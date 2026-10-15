import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

import { imageConversationNode } from '../src/image-conversation.js'

const host020 = createRequire(import.meta.resolve('packycode-host-v020-fixture'))

/** Use DSH's shipped assembler and location index, with only its snapshot sink replaced. */
export function conversationSource(version = '0.2.0') {
  const bundle = readFileSync(version === '0.2.0' ? host020.resolve('@deepseek-ai/dsh-client-ui-conversation/client')
    : new URL('../node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', import.meta.url), 'utf8')
  const start = bundle.indexOf('//#region lib/types/client/contract/conversation.js')
  const end = bundle.indexOf('//#region lib/types/client/conversation/definition-registry.js')
  assert.ok(start >= 0 && end > start, 'pinned DSH conversation runtime is available')
  return bundle.slice(start, end)
}

export function assembler(version = '0.1.5', realChat = false, definition = imageConversationNode) {
  const Runtime = vm.runInNewContext(`${conversationSource(version)}\nConversationNodeAssembler`, {
    _deepseek_ai_dsh_client_store: { notifySubscribers: listeners => { for (const listener of listeners) listener() } },
  })
  const view = realChat ? chatRuntime().view : undefined
  const groups = realChat ? chatRuntime().groups : undefined
  return new Runtime({ entries: () => [definition], fallbackEntry: () => undefined }, view ? { entries: () => [view] } : {
    entries: () => [{ target: 'chat', create() {
      const nodes = new Map()
      const snapshot = () => [...nodes.values()].filter(node => node.visibility === 'visible')
      return { empty: [], replace(input) { nodes.clear(); for (const node of input.nodes) nodes.set(node.key, node); return snapshot() },
        apply(input) { for (const node of input.upserts) nodes.set(node.key, node); return snapshot() } }
    } }],
  }, groups ? { forTarget: target => target === 'chat' ? groups : undefined } : undefined)
}

export function chatSource() {
  const bundle = readFileSync(host020.resolve('@deepseek-ai/dsh-client-ui-chat/client'), 'utf8')
  const start = bundle.indexOf('//#region lib/types/client/contract/chat-nodes.js')
  const end = bundle.indexOf('//#region ../../core/session/lib/types/surface.js', start)
  const groupStart = bundle.indexOf('//#region lib/types/client/conversation-nodes/process-activity.js')
  const groupEnd = bundle.indexOf('//#region lib/types/client/conversation-nodes/register.js', groupStart)
  assert.ok(start >= 0 && end > start && groupStart >= end && groupEnd > groupStart)
  return `${bundle.slice(start, end)}\n${bundle.slice(groupStart, groupEnd)}`
}

/** Keep the real Chat store, ordering, navigation and grouping in the feedback loop. */
export function chatRuntime() {
  return vm.runInNewContext(`${chatSource()}\n({view: chatViewDefinition, groups: processGroupDefinition})`, {
    brandString: value => value,
    _deepseek_ai_dsh_client_store: { notifySubscribers: listeners => { for (const listener of listeners) listener() } },
  })
}

/** Exercise the real 0.2 chat grouping policy; custom Turn nodes default to process groups. */
export function chatRoots(nodes) {
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
