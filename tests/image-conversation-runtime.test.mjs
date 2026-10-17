import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import savedResult from './fixtures/image-result-event.json' with { type: 'json' }

import { assembler, chatRoots, HOST_VERSIONS } from './image-conversation-fixture.mjs'

const attachment = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 100, width: 1152, height: 2048 }
const event = (seq, type, data) => ({ type: 'event', event: { seq, type, data } })
const events = [
  event(1, 'turn/start', { turn: 1 }),
  event(2, 'step/start', { turn: 1, step: 1 }),
  event(3, 'tool/result', { meta: { kind: 'packycode-image' }, message: { role: 'tool', source: { kind: 'tool', callId: 'generated' }, toolCallId: 'generated', isError: false, content: [{ type: 'image', attachment }] } }),
  event(4, 'assistant/message', { turn: 1, step: 1, message: { source: { kind: 'model', provider: 'packycode', model: 'gpt-6-astra' }, content: [{ type: 'text', text: 'Generated. ![Preview](a-host-local-path.png)' }] } }),
  event(5, 'step/end', { turn: 1, step: 1 }),
  event(6, 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
]

const chatNodes = runtime => {
  runtime.flush()
  const snapshot = runtime.snapshot('chat')
  return snapshot.order.map(key => snapshot.nodes.get(key))
}

for (const version of HOST_VERSIONS) test(`DSH ${version}: raw image records stay with their own turns across live updates, history reload and older-page prepend`, () => {
  const second = events.map(entry => ({ type: 'event', event: { ...entry.event, seq: entry.event.seq + 10,
    data: entry.event.type === 'tool/result' ? { ...entry.event.data, message: { ...entry.event.data.message, source: { kind: 'tool', callId: 'second-image' }, toolCallId: 'second-image' } }
      : { ...entry.event.data, turn: 2 },
  } }))
  for (const replay of [false, true]) {
    const runtime = assembler(version, true)
    runtime.activateTarget('chat')
    if (replay) runtime.replaceWindow([...events, ...second], false)
    else for (const entry of [...events, ...second]) { runtime.append(entry); runtime.flush() }
    assert.deepEqual([...chatNodes(runtime)].map(node => node.data.turn), [1, 2])
    assert.deepEqual([...chatNodes(runtime)].map(node => node.data.blocks[0].toolCallId), ['generated', 'second-image'])
  }
  const paged = assembler(version, true)
  paged.activateTarget('chat')
  paged.replaceWindow(second, true)
  const key = chatNodes(paged)[0].key
  paged.prepend(events, false)
  assert.equal(chatNodes(paged).length, 2)
  assert.equal(chatNodes(paged)[1].key, key)
})

for (const version of HOST_VERSIONS) test(`DSH ${version}: shared image definition never mixes independent sessions with identical call IDs`, () => {
  const first = assembler(version, true), second = assembler(version, true)
  first.activateTarget('chat'); second.activateTarget('chat')
  const other = { ...attachment, attachmentId: `sha256:${'b'.repeat(64)}` }
  for (const entry of events) {
    first.append(entry); first.flush()
    const copy = structuredClone(entry)
    if (copy.event.type === 'tool/result') copy.event.data.message.content[0].attachment = other
    second.append(copy); second.flush()
  }
  assert.deepEqual(chatNodes(first)[0].data.blocks[0].content[0].attachment, attachment)
  assert.deepEqual(chatNodes(second)[0].data.blocks[0].content[0].attachment, other)
})

for (const version of HOST_VERSIONS) test(`DSH ${version}: history whose image arrives before its opening boundary can refine Location without losing the card`, () => {
  const runtime = assembler(version, true)
  runtime.activateTarget('chat')
  runtime.replaceWindow([events[2]], true)
  assert.equal(chatNodes(runtime).length, 1)
  runtime.prepend(events.slice(0, 2), false)
  assert.equal(chatNodes(runtime).length, 1)
  for (const entry of events.slice(3)) runtime.append(entry)
  assert.equal(chatNodes(runtime).length, 1)
  assert.equal(chatNodes(runtime)[0].data.turn, 1)
})

for (const version of HOST_VERSIONS) test(`DSH ${version} keeps a generated image in main chat after tool details are collapsed and history is reopened`, () => {
  for (const replay of [false, true]) {
    const runtime = assembler(version)
    runtime.activateTarget('chat')
    if (replay) runtime.replaceWindow(JSON.parse(JSON.stringify(events)), false)
    else for (const entry of events) { runtime.append(entry); runtime.flush() }
    runtime.flush()
    const nodes = runtime.snapshot('chat')
    assert.equal(nodes.length, 1, 'main chat must have an image card independently of the tool detail panel')
    assert.deepEqual(nodes[0].data.blocks[0].content[0].attachment, attachment)
    assert.deepEqual(chatRoots(nodes, version), [{ kind: 'node', key: nodes[0].key }], 'image output must stay out of closed process groups')
  }
})

for (const version of HOST_VERSIONS) test(`DSH ${version} real Chat snapshot and grouping render flat native ToolMessages without fabricated turn fields`, () => {
  for (const replay of [false, true]) {
    const runtime = assembler(version, true)
    runtime.activateTarget('chat')
    if (replay) runtime.replaceWindow(events, false)
    else for (const entry of events) { runtime.append(entry); runtime.flush() }
    runtime.flush()
    const snapshot = runtime.snapshot('chat')
    assert.equal(snapshot.order.length, 1, 'the real Chat builder must publish a main-chat image card')
    const node = snapshot.nodes.get(snapshot.order[0])
    assert.deepEqual(node.data.blocks[0].content[0].attachment, attachment)
    assert.equal(node.data.turn, 1, 'use the host Location to recover the owning turn')
  }
})

for (const version of HOST_VERSIONS) test(`DSH ${version}: a sanitized actual DSH stored native result appears in main chat without opening tool details`, () => {
  // Preserve the recorded ToolMessage structure. Only identifiers, text and the
  // attachment digest/name were replaced; no pi-ai tool-result wrapper exists.
  for (const replay of [false, true]) {
    const runtime = assembler(version, true)
    runtime.activateTarget('chat')
    const record = { type: 'event', event: structuredClone(savedResult) }
    if (replay) runtime.replaceWindow([record], false)
    else runtime.append(record)
    const nodes = chatNodes(runtime)
    assert.equal(nodes.length, 1, 'the successful saved result must create a main-chat gallery')
    assert.equal(nodes[0].location.kind, 'session')
    assert.equal(nodes[0].data.blocks[0].toolCallId, 'image-call')
    assert.deepEqual(nodes[0].data.blocks[0].content, savedResult.data.message.content)
    assert.equal(nodes[0].data.blocks[0].meta.requestedQuality, 'max')
  }
})

test('an image rendered by a nested native tool also appears in main chat after PTC tool details are closed', async () => {
  const ctx = new Context()
  const log = events.slice(0, 2)
  const session = { id: 'image-repro', append(type, data) {
    const entry = event(log.length + 1, type, data)
    log.push(entry)
    return entry.event
  } }
  const agent = { id: session.id, session, ctx }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 })
  ctx.provide('agents', { currentInitiator: () => agent })
  // DSH 0.2.0 runs PTC programs on `codeRuntime`; 0.2.1 renamed it
  // `ptcRuntime`, resolves each request first, releases an agent's retained
  // environment through `agent.ctx`, and gives run_code the agent's cwd.
  const ptc = { language: 'typescript', resolve: request => request, release() {}, async run({ program, bindings }) {
    return { logs: [], value: await new AsyncFunction('tools', program)(bindings[0].functions) }
  } }
  ctx.provide('codeRuntime', ptc)
  ctx.provide('ptcRuntime', ptc)
  ctx.provide('workingDirectory', { ensure: async () => process.cwd() })
  const tools = new ToolRuntime(ctx, { mode: 'ptc' })
  tools.register(defineTool({ name: 'packycode_image_generate', description: 'Fixture of the actual image output contract.', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'image', attachment }], presentationMeta: () => ({ kind: 'packycode-image' }) },
    execute: async () => ({}),
  }))
  const result = await tools.execute({ callId: 'ptc-image', name: 'run_code', agent, signal: new AbortController().signal,
    arguments: { description: 'Generate requested image', code: 'return await tools.packycode_image_generate({});' } })
  assert.equal(result.isError, false)
  const detail = log.find(entry => entry.event.type === 'tool/ptc-dispatch' && entry.event.data.content.some(part => part.type === 'image'))
  assert.ok(detail, 'the real native image result is available to the tool detail view')
  log.push(event(log.length + 1, 'turn/end', { turn: 1 }))
  const runtime = assembler()
  runtime.activateTarget('chat')
  runtime.replaceWindow(log, false)
  runtime.flush()
  const nodes = runtime.snapshot('chat')
  assert.equal(nodes.length, 1, 'the same successful image must be visible outside collapsed PTC details')
  assert.deepEqual(nodes[0].data.blocks[0].content[0].attachment, attachment)
  assert.deepEqual(chatRoots(nodes), [{ kind: 'node', key: nodes[0].key }])
})
