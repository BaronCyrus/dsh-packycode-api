import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { stringify } from 'yaml'

import { PackyCodeKeyRing } from '../src/key-ring.js'
import { createImageController, readImagePreference } from '../src/image-settings.js'
import { createPackyCodeRpc } from '../src/rpc.js'
import { createBalanceReader } from '../src/balance.js'
import { readStoredKey } from '../scripts/stored-key.mjs'
import { apply } from '../src/index.js'

function credentials() {
  const records = new Map()
  let pending = Promise.resolve()
  return {
    records,
    readRecord: async key => records.get(key),
    modifyRecord(key, mutate) {
      const result = pending.then(async () => { const value = await mutate(records.get(key)); records.set(key, value); return value })
      pending = result.catch(() => undefined)
      return result
    },
  }
}

function setup({ createImageBalance } = {}) {
  const store = credentials()
  const ring = new PackyCodeKeyRing(store)
  const imageRing = new PackyCodeKeyRing(store, { recordId: 'image-keys' })
  const imageBalance = createImageBalance?.(imageRing)
  let preference = {}
  let writable = true
  const updates = []
  const images = createImageController({ ring: imageRing, balance: imageBalance, readPreference: () => preference, isWritable: () => writable, writePreference: async patch => { updates.push(patch); preference = { ...preference, ...patch } } })
  return { store, ring, imageRing, images, imageBalance, updates, readOnly: () => { writable = false } }
}

test('image balance RPC reads only image keys, skips account billing and follows key changes', async () => {
  const requests = []
  let currentHosts = { statusHost: 'https://status.invalid', apiHost: 'https://api.invalid' }
  const { ring, images } = setup({ createImageBalance: imageRing => createBalanceReader({
    listKeys: () => imageRing.secrets(), getHosts: () => currentHosts, includeAccount: false,
    fetchImpl: async (url, init) => {
      requests.push({ url, auth: init.headers.Authorization })
      assert.equal(new URL(url).pathname, '/api/usage/token/')
      assert.equal(init.redirect, 'error')
      assert.notEqual(init.headers.Authorization, 'Bearer sk-fixture-conversation')
      return { ok: true, json: async () => ({ data: { total_available: 4500000, total_used: 500000, quota_limit: 5000000 } }) }
    },
  }) })
  await ring.add('sk-fixture-conversation')
  await images.mutate('add', { key: 'sk-fixture-image-one', label: 'image one' })
  await images.mutate('add', { key: 'sk-fixture-image-two', label: 'image two' })
  let conversationInvalidated = 0
  const rpc = createPackyCodeRpc({ ring, images, hosts: () => currentHosts,
    preference: { writable: true, set: async patch => { currentHosts = patch } },
    balance: { invalidate: () => { conversationInvalidated += 1 } },
  })
  const first = await rpc('images/balance', { force: true })
  assert.equal(first.ok, true)
  assert.equal(first.value.keys.length, 2)
  assert.equal(first.value.keys[0].usage.availableUsd, 9)
  assert.equal(Object.hasOwn(first.value, 'account'), false)
  assert.equal(JSON.stringify(first).includes('sk-fixture'), false)
  assert.equal(requests.length, 2)
  await rpc('images/balance')
  assert.equal(requests.length, 2)
  const status = await images.status()
  await rpc('images/keys/select', { id: status.keys[1].id })
  assert.equal((await rpc('images/balance')).value.activeId, status.keys[1].id)
  assert.equal(requests.length, 4)
  await rpc('images/keys/remove', { id: status.keys[0].id })
  const remaining = (await rpc('images/balance')).value
  assert.deepEqual(remaining.keys.map(entry => entry.id), [status.keys[1].id])
  assert.equal(requests.length, 5)
  assert.equal(conversationInvalidated, 0)
  await rpc('hosts/update', { statusHost: 'https://updated-status.invalid', apiHost: 'https://api.invalid' })
  await rpc('images/balance')
  assert.equal(requests.at(-1).url, 'https://updated-status.invalid/api/usage/token/')
})

test('image balance RPC forwards force/cancellation and hides unexpected storage failures', async () => {
  let seen
  let failing = false
  const { images } = setup({ createImageBalance: () => ({ invalidate() {}, read: async options => {
    seen = options
    if (failing) throw new Error('PackyCode sk-fixture-image-secret')
    return { keys: [], fetchedAt: 1 }
  } }) })
  const rpc = createPackyCodeRpc({ images })
  const signal = new AbortController().signal
  assert.equal((await rpc('images/balance', { force: true }, signal)).ok, true)
  assert.equal(seen.force, true)
  assert.equal(seen.signal, signal)
  failing = true
  const failure = await rpc('images/balance')
  assert.equal(failure.ok, false)
  assert.equal(failure.error.message, 'PackyCode image balance could not be read')
  assert.equal(JSON.stringify(failure).includes('sk-fixture'), false)
})

test('image credentials are isolated from conversational keys, including selection/removal', async () => {
  const { store, ring, imageRing, images } = setup()
  await ring.add('sk-fixture-conversation', 'chat')
  const original = structuredClone(store.records.get('packycode-api/keys'))
  await images.mutate('add', { key: 'sk-fixture-image', label: 'image' })
  await images.mutate('add', { key: 'sk-fixture-image-two', label: 'image 2' })
  const state = await images.status()
  assert.equal(state.keys.length, 2)
  assert.equal(JSON.stringify(state).includes('sk-fixture'), false)
  await images.mutate('select', { id: state.keys[1].id })
  assert.equal((await imageRing.activeKey()).key, 'sk-fixture-image-two')
  await images.mutate('remove', { id: state.keys[1].id })
  assert.equal((await imageRing.activeKey()).key, 'sk-fixture-image')
  assert.deepEqual(store.records.get('packycode-api/keys'), original)
})

test('tool registration follows key availability and settings without reloading the model route', async () => {
  const { images } = setup()
  let registrations = 0
  let disposals = 0
  const unmount = images.mount(() => { registrations += 1; return () => { disposals += 1 } })
  await images.reconcile()
  assert.equal(registrations, 0)
  await images.mutate('add', { key: 'sk-fixture-image' })
  assert.equal(registrations, 1)
  await images.update({ imageModel: 'gpt-image-2.5-sunburst', imageQuality: 'max' })
  assert.equal(registrations, 1)
  await images.update({ imageEnabled: false })
  assert.equal(disposals, 1)
  await images.update({ imageEnabled: true })
  assert.equal(registrations, 2)
  const state = await images.status()
  await images.mutate('remove', { id: state.keys[0].id })
  assert.equal(disposals, 2)
  unmount()
  assert.equal((await images.status()).available, false)
})

test('quality is checked before writes and switching to Image 2 explicitly resets incompatible quality', async () => {
  const { images, updates, readOnly } = setup()
  assert.deepEqual(readImagePreference(), { imageEnabled: true, imageModel: 'gpt-image-2', imageQuality: 'auto' })
  await assert.rejects(() => images.update({ imageQuality: 'max' }), /not supported/u)
  assert.equal(updates.length, 0)
  await images.update({ imageModel: 'gpt-image-2.5-flare', imageQuality: 'max' })
  await images.update({ imageModel: 'gpt-image-2' })
  assert.deepEqual(updates.at(-1), { imageModel: 'gpt-image-2', imageQuality: 'auto' })
  await assert.rejects(() => images.update({ imageEnabled: 'true' }), /boolean/u)
  readOnly()
  await assert.rejects(() => images.update({ imageEnabled: false }), /not writable/u)
  assert.deepEqual(readImagePreference({ imageModel: { get: () => 'gpt-image-2.5-sunburst' }, imageQuality: { get: () => 'xhigh' } }).imageQuality, 'xhigh')
})

test('image RPC replies contain only projections and do not invalidate conversational state', async () => {
  const { images, ring } = setup()
  await ring.add('sk-fixture-conversation', 'chat')
  let invalidated = 0
  const rpc = createPackyCodeRpc({ ring, images, balance: { invalidate: () => { invalidated += 1 } }, hosts: () => ({}), preference: {} })
  const reply = await rpc('images/keys/add', { key: 'sk-fixture-image', label: 'images' })
  assert.equal(reply.ok, true)
  assert.equal(reply.value.keys[0].label, 'images')
  assert.equal(JSON.stringify(reply).includes('sk-fixture'), false)
  assert.equal((await rpc('status')).value.keys[0].label, 'chat')
  assert.equal(invalidated, 0)
  const rejected = await rpc('images/update', { imageModel: 'gpt-image-2', imageQuality: 'xhigh' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'packycode/request-failed')
})

test('image keys rename through RPC with projection-only replies, a fresh balance label and the chat ring untouched', async () => {
  const { store, ring, imageRing, images } = setup({ createImageBalance: imageRing => createBalanceReader({
    listKeys: () => imageRing.secrets(), getHosts: () => ({ statusHost: 'https://status.invalid' }), includeAccount: false,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: { total_available: 4500000, total_used: 500000 } }) }),
  }) })
  await ring.add('sk-fixture-conversation', 'chat')
  const conversation = structuredClone(store.records.get('packycode-api/keys'))
  let invalidated = 0
  const rpc = createPackyCodeRpc({ ring, images, balance: { invalidate: () => { invalidated += 1 } }, hosts: () => ({}), preference: {} })
  await rpc('images/keys/add', { key: 'sk-fixture-image-one', label: 'image one' })
  await rpc('images/keys/add', { key: 'sk-fixture-image-two' })
  const [first, second] = (await images.status()).keys
  assert.equal((await rpc('images/balance')).value.keys[1].label, 'Key 2')

  const reply = await rpc('images/keys/rename', { id: second.id, label: '  海报 Key  ' })
  assert.equal(reply.ok, true)
  assert.deepEqual(reply.value.keys.map(entry => entry.label), ['image one', '海报 Key'])
  assert.equal(reply.value.activeId, first.id)
  assert.deepEqual(Object.keys(reply.value.keys[1]).sort(), ['active', 'addedAt', 'disabled', 'id', 'label'])
  assert.equal(JSON.stringify(reply).includes('sk-fixture'), false)
  assert.equal((await imageRing.secrets())[1].key, 'sk-fixture-image-two')
  // The rename dropped the cached image balance, so the composer's next unforced read names the key anew.
  const balance = await rpc('images/balance')
  assert.equal(balance.value.keys[1].label, '海报 Key')
  assert.equal(JSON.stringify(balance).includes('sk-fixture'), false)

  const empty = await rpc('images/keys/rename', { id: second.id, label: '   ' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error.message, 'That PackyCode key name cannot be empty')
  const unknown = await rpc('images/keys/rename', { id: 'missing', label: 'x' })
  assert.equal(unknown.error.message, 'Unknown PackyCode key')
  // A conversation key id means nothing to the image ring.
  const chat = (await rpc('status')).value.keys[0]
  assert.equal((await rpc('images/keys/rename', { id: chat.id, label: 'hijack' })).ok, false)
  assert.equal((await rpc('status')).value.keys[0].label, 'chat')
  assert.deepEqual(store.records.get('packycode-api/keys'), conversation)
  assert.equal(invalidated, 0)
})

test('paid image checks read only the image credential record and never fall back to a chat key', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'packycode-image-key-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { store, ring, imageRing } = setup()
  await ring.add('sk-fixture-conversation')
  const filePath = join(dir, 'credentials.yaml')
  const save = () => writeFile(filePath, stringify({ version: 2, records: Object.fromEntries(store.records) }), { mode: 0o600 })
  await save()
  await assert.rejects(() => readStoredKey({ filePath, recordId: 'image-keys' }), /separate image key/u)
  await imageRing.add('sk-fixture-image')
  await save()
  assert.equal(await readStoredKey({ filePath, recordId: 'image-keys' }), 'sk-fixture-image')
  assert.equal(await readStoredKey({ filePath }), 'sk-fixture-conversation')
})

test('apply wires the dedicated image ring, live settings, native tool and removal together', async t => {
  const store = credentials()
  const tools = new Map()
  let handler
  let configuration = {}
  const listeners = new Map()
  const ctx = {
    credentials: store, logger: { warn() {} }, get: () => undefined,
    llm: { registerAdapter: () => () => {}, registerConfigurableProviders() {} },
    on: (event, listener) => listeners.set(event, listener),
    effect: callback => callback(),
    inject(services, callback) {
      if (services.includes('settings')) return callback({ settings: {
        installSection(_ctx, _ns, _schema, _initial, hooks) { hooks.setSource(() => configuration) },
        async update(_ns, patch) { configuration = { ...configuration, ...patch } },
      } })
      if (services.includes('connection')) return callback({ effect: ctx.effect, connection: { rpc: { handle(_channel, value) { handler = value } } } })
      if (services.includes('tools')) return callback({
        tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
        attachments: services.includes('attachments') ? { saveImage() {}, readImage() {} } : undefined,
      })
      callback(ctx)
    },
  }
  apply(ctx)
  await new PackyCodeKeyRing(store).add('sk-fixture-conversation')
  assert.equal((await handler('images/status')).value.keys.length, 0)
  const added = await handler('images/keys/add', { key: 'sk-fixture-image' })
  assert.equal(added.ok, true)
  assert.equal(tools.has('packycode_image_generate'), true)
  const previousFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = previousFetch })
  let balanceCalls = 0
  globalThis.fetch = async (url, init) => {
    balanceCalls += 1
    assert.equal(new URL(url).pathname, '/api/usage/token/')
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer sk-fixture-image')
    return new Response(JSON.stringify({ data: { total_available: 4800000, total_used: 200000 } }))
  }
  const quota = await handler('images/balance', { force: true })
  assert.equal(quota.ok, true)
  assert.equal(quota.value.keys[0].usage.availableUsd, 9.6)
  assert.equal(Object.hasOwn(quota.value, 'account'), false)
  assert.equal(balanceCalls, 1)
  const saved = await handler('images/update', { imageModel: 'gpt-image-2.5-sunburst', imageQuality: 'max' })
  assert.equal(saved.value.imageQuality, 'max')
  await handler('images/update', { imageEnabled: false })
  assert.equal(tools.has('packycode_image_generate'), false)
  assert.equal((await handler('status')).value.keys.length, 1)
})
