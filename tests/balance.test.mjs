import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createBalanceReader,
  parseBillingSubscription,
  parseBillingUsage,
  parseTokenUsage,
} from '../src/balance.js'

/** The live shape `/api/usage/token/` answers with. */
const TOKEN_USAGE = {
  code: true,
  data: {
    expires_at: 0,
    name: '战魂銘人-张洋凡',
    object: 'token_usage',
    quota_limit: 250000000,
    quota_period_start: 1790784000,
    quota_reset_period: 'monthly',
    total_available: 249626442,
    total_granted: 250000000,
    total_used: 373558,
    unlimited_quota: false,
  },
  message: 'ok',
}

test('parses per-key quota into quota units and USD', () => {
  const usage = parseTokenUsage(TOKEN_USAGE)
  assert.equal(usage.name, '战魂銘人-张洋凡')
  assert.equal(usage.unlimitedQuota, false)
  assert.equal(usage.limitQuota, 250000000)
  assert.equal(usage.limitUsd, 500)
  assert.equal(usage.availableUsd, 499.252884)
  assert.equal(usage.usedUsd, 0.747116)
  assert.equal(usage.resetPeriod, 'monthly')
  assert.equal('expiresAt' in usage, false)
})

test('treats the no-period-limit sentinel as absent and honors unlimited quota', () => {
  const usage = parseTokenUsage({ data: { quota_limit: -1, unlimited_quota: true, total_available: 1000 } })
  assert.equal('limitQuota' in usage, false)
  assert.equal(usage.unlimitedQuota, true)
  assert.equal(usage.availableUsd, 0.002)
})

test('parses the account endpoints', () => {
  assert.deepEqual(
    parseBillingSubscription({ hard_limit_usd: 500, soft_limit_usd: 500, system_hard_limit_usd: 500, access_until: 0 }),
    { softLimitUsd: 500, hardLimitUsd: 500, systemHardLimitUsd: 500 },
  )
  assert.deepEqual(parseBillingUsage({ object: 'list', total_usage: 74.7116 }), { totalUsageUsd: 74.7116 })
  assert.equal(parseTokenUsage({ nothing: true }), undefined)
})

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

function routedFetch(routes) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push(url)
    const route = routes.find(candidate => url.startsWith(candidate.prefix))
    if (route === undefined) throw new Error(`unrouted ${url}`)
    if (typeof route.reply === 'function') return route.reply(url, options)
    return jsonResponse(route.reply, route.status ?? 200)
  }
  return { fetchImpl, calls }
}

const KEYS = [{ id: 'a', label: 'primary', key: 'sk-aaaaaaaaaaaaaaaa', disabled: false }]
const HOSTS = { apiHost: 'https://cf.api.fan', statusHost: 'https://www.packyapi.com' }

test('reads per-key quota from the status host and the account from the model host', async () => {
  const { fetchImpl, calls } = routedFetch([
    { prefix: 'https://www.packyapi.com/api/usage/token/', reply: TOKEN_USAGE },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/subscription', reply: { hard_limit_usd: 500 } },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/usage', reply: { total_usage: 74.7116 } },
  ])
  const reader = createBalanceReader({ listKeys: async () => KEYS, getHosts: () => HOSTS, fetchImpl })
  const value = await reader.read()
  assert.equal(value.keys[0].usage.availableUsd, 499.252884)
  assert.equal(value.account.remainingUsd, 425.2884)
  assert.equal(calls.length, 3)
  assert.match(calls[0], /^https:\/\/www\.packyapi\.com/u)
})

test('falls back to the other host when the configured one cannot answer', async () => {
  const { fetchImpl } = routedFetch([
    { prefix: 'https://cf.api.fan/api/usage/token/', reply: { error: 'not found' }, status: 404 },
    { prefix: 'https://www.packyapi.com/api/usage/token/', reply: TOKEN_USAGE },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/subscription', reply: { hard_limit_usd: 500 } },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/usage', reply: { total_usage: 0 } },
  ])
  const reader = createBalanceReader({ listKeys: async () => KEYS, getHosts: () => HOSTS, fetchImpl })
  const value = await reader.read()
  assert.equal(value.keys[0].error, undefined)
  assert.equal(value.keys[0].usage.limitUsd, 500)
})

test('a rejected key reports its own error without failing the whole read', async () => {
  const { fetchImpl } = routedFetch([
    { prefix: 'https://www.packyapi.com/api/usage/token/', reply: { error: { message: '无效的令牌' } }, status: 401 },
    { prefix: 'https://cf.api.fan/api/usage/token/', reply: { error: { message: '无效的令牌' } }, status: 401 },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/subscription', reply: { hard_limit_usd: 500 } },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/usage', reply: { total_usage: 1 } },
  ])
  const reader = createBalanceReader({ listKeys: async () => KEYS, getHosts: () => HOSTS, fetchImpl })
  const value = await reader.read()
  assert.equal(value.keys[0].usage, undefined)
  assert.match(value.keys[0].error, /rejected \(401\)/u)
  assert.equal(value.account.remainingUsd, 499)
})

test('a read without keys still returns the account error instead of throwing', async () => {
  const { fetchImpl } = routedFetch([])
  const reader = createBalanceReader({ listKeys: async () => [], getHosts: () => HOSTS, fetchImpl })
  const value = await reader.read()
  assert.deepEqual(value.keys, [])
  assert.match(value.account.error, /add a PackyCode API key/u)
})

test('the account read falls back to a key the gateway accepts', async () => {
  const keys = [
    { id: 'bad', label: 'bad', key: 'sk-invalid-000000', disabled: false },
    { id: 'good', label: 'good', key: 'sk-valid-000000', disabled: false },
  ]
  const isBad = options => String(options.headers.Authorization).includes('sk-invalid')
  const { fetchImpl } = routedFetch([
    {
      prefix: 'https://www.packyapi.com/api/usage/token/',
      reply: (_url, options) => (isBad(options) ? jsonResponse({ error: { message: '无效的令牌' } }, 401) : jsonResponse(TOKEN_USAGE)),
    },
    { prefix: 'https://cf.api.fan/api/usage/token/', reply: { error: 'not found' }, status: 404 },
    {
      prefix: 'https://cf.api.fan/v1/dashboard/billing/subscription',
      reply: (_url, options) => (isBad(options) ? jsonResponse({ error: 'unauthorized' }, 401) : jsonResponse({ hard_limit_usd: 500 })),
    },
    { prefix: 'https://www.packyapi.com/v1/dashboard/billing/subscription', reply: { hard_limit_usd: 500 } },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/usage', reply: { total_usage: 74.7116 } },
    { prefix: 'https://www.packyapi.com/v1/dashboard/billing/usage', reply: { total_usage: 74.7116 } },
  ])
  const reader = createBalanceReader({ listKeys: async () => keys, getHosts: () => HOSTS, fetchImpl })
  const value = await reader.read()
  assert.match(value.keys[0].error, /rejected \(401\)/u)
  assert.equal(value.keys[1].usage.availableUsd, 499.252884)
  // The total must come from the key that answered, not from whichever is first.
  assert.equal(value.account.hardLimitUsd, 500)
  assert.equal(value.account.keyId, 'good')
})

test('caches a read, shares one in flight, and forgets on invalidate', async () => {
  let calls = 0
  const { fetchImpl } = routedFetch([
    {
      prefix: 'https://www.packyapi.com/api/usage/token/',
      reply: () => {
        calls += 1
        return jsonResponse(TOKEN_USAGE)
      },
    },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/subscription', reply: { hard_limit_usd: 500 } },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/usage', reply: { total_usage: 0 } },
  ])
  const reader = createBalanceReader({ listKeys: async () => KEYS, getHosts: () => HOSTS, fetchImpl, now: () => 1000 })
  const [first, second] = await Promise.all([reader.read(), reader.read()])
  assert.equal(calls, 1)
  assert.equal(first.fetchedAt, second.fetchedAt)
  await reader.read()
  assert.equal(calls, 1)
  reader.invalidate()
  await reader.read()
  assert.equal(calls, 2)
})
