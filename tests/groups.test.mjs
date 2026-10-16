import assert from 'node:assert/strict'
import test from 'node:test'

import {
  catalogCoverage,
  createGroupReader,
  GROUP_PROBE_MODEL,
  parsePricing,
  parseSelectedGroups,
  pickKeyForModel,
} from '../src/groups.js'

/** The gateway's own refusal text for a model the token cannot route. */
const REFUSAL = (groups) => `当前令牌未覆盖供应商 ""（模型=${GROUP_PROBE_MODEL}，已选分组=[${groups.join(' ')}]） (request id: 01M4SRE5WPZ0QTBASEW8KNN68F)`

/** A trimmed copy of the public `/api/pricing` body. */
const PRICING = {
  data: [
    { model_name: 'deepseek-flash', enable_groups: ['deepseek-sale', 'deepseek-officially'] },
    { model_name: 'gpt-6.1-sol', enable_groups: ['codex', 'codex-sale', 'azure-officially'] },
    { model_name: 'gpt-6-astra', enable_groups: ['azure-officially', 'codex', 'codex-sale'] },
    { model_name: 'claude-opus-5-5', enable_groups: ['cc', 'cc-expensive', 'claude-officially', 'cc-sale'] },
    { model_name: 'claude-sonnet-5-5', enable_groups: ['cc-expensive', 'claude-officially', 'cc-sale', 'cc'] },
    { model_name: 'claude-haiku-5-5', enable_groups: ['claude-officially', 'cc'] },
    { model_name: 'grok-4.6', enable_groups: ['grok-sale'] },
  ],
  usable_group: { cc: 'claude code专用', codex: 'codex专用', 'kimi-sale': ' 便宜的kimi分组，非逆向', '<script>': 'x' },
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })

test('the token groups are read out of the gateway refusal', () => {
  assert.deepEqual(parseSelectedGroups(REFUSAL(['codex', 'deepseek-officially', 'kimi-sale'])), ['codex', 'deepseek-officially', 'kimi-sale'])
  assert.deepEqual(parseSelectedGroups('已选分组=[cc, cc-sale，cc]'), ['cc', 'cc-sale'])
  assert.deepEqual(parseSelectedGroups('已选分组=[]'), [])
  assert.equal(parseSelectedGroups('model_not_found'), undefined)
  // Anything that is not a group name never reaches the browser.
  assert.deepEqual(parseSelectedGroups('已选分组=[cc <img/onerror=x> ok]'), ['cc', 'ok'])
})

test('pricing keeps the catalog models\' groups and each group\'s description', () => {
  const pricing = parsePricing(PRICING)
  assert.deepEqual(Object.keys(pricing.modelGroups).sort(), ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'deepseek-flash', 'gpt-6-astra', 'gpt-6.1-sol'])
  assert.deepEqual(pricing.modelGroups['claude-haiku-5-5'], ['cc', 'claude-officially'])
  assert.deepEqual(pricing.descriptions, { cc: 'claude code专用', codex: 'codex专用', 'kimi-sale': '便宜的kimi分组，非逆向' })
  assert.equal(parsePricing({ nope: true }), undefined)
})

test('coverage takes either source as evidence and leaves the rest unknown', () => {
  const { modelGroups } = parsePricing(PRICING)
  assert.deepEqual(catalogCoverage({ groups: ['codex', 'deepseek-officially'], modelGroups }), {
    'deepseek-flash': true,
    'gpt-6.1-sol': true,
    'gpt-6-astra': true,
    'claude-opus-5-5': false,
    'claude-sonnet-5-5': false,
    'claude-haiku-5-5': false,
  })
  // cc-sale serves Opus and Sonnet but not Haiku.
  assert.equal(catalogCoverage({ groups: ['cc-sale'], modelGroups })['claude-haiku-5-5'], false)
  assert.equal(catalogCoverage({ groups: ['cc-sale'], modelGroups })['claude-opus-5-5'], true)
  // The key's own model list wins a disagreement in the reachable direction.
  assert.equal(catalogCoverage({ groups: ['codex'], models: new Set(['claude-opus-5-5']), modelGroups })['claude-opus-5-5'], true)
  // No groups, no pricing, no model list: nothing is claimed.
  assert.deepEqual(catalogCoverage({}), {})
  assert.deepEqual(catalogCoverage({ models: new Set(['deepseek-flash']) }), {
    'deepseek-flash': true,
    'gpt-6.1-sol': false,
    'gpt-6-astra': false,
    'gpt-5.6-sol': false,
    'grok-4.7': false,
    'gemini-4-argon': false,
    'gemini-3.8-flash': false,
    'claude-opus-5-5': false,
    'claude-sonnet-5-5': false,
    'claude-haiku-5-5': false,
  })
})

test('Gemini coverage uses gateway evidence without guessing a token group', () => {
  const { modelGroups } = parsePricing({
    data: [{ model_name: 'gemini-4-argon', enable_groups: ['fixture-gemini'] }],
  })
  assert.deepEqual(modelGroups['gemini-4-argon'], ['fixture-gemini'])
  assert.equal(catalogCoverage({ groups: ['fixture-gemini'], modelGroups })['gemini-4-argon'], true)
  assert.equal(catalogCoverage({ groups: ['codex'], modelGroups })['gemini-4-argon'], false)
  assert.equal(catalogCoverage({ models: new Set(['gemini-4-argon']) })['gemini-4-argon'], true)
  assert.equal(catalogCoverage({ groups: ['codex'] })['gemini-4-argon'], undefined)
})

function gateway({ groupsByKey, modelsByKey = {}, pricing = PRICING, fail = {} }) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const key = init.headers?.Authorization?.replace(/^Bearer /u, '')
    calls.push({ url, key, method: init.method ?? 'GET', redirect: init.redirect })
    if (fail[key]) throw new Error('fetch failed')
    if (url.endsWith('/api/pricing')) return json(200, pricing)
    if (url.endsWith('/v1/chat/completions')) {
      if (groupsByKey[key] === 'rejected') return json(401, { error: { message: '无效的令牌' } })
      return json(400, { error: { code: 'model_not_found', message: REFUSAL(groupsByKey[key] ?? []) } })
    }
    if (url.endsWith('/v1/models')) {
      if (groupsByKey[key] === 'rejected') return json(401, { error: { message: '无效的令牌' } })
      return json(200, { data: (modelsByKey[key] ?? []).map(id => ({ id })) })
    }
    return json(404, {})
  }
  return { calls, fetchImpl }
}

const KEYS = [
  { id: 'a', label: 'codex key', key: 'sk-codex-key-AAAA', disabled: false },
  { id: 'b', label: 'cc key', key: 'sk-claude-key-BBBB', disabled: false },
]

test('each key reports its groups and reachable catalog models, with no key material', async () => {
  const net = gateway({ groupsByKey: { 'sk-codex-key-AAAA': ['codex', 'deepseek-officially'], 'sk-claude-key-BBBB': ['cc'] } })
  let now = 1_000
  const reader = createGroupReader({ listKeys: async () => KEYS, getHosts: () => ({ apiHost: 'https://gw.example', statusHost: 'https://status.example' }), fetchImpl: net.fetchImpl, now: () => now })
  const value = await reader.read()
  assert.doesNotMatch(JSON.stringify(value), /sk-(codex|claude)-key/u)
  assert.deepEqual(value.keys.map(key => key.groups), [['codex', 'deepseek-officially'], ['cc']])
  assert.equal(value.keys[0].coverage['claude-opus-5-5'], false)
  assert.equal(value.keys[1].coverage['claude-opus-5-5'], true)
  assert.equal(value.descriptions.cc, 'claude code专用')
  assert.deepEqual(value.requirements['claude-opus-5-5'], ['cc', 'cc-expensive', 'cc-sale', 'claude-officially'])
  // The probe never names a routable model, and nothing follows a redirect.
  const probes = net.calls.filter(call => call.url.endsWith('/v1/chat/completions'))
  assert.equal(probes.length, 2)
  assert.ok(net.calls.every(call => call.redirect === 'error'))
  assert.ok(net.calls.filter(call => call.url.endsWith('/api/pricing')).every(call => call.url.startsWith('https://status.example') && call.key === undefined))

  assert.equal(reader.covers('b', 'claude-opus-5-5'), true)
  assert.equal(reader.covers('a', 'claude-opus-5-5'), false)
  assert.equal(reader.covers('a', 'unknown-model'), undefined)
  assert.deepEqual(reader.groupsOf('b'), ['cc'])
  assert.deepEqual(reader.requiredGroups('claude-haiku-5-5'), ['cc', 'claude-officially'])

  // Cached for the TTL, refreshed when forced or invalidated.
  const before = net.calls.length
  await reader.read()
  assert.equal(net.calls.length, before)
  now += 11 * 60_000
  await reader.read()
  assert.ok(net.calls.length > before)
  const afterExpiry = net.calls.length
  reader.invalidate()
  assert.equal(reader.snapshot(), undefined)
  await reader.read({ force: true })
  assert.ok(net.calls.length > afterExpiry)
})

test('a rejected key reaches nothing; a failed read keeps the last good groups, marked stale', async () => {
  const groupsByKey = { 'sk-codex-key-AAAA': ['codex'], 'sk-claude-key-BBBB': 'rejected' }
  const fail = {}
  const net = gateway({ groupsByKey, fail })
  const reader = createGroupReader({ listKeys: async () => KEYS, getHosts: () => ({ apiHost: 'https://gw.example' }), fetchImpl: net.fetchImpl })
  const first = await reader.read()
  assert.equal(first.keys[1].rejected, true)
  assert.equal(reader.covers('b', 'deepseek-flash'), false)

  fail['sk-codex-key-AAAA'] = true
  const second = await reader.read({ force: true })
  assert.deepEqual(second.keys[0].groups, ['codex'])
  assert.match(second.keys[0].stale.error, /fetch failed/u)
})

test('keys are read concurrently and in order, and a lost probe keeps the model-list evidence', async () => {
  const PROBE_LOST = 'sk-probe-lost-key-DDDD'
  const SLOW = 'sk-slow-key-EEEE'
  const keys = [
    { id: 'slow', label: 'slow', key: SLOW, disabled: false },
    { id: 'lost', label: 'lost', key: PROBE_LOST, disabled: false },
  ]
  let inFlight = 0
  let peak = 0
  const fetchImpl = async (url, init) => {
    const key = init.headers?.Authorization?.replace(/^Bearer /u, '')
    inFlight += 1
    peak = Math.max(peak, inFlight)
    try {
      if (key === SLOW) await new Promise(resolve => { setTimeout(resolve, 40) })
      if (url.endsWith('/api/pricing')) return json(200, PRICING)
      if (url.endsWith('/v1/chat/completions')) {
        if (key === PROBE_LOST) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
        return json(400, { error: { message: REFUSAL(['codex']) } })
      }
      return json(200, { data: key === PROBE_LOST ? [{ id: 'deepseek-flash' }] : [] })
    } finally {
      inFlight -= 1
    }
  }
  const reader = createGroupReader({ listKeys: async () => keys, getHosts: () => ({ apiHost: 'https://gw.example' }), fetchImpl })
  const value = await reader.read()
  assert.deepEqual(value.keys.map(key => key.id), ['slow', 'lost'])
  assert.ok(peak >= 3, `requests overlapped (peak ${peak})`)
  assert.deepEqual(value.keys[0].groups, ['codex'])
  // The probe never answered; the model list still says what the key reaches.
  assert.equal(value.keys[1].groups, undefined)
  assert.equal(value.keys[1].coverage['deepseek-flash'], true)
  assert.equal(value.keys[1].coverage['claude-opus-5-5'], false)
})

test('a key is passed over only on evidence, and the active pointer is never moved', () => {
  const usable = [
    { id: 'a', label: 'A', key: 'ka' },
    { id: 'b', label: 'B', key: 'kb' },
    { id: 'c', label: 'C', key: 'kc' },
  ]
  const evidence = { 'a:claude': false, 'b:claude': undefined, 'c:claude': true, 'a:gpt': true }
  const covers = (id, model) => evidence[`${id}:${model}`]
  // The active key serves what it is not known to be excluded from.
  assert.deepEqual(pickKeyForModel('gpt', usable[0], usable, covers), usable[0])
  assert.deepEqual(pickKeyForModel('unknown', usable[0], usable, covers), usable[0])
  // Known excluded: the next key that surely can, ahead of one that may.
  assert.deepEqual(pickKeyForModel('claude', usable[0], usable, covers), { id: 'c', label: 'C', key: 'kc', switchedFrom: { id: 'a', label: 'A' } })
  // With no sure key, one with no evidence either way.
  evidence['c:claude'] = false
  assert.equal(pickKeyForModel('claude', usable[0], usable, covers).id, 'b')
  // With nothing better, the active key, marked uncovered.
  evidence['b:claude'] = false
  assert.deepEqual(pickKeyForModel('claude', usable[0], usable, covers), { ...usable[0], uncovered: true })
  // Ring order starts after the active key.
  evidence['a:claude'] = true
  evidence['c:claude'] = true
  assert.equal(pickKeyForModel('claude', usable[1], usable, covers).id, 'c')
  assert.equal(pickKeyForModel('claude', undefined, usable, covers), undefined)
})
