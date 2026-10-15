import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import * as react from 'react'
import * as jsx from 'react/jsx-runtime'
import TestRenderer from 'react-test-renderer'

import { zh } from '../src/client-copy.js'

const { act, create } = TestRenderer
const enabled = () => ({ imageEnabled: true, available: true, activeId: 'image-b', keys: [{ id: 'image-a' }, { id: 'image-b', active: true }] })
const balance = () => ({ activeId: 'image-b', fetchedAt: 1000, keys: [
  { id: 'image-a', label: 'Other image key', usage: { availableUsd: 500, usedUsd: 0 } },
  { id: 'image-b', label: 'Current image key', usage: { name: 'Image account', availableUsd: 85.21, usedUsd: 14.79, resetPeriod: 'never' } },
] })

function fixture(options = {}) {
  let current = { current: { provider: options.provider ?? 'packycode', model: 'claude-haiku-5-5' } }
  let status = options.status ?? enabled()
  let quota = balance()
  let failure = false
  const subscribers = new Set(), listeners = new Map(), timers = new Map(), slots = new Map(), calls = [], drafts = []
  let nextTimer = 0, client, root
  const directory = { getSnapshot: () => current, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener) } }
  const rpc = { async call(channel, endpoint, payload) {
    assert.equal(channel, '/packycode-api')
    calls.push({ endpoint, payload })
    if (endpoint === 'images/status') return { ok: true, value: await (options.readStatus ? options.readStatus() : status) }
    assert.equal(endpoint, 'images/balance', 'the shortcut must read only the dedicated image balance')
    if (failure) throw new Error('Fixture RPC unavailable')
    return { ok: true, value: await (options.readBalance ? options.readBalance() : quota) }
  } }
  const window = { __ModuleLoader__: { load(spec) { client = spec.factory(name => name === 'react' ? react : jsx) } },
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener) },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener) },
    setInterval(fn, ms) { assert.equal(ms, 60_000); timers.set(++nextTimer, fn); return nextTimer },
    clearInterval(id) { timers.delete(id) },
  }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window, document: { head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) },
  })
  const ctx = {
    locale: { register() {}, bind: () => key => zh[key] }, effect: fn => fn(),
    get: name => ({ connection: { rpc }, sessions: { scope: () => ({}) }, conversation: { input: { for: () => ({
      state: { getSnapshot: () => ({ phase: 'plain', draft: '', occurrences: [] }) }, setDraft: text => drafts.push(text),
    }) } } })[name],
    modelDirectories: { directoryFor: () => ({ store: directory }) },
    inject(names, fn) { if (names.includes('sessions') && names.includes('conversation')) fn(ctx) },
    slots: { inject: (_name, fn) => fn(), register(spec, component) { slots.set(spec.id ?? spec.key, { spec, component }) } },
  }
  client.apply(ctx)
  const entry = slots.get('packycode-image-create')
  const dispatch = () => { for (const listener of [...(listeners.get('packycode-images-updated') ?? [])]) listener() }
  return {
    calls, timers, drafts,
    async mount() { await act(async () => { root = create(react.createElement(entry.component, entry.spec.inject('image-session'))) }) },
    async close() { await act(async () => { root?.unmount() }) },
    async provider(provider) { await act(async () => { current = { current: { provider } }; for (const listener of subscribers) listener() }) },
    async update(value = status) { status = value; await act(async () => dispatch()) },
    setBalance(value) { quota = value },
    fail(value = true) { failure = value },
    async tick() { await act(async () => { for (const fn of [...timers.values()]) fn() }) },
    rendered: () => root.toJSON(),
    buttons: () => root.root.findAllByType('button'),
    amount: () => root.root.findAll(node => node.props.className === 'pkc-composer pkc-quota-value'),
    tooltip: () => root.root.findAll(node => node.props.role === 'tooltip'),
  }
}

test('the built Create image shortcut shows the current image key balance immediately to its right with quota details', async t => {
  const fx = fixture(); t.after(() => fx.close()); await fx.mount()
  assert.equal(fx.buttons().length, 1)
  assert.equal(fx.amount().length, 1)
  assert.match(fx.amount()[0].children.join(''), /85\.21/u)
  const details = fx.tooltip()[0].children.join('')
  assert.match(details, /Current image key/u)
  assert.match(details, /Image account/u)
  assert.match(details, /85\.21/u)
  assert.match(details, /14\.79/u)
  assert.match(details, /100\.00/u)
  assert.doesNotMatch(details, /500\.00/u)
  assert.equal(fx.amount()[0].props['aria-describedby'], fx.tooltip()[0].props.id)
  assert.equal(fx.timers.size, 1)
  await act(async () => fx.buttons()[0].props.onClick())
  assert.match(fx.drafts[0], /packycode_image_generate/u)
  const before = fx.calls.length
  await fx.tick()
  assert.equal(fx.calls.length, before + 1)
  assert.equal(fx.calls.at(-1).endpoint, 'images/balance')
})

test('button and balance hide together for inactive providers, disabled images, missing attachment support and missing usable keys', async t => {
  const fx = fixture(); t.after(() => fx.close()); await fx.mount()
  await fx.provider('other-provider')
  assert.equal(fx.rendered(), null)
  assert.equal(fx.timers.size, 0)
  const before = fx.calls.length
  await fx.tick()
  assert.equal(fx.calls.length, before)
  await fx.provider('packycode')
  assert.equal(fx.amount().length, 1)
  for (const patch of [{ imageEnabled: false }, { available: false }, { keys: [] }, { keys: [{ id: 'image-a', disabled: true }] }]) {
    await fx.update({ ...enabled(), ...patch })
    assert.equal(fx.rendered(), null)
    assert.equal(fx.timers.size, 0)
    const reads = fx.calls.length
    await fx.tick()
    assert.equal(fx.calls.length, reads)
    await fx.update(enabled())
    assert.equal(fx.amount().length, 1)
    assert.equal(fx.timers.size, 1)
  }
})

test('image balance updates after key changes and reports stale, unreadable and unlimited quota without hiding a usable button', async t => {
  const fx = fixture(); t.after(() => fx.close()); await fx.mount()
  fx.fail(); await fx.tick()
  assert.match(fx.amount()[0].children.join(''), /≈.*85\.21/u)
  assert.match(fx.tooltip()[0].children.join(''), /上次读取于/u)
  assert.equal(fx.buttons().length, 1)
  fx.fail(false)
  fx.setBalance({ activeId: 'image-c', fetchedAt: 2000, keys: [{ id: 'image-c', label: 'New image key', usage: { availableUsd: 20, usedUsd: 5 } }] })
  await fx.update({ ...enabled(), activeId: 'image-c', keys: [{ id: 'image-c', active: true }] })
  assert.match(fx.amount()[0].children.join(''), /20\.00/u)
  assert.match(fx.tooltip()[0].children.join(''), /New image key/u)
  assert.doesNotMatch(fx.tooltip()[0].children.join(''), /Current image key/u)
  assert.equal(fx.calls.at(-1).payload.force, true)
  fx.setBalance({ activeId: 'image-c', keys: [{ id: 'image-c', error: 'balance unavailable' }] }); await fx.tick()
  assert.equal(fx.amount()[0].children.join(''), '—')
  assert.equal(fx.buttons().length, 1)
  fx.setBalance({ activeId: 'image-c', keys: [{ id: 'image-c', usage: { unlimitedQuota: true, usedUsd: 5 } }] }); await fx.tick()
  assert.match(fx.amount()[0].children.join(''), /不限额度/u)
})

test('a late image balance response cannot restore the shortcut or its refresh timer after a provider switch', async t => {
  let resolve
  const pending = new Promise(done => { resolve = done })
  const fx = fixture({ readBalance: () => pending }); t.after(() => fx.close()); await fx.mount()
  assert.equal(fx.amount().length, 1)
  await fx.provider('other-provider')
  assert.equal(fx.rendered(), null)
  assert.equal(fx.timers.size, 0)
  await act(async () => resolve(balance()))
  assert.equal(fx.rendered(), null)
  assert.equal(fx.timers.size, 0)
})

test('an older image-status response cannot restore a button and balance hidden by a newer setting', async t => {
  let resolveOlder, reads = 0
  const older = new Promise(resolve => { resolveOlder = resolve })
  const fx = fixture({ readStatus() {
    reads += 1
    return reads === 1 ? enabled() : reads === 2 ? older : { ...enabled(), imageEnabled: false }
  } })
  t.after(() => fx.close()); await fx.mount()
  await fx.update()
  await fx.update()
  assert.equal(fx.rendered(), null)
  assert.equal(fx.timers.size, 0)
  await act(async () => resolveOlder(enabled()))
  assert.equal(fx.rendered(), null)
  assert.equal(fx.timers.size, 0)
})
