import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import * as react from 'react'
import * as jsx from 'react/jsx-runtime'
import TestRenderer from 'react-test-renderer'
import { zh } from '../src/client-copy.js'

const { act, create } = TestRenderer

test('the built Claude web tool card switches from call preview to applied patch and retains inspect and error details', t => {
  let plugin, card
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(spec) { plugin = spec.factory(name => name === 'react' ? react : jsx) } } },
    document: { head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) },
  })
  plugin.apply({
    get: () => ({ rpc: {} }), locale: { register() {}, bind: () => key => zh[key] },
    effect: fn => fn(), inject() {},
    slots: { inject: (_name, register) => register(), register(spec, component) {
      if (spec.name === 'tool.call.toolview' && spec.key === 'claude_code') card = props => react.createElement(component, { ...spec.inject('a'), ...props })
    } },
  })
  const call = { name: 'claude_code', phase: 'start', argsRaw: JSON.stringify({ tool: 'Write', input: { file_path: 'note', content: 'requested' } }) }
  let root, inspected = 0
  const props = { block: call, phase: 'start', inspect: () => inspected++ }
  act(() => { root = create(card(props)) })
  t.after(() => act(() => root.unmount()))
  act(() => root.root.findByProps({ 'aria-expanded': false }).props.onClick())
  const display = () => JSON.stringify(root.toJSON())
  assert.match(display(), /调用预览/u)
  const block = { kind: 'tool-result', call, content: [{ type: 'text', text: 'Written' }],
    meta: { kind: 'claude-file-diff', patch: { path: 'note', created: false, hunks: [{ oldStart: 2, newStart: 2, lines: [' context', '-actual old', '+actual new'] }] } } }
  act(() => root.update(card({ ...props, block, phase: 'result' })))
  assert.match(display(), /实际文件改动/u)
  assert.match(display(), /-actual old/u)
  assert.doesNotMatch(display(), /requested|调用预览/u)
  act(() => root.root.findAllByType('button').find(button => button.children.includes(zh.cliInspectCall)).props.onClick())
  assert.equal(inspected, 1)
  act(() => root.update(card({ ...props, block: { ...block, meta: undefined }, phase: 'result' })))
  assert.match(display(), /调用预览/u, 'older CLI results have an explicitly labelled preview')
  act(() => root.update(card({ ...props, block: { ...block, isError: true, content: [{ type: 'text', text: 'Denied in DSH' }] }, phase: 'result' })))
  assert.match(display(), /Denied in DSH/u)
  assert.doesNotMatch(display(), /实际文件改动/u)
})
