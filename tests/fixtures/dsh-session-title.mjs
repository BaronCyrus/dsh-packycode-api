/**
 * DSH's session-title request as its title providers write it, so the route
 * is checked with the request it actually gets. The system prompt and the
 * JSON framing are copied word for word from
 * `@deepseek-ai/dsh-session-title-all-prompts-llm` (without a current title
 * they are those of `@deepseek-ai/dsh-session-title-first-prompt-llm`, DSH's
 * default provider), and the request is the one `executeSessionTitleLlm` of
 * `@deepseek-ai/dsh-session-title-llm` builds from them; all 0.2.1-rc.2,
 * unchanged in rc.3 (MIT, deepseek-ai/deepseek-harness `packages/session`
 * and `packages/experimental`). The config is the default provider's in
 * `@deepseek-ai/dsh-base/cordis.patch.yml`.
 *
 * The input arrives as one user message under a source of DSH's own, not
 * `user`, although it holds only the user's words: DSH collects the
 * `user/message` events whose source is `user`.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** The source of the message that carries the title input. */
export const TITLE_INPUT_SOURCE = 'dsh-session-title-llm'

/** DSH's base config for its default title provider. */
export const TITLE_CONFIG = Object.freeze({ targetWords: 5, targetCjkCharacters: 10, maxOutputTokens: 4096 })

/** Language-aware system instruction, with stability rules when a provider title is anchored. */
export function systemPrompt(config, hasCurrentTitle) {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
    'If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.',
    ...(hasCurrentTitle ? [
      'An existing title is supplied as currentTitle. If it still accurately describes the main topic or task, return it exactly unchanged.',
      'Follow-up questions, additional details within the same topic, acknowledgements such as "thanks", and requests to continue do not by themselves justify a title change.',
      'Do not reword, polish, shorten, or replace synonyms in an adequate title. Keeping its exact wording takes priority over the target length.',
      'Change the title only when the messages materially change or expand the main topic or task so that the existing title is no longer accurate.',
    ] : []),
  ].join('\n')
}

/** Frame messages as JSON so user text cannot break structural delimiters. */
export function frameMessages(messages, currentTitle) {
  if (currentTitle !== undefined) return `Update the session title from this JSON object:\n${JSON.stringify({ currentTitle, messages })}`
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`
}

/**
 * The stream options DSH's title call hands the route.
 * @param prompts - the user's messages to name, oldest first.
 * @param options - the route (`provider`, `model`), `sessionId`, the effort
 *   DSH picked (the model's least), `currentTitle` for a refresh, `signal`.
 * @returns the options of one `purpose: 'session-title'` call.
 */
export function dshTitleRequest(prompts, { provider = 'packycode', model, sessionId, reasoningEffort, currentTitle, signal } = {}) {
  const messages = prompts.map((text, index) => ({ seq: index + 1, text }))
  return {
    provider,
    model,
    maxTokens: TITLE_CONFIG.maxOutputTokens,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    messages: [createUserMessage({ content: [{ type: 'text', text: frameMessages(messages, currentTitle) }], source: { kind: TITLE_INPUT_SOURCE } })],
    system: systemPrompt(TITLE_CONFIG, currentTitle !== undefined),
    sessionId,
    purpose: 'session-title',
    ...(signal === undefined ? {} : { signal }),
  }
}
