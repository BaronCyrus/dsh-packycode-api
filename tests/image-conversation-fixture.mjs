import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

import { imageConversationNode } from '../src/image-conversation.js'

/**
 * Each tested host's DSH client packages: 0.2.1 is the development host
 * (devDependencies); 0.2.0 keeps its own fixture graph.
 */
const HOSTS = Object.freeze({
  '0.2.0': createRequire(import.meta.resolve('packycode-host-v020-fixture')),
  '0.2.1': createRequire(import.meta.url),
})
/** Every host the client fixtures run on, oldest first. */
export const HOST_VERSIONS = Object.freeze(Object.keys(HOSTS))
/** The development host, used when a test names none. */
export const CURRENT_HOST = '0.2.1'

/** Where one tested host resolves a package, for tests that load it directly. */
export function hostResolve(version, specifier) {
  return HOSTS[version].resolve(specifier)
}

const bundleOf = (version, specifier) => readFileSync(hostResolve(version, specifier), 'utf8')

/** Include the actual registries, bound event feed and image cache for lifecycle tests. */
export function conversationServiceSource(version = CURRENT_HOST) {
  const bundle = bundleOf(version, '@deepseek-ai/dsh-client-ui-conversation/client')
  const weakStart = bundle.indexOf('var WeakMapWithValues = class')
  const weakEnd = bundle.indexOf('//#endregion', weakStart)
  const start = bundle.indexOf('//#region lib/types/client/contract/conversation.js')
  const end = bundle.indexOf('//#region lib/types/client/stores.js', start)
  assert.ok(weakStart >= 0 && weakEnd > weakStart && start > weakEnd && end > start)
  return `${bundle.slice(weakStart, weakEnd)}\n${bundle.slice(start, end)}`
}

export function slotRegistrySource(version = CURRENT_HOST) {
  const bundle = bundleOf(version, '@deepseek-ai/dsh-client-ui-renderer/client')
  const start = bundle.indexOf('//#region lib/types/client/registry.js')
  const end = bundle.indexOf('//#region lib/types/client/index.js', start)
  assert.ok(start >= 0 && end > start)
  return bundle.slice(start, end)
}

/** Use DSH's shipped assembler and location index, with only its snapshot sink replaced. */
export function conversationSource(version = CURRENT_HOST) {
  const bundle = bundleOf(version, '@deepseek-ai/dsh-client-ui-conversation/client')
  const start = bundle.indexOf('//#region lib/types/client/contract/conversation.js')
  const end = bundle.indexOf('//#region lib/types/client/conversation/definition-registry.js')
  assert.ok(start >= 0 && end > start, 'pinned DSH conversation runtime is available')
  return bundle.slice(start, end)
}

export function assembler(version = CURRENT_HOST, realChat = false, definition = imageConversationNode) {
  const Runtime = vm.runInNewContext(`${conversationSource(version)}\nConversationNodeAssembler`, {
    _deepseek_ai_dsh_client_store: { notifySubscribers: listeners => { for (const listener of listeners) listener() } },
  })
  const view = realChat ? chatRuntime(version).view : undefined
  const groups = realChat ? chatRuntime(version).groups : undefined
  return new Runtime({ entries: () => [definition], fallbackEntry: () => undefined }, view ? { entries: () => [view] } : {
    entries: () => [{ target: 'chat', create() {
      const nodes = new Map()
      const snapshot = () => [...nodes.values()].filter(node => node.visibility === 'visible')
      return { empty: [], replace(input) { nodes.clear(); for (const node of input.nodes) nodes.set(node.key, node); return snapshot() },
        apply(input) { for (const node of input.upserts) nodes.set(node.key, node); return snapshot() } }
    } }],
  }, groups ? { forTarget: target => target === 'chat' ? groups : undefined } : undefined)
}

/** One `//#region` of a host bundle, or nothing when this host has no such region. */
function region(bundle, name) {
  const start = bundle.indexOf(`//#region ${name}`)
  if (start < 0) return ''
  const end = bundle.indexOf('//#region', start + 1)
  return bundle.slice(start, end < 0 ? undefined : end)
}

export function chatSource(version = CURRENT_HOST) {
  const bundle = bundleOf(version, '@deepseek-ai/dsh-client-ui-chat/client')
  const start = bundle.indexOf('//#region lib/types/client/contract/chat-nodes.js')
  const end = bundle.indexOf('//#region ../../core/session/lib/types/surface.js', start)
  const groupStart = bundle.indexOf('//#region lib/types/client/conversation-nodes/process-activity.js')
  const groupEnd = bundle.indexOf('//#region lib/types/client/conversation-nodes/register.js', groupStart)
  assert.ok(start >= 0 && end > start && groupStart >= end && groupEnd > groupStart)
  // DSH 0.2.1 moved helpers the Chat store calls (locationCoordinates,
  // isAtOrOutside) out of the chat-nodes region.
  const helpers = ['lib/types/client/contract/group-tree.js', 'lib/types/client/conversation-nodes/common.js'].map(name => region(bundle, name))
  return `${helpers.join('\n')}\n${bundle.slice(start, end)}\n${bundle.slice(groupStart, groupEnd)}`
}

/** Keep the real Chat store, ordering, navigation and grouping in the feedback loop. */
export function chatRuntime(version = CURRENT_HOST) {
  return vm.runInNewContext(`${chatSource(version)}\n({view: chatViewDefinition, groups: processGroupDefinition})`, {
    brandString: value => value,
    _deepseek_ai_dsh_client_store: { notifySubscribers: listeners => { for (const listener of listeners) listener() } },
  })
}

/** Exercise the real 0.2 chat grouping policy; custom Turn nodes default to process groups. */
export function chatRoots(nodes, version = CURRENT_HOST) {
  const bundle = bundleOf(version, '@deepseek-ai/dsh-client-ui-chat/client')
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
