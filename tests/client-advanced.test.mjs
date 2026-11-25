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
const text = node => (typeof node === 'string' ? node : node.children.map(text).join(''))
const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (match, name) => (values[name] === undefined ? match : String(values[name])))

async function advancedFixture(t, initial = {}) {
  const calls = []
  let current = {
    writable: true,
    maxRetries: 20,
    streamIdleTimeoutMs: 600_000,
    defaults: { maxRetries: 20, streamIdleTimeoutMs: 600_000 },
    limits: { maxRetries: { min: 0, max: 100 }, streamIdleTimeoutMs: { min: 30_000, max: 3_600_000 } },
    ...initial,
  }
  const answers = {
    status: () => ({ activeId: null, writable: true, hosts: {}, defaults: {}, keys: [] }),
    balance: () => ({ activeId: null, fetchedAt: 1, keys: [] }),
    groups: () => ({ keys: [], descriptions: {} }),
    'route/status': () => current,
    'route/update': payload => {
      current = {
        ...current,
        ...(payload.maxRetries === undefined ? {} : { maxRetries: payload.maxRetries }),
        ...(payload.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: payload.streamIdleTimeoutMs }),
      }
      return current
    },
  }
  const rpc = {
    async call(channel, endpoint, payload) {
      assert.equal(channel, '/packycode-api')
      calls.push({ endpoint, payload: structuredClone(payload) })
      const answer = answers[endpoint]
      return answer === undefined
        ? { ok: false, error: { code: 'packycode/request-failed', message: 'PackyCode fixture: not under test', details: {} } }
        : { ok: true, value: structuredClone(answer(payload)) }
    },
  }
  let client
  const slots = new Map()
  const window = {
    __ModuleLoader__: { load(spec) { client = spec.factory(name => (name === 'react' ? react : jsx)) } },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window,
    Event: class { constructor(type) { this.type = type } },
    document: { head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) },
    navigator: {},
  })
  client.apply({
    locale: { register() {}, bind: () => key => zh[key] },
    effect: fn => fn(),
    get: name => (name === 'connection' ? { rpc } : undefined),
    inject() {},
    slots: { inject: (_name, fn) => fn(), register(spec, component) { slots.set(spec.id ?? spec.key, { spec, component }) } },
  })
  const section = slots.get('packycode-api')
  let root
  await act(async () => { root = create(react.createElement(section.component, section.spec.inject())) })
  await settle()
  t.after(() => act(async () => root.unmount()))
  const card = () => root.root.find(node => node.type === 'section'
    && node.findAll(child => child.type === 'h3' && text(child) === zh.routeTitle).length === 1)
  return {
    calls,
    card,
    details: () => card().findByType('details'),
    summary: () => card().findByType('summary'),
    retriesInput: () => card().find(node => node.type === 'input' && node.props.id === 'pkc-route-retries'),
    timeoutInput: () => card().find(node => node.type === 'input' && node.props.id === 'pkc-route-timeout'),
    alerts: () => card().findAll(node => node.props.role === 'alert').map(text),
    async setRetries(value) {
      await act(async () => card().find(node => node.type === 'input' && node.props.id === 'pkc-route-retries').props.onChange({ target: { value: String(value) } }))
      await settle()
    },
    async setTimeoutSeconds(value) {
      await act(async () => card().find(node => node.type === 'input' && node.props.id === 'pkc-route-timeout').props.onChange({ target: { value: String(value) } }))
      await settle()
    },
    async save() {
      await act(async () => card().findByType('form').props.onSubmit({ preventDefault() {} }))
      await settle()
    },
    async reset() {
      const button = card().find(node => node.type === 'button' && text(node) === zh.routeReset)
      await act(async () => button.props.onClick())
      await settle()
    },
  }
}

test('the advanced card renders collapsed by default and shows the current retry and timeout summary', async t => {
  const page = await advancedFixture(t)
  assert.equal(page.details().props.open, undefined, 'collapsed by default')
  const summaryText = text(page.summary())
  assert.ok(summaryText.includes(zh.routeTitle))
  assert.ok(summaryText.includes(fill(zh.routeSummary, { retries: 20, seconds: 600 })))
  assert.equal(summaryText.includes(zh.routeCustomized), false)
  assert.equal(page.retriesInput().props.value, '20')
  assert.equal(page.timeoutInput().props.value, '600')
})

test('saving custom retry and timeout values updates the host in milliseconds and reset restores defaults', async t => {
  const page = await advancedFixture(t)
  await page.setRetries(12)
  await page.setTimeoutSeconds(300)
  await page.save()

  assert.deepEqual(page.calls.filter(call => call.endpoint === 'route/update').map(call => call.payload), [
    { maxRetries: 12, streamIdleTimeoutMs: 300_000 },
  ])
  assert.ok(text(page.summary()).includes(zh.routeCustomized))
  assert.ok(text(page.summary()).includes(fill(zh.routeSummary, { retries: 12, seconds: 300 })))
  assert.ok(text(page.card()).includes(zh.routeSaved))

  await page.reset()
  assert.deepEqual(page.calls.filter(call => call.endpoint === 'route/update').map(call => call.payload), [
    { maxRetries: 12, streamIdleTimeoutMs: 300_000 },
    { maxRetries: 20, streamIdleTimeoutMs: 600_000 },
  ])
  assert.equal(text(page.summary()).includes(zh.routeCustomized), false)
  assert.equal(page.retriesInput().props.value, '20')
  assert.equal(page.timeoutInput().props.value, '600')
})

test('out-of-range inputs report a validation alert without calling route/update', async t => {
  const page = await advancedFixture(t)
  await page.setRetries(101)
  await page.save()
  assert.equal(page.calls.filter(call => call.endpoint === 'route/update').length, 0)
  assert.ok(page.alerts()[0]?.includes(fill(zh.routeRetriesRange, { min: 0, max: 100 })))

  await page.setRetries(10)
  await page.setTimeoutSeconds(10)
  await page.save()
  assert.equal(page.calls.filter(call => call.endpoint === 'route/update').length, 0)
  assert.ok(page.alerts()[0]?.includes(fill(zh.routeTimeoutRange, { min: 30, max: 3600 })))
})
