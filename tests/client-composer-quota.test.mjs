import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import * as react from 'react'
import * as jsx from 'react/jsx-runtime'
import TestRenderer from 'react-test-renderer'

import { zh } from '../src/client-copy.js'
import { STYLE } from '../src/client-style.js'

const { act, create } = TestRenderer
const settle = () => act(async () => { await new Promise(resolve => setImmediate(resolve)) })
const READ_AT = Date.UTC(2026, 9, 15, 12, 34)
// The bundle formats with the runtime's default locale; so do the expectations.
const usd = value => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value)
const time = ms => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

const chatBalance = () => ({ activeId: 'chat-b', fetchedAt: READ_AT, keys: [
  { id: 'chat-a', label: 'Backup key', usage: { availableUsd: 500, usedUsd: 0 } },
  { id: 'chat-b', label: 'Main key', usage: { name: 'Chat account', availableUsd: 42.5, usedUsd: 7.5, resetPeriod: 'monthly' } },
] })
const imageBalance = () => ({ activeId: 'image-a', fetchedAt: READ_AT, keys: [
  { id: 'image-a', label: 'Poster key', usage: { name: 'Image account', availableUsd: 80, usedUsd: 20, resetPeriod: 'never' } },
] })

/** The composer's PackyCode quota and Create image shortcut from the built bundle, side by side. */
function composerFixture(t) {
  let current = { current: { provider: 'packycode', model: 'deepseek-flash' } }
  let chat = chatBalance()
  let failure = false
  const calls = [], subscribers = new Set(), timers = new Map(), slots = new Map()
  let nextTimer = 0, client, root
  const directory = { getSnapshot: () => current, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener) } }
  const rpc = { async call(channel, endpoint, payload) {
    assert.equal(channel, '/packycode-api')
    calls.push({ endpoint, payload: structuredClone(payload) })
    if (endpoint === 'images/status') return { ok: true, value: { imageEnabled: true, available: true, activeId: 'image-a', keys: [{ id: 'image-a', active: true }] } }
    if (failure) throw new Error('Fixture RPC unavailable')
    if (endpoint === 'balance') return { ok: true, value: structuredClone(chat) }
    assert.equal(endpoint, 'images/balance')
    return { ok: true, value: imageBalance() }
  } }
  const window = { __ModuleLoader__: { load(spec) { client = spec.factory(name => name === 'react' ? react : jsx) } },
    addEventListener() {}, removeEventListener() {},
    setInterval(fn, ms) { assert.equal(ms, 60_000); timers.set(++nextTimer, fn); return nextTimer },
    clearInterval(id) { timers.delete(id) },
  }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window, document: { head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) },
  })
  const ctx = {
    locale: { register() {}, bind: () => key => zh[key] }, effect: fn => fn(),
    get: name => ({ connection: { rpc }, sessions: { scope: () => ({}) }, conversation: { input: { for: () => ({
      state: { getSnapshot: () => ({ phase: 'plain', draft: '', occurrences: [] }) }, setDraft() {},
    }) } } })[name],
    modelDirectories: { directoryFor: () => ({ store: directory }) },
    inject(names, fn) { if (names.includes('sessions') && names.includes('conversation')) fn(ctx) },
    slots: { inject: (_name, fn) => fn(), register(spec, component) { slots.set(spec.id ?? spec.key, { spec, component }) } },
  }
  client.apply(ctx)
  const quota = slots.get('packycode-api-balance'), shortcut = slots.get('packycode-image-create')
  t.after(() => act(async () => root?.unmount()))
  /** One hover: its wrapper, the help-cursor figure, the tooltip and the tooltip's lines. */
  const parts = hover => {
    const [value] = hover.findAll(node => node.props.className === 'pkc-composer pkc-quota-value')
    const [tooltip] = hover.findAll(node => node.props.role === 'tooltip')
    return { hover, value, tooltip, figure: value.children.join(''), lines: tooltip.children.join('').split('\n') }
  }
  const hovers = () => root.root.findAll(node => node.type === 'span' && node.props.className === 'pkc-quota').map(parts)
  return {
    calls, timers,
    async mount() {
      await act(async () => {
        root = create(react.createElement('div', null,
          react.createElement(shortcut.component, shortcut.spec.inject('session')),
          react.createElement(quota.component, quota.spec.inject('session'))))
      })
      await settle()
    },
    /** The image balance renders first (left side), the PackyCode quota last (beside the model). */
    image: () => hovers().find(side => side.lines[0] === zh.imagesComposerLabel),
    chat: () => hovers().find(side => side.lines[0] === zh.composerLabel),
    hovers,
    setChat(value) { chat = value },
    fail(value = true) { failure = value },
    async provider(provider) { await act(async () => { current = { current: { provider } }; for (const listener of subscribers) listener() }) },
    async tick() { await act(async () => { for (const fn of [...timers.values()]) fn() }); await settle() },
  }
}

test('the PackyCode quota beside the model shows the image balance’s help-cursor details, line for line', async t => {
  const fx = composerFixture(t)
  await fx.mount()
  const chat = fx.chat(), image = fx.image()
  assert.equal(chat.figure, usd(42.5))
  assert.deepEqual(chat.lines, [
    zh.composerLabel, `${zh.composerKey}: Main key`, `${zh.keyName}: Chat account`,
    `${zh.keyRemaining}: ${usd(42.5)}`, `${zh.keyUsed}: ${usd(7.5)}`, `${zh.accountLimit}: ${usd(50)}`, `更新于 ${time(READ_AT)}`,
  ])
  assert.deepEqual(image.lines, [
    zh.imagesComposerLabel, `${zh.imagesBalanceKey}: Poster key`, `${zh.keyName}: Image account`,
    `${zh.keyRemaining}: ${usd(80)}`, `${zh.keyUsed}: ${usd(20)}`, `${zh.accountLimit}: ${usd(100)}`, `更新于 ${time(READ_AT)}`,
  ])
  // Same trigger: a focusable help-cursor figure described by a styled tooltip, never the native title.
  for (const side of [chat, image]) {
    assert.equal(side.value.props.role, 'status')
    assert.equal(side.value.props.tabIndex, 0)
    assert.equal(side.value.props['aria-describedby'], side.tooltip.props.id)
    assert.equal(side.value.props.title, undefined)
    assert.equal(side.tooltip.props.className, 'pkc-quota-tooltip')
  }
  assert.equal(chat.value.props['aria-label'], `${zh.composerLabel}: ${usd(42.5)}`)
  // The PackyCode quota sits at the composer's right edge, so its details open leftward.
  assert.equal(chat.hover.props['data-align'], 'end')
  assert.equal(image.hover.props['data-align'], undefined)
  assert.match(STYLE, /\.pkc-quota-value\{cursor:help;/u)
  assert.match(STYLE, /\.pkc-quota:hover>\.pkc-quota-tooltip,\.pkc-quota:focus-within>\.pkc-quota-tooltip\{visibility:visible;opacity:1\}/u)
  assert.match(STYLE, /\.pkc-quota\[data-align=end\]>\.pkc-quota-tooltip\{left:auto;right:0\}/u)
  assert.doesNotMatch(STYLE, /pkc-image-balance/u)

  // Hover and focus ask for the host's cached balance, not a forced gateway read.
  for (const trigger of ['onMouseEnter', 'onFocus']) {
    const before = fx.calls.length
    await act(async () => fx.chat().value.props[trigger]())
    await settle()
    const reads = fx.calls.slice(before)
    assert.deepEqual(reads.map(call => call.endpoint), ['balance'], trigger)
    assert.notEqual(reads[0].payload.force, true)
  }
})

test('stale, unreadable, unlimited and missing conversation balances read the same way as image ones', async t => {
  const fx = composerFixture(t)
  await fx.mount()
  const main = { id: 'chat-b', label: 'Main key' }
  const staleAt = READ_AT - 5 * 60_000
  fx.setChat({ ...chatBalance(), keys: [{ ...chatBalance().keys[1], stale: { fetchedAt: staleAt, error: 'gateway busy' } }] })
  await fx.tick()
  assert.equal(fx.chat().figure, `≈${usd(42.5)}`)
  assert.equal(fx.chat().value.props['aria-label'], `${zh.composerLabel}: ≈${usd(42.5)}`)
  assert.equal(fx.chat().lines.at(-1), `上次读取于 ${time(staleAt)}，本次读取失败`)

  fx.setChat({ activeId: 'chat-b', fetchedAt: READ_AT, keys: [{ ...main, error: 'this API key was rejected (401)' }] })
  await fx.tick()
  assert.equal(fx.chat().figure, zh.composerUnread)
  assert.deepEqual(fx.chat().lines, [
    zh.composerLabel, `${zh.composerKey}: Main key`, `${zh.keyRemaining}: —`, `${zh.keyUsed}: —`, `${zh.accountLimit}: —`, zh.composerUnread,
  ])

  fx.setChat({ activeId: 'chat-b', fetchedAt: READ_AT, keys: [{ ...main, usage: { unlimitedQuota: true, usedUsd: 3 } }] })
  await fx.tick()
  assert.equal(fx.chat().figure, zh.keyUnlimited)
  assert.ok(fx.chat().lines.includes(`${zh.accountLimit}: ${zh.keyUnlimited}`))
  assert.ok(fx.chat().lines.includes(`${zh.keyUsed}: ${usd(3)}`))

  fx.setChat({ activeId: undefined, fetchedAt: READ_AT, keys: [] })
  await fx.tick()
  assert.equal(fx.chat().figure, zh.composerNoKey)
  assert.equal(fx.chat().lines.some(line => line.startsWith(`${zh.composerKey}:`)), false)
})

test('the PackyCode quota still hides for other providers and after a failed read, and stops polling', async t => {
  const fx = composerFixture(t)
  await fx.mount()
  assert.equal(fx.hovers().length, 2)
  await fx.provider('other-provider')
  assert.equal(fx.hovers().length, 0)
  assert.equal(fx.timers.size, 0)
  await fx.provider('packycode')
  await settle()
  assert.ok(fx.chat())
  fx.fail()
  await fx.tick()
  assert.equal(fx.chat(), undefined)
  // The image balance keeps its last figure, marked stale, as before.
  assert.equal(fx.image().figure, `≈${usd(80)}`)
})
