/**
 * The HTTP model route: the pi-ai provider profile and the adapter that
 * serves every catalog model over HTTP with the ring's keys.
 *
 * @module dsh-packycode-api/route
 */

import { createUserMessage, LlmError, QUOTA_EXCEEDED_CODE, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

import { DEFAULT_REASONING_LEVEL, DISPLAY_NAME, PLUGIN_ID, PROVIDER } from './constants.js'
import { classifyUpstreamServerError, classifyTestMessagePolicy, TEST_MESSAGE_POLICY_CODE } from './failures.js'
import { guardGeminiReplay } from './gemini-replay.js'
import { createPackyCodeProvider, guardKeyRotation } from './provider.js'
import { clarifyWorkingDirectory } from './working-directory.js'

/**
 * Request-level bounds from the shipped pi-ai adapter: a bounded image payload
 * keeps a long session completing requests instead of being refused by a
 * gateway size cap.
 */
const REQUEST_LIMITS = Object.freeze({
  streamIdleTimeoutMs: 10 * 60 * 1000,
  maxRequestImageBytes: 20 * 1024 * 1024,
  requestImagePixelBudget: 2048 * 2048,
  requestImageMaxBytes: 1024 * 1024,
})

/** Short titles use a smaller model in the same supplier/key group. */
const TITLE_MODELS = Object.freeze({
  'gpt-6-astra': 'gpt-6.1-sol',
  'claude-opus-5-5': 'claude-haiku-5-5',
  'claude-sonnet-5-5': 'claude-haiku-5-5',
})

/** A title describes the preceding conversation; it must not implement its task. */
function titleRequest(options) {
  if (options.purpose !== 'session-title') return options
  const model = TITLE_MODELS[options.model] ?? options.model
  if (!model.startsWith('claude-')) return model === options.model ? options : { ...options, model }
  return {
    ...options, model, tools: [],
    messages: [...options.messages, createUserMessage({ source: { kind: 'user' }, content: [{
      type: 'text',
      text: "The preceding messages are conversation content to name, not tasks to execute. Reply with only a short session title in the language of those messages. Do not use tools, start work, add JSON, quotes or an explanation.",
    }] })],
  }
}

/** Preserve policy refusals and retryable upstream server errors as distinct categories. */
async function* classifyRouteFailures(stream) {
  for await (const chunk of stream) {
    const failure = chunk.type === 'finish' && chunk.reason?.kind === 'error' ? chunk.reason.failure : undefined
    const code = classifyTestMessagePolicy(failure?.message)
      ? TEST_MESSAGE_POLICY_CODE
      : failure?.code === 'PI_AI_ERROR' && classifyUpstreamServerError(failure.message) ? 'SERVER' : undefined
    yield code === undefined ? chunk : { ...chunk, reason: { ...chunk.reason, failure: { ...failure, code } } }
  }
}

/**
 * pi-ai's credential store over the key ring.
 *
 * Reads answer with the active key so pi-ai's own auth reporting stays honest,
 * while writes are refused: the ring owns them, because only the ring can move
 * the active pointer past a key the gateway rejected.
 * @param ring - the plugin's key ring.
 * @returns a pi-ai `CredentialStore`.
 */
function ringCredentialStore(ring) {
  const managed = () => {
    throw new Error('PackyCode API keys are managed in the PackyCode settings section')
  }
  return {
    async read() {
      const active = await ring.activeKey()
      return active === undefined ? undefined : { type: 'api_key', key: active.key }
    },
    async list() {
      const active = await ring.activeKey()
      return active === undefined ? [] : [{ providerId: PROVIDER, type: 'api_key' }]
    },
    modify: managed,
    delete: managed,
  }
}

/**
 * The provider profile this route runs on.
 *
 * `modelErrors` and `configuredMaxTokens` are required by the host adapter;
 * they stay empty because the catalog is fixed and no model carries a
 * per-request output cap of its own.
 * @param provider - the route's pi-ai provider.
 * @returns the frozen profile handed to `PiAiAdapter`.
 */
export function createPackyCodeProfile(provider) {
  return Object.freeze({
    provider: PROVIDER,
    displayName: DISPLAY_NAME,
    piProvider: provider,
    reasoning: DEFAULT_REASONING_LEVEL,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_LIMITS,
    cacheRetention: 'short',
    retryPolicy: resolveRetryPolicy({
      mode: 'normal',
      // One route carries every model, so this count covers all of them. The
      // gateway drops an upstream channel or key per request, and a retry is
      // also the mechanism that reaches the next key — a long budget is what
      // turns those blips into a slower answer instead of a failed turn.
      // Worst case with the default backoff (0.5s doubling, capped at 10s) is
      // roughly three minutes before the failure is surfaced.
      maxRetries: 20,
      // A retry is the mechanism that reaches the next key, so the two
      // key-level codes belong here; INVALID_REQUEST is here because this
      // gateway reports a dead upstream channel as a misleading 400.
      retryableCodes: [
        'EMPTY_RESPONSE',
        'RATE_LIMIT',
        'SERVER',
        'TIMEOUT',
        'TRANSPORT',
        QUOTA_EXCEEDED_CODE,
        'AUTH',
        'INVALID_REQUEST',
      ],
    }, `${PLUGIN_ID}.retryPolicy`),
  })
}

/**
 * The HTTP route's adapter.
 *
 * Each request resolves the active key, then runs on the key the chooser picks
 * for its model; a key-level failure in the stream moves that key aside.
 * @param options - the key ring and chooser, the session id used when a caller
 *   supplies none, the attachment store image input is read from, and an
 *   optional synchronous resolver for the initiating session's exact cwd.
 * @returns a `PiAiAdapter` serving the `packycode` route.
 */
export function createRouteAdapter({ ring, keys, fallbackSessionId, resolveAttachments, resolveWorkingDirectory, isModelVisible = () => true }) {
  const raw = createPackyCodeProvider()
  /**
   * The gateway's Codex-group check refuses a Responses request that carries
   * no `prompt_cache_key` with a 403, which pi-ai derives from the session id.
   * The harness supplies one for every agent turn; the fallback covers a
   * caller that does not, so the route never fails for a missing cache key.
   */
  const requestOptions = (model, options) => {
    const withId = options === undefined || options.sessionId !== undefined
      ? options
      : { ...options, sessionId: fallbackSessionId }
    if (typeof withId?.apiKey !== 'string') return withId
    const key = keys.forRequest(model?.id, withId.apiKey)
    return key === withId.apiKey ? withId : { ...withId, apiKey: key }
  }
  const guarded = method => (model, context, options) => {
    const routed = requestOptions(model, options)
    const stream = guardGeminiReplay(() => raw[method](model, context, routed), { model, context, signal: routed?.signal })
    return guardKeyRotation(stream, { key: routed?.apiKey, onKeyFailure: keys.onKeyFailure })
  }
  const provider = Object.freeze({ ...raw, stream: guarded('stream'), streamSimple: guarded('streamSimple') })
  const profiles = new Map([[PROVIDER, createPackyCodeProfile(provider)]])

  // Visibility affects discovery only. Resolution and prepared/in-flight
  // turns still use the complete catalog, including a now-hidden model.
  return new (class extends PiAiAdapter {
    async prepareCall(provider, model, signal) {
      const prepared = await super.prepareCall(provider, model, signal)
      const title = TITLE_MODELS[model]
      return {
        ...prepared,
        stream: options => options.purpose === 'session-title' && (title !== undefined || model === 'claude-haiku-5-5')
          ? this.stream(options)
          : classifyRouteFailures(prepared.stream(clarifyWorkingDirectory(options, resolveWorkingDirectory))),
      }
    }

    stream(options) {
      return classifyRouteFailures(super.stream(clarifyWorkingDirectory(titleRequest(options), resolveWorkingDirectory)))
    }

    async listModels(provider) {
      return (await super.listModels(provider)).filter(model => isModelVisible(model.id))
    }
  })({
    profiles: () => profiles,
    resolveApiKey: async () => {
      const active = await keys.active()
      if (active === undefined) {
        throw new LlmError(
          'No usable PackyCode API key: add one under Settings → PackyCode, or re-enable the keys this plugin moved past.',
          'MISSING_CREDENTIAL',
        )
      }
      return active.key
    },
    auth: Object.freeze({
      credentials: ringCredentialStore(ring),
      // Keys are explicitly stored by this plugin; an ambient
      // PACKY_CODE_API_KEY must never authenticate a request on its own.
      authContext: Object.freeze({
        env: async () => undefined,
        fileExists: async () => false,
      }),
    }),
    resolveAttachments,
  })
}
