/**
 * Send Claude Messages requests through the official Claude Code CLI.
 *
 * The native route builds every Claude request exactly as it does for HTTP —
 * DSH's history, system prompt, tools, images and signed thinking, converted
 * by pi-ai — and hands the finished request to this transport instead of the
 * network when the key's group only serves the official client. The answer
 * comes back as the same SSE stream, so DSH's agent loop, tool execution,
 * permissions, plan mode, replay and error handling are unchanged.
 *
 * Each DSH conversation (session and model) keeps one live CLI process. A
 * request that continues it — the tool results it is waiting for, or the
 * user's next turn — reuses it, so its requests share one cacheable prefix.
 * Any other request (a different history, system prompt, tool set, key or
 * effort) replaces it with a process resumed from the request's own history.
 * Session titles and compaction run in a separate one-shot process.
 *
 * @module dsh-packycode-api/claude-cli-transport
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { CLAUDE_MIN_VERSION, DEFAULT_CLAUDE_CONFIG_DIR, isClaudeCliOutdated } from './claude-binary.js'
import { MCP_TOOL_PREFIX } from './claude-mcp-bridge.js'
import { errorResponse, runDirectoryName, startClaudeCliSession } from './claude-cli-session.js'
import { canonicalMessage, contentBlocks, splitConversation, toolUseIds, withoutCacheControl } from './claude-transcript.js'
import { CLI_OUTDATED, CLI_UNAVAILABLE } from './failures.js'

/** Live processes kept at once; the least recently used one goes first. */
export const MAX_LIVE_CLI_SESSIONS = 8
/** A process nothing has used for this long is stopped; DSH resumes it from history. */
export const CLI_SESSION_IDLE_MS = 20 * 60 * 1000
const SWEEP_MS = 60 * 1000
/** Run directories a crashed host left behind are removed after this long. */
const STALE_RUN_MS = 24 * 60 * 60 * 1000

/** Text blocks the native route prepends for its own HTTP envelope; the CLI writes its own. */
const ENVELOPE = /^(?:x-anthropic-billing-header:|You are Claude Code, Anthropic's official CLI for Claude)/u

/**
 * Appended after DSH's own instructions: the tools are DSH's, under the MCP
 * prefix the CLI gives them, and the CLI's own tools are absent.
 */
export const CLI_TOOL_NOTE = [
  'Tool access in this session: every tool you can call is provided by DeepSeek Harness (DSH) and appears with the mcp__dsh__ prefix.',
  'When the instructions above name a tool by its plain name (for example bash, read, edit or exit_plan_mode), call the mcp__dsh__ tool of that name.',
  'Claude Code\'s built-in tools (Bash, Read, Edit, Write, Glob, Grep, Task, TodoWrite, WebSearch, WebFetch, NotebookEdit) are not available here; never call them.',
  'DSH runs each call under its own permissions and sandbox and returns the result.',
].join('\n')

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
 * What a payload asks of the CLI.
 * @param body - the Messages request body the native route built.
 * @param meta - the request's key, endpoint and working directory.
 * @returns model, effort, cap, system text, tools, messages, and the
 *   signature a live process must match to continue.
 */
export function describeRequest(body, { apiKey, baseUrl, cwd } = {}) {
  const tools = (Array.isArray(body?.tools) ? body.tools : [])
    .filter(tool => typeof tool?.name === 'string' && tool.name.startsWith(MCP_TOOL_PREFIX) && tool.input_schema !== undefined)
    .map(tool => ({ name: tool.name, description: tool.description ?? '', input_schema: tool.input_schema }))
  const own = dshSystemText(body?.system)
  const system = own === '' ? CLI_TOOL_NOTE : `${own}\n\n${CLI_TOOL_NOTE}`
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const request = {
    model: String(body?.model ?? ''),
    effort: typeof body?.output_config?.effort === 'string' ? body.output_config.effort : undefined,
    maxTokens: Number.isSafeInteger(body?.max_tokens) ? body.max_tokens : undefined,
    system,
    tools,
    messages,
    normalized: messages.map(message => JSON.stringify(canonicalMessage(message))),
  }
  request.signature = createHash('sha256').update(JSON.stringify([
    request.model, request.effort, request.maxTokens, system, tools,
    createHash('sha256').update(String(apiKey ?? '')).digest('hex'), baseUrl, cwd,
  ])).digest('hex')
  return request
}

/**
 * How a live process continues this request, or undefined when it cannot.
 * @param entry - the live process and the request it last served.
 * @param request - the new request.
 * @returns `{ kind: 'tools', results }` or `{ kind: 'turn', content }`.
 */
export function planContinuation(entry, request) {
  const session = entry?.session
  if (session === undefined || session.closed || entry.signature !== request.signature) return undefined
  const base = entry.baseline
  const next = request.normalized
  if (next.length < base.length + 2) return undefined
  for (let index = 0; index < base.length; index++) if (next[index] !== base[index]) return undefined
  const assistant = request.messages[base.length]
  const rest = request.messages.slice(base.length + 1)
  if (assistant?.role !== 'assistant' || rest.some(message => message?.role !== 'user')) return undefined
  const ids = toolUseIds(assistant)
  const blocks = rest.flatMap(message => contentBlocks(withoutCacheControl(message.content)))
  if (session.state === 'awaiting-tools') {
    const pending = session.pendingToolIds
    if (ids.join('\n') !== pending.join('\n')) return undefined
    // A steering note beside the results cannot ride on them: resume instead.
    if (blocks.some(block => block?.type !== 'tool_result')) return undefined
    const results = new Map(blocks.map(block => [block.tool_use_id, block]))
    if (results.size !== pending.length || pending.some(id => !results.has(id))) return undefined
    return { kind: 'tools', results }
  }
  if (session.state === 'idle') {
    if (ids.length > 0 || blocks.length === 0 || blocks.some(block => block?.type === 'tool_result')) return undefined
    return { kind: 'turn', content: blocks }
  }
  return undefined
}

/** The endpoint a Messages URL belongs to: everything before `/v1/messages`. */
export function baseUrlOf(input) {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const path = url.pathname.replace(/\/v1\/messages\/?$/u, '').replace(/\/+$/u, '')
  return `${url.origin}${path}`
}

/**
 * Create the transport.
 * @param options - how to find the CLI binary (`binary()` resolves a path or
 *   throws), the isolated CLI home, the detected CLI version (read once the
 *   binary is resolved: an outdated one is refused, and it is recorded in
 *   transcripts),
 *   limits, a logger, and process seams for tests.
 * @returns `{ fetch(input, init, meta), close(), stats() }`.
 */
export function createClaudeCliTransport({
  binary,
  configDir = DEFAULT_CLAUDE_CONFIG_DIR,
  version = () => undefined,
  maxLive = MAX_LIVE_CLI_SESSIONS,
  idleMs = CLI_SESSION_IDLE_MS,
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
  let closed = false
  let opened = 0
  let continued = 0

  // Private run files of processes a crashed host never cleaned up.
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
    void entry.session.dispose(reason)
  }
  const sweep = setInterval(() => {
    for (const session of oneShots) if (session.closed) oneShots.delete(session)
    for (const [key, entry] of live) {
      if (entry.session.closed) live.delete(key)
      else if (now() - entry.touched > idleMs && entry.session.state !== 'streaming') evict(key, 'idle')
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

  const open = async (request, meta, { oneShot }) => {
    // Resolving the binary detects its version; a CLI too old for the
    // options below is turned away before it starts.
    const program = await binary()
    const cliVersion = version()
    if (isClaudeCliOutdated(cliVersion)) {
      throw Object.assign(new Error(`Claude Code ${cliVersion} is older than ${CLAUDE_MIN_VERSION}`), { code: 'CLAUDE_CLI_OUTDATED' })
    }
    return startClaudeCliSession({
      binary: async () => program,
      configDir,
      runDirectory: join(configDir, 'runs', runDirectoryName()),
      baseUrl: meta.baseUrl,
      apiKey: meta.apiKey,
      request,
      conversation: splitConversation(request.messages),
      cwd: await workingDirectory(meta.cwd),
      sessionId: oneShot ? randomUUID() : meta.sessionId,
      cliVersion,
      oneShot,
      logger,
      ...(spawnImpl === undefined ? {} : { spawnImpl }),
      ...(platform === undefined ? {} : { platform }),
      ...(parentEnv === undefined ? {} : { parentEnv }),
      ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
    })
  }

  /**
   * Send one Messages request through the CLI.
   * @param input - the request URL the native client targeted.
   * @param init - its init; `body` is the JSON payload, `signal` the abort.
   * @param meta - `{ apiKey, sessionId, purpose, cwd }`.
   * @returns the HTTP response of the request.
   */
  const send = async (input, init, meta) => {
    if (closed) throw new Error('the Claude Code CLI transport is closed')
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
    const baseUrl = baseUrlOf(input)
    const request = describeRequest(body, { apiKey: meta.apiKey, baseUrl, cwd: meta.cwd })
    const context = { ...meta, baseUrl }
    const oneShot = async () => {
      const session = await open(request, context, { oneShot: true })
      opened += 1
      oneShots.add(session)
      return session.respond({ kind: 'start' }, init?.signal)
    }
    try {
      if (meta.purpose !== undefined) return await oneShot()
      const key = `${meta.sessionId}\u0000${request.model}`
      const entry = live.get(key)
      // Never cut off a response in flight for an unrelated request.
      if (entry !== undefined && !entry.session.closed && ['starting', 'streaming'].includes(entry.session.state)) return await oneShot()
      const plan = planContinuation(entry, request)
      if (plan !== undefined) {
        entry.baseline = request.normalized
        entry.touched = now()
        continued += 1
        return await entry.session.respond(plan, init?.signal)
      }
      if (entry !== undefined) evict(key, 'superseded')
      const session = await open(request, context, { oneShot: false })
      opened += 1
      live.set(key, { session, baseline: request.normalized, signature: request.signature, touched: now() })
      while (live.size > maxLive) {
        const [oldest] = [...live.entries()].filter(([candidate]) => candidate !== key).sort((left, right) => left[1].touched - right[1].touched)
        if (oldest === undefined) break
        evict(oldest[0], 'too many live sessions')
      }
      return await session.respond({ kind: 'start' }, init?.signal)
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
      return errorResponse(400, `${CLI_UNAVAILABLE}${reason}`, CLI_UNAVAILABLE)
    }
  }

  return Object.freeze({
    fetch: send,
    /** Counters for diagnostics; never message content. */
    stats: () => ({ live: [...live.values()].filter(entry => !entry.session.closed).length, opened, continued }),
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
