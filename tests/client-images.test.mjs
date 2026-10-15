import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import { zh } from '../src/client-copy.js'
import { createImageController } from '../src/image-settings.js'
import { PackyCodeKeyRing } from '../src/key-ring.js'
import { createPackyCodeRpc } from '../src/rpc.js'
import { fakeCredentials } from './helpers.mjs'

test('built image settings persist quality choices, constrain menus by model and clear saved password drafts', async () => {
  let preference = {}
  const ring = new PackyCodeKeyRing(fakeCredentials(), { recordId: 'image-keys' })
  const balanceReads = []
  let balanceMode = 'fresh'
  let invalidations = 0
  const images = createImageController({
    ring,
    balance: {
      invalidate() { invalidations += 1 },
      async read(options) {
        balanceReads.push(options)
        return { fetchedAt: 1000, keys: (await ring.list()).keys.map(({ id, label }) => ({
          id, label,
          ...(balanceMode === 'error' ? { error: 'balance fixture unavailable' } : {
            usage: { name: 'Image fixture', availableUsd: 9.5, ...(balanceMode === 'partial-usage' ? {} : { usedUsd: 0.5 }),
              ...(balanceMode === 'no-limit' ? { grantedUsd: 10 } : balanceMode === 'unknown-total' ? {} : { limitUsd: 10 }),
              resetPeriod: ['no-limit', 'unknown-total'].includes(balanceMode) ? 'never' : 'monthly', unlimitedQuota: balanceMode === 'unlimited' },
            ...(balanceMode === 'stale' ? { stale: { fetchedAt: 1000, error: 'balance fixture offline' } } : {}),
          }),
        })) }
      },
    },
    readPreference: () => preference, isWritable: () => true,
    writePreference: async patch => { preference = { ...preference, ...patch } },
  })
  const handler = createPackyCodeRpc({ images })
  const endpoints = []
  const rpc = { call: async (_channel, endpoint, payload) => { endpoints.push(endpoint); return handler(endpoint, payload) } }
  let active
  const element = (type, props, ...children) => ({ type, props: { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } })
  const react = {
    createElement: element,
    useMemo: fn => fn(),
    useRef(initial) { const index = active.index++; return active.values[index] ??= { current: initial } },
    useState(initial) {
      const state = active, index = state.index++
      if (!(index in state.values)) state.values[index] = initial
      return [state.values[index], value => { state.values[index] = typeof value === 'function' ? value(state.values[index]) : value }]
    },
    useEffect(fn, deps) {
      const index = active.index++
      if (!active.effects[index] || deps.some((value, i) => value !== active.effects[index][i])) { active.effects[index] = deps; fn() }
    },
  }
  const jsx = { jsx: (type, props) => element(type, props), jsxs: (type, props) => element(type, props) }
  const slots = new Map()
  let client
  const sandbox = {
    Event: class {}, window: { dispatchEvent() {}, setInterval: () => 1, clearInterval() {}, __ModuleLoader__: { load(spec) { client = spec.factory(name => name === 'react' ? react : jsx) } } },
    document: { head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) },
  }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox)
  const ctx = {
    locale: { register() {}, bind: () => key => zh[key] },
    effect: fn => fn(), get: () => ({ rpc }), inject() {},
    slots: { inject: (_name, fn) => fn(), register: (spec, component) => { slots.set(spec.id, { spec, component }); return () => {} } },
  }
  client.apply(ctx)
  const render = (type, props, state = { index: 0, values: [], effects: [] }) => {
    active = state; state.index = 0
    const output = type(props)
    active = undefined
    return output
  }
  const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : []
  const deepNodes = tree => Array.isArray(tree) ? tree.flatMap(deepNodes) : tree && typeof tree === 'object'
    ? typeof tree.type === 'function' ? deepNodes(tree.type(tree.props)) : [tree, ...deepNodes(tree.props?.children)] : []
  const section = slots.get('packycode-api')
  const card = nodes(render(section.component, section.spec.inject())).find(node => node.type?.name === 'PackyCodeImagesCard')
  assert.ok(card)
  const state = { index: 0, values: [], effects: [] }
  const show = () => nodes(render(card.type, card.props, state))
  const tick = () => new Promise(resolve => setImmediate(resolve))
  show(); await tick()
  const select = label => show().find(node => node.type === 'label' && nodes(node.props.children).some(child => child.props?.children === label)).props.children[1]
  assert.equal(select(zh.imagesQuality).props.value, 'auto')
  assert.equal(nodes(select(zh.imagesQuality)).filter(node => node.type === 'option').length, 4)
  select(zh.imagesModel).props.onChange({ target: { value: 'gpt-image-2.5-sunburst' } }); await tick()
  assert.equal(nodes(select(zh.imagesQuality)).filter(node => node.type === 'option').length, 6)
  select(zh.imagesQuality).props.onChange({ target: { value: 'max' } }); await tick()
  assert.equal(select(zh.imagesQuality).props.value, 'max')
  select(zh.imagesModel).props.onChange({ target: { value: 'gpt-image-2' } }); await tick()
  assert.equal(select(zh.imagesQuality).props.value, 'auto')
  const password = () => show().find(node => node.type === 'input' && node.props.type === 'password')
  password().props.onChange({ target: { value: 'sk-fixture-separate-image' } })
  assert.equal(password().props.value, 'sk-fixture-separate-image')
  show().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await tick()
  assert.equal(password().props.value, '')
  assert.ok(show().some(node => node.props?.children === 'Key 1'))
  assert.equal(endpoints.includes('images/keys/add'), true)
  assert.equal(endpoints.some(endpoint => endpoint === 'keys/add'), false)
  assert.equal(invalidations, 1)
  assert.ok(endpoints.includes('images/balance'))
  const rendered = () => deepNodes(render(card.type, card.props, state))
  const text = () => rendered().filter(node => typeof node.props?.children === 'string').map(node => node.props.children).join(' ')
  assert.match(text(), /\$9\.50/u)
  assert.match(text(), /Image fixture/u)
  assert.match(text(), /每月重置/u)
  const refresh = () => show().find(node => node.type === 'button' && node.props.children === zh.refresh)
  balanceMode = 'no-limit'
  refresh().props.onClick(); await tick()
  assert.match(text(), /不重置/u)
  assert.equal(rendered().filter(node => node.props?.className === 'pkc-stat-value').at(-1).props.children, '$10.00')
  assert.equal(rendered().some(node => node.props?.className === 'pkc-bar'), true)
  balanceMode = 'unknown-total'
  refresh().props.onClick(); await tick()
  assert.equal(rendered().filter(node => node.props?.className === 'pkc-stat-value').at(-1).props.children, '$10.00')
  balanceMode = 'partial-usage'
  refresh().props.onClick(); await tick()
  assert.equal(rendered().filter(node => node.props?.className === 'pkc-stat-value').at(-1).props.children, '—')
  assert.equal(rendered().some(node => node.props?.className === 'pkc-bar'), false)
  balanceMode = 'stale'
  refresh().props.onClick(); await tick()
  assert.equal(balanceReads.at(-1).force, true)
  assert.match(text(), /\$9\.50/u)
  assert.match(text(), /balance fixture offline/u)
  balanceMode = 'unlimited'
  refresh().props.onClick(); await tick()
  assert.match(text(), /不限额度/u)
  assert.equal(rendered().some(node => node.props?.className === 'pkc-bar'), false)
  balanceMode = 'error'
  refresh().props.onClick(); await tick()
  assert.match(text(), /balance fixture unavailable/u)
  assert.doesNotMatch(text(), /\$9\.50/u)
  show().find(node => node.type === 'button' && node.props.children === zh.keyRemove).props.onClick(); await tick()
  assert.equal(invalidations, 2)
  assert.match(text(), /尚未添加图片 Key/u)
  assert.doesNotMatch(text(), /Image fixture/u)
})
