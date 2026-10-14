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
 * 5.5 (platform.claude.com effort docs), GPT-6.1 Sol and GPT-6 Astra
 * `reasoning.effort` (developers.openai.com model pages), DeepSeek thinking
 * mode (`thinking` toggle plus `low|high|max` effort), and Grok 4.7
 * (docs.x.ai/developers/grok-4-7).
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

/**
 * Claude 5.5 models, GPT-6.1 Sol, and GPT-6 Astra cannot disable reasoning, so `off` is
 * pinned unsupported. The Claude models run through the CLI, which picks its
 * own effort, so for them these levels only shape the picker.
 */
const ALWAYS_THINKING_LEVELS = Object.freeze({
  off: null,
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
})

/** Grok 4.7 supports low | medium | high | xhigh, with no off or max. */
const GROK_LEVELS = Object.freeze({ ...ALWAYS_THINKING_LEVELS, max: null })

export const PACKYCODE_MODELS = Object.freeze([
  Object.freeze({
    // api-docs.deepseek.com/guides/vision: Flash accepts text and images
    // through the OpenAI-compatible Chat Completions API.
    id: 'deepseek-flash',
    name: 'DeepSeek Flash',
    api: 'openai-completions',
    provider: PROVIDER,
    baseUrl: COMPLETIONS_BASE,
    reasoning: true,
    input: Object.freeze(['text', 'image']),
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
    // developers.openai.com/api/docs/models/gpt-6-astra: Responses and Chat
    // Completions; text and image input; 1,050,000 context, 128,000 output;
    // `reasoning.effort` low | medium | high | xhigh | max (no `none`).
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
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
    // docs.x.ai/developers/grok-4-7: Responses; text/image input; 500K
    // context, no separate text-output cap. pi-ai requires a numeric output
    // ceiling and bounds it by the remaining context on each request.
    id: 'grok-4.7',
    name: 'Grok 4.7',
    api: 'openai-responses',
    provider: PROVIDER,
    baseUrl: RESPONSES_BASE,
    reasoning: true,
    input: Object.freeze(['text', 'image']),
    cost: NO_COST,
    contextWindow: 500_000,
    maxTokens: 500_000,
    thinkingLevelMap: GROK_LEVELS,
    compat: Object.freeze({ supportsLongCacheRetention: false }),
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
  Object.freeze({
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
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
      forceAdaptiveThinking: true,
      supportsTemperature: false,
    }),
  }),
  Object.freeze({
    // platform.claude.com/docs/en/models/haiku-5-5/overview: 1M context,
    // 128K max output — the same as Opus and Sonnet 5.5.
    id: 'claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
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
      forceAdaptiveThinking: true,
      supportsTemperature: false,
    }),
  }),
])

/** Every model id this catalog advertises, in picker order. */
export const PACKYCODE_MODEL_IDS = Object.freeze(PACKYCODE_MODELS.map(model => model.id))
