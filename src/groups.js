/**
 * Which PackyCode token groups each stored key belongs to, and which catalog
 * models those groups can serve.
 *
 * PackyCode routes a request by the token's groups: a key without a Claude
 * Code group (`cc`, `cc-sale`, …) is refused for Claude, a key without a Codex
 * group for GPT. None of that is visible from the key itself, so a key that
 * cannot serve the selected model looked exactly like a client or CLI fault.
 *
 * Three host-side reads answer it, none of them billed:
 * - the gateway refuses a model id it cannot route before contacting any
 *   upstream, and its refusal names the token's groups: a list for a token
 *   with several (`已选分组=[codex deepseek-officially kimi-sale]`), the one
 *   group for a single-group token (`分组 cc-sale 下模型 <id> 无可用渠道`);
 * - `/v1/models` lists the models the key can reach;
 * - the public `/api/pricing` lists each model's groups and each group's
 *   description.
 *
 * Every request is bounded by a timeout and refuses redirects. Nothing here
 * returns key material: the projection carries group names, their public
 * descriptions, and per-model booleans.
 *
 * @module dsh-packycode-api/groups
 */

import { createCachedRead } from './cached-read.js'
import { PACKYCODE_COVERED_MODEL_IDS } from './catalog.js'
import { DEFAULT_REQUEST_TIMEOUT_MS } from './constants.js'
import { statusHostOrder } from './hosts.js'
import { ambientFetch, boundedFetch } from './request.js'

/** A model id no gateway routes; its refusal is what names the groups. */
export const GROUP_PROBE_MODEL = 'dsh-packycode-group-probe'
/** Group membership changes rarely; a forced read bypasses this. */
export const DEFAULT_GROUP_TTL_MS = 10 * 60_000
/** A reading that could not reach a key is tried again this soon. */
export const FAILED_GROUP_RETRY_MS = 30_000

const SELECTED_GROUPS = /已选分组\s*[=＝:：]\s*\[([^\]]*)\]/u
/** A single-group token's refusal: `分组 cc-sale 下模型 <id> 无可用渠道（distributor）`. */
const NAMED_GROUP = /分组\s*[「“"']?([A-Za-z0-9._-]{1,64}(?:\s*[、,，/]\s*[A-Za-z0-9._-]{1,64})*)[」”"']?\s*下(?:对于)?模型/u
const GROUP_NAME = /^[A-Za-z0-9._-]{1,64}$/u
const INVALID_KEY = /无效的令牌|令牌无效|invalid[\s_-]+api[\s_-]*key|invalid_authentication/iu
const MAX_GROUPS = 32
const MAX_DESCRIPTION = 80
/** Keys read at once. */
const KEY_CONCURRENCY = 4

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Run `task` over `items`, at most `limit` at a time, keeping their order. */
async function mapLimited(items, limit, task) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await task(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** The gateway refused the key itself; it reaches no model at all. */
class RejectedKeyError extends Error {
  constructor() {
    super('the gateway rejected this key')
  }
}

/**
 * Read the token's groups out of the gateway's routing refusal.
 * @param message - the refusal text.
 * @returns the group names, or undefined when the text names none.
 */
export function parseSelectedGroups(message) {
  const text = typeof message === 'string' ? message : ''
  const match = SELECTED_GROUPS.exec(text) ?? NAMED_GROUP.exec(text)
  if (match === null) return undefined
  const names = [...new Set(match[1].split(/[\s,，、]+/u).filter(name => GROUP_NAME.test(name)))]
  return names.slice(0, MAX_GROUPS)
}

/**
 * Normalize `/api/pricing`: the groups each covered model is enabled in, and
 * each group's public description.
 * @param payload - the parsed pricing body.
 * @returns `{ modelGroups, descriptions }`, or undefined when unrecognized.
 */
export function parsePricing(payload) {
  if (!record(payload) || !Array.isArray(payload.data)) return undefined
  const modelGroups = {}
  for (const item of payload.data) {
    if (!record(item) || !PACKYCODE_COVERED_MODEL_IDS.includes(item.model_name) || !Array.isArray(item.enable_groups)) continue
    modelGroups[item.model_name] = [...new Set(item.enable_groups.filter(name => typeof name === 'string' && GROUP_NAME.test(name)))].sort()
  }
  const descriptions = {}
  if (record(payload.usable_group)) {
    for (const [name, description] of Object.entries(payload.usable_group)) {
      if (!GROUP_NAME.test(name) || typeof description !== 'string') continue
      const clean = description.replace(/\s+/gu, ' ').trim().slice(0, MAX_DESCRIPTION)
      if (clean !== '') descriptions[name] = clean
    }
  }
  return { modelGroups, descriptions }
}

/**
 * Which covered models a key can reach. Either source decides: a model the
 * key's groups are enabled for, or one its model list shows. A model is only
 * marked unreachable on evidence; with neither source it is left unknown.
 * @param options - the key's groups, its model ids, and pricing's model groups.
 * @returns covered model id → reachable, for the models with evidence.
 */
export function catalogCoverage({ groups, models, modelGroups }) {
  const coverage = {}
  for (const id of PACKYCODE_COVERED_MODEL_IDS) {
    const enabled = modelGroups?.[id]
    const byGroups = groups === undefined || enabled === undefined ? undefined : enabled.some(name => groups.includes(name))
    const byModels = models === undefined ? undefined : models.has(id)
    if (byGroups === true || byModels === true) coverage[id] = true
    else if (byGroups === false || byModels === false) coverage[id] = false
  }
  return coverage
}

async function bodyText(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function errorMessage(text) {
  try {
    const parsed = JSON.parse(text)
    const message = parsed?.error?.message ?? parsed?.message
    if (typeof message === 'string') return message
  } catch {
    // Not JSON.
  }
  return text
}

/**
 * Cached, single-flight group reader.
 * @param options - key listing, host resolution, and transport knobs.
 * @returns `{ read, snapshot, covers, requiredGroups, invalidate }`.
 */
export function createGroupReader({
  listKeys,
  getHosts,
  fetchImpl = ambientFetch,
  now = Date.now,
  ttlMs = DEFAULT_GROUP_TTL_MS,
  retryMs = FAILED_GROUP_RETRY_MS,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof listKeys !== 'function') throw new Error('PackyCode group reader requires listKeys')
  if (typeof getHosts !== 'function') throw new Error('PackyCode group reader requires getHosts')
  /** Last good reading per key id, kept when a later read of that key fails. */
  const lastGood = new Map()
  let lastPricing

  const request = (url, init, signal) => boundedFetch(url, init, { fetchImpl, timeoutMs, signal })

  const loadPricing = async (hosts, signal) => {
    const tried = []
    for (const host of statusHostOrder(hosts)) {
      try {
        const response = await request(`${host}/api/pricing`, { headers: { Accept: 'application/json' } }, signal)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const pricing = parsePricing(await response.json())
        if (pricing === undefined) throw new Error('unrecognized pricing payload')
        return pricing
      } catch (error) {
        signal?.throwIfAborted()
        tried.push(`${host}: ${error.message}`)
      }
    }
    throw new Error(tried.join('; '))
  }

  /** The token's groups, from the gateway's refusal of a model it cannot route. */
  const loadGroups = async (entry, hosts, signal) => {
    const response = await request(`${hosts.apiHost}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${entry.key}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROUP_PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: '.' }] }),
    }, signal)
    const message = errorMessage(await bodyText(response))
    if (response.status === 401 || INVALID_KEY.test(message)) throw new RejectedKeyError()
    return parseSelectedGroups(message)
  }

  /** The models the key can reach. */
  const loadModels = async (entry, hosts, signal) => {
    const response = await request(`${hosts.apiHost}/v1/models`, {
      headers: { Authorization: `Bearer ${entry.key}`, Accept: 'application/json' },
    }, signal)
    if (response.status === 401) throw new RejectedKeyError()
    if (!response.ok) return undefined
    const payload = await response.json()
    if (!Array.isArray(payload?.data)) return undefined
    return new Set(payload.data.map(item => item?.id).filter(id => typeof id === 'string'))
  }

  /**
   * One key's groups and model list. The two are independent evidence: one
   * failing in transit does not discard the other, and a rejection from
   * either means the gateway refuses the key itself.
   */
  const readKey = async (entry, hosts, signal) => {
    const results = await Promise.allSettled([loadGroups(entry, hosts, signal), loadModels(entry, hosts, signal)])
    if (results.some(result => result.status === 'rejected' && result.reason instanceof RejectedKeyError)) return { rejected: true }
    const [groups, models] = results.map(result => (result.status === 'fulfilled' ? result.value : undefined))
    if (groups === undefined && models === undefined) {
      throw results.find(result => result.status === 'rejected')?.reason ?? new Error('the gateway named no groups for this key')
    }
    return { groups, models }
  }

  /**
   * Pricing and every key are read concurrently (a few keys at a time), so a
   * slow or broken key does not hold up the reading for the others.
   */
  const load = async signal => {
    signal?.throwIfAborted()
    const hosts = getHosts()
    const keys = await listKeys()
    for (const id of lastGood.keys()) {
      if (!keys.some(entry => entry.id === id)) lastGood.delete(id)
    }
    const pricingTask = loadPricing(hosts, signal).then(
      pricing => {
        lastPricing = pricing
        return pricing
      },
      () => {
        signal?.throwIfAborted()
        return lastPricing
      },
    )
    const readings = await mapLimited(keys, KEY_CONCURRENCY, entry => readKey(entry, hosts, signal).then(value => ({ value }), error => ({ error })))
    const pricing = await pricingTask
    signal?.throwIfAborted()
    const entries = keys.map((entry, index) => {
      const { value, error } = readings[index]
      if (value?.rejected === true) {
        // Evidence, not a failed read: a rejected key reaches nothing.
        lastGood.delete(entry.id)
        return { id: entry.id, rejected: true, coverage: Object.fromEntries(PACKYCODE_COVERED_MODEL_IDS.map(id => [id, false])), error: new RejectedKeyError().message }
      }
      if (value !== undefined) {
        const reading = {
          id: entry.id,
          ...(value.groups === undefined ? {} : { groups: value.groups }),
          coverage: catalogCoverage({ groups: value.groups, models: value.models, modelGroups: pricing?.modelGroups }),
        }
        lastGood.set(entry.id, { value: reading, fetchedAt: now() })
        return reading
      }
      const message = error instanceof Error ? error.message : String(error)
      const previous = lastGood.get(entry.id)
      return previous === undefined
        ? { id: entry.id, coverage: {}, error: message }
        : { ...previous.value, stale: { fetchedAt: previous.fetchedAt, error: message } }
    })
    return {
      keys: entries,
      descriptions: pricing?.descriptions ?? {},
      requirements: pricing?.modelGroups ?? {},
      fetchedAt: now(),
    }
  }

  // A key the reading could not reach is read again soon, not after the full
  // TTL: until then its Claude requests cannot follow its groups.
  const unreached = value => value.keys.some(entry => entry.groups === undefined && entry.error !== undefined)
  const cache = createCachedRead(load, { ttlMs, now, ttlFor: value => (unreached(value) ? Math.min(ttlMs, retryMs) : ttlMs) })
  const keyEntry = keyId => cache.peek()?.keys.find(candidate => candidate.id === keyId)

  return Object.freeze({
    /**
     * Read every key's groups; cached for the TTL unless forced.
     * @returns the projection the settings panel shows.
     */
    read: options => cache.read(options),
    /** The last reading, however old, without touching the network. */
    snapshot: () => cache.snapshot(),
    /** Whether any reading exists yet. */
    hasReading: () => cache.peek() !== undefined,
    /**
     * Whether a key's groups reach a model, from the last reading.
     * @returns true, false, or undefined when there is no evidence.
     */
    covers(keyId, modelId) {
      const value = keyEntry(keyId)?.coverage?.[modelId]
      return typeof value === 'boolean' ? value : undefined
    },
    /** The groups pricing lists for a model, from the last reading. */
    requiredGroups(modelId) {
      const groups = cache.peek()?.requirements?.[modelId]
      return Array.isArray(groups) ? [...groups] : undefined
    },
    /** The groups the last reading found for a key. */
    groupsOf(keyId) {
      const groups = keyEntry(keyId)?.groups
      return Array.isArray(groups) ? [...groups] : undefined
    },
    /** Drop the reading so the next read goes to the network. */
    invalidate: () => cache.invalidate(),
  })
}

/**
 * Pick the key a request for `modelId` runs with.
 *
 * The active key serves every model it is not known to be excluded from.
 * When the last reading shows its groups cannot reach the model, the next
 * usable key in ring order that can — or, failing that, one with no evidence
 * either way — serves this request instead. The active pointer itself does
 * not move; with no better key the active one is returned, marked uncovered.
 * @param modelId - the catalog model of this request.
 * @param active - the ring's active key.
 * @param usable - the ring's usable keys, in ring order.
 * @param covers - `(keyId, modelId) => true | false | undefined`.
 * @returns the chosen key, with `switchedFrom` or `uncovered` when it is not
 *   simply the active key.
 */
export function pickKeyForModel(modelId, active, usable, covers) {
  if (active === undefined) return undefined
  if (typeof modelId !== 'string' || covers(active.id, modelId) !== false) return { ...active }
  const start = usable.findIndex(entry => entry.id === active.id)
  const others = start < 0 ? usable.filter(entry => entry.id !== active.id) : [...usable.slice(start + 1), ...usable.slice(0, start)]
  const pick = others.find(entry => covers(entry.id, modelId) === true) ?? others.find(entry => covers(entry.id, modelId) === undefined)
  if (pick === undefined) return { ...active, uncovered: true }
  return { id: pick.id, label: pick.label, key: pick.key, switchedFrom: { id: active.id, label: active.label } }
}
