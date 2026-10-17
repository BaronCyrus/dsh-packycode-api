#!/usr/bin/env node
/**
 * Move `latest` to the newest staged version that is older than the
 * release-age window DSH's pnpm enforces.
 *
 *   node scripts/promote-release.mjs [--dry-run]
 *
 * Transitional. Tags publish straight to `latest` again; this only finishes
 * moving `latest` to 1.3.3 and 1.3.4, which were staged on `next` before
 * that. Once `latest` is 1.3.4 or newer, `next` is never newer than `latest`
 * and every run is a no-op, so remove this with the promote job.
 *
 * While tags published to `next`, pnpm (11 by default) refuses to install a version
 * younger than `minimumReleaseAge`, 24 hours, and refuses every later install
 * in a profile whose lockfile already holds one. The plugin's update button and
 * DSH's Plugins page both install what `latest` names, so `latest` only ever
 * names a version past that window — including for update buttons already
 * shipped, which cannot be changed.
 *
 * Releases can follow each other faster than the window: `next` then names a
 * version that is still too young, while an earlier staged one is old enough.
 * The newest version after `latest`, up to `next`, that has aged past the
 * window is promoted, so `latest` trails the newest release by about a day
 * instead of waiting for a quiet day. A version deprecated on npm is never
 * promoted; deprecating is how a broken release is held back.
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
 * Decide which staged version may become `latest` now.
 * @param registry - from the registry: `distTags`, publish `time` per version,
 *   the `versions` it still serves, and the `deprecated` ones.
 * @param now - the current time in milliseconds.
 * @returns `{ version }` to promote, or `{ skip }` with the reason.
 */
export function decidePromotion({ distTags, time, versions, deprecated = [] }, now, promoteAfterMs = PROMOTE_AFTER_MS) {
  const next = distTags?.next
  const latest = distTags?.latest
  if (next === undefined) return { skip: 'no next tag' }
  const order = compareVersions(next, latest)
  if (order === undefined) return { skip: `next ${next} or latest ${latest} is not a plain version` }
  if (order <= 0) return { skip: `next ${next} is not newer than latest ${latest}` }
  const staged = (versions ?? Object.keys(time ?? {}))
    .filter(version => compareVersions(version, latest) === 1 && compareVersions(version, next) <= 0 && !deprecated.includes(version))
    .map(version => ({ version, published: Date.parse(time?.[version]) }))
    .filter(entry => Number.isFinite(entry.published))
  if (staged.length === 0) return { skip: `no undeprecated version after latest ${latest}, up to next ${next}, has a publish time` }
  const ready = staged.filter(entry => now - entry.published >= promoteAfterMs)
  if (ready.length > 0) return { version: ready.reduce((newest, entry) => (compareVersions(entry.version, newest.version) === 1 ? entry : newest)).version }
  const first = staged.reduce((oldest, entry) => (entry.published < oldest.published ? entry : oldest))
  return { skip: `${first.version} is ${((now - first.published) / 3_600_000).toFixed(1)}h old; it may become latest after ${new Date(first.published + promoteAfterMs).toISOString()}` }
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
  const manifests = Object.entries(document.versions ?? {})
  return {
    distTags: document['dist-tags'],
    time: document.time,
    versions: manifests.map(([version]) => version),
    deprecated: manifests.filter(([, manifest]) => manifest?.deprecated).map(([version]) => version),
  }
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
