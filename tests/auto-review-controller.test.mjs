import assert from 'node:assert/strict'
import test from 'node:test'
import { format } from 'node:util'

import { AUTO_PRESET, createAutoReviewController, DSH_AUTO_REVIEW_ROW, readAutoReviewChoice } from '../src/auto-review-controller.js'

const flush = () => new Promise(resolve => setImmediate(resolve))

/**
 * DSH's permission-preset service at the seam auto review uses: one holder of
 * `auto`, `current()` reading `custom` once `auto` is withdrawn, and the
 * permission projection keeping the last selected preset.
 */
function fakePresets({ configured = ['read-only', 'workspace-write', 'danger-full-access'], onChange = () => {} } = {}) {
  const selected = new Map()
  let admit
  const presets = {
    get names() { return [...configured, ...(admit === undefined ? [] : [AUTO_PRESET])] },
    registerAuto(gate) {
      if (admit !== undefined) throw new Error('permission: preset "auto" is already registered')
      admit = gate
      onChange()
      return async () => {
        admit = undefined
        onChange()
      }
    },
    current(session) {
      const preset = selected.get(session) ?? 'workspace-write'
      return preset === AUTO_PRESET && admit === undefined ? 'custom' : preset
    },
    set(session, name) {
      if (!presets.names.includes(name)) throw new Error(`permission: unknown preset "${name}"`)
      if (name === AUTO_PRESET) admit()
      selected.set(session, name)
    },
    stored: session => selected.get(session),
  }
  return presets
}

/** A cordis-shaped scope: effects (generators included), events, a waterfall, and disposal. */
function fakeScope(services) {
  const listeners = new Map()
  const effects = []
  const scope = {
    ...services,
    get: name => services[name],
    on(name, listener, options) {
      const list = listeners.get(name) ?? []
      if (options?.prepend === true) list.unshift(listener)
      else list.push(listener)
      listeners.set(name, list)
      return () => {
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
        return index >= 0
      }
    },
    effect(execute) {
      const collected = []
      const result = execute()
      if (typeof result === 'function') collected.push(result)
      else if (result !== undefined && typeof result[Symbol.iterator] === 'function') {
        for (let step = result.next(); ; step = result.next()) {
          if (typeof step.value === 'function') collected.push(step.value)
          if (step.done) break
        }
      }
      let disposal
      const dispose = () => {
        disposal ??= (async () => {
          for (const disposer of collected.reverse()) await disposer()
        })()
        return disposal
      }
      effects.push(dispose)
      return dispose
    },
    emit(name, ...args) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
    },
    waterfall(name, value, fallback) {
      const list = [...(listeners.get(name) ?? [])]
      const run = index => (index < list.length ? list[index](value, () => run(index + 1)) : fallback())
      return run(0)
    },
    listeners: name => listeners.get(name)?.length ?? 0,
    async dispose() {
      for (const dispose of effects.reverse()) await dispose()
    },
  }
  return scope
}

function session(id, { policy = 'ask', messages = [] } = {}) {
  return {
    id,
    policy,
    header: { cwd: `/work/${id}` },
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: 'fix the tests' }] },
      ...messages,
      { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"rm -rf data"}' }] },
    ],
    requestHeader: () => ({ tools: [{ name: 'bash', description: 'Run a command.', parameters: { type: 'object' } }] }),
  }
}

/** The controller mounted on a fake host, plus the handles a test drives. */
async function mounted({ preference = {}, reviewer, presets: presetOptions, loaderEntry, writable = true } = {}) {
  const values = { ...preference }
  const writes = []
  const logs = []
  let scope
  const presets = fakePresets({ ...presetOptions, onChange: () => scope?.emit('permission-presets/catalog-changed') })
  const sessions = [session('s-auto'), session('s-plain'), session('s-child', { policy: 'never' })]
  scope = fakeScope({
    permissionPresets: presets,
    approval: { overrideOf: entry => entry.policy },
    sessions: { list: () => sessions },
    tools: {},
    workingDirectory: { get: entry => `${entry.header.cwd}/now` },
    sessionProjections: { stateOf: (entry, key) => (key === 'permissions' ? { preset: presets.stored(entry) ?? null } : undefined) },
  })
  const reviews = []
  const controller = createAutoReviewController({
    reviewer: {
      async review(model, snapshot, signal) {
        reviews.push({ model, snapshot, signal })
        return typeof reviewer === 'function' ? reviewer(model, snapshot, signal) : { decision: 'allow', risk: 'low' }
      },
    },
    readPreference: () => values,
    writePreference: async patch => {
      writes.push(patch)
      Object.assign(values, patch)
    },
    isWritable: () => writable,
    loaderEntry: id => loaderEntry?.(id),
    logger: { info: (...args) => logs.push(['info', format(...args)]), warn: (...args) => logs.push(['warn', format(...args)]) },
  })
  controller.mount(scope)
  await flush()
  const byId = Object.fromEntries(sessions.map(entry => [entry.id, entry]))
  const call = (sessionId, { name = 'bash', args = { command: 'rm -rf data' }, parent, downstream = { kind: 'allow' }, signal = new AbortController().signal } = {}) => {
    let downstreamCalls = 0
    const exec = { callId: 'call-1', rootCallId: parent === undefined ? 'call-1' : 'run-1', name, arguments: args, agent: { session: byId[sessionId] }, signal, ...(parent === undefined ? {} : { parent, schema: { name, description: 'x', parameters: {} } }) }
    return scope.waterfall('tools/pre-execute', exec, () => {
      downstreamCalls += 1
      return Promise.resolve(downstream)
    }).then(decision => ({ decision, downstreamCalls }))
  }
  return { controller, scope, presets, sessions: byId, reviews, writes, logs, values, call }
}

test('the stored preference reads as on with jev-latest unless it says otherwise', () => {
  assert.deepEqual(readAutoReviewChoice(undefined), { enabled: true, model: 'jev-latest' })
  assert.deepEqual(readAutoReviewChoice({ autoReview: { get: () => false }, autoReviewModel: 'deepseek-flash' }), { enabled: false, model: 'deepseek-flash' })
  assert.deepEqual(readAutoReviewChoice({ autoReviewModel: 'gpt-6.1-sol' }), { enabled: true, model: 'jev-latest' })
})

test('自动审查 is offered in the permission menu and reviews only the sessions that chose it', async () => {
  const host = await mounted()
  assert.equal(host.presets.names.includes(AUTO_PRESET), true)
  assert.equal(host.scope.listeners('tools/pre-execute'), 1)
  const status = host.controller.status()
  assert.deepEqual([status.available, status.offered, status.enabled, status.model], [true, true, true, 'jev-latest'])
  assert.deepEqual(status.models.map(model => model.id), ['jev-latest', 'deepseek-flash'])

  // A session in another preset is not reviewed at all.
  assert.deepEqual((await host.call('s-plain')).decision, { kind: 'allow' })
  assert.equal(host.reviews.length, 0)

  host.presets.set(host.sessions['s-auto'], AUTO_PRESET)
  const { decision, downstreamCalls } = await host.call('s-auto')
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(downstreamCalls, 1)
  const [review] = host.reviews
  assert.equal(review.model, 'jev-latest')
  assert.equal(review.snapshot.environment.cwd, '/work/s-auto/now')
  assert.deepEqual(review.snapshot.pendingAction.arguments, { command: 'rm -rf data' })
  assert.deepEqual(host.controller.status().counts, { reviewed: 1, allowed: 1, asked: 0, denied: 0, failed: 0 })
  assert.equal(host.controller.status().last.tool, 'bash')
  assert.equal(host.logs.at(-1)[0], 'info')
  assert.match(host.logs.at(-1)[1], /^packycode-api: auto review allowed bash \(jev-latest, low risk, \d+ ms\)$/u)
})

test('a denial asks the human, naming the reviewer and its reason', async () => {
  let answer = { decision: 'deny', risk: 'medium' }
  const host = await mounted({ reviewer: () => answer })
  host.presets.set(host.sessions['s-auto'], AUTO_PRESET)
  const jev = (await host.call('s-auto')).decision
  assert.equal(jev.kind, 'ask')
  assert.match(jev.displayReason.zh, /^PackyCode 自动审查（jev-latest）拒绝了此调用：中风险操作/u)
  assert.match(jev.displayReason.en, /medium-risk action that you have not explicitly asked for/u)
  assert.match(jev.reason, /denied tool "bash"/u)

  answer = { decision: 'deny', risk: 'high', reason: '会把客户数据发到外部网站' }
  await host.controller.update({ autoReviewModel: 'deepseek-flash' })
  const flash = (await host.call('s-auto')).decision
  assert.equal(flash.displayReason.zh, 'PackyCode 自动审查（DeepSeek Flash）拒绝了此调用：会把客户数据发到外部网站')
  assert.equal(host.reviews.at(-1).model, 'deepseek-flash')
  assert.equal(host.controller.status().counts.asked, 2)
})

test('in a child whose policy is never, a denial is final and renders as Auto review\'s refusal', async () => {
  const host = await mounted({ reviewer: () => ({ decision: 'deny', risk: 'high' }) })
  host.presets.set(host.sessions['s-child'], AUTO_PRESET)
  const { decision } = await host.call('s-child')
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.info.name, 'AutoReviewDeniedError')
  assert.equal(decision.info.code, 'AUTO_REVIEW_DENIED')
  assert.match(decision.info.reason, /^jev-latest: 高风险操作/u)
  assert.equal(host.controller.status().counts.denied, 1)
})

test('a review that fails asks the human instead of running the call', async () => {
  const host = await mounted({ reviewer: () => { throw new Error('PackyCode auto review failed: Error 502: Bad gateway') } })
  host.presets.set(host.sessions['s-auto'], AUTO_PRESET)
  const asked = (await host.call('s-auto')).decision
  assert.equal(asked.kind, 'ask')
  assert.match(asked.displayReason.zh, /未能完成审查：PackyCode auto review failed: Error 502/u)
  host.presets.set(host.sessions['s-child'], AUTO_PRESET)
  const final = (await host.call('s-child')).decision
  assert.equal(final.kind, 'deny')
  assert.match(final.reason, /its body was not executed/u)
  assert.equal(host.controller.status().counts.failed, 2)
  assert.equal(host.logs.filter(([level]) => level === 'warn').length, 2)
})

test('later policy decides without a review, run_code itself is not reviewed, and a cancelled call is cancelled', async () => {
  const host = await mounted()
  host.presets.set(host.sessions['s-auto'], AUTO_PRESET)
  const denied = { kind: 'deny', reason: 'plan mode blocks edits' }
  assert.deepEqual((await host.call('s-auto', { downstream: denied })).decision, denied)
  assert.deepEqual((await host.call('s-auto', { name: 'run_code', args: { code: 'x' } })).decision, { kind: 'allow' })
  assert.equal(host.reviews.length, 0)
  // Each inner call of a PTC program is reviewed on its own.
  await host.call('s-auto', { name: 'read_file', args: { path: 'a' }, parent: {} })
  assert.equal(host.reviews.at(-1).snapshot.pendingAction.mode, 'ptc-inner')
  const stopped = new AbortController()
  stopped.abort()
  assert.deepEqual((await host.call('s-auto', { signal: stopped.signal })).decision, { kind: 'cancel' })
})

test('DSH\'s own integration, or any other holder of the preset, keeps it; ours waits for the release', async () => {
  const dsh = await mounted({ loaderEntry: id => (id === DSH_AUTO_REVIEW_ROW ? { options: { id }, disabled: false } : undefined) })
  assert.deepEqual([dsh.controller.status().offered, dsh.controller.status().blocked], [false, 'dsh-integration'])
  assert.equal(dsh.presets.names.includes(AUTO_PRESET), false)

  // A switched-off DSH row does not count.
  const off = await mounted({ loaderEntry: id => (id === DSH_AUTO_REVIEW_ROW ? { options: { id, disabled: true }, disabled: true } : undefined) })
  assert.equal(off.controller.status().offered, true)

  const host = await mounted({ preference: { autoReview: false } })
  const releaseOther = host.presets.registerAuto(() => {})
  await host.controller.update({ autoReview: true })
  assert.deepEqual([host.controller.status().offered, host.controller.status().blocked], [false, 'occupied'])
  // The other integration's sessions are never reviewed by this one.
  host.presets.set(host.sessions['s-auto'], AUTO_PRESET)
  await host.call('s-auto')
  assert.equal(host.reviews.length, 0)
  await releaseOther()
  await flush()
  assert.equal(host.controller.status().offered, true)
})

test('switching the option off moves every session out of auto review before withdrawing it', async () => {
  const host = await mounted()
  host.presets.set(host.sessions['s-auto'], AUTO_PRESET)
  const status = await host.controller.update({ autoReview: false })
  assert.deepEqual(host.writes, [{ autoReview: false }])
  assert.equal(status.offered, false)
  assert.equal(host.presets.current(host.sessions['s-auto']), 'workspace-write')
  assert.equal(host.presets.names.includes(AUTO_PRESET), false)

  const readOnly = await mounted({ presets: { configured: ['read-only', 'danger-full-access'] } })
  readOnly.presets.set(readOnly.sessions['s-auto'], AUTO_PRESET)
  await readOnly.controller.update({ autoReview: false })
  assert.equal(readOnly.presets.current(readOnly.sessions['s-auto']), 'read-only')
})

test('unloading the plugin moves sessions out of auto review first, then removes the gate', async () => {
  const host = await mounted()
  host.presets.set(host.sessions['s-auto'], AUTO_PRESET)
  await host.scope.dispose()
  assert.equal(host.presets.stored(host.sessions['s-auto']), 'workspace-write')
  assert.equal(host.presets.names.includes(AUTO_PRESET), false)
  assert.equal(host.scope.listeners('tools/pre-execute'), 0)
  assert.equal(host.controller.status().available, false)
})

test('a host without the Auto seam reports it and never touches the menu', async () => {
  const scope = fakeScope({ permissionPresets: { current: () => 'workspace-write' }, approval: {}, sessions: { list: () => [] }, tools: {} })
  const controller = createAutoReviewController({ reviewer: { review: async () => ({}) }, readPreference: () => ({}) })
  controller.mount(scope)
  await flush()
  assert.deepEqual([controller.status().available, controller.status().blocked], [false, 'unsupported'])
  assert.equal(scope.listeners('tools/pre-execute'), 0)
})

test('a preference change is validated and must be writable', async () => {
  const host = await mounted()
  await assert.rejects(host.controller.update({ autoReviewModel: 'gpt-6.1-sol' }), /model is not supported/u)
  await assert.rejects(host.controller.update({ autoReview: 'yes' }), /setting is not supported/u)
  assert.deepEqual(host.writes, [])
  const status = await host.controller.update({ autoReviewModel: 'deepseek-flash' })
  assert.equal(status.model, 'deepseek-flash')
  const locked = await mounted({ writable: false })
  await assert.rejects(locked.controller.update({ autoReview: false }), /not writable/u)
  assert.equal(locked.controller.status().writable, false)
})
