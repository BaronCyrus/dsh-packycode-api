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
import { isAbsolute, join } from 'node:path'

import { LlmError, QUOTA_EXCEEDED_CODE, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

import { createBalanceReader } from './balance.js'
import { createClaudeCliAdapter } from './claude-adapter.js'
import {
  CLAUDE_CLI_MODES,
  DEFAULT_CLAUDE_MODE,
  createClaudeRunner,
} from './claude-cli.js'
import { createClaudeCliManager } from './claude-install.js'
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
import { AUTO_CLAUDE_MODE, capClaudeMode, claudeModeForSession } from './permission.js'
import { createPackyCodePluginManager } from './plugin-version.js'
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

/** What a `claude_code` tool run is told about where its task came from. */
const CLAUDE_TOOL_INSTRUCTIONS = 'This task was delegated to Claude Code by another agent in DeepSeek Harness through its claude_code tool. The task text is self-contained; complete it with your own tools and reply with the final result only.'

/** Host overrides; a profile that never installs this section keeps the defaults. */
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

  /**
   * The Claude Code CLI runner. PackyCode's `cc` group serves its Claude
   * models only to the official CLI, so CLI-backed models below are run by
   * that CLI itself — with this plugin's endpoint and key, in an isolated
   * config home.
   */
  const claudeCli = createClaudeCliManager({ explicitPath: () => config?.claudeCliPath })
  const claudeRunner = createClaudeRunner({
    binary: () => claudeCli.binary(),
    resolveCredential: async () => {
      const active = await ring.activeKey()
      if (active === undefined) {
        throw new Error('Claude Code CLI needs a usable PackyCode API key; add one under Settings → PackyCode')
      }
      return { baseUrl: hosts().apiHost, token: active.key }
    },
  })

  /** The session of the agent this turn runs for, when one is in scope. */
  const currentSession = () => {
    try {
      return ctx.get?.('agents')?.currentInitiator?.()?.session
    } catch {
      return undefined
    }
  }

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
  const configuredCliMode = () => {
    const configured = config?.claudeCliMode
    return configured === undefined || configured === AUTO_CLAUDE_MODE ? undefined : configured
  }
  const cliModeCeiling = session => configuredCliMode() ?? claudeModeForSession(ctx, session)
  const resolveCliMode = () => cliModeCeiling(currentSession()) ?? DEFAULT_CLAUDE_MODE

  const innerAdapter = new PiAiAdapter({
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

  /**
   * Dispatch per model: CLI-backed ids run the Claude Code CLI, everything
   * else keeps the pi-ai path.
   */
  const adapter = createClaudeCliAdapter({
    inner: innerAdapter,
    runner: claudeRunner,
    resolveMode: resolveCliMode,
    resolveCwd: resolveCliCwd,
    // Images in a CLI-backed turn are read from the same store the HTTP
    // route reads them from, and sent to the CLI as image blocks.
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

  const handler = createPackyCodeRpc({
    ring,
    balance,
    hosts,
    preference,
    claudeCli,
    pluginManager: createPackyCodePluginManager(),
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
    ctx.effect(
      () => connectionCtx.connection.rpc.handle(CHANNEL, handler),
      'packycode-api: loopback account RPC',
    )
  })

  /**
   * The explicit delegation tool, for asking Claude Code for something while
   * another model drives the session. It shares the runner the CLI-backed
   * models use.
   */
  ctx.inject(['tools'], toolsCtx => {
    ctx.effect(() => toolsCtx.tools.register(defineTool({
      name: 'claude_code',
      description: 'Delegate a task to the local Claude Code CLI (the official `claude` binary), which runs it with its own tools and returns its final answer. Use it when the user asks for Claude or when a task suits Claude Code. The child runs with this plugin\'s PackyCode endpoint and API key, in an isolated config home. `mode` bounds what it may do on its own: "read-only" (Read/Grep/Glob), "edit" (also Edit/Write), "full" (bypasses the CLI\'s permission checks, including shell commands); it defaults to, and is capped at, what this session\'s permission preset allows. It starts a fresh CLI session per call, takes tens of seconds, and bills through the same PackyCode key. Its internal tool calls are not part of this session\'s transcript — only the returned answer is.',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'The task for Claude Code, written as a self-contained instruction (it does not see this conversation).',
        },
        mode: {
          type: 'string',
          enum: Object.keys(CLAUDE_CLI_MODES),
          description: 'What the CLI may do on its own. Defaults to the most this session\'s permission preset allows; a wider mode is capped to it. Ask for "full" only when the task genuinely needs shell commands.',
        },
        model: {
          type: 'string',
          description: 'Model id passed to the CLI (for example "claude-opus-5-5", "claude-sonnet-5-5", or "claude-haiku-5-5"). Omit to use the CLI\'s own default.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the CLI. Defaults to this session\'s workspace; a relative path resolves against it.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            result: { type: 'string', required: true },
            model: { type: 'string', required: true },
            mode: { type: 'string', required: true },
            costUsd: { type: 'number', required: true },
            durationMs: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `${value.result}\n\n— Claude Code CLI · ${value.model || 'default model'} · ${value.mode} · ${Math.round(value.durationMs / 1000)}s · $${value.costUsd.toFixed(4)}`,
        }],
      },
      async execute(args, exec) {
        const sessionCwd = exec?.agent?.session?.header?.cwd
        const requested = typeof args.cwd === 'string' ? args.cwd.trim() : ''
        const cwd = requested === ''
          ? sessionCwd
          : isAbsolute(requested) ? requested : (sessionCwd === undefined ? requested : join(sessionCwd, requested))
        return await claudeRunner.run({
          prompt: args.prompt,
          mode: capClaudeMode(args.mode, cliModeCeiling(exec?.agent?.session)) ?? DEFAULT_CLAUDE_MODE,
          model: args.model,
          appendSystemPrompt: CLAUDE_TOOL_INSTRUCTIONS,
          cwd,
          signal: exec?.signal,
        })
      },
    })), 'packycode-api: claude_code tool')
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
  renderAuxiliaryPrompt,
  renderDelegatedPrompt,
  TITLE_MODEL_ID,
  TITLE_MODEL_ROUTES,
} from './claude-adapter.js'
export { AUTO_CLAUDE_MODE, capClaudeMode, claudeModeFor, claudeModeForSession } from './permission.js'
export { accountHostOrder, createBalanceReader, parseBillingSubscription, parseBillingUsage, parseTokenUsage, statusHostOrder } from './balance.js'
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
  normalizeFailureMessage,
} from './failures.js'
export { assertApiKey, PackyCodeKeyRing } from './key-ring.js'
export { createPackyCodeProvider, guardKeyRotation } from './provider.js'
export { createPackyCodeRpc, normalizeHost } from './rpc.js'
