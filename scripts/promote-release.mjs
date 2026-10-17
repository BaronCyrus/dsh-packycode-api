#!/usr/bin/env node
/**
 * Move `latest` to the `next` version once that version is older than the
 * release-age window DSH's pnpm enforces.
 *
 *   node scripts/promote-release.mjs [--dry-run]
 *
 * A tag publishes to `next`. pnpm (11 by default) refuses to install a version
 * younger than `minimumReleaseAge`, 24 hours, and refuses every later install
 * in a profile whose lockfile already holds one. The plugin's update button and
 * DSH's Plugins page both install what `latest` names, so `latest` only ever
 * names a version past that window — including for update buttons already
 * shipped, which cannot be changed.
 *
 * Reading the registry needs no credentials. In GitHub Actions the npm CLI
 * moves the tag with the workflow's OIDC identity; the trusted publisher must
 * allow npm dist-tag. Node built-ins only: this runs without installing
 * dependencies. Prints the decision; with `GITHUB_OUTPUT` set it records a
 * promoted version as `version=<x.y.z>`.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = 'dsh-packycode-api'
/** pnpm's default `minimumReleaseAge` (1440 minutes) plus an hour of margin. */
export const PROMOTE_AFTER_MS = 25 * 60 * 60 * 1000

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/u

/** Order two plain `x.y.z` versions; undefined when either is not one. */
export function compareVersions(left, right) {
  const a = VERSION.exec(String(left))
  const b = VERSION.exec(String(right))
  if (a === null || b === null) return undefined
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index])
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

/**
 * Decide whether `next` may become `latest` now.
 * @param registry - the package's `dist-tags` and `time` from the registry.
 * @param now - the current time in milliseconds.
 * @returns `{ version }` to promote, or `{ skip }` with the reason.
 */
export function decidePromotion({ distTags, time }, now, promoteAfterMs = PROMOTE_AFTER_MS) {
  const next = distTags?.next
  const latest = distTags?.latest
  if (next === undefined) return { skip: 'no next tag' }
  const order = compareVersions(next, latest)
  if (order === undefined) return { skip: `next ${next} or latest ${latest} is not a plain version` }
  if (order <= 0) return { skip: `next ${next} is not newer than latest ${latest}` }
  const published = Date.parse(time?.[next])
  if (!Number.isFinite(published)) return { skip: `the registry gives no publish time for ${next}` }
  const age = now - published
  if (age < promoteAfterMs) {
    return { skip: `next ${next} is ${(age / 3_600_000).toFixed(1)}h old; it may become latest after ${new Date(published + promoteAfterMs).toISOString()}` }
  }
  return { version: next }
}

/** The full registry document; `npm view --json` changes its shape between CLI versions. */
async function readRegistry() {
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}`, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`the registry answered HTTP ${response.status}`)
  const document = await response.json()
  return { distTags: document['dist-tags'], time: document.time }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const decision = decidePromotion(await readRegistry(), Date.now())
  if (decision.version === undefined) {
    console.log(`nothing to promote: ${decision.skip}`)
    return
  }
  if (dryRun) {
    console.log(`would promote ${PACKAGE_NAME}@${decision.version} to latest`)
    return
  }
  execFileSync('npm', ['dist-tag', 'add', `${PACKAGE_NAME}@${decision.version}`, 'latest'], { stdio: ['ignore', 'inherit', 'inherit'] })
  console.log(`promoted ${PACKAGE_NAME}@${decision.version} to latest`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${decision.version}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
