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

const SESSIONS = [
  { id: 'session-new', createdAt: '2026-10-15T13:20:00.000Z', live: true, folder: 'project-a' },
  { id: 'session-old', createdAt: '2026-10-14T08:05:00.000Z', live: false, folder: 'project-b' },
]

/** The built settings page against a channel that answers the diagnostics endpoints. */
async function diagnosticsFixture(t, { clipboard = true } = {}) {
  const calls = []
  const copied = []
  const answers = {
    status: () => ({ activeId: null, writable: true, hosts: {}, defaults: {}, keys: [] }),
    balance: () => ({ activeId: null, fetchedAt: 1, keys: [] }),
    groups: () => ({ keys: [], descriptions: {} }),
    'diagnostics/sessions': () => ({ sessions: SESSIONS }),
    'diagnostics/session': payload => ({ format: 'packycode-diagnostics/1', session: { id: payload.sessionId }, totals: { steps: 3, maxTokenSteps: 1 } }),
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
    navigator: clipboard ? { clipboard: { writeText: async value => { copied.push(value) } } } : {},
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
    && node.findAll(child => child.type === 'h3' && text(child) === zh.diagTitle).length === 1)
  const button = label => card().find(node => node.type === 'button' && text(node) === label)
  return {
    calls, copied, card, button,
    select: () => card().find(node => node.type === 'select'),
    report: () => card().findAll(node => node.type === 'textarea')[0],
    click: async label => { await act(async () => button(label).props.onClick()); await settle() },
  }
}

test('the diagnostics card lists recent sessions, newest selected', async t => {
  const page = await diagnosticsFixture(t)
  const options = page.select().findAll(node => node.type === 'option')
  assert.deepEqual(options.map(option => option.props.value), ['session-new', 'session-old'])
  assert.match(text(options[0]), /project-a · 进行中$/u)
  assert.equal(page.select().props.value, 'session-new')
  assert.equal(page.report(), undefined, 'nothing is generated until asked')
})

test('generating reads the chosen session and copying sends the exact report', async t => {
  const page = await diagnosticsFixture(t)
  await act(async () => page.select().props.onChange({ target: { value: 'session-old' } }))
  await page.click(zh.diagGenerate)
  assert.deepEqual(page.calls.filter(call => call.endpoint === 'diagnostics/session'), [{ endpoint: 'diagnostics/session', payload: { sessionId: 'session-old' } }])
  const report = page.report().props.value
  assert.deepEqual(JSON.parse(report), { format: 'packycode-diagnostics/1', session: { id: 'session-old' }, totals: { steps: 3, maxTokenSteps: 1 } })
  assert.equal(page.report().props.readOnly, true)
  await page.click(zh.diagCopy)
  assert.deepEqual(page.copied, [report])
  assert.ok(page.button(zh.diagCopied), 'the button confirms the copy')
  assert.ok(text(page.card()).includes(zh.diagPrivacy), 'the card says what the text contains')
})

test('without a clipboard API the report is selected for a manual copy', async t => {
  const page = await diagnosticsFixture(t, { clipboard: false })
  await page.click(zh.diagGenerate)
  await page.click(zh.diagCopy)
  assert.ok(text(page.card()).includes(zh.diagSelected))
})
