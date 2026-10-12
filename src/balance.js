/**
 * Account and per-key balance.
 *
 * PackyCode is a new-api style relay: `/api/usage/token/` reports the quota of
 * the key that authorized the request, and `/v1/dashboard/billing/*` reports
 * the account. Only the second family exists on the model host (`cf.api.fan`
 * answers 404 for `/api/*`), so a read tries the configured host first and
 * falls back to the PackyAPI host — the same fallback the PackyCode status
 * tooling uses.
 *
 * Credentials and response bodies stay host-side; the browser receives only
 * the projection built here.
 *
 * @module dsh-packycode-api/balance
 */

import {
  DEFAULT_API_HOST,
  DEFAULT_BALANCE_TTL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STATUS_HOST,
  QUOTA_PER_USD,
  UNLIMITED_QUOTA_SENTINEL,
} from './constants.js'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = value => structuredClone(value)

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

/** Normalize `/v1/dashboard/billing/subscription`. */
export function parseBillingSubscription(payload) {
  if (!record(payload)) return undefined
  return {
    ...(number(payload.soft_limit_usd) === undefined ? {} : { softLimitUsd: number(payload.soft_limit_usd) }),
    ...(number(payload.hard_limit_usd) === undefined ? {} : { hardLimitUsd: number(payload.hard_limit_usd) }),
    ...(number(payload.system_hard_limit_usd) === undefined ? {} : { systemHardLimitUsd: number(payload.system_hard_limit_usd) }),
    ...(number(payload.access_until) === undefined || number(payload.access_until) <= 0 ? {} : { accessUntil: number(payload.access_until) }),
  }
}

/** Normalize `/v1/dashboard/billing/usage`. */
export function parseBillingUsage(payload) {
  if (!record(payload)) return undefined
  const total = number(payload.total_usage)
  return total === undefined ? {} : { totalUsageUsd: Math.round(total * 1e6) / 1e6 }
}

function statusMessage(status) {
  if (status === 401) return 'this API key was rejected (401)'
  if (status === 402 || status === 403) return 'the account cannot be read with this key (402/403)'
  return `the gateway answered HTTP ${status}`
}

async function getJson(url, key, { fetchImpl, timeoutMs, signal }) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    redirect: 'error',
    signal: requestSignal,
  })
  if (!response.ok) throw new Error(statusMessage(response.status))
  return response.json()
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
 * @param options - key listing, host resolution, and transport knobs.
 * @returns `{ read({force, signal}), invalidate() }`.
 */
export function createBalanceReader({
  listKeys,
  getHosts,
  fetchImpl = fetch,
  now = Date.now,
  ttlMs = DEFAULT_BALANCE_TTL_MS,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof listKeys !== 'function') throw new Error('PackyCode balance reader requires listKeys')
  if (typeof getHosts !== 'function') throw new Error('PackyCode balance reader requires getHosts')
  let cached
  let inFlight
  let generation = 0

  const loadKey = async (entry, hosts, signal) => {
    const statusHosts = [...new Set([hosts.statusHost, DEFAULT_STATUS_HOST, hosts.apiHost, DEFAULT_API_HOST])]
    const { payload } = await withFallback(statusHosts, '/api/usage/token/', entry.key, { fetchImpl, timeoutMs, signal })
    const usage = parseTokenUsage(payload)
    if (usage === undefined) throw new Error('the gateway returned an unrecognized usage payload')
    return usage
  }

  /**
   * The account endpoints need one working key. Candidates are ordered by
   * evidence: a key whose per-key read just succeeded, then the key that
   * answered this read last time, then the rest — so an invalid key sitting
   * first in the ring cannot blank the account total.
   */
  let accountKeyId
  const loadAccount = async (keys, hosts, signal, usableIds = []) => {
    const candidates = [...new Set([...usableIds, accountKeyId, ...keys.filter(entry => entry.disabled !== true).map(entry => entry.id)])]
      .map(id => keys.find(entry => entry.id === id))
      .filter(entry => entry !== undefined)
    if (candidates.length === 0) throw new Error('add a PackyCode API key to read the account balance')
    const hostsToTry = [...new Set([hosts.apiHost, DEFAULT_API_HOST, hosts.statusHost, DEFAULT_STATUS_HOST])]
    const options = { fetchImpl, timeoutMs, signal }
    let lastError
    for (const key of candidates) {
      try {
        const subscription = parseBillingSubscription((await withFallback(hostsToTry, '/v1/dashboard/billing/subscription', key.key, options)).payload)
        const usage = parseBillingUsage((await withFallback(hostsToTry, '/v1/dashboard/billing/usage', key.key, options)).payload)
        const remaining = subscription?.hardLimitUsd === undefined || usage?.totalUsageUsd === undefined
          ? undefined
          : Math.round((subscription.hardLimitUsd - usage.totalUsageUsd) * 1e6) / 1e6
        accountKeyId = key.id
        return { ...subscription, ...usage, ...(remaining === undefined ? {} : { remainingUsd: remaining }), keyId: key.id }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  const load = async signal => {
    signal?.throwIfAborted()
    const hosts = getHosts()
    const keys = await listKeys()
    const entries = []
    const usableIds = []
    for (const entry of keys) {
      const base = { id: entry.id, label: entry.label, disabled: entry.disabled === true }
      try {
        entries.push({ ...base, usage: await loadKey(entry, hosts, signal) })
        usableIds.push(entry.id)
      } catch (error) {
        entries.push({ ...base, error: error instanceof Error ? error.message : String(error) })
      }
    }
    let account
    try {
      account = await loadAccount(keys, hosts, signal, usableIds)
    } catch (error) {
      account = { error: error instanceof Error ? error.message : String(error) }
    }
    return { keys: entries, account, hosts, fetchedAt: now() }
  }

  return Object.freeze({
    async read({ force = false, signal } = {}) {
      signal?.throwIfAborted()
      if (!force && cached !== undefined && now() - cached.fetchedAt < ttlMs) return clone(cached)
      const createPending = requestSignal => {
        const observedGeneration = generation
        return load(requestSignal).then(value => {
          if (generation === observedGeneration) cached = value
          return value
        })
      }
      if (force) return clone(await createPending(signal))
      const pending = inFlight ?? createPending()
      if (inFlight === undefined) {
        inFlight = pending
        const clear = () => {
          if (inFlight === pending) inFlight = undefined
        }
        void pending.then(clear, clear)
      }
      return clone(await pending)
    },
    invalidate() {
      generation += 1
      cached = undefined
    },
  })
}
