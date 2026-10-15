import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import * as react from 'react'
import * as jsx from 'react/jsx-runtime'
import TestRenderer from 'react-test-renderer'

import { zh } from '../src/client-copy.js'

const { act, create } = TestRenderer
const settle = () => act(async () => { await new Promise(resolve => setImmediate(resolve)) })
const text = node => typeof node === 'string' ? node : node.children.map(text).join('')

/** The built settings page against a channel that answers with the host's projections. */
async function settingsFixture(t) {
  const calls = [], events = [], slots = new Map()
  let chat = { activeId: 'chat-a', writable: true, hosts: {}, defaults: {},
    keys: [{ id: 'chat-a', label: 'Chat main', addedAt: 1, active: true, disabled: false }] }
  let images = { imageEnabled: true, imageModel: 'gpt-image-2', imageQuality: 'auto', writable: true, available: true, activeId: 'image-a',
    keys: [
      { id: 'image-a', label: 'Poster key', addedAt: 1, active: true, disabled: false },
      { id: 'image-b', label: 'Key 2', addedAt: 2, active: false, disabled: false },
    ],
    models: [{ id: 'gpt-image-2', qualities: ['auto', 'low', 'medium', 'high'] }] }
  const relabel = (state, { id, label }) => ({ ...state, keys: state.keys.map(entry => entry.id === id ? { ...entry, label: label.trim() } : entry) })
  const answers = {
    status: () => chat,
    balance: () => ({ activeId: chat.activeId, fetchedAt: 1, keys: [] }),
    groups: () => ({ keys: [], descriptions: {} }),
    'keys/rename': payload => (chat = relabel(chat, payload)),
    'images/status': () => images,
    'images/balance': () => ({ activeId: images.activeId, fetchedAt: 1, keys: [] }),
    'images/keys/rename': payload => (images = relabel(images, payload)),
  }
  const rpc = { async call(channel, endpoint, payload) {
    assert.equal(channel, '/packycode-api')
    // The bundle runs in its own realm; keep a plain copy for deep comparison.
    calls.push({ endpoint, payload: structuredClone(payload) })
    const answer = answers[endpoint]
    return answer === undefined
      ? { ok: false, error: { code: 'packycode/request-failed', message: 'PackyCode fixture: not under test', details: {} } }
      : { ok: true, value: structuredClone(answer(payload)) }
  } }
  let client
  const window = {
    __ModuleLoader__: { load(spec) { client = spec.factory(name => name === 'react' ? react : jsx) } },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
    addEventListener() {}, removeEventListener() {}, dispatchEvent: event => { events.push(event.type) },
  }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window, Event: class { constructor(type) { this.type = type } },
    document: { head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) },
  })
  client.apply({
    locale: { register() {}, bind: () => key => zh[key] }, effect: fn => fn(),
    get: name => name === 'connection' ? { rpc } : undefined, inject() {},
    slots: { inject: (_name, fn) => fn(), register(spec, component) { slots.set(spec.id ?? spec.key, { spec, component }) } },
  })
  const section = slots.get('packycode-api')
  let root
  await act(async () => { root = create(react.createElement(section.component, section.spec.inject())) })
  await settle()
  t.after(() => act(async () => root.unmount()))
  const card = title => root.root.find(node => node.type === 'section'
    && node.findAll(child => child.type === 'h3' && text(child) === title).length === 1)
  return {
    calls, events,
    rows: title => card(title).findAll(node => node.type === 'div' && node.props.className === 'pkc-row'),
    buttons: (scope, label) => scope.findAll(node => node.type === 'button' && text(node) === label),
    fields: scope => scope.findAll(node => node.type === 'input'),
  }
}

/** What a user sees and can do, without the handlers' identities or the typed value. */
const shape = node => typeof node === 'string' ? node : {
  type: node.type,
  props: Object.fromEntries(Object.entries(node.props).filter(([name, value]) => name !== 'children' && name !== 'value' && typeof value !== 'function')),
  children: node.children.map(shape),
}

test('image keys rename inline: Escape keeps the name, blank names cannot be saved and Save sends only id and label', async t => {
  const fx = await settingsFixture(t)
  const row = () => fx.rows(zh.imagesTitle)[1]
  assert.equal(fx.buttons(row(), zh.keyRename).length, 1)
  await act(async () => fx.buttons(row(), zh.keyRename)[0].props.onClick())
  const [field] = fx.fields(row())
  assert.equal(field.props.value, 'Key 2')
  assert.equal(field.props.maxLength, 60)
  assert.equal(field.props.placeholder, zh.keyRenamePlaceholder)
  assert.equal(field.props.autoFocus, true)
  // The row's own actions give way to the field; the other rows keep theirs.
  assert.deepEqual([zh.keyUse, zh.keyRename, zh.keyRemove].map(label => fx.buttons(row(), label).length), [0, 0, 0])
  assert.equal(fx.buttons(fx.rows(zh.imagesTitle)[0], zh.keyRemove).length, 1)

  await act(async () => fx.fields(row())[0].props.onKeyDown({ key: 'Escape' }))
  assert.equal(fx.fields(row()).length, 0)
  assert.match(text(row()), /Key 2/u)
  assert.equal(fx.calls.some(call => call.endpoint.endsWith('/rename')), false)

  await act(async () => fx.buttons(row(), zh.keyRename)[0].props.onClick())
  await act(async () => fx.fields(row())[0].props.onChange({ target: { value: '   ' } }))
  assert.equal(fx.buttons(row(), zh.keyRenameSave)[0].props.disabled, true)
  await act(async () => fx.fields(row())[0].props.onChange({ target: { value: '海报 Key 2' } }))
  assert.equal(fx.buttons(row(), zh.keyRenameSave)[0].props.disabled, false)
  const balanceReads = fx.calls.filter(call => call.endpoint === 'images/balance').length
  await act(async () => row().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }))
  await settle()

  assert.deepEqual(fx.calls.filter(call => call.endpoint.endsWith('/rename')), [{ endpoint: 'images/keys/rename', payload: { id: 'image-b', label: '海报 Key 2' } }])
  assert.equal(fx.fields(row()).length, 0)
  assert.match(text(row()), /海报 Key 2/u)
  assert.equal(fx.buttons(row(), zh.keyRename).length, 1)
  // The composer's image balance hears about it, and this card re-reads its own quota.
  assert.ok(fx.events.includes('packycode-images-updated'))
  const reads = fx.calls.filter(call => call.endpoint === 'images/balance')
  assert.equal(reads.length, balanceReads + 1)
  assert.equal(reads.at(-1).payload.force, true)
})

test('the image card renames with the same field and buttons as the conversation card', async t => {
  const fx = await settingsFixture(t)
  await act(async () => fx.buttons(fx.rows(zh.accountsTitle)[0], zh.keyRename)[0].props.onClick())
  await act(async () => fx.buttons(fx.rows(zh.imagesTitle)[0], zh.keyRename)[0].props.onClick())
  const chatForm = fx.rows(zh.accountsTitle)[0].find(node => node.type === 'form')
  const imageForm = fx.rows(zh.imagesTitle)[0].find(node => node.type === 'form')
  assert.deepEqual(shape(imageForm), shape(chatForm))
  assert.equal(fx.fields(chatForm)[0].props.value, 'Chat main')
  assert.equal(fx.fields(imageForm)[0].props.value, 'Poster key')

  // Each card still renames through its own ring.
  await act(async () => fx.fields(chatForm)[0].props.onChange({ target: { value: 'Chat renamed' } }))
  await act(async () => fx.rows(zh.accountsTitle)[0].find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }))
  await settle()
  assert.deepEqual(fx.calls.filter(call => call.endpoint.endsWith('/rename')), [{ endpoint: 'keys/rename', payload: { id: 'chat-a', label: 'Chat renamed' } }])
  assert.match(text(fx.rows(zh.accountsTitle)[0]), /Chat renamed/u)
  assert.equal(fx.rows(zh.accountsTitle)[0].findAll(node => node.type === 'form').length, 0)
  assert.equal(fx.fields(fx.rows(zh.imagesTitle)[0])[0].props.value, 'Poster key')
})
