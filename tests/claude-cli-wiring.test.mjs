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

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-claude-cli.mjs', import.meta.url))
const CC_KEY = 'sk-wiring-cc-key-AAAA'
const SALE_KEY = 'sk-wiring-cc-sale-key-BBBB'
const GROUPS = { [CC_KEY]: ['cc', 'codex'], [SALE_KEY]: ['cc-sale'] }
const CLAUDE = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']

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
  for await (const chunk of prepared.stream({ provider: 'packycode', model, sessionId: 'wiring-session', reasoningEffort: 'low', messages: [createUserMessage({ content: [{ type: 'text', text: '核对订单' }], source: { kind: 'user' } })] })) result.push(chunk)
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
