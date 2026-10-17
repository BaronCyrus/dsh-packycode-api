/**
 * One Claude Code CLI process serving one DSH conversation.
 *
 * The CLI is the transport, not the agent. It runs with its own tools
 * disabled, DSH's system prompt appended to its own, and DSH's tools listed
 * through the MCP bridge. Each DSH model step is one API request the CLI
 * makes; its raw stream events are replayed to the native Messages client as
 * the HTTP response of that step, frame for frame what the gateway streamed.
 * When the model calls tools, the CLI waits on the bridge while DSH executes
 * them; the next step's tool results answer those calls and the same process
 * continues, so its requests keep one growing, cacheable prefix. Between
 * turns the process waits for the next user message on stdin.
 *
 * A process that cannot continue a request (another history, prompt, tool set
 * or key) is replaced by one resumed from DSH's history; see the transport.
 *
 * @module dsh-packycode-api/claude-cli-session
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveSpawnCommand } from './claude-binary.js'
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, startClaudeMcpBridge, toolResultToMcp } from './claude-mcp-bridge.js'
import { CLI_MARK, CLI_OUTDATED, CLI_UNAVAILABLE } from './failures.js'
import { buildTranscript } from './claude-transcript.js'
import { withProgramDirOnPath } from './locate.js'

/** The CLI wrote nothing for this long after starting: it is stuck before its first request. */
export const CLI_STARTUP_TIMEOUT_MS = 90_000
const KILL_GRACE_MS = 3_000
const MAX_STDERR_CHARS = 16 * 1024
const MAX_LINE_CHARS = 64 * 1024 * 1024
/** The project-directory name the CLI's own files go under in its isolated home. */
export const CLI_PROJECT_DIR_NAME = 'dsh-packycode'

/** A held tool call's answer when the process is torn down first. */
const DISPOSED_RESULT = Object.freeze({ isError: true, content: [{ type: 'text', text: 'DSH replaced this Claude Code CLI process before the tool result arrived.' }] })

const ERROR_TYPES = Object.freeze({ 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 500: 'api_error', 529: 'overloaded_error' })

/**
 * CLI arguments for one process. DSH's tools reach the model through the
 * bridge; the CLI's own tools, settings files, slash commands and session
 * persistence are off, and its system prompt gets DSH's appended.
 * @param options - model, effort, private file paths, and either the
 *   transcript to resume or the fresh session id.
 * @returns argv after the binary.
 */
export function buildCliArgs({ model, effort, systemFile, mcpConfigFile, transcriptFile, sessionId }) {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', model,
    ...(typeof effort === 'string' && effort !== '' ? ['--effort', effort] : []),
    '--tools', '',
    '--strict-mcp-config', '--mcp-config', mcpConfigFile,
    '--allowedTools', `mcp__${MCP_SERVER_NAME}`,
    '--permission-prompts', 'none',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--append-system-prompt-file', systemFile,
    ...(typeof transcriptFile === 'string' ? ['--resume', transcriptFile] : ['--session-id', sessionId]),
  ]
}

/**
 * The child's environment: the request's endpoint and key, an isolated CLI
 * home, retries and fallbacks handed back to DSH, and nothing inherited that
 * would authenticate another account or redirect the request.
 * @param options - endpoint, key, CLI home, output cap, whether the open turn
 *   is continued, and the parent environment.
 * @returns the environment for the child process.
 */
export function buildCliEnvironment({ baseUrl, apiKey, configDir, maxTokens, continues = false, parent = process.env }) {
  if (typeof apiKey !== 'string' || apiKey === '') throw new Error('Claude Code CLI has no PackyCode API key to run with')
  const env = {}
  for (const [name, value] of Object.entries(parent ?? {})) {
    // The user's own Claude configuration must not reach this process: an
    // ambient key, OAuth token, model or base URL would override ours.
    if (/^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE|AWS_BEARER_TOKEN_BEDROCK|MCP_|MAX_MCP_|DISABLE_|ENABLE_)/iu.test(name)) continue
    if (value !== undefined) env[name] = value
  }
  return {
    ...env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_PROJECT_DIR_NAME: CLI_PROJECT_DIR_NAME,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_BUG_COMMAND: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // DSH's retry policy owns retries and key rotation; one DSH step is one request.
    CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
    CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
    // DSH owns memory, project instructions and compaction.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    DISABLE_AUTO_COMPACT: '1',
    DISABLE_COMPACT: '1',
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    // A held call waits for DSH, which may wait for the user.
    CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '0',
    CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0',
    MCP_TOOL_TIMEOUT: '86400000',
    // DSH already bounds tool output; the CLI must pass it through whole.
    MAX_MCP_OUTPUT_TOKENS: '1000000',
    ...(Number.isSafeInteger(maxTokens) && maxTokens > 0 ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) } : {}),
    ...(continues ? { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1' } : {}),
  }
}

/** The gateway message inside the CLI's "API Error: …" result text. */
export function cliErrorMessage(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  const match = /API Error:\s*(?:Request rejected\s*\(\d{3}\)\s*·?\s*|\d{3}\s+)?([\s\S]*)$/u.exec(value)
  return (match?.[1] ?? value).trim() || value
}

/** An HTTP error response carrying the gateway's own words. */
export function errorResponse(status, message, type) {
  const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502
  return new Response(JSON.stringify({ type: 'error', error: { type: type ?? ERROR_TYPES[code] ?? 'api_error', message } }), {
    status: code,
    headers: { 'content-type': 'application/json' },
  })
}

const sseFrame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
const encoder = new TextEncoder()

/**
 * Start a process.
 * @param options - the binary resolver, CLI home, private run directory,
 *   endpoint and key, the request (model, effort, system text, tools, max
 *   tokens), the conversation split (history to resume, input, open-turn
 *   flag), cwd, the CLI session id, the version recorded in the transcript,
 *   and process seams.
 * @returns the session; call `respond()` for each step it serves.
 */
export async function startClaudeCliSession({
  binary,
  configDir,
  runDirectory,
  baseUrl,
  apiKey,
  request,
  conversation,
  cwd,
  sessionId,
  cliVersion,
  oneShot = false,
  platform = process.platform,
  parentEnv = process.env,
  spawnImpl = spawn,
  startupTimeoutMs = CLI_STARTUP_TIMEOUT_MS,
  logger,
}) {
  await mkdir(runDirectory, { recursive: true, mode: 0o700 })
  /** Calls the CLI is holding open, by tool_use id. */
  const held = new Map()
  /** DSH's results for the calls of the last response. */
  const answers = new Map()
  /** The tool_use ids and names of the last response, in order. */
  let pending = []
  let bridge
  let child
  let state = 'starting'
  let step
  let disposing
  let stderr = ''
  let startupTimer
  let apiError
  let sawOutput = false
  let version

  const disposed = () => disposing !== undefined

  const onCall = ({ toolUseId, name }) => {
    if (disposed()) return Promise.resolve(DISPOSED_RESULT)
    // Older CLIs omit the id; take the oldest unanswered call of that name.
    const id = toolUseId ?? pending.find(entry => entry.name === name && !held.has(entry.id) && !entry.served)?.id
    const entry = pending.find(candidate => candidate.id === id)
    if (entry !== undefined) entry.served = true
    if (answers.has(id)) return Promise.resolve(answers.get(id))
    return new Promise(resolve => { held.set(id, resolve) })
  }

  const release = entry => {
    entry.done = true
    entry.signal?.removeEventListener('abort', entry.onAbort)
    if (step === entry) step = undefined
  }

  /** Fail the step that is waiting or streaming. */
  const failStep = (error, { status, message } = {}) => {
    const entry = step
    if (entry === undefined || entry.done) return
    release(entry)
    if (!entry.started) {
      if (status !== undefined) entry.resolve(errorResponse(status, message ?? error.message))
      else entry.reject(error)
      return
    }
    try {
      entry.controller.enqueue(encoder.encode(sseFrame({ type: 'error', error: { type: ERROR_TYPES[status] ?? 'api_error', message: message ?? error.message } })))
      entry.controller.close()
    } catch { /* the consumer went away */ }
  }

  const dispose = (reason = 'closed') => {
    if (disposing !== undefined) return disposing
    state = 'closed'
    clearTimeout(startupTimer)
    for (const resolve of held.values()) resolve(DISPOSED_RESULT)
    held.clear()
    // An unexpected end reaches a waiting step as a transport failure DSH retries.
    failStep(new Error(`Claude Code CLI process ended (${reason})`))
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      try { child.stdin?.end?.() } catch { /* already closed */ }
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, KILL_GRACE_MS)
      timer.unref?.()
      child.once?.('close', () => clearTimeout(timer))
    }
    disposing = Promise.allSettled([bridge?.close(), rm(runDirectory, { recursive: true, force: true })]).then(() => undefined)
    return disposing
  }

  const finishStep = () => {
    const entry = step
    if (entry === undefined || entry.done) return
    release(entry)
    try { entry.controller.close() } catch { /* the consumer went away */ }
    if (oneShot) { void dispose('one-shot request answered'); return }
    if (entry.stopReason === 'tool_use' && entry.tools.length > 0) {
      state = 'awaiting-tools'
      pending = entry.tools
      answers.clear()
    } else if (entry.stopReason === 'end_turn') {
      state = 'idle'
      pending = []
    } else {
      // A truncated, refused or paused answer would make the CLI recover on
      // its own with another request; DSH decides what happens next instead.
      void dispose(`response ended with ${entry.stopReason ?? 'no stop reason'}`)
    }
  }

  const onEvent = event => {
    const entry = step
    if (entry === undefined || entry.done) return
    if (event.type === 'message_start') {
      if (entry.started) {
        failStep(new Error('second response'), { status: 502, message: `${CLI_MARK} began a second response within one step` })
        void dispose('second response in one step')
        return
      }
      entry.started = true
      clearTimeout(startupTimer)
      const body = new ReadableStream({
        start(controller) { entry.controller = controller },
        cancel() { if (!entry.done) { release(entry); void dispose('response cancelled') } },
      })
      entry.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } }))
    }
    if (!entry.started) return
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      entry.tools.push({ id: event.content_block.id, name: String(event.content_block.name ?? '').slice(MCP_TOOL_PREFIX.length) })
    }
    if (event.type === 'message_delta' && typeof event.delta?.stop_reason === 'string') entry.stopReason = event.delta.stop_reason
    try { entry.controller.enqueue(encoder.encode(sseFrame(event))) } catch { /* the consumer went away */ }
    if (event.type === 'message_stop') finishStep()
  }

  const write = frame => {
    try { child?.stdin?.write?.(`${JSON.stringify(frame)}\n`) } catch { /* reported when the process closes */ }
  }

  const onLine = line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message === null || typeof message !== 'object') return
    if (message.type === 'stream_event' && message.event !== null && typeof message.event === 'object') { onEvent(message.event); return }
    if (message.type === 'system' && message.subtype === 'init' && typeof message.claude_code_version === 'string') { version = message.claude_code_version; return }
    if (message.type === 'control_request' && typeof message.request_id === 'string') {
      // Nothing here may prompt; refuse rather than leave the CLI waiting.
      write({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'DeepSeek Harness answers no Claude Code CLI prompts' } })
      return
    }
    if (message.type === 'assistant' && typeof message.error === 'string') {
      apiError = (message.message?.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n')
      return
    }
    if (message.type === 'result') {
      if (message.is_error === true || (typeof message.subtype === 'string' && message.subtype !== 'success')) {
        const text = typeof message.result === 'string' && message.result !== '' ? message.result : apiError ?? 'Claude Code CLI request failed'
        failStep(new Error(text), { status: Number.isInteger(message.api_error_status) ? message.api_error_status : 502, message: `${CLI_MARK} ${cliErrorMessage(text)}` })
        void dispose('request failed')
      }
      apiError = undefined
    }
  }

  /**
   * Serve one step: give the CLI its input, then answer with the response it
   * streams for its next API request.
   * @param input - `{ kind: 'start' }`, `{ kind: 'tools', results }` (tool_use
   *   id → Anthropic tool_result block), or `{ kind: 'turn', content }`.
   * @param signal - the step's abort signal.
   * @returns the HTTP response of this step.
   */
  const respond = (input, signal) => new Promise((resolve, reject) => {
    if (disposed()) { reject(new Error('Claude Code CLI process is closed')); return }
    if (step !== undefined) { reject(new Error('Claude Code CLI process is already serving a step')); return }
    const entry = { started: false, done: false, tools: [], stopReason: undefined, controller: undefined, resolve, reject, signal }
    entry.onAbort = () => {
      const error = signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
      if (entry.started && !entry.done) {
        release(entry)
        try { entry.controller.error(error) } catch { /* already closed */ }
      } else failStep(error)
      void dispose('aborted')
    }
    step = entry
    if (signal?.aborted) { entry.onAbort(); return }
    signal?.addEventListener('abort', entry.onAbort, { once: true })
    state = 'streaming'
    if (input.kind === 'tools') {
      for (const [id, block] of input.results) answers.set(id, toolResultToMcp(block))
      for (const [id, resolveCall] of held) {
        if (answers.has(id)) { held.delete(id); resolveCall(answers.get(id)) }
      }
    } else if (input.kind === 'turn') {
      write({ type: 'user', message: { role: 'user', content: input.content }, parent_tool_use_id: null })
    } else if (conversation.input !== undefined) {
      write({ type: 'user', message: { role: 'user', content: conversation.input }, parent_tool_use_id: null })
    }
  })

  // ── start the bridge and the process ────────────────────────────────────
  try {
    bridge = await startClaudeMcpBridge({ tools: request.tools, onCall })
    const systemFile = join(runDirectory, 'system-prompt.md')
    const mcpConfigFile = join(runDirectory, 'mcp.json')
    await writeFile(systemFile, request.system, { mode: 0o600 })
    await writeFile(mcpConfigFile, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: bridge.url, headers: { Authorization: bridge.authorization }, timeout: 86_400_000 } } }), { mode: 0o600 })
    let transcriptFile
    if (conversation.history.length > 0) {
      transcriptFile = join(runDirectory, `${sessionId}.jsonl`)
      await writeFile(transcriptFile, buildTranscript(conversation.history, { sessionId, cwd, model: request.model, version: cliVersion }), { mode: 0o600 })
    }
    const program = await binary()
    const command = resolveSpawnCommand(program, { platform })
    const args = buildCliArgs({ model: request.model, effort: request.effort, systemFile, mcpConfigFile, transcriptFile, sessionId })
    const env = withProgramDirOnPath(buildCliEnvironment({ baseUrl, apiKey, configDir, maxTokens: request.maxTokens, continues: conversation.continues, parent: parentEnv }), program, platform)
    child = spawnImpl(command.command, [...command.args, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  } catch (error) {
    await dispose('could not start')
    throw error
  }

  let buffer = ''
  child.stdout?.setEncoding?.('utf8')
  child.stderr?.setEncoding?.('utf8')
  child.stdout?.on('data', chunk => {
    sawOutput = true
    buffer += chunk
    if (buffer.length > MAX_LINE_CHARS) buffer = ''
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.startsWith('{')) onLine(line)
      index = buffer.indexOf('\n')
    }
  })
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-MAX_STDERR_CHARS) })
  child.stdin?.on?.('error', () => undefined)
  child.on('error', error => {
    if (error?.code === 'ENOENT') failStep(error, { status: 400, message: CLI_UNAVAILABLE })
    else failStep(error, { status: 502, message: `${CLI_MARK} could not run: ${error.message}` })
    void dispose('could not run')
  })
  child.on('close', (code, killSignal) => {
    if (!disposed()) {
      const detail = stderr.trim().split('\n').slice(-6).join(' ').slice(0, 800)
      const outdated = /unknown option|unrecognized option|error: option|invalid choice/iu.test(detail)
      failStep(new Error(detail), {
        status: outdated ? 400 : 502,
        message: outdated ? `${CLI_OUTDATED}: ${detail}` : `${CLI_MARK} exited with ${code ?? killSignal}${detail === '' ? '' : `: ${detail}`}`,
      })
      logger?.warn?.('packycode-api: Claude Code CLI exited (%s)', code ?? killSignal)
    }
    void dispose('exited')
  })
  startupTimer = setTimeout(() => {
    if (sawOutput || disposed()) return
    failStep(new Error('silent'), { status: 504, message: `${CLI_MARK} printed nothing within ${Math.round(startupTimeoutMs / 1000)}s of starting` })
    void dispose('startup timeout')
  }, startupTimeoutMs)
  startupTimer.unref?.()

  return {
    /** `starting`, `streaming`, `awaiting-tools`, `idle` or `closed`. */
    get state() { return state },
    /** The tool_use ids the CLI is waiting on, in order. */
    get pendingToolIds() { return pending.map(entry => entry.id) },
    get closed() { return disposed() },
    /** The CLI version the process announced, once it has. */
    get version() { return version },
    respond,
    dispose,
  }
}

/** A fresh private directory name for one process. */
export const runDirectoryName = () => `run-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`
