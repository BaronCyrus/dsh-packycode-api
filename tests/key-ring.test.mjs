import assert from 'node:assert/strict'
import test from 'node:test'

import { PackyCodeKeyRing, assertApiKey } from '../src/key-ring.js'

/** Minimal credential-record service: one in-memory record, serialized writes. */
function fakeCredentials() {
  let record
  let chain = Promise.resolve()
  return {
    async readRecord() {
      return record
    },
    modifyRecord(_key, mutate) {
      const run = chain.then(async () => {
        const next = await mutate(record)
        if (next !== undefined) record = next
        return record
      })
      chain = run.then(() => undefined, () => undefined)
      return run
    },
    /** Test-only view of the stored payload. */
    payload() {
      return record?.payload
    },
  }
}

const KEY_A = 'sk-aaaaaaaaaaaaaaaaaaaa'
const KEY_B = 'sk-bbbbbbbbbbbbbbbbbbbb'
const KEY_C = 'sk-cccccccccccccccccccc'

test('rejects keys the gateway could not carry in a header', () => {
  assert.equal(assertApiKey('  sk-abcdefgh12345678  '), 'sk-abcdefgh12345678')
  assert.throws(() => assertApiKey('short'), /printable ASCII/u)
  assert.throws(() => assertApiKey('sk-with space in it'), /printable ASCII/u)
  assert.throws(() => assertApiKey(''), /printable ASCII/u)
})

test('adds keys in order and keeps the first one active', async () => {
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add(KEY_A, 'primary')
  await ring.add(KEY_B)
  const state = await ring.list()
  assert.equal(state.keys.length, 2)
  assert.equal(state.keys[0].label, 'primary')
  assert.equal(state.keys[1].label, 'Key 2')
  assert.equal(state.activeId, state.keys[0].id)
  assert.equal((await ring.activeKey()).key, KEY_A)
  // The projection never carries key material.
  assert.equal(JSON.stringify(state).includes('sk-'), false)
})

test('refuses a duplicate key', async () => {
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add(KEY_A)
  await assert.rejects(() => ring.add(KEY_A), /already stored/u)
})

test('disabling the active key moves to the next usable one', async () => {
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add(KEY_A)
  await ring.add(KEY_B)
  await ring.add(KEY_C)
  const [a, b] = (await ring.list()).keys

  await ring.disable(a.id, 'quota')
  assert.equal((await ring.activeKey()).key, KEY_B)
  const afterFirst = await ring.list()
  assert.equal(afterFirst.keys[0].disabled, true)
  assert.equal(afterFirst.keys[0].disabledReason, 'quota')

  await ring.disable(b.id, 'invalid-key')
  assert.equal((await ring.activeKey()).key, KEY_C)

  // Re-enabling a key makes it eligible again without stealing the pointer.
  await ring.enable(a.id)
  assert.equal((await ring.activeKey()).key, KEY_C)
})

test('every key disabled leaves no usable key instead of a silent fallback', async () => {
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add(KEY_A)
  const [a] = (await ring.list()).keys
  await ring.disable(a.id, 'quota')
  assert.equal(await ring.activeKey(), undefined)
})

test('select, remove, and removeAll keep the ring consistent', async () => {
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add(KEY_A)
  await ring.add(KEY_B)
  const [a, b] = (await ring.list()).keys

  await ring.select(b.id)
  assert.equal((await ring.list()).activeId, b.id)
  assert.equal((await ring.activeKey()).key, KEY_B)

  await ring.remove(b.id)
  const afterRemove = await ring.list()
  assert.equal(afterRemove.keys.length, 1)
  assert.equal(afterRemove.activeId, a.id)

  await ring.removeAll()
  assert.deepEqual(await ring.list(), { activeId: undefined, keys: [] })
  await assert.rejects(() => ring.select('missing'), /Unknown PackyCode key/u)
})

test('tolerates a hand-edited record instead of failing the route', async () => {
  const credentials = fakeCredentials()
  const ring = new PackyCodeKeyRing(credentials)
  await ring.add(KEY_A)
  const payload = credentials.payload()
  // A record whose activeId names no stored key still serves the first key.
  await credentials.modifyRecord('ignored', async () => ({
    kind: 'grant',
    payload: { ...payload, activeId: 'gone' },
  }))
  assert.equal((await ring.activeKey()).key, KEY_A)
})

test('secrets() is host-side material and marks disabled keys', async () => {
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add(KEY_A)
  const [a] = (await ring.list()).keys
  await ring.disable(a.id, 'quota')
  const secrets = await ring.secrets()
  assert.equal(secrets.length, 1)
  assert.equal(secrets[0].key, KEY_A)
  assert.equal(secrets[0].disabled, true)
})

test('a default label never collides after a removal', async () => {
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add(KEY_A)
  await ring.add(KEY_B)
  const [first] = (await ring.list()).keys
  await ring.remove(first.id)
  // The ring shrank to one key, but "Key 2" is taken: the next name must not repeat it.
  await ring.add(KEY_C)
  const labels = (await ring.list()).keys.map(candidate => candidate.label)
  assert.deepEqual(labels, ['Key 2', 'Key 3'])
  assert.equal(new Set(labels).size, labels.length)
})

test('an explicit label is kept verbatim and may repeat', async () => {
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add(KEY_A, '战魂铭人-张洋凡')
  await ring.add(KEY_B, '战魂铭人-张洋凡')
  const labels = (await ring.list()).keys.map(candidate => candidate.label)
  assert.deepEqual(labels, ['战魂铭人-张洋凡', '战魂铭人-张洋凡'])
})
