/**
 * Auto review wiring: the permission menu's "自动审查" option, the gate that
 * reviews each tool call of a session that selected it, the user's reviewer
 * preference, and the projection the settings panel reads.
 *
 * DSH ships the option itself: `permissionPresets.registerAuto()` publishes
 * the `auto` preset (full sandbox, `ask` approval policy) that the composer's
 * permission menu and `/permission` list as 自动审查. Whoever registers it
 * reviews the calls; DSH's own experimental integration uses the session's
 * model, this one uses the reviewer chosen under Settings → PackyCode. Only
 * one integration can hold the preset, so this one steps aside when DSH's is
 * switched on.
 *
 * A call the reviewer allows runs as DSH would run it under full access. A
 * call it denies, or cannot review, is put to the human through DSH's
 * approval prompt; in a delegated child, whose policy is `never`, a denial is
 * final. Nothing is executed on a failed review.
 *
 * @module dsh-packycode-api/auto-review-controller
 */

import {
  AUTO_REVIEW_MODEL_NAMES,
  AUTO_REVIEW_MODELS,
  DEFAULT_AUTO_REVIEW_MODEL,
  reviewLimits,
  snapshotFromSession,
} from './auto-review.js'
import { fieldValue } from './preferences.js'

/** DSH's fixed id of the current-session review preset. */
export const AUTO_PRESET = 'auto'
/** The Loader row of DSH's own experimental integration. */
export const DSH_AUTO_REVIEW_ROW = 'auto-review'
/** dsh-tools' PTC transport; its inner calls are reviewed one by one instead. */
const RUN_CODE_NAME = 'run_code'
/** Where a session in auto review goes when the option is withdrawn, in order of preference. */
const FALLBACK_PRESETS = Object.freeze(['workspace-write', 'read-only'])
/** Structured error the tool card renders as "Auto review 已拒绝". */
const DENIED_ERROR = Object.freeze({ name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED' })

/** Normalize a stored preference; anything unknown reads as the default. */
export function readAutoReviewChoice(value) {
  const enabled = fieldValue(value?.autoReview)
  const model = fieldValue(value?.autoReviewModel)
  return {
    enabled: enabled !== false,
    model: AUTO_REVIEW_MODELS.includes(model) ? model : DEFAULT_AUTO_REVIEW_MODEL,
  }
}

/** A reviewer's denial in both languages; Jev names no reason, so its risk class speaks. */
function denialReason(decision) {
  if (typeof decision.reason === 'string' && decision.reason !== '') return { en: decision.reason, zh: decision.reason }
  if (decision.risk === 'high') {
    return {
      en: 'a high-risk action (such as sending credentials out or destroying data) always needs your decision',
      zh: '高风险操作（如外发凭据、破坏数据），始终需要你亲自决定',
    }
  }
  return {
    en: 'a medium-risk action that you have not explicitly asked for',
    zh: '中风险操作，且没有找到你对此操作的明确指示',
  }
}

const errorText = error => (error instanceof Error ? error.message : String(error)).slice(0, 300)

/**
 * @param options - the reviewer, the preference reader and writer, the Loader
 *   row lookup, a logger, and a clock.
 */
export function createAutoReviewController({
  reviewer,
  readPreference,
  writePreference,
  isWritable = () => typeof writePreference === 'function',
  loaderEntry = () => undefined,
  logger,
  now = Date.now,
}) {
  /** The host services, while a scope that has all of them is mounted. */
  let host
  /** Whether a scope with every service is mounted. */
  let mounted = false
  /** The async disposer of our `auto` registration, while we hold it. */
  let registration
  /** Why the option is not offered, when it is not. */
  let blocked
  /** Admission closes before the registration is withdrawn. */
  let accepting = false
  let lifecycle = new AbortController()
  const active = new Set()
  const counts = { reviewed: 0, allowed: 0, asked: 0, denied: 0, failed: 0 }
  let last
  let chain = Promise.resolve()

  const preference = () => readAutoReviewChoice(readPreference?.())

  const presetOf = session => {
    try {
      return host?.presets.current(session)
    } catch {
      return undefined
    }
  }

  /**
   * The preset a session last selected, from DSH's permission projection. It
   * still reads `auto` after the preset itself was withdrawn, which is when
   * `current()` no longer can.
   */
  const storedPreset = session => {
    try {
      return host?.projections?.()?.stateOf?.(session, 'permissions')?.preset ?? undefined
    } catch {
      return undefined
    }
  }

  /** Whether DSH's own integration is switched on in this profile. */
  const dshIntegrationActive = () => {
    const entry = loaderEntry(DSH_AUTO_REVIEW_ROW)
    return entry !== undefined && entry.disabled !== true && entry.options?.disabled !== true
  }

  const presetNames = () => {
    try {
      const names = host?.presets.names
      if (Array.isArray(names)) return names
      return host?.presets.catalog?.().options?.map(option => option.value) ?? []
    } catch {
      return []
    }
  }

  /** Move every live session out of auto review, to the safest preset this profile offers. */
  const migrateSessions = () => {
    if (host === undefined) return
    const names = presetNames()
    const fallback = FALLBACK_PRESETS.find(name => names.includes(name))
    let sessions = []
    try {
      sessions = [...(host.sessions?.list?.() ?? [])]
    } catch {
      sessions = []
    }
    for (const session of sessions) {
      if (presetOf(session) !== AUTO_PRESET && storedPreset(session) !== AUTO_PRESET) continue
      if (fallback === undefined) {
        logger?.warn?.('packycode-api: session %s stays in auto review; this profile offers no safer preset', session.id)
        continue
      }
      try {
        host.presets.set(session, fallback)
      } catch (error) {
        logger?.warn?.('packycode-api: could not move session %s out of auto review: %s', session.id, errorText(error))
      }
    }
  }

  /**
   * Offer the option. The registration lives in its own effect whose disposer
   * moves the sessions out of auto review *before* the preset disappears, so
   * a plugin unload, which disposes every effect at once, leaves no session
   * running unreviewed with full access.
   */
  const register = () => {
    if (!mounted || host === undefined || registration !== undefined) return
    if (dshIntegrationActive()) {
      blocked = 'dsh-integration'
      return
    }
    if (presetNames().includes(AUTO_PRESET)) {
      blocked = 'occupied'
      return
    }
    const { presets, scope } = host
    const reviews = new AbortController()
    try {
      registration = scope.effect(() => {
        lifecycle = reviews
        accepting = true
        const withdraw = presets.registerAuto(() => {
          if (!accepting) throw new Error('PackyCode auto review is being withdrawn')
        })
        return async () => {
          accepting = false
          try {
            migrateSessions()
          } finally {
            reviews.abort(new Error('PackyCode auto review withdrawn'))
            await Promise.allSettled([...active])
            await withdraw?.()
          }
        }
      }, 'packycode-api: auto review option')
      blocked = undefined
    } catch (error) {
      accepting = false
      registration = undefined
      blocked = 'occupied'
      logger?.warn?.('packycode-api: could not offer auto review: %s', errorText(error))
    }
  }

  const unregister = async () => {
    const dispose = registration
    registration = undefined
    await dispose?.()
  }

  /** Offer or withdraw the option as the preference says; serialized. */
  const reconcile = () => {
    const run = async () => {
      if (!mounted || host === undefined) return
      if (preference().enabled) {
        register()
      } else {
        blocked = undefined
        await unregister()
      }
    }
    const next = chain.then(run)
    chain = next.then(() => undefined, error => logger?.warn?.('packycode-api: auto review reconcile failed: %s', errorText(error)))
    return next
  }

  /** Count one review and log it: one line per reviewed call, no arguments. */
  const settle = (kind, details) => {
    counts.reviewed += 1
    counts[kind] += 1
    last = { at: now(), outcome: kind, ...details }
    const log = kind === 'failed' ? logger?.warn : logger?.info
    log?.call(
      logger,
      'packycode-api: auto review %s %s (%s%s%s, %d ms)',
      kind,
      details.tool,
      details.version ?? details.model,
      details.risk === undefined ? '' : `, ${details.risk} risk`,
      details.error === undefined ? '' : `: ${details.error}`,
      details.ms,
    )
  }

  /** Review one pending call; see the module comment for the outcomes. */
  const gate = async (exec, next) => {
    const agent = exec?.agent
    if (registration === undefined || agent === undefined) return next()
    if (exec.parent === undefined && exec.name === RUN_CODE_NAME) return next()
    if (presetOf(agent.session) !== AUTO_PRESET) return next()
    if (!accepting) return { kind: 'cancel' }
    // A later listener that denies, cancels or asks decides without a review.
    const downstream = await next()
    if (downstream?.kind !== 'allow') return downstream
    if (exec.signal?.aborted === true || lifecycle.signal.aborted) return { kind: 'cancel' }

    const model = preference().model
    const name = AUTO_REVIEW_MODEL_NAMES[model] ?? model
    const final = host?.approval?.overrideOf?.(agent.session) === 'never'
    const started = now()
    const done = Promise.withResolvers()
    active.add(done.promise)
    try {
      let cwd
      try {
        cwd = host?.workingDirectory?.()?.get?.(agent.session)
      } catch {
        cwd = undefined
      }
      const signal = AbortSignal.any([exec.signal, lifecycle.signal].filter(Boolean))
      let decision
      try {
        decision = await reviewer.review(model, snapshotFromSession(agent.session, exec, cwd, reviewLimits(model)), signal)
      } catch (error) {
        if (signal.aborted) return { kind: 'cancel' }
        const message = errorText(error)
        settle('failed', { model, tool: exec.name, ms: now() - started, error: message })
        if (final) return { kind: 'deny', reason: `PackyCode auto review of tool "${exec.name}" failed; its body was not executed: ${message}` }
        return {
          kind: 'ask',
          reason: `PackyCode auto review (${name}) could not review tool "${exec.name}": ${message}`,
          displayReason: {
            en: `PackyCode auto review (${name}) could not review this call: ${message}`,
            zh: `PackyCode 自动审查（${name}）未能完成审查：${message}`,
          },
        }
      }
      if (lifecycle.signal.aborted) return { kind: 'cancel' }
      const details = {
        model,
        tool: exec.name,
        ms: now() - started,
        risk: decision.risk,
        ...(typeof decision.version === 'string' ? { version: decision.version } : {}),
      }
      if (decision.decision === 'allow') {
        settle('allowed', details)
        return downstream
      }
      const reason = denialReason(decision)
      if (final) {
        settle('denied', details)
        return {
          kind: 'deny',
          reason: `PackyCode auto review (${name}) rejected tool "${exec.name}"; its body was not executed`,
          info: { ...DENIED_ERROR, reason: `${name}: ${reason.zh}` },
        }
      }
      settle('asked', details)
      return {
        kind: 'ask',
        reason: `PackyCode auto review (${name}) denied tool "${exec.name}": ${reason.en}`,
        displayReason: {
          en: `PackyCode auto review (${name}) denied this call: ${reason.en}`,
          zh: `PackyCode 自动审查（${name}）拒绝了此调用：${reason.zh}`,
        },
      }
    } finally {
      active.delete(done.promise)
      done.resolve()
    }
  }

  /** The projection the settings panel reads; no key material. */
  const status = () => {
    const { enabled, model } = preference()
    return {
      enabled,
      model,
      models: AUTO_REVIEW_MODELS.map(id => ({ id, name: AUTO_REVIEW_MODEL_NAMES[id] ?? id })),
      writable: isWritable() === true,
      available: host !== undefined,
      offered: registration !== undefined,
      ...(blocked === undefined ? {} : { blocked }),
      counts: { ...counts },
      ...(last === undefined ? {} : { last: { ...last } }),
    }
  }

  return Object.freeze({
    /**
     * Attach to a scope that holds the permission, approval, session and tool
     * services. The gate is installed for the scope's lifetime; the option
     * follows the preference.
     * @param scope - the inject scope.
     */
    mount(scope) {
      const presets = scope.permissionPresets
      if (typeof presets?.registerAuto !== 'function' || typeof presets.current !== 'function' || typeof presets.set !== 'function') {
        blocked = 'unsupported'
        return
      }
      scope.effect(function* () {
        host = {
          scope,
          presets,
          approval: scope.approval,
          sessions: scope.sessions,
          workingDirectory: () => scope.get?.('workingDirectory'),
          projections: () => scope.get?.('sessionProjections'),
        }
        mounted = true
        // Disposed in reverse: the option is withdrawn while the gate still reviews.
        yield scope.on('tools/pre-execute', gate, { prepend: true })
        // Another integration released the preset, or ours appeared.
        yield scope.on('permission-presets/catalog-changed', () => {
          void reconcile()
        })
        yield async () => {
          mounted = false
          await chain
          await unregister()
          host = undefined
          if (blocked !== 'unsupported') blocked = undefined
        }
        void reconcile()
      }, 'packycode-api: auto review')
    },
    reconcile,
    status,
    /** Validate, persist, and apply a preference change. */
    async update(patch) {
      const next = {}
      if (patch?.autoReview !== undefined) {
        if (typeof patch.autoReview !== 'boolean') throw new Error('That PackyCode auto review setting is not supported')
        next.autoReview = patch.autoReview
      }
      if (patch?.autoReviewModel !== undefined) {
        if (!AUTO_REVIEW_MODELS.includes(patch.autoReviewModel)) throw new Error('That PackyCode auto review model is not supported')
        next.autoReviewModel = patch.autoReviewModel
      }
      if (Object.keys(next).length === 0) return status()
      if (isWritable() !== true || typeof writePreference !== 'function') {
        throw new Error('PackyCode settings are not writable in this profile')
      }
      try {
        await writePreference(next)
      } catch (error) {
        logger?.warn?.('packycode-api: could not save the auto review preference: %s', errorText(error))
        throw new Error('PackyCode could not save the auto review preference', { cause: error })
      }
      await reconcile()
      return status()
    },
    /** The gate itself, for tests and diagnostics. */
    gate,
  })
}
