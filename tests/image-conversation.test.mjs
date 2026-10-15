import assert from 'node:assert/strict'
import test from 'node:test'

import { imageConversationNode, IMAGE_CHAT_KIND } from '../src/image-conversation.js'

const image = { type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}` } }
const block = { type: 'tool-result', toolCallId: 'image-call', content: [image] }
const result = (extra = {}) => ({ type: 'tool/result', seq: 4, data: { turn: 1, meta: { kind: 'packycode-image' }, message: { content: [block] } }, ...extra })
const end = { type: 'turn/end', seq: 10, data: { turn: 1 } }
const match = event => ({ event, location: { turn: { steps: [{ data: new Map([['assistant-step', { finalNode: { seq: 8 } }]]) }] } } })
const context = matches => ({ key: 'image-output', id: '1', matches: matches.map(match) })

test('image chat projection recognizes only successful image results from this plugin', () => {
  assert.deepEqual(imageConversationNode.match(result()), { id: '1', role: 'update' })
  assert.equal(imageConversationNode.match(result({ data: { turn: 1, meta: { kind: 'codex-subscription-image' }, message: { content: [block] } } })), null)
  assert.equal(imageConversationNode.match(result({ data: { turn: 1, meta: { kind: 'packycode-image' }, message: { content: [{ ...block, isError: true }] } } })), null)
  assert.equal(imageConversationNode.match({ type: 'assistant/message', data: {} }), null)
})

test('images appear after the final answer and remain projections of durable tool output', () => {
  assert.equal(imageConversationNode.buildViewNode(context([result()])), null)
  assert.equal(imageConversationNode.buildViewNode(context([end])), null)
  const source = result()
  const before = structuredClone(source)
  const view = imageConversationNode.buildViewNode(context([source, end]))
  assert.equal(view.kind, IMAGE_CHAT_KIND)
  assert.equal(view.target, 'chat')
  assert.equal(view.anchorSeq, 8.025)
  assert.equal(view.data.blocks.length, 1)
  assert.deepEqual(view.data.blocks[0].content, [image])
  assert.deepEqual(source, before)
  assert.deepEqual(imageConversationNode.buildViewNode(context([source, end])), view, 'replay has the same image projection')
})

test('an image after the last text is placed just before turn end', () => {
  const view = imageConversationNode.buildViewNode(context([result({ seq: 9 }), end]))
  assert.equal(view.anchorSeq, 9.975)
})
