import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { claudeBinaryCandidates, locateClaudeBinary, resolveSpawnCommand } from '../src/claude-binary.js'
import { createClaudeCliTransport } from '../src/claude-cli-transport.js'
import {
  CLAUDE_INSTALL_COMMAND,
  CLAUDE_NPM_LATEST_URL,
  CLAUDE_NPM_UPDATE_COMMAND,
  CLAUDE_SELF_UPDATE_COMMAND,
  createClaudeCliManager,
  createClaudeLatestReader,
  explainNpmFailure,
  isNpmClaudeInstall,
  locateNpm,
  parseClaudeVersion,
} from '../src/claude-install.js'
import { searchPath, withProgramDirOnPath } from '../src/locate.js'
import { createPackyCodeRpc } from '../src/rpc.js'

/** A file system made of the listed paths. */
const filesystem = paths => {
  const set = new Set(paths)
  return { set, exists: candidate => set.has(candidate) }
}

/**
 * A spawn stand-in: `respond(command, args, options)` returns what the child
 * prints and how it exits, or `{ error }` for a program that cannot start.
 */
function scriptedSpawn(respond) {
  const calls = []
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.exitCode = null
    child.signalCode = null
    child.kill = () => true
    const outcome = respond(command, args, options) ?? {}
    queueMicrotask(() => {
      if (outcome.error !== undefined) {
        child.emit('error', outcome.error)
        return
      }
      outcome.effect?.()
      if (outcome.stdout) child.stdout.emit('data', outcome.stdout)
      if (outcome.stderr) child.stderr.emit('data', outcome.stderr)
      child.exitCode = outcome.code ?? 0
      child.emit('close', outcome.code ?? 0, null)
    })
    return child
  }
  return { spawnImpl, calls }
}

const MAC = { platform: 'darwin', home: '/Users/u', readdir: () => [] }
const WIN = {
  platform: 'win32',
  home: 'C:\\Users\\u',
  env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', Path: 'C:\\Windows\\system32;C:\\Program Files\\nodejs' },
}

/** The launcher npm's cmd-shim writes for a JavaScript bin. */
const JS_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`

test('reads the version claude --version prints', () => {
  assert.equal(parseClaudeVersion('2.1.3 (Claude Code)\n'), '2.1.3')
  assert.equal(parseClaudeVersion('1.0.0-beta.2 (Claude Code)'), '1.0.0-beta.2')
  assert.equal(parseClaudeVersion('command not found'), undefined)
  assert.equal(parseClaudeVersion(undefined), undefined)
})

test('finds the CLI where each platform installs it', () => {
  // macOS: the native installer wins over an nvm-installed npm copy.
  const mac = filesystem(['/Users/u/.local/bin/claude', '/Users/u/.nvm/versions/node/v22.1.0/bin/claude'])
  assert.equal(locateClaudeBinary({ ...MAC, env: {}, exists: mac.exists }), '/Users/u/.local/bin/claude')
  // nvm versions are tried newest first.
  const nvm = filesystem(['/Users/u/.nvm/versions/node/v9.0.0/bin/claude', '/Users/u/.nvm/versions/node/v20.3.1/bin/claude'])
  assert.equal(
    locateClaudeBinary({ ...MAC, env: {}, exists: nvm.exists, readdir: () => ['v9.0.0', 'v20.3.1', 'not-a-version'] }),
    '/Users/u/.nvm/versions/node/v20.3.1/bin/claude',
  )
  // Windows: npm's launcher under %APPDATA%\npm.
  const win = filesystem(['C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'])
  assert.equal(locateClaudeBinary({ ...WIN, exists: win.exists }), 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd')
  assert.ok(claudeBinaryCandidates(WIN).includes('C:\\Users\\u\\.local\\bin\\claude.exe'))
  // Nothing installed anywhere.
  assert.equal(locateClaudeBinary({ ...MAC, env: { PATH: '/usr/bin' }, exists: () => false }), undefined)
})

test('PATH is searched with the platform rules, including Windows Path spelling', () => {
  const win = filesystem(['D:\\tools\\claude.exe'])
  assert.equal(searchPath(['claude.exe', 'claude.cmd'], { platform: 'win32', env: { Path: 'C:\\x;"D:\\tools"' }, exists: win.exists }), 'D:\\tools\\claude.exe')
  const mac = filesystem(['/opt/bin/claude'])
  assert.equal(locateClaudeBinary({ ...MAC, env: { PATH: '/usr/bin:/opt/bin' }, exists: mac.exists }), '/opt/bin/claude')
})

test('a configured path wins when it exists and reports absence when it does not', () => {
  const fs = filesystem(['/custom/claude', '/Users/u/.local/bin/claude'])
  assert.equal(locateClaudeBinary({ ...MAC, explicit: '/custom/claude', env: {}, exists: fs.exists }), '/custom/claude')
  assert.equal(locateClaudeBinary({ ...MAC, explicit: '/missing/claude', env: {}, exists: fs.exists }), undefined)
})

test('a Windows npm launcher is started through the program it forwards to, never a shell', () => {
  const shim = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'
  const cli = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
  const fs = filesystem([shim, cli])
  assert.deepEqual(resolveSpawnCommand(shim, { platform: 'win32', exists: fs.exists, readFile: () => JS_SHIM }), { command: 'node', args: [cli] })

  // A node.exe beside the launcher is the one npm itself would use.
  fs.set.add('C:\\Users\\u\\AppData\\Roaming\\npm\\node.exe')
  assert.equal(resolveSpawnCommand(shim, { platform: 'win32', exists: fs.exists, readFile: () => JS_SHIM }).command, 'C:\\Users\\u\\AppData\\Roaming\\npm\\node.exe')

  // A package that ships a native binary: the launcher points at the .exe.
  const exe = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
  fs.set.add(exe)
  const nativeShim = '@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'
  assert.deepEqual(resolveSpawnCommand(shim, { platform: 'win32', exists: fs.exists, readFile: () => nativeShim }), { command: exe, args: [] })

  // A launcher whose program is gone asks for a reinstall instead of failing obscurely.
  assert.throws(() => resolveSpawnCommand(shim, { platform: 'win32', exists: candidate => candidate === shim, readFile: () => JS_SHIM }), /reinstall/u)

  // Everything else starts as is.
  assert.deepEqual(resolveSpawnCommand('C:\\Users\\u\\.local\\bin\\claude.exe', { platform: 'win32' }), { command: 'C:\\Users\\u\\.local\\bin\\claude.exe', args: [] })
  assert.deepEqual(resolveSpawnCommand('/usr/local/bin/claude', { platform: 'darwin' }), { command: '/usr/local/bin/claude', args: [] })
})

test('the program directory joins PATH so a node launcher finds node', () => {
  assert.equal(withProgramDirOnPath({ PATH: '/usr/bin' }, '/opt/homebrew/bin/claude', 'darwin').PATH, '/opt/homebrew/bin:/usr/bin')
  assert.equal(withProgramDirOnPath({ PATH: '/opt/homebrew/bin' }, '/opt/homebrew/bin/claude', 'darwin').PATH, '/opt/homebrew/bin')
  assert.equal(withProgramDirOnPath({ Path: 'C:\\Windows' }, 'C:\\npm\\npm.cmd', 'win32').Path, 'C:\\npm;C:\\Windows')
  assert.equal(withProgramDirOnPath({ PATH: '/usr/bin' }, 'claude', 'darwin').PATH, '/usr/bin')
})

test('finds npm on PATH first, then beside the host Node and in the usual places', () => {
  const fs = filesystem(['/usr/bin/npm', '/opt/homebrew/bin/npm'])
  assert.equal(locateNpm({ ...MAC, env: { PATH: '/usr/bin' }, execPath: '/x/node', exists: fs.exists }), '/usr/bin/npm')
  assert.equal(locateNpm({ ...MAC, env: { PATH: '' }, execPath: '/x/node', exists: fs.exists }), '/opt/homebrew/bin/npm')
  const win = filesystem(['C:\\Program Files\\nodejs\\npm.cmd'])
  assert.equal(locateNpm({ ...WIN, env: { Path: 'C:\\Windows' }, execPath: 'C:\\app\\dsh.exe', exists: win.exists }), 'C:\\Program Files\\nodejs\\npm.cmd')
  assert.equal(locateNpm({ ...MAC, env: {}, execPath: '/x/node', exists: () => false }), undefined)
})

test('an npm failure is classified so the panel can say what to do', () => {
  assert.equal(explainNpmFailure({ code: 243, stderr: 'npm error code EACCES\nnpm error syscall mkdir' }).code, 'permission')
  assert.equal(explainNpmFailure({ code: 1, stderr: 'npm error code EPERM' }).code, 'permission')
  assert.equal(explainNpmFailure({ code: 1, stderr: 'npm error code ENOTFOUND' }).code, 'network')
  assert.equal(explainNpmFailure({ code: null, error: new Error('timed out after 900s') }).code, 'timeout')
  const other = explainNpmFailure({ code: 7, stderr: '' })
  assert.deepEqual(other, { code: 'failed', detail: 'npm exited with code 7' })
})

test('detects an installed CLI and its version', async () => {
  const fs = filesystem(['/Users/u/.local/bin/claude'])
  const { spawnImpl, calls } = scriptedSpawn(() => ({ stdout: '2.1.3 (Claude Code)\n' }))
  const cli = createClaudeCliManager({ ...MAC, env: { PATH: '/usr/bin' }, exists: fs.exists, spawnImpl, configDir: '/tmp/cfg' })
  const status = await cli.status()
  assert.equal(status.installed, true)
  assert.equal(status.version, '2.1.3')
  assert.equal(status.path, '/Users/u/.local/bin/claude')
  assert.equal(status.command, CLAUDE_INSTALL_COMMAND)
  assert.equal(status.install.state, 'idle')
  assert.equal(status.minVersion, '2.1.259')
  assert.equal(status.outdated, true, '2.1.3 lacks options the transport passes')
  assert.equal(status.updateCommand, CLAUDE_SELF_UPDATE_COMMAND)
  assert.deepEqual(calls[0].args, ['--version'])
  // The probe runs in the plugin's isolated config home, never the user's.
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, '/tmp/cfg')
  assert.equal(calls[0].options.shell, undefined)

  // A cached read does not spawn again; a forced one does.
  await cli.status()
  assert.equal(calls.length, 1)
  await cli.status({ force: true })
  assert.equal(calls.length, 2)
  assert.equal(await cli.binary(), '/Users/u/.local/bin/claude')
})

test('a CLI that is found but cannot run is reported with its output', async () => {
  const fs = filesystem(['/Users/u/.local/bin/claude'])
  const { spawnImpl } = scriptedSpawn(() => ({ code: 127, stderr: 'env: node: No such file or directory' }))
  const cli = createClaudeCliManager({ ...MAC, env: {}, exists: fs.exists, spawnImpl })
  const status = await cli.status()
  assert.equal(status.installed, true)
  assert.equal(status.version, undefined)
  assert.match(status.error, /env: node/u)
})

test('without a CLI anywhere it asks npm for its global bin before giving up', async () => {
  const fs = filesystem(['/usr/bin/npm', '/Users/u/.npm-prefix/bin/claude'])
  const { spawnImpl, calls } = scriptedSpawn((command, args) => {
    if (command === '/usr/bin/npm' && args.join(' ') === 'prefix -g') return { stdout: '/Users/u/.npm-prefix\n' }
    if (args[0] === '--version') return { stdout: '2.0.0 (Claude Code)' }
    return { code: 1 }
  })
  const cli = createClaudeCliManager({ ...MAC, env: { PATH: '/usr/bin' }, exists: fs.exists, spawnImpl })
  const status = await cli.status()
  assert.equal(status.path, '/Users/u/.npm-prefix/bin/claude')
  assert.equal(status.version, '2.0.0')
  // npm runs with its own directory on PATH so its `env node` resolves.
  assert.match(calls[0].options.env.PATH, /^\/usr\/bin/u)

  fs.set.delete('/Users/u/.npm-prefix/bin/claude')
  const missing = await cli.status({ force: true })
  assert.equal(missing.installed, false)
  assert.equal(await cli.binary(), 'claude', 'the runner then reports the CLI as missing')
})

test('installs with npm install -g and detects the result', async () => {
  const fs = filesystem(['/usr/bin/npm'])
  const { spawnImpl, calls } = scriptedSpawn((command, args) => {
    if (args.join(' ') === 'prefix -g') return { stdout: '/usr\n' }
    if (args.join(' ') === 'install -g @anthropic-ai/claude-code --allow-scripts=@anthropic-ai/claude-code') {
      return { effect: () => fs.set.add('/usr/bin/claude'), stdout: 'added 3 packages in 4s\n' }
    }
    if (args[0] === '--version') return { stdout: '2.1.3 (Claude Code)\n' }
    return { code: 1 }
  })
  const cli = createClaudeCliManager({ ...MAC, env: { PATH: '/usr/bin' }, exists: fs.exists, spawnImpl })
  assert.equal((await cli.status()).installed, false)

  const started = cli.install()
  assert.equal(started.state, 'running')
  assert.equal(cli.install().state, 'running', 'a second click joins the install in flight')
  assert.equal((await cli.status()).install.state, 'running')
  await cli.settled()

  const status = await cli.status()
  assert.equal(status.install.state, 'succeeded')
  assert.equal(status.installed, true)
  assert.equal(status.version, '2.1.3')
  assert.equal(calls.filter(call => call.args.join(' ') === 'install -g @anthropic-ai/claude-code --allow-scripts=@anthropic-ai/claude-code').length, 1)
  assert.equal(CLAUDE_INSTALL_COMMAND, 'npm install -g @anthropic-ai/claude-code --allow-scripts=@anthropic-ai/claude-code', 'npm 12 runs the postinstall that places the native binary only when allowed')
  assert.equal(calls.find(call => call.args[0] === 'install').options.shell, false)
})

test('on Windows npm runs through its .cmd launcher with constant arguments', async () => {
  const npm = 'C:\\Program Files\\nodejs\\npm.cmd'
  const fs = filesystem([npm])
  const { spawnImpl, calls } = scriptedSpawn(() => ({ code: 1, stderr: 'npm error code EPERM\nnpm error syscall rename' }))
  const cli = createClaudeCliManager({ ...WIN, execPath: 'C:\\app\\dsh.exe', exists: fs.exists, spawnImpl })
  cli.install()
  await cli.settled()
  const call = calls.find(entry => entry.args[0] === 'install')
  assert.equal(call.command, `"${npm}"`)
  assert.deepEqual(call.args, ['install', '-g', '@anthropic-ai/claude-code', '--allow-scripts=@anthropic-ai/claude-code'])
  assert.equal(call.options.shell, true)
  const status = await cli.status()
  assert.equal(status.platform, 'win32')
  assert.equal(status.install.state, 'failed')
  assert.equal(status.install.code, 'permission')
  assert.match(status.install.detail, /EPERM/u)
})

test('without npm the install fails at once and says why', async () => {
  const { spawnImpl, calls } = scriptedSpawn(() => ({ code: 1 }))
  const cli = createClaudeCliManager({ ...MAC, env: { PATH: '' }, execPath: '/x/node', exists: () => false, spawnImpl })
  const result = cli.install()
  assert.equal(result.state, 'failed')
  assert.equal(result.code, 'npm-missing')
  assert.equal(calls.length, 0)
})

test('a broken Windows npm launcher is reported as an unavailable CLI before anything starts', async () => {
  const calls = []
  const transport = createClaudeCliTransport({
    binary: async () => 'C:\\npm\\claude.cmd',
    configDir: await mkdtemp(join(tmpdir(), 'packy-launcher-')),
    platform: 'win32',
    spawnImpl: (...args) => { calls.push(args); throw new Error('must not spawn') },
  })
  try {
    // The real launcher is read from disk; this one does not exist, so the
    // transport refuses before spawning instead of handing argv to cmd.exe.
    const response = await transport.fetch('https://cf.api.fan/v1/messages', { body: JSON.stringify({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'x' }] }) },
      { apiKey: 'sk-launcher-fixture', sessionId: '11111111-2222-4333-8444-555555555555' })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error.type, 'dsh_cli_unavailable')
    assert.match(body.error.message, /reinstall/u)
    assert.equal(calls.length, 0)
  } finally { await transport.close() }
})

/**
 * A CLI whose version the scripted `update` (or npm install) changes; every
 * spawn is recorded.
 */
function updatableCli({ version, onUpdate }) {
  const state = { version }
  const { spawnImpl, calls } = scriptedSpawn((command, args) => {
    if (args.at(-1) === '--version') return state.version === undefined ? { code: 1, stderr: 'Error: claude native binary not installed.' } : { stdout: `${state.version} (Claude Code)\n` }
    return onUpdate(command, args, state) ?? { code: 1 }
  })
  return { state, spawnImpl, calls }
}

test('an outdated native CLI updates itself in the plugin\'s CLI home, without the user\'s Claude settings', async () => {
  const binary = '/Users/u/.local/bin/claude'
  const fs = filesystem([binary])
  const { spawnImpl, calls } = updatableCli({
    version: '2.1.223',
    onUpdate: (command, args, state) => (command === binary && args.join(' ') === 'update'
      ? { effect: () => { state.version = '2.1.303' }, stdout: 'Successfully updated from 2.1.223 to version 2.1.303\n' }
      : undefined),
  })
  const cli = createClaudeCliManager({
    ...MAC, exists: fs.exists, spawnImpl, configDir: '/Users/u/.dsh/packycode-claude-cli',
    realpath: () => '/Users/u/.local/share/claude/versions/2.1.223',
    env: { PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy', DISABLE_AUTOUPDATER: '1', CLAUDE_CONFIG_DIR: '/Users/u/.claude', ANTHROPIC_API_KEY: 'sk-ambient' },
  })
  const before = await cli.status()
  assert.equal(before.outdated, true)
  assert.equal(before.updateCommand, 'claude update')

  const started = cli.update()
  assert.equal(started.state, 'running')
  assert.equal(started.action, 'update')
  assert.equal(cli.update(), started, 'a second click joins the update in flight')
  assert.equal(cli.install().action, 'update', 'an install cannot start while the update runs')
  await cli.settled()

  const after = await cli.status()
  assert.equal(after.version, '2.1.303')
  assert.equal(after.outdated, false)
  assert.equal(after.install.state, 'succeeded')
  assert.equal(after.install.action, 'update')
  assert.equal(after.install.from, '2.1.223')
  assert.equal(after.install.to, '2.1.303')
  const run = calls.find(call => call.args.join(' ') === 'update')
  assert.equal(run.command, binary)
  assert.equal(run.options.env.CLAUDE_CONFIG_DIR, '/Users/u/.dsh/packycode-claude-cli')
  assert.equal(run.options.env.DISABLE_AUTOUPDATER, undefined, 'an ambient switch must not stop the update')
  assert.equal(run.options.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(run.options.env.HTTPS_PROXY, 'http://proxy', 'the user\'s proxy still applies')
  assert.equal(run.options.shell, undefined)
  assert.equal(calls.filter(call => call.command.endsWith('npm')).length, 0)
})

test('an npm install of the CLI is updated by npm itself, allowing the package\'s scripts', async () => {
  const binary = '/usr/local/bin/claude'
  const fs = filesystem([binary, '/usr/local/bin/npm', '/usr/bin/npm'])
  const { spawnImpl, calls } = updatableCli({
    version: '2.1.223',
    onUpdate: (command, args, state) => (command === '/usr/local/bin/npm' && args.join(' ') === 'install -g @anthropic-ai/claude-code@latest --allow-scripts=@anthropic-ai/claude-code'
      ? { effect: () => { state.version = '2.1.303' }, stdout: 'changed 2 packages\n' }
      : undefined),
  })
  const cli = createClaudeCliManager({ ...MAC, env: { PATH: '/usr/bin' }, exists: fs.exists, spawnImpl,
    realpath: () => '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe' })
  assert.equal((await cli.status()).updateCommand, CLAUDE_NPM_UPDATE_COMMAND)
  cli.update()
  await cli.settled()
  const after = await cli.status()
  assert.equal(after.install.state, 'succeeded')
  assert.equal(after.version, '2.1.303')
  // npm beside the CLI owns its global prefix; the CLI's own updater would run
  // npm without --allow-scripts and leave no native binary on npm 12.
  assert.equal(calls.filter(call => call.args.join(' ') === 'update').length, 0)
  assert.equal(calls.filter(call => call.command === '/usr/bin/npm').length, 0)
  assert.equal(CLAUDE_NPM_UPDATE_COMMAND, 'npm install -g @anthropic-ai/claude-code@latest --allow-scripts=@anthropic-ai/claude-code')
})

test('an update that leaves the CLI old, broken, or unreached says so', async () => {
  const binary = '/Users/u/.local/bin/claude'
  const fs = filesystem([binary])
  const options = { ...MAC, env: { PATH: '/usr/bin' }, exists: fs.exists, realpath: () => '/opt/homebrew/Caskroom/claude-code/2.1.223/claude' }

  const homebrew = updatableCli({ version: '2.1.223', onUpdate: () => ({ stdout: 'Claude is managed by Homebrew.\nTo update, run:\n  brew upgrade claude-code\n' }) })
  const stale = createClaudeCliManager({ ...options, spawnImpl: homebrew.spawnImpl })
  stale.update()
  await stale.settled()
  const old = (await stale.status()).install
  assert.equal(old.code, 'still-outdated')
  assert.match(old.detail, /brew upgrade claude-code/u)

  const breaking = updatableCli({ version: '2.1.223', onUpdate: (_command, _args, state) => ({ effect: () => { state.version = undefined }, stdout: 'Successfully updated\n' }) })
  const broken = createClaudeCliManager({ ...options, spawnImpl: breaking.spawnImpl })
  broken.update()
  await broken.settled()
  const result = await broken.status()
  assert.equal(result.install.code, 'broken-after-update')
  assert.match(result.install.detail, /native binary not installed/u)
  assert.equal(result.installed, true)

  const offline = updatableCli({ version: '2.1.223', onUpdate: () => ({ code: 1, stderr: 'Error: getaddrinfo ENOTFOUND storage.googleapis.com' }) })
  const unreached = createClaudeCliManager({ ...options, spawnImpl: offline.spawnImpl })
  unreached.update()
  await unreached.settled()
  assert.equal((await unreached.status()).install.code, 'network')

  const nothing = createClaudeCliManager({ ...MAC, env: { PATH: '' }, execPath: '/x/node', exists: () => false, spawnImpl: offline.spawnImpl })
  nothing.update()
  await nothing.settled()
  assert.equal((await nothing.status()).install.code, 'not-installed')
})

test('the newest CLI release is read from npm with a timeout, no redirects, and a cache', async () => {
  let clock = 1_000
  const requests = []
  let answer = () => Response.json({ name: '@anthropic-ai/claude-code', version: '2.1.303' })
  const reader = createClaudeLatestReader({
    now: () => clock,
    fetchImpl: async (url, init) => {
      requests.push({ url, redirect: init.redirect, signal: init.signal })
      return answer()
    },
  })
  assert.equal(reader.peek(), undefined)
  assert.equal(await reader.read(), '2.1.303')
  assert.equal(requests[0].url, CLAUDE_NPM_LATEST_URL)
  assert.equal(CLAUDE_NPM_LATEST_URL, 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest')
  assert.equal(requests[0].redirect, 'error')
  assert.ok(requests[0].signal instanceof AbortSignal, 'the read is bounded by a timeout')
  // Cached for half an hour; a forced read (the panel's refresh) goes out again.
  clock += 29 * 60_000
  assert.equal(await reader.read(), '2.1.303')
  assert.equal(requests.length, 1)
  assert.equal(await reader.read({ force: true }), '2.1.303')
  assert.equal(requests.length, 2)
  assert.equal(reader.peek(), '2.1.303')

  // No answer offers nothing, never throws, and is retried after two minutes.
  for (const failing of [
    () => { throw new TypeError('fetch failed') },
    () => new Response('nope', { status: 503 }),
    () => new Response('{not json', { status: 200 }),
    () => Response.json({ version: 'latest' }),
  ]) {
    answer = failing
    assert.equal(await reader.read({ force: true }), undefined)
  }
  const failed = requests.length
  clock += 60_000
  assert.equal(await reader.read(), undefined)
  assert.equal(requests.length, failed)
  answer = () => Response.json({ version: '2.1.304' })
  clock += 61_000
  assert.equal(await reader.read(), '2.1.304')
})

/** A newest-release reader that answers `version` and counts its reads. */
const latestAt = version => {
  const reads = []
  return { reads, read: async options => { reads.push(options); return version }, peek: () => version }
}

test('a usable CLI behind npm\'s latest offers the update; a current one does not', async () => {
  const binary = '/Users/u/.local/bin/claude'
  const fs = filesystem([binary])
  const options = { ...MAC, env: { PATH: '/usr/bin' }, exists: fs.exists, realpath: () => '/Users/u/.local/share/claude/versions/2.1.295' }
  const latest = latestAt('2.1.303')
  const behind = createClaudeCliManager({ ...options, spawnImpl: updatableCli({ version: '2.1.295', onUpdate: () => undefined }).spawnImpl, latestReader: latest })
  const status = await behind.status()
  assert.equal(status.outdated, false)
  assert.equal(status.latest, '2.1.303')
  assert.equal(status.updateAvailable, true)
  assert.equal(status.updateCommand, CLAUDE_SELF_UPDATE_COMMAND)
  await behind.status({ force: true })
  assert.deepEqual(latest.reads, [{ force: false }, { force: true }], 'the panel\'s refresh re-reads the newest release')

  const current = createClaudeCliManager({ ...options, spawnImpl: updatableCli({ version: '2.1.303', onUpdate: () => undefined }).spawnImpl, latestReader: latestAt('2.1.303') })
  assert.equal((await current.status()).updateAvailable, false)
  const unknown = createClaudeCliManager({ ...options, spawnImpl: updatableCli({ version: '2.1.295', onUpdate: () => undefined }).spawnImpl, latestReader: latestAt(undefined) })
  const offline = await unknown.status()
  assert.equal(offline.updateAvailable, false)
  assert.equal(Object.hasOwn(offline, 'latest'), false)
  const without = createClaudeCliManager({ ...options, spawnImpl: updatableCli({ version: '2.1.295', onUpdate: () => undefined }).spawnImpl })
  assert.equal((await without.status()).updateAvailable, false)
})

test('a CLI behind npm\'s latest updates the way it was installed and reports the new version', async () => {
  const binary = '/Users/u/.local/bin/claude'
  const fs = filesystem([binary])
  const { spawnImpl, calls } = updatableCli({
    version: '2.1.295',
    onUpdate: (command, args, state) => (command === binary && args.join(' ') === 'update'
      ? { effect: () => { state.version = '2.1.303' }, stdout: 'Successfully updated from 2.1.295 to version 2.1.303\n' }
      : undefined),
  })
  const latest = latestAt('2.1.303')
  const cli = createClaudeCliManager({ ...MAC, env: { PATH: '/usr/bin' }, exists: fs.exists, spawnImpl, latestReader: latest,
    realpath: () => '/Users/u/.local/share/claude/versions/2.1.295' })
  assert.equal((await cli.status()).updateAvailable, true)
  cli.update()
  const during = await cli.status()
  assert.equal(during.install.state, 'running')
  assert.equal(during.latest, '2.1.303', 'a poll during the update shows the last reading')
  const readsBefore = latest.reads.length
  await cli.settled()
  const after = await cli.status()
  assert.deepEqual([after.install.state, after.install.from, after.install.to], ['succeeded', '2.1.295', '2.1.303'])
  assert.equal(after.updateAvailable, false)
  assert.ok(latest.reads.length > readsBefore)
  assert.equal(calls.filter(call => call.args.join(' ') === 'update').length, 1)
})

test('an update that leaves a usable CLI where it was says so instead of claiming success', async () => {
  const binary = '/Users/u/.local/bin/claude'
  const fs = filesystem([binary])
  const options = { ...MAC, env: { PATH: '/usr/bin' }, exists: fs.exists, realpath: () => '/opt/homebrew/Caskroom/claude-code/2.1.295/claude' }

  // The command exited cleanly but the CLI is still behind: the installer's own words come back.
  const homebrew = updatableCli({ version: '2.1.295', onUpdate: () => ({ stdout: 'Claude is managed by Homebrew.\nTo update, run:\n  brew upgrade claude-code\n' }) })
  const held = createClaudeCliManager({ ...options, spawnImpl: homebrew.spawnImpl, latestReader: latestAt('2.1.303') })
  held.update()
  await held.settled()
  const stayed = (await held.status()).install
  assert.deepEqual([stayed.state, stayed.code, stayed.latest], ['failed', 'not-updated', '2.1.303'])
  assert.match(stayed.detail, /brew upgrade claude-code/u)

  // A failed command that changed nothing is that failure, not a success.
  const offline = updatableCli({ version: '2.1.295', onUpdate: () => ({ code: 1, stderr: 'Error: getaddrinfo ENOTFOUND storage.googleapis.com' }) })
  const unreached = createClaudeCliManager({ ...options, spawnImpl: offline.spawnImpl, latestReader: latestAt('2.1.303') })
  unreached.update()
  await unreached.settled()
  assert.deepEqual([(await unreached.status()).install.state, (await unreached.status()).install.code], ['failed', 'network'])

  // With the newest release unknown, a clean run that changed nothing is reported as such.
  const quiet = updatableCli({ version: '2.1.295', onUpdate: () => ({ stdout: 'Claude Code is up to date (2.1.295)\n' }) })
  const unknown = createClaudeCliManager({ ...options, spawnImpl: quiet.spawnImpl, latestReader: latestAt(undefined) })
  unknown.update()
  await unknown.settled()
  const same = (await unknown.status()).install
  assert.deepEqual([same.state, same.from, same.to], ['succeeded', '2.1.295', '2.1.295'])
})

test('npm installs are told apart from native ones by where the CLI really lives', () => {
  assert.equal(isNpmClaudeInstall('/usr/local/bin/claude', { platform: 'darwin', realpath: () => '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js' }), true)
  assert.equal(isNpmClaudeInstall('/Users/u/.local/bin/claude', { platform: 'darwin', realpath: () => '/Users/u/.local/share/claude/versions/2.1.303' }), false)
  assert.equal(isNpmClaudeInstall('/Users/u/.local/bin/claude', { platform: 'darwin', realpath: () => { throw new Error('ENOENT') } }), false)
  assert.equal(isNpmClaudeInstall('C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd', { platform: 'win32' }), true)
  assert.equal(isNpmClaudeInstall('C:\\Users\\u\\.local\\bin\\claude.exe', { platform: 'win32', realpath: path => path }), false)
})

test('the RPC surface reports the CLI and starts its install or update', async () => {
  const seen = []
  const claude = {
    status: async options => {
      seen.push(['status', options])
      const last = seen.findLast(([kind]) => kind === 'install' || kind === 'update')?.[0]
      return { installed: false, command: CLAUDE_INSTALL_COMMAND, install: last === undefined ? { state: 'idle' } : { state: 'running', action: last } }
    },
    install: () => {
      seen.push(['install'])
      return { state: 'running', action: 'install' }
    },
    update: payload => {
      seen.push(['update', payload])
      return { state: 'running', action: 'update' }
    },
    transportFor: names => ({ transport: names?.includes('cc') ? 'cli' : 'http', reason: 'group' }),
  }
  const groups = { read: async () => ({ keys: [{ id: 'a', groups: ['cc'] }, { id: 'b', groups: ['cc-sale'] }], descriptions: {} }) }
  const handler = createPackyCodeRpc({ ring: {}, balance: {}, groups, hosts: () => ({}), preference: {}, claude })
  const status = await handler('claude-cli/status', { force: true })
  assert.equal(status.ok, true)
  assert.equal(status.value.installed, false)
  assert.deepEqual(seen[0], ['status', { force: true }])
  const installed = await handler('claude-cli/install', {})
  assert.deepEqual(installed.value.install, { state: 'running', action: 'install' })
  // The browser cannot steer the update: no payload reaches it.
  const updated = await handler('claude-cli/update', { transport: 'http', command: 'rm -rf /' })
  assert.equal(updated.ok, true)
  assert.deepEqual(updated.value.install, { state: 'running', action: 'update' })
  assert.deepEqual(seen.find(([kind]) => kind === 'update'), ['update', undefined])
  // Each key's groups name the route its Claude requests take.
  const reading = await handler('groups', {})
  assert.deepEqual(reading.value.keys.map(key => key.claudeTransport.transport), ['cli', 'http'])

  const without = createPackyCodeRpc({ ring: {}, balance: {}, hosts: () => ({}), preference: {} })
  const refused = await without('claude-cli/status', {})
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /unavailable/u)
})
