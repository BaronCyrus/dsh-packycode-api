/**
 * Hy4's maker, stated where DSH's system prompt leaves it out.
 *
 * DSH's system prompt opens with "You are an AI agent powered by DeepSeek
 * Harness." and "You are a coding agent powered by the hy4 model.": the
 * harness by name, the model only by its id. Hy4 takes the system prompt as
 * its identity and reads the harness as its maker. Asked which model it was,
 * it said a DeepSeek model, and asked whether it was Hunyuan, it denied it
 * and claimed `hy` did not stand for Hunyuan. Without a system prompt it
 * answers "我是混元，是由腾讯开发的大模型", and with the harness renamed it
 * no longer claimed DeepSeek. Under the same prompt with their own ids, the
 * GPT, Grok, Gemini and DeepSeek models named their own makers.
 *
 * So every Hy4 request ends its leading instructions with one sentence on
 * who made it. DSH's own text stays as written, and the sentence never
 * changes, so the cached prefix does not either.
 *
 * @module dsh-packycode-api/hy4-identity
 */

/** The catalog model this note is for. */
export const HY4_MODEL_ID = 'hy4'

/** The sentence appended to Hy4's instructions; checked live as worded. */
export const HY4_IDENTITY_NOTE = 'About yourself: the hy4 model is Hy4 from Tencent Hunyuan (腾讯混元), reached through PackyCode. DeepSeek Harness is the agent app you run in, not your model or its maker.'

const INSTRUCTION_ROLES = new Set(['developer', 'system'])

const carriesNote = item => typeof item?.content === 'string' && item.content.includes(HY4_IDENTITY_NOTE)

/**
 * Add the note to a Responses payload: after the leading instructions, or as
 * the only ones when the request has none. A payload that already carries it
 * is returned unchanged, and the given payload is never modified.
 * @param payload - the Responses request body pi-ai built.
 * @returns the body to send.
 */
export function withIdentityNote(payload) {
  if (!Array.isArray(payload?.input) || payload.input.some(carriesNote)) return payload
  const [first, ...rest] = payload.input
  const input = INSTRUCTION_ROLES.has(first?.role) && typeof first.content === 'string'
    ? [{ ...first, content: `${first.content}\n\n${HY4_IDENTITY_NOTE}` }, ...rest]
    : [{ role: 'developer', content: HY4_IDENTITY_NOTE }, ...payload.input]
  return { ...payload, input }
}

/**
 * pi-ai options whose payload carries the note before any caller hook sees
 * it, so a caller's own `onPayload` still has the last word.
 * @param options - the request's pi-ai options.
 * @returns the same options with the note added on the way out.
 */
export function withHy4Identity(options) {
  return {
    ...options,
    onPayload: async (payload, model) => {
      const noted = withIdentityNote(payload)
      return await options?.onPayload?.(noted, model) ?? noted
    },
  }
}
