import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createBalanceReader,
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

test('does not mistake another payload for token usage', () => {
  assert.equal(parseTokenUsage({ nothing: true }), undefined)
  // The billing family's shape is not a key's usage, even from the same key.
  assert.equal(parseTokenUsage({ object: 'billing_subscription', hard_limit_usd: 100 }), undefined)
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

test('a balance read requests only per-key usage, never the billing family', async () => {
  // PackyCode answers `/v1/dashboard/billing/*` per key too (its grant, its
  // spend in cents), so those requests could only repeat this row.
  const requests = []
  const reader = createBalanceReader({ listKeys: async () => KEYS, getHosts: () => HOSTS,
    fetchImpl: async (url, init) => {
      requests.push(url)
      assert.equal(new URL(url).pathname, '/api/usage/token/')
      assert.equal(init.redirect, 'error')
      assert.ok(init.signal instanceof AbortSignal)
      return jsonResponse(TOKEN_USAGE)
    },
  })
  const value = await reader.read()
  assert.equal(value.keys[0].usage.availableUsd, 499.252884)
  assert.equal(Object.hasOwn(value, 'account'), false)
  assert.equal(requests.length, 1)
  assert.match(requests[0], /^https:\/\/www\.packyapi\.ai/u)
  await reader.read()
  assert.equal(requests.length, 1)
  await reader.read({ force: true })
  assert.equal(requests.length, 2)
})

test('a read without keys makes no authenticated request', async () => {
  const reader = createBalanceReader({ listKeys: async () => [], getHosts: () => HOSTS,
    fetchImpl: async () => { assert.fail('must not fall back to another credential') },
  })
  const value = await reader.read()
  assert.deepEqual(value.keys, [])
  assert.equal(Object.hasOwn(value, 'account'), false)
})

test('quota projections redact credentials echoed in names, reset periods and transport diagnostics', async () => {
  let failing = false
  const key = KEYS[0].key
  const reader = createBalanceReader({ listKeys: async () => KEYS, getHosts: () => HOSTS,
    fetchImpl: async () => {
      if (failing) throw new Error(`connection failed with Bearer ${key}`)
      return jsonResponse({ data: { name: `image account ${key}`, total_available: 500000, quota_reset_period: key } })
    },
  })
  const first = await reader.read()
  assert.equal(JSON.stringify(first).includes(key), false)
  assert.match(first.keys[0].usage.name, /\[redacted\]/u)
  failing = true
  const stale = await reader.read({ force: true })
  assert.equal(stale.keys[0].usage.availableUsd, 1)
  assert.ok(stale.keys[0].stale)
  assert.equal(JSON.stringify(stale).includes(key), false)
})

test('an invalid JSON balance response never exposes a secret from its parse error', async () => {
  const reader = createBalanceReader({ listKeys: async () => KEYS, getHosts: () => HOSTS,
    fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError(`invalid JSON near ${KEYS[0].key}`) } }),
  })
  const value = await reader.read()
  assert.match(value.keys[0].error, /unreadable balance data/u)
  assert.equal(JSON.stringify(value).includes(KEYS[0].key), false)
})

test('falls back to the other host when the configured one cannot answer', async () => {
  const { fetchImpl, calls } = routedFetch([
    { prefix: 'https://cf.api.fan/api/usage/token/', reply: { error: 'not found' }, status: 404 },
    { prefix: 'https://www.packyapi.ai/api/usage/token/', reply: TOKEN_USAGE },
  ])
  const reader = createBalanceReader({ listKeys: async () => KEYS, getHosts: () => ({ apiHost: 'https://cf.api.fan', statusHost: 'https://cf.api.fan' }), fetchImpl })
  const value = await reader.read()
  assert.equal(value.keys[0].error, undefined)
  assert.equal(value.keys[0].usage.limitUsd, 500)
  assert.deepEqual(calls, ['https://cf.api.fan/api/usage/token/', 'https://www.packyapi.ai/api/usage/token/'])
})

test('a rejected key reports its own error without failing the whole read', async () => {
  const { fetchImpl } = routedFetch([
    { prefix: 'https://www.packyapi.ai/api/usage/token/', reply: { error: { message: '无效的令牌' } }, status: 401 },
    { prefix: 'https://cf.api.fan/api/usage/token/', reply: { error: { message: '无效的令牌' } }, status: 401 },
  ])
  const reader = createBalanceReader({ listKeys: async () => KEYS, getHosts: () => HOSTS, fetchImpl })
  const value = await reader.read()
  assert.equal(value.keys[0].usage, undefined)
  assert.match(value.keys[0].error, /rejected \(401\)/u)
})

test('each key reports with its own credential, so a rejected key leaves the others intact', async () => {
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
    { prefix: 'https://www.packyapi.com/api/usage/token/', reply: { error: { message: '无效的令牌' } }, status: 401 },
    { prefix: 'https://cf.api.fan/api/usage/token/', reply: { error: 'not found' }, status: 404 },
  ])
  const reader = createBalanceReader({ listKeys: async () => keys, getHosts: () => HOSTS, fetchImpl })
  const value = await reader.read()
  assert.match(value.keys[0].error, /rejected \(401\)/u)
  assert.equal(value.keys[1].usage.availableUsd, 499.252884)
  assert.equal(value.keys[1].error, undefined)
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
  ])
  const legacy = { apiHost: 'https://cf.api.fan', statusHost: 'https://www.packyapi.com' }
  const reader = createBalanceReader({ listKeys: async () => KEYS, getHosts: () => legacy, fetchImpl })
  const value = await reader.read()
  assert.equal(value.keys[0].usage.availableUsd, 499.252884)
  assert.match(calls[0], /^https:\/\/www\.packyapi\.ai\//u)
  assert.deepEqual(statusHostOrder(legacy), ['https://www.packyapi.ai', 'https://www.packyapi.com', 'https://cf.api.fan'])
  // An explicit non-legacy override still goes first.
  assert.equal(statusHostOrder({ apiHost: 'https://cf.api.fan', statusHost: 'https://status.example' })[0], 'https://status.example')
})

test('an unreachable host is reported with the transport cause, and the legacy host still answers', async () => {
  const dnsFailure = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND www.packyapi.ai'), { code: 'ENOTFOUND' }) })
  const { fetchImpl } = routedFetch([
    { prefix: 'https://www.packyapi.ai/', reply: () => { throw dnsFailure } },
    { prefix: 'https://www.packyapi.com/api/usage/token/', reply: TOKEN_USAGE },
  ])
  const reader = createBalanceReader({ listKeys: async () => KEYS, getHosts: () => HOSTS, fetchImpl })
  assert.equal((await reader.read()).keys[0].usage.limitUsd, 500)

  const { fetchImpl: down } = routedFetch([
    { prefix: 'https://www.packyapi.', reply: () => { throw dnsFailure } },
    { prefix: 'https://cf.api.fan/api/usage/token/', reply: { error: 'not found' }, status: 404 },
  ])
  const failing = createBalanceReader({ listKeys: async () => KEYS, getHosts: () => HOSTS, fetchImpl: down })
  const value = await failing.read()
  assert.match(value.keys[0].error, /fetch failed \(ENOTFOUND\)/u)
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
  ])
  let keys = KEYS
  const reader = createBalanceReader({ listKeys: async () => keys, getHosts: () => HOSTS, fetchImpl, now: () => clock })
  const first = await reader.read()
  assert.equal(first.keys[0].stale, undefined)

  up = false
  clock = 99_000
  const second = await reader.read({ force: true })
  assert.equal(second.keys[0].usage.availableUsd, 499.252884, 'the last good balance stays visible')
  assert.equal(second.keys[0].stale.fetchedAt, 1_000)
  assert.match(second.keys[0].stale.error, /429/u)
  assert.equal(second.keys[0].error, undefined)

  // A key that is no longer stored takes its last balance with it.
  keys = [{ id: 'b', label: 'other', key: 'sk-bbbbbbbbbbbbbbbb', disabled: false }]
  const third = await reader.read({ force: true })
  assert.equal(third.keys[0].usage, undefined)
  assert.equal(third.keys[0].stale, undefined)
  assert.ok(third.keys[0].error)
})
