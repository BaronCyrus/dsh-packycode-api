import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

import * as react from 'react'
import * as jsx from 'react/jsx-runtime'
import { IMAGE_CHAT_KIND } from '../src/image-conversation.js'
import { chatRuntime, conversationServiceSource, slotRegistrySource } from './image-conversation-fixture.mjs'
import savedResult from './fixtures/image-result-event.json' with { type: 'json' }

const host020 = createRequire(import.meta.resolve('packycode-host-v020-fixture'))
const cordis = await import(host020.resolve('@deepseek-ai/cordis'))
const stores = await import(host020.resolve('@deepseek-ai/dsh-client-store'))
const slotCore = await import(host020.resolve('@deepseek-ai/dsh-client-ui-slots'))
const { UiConversation, SlotRegistry } = vm.runInNewContext(`${conversationServiceSource()}\n${slotRegistrySource()}\n({UiConversation, SlotRegistry})`, {
  _deepseek_ai_cordis: cordis,
  _deepseek_ai_dsh_client_store: stores,
  _deepseek_ai_dsh_client_ui_slots: slotCore,
  queueMicrotask, URL, Blob, Uint8Array,
})

test('built image plugin registers and replays through real Cordis, UI registries, bound feed and session image cache', async t => {
  const ctx = new cordis.Context()
  t.after(() => ctx.fiber.dispose())
  let slots, conversation, sessionOwner
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jpj8AAAAASUVORK5CYII=', 'base64')
  let reads = 0
  let revision = 0
  const listeners = new Set()
  let window = { revision, entries: [{ type: 'event', event: structuredClone(savedResult) }], hasMore: false, change: { kind: 'replace' } }
  const feed = { getSnapshot: () => window, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } }
  await ctx.plugin({ name: 'existing-ui-services', apply(owner) {
    slots = new SlotRegistry(owner)
    owner.provide('locale', { register() {}, bind: () => key => key })
    owner.provide('connection', { rpc: { call: () => assert.fail('preview must not call a paid RPC') } })
    owner.provide('modelDirectories', {})
    sessionOwner = { sessionId: 'saved-session', ctx: owner, eventSource: feed, session: {
      async readAttachment(id) {
        assert.equal(id, savedResult.data.message.content[1].attachment.attachmentId)
        reads += 1
        return { ok: true, value: { attachment: savedResult.data.message.content[1].attachment, data: [...png] } }
      },
    } }
    owner.provide('sessions', { binding: id => id === 'saved-session' ? sessionOwner : undefined })
  } })
  await ctx.plugin({ name: 'existing-conversation', inject: ['sessions'], apply(owner) {
    conversation = new UiConversation(owner, owner.get('sessions'))
  } })
  const chat = chatRuntime()
  await ctx.plugin({ name: 'existing-chat-and-tool-outlets', inject: ['slots', 'uiConversation'], apply(owner) {
    owner.slots.register({ name: 'root', children: {
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    } }, () => null)
    owner.uiConversation.views.register(chat.view)
    owner.uiConversation.groups.register(chat.groups)
  } })
  let plugin
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(spec) { plugin = spec.factory(name => name === 'react' ? react : jsx) } } },
    document: { head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) },
  })
  const settled = async () => {
    await Promise.all([...ctx.registry.values()].flatMap(runtime => [...runtime.fibers].map(fiber => fiber.await())))
    await new Promise(resolve => setImmediate(resolve))
  }
  const bound = conversation.binding('saved-session')
  const target = bound.target('chat')
  const unsubscribe = target.subscribe(() => {})
  t.after(unsubscribe)
  const imageNodes = () => [...target.getSnapshot().nodes.values()].filter(node => node.kind === IMAGE_CHAT_KIND)
  assert.equal(imageNodes().length, 0)
  let fiber = await ctx.plugin({ ...plugin, name: 'packycode-image-client' })
  await settled()
  assert.equal(fiber.state, 2, 'real optional injection and nested registry effects must finish loading')
  assert.equal(conversation.events.entries().filter(definition => definition.kind === IMAGE_CHAT_KIND).length, 1)
  assert.equal(imageNodes().length, 1, 'registering the built client must replay the already-loaded native image')
  const gallery = slots.entries('conversation.chat.node').find(entry => entry.options.key === IMAGE_CHAT_KIND)
  const detail = slots.entries('tool.call.toolview').find(entry => entry.options.key === 'packycode_image_generate')
  assert.ok(gallery && detail, 'real keyed Slot registrations must exist')
  const attachment = imageNodes()[0].data.blocks[0].content[1].attachment
  const props = gallery.inject('saved-session')
  const url = await props.loadImage(attachment)
  assert.match(url, /^blob:/u)
  assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), png)
  assert.equal(await detail.inject('saved-session').loadImage(attachment), url)
  assert.equal(reads, 1, 'main chat and tool details share the real session-authorized image cache')

  window = { ...window, revision: ++revision, entries: JSON.parse(JSON.stringify(window.entries)), change: { kind: 'replace' } }
  for (const listener of listeners) listener()
  assert.equal(imageNodes().length, 1, 'reopening history must publish without manually flushing an assembler')
  await fiber.dispose()
  await settled()
  assert.equal(imageNodes().length, 0)
  assert.equal(slots.entries('conversation.chat.node').length, 0)
  assert.equal(conversation.events.entries().length, 0)
  fiber = await ctx.plugin({ ...plugin, name: 'packycode-image-client' })
  await settled()
  assert.equal(fiber.state, 2)
  assert.equal(imageNodes().length, 1, 'reinstalling the client must restore the same saved image without duplicate entries')
})
