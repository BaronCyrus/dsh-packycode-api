import assert from 'node:assert/strict'
import test from 'node:test'
import { createPackyCodeProvider } from '../src/provider.js'
import { hostProvider } from './helpers.mjs'
import { anthropicStream } from './fixtures/anthropic.mjs'

const key = 'sk-tool-envelope-fixture'
const tool = name => ({ name, description: 'Read inventory', parameters: { type: 'object', properties: { sku: { type: 'string' } } } })
const user = { role: 'user', content: '查询 KB-87 库存', timestamp: 1 }

test('wire tools use CLI MCP names while streamed calls and result() retain native names', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const body = await new Request(input, init).json()
    requests.push(body)
    return anthropicStream(body.model, { type: 'tool_use', id: 'inventory_call', name: body.tools[0].name, input: { sku: 'KB-87' } })
  })
  const provider = hostProvider(createPackyCodeProvider()), model = provider.getModels().find(m => m.id === 'claude-sonnet-5-5')
  const context = { messages: [user], tools: [tool('lookup_inventory')] }, before = JSON.stringify(context)
  const options = { apiKey: key, onPayload: payload => ({ ...payload, tool_choice: { type: 'tool', name: 'lookup_inventory' } }) }
  const events = []
  for await (const event of provider.streamSimple(model, context, options)) events.push(event)
  const result = await provider.stream(model, context, options).result()
  for (const body of requests) {
    assert.match(body.tools[0].name, /^mcp__dsh__/u)
    assert.equal(body.tool_choice.name, body.tools[0].name)
  }
  assert.equal(requests[0].tools[0].name, requests[1].tools[0].name)
  assert.equal(events.find(e => e.type === 'toolcall_start').partial.content[0].name, 'lookup_inventory')
  assert.equal(events.find(e => e.type === 'toolcall_end').toolCall.name, 'lookup_inventory')
  assert.equal(result.content[0].name, 'lookup_inventory')
  assert.equal(JSON.stringify(context), before)
})

test('tool replay preserves the wire alias, result id and signed thinking through JSON persistence', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const body = await new Request(input, init).json()
    requests.push(body)
    return anthropicStream(body.model, requests.length === 1
      ? { type: 'tool_use', id: 'inventory_call', name: body.tools[0].name, input: { sku: 'KB-87' } }
      : { type: 'text', text: '35' })
  })
  const provider = hostProvider(createPackyCodeProvider()), model = provider.getModels().find(m => m.id === 'claude-sonnet-5-5')
  const context = { messages: [user], tools: [tool('lookup_inventory')] }
  const first = await provider.streamSimple(model, context, { apiKey: key, reasoning: 'low' }).result()
  assert.equal(first.content[0].name, 'lookup_inventory')
  first.content.unshift({ type: 'thinking', thinking: 'signed fixture', thinkingSignature: 'signature-fixture' })
  context.messages.push(first, { role: 'toolResult', toolCallId: 'inventory_call', toolName: 'lookup_inventory', content: [{ type: 'text', text: '{"onHand":42,"reserved":7}' }], isError: false, timestamp: 2 })
  await provider.streamSimple(model, JSON.parse(JSON.stringify(context)), { apiKey: key, reasoning: 'low' }).result()
  const blocks = requests[1].messages.flatMap(m => m.content)
  assert.equal(blocks.find(b => b.type === 'tool_use').name, requests[0].tools[0].name)
  assert.equal(blocks.find(b => b.type === 'tool_result').tool_use_id, 'inventory_call')
  assert.equal(blocks.find(b => b.type === 'thinking').signature, 'signature-fixture')
  assert.equal(blocks.find(b => b.type === 'thinking').thinking, 'signed fixture')
})

test('long and similarly normalized native names remain distinct and unknown aliases are not decoded', async t => {
  const names = ['a.b', 'a_b', '工具'.repeat(80)]
  let body
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    body = await new Request(input, init).json()
    return anthropicStream(body.model, { type: 'tool_use', id: 'unknown', name: 'mcp__dsh__unoffered_tool', input: {} })
  })
  const provider = hostProvider(createPackyCodeProvider()), model = provider.getModels().find(m => m.id === 'claude-haiku-5-5')
  const result = await provider.streamSimple(model, { messages: [user], tools: names.map(tool) }, { apiKey: key }).result()
  const wireNames = body.tools.map(t => t.name)
  assert.equal(new Set(wireNames).size, names.length)
  for (const name of wireNames) assert.match(name, /^mcp__dsh__[a-zA-Z0-9_-]{1,54}$/u)
  assert.equal(result.content[0].name, 'mcp__dsh__unoffered_tool')
})

test('offered DSH builtins declare canonical CLI names while retaining their exact schemas and arguments', async t => {
  const names = { bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', glob: 'Glob', grep: 'Grep' }
  const provider = hostProvider(createPackyCodeProvider()), model = provider.getModels().find(m => m.id === 'claude-haiku-5-5')
  const offered = Object.keys(names).map(tool)
  let selected, body, schemas
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    body = await new Request(input, init).json()
    return anthropicStream(body.model, { type: 'tool_use', id: 'builtin-call', name: names[selected], input: { sku: 'KB-87' } })
  })
  for (selected of Object.keys(names)) {
    const result = await provider.streamSimple(model, { messages: [user], tools: offered }, { apiKey: key,
      onPayload: payload => {
        schemas = payload.tools.map(tool => structuredClone(tool.input_schema))
        return { ...payload, tool_choice: { type: 'tool', name: selected } }
      },
    }).result()
    assert.deepEqual(body.tools.map(t => t.name), Object.values(names))
    for (let i = 0; i < offered.length; i++) assert.deepEqual(body.tools[i].input_schema, schemas[i])
    assert.equal(body.tool_choice.name, names[selected])
    assert.equal(result.content[0].name, selected)
    assert.equal(result.content[0].id, 'builtin-call')
    assert.deepEqual(result.content[0].arguments, { sku: 'KB-87' })
  }
})

test('an unoffered Bash never becomes a host command, including PTC-only and history-only requests', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const body = await new Request(input, init).json(); requests.push(body)
    return anthropicStream(body.model, { type: 'tool_use', id: 'unoffered', name: 'Bash', input: { command: 'date' } })
  })
  const provider = hostProvider(createPackyCodeProvider()), model = provider.getModels().find(m => m.id === 'claude-haiku-5-5')
  const history = { role: 'assistant', content: [{ type: 'toolCall', id: 'old-call', name: 'bash', arguments: { command: 'date' } }],
    api: 'anthropic-messages', provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
  for (const context of [{ messages: [user], tools: [tool('run_code')] }, { messages: [user, history], tools: [tool('read')] }]) {
    const result = await provider.streamSimple(model, context, { apiKey: key }).result()
    assert.ok(result.content[0], result.errorMessage)
    assert.equal(result.content[0].name, 'Bash', 'an unknown name must not be rewritten to an executable bash')
    assert.equal(requests.at(-1).tools.some(t => t.name === 'Bash'), false)
  }
})

test('canonical names never shadow another offered tool or inherited object properties', async t => {
  const names = ['bash', 'Bash', 'constructor', 'toString', '__proto__']
  let body
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    body = await new Request(input, init).json()
    return anthropicStream(body.model, { type: 'tool_use', id: 'case-sensitive', name: 'Bash', input: {} })
  })
  const provider = hostProvider(createPackyCodeProvider()), model = provider.getModels().find(m => m.id === 'claude-haiku-5-5')
  const result = await provider.streamSimple(model, { messages: [user], tools: names.map(tool) }, { apiKey: key }).result()
  assert.equal(new Set(body.tools.map(t => t.name)).size, names.length)
  for (const tool of body.tools) assert.match(tool.name, /^mcp__dsh__/u)
  assert.equal(result.content[0].name, 'Bash')
})

test('Haiku matches CLI omitted summaries while keeping effort, output limits and explicit display overrides', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (input, init) => { const body = await new Request(input, init).json(); requests.push(body); return anthropicStream(body.model) })
  const provider = hostProvider(createPackyCodeProvider()), model = provider.getModels().find(m => m.id === 'claude-haiku-5-5')
  for (const thinkingDisplay of [undefined, 'summarized']) await provider.streamSimple(model, { messages: [user] }, { apiKey: key, reasoning: 'high', maxTokens: 2048, thinkingDisplay }).result()
  assert.deepEqual(requests.map(body => body.thinking.display), ['omitted', 'summarized'])
  for (const body of requests) { assert.equal(body.output_config.effort, 'high'); assert.equal(body.max_tokens, 2048) }
})

test('Anthropic server tools retain their defined names', async t => {
  let body
  t.mock.method(globalThis, 'fetch', async (input, init) => { body = await new Request(input, init).json(); return anthropicStream(body.model) })
  const provider = hostProvider(createPackyCodeProvider()), model = provider.getModels().find(m => m.id === 'claude-sonnet-5-5')
  await provider.streamSimple(model, { messages: [user], tools: [tool('lookup_inventory')] }, { apiKey: key, onPayload: payload => ({ ...payload, tools: [{ type: 'web_search_20250305', name: 'web_search' }, ...payload.tools], tool_choice: { type: 'tool', name: 'web_search' } }) }).result()
  assert.equal(body.tools[0].name, 'web_search')
  assert.equal(body.tool_choice.name, 'web_search')
  assert.match(body.tools[1].name, /^mcp__dsh__/u)
})

for (const id of ['claude-sonnet-5-5', 'claude-opus-5-5']) test(`${id} exposes CLI progress updates with the required beta and preserves explicit summary requests`, async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (input, init) => { const request = new Request(input, init); const body = await request.json(); requests.push({ body, headers: request.headers }); return anthropicStream(body.model) })
  const provider = hostProvider(createPackyCodeProvider()), model = provider.getModels().find(m => m.id === id)
  for (const thinkingDisplay of [undefined, 'summarized']) await provider.streamSimple(model, { messages: [user] }, { apiKey: key, reasoning: 'low', maxTokens: 2048, thinkingDisplay }).result()
  assert.equal(requests[0].body.thinking.display, 'updates')
  assert.ok(requests[0].headers.get('anthropic-beta').includes('thinking-display-updates-2026-08-18'))
  assert.equal(requests[1].body.thinking.display, 'summarized')
  assert.equal(requests[1].headers.get('anthropic-beta').includes('thinking-display-updates-2026-08-18'), false)
  for (const { body } of requests) { assert.equal(body.output_config.effort, 'low'); assert.equal(body.max_tokens, 2048) }
})
