/** A bounded resend for the gateway's intermittent Flash signature refusal. */
import { setTimeout as sleep } from 'node:timers/promises'
import { lazyStream } from '@earendil-works/pi-ai/api/lazy'

import { classifyGatewayFailure } from './failures.js'

const waitForRetry = (ms, signal) => sleep(ms, undefined, { signal })

/** Only a current-turn result for a signed same-model native call qualifies. */
function hasSignedResult(model, context) {
  if (model?.id !== 'gemini-3.8-flash' || model.api !== 'google-generative-ai') return false
  const messages = context?.messages ?? []
  const calls = new Set()
  for (const message of messages.slice(messages.findLastIndex(item => item.role === 'user') + 1)) {
    if (message.role === 'assistant' && message.provider === model.provider && message.model === model.id && message.api === model.api) {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const signature = block.thoughtSignature
        if (block.type === 'toolCall' && typeof block.id === 'string' && typeof signature === 'string'
          && signature.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(signature)) calls.add(block.id)
      }
    }
    if (message.role === 'toolResult' && calls.has(message.toolCallId)) return true
  }
  return false
}

function isSignatureRefusal(event) {
  if (event.type !== 'error' || event.reason !== 'error' || event.error.content?.length) return false
  const text = event.error.errorMessage ?? ''
  return /\b400\b/u.test(text) && /\b(?:Corrupted|Invalid) thought signature\b/iu.test(text)
    && !/\b(?:401|403|408|409|429|5\d\d)\b/u.test(text) && classifyGatewayFailure(text) === undefined
}

/**
 * The caller closes over one resolved model/context/key/session. Reopening it
 * resends that request once; it never chooses a different key or changes the
 * signature. SDK retries remain disabled by the host. Its ordinary retry
 * policy still receives any terminal failure after this one compatibility
 * resend. Never replay after even a start event has reached the consumer.
 */
export function guardGeminiReplay(open, { model, context, signal, wait = waitForRetry } = {}) {
  const initial = open()
  if (!hasSignedResult(model, context) || signal?.aborted) return initial
  let finalMessage
  return lazyStream(model, async () => ({
    async *[Symbol.asyncIterator]() {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const source = attempt === 0 ? initial : open()
        let observed = false
        let refused
        for await (const event of source) {
          if (attempt === 0 && !observed && isSignatureRefusal(event)) refused = event
          else {
            observed = true
            yield event
          }
        }
        finalMessage = await source.result()
        if (refused === undefined) return
        try {
          await wait(1000, signal)
          signal?.throwIfAborted()
        } catch (error) {
          if (!signal?.aborted) throw error
          finalMessage = { ...refused.error, stopReason: 'aborted', errorMessage: 'Request aborted' }
          yield { type: 'error', reason: 'aborted', error: finalMessage }
          return
        }
      }
    },
    result: async () => finalMessage,
  }))
}
