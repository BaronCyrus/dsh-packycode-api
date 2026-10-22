/**
 * Auto review wiring: which model DSH's official 自动审查 reviews with, the
 * `llm/stream` listener that sends its requests there, and the projection the
 * settings panel reads.
 *
 * DSH's experimental "自动授权审查" plugin (Loader row `auto-review`) owns the
 * permission menu entry, the review and what it decides. Its one model
 * request per tool call passes through DSH's `llm/stream` waterfall like
 * every model call; the listener recognizes it and answers it with the
 * reviewer chosen under Settings → PackyCode:
 * - `jev-latest`: over System One, written back as the official answer;
 * - `deepseek-flash`: the same request, addressed to the PackyCode route;
 * - `session`: untouched, as without this plugin.
 * Every other request, conversation turns included, goes on unchanged. A
 * review that fails ends its stream with an error, which the official
 * reviewer turns into a refused call — exactly as with its own model.
 *
 * @module dsh-packycode-api/auto-review-controller
 */

import {
  answerChunks,
  AUTO_REVIEW_FLASH,
  AUTO_REVIEW_MODEL_NAMES,
  AUTO_REVIEW_MODELS,
  AUTO_REVIEW_SESSION,
  DEFAULT_AUTO_REVIEW_MODEL,
  failureChunk,
  isOfficialReviewRequest,
  officialAnswer,
  readReviewSections,
} from './auto-review.js'
import { PROVIDER } from './constants.js'
import { fieldValue } from './preferences.js'

/** The Loader row of DSH's experimental auto review. */
export const DSH_AUTO_REVIEW_ROW = 'auto-review'
/** DSH's id of the 自动审查 permission preset. */
export const AUTO_PRESET = 'auto'

/** Normalize a stored preference; anything unknown reads as the default. */
export function readAutoReviewChoice(value) {
  const model = fieldValue(value?.autoReviewModel)
  return { model: AUTO_REVIEW_MODELS.includes(model) ? model : DEFAULT_AUTO_REVIEW_MODEL }
}

const errorText = error => (error instanceof Error ? error.message : String(error)).slice(0, 300)

/** The decision a reviewer's streamed text carried, when it is the official JSON object. */
function streamedDecision(answer) {
  try {
    const value = JSON.parse(answer.trim())
    return value?.decision === 'allow' || value?.decision === 'deny' ? value : undefined
  } catch {
    return undefined
  }
}

/** The pending tool's name, for the counts; undefined when the message is unreadable. */
function toolOf(options) {
  try {
    return readReviewSections(options).pendingAction.name
  } catch {
    return undefined
  }
}

/**
 * @param options - the Jev reviewer, a function that streams one request
 *   through DSH's LLM service, the preference reader and writer, the Loader
 *   row lookup, the live preset names, a logger, and a clock.
 */
export function createAutoReviewController({
  jev,
  stream,
  readPreference,
  writePreference,
  isWritable = () => typeof writePreference === 'function',
  loaderEntry = () => undefined,
  presetNames = () => [],
  logger,
  now = Date.now,
}) {
  /** Requests this listener re-addressed; they pass through on their second trip. */
  const rerouted = new WeakSet()
  const counts = { reviewed: 0, allowed: 0, denied: 0, failed: 0 }
  let last

  const preference = () => readAutoReviewChoice(readPreference?.())

  /** Count one review and log it: one line per review, no arguments. */
  const settle = (outcome, details) => {
    counts.reviewed += 1
    counts[outcome] += 1
    last = { at: now(), outcome, ...details }
    const log = outcome === 'failed' ? logger?.warn : logger?.info
    log?.call(
      logger,
      'packycode-api: auto review %s %s (%s%s%s, %d ms)',
      outcome,
      details.tool ?? 'a tool call',
      details.version ?? AUTO_REVIEW_MODEL_NAMES[details.model] ?? details.model,
      details.risk === undefined ? '' : `, ${details.risk} risk`,
      details.error === undefined ? '' : `: ${details.error}`,
      details.ms,
    )
  }

  /** Answer one official review with Jev. */
  async function* jevAnswer(options) {
    const started = now()
    const signal = options.signal
    let tool
    try {
      const sections = readReviewSections(options)
      tool = sections.pendingAction.name
      const decision = await jev.review(options.system, sections, signal)
      settle(decision.decision === 'allow' ? 'allowed' : 'denied', {
        model: 'jev-latest', tool, ms: now() - started, risk: decision.risk,
        ...(decision.version === undefined ? {} : { version: decision.version }),
      })
      yield* answerChunks(officialAnswer(decision), decision.usage)
    } catch (error) {
      if (signal?.aborted === true) {
        yield failureChunk('PackyCode auto review was cancelled', { aborted: true })
        return
      }
      const message = errorText(error)
      settle('failed', { model: 'jev-latest', tool, ms: now() - started, error: message })
      yield failureChunk(message)
    }
  }

  /** Pass a re-addressed review through unchanged, counting what it decided. */
  async function* counted(source, model, tool) {
    const started = now()
    let answer = ''
    let settled = false
    for await (const chunk of source) {
      if (chunk?.type === 'text-delta') answer += chunk.text
      if (chunk?.type === 'finish' && !settled) {
        settled = true
        const kind = chunk.reason?.kind
        if (kind === 'error') settle('failed', { model, tool, ms: now() - started, error: errorText(chunk.reason.failure?.message ?? 'no detail') })
        else if (kind !== 'aborted') {
          const decision = streamedDecision(answer)
          if (decision === undefined) settle('failed', { model, tool, ms: now() - started, error: 'the answer was not the official JSON object' })
          else settle(decision.decision === 'allow' ? 'allowed' : 'denied', { model, tool, ms: now() - started, risk: decision.risk })
        }
      }
      yield chunk
    }
  }

  /**
   * The `llm/stream` waterfall listener.
   * @param options - one model request.
   * @param next - the rest of the waterfall.
   * @returns the request's chunk stream.
   */
  const listener = (options, next) => {
    if (rerouted.has(options) || !isOfficialReviewRequest(options)) return next()
    const { model } = preference()
    if (model === AUTO_REVIEW_SESSION) return next()
    if (model === AUTO_REVIEW_FLASH) {
      // The official request as it is, on the PackyCode route; its second
      // trip through the waterfall reaches the adapter.
      const routed = { ...options, provider: PROVIDER, model: AUTO_REVIEW_FLASH }
      rerouted.add(routed)
      return counted(stream(routed), model, toolOf(options))
    }
    return jevAnswer(options)
  }

  /** The projection the settings panel reads; no key material. */
  const status = () => {
    const { model } = preference()
    const entry = loaderEntry(DSH_AUTO_REVIEW_ROW)
    let offered = false
    try {
      offered = (presetNames() ?? []).includes(AUTO_PRESET)
    } catch {
      offered = false
    }
    return {
      model,
      models: AUTO_REVIEW_MODELS.map(id => ({ id, name: AUTO_REVIEW_MODEL_NAMES[id] ?? id })),
      writable: isWritable() === true,
      official: {
        enabled: entry !== undefined && entry.disabled !== true && entry.options?.disabled !== true,
        offered,
      },
      counts: { ...counts },
      ...(last === undefined ? {} : { last: { ...last } }),
    }
  }

  return Object.freeze({
    listener,
    status,
    /** Validate and persist a reviewer choice; it applies to the next review. */
    async update(patch) {
      if (patch?.autoReviewModel === undefined) return status()
      if (!AUTO_REVIEW_MODELS.includes(patch.autoReviewModel)) throw new Error('That PackyCode auto review model is not supported')
      if (isWritable() !== true || typeof writePreference !== 'function') {
        throw new Error('PackyCode settings are not writable in this profile')
      }
      try {
        await writePreference({ autoReviewModel: patch.autoReviewModel })
      } catch (error) {
        logger?.warn?.('packycode-api: could not save the auto review preference: %s', errorText(error))
        throw new Error('PackyCode could not save the auto review preference', { cause: error })
      }
      return status()
    },
  })
}
