/**
 * dsh-packycode-api — a self-contained PackyCode route for DeepSeek Harness.
 *
 * The plugin builds its own pi-ai provider, model catalog, key ring, and
 * balance reader, then registers the route through the same public
 * `llm.registerAdapter` API the shipped adapters use. Nothing here reads the
 * profile's composition config, so installing the package is the whole setup:
 * the picker shows the models and the user only pastes API keys.
 *
 * @module dsh-packycode-api
 */

import { randomUUID } from 'node:crypto'

import { LlmError, QUOTA_EXCEEDED_CODE, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import z from '@deepseek-ai/schemastery'

import { createBalanceReader } from './balance.js'
import {
  CHANNEL,
  DEFAULT_API_HOST,
  DEFAULT_REASONING_LEVEL,
  DEFAULT_STATUS_HOST,
  DISPLAY_NAME,
  PLUGIN_ID,
  PROVIDER,
  SETTINGS_NAMESPACE,
} from './constants.js'
import { PackyCodeKeyRing } from './key-ring.js'
import { createPackyCodeProvider, guardKeyRotation } from './provider.js'
import { createPackyCodeRpc, normalizeHost } from './rpc.js'

export const name = PLUGIN_ID
/**
 * Only the model route is mandatory. `connection` carries the browser RPC
 * surface, and `settings` the host overrides: a profile without them (a
 * headless run, for one) must still boot with a working route instead of
 * blocking on a service it will never see.
 */
export const inject = ['llm', 'credentials']

/** Host overrides; a profile that never installs this section keeps the defaults. */
export const Config = z.object({
  apiHost: z.string().default(DEFAULT_API_HOST),
  statusHost: z.string().default(DEFAULT_STATUS_HOST),
})

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

export function apply(ctx, config) {
  const balanceReaderOptions = {}
  const ring = new PackyCodeKeyRing(ctx.credentials)

  /**
   * Key material to ring id. A failure is reported from inside a stream, which
   * carries the request's key but not its id; this index is refreshed on every
   * resolution so the right key is the one that moves aside.
   */
  const idByKey = new Map()
  const rememberKeys = async () => {
    for (const entry of await ring.secrets()) idByKey.set(entry.key, entry.id)
  }

  let source = () => ({
    apiHost: normalizeHost(config?.apiHost, DEFAULT_API_HOST),
    statusHost: normalizeHost(config?.statusHost, DEFAULT_STATUS_HOST),
  })
  const hosts = () => {
    const current = source() ?? {}
    return {
      apiHost: normalizeHost(current.apiHost, DEFAULT_API_HOST),
      statusHost: normalizeHost(current.statusHost, DEFAULT_STATUS_HOST),
    }
  }

  const balance = createBalanceReader({
    ...balanceReaderOptions,
    listKeys: () => ring.secrets(),
    getHosts: hosts,
  })

  const onKeyFailure = (kind, _message, key) => {
    const id = key === undefined ? undefined : idByKey.get(key)
    if (id === undefined) {
      ctx.logger?.warn?.('packycode-api: %s reported for an unidentified key; not rotating', kind)
      return
    }
    ctx.logger?.warn?.('packycode-api: %s on key %s; the next key serves the retry', kind, id)
    void ring.disable(id, kind)
      .then(() => balance.invalidate())
      .catch(error => ctx.logger?.warn?.('packycode-api: could not move past key %s: %s', id, error.message))
  }

  const raw = createPackyCodeProvider()
  /**
   * The gateway's Codex-group check refuses a Responses request that carries no
   * `prompt_cache_key` with a 403, which pi-ai derives from the session id. The
   * harness supplies one for every agent turn; this fallback covers a caller
   * that does not, so the route never fails for a missing cache key.
   */
  const fallbackSessionId = `${PLUGIN_ID}-${randomUUID()}`
  const withSessionId = options => (options === undefined || options.sessionId !== undefined
    ? options
    : { ...options, sessionId: fallbackSessionId })
  const provider = Object.freeze({
    ...raw,
    stream: (model, context, options) => guardKeyRotation(raw.stream(model, context, withSessionId(options)), {
      key: options?.apiKey,
      onKeyFailure,
    }),
    streamSimple: (model, context, options) => guardKeyRotation(raw.streamSimple(model, context, withSessionId(options)), {
      key: options?.apiKey,
      onKeyFailure,
    }),
  })

  const profile = createPackyCodeProfile(provider)
  const profiles = new Map([[PROVIDER, profile]])

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => {
      await rememberKeys()
      const active = await ring.activeKey()
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
    resolveAttachments: () => ctx.get?.('attachments') ?? ctx.attachments,
  })

  ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: DISPLAY_NAME,
    settingsNs: SETTINGS_NAMESPACE,
    settingsPath: [],
  }])

  const preference = {
    writable: false,
    set: async () => {
      throw new Error('PackyCode host overrides are not writable in this profile')
    },
  }
  ctx.inject(['settings'], settingsCtx => {
    try {
      settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, source(), {
        // The section hands back the live source; it may answer with a plain
        // value on a runtime that does not wrap it in a getter.
        setSource: current => {
          source = typeof current === 'function' ? () => current() ?? {} : () => current ?? {}
        },
        onChange: () => balance.invalidate(),
      })
      if (typeof settingsCtx.settings.update === 'function') {
        preference.writable = true
        preference.set = patch => settingsCtx.settings.update(SETTINGS_NAMESPACE, patch)
      }
    } catch (error) {
      ctx.logger?.warn?.('packycode-api: host overrides unavailable, defaults stand: %s', error.message)
    }
  })

  void rememberKeys().catch(() => undefined)

  const handler = createPackyCodeRpc({ ring, balance, hosts, preference })
  /**
   * Connection registers a channel through `owner.webServer`, read on its own
   * row's fiber — which is why this plugin ships the `connection` inject patch
   * in `cordis.patch.yml`. Without that service the read is refused, the
   * channel never reaches the web server, and the browser answers HTTP 405
   * while the boot log stays clean. A profile with neither service (a headless
   * run) simply never runs this callback.
   */
  ctx.inject(['connection', 'webServer'], connectionCtx => {
    ctx.effect(
      () => connectionCtx.connection.rpc.handle(CHANNEL, handler),
      'packycode-api: loopback account RPC',
    )
  })
}

export { createBalanceReader, parseBillingSubscription, parseBillingUsage, parseTokenUsage } from './balance.js'
export { PACKYCODE_MODELS, PACKYCODE_MODEL_IDS } from './catalog.js'
export {
  CHANNEL,
  DEFAULT_API_HOST,
  DEFAULT_STATUS_HOST,
  DISPLAY_NAME,
  PLUGIN_ID,
  PROVIDER,
  SETTINGS_NAMESPACE,
} from './constants.js'
export { classifyClientPolicy, classifyGatewayFailure, explainClientPolicyFailure, normalizeFailureMessage } from './failures.js'
export { assertApiKey, PackyCodeKeyRing } from './key-ring.js'
export { createPackyCodeProvider, guardKeyRotation } from './provider.js'
export { createPackyCodeRpc, normalizeHost } from './rpc.js'
