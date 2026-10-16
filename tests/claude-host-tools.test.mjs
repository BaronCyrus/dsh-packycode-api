import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { BlockAssembler, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { createRouteAdapter } from '../src/route.js'
import { PackyCodeKeyRing } from '../src/key-ring.js'
import { fakeCredentials } from './helpers.mjs'
import { anthropicStream } from './fixtures/anthropic.mjs'
import captured from './fixtures/claude-bash.json' with { type: 'json' }

test('the captured Haiku Bash call reaches the offered DSH bash tool without UNKNOWN_TOOL', async t => {
  // Replay the real name, arguments and schema from the user's failed turn.
  // The actual host dispatcher validates and executes an in-memory fixture;
  // neither the test nor the model can run a shell command.
  const ctx = new Context()
  const session = { id: 'captured-bash-session', append() { return { seq: 1 } } }
  const agent = { session }
  ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 })
  ctx.provide('agents', { currentInitiator: () => agent })
  const runtime = new ToolRuntime(ctx, { mode: 'native' })
  let executed = 0
  runtime.register({ ...captured.tool,
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: async args => {
    executed++
    assert.deepEqual(args, JSON.parse(captured.call.arguments))
    return { text: '2026-10-17 00:31:20 CST' }
  } })
  t.after(() => ctx.fiber.dispose())
  const wires = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const wire = await new Request(input, init).json()
    wires.push(wire)
    return anthropicStream(wire.model, wires.length === 1 ? { type: 'tool_use', id: captured.call.id,
      name: captured.call.name, input: JSON.parse(captured.call.arguments) } : { type: 'text', text: '现在是凌晨。' })
  })
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add('sk-host-tool-fixture', 'fixture')
  const adapter = createRouteAdapter({ ring, keys: {
    active: () => ring.activeKey(), forRequest: (_model, key) => key, onKeyFailure: () => assert.fail('Unexpected key failure'),
  } })
  const prepared = await adapter.prepareCall('packycode', 'claude-haiku-5-5')
  const assembled = new BlockAssembler()
  const request = { provider: 'packycode', model: 'claude-haiku-5-5',
    reasoningEffort: 'high', maxTokens: 2048, sessionId: session.id,
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '晚上了吗现在' }] })],
    tools: [captured.tool],
  }
  for await (const chunk of prepared.stream(request)) assembled.push(chunk)
  const call = assembled.blocks().find(block => block.type === 'tool-call')
  assert.ok(call)
  const result = await runtime.execute({ callId: call.id, name: call.name, arguments: JSON.parse(call.arguments),
    agent, signal: new AbortController().signal })
  assert.equal(result.isError, false, JSON.stringify(result.content))
  assert.equal(executed, 1)
  assert.equal(call.name, 'bash')
  // A decoded call must have been offered under that exact wire name, not
  // guessed from an unoffered name after the response arrived.
  assert.ok(wires[0].tools.some(tool => tool.name === captured.call.name))
  const next = new BlockAssembler()
  const messages = [...request.messages, assembled.message({ kind: 'model', provider: 'packycode',
    model: 'claude-haiku-5-5', replayState: assembled.replayState }),
    createToolResultMessage({ callId: call.id, content: result.content, isError: false })]
  for await (const chunk of prepared.stream({ ...request, messages: JSON.parse(JSON.stringify(messages)) })) next.push(chunk)
  assert.equal(next.finish.kind, 'stop')
  const replay = wires[1].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
  assert.equal(replay.find(block => block.type === 'tool_use').name, 'Bash')
  assert.deepEqual(replay.find(block => block.type === 'tool_use').input, JSON.parse(captured.call.arguments))
  assert.equal(replay.find(block => block.type === 'tool_result').tool_use_id, call.id)
  assert.equal(executed, 1)
})
