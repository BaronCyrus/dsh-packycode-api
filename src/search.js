/**
 * PackyCode web search for the DSH `web` seam.
 *
 * Two search providers register with `ctx.web`:
 * - `packycode-api` searches through PackyCode for every request.
 * - `packycode-api-auto` searches through PackyCode only when the initiating
 *   session runs on a PackyCode model, and hands every other request to the
 *   provider DSH would have used without this plugin.
 *
 * PackyCode has no dedicated search endpoint; a search is one model call with
 * the vendor's server-side search tool. The user picks the backend:
 * - `deepseek`: Anthropic Messages at `/v1/messages`, `deepseek-flash`, with
 *   the `web_search_20250305` server tool. Results come from its structured
 *   `web_search_tool_result` blocks, never from prose.
 * - `gpt`: OpenAI Responses at `/v1/responses`, `gpt-6.1-sol`, with the
 *   hosted `web_search` tool, streamed. Results come from `url_citation`
 *   annotations and the `web_search_call` actions.
 *
 * Only keys stored in this plugin's key ring authenticate a search; there is no
 * fallback to another credential. A key the gateway reports as exhausted or
 * rejected is moved aside exactly as on the model route, and the search tries
 * the next usable key.
 *
 * @module dsh-packycode-api/search
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { HarnessError } from '@deepseek-ai/dsh-llm'

import { PROVIDER } from './constants.js'
import { classifyClientPolicy, classifyCoverage, classifyGatewayFailure, classifyUpstreamServerError, explainClientPolicyFailure } from './failures.js'
import { orderKeysFor } from './key-chooser.js'
import { ambientFetch, boundedFetch } from './request.js'

/** Search provider that always searches through PackyCode. */
export const PACKYCODE_SEARCH_PROVIDER_ID = 'packycode-api'
/** Search provider that routes by the initiating session's model provider. */
export const PACKYCODE_AUTO_SEARCH_PROVIDER_ID = 'packycode-api-auto'
/** Both ids this plugin registers; neither may serve as its own fallback. */
export const OWN_SEARCH_PROVIDER_IDS = Object.freeze([PACKYCODE_SEARCH_PROVIDER_ID, PACKYCODE_AUTO_SEARCH_PROVIDER_ID])
/** DSH's built-in search provider, the fallback when nothing else is known. */
export const DSH_SEARCH_PROVIDER_FALLBACK = 'deepseek-official'

/** Search routing the user picks. */
export const SEARCH_MODE_DEFAULT = 'default'
export const SEARCH_MODE_AUTO = 'auto'
export const SEARCH_MODE_PACKYCODE = 'packycode'
export const SEARCH_MODES = Object.freeze([SEARCH_MODE_DEFAULT, SEARCH_MODE_AUTO, SEARCH_MODE_PACKYCODE])

/** Search backends the user picks between. */
export const SEARCH_BACKEND_DEEPSEEK = 'deepseek'
export const SEARCH_BACKEND_GPT = 'gpt'
export const SEARCH_BACKENDS = Object.freeze([SEARCH_BACKEND_DEEPSEEK, SEARCH_BACKEND_GPT])
/**
 * DeepSeek is the default: a search costs a few thousand tokens there, and its
 * group answered the server tool in the live check. GPT search reads far more
 * (about 26K input tokens per search) and needs a key whose group the gateway
 * currently routes GPT models to.
 */
export const DEFAULT_SEARCH_BACKEND = SEARCH_BACKEND_DEEPSEEK

/** The model each backend searches with. */
export const SEARCH_BACKEND_MODELS = Object.freeze({
  [SEARCH_BACKEND_DEEPSEEK]: 'deepseek-flash',
  [SEARCH_BACKEND_GPT]: 'gpt-6.1-sol',
})

/** Bound on one search request, below the `web_search` tool's 60 s budget. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 55_000
/** Upper bound on server-side searches inside one DeepSeek request. */
const DEEPSEEK_MAX_USES = 3
const MAX_OUTPUT_TOKENS = 4096
const ANTHROPIC_VERSION = '2023-06-01'
/** Distinct keys one search may try before reporting the last failure. */
const MAX_KEY_ATTEMPTS = 4
/** Resends of one search after an upstream hiccup the gateway relayed with 200. */
const MAX_TRANSIENT_RETRIES = 2
/** Pause before such a resend when the upstream names none. */
export const DEFAULT_RETRY_DELAY_MS = 1_000
/** A longer advised pause would not fit DSH's search budget; report it instead. */
const MAX_RETRY_DELAY_MS = 5_000
/** Bound on one unterminated stream event. */
const MAX_EVENT_CHARS = 4 * 1024 * 1024
const MAX_CONTENT_CHARS = 4000
const MAX_SNIPPET_CHARS = 500
const MAX_TITLE_CHARS = 200
const MAX_SOURCES = 20
const MAX_ERROR_DETAIL_CHARS = 400

/**
 * Error shape of the DSH web seam. `@deepseek-ai/dsh-web` defines `WebError`
 * as a bare `HarnessError` subclass with a machine-routable `code`; consumers
 * route on that code, so this mirror avoids a peer dependency on the package.
 */
export class WebError extends HarnessError {}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => (typeof value === 'string' ? value : '')
const named = value => (text(value) === '' ? undefined : value)

function bounded(value, maximum) {
  const clean = text(value).replace(/\s+/gu, ' ').trim()
  if (clean === '') return undefined
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1)}…`
}

function boundedBlock(value, maximum) {
  const clean = text(value).trim()
  if (clean === '') return undefined
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1)}…`
}

function httpUrl(value) {
  const url = text(value)
  if (url === '') return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Accumulates sources by URL, first sighting wins, missing fields filled later. */
function sourceList() {
  const byUrl = new Map()
  return {
    add({ url, title, snippet, publishedAt }) {
      const parsed = httpUrl(url)
      if (parsed === undefined) return
      const key = parsed.href
      const existing = byUrl.get(key)
      if (existing === undefined) {
        if (byUrl.size >= MAX_SOURCES) return
        byUrl.set(key, {
          url: text(url),
          title: bounded(title, MAX_TITLE_CHARS) ?? parsed.hostname,
          ...(bounded(snippet, MAX_SNIPPET_CHARS) === undefined ? {} : { snippet: bounded(snippet, MAX_SNIPPET_CHARS) }),
          ...(bounded(publishedAt, 64) === undefined ? {} : { publishedAt: bounded(publishedAt, 64) }),
        })
        return
      }
      if (existing.title === parsed.hostname && bounded(title, MAX_TITLE_CHARS) !== undefined) existing.title = bounded(title, MAX_TITLE_CHARS)
      if (existing.snippet === undefined && bounded(snippet, MAX_SNIPPET_CHARS) !== undefined) existing.snippet = bounded(snippet, MAX_SNIPPET_CHARS)
      if (existing.publishedAt === undefined && bounded(publishedAt, 64) !== undefined) existing.publishedAt = bounded(publishedAt, 64)
    },
    values: () => [...byUrl.values()],
  }
}

function result(sources, content) {
  return {
    ...(content === undefined ? {} : { content }),
    sources,
    truncated: false,
  }
}

/**
 * Map an Anthropic Messages response with native search to a search result.
 * Sources come from `web_search_tool_result` blocks; a text block's citation
 * excerpt becomes its source's snippet; the answer text becomes `content`.
 * @param response - parsed Messages response body.
 * @returns the normalized search result.
 * @throws {WebError} when the response carries no search result block.
 */
export function parseMessagesSearchResponse(response) {
  const blocks = Array.isArray(response?.content) ? response.content : []
  const resultBlocks = blocks.filter(block => block?.type === 'web_search_tool_result')
  if (resultBlocks.length === 0) {
    throw new WebError('PackyCode search returned no web_search_tool_result block; the model did not run a web search', 'WEB_PROVIDER_ERROR')
  }
  const sources = sourceList()
  const errors = []
  for (const block of resultBlocks) {
    if (!Array.isArray(block.content)) {
      if (record(block.content) && text(block.content.error_code) !== '') errors.push(block.content.error_code)
      continue
    }
    for (const item of block.content) {
      if (item?.type !== 'web_search_result') continue
      sources.add({ url: item.url, title: item.title, publishedAt: item.page_age })
    }
  }
  for (const block of blocks) {
    if (block?.type !== 'text' || !Array.isArray(block.citations)) continue
    for (const cite of block.citations) sources.add({ url: cite?.url, title: cite?.title, snippet: cite?.cited_text })
  }
  const found = sources.values()
  if (found.length === 0 && errors.length > 0) {
    throw new WebError(`PackyCode search failed upstream (${errors.join(', ')})`, 'WEB_PROVIDER_ERROR')
  }
  const answer = boundedBlock(blocks.filter(block => block?.type === 'text').map(block => text(block.text)).join(''), MAX_CONTENT_CHARS)
  return result(found, answer)
}

/**
 * Map an OpenAI Responses response with the hosted search tool to a search
 * result. Cited URLs come first with their titles, then every other URL the
 * search actions surfaced; the final message becomes `content`.
 * @param response - parsed Responses body.
 * @returns the normalized search result.
 * @throws {WebError} when the model ran no web search, or the body carries no
 *   output at all.
 */
export function parseResponsesSearchResponse(response) {
  const output = Array.isArray(response?.output) ? response.output : []
  if (output.length === 0) {
    const status = text(response?.status) === '' ? '' : ` (status ${text(response.status)})`
    throw new WebError(`PackyCode search returned no output items${status}; the gateway did not pass the search result on`, 'WEB_PROVIDER_ERROR')
  }
  const calls = output.filter(item => item?.type === 'web_search_call')
  if (calls.length === 0) {
    throw new WebError('PackyCode search returned no web_search_call; the model did not run a web search', 'WEB_PROVIDER_ERROR')
  }
  const sources = sourceList()
  let answer
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue
    const parts = []
    for (const part of item.content) {
      if (part?.type !== 'output_text') continue
      parts.push(text(part.text))
      for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
        if (annotation?.type === 'url_citation') sources.add({ url: annotation.url, title: annotation.title })
      }
    }
    const joined = parts.join('')
    if (joined.trim() !== '') answer = joined
  }
  for (const call of calls) {
    const action = record(call.action) ? call.action : {}
    if (text(action.url) !== '') sources.add({ url: action.url })
    for (const source of Array.isArray(action.sources) ? action.sources : []) sources.add({ url: source?.url, title: source?.title })
  }
  return result(sources.values(), boundedBlock(answer, MAX_CONTENT_CHARS))
}

/** Events after which a Responses stream carries nothing a search uses. */
const RESPONSES_LAST_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed', 'error'])

/**
 * Read a streamed Responses answer into the body it describes.
 *
 * PackyCode's Codex channel ends a stream with a `response.completed` whose
 * `output` is empty; the items only arrive as `response.output_item.done`
 * events. A non-streaming request gets that same empty `output`, which is why
 * the GPT backend streams. The items are rebuilt here in `output_index`
 * order; the final event's own `output` wins when it has any. An `error`
 * event or `response.failed` becomes the body's `error`.
 * @param response - a 200 answer whose body is `text/event-stream`.
 * @param signal - the caller's cancellation; it cancels the read.
 * @returns the body, with `output` rebuilt or `error` set.
 * @throws {WebError} when the stream ends before its final event.
 */
export async function readResponsesStream(response, signal) {
  if (response.body === null || response.body === undefined) throw new WebError('PackyCode search returned an empty stream', 'WEB_PROVIDER_ERROR')
  const items = []
  let final
  let failure
  /** Apply one event; true once nothing after it matters. */
  const dispatch = block => {
    let name = ''
    let data
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /u, '')
      if (field === 'event') name = value
      else if (field === 'data') data = data === undefined ? value : `${data}\n${value}`
    }
    if (data === undefined || data === '[DONE]') return false
    let event
    try {
      event = JSON.parse(data)
    } catch {
      return false
    }
    const type = text(event?.type) || name
    if (type === 'response.output_item.done' && record(event.item)) {
      items.push({ index: Number.isInteger(event.output_index) ? event.output_index : Number.MAX_SAFE_INTEGER, item: event.item })
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      final = record(event.response) ? event.response : {}
    } else if (type === 'error') {
      failure = record(event.error) ? event.error : { code: event.code, message: event.message }
    } else if (type === 'response.failed') {
      failure ??= record(event.response?.error) ? event.response.error : { message: 'the response failed' }
    }
    return RESPONSES_LAST_EVENTS.has(type)
  }

  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined) }
  signal?.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder()
  let pending = ''
  let carry = ''
  let ended = false
  try {
    signal?.throwIfAborted()
    while (!ended) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      // A CR can end one chunk and its LF start the next.
      const decoded = carry + (done ? decoder.decode() : decoder.decode(value, { stream: true }))
      carry = !done && decoded.endsWith('\r') ? '\r' : ''
      pending += decoded.slice(0, decoded.length - carry.length).replace(/\r\n?/gu, '\n')
      for (let boundary = pending.indexOf('\n\n'); !ended && boundary >= 0; boundary = pending.indexOf('\n\n')) {
        ended = dispatch(pending.slice(0, boundary))
        pending = pending.slice(boundary + 2)
      }
      if (done) {
        if (!ended && pending.trim() !== '') ended = dispatch(pending)
        break
      }
      if (pending.length > MAX_EVENT_CHARS) throw new WebError('PackyCode search stream sent an oversized event', 'WEB_PROVIDER_ERROR')
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }

  if (failure !== undefined) return { error: failure }
  if (final === undefined) throw new WebError('PackyCode search stream ended before the response completed', 'WEB_PROVIDER_ERROR')
  const output = Array.isArray(final.output) && final.output.length > 0
    ? final.output
    : items.sort((left, right) => left.index - right.index).map(entry => entry.item)
  return { ...final, output }
}

/** "Please try again in 2s.", "try again in 1.898s", "try again in 28ms". */
const RETRY_HINT = /try again in\s*(\d+(?:\.\d+)?)\s*(ms|s|secs?|seconds?)\b/iu

/**
 * Whether an error the gateway relayed with a 200 answer is an upstream
 * hiccup a resent request clears, and how long to wait before resending.
 *
 * The Codex channel reports a model at capacity as `rate_limit_exceeded`
 * ("Temporary capacity limit. Please try again in 2s.") and a fault as
 * `server_error`, inside a stream it has already answered 200 for, so the
 * gateway cannot resend it on another channel. The official Codex client
 * resends both, after the pause the message names.
 * @param error - the body's or the stream's `error` object.
 * @param fallbackMs - the pause when the upstream names none.
 * @returns the pause in milliseconds, or undefined when a resend would not
 *   help or its pause would not fit DSH's search budget.
 */
export function transientRetryDelay(error, fallbackMs = DEFAULT_RETRY_DELAY_MS) {
  if (!record(error)) return undefined
  const message = text(error.message)
  // Quota and key wording move the key ring along instead.
  if (classifyGatewayFailure(message) !== undefined) return undefined
  const transient = ['rate_limit_exceeded', 'server_error'].includes(text(error.code))
    || ['server_error', 'service_unavailable_error'].includes(text(error.type))
    || classifyUpstreamServerError(message)
  if (!transient) return undefined
  const hint = RETRY_HINT.exec(message)
  const delay = hint === null ? fallbackMs : Math.round(Number(hint[1]) * (hint[2].toLowerCase() === 'ms' ? 1 : 1000))
  return delay <= MAX_RETRY_DELAY_MS ? delay : undefined
}

/** Build one backend's request; the key is attached by the caller. */
export function buildSearchRequest(backend, { apiHost, query, sessionId }) {
  const model = SEARCH_BACKEND_MODELS[backend]
  if (backend === SEARCH_BACKEND_GPT) {
    return {
      url: `${apiHost}/v1/responses`,
      model,
      headers: key => ({ authorization: `Bearer ${key}` }),
      body: {
        model,
        // The Codex group refuses a bare string input on some channels.
        input: [{
          role: 'user',
          content: [{
            type: 'input_text',
            text: `Search the web for: ${query}\n\nReply with a concise factual summary of what the sources say, citing them.`,
          }],
        }],
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
        include: ['web_search_call.action.sources'],
        reasoning: { effort: 'low' },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
        // Only the stream carries the output items; see readResponsesStream.
        stream: true,
        ...(typeof sessionId === 'string' && sessionId !== '' ? { prompt_cache_key: sessionId } : {}),
      },
      parse: parseResponsesSearchResponse,
    }
  }
  if (backend === SEARCH_BACKEND_DEEPSEEK) {
    return {
      url: `${apiHost}/v1/messages`,
      model,
      headers: key => ({ 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }),
      body: {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{
          role: 'user',
          content: `Perform a web search for the query: ${query}\n\nThen reply with a concise factual summary of what the results say.`,
        }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: DEEPSEEK_MAX_USES }],
      },
      parse: parseMessagesSearchResponse,
    }
  }
  throw new WebError(`PackyCode search backend "${String(backend)}" is not supported`, 'WEB_PROVIDER_UNAVAILABLE')
}

/** Read a failure body as bounded text, preferring the gateway's own message. */
async function failureText(response) {
  let raw = ''
  try {
    raw = await response.text()
  } catch {
    return ''
  }
  try {
    const parsed = JSON.parse(raw)
    const message = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message
    if (typeof message === 'string' && message !== '') {
      const code = typeof parsed?.error?.code === 'string' && parsed.error.code !== '' ? `${parsed.error.code}: ` : ''
      return `${code}${message}`.slice(0, MAX_ERROR_DETAIL_CHARS)
    }
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return raw.replace(/\s+/gu, ' ').trim().slice(0, MAX_ERROR_DETAIL_CHARS)
}

/** An error object as bounded text, its code first, the way failureText words one. */
function errorText(error) {
  const message = text(error.message)
  if (message === '') return JSON.stringify(error).slice(0, MAX_ERROR_DETAIL_CHARS)
  const code = text(error.code) === '' ? '' : `${error.code}: `
  return `${code}${message}`.slice(0, MAX_ERROR_DETAIL_CHARS)
}

const mask = (message, key) => (typeof key === 'string' && key.length >= 8
  ? message.split(key).join(`…${key.slice(-4)}`)
  : message)

function isAbort(error, signal) {
  return signal?.aborted === true || error?.name === 'AbortError'
}

const isEventStream = response => /^text\/event-stream\b/iu.test(response.headers?.get?.('content-type') ?? '')

/** Wait before a resend; a cancelled search stops waiting. */
async function pause(ms, signal) {
  try {
    await sleep(ms, undefined, { signal })
  } catch (error) {
    throw new WebError('PackyCode search aborted', 'WEB_ABORTED', { cause: error })
  }
}

/**
 * Create the provider that searches through PackyCode on every request.
 * @param options - the key ring, the host resolution, the backend preference,
 *   the key-failure sink shared with the model route, and test seams.
 * @returns a DSH web search provider.
 */
export function createPackyCodeSearchProvider({
  ring,
  hosts,
  backend = () => DEFAULT_SEARCH_BACKEND,
  onKeyFailure,
  covers,
  resolveSessionId,
  fetchImpl = ambientFetch,
  timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
  if (ring === undefined || typeof ring.activeKey !== 'function') throw new Error('PackyCode search requires the key ring')
  if (typeof hosts !== 'function') throw new Error('PackyCode search requires the host resolution')
  /**
   * The Codex group refuses a Responses request without `prompt_cache_key`
   * with a 403 ("请使用标准 Codex 客户端"); a search no session is named for
   * still sends one, as the model route does.
   */
  const fallbackSessionId = `${PACKYCODE_SEARCH_PROVIDER_ID}-search-${randomUUID()}`

  /** One request with one key; classified failures come back as values. */
  const attempt = async (request, key, signal) => {
    // Key resolution is asynchronous; the caller may have given up meanwhile.
    if (signal?.aborted === true) throw new WebError('PackyCode search aborted', 'WEB_ABORTED', { cause: signal.reason })
    const streamed = request.body.stream === true
    let response
    try {
      response = await boundedFetch(request.url, {
        method: 'POST',
        headers: {
          ...request.headers(key),
          accept: streamed ? 'text/event-stream' : 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(request.body),
      }, { fetchImpl, timeoutMs, signal })
    } catch (error) {
      if (error.aborted) throw new WebError('PackyCode search aborted', 'WEB_ABORTED', { cause: error })
      if (error.timedOut) throw new WebError(`PackyCode search got no answer within ${Math.round(timeoutMs / 1000)}s`, 'WEB_PROVIDER_ERROR', { cause: error })
      throw new WebError(`PackyCode search request failed (${mask(error.code ?? error.message, key)})`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (!response.ok) return { failure: mask(await failureText(response), key), status: response.status }
    let body
    try {
      // A channel may still answer a streamed request with one JSON body.
      body = streamed && isEventStream(response) ? await readResponsesStream(response, signal) : await response.json()
    } catch (error) {
      if (isAbort(error, signal)) throw new WebError('PackyCode search aborted', 'WEB_ABORTED', { cause: error })
      // The request's timeout also ends a body still arriving.
      if (error?.name === 'TimeoutError') throw new WebError(`PackyCode search got no answer within ${Math.round(timeoutMs / 1000)}s`, 'WEB_PROVIDER_ERROR', { cause: error })
      if (error instanceof WebError) throw error
      throw new WebError('PackyCode search returned an unreadable response', 'WEB_PROVIDER_ERROR', { cause: error })
    }
    // Some gateway channels answer 200 with an error object, or relay one in the stream.
    if (record(body?.error)) {
      return { failure: mask(errorText(body.error), key), status: response.status, retryAfterMs: transientRetryDelay(body.error, retryDelayMs) }
    }
    return { value: request.parse(body) }
  }

  return Object.freeze({
    id: PACKYCODE_SEARCH_PROVIDER_ID,
    available: () => true,
    async search(searchRequest, signal) {
      if (signal?.aborted === true) throw new WebError('PackyCode search aborted', 'WEB_ABORTED', { cause: signal.reason })
      const query = text(searchRequest?.query).trim()
      if (query === '') throw new WebError('PackyCode search needs a non-empty query', 'WEB_PROVIDER_ERROR')
      const chosen = SEARCH_BACKENDS.includes(backend()) ? backend() : DEFAULT_SEARCH_BACKEND
      const request = buildSearchRequest(chosen, {
        apiHost: hosts().apiHost,
        query,
        // An MCP invocation supplies the originating session captured by
        // the host; HTTP callbacks no longer have the agent's async context.
        sessionId: named(searchRequest?.sessionId) ?? named(resolveSessionId?.()) ?? fallbackSessionId,
      })

      const candidates = await orderKeysFor(ring, request.model, covers)
      const other = chosen === SEARCH_BACKEND_GPT ? SEARCH_BACKEND_DEEPSEEK : SEARCH_BACKEND_GPT
      let lastFailure
      let uncovered = false
      for (const key of candidates.slice(0, MAX_KEY_ATTEMPTS)) {
        let outcome = await attempt(request, key.key, signal)
        // An upstream hiccup says nothing about the key; resend on the same one.
        for (let retry = 0; outcome.retryAfterMs !== undefined && retry < MAX_TRANSIENT_RETRIES; retry += 1) {
          await pause(outcome.retryAfterMs, signal)
          outcome = await attempt(request, key.key, signal)
        }
        if (outcome.value !== undefined) return outcome.value

        const failure = outcome.failure === '' ? `HTTP ${outcome.status}` : outcome.failure
        lastFailure = failure
        if (outcome.retryAfterMs !== undefined) {
          throw new WebError(
            `PackyCode search: ${request.model} stayed unavailable upstream after ${MAX_TRANSIENT_RETRIES + 1} attempts (${failure}). `
              + `Try again shortly, or switch the search backend to "${other}" under Settings → PackyCode → Web search.`,
            'WEB_PROVIDER_ERROR',
          )
        }
        if (classifyClientPolicy(failure)) {
          throw new WebError(explainClientPolicyFailure(), 'WEB_PROVIDER_ERROR')
        }
        const kind = classifyGatewayFailure(failure) ?? (outcome.status === 401 ? 'invalid-key' : undefined)
        if (kind !== undefined) {
          // The same sink the model route uses: the key moves aside for both.
          onKeyFailure?.(kind, failure, key.key, key.id)
          continue
        }
        if (classifyCoverage(failure)) {
          // This key's groups do not reach the model; another key's might.
          uncovered = true
          continue
        }
        // A 200 here carried its error in the body or the stream.
        throw new WebError(`PackyCode search failed ${outcome.status === 200 ? 'upstream' : `(HTTP ${outcome.status})`}: ${failure}`, 'WEB_PROVIDER_ERROR')
      }

      if (candidates.length === 0) {
        throw new WebError('PackyCode search has no usable API key; add one under Settings → PackyCode', 'WEB_PROVIDER_CREDENTIAL_MISSING')
      }
      if (uncovered) {
        throw new WebError(
          `PackyCode search: no stored API key's group covers ${request.model} (${chosen} backend). `
            + `Switch the search backend to "${other}" under Settings → PackyCode → Web search, or add a key whose group includes it. `
            + `Gateway said: ${lastFailure}`,
          'WEB_PROVIDER_ERROR',
        )
      }
      throw new WebError(`PackyCode search: every usable key was refused (${lastFailure ?? 'no detail'})`, 'WEB_PROVIDER_CREDENTIAL_MISSING')
    },
  })
}

/** Marks a request already passing through the auto provider's fallback. */
const delegating = new AsyncLocalStorage()

/**
 * Create the provider that searches through PackyCode for PackyCode sessions
 * only. Every other request goes to the fallback provider: the search provider
 * the web row selected before this plugin's patch, or DSH's built-in search.
 *
 * Another plugin's router may delegate back to this one (its own fallback is
 * the web row's base, which this plugin's patch points here). A request that
 * re-enters while already delegating goes straight to DSH's built-in search
 * instead of looping.
 * @param options - the PackyCode provider, the initiating model provider, a
 *   lookup of registered search providers, and the fallback id.
 * @returns a DSH web search provider.
 */
export function createPackyCodeAutoSearchProvider({ packycode, resolveModelProvider, resolveProvider, resolveFallbackId }) {
  return Object.freeze({
    id: PACKYCODE_AUTO_SEARCH_PROVIDER_ID,
    available: () => true,
    async search(request, signal) {
      if (resolveModelProvider?.() === PROVIDER) return packycode.search(request, signal)
      const reentered = delegating.getStore() === true
      const wanted = reentered ? DSH_SEARCH_PROVIDER_FALLBACK : (resolveFallbackId?.() ?? DSH_SEARCH_PROVIDER_FALLBACK)
      const id = OWN_SEARCH_PROVIDER_IDS.includes(wanted) ? DSH_SEARCH_PROVIDER_FALLBACK : wanted
      const provider = resolveProvider?.(id)
      if (provider === undefined || OWN_SEARCH_PROVIDER_IDS.includes(provider.id) || provider.available?.() !== true) {
        throw new WebError(`PackyCode auto search: the fallback search provider "${id}" is unavailable`, 'WEB_PROVIDER_UNAVAILABLE')
      }
      return delegating.run(true, () => provider.search(request, signal))
    },
  })
}
