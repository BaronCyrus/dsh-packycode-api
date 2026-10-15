/**
 * Account and per-key balance.
 *
 * PackyCode is a new-api style relay: `/api/usage/token/` reports the quota of
 * the key that authorized the request, and `/v1/dashboard/billing/*` reports
 * the account. Only the second family exists on the model host (`cf.api.fan`
 * answers 404 for `/api/*`), so a read tries the configured host first and
 * falls back to the PackyAPI host — the same fallback the PackyCode status
 * tooling uses. A saved legacy status host (`www.packyapi.com`, DNS-poisoned
 * on mainland networks) is tried after the current default, not before it.
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
import { accountHostOrder, statusHostOrder } from './hosts.js'
import { ambientFetch, boundedFetch } from './request.js'
import { redactSecrets } from './secret-redactor.js'

export { accountHostOrder, statusHostOrder } from './hosts.js'

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
 * the row. The same holds for the account figures. These last-good values
 * live in the host process: a page refresh keeps them, a restart does not.
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
  /** Image keys need only their own quota, not account-wide billing. */
  includeAccount = true,
} = {}) {
  if (typeof listKeys !== 'function') throw new Error('PackyCode balance reader requires listKeys')
  if (typeof getHosts !== 'function') throw new Error('PackyCode balance reader requires getHosts')
  /** Last successful per-key usage, by key id, and the last account figures. */
  const lastGood = new Map()
  let lastAccount

  const loadKey = async (entry, hosts, signal) => {
    const { payload } = await withFallback(statusHostOrder(hosts), '/api/usage/token/', entry.key, { fetchImpl, timeoutMs, signal })
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
    const hostsToTry = accountHostOrder(hosts)
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
    const secrets = keys.map(entry => entry.key)
    const safe = value => redactSecrets(value, secrets)
    // A removed key's last balance must not resurface under a later key.
    for (const id of lastGood.keys()) {
      if (!keys.some(entry => entry.id === id)) lastGood.delete(id)
    }
    const entries = []
    const usableIds = []
    for (const entry of keys) {
      const base = { id: entry.id, label: safe(entry.label), disabled: entry.disabled === true }
      try {
        const usage = await loadKey(entry, hosts, signal)
        if (usage.name !== undefined) usage.name = safe(usage.name)
        if (usage.resetPeriod !== undefined) usage.resetPeriod = safe(usage.resetPeriod)
        lastGood.set(entry.id, { usage, fetchedAt: now() })
        entries.push({ ...base, usage })
        usableIds.push(entry.id)
      } catch (error) {
        signal?.throwIfAborted()
        const message = safe(error instanceof Error ? error.message : String(error))
        const previous = lastGood.get(entry.id)
        entries.push(previous === undefined
          ? { ...base, error: message }
          : { ...base, usage: previous.usage, stale: { fetchedAt: previous.fetchedAt, error: message } })
      }
    }
    let account
    if (includeAccount) {
      try {
        account = await loadAccount(keys, hosts, signal, usableIds)
        lastAccount = { account, fetchedAt: now() }
      } catch (error) {
        signal?.throwIfAborted()
        const message = safe(error instanceof Error ? error.message : String(error))
        account = lastAccount === undefined || !keys.some(entry => entry.id === lastAccount.account.keyId)
          ? { error: message }
          : { ...lastAccount.account, stale: { fetchedAt: lastAccount.fetchedAt, error: message } }
      }
    }
    return { keys: entries, ...(includeAccount ? { account } : {}), hosts, fetchedAt: now() }
  }

  const cache = createCachedRead(load, { ttlMs, now })
  return Object.freeze({
    read: options => cache.read(options),
    invalidate: () => cache.invalidate(),
  })
}
