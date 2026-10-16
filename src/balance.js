/**
 * Per-key balance.
 *
 * PackyCode is a new-api style relay, and an API key can read only its own
 * figures: `/api/usage/token/` reports the quota of the key that authorized
 * the request. The `/v1/dashboard/billing/*` family is per key on this gateway
 * as well — `hard_limit_usd` is the key's own grant, `total_usage` its own
 * spend in cents, and an unlimited key reports the placeholder limit
 * 100000000 — so it adds nothing and is not requested. The account's own
 * balance sits behind the dashboard API, which takes a login session rather
 * than a key. `cf.api.fan` answers 404 for the whole `/api/*` family, so a read
 * tries the status host first and falls back through the other PackyCode
 * hosts — the same fallback the PackyCode status tooling uses. A saved legacy
 * status host (`www.packyapi.com`, DNS-poisoned on mainland networks) is tried
 * after the current default, not before it.
 *
 * Credentials and response bodies stay host-side; the browser receives only
 * the projection built here.
 *
 * @module dsh-packycode-api/balance
 */

import { createCachedRead } from './cached-read.js'
import {
  DEFAULT_BALANCE_TTL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  QUOTA_PER_USD,
  UNLIMITED_QUOTA_SENTINEL,
} from './constants.js'
import { statusHostOrder } from './hosts.js'
import { ambientFetch, boundedFetch } from './request.js'
import { redactSecrets } from './secret-redactor.js'

export { statusHostOrder } from './hosts.js'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function number(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function money(quota) {
  const value = number(quota)
  if (value === undefined) return undefined
  return Math.round(value / QUOTA_PER_USD * 1e6) / 1e6
}

/** Normalize one quoted amount, treating the "no period limit" sentinel as absent. */
function quotaFields(prefix, quota) {
  const value = number(quota)
  if (value === undefined || value === UNLIMITED_QUOTA_SENTINEL) return {}
  return { [`${prefix}Quota`]: value, [`${prefix}Usd`]: money(value) }
}

/**
 * Normalize `/api/usage/token/`.
 * @param payload - the endpoint's payload, wrapped or bare.
 * @returns a small projection, or undefined when the shape is unrecognized.
 */
export function parseTokenUsage(payload) {
  const data = record(payload?.data) ? payload.data : payload
  if (!record(data)) return undefined
  const recognized = ['name', 'quota_limit', 'total_granted', 'total_used', 'total_available', 'unlimited_quota', 'quota_reset_period']
    .some(field => data[field] !== undefined)
  if (!recognized) return undefined
  const expiresAt = number(data.expires_at)
  return {
    unlimitedQuota: data.unlimited_quota === true,
    ...(typeof data.name === 'string' && data.name !== '' ? { name: data.name } : {}),
    ...quotaFields('limit', data.quota_limit),
    ...quotaFields('granted', data.total_granted),
    ...quotaFields('used', data.total_used),
    ...quotaFields('available', data.total_available),
    ...(typeof data.quota_reset_period === 'string' && data.quota_reset_period !== ''
      ? { resetPeriod: data.quota_reset_period }
      : {}),
    ...(expiresAt === undefined || expiresAt <= 0 ? {} : { expiresAt }),
  }
}

function statusMessage(status) {
  if (status === 401) return 'this API key was rejected (401)'
  if (status === 402 || status === 403) return 'the gateway refused this key\'s balance read (402/403)'
  if (status === 429) return 'the gateway is rate limiting balance reads (429)'
  return `the gateway answered HTTP ${status}`
}

async function getJson(url, key, { fetchImpl, timeoutMs, signal }) {
  let response
  try {
    response = await boundedFetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }, { fetchImpl, timeoutMs, signal })
  } catch (error) {
    if (error.aborted) throw error.cause
    throw new Error(error.message, { cause: error })
  }
  if (!response.ok) throw new Error(statusMessage(response.status))
  try { return await response.json() }
  catch { throw new Error('the gateway returned unreadable balance data') }
}

async function withFallback(hosts, path, key, options) {
  const tried = []
  for (const host of hosts) {
    try {
      return { payload: await getJson(`${host}${path}`, key, options), host }
    } catch (error) {
      tried.push(`${host}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(tried.join('; '))
}

/**
 * Cached, single-flight balance reader.
 *
 * A read that fails for one key — the gateway throttled it, a host was
 * unreachable — keeps showing the last balance that key did report, marked
 * `stale` with when it was read and why this read failed, instead of blanking
 * the row. These last-good values live in the host process: a page refresh
 * keeps them, a restart does not.
 * @param options - key listing, host resolution, and transport knobs.
 * @returns `{ read({force, signal}), invalidate() }`.
 */
export function createBalanceReader({
  listKeys,
  getHosts,
  fetchImpl = ambientFetch,
  now = Date.now,
  ttlMs = DEFAULT_BALANCE_TTL_MS,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof listKeys !== 'function') throw new Error('PackyCode balance reader requires listKeys')
  if (typeof getHosts !== 'function') throw new Error('PackyCode balance reader requires getHosts')
  /** Last successful per-key usage, by key id. */
  const lastGood = new Map()

  const loadKey = async (entry, hosts, signal) => {
    const { payload } = await withFallback(statusHostOrder(hosts), '/api/usage/token/', entry.key, { fetchImpl, timeoutMs, signal })
    const usage = parseTokenUsage(payload)
    if (usage === undefined) throw new Error('the gateway returned an unrecognized usage payload')
    return usage
  }

  const load = async signal => {
    signal?.throwIfAborted()
    const hosts = getHosts()
    const keys = await listKeys()
    const secrets = keys.map(entry => entry.key)
    const safe = value => redactSecrets(value, secrets)
    // A removed key's last balance must not resurface under a later key.
    for (const id of lastGood.keys()) {
      if (!keys.some(entry => entry.id === id)) lastGood.delete(id)
    }
    const entries = []
    for (const entry of keys) {
      const base = { id: entry.id, label: safe(entry.label), disabled: entry.disabled === true }
      try {
        const usage = await loadKey(entry, hosts, signal)
        if (usage.name !== undefined) usage.name = safe(usage.name)
        if (usage.resetPeriod !== undefined) usage.resetPeriod = safe(usage.resetPeriod)
        lastGood.set(entry.id, { usage, fetchedAt: now() })
        entries.push({ ...base, usage })
      } catch (error) {
        signal?.throwIfAborted()
        const message = safe(error instanceof Error ? error.message : String(error))
        const previous = lastGood.get(entry.id)
        entries.push(previous === undefined
          ? { ...base, error: message }
          : { ...base, usage: previous.usage, stale: { fetchedAt: previous.fetchedAt, error: message } })
      }
    }
    return { keys: entries, hosts, fetchedAt: now() }
  }

  const cache = createCachedRead(load, { ttlMs, now })
  return Object.freeze({
    read: options => cache.read(options),
    invalidate: () => cache.invalidate(),
  })
}
