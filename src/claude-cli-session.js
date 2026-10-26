/**
 * One Claude Code CLI process serving one DSH conversation, with Claude Code
 * as the agent.
 *
 * The CLI runs as it runs in a terminal: its own system prompt, its own tools,
 * its own session. Each API request it makes is one DSH model step — its raw
 * stream events are replayed to the native Messages client as that step's
 * HTTP response. The tool calls in a response reach DSH as calls of the
 * `claude_code` mirror tool, and ExitPlanMode as DSH's own `exit_plan_mode`,
 * so DSH shows them, asks the user whenever the CLI asks for permission, and
 * reviews plans. The CLI executes its own tools; this module only tells it
 * what DSH decided and reports what the CLI did.
 *
 * Between steps the CLI keeps working: it runs the tools DSH allowed and
 * starts its next request, whose events are held until DSH asks for the next
 * step. Between turns it waits for the next user message on stdin.
 *
 * @module dsh-packycode-api/claude-cli-session
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { resolveSpawnCommand } from './claude-binary.js'
import { CLI_MARK, CLI_OUTDATED, CLI_UNAVAILABLE } from './failures.js'
import { withProgramDirOnPath } from './locate.js'

/** The CLI wrote nothing for this long after starting: it is stuck before its first request. */
export const CLI_STARTUP_TIMEOUT_MS = 90_000
const KILL_GRACE_MS = 3_000
const MAX_STDERR_CHARS = 16 * 1024
const MAX_LINE_CHARS = 64 * 1024 * 1024
/** The project-directory name the CLI's own files go under in its isolated home. */
export const CLI_PROJECT_DIR_NAME = 'dsh-packycode'

/** The DSH tool every Claude Code tool call is shown and decided through. */
export const MIRROR_TOOL = 'claude_code'
/** DSH's plan review; Claude Code's ExitPlanMode becomes a call of it. */
export const PLAN_TOOL = 'exit_plan_mode'
/** What DSH shows when Claude Code submits a plan without writing a plan file. */
const MISSING_PLAN = '# 计划\n\n（Claude Code 没有写出计划文件，请让它把计划写完整后再提交。）'

const ERROR_TYPES = Object.freeze({ 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 500: 'api_error', 529: 'overloaded_error' })

/**
 * CLI arguments for one process. Claude Code keeps its own system prompt and
 * tools; its permission prompts come to this host over stdio, and it reads
 * only the settings in its isolated home — never a project's settings, hooks
 * or MCP servers. A one-shot process (a session title) has no tools and no
 * session record.
 * @param options - model, effort, permission mode, the CLI session id and
 *   whether to resume it, and whether the process is one-shot.
 * @returns argv after the binary.
 */
export function buildCliArgs({ model, effort, permissionMode = 'default', cliSessionId, resume = false, oneShot = false }) {
  return [
    ...(oneShot ? ['-p'] : []),
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', model,
    ...(typeof effort === 'string' && effort !== '' ? ['--effort', effort] : []),
    ...(oneShot
      ? ['--tools', '', '--no-session-persistence', '--permission-mode', 'default']
      : ['--permission-prompt-tool', 'stdio', '--permission-mode', permissionMode, '--allow-dangerously-skip-permissions']),
    '--setting-sources', 'user',
    '--strict-mcp-config',
    ...(oneShot ? [] : resume ? ['--resume', cliSessionId] : ['--session-id', cliSessionId]),
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
    // No hidden state of its own: DSH shows every turn, and background work
    // that outlives a turn would run where DSH cannot show it.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
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

/** One assistant message's identity, as both the CLI's stream and DSH's replay show it. */
export function responseFingerprint({ toolIds = [], text = '' } = {}) {
  return JSON.stringify([toolIds, text.trim()])
}

/** A tool result's content as text, for DSH's card and for errors. */
export function toolResultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (block?.type === 'text' ? block.text : block?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n')
}

/**
 * Start a process.
 * @param options - the binary resolver, CLI home, endpoint and key, model,
 *   effort and output cap, cwd, the CLI session id and whether to resume it,
 *   whether the interrupted turn is continued, the permission mode, a sink
 *   for permission prompts about calls DSH has not been shown (a subagent's),
 *   a sink for each served response, and process seams.
 * @returns the session; call `respond()` for each step it serves.
 */
export async function startClaudeCliSession({
  binary,
  configDir,
  baseUrl,
  apiKey,
  model,
  effort,
  maxTokens,
  cwd,
  cliSessionId = randomUUID(),
  resume = false,
  continues = false,
  permissionMode = 'default',
  oneShot = false,
  nestedPermission,
  onServed,
  platform = process.platform,
  parentEnv = process.env,
  spawnImpl = spawn,
  startupTimeoutMs = CLI_STARTUP_TIMEOUT_MS,
  logger,
}) {
  /** Tool calls by tool_use id: the CLI's name and input, its permission prompt, its result. */
  const calls = new Map()
  /** Stream events of a request that started before DSH asked for its step. */
  const held = []
  /** Answers to control requests this host sent, by request id. */
  const controls = new Map()
  const plansDir = resolve(configDir, 'plans')
  const startedAt = Date.now()
  let child
  let state = 'starting'
  let mode = permissionMode
  let step
  let disposing
  let stderr = ''
  let startupTimer
  let apiError
  let sawOutput = false
  let version
  /** The last response served in full, and the one being streamed. */
  let served
  let streaming
  /** A user message was written and its request has not started yet. */
  let inputPending = false
  /** A turn of the CLI is running: from its input until its `result`. */
  let cliBusy = false
  /** A request failed between steps; the next step reports it. */
  let failure
  let interrupting = false
  /** The CLI is compacting its own context; that request is not a DSH step. */
  let compacting = false
  /** Callers waiting for an interrupted turn to end. */
  const stopWaiters = []
  let lastPlanFile
  let pending = []

  const disposed = () => disposing !== undefined

  const callOf = id => {
    let call = calls.get(id)
    if (call === undefined) {
      call = { id, name: undefined, input: undefined, permission: undefined, verdict: undefined, answered: false, result: undefined, decisionWaiters: [], resultWaiters: [] }
      calls.set(id, call)
    }
    return call
  }

  const settleDecision = (call, decision) => {
    for (const waiter of call.decisionWaiters.splice(0)) waiter.resolve(decision)
  }
  const settleResult = call => {
    for (const waiter of call.resultWaiters.splice(0)) waiter.resolve(call.result)
    settleDecision(call, 'auto')
  }

  const release = entry => {
    entry.done = true
    entry.signal?.removeEventListener('abort', entry.onAbort)
    if (step === entry) step = undefined
  }

  /** Fail the step that is waiting or streaming. */
  const failStep = (error, { status, message } = {}) => {
    const entry = step
    if (entry === undefined || entry.done) return false
    release(entry)
    if (!entry.started) {
      if (status !== undefined) entry.resolve(errorResponse(status, message ?? error.message))
      else entry.reject(error)
      return true
    }
    try {
      entry.controller.enqueue(encoder.encode(sseFrame({ type: 'error', error: { type: ERROR_TYPES[status] ?? 'api_error', message: message ?? error.message } })))
      entry.controller.close()
    } catch { /* the consumer went away */ }
    return true
  }

  const write = frame => {
    try { child?.stdin?.write?.(`${JSON.stringify(frame)}\n`) } catch { /* reported when the process closes */ }
  }

  /** Send a control request; resolves with the CLI's answer, or undefined if the process ends first. */
  const control = request => new Promise(resolveControl => {
    if (disposed()) { resolveControl(undefined); return }
    const id = `dsh-${randomUUID()}`
    controls.set(id, resolveControl)
    write({ type: 'control_request', request_id: id, request })
  })

  /**
   * Record DSH's verdict on a call and pass it on: at once when the CLI is
   * asking, or the moment it asks. The first verdict stands.
   */
  const decide = (call, response) => {
    call.verdict ??= response
    if (call.permission === undefined || call.answered) return
    call.answered = true
    const verdict = typeof call.verdict === 'function' ? call.verdict(call.permission.request) : call.verdict
    write({ type: 'control_response', response: { subtype: 'success', request_id: call.permission.requestId, response: verdict } })
  }

  const dispose = (reason = 'closed') => {
    if (disposing !== undefined) return disposing
    state = 'closed'
    clearTimeout(startupTimer)
    const gone = new Error(`Claude Code CLI process ended (${reason})`)
    for (const call of calls.values()) {
      for (const waiter of [...call.decisionWaiters.splice(0), ...call.resultWaiters.splice(0)]) waiter.reject(gone)
    }
    for (const resolveControl of controls.values()) resolveControl(undefined)
    controls.clear()
    for (const resolveStop of stopWaiters.splice(0)) resolveStop()
    // An unexpected end reaches a waiting step as a transport failure DSH retries.
    failStep(gone)
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      try { child.stdin?.end?.() } catch { /* already closed */ }
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, KILL_GRACE_MS)
      timer.unref?.()
      child.once?.('close', () => clearTimeout(timer))
    }
    disposing = Promise.resolve()
    return disposing
  }

  /**
   * The plan Claude Code submitted. Its ExitPlanMode carries no text: the plan
   * is the file it wrote in its plans directory — the one this process wrote
   * last, else the newest one written since the process started.
   */
  const planText = input => {
    if (typeof input?.plan === 'string' && input.plan.trim() !== '') return headed(input.plan)
    const read = path => { try { return headed(readFileSync(path, 'utf8')) } catch { return undefined } }
    if (lastPlanFile !== undefined) {
      const text = read(lastPlanFile)
      if (text !== undefined) return text
    }
    let newest
    try {
      for (const name of readdirSync(plansDir)) {
        if (!name.endsWith('.md')) continue
        const path = join(plansDir, name)
        const mtime = statSync(path).mtimeMs
        if (mtime >= startedAt - 1000 && (newest === undefined || mtime > newest.mtime)) newest = { path, mtime }
      }
    } catch { /* no plans yet */ }
    return (newest === undefined ? undefined : read(newest.path)) ?? MISSING_PLAN
  }

  const finishStep = () => {
    const entry = step
    if (entry === undefined || entry.done) return
    release(entry)
    try { entry.controller.close() } catch { /* the consumer went away */ }
    const fingerprint = responseFingerprint({ toolIds: entry.tools.map(tool => tool.id), text: entry.text.join('') })
    served = { fingerprint, toolIds: entry.tools.map(tool => tool.id), planId: entry.tools.find(tool => tool.name === PLAN_TOOL)?.id }
    streaming = undefined
    if (oneShot) { void dispose('one-shot request answered'); return }
    onServed?.(served)
    if (entry.stopReason === 'tool_use' && entry.tools.length > 0) {
      state = 'awaiting-tools'
      pending = entry.tools
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
    const enqueue = frame => { try { entry.controller.enqueue(encoder.encode(sseFrame(frame))) } catch { /* the consumer went away */ } }
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const name = String(event.content_block.name ?? '')
      const id = String(event.content_block.id ?? '')
      // Only a CLI in plan mode waits for DSH's review; outside it Claude Code
      // refuses its own ExitPlanMode, and DSH shows that as an ordinary call.
      const dshName = name === 'ExitPlanMode' && mode === 'plan' ? PLAN_TOOL : MIRROR_TOOL
      const call = callOf(id)
      call.name = name
      entry.blocks.set(event.index, { id, name, dshName, json: '' })
      entry.tools.push({ id, name: dshName, cliName: name })
      enqueue({ ...event, content_block: { type: 'tool_use', id, name: dshName, input: {} } })
      return
    }
    const block = entry.blocks.get(event.index)
    if (block !== undefined && event.type === 'content_block_delta') {
      if (event.delta?.type === 'input_json_delta') block.json += String(event.delta.partial_json ?? '')
      return
    }
    if (block !== undefined && event.type === 'content_block_stop') {
      let input = {}
      try { input = block.json.trim() === '' ? {} : JSON.parse(block.json) } catch { /* the CLI's assistant frame carries it whole */ }
      const call = callOf(block.id)
      call.input ??= input
      const args = block.dshName === PLAN_TOOL ? { plan: planText(call.input) } : { tool: block.name, input: call.input }
      enqueue({ type: 'content_block_delta', index: event.index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } })
      enqueue(event)
      return
    }
    if (event.type === 'content_block_start' && event.content_block?.type === 'text') entry.text.push(String(event.content_block.text ?? ''))
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      entry.text.push(String(event.delta.text ?? ''))
      streaming = { text: entry.text.join('') }
    }
    if (event.type === 'message_delta' && typeof event.delta?.stop_reason === 'string') entry.stopReason = event.delta.stop_reason
    enqueue(event)
    if (event.type === 'message_stop') finishStep()
  }

  /** A stream event: the step's, or held until DSH asks for the next step. */
  const onStreamEvent = event => {
    if (interrupting || compacting) return
    if (event.type === 'message_start') {
      if (!cliBusy && !inputPending && step === undefined) {
        // A turn Claude Code started on its own (a scheduled prompt): DSH cannot show it.
        logger?.warn?.('packycode-api: Claude Code started a turn on its own; it was interrupted')
        cliBusy = true
        void stopTurn()
        return
      }
      cliBusy = true
      inputPending = false
    }
    if (step !== undefined && !step.done) onEvent(event)
    else held.push(event)
  }

  /**
   * Stop the CLI's running turn; resolves once it has ended. The process
   * stays for the next turn. A CLI with no turn running resolves at once.
   */
  const stopTurn = () => new Promise(resolveStop => {
    if (disposed() || !cliBusy) { resolveStop(); return }
    stopWaiters.push(resolveStop)
    if (interrupting) return
    interrupting = true
    void control({ subtype: 'interrupt' })
  })

  const writeUser = content => {
    inputPending = true
    cliBusy = true
    write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: cliSessionId })
  }

  const onLine = line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message === null || typeof message !== 'object') return
    // A subagent's own requests and tools belong to the Agent call that started them.
    const nested = typeof message.parent_tool_use_id === 'string' && message.parent_tool_use_id !== ''
    if (message.type === 'stream_event' && message.event !== null && typeof message.event === 'object') {
      if (!nested) onStreamEvent(message.event)
      return
    }
    if (message.type === 'system') {
      if (message.subtype === 'init') {
        if (typeof message.claude_code_version === 'string') version = message.claude_code_version
        if (typeof message.permissionMode === 'string') mode = message.permissionMode
      }
      if (message.subtype === 'status') {
        if (typeof message.permissionMode === 'string') mode = message.permissionMode
        // Each request is announced: `requesting` for the conversation, `compacting` for a summary.
        if (Object.hasOwn(message, 'status') && message.status !== null) compacting = message.status === 'compacting'
      }
      if (message.subtype === 'compact_boundary') compacting = false
      return
    }
    if (message.type === 'control_response') {
      const id = message.response?.request_id
      const resolveControl = controls.get(id)
      if (resolveControl !== undefined) { controls.delete(id); resolveControl(message.response) }
      return
    }
    if (message.type === 'control_request' && typeof message.request_id === 'string') {
      const request = message.request ?? {}
      if (request.subtype !== 'can_use_tool') {
        write({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'DeepSeek Harness does not answer this Claude Code CLI request' } })
        return
      }
      const id = typeof request.tool_use_id === 'string' ? request.tool_use_id
        // Older CLIs omit the id; take the oldest unanswered call of that name.
        : [...calls.values()].find(call => call.name === request.tool_name && call.permission === undefined && call.result === undefined)?.id
      if (id === undefined || !calls.has(id) || calls.get(id).name === undefined) {
        // A call DSH was never shown (a subagent's): ask DSH without a card.
        void Promise.resolve(nestedPermission?.(request)).then(
          answer => answer ?? { behavior: 'deny', message: 'DeepSeek Harness could not ask about this call.' },
          () => ({ behavior: 'deny', message: 'DeepSeek Harness could not ask about this call.' }),
        ).then(answer => write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: answer } }))
        return
      }
      const call = calls.get(id)
      call.permission = { requestId: message.request_id, request }
      settleDecision(call, 'ask')
      // DSH may have decided before the CLI asked.
      if (call.verdict !== undefined) decide(call, call.verdict)
      return
    }
    if (nested) return
    if (message.type === 'assistant') {
      if (typeof message.error === 'string') {
        apiError = (message.message?.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n')
        return
      }
      for (const block of message.message?.content ?? []) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue
        const call = callOf(block.id)
        call.name ??= block.name
        if (block.input !== null && typeof block.input === 'object') call.input = block.input
        const path = typeof block.input?.file_path === 'string' ? resolve(cwd, block.input.file_path) : undefined
        if (path !== undefined && path.startsWith(plansDir + sep) && path.endsWith('.md')) lastPlanFile = path
      }
      return
    }
    if (message.type === 'user') {
      const content = Array.isArray(message.message?.content) ? message.message.content : []
      for (const block of content) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
        const call = callOf(block.tool_use_id)
        call.result = { content: block.content, isError: block.is_error === true }
        settleResult(call)
      }
      return
    }
    if (message.type === 'result') {
      cliBusy = false
      if (interrupting) {
        // The turn this host stopped has ended; nothing it streamed counts.
        interrupting = false
        held.length = 0
        if (step === undefined) { state = 'idle'; pending = [] }
        apiError = undefined
        for (const resolveStop of stopWaiters.splice(0)) resolveStop()
        return
      }
      if (message.is_error === true || (typeof message.subtype === 'string' && message.subtype !== 'success')) {
        const text = typeof message.result === 'string' && message.result !== '' ? message.result : apiError ?? 'Claude Code CLI request failed'
        const status = Number.isInteger(message.api_error_status) ? message.api_error_status : 502
        const relayed = `${CLI_MARK} ${cliErrorMessage(text)}`
        if (!failStep(new Error(text), { status, message: relayed })) {
          // Failed between steps: the next step reports it.
          failure = { status, message: relayed }
          return
        }
        void dispose('request failed')
      }
      apiError = undefined
    }
  }

  /**
   * Serve one step: give the CLI its input, then answer with the response it
   * streams for its next API request.
   *
   * A user note beside DSH's tool results must shape the response DSH asks
   * for, but by then the CLI has almost always sent its next request: that
   * request is stopped, and the note goes in as the user's next message.
   * @param input - `{ kind: 'turn', content }` (a user message),
   *   `{ kind: 'continue', exitPlan?, steer? }` (the tools ran; a plan review
   *   to pass on; a user note to add), or `{ kind: 'resume' }` (the resumed
   *   process continues its interrupted turn on its own).
   * @param signal - the step's abort signal.
   * @returns the HTTP response of this step.
   */
  const respond = (input, signal) => new Promise((resolveStep, reject) => {
    if (disposed()) { reject(new Error('Claude Code CLI process is closed')); return }
    if (step !== undefined) { reject(new Error('Claude Code CLI process is already serving a step')); return }
    if (failure !== undefined) {
      const { status, message } = failure
      failure = undefined
      resolveStep(errorResponse(status, message))
      void dispose('request failed')
      return
    }
    if (input.kind === 'turn' && !(Array.isArray(input.content) && input.content.length > 0)) {
      resolveStep(errorResponse(400, `${CLI_MARK} received a request with no new message to send`))
      return
    }
    const entry = { started: false, done: false, tools: [], text: [], blocks: new Map(), stopReason: undefined, controller: undefined, resolve: resolveStep, reject, signal }
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
    if (input.kind === 'continue' && input.exitPlan !== undefined) {
      const call = calls.get(input.exitPlan.id)
      if (call !== undefined) {
        const { approved, mode: next, message } = input.exitPlan
        decide(call, approved
          ? request => ({ behavior: 'allow', updatedInput: request?.input ?? {}, ...(next === undefined ? {} : { updatedPermissions: [{ type: 'setMode', mode: next, destination: 'session' }] }) })
          : { behavior: 'deny', message })
        if (approved && next !== undefined) mode = next
      }
    }
    const replayHeld = () => { while (held.length > 0 && step === entry && !entry.done) onEvent(held.shift()) }
    if (input.kind === 'turn') {
      writeUser(input.content)
      replayHeld()
    } else if (input.kind === 'continue' && Array.isArray(input.steer) && input.steer.length > 0) {
      void stopTurn().then(() => {
        if (entry.done || disposed()) return
        held.length = 0
        writeUser(input.steer)
      })
    } else replayHeld()
  })

  // ── start the process ───────────────────────────────────────────────────
  try {
    const program = await binary()
    const command = resolveSpawnCommand(program, { platform })
    const args = buildCliArgs({ model, effort, permissionMode, cliSessionId, resume, oneShot })
    const env = withProgramDirOnPath(buildCliEnvironment({ baseUrl, apiKey, configDir, maxTokens, continues, parent: parentEnv }), program, platform)
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
    /** The tool_use ids of the last served response, in order. */
    get pendingToolIds() { return pending.map(entry => entry.id) },
    /** The last response served in full: its fingerprint, tool ids and plan call. */
    get served() { return served },
    /** The text of a response that was cut off while streaming. */
    get partial() { return streaming },
    get closed() { return disposed() },
    /** The CLI version the process announced, once it has. */
    get version() { return version },
    /** The permission mode the CLI runs in, as it last reported or was told. */
    get permissionMode() { return mode },
    cliSessionId,
    /**
     * One tool call of the served responses, for DSH's decision and result.
     * @param id - the tool_use id.
     * @returns undefined when the CLI never made that call.
     */
    toolCall(id) {
      const call = calls.get(id)
      if (call === undefined || call.name === undefined) return undefined
      const wait = (list, ready, signal) => new Promise((resolveWait, rejectWait) => {
        if (ready() !== undefined) { resolveWait(ready()); return }
        if (disposed()) { rejectWait(new Error('Claude Code CLI process has ended')); return }
        const waiter = { resolve: resolveWait, reject: rejectWait }
        list.push(waiter)
        signal?.addEventListener('abort', () => {
          const index = list.indexOf(waiter)
          if (index >= 0) list.splice(index, 1)
          rejectWait(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'))
        }, { once: true })
      })
      const asked = () => (call.permission !== undefined ? 'ask' : call.result !== undefined ? 'auto' : undefined)
      return {
        id,
        get name() { return call.name },
        get input() { return call.input ?? {} },
        /** The CLI's permission prompt, when it asked. */
        get request() { return call.permission?.request },
        /** Resolves `ask` when the CLI asks for permission, `auto` when it ran or settled the call itself. */
        asked: signal => wait(call.decisionWaiters, asked, signal),
        /** {@link asked}, except that a CLI that asks about nothing settles at once. */
        decision: signal => wait(call.decisionWaiters, () => asked() ?? (mode === 'bypassPermissions' ? 'auto' : undefined), signal),
        /** Let the CLI run the call, now or whenever it asks. */
        allow(updatedInput, updatedPermissions) {
          decide(call, request => ({ behavior: 'allow', updatedInput: updatedInput ?? request?.input ?? call.input ?? {}, ...(updatedPermissions === undefined ? {} : { updatedPermissions }) }))
        },
        /** Refuse the call with DSH's reason, now or whenever the CLI asks. */
        deny(message) { decide(call, { behavior: 'deny', message }) },
        /** The CLI's result for the call. */
        result: signal => wait(call.resultWaiters, () => call.result, signal),
      }
    },
    /** Switch the permission mode of the live process. */
    async setPermissionMode(next) {
      if (next === mode) return
      const answer = await control({ subtype: 'set_permission_mode', mode: next })
      if (answer?.subtype === 'success') mode = next
    },
    /** Stop the CLI's current turn; the process stays for the next one. */
    interrupt: stopTurn,
    respond,
    dispose,
  }
}

/** A plan as DSH's review requires it: markdown that starts with a # heading. */
function headed(text) {
  const trimmed = String(text).trim()
  if (trimmed === '') return MISSING_PLAN
  return /^#\s+\S/u.test(trimmed) ? trimmed : `# 计划\n\n${trimmed}`
}
