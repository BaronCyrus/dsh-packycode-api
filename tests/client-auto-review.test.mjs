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
const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (match, name) => values[name] === undefined ? match : String(values[name]))

const MODELS = [{ id: 'jev-latest', name: 'jev-latest' }, { id: 'deepseek-flash', name: 'DeepSeek Flash' }]

/** The built settings page against a channel that answers the auto review endpoints. */
async function reviewFixture(t, status, groups = { keys: [], descriptions: {} }) {
  const calls = []
  let current = { enabled: true, model: 'jev-latest', models: MODELS, writable: true, available: true, offered: true, counts: { reviewed: 0, allowed: 0, asked: 0, denied: 0, failed: 0 }, ...status }
  const answers = {
    status: () => ({ activeId: null, writable: true, hosts: {}, defaults: {}, keys: [] }),
    balance: () => ({ activeId: null, fetchedAt: 1, keys: [] }),
    groups: () => groups,
    'auto-review/status': () => current,
    'auto-review/update': payload => {
      current = {
        ...current,
        ...(payload.autoReview === undefined ? {} : { enabled: payload.autoReview, offered: payload.autoReview }),
        ...(payload.autoReviewModel === undefined ? {} : { model: payload.autoReviewModel }),
      }
      return current
    },
  }
  const rpc = { async call(channel, endpoint, payload) {
    assert.equal(channel, '/packycode-api')
    calls.push({ endpoint, payload: structuredClone(payload) })
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
    navigator: {},
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
    && node.findAll(child => child.type === 'h3' && text(child) === zh.reviewTitle).length === 1)
  const radio = label => card().find(node => node.type === 'button' && node.props.role === 'radio' && text(node) === label)
  return {
    calls,
    card,
    radio,
    pick: async label => { await act(async () => radio(label).props.onClick()); await settle() },
  }
}

test('the card says 自动审查 is offered, which reviewer runs it, and what it has done', async t => {
  const page = await reviewFixture(t, {
    counts: { reviewed: 5, allowed: 3, asked: 1, denied: 0, failed: 1 },
    last: { at: 1, outcome: 'asked', model: 'jev-latest', tool: 'bash', ms: 352, risk: 'medium' },
  })
  const body = text(page.card())
  assert.ok(body.includes(zh.reviewOffered))
  assert.ok(body.includes(zh.reviewIntro))
  assert.ok(body.includes(zh.reviewModelJevHint))
  assert.ok(body.includes(fill(zh.reviewCounts, { reviewed: 5, allowed: 3, asked: 1, denied: 0, failed: 1 })))
  assert.ok(body.includes(fill(zh.reviewLast, { tool: 'bash', outcome: zh.reviewOutcomeAsked, model: 'jev-latest', seconds: '0.4' })))
  assert.ok(body.includes(zh.reviewMenuNote), 'the card explains that the menu text is DSH\'s')
  assert.equal(page.radio('jev-latest').props['aria-checked'], true)
  assert.equal(page.radio(zh.reviewMenuOn).props['aria-checked'], true)
})

test('picking a reviewer or hiding the option writes only that preference', async t => {
  const page = await reviewFixture(t, {})
  await page.pick('DeepSeek Flash')
  await page.pick(zh.reviewMenuOff)
  assert.deepEqual(page.calls.filter(call => call.endpoint === 'auto-review/update').map(call => call.payload), [
    { autoReviewModel: 'deepseek-flash' },
    { autoReview: false },
  ])
  const body = text(page.card())
  assert.ok(body.includes(zh.reviewModelFlashHint))
  assert.ok(body.includes(zh.reviewMenuOffHint))
  assert.ok(body.includes(zh.reviewNotOffered))
})

test('the card warns when no key reaches the reviewer, and when DSH\'s own integration holds the option', async t => {
  const uncovered = await reviewFixture(t, {}, {
    keys: [{ id: 'a', groups: ['cc', 'codex'], coverage: { 'jev-latest': false, 'deepseek-flash': true } }],
    descriptions: {},
  })
  assert.ok(text(uncovered.card()).includes(fill(zh.reviewUncovered, { model: 'jev-latest' })))

  const blocked = await reviewFixture(t, { offered: false, blocked: 'dsh-integration' })
  assert.ok(text(blocked.card()).includes(zh.reviewBlockedDsh))
  assert.ok(text(blocked.card()).includes(zh.reviewNotOffered))

  const old = await reviewFixture(t, { offered: false, available: false, blocked: 'unsupported' })
  assert.ok(text(old.card()).includes(zh.reviewUnsupported))
})

test('each key\'s reach line lists Jev', async t => {
  const page = await reviewFixture(t, {})
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /\["Jev", \["jev-latest"\]\]/u)
  assert.ok(page.card())
})
