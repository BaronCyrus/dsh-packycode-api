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
const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (_match, name) => String(values[name]))
const AVAILABLE_AT = Date.parse('2026-10-18T19:16:25.489Z')

/** The built settings page against a channel whose update answers with `updateResult`. */
async function versionFixture(t, updateResult) {
  const answers = {
    status: () => ({ activeId: null, writable: true, hosts: {}, defaults: {}, keys: [] }),
    balance: () => ({ fetchedAt: 1, keys: [] }),
    groups: () => ({ keys: [], descriptions: {} }),
    'plugin/version': () => ({ current: '1.3.2', latest: '1.3.3', updateAvailable: true, install: { kind: 'npm', profile: 'desktop' }, fetchedAt: 1 }),
    'plugin/update': () => updateResult,
  }
  const rpc = { async call(channel, endpoint, payload) {
    assert.equal(channel, '/packycode-api')
    const answer = answers[endpoint]
    return answer === undefined
      ? { ok: false, error: { code: 'packycode/request-failed', message: 'PackyCode fixture: not under test', details: {} } }
      : { ok: true, value: structuredClone(answer(payload)) }
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
  const card = () => root.root.find(node => node.type === 'section'
    && node.findAll(child => child.type === 'h3' && text(child) === zh.versionTitle).length === 1)
  const updateButton = () => card().findAll(node => node.type === 'button' && text(node) === zh.versionUpdate)
  return {
    card,
    updateButton,
    async update() {
      await act(async () => updateButton()[0].props.onClick())
      await settle()
    },
  }
}

test('an update pnpm still holds back says when it can run and keeps the button', async t => {
  const page = await versionFixture(t, { version: '1.3.3', profile: 'desktop', pending: true, availableAt: AVAILABLE_AT })
  await page.update()
  const time = new Date(AVAILABLE_AT).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  assert.ok(text(page.card()).includes(fill(zh.versionCoolingUntil, { version: '1.3.3', time })))
  assert.equal(text(page.card()).includes(fill(zh.versionUpdated, { version: '1.3.3' })), false)
  assert.equal(text(page.card()).includes(zh.versionUpdateFailed), false)
  assert.equal(page.updateButton().length, 1, 'the update can be tried again once the wait is over')
})

test('a hold-back without a known time still reads as a wait, not a failure', async t => {
  const page = await versionFixture(t, { version: '1.3.3', profile: 'desktop', pending: true })
  await page.update()
  assert.ok(text(page.card()).includes(fill(zh.versionCooling, { version: '1.3.3' })))
  assert.equal(text(page.card()).includes(zh.versionUpdateFailed), false)
})

test('a completed update still reports the installed version', async t => {
  const page = await versionFixture(t, { version: '1.3.3', profile: 'desktop' })
  await page.update()
  assert.ok(text(page.card()).includes(fill(zh.versionUpdated, { version: '1.3.3' })))
  assert.equal(text(page.card()).includes(fill(zh.versionCooling, { version: '1.3.3' })), false)
})

test('an install source still syncing reads as a wait, naming the source', async t => {
  const page = await versionFixture(t, { version: '1.3.3', profile: 'desktop', failed: 'syncing', registry: 'registry.npmmirror.com' })
  await page.update()
  const body = text(page.card())
  assert.ok(body.includes(fill(zh.versionUpdateSyncingFrom, { version: '1.3.3', registry: 'registry.npmmirror.com' })))
  assert.equal(body.includes(zh.versionUpdateFailed), false)
  assert.equal(page.card().findAll(node => node.props?.role === 'alert').length, 0, 'a wait is not an alert')
  assert.equal(page.updateButton().length, 1, 'the button stays for the next try')
})

test('an unreachable install source asks to check the network', async t => {
  const page = await versionFixture(t, { version: '1.3.3', profile: 'desktop', failed: 'unreachable' })
  await page.update()
  const body = text(page.card())
  assert.ok(body.includes(fill(zh.versionUpdateUnreachable, { version: '1.3.3' })))
  assert.equal(body.includes(zh.versionUpdateFailed), false)
  assert.equal(page.card().findAll(node => node.props?.role === 'alert').length, 1)
})
