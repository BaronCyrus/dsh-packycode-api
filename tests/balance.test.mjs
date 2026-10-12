import assert from 'node:assert/strict'
import test from 'node:test'

import {
  accountHostOrder,
  createBalanceReader,
  parseBillingSubscription,
  parseBillingUsage,
  parseTokenUsage,
  statusHostOrder,
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
const HOSTS = { apiHost: 'https://cf.api.fan', statusHost: 'https://www.packyapi.ai' }

test('reads per-key quota from the status host and the account from the model host', async () => {
  const { fetchImpl, calls } = routedFetch([
    { prefix: 'https://www.packyapi.ai/api/usage/token/', reply: TOKEN_USAGE },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/subscription', reply: { hard_limit_usd: 500 } },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/usage', reply: { total_usage: 74.7116 } },
  ])
  const reader = createBalanceReader({ listKeys: async () => KEYS, getHosts: () => HOSTS, fetchImpl })
  const value = await reader.read()
  assert.equal(value.keys[0].usage.availableUsd, 499.252884)
  assert.equal(value.account.remainingUsd, 425.2884)
  assert.equal(calls.length, 3)
  assert.match(calls[0], /^https:\/\/www\.packyapi\.ai/u)
})

test('falls back to the other host when the configured one cannot answer', async () => {
  const { fetchImpl } = routedFetch([
    { prefix: 'https://cf.api.fan/api/usage/token/', reply: { error: 'not found' }, status: 404 },
    { prefix: 'https://www.packyapi.ai/api/usage/token/', reply: TOKEN_USAGE },
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
    { prefix: 'https://www.packyapi.ai/api/usage/token/', reply: { error: { message: '无效的令牌' } }, status: 401 },
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
      prefix: 'https://www.packyapi.ai/api/usage/token/',
      reply: (_url, options) => (isBad(options) ? jsonResponse({ error: { message: '无效的令牌' } }, 401) : jsonResponse(TOKEN_USAGE)),
    },
    { prefix: 'https://cf.api.fan/api/usage/token/', reply: { error: 'not found' }, status: 404 },
    {
      prefix: 'https://cf.api.fan/v1/dashboard/billing/subscription',
      reply: (_url, options) => (isBad(options) ? jsonResponse({ error: 'unauthorized' }, 401) : jsonResponse({ hard_limit_usd: 500 })),
    },
    { prefix: 'https://www.packyapi.ai/v1/dashboard/billing/subscription', reply: { hard_limit_usd: 500 } },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/usage', reply: { total_usage: 74.7116 } },
    { prefix: 'https://www.packyapi.ai/v1/dashboard/billing/usage', reply: { total_usage: 74.7116 } },
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
      prefix: 'https://www.packyapi.ai/api/usage/token/',
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

test('a saved legacy status host is tried after the current default, never first', async () => {
  const { fetchImpl, calls } = routedFetch([
    { prefix: 'https://www.packyapi.ai/api/usage/token/', reply: TOKEN_USAGE },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/subscription', reply: { hard_limit_usd: 500 } },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/usage', reply: { total_usage: 0 } },
  ])
  const legacy = { apiHost: 'https://cf.api.fan', statusHost: 'https://www.packyapi.com' }
  const reader = createBalanceReader({ listKeys: async () => KEYS, getHosts: () => legacy, fetchImpl })
  const value = await reader.read()
  assert.equal(value.keys[0].usage.availableUsd, 499.252884)
  assert.match(calls[0], /^https:\/\/www\.packyapi\.ai\//u)
  assert.deepEqual(statusHostOrder(legacy), ['https://www.packyapi.ai', 'https://www.packyapi.com', 'https://cf.api.fan'])
  // An explicit non-legacy override still goes first.
  assert.equal(statusHostOrder({ apiHost: 'https://cf.api.fan', statusHost: 'https://status.example' })[0], 'https://status.example')
  assert.deepEqual(accountHostOrder(legacy).slice(0, 2), ['https://cf.api.fan', 'https://www.packyapi.ai'])
})

test('an unreachable host is reported with the transport cause, and the legacy host still answers', async () => {
  const dnsFailure = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND www.packyapi.ai'), { code: 'ENOTFOUND' }) })
  const { fetchImpl } = routedFetch([
    { prefix: 'https://www.packyapi.ai/', reply: () => { throw dnsFailure } },
    { prefix: 'https://www.packyapi.com/api/usage/token/', reply: TOKEN_USAGE },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/subscription', reply: { hard_limit_usd: 500 } },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/usage', reply: { total_usage: 0 } },
  ])
  const reader = createBalanceReader({ listKeys: async () => KEYS, getHosts: () => HOSTS, fetchImpl })
  assert.equal((await reader.read()).keys[0].usage.limitUsd, 500)

  const { fetchImpl: down } = routedFetch([
    { prefix: 'https://www.packyapi.', reply: () => { throw dnsFailure } },
    { prefix: 'https://cf.api.fan/api/usage/token/', reply: { error: 'not found' }, status: 404 },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/', reply: {}, status: 429 },
  ])
  const failing = createBalanceReader({ listKeys: async () => KEYS, getHosts: () => HOSTS, fetchImpl: down })
  const value = await failing.read()
  assert.match(value.keys[0].error, /fetch failed \(ENOTFOUND\)/u)
  assert.match(value.account.error, /rate limiting balance reads \(429\)/u)
})

test('a failed read keeps the last balance each key reported, marked stale', async () => {
  let up = true
  let clock = 1_000
  const { fetchImpl } = routedFetch([
    {
      prefix: 'https://www.packyapi.ai/api/usage/token/',
      reply: () => (up ? jsonResponse(TOKEN_USAGE) : jsonResponse({ error: 'busy' }, 429)),
    },
    { prefix: 'https://www.packyapi.com/api/usage/token/', reply: () => jsonResponse({ error: 'busy' }, 429) },
    { prefix: 'https://cf.api.fan/api/usage/token/', reply: { error: 'not found' }, status: 404 },
    {
      prefix: 'https://cf.api.fan/v1/dashboard/billing/subscription',
      reply: () => (up ? jsonResponse({ hard_limit_usd: 500 }) : jsonResponse({ error: 'busy' }, 429)),
    },
    { prefix: 'https://www.packyapi.', reply: () => jsonResponse({ error: 'busy' }, 429) },
    { prefix: 'https://cf.api.fan/v1/dashboard/billing/usage', reply: { total_usage: 74.7116 } },
  ])
  let keys = KEYS
  const reader = createBalanceReader({ listKeys: async () => keys, getHosts: () => HOSTS, fetchImpl, now: () => clock })
  const first = await reader.read()
  assert.equal(first.keys[0].stale, undefined)
  assert.equal(first.account.remainingUsd, 425.2884)

  up = false
  clock = 99_000
  const second = await reader.read({ force: true })
  assert.equal(second.keys[0].usage.availableUsd, 499.252884, 'the last good balance stays visible')
  assert.equal(second.keys[0].stale.fetchedAt, 1_000)
  assert.match(second.keys[0].stale.error, /429/u)
  assert.equal(second.keys[0].error, undefined)
  assert.equal(second.account.remainingUsd, 425.2884)
  assert.equal(second.account.stale.fetchedAt, 1_000)

  // A key that is no longer stored takes its last balance with it.
  keys = [{ id: 'b', label: 'other', key: 'sk-bbbbbbbbbbbbbbbb', disabled: false }]
  const third = await reader.read({ force: true })
  assert.equal(third.keys[0].usage, undefined)
  assert.equal(third.keys[0].stale, undefined)
  assert.equal(third.account.stale, undefined)
  assert.ok(third.account.error)
})
