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

const INSTALLED = { installed: true, version: '2.1.295', minVersion: '2.1.259', outdated: false, path: '/Users/u/.local/bin/claude', platform: 'darwin', command: 'npm install -g @anthropic-ai/claude-code --allow-scripts=@anthropic-ai/claude-code', updateCommand: 'claude update', install: { state: 'idle' }, processes: { live: 1, opened: 3, continued: 7 } }
const OUTDATED = { ...INSTALLED, version: '2.1.223', outdated: true, processes: { live: 0, opened: 0, continued: 0 } }
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
    'claude-cli/update': () => (current = { ...current, install: { state: 'running', action: 'update', startedAt: 1 } }),
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
  const finish = next => { current = { ...current, ...next } }
  return {
    root, calls, timers, card, finish,
    radios: () => card().findAll(node => node.props.role === 'radio'),
    button: label => card().find(node => node.type === 'button' && text(node) === label),
    chips: () => root.root.findAll(node => node.type === 'span' && typeof node.props.className === 'string' && node.props.className.includes('pkc-chip')).map(node => [text(node), node.props.title]),
  }
}

test('the CLI card shows the installed CLI and its sessions, with no route to choose', async t => {
  const view = await page(t, INSTALLED)
  const content = text(view.card())
  assert.ok(content.includes(zh.cliIntro))
  assert.ok(content.includes('2.1.295'))
  assert.ok(content.includes('/Users/u/.local/bin/claude'))
  assert.ok(content.includes('运行中的 CLI 会话 1 个 · 已启动 3 次 · 续接 7 次'))
  // A key's groups decide its route; the card offers no switch.
  assert.deepEqual(view.radios(), [])
  assert.ok(!content.includes('Claude 通道'))
  assert.ok(!content.includes(zh.cliOutdated))
  assert.equal(view.card().findAll(node => node.type === 'button' && text(node) === zh.cliUpdate).length, 0)
  assert.equal(view.calls.some(([endpoint]) => endpoint === 'claude-cli/install' || endpoint === 'claude-cli/update'), false)
})

test('an outdated CLI offers the update, which polls its progress and reports the new version', async t => {
  const view = await page(t, OUTDATED)
  const content = text(view.card())
  assert.ok(content.includes(zh.cliOutdated))
  assert.ok(content.includes('2.1.223'))
  assert.ok(content.includes('插件需要 2.1.259 或更新版本'))
  assert.ok(content.includes('将在本机执行：claude update'))
  await act(async () => view.button(zh.cliUpdate).props.onClick())
  await settle()
  // The browser sends no payload: what runs is decided on the host.
  assert.equal(JSON.stringify(view.calls.find(([endpoint]) => endpoint === 'claude-cli/update')), JSON.stringify(['claude-cli/update', {}]))
  assert.ok(text(view.card()).includes(zh.cliUpdating))
  const poll = view.timers.find(timer => timer.ms === 2_000)
  assert.ok(poll !== undefined, 'the panel polls the update')

  view.finish({ version: '2.1.303', outdated: false, install: { state: 'succeeded', action: 'update', from: '2.1.223', to: '2.1.303' } })
  await act(async () => poll.fn())
  await settle()
  const updated = text(view.card())
  assert.ok(updated.includes('已更新到 2.1.303。'))
  assert.ok(!updated.includes(zh.cliOutdated))
})

test('a failed update says why and keeps the button', async t => {
  const view = await page(t, { ...OUTDATED, install: { state: 'failed', action: 'update', code: 'still-outdated', detail: 'To update, run: brew upgrade claude-code' } })
  const content = text(view.card())
  assert.ok(content.includes(zh.cliUpdateFailed))
  assert.ok(content.includes('版本仍低于 2.1.259'))
  assert.ok(content.includes('brew upgrade claude-code'))
  assert.ok(view.button(zh.cliUpdate) !== undefined)
  assert.ok(!content.includes(zh.cliInstallFailed))
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

test('each key that reaches Claude says which route its Claude requests take', async t => {
  const view = await page(t, INSTALLED)
  const chips = view.chips()
  const cli = chips.find(([label]) => label === zh.keyClaudeCli)
  const http = chips.filter(([label]) => label === zh.keyClaudeHttp)
  assert.ok(cli !== undefined)
  assert.match(cli[1], /分组 cc 只接受官方 Claude Code 客户端/u)
  assert.equal(http.length, 1, 'a key without Claude coverage gets no route chip')
})
