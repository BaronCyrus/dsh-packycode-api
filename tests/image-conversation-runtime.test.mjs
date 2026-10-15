import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'

import { imageConversationNode } from '../src/image-conversation.js'

const host020 = createRequire(import.meta.resolve('packycode-host-v020-fixture'))

/** Use DSH's shipped assembler and location index, with only its snapshot sink replaced. */
function assembler(version = '0.1.5') {
  const bundle = readFileSync(version === '0.2.0' ? host020.resolve('@deepseek-ai/dsh-client-ui-conversation/client')
    : new URL('../node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', import.meta.url), 'utf8')
  const start = bundle.indexOf('//#region lib/types/client/contract/conversation.js')
  const end = bundle.indexOf('//#region lib/types/client/conversation/definition-registry.js')
  assert.ok(start >= 0 && end > start, 'pinned DSH conversation runtime is available')
  const Runtime = vm.runInNewContext(`${bundle.slice(start, end)}\nConversationNodeAssembler`, {
    _deepseek_ai_dsh_client_store: { notifySubscribers: listeners => { for (const listener of listeners) listener() } },
  })
  return new Runtime({ entries: () => [imageConversationNode], fallbackEntry: () => undefined }, {
    entries: () => [{ target: 'chat', create() {
      const nodes = new Map()
      const snapshot = () => [...nodes.values()].filter(node => node.visibility === 'visible')
      return { empty: [], replace(input) { nodes.clear(); for (const node of input.nodes) nodes.set(node.key, node); return snapshot() },
        apply(input) { for (const node of input.upserts) nodes.set(node.key, node); return snapshot() } }
    } }],
  })
}

/** Exercise the real 0.2 chat grouping policy; custom Turn nodes default to process groups. */
function chatRoots(nodes) {
  const bundle = readFileSync(host020.resolve('@deepseek-ai/dsh-client-ui-chat/client'), 'utf8')
  const start = bundle.indexOf('//#region lib/types/client/conversation-nodes/process-activity.js')
  const end = bundle.indexOf('//#region lib/types/client/conversation-nodes/register.js')
  assert.ok(start >= 0 && end > start)
  const State = vm.runInNewContext(`${bundle.slice(start, end)}\nProcessState`, {
    brandString: value => value,
    isVisibleChatNode: node => node.visibility === 'visible',
  })
  const state = new State()
  const order = nodes.map(node => node.key)
  const byKey = new Map(nodes.map(node => [node.key, node]))
  const turnOf = node => ['turn', 'step'].includes(node.location.kind) ? node.location.turn.turn : undefined
  state.accept({ kind: 'replace', order, timeline: { turns: new Map([[1, { status: 'closed' }]]) },
    readNode: key => byKey.get(key), readTurn: turn => order.filter(key => turnOf(byKey.get(key)) === turn),
    readPosition: key => ({ turn: turnOf(byKey.get(key)), previous: order[order.indexOf(key) - 1], next: order[order.indexOf(key) + 1] }),
  })
  return JSON.parse(JSON.stringify(state.output().entries))
}

const attachment = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 100, width: 1152, height: 2048 }
const event = (seq, type, data) => ({ type: 'event', event: { seq, type, data } })
const events = [
  event(1, 'turn/start', { turn: 1 }),
  event(2, 'step/start', { turn: 1, step: 1 }),
  event(3, 'tool/result', { turn: 1, step: 1, meta: { kind: 'packycode-image' }, message: { content: [{ type: 'tool-result', toolCallId: 'generated', content: [{ type: 'image', attachment }] }] } }),
  event(4, 'assistant/message', { turn: 1, step: 1, message: { source: { kind: 'model', provider: 'packycode', model: 'gpt-6-astra' }, content: [{ type: 'text', text: 'Generated. ![Preview](a-host-local-path.png)' }] } }),
  event(5, 'step/end', { turn: 1, step: 1 }),
  event(6, 'turn/end', { turn: 1 }),
]

for (const version of ['0.1.5', '0.2.0']) test(`DSH ${version} keeps a generated image in main chat after tool details are collapsed and history is reopened`, () => {
  for (const replay of [false, true]) {
    const runtime = assembler(version)
    runtime.activateTarget('chat')
    if (replay) runtime.replaceWindow(JSON.parse(JSON.stringify(events)), false)
    else for (const entry of events) { runtime.append(entry); runtime.flush() }
    runtime.flush()
    const nodes = runtime.snapshot('chat')
    assert.equal(nodes.length, 1, 'main chat must have an image card independently of the tool detail panel')
    assert.deepEqual(nodes[0].data.blocks[0].content[0].attachment, attachment)
    assert.deepEqual(chatRoots(nodes), [{ kind: 'node', key: nodes[0].key }], 'image output must stay out of closed process groups')
  }
})

test('an image rendered by a nested native tool also appears in main chat after PTC tool details are closed', async () => {
  const ctx = new Context()
  const log = events.slice(0, 2)
  const session = { id: 'image-repro', append(type, data) {
    const entry = event(log.length + 1, type, { turn: 1, step: 1, ...data })
    log.push(entry)
    return entry.event
  } }
  const agent = { id: session.id, session }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder: () => 1 })
  ctx.provide('agents', { currentInitiator: () => agent })
  ctx.provide('codeRuntime', { language: 'typescript', async run({ program, bindings }) {
    return { logs: [], value: await new AsyncFunction('tools', program)(bindings[0].functions) }
  } })
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
