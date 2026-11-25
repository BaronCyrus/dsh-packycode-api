import assert from 'node:assert/strict'
import test from 'node:test'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import {
  apply,
  Config,
  createPackyCodeProfile,
  createPackyCodeProvider,
  createRouteAdapter,
  createRouteSettingsController,
  DEFAULT_MAX_RETRIES,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_MAX_RETRIES,
  MAX_STREAM_IDLE_TIMEOUT_MS,
  MIN_MAX_RETRIES,
  MIN_STREAM_IDLE_TIMEOUT_MS,
  PackyCodeKeyRing,
  readRouteSettings,
} from '../src/index.js'
import { fieldValue } from '../src/preferences.js'
import { fakeCredentials } from './helpers.mjs'

test('route retry and timeout settings are volatile in Config and enforce integer bounds', () => {
  assert.equal(Config.dict.maxRetries.meta.volatile, true)
  assert.equal(Config.dict.streamIdleTimeoutMs.meta.volatile, true)
  const defaults = Config({})
  assert.equal(fieldValue(defaults.maxRetries), DEFAULT_MAX_RETRIES)
  assert.equal(fieldValue(defaults.streamIdleTimeoutMs), DEFAULT_STREAM_IDLE_TIMEOUT_MS)

  const custom = Config({ maxRetries: 0, streamIdleTimeoutMs: 300_000 })
  assert.equal(fieldValue(custom.maxRetries), 0)
  assert.equal(fieldValue(custom.streamIdleTimeoutMs), 300_000)

  for (const bad of [
    { maxRetries: -1 },
    { maxRetries: MAX_MAX_RETRIES + 1 },
    { maxRetries: 2.5 },
    { streamIdleTimeoutMs: MIN_STREAM_IDLE_TIMEOUT_MS - 1 },
    { streamIdleTimeoutMs: MAX_STREAM_IDLE_TIMEOUT_MS + 1 },
    { streamIdleTimeoutMs: 60_000.5 },
  ]) {
    assert.throws(() => Config(bad), JSON.stringify(bad))
  }
})

test('readRouteSettings falls back to defaults for missing or out-of-range values', () => {
  assert.deepEqual(readRouteSettings(undefined), {
    maxRetries: DEFAULT_MAX_RETRIES,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  })
  assert.deepEqual(readRouteSettings({ maxRetries: -5, streamIdleTimeoutMs: 100 }), {
    maxRetries: DEFAULT_MAX_RETRIES,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  })
  assert.deepEqual(readRouteSettings({ maxRetries: 15, streamIdleTimeoutMs: 300_000 }), {
    maxRetries: 15,
    streamIdleTimeoutMs: 300_000,
  })
})

test('createRouteSettingsController validates updates, writes patches and reconciles changes', async () => {
  let stored = {}
  let writable = true
  let changed = 0
  const writes = []
  const controller = createRouteSettingsController({
    readPreference: () => stored,
    isWritable: () => writable,
    writePreference: async patch => {
      writes.push(patch)
      stored = { ...stored, ...patch }
    },
    onChange: () => { changed += 1 },
  })

  assert.deepEqual(controller.status(), {
    writable: true,
    maxRetries: 20,
    streamIdleTimeoutMs: 600_000,
    defaults: { maxRetries: 20, streamIdleTimeoutMs: 600_000 },
    limits: {
      maxRetries: { min: MIN_MAX_RETRIES, max: MAX_MAX_RETRIES },
      streamIdleTimeoutMs: { min: MIN_STREAM_IDLE_TIMEOUT_MS, max: MAX_STREAM_IDLE_TIMEOUT_MS },
    },
  })

  await assert.rejects(() => controller.update({}), /not supported/u)
  await assert.rejects(() => controller.update({ maxRetries: 101 }), /integer from 0 to 100/u)
  await assert.rejects(() => controller.update({ streamIdleTimeoutMs: 10_000 }), /between 30s and 3600s/u)

  const after = await controller.update({ maxRetries: 8, streamIdleTimeoutMs: 180_000 })
  assert.equal(after.maxRetries, 8)
  assert.equal(after.streamIdleTimeoutMs, 180_000)
  assert.equal(changed, 1)
  assert.deepEqual(writes, [{ maxRetries: 8, streamIdleTimeoutMs: 180_000 }])

  // Re-applying identical values does not trigger redundant route replacements.
  controller.reconcile()
  assert.equal(changed, 1)

  writable = false
  await assert.rejects(() => controller.update({ maxRetries: 5 }), /not writable/u)
})

test('createPackyCodeProfile applies configured retry count and raises SDK timeoutMs above 10 minutes', () => {
  const provider = createPackyCodeProvider()
  const base = createPackyCodeProfile(provider)
  assert.equal(base.retryPolicy.maxRetries, 20)
  assert.equal(base.streamIdleTimeoutMs, 600_000)
  assert.equal(base.timeoutMs, undefined)

  const shorter = createPackyCodeProfile(provider, { maxRetries: 0, streamIdleTimeoutMs: 120_000 })
  assert.equal(shorter.retryPolicy.maxRetries, 0)
  assert.equal(shorter.streamIdleTimeoutMs, 120_000)
  assert.equal(shorter.timeoutMs, undefined)

  const longer = createPackyCodeProfile(provider, { maxRetries: 40, streamIdleTimeoutMs: 1_200_000 })
  assert.equal(longer.retryPolicy.maxRetries, 40)
  assert.equal(longer.streamIdleTimeoutMs, 1_200_000)
  assert.equal(longer.timeoutMs, 1_200_000)
})

test('updating route settings through RPC hot-replaces the registered route retryPolicy without restarting', async () => {
  const listeners = new Map()
  let state = Config({})
  let handler
  let registeredAdapter
  const replacements = []
  const ctx = {
    credentials: fakeCredentials(),
    logger: { warn: () => {} },
    fiber: { entry: { options: { id: 'packycode-api' } } },
    llm: {
      registerAdapter(_providers, adapter) {
        registeredAdapter = adapter
        const handle = () => {}
        handle.replace = next => replacements.push({ next, policy: adapter.providerRetryPolicy('packycode') })
        return handle
      },
      registerConfigurableProviders: () => () => {},
    },
    on(event, fn) {
      listeners.set(event, fn)
      return () => listeners.delete(event)
    },
    get: () => undefined,
    inject(services, callback) {
      if (services.includes('settings')) {
        return callback({
          effect: ctx.effect,
          settings: {
            writable: true,
            configure: () => () => {},
            update: async (_id, patch) => {
              state = Config({
                maxRetries: patch.maxRetries ?? fieldValue(state.maxRetries),
                streamIdleTimeoutMs: patch.streamIdleTimeoutMs ?? fieldValue(state.streamIdleTimeoutMs),
              })
              listeners.get('loader/volatile-update')?.()
            },
          },
        })
      }
      if (services.includes('connection')) {
        return callback({
          effect: ctx.effect,
          connection: { rpc: { handle(_ch, fn) { handler = fn; return () => {} } } },
        })
      }
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }

  // Pass volatile getters like DSH 0.2 does.
  const dynamicConfig = {
    get maxRetries() { return state.maxRetries },
    get streamIdleTimeoutMs() { return state.streamIdleTimeoutMs },
  }
  apply(ctx, dynamicConfig)
  assert.equal(registeredAdapter.providerRetryPolicy('packycode').maxRetries, 20)

  const initial = await handler('route/status', {})
  assert.equal(initial.ok, true)
  assert.equal(initial.value.maxRetries, 20)
  assert.equal(initial.value.streamIdleTimeoutMs, 600_000)

  const updated = await handler('route/update', { maxRetries: 12, streamIdleTimeoutMs: 300_000 })
  assert.equal(updated.ok, true)
  assert.equal(updated.value.maxRetries, 12)
  assert.equal(updated.value.streamIdleTimeoutMs, 300_000)
  assert.equal(registeredAdapter.providerRetryPolicy('packycode').maxRetries, 12)
  assert.ok(replacements.length >= 1)
  assert.equal(replacements.at(-1).policy.maxRetries, 12)
})

test('createRouteAdapter enforces a reconfigured streamIdleTimeoutMs on subsequent requests', async t => {
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add('sk-timeout-fixture-not-a-real-key', 'fixture')
  let settings = { maxRetries: 5, streamIdleTimeoutMs: 30_000 }
  const adapter = createRouteAdapter({
    ring,
    keys: { active: () => ring.activeKey(), forRequest: (_m, key) => key, onKeyFailure() {} },
    getRouteSettings: () => settings,
  })
  assert.equal(adapter.providerRetryPolicy('packycode').maxRetries, 5)
  settings = { maxRetries: 9, streamIdleTimeoutMs: 45_000 }
  assert.equal(adapter.providerRetryPolicy('packycode').maxRetries, 9)

  // Verify the adapter still streams normally after reconfiguration.
  t.mock.method(globalThis, 'fetch', async () => new Response([
    `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } } })}\n\n`,
  ].join(''), { headers: { 'Content-Type': 'text/event-stream' } }))
  const prepared = await adapter.prepareCall('packycode', 'gpt-6.2-sol')
  let finish
  for await (const chunk of prepared.stream({
    provider: 'packycode',
    model: 'gpt-6.2-sol',
    sessionId: 'timeout-session',
    reasoningEffort: 'low',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'ok' }], source: { kind: 'user' } })],
  })) {
    if (chunk.type === 'finish') finish = chunk.reason
  }
  assert.equal(finish.kind, 'stop')
})
