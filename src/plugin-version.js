/**
 * Version self-knowledge for the settings panel.
 *
 * The running version comes from this package. The latest version comes from
 * the npm registry. An in-place update is only offered for a registry install,
 * and it installs that exact version with the host's own pnpm — never through
 * `dsh plugin --profile desktop`, which the desktop app refuses. The install
 * runs under the profile's own `minimumReleaseAge`: a version installed past
 * it would sit in the profile's lockfile, and pnpm then refuses every later
 * plugin install in that profile until the version is old enough. A version
 * pnpm still holds back is reported as pending, with when it clears. The
 * latest version is read from npm itself while pnpm installs from the
 * profile's own install source, which can lag behind a fresh release (a mirror
 * still syncing, npm's CDN for a few minutes) or be unreachable; both are
 * reported as such instead of a bare failure. Registry bodies and
 * package-manager output stay host-side; only a registry host name leaves.
 *
 * @module dsh-packycode-api/plugin-version
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCachedRead } from './cached-read.js'
import { ambientFetch, boundedFetch } from './request.js'

export { ambientFetch, waitForSharedRequest } from './request.js'

export const PACKAGE_NAME = 'dsh-packycode-api'
export const NPM_REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
export const DEFAULT_VERSION_TTL_MS = 5 * 60_000
export const DEFAULT_VERSION_TIMEOUT_MS = 10_000
export const DEFAULT_UPDATE_TIMEOUT_MS = 180_000
export const DEFAULT_SETTLE_DELAY_MS = 250

/** The spawn bound's own reason, so a hung install reads as an unreachable source. */
const UPDATE_TIMED_OUT = 'PackyCode plugin update timed out'
const RELEASE_AGE_ERROR = /ERR_PNPM_(?:NO_MATURE_MATCHING_VERSION|MINIMUM_RELEASE_AGE_VIOLATION)/u
/**
 * pnpm's codes for a version its registry does not list yet, or a tarball it
 * does not serve yet; DSH's plugin manager reads the same ones.
 */
const NOT_SYNCED = /ERR_PNPM_NO_MATCHING_VERSION|\bETARGET\b|No matching version found|ERR_PNPM_FETCH_404|\bE404\b|404 Not Found|Not Found - 404/u
/** pnpm's and Node's codes for a registry pnpm could not reach (DSH's network family). */
const UNREACHABLE = /ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_5\d\d|ERR_PNPM_FETCH_TIMEOUT|\bENOTFOUND\b|\bECONNRESET\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|\bFETCH_ERROR\b|socket hang up/u
const REGISTRY_URL = /(?:while fetching it from|GET)\s+(https?:\/\/\S+)/u
const RELEASE_AGE_ENTRY = /(\S+@\S+) was published at (\S+?), within the minimumReleaseAge cutoff \((\S+?)\)/gu

/**
 * Recognize pnpm refusing a version that is younger than its
 * `minimumReleaseAge`, whether the version was requested or already sits in
 * the lockfile. Each refused entry reads `<name>@<version> was published at
 * <time>, within the minimumReleaseAge cutoff (<time>)`.
 * @param output - the install's stdout and stderr.
 * @param finishedAt - when the install ended; pnpm drew its cutoff then.
 * @returns undefined when this is not a release-age refusal; otherwise
 *   `{ availableAt }`, when the youngest refused entry clears, if pnpm said.
 */
export function releaseAgeRefusal(output, finishedAt) {
  // A colour-forcing environment can wrap the entries in ANSI escapes.
  const text = String(output ?? '').replace(/\u001b\[[0-9;]*m/gu, '')
  if (!RELEASE_AGE_ERROR.test(text)) return undefined
  let availableAt
  for (const [, , published, cutoff] of text.matchAll(RELEASE_AGE_ENTRY)) {
    const clears = Date.parse(published) + (finishedAt - Date.parse(cutoff))
    if (Number.isFinite(clears) && (availableAt === undefined || clears > availableAt)) availableAt = clears
  }
  return availableAt === undefined ? {} : { availableAt }
}

/** The host of the registry URL one pnpm error line names; never its path or credentials. */
function registryHost(line) {
  const match = REGISTRY_URL.exec(line)
  if (match === null) return {}
  try {
    const { host } = new URL(match[1].replace(/[.,:;)\]]+$/u, ''))
    return host === '' ? {} : { registry: host }
  } catch {
    return {}
  }
}

/**
 * Recognize why pnpm could not fetch the new version: its install source has
 * not synced the version yet, or pnpm could not reach the install source.
 * Only a line naming this package counts as not synced; another package's 404
 * is not this update's.
 * @param output - the install's stdout and stderr.
 * @returns `{ reason: 'syncing' | 'unreachable', registry? }` with the host
 *   pnpm named, or undefined for any other failure.
 */
export function installFailure(output) {
  // A colour-forcing environment can wrap the lines in ANSI escapes.
  const lines = String(output ?? '').replace(/\u001b\[[0-9;]*m/gu, '').split('\n')
  const syncing = lines.find(line => NOT_SYNCED.test(line) && line.includes(PACKAGE_NAME))
  if (syncing !== undefined) return { reason: 'syncing', ...registryHost(syncing) }
  const unreachable = lines.find(line => UNREACHABLE.test(line))
  if (unreachable !== undefined) return { reason: 'unreachable', ...registryHost(unreachable) }
  return undefined
}

/** Parse a strict `x.y.z[-pre][+build]` version; anything else is undefined. */
export function parseSemver(value) {
  if (typeof value !== 'string') return undefined
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value.trim())
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] }
}

/** Compare two versions: -1/0/1, or undefined when either side is not semver. */
export function compareSemver(a, b) {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (left === undefined || right === undefined) return undefined
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre === right.pre) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  return left.pre < right.pre ? -1 : 1
}

/**
 * Classify how the running package reached the profile. Only registry specs
 * may be updated in place; local checkouts belong to the owner's iteration.
 */
function classifySpec(spec) {
  if (typeof spec !== 'string' || spec === '') return 'unknown'
  if (/^(?:link|file):/u.test(spec)) return 'link'
  if (/^(?:\d|[~^*])/u.test(spec)) return 'npm'
  return 'unknown'
}

const readManifest = async path => {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * A zero exit only proves the command ran. pnpm can skip a too-new version
 * and still exit zero, so the landed manifest is what makes the answer true.
 */
async function confirmInstalled({ profileDir, expected, settleDelayMs, attempts = 3 }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const installed = (await readManifest(join(profileDir, 'node_modules', PACKAGE_NAME, 'package.json')))?.version
    if (installed === expected) return
    if (attempt < attempts) await new Promise(resolve => { setTimeout(resolve, settleDelayMs) })
  }
  throw new Error('PackyCode plugin update did not install the requested version')
}

/**
 * Find the profile that owns this running installation. pnpm symlinks resolve
 * to the same realpath on both sides. When no realpath matches, fall back to
 * the only profile that declares the dependency at all.
 */
export async function findInstall({ dshHome, ownPackageJsonUrl }) {
  let ownReal
  try {
    ownReal = await realpath(fileURLToPath(ownPackageJsonUrl))
  } catch {
    ownReal = undefined
  }
  let entries = []
  try {
    entries = await readdir(join(dshHome, 'profiles'), { withFileTypes: true })
  } catch {
    entries = []
  }
  const declared = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const profileDir = join(dshHome, 'profiles', entry.name)
    const spec = (await readManifest(join(profileDir, 'package.json')))?.dependencies?.[PACKAGE_NAME]
    if (typeof spec !== 'string') continue
    declared.push({ profile: entry.name, spec })
    if (ownReal === undefined) continue
    try {
      const installed = await realpath(join(profileDir, 'node_modules', PACKAGE_NAME, 'package.json'))
      if (installed === ownReal) return { kind: classifySpec(spec), profile: entry.name }
    } catch {
      // Declared, but not resolvable in this profile.
    }
  }
  if (declared.length === 1) return { kind: classifySpec(declared[0].spec), profile: declared[0].profile }
  return { kind: 'unknown' }
}

const isExistingPath = value => typeof value === 'string' && value !== '' && existsSync(value)

/** Anchored to the file name so a directory that merely contains the word cannot match. */
const PNPM_SCRIPT = /[\\/]pnpm\.(?:mjs|cjs|js)$/u

const dshRuntimeRoot = value => (isExistingPath(value)
  && existsSync(join(value, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  ? value
  : undefined)

/**
 * Locate the package manager that owns this profile.
 *
 * `dsh plugin --profile desktop` is refused by the desktop app, so the update
 * installs with pnpm directly. The desktop host puts the bundled pnpm in its
 * own arguments; nothing is guessed from the entry script.
 */
export function resolvePnpm({ argv } = {}) {
  const entries = Array.isArray(argv) ? argv : []
  for (const entry of entries) {
    if (isExistingPath(entry) && PNPM_SCRIPT.test(entry)) return entry
  }
  for (const entry of entries) {
    const root = dshRuntimeRoot(entry)
    if (root === undefined) continue
    const script = join(root, '..', 'pnpm', 'bin', 'pnpm.mjs')
    if (existsSync(script)) return script
  }
  return undefined
}

function resolveLauncher({ argv, execPath }) {
  const pnpm = resolvePnpm({ argv })
  if (pnpm === undefined) return { command: 'pnpm', prefix: [] }
  return { command: execPath, prefix: [pnpm] }
}

/** Run pnpm host-side. Its output is never returned to the browser. */
function spawnRunCommand({ command, args, cwd }, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('PackyCode plugin update aborted'))
      return
    }
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error(UPDATE_TIMED_OUT)), timeoutMs)
    let settled = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    let child
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: controller.signal,
        ...(cwd === undefined ? {} : { cwd }),
      })
    } catch (error) {
      settle(reject, error)
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk).slice(-8192) })
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
    /** Why the install was stopped: the caller's reason or the bound's. */
    const abortReason = () => {
      const reason = controller.signal.reason
      return reason instanceof Error ? reason : new Error('PackyCode plugin update aborted')
    }
    // Node reports an abort as its own AbortError, before `close`; keep the reason.
    child.on('error', error => settle(reject, controller.signal.aborted ? abortReason() : error))
    child.on('close', code => {
      if (controller.signal.aborted) {
        settle(reject, abortReason())
        return
      }
      settle(resolve, { code: code ?? 1, stdout, stderr })
    })
  })
}

/**
 * The running version, the latest registry version, which profile installed
 * this copy, and registry-spec updates against that profile.
 */
export function createPackyCodePluginManager({
  fetchImpl = ambientFetch,
  runCommand = spawnRunCommand,
  execPath = process.execPath,
  argv = process.argv,
  env = process.env,
  ownPackageJsonUrl = new URL('../package.json', import.meta.url),
  registryUrl = NPM_REGISTRY_LATEST_URL,
  now = Date.now,
  ttlMs = DEFAULT_VERSION_TTL_MS,
  timeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
  updateTimeoutMs = DEFAULT_UPDATE_TIMEOUT_MS,
  settleDelayMs = DEFAULT_SETTLE_DELAY_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('PackyCode plugin manager requires fetch')
  if (typeof runCommand !== 'function') throw new Error('PackyCode plugin manager requires runCommand')
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  const launcher = resolveLauncher({ argv, execPath })
  let updating = false

  const fetchLatest = async signal => {
    let response
    try {
      response = await boundedFetch(registryUrl, { headers: { Accept: 'application/json' } }, { fetchImpl, timeoutMs, signal })
    } catch (error) {
      if (error.aborted) throw error.cause
      throw new Error('PackyCode plugin version check failed')
    }
    if (!response.ok) throw new Error('PackyCode plugin version check failed')
    let version
    try {
      version = (await response.json())?.version
    } catch {
      version = undefined
    }
    if (parseSemver(version) === undefined) throw new Error('PackyCode plugin version check failed')
    return version
  }

  const readOwnVersion = async () => {
    const version = (await readManifest(fileURLToPath(ownPackageJsonUrl)))?.version
    if (parseSemver(version) === undefined) throw new Error('PackyCode plugin version is unavailable')
    return version
  }

  const load = async signal => {
    signal?.throwIfAborted()
    const [current, install, latest] = await Promise.all([
      readOwnVersion(),
      findInstall({ dshHome, ownPackageJsonUrl }),
      fetchLatest(signal),
    ])
    return {
      current,
      latest,
      updateAvailable: compareSemver(latest, current) === 1,
      install,
      fetchedAt: now(),
    }
  }

  const cache = createCachedRead(load, { ttlMs, now })

  return Object.freeze({
    read: options => cache.read(options),

    async update({ signal } = {}) {
      signal?.throwIfAborted()
      if (updating) throw new Error('PackyCode plugin update is already running')
      updating = true
      try {
        const install = await findInstall({ dshHome, ownPackageJsonUrl })
        if (install.kind === 'link') throw new Error('PackyCode plugin is installed from a local checkout')
        if (install.kind !== 'npm' || install.profile === undefined) {
          throw new Error('PackyCode plugin update could not find the owning profile')
        }
        const latest = await fetchLatest(signal)
        const profileDir = join(dshHome, 'profiles', install.profile)
        let result
        try {
          result = await runCommand({
            command: launcher.command,
            args: [...launcher.prefix, 'add', '--save-exact', `${PACKAGE_NAME}@${latest}`],
            cwd: profileDir,
          }, { signal, timeoutMs: updateTimeoutMs })
        } catch (error) {
          if (signal?.aborted) throw error
          // pnpm hung past the bound: its install source did not answer.
          if (error?.message === UPDATE_TIMED_OUT) return { version: latest, profile: install.profile, failed: 'unreachable' }
          throw new Error('PackyCode plugin update failed')
        }
        if (result.code !== 0) {
          const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
          // Not a failure to retry blindly: pnpm installs it once old enough.
          const refusal = releaseAgeRefusal(output, now())
          if (refusal !== undefined) return { version: latest, profile: install.profile, pending: true, ...refusal }
          // Nothing changed in the profile; the card says to wait or to check the network.
          const failure = installFailure(output)
          if (failure !== undefined) {
            return { version: latest, profile: install.profile, failed: failure.reason, ...(failure.registry === undefined ? {} : { registry: failure.registry }) }
          }
          throw new Error('PackyCode plugin update failed')
        }
        await confirmInstalled({ profileDir, expected: latest, settleDelayMs })
        cache.invalidate()
        return { version: latest, profile: install.profile }
      } finally {
        updating = false
      }
    },

    invalidate: () => cache.invalidate(),
  })
}
