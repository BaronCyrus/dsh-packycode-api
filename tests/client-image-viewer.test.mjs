import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import test from 'node:test'
import vm from 'node:vm'
import * as react from 'react'
import * as jsx from 'react/jsx-runtime'
import TestRenderer from 'react-test-renderer'

import { zh } from '../src/client-copy.js'
import { IMAGE_CHAT_KIND } from '../src/image-conversation.js'

const { act, create } = TestRenderer
const attachment = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', name: 'generated.png', bytes: 100, width: 1024, height: 1536 }
const original = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jpj8AAAAASUVORK5CYII=', 'base64'), Buffer.alloc(300_000, 3)])
const assetId = '11111111-2222-4333-8444-555555555555.png'
const info = () => ({ assetId, attachmentId: attachment.attachmentId, mediaType: 'image/png', bytes: original.length,
  sha256: createHash('sha256').update(original).digest('hex') })
const originalRpc = async (endpoint, payload) => {
  assert.equal(payload.sessionId, 'saved-session')
  assert.equal(payload.attachmentId, attachment.attachmentId)
  if (endpoint === 'images/original') return info()
  assert.equal(endpoint, 'images/original/chunk', 'image preview and saving must never make a paid request')
  assert.equal(payload.assetId, assetId)
  const bytes = original.subarray(payload.offset, payload.offset + 256 * 1024)
  return { ...payload, totalBytes: original.length, encoded: bytes.toString('base64'), done: payload.offset + bytes.length === original.length }
}

function fixture(nativeViewer, options = {}) {
  let plugin, root
  const slots = [], popups = [], calls = [], listeners = new Map(), downloads = [], timers = []
  const preview = 'blob:session-owned-preview'
  const document = { head: { append() {} }, body: { style: {}, append() {} }, activeElement: undefined,
    createElement: name => name === 'a' ? { remove() {}, click() { downloads.push({ href: this.href, name: this.download }) } } : { dataset: {}, remove() {} },
    addEventListener(name, fn) { listeners.set(name, fn) },
    removeEventListener(name) { listeners.delete(name) },
  }
  const window = { open: (...args) => { popups.push(args); return null },
    showSaveFilePicker: options.picker,
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length },
    addEventListener: document.addEventListener, removeEventListener: document.removeEventListener,
    __ModuleLoader__: { load(spec) { plugin = spec.factory(name => name === 'react' ? react : jsx) } },
  }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window, document, AbortController, atob, crypto: globalThis.crypto, URL, Blob, Uint8Array,
  })
  const ctx = {
    locale: { register() {}, bind: () => key => zh[key] ?? key }, effect: fn => fn(),
    get: name => ({ uiConversation: { events: { register() {} }, imageUrl: async () => preview },
      connection: { rpc: { call: async (_channel, endpoint, payload, signal) => {
        calls.push({ endpoint, payload, signal })
        return { ok: true, value: await (options.rpc ?? originalRpc)(endpoint, payload, signal) }
      } } },
      nativeImageViewer: nativeViewer,
    })[name],
    inject(names, fn) { if (names.length === 1 && names[0] === 'uiConversation') fn(ctx) },
    slots: { inject: (_name, fn) => fn(), register(spec, component) { slots.push({ spec, component }) } },
  }
  plugin.apply(ctx)
  const gallery = slots.find(entry => entry.spec.name === 'conversation.chat.node' && entry.spec.key === IMAGE_CHAT_KIND)
  const block = { kind: 'tool-result', toolCallId: 'generated-call', content: [{ type: 'image', attachment }], meta: { kind: 'packycode-image' } }
  const node = { data: { blocks: [block] } }
  return {
    calls, popups, preview, downloads, listeners,
    async mount() {
      await act(async () => {
        root = create(react.createElement(react.Fragment, null,
          react.createElement(gallery.component, { ...gallery.spec.inject('saved-session'), node }),
          ...slots.filter(entry => entry.spec.name === 'shell.overlay').map(entry => react.createElement(entry.component, { key: entry.spec.id, ...entry.spec.inject?.() }))),
        { createNodeMock: () => ({ focus() {}, querySelectorAll: () => [], contains: () => false }) })
      })
    },
    async close() { await act(async () => root?.unmount()); for (const timer of timers) timer.fn() },
    root: () => root.root,
    async open() { await act(async () => root.root.findByProps({ className: 'pkc-generated-image' }).props.onClick({ currentTarget: { focus() {} } })) },
    async save() { await act(async () => root.root.findByProps({ className: 'pkc-image-viewer-button' }).props.onClick()) },
    async dismiss() { await act(async () => root.root.findByProps({ 'aria-label': zh.imagesClosePreview }).props.onClick()) },
    async escape() { await act(async () => listeners.get('keydown')?.({ key: 'Escape', preventDefault() {}, stopPropagation() {} })) },
  }
}

test('Download original is immediately left of Close, opens the location picker before any RPC, and writes original bytes', async t => {
  const order = [], writes = []
  const fx = fixture(undefined, {
    picker: async options => {
      order.push('picker'); assert.equal(options.suggestedName, 'generated.png')
      assert.deepEqual(Object.keys(options.types[0].accept), ['image/png'])
      return { createWritable: async () => ({ write: async data => writes.push(Buffer.from(data)), close: async () => order.push('closed'), abort: async () => {} }) }
    },
    rpc: async (...args) => { order.push(args[0]); return originalRpc(...args) },
  })
  t.after(() => fx.close()); await fx.mount(); await fx.open()
  const buttons = fx.root().findByProps({ role: 'dialog' }).findAllByType('button')
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].children.at(-1), zh.imagesDownloadOriginal)
  assert.equal(buttons[1].props['aria-label'], zh.imagesClosePreview)
  assert.equal(fx.calls.length, 0, 'enlarging an image must not load an original or call the gateway')
  await fx.save()
  assert.equal(order[0], 'picker')
  assert.equal(order.at(-1), 'closed')
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0], original)
  assert.equal(fx.calls.length, 3)
  await fx.dismiss()
  assert.equal(fx.root().findAllByProps({ role: 'dialog' }).length, 0)
  await fx.open(); await fx.escape()
  assert.equal(fx.root().findAllByProps({ role: 'dialog' }).length, 0)
  assert.equal(fx.listeners.size, 0)
})

test('cancelling the save-location picker performs no file read and shows no failure', async t => {
  const fx = fixture(undefined, { picker: async () => { throw Object.assign(new Error('Cancelled'), { name: 'AbortError' }) } })
  t.after(() => fx.close()); await fx.mount(); await fx.open(); await fx.save()
  assert.equal(fx.calls.length, 0)
  assert.equal(fx.downloads.length, 0)
  assert.equal(fx.root().findAllByProps({ role: 'alert' }).length, 0)
  assert.equal(fx.root().findByProps({ className: 'pkc-image-viewer-button' }).props.disabled, false)
})

test('desktop download without File System Access dispatches the original PNG to the normal Save dialog instead of a blob popup', async t => {
  const fx = fixture(); t.after(() => fx.close()); await fx.mount(); await fx.open(); await fx.save()
  assert.equal(fx.downloads.length, 1)
  assert.equal(fx.downloads[0].name, 'generated.png')
  assert.deepEqual(Buffer.from(await (await fetch(fx.downloads[0].href)).arrayBuffer()), original)
  assert.equal(fx.popups.length, 0)
})

test('a failed or corrupt original remains retryable and never writes a preview in its place', async t => {
  let corrupt = true, writes = 0
  const fx = fixture(undefined, {
    picker: async () => ({ createWritable: async () => ({ write: async () => { writes += 1 }, close: async () => {}, abort: async () => {} }) }),
    rpc: async (...args) => {
      const value = await originalRpc(...args)
      return args[0] === 'images/original' && corrupt ? { ...value, sha256: '0'.repeat(64) } : value
    },
  })
  t.after(() => fx.close()); await fx.mount(); await fx.open(); await fx.save()
  assert.equal(writes, 0)
  assert.equal(fx.downloads.length, 0)
  assert.equal(fx.root().findAllByProps({ role: 'alert' }).length, 1)
  corrupt = false; await fx.save()
  assert.equal(writes, 1)
  assert.equal(fx.root().findAllByProps({ role: 'alert' }).length, 0)
})

test('closing the large preview aborts an in-flight original read and cannot trigger a later save', async t => {
  let resolve
  const pending = new Promise(done => { resolve = done })
  const fx = fixture(undefined, { rpc: async () => pending })
  t.after(() => fx.close()); await fx.mount(); await fx.open()
  let saving
  await act(async () => { saving = fx.root().findByProps({ className: 'pkc-image-viewer-button' }).props.onClick() })
  assert.equal(fx.calls[0].signal.aborted, false)
  await fx.dismiss()
  assert.equal(fx.calls[0].signal.aborted, true)
  await act(async () => { resolve(info()); await saving })
  assert.equal(fx.downloads.length, 0)
  assert.equal(fx.root().findAllByProps({ role: 'dialog' }).length, 0)
})

for (const [label, native] of [['absent', undefined], ['declines', { open: () => false }]]) {
  test(`a generated thumbnail opens a large in-app preview when the optional native viewer ${label}`, async t => {
    const fx = fixture(native); t.after(() => fx.close()); await fx.mount()
    await fx.open()
    const dialogs = fx.root().findAllByProps({ role: 'dialog' })
    assert.equal(dialogs.length, 1, 'clicking the generated image must actually open a large preview')
    assert.equal(dialogs[0].findByType('img').props.src, fx.preview)
    assert.equal(fx.popups.length, 0, 'desktop preview must work without a popup window')
  })
}
