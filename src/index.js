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
import { PACKYCODE_MODEL_IDS } from './catalog.js'
import { createClaudeCliAdapter } from './claude-adapter.js'
import { DEFAULT_CLAUDE_MODE, createClaudeRunner } from './claude-cli.js'
import { createClaudeCliManager } from './claude-install.js'
import { createClaudeSearchBridge } from './claude-search-mcp.js'
import { createClaudeCodeTool } from './claude-tool.js'
import {
  CHANNEL,
  DEFAULT_API_HOST,
  DEFAULT_STATUS_HOST,
  DISPLAY_NAME,
  PLUGIN_ID,
  PROVIDER,
  SETTINGS_NAMESPACE,
} from './constants.js'
import { createGroupReader } from './groups.js'
import { normalizeHost } from './hosts.js'
import { createKeyChooser } from './key-chooser.js'
import { PackyCodeKeyRing } from './key-ring.js'
import { createModelSelectionController } from './model-selection.js'
import { AUTO_CLAUDE_MODE, claudeModeForSession, planModeForSession, planModeForToolExecution } from './permission.js'
import { createPackyCodePluginManager } from './plugin-version.js'
import { connectSettings, fieldValue, live, unwritable } from './preferences.js'
import { createRouteAdapter } from './route.js'
import { createPackyCodeRpc } from './rpc.js'
import { DEFAULT_SEARCH_BACKEND, SEARCH_BACKENDS, SEARCH_MODE_DEFAULT, SEARCH_MODES } from './search.js'
import { createProfileSearchComposition } from './search-composition.js'
import { createSearchController } from './search-controller.js'
import { redactSecrets } from './secret-redactor.js'

export const name = PLUGIN_ID
/**
 * Only the model route is mandatory. `settings`, `web`, `connection`, and
 * `tools` are requested through `ctx.inject`: a profile without them (a
 * headless run, for one) must still boot with a working route instead of
 * blocking on a service it will never see.
 */
export const inject = ['llm', 'credentials']

/** The model a CLI run without one is matched against for its key's groups. */
const CLI_GROUP_MODEL = 'claude-opus-5-5'

/** Host overrides and preferences; a profile that never sets them keeps the defaults. */
export const Config = z.object({
  apiHost: z.string().default(DEFAULT_API_HOST),
  statusHost: z.string().default(DEFAULT_STATUS_HOST),
  /** Path to the Claude Code CLI binary; empty means "look in the usual places, then PATH". */
  claudeCliPath: z.string().default(''),
  /**
   * What the CLI may do on its own during a CLI-backed turn. `auto` follows the
   * session's permission preset, so nothing needs configuring here.
   */
  claudeCliMode: z.union([AUTO_CLAUDE_MODE, 'read-only', 'edit', 'full']).default(AUTO_CLAUDE_MODE),
  /** Working directory for CLI-backed turns; empty means "the session's workspace". */
  claudeCliCwd: z.string().default(''),
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
})

export function apply(ctx, config) {
  const ring = new PackyCodeKeyRing(ctx.credentials)

  // Read through on every call: on DSH 0.2 the preferences are volatile
  // references that change without restarting the plugin, and on 0.1.5 the
  // installed section replaces this source with its own.
  let source = () => ({
    apiHost: normalizeHost(config?.apiHost, DEFAULT_API_HOST),
    statusHost: normalizeHost(config?.statusHost, DEFAULT_STATUS_HOST),
    searchProvider: fieldValue(config?.searchProvider),
    searchBackend: fieldValue(config?.searchBackend),
    hiddenModels: fieldValue(config?.hiddenModels),
  })
  const hosts = () => {
    const current = source() ?? {}
    return {
      apiHost: normalizeHost(current.apiHost, DEFAULT_API_HOST),
      statusHost: normalizeHost(current.statusHost, DEFAULT_STATUS_HOST),
    }
  }

  const balance = createBalanceReader({ listKeys: () => ring.secrets(), getHosts: hosts })
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

  /**
   * The Claude Code CLI runner. PackyCode serves its Claude models only to the
   * official CLI, so CLI-backed models are run by that CLI itself — with this
   * plugin's endpoint and a ring key, in an isolated config home. Each run
   * uses the active key unless its groups cannot reach the run's Claude model
   * and another stored key's can, and reports which key it used by label.
   */
  const claudeCli = createClaudeCliManager({ explicitPath: () => config?.claudeCliPath })
  const claudeRunner = createClaudeRunner({
    binary: () => claudeCli.binary(),
    resolveCredential: async ({ model } = {}) => {
      // A delegated run without a model runs the CLI's default, a Claude model.
      const choice = await keys.forRun(PACKYCODE_MODEL_IDS.includes(model) ? model : CLI_GROUP_MODEL)
      if (choice === undefined) {
        throw new Error('Claude Code CLI needs a usable PackyCode API key; add one under Settings → PackyCode')
      }
      const { key, ...described } = choice
      return { ...described, baseUrl: hosts().apiHost, token: key }
    },
    createSearchBridge: async ({ signal }) => {
      // MCP HTTP callbacks do not inherit the originating agent's context.
      // Capture the trusted session now, never from model-supplied arguments.
      const sessionId = currentSession()?.id ?? fallbackSessionId
      const secrets = new Set((await ring.secrets()).map(entry => entry.key))
      const bridge = await createClaudeSearchBridge({
        signal,
        backend: () => search.status().searchBackend,
        // Direct provider only: DSH routing/off does not change CLI searches
        // or silently send them to another provider's credentials.
        search: (request, searchSignal) => search.packycode.search({ ...request, sessionId }, searchSignal),
        sanitize: async text => {
          for (const entry of await ring.secrets()) secrets.add(entry.key)
          return redactSecrets(text, [...secrets])
        },
      })
      return {
        ...bridge,
        scrub: text => redactSecrets(bridge.scrub(text), [...secrets]),
        redactionValues: () => [...bridge.redactionValues(), ...secrets],
      }
    },
  })
  ctx.effect(() => () => claudeRunner.close(), 'packycode-api: CLI invocation lifetimes')

  /** The session's own workspace, so a CLI turn edits the project in view. */
  const resolveCliCwd = () => {
    const configured = typeof config?.claudeCliCwd === 'string' ? config.claudeCliCwd.trim() : ''
    if (configured !== '') return configured
    const cwd = currentSession()?.header?.cwd
    // No agent in scope; the process directory is the honest fallback.
    return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  }
  /**
   * The most a CLI turn may do: an explicit setting when the profile names
   * one, otherwise what the session's permission preset allows.
   */
  const cliModeCeiling = session => {
    const configured = config?.claudeCliMode
    return configured === undefined || configured === AUTO_CLAUDE_MODE ? claudeModeForSession(ctx, session) : configured
  }

  // CLI-backed ids run the Claude Code CLI; everything else keeps the pi-ai path.
  const registration = ctx.llm.registerAdapter([PROVIDER], createClaudeCliAdapter({
    inner: createRouteAdapter({ ring, keys, fallbackSessionId, resolveAttachments: attachments, isModelVisible: modelSelection.isVisible }),
    runner: claudeRunner,
    // Plan mode is "do not implement yet" for this turn, so it wins over the
    // permission ceiling and an explicit claudeCliMode pin. Titles ignore it.
    resolveMode: () => {
      const session = currentSession()
      return planModeForSession(ctx, session) ? 'plan' : cliModeCeiling(session) ?? DEFAULT_CLAUDE_MODE
    },
    resolveCwd: resolveCliCwd,
    // Images in a CLI-backed turn are read from the same store the HTTP route
    // reads them from, and sent to the CLI as image blocks.
    resolveAttachments: attachments,
    // A refusal from a run that started before its key's groups were known
    // is explained from a fresh reading.
    explainKey: runKey => keys.describe(runKey),
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
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
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
      groups.invalidate()
      modelSelection.reconcile()
      void search.reconcile()
    },
    hostPreference,
    searchPreference,
    modelPreference,
  }))
  // A volatile field changed (the PackyCode panel, or a hand edit of the
  // profile patch): follow it without restarting the route.
  ctx.on?.('loader/volatile-update', () => {
    modelSelection.reconcile()
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

  // ── browser surface and the delegation tool ───────────────────────────────

  void keys.remember().catch(() => undefined)

  const handler = createPackyCodeRpc({
    ring,
    balance,
    groups,
    hosts,
    preference: hostPreference,
    claudeCli,
    pluginManager: createPackyCodePluginManager(),
    search,
    modelSelection,
  })
  /**
   * Connection registers a channel through `owner.webServer`, read on its own
   * row's fiber — which is why this plugin ships the `connection` inject patch
   * in `cordis.patch.yml`. Without that service the read is refused, the
   * channel never reaches the web server, and the browser answers HTTP 405
   * while the boot log stays clean. A profile with neither service (a headless
   * run) simply never runs this callback.
   */
  ctx.inject(['connection', 'webServer'], connectionCtx => {
    ctx.effect(() => connectionCtx.connection.rpc.handle(CHANNEL, handler), 'packycode-api: loopback account RPC')
  })

  ctx.inject(['tools'], toolsCtx => {
    ctx.effect(
      () => toolsCtx.tools.register(createClaudeCodeTool({
        runner: claudeRunner,
        modeCeiling: cliModeCeiling,
        // A selected transition takes effect only at the next accepted step,
        // never halfway through the batch executing this tool.
        planActive: (session, agent) => planModeForToolExecution(ctx, session, agent),
      })),
      'packycode-api: claude_code tool',
    )
  })
}

export {
  buildClaudeArgs,
  buildClaudeEnvironment,
  buildClaudeInput,
  CLAUDE_CLI_MODES,
  CLAUDE_MISSING_MESSAGE,
  CLAUDE_NPM_PACKAGE,
  claudeBinaryCandidates,
  createClaudeRunner,
  DEFAULT_APPEND_SYSTEM_PROMPT,
  describeRunKey,
  findClaudeBinary,
  locateClaudeBinary,
  parseClaudeResult,
  readClaudeStreamEvents,
  resolveSpawnCommand,
  summarizeToolUse,
} from './claude-cli.js'
export { CLAUDE_INSTALL_COMMAND, createClaudeCliManager, explainNpmFailure, locateNpm, npmCandidates, parseClaudeVersion } from './claude-install.js'
export {
  buildDelegatedContent,
  CLI_BACKED_MODEL_IDS,
  CLI_IMAGE_LIMITS,
  createClaudeCliAdapter,
  delegationInstructions,
  keyNote,
  renderAuxiliaryPrompt,
  renderDelegatedPrompt,
  TITLE_MODEL_ID,
  TITLE_MODEL_ROUTES,
} from './claude-adapter.js'
export { CLAUDE_TOOL_INSTRUCTIONS, createClaudeCodeTool } from './claude-tool.js'
export { createClaudeSearchBridge, cliSearchInstructions } from './claude-search-mcp.js'
export { AUTO_CLAUDE_MODE, capClaudeMode, claudeModeFor, claudeModeForSession, planModeForSession, planModeForToolExecution } from './permission.js'
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
  explainClientPolicyFailure,
  explainCliClientPolicyFailure,
  explainCliGroupFailure,
  normalizeFailureMessage,
} from './failures.js'
export { catalogCoverage, createGroupReader, parsePricing, parseSelectedGroups, pickKeyForModel } from './groups.js'
export { createKeyChooser } from './key-chooser.js'
export { createModelSelectionController, readHiddenModels } from './model-selection.js'
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
