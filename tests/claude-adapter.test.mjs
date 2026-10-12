import assert from 'node:assert/strict'
import test from 'node:test'

import { CLI_BACKED_MODEL_IDS, createClaudeCliAdapter, renderDelegatedPrompt, TITLE_MODEL_ID } from '../src/claude-adapter.js'

/** An inner adapter that records what it was asked for. */
function innerAdapter({ model = { id: 'gpt-6.1-sol' } } = {}) {
  const calls = []
  return {
    calls,
    providerInfo: provider => ({ id: provider, displayName: 'PackyCode' }),
    providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 20, retryableCodes: [] }),
    listModels: async () => [model],
    resolveModel: async (_provider, id) => ({ ...model, id }),
    prepareCall: async (_provider, id) => {
      calls.push({ kind: 'inner-prepare', id })
      return { model: { ...model, id }, stream: () => (async function* () { yield { type: 'text-delta', index: 0, text: 'inner' } })() }
    },
    stream: () => (async function* () { yield { type: 'text-delta', index: 0, text: 'inner' } })(),
  }
}

/** A runner that replays a scripted event list. */
function stubRunner(events, { onCall } = {}) {
  const calls = []
  return {
    calls,
    async *stream(options) {
      calls.push(options)
      onCall?.(options)
      for (const event of events) yield event
    },
  }
}

async function consume(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

test('only the CLI-backed ids leave the pi-ai path', async () => {
  const inner = innerAdapter()
  const runner = stubRunner([{ type: 'text', text: 'cli' }, { type: 'result', result: { result: 'cli', inputTokens: 1, outputTokens: 2 } }])
  const adapter = createClaudeCliAdapter({ inner, runner, modelIds: CLI_BACKED_MODEL_IDS, resolveMode: () => 'edit', resolveCwd: () => '/work' })

  const passthrough = await adapter.prepareCall('packycode', 'gpt-6.1-sol')
  assert.deepEqual(await consume(passthrough.stream({ model: 'gpt-6.1-sol' })), [{ type: 'text-delta', index: 0, text: 'inner' }])
  assert.deepEqual(inner.calls, [{ kind: 'inner-prepare', id: 'gpt-6.1-sol' }])
  assert.equal(runner.calls.length, 0)

  const delegated = await adapter.prepareCall('packycode', 'claude-opus-5-5')
  assert.equal(delegated.model.id, 'claude-opus-5-5')
  assert.equal(runner.calls.length, 0, 'the CLI starts only when the stream is consumed')
  await consume(delegated.stream({ provider: 'packycode', model: 'claude-opus-5-5', messages: [] }))
  assert.equal(runner.calls.length, 1)
  assert.equal(runner.calls[0].mode, 'edit')
  assert.equal(runner.calls[0].cwd, '/work')
  assert.equal(runner.calls[0].model, 'claude-opus-5-5')
})

test('a delegated turn streams the CLI text and finishes clean', async () => {
  const runner = stubRunner([
    { type: 'text', text: 'Hel' },
    { type: 'text', text: 'lo' },
    { type: 'result', result: { result: 'Hello', inputTokens: 3, outputTokens: 4 } },
  ])
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner, resolveMode: () => 'read-only' })
  const chunks = await consume(adapter.stream({
    provider: 'packycode',
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('thinking and tool activity stream live as reasoning, the answer as text', async () => {
  const runner = stubRunner([
    { type: 'block', kind: 'reasoning' },
    { type: 'reasoning', text: '先看仓库' },
    { type: 'tool', id: 't1', summary: 'Bash · git status' },
    { type: 'tool', id: 't1', summary: 'Bash · git status' },
    { type: 'tool-error', id: 't1', text: 'not a git repository' },
    { type: 'block', kind: 'text' },
    { type: 'text', text: '第一段' },
    { type: 'block', kind: 'text' },
    { type: 'text', text: '第二段' },
    { type: 'result', result: { result: '', inputTokens: 0, outputTokens: 9 } },
  ])
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner })
  const chunks = await consume(adapter.stream({ provider: 'packycode', model: 'claude-opus-5-5', messages: [] }))
  const ends = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.deepEqual(ends, [
    { type: 'reasoning', text: '先看仓库\n▸ Bash · git status\n  ✗ not a git repository\n' },
    { type: 'text', text: '第一段' },
    { type: 'text', text: '第二段' },
  ])
  // Every delta addresses an open block of its own type.
  const open = new Map()
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') open.set(chunk.index, chunk.blockType)
    if (chunk.type === 'block-end') open.delete(chunk.index)
    if (chunk.type === 'text-delta') assert.equal(open.get(chunk.index), 'text')
    if (chunk.type === 'reasoning-delta') assert.equal(open.get(chunk.index), 'reasoning')
  }
  assert.equal(open.size, 0)
})

test('usage reports the last request as context and keeps cache hits', async () => {
  const runner = stubRunner([
    { type: 'request-usage', usage: { inputTokens: 2, cacheReadTokens: 29_246, cacheWriteTokens: 13_634 } },
    { type: 'text', text: 'a' },
    { type: 'request-usage', usage: { inputTokens: 2, cacheReadTokens: 43_323, cacheWriteTokens: 385 } },
    { type: 'result', result: { result: 'a', inputTokens: 4, outputTokens: 357, cacheReadTokens: 72_569, cacheWriteTokens: 14_019 } },
  ])
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner })
  const chunks = await consume(adapter.stream({ provider: 'packycode', model: 'claude-opus-5-5', messages: [] }))
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, {
    inputTokens: 2,
    outputTokens: 357,
    cacheReadTokens: 43_323,
    cacheWriteTokens: 385,
  })
})

test('usage falls back to the CLI totals when no request was observed', async () => {
  const runner = stubRunner([
    { type: 'result', result: { result: '', inputTokens: 4, outputTokens: 5, cacheReadTokens: 6, cacheWriteTokens: 7 } },
  ])
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner })
  const chunks = await consume(adapter.stream({ provider: 'packycode', model: 'claude-opus-5-5', messages: [] }))
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, {
    inputTokens: 4,
    outputTokens: 5,
    cacheReadTokens: 6,
    cacheWriteTokens: 7,
  })
})

test('a delegated turn reports a CLI failure without blaming a key', async () => {
  const runner = {
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('Claude Code CLI failed: Failed to authenticate. API Error: 401 无效的令牌')
    },
  }
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner })
  const chunks = await consume(adapter.stream({ provider: 'packycode', model: 'claude-opus-5-5', messages: [] }))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'PI_AI_ERROR')
  assert.match(chunks[0].reason.failure.message, /401 无效的令牌/u)
})

test('the request signal reaches the CLI so a cancelled turn kills it', async () => {
  const runner = stubRunner([{ type: 'result', result: { result: 'x', inputTokens: 0, outputTokens: 0 } }])
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner })
  const controller = new AbortController()
  await consume(adapter.stream({ provider: 'packycode', model: 'claude-opus-5-5', messages: [], signal: controller.signal }))
  assert.equal(runner.calls[0].signal, controller.signal)
})

test('a session title runs on the small model, read-only, outside the workspace', async () => {
  const runner = stubRunner([{ type: 'text', text: '修复登录' }, { type: 'result', result: { result: '修复登录', inputTokens: 1, outputTokens: 2 } }])
  const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner, resolveMode: () => 'full', resolveCwd: () => '/work' })
  const chunks = await consume(adapter.stream({
    provider: 'packycode',
    model: 'claude-opus-5-5',
    purpose: 'session-title',
    system: 'Return only the title.',
    messages: [{ role: 'user', content: [{ type: 'text', text: '登录页报错了' }] }],
  }))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(runner.calls.length, 1)
  const call = runner.calls[0]
  assert.equal(call.model, TITLE_MODEL_ID)
  assert.equal(call.mode, 'read-only')
  assert.notEqual(call.cwd, '/work')
  assert.equal(call.appendSystemPrompt, 'Return only the title.')
  assert.equal(call.prompt, '登录页报错了')
})

test('every CLI-backed model is routed to the CLI with its own id', async () => {
  for (const id of CLI_BACKED_MODEL_IDS) {
    const runner = stubRunner([{ type: 'result', result: { result: '', inputTokens: 0, outputTokens: 0 } }])
    const adapter = createClaudeCliAdapter({ inner: innerAdapter(), runner })
    await consume(adapter.stream({ provider: 'packycode', model: id, messages: [] }))
    assert.equal(runner.calls[0].model, id)
  }
})

test('a delegated prompt drops the harness system prompt and marks what it cannot carry', () => {
  const prompt = renderDelegatedPrompt({
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'DSH 系统提示：你有 bash 工具……' }] },
      { role: 'user', content: [{ type: 'text', text: '看看这个文件' }, { type: 'image', source: {} }] },
      { role: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'tool-call', name: 'read' }] },
    ],
  }, '/work/repo')
  // The CLI has its own system prompt and its own tools.
  assert.equal(prompt.includes('DSH 系统提示'), false)
  assert.match(prompt, /工作目录：\/work\/repo/u)
  assert.match(prompt, /用户：看看这个文件/u)
  assert.match(prompt, /\[图片\]/u)
  assert.match(prompt, /\[调用工具 read\]/u)
  assert.match(prompt, /助手：好/u)
})

test('a long conversation is trimmed to its most recent turns', () => {
  const messages = []
  for (let i = 0; i < 200; i += 1) messages.push({ role: 'user', content: [{ type: 'text', text: `第 ${i} 轮 ` + 'x'.repeat(500) }] })
  const prompt = renderDelegatedPrompt({ messages }, '/work')
  assert.ok(prompt.length < 52_000, `prompt length ${prompt.length}`)
  assert.match(prompt, /较早对话已截断/u)
  assert.match(prompt, /第 199 轮/u)
  assert.equal(prompt.includes('第 0 轮'), false)
})
