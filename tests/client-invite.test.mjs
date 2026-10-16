import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import * as react from 'react'
import * as jsx from 'react/jsx-runtime'
import TestRenderer from 'react-test-renderer'

import { zh } from '../src/client-copy.js'

const { act, create } = TestRenderer
const settle = () => act(async () => { await new Promise(resolve => setImmediate(resolve)) })
const text = node => typeof node === 'string' ? node : node.children.map(text).join('')

const INVITE_URL = 'https://www.packyapi.ai/register?aff=Im3l'
const STORED = { id: 'chat-a', label: 'Chat main', addedAt: 1, active: true, disabled: false }

/**
 * The built settings page against a channel holding `keys` (or failing its
 * status read), with `keys/add` storing one more key and `keys/remove-all`
 * emptying the ring (or failing in the host's words) the way the host does.
 */
async function accountsFixture(t, { keys = [], statusFails = false, removeAllFails = false } = {}) {
  let chat = { activeId: keys[0]?.id ?? null, writable: true, hosts: {}, defaults: {}, keys }
  const answers = {
    status: () => {
      if (statusFails) throw new Error('fixture: status unavailable')
      return chat
    },
    balance: () => ({ activeId: chat.activeId, fetchedAt: 1, keys: [] }),
    groups: () => ({ keys: [], descriptions: {} }),
    'keys/add': payload => (chat = { ...chat, activeId: 'chat-new', keys: [...chat.keys, { id: 'chat-new', label: payload.label || 'Key 1', addedAt: 2, active: true, disabled: false }] }),
    'keys/remove-all': () => {
      if (removeAllFails) throw new Error('PackyCode could not save the key change in DSH\'s credential store')
      return (chat = { ...chat, activeId: undefined, keys: [] })
    },
  }
  const endpoints = []
  const rpc = { async call(channel, endpoint, payload) {
    endpoints.push(endpoint)
    assert.equal(channel, '/packycode-api')
    const answer = answers[endpoint]
    if (answer === undefined) return { ok: false, error: { code: 'packycode/request-failed', message: 'PackyCode fixture: not under test', details: {} } }
    try {
      return { ok: true, value: structuredClone(answer(payload)) }
    } catch (error) {
      const message = error.message.startsWith('PackyCode') ? error.message : 'PackyCode request failed'
      return { ok: false, error: { code: 'packycode/request-failed', message, details: {} } }
    }
  } }
  let client
  const slots = new Map()
  const window = {
    __ModuleLoader__: { load(spec) { client = spec.factory(name => name === 'react' ? react : jsx) } },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window, Event: class { constructor(type) { this.type = type } },
    document: { head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) },
  })
  client.apply({
    locale: { register() {}, bind: () => key => zh[key] }, effect: fn => fn(),
    get: name => name === 'connection' ? { rpc } : undefined, inject() {},
    slots: { inject: (_name, fn) => fn(), register(spec, component) { slots.set(spec.id ?? spec.key, { spec, component }) } },
  })
  const section = slots.get('packycode-api')
  let root
  await act(async () => { root = create(react.createElement(section.component, section.spec.inject())) })
  await settle()
  t.after(() => act(async () => root.unmount()))
  const accounts = () => root.root.find(node => node.type === 'section'
    && node.findAll(child => child.type === 'h3' && text(child) === zh.accountsTitle).length === 1)
  return {
    accounts,
    endpoints,
    headings: () => root.root.findAll(node => node.type === 'h3').map(text),
    invites: () => root.root.findAll(node => node.type === 'a' && node.props.href === INVITE_URL),
    alerts: () => accounts().findAll(node => node.props.role === 'alert').map(text),
    async removeAll() {
      const button = accounts().find(node => node.type === 'button' && text(node) === zh.removeAll)
      await act(async () => button.props.onClick())
      await settle()
    },
    async addKey(value) {
      const card = accounts()
      const input = card.find(node => node.type === 'input' && node.props.type === 'password')
      await act(async () => input.props.onChange({ target: { value } }))
      await act(async () => card.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }))
      await settle()
    },
  }
}

test('the built settings page retains native controls without a CLI card or detection requests', async t => {
  const page = await accountsFixture(t)
  for (const endpoint of ['status', 'images/status', 'models/status', 'search/status', 'plugin/version']) {
    assert.ok(page.endpoints.includes(endpoint), endpoint)
  }
  assert.equal(page.endpoints.some(endpoint => endpoint.startsWith('claude-cli/')), false)
  assert.equal(page.headings().some(heading => /Claude Code|CLI|委派/u.test(heading)), false)
})

test('a profile with no stored key is offered the registration invite, opening outside DSH', async t => {
  const page = await accountsFixture(t)
  const [link] = page.invites()
  assert.ok(link, 'the invite link is shown while no key is stored')
  assert.equal(page.invites().length, 1, 'one invite on the whole page')
  assert.equal(link.props.target, '_blank', 'a new-window link: DSH desktop hands it to the system browser')
  assert.deepEqual(link.props.rel.split(' ').sort(), ['noopener', 'noreferrer'])
  assert.equal(text(link), zh.inviteLink)
  const paragraph = page.accounts().find(node => node.type === 'p' && node.findAll(child => child === link).length === 1)
  assert.ok(text(paragraph).startsWith(zh.inviteLead), 'the link is introduced as a way to register')
})

test('a stored key hides the invite', async t => {
  const page = await accountsFixture(t, { keys: [STORED] })
  assert.equal(page.invites().length, 0)
})

test('an unreadable status shows no invite, since stored keys are unknown', async t => {
  const page = await accountsFixture(t, { statusFails: true })
  assert.equal(page.invites().length, 0)
})

test('adding the first key removes the invite at once', async t => {
  const page = await accountsFixture(t)
  assert.equal(page.invites().length, 1)
  await page.addKey('sk-fixture-not-a-real-key')
  assert.equal(page.invites().length, 0)
})

test('clearing every key empties the list and brings the invite back', async t => {
  const page = await accountsFixture(t, { keys: [STORED] })
  await page.removeAll()
  assert.deepEqual(page.alerts(), [])
  assert.ok(text(page.accounts()).includes(zh.empty), 'the empty-state note replaces the key list')
  assert.equal(page.invites().length, 1)
})

test('a refused key change is reported as a failed update, not as a failed status read', async t => {
  const page = await accountsFixture(t, { keys: [STORED], removeAllFails: true })
  await page.removeAll()
  assert.deepEqual(page.alerts(), [`${zh.saveError}: PackyCode could not save the key change in DSH's credential store`])
  assert.ok(text(page.accounts()).includes(STORED.label), 'the keys stay listed')
  assert.equal(page.invites().length, 0)
})
