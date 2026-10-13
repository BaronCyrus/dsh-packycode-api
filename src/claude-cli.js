/**
 * Bridge to the local Claude Code CLI.
 *
 * The gateway's `cc` group serves its Claude models only to the official CLI,
 * so this module runs that CLI — the real binary, not an imitation of it — as
 * a subprocess and hands its final answer back to the harness. The child gets
 * the plugin's own endpoint and key through the environment, plus an isolated
 * `CLAUDE_CONFIG_DIR`: `~/.claude/settings.json` env wins over an inherited
 * environment, so without that isolation the user's own CLI configuration
 * would silently override both.
 *
 * @module dsh-packycode-api/claude-cli
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { nvmBinDirs, pathFor, searchPath, withProgramDirOnPath } from './locate.js'
import { waitForSharedRequest } from './request.js'
import { createDeltaRedactor, redactSecrets } from './secret-redactor.js'

/**
 * What the delegated CLI may do on its own. The CLI runs its own tool loop;
 * these are its permission switches, not the harness's sandbox.
 */
export const CLAUDE_CLI_MODES = Object.freeze({
  'read-only': Object.freeze({ allowedTools: Object.freeze(['Read', 'Grep', 'Glob']) }),
  edit: Object.freeze({ allowedTools: Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit']) }),
  full: Object.freeze({ skipPermissions: true }),
})

export const DEFAULT_CLAUDE_MODE = 'edit'
/** Isolated CLI home; the plugin owns the endpoint and key it runs with. */
export const DEFAULT_CLAUDE_CONFIG_DIR = join(homedir(), '.dsh', 'packycode-claude-cli')
export const DEFAULT_CLAUDE_TIMEOUT_MS = 30 * 60 * 1000
/**
 * How long a streaming run may stay silent after starting. The CLI prints its
 * `system/init` line within a second or two once it runs; one that prints
 * nothing for this long is stuck before its first request and is stopped, so
 * the turn reports it instead of spinning until the overall timeout.
 */
export const DEFAULT_CLAUDE_STARTUP_TIMEOUT_MS = 2 * 60 * 1000

/**
 * Upper bound on one run's prompt text. The prompt travels over stdin, so this
 * is a sanity cap rather than an OS limit.
 */
const MAX_PROMPT_CHARS = 100_000
/** Upper bound on the images one run carries. */
const MAX_INPUT_IMAGES = 20

/**
 * Instructions a run carries when its caller supplies none.
 *
 * In print mode the official CLI chooses its own identity line from whether
 * it was given appended instructions: with them it introduces itself to the
 * model as "Claude Code, Anthropic's official CLI for Claude, running within
 * the Claude Agent SDK"; without them as "a Claude agent, built on Anthropic's
 * Claude Agent SDK". PackyCode routes Claude only to Claude Code, and a run
 * without instructions was refused upstream as not coming from it, so every
 * run states what it was delegated to do.
 */
export const DEFAULT_APPEND_SYSTEM_PROMPT = 'This task was delegated to Claude Code by DeepSeek Harness. Complete it with your own tools and reply with the final result.'
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024
const KILL_GRACE_MS = 3_000

/** The npm package the official CLI ships as. */
export const CLAUDE_NPM_PACKAGE = '@anthropic-ai/claude-code'

/** What the turn reports when no CLI could be started at all. */
export const CLAUDE_MISSING_MESSAGE = 'Claude Code CLI is not installed on this device, and Claude models on the PackyCode route run through it. Install it under Settings → PackyCode, or run: npm install -g @anthropic-ai/claude-code'

/** The CLI's file names on PATH: the native installer ships an `.exe`, npm a `.cmd` launcher. */
export const claudeFileNames = platform => (platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'])

/**
 * Where the official installer, npm, and the common Node managers put the CLI,
 * in the order they are tried. PATH is searched after these.
 * @param options - platform, home directory, environment, and a directory reader.
 * @returns absolute candidate paths.
 */
export function claudeBinaryCandidates({ platform = process.platform, home = homedir(), env = process.env, readdir } = {}) {
  const path = pathFor(platform)
  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    return [
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(appData, 'npm', 'claude.cmd'),
      ...(env.NVM_SYMLINK ? [path.join(env.NVM_SYMLINK, 'claude.cmd')] : []),
      path.join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'claude.cmd'),
    ]
  }
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.volta', 'bin', 'claude'),
    ...nvmBinDirs({ home, env, platform, readdir }).map(directory => path.join(directory, 'claude')),
  ]
}

/**
 * Locate an installed Claude Code CLI.
 * @param options - a configured path (wins when it exists), plus platform,
 *   home, environment, and file-system seams.
 * @returns an absolute path, or undefined when none is installed.
 */
export function locateClaudeBinary({ explicit, platform = process.platform, home = homedir(), env = process.env, exists = existsSync, readdir } = {}) {
  const configured = typeof explicit === 'string' ? explicit.trim() : ''
  if (configured !== '') {
    if (pathFor(platform).isAbsolute(configured)) return exists(configured) ? configured : undefined
    const names = platform === 'win32' && !/\.[a-z]+$/iu.test(configured) ? [`${configured}.exe`, `${configured}.cmd`] : [configured]
    return searchPath(names, { platform, env, exists })
  }
  for (const candidate of claudeBinaryCandidates({ platform, home, env, readdir })) {
    if (exists(candidate)) return candidate
  }
  return searchPath(claudeFileNames(platform), { platform, env, exists })
}

/**
 * Locate the Claude Code CLI.
 * @param explicit - a configured path, when the deployment names one.
 * @returns an absolute path when one exists, otherwise the configured value or
 *   the bare name, so starting it reports what is missing.
 */
export function findClaudeBinary(explicit) {
  const configured = typeof explicit === 'string' ? explicit.trim() : ''
  return locateClaudeBinary({ explicit: configured }) ?? (configured === '' ? 'claude' : configured)
}

/** The program an npm `.cmd` launcher runs, relative to the launcher's own directory. */
const SHIM_TARGET = /"%(?:~dp0|dp0%)\\([^"%]+?\.(?:c?js|mjs|exe))"/giu

/**
 * Turn a located CLI into something `spawn` can start without a shell.
 *
 * On Windows npm installs `claude.cmd`, and Node refuses to start a `.cmd`
 * without `shell: true` — which would hand the prompt to `cmd.exe` to parse.
 * The launcher only forwards to a program beside it, so that program is
 * started directly instead: `node <cli.js>` or the packaged `.exe`.
 * @param binary - the located CLI.
 * @param options - platform and file-system seams.
 * @returns the command and the arguments that precede the CLI's own.
 */
export function resolveSpawnCommand(binary, { platform = process.platform, exists = existsSync, readFile = file => readFileSync(file, 'utf8') } = {}) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/iu.test(binary)) return { command: binary, args: [] }
  const path = pathFor(platform)
  const directory = path.dirname(binary)
  let relative
  try {
    relative = [...readFile(binary).matchAll(SHIM_TARGET)]
      .map(match => match[1])
      .find(target => !/^node\.exe$/iu.test(target))
  } catch {
    // Unreadable launcher; fall back to npm's standard layout below.
  }
  const target = relative === undefined
    ? path.join(directory, 'node_modules', ...CLAUDE_NPM_PACKAGE.split('/'), 'cli.js')
    : path.join(directory, relative)
  if (!exists(target)) {
    throw new Error(`Claude Code CLI launcher ${binary} points at a missing program; reinstall it with npm install -g ${CLAUDE_NPM_PACKAGE}`)
  }
  if (/\.exe$/iu.test(target)) return { command: target, args: [] }
  const bundledNode = path.join(directory, 'node.exe')
  return { command: exists(bundledNode) ? bundledNode : 'node', args: [target] }
}

/**
 * Build the CLI arguments for one delegated task.
 *
 * The prompt is not among them: it travels over stdin (see
 * {@link buildClaudeInput}). An argv is bounded — about 32K UTF-16 units on
 * Windows — and cannot carry an image; stdin carries both.
 * @param options - the permission mode, an optional model, whether the caller
 *   consumes the streaming protocol, and instructions appended to the CLI's
 *   own system prompt ({@link DEFAULT_APPEND_SYSTEM_PROMPT} when blank). The
 *   CLI's system prompt and tool set are never replaced: they are part of
 *   what the official client sends.
 * @returns argv after the binary name.
 */
export function buildClaudeArgs({ mode = DEFAULT_CLAUDE_MODE, model, stream = false, appendSystemPrompt, searchBridge, disableNativeSearch = false } = {}) {
  const spec = CLAUDE_CLI_MODES[mode]
  if (spec === undefined) {
    throw new Error(`claude_code mode must be one of ${Object.keys(CLAUDE_CLI_MODES).join(', ')}`)
  }
  const args = stream
    ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose']
    : ['-p', '--output-format', 'json']
  const named = typeof model === 'string' ? model.trim() : ''
  if (named !== '') args.push('--model', named)
  const appended = typeof appendSystemPrompt === 'string' ? appendSystemPrompt.trim() : ''
  const instructions = appended === '' ? DEFAULT_APPEND_SYSTEM_PROMPT : appended
  if (searchBridge !== undefined && (!/^mcp__packycode_search_[a-f0-9]+__web_search$/u.test(searchBridge.toolName ?? '') || typeof searchBridge.configPath !== 'string')) {
    throw new Error('PackyCode CLI search bridge configuration is invalid')
  }
  args.push('--append-system-prompt', searchBridge === undefined ? instructions : `${instructions}\n\n${searchBridge.instructions}`)
  if (spec.skipPermissions === true) args.push('--dangerously-skip-permissions')
  else args.push('--allowedTools', ...spec.allowedTools, ...(searchBridge === undefined ? [] : [searchBridge.toolName]))
  if (disableNativeSearch || searchBridge !== undefined) args.push('--disallowedTools', 'WebSearch')
  // Add one private server for this run. Do not use --strict-mcp-config:
  // unrelated existing project/user MCP configurations remain untouched.
  if (searchBridge !== undefined) args.push('--mcp-config', searchBridge.configPath)
  return args
}

/**
 * Build what the CLI reads from stdin for one run.
 *
 * A streaming run reads one `stream-json` user message, whose content may mix
 * text and Anthropic image blocks; the CLI forwards those images to the model
 * as images. A non-streaming run reads plain prompt text.
 * @param options - the prompt text, or `content` blocks (`text` and
 *   `image` with a base64 `source`), and whether the run streams.
 * @returns the stdin payload.
 */
export function buildClaudeInput({ prompt, content, stream = false } = {}) {
  const blocks = Array.isArray(content)
    ? content.filter(block => (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') || block?.type === 'image')
    : [{ type: 'text', text: typeof prompt === 'string' ? prompt : '' }]
  const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('')
  const images = blocks.filter(block => block.type === 'image')
  if (text.trim() === '' && images.length === 0) throw new Error('claude_code needs a non-empty prompt')
  if (text.length > MAX_PROMPT_CHARS) {
    throw new Error(`claude_code prompt is too long (${text.length} > ${MAX_PROMPT_CHARS} characters)`)
  }
  if (images.length > MAX_INPUT_IMAGES) {
    throw new Error(`claude_code carries at most ${MAX_INPUT_IMAGES} images per run (got ${images.length})`)
  }
  if (!stream) {
    if (images.length > 0) throw new Error('claude_code images need the streaming CLI input')
    return text
  }
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } })}\n`
}

/**
 * The child's environment: this plugin's endpoint and key, an isolated config
 * home, and the CLI's own network-noise switches off.
 * @param options - credential, config home, and the parent environment.
 * @returns the environment for the child process.
 */
export function buildClaudeEnvironment({ baseUrl, token, configDir = DEFAULT_CLAUDE_CONFIG_DIR, parent = process.env } = {}) {
  if (typeof token !== 'string' || token === '') throw new Error('claude_code has no PackyCode API key to run with')
  const env = { ...parent }
  // A defined ANTHROPIC_API_KEY wins inside the CLI, and an ambient one would
  // authenticate the wrong account; an OAuth token would bypass the relay.
  delete env.ANTHROPIC_API_KEY
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  delete env.CLAUDE_CODE_USE_BEDROCK
  delete env.CLAUDE_CODE_USE_VERTEX
  return {
    ...env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_BUG_COMMAND: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}

/**
 * Read the CLI's `--output-format json` payload.
 * @param stdout - the child's stdout.
 * @returns the parsed payload, or undefined when nothing usable was printed.
 */
export function parseClaudeResult(stdout) {
  const text = typeof stdout === 'string' ? stdout : ''
  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const value = JSON.parse(trimmed)
      if (value !== null && typeof value === 'object' && ('result' in value || 'is_error' in value)) return value
    } catch {
      // Not the payload line; keep looking.
    }
  }
  return undefined
}

/** Turn a CLI failure into a message that names what the CLI reported. */
function failureMessage(parsed, exitCode, stderr) {
  const reported = typeof parsed?.result === 'string' && parsed.result.trim() !== '' ? parsed.result.trim() : undefined
  if (reported !== undefined) return `Claude Code CLI failed: ${reported}`
  const detail = (typeof stderr === 'string' ? stderr : '').trim().split('\n').slice(-4).join(' ').slice(0, 400)
  return detail === ''
    ? `Claude Code CLI exited with code ${exitCode ?? 'unknown'}`
    : `Claude Code CLI exited with code ${exitCode ?? 'unknown'}: ${detail}`
}

const MAX_TOOL_SUMMARY_CHARS = 160
/** Tool inputs worth showing, in the order a reader looks for them. */
const TOOL_SUMMARY_FIELDS = Object.freeze(['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'prompt', 'path'])

function oneLine(text, limit = MAX_TOOL_SUMMARY_CHARS) {
  const flat = String(text).replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/**
 * A one-line description of one tool call, for progress display.
 * @param name - the CLI tool name.
 * @param input - the tool call's input object.
 * @returns e.g. `Bash · git status`.
 */
export function summarizeToolUse(name, input) {
  const label = /^mcp__packycode_search_[a-f0-9]+__web_search$/u.test(name ?? '') ? 'PackyCode WebSearch' : typeof name === 'string' && name !== '' ? name : 'tool'
  if (input === null || typeof input !== 'object') return label
  for (const field of TOOL_SUMMARY_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value.trim() !== '') return `${label} · ${oneLine(value)}`
  }
  return label
}

/** One API request's prompt side, in the harness's disjoint buckets. */
function promptUsageOf(usage) {
  if (usage === null || typeof usage !== 'object' || typeof usage.input_tokens !== 'number') return undefined
  return {
    inputTokens: usage.input_tokens,
    cacheReadTokens: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0,
    cacheWriteTokens: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0,
  }
}

function toolResultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join(' ')
}

/**
 * Read one `--output-format stream-json` line.
 *
 * The CLI prints both partial deltas (`stream_event`) and each finished
 * message (`assistant`/`user`); deltas carry the live text and thinking, the
 * finished messages carry complete tool inputs and results.
 * @param event - a parsed stream-json line.
 * @returns what the caller can act on; empty for noise.
 */
export function readClaudeStreamEvents(event) {
  if (event === null || typeof event !== 'object') return []
  if (event.type === 'stream_event') {
    const inner = event.event
    switch (inner?.type) {
      case 'message_start': {
        const usage = promptUsageOf(inner.message?.usage)
        return usage === undefined ? [] : [{ type: 'request-usage', usage }]
      }
      case 'content_block_start': {
        const kind = inner.content_block?.type
        if (kind === 'text') return [{ type: 'block', kind: 'text' }]
        if (kind === 'thinking') return [{ type: 'block', kind: 'reasoning' }]
        return []
      }
      case 'content_block_delta': {
        const delta = inner.delta
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') return [{ type: 'text', text: delta.text }]
        if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') return [{ type: 'reasoning', text: delta.thinking }]
        return []
      }
      default:
        return []
    }
  }
  if (event.type === 'assistant') {
    const content = Array.isArray(event.message?.content) ? event.message.content : []
    const events = content
      .filter(block => block?.type === 'tool_use')
      .map(block => ({ type: 'tool', id: String(block.id ?? ''), summary: summarizeToolUse(block.name, block.input) }))
    const usage = promptUsageOf(event.message?.usage)
    return usage === undefined ? events : [{ type: 'request-usage', usage }, ...events]
  }
  if (event.type === 'user') {
    const content = Array.isArray(event.message?.content) ? event.message.content : []
    return content
      .filter(block => block?.type === 'tool_result' && block.is_error === true)
      .map(block => ({ type: 'tool-error', id: String(block.tool_use_id ?? ''), text: oneLine(toolResultText(block.content)) }))
  }
  if (event.type === 'system') {
    // The CLI says it is up, and when the gateway pushes back it retries on
    // its own — for minutes with the default ten attempts — printing nothing
    // else meanwhile. Both are worth showing, or a throttled turn looks hung.
    if (event.subtype === 'init') {
      return [{
        type: 'started',
        version: typeof event.claude_code_version === 'string' ? event.claude_code_version : '',
        model: typeof event.model === 'string' ? event.model : '',
      }]
    }
    if (event.subtype === 'api_retry') {
      const count = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
      return [{
        type: 'retry',
        attempt: count(event.attempt),
        maxRetries: count(event.max_retries),
        delayMs: count(event.retry_delay_ms),
        status: count(event.error_status),
        error: typeof event.error === 'string' ? event.error : '',
      }]
    }
    return []
  }
  if (event.type === 'result') return [{ type: 'result', result: event }]
  return []
}

const nameList = value => (Array.isArray(value) ? value.filter(item => typeof item === 'string' && item !== '').slice(0, 32) : undefined)

/**
 * What a run may say about the key it used: its ring id and label, why it was
 * chosen, and the groups involved. Never the token.
 * @param credential - what `resolveCredential` answered.
 * @returns the description, or undefined when the credential carries no label.
 */
export function describeRunKey(credential) {
  if (credential === null || typeof credential !== 'object') return undefined
  const label = typeof credential.label === 'string' && credential.label !== '' ? credential.label.slice(0, 60) : undefined
  if (label === undefined) return undefined
  const groups = nameList(credential.groups)
  const required = nameList(credential.required)
  const from = typeof credential.switchedFrom?.label === 'string' && credential.switchedFrom.label !== '' ? credential.switchedFrom.label.slice(0, 60) : undefined
  return {
    ...(typeof credential.id === 'string' && credential.id !== '' ? { id: credential.id } : {}),
    label,
    ...(typeof credential.model === 'string' && credential.model !== '' ? { model: credential.model } : {}),
    ...(groups === undefined ? {} : { groups }),
    ...(required === undefined ? {} : { required }),
    ...(typeof credential.covers === 'boolean' ? { covers: credential.covers } : {}),
    ...(from === undefined ? {} : { switchedFrom: from }),
    ...(credential.uncovered === true ? { uncovered: true } : {}),
  }
}

/**
 * A Claude Code CLI runner.
 * @param options - binary (a path, or a function resolving one per run so a
 *   CLI installed after startup is picked up), config home, credential
 *   resolution, the overall and (streaming) startup time limits, and process
 *   seams.
 * @returns `{ run(options), stream(options) }`.
 */
export function createClaudeRunner({
  binary = findClaudeBinary(),
  configDir = DEFAULT_CLAUDE_CONFIG_DIR,
  resolveCredential,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_CLAUDE_TIMEOUT_MS,
  startupTimeoutMs = DEFAULT_CLAUDE_STARTUP_TIMEOUT_MS,
  platform = process.platform,
  createSearchBridge,
} = {}) {
  if (typeof resolveCredential !== 'function') throw new Error('the Claude Code CLI runner needs resolveCredential')

  const owners = new Set()
  let disposed = false

  /**
   * Every invocation owns its child and optional MCP bridge from asynchronous
   * setup onward. Cancelling setup never spawns a child; stopping a running
   * invocation immediately revokes MCP access, then terminates the CLI.
   */
  const start = async ({ prompt, content, mode, model, appendSystemPrompt, cwd, signal, stream, onStdout, enableSearch }) => {
    // Validate caller input before resolving credentials or opening a server.
    buildClaudeArgs({ mode, model, stream, appendSystemPrompt })
    const input = buildClaudeInput({ prompt, content, stream })
    if (disposed || signal?.aborted) throw new Error('claude_code was aborted')
    const cancellation = new AbortController()
    const runSignal = signal === undefined ? cancellation.signal : AbortSignal.any([signal, cancellation.signal])
    const state = { stdout: '', stderr: '', timedOut: false, silent: false, sawOutput: false, settled: false }
    let child
    let bridge
    let bridgeClosing
    let pendingBridge
    let timer
    let startupTimer
    let killTimer
    let closed
    let done
    const finished = new Promise(resolve => { done = resolve })

    const closeBridge = () => {
      if (bridge === undefined) return Promise.resolve()
      if (bridgeClosing === undefined) bridgeClosing = Promise.resolve().then(() => bridge.close())
      return bridgeClosing
    }
    const clearStartup = () => {
      if (startupTimer !== undefined) clearTimeout(startupTimer)
      startupTimer = undefined
    }
    const kill = () => {
      cancellation.abort()
      // Abort upstream searches and stop accepting paid work NOW, not when
      // an unresponsive CLI eventually closes.
      void closeBridge().catch(() => undefined)
      if (child === undefined || state.settled || child.exitCode !== null || child.signalCode !== null) return
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      if (killTimer !== undefined) return
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, KILL_GRACE_MS)
      killTimer.unref?.()
    }
    const onAbort = () => kill()
    const owner = { kill, finished }
    owners.add(owner)
    runSignal.addEventListener('abort', onAbort, { once: true })

    const cleanup = async () => {
      if (timer !== undefined) clearTimeout(timer)
      clearStartup()
      if (killTimer !== undefined) clearTimeout(killTimer)
      runSignal.removeEventListener('abort', onAbort)
      if (bridge === undefined && pendingBridge !== undefined) {
        // The turn can report cancellation now, but plugin unload still owns
        // and waits for a factory whose filesystem setup completes later.
        void pendingBridge.then(value => value?.close(), () => undefined).catch(() => undefined).finally(() => {
          owners.delete(owner)
          done()
        })
        return
      }
      try {
        await closeBridge()
      } finally {
        owners.delete(owner)
        done()
      }
    }
    const checkAborted = () => {
      if (disposed || runSignal.aborted) throw new Error('claude_code was aborted')
    }
    const setup = async pending => {
      try {
        const value = await waitForSharedRequest(Promise.resolve(pending), runSignal)
        checkAborted()
        return value
      } catch (error) {
        checkAborted()
        throw error
      }
    }

    try {
      // Resolve per invocation, for its own model. The MCP capability below
      // is unrelated to this API key; no key goes into its config or args.
      const credential = await setup(resolveCredential({ model, signal: runSignal }))
      const { baseUrl, token } = credential
      const scrub = value => {
        const text = redactSecrets(String(value), [token])
        return typeof bridge?.scrub === 'function' ? bridge.scrub(text) : text
      }
      const program = await setup(typeof binary === 'function' ? binary() : binary)
      const command = resolveSpawnCommand(program, { platform })
      const env = withProgramDirOnPath(buildClaudeEnvironment({ baseUrl, token, configDir }), program, platform)
      if (typeof createSearchBridge === 'function' && enableSearch !== false) {
        pendingBridge = Promise.resolve().then(() => {
          checkAborted()
          return createSearchBridge({ model, signal: runSignal })
        })
        bridge = await setup(pendingBridge)
        if (bridge === undefined || typeof bridge.close !== 'function') throw new Error('PackyCode CLI search bridge could not start')
      }
      checkAborted()
      const args = buildClaudeArgs({ mode, model, stream, appendSystemPrompt, searchBridge: bridge, disableNativeSearch: typeof createSearchBridge === 'function' })
      child = spawnImpl(command.command, [...command.args, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      if (timeoutMs > 0) {
        timer = setTimeout(() => { state.timedOut = true; kill() }, timeoutMs)
        timer.unref?.()
      }
      if (stream && startupTimeoutMs > 0) {
        startupTimer = setTimeout(() => {
          if (state.sawOutput) return
          state.silent = true
          kill()
        }, startupTimeoutMs)
        startupTimer.unref?.()
      }
      child.stdout?.setEncoding?.('utf8')
      child.stderr?.setEncoding?.('utf8')
      child.stdout?.on('data', chunk => {
        state.sawOutput = true
        clearStartup()
        const text = String(chunk)
        state.stdout = scrub((state.stdout + text).slice(-MAX_CAPTURE_BYTES))
        onStdout?.(text)
      })
      child.stderr?.on('data', chunk => {
        state.stderr = scrub((state.stderr + String(chunk)).slice(-MAX_CAPTURE_BYTES))
      })
      const exited = new Promise((resolve, reject) => {
        child.on('error', error => {
          if (state.settled) return
          state.settled = true
          // ENOENT also means a missing cwd; only blame the CLI when its
          // binary itself is missing.
          const missing = error.code === 'ENOENT' && !(pathFor(platform).isAbsolute(program) && existsSync(program))
          reject(missing
            ? new Error(CLAUDE_MISSING_MESSAGE, { cause: error })
            : new Error(`claude_code could not run ${program}: ${error.message}`, { cause: error }))
        })
        child.on('close', (code, killSignal) => {
          if (state.settled) return
          state.settled = true
          if (state.timedOut) return reject(new Error(`claude_code timed out after ${Math.round(timeoutMs / 1000)}s`))
          if (state.silent) {
            const detail = state.stderr.trim().split('\n').slice(-4).join(' ').slice(0, 400)
            return reject(new Error(`Claude Code CLI printed nothing within ${Math.round(startupTimeoutMs / 1000)}s of starting and was stopped${detail === '' ? '' : `: ${detail}`}`))
          }
          if (runSignal.aborted) return reject(new Error('claude_code was aborted'))
          resolve({ code, killSignal })
        })
      })
      closed = exited.then(async value => { await cleanup(); return value }, async error => { await cleanup(); throw error })
      closed.catch(() => undefined)
      // Attach error listeners before feeding stdin: a quick EPIPE must not
      // crash the host or miss child completion.
      child.stdin?.on?.('error', () => undefined)
      child.stdin?.end?.(input)
      if (runSignal.aborted) kill()
      return { child, state, closed, kill, closeBridge, scrub, deltaRedactor: createDeltaRedactor([token, ...(bridge?.redactionValues?.() ?? [])]), key: describeRunKey(credential), searchBackend: bridge?.backend }
    } catch (error) {
      kill()
      if (closed !== undefined) await closed.catch(() => undefined)
      else await cleanup()
      throw error
    }
  }

  return Object.freeze({
    /**
     * Run one delegated task to completion, reading only its final result.
     * @param options - prompt, mode, model, working directory, and cancellation.
     * @returns the CLI's answer plus its own accounting.
     */
    async run({ prompt, mode = DEFAULT_CLAUDE_MODE, model, appendSystemPrompt, cwd, signal, enableSearch } = {}) {
      const startedAt = Date.now()
      const { state, closed } = await start({ prompt, mode, model, appendSystemPrompt, cwd, signal, enableSearch, stream: false })
      const { code, killSignal } = await closed
      const parsed = parseClaudeResult(state.stdout)
      if (parsed === undefined) throw new Error(failureMessage(undefined, code ?? killSignal, state.stderr))
      if (parsed.is_error === true || code !== 0) throw new Error(failureMessage(parsed, code, state.stderr))
      const usage = parsed.usage ?? {}
      return {
        result: typeof parsed.result === 'string' ? parsed.result : '',
        model: typeof parsed.model === 'string' ? parsed.model : (model ?? ''),
        mode,
        costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0,
        durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : Date.now() - startedAt,
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      }
    },

    /**
     * Run one delegated task, yielding its answer as the CLI produces it.
     * The final `result` event carries the CLI's own accounting, summed over
     * every request the CLI made.
     * @param options - as {@link run}, plus optional `content` blocks (text
     *   and base64 images) that replace `prompt`.
     * @returns an async generator of {@link readClaudeStreamEvents} events and
     *   one closing `result` event.
     */
    async *stream({ prompt, content, mode = DEFAULT_CLAUDE_MODE, model, appendSystemPrompt, cwd, signal, enableSearch } = {}) {
      const startedAt = Date.now()
      let buffer = ''
      let sawResult
      const lines = []
      const { state, closed, kill, closeBridge, scrub, deltaRedactor, key, searchBackend } = await start({
        prompt,
        content,
        mode,
        model,
        appendSystemPrompt,
        cwd,
        signal,
        enableSearch,
        stream: true,
        onStdout: chunk => {
          buffer += chunk
          let index = buffer.indexOf('\n')
          while (index !== -1) {
            lines.push(buffer.slice(0, index))
            buffer = buffer.slice(index + 1)
            index = buffer.indexOf('\n')
          }
        },
      })
      let deltaKind
      const redactedEvents = function* (event) {
        // Accounting events do not change the displayed block. Keep a
        // possible prefix pending across them rather than over-redacting
        // ordinary words ending in the same first letter as a credential.
        if (event.type === 'request-usage') { yield event; return }
        const textual = event.type === 'text' || event.type === 'reasoning'
        if (!textual || event.type !== deltaKind) {
          const tail = deltaRedactor.flush({ boundary: event.type !== 'result' })
          if (tail !== '' && deltaKind !== undefined) yield { type: deltaKind, text: tail }
        }
        if (textual) {
          deltaKind = event.type
          const safe = deltaRedactor.write(event.text)
          if (safe !== '') yield { ...event, text: safe }
        } else yield event
      }
      const drain = function* () {
        while (lines.length > 0) {
          const line = lines.shift().trim()
          if (line === '' || !line.startsWith('{')) continue
          let parsed
          try {
            parsed = JSON.parse(scrub(line))
          } catch {
            continue
          }
          for (const event of readClaudeStreamEvents(parsed)) {
            for (const safe of redactedEvents(event)) {
              if (safe.type === 'result') sawResult = safe.result
              else yield safe
            }
          }
        }
      }
      let finished = false
      let exitStatus
      // A consumer that stops reading early must not leave the CLI running.
      const stopIfAbandoned = () => {
        if (!finished) kill()
      }
      const completion = closed.then(value => {
        finished = true
        exitStatus = value
      }, error => {
        finished = true
        throw error
      })
      completion.catch(() => undefined)
      try {
        // Even the first key/progress yield is owned: iterator.return() must
        // revoke the bridge and terminate the CLI.
        if (key !== undefined) yield { type: 'key', ...JSON.parse(scrub(JSON.stringify(key))) }
        if (searchBackend !== undefined) yield { type: 'search-bridge', backend: searchBackend }
        while (!finished || lines.length > 0) {
          if (lines.length === 0) {
            if (finished) break
            await new Promise(resolve => setTimeout(resolve, 15))
            continue
          }
          yield* drain()
        }
        await completion
        if (buffer.trim().startsWith('{')) {
          try {
            const event = readClaudeStreamEvents(JSON.parse(scrub(buffer.trim()))).find(item => item.type === 'result')
            if (event !== undefined) sawResult = event.result
          } catch {
            // A truncated tail is not a result.
          }
        }
        if (sawResult === undefined) {
          throw new Error(failureMessage(undefined, undefined, state.stderr))
        }
        if (sawResult.is_error === true || exitStatus?.code !== 0) throw new Error(failureMessage(sawResult, exitStatus?.code ?? exitStatus?.killSignal, state.stderr))
        const usage = sawResult.usage ?? {}
        yield {
          type: 'result',
          result: {
            result: typeof sawResult.result === 'string' ? sawResult.result : '',
            model: typeof sawResult.model === 'string' ? sawResult.model : (model ?? ''),
            mode,
            costUsd: typeof sawResult.total_cost_usd === 'number' ? sawResult.total_cost_usd : 0,
            durationMs: typeof sawResult.duration_ms === 'number' ? sawResult.duration_ms : Date.now() - startedAt,
            inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
            outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
            cacheReadTokens: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0,
            cacheWriteTokens: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0,
          },
        }
      } finally {
        stopIfAbandoned()
        await closeBridge()
      }
    },
    /** Revoke bridges and stop every invocation when the plugin unloads. */
    async close() {
      disposed = true
      const active = [...owners]
      for (const owner of active) owner.kill()
      await Promise.all(active.map(owner => owner.finished))
    },
  })
}
