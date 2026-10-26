import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

import { apply } from '../src/index.js'
import { fakeCredentials } from './helpers.mjs'
import { anthropicStream } from './fixtures/anthropic.mjs'

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-claude-agent.mjs', import.meta.url))
const CC_KEY = 'sk-wiring-cc-key-AAAA'
const SALE_KEY = 'sk-wiring-cc-sale-key-BBBB'
const GROUPS = { [CC_KEY]: ['cc', 'codex'], [SALE_KEY]: ['cc-sale'] }
const CLAUDE = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
/** A DSH step always offers its tools; a request without any is no agent's step. */
const TOOLS = [{ name: 'bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }]

/** The PackyCode gateway's account reads, and an HTTP Messages endpoint that records the key. */
function fakeGateway(t) {
  const httpKeys = []
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const key = request.headers.get('authorization')?.replace(/^Bearer /u, '')
    if (url.pathname === '/api/pricing') return Response.json({ data: CLAUDE.map(model_name => ({ model_name, enable_groups: ['cc', 'cc-sale'] })), usable_group: {} })
    if (url.pathname === '/v1/models') return Response.json({ data: [] })
    if (url.pathname === '/v1/chat/completions') return Response.json({ error: { message: `当前令牌未覆盖供应商（已选分组=[${GROUPS[key].join(' ')}]）` } }, { status: 400 })
    if (url.pathname === '/v1/messages') {
      const body = await request.json()
      httpKeys.push(key)
      return anthropicStream(body.model, { type: 'text', text: 'via http' })
    }
    return new Response('{}', { status: 404 })
  })
  return httpKeys
}

function context() {
  const seen = { disposers: [] }
  const ctx = {
    credentials: fakeCredentials(),
    logger: { warn: () => {}, info: () => {} },
    llm: { registerAdapter: (_providers, adapter) => { seen.adapter = adapter; return () => {} }, registerConfigurableProviders: () => () => {} },
    get: () => undefined,
    inject(names, callback) {
      if (names.includes('connection')) return callback({ effect: ctx.effect, connection: { rpc: { handle: (_c, handler) => { seen.handler = handler; return () => {} } } } })
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') seen.disposers.push(disposer)
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  return { ctx, seen }
}

async function turn(adapter, model) {
  const prepared = await adapter.prepareCall('packycode', model)
  const result = new BlockAssembler()
  for await (const chunk of prepared.stream({ provider: 'packycode', model, sessionId: 'wiring-session', reasoningEffort: 'low', tools: TOOLS, messages: [createUserMessage({ content: [{ type: 'text', text: '核对订单' }], source: { kind: 'user' } })] })) result.push(chunk)
  return result
}

test('by group: a cc key\'s Claude turn runs through the Claude Code CLI, a cc-sale key\'s over HTTP', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'packy-wiring-cli-'))
  await writeFile(join(dir, 'script.json'), JSON.stringify([{ blocks: [{ type: 'text', text: 'via cli' }] }]))
  await chmod(FAKE_CLI, 0o755)
  const previous = process.env.FAKE_CLAUDE_DIR
  process.env.FAKE_CLAUDE_DIR = dir
  t.after(() => { if (previous === undefined) delete process.env.FAKE_CLAUDE_DIR; else process.env.FAKE_CLAUDE_DIR = previous })
  const httpKeys = fakeGateway(t)
  const { ctx, seen } = context()
  apply(ctx, { claudeCliPath: FAKE_CLI })
  t.after(async () => { for (const dispose of seen.disposers) await dispose() })
  await seen.handler('keys/add', { key: CC_KEY, label: 'cc' })
  await seen.handler('keys/add', { key: SALE_KEY, label: 'cc-sale' })

  const viaCli = await turn(seen.adapter, 'claude-opus-5-5')
  assert.equal(viaCli.finish.kind, 'stop', JSON.stringify(viaCli.finish))
  assert.equal(viaCli.blocks().find(block => block.type === 'text').text, 'via cli')
  assert.deepEqual(httpKeys, [], 'the cc key never reached the HTTP route')
  const started = (await readFile(join(dir, 'log.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.kind === 'start')
  assert.equal(started.length, 1)
  assert.equal(started[0].env.ANTHROPIC_BASE_URL, 'https://cf.api.fan')

  const status = await seen.handler('status', {})
  await seen.handler('keys/select', { id: status.value.keys.find(key => key.label === 'cc-sale').id })
  const viaHttp = await turn(seen.adapter, 'claude-opus-5-5')
  assert.equal(viaHttp.blocks().find(block => block.type === 'text').text, 'via http')
  assert.deepEqual(httpKeys, [SALE_KEY])

  const groups = await seen.handler('groups', {})
  assert.deepEqual(groups.value.keys.map(key => [key.claudeTransport.transport, key.claudeTransport.reason]), [['cli', 'group'], ['http', 'group']])
  const cli = await seen.handler('claude-cli/status', {})
  assert.equal(cli.value.installed, true)
  assert.equal(cli.value.version, '2.1.295')
  assert.equal(cli.value.path, FAKE_CLI)
  assert.equal(cli.value.processes.opened, 1)
})

/**
 * A gateway whose group reading a test controls per key: a list refusal, the
 * single-group refusal of issue #3, or a read that fails in transit.
 */
function scriptedGateway(t, reading) {
  const httpKeys = []
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const key = request.headers.get('authorization')?.replace(/^Bearer /u, '')
    const answer = url.pathname === '/api/pricing' ? undefined : reading[key]
    if (answer === 'fail') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })
    if (url.pathname === '/api/pricing') return Response.json({ data: CLAUDE.map(model_name => ({ model_name, enable_groups: ['cc', 'cc-sale'] })), usable_group: {} })
    if (url.pathname === '/v1/models') return Response.json({ data: [] })
    if (url.pathname === '/v1/chat/completions') {
      if (answer.single !== undefined) return Response.json({ error: { message: `分组 ${answer.single} 下模型 dsh-packycode-group-probe 无可用渠道（distributor），请尝试切换其他分组` } }, { status: 503 })
      return Response.json({ error: { message: `当前令牌未覆盖供应商（已选分组=[${answer.join(' ')}]）` } }, { status: 400 })
    }
    if (url.pathname === '/v1/messages') {
      const body = await request.json()
      httpKeys.push(key)
      return anthropicStream(body.model, { type: 'text', text: 'via http' })
    }
    return new Response('{}', { status: 404 })
  })
  return httpKeys
}

async function fakeCli(t, script) {
  const dir = await mkdtemp(join(tmpdir(), 'packy-wiring-cli-'))
  await writeFile(join(dir, 'script.json'), JSON.stringify(script))
  await chmod(FAKE_CLI, 0o755)
  const previous = process.env.FAKE_CLAUDE_DIR
  process.env.FAKE_CLAUDE_DIR = dir
  t.after(() => { if (previous === undefined) delete process.env.FAKE_CLAUDE_DIR; else process.env.FAKE_CLAUDE_DIR = previous })
  return async () => (await readFile(join(dir, 'log.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
}

test('a key whose groups cannot be read sends its Claude turns to the CLI; HTTP takes over once a reading shows cc-sale', async t => {
  const log = await fakeCli(t, [{ blocks: [{ type: 'text', text: 'via cli' }] }])
  const reading = { [SALE_KEY]: 'fail' }
  const httpKeys = scriptedGateway(t, reading)
  const { ctx, seen } = context()
  apply(ctx, { claudeCliPath: FAKE_CLI })
  t.after(async () => { for (const dispose of seen.disposers) await dispose() })
  await seen.handler('keys/add', { key: SALE_KEY, label: 'cc-sale' })

  const unread = await turn(seen.adapter, 'claude-sonnet-5-5')
  assert.equal(unread.blocks().find(block => block.type === 'text').text, 'via cli')
  assert.deepEqual(httpKeys, [], 'a key that may be in cc never goes to HTTP blind')
  assert.equal((await log()).filter(entry => entry.kind === 'start').length, 1)

  reading[SALE_KEY] = { single: 'cc-sale' }
  const groups = await seen.handler('groups', { force: true })
  assert.deepEqual(groups.value.keys.map(key => [key.groups, key.claudeTransport.transport]), [[['cc-sale'], 'http']])
  const read = await turn(seen.adapter, 'claude-sonnet-5-5')
  assert.equal(read.blocks().find(block => block.type === 'text').text, 'via http')
  assert.deepEqual(httpKeys, [SALE_KEY])
})

test('with no CLI installed, a key whose groups are unread is told why it went to the CLI, and sent nowhere else', async t => {
  const httpKeys = scriptedGateway(t, { [SALE_KEY]: 'fail' })
  const { ctx, seen } = context()
  apply(ctx, { claudeCliPath: '/nonexistent/packycode-wiring-cli' })
  t.after(async () => { for (const dispose of seen.disposers) await dispose() })
  await seen.handler('keys/add', { key: SALE_KEY, label: 'cc-sale' })
  const result = await turn(seen.adapter, 'claude-haiku-5-5')
  assert.equal(result.finish.kind, 'error')
  assert.match(result.finish.failure.message, /本机没有可用的 Claude Code CLI。插件还没读到当前 Key 的分组/u)
  assert.match(result.finish.failure.message, /读到分组后会自动改走插件内置的 HTTP 通道/u)
  assert.doesNotMatch(result.finish.failure.message, /dsh_groups_unread|dsh_cli_unavailable/u)
  assert.deepEqual(httpKeys, [])
})

test('single-group keys are read from the gateway\'s newer refusal (issue #3): cc takes the CLI, cc-sale HTTP', async t => {
  const log = await fakeCli(t, [{ blocks: [{ type: 'text', text: 'via cli' }] }])
  const httpKeys = scriptedGateway(t, { [CC_KEY]: { single: 'cc' }, [SALE_KEY]: { single: 'cc-sale' } })
  const { ctx, seen } = context()
  apply(ctx, { claudeCliPath: FAKE_CLI })
  t.after(async () => { for (const dispose of seen.disposers) await dispose() })
  await seen.handler('keys/add', { key: CC_KEY, label: 'cc' })
  await seen.handler('keys/add', { key: SALE_KEY, label: 'cc-sale' })

  const groups = await seen.handler('groups', {})
  assert.deepEqual(groups.value.keys.map(key => [key.groups, key.claudeTransport.transport, key.claudeTransport.reason]), [[['cc'], 'cli', 'group'], [['cc-sale'], 'http', 'group']])
  assert.equal((await turn(seen.adapter, 'claude-opus-5-5')).blocks().find(block => block.type === 'text').text, 'via cli')
  const status = await seen.handler('status', {})
  await seen.handler('keys/select', { id: status.value.keys.find(key => key.label === 'cc-sale').id })
  assert.equal((await turn(seen.adapter, 'claude-opus-5-5')).blocks().find(block => block.type === 'text').text, 'via http')
  assert.deepEqual(httpKeys, [SALE_KEY])
  assert.equal((await log()).filter(entry => entry.kind === 'start').length, 1)
})

/**
 * DSH's side for one session, as the desktop composes it: the agent was
 * created on another model and switched to Claude in the picker, its plan
 * mode lives in its agent preset, and turns announce themselves.
 */
function desktopContext({ planActive = false } = {}) {
  const { ctx, seen } = context()
  const listeners = {}
  const tools = new Map()
  const session = { id: 'session-wiring-desktop' }
  const agent = {
    id: session.id,
    session,
    options: { provider: 'kimi-subscription', model: 'k3.1-pro-highspeed' },
    ctx: {
      tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
      on: () => () => {},
    },
  }
  const state = { planActive }
  const services = {
    agents: { currentInitiator: () => agent },
    sessionProjections: { stateOf: (_session, key) => (key === 'modelSelection' ? { pending: { provider: 'packycode', model: 'claude-opus-5-5' }, lastUsed: null } : undefined) },
    agentPresets: { serviceFor: (_agent, name) => (name === 'planMode' ? { get: () => ({ active: state.planActive }) } : undefined) },
    permissionPresets: { current: () => 'workspace-write', presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } } },
  }
  ctx.get = name => services[name]
  ctx.on = (name, listener) => { (listeners[name] ??= []).push(listener); return () => {} }
  const emit = (name, ...args) => { for (const listener of listeners[name] ?? []) listener(...args) }
  const run = async () => {
    const prepared = await seen.adapter.prepareCall('packycode', 'claude-opus-5-5')
    const result = new BlockAssembler()
    for await (const chunk of prepared.stream({ provider: 'packycode', model: 'claude-opus-5-5', sessionId: agent.id, reasoningEffort: 'high', tools: TOOLS, messages: [createUserMessage({ content: [{ type: 'text', text: '加 median' }], source: { kind: 'user' } })] })) result.push(chunk)
    return result
  }
  return { ctx, seen, agent, tools, state, emit, run, turnStart: () => emit('session/event', session, { type: 'turn/start', data: { turn: 1 } }), turnEnd: () => emit('session/event', session, { type: 'turn/end', data: { turn: 1 } }) }
}

test('a session switched to Claude in the picker gets the mirror tool at turn start, with plan mode from its preset', async t => {
  const log = await fakeCli(t, [{ blocks: [{ type: 'text', text: '先规划。' }] }])
  scriptedGateway(t, { [CC_KEY]: ['cc'] })
  const desktop = desktopContext({ planActive: true })
  apply(desktop.ctx, { claudeCliPath: FAKE_CLI })
  t.after(async () => { for (const dispose of desktop.seen.disposers) await dispose() })
  await desktop.seen.handler('keys/add', { key: CC_KEY, label: 'cc' })

  desktop.turnStart()
  assert.ok(desktop.tools.has('claude_code'), 'the first step already lists the mirror tool')
  const result = await desktop.run()
  assert.equal(result.blocks().find(block => block.type === 'text').text, '先规划。')
  const start = (await log()).find(entry => entry.kind === 'start')
  assert.equal(start.args[start.args.indexOf('--permission-mode') + 1], 'plan', 'DSH\'s plan mode reached Claude Code')
  desktop.turnEnd()
})

test('a turn that starts on the CLI ends there, even when the reading arrives during it; the next turn follows the groups', async t => {
  const log = await fakeCli(t, [{ blocks: [{ type: 'text', text: 'via cli' }] }])
  const httpKeys = scriptedGateway(t, { [SALE_KEY]: { single: 'cc-sale' } })
  const desktop = desktopContext()
  apply(desktop.ctx, { claudeCliPath: FAKE_CLI })
  t.after(async () => { for (const dispose of desktop.seen.disposers) await dispose() })
  await desktop.seen.handler('keys/add', { key: SALE_KEY, label: 'cc-sale' })

  // Nothing has read the key yet: the turn starts on the CLI.
  desktop.turnStart()
  assert.ok(desktop.tools.has('claude_code'))
  assert.equal((await desktop.run()).blocks().find(block => block.type === 'text').text, 'via cli')
  assert.deepEqual(httpKeys, [], 'the reading came in during the turn, which stayed on the CLI')
  desktop.turnEnd()

  desktop.turnStart()
  assert.equal(desktop.tools.has('claude_code'), false, 'an HTTP turn is not offered the mirror tool')
  assert.equal((await desktop.run()).blocks().find(block => block.type === 'text').text, 'via http')
  assert.deepEqual(httpKeys, [SALE_KEY])
  desktop.turnEnd()
  assert.equal((await log()).filter(entry => entry.kind === 'start').length, 1)
})

test('the groups alone decide: a stored route pin is ignored, and a cc key never falls back to HTTP', async t => {
  const httpKeys = fakeGateway(t)
  const { ctx, seen } = context()
  // Profiles from 1.3.4 may still hold a pin; it no longer means anything.
  apply(ctx, { claudeCliPath: '/nonexistent/packycode-wiring-cli', claudeTransport: 'http' })
  t.after(async () => { for (const dispose of seen.disposers) await dispose() })
  await seen.handler('keys/add', { key: CC_KEY, label: 'cc' })
  await seen.handler('keys/add', { key: SALE_KEY, label: 'cc-sale' })
  const missing = await turn(seen.adapter, 'claude-haiku-5-5')
  assert.equal(missing.finish.kind, 'error')
  assert.match(missing.finish.failure.message, /本机没有可用的 Claude Code CLI/u)
  assert.deepEqual(httpKeys, [], 'no HTTP fallback for a cc key when the CLI is missing')

  const status = await seen.handler('status', {})
  await seen.handler('keys/select', { id: status.value.keys.find(key => key.label === 'cc-sale').id })
  const http = await turn(seen.adapter, 'claude-haiku-5-5')
  assert.equal(http.finish.kind, 'stop')
  assert.deepEqual(httpKeys, [SALE_KEY])
  const cli = (await seen.handler('claude-cli/status', {})).value
  assert.equal(cli.processes.opened, 0)
  assert.equal(Object.hasOwn(cli, 'transport'), false)
  assert.equal(Object.hasOwn(cli, 'writable'), false)
})
