import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  compareSemver,
  createPackyCodePluginManager,
  installFailure,
  NPM_REGISTRY_LATEST_URL,
  PACKAGE_NAME,
  parseSemver,
  releaseAgeRefusal,
  resolvePnpm,
} from '../src/plugin-version.js'
import { createPackyCodeRpc } from '../src/rpc.js'

const writeManifest = async (path, manifest) => {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(manifest))
}

/** Fake DSH home whose `web` profile installed the package from the registry. */
async function npmInstall(root, version = '1.0.3') {
  const installedDir = join(root, 'profiles', 'web', 'node_modules', PACKAGE_NAME)
  await writeManifest(join(root, 'profiles', 'web', 'package.json'), {
    dependencies: { [PACKAGE_NAME]: version },
  })
  await writeManifest(join(installedDir, 'package.json'), { name: PACKAGE_NAME, version })
  return pathToFileURL(join(installedDir, 'package.json'))
}

/** Fake DSH home whose `web` profile links a local checkout. */
async function linkInstall(root, version = '1.0.3') {
  const checkout = join(root, 'checkout')
  await writeManifest(join(checkout, 'package.json'), { name: PACKAGE_NAME, version })
  await writeManifest(join(root, 'profiles', 'web', 'package.json'), {
    dependencies: { [PACKAGE_NAME]: 'link:../../checkout' },
  })
  const modules = join(root, 'profiles', 'web', 'node_modules')
  await mkdir(modules, { recursive: true })
  await symlink(checkout, join(modules, PACKAGE_NAME), 'dir')
  return pathToFileURL(join(checkout, 'package.json'))
}

const registryOk = version => async () => ({ ok: true, status: 200, async json() { return { version } } })

const rpc = pluginManager => createPackyCodeRpc({
  ring: {},
  balance: {},
  hosts: () => ({}),
  preference: {},
  pluginManager,
})

test('semver parsing and comparison drive the update badge', () => {
  assert.deepEqual(parseSemver(' 1.0.3 '), { major: 1, minor: 0, patch: 3, pre: undefined })
  assert.equal(parseSemver('v1.0.3'), undefined)
  assert.equal(parseSemver('1.0'), undefined)
  assert.equal(compareSemver('1.0.3', '1.0.4'), -1)
  assert.equal(compareSemver('1.0.4', '1.0.3'), 1)
  assert.equal(compareSemver('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareSemver('not-a-version', '1.0.3'), undefined)
})

test('version check asks the registry for an uncompressed document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packy-version-encoding-'))
  const ownPackageJsonUrl = await npmInstall(root, '1.0.3')
  const original = globalThis.fetch
  let acceptEncoding
  globalThis.fetch = async (_url, init) => {
    acceptEncoding = new Headers(init?.headers).get('accept-encoding')
    if (acceptEncoding !== 'identity') {
      return { ok: true, status: 200, async json() { throw new SyntaxError('gzip body') } }
    }
    return { ok: true, status: 200, async json() { return { version: '1.0.3' } } }
  }
  try {
    const value = await createPackyCodePluginManager({
      env: { DSH_HOME: root },
      ownPackageJsonUrl,
    }).read({ force: true })
    assert.equal(acceptEncoding, 'identity')
    assert.equal(value.latest, '1.0.3')
    assert.equal(value.updateAvailable, false)
  } finally {
    globalThis.fetch = original
  }
})

test('version read combines own manifest, registry latest, and the owning npm profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packy-version-npm-'))
  const ownPackageJsonUrl = await npmInstall(root)
  let requests = 0
  let observed
  let clock = 1000
  const manager = createPackyCodePluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    now: () => clock,
    fetchImpl: (url, init) => {
      requests += 1
      observed = { url, redirect: init.redirect }
      return registryOk('1.0.4')()
    },
  })
  const first = await manager.read()
  assert.deepEqual(first, {
    current: '1.0.3',
    latest: '1.0.4',
    updateAvailable: true,
    install: { kind: 'npm', profile: 'web' },
    fetchedAt: 1000,
  })
  assert.deepEqual(observed, { url: NPM_REGISTRY_LATEST_URL, redirect: 'error' })
  await manager.read()
  assert.equal(requests, 1, 'fresh cached reads stay off the network')
  await manager.read({ force: true })
  assert.equal(requests, 2)
})

test('registry failures and malformed payloads surface one sanitized error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packy-version-down-'))
  const ownPackageJsonUrl = await npmInstall(root)
  const failing = createPackyCodePluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  })
  await assert.rejects(() => failing.read(), /^Error: PackyCode plugin version check failed$/u)
  const malformed = createPackyCodePluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { version: 'not-a-version' } } }),
  })
  await assert.rejects(() => malformed.read(), /^Error: PackyCode plugin version check failed$/u)
})

test('linked checkouts are reported but never updated in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packy-version-link-'))
  const ownPackageJsonUrl = await linkInstall(root)
  const manager = createPackyCodePluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    fetchImpl: registryOk('1.0.4'),
    runCommand: async () => {
      throw new Error('runCommand must not run for linked installs')
    },
  })
  const info = await manager.read()
  assert.equal(info.install.kind, 'link')
  assert.equal(info.install.profile, 'web')
  assert.equal(info.updateAvailable, true)
  await assert.rejects(() => manager.update(), /^Error: PackyCode plugin is installed from a local checkout$/u)
})

/** A fake desktop runtime: argv carries the host entry, the dsh runtime, and bundled pnpm. */
async function desktopRuntime(root) {
  const runtimeDir = join(root, 'resources', 'app.asar', 'dsh')
  const hostEntry = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
  const pnpm = join(root, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  await writeManifest(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), {
    name: '@deepseek-ai/dsh',
    version: '0.1.7-rc.2',
  })
  await writeManifest(hostEntry, { name: '@deepseek-ai/dsh-desktop-host', version: '0.1.7-rc.2' })
  await writeManifest(pnpm, { name: 'pnpm', version: '11.7.0' })
  return {
    runtimeDir,
    hostEntry,
    pnpm,
    argv: [
      join(root, 'DeepSeek Harness'),
      hostEntry,
      runtimeDir,
      join(root, 'profiles', 'desktop'),
      join(root, 'resources', 'runtime', 'primary-runtime'),
      pnpm,
      join(root, 'resources', 'runtime', 'bin'),
    ],
  }
}

const installRecorder = async ({ args, cwd }) => {
  await writeManifest(join(cwd, 'node_modules', PACKAGE_NAME, 'package.json'), {
    name: PACKAGE_NAME,
    version: args.at(-1).split('@').at(-1),
  })
  return { code: 0, stdout: '', stderr: '' }
}

test('update installs the exact version into the owning profile, pinned and under the profile\'s release-age policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packy-version-update-'))
  const ownPackageJsonUrl = await npmInstall(root)
  const calls = []
  let registryRequests = 0
  const manager = createPackyCodePluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    execPath: '/node',
    argv: ['/node', '/dsh/bin.js'],
    fetchImpl: () => {
      registryRequests += 1
      return registryOk('1.0.4')()
    },
    runCommand: async (call, options) => {
      calls.push(call)
      return installRecorder(call, options)
    },
  })
  const updated = await manager.update()
  assert.deepEqual(updated, { version: '1.0.4', profile: 'web' })
  assert.equal(calls[0].command, 'pnpm')
  // No minimumReleaseAge override: a version installed past the policy would
  // make pnpm refuse every later plugin install in the profile.
  assert.deepEqual(calls[0].args, ['add', '--save-exact', `${PACKAGE_NAME}@1.0.4`])
  assert.equal(calls[0].cwd, join(root, 'profiles', 'web'))
  await manager.read()
  assert.equal(registryRequests, 2, 'a successful update invalidates the cached version')
})

test('desktop hosts install with the bundled pnpm, never by launching the desktop host again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packy-version-desktop-'))
  const ownPackageJsonUrl = await npmInstall(root, '1.0.3')
  const runtime = await desktopRuntime(root)
  assert.equal(resolvePnpm({ argv: runtime.argv }), runtime.pnpm)
  const calls = []
  const manager = createPackyCodePluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    execPath: '/Applications/DeepSeek Harness',
    argv: runtime.argv,
    fetchImpl: registryOk('1.0.4'),
    runCommand: async (call, options) => {
      calls.push(call)
      return installRecorder(call, options)
    },
  })
  assert.deepEqual(await manager.update(), { version: '1.0.4', profile: 'web' })
  const [call] = calls
  assert.equal(call.command, '/Applications/DeepSeek Harness')
  assert.deepEqual(call.args, [runtime.pnpm, 'add', '--save-exact', `${PACKAGE_NAME}@1.0.4`])
  const flattened = JSON.stringify(call)
  assert.equal(flattened.includes(runtime.hostEntry), false)
  assert.equal(flattened.includes('plugin'), false)
})

test('an update that installs nothing is a failure, not a reported success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packy-version-verify-'))
  const ownPackageJsonUrl = await npmInstall(root, '1.0.3')
  const manager = createPackyCodePluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    fetchImpl: registryOk('1.0.4'),
    settleDelayMs: 1,
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
  })
  await assert.rejects(
    () => manager.update(),
    /^Error: PackyCode plugin update did not install the requested version$/u,
  )
})

/** pnpm 11's refusal of a version requested before its release age, as captured on 2026-10-17. */
const TOO_NEW = `[ERR_PNPM_NO_MATURE_MATCHING_VERSION] 1 version does not meet the minimumReleaseAge constraint:
  dsh-packycode-api@1.3.2 was published at 2026-10-16T19:16:25.489Z, within the minimumReleaseAge cutoff (2026-10-16T03:19:30.745Z)`
/** The lockfile check that refused an unrelated install in a profile holding a too-new version. */
const LOCKFILE_VIOLATION = `✗ Lockfile failed supply-chain policy check (2 entries in 1.3s)
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 2 lockfile entries failed verification:
  dsh-packycode-api@1.3.2 was published at 2026-10-16T19:15:26.000Z, within the minimumReleaseAge cutoff (2026-10-16T03:18:55.442Z)
  dsh-chat-manager@1.5.13 was published at 2026-10-16T14:05:23.291Z, within the minimumReleaseAge cutoff (2026-10-16T03:18:55.442Z)`

test('a release-age refusal says when pnpm will accept the youngest refused version', () => {
  const finishedAt = Date.parse('2026-10-17T03:19:30.745Z')
  assert.deepEqual(releaseAgeRefusal(TOO_NEW, finishedAt), { availableAt: Date.parse('2026-10-17T19:16:25.489Z') })
  // Every refused entry must clear; the youngest one decides.
  assert.deepEqual(releaseAgeRefusal(`\u001b[31m${LOCKFILE_VIOLATION}\u001b[39m`, Date.parse('2026-10-17T03:18:55.442Z')),
    { availableAt: Date.parse('2026-10-17T19:15:26.000Z') })
  assert.deepEqual(releaseAgeRefusal('[ERR_PNPM_NO_MATURE_MATCHING_VERSION] something unparseable', finishedAt), {})
  assert.equal(releaseAgeRefusal('ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/dsh-packycode-api: Not Found', finishedAt), undefined)
  assert.equal(releaseAgeRefusal(undefined, finishedAt), undefined)
})

test('an update pnpm holds back for its release age is pending, not failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packy-version-cooling-'))
  const ownPackageJsonUrl = await npmInstall(root, '1.0.3')
  let registryRequests = 0
  const manager = createPackyCodePluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    now: () => Date.parse('2026-10-17T03:19:30.745Z'),
    fetchImpl: () => {
      registryRequests += 1
      return registryOk('1.0.4')()
    },
    runCommand: async () => ({ code: 1, stdout: '', stderr: TOO_NEW.replaceAll('1.3.2', '1.0.4') }),
  })
  await manager.read()
  assert.deepEqual(await manager.update(), {
    version: '1.0.4', profile: 'web', pending: true, availableAt: Date.parse('2026-10-17T19:16:25.489Z'),
  })
  await manager.read()
  assert.equal(registryRequests, 2, 'only the update itself re-read the registry; nothing was installed')
})

test('the package-manager resolver trusts only real pnpm entries and owned runtime roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packy-version-resolve-'))
  const runtime = await desktopRuntime(root)
  const elsewhere = await mkdtemp(join(tmpdir(), 'packy-version-resolve-other-'))
  const otherPnpm = join(elsewhere, 'resources', 'pnpm', 'bin', 'pnpm.mjs')

  assert.equal(resolvePnpm({ argv: runtime.argv }), runtime.pnpm)
  assert.equal(resolvePnpm({ argv: ['/node', '--expose-internals', '/dsh/bin.js'] }), undefined)
  assert.equal(resolvePnpm({ argv: ['/node', runtime.hostEntry] }), undefined)
  assert.equal(resolvePnpm({ argv: ['/node', '/somewhere/pnpm-not-really'] }), undefined)
  assert.equal(resolvePnpm({ argv: ['/node', join(root, 'missing', 'pnpm.mjs')] }), undefined)

  await writeManifest(otherPnpm, { name: 'pnpm', version: '11.7.0' })
  const runtimeDir = join(elsewhere, 'resources', 'runtime')
  await writeManifest(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), {
    name: '@deepseek-ai/dsh',
    version: '0.1.7-rc.2',
  })
  assert.equal(
    resolvePnpm({ argv: ['/node', join(elsewhere, 'index.js'), runtimeDir] }),
    otherPnpm,
  )
})

test('update failures stay generic and unknown installs refuse to guess a profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packy-version-fail-'))
  const ownPackageJsonUrl = await npmInstall(root)
  const failing = createPackyCodePluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    fetchImpl: registryOk('1.0.4'),
    runCommand: async () => ({ code: 1, stdout: '', stderr: 'pnpm exploded with secret-ish output' }),
  })
  await assert.rejects(
    () => failing.update(),
    error => error.message === 'PackyCode plugin update failed' && !error.message.includes('secret-ish'),
  )

  const emptyHome = await mkdtemp(join(tmpdir(), 'packy-version-none-'))
  const stray = join(emptyHome, 'elsewhere', 'package.json')
  await writeManifest(stray, { name: PACKAGE_NAME, version: '1.0.3' })
  const unknown = createPackyCodePluginManager({
    env: { DSH_HOME: emptyHome },
    ownPackageJsonUrl: pathToFileURL(stray),
    fetchImpl: registryOk('1.0.4'),
  })
  const info = await unknown.read()
  assert.deepEqual(info.install, { kind: 'unknown' })
  await assert.rejects(() => unknown.update(), /^Error: PackyCode plugin update could not find the owning profile$/u)
})

test('loopback RPC exposes version and update endpoints with sanitized errors', async () => {
  const projection = {
    current: '1.0.3',
    latest: '1.0.4',
    updateAvailable: true,
    install: { kind: 'npm', profile: 'web' },
    fetchedAt: 1000,
  }
  const forced = []
  const handler = rpc({
    async read({ force } = {}) {
      forced.push(force)
      return projection
    },
    async update() {
      return { version: '1.0.4', profile: 'web' }
    },
  })
  assert.deepEqual(await handler('plugin/version', {}), { ok: true, value: projection })
  await handler('plugin/version', { force: true })
  assert.deepEqual(forced, [false, true])
  assert.deepEqual(await handler('plugin/update', {}), {
    ok: true,
    value: { version: '1.0.4', profile: 'web' },
  })

  const failing = rpc({
    async read() { throw new Error('PackyCode plugin version check failed') },
    async update() { throw new Error('pnpm leaked internals') },
  })
  assert.deepEqual(await failing('plugin/version', {}), {
    ok: false,
    error: { code: 'packycode/request-failed', message: 'PackyCode plugin version check failed', details: {} },
  })
  assert.deepEqual(await failing('plugin/update', {}), {
    ok: false,
    error: { code: 'packycode/request-failed', message: 'PackyCode request failed', details: {} },
  })

  const missing = rpc(undefined)
  assert.deepEqual(await missing('plugin/version', {}), {
    ok: false,
    error: { code: 'packycode/request-failed', message: 'PackyCode plugin version is unavailable', details: {} },
  })
})

/** What DSH's bundled pnpm 11.28.5 printed on 2026-10-22, shortly after 1.3.8 was published. */
const MIRROR_NOT_SYNCED = `? Verifying lockfile against supply-chain policies (1 entry)...
\u001b[32m✓\u001b[39m Lockfile passes supply-chain policies (1 entry in 2ms)
[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for dsh-packycode-api@1.3.8 while fetching it from https://registry.npmmirror.com/
This error happened while installing a direct dependency of /Users/someone/.dsh/profiles/desktop
The latest release of dsh-packycode-api is "1.3.7". Published at 10/21/2026 4:49:59 PM`
const TARBALL_NOT_SERVED = '[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/dsh-packycode-api/-/dsh-packycode-api-1.3.8.tgz: Not Found - 404\nNo authorization header was set for the request.'
const SOURCE_UNREACHABLE = '[ERR_PNPM_META_FETCH_FAIL] GET https://registry.npmjs.org/dsh-packycode-api: fetch failed\nThis error happened while installing a direct dependency of /Users/someone/.dsh/profiles/desktop'

test('pnpm\'s output says whether the install source is still syncing or out of reach', () => {
  assert.deepEqual(installFailure(MIRROR_NOT_SYNCED), { reason: 'syncing', registry: 'registry.npmmirror.com' })
  assert.deepEqual(installFailure(TARBALL_NOT_SERVED), { reason: 'syncing', registry: 'registry.npmjs.org' })
  assert.deepEqual(installFailure(SOURCE_UNREACHABLE), { reason: 'unreachable', registry: 'registry.npmjs.org' })
  assert.deepEqual(installFailure('ERR_PNPM_META_FETCH_FAIL  GET http://127.0.0.1:9/dsh-packycode-api: request failed, reason: connect ECONNREFUSED'), { reason: 'unreachable', registry: '127.0.0.1:9' })
  assert.deepEqual(installFailure('getaddrinfo ENOTFOUND registry.npmjs.org'), { reason: 'unreachable' })
  // Only the host leaves the machine, never credentials or a path.
  assert.deepEqual(installFailure('[ERR_PNPM_META_FETCH_FAIL] GET https://user:secret@npm.corp.example:8443/dsh-packycode-api: fetch failed'), { reason: 'unreachable', registry: 'npm.corp.example:8443' })
  // Another package's 404 and any other failure are not this update's.
  assert.equal(installFailure('[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/left-pad/-/left-pad-9.9.9.tgz: Not Found - 404'), undefined)
  assert.equal(installFailure('pnpm exploded with secret-ish output'), undefined)
  assert.equal(installFailure(undefined), undefined)
})

test('an update the install source cannot serve yet, or cannot be reached for, says so instead of failing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packy-version-source-'))
  const ownPackageJsonUrl = await npmInstall(root, '1.3.7')
  const managerFor = runCommand => createPackyCodePluginManager({ env: { DSH_HOME: root }, ownPackageJsonUrl, fetchImpl: registryOk('1.3.8'), runCommand })
  assert.deepEqual(await managerFor(async () => ({ code: 1, stdout: '', stderr: MIRROR_NOT_SYNCED })).update(), {
    version: '1.3.8', profile: 'web', failed: 'syncing', registry: 'registry.npmmirror.com',
  })
  assert.deepEqual(await managerFor(async () => ({ code: 1, stdout: SOURCE_UNREACHABLE, stderr: '' })).update(), {
    version: '1.3.8', profile: 'web', failed: 'unreachable', registry: 'registry.npmjs.org',
  })
  // A pnpm that would not even start is still a plain failure.
  await assert.rejects(() => managerFor(async () => { throw Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }) }).update(), /^Error: PackyCode plugin update failed$/u)
})

test('a pnpm that hangs past the update\'s bound reads as an unreachable source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packy-version-hang-'))
  const ownPackageJsonUrl = await npmInstall(root, '1.3.7')
  // A pnpm that never answers, started by the real spawn: Node reports the
  // bound's abort as its own AbortError, which must not hide the reason.
  const pnpm = join(root, 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  await mkdir(join(pnpm, '..'), { recursive: true })
  await writeFile(pnpm, 'setInterval(() => {}, 1000)\n')
  const manager = createPackyCodePluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    fetchImpl: registryOk('1.3.8'),
    execPath: process.execPath,
    argv: [process.execPath, pnpm],
    updateTimeoutMs: 300,
  })
  assert.deepEqual(await manager.update(), { version: '1.3.8', profile: 'web', failed: 'unreachable' })
  // A cancel is still a cancel, not an unreachable source.
  const cancelled = new AbortController()
  setTimeout(() => cancelled.abort(new Error('stopped by the test')), 100)
  await assert.rejects(() => createPackyCodePluginManager({
    env: { DSH_HOME: root },
    ownPackageJsonUrl,
    fetchImpl: registryOk('1.3.8'),
    execPath: process.execPath,
    argv: [process.execPath, pnpm],
    updateTimeoutMs: 60_000,
  }).update({ signal: cancelled.signal }), /^Error: stopped by the test$/u)
})
