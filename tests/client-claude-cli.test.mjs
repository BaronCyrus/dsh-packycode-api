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

const INSTALLED = { installed: true, version: '2.1.295', path: '/Users/u/.local/bin/claude', platform: 'darwin', command: 'npm install -g @anthropic-ai/claude-code', install: { state: 'idle' }, transport: 'auto', writable: true, processes: { live: 1, opened: 3, continued: 7 } }
const KEYS = [
  { id: 'cc', label: 'cc key', addedAt: 1, active: true, disabled: false },
  { id: 'sale', label: 'sale key', addedAt: 2, active: false, disabled: false },
  { id: 'gpt', label: 'gpt key', addedAt: 3, active: false, disabled: false },
]
const CLAUDE_COVERAGE = { 'claude-opus-5-5': true, 'claude-sonnet-5-5': true, 'claude-haiku-5-5': true }

/** The built settings page against a channel answering the CLI endpoints from `cli`. */
async function page(t, cli) {
  let current = structuredClone(cli)
  const answers = {
    status: () => ({ activeId: 'cc', writable: true, hosts: {}, defaults: {}, keys: KEYS }),
    balance: () => ({ activeId: 'cc', fetchedAt: 1, keys: [] }),
    groups: () => ({
      descriptions: {},
      keys: [
        { id: 'cc', groups: ['cc', 'codex'], coverage: CLAUDE_COVERAGE, claudeTransport: { transport: 'cli', reason: 'group', groups: ['cc'] } },
        { id: 'sale', groups: ['cc-sale'], coverage: CLAUDE_COVERAGE, claudeTransport: { transport: 'http', reason: 'group', groups: ['cc-sale'] } },
        { id: 'gpt', groups: ['codex'], coverage: { 'gpt-6.1-sol': true, 'claude-opus-5-5': false }, claudeTransport: { transport: 'http', reason: 'group', groups: [] } },
      ],
    }),
    'claude-cli/status': () => current,
    'claude-cli/install': () => (current = { ...current, install: { state: 'running', startedAt: 1 } }),
    'claude-cli/update': payload => (current = { ...current, transport: payload.transport }),
  }
  const calls = []
  const rpc = { async call(_channel, endpoint, payload) {
    calls.push([endpoint, payload])
    const answer = answers[endpoint]
    return answer === undefined
      ? { ok: false, error: { code: 'packycode/request-failed', message: 'PackyCode fixture: not under test', details: {} } }
      : { ok: true, value: structuredClone(answer(payload)) }
  } }
  let client
  const slots = new Map()
  const timers = []
  const window = {
    __ModuleLoader__: { load(spec) { client = spec.factory(name => name === 'react' ? react : jsx) } },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearInterval() {}, setTimeout: () => 0,
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
  const card = () => root.root.find(node => node.type === 'section' && node.findAll(child => child.type === 'h3' && text(child) === zh.cliTitle).length === 1)
  return {
    root, calls, timers, card,
    radios: () => card().findAll(node => node.props.role === 'radio'),
    button: label => card().find(node => node.type === 'button' && text(node) === label),
    chips: () => root.root.findAll(node => node.type === 'span' && typeof node.props.className === 'string' && node.props.className.includes('pkc-chip')).map(node => [text(node), node.props.title]),
  }
}

test('the CLI card shows the installed CLI, its sessions, and saves the Claude route', async t => {
  const view = await page(t, INSTALLED)
  const content = text(view.card())
  assert.ok(content.includes(zh.cliIntro))
  assert.ok(content.includes('2.1.295'))
  assert.ok(content.includes('/Users/u/.local/bin/claude'))
  assert.ok(content.includes('运行中的 CLI 会话 1 个 · 已启动 3 次 · 续接 7 次'))
  assert.deepEqual(view.radios().map(radio => [text(radio), radio.props['aria-checked']]), [[zh.cliTransportAuto, true], [zh.cliTransportCli, false], [zh.cliTransportHttp, false]])
  assert.ok(content.includes(zh.cliTransportAutoHint))
  await act(async () => view.radios()[1].props.onClick())
  await settle()
  // The payload comes from the bundle's realm; compare its JSON.
  assert.equal(JSON.stringify(view.calls.find(([endpoint]) => endpoint === 'claude-cli/update')), JSON.stringify(['claude-cli/update', { transport: 'cli' }]))
  assert.equal(view.radios()[1].props['aria-checked'], true)
  assert.ok(text(view.card()).includes(zh.cliTransportCliHint))
  assert.equal(view.calls.some(([endpoint]) => endpoint === 'claude-cli/install'), false)
})

test('a missing CLI offers the install, which then polls its progress', async t => {
  const view = await page(t, { ...INSTALLED, installed: false, version: undefined, path: undefined, processes: { live: 0, opened: 0, continued: 0 } })
  assert.ok(text(view.card()).includes(zh.cliMissing))
  assert.ok(text(view.card()).includes(zh.cliMissingHint))
  await act(async () => view.button(zh.cliInstall).props.onClick())
  await settle()
  assert.ok(view.calls.some(([endpoint]) => endpoint === 'claude-cli/install'))
  assert.ok(text(view.card()).includes(zh.cliInstalling))
  assert.ok(view.timers.some(timer => timer.ms === 2_000), 'the panel polls the install')
})

test('an unwritable profile shows the route without letting it change', async t => {
  const view = await page(t, { ...INSTALLED, writable: false })
  assert.ok(view.radios().every(radio => radio.props.disabled === true))
  assert.ok(text(view.card()).includes(zh.cliTransportNotWritable))
})

test('each key that reaches Claude says which route its Claude requests take', async t => {
  const view = await page(t, INSTALLED)
  const chips = view.chips()
  const cli = chips.find(([label]) => label === zh.keyClaudeCli)
  const http = chips.filter(([label]) => label === zh.keyClaudeHttp)
  assert.ok(cli !== undefined)
  assert.match(cli[1], /分组 cc 只接受官方 Claude Code 客户端/u)
  assert.equal(http.length, 1, 'a key without Claude coverage gets no route chip')
})
