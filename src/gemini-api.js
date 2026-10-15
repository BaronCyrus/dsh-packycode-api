/** Gemini's native API, including level-based thinking on older pi-ai hosts. */
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'

/**
 * pi-ai 0.85 treats Argon as a budget-based model, and defaults Flash to
 * MINIMAL when reasoning is omitted. Both models support LOW/MEDIUM/HIGH,
 * default to MEDIUM and cannot disable thinking. Keep the native SDK stream,
 * credentials, tools and replay signatures; correct only that config.
 */
export function createGeminiApi() {
  const api = googleGenerativeAIApi()
  return {
    ...api,
    streamSimple(model, context, options) {
      if (!['gemini-4-argon', 'gemini-3.8-flash'].includes(model.id)) return api.streamSimple(model, context, options)
      const level = options?.reasoning === undefined ? 'medium' : clampThinkingLevel(model, options.reasoning)
      const wireLevel = (model.thinkingLevelMap?.[level] ?? level).toUpperCase()
      return api.streamSimple(model, context, {
        ...options,
        onPayload: async (payload, descriptor) => {
          const { thinkingBudget: _budget, ...thinking } = payload.config?.thinkingConfig ?? {}
          const normalized = {
            ...payload,
            config: { ...payload.config, thinkingConfig: { ...thinking, thinkingLevel: wireLevel } },
          }
          return await options?.onPayload?.(normalized, descriptor) ?? normalized
        },
      })
    },
  }
}
