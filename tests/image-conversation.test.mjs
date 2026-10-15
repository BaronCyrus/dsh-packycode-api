import assert from 'node:assert/strict'
import test from 'node:test'

import { imageConversationNode, IMAGE_CHAT_KIND } from '../src/image-conversation.js'

const image = { type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}` } }
const message = { role: 'tool', source: { kind: 'tool', callId: 'image-call' }, toolCallId: 'image-call', isError: false, content: [image] }
const result = (extra = {}) => ({ type: 'tool/result', seq: 4, data: { meta: { kind: 'packycode-image' }, message }, ...extra })
const end = { type: 'turn/end', seq: 10, data: { turn: 1 } }
const match = event => ({ event, location: { kind: 'turn', turn: { turn: 1, end, steps: [{ data: new Map([['assistant-step', { finalNode: { seq: 8 } }]]) }] } } })
const context = matches => ({ key: 'image-output', id: '1', matches: matches.map(match) })

test('image chat projection recognizes only successful image results from this plugin', () => {
  assert.deepEqual(imageConversationNode.match(result()), { id: 'image-call', role: 'update' })
  assert.equal(imageConversationNode.match(end), null, 'boundaries update the engine Location rather than form another Context')
  assert.equal(imageConversationNode.match(result({ data: { meta: { kind: 'codex-subscription-image' }, message } })), null)
  for (const patch of [{ isError: true }, { source: { kind: 'tool', callId: '' } }, { source: { kind: 'plugin', callId: 'image-call' } },
    { content: [{ type: 'text', text: 'No image' }] }]) {
    assert.equal(imageConversationNode.match(result({ data: { meta: { kind: 'packycode-image' }, message: { ...message, ...patch } } })), null)
  }
  assert.equal(imageConversationNode.match({ type: 'assistant/message', data: {} }), null)
})

test('images appear after the final answer and remain projections of durable tool output', () => {
  const pending = context([result()])
  pending.matches[0].location.turn = { turn: 1, steps: [], status: 'open' }
  assert.equal(imageConversationNode.buildViewNode(pending).anchorSeq, 4.025, 'a completed image is visible even while the turn is still open')
  assert.equal(imageConversationNode.buildViewNode(context([end])), null)
  const source = result()
  const before = structuredClone(source)
  const view = imageConversationNode.buildViewNode(context([source, end]))
  assert.equal(view.kind, IMAGE_CHAT_KIND)
  assert.equal(view.target, 'chat')
  assert.equal(view.anchorSeq, 8.025)
  assert.equal(view.location.kind, 'session', 'gallery stays outside process folding')
  assert.equal(view.data.turn, 1)
  assert.equal(view.data.blocks.length, 1)
  assert.deepEqual(view.data.blocks[0].content, [image])
  assert.deepEqual(source, before)
  assert.deepEqual(imageConversationNode.buildViewNode(context([source, end])), view, 'replay has the same image projection')
})

test('PTC projects only successful image output from this plugin and deduplicates the same call', () => {
  const dispatch = { type: 'tool/ptc-dispatch', seq: 4, data: { name: 'packycode_image_generate', subCallId: 'image-call', isError: false, content: [image] } }
  assert.deepEqual(imageConversationNode.match(dispatch), { id: 'image-call', role: 'update' })
  for (const patch of [{ name: 'other_image_tool' }, { name: 'web_search' }, { isError: true }, { subCallId: undefined }, { content: [{ type: 'text', text: 'not an image' }] }]) {
    assert.equal(imageConversationNode.match({ ...dispatch, data: { ...dispatch.data, ...patch } }), null)
  }
  const view = imageConversationNode.buildViewNode(context([result({ seq: 3 }), dispatch, { ...dispatch, seq: 5 }, end]))
  assert.equal(view.data.blocks.length, 1)
  assert.deepEqual(view.data.blocks[0].content, [image])
  assert.equal(view.data.blocks[0].meta.kind, 'packycode-image')
  assert.equal(imageConversationNode.buildViewNode(context([dispatch, end])).location.kind, 'session')
  assert.ok(imageConversationNode.match({ ...dispatch, data: { ...dispatch.data, name: 'claude_code' } }))
})

test('an image after the last text is placed just before turn end', () => {
  const view = imageConversationNode.buildViewNode(context([result({ seq: 9 }), end]))
  assert.equal(view.anchorSeq, 9.975)
})

test('CLI assistant images survive chat replay as view projections of the owned assistant reference', () => {
  const event = { type: 'assistant/message', seq: 7, data: { turn: 1, message: {
    source: { kind: 'model', provider: 'packycode', model: 'claude-opus-5-5' }, content: [{ type: 'text', text: 'Done' }, image],
  } } }
  assert.deepEqual(imageConversationNode.match(event), { id: 'cli:7', role: 'update' })
  const view = imageConversationNode.buildViewNode(context([event, end]))
  assert.deepEqual(view.data.blocks[0].content, [image])
  assert.equal(view.data.blocks[0].kind, 'tool-result')
  assert.equal(view.anchorSeq, 8.025)
  assert.deepEqual(imageConversationNode.buildViewNode(context([JSON.parse(JSON.stringify(event)), end])), view)
  assert.equal(event.data.message.content.length, 2, 'no synthetic tool event is persisted')
  for (const source of [{ kind: 'user' }, { kind: 'plugin', plugin: 'other' }, { kind: 'model', provider: 'other', model: 'claude-opus-5-5' }, { kind: 'model', provider: 'packycode', model: 'gpt-6.1-sol' }]) {
    assert.equal(imageConversationNode.match({ ...event, data: { ...event.data, message: { ...event.data.message, source } } }), null)
  }
})
