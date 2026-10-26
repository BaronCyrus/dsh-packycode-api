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

import { AUTO_REVIEW_MODELS, createJevReviewer, DEFAULT_AUTO_REVIEW_MODEL } from './auto-review.js'
import { createAutoReviewController } from './auto-review-controller.js'
import { createBalanceReader } from './balance.js'
import { createClaudeAgentBridge } from './claude-agent-tools.js'
import { sessionUuid } from './claude-api.js'
import { isClaudeCliOutdated } from './claude-binary.js'
import { createClaudeCliManager, createClaudeLatestReader } from './claude-install.js'
import { createClaudeCliTransport } from './claude-cli-transport.js'
import { claudeTransportFor, isClaudeModel } from './claude-transport.js'
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
  /** Path to the Claude Code CLI; empty means "the usual install places, then PATH". */
  claudeCliPath: live(z.string().default('')),
  /**
   * Which model DSH's official 自动审查 reviews with: `jev-latest` or
   * `deepseek-flash` through PackyCode, or `session` for its own default.
   */
  autoReviewModel: live(z.union([...AUTO_REVIEW_MODELS]).default(DEFAULT_AUTO_REVIEW_MODEL)),
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
    claudeCliPath: fieldValue(config?.claudeCliPath),
    autoReviewModel: fieldValue(config?.autoReviewModel),
  })
  const hosts = () => {
    const current = source() ?? {}
    return {
      apiHost: normalizeHost(current.apiHost, DEFAULT_API_HOST),
      statusHost: normalizeHost(current.statusHost, DEFAULT_STATUS_HOST),
    }
  }

  const balance = createBalanceReader({ listKeys: () => ring.secrets(), getHosts: hosts })
  const imageBalance = createBalanceReader({ listKeys: () => imageRing.secrets(), getHosts: hosts })
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

  // ── the Claude Code CLI transport ─────────────────────────────────────────

  /**
   * Keys in a group that only serves the official client have their Claude
   * sessions run by this device's Claude Code CLI as the agent. Its tool
   * calls appear in DSH as `claude_code` calls: DSH shows them, asks when
   * Claude Code asks for permission, and reviews its plans.
   */
  const claudeCli = createClaudeCliManager({
    explicitPath: () => fieldValue(source()?.claudeCliPath),
    latestReader: createClaudeLatestReader(),
  })
  let agentBridge
  const cliTransport = createClaudeCliTransport({
    binary: async () => {
      let found = await claudeCli.detect()
      // A CLI updated in a terminal since the last check is used at once.
      if (isClaudeCliOutdated(found.version)) found = await claudeCli.detect({ force: true })
      if (typeof found.path !== 'string' || found.path === '') {
        throw Object.assign(new Error('Claude Code CLI is not installed'), { code: 'CLAUDE_CLI_MISSING' })
      }
      return found.path
    },
    version: () => claudeCli.lastDetection()?.version,
    nestedPermission: (key, request) => agentBridge.nestedPermission(key, request),
    logger: ctx.logger,
  })
  ctx.effect(() => () => { void cliTransport.close() }, 'packycode-api: Claude Code CLI processes')
  /**
   * A DSH service as an agent sees it. On the Web surface an agent's plan
   * mode, like every row its preset owns, lives in the preset's isolated
   * realm, which this plugin's own context cannot see; elsewhere the host's
   * service answers.
   */
  const serviceFor = (agent, name) => {
    try {
      const scoped = agent === undefined ? undefined : ctx.get?.('agentPresets')?.serviceFor?.(agent, name)
      if (scoped !== undefined) return scoped
    } catch { /* a profile without agent presets */ }
    try { return ctx.get?.(name) } catch { return undefined }
  }
  agentBridge = createClaudeAgentBridge({
    transport: cliTransport,
    services: agent => ({
      userQuestions: serviceFor(agent, 'userQuestions'),
      planMode: serviceFor(agent, 'planMode'),
      permissionPresets: serviceFor(agent, 'permissionPresets'),
      approval: serviceFor(agent, 'approval'),
    }),
    logger: ctx.logger,
  })
  /** The agent a cc Claude request runs for, when the request is its own step. */
  const requestAgent = meta => {
    if (meta.purpose !== undefined) return undefined
    try {
      const agent = ctx.get?.('agents')?.currentInitiator?.()
      return agent !== undefined && sessionUuid(agent.id) === meta.sessionId ? agent : undefined
    } catch {
      return undefined
    }
  }
  /**
   * The provider and model an agent's next request runs on. The session's
   * own pick in the model picker overrides the agent's options in DSH's
   * request waterfall, so it is read first: a pending pick, else the last
   * request's model.
   */
  const nextModelOf = agent => {
    try {
      const state = ctx.get?.('sessionProjections')?.stateOf?.(agent.session, 'modelSelection')
      const next = state?.pending ?? state?.lastUsed
      if (typeof next?.provider === 'string' && typeof next?.model === 'string') return next
    } catch { /* a profile without the model-selection projection */ }
    try {
      const config = agent.session?.requestHeader?.()?.config
      if (typeof config?.provider === 'string' && typeof config?.model === 'string') return config
    } catch { /* no request yet */ }
    return { provider: agent?.options?.provider, model: agent?.options?.model }
  }
  /** The transport a Claude request on this key takes, by its last group reading. */
  const claudeTransportOf = keyId => claudeTransportFor({ groups: keyId === undefined ? undefined : groups.groupsOf(keyId) })
  /** Sessions whose running turn is Claude Code's; it may be waiting for DSH's tool results. */
  const cliTurns = new WeakSet()
  /** Read the active key's groups in the background, for the routes still to come. */
  const readGroupsSoon = () => { void keys.active().then(key => (key === undefined ? undefined : keys.awaitGroups?.(key.id))).catch(() => undefined) }
  // A session that opens reads them before its first turn needs them.
  ctx.on?.('agent/created', readGroupsSoon)
  /**
   * DSH lists a step's tools before it calls the model, and Auto review only
   * reviews a call of a tool the step listed. So each turn decides its route
   * when it starts: a Claude turn for Claude Code gets the mirror tool before
   * its first step, any other turn loses it. A turn that starts on the CLI
   * stays there to its end, even if a group reading arrives during it.
   */
  ctx.on?.('session/event', (session, event) => {
    if (event?.type === 'turn/end') { cliTurns.delete(session); return }
    if (event?.type !== 'turn/start') return
    let agent
    try { agent = ctx.get?.('agents')?.currentInitiator?.() } catch { return }
    if (agent === undefined || agent.session !== session) return
    const next = nextModelOf(agent)
    const route = next.provider === PROVIDER && isClaudeModel(next.model) ? claudeTransportOf(keys.idFor(next.model)) : undefined
    if (route?.transport !== 'cli') {
      cliTurns.delete(session)
      agentBridge.detach(agent)
      return
    }
    cliTurns.add(session)
    agentBridge.attach(agent)
    if (route.reason === 'unknown') readGroupsSoon()
  })

  // ── the model route ───────────────────────────────────────────────────────

  // Every model runs DSH's native agent loop, except Claude on a cc key (or
  // one whose groups are not read yet), where Claude Code is the agent; no
  // other fallback exists.
  const registration = ctx.llm.registerAdapter([PROVIDER], createRouteAdapter({
    ring, keys, fallbackSessionId, resolveAttachments: attachments, isModelVisible: modelSelection.isVisible,
    claudeCli: Object.freeze({
      followsGroups: () => true,
      choose: ({ apiKey, model }) => {
        if (!isClaudeModel(model)) return false
        const session = currentSession()
        return (session !== undefined && cliTurns.has(session)) || claudeTransportOf(keys.idOf(apiKey)).transport === 'cli'
      },
      fetch: (input, init, meta) => {
        const agent = requestAgent(meta)
        const route = { groupsKnown: claudeTransportOf(keys.idOf(meta.apiKey)).reason === 'group' }
        if (agent === undefined) return cliTransport.fetch(input, init, { ...meta, ...route })
        agentBridge.attach(agent)
        return cliTransport.fetch(input, init, { ...meta, ...route, ...agentBridge.permissionModes(agent) })
      },
    }),
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
  const autoReviewPreference = { writable: false, set: undefined }
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

  /**
   * DSH's official 自动审查 reviews each tool call with one model request; the
   * `llm/stream` listener answers it with the reviewer picked here, using this
   * plugin's keys. The official plugin keeps the menu entry and the outcomes.
   */
  const autoReview = createAutoReviewController({
    jev: createJevReviewer({ ring, hosts, covers: keys.covers, onKeyFailure: keys.onKeyFailure }),
    stream: options => ctx.llm.stream(options),
    readPreference: () => source() ?? {},
    writePreference: patch => autoReviewPreference.set(patch),
    isWritable: () => autoReviewPreference.writable === true && typeof autoReviewPreference.set === 'function',
    loaderEntry,
    presetNames: () => ctx.get?.('permissionPresets')?.names ?? [],
    logger: ctx.logger,
  })
  ctx.on?.('llm/stream', autoReview.listener)

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
    autoReviewPreference,
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
    claude: Object.freeze({
      async status({ force = false } = {}) {
        return { ...(await claudeCli.status({ force })), processes: cliTransport.stats() }
      },
      install: () => claudeCli.install(),
      update: () => claudeCli.update(),
      transportFor: names => claudeTransportFor({ groups: names }),
    }),
    search,
    autoReview,
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

export { CLAUDE_MIN_VERSION, CLAUDE_MISSING_MESSAGE, CLAUDE_NPM_PACKAGE, claudeBinaryCandidates, DEFAULT_CLAUDE_CONFIG_DIR, isClaudeCliOutdated, locateClaudeBinary, resolveSpawnCommand } from './claude-binary.js'
export { answersFor, approvalReason, createClaudeAgentBridge, presentClaudeCall, presentClaudeResult, questionsFor, refusalMessage } from './claude-agent-tools.js'
export { baseUrlOf, CLI_SESSION_IDLE_MS, compactionSummary, createClaudeCliTransport, describeRequest, dshSystemText, MAX_LIVE_CLI_SESSIONS, messageFingerprint, planAnswer, planContinuation, questionPrompt, splitAtLastAnswer, textResponse, titlePrompt } from './claude-cli-transport.js'
export { buildCliArgs, buildCliEnvironment, CLI_PROJECT_DIR_NAME, cliErrorMessage, MIRROR_TOOL, PLAN_TOOL, responseFingerprint, startClaudeCliSession, toolResultText } from './claude-cli-session.js'
export { CLAUDE_INSTALL_COMMAND, CLAUDE_NPM_LATEST_URL, CLAUDE_NPM_UPDATE_COMMAND, CLAUDE_SELF_UPDATE_COMMAND, createClaudeCliManager, createClaudeLatestReader, explainNpmFailure, isNpmClaudeInstall, locateNpm, parseClaudeVersion } from './claude-install.js'
export { claudePermissionMode, CLAUDE_PERMISSION_MODES } from './claude-permission-mode.js'
export { buildTranscript, toCliHistory } from './claude-transcript.js'
export { sessionUuid } from './claude-api.js'
export { createClaudeToolNames } from './claude-tools.js'
export { claudeTransportFor, CLI_ONLY_GROUPS, HTTP_CLAUDE_GROUPS } from './claude-transport.js'
export {
  answerChunks,
  AUTO_REVIEW_FLASH,
  AUTO_REVIEW_JEV,
  AUTO_REVIEW_MODEL_NAMES,
  AUTO_REVIEW_MODELS,
  AUTO_REVIEW_SESSION,
  AUTO_REVIEW_TIMEOUT_MS,
  createJevReviewer,
  decideFromJev,
  DEFAULT_AUTO_REVIEW_MODEL,
  failureChunk,
  isOfficialReviewRequest,
  JEV_ALLOW_THRESHOLD,
  JEV_HIGH_RISK_LIMIT,
  JEV_LIMITS,
  JEV_QUESTIONS,
  jevState,
  officialAnswer,
  readReviewSections,
} from './auto-review.js'
export { AUTO_PRESET, createAutoReviewController, DSH_AUTO_REVIEW_ROW, readAutoReviewChoice } from './auto-review-controller.js'
export { createBalanceReader, parseTokenUsage } from './balance.js'
export { normalizeHost, statusHostOrder } from './hosts.js'
export { PACKYCODE_CLASSIFIER_MODELS, PACKYCODE_COVERED_MODEL_IDS, PACKYCODE_MODELS, PACKYCODE_MODEL_IDS } from './catalog.js'
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
  classifyCliOutdated,
  classifyCliUnavailable,
  classifyGatewayFailure,
  classifyUpstreamServerError,
  classifyTestMessagePolicy,
  explainTestMessagePolicyFailure,
  TEST_MESSAGE_POLICY_CODE,
  explainClientPolicyFailure,
  explainCliClientPolicyFailure,
  explainCliOutdated,
  explainCliUnavailable,
  normalizeFailureMessage,
} from './failures.js'
export { createDiagnostics, DIAGNOSTICS_FORMAT, DIAGNOSTICS_LIMITS, summarizeSessionEvents } from './diagnostics.js'
export { catalogCoverage, createGroupReader, parsePricing, parseSelectedGroups, pickKeyForModel } from './groups.js'
export { createKeyChooser, orderKeysFor } from './key-chooser.js'
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
