import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import { zh } from '../src/client-copy.js'
import { IMAGE_CHAT_KIND } from '../src/image-conversation.js'
import { assembler } from './image-conversation-fixture.mjs'
import savedResult from './fixtures/image-result-event.json' with { type: 'json' }

/** Run the built client with deterministic Hook lifetimes and the public image-loader seam. */
function clientFixture() {
  let active
  const states = new Map()
  const element = (type, props) => ({ type, props: props ?? {} })
  const react = {
    useState(initial) {
      const state = active, index = state.index++
      if (!(index in state.values)) state.values[index] = initial
      return [state.values[index], value => { state.values[index] = typeof value === 'function' ? value(state.values[index]) : value }]
    },
    useEffect(fn, deps) {
      const index = active.index++
      if (!active.effects[index] || deps.some((value, i) => value !== active.effects[index].deps[i])) {
        active.effects[index]?.cleanup?.()
        active.effects[index] = { deps, cleanup: fn() }
      }
    },
  }
  const slots = new Map()
  const reads = []
  const opened = []
  let definition
  let client
  const preview = 'blob:session-owned-generated-preview'
  const conversation = { events: { register: value => { definition = value } },
    imageUrl: async (sessionId, attachment) => { reads.push({ sessionId, attachment }); return preview } }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { open: () => assert.fail('the in-app viewer should be used'), __ModuleLoader__: { load: spec => { client = spec.factory(name => name === 'react' ? react : { jsx: element, jsxs: element }) } } },
    document: { head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) },
  })
  const ctx = {
    locale: { register() {}, bind: () => key => zh[key] }, effect: fn => fn(),
    get: name => ({ uiConversation: conversation, connection: { rpc: { call: () => assert.fail('preview/replay must not make a paid RPC') } },
      nativeImageViewer: { open: request => { opened.push(request); return true } } })[name],
    inject(names, callback) { if (names.length === 1 && names[0] === 'uiConversation') callback(ctx) },
    slots: { inject: (_name, fn) => fn(), register(spec, component) { slots.set(`${spec.name}:${spec.key ?? spec.id}`, { spec, component }) } },
  }
  client.apply(ctx)
  const render = (tree, path = 'root') => {
    if (Array.isArray(tree)) return tree.flatMap((part, i) => render(part, `${path}:${i}`))
    if (!tree || typeof tree !== 'object') return []
    if (typeof tree.type === 'function') {
      const state = states.get(path) ?? { index: 0, values: [], effects: [] }
      states.set(path, state)
      active = state; state.index = 0
      const child = tree.type(tree.props)
      active = undefined
      return render(child, `${path}:child`)
    }
    return [tree, ...render(tree.props.children, `${path}:children`)]
  }
  return { slots, reads, opened, render, preview, definition: () => definition }
}

for (const protocol of ['native', 'ptc', 'cli']) test(`built ${protocol} main-chat gallery uses the same session image loader/viewer as tool details`, async () => {
  const fx = clientFixture()
  assert.equal(fx.definition().kind, IMAGE_CHAT_KIND)
  const gallery = fx.slots.get(`conversation.chat.node:${IMAGE_CHAT_KIND}`)
  const details = fx.slots.get('tool.call.toolview:packycode_image_generate')
  assert.ok(gallery && details)
  const attachment = { attachmentId: `sha256:${'a'.repeat(64)}`, bytes: 100, width: 1152, height: 2048, mediaType: 'image/png', name: 'saved-output.png' }
  const end = { type: 'turn/end', seq: 10, data: { turn: 1 } }
  const image = { type: 'image', attachment }
  const output = protocol === 'native' ? { ...savedResult, seq: 4,
    data: { ...savedResult.data, message: { ...savedResult.data.message, content: [image] } } }
    : protocol === 'ptc' ? { type: 'tool/ptc-dispatch', seq: 4, data: { name: 'packycode_image_generate', subCallId: 'nested-image', isError: false, content: [image] } }
      : { type: 'assistant/message', seq: 4, data: { turn: 1, step: 1, message: {
        source: { kind: 'model', provider: 'packycode', model: 'claude-opus-5-5' }, content: [image],
      } } }
  const entries = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 2, data: { turn: 1, step: 1 } },
    output,
    { ...end, data: { turn: 1, reason: { kind: 'stop' } } },
  ]
  const runtime = assembler('0.2.0', true, fx.definition())
  runtime.activateTarget('chat')
  runtime.replaceWindow(JSON.parse(JSON.stringify(entries)).map(event => ({ type: 'event', event })), false)
  runtime.flush()
  const snapshot = runtime.snapshot('chat')
  assert.equal(snapshot.order.length, 1, 'built registry definition must reach the real DSH chat snapshot')
  const node = snapshot.nodes.get(snapshot.order[0])
  assert.equal(node.location.kind, 'session', 'main gallery is independent of collapsed tool/turn views')
  const props = gallery.spec.inject('colleague-session')
  const show = () => fx.render({ type: gallery.component, props: { ...props, node } })
  show()
  await new Promise(resolve => setImmediate(resolve))
  const visible = show()
  assert.equal(visible.filter(part => part.type === 'img').length, 1, 'image is visible with no detail component mounted')
  assert.equal(visible.find(part => part.type === 'img').props.src, fx.preview)
  assert.equal(fx.reads[0].sessionId, 'colleague-session')
  assert.equal(fx.reads[0].attachment.attachmentId, attachment.attachmentId)
  const button = visible.find(part => part.type === 'button')
  assert.equal(button.props.disabled, false)
  button.props.onClick({ currentTarget: 'opener' })
  const opened = fx.slots.get('shell.overlay:packycode-image-viewer').spec.inject().viewer.getSnapshot()
  assert.equal(opened.src, fx.preview)
  assert.equal(opened.attachment.attachmentId, attachment.attachmentId)
  assert.equal(fx.opened.length, 0, 'the plugin owns its viewer and original-download controls')
  const detailProps = details.spec.inject('colleague-session')
  const detail = { type: details.component, props: { ...detailProps, block: node.data.blocks[0] } }
  fx.render(detail, 'detail')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fx.render(detail, 'detail').find(part => part.type === 'img').props.src, fx.preview)
  assert.ok(fx.reads.every(read => read.sessionId === 'colleague-session'))
})
