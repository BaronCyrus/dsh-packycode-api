/**
 * Detecting, installing and updating the local Claude Code CLI.
 *
 * Claude requests on a key whose group serves only the official client are
 * sent by this device's Claude Code CLI, so the settings panel shows whether
 * one is installed (and which version), and offers to install it with
 * `npm install -g @anthropic-ai/claude-code` — the same command on macOS and
 * Windows — or to update one older than the transport needs or than npm's
 * `latest`. Both run on the host, never in a shell built from user text:
 * their arguments are constants.
 *
 * npm 12 skips install scripts unless they are allowed, and the CLI's
 * postinstall is what puts its native binary in place, so every npm install
 * allows the package's scripts (npm 10 and 11 accept the option as well).
 *
 * @module dsh-packycode-api/claude-install
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'

import {
  CLAUDE_MIN_VERSION,
  CLAUDE_NPM_PACKAGE,
  DEFAULT_CLAUDE_CONFIG_DIR,
  claudeFileNames,
  isClaudeCliOutdated,
  locateClaudeBinary,
  resolveSpawnCommand,
} from './claude-binary.js'
import { nvmBinDirs, pathFor, searchPath, withProgramDirOnPath } from './locate.js'
import { compareSemver, parseSemver } from './plugin-version.js'
import { ambientFetch, boundedFetch } from './request.js'

const ALLOW_SCRIPTS = `--allow-scripts=${CLAUDE_NPM_PACKAGE}`
export const CLAUDE_INSTALL_COMMAND = `npm install -g ${CLAUDE_NPM_PACKAGE} ${ALLOW_SCRIPTS}`
/** How an npm install of the CLI is updated. */
export const CLAUDE_NPM_UPDATE_COMMAND = `npm install -g ${CLAUDE_NPM_PACKAGE}@latest ${ALLOW_SCRIPTS}`
/** How any other install (the native installer's, Homebrew's) is updated: by the CLI itself. */
export const CLAUDE_SELF_UPDATE_COMMAND = 'claude update'
/**
 * The newest CLI release. npm's `latest` tag and the native installer's
 * `latest` channel name the same version, and both updates above install it.
 */
export const CLAUDE_NPM_LATEST_URL = `https://registry.npmjs.org/${CLAUDE_NPM_PACKAGE}/latest`

const INSTALL_ARGS = Object.freeze(['install', '-g', CLAUDE_NPM_PACKAGE, ALLOW_SCRIPTS])
const NPM_UPDATE_ARGS = Object.freeze(['install', '-g', `${CLAUDE_NPM_PACKAGE}@latest`, ALLOW_SCRIPTS])
const SELF_UPDATE_ARGS = Object.freeze(['update'])
const PREFIX_ARGS = Object.freeze(['prefix', '-g'])
const VERSION_TIMEOUT_MS = 20_000
const PREFIX_TIMEOUT_MS = 20_000
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000
/** A detection is reused this long; the panel's refresh and an install bypass it. */
const DETECTION_TTL_MS = 5 * 60 * 1000
const MAX_CAPTURE_CHARS = 64 * 1024
const LATEST_TIMEOUT_MS = 10_000
/** The newest release is read again after this long; the panel's refresh bypasses it. */
const LATEST_TTL_MS = 30 * 60 * 1000
/** An unanswered read is retried sooner, so one network blip does not hide an update for long. */
const LATEST_RETRY_MS = 2 * 60 * 1000
const DETAIL_LINES = 8
const DETAIL_CHARS = 800

/**
 * The version `claude --version` prints, e.g. `2.1.3 (Claude Code)`.
 * @param output - the command's stdout.
 * @returns the semantic version, or undefined.
 */
export function parseClaudeVersion(output) {
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u.exec(typeof output === 'string' ? output : '')?.[1]
}

/** The last lines of a command's output, bounded for display. */
function detailOf(...texts) {
  const lines = texts
    .filter(text => typeof text === 'string')
    .join('\n')
    .split(/\r?\n/u)
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
  const tail = lines.slice(-DETAIL_LINES).join('\n')
  return tail.length > DETAIL_CHARS ? tail.slice(-DETAIL_CHARS) : tail
}

/**
 * Where npm usually lives, in the order tried after PATH.
 * @param options - platform, home, environment, the host's own Node, and a directory reader.
 * @returns absolute candidate paths.
 */
export function npmCandidates({ platform = process.platform, home = homedir(), env = process.env, execPath = process.execPath, readdir } = {}) {
  const path = pathFor(platform)
  const name = platform === 'win32' ? 'npm.cmd' : 'npm'
  const beside = typeof execPath === 'string' && execPath !== '' ? [path.join(path.dirname(execPath), name)] : []
  if (platform === 'win32') {
    return [
      ...beside,
      ...(env.NVM_SYMLINK ? [path.join(env.NVM_SYMLINK, name)] : []),
      path.join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', name),
    ]
  }
  return [
    ...beside,
    '/opt/homebrew/bin/npm',
    '/usr/local/bin/npm',
    path.join(home, '.volta', 'bin', 'npm'),
    ...nvmBinDirs({ home, env, platform, readdir }).map(directory => path.join(directory, 'npm')),
  ]
}

/**
 * Locate npm: PATH first (the one the user's terminal runs), then the usual places.
 * @param options - as {@link npmCandidates}, plus an existence check.
 * @returns an absolute path, or undefined.
 */
export function locateNpm({ platform = process.platform, home = homedir(), env = process.env, execPath = process.execPath, exists = existsSync, readdir } = {}) {
  const onPath = searchPath(platform === 'win32' ? ['npm.cmd'] : ['npm'], { platform, env, exists })
  if (onPath !== undefined) return onPath
  return npmCandidates({ platform, home, env, execPath, readdir }).find(candidate => exists(candidate))
}

/**
 * Whether a located CLI is npm's global package. npm's own update must then
 * be used: the CLI's `claude update` runs npm without allowing the package's
 * scripts, which on npm 12 reports success and leaves no native binary.
 * @param binary - the located CLI.
 * @param options - platform and a realpath seam.
 */
export function isNpmClaudeInstall(binary, { platform = process.platform, realpath = realpathSync } = {}) {
  if (typeof binary !== 'string' || binary === '') return false
  if (platform === 'win32' && /\.(?:cmd|bat)$/iu.test(binary)) return true
  let resolved = binary
  try {
    resolved = realpath(binary)
  } catch {
    // Unreadable link: judge the path as located.
  }
  return /[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]/u.test(resolved)
}

/**
 * The parent environment without the user's own Claude settings: a
 * `DISABLE_AUTOUPDATER`, config directory or key there must not steer the
 * plugin's update.
 */
const withoutClaudeSettings = env => Object.fromEntries(Object.entries(env ?? {})
  .filter(([name, value]) => value !== undefined && !/^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE|DISABLE_)/iu.test(name)))

/**
 * Classify an npm failure so the panel can say what to do about it.
 * @param result - the captured npm run.
 * @returns `{ code, detail }`.
 */
export function explainNpmFailure(result) {
  const detail = detailOf(result?.error?.message, result?.stderr, result?.stdout)
  if (/\bEACCES\b|\bEPERM\b|permission denied|operation not permitted/iu.test(detail)) return { code: 'permission', detail }
  if (/\bENOTFOUND\b|\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|network/iu.test(detail)) return { code: 'network', detail }
  if (/timed out after/iu.test(detail)) return { code: 'timeout', detail }
  return { code: 'failed', detail: detail === '' ? `npm exited with code ${result?.code ?? 'unknown'}` : detail }
}

/**
 * The newest Claude Code CLI version on npm, read host-side with a timeout
 * and redirects refused. A read never throws: no answer is `undefined`, which
 * offers no update.
 * @param options - fetch, registry URL, timeout, cache lifetimes and clock.
 * @returns `{ read({ force }), peek() }`.
 */
export function createClaudeLatestReader({
  fetchImpl = ambientFetch,
  url = CLAUDE_NPM_LATEST_URL,
  timeoutMs = LATEST_TIMEOUT_MS,
  ttlMs = LATEST_TTL_MS,
  retryMs = LATEST_RETRY_MS,
  now = () => Date.now(),
} = {}) {
  let cached
  let inFlight
  const load = async () => {
    let version
    try {
      const response = await boundedFetch(url, { headers: { Accept: 'application/json' } }, { fetchImpl, timeoutMs })
      if (response.ok) version = (await response.json())?.version
    } catch {
      version = undefined
    }
    return { version: parseSemver(version) === undefined ? undefined : version, fetchedAt: now() }
  }
  return Object.freeze({
    async read({ force = false } = {}) {
      const lifetime = cached?.version === undefined ? retryMs : ttlMs
      if (!force && cached !== undefined && now() - cached.fetchedAt < lifetime) return cached.version
      if (inFlight === undefined) {
        inFlight = load().then(value => {
          cached = value
          return value
        }).finally(() => {
          inFlight = undefined
        })
      }
      return (await inFlight).version
    },
    /** The last version read, without a request. */
    peek: () => cached?.version,
  })
}

/**
 * Run a command to completion and capture its output. Never rejects: a
 * missing program or a timeout comes back as `error`.
 */
function runCaptured(spawnImpl, command, args, options, timeoutMs) {
  return new Promise(resolve => {
    let child
    try {
      child = spawnImpl(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error })
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = outcome => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ stdout, stderr, ...outcome })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      finish({ code: null, error: new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`) })
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', chunk => {
      stdout = (stdout + String(chunk)).slice(-MAX_CAPTURE_CHARS)
    })
    child.stderr?.on('data', chunk => {
      stderr = (stderr + String(chunk)).slice(-MAX_CAPTURE_CHARS)
    })
    child.on('error', error => finish({ code: null, error }))
    child.on('close', code => finish({ code, error: undefined }))
  })
}

/**
 * The CLI manager behind the settings panel and the runner.
 * @param options - the configured CLI path (a function, so a settings change
 *   applies without a restart), the newest-release reader (none: no update
 *   is offered for a CLI the transport can use), plus platform, environment,
 *   and process seams.
 * @returns `{ binary, detect, install, status }`.
 */
export function createClaudeCliManager({
  explicitPath = () => '',
  latestReader,
  platform = process.platform,
  home = homedir(),
  env = process.env,
  execPath = process.execPath,
  configDir = DEFAULT_CLAUDE_CONFIG_DIR,
  spawnImpl = spawn,
  exists = existsSync,
  readFile = file => readFileSync(file, 'utf8'),
  realpath = realpathSync,
  readdir,
  now = () => Date.now(),
} = {}) {
  const path = pathFor(platform)
  const configured = () => {
    const value = explicitPath()
    return typeof value === 'string' ? value.trim() : ''
  }
  const locateOptions = () => ({ platform, home, env, exists, readdir })
  const npm = () => locateNpm({ ...locateOptions(), execPath })

  /**
   * Run npm. On Windows npm is a `.cmd` launcher, which Node starts only
   * through `cmd.exe`; that is safe here because every argument is a constant.
   */
  const runNpm = (program, args, timeoutMs) => runCaptured(
    spawnImpl,
    platform === 'win32' ? `"${program}"` : program,
    args,
    { env: withProgramDirOnPath(env, program, platform), shell: platform === 'win32' },
    timeoutMs,
  )

  /** npm's global bin directory, read once; a GUI PATH often lacks it. */
  let globalBin
  const npmGlobalBin = async () => {
    if (globalBin !== undefined) return globalBin === '' ? undefined : globalBin
    const program = npm()
    if (program === undefined) return undefined
    const result = await runNpm(program, PREFIX_ARGS, PREFIX_TIMEOUT_MS)
    const prefix = result.code === 0 ? result.stdout.trim().split(/\r?\n/u).at(-1)?.trim() ?? '' : ''
    globalBin = prefix === '' ? '' : (platform === 'win32' ? prefix : path.join(prefix, 'bin'))
    return globalBin === '' ? undefined : globalBin
  }

  const locate = async () => {
    const found = locateClaudeBinary({ explicit: configured(), ...locateOptions() })
    if (found !== undefined || configured() !== '') return found
    const bin = await npmGlobalBin()
    if (bin === undefined) return undefined
    return claudeFileNames(platform).map(name => path.join(bin, name)).find(candidate => exists(candidate))
  }

  const probe = async () => {
    const found = await locate()
    if (found === undefined) {
      return configured() === ''
        ? { installed: false }
        : { installed: false, configuredPath: configured() }
    }
    let command
    try {
      command = resolveSpawnCommand(found, { platform, exists, readFile })
    } catch (error) {
      return { installed: true, path: found, error: error.message }
    }
    const result = await runCaptured(spawnImpl, command.command, [...command.args, '--version'], {
      env: {
        ...withProgramDirOnPath(env, found, platform),
        CLAUDE_CONFIG_DIR: configDir,
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    }, VERSION_TIMEOUT_MS)
    const version = result.code === 0 ? parseClaudeVersion(result.stdout) : undefined
    if (version !== undefined) return { installed: true, path: found, version }
    return {
      installed: true,
      path: found,
      error: detailOf(result.error?.message, result.stderr, result.stdout) || `exited with code ${result.code ?? 'unknown'}`,
    }
  }

  let detection
  let detecting
  const detect = async ({ force = false } = {}) => {
    if (!force && detection !== undefined && now() - detection.checkedAt < DETECTION_TTL_MS) return detection
    if (detecting !== undefined) return detecting
    detecting = probe()
      .catch(error => ({ installed: false, error: error instanceof Error ? error.message : String(error) }))
      .then(value => {
        detection = { ...value, checkedAt: now() }
        return detection
      })
      .finally(() => {
        detecting = undefined
      })
    return detecting
  }

  /** The install or update in flight or last finished; `action` says which. */
  let installation = { state: 'idle' }
  let installing

  const install = () => {
    if (installing !== undefined) return installation
    const program = npm()
    if (program === undefined) {
      installation = { state: 'failed', action: 'install', code: 'npm-missing', finishedAt: now() }
      return installation
    }
    installation = { state: 'running', action: 'install', startedAt: now(), npm: program }
    installing = runNpm(program, INSTALL_ARGS, INSTALL_TIMEOUT_MS)
      .then(async result => {
        // npm may have just created its global directory; read it again.
        globalBin = undefined
        if (result.code !== 0) {
          installation = { state: 'failed', action: 'install', ...explainNpmFailure(result), finishedAt: now() }
          await detect({ force: true })
          return
        }
        const found = await detect({ force: true })
        installation = found.installed && found.version !== undefined
          ? { state: 'succeeded', action: 'install', finishedAt: now() }
          : { state: 'failed', action: 'install', code: 'not-found-after-install', detail: detailOf(result.stdout, result.stderr), finishedAt: now() }
      })
      .catch(error => {
        installation = { state: 'failed', action: 'install', code: 'failed', detail: error instanceof Error ? error.message : String(error), finishedAt: now() }
      })
      .finally(() => {
        installing = undefined
      })
    return installation
  }

  /** npm for an npm install of the CLI: the one beside it shares its global prefix. */
  const npmBeside = binary => {
    const beside = path.join(path.dirname(binary), platform === 'win32' ? 'npm.cmd' : 'npm')
    return exists(beside) ? beside : npm()
  }

  /** The newest release, or undefined when unknown. */
  const latestVersion = ({ force = false } = {}) => latestReader?.read({ force }) ?? Promise.resolve(undefined)
  /** Whether a version is older than the newest release; false when either is unknown. */
  const behind = (version, latest) => latest !== undefined && compareSemver(version, latest) === -1

  /**
   * Update the located CLI the way it was installed: npm's global package
   * through npm, anything else through `claude update` with the plugin's
   * own CLI home. Success means the CLI now detected is new enough and either
   * changed or was not behind the newest release; a command that exited
   * cleanly but left it behind says so.
   */
  const runUpdate = async () => {
    const before = await detect({ force: true })
    if (!before.installed || typeof before.path !== 'string') {
      installation = { state: 'failed', action: 'update', code: 'not-installed', finishedAt: now() }
      return
    }
    let result
    if (isNpmClaudeInstall(before.path, { platform, realpath })) {
      const program = npmBeside(before.path)
      if (program === undefined) {
        installation = { state: 'failed', action: 'update', code: 'npm-missing', finishedAt: now() }
        return
      }
      installation = { ...installation, npm: program }
      result = await runNpm(program, NPM_UPDATE_ARGS, INSTALL_TIMEOUT_MS)
      globalBin = undefined
    } else {
      const command = resolveSpawnCommand(before.path, { platform, exists, readFile })
      result = await runCaptured(spawnImpl, command.command, [...command.args, ...SELF_UPDATE_ARGS], {
        env: {
          ...withProgramDirOnPath(withoutClaudeSettings(env), before.path, platform),
          CLAUDE_CONFIG_DIR: configDir,
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
        },
      }, INSTALL_TIMEOUT_MS)
    }
    const after = await detect({ force: true })
    const latest = await latestVersion()
    const from = before.version === undefined ? {} : { from: before.version }
    const changed = after.version !== undefined && after.version !== before.version
    if (after.version !== undefined && !isClaudeCliOutdated(after.version) && (changed || (result.code === 0 && !behind(after.version, latest)))) {
      installation = { state: 'succeeded', action: 'update', ...from, to: after.version, finishedAt: now() }
    } else if (result.code !== 0) {
      installation = { state: 'failed', action: 'update', ...explainNpmFailure(result), finishedAt: now() }
    } else if (after.version === undefined) {
      installation = { state: 'failed', action: 'update', code: 'broken-after-update', detail: detailOf(after.error, result.stdout, result.stderr), finishedAt: now() }
    } else if (isClaudeCliOutdated(after.version)) {
      installation = { state: 'failed', action: 'update', code: 'still-outdated', detail: detailOf(result.stdout, result.stderr), finishedAt: now() }
    } else {
      installation = { state: 'failed', action: 'update', code: 'not-updated', latest, detail: detailOf(result.stdout, result.stderr), finishedAt: now() }
    }
  }

  const update = () => {
    if (installing !== undefined) return installation
    installation = { state: 'running', action: 'update', startedAt: now() }
    installing = runUpdate()
      .catch(error => {
        installation = { state: 'failed', action: 'update', code: 'failed', detail: error instanceof Error ? error.message : String(error), finishedAt: now() }
      })
      .finally(() => {
        installing = undefined
      })
    return installation
  }

  return Object.freeze({
    /**
     * The CLI the runner should start: the last detected one while it still
     * exists, otherwise a fresh lookup — so a CLI installed after startup,
     * from the panel or a terminal, is used without restarting.
     */
    async binary() {
      if (detection?.path !== undefined && exists(detection.path)) return detection.path
      const found = await locate()
      return found ?? (configured() === '' ? 'claude' : configured())
    },
    detect,
    /** The last detection, without probing again; undefined before the first. */
    lastDetection: () => (detection === undefined ? undefined : { ...detection }),
    install,
    update,
    /** Wait for an install or update in flight; for tests and scripts. */
    settled: () => installing ?? Promise.resolve(),
    /**
     * What the settings panel shows. While an install or update runs, the
     * last detection and the last newest-release reading stand instead of
     * probing a half-written package. The two reads run side by side.
     */
    async status({ force = false } = {}) {
      const [value, latest] = installing === undefined
        ? await Promise.all([detect({ force }), latestVersion({ force })])
        : [detection, latestReader?.peek()]
      return {
        installed: value?.installed === true,
        ...(value?.version === undefined ? {} : { version: value.version }),
        minVersion: CLAUDE_MIN_VERSION,
        outdated: isClaudeCliOutdated(value?.version),
        ...(latest === undefined ? {} : { latest }),
        updateAvailable: value?.version !== undefined && behind(value.version, latest),
        ...(value?.path === undefined ? {} : {
          updateCommand: isNpmClaudeInstall(value.path, { platform, realpath }) ? CLAUDE_NPM_UPDATE_COMMAND : CLAUDE_SELF_UPDATE_COMMAND,
        }),
        ...(value?.path === undefined ? {} : { path: value.path }),
        ...(value?.configuredPath === undefined ? {} : { configuredPath: value.configuredPath }),
        ...(value?.error === undefined ? {} : { error: value.error }),
        ...(value?.checkedAt === undefined ? {} : { checkedAt: value.checkedAt }),
        platform,
        command: CLAUDE_INSTALL_COMMAND,
        install: { ...installation },
      }
    },
  })
}
