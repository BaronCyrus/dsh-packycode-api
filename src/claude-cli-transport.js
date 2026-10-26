/**
 * Serve Claude requests on cc keys with the official Claude Code CLI as the
 * agent.
 *
 * pi-ai still builds each request from DSH's history, as for HTTP, and the
 * answer comes back as the same SSE stream; but the CLI works with its own
 * system prompt, tools and session, and each request only tells it what is
 * new: the user's next message, or that DSH has dealt with the tool calls of
 * the last step. Everything else stays in the CLI's own session.
 *
 * Each DSH session keeps one live CLI process. A request that continues it
 * reuses it. Any other request (another model, effort or key, a process that
 * idled out, a DSH restart) starts a process that resumes the same CLI
 * session; one whose history no longer matches it (an edited message, a
 * fork, a conversation that began on another model) starts a new CLI session
 * from DSH's history. Session titles run in a one-shot process, and DSH's
 * compaction is answered here, because the context that matters is the
 * CLI's own.
 *
 * @module dsh-packycode-api/claude-cli-transport
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { CLAUDE_MIN_VERSION, DEFAULT_CLAUDE_CONFIG_DIR, isClaudeCliOutdated } from './claude-binary.js'
import { CLI_PROJECT_DIR_NAME, errorResponse, PLAN_TOOL, responseFingerprint, startClaudeCliSession, toolResultText } from './claude-cli-session.js'
import { buildTranscript, contentBlocks, toCliHistory, withoutCacheControl } from './claude-transcript.js'
import { CLI_MARK, CLI_OUTDATED, CLI_UNAVAILABLE, GROUPS_UNREAD } from './failures.js'

/** Live processes kept at once; the least recently used one goes first. */
export const MAX_LIVE_CLI_SESSIONS = 8
/** A process nothing has used for this long is stopped; the next request resumes its session. */
export const CLI_SESSION_IDLE_MS = 20 * 60 * 1000
const SWEEP_MS = 60 * 1000
/** Leftover run directories of 1.3.x processes are removed after this long. */
const STALE_RUN_MS = 24 * 60 * 60 * 1000
/** DSH sessions whose CLI session is remembered. */
const MAX_REMEMBERED = 500
const DEFAULT_PERMISSION_MODE = 'default'

/** Text blocks the native route prepends for its own HTTP envelope. */
const ENVELOPE = /^(?:x-anthropic-billing-header:|You are Claude Code, Anthropic's official CLI for Claude)/u

/** The DSH system prompt inside a Messages payload, without the HTTP envelope. */
export function dshSystemText(system) {
  const blocks = typeof system === 'string' ? [{ type: 'text', text: system }] : Array.isArray(system) ? system : []
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string' && !ENVELOPE.test(block.text))
    .map(block => block.text)
    .join('\n\n')
    .trim()
}

/**
 * The messages Claude Code receives: user text blocks DSH added for its own
 * agent are dropped (see claude-user-text), and so are user messages left
 * empty. A new turn left with nothing to say keeps its words, so a turn DSH
 * started on its own (a goal's next step) still reaches Claude Code.
 * @param messages - the payload's messages.
 * @param userText - `(text) => boolean`; without it every message is kept.
 * @returns the messages to work with.
 */
export function forwardedMessages(messages, userText) {
  if (typeof userText !== 'function') return messages
  const said = list => list.some(message => contentBlocks(message?.content).some(block => block?.type !== 'tool_result'))
  const answered = list => list.some(message => contentBlocks(message?.content).some(block => block?.type === 'tool_result'))
  const kept = messages.map(message => {
    if (message?.role !== 'user') return message
    const blocks = contentBlocks(message.content)
    const forwarded = blocks.filter(block => block?.type !== 'text' || userText(block.text))
    return forwarded.length === blocks.length ? message : { ...message, content: forwarded }
  })
  const last = kept.findLastIndex(message => message?.role === 'assistant')
  const tail = messages.slice(last + 1)
  if (!answered(tail) && said(tail) && !said(kept.slice(last + 1))) kept.splice(last + 1, tail.length, ...tail)
  return kept.filter(message => message?.role !== 'user' || contentBlocks(message.content).length > 0)
}

/**
 * What a payload asks of the CLI.
 * @param body - the Messages request body the native route built.
 * @param meta - the request's key, endpoint, working directory, and which
 *   user texts are the user's own.
 * @returns model, effort, cap, DSH's system text, messages, and the
 *   signature a live process must match to continue.
 */
export function describeRequest(body, { apiKey, baseUrl, cwd, userText } = {}) {
  const request = {
    model: String(body?.model ?? ''),
    effort: typeof body?.output_config?.effort === 'string' ? body.output_config.effort : undefined,
    maxTokens: Number.isSafeInteger(body?.max_tokens) ? body.max_tokens : undefined,
    system: dshSystemText(body?.system),
    messages: forwardedMessages(Array.isArray(body?.messages) ? body.messages : [], userText),
  }
  request.signature = createHash('sha256').update(JSON.stringify([
    request.model, request.effort, request.maxTokens,
    createHash('sha256').update(String(apiKey ?? '')).digest('hex'), baseUrl, cwd,
  ])).digest('hex')
  return request
}

/** The fingerprint of an assistant message as DSH replays it. */
export function messageFingerprint(message) {
  const blocks = contentBlocks(withoutCacheControl(message?.content))
  return responseFingerprint({
    toolIds: blocks.filter(block => block?.type === 'tool_use').map(block => block.id),
    text: blocks.filter(block => block?.type === 'text').map(block => block.text).join(''),
  })
}

/** The request's last assistant message, and the user content after it. */
export function splitAtLastAnswer(messages) {
  const list = Array.isArray(messages) ? messages : []
  let index = list.length - 1
  while (index >= 0 && list[index]?.role !== 'assistant') index--
  const tail = list.slice(index + 1)
  const blocks = tail.flatMap(message => contentBlocks(withoutCacheControl(message?.content)))
  return {
    index,
    answer: index >= 0 ? list[index] : undefined,
    results: new Map(blocks.filter(block => block?.type === 'tool_result').map(block => [block.tool_use_id, block])),
    other: blocks.filter(block => block?.type !== 'tool_result'),
    onlyUsers: tail.every(message => message?.role === 'user'),
  }
}

/** DSH's plan review result as the answer Claude Code's ExitPlanMode waits for. */
export function planAnswer(result, approvedMode) {
  const text = toolResultText(result?.content).trim()
  if (result?.is_error !== true && /^Plan approved\b/u.test(text)) return { approved: true, mode: approvedMode }
  const feedback = /their feedback:\s*([\s\S]*)$/u.exec(text)?.[1]?.trim()
  if (feedback) return { approved: false, message: `The user reviewed the plan in DeepSeek Harness and wants changes: ${feedback}` }
  if (/keep planning/iu.test(text)) return { approved: false, message: 'The user reviewed the plan in DeepSeek Harness and chose to keep planning; revise the plan and present it again.' }
  return { approved: false, message: 'The user closed the plan review in DeepSeek Harness to reply in their own words; stay in plan mode.' }
}

/**
 * How a live process continues this request, or undefined when it cannot.
 * The request must answer the last response the process served: its tool
 * calls, all handled by DSH (a plan review among them), or — once the turn
 * ended — the user's next message.
 * @param session - the live process.
 * @param request - the new request.
 * @param options - the permission mode to apply once a plan is approved.
 * @returns `{ kind: 'continue', exitPlan?, steer? }` or `{ kind: 'turn', content }`.
 */
export function planContinuation(session, request, { approvedMode } = {}) {
  if (session === undefined || session.closed) return undefined
  const served = session.served
  const { answer, results, other, onlyUsers } = splitAtLastAnswer(request.messages)
  if (served === undefined || answer === undefined || !onlyUsers || messageFingerprint(answer) !== served.fingerprint) return undefined
  if (session.state === 'awaiting-tools') {
    const pending = session.pendingToolIds
    if (pending.some(id => !results.has(id))) return undefined
    const exitPlan = served.planId === undefined ? undefined : { id: served.planId, ...planAnswer(results.get(served.planId), approvedMode) }
    return { kind: 'continue', ...(exitPlan === undefined ? {} : { exitPlan }), ...(other.length > 0 ? { steer: other } : {}) }
  }
  // Results DSH wrote for calls a cancelled turn never ran are not news to the CLI.
  if (session.state === 'idle' && other.length > 0) return { kind: 'turn', content: other }
  return undefined
}

/** A one-message SSE answer for a request served without the CLI. */
export function textResponse(model, text) {
  const frames = [
    { type: 'message_start', message: { id: `msg_dsh_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } },
    { type: 'message_stop' },
  ]
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

const textOf = message => contentBlocks(withoutCacheControl(message?.content)).filter(block => block?.type === 'text').map(block => block.text).join('\n').trim()

/**
 * DSH's compaction summary for a cc session, written without a model: the
 * context that matters is in Claude Code's own session, which compacts
 * itself, so DSH only needs a record of what was asked and answered.
 * @param messages - the conversation DSH compacts, with its instruction last.
 * @returns the summary text.
 */
export function compactionSummary(messages) {
  const list = (Array.isArray(messages) ? messages : []).slice(0, -1)
  const asked = list.filter(message => message?.role === 'user').map(textOf).filter(Boolean).slice(-12)
  const answered = list.filter(message => message?.role === 'assistant').map(textOf).filter(Boolean).at(-1)
  return [
    '本会话由 Claude Code（PackyCode cc 通道）执行，完整上下文保存在 Claude Code 自己的会话里。以下是 DSH 侧的简要记录。',
    '',
    '用户的请求：',
    ...(asked.length === 0 ? ['（无）'] : asked.map((text, index) => `${index + 1}. ${text.replace(/\s+/gu, ' ').slice(0, 300)}`)),
    ...(answered === undefined ? [] : ['', 'Claude Code 最近的回复：', answered.slice(0, 2000)]),
  ].join('\n')
}

/**
 * The user message a session-title process receives: DSH's title rules, the
 * conversation to name, and the route's closing instruction, all as the
 * user's words; nothing is added to Claude Code's own system prompt. DSH
 * bounds its title input itself, so it is passed on whole, as over HTTP.
 * @param request - the described title request.
 * @returns the message text.
 */
export function titlePrompt(request) {
  const messages = request.messages
  const instruction = textOf(messages.at(-1))
  const conversation = messages.slice(0, -1)
    .map(message => `${message?.role === 'assistant' ? '助手' : '用户'}：${textOf(message)}`)
    .filter(line => !/^(?:用户|助手)：$/u.test(line))
  return [request.system, '要命名的对话：', '---', ...conversation, '---', instruction].filter(part => part !== '').join('\n\n')
}

/**
 * The user message for a request that is no agent's step, such as Auto
 * review asking with the session's model: its instructions, the earlier
 * messages, and its question last, all as the user's words.
 * @param request - the described request.
 * @returns the message text.
 */
export function questionPrompt(request) {
  const messages = request.messages
  const earlier = messages.slice(0, -1)
    .map(message => `${message?.role === 'assistant' ? '助手' : '用户'}：${textOf(message)}`)
    .filter(line => !/^(?:用户|助手)：$/u.test(line))
  return [request.system, ...earlier, textOf(messages.at(-1))].filter(part => part !== '').join('\n\n')
}

/** Remembered CLI sessions, by DSH session: ids and fingerprints only. */
function createSessionStore(file) {
  let records
  const load = () => {
    if (records !== undefined) return records
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'))
      records = value?.version === 1 && value.sessions !== null && typeof value.sessions === 'object' ? value.sessions : {}
    } catch { records = {} }
    return records
  }
  const save = () => {
    const entries = Object.entries(records).sort((left, right) => (right[1].touched ?? 0) - (left[1].touched ?? 0)).slice(0, MAX_REMEMBERED)
    records = Object.fromEntries(entries)
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: 1, sessions: records }), { mode: 0o600 })
      renameSync(temporary, file)
    } catch { /* a lost record only means the next request rebuilds from DSH's history */ }
  }
  return {
    get: key => load()[key],
    set(key, value) { load()[key] = { ...value, touched: Date.now() }; save() },
    update(key, patch) { const current = load()[key]; if (current !== undefined) { load()[key] = { ...current, ...patch, touched: Date.now() }; save() } },
  }
}

/**
 * Create the transport.
 * @param options - how to find the CLI binary (`binary()` resolves a path or
 *   throws), the isolated CLI home, the detected CLI version (read once the
 *   binary is resolved: an outdated one is refused, and it is recorded in
 *   rebuilt transcripts), limits, a sink for permission prompts about calls
 *   DSH was never shown, a logger, and process seams for tests.
 * @returns `{ fetch(input, init, meta), toolCall(key, id), interrupt(key), close(), stats() }`.
 */
export function createClaudeCliTransport({
  binary,
  configDir = DEFAULT_CLAUDE_CONFIG_DIR,
  version = () => undefined,
  maxLive = MAX_LIVE_CLI_SESSIONS,
  idleMs = CLI_SESSION_IDLE_MS,
  nestedPermission,
  logger,
  spawnImpl,
  platform,
  parentEnv,
  startupTimeoutMs,
  now = Date.now,
} = {}) {
  if (typeof binary !== 'function') throw new Error('the Claude Code CLI transport needs a binary resolver')
  const live = new Map()
  /** One-shot processes in flight; they end themselves, unless the plugin unloads first. */
  const oneShots = new Set()
  const remembered = createSessionStore(join(configDir, 'dsh-sessions.json'))
  const store = join(configDir, 'projects', CLI_PROJECT_DIR_NAME)
  let closed = false
  let opened = 0
  let continued = 0
  let resumed = 0
  let rebuilt = 0

  // Private run files a 1.3.x process left behind.
  void (async () => {
    const runs = join(configDir, 'runs')
    for (const name of await readdir(runs).catch(() => [])) {
      if (!name.startsWith('run-')) continue
      const path = join(runs, name)
      try { if (now() - (await stat(path)).mtimeMs > STALE_RUN_MS) await rm(path, { recursive: true, force: true }) } catch { /* in use or gone */ }
    }
  })()

  const evict = (key, reason) => {
    const entry = live.get(key)
    if (entry === undefined) return
    live.delete(key)
    // A response cut off mid-stream is what DSH keeps of it; remember it so
    // the next request still resumes this CLI session.
    const partial = entry.session.partial?.text
    if (typeof partial === 'string' && partial !== '') remembered.update(key, { partial })
    void entry.session.dispose(reason)
  }
  const sweep = setInterval(() => {
    for (const session of oneShots) if (session.closed) oneShots.delete(session)
    for (const [key, entry] of live) {
      if (entry.session.closed) live.delete(key)
      else if (now() - entry.touched > idleMs && !['streaming', 'awaiting-tools'].includes(entry.session.state)) evict(key, 'idle')
    }
  }, SWEEP_MS)
  sweep.unref?.()

  /** The session's own directory when it exists; otherwise a neutral one. */
  const workingDirectory = async cwd => {
    if (typeof cwd === 'string' && cwd !== '') {
      try { if ((await stat(cwd)).isDirectory()) return cwd } catch { /* gone or unreadable */ }
    }
    const fallback = join(configDir, 'workspace')
    await mkdir(fallback, { recursive: true })
    return fallback
  }

  /** Resolve the binary, refuse an outdated CLI, and start a process. */
  const open = async (options, meta) => {
    // Resolving the binary detects its version; a CLI too old for the
    // options below is turned away before it starts.
    const program = await binary()
    const cliVersion = version()
    if (isClaudeCliOutdated(cliVersion)) {
      throw Object.assign(new Error(`Claude Code ${cliVersion} is older than ${CLAUDE_MIN_VERSION}`), { code: 'CLAUDE_CLI_OUTDATED' })
    }
    opened += 1
    return startClaudeCliSession({
      binary: async () => program,
      configDir,
      baseUrl: meta.baseUrl,
      apiKey: meta.apiKey,
      cwd: await workingDirectory(meta.cwd),
      logger,
      ...options,
      ...(spawnImpl === undefined ? {} : { spawnImpl }),
      ...(platform === undefined ? {} : { platform }),
      ...(parentEnv === undefined ? {} : { parentEnv }),
      ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
    })
  }

  /**
   * Which CLI session a request starts a process on, and what it sends:
   * the same session when the request answers its last response (or a
   * response cut off mid-stream), a new one for a conversation's first
   * message, and otherwise a new one rebuilt from DSH's history.
   */
  const prepareStart = async (key, request, meta) => {
    const record = remembered.get(key)
    const { index, answer, results, other } = splitAtLastAnswer(request.messages)
    const midTurn = results.size > 0 && answer !== undefined
      && contentBlocks(answer.content).some(block => block?.type === 'tool_use' && results.has(block.id))
    // Inside a turn the CLI continues on its own, unless the user added a
    // note: then the note is its next message.
    const continues = midTurn && other.length === 0
    const input = continues ? { kind: 'resume' } : { kind: 'turn', content: other }
    if (answer === undefined) return { cliSessionId: randomUUID(), resume: false, continues: false, input }
    const fingerprint = messageFingerprint(answer)
    const text = textOf(answer)
    const cutOff = record?.partial !== undefined && !midTurn && contentBlocks(answer.content).every(block => block?.type !== 'tool_use') && record.partial.startsWith(text)
    if (record !== undefined && (record.last === fingerprint || cutOff)) {
      resumed += 1
      return { cliSessionId: record.cli, resume: true, continues, input }
    }
    // A history Claude Code's session does not hold: start one from DSH's,
    // tool results included when the turn is open, the user's new words not.
    const cliSessionId = randomUUID()
    const kept = request.messages.slice(0, index + 1)
    if (midTurn) kept.push({ role: 'user', content: [...results.values()] })
    await mkdir(store, { recursive: true, mode: 0o700 })
    await writeFile(join(store, `${cliSessionId}.jsonl`), buildTranscript(toCliHistory(kept), { sessionId: cliSessionId, cwd: await workingDirectory(meta.cwd), model: request.model, version: version() }), { mode: 0o600 })
    rebuilt += 1
    return { cliSessionId, resume: true, continues, input }
  }

  /**
   * Serve one step on a process. A process that ends before it answers is a
   * failure DSH retries — the retry resumes the CLI session — not a CLI that
   * cannot start.
   */
  const serve = async (session, input, signal) => {
    try {
      return await session.respond(input, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      return errorResponse(502, `${CLI_MARK} ${String(error?.message ?? error).slice(0, 300)}`)
    }
  }

  /**
   * Send one Messages request through the CLI.
   * @param input - the request URL the native client targeted.
   * @param init - its init; `body` is the JSON payload, `signal` the abort.
   * @param meta - `{ apiKey, sessionId, purpose, cwd, permissionMode, approvedMode }`.
   * @returns the HTTP response of the request.
   */
  const send = async (input, init, meta) => {
    if (closed) throw new Error('the Claude Code CLI transport is closed')
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
    const baseUrl = baseUrlOf(input)
    // DSH sends a title's input under a source of its own, not `user`, but it
    // holds only what the user said: it is the conversation to name, kept whole.
    const userText = meta.purpose === 'session-title' ? undefined : meta.userText
    const request = describeRequest(body, { apiKey: meta.apiKey, baseUrl, cwd: meta.cwd, userText })
    const context = { ...meta, baseUrl }
    const mode = meta.permissionMode ?? DEFAULT_PERMISSION_MODE
    try {
      if (meta.purpose === 'compaction') return textResponse(request.model, compactionSummary(request.messages))
      // A title, or a request that offers no tools and so is no agent's step
      // (Auto review asking with the session's model): one answer, no tools.
      if (meta.purpose !== undefined || !(Array.isArray(body?.tools) && body.tools.length > 0)) {
        const session = await open({ model: request.model, oneShot: true }, context)
        oneShots.add(session)
        const text = meta.purpose === 'session-title' ? titlePrompt(request) : questionPrompt(request)
        return await serve(session, { kind: 'turn', content: [{ type: 'text', text }] }, init?.signal)
      }
      const key = meta.sessionId
      const entry = live.get(key)
      if (entry !== undefined && entry.signature === request.signature && !entry.session.closed && entry.session.state !== 'streaming') {
        const plan = planContinuation(entry.session, request, { approvedMode: meta.approvedMode })
        if (plan !== undefined) {
          entry.touched = now()
          continued += 1
          if (plan.exitPlan?.approved !== true) await entry.session.setPermissionMode(mode)
          return await serve(entry.session, plan, init?.signal)
        }
      }
      if (entry !== undefined) evict(key, 'superseded')
      const start = await prepareStart(key, request, context)
      const session = await open({
        model: request.model,
        effort: request.effort,
        maxTokens: request.maxTokens,
        cliSessionId: start.cliSessionId,
        resume: start.resume,
        continues: start.continues,
        permissionMode: mode,
        nestedPermission: prompt => nestedPermission?.(key, prompt),
        onServed: served => remembered.set(key, { cli: start.cliSessionId, last: served.fingerprint }),
      }, context)
      remembered.set(key, { cli: start.cliSessionId, last: remembered.get(key)?.cli === start.cliSessionId ? remembered.get(key).last : undefined })
      live.set(key, { session, signature: request.signature, touched: now() })
      while (live.size > maxLive) {
        const [oldest] = [...live.entries()].filter(([candidate, value]) => candidate !== key && !['streaming', 'awaiting-tools'].includes(value.session.state)).sort((left, right) => left[1].touched - right[1].touched)
        if (oldest === undefined) break
        evict(oldest[0], 'too many live sessions')
      }
      return await serve(session, start.input, init?.signal)
    } catch (error) {
      if (init?.signal?.aborted) throw error
      if (error?.code === 'CLAUDE_CLI_OUTDATED') {
        logger?.warn?.('packycode-api: %s', error.message)
        return errorResponse(400, `${CLI_OUTDATED}: ${error.message}`, CLI_OUTDATED)
      }
      // Every other failure to start is local (no CLI, a broken launcher, an
      // unwritable home): explained once, never retried as a network fault.
      const reason = error?.code === 'CLAUDE_CLI_MISSING' ? '' : `: ${String(error?.message ?? error).slice(0, 300)}`
      logger?.warn?.('packycode-api: Claude Code CLI could not start%s', reason)
      // A key whose groups are unread came here by default; the explanation says so.
      return errorResponse(400, `${CLI_UNAVAILABLE}${meta.groupsKnown === false ? ` ${GROUPS_UNREAD}` : ''}${reason}`, CLI_UNAVAILABLE)
    }
  }

  return Object.freeze({
    fetch: send,
    /** One tool call of a live process, for DSH's decision on it and its result. */
    toolCall: (key, id) => {
      const entry = live.get(key)
      return entry === undefined || entry.session.closed ? undefined : entry.session.toolCall(id)
    },
    /** Stop a live process's current turn; DSH cancelled it. */
    interrupt: key => live.get(key)?.session.interrupt(),
    /** Counters for diagnostics; never message content. */
    stats: () => ({ live: [...live.values()].filter(entry => !entry.session.closed).length, opened, continued, resumed, rebuilt }),
    /** Stop every process; the plugin is unloading. */
    async close() {
      closed = true
      clearInterval(sweep)
      const sessions = [...[...live.values()].map(entry => entry.session), ...oneShots]
      live.clear()
      oneShots.clear()
      await Promise.allSettled(sessions.map(session => session.dispose('plugin unloaded')))
    },
  })
}

/** The endpoint a Messages URL belongs to: everything before `/v1/messages`. */
export function baseUrlOf(input) {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const path = url.pathname.replace(/\/v1\/messages\/?$/u, '').replace(/\/+$/u, '')
  return `${url.origin}${path}`
}

export { PLAN_TOOL }
