/** Gemini's native API, including level-based thinking on older pi-ai hosts. */
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'

const GEMINI_MODELS = ['gemini-4-argon', 'gemini-3.8-flash']

/**
 * Google's documented thought signature for a function call whose real one
 * cannot be sent: the API skips signature validation for it.
 */
export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

/**
 * Send no real thought signature.
 *
 * PackyCode's native Gemini route refuses signed tool continuations with
 * HTTP 400 "Invalid thought signature" / "Corrupted thought signature", and
 * its support attributes this to the route not handling the signature field
 * in tool calls: resending does not help, and clients should ignore the field.
 * Every signature in the request therefore becomes Google's skip value. Gemini
 * 3 and later still require a signature on the first function call of each
 * step, so that part carries the skip value even when its response had none.
 * DSH's replay state keeps the signatures the model returned; only the wire
 * request changes.
 * @param contents - the request's `contents`.
 * @returns contents without a real signature.
 */
export function skipThoughtSignatures(contents) {
  if (!Array.isArray(contents)) return contents
  return contents.map(content => {
    if (!Array.isArray(content?.parts)) return content
    let stepStart = content.role === 'model'
    return {
      ...content,
      parts: content.parts.map(part => {
        const firstCall = stepStart && part?.functionCall !== undefined
        if (firstCall) stepStart = false
        return firstCall || typeof part?.thoughtSignature === 'string' ? { ...part, thoughtSignature: SKIP_THOUGHT_SIGNATURE } : part
      }),
    }
  })
}

/** Run `rewrite` on the request payload ahead of any caller hook. */
function withPayload(options, rewrite) {
  return {
    ...options,
    onPayload: async (payload, descriptor) => {
      const rewritten = rewrite(payload)
      return await options?.onPayload?.(rewritten, descriptor) ?? rewritten
    },
  }
}

const skipped = payload => ({ ...payload, contents: skipThoughtSignatures(payload.contents) })

/**
 * pi-ai 0.85 treats Argon as a budget-based model, and defaults Flash to
 * MINIMAL when reasoning is omitted. Both models support LOW/MEDIUM/HIGH,
 * default to MEDIUM and cannot disable thinking. Keep the native SDK stream,
 * credentials and tools; correct that config and send no real signature.
 */
export function createGeminiApi() {
  const api = googleGenerativeAIApi()
  return {
    ...api,
    stream(model, context, options) {
      if (!GEMINI_MODELS.includes(model.id)) return api.stream(model, context, options)
      return api.stream(model, context, withPayload(options, skipped))
    },
    streamSimple(model, context, options) {
      if (!GEMINI_MODELS.includes(model.id)) return api.streamSimple(model, context, options)
      const level = options?.reasoning === undefined ? 'medium' : clampThinkingLevel(model, options.reasoning)
      const wireLevel = (model.thinkingLevelMap?.[level] ?? level).toUpperCase()
      return api.streamSimple(model, context, withPayload(options, payload => {
        const { thinkingBudget: _budget, ...thinking } = payload.config?.thinkingConfig ?? {}
        return skipped({ ...payload, config: { ...payload.config, thinkingConfig: { ...thinking, thinkingLevel: wireLevel } } })
      }))
    },
  }
}
