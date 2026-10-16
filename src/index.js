/**
 * dsh-packycode-api — a self-contained PackyCode route for DeepSeek Harness.
 *
 * The plugin builds its own pi-ai provider, model catalog, key ring, balance
 * and group readers, then registers the route through the same public
 * `llm.registerAdapter` API the shipped adapters use. Nothing here reads the
 * profile's composition config, so installing the package is the whole setup:
 * the picker shows the models and the user only pastes API keys.
 *
 * This module only composes; each concern lives in its own module.
 *
 * @module dsh-packycode-api
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import z from '@deepseek-ai/schemastery'

import { createBalanceReader } from './balance.js'
import {
  CHANNEL,
  DEFAULT_API_HOST,
  DEFAULT_STATUS_HOST,
  DISPLAY_NAME,
  IMAGE_KEY_RECORD_ID,
  PLUGIN_ID,
  PROVIDER,
  SETTINGS_NAMESPACE,
} from './constants.js'
import { createDiagnostics } from './diagnostics.js'
import { createGroupReader } from './groups.js'
import { DEFAULT_IMAGE_MODEL, IMAGE_MODEL_IDS, IMAGE_QUALITIES } from './image-models.js'
import { createImageController } from './image-settings.js'
import { createImageOriginalReader } from './image-originals.js'
import { createPackyCodeImageClient, createPackyCodeImageTool } from './images.js'
import { normalizeHost } from './hosts.js'
import { createKeyChooser } from './key-chooser.js'
import { PackyCodeKeyRing } from './key-ring.js'
import { createModelSelectionController } from './model-selection.js'
import { createPackyCodePluginManager } from './plugin-version.js'
import { connectSettings, fieldValue, live, unwritable } from './preferences.js'
import { createRouteAdapter } from './route.js'
import { createPackyCodeRpc } from './rpc.js'
import { DEFAULT_SEARCH_BACKEND, SEARCH_BACKENDS, SEARCH_MODE_DEFAULT, SEARCH_MODES } from './search.js'
import { createProfileSearchComposition } from './search-composition.js'
import { createSearchController } from './search-controller.js'

export const name = PLUGIN_ID
/**
 * Only the model route is mandatory. `settings`, `web`, `connection`, and
 * `tools` are requested through `ctx.inject`: a profile without them (a
 * headless run, for one) must still boot with a working route instead of
 * blocking on a service it will never see.
 */
export const inject = ['llm', 'credentials']

/** Host overrides and preferences; a profile that never sets them keeps the defaults. */
export const Config = z.object({
  apiHost: z.string().default(DEFAULT_API_HOST),
  statusHost: z.string().default(DEFAULT_STATUS_HOST),
  /**
   * Web search routing: `default` leaves DSH's search alone, `auto` searches
   * through PackyCode for PackyCode sessions only, `packycode` for every
   * request DSH's own search would have served.
   */
  searchProvider: live(z.union([...SEARCH_MODES]).default(SEARCH_MODE_DEFAULT)),
  /** Which PackyCode model runs a search: `deepseek` or `gpt`. */
  searchBackend: live(z.union([...SEARCH_BACKENDS]).default(DEFAULT_SEARCH_BACKEND)),
  /** Only the picker is filtered; an existing session can keep its model. */
  hiddenModels: live(z.array(z.string()).default([])),
  imageEnabled: live(z.boolean().default(true)),
  imageModel: live(z.union([...IMAGE_MODEL_IDS]).default(DEFAULT_IMAGE_MODEL)),
  imageQuality: live(z.union([...IMAGE_QUALITIES]).default('auto')),
})

export function apply(ctx, config) {
  const ring = new PackyCodeKeyRing(ctx.credentials)
  const imageRing = new PackyCodeKeyRing(ctx.credentials, { recordId: IMAGE_KEY_RECORD_ID })

  // Read through on every call: on DSH 0.2 the preferences are volatile
  // references that change without restarting the plugin, and on 0.1.5 the
  // installed section replaces this source with its own.
  let source = () => ({
    apiHost: normalizeHost(config?.apiHost, DEFAULT_API_HOST),
    statusHost: normalizeHost(config?.statusHost, DEFAULT_STATUS_HOST),
    searchProvider: fieldValue(config?.searchProvider),
    searchBackend: fieldValue(config?.searchBackend),
    hiddenModels: fieldValue(config?.hiddenModels),
    imageEnabled: fieldValue(config?.imageEnabled),
    imageModel: fieldValue(config?.imageModel),
    imageQuality: fieldValue(config?.imageQuality),
  })
  const hosts = () => {
    const current = source() ?? {}
    return {
      apiHost: normalizeHost(current.apiHost, DEFAULT_API_HOST),
      statusHost: normalizeHost(current.statusHost, DEFAULT_STATUS_HOST),
    }
  }

  const balance = createBalanceReader({ listKeys: () => ring.secrets(), getHosts: hosts })
  const imageBalance = createBalanceReader({ listKeys: () => imageRing.secrets(), getHosts: hosts, includeAccount: false })
  /**
   * Which token groups each key is in, and so which models it can reach.
   * Nothing reads it at boot: the settings panel asks for it, and a request
   * with a choice of keys waits briefly for the first reading.
   */
  const groups = createGroupReader({ listKeys: () => ring.secrets(), getHosts: hosts })
  const keys = createKeyChooser({ ring, groups, logger: ctx.logger, onRotated: () => balance.invalidate() })

  /** The session of the agent this turn runs for, when one is in scope. */
  const currentSession = () => {
    try {
      return ctx.get?.('agents')?.currentInitiator?.()?.session
    } catch {
      return undefined
    }
  }
  /** One Loader entry by row id, or undefined outside a Loader composition. */
  const loaderEntry = id => {
    try {
      return [...(ctx.get?.('loader')?.entries?.() ?? [])].find(entry => entry?.options?.id === id)
    } catch {
      return undefined
    }
  }
  const fallbackSessionId = `${PLUGIN_ID}-${randomUUID()}`
  const attachments = () => ctx.get?.('attachments') ?? ctx.attachments
  const modelPreference = { writable: false, set: undefined }
  let refreshModels = () => {}
  const modelSelection = createModelSelectionController({
    readPreference: () => source() ?? {},
    writePreference: patch => modelPreference.set(patch),
    isWritable: () => modelPreference.writable === true && typeof modelPreference.set === 'function',
    onChange: () => refreshModels(),
  })

  // ── the model route ───────────────────────────────────────────────────────

  // Every model uses DSH's native HTTP/tool loop; no implicit CLI fallback.
  const registration = ctx.llm.registerAdapter([PROVIDER], createRouteAdapter({
    ring, keys, fallbackSessionId, resolveAttachments: attachments, isModelVisible: modelSelection.isVisible,
    resolveWorkingDirectory: sessionId => {
      const session = currentSession()
      // A background/title call for another session must not inherit the
      // foreground workspace. Read fresh metadata on every model request.
      return session && (sessionId === undefined || session.id === sessionId) ? session.header?.cwd : undefined
    },
  }))
  refreshModels = () => {
    // Atomic replacement announces the changed catalog to DSH's model
    // directories without unmounting the route or interrupting a turn.
    if (typeof registration?.replace === 'function') registration.replace([PROVIDER])
    else ctx.emit?.('llm/adapters-updated')
  }
  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: DISPLAY_NAME,
    settingsNs: SETTINGS_NAMESPACE,
    settingsPath: [],
  }])

  // ── preferences and web search ────────────────────────────────────────────

  const hostPreference = unwritable('PackyCode host overrides are not writable in this profile')
  const searchPreference = { writable: false, set: undefined }
  const imagePreference = { writable: false, set: undefined }
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const images = createImageController({
    ring: imageRing,
    balance: imageBalance,
    readPreference: () => source() ?? {},
    writePreference: patch => imagePreference.set(patch),
    isWritable: () => imagePreference.writable === true && typeof imagePreference.set === 'function',
  })
  const imageClient = createPackyCodeImageClient({ resolveKey: () => imageRing.activeKey(), getHost: () => hosts().apiHost })
  const search = createSearchController({
    ring,
    hosts,
    onKeyFailure: keys.onKeyFailure,
    covers: keys.covers,
    readPreference: () => source() ?? {},
    writePreference: patch => searchPreference.set(patch),
    isWritable: () => searchPreference.writable === true && typeof searchPreference.set === 'function',
    resolveModelProvider: () => {
      try {
        return currentSession()?.requestContext?.()?.provider
      } catch {
        return undefined
      }
    },
    resolveSessionId: () => {
      const id = currentSession()?.id
      return typeof id === 'string' && id !== '' ? id : fallbackSessionId
    },
    webEntry: () => loaderEntry('web'),
    composition: createProfileSearchComposition({
      ctx,
      webEntry: () => loaderEntry('web'),
      dshHome,
      ownPackageJsonUrl: new URL('../package.json', import.meta.url),
    }),
    logger: ctx.logger,
  })

  ctx.inject(['settings'], settingsCtx => connectSettings(settingsCtx, {
    ctx,
    Config,
    namespace: SETTINGS_NAMESPACE,
    source: () => source(),
    setSource: next => { source = next },
    onChange: () => {
      balance.invalidate()
      imageBalance.invalidate()
      groups.invalidate()
      modelSelection.reconcile()
      void images.reconcile().catch(() => undefined)
      void search.reconcile()
    },
    hostPreference,
    searchPreference,
    modelPreference,
    imagePreference,
  }))
  // A volatile field changed (the PackyCode panel, or a hand edit of the
  // profile patch): follow it without restarting the route.
  ctx.on?.('loader/volatile-update', () => {
    modelSelection.reconcile()
    void images.reconcile().catch(() => undefined)
    void search.reconcile()
  })

  /**
   * Both search providers register with the web service whenever one exists.
   * Registration alone changes nothing; the preference decides whether the
   * profile patch points DSH at them.
   */
  ctx.inject(['web'], webCtx => {
    if (typeof webCtx.web?.registerSearchProvider !== 'function') return
    const scope = typeof webCtx.effect === 'function' ? webCtx : ctx
    search.register(webCtx.web, (callback, label) => scope.effect(callback, label))
  })

  // ── browser surface and native image tool  ───────────────────────────────

  void keys.remember().catch(() => undefined)

  /** One session's events from DSH's session query service, without projections. */
  const readSessionEvents = async (sessionId, signal) => {
    const query = ctx.get?.('sessionQuery')
    if (typeof query?.observeSession === 'function') {
      const observation = await query.observeSession(sessionId, { signal, projectionMode: 'none' })
      try { return [...observation.events] } finally { observation[Symbol.dispose]() }
    }
    if (typeof query?.readSession === 'function') return (await query.readSession(sessionId)).events
    return []
  }

  const handler = createPackyCodeRpc({
    ring,
    balance,
    groups,
    hosts,
    preference: hostPreference,
    pluginManager: createPackyCodePluginManager(),
    search,
    modelSelection,
    images,
    imageOriginals: createImageOriginalReader({
      imageDirectory: join(dshHome, 'packycode-api', 'images'),
      getSessionEvents: readSessionEvents,
    }),
    diagnostics: createDiagnostics({
      sessionQuery: () => ctx.get?.('sessionQuery'),
      readEvents: readSessionEvents,
      ring,
      groups,
      secrets: async () => (await Promise.all([ring.secrets(), imageRing.secrets()])).flat().map(entry => entry.key),
      ownPackageJsonUrl: new URL('../package.json', import.meta.url),
    }),
  })
  /**
   * The shipped Connection getter retains its own service context, whose row
   * need not inject webServer. Register with our injected context explicitly:
   * a first hot install then mounts the channel without rebuilding Connection.
   * The native registry still owns admission and the wire protocol. Its
   * explicit-owner entry is internal, so retain the public RPC contract for
   * other Connection implementations. A headless profile can omit this scope.
   */
  ctx.inject(['connection', 'webServer'], connectionCtx => {
    const service = connectionCtx.connection
    connectionCtx.effect(
      () => typeof service.register === 'function'
        ? service.register(connectionCtx, CHANNEL, handler)
        : service.rpc.handle(CHANNEL, handler),
      'packycode-api: loopback account RPC',
    )
  })

  ctx.inject(['tools', 'attachments'], imageCtx => {
    const store = imageCtx.attachments
    if (typeof store?.saveImage !== 'function' || typeof store?.readImage !== 'function') return
    const scope = typeof imageCtx.effect === 'function' ? imageCtx : ctx
    scope.effect(() => images.mount(() => imageCtx.tools.register(createPackyCodeImageTool({
      client: imageClient,
      attachments: store,
      getPreference: images.preference,
      onGenerated: () => imageBalance.invalidate(),
      getSessionMessages: id => ctx.get?.('sessions')?.get?.(id)?.deriveMessages?.() ?? [],
      imageDirectory: join(dshHome, 'packycode-api', 'images'),
    }))), 'packycode-api: image tool availability')
  })
}

export { createBalanceReader, parseBillingSubscription, parseBillingUsage, parseTokenUsage } from './balance.js'
export { accountHostOrder, normalizeHost, statusHostOrder } from './hosts.js'
export { PACKYCODE_MODELS, PACKYCODE_MODEL_IDS } from './catalog.js'
export {
  CHANNEL,
  DEFAULT_API_HOST,
  DEFAULT_STATUS_HOST,
  DISPLAY_NAME,
  LEGACY_STATUS_HOSTS,
  PLUGIN_ID,
  PROVIDER,
  SETTINGS_NAMESPACE,
} from './constants.js'
export {
  classifyClientPolicy,
  classifyGatewayFailure,
  classifyUpstreamServerError,
  classifyTestMessagePolicy,
  explainTestMessagePolicyFailure,
  TEST_MESSAGE_POLICY_CODE,
  explainClientPolicyFailure,
  normalizeFailureMessage,
} from './failures.js'
export { createDiagnostics, DIAGNOSTICS_FORMAT, DIAGNOSTICS_LIMITS, summarizeSessionEvents } from './diagnostics.js'
export { catalogCoverage, createGroupReader, parsePricing, parseSelectedGroups, pickKeyForModel } from './groups.js'
export { createKeyChooser } from './key-chooser.js'
export { createModelSelectionController, readHiddenModels } from './model-selection.js'
export { DEFAULT_IMAGE_MODEL, IMAGE_MODELS, IMAGE_MODEL_IDS, IMAGE_QUALITIES, validateImageOptions } from './image-models.js'
export { createImageController, readImagePreference } from './image-settings.js'
export { createPackyCodeImageClient, createPackyCodeImageTool, decodeImagePng, IMAGE_TOOL_NAME, IMAGE_TIMEOUT_MS, MAX_IMAGE_BYTES, pngDimensions } from './images.js'
export { assertApiKey, PackyCodeKeyRing } from './key-ring.js'
export { createPackyCodeProvider, guardKeyRotation } from './provider.js'
export { createPackyCodeProfile, createRouteAdapter } from './route.js'
export { createPackyCodeRpc } from './rpc.js'
export {
  buildSearchRequest,
  createPackyCodeAutoSearchProvider,
  createPackyCodeSearchProvider,
  DEFAULT_SEARCH_BACKEND,
  PACKYCODE_AUTO_SEARCH_PROVIDER_ID,
  PACKYCODE_SEARCH_PROVIDER_ID,
  parseMessagesSearchResponse,
  parseResponsesSearchResponse,
  SEARCH_BACKEND_MODELS,
  SEARCH_BACKENDS,
  SEARCH_MODES,
} from './search.js'
export { createProfileSearchComposition, createSearchComposition } from './search-composition.js'
export { createSearchController, readSearchChoice } from './search-controller.js'
