/**
 * The built-in PackyCode model catalog.
 *
 * The gateway's own guidance for these routes, which the base URLs and pinned
 * protocols below exist to satisfy:
 * - OpenAI/Codex traffic takes `/v1` in the base URL and never an endpoint
 *   path — the SDK appends `/responses` or `/chat/completions` itself.
 * - Anthropic traffic takes `https://cf.api.fan` with **no** `/v1`: the
 *   Anthropic client appends `/v1/messages` itself.
 * - A model asked over the wrong protocol does not fail cleanly; the stream
 *   ends early. So every model pins the protocol its vendor serves here.
 *
 * Effort levels come from each vendor's documentation, because an effort the
 * model does not support is refused before the request is sent: Claude Opus
 * 5.5 (platform.claude.com effort docs), GPT-6.1 Sol `reasoning.effort`
 * (developers.openai.com model page), DeepSeek thinking mode (`thinking`
 * toggle plus `low|high|max` effort).
 *
 * @module dsh-packycode-api/catalog
 */

import { DEFAULT_API_HOST, PROVIDER } from './constants.js'

/** pi-ai never reads this gateway's pricing; the harness zeroes cost anyway. */
const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

const COMPLETIONS_BASE = `${DEFAULT_API_HOST}/v1`
const RESPONSES_BASE = `${DEFAULT_API_HOST}/v1`
const MESSAGES_BASE = DEFAULT_API_HOST

/**
 * pi-ai thinking-level maps. A level pinned to `null` is unsupported; an
 * absent key keeps pi-ai's own default for that level, which is how `off`
 * stays available for DeepSeek (`off` sends nothing and the deepseek dialect
 * then emits `thinking: disabled`).
 */
const DEEPSEEK_LEVELS = Object.freeze({
  minimal: null,
  low: 'low',
  medium: null,
  high: 'high',
  xhigh: null,
  max: 'max',
})

/** Opus 5.5 and GPT-6.1 Sol cannot disable reasoning, so `off` is pinned unsupported. */
const ALWAYS_THINKING_LEVELS = Object.freeze({
  off: null,
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
})

export const PACKYCODE_MODELS = Object.freeze([
  Object.freeze({
    id: 'deepseek-flash',
    name: 'DeepSeek Flash',
    api: 'openai-completions',
    provider: PROVIDER,
    baseUrl: COMPLETIONS_BASE,
    reasoning: true,
    input: Object.freeze(['text']),
    cost: NO_COST,
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    thinkingLevelMap: DEEPSEEK_LEVELS,
    compat: Object.freeze({
      thinkingFormat: 'deepseek',
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      supportsDeveloperRole: false,
    }),
  }),
  Object.freeze({
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1 Sol',
    api: 'openai-responses',
    provider: PROVIDER,
    baseUrl: RESPONSES_BASE,
    reasoning: true,
    input: Object.freeze(['text', 'image']),
    cost: NO_COST,
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    thinkingLevelMap: ALWAYS_THINKING_LEVELS,
  }),
  Object.freeze({
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    api: 'anthropic-messages',
    provider: PROVIDER,
    baseUrl: MESSAGES_BASE,
    reasoning: true,
    input: Object.freeze(['text', 'image']),
    cost: NO_COST,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinkingLevelMap: ALWAYS_THINKING_LEVELS,
    compat: Object.freeze({
      // Adaptive thinking is always on for Opus 5.x: effort is the depth
      // control, and the model rejects temperature outright.
      forceAdaptiveThinking: true,
      supportsTemperature: false,
    }),
  }),
])

/** Every model id this catalog advertises, in picker order. */
export const PACKYCODE_MODEL_IDS = Object.freeze(PACKYCODE_MODELS.map(model => model.id))
