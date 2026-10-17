import assert from 'node:assert/strict'
import test from 'node:test'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { PACKYCODE_MODEL_IDS } from '../src/catalog.js'
import { apply } from '../src/index.js'
import { fakeCredentials } from './helpers.mjs'
import { anthropicStream } from './fixtures/anthropic.mjs'

const KEY_CODEX = 'sk-codex-only-key-AAAA'
const KEY_DEEPSEEK = 'sk-deepseek-key-BBBB'
const KEY_CLAUDE = 'sk-claude-code-key-CCCC'
const GROUPS = { [KEY_CODEX]: ['codex'], [KEY_DEEPSEEK]: ['deepseek-officially'], [KEY_CLAUDE]: ['cc'] }
const PRICING = {
  data: [
    { model_name: 'deepseek-flash', enable_groups: ['deepseek-officially'] },
    { model_name: 'gpt-6.1-sol', enable_groups: ['codex'] },
    { model_name: 'claude-opus-5-5', enable_groups: ['cc'] },
    { model_name: 'claude-haiku-5-5', enable_groups: ['cc'] },
  ],
  usable_group: { cc: 'claude code专用' },
}

const sse = chunks => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
})

/**
 * A stand-in PackyCode gateway on `fetch`: the group probe, the model list,
 * pricing, and a streaming chat completion that records the key it was sent.
 */
function fakeGateway() {
  const chatKeys = []
  const probes = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    const headers = new Headers(init.headers ?? (typeof input === 'string' ? undefined : input.headers))
    const key = headers.get('authorization')?.replace(/^Bearer /u, '')
    if (new URL(url).pathname === '/v1/messages') {
      const body = JSON.parse(init.body)
      chatKeys.push(key)
      return anthropicStream(body.model)
    }
    if (url.endsWith('/api/pricing')) return Response.json(PRICING)
    if (url.endsWith('/v1/models')) return Response.json({ data: [] })
    if (url.endsWith('/v1/chat/completions')) {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : await new Response(init.body).text())
      if (body.model === 'dsh-packycode-group-probe') {
        probes.push(key)
        return Response.json({ error: { code: 'model_not_found', message: `当前令牌未覆盖供应商 ""（模型=${body.model}，已选分组=[${(GROUPS[key] ?? []).join(' ')}]）` } }, { status: 400 })
      }
      chatKeys.push(key)
      return sse([
        { id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
        { id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ])
    }
    return new Response('{}', { status: 404 })
  }
  return { chatKeys, probes, restore: () => { globalThis.fetch = original } }
}

function context() {
  const seen = {}
  const ctx = {
    credentials: fakeCredentials(),
    logger: { warn: () => {}, info: () => {} },
    llm: {
      registerAdapter: (_providers, adapter) => { seen.adapter = adapter; return () => {} },
      registerConfigurableProviders: () => () => {},
    },
    get: () => undefined,
    inject(names, callback) {
      if (names.includes('connection')) return callback({ effect: ctx.effect, connection: { rpc: { handle: (_c, handler) => { seen.handler = handler; return () => {} } } } })
      if (names.includes('tools')) return callback({ tools: { register: () => () => {} } })
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  return { ctx, seen }
}

const turn = async (adapter, model) => {
  const prepared = await adapter.prepareCall('packycode', model)
  const chunks = []
  for await (const chunk of prepared.stream({
    provider: 'packycode',
    model,
    sessionId: 'session-1',
    reasoningEffort: 'high',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
  })) chunks.push(chunk)
  return chunks
}

test('an HTTP turn runs on a key whose groups reach its model, without moving the active key', async t => {
  const gateway = fakeGateway()
  t.after(gateway.restore)
  const { ctx, seen } = context()
  apply(ctx, {})
  await seen.handler('keys/add', { key: KEY_CODEX, label: 'codex' })
  await seen.handler('keys/add', { key: KEY_DEEPSEEK, label: 'deepseek' })

  const chunks = await turn(seen.adapter, 'deepseek-flash')
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  // The active key (codex) has no DeepSeek group; the DeepSeek key served it.
  assert.deepEqual(gateway.chatKeys, [KEY_DEEPSEEK])
  const status = await seen.handler('status', {})
  assert.equal(status.value.keys.find(key => key.active).label, 'codex')

  // The panel's group projection names both keys' groups, and no key.
  const groups = await seen.handler('groups', {})
  assert.equal(groups.ok, true)
  assert.deepEqual(groups.value.keys.map(key => key.groups), [['codex'], ['deepseek-officially']])
  assert.doesNotMatch(JSON.stringify(groups), /sk-(codex|deepseek)/u)
})

test('listing models neither waits for nor starts a group reading; the next turn still reads one', async t => {
  const gateway = fakeGateway()
  t.after(gateway.restore)
  const { ctx, seen } = context()
  apply(ctx, {})
  await seen.handler('keys/add', { key: KEY_CODEX, label: 'codex' })
  await seen.handler('keys/add', { key: KEY_DEEPSEEK, label: 'deepseek' })

  // DSH 0.2.1 resolves a key before it lists the route's models.
  assert.deepEqual((await seen.adapter.listModels('packycode')).map(model => model.id), [...PACKYCODE_MODEL_IDS])
  assert.deepEqual(gateway.probes, [])

  const chunks = await turn(seen.adapter, 'deepseek-flash')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(gateway.chatKeys, [KEY_DEEPSEEK])
  assert.deepEqual(gateway.probes.toSorted(), [KEY_CODEX, KEY_DEEPSEEK].toSorted())
})

test('a native Claude turn after "use this key" uses that key, otherwise one with Claude coverage', async t => {
  const gateway = fakeGateway()
  t.after(gateway.restore)
  const { ctx, seen } = context()
  // Key choice is transport-independent; pin HTTP so the cc key's Claude
  // turns reach this fake gateway instead of a Claude Code CLI.
  apply(ctx, { claudeTransport: 'http' })
  await seen.handler('keys/add', { key: KEY_CODEX, label: 'codex' })
  await seen.handler('keys/add', { key: KEY_CLAUDE, label: 'claude' })

  // Active key without Claude coverage: the native bearer uses the cc key.
  const passedOver = await turn(seen.adapter, 'claude-opus-5-5')
  assert.equal(passedOver.at(-1).reason.kind, 'stop')
  assert.deepEqual(gateway.chatKeys, [KEY_CLAUDE])

  // "Use this key" on the cc key: the very next run uses it, named plainly.
  const status = await seen.handler('status', {})
  await seen.handler('keys/select', { id: status.value.keys.find(key => key.label === 'claude').id })
  const selected = await turn(seen.adapter, 'claude-opus-5-5')
  assert.equal(selected.at(-1).reason.kind, 'stop')

  assert.deepEqual(gateway.chatKeys, [KEY_CLAUDE, KEY_CLAUDE])
})
