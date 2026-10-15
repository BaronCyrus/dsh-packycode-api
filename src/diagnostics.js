/**
 * A support summary of one DSH session, for reports such as "已达到输出 token
 * 上限" or failing requests: which route, reasoning effort and output ceiling
 * each request used, how every model step ended and what it consumed, and
 * which retries and failures happened.
 *
 * The summary carries numbers and identifiers only. Message text, reasoning,
 * tool arguments and results, titles, paths and key material never enter it;
 * error messages are redacted and shortened. A user can paste it into a bug
 * report as it is.
 *
 * @module dsh-packycode-api/diagnostics
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { redactSecrets } from './secret-redactor.js'

export const DIAGNOSTICS_FORMAT = 'packycode-diagnostics/1'
const SESSION_LIST_LIMIT = 20
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const MESSAGE_CHARS = 160
/** How many of each record the summary keeps, newest last. */
export const DIAGNOSTICS_LIMITS = Object.freeze({ requests: 8, truncated: 12, steps: 20, turns: 10, retries: 10, attempts: 10 })

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
/** Identifier-like strings only (routes, models, efforts, reason kinds, codes). */
const word = value => (typeof value === 'string' && /^[\w.:/@[\]-]{1,80}$/u.test(value) ? value : undefined)
const iso = value => (finite(value) === undefined ? undefined : new Date(value).toISOString())
const last = (list, count) => list.slice(Math.max(0, list.length - count))
const compact = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))
const chunksOf = stream => (Array.isArray(stream) ? stream.map(item => item?.chunk).filter(chunk => chunk !== null && typeof chunk === 'object') : [])

/** A provider or harness error message, redacted and shortened. */
function safeMessage(text, secrets) {
  if (typeof text !== 'string' || text === '') return undefined
  const safe = redactSecrets(text, secrets)
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, 'sk-[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, 'Bearer [redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
  return safe.length > MESSAGE_CHARS ? `${safe.slice(0, MESSAGE_CHARS)}…` : safe
}

function failureOf(reason, secrets) {
  const failure = reason?.failure ?? reason?.error
  return failure === undefined ? {} : { code: word(failure.code), message: safeMessage(failure.message, secrets) }
}

/**
 * Summarize one session's events.
 * @param events - the session's events in log order.
 * @param options - values to redact from error messages.
 * @returns the numbers-only summary body.
 */
export function summarizeSessionEvents(events, { secrets = [] } = {}) {
  const requests = []
  const steps = []
  const turnEnds = []
  const retries = []
  const attempts = []
  let turns = 0
  let compactions = 0
  for (const event of events ?? []) {
    const type = event?.type
    const data = event?.data ?? {}
    if (typeof type !== 'string') continue
    if (/compact/u.test(type)) compactions += 1
    if (type === 'turn/start') turns += 1
    else if (type === 'request/header') {
      const config = data.header?.config ?? {}
      requests.push(compact({
        time: iso(event.time),
        reason: word(data.reason),
        provider: word(config.provider),
        model: word(config.model),
        reasoningEffort: word(config.reasoningEffort),
        maxTokens: finite(config.maxTokens),
        maxTokensFromAdapter: data.header?.adapterDefaults?.maxTokens === true ? true : undefined,
      }))
    } else if (type === 'assistant/message') {
      const chunks = chunksOf(data.stream)
      const usage = data.usage ?? chunks.find(chunk => chunk.type === 'usage')?.usage ?? {}
      const input = finite(usage.inputTokens)
      const cacheRead = finite(usage.cacheReadTokens)
      steps.push(compact({
        turn: finite(data.turn),
        step: finite(data.step),
        time: iso(event.time),
        finish: word(chunks.find(chunk => chunk.type === 'finish')?.reason?.kind) ?? 'none',
        input,
        cacheRead,
        cacheWrite: finite(usage.cacheWriteTokens),
        output: finite(usage.outputTokens),
        context: input === undefined && cacheRead === undefined ? undefined : (input ?? 0) + (cacheRead ?? 0),
      }))
    } else if (type === 'assistant/attempt') {
      const reason = chunksOf(data.stream).find(chunk => chunk.type === 'finish')?.reason
      attempts.push(compact({ turn: finite(data.turn), step: finite(data.step), time: iso(event.time), finish: word(reason?.kind), ...failureOf(reason, secrets) }))
    } else if (type === 'llm/retry') {
      retries.push(compact({
        turn: finite(data.turn),
        step: finite(data.step),
        time: iso(event.time),
        provider: word(data.provider),
        retry: finite(data.retry),
        maxRetries: finite(data.maxRetries),
        ...failureOf({ failure: data.failure }, secrets),
      }))
    } else if (type === 'turn/end') {
      turnEnds.push(compact({ turn: finite(data.turn), time: iso(event.time), kind: word(data.reason?.kind), ...failureOf(data.reason, secrets) }))
    }
  }
  const truncated = steps.filter(step => step.finish === 'max-tokens')
  return {
    totals: { turns, steps: steps.length, maxTokenSteps: truncated.length, retries: retries.length, failedAttempts: attempts.length, compactionEvents: compactions },
    requestSettings: last(requests, DIAGNOSTICS_LIMITS.requests),
    maxTokenSteps: last(truncated, DIAGNOSTICS_LIMITS.truncated),
    recentSteps: last(steps, DIAGNOSTICS_LIMITS.steps),
    turnEnds: last(turnEnds, DIAGNOSTICS_LIMITS.turns),
    retries: last(retries, DIAGNOSTICS_LIMITS.retries),
    failedAttempts: last(attempts, DIAGNOSTICS_LIMITS.attempts),
  }
}

/**
 * The diagnostics service behind the settings card.
 * @param options - DSH's session query service (read lazily), the session
 *   event reader the image originals already use, the key ring and group
 *   reader, the stored secrets to redact, and this package's manifest URL.
 */
export function createDiagnostics({ sessionQuery, readEvents, ring, groups, secrets = async () => [], ownPackageJsonUrl }) {
  const query = () => {
    const service = sessionQuery?.()
    if (typeof service?.listSessions !== 'function') throw new Error('PackyCode diagnostics need DSH session history, which this runtime does not provide')
    return service
  }

  const version = async () => {
    try {
      return word(JSON.parse(await readFile(fileURLToPath(ownPackageJsonUrl), 'utf8')).version)
    } catch {
      return undefined
    }
  }

  /** Stored conversation keys by position: state and groups, never labels or keys. */
  const keys = async () => {
    const listed = (await ring.list()).keys ?? []
    let reading
    try {
      reading = await groups?.read({ force: false })
    } catch {
      reading = undefined
    }
    return listed.map((entry, index) => {
      const group = reading?.keys?.find(item => item.id === entry.id)
      return compact({
        key: index + 1,
        active: entry.active === true,
        disabled: entry.disabled === true ? true : undefined,
        groups: Array.isArray(group?.groups) ? group.groups.map(word).filter(Boolean) : undefined,
        reaches: group?.coverage === undefined ? undefined : Object.keys(group.coverage).filter(model => group.coverage[model] === true),
      })
    })
  }

  return Object.freeze({
    /** Recent top-level sessions, newest first, for the picker. */
    async list(signal) {
      const records = await query().listSessions(signal)
      const sessions = records
        .filter(record => typeof record?.header?.id === 'string' && !(record.header.delegationDepth > 0))
        .slice(0, SESSION_LIST_LIMIT)
        .map(record => compact({
          id: record.header.id,
          createdAt: iso(record.header.createdAt),
          live: record.live === true,
          folder: typeof record.header.cwd === 'string' && record.header.cwd !== '' ? basename(record.header.cwd) : undefined,
        }))
      return { sessions }
    },

    /** The numbers-only summary of one session. */
    async read(payload, signal) {
      const sessionId = payload?.sessionId
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('PackyCode diagnostics need a session to read')
      query()
      let events
      try {
        events = await readEvents(sessionId, signal)
      } catch {
        throw new Error('PackyCode could not read that session')
      }
      const record = (await query().listSessions(signal)).find(item => item?.header?.id === sessionId)
      return {
        format: DIAGNOSTICS_FORMAT,
        generatedAt: new Date().toISOString(),
        plugin: compact({ version: await version() }),
        session: compact({
          id: sessionId,
          createdAt: iso(record?.header?.createdAt),
          live: record === undefined ? undefined : record.live === true,
          delegationDepth: finite(record?.header?.delegationDepth),
        }),
        keys: await keys(),
        ...summarizeSessionEvents(events, { secrets: await secrets() }),
      }
    },
  })
}
