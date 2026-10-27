/**
 * The built-in PackyCode model catalog.
 *
 * The gateway's own guidance for these routes, which the base URLs and pinned
 * protocols below exist to satisfy:
 * - OpenAI-protocol traffic takes `/v1` in the base URL and never an endpoint
 *   path — the SDK appends `/responses` itself.
 * - Anthropic traffic takes `https://cf.api.fan` with **no** `/v1`: the
 *   Anthropic client appends `/v1/messages` itself.
 * - A model asked over the wrong protocol does not fail cleanly; the stream
 *   ends early. So every model pins the protocol its vendor serves here.
 *
 * Effort levels come from each vendor's documentation, because an effort the
 * model does not support is refused before the request is sent: Claude Opus
 * 5.5 (platform.claude.com effort docs), GPT-6.1 Sol, GPT-6.1 Terra, GPT-6
 * Astra and GPT-5.6 Sol `reasoning.effort` (developers.openai.com model
 * pages), DeepSeek thinking mode (`low|high|max` effort, or off), Grok 4.7
 * (docs.x.ai/developers/grok-4-7), and Gemini 4 Argon
 * (ai.google.dev/gemini-api/docs/models/gemini-4-argon and docs/openai).
 *
 * @module dsh-packycode-api/catalog
 */

import { DEFAULT_API_HOST, PROVIDER } from './constants.js'

/** pi-ai never reads this gateway's pricing; the harness zeroes cost anyway. */
const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

const RESPONSES_BASE = `${DEFAULT_API_HOST}/v1`
const MESSAGES_BASE = DEFAULT_API_HOST
const GEMINI_BASE = `${DEFAULT_API_HOST}/v1beta`

/**
 * PackyCode's GPT route treats a function tool that names no `strict` as
 * strict, so the model fills every optional parameter. DSH's sandbox
 * escalation pair then came back as `workspace-write` with an empty
 * justification, which DSH's edit and write refuse. Declaring strict-mode
 * support makes pi-ai send `strict: false` on each tool, as the official
 * Codex client does; the schemas stay as DSH wrote them. DeepSeek and Grok
 * leave optional parameters out either way.
 */
const GPT_COMPAT = Object.freeze({ supportsStrictMode: true })

/**
 * pi-ai thinking-level maps. A level pinned to `null` is unsupported; an
 * absent key keeps pi-ai's own default for that level, which is how `off`
 * stays available for DeepSeek: pi-ai's Responses API then sends
 * `reasoning.effort: "none"`, which the gateway answers without reasoning.
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
 * pinned unsupported; GPT-5.6 Sol is kept on the same levels. Claude effort is
 * sent through the native Messages API.
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

/**
 * GPT-6.1 Terra documents `reasoning.effort` none | low | medium | high |
 * xhigh | max, and PackyCode passes its `none` through (no reasoning tokens),
 * so `off` keeps pi-ai's default and sends `none`. `minimal` is not
 * documented; the gateway answers it as `none`.
 */
const TERRA_LEVELS = Object.freeze({
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
})

/** Grok 4.7 supports low | medium | high | xhigh, with no off or max. */
const GROK_LEVELS = Object.freeze({ ...ALWAYS_THINKING_LEVELS, max: null })

/** Gemini 4 Argon and 3.8 Flash support low | medium | high, with no off. */
const GEMINI_LEVELS = Object.freeze({ ...ALWAYS_THINKING_LEVELS, xhigh: null, max: null })

export const PACKYCODE_MODELS = Object.freeze([
  Object.freeze({
    // api-docs.deepseek.com/guides/vision: Flash accepts text and images.
    // PackyCode also serves it on Responses (`/api/pricing` lists
    // `openai-response`): reasoning arrives as `reasoning_text` items, which
    // pi-ai replays with the turn's tool calls, and the gateway caches the
    // prefix without `prompt_cache_key`. Output is capped at 393,216 there.
    id: 'deepseek-flash',
    name: 'DeepSeek Flash',
    api: 'openai-responses',
    provider: PROVIDER,
    baseUrl: RESPONSES_BASE,
    reasoning: true,
    input: Object.freeze(['text', 'image']),
    cost: NO_COST,
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    thinkingLevelMap: DEEPSEEK_LEVELS,
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
    compat: GPT_COMPAT,
  }),
  Object.freeze({
    // developers.openai.com/api/docs/models/gpt-6.1-terra: Responses and Chat
    // Completions (tool calling needs Responses); text and image input;
    // 1,050,000 context, 128,000 output. PackyCode serves it to `codex` and
    // `codex-sale`, not `azure-officially`.
    id: 'gpt-6.1-terra',
    name: 'GPT-6.1 Terra',
    api: 'openai-responses',
    provider: PROVIDER,
    baseUrl: RESPONSES_BASE,
    reasoning: true,
    input: Object.freeze(['text', 'image']),
    cost: NO_COST,
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    thinkingLevelMap: TERRA_LEVELS,
    compat: GPT_COMPAT,
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
    compat: GPT_COMPAT,
  }),
  Object.freeze({
    // developers.openai.com/api/docs/models/gpt-5.6-sol: Responses and Chat
    // Completions; text and image input; 1,050,000 context, 128,000 output;
    // `reasoning.effort` none | low | medium | high | xhigh | max. `none` is
    // deliberately not offered, so it takes the same levels as GPT-6.1 Sol.
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    api: 'openai-responses',
    provider: PROVIDER,
    baseUrl: RESPONSES_BASE,
    reasoning: true,
    input: Object.freeze(['text', 'image']),
    cost: NO_COST,
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    thinkingLevelMap: ALWAYS_THINKING_LEVELS,
    compat: GPT_COMPAT,
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
    // PackyCode lists only the native Gemini endpoint for Argon. The Google
    // model page declares unified 1M context and 65,536 output per stream;
    // automatic continuation/long decode is not part of this route.
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    api: 'google-generative-ai',
    provider: PROVIDER,
    baseUrl: GEMINI_BASE,
    reasoning: true,
    input: Object.freeze(['text', 'image']),
    cost: NO_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    thinkingLevelMap: GEMINI_LEVELS,
  }),
  Object.freeze({
    // ai.google.dev/gemini-api/docs/models/gemini-3.8-flash. Keep the Gemini
    // family on its native protocol, including image and signature replay.
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    api: 'google-generative-ai',
    provider: PROVIDER,
    baseUrl: GEMINI_BASE,
    reasoning: true,
    input: Object.freeze(['text', 'image']),
    cost: NO_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    thinkingLevelMap: GEMINI_LEVELS,
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

/**
 * Models the plugin calls host-side and never lists in the picker. TypeSafe's
 * Jev is a classifier, not a chat model: it answers typed questions about a
 * JSON state over the System One protocol, which PackyCode lists as the
 * `systemone` endpoint (`POST /v1/systemone`) in the `typesafe-officially`
 * group. Auto review asks it whether a tool call may run. The descriptor
 * follows pi-ai's own TypeSafe catalog entry (64K context, text only).
 */
export const PACKYCODE_CLASSIFIER_MODELS = Object.freeze([
  Object.freeze({
    type: 'classifier',
    id: 'jev-latest',
    name: 'Jev',
    api: 'typesafe-system-one',
    provider: PROVIDER,
    baseUrl: RESPONSES_BASE,
    input: Object.freeze(['text']),
    cost: NO_COST,
    contextWindow: 64_000,
  }),
])

/** Every model whose group coverage is read for each key: the picker's, then the classifiers. */
export const PACKYCODE_COVERED_MODEL_IDS = Object.freeze([
  ...PACKYCODE_MODEL_IDS,
  ...PACKYCODE_CLASSIFIER_MODELS.map(model => model.id),
])
