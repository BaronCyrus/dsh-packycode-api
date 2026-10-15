import assert from 'node:assert/strict'
import test from 'node:test'

import { PackyCodeKeyRing } from '../src/key-ring.js'
import { createPackyCodeRpc } from '../src/rpc.js'
import { createSearchController } from '../src/search-controller.js'
import { fakeCredentials } from './helpers.mjs'
import { Config } from '../src/index.js'

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
