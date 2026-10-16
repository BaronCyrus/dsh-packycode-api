/** Bounded replay for the gateway's captured, inconsistent tool-request checks. */
import { setTimeout as delay } from 'node:timers/promises'
import { classifyTestMessagePolicy } from './failures.js'

const MAX_ERROR_BYTES = 16 * 1024
const ANOMALY = /我们检测到您的客户端存在异常|We have detected an anomaly in your client/iu
const STANDARD_CLIENT = /标准\s*Claude\s*Code\s*客户端|standard\s+Claude\s+Code\s+client/iu

/** Inspect a small clone; the SDK still owns an unrecognised error response. */
async function isReplayableRefusal(response, { allowTestMessage }) {
  // The live gateway labels these JSON errors as text/event-stream too.
  // Trust neither MIME nor a bare status: parse only a bounded JSON body and
  // require the captured error type and wording below. Accepted streams never
  // reach this path, and genuine SSE/HTML/non-JSON refusals remain unchanged.
  if (response.status !== 403) return false
  if (Number(response.headers.get('content-length')) > MAX_ERROR_BYTES) return false
  let reader
  try {
    reader = response.clone().body?.getReader()
    if (reader === undefined) return false
    const chunks = []
    let bytes = 0
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > MAX_ERROR_BYTES) {
        void reader.cancel().catch(() => {})
        return false
      }
      chunks.push(item.value)
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return (value?.error?.type === 'packy_api_error' && ANOMALY.test(value.error.message) && STANDARD_CLIENT.test(value.error.message))
      || (allowTestMessage && value?.error?.type === 'packy_<nil>' && classifyTestMessagePolicy(value.error.message))
  } catch {
    return false
  } finally { reader?.releaseLock() }
}

function hasToolContext(context) {
  return (context.tools?.length ?? 0) > 0 || context.messages?.some(message => message.role === 'toolResult'
    || (Array.isArray(message.content) && message.content.some(block => block.type === 'toolCall')))
}

/**
 * Fixed Haiku and Sonnet tool payloads were observed returning both 200 and
 * the client-anomaly 403. The already-authorized/test-message replay remains
 * limited to Haiku, where that exact pattern was captured too. Retry only
 * these refusals, before any model event exists.
 * One replay retains the body, headers, key and session; normal policy
 * refusals, Opus, capacity errors and accepted streams pass through.
 */
export function createClaudeReplayFetch(fetchImpl, { model, context, delayMs = 1000 } = {}) {
  const allowTestMessage = model?.id === 'claude-haiku-5-5'
  const enabled = (allowTestMessage || model?.id === 'claude-sonnet-5-5') && hasToolContext(context ?? {})
  return async (input, init) => {
    // The Messages SDK sends a JSON string. Never replay a consumed stream
    // supplied by a different transport; a Request can be cloned beforehand.
    if (!enabled || (init?.body !== undefined && typeof init.body !== 'string')) return fetchImpl(input, init)
    const retryInput = input instanceof Request ? input.clone() : input
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const firstInit = { ...init, headers: new Headers(headers) }
    const retryInit = { ...init, headers: new Headers(headers) }
    let replayed = false
    let response
    let discarded = false
    try {
      response = await fetchImpl(input, firstInit)
      if (!await isReplayableRefusal(response, { allowTestMessage })) return response
      discarded = true
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      signal?.throwIfAborted()
      await delay(delayMs, undefined, { signal })
      await response.body?.cancel()
      replayed = true
      return await fetchImpl(retryInput, retryInit)
    } finally {
      if (!replayed && retryInput instanceof Request && retryInput !== input) void retryInput.body?.cancel().catch(() => {})
      if (discarded) void response?.body?.cancel().catch(() => {})
    }
  }
}
