import assert from 'node:assert/strict'
import test from 'node:test'

import { readAutoReviewChoice } from '../src/auto-review-controller.js'
import { PackyCodeKeyRing } from '../src/key-ring.js'
import { createPackyCodeRpc } from '../src/rpc.js'
import { createSearchController } from '../src/search-controller.js'
import { fakeCredentials } from './helpers.mjs'
import { Config } from '../src/index.js'
import { fieldValue } from '../src/preferences.js'

test('search settings declare volatile fields accepted by DSH 0.2', () => {
  for (const field of ['searchProvider', 'searchBackend']) {
    assert.equal(Config.dict[field].meta.volatile, true, `${field}: DSH 0.2 otherwise rejects settings.update with no volatile fields`)
  }
})

/** DSH 0.2 Connection's failure contract, after a JSON wire round trip. */
function connectionFailure(result) {
  const wire = JSON.parse(JSON.stringify(result))
  assert.equal(wire.ok, false)
  assert.equal(typeof wire.error.code, 'string', 'DSH requires error.code; otherwise invalid server-response failure')
  assert.equal(typeof wire.error.message, 'string')
  assert.deepEqual(wire.error.details, {}, 'DSH requires error.details; diagnostics must carry no secrets')
  return wire.error
}

test('a failed Auto search setting is a valid Connection failure, preserving its safe explanation', async () => {
  const search = createSearchController({
    ring: new PackyCodeKeyRing(fakeCredentials()),
    hosts: () => ({}),
    readPreference: () => ({}),
    isWritable: () => true,
    writePreference: async () => { throw new Error('storage fixture refused the write') },
  })
  const rpc = createPackyCodeRpc({ search })
  const error = connectionFailure(await rpc('search/update', { searchProvider: 'auto' }))
  assert.equal(error.message, 'PackyCode could not save the web search preference')
})

test('unknown endpoints and unavailable services also satisfy the Connection failure contract', async () => {
  const rpc = createPackyCodeRpc({})
  for (const endpoint of ['unknown', 'search/status', 'models/status', 'plugin/version', 'status']) {
    connectionFailure(await rpc(endpoint))
  }
})

test('an unexpected storage failure never places upstream diagnostics in the envelope', async () => {
  const secret = 'sk-fixture-secret-not-a-real-key'
  const rpc = createPackyCodeRpc({ ring: { list: async () => { throw new Error(secret) } } })
  const result = await rpc('status')
  assert.equal(connectionFailure(result).message, 'PackyCode request failed')
  assert.equal(JSON.stringify(result).includes(secret), false)
})

test('clearing every key through the channel answers the empty status', async () => {
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add('sk-fixture-clear-all-0001')
  await ring.add('sk-fixture-clear-all-0002')
  const invalidated = []
  const rpc = createPackyCodeRpc({
    ring,
    balance: { invalidate: () => invalidated.push('balance') },
    groups: { invalidate: () => invalidated.push('groups') },
    hosts: () => ({}),
    preference: { writable: true },
  })
  const result = await rpc('keys/remove-all', {})
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.value.keys, [])
  assert.deepEqual(invalidated, ['balance', 'groups'])
})

test('a credential store failure reaches the panel as the ring\'s own sentence', async () => {
  const ring = new PackyCodeKeyRing({ readRecord: async () => undefined, modifyRecord: async () => { throw new TypeError('credentials-local: record payload holds a value JSON cannot represent') } })
  const rpc = createPackyCodeRpc({ ring, balance: { invalidate() {} }, hosts: () => ({}), preference: {} })
  assert.equal(connectionFailure(await rpc('keys/remove-all', {})).message, 'PackyCode could not save the key change in DSH\'s credential store')
})

test('the auto review setting is volatile, defaults to jev-1.14.0, and keeps jev-latest as a retired choice', () => {
  assert.equal(Config.dict.autoReviewModel.meta.volatile, true)
  assert.equal(Object.hasOwn(Config.dict, 'autoReview'), false, 'DSH\'s own plugin switches auto review on and off')
  assert.equal(fieldValue(Config({}).autoReviewModel), 'jev-1.14.0')
  for (const model of ['deepseek-flash', 'session']) assert.equal(fieldValue(Config({ autoReviewModel: model }).autoReviewModel), model)
  // A saved jev-latest still parses (dropping it would fail the plugin Config) and reads as the versioned model.
  const retired = Config({ autoReviewModel: 'jev-latest' })
  assert.equal(fieldValue(retired.autoReviewModel), 'jev-latest')
  assert.deepEqual(readAutoReviewChoice(retired), { model: 'jev-1.14.0' })
  const offered = Config.dict.autoReviewModel.list.filter(item => item.meta?.hidden !== true).map(item => item.value)
  assert.deepEqual(offered, ['jev-1.14.0', 'deepseek-flash', 'session'])
  assert.throws(() => Config({ autoReviewModel: 'gpt-6.1-sol' }))
})

test('the auto review endpoints pass only their own fields, and a refusal is a valid Connection failure', async () => {
  const seen = []
  const autoReview = {
    status: () => ({ model: 'jev-1.14.0' }),
    update: async patch => {
      seen.push(patch)
      if (patch.autoReviewModel === 'gpt-6.1-sol') throw new Error('That PackyCode auto review model is not supported')
      return { model: patch.autoReviewModel ?? 'jev-1.14.0' }
    },
  }
  const rpc = createPackyCodeRpc({ autoReview })
  assert.deepEqual(await rpc('auto-review/status', {}), { ok: true, value: { model: 'jev-1.14.0' } })
  const saved = await rpc('auto-review/update', { autoReviewModel: 'deepseek-flash', apiKey: 'sk-ignored' })
  assert.deepEqual(saved.value, { model: 'deepseek-flash' })
  assert.deepEqual(seen, [{ autoReviewModel: 'deepseek-flash' }])
  const error = connectionFailure(await rpc('auto-review/update', { autoReviewModel: 'gpt-6.1-sol' }))
  assert.equal(error.message, 'That PackyCode auto review model is not supported')
  // A runtime without the controller refuses with the plugin's own sentence.
  const bare = connectionFailure(await createPackyCodeRpc({})('auto-review/status', {}))
  assert.equal(bare.message, 'PackyCode auto review is unavailable in this runtime')
})
