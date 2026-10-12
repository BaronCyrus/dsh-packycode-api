import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../src/index.js'

/** In-memory credential-record service for the ring. */
function fakeCredentials() {
  let record
  let chain = Promise.resolve()
  return {
    async readRecord() {
      return record
    },
    modifyRecord(_key, mutate) {
      const run = chain.then(async () => {
        const next = await mutate(record)
        if (next !== undefined) record = next
        return record
      })
      chain = run.then(() => undefined, () => undefined)
      return run
    },
  }
}

/**
 * A context that records what the plugin registers. Every service this plugin
 * injects is present, so a wiring mistake in `apply()` fails here rather than
 * at the user's next boot.
 */
function stubContext() {
  const registered = { adapters: [], directories: [], rpc: [], effects: [] }
  const ctx = {
    credentials: fakeCredentials(),
    injected: [],
    injectedOptions: [],
    attachments: undefined,
    logger: { warn: () => {} },
    llm: {
      registerAdapter(providers, adapter) {
        registered.adapters.push({ providers, adapter })
        return () => {}
      },
      registerConfigurableProviders(entries) {
        registered.directories.push(entries)
        return () => {}
      },
    },
    connection: {
      rpc: {
        handle(channel, handler) {
          registered.rpc.push({ channel, handler })
          return () => {}
        },
      },
    },
    get: () => undefined,
    inject(services, callback) {
      ctx.injected.push(services)
      callback(ctx)
    },
    effect(callback, label) {
      registered.effects.push(label)
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  return { ctx, registered }
}

test('registers one route and one directory entry, and defers the browser surface', async () => {
  const { ctx, registered } = stubContext()
  apply(ctx)

  assert.equal(name, 'packycode-api')
  // A profile without a browser surface must still boot: only the route is mandatory.
  assert.deepEqual(inject, ['llm', 'credentials'])

  assert.equal(registered.adapters.length, 1)
  assert.deepEqual(registered.adapters[0].providers, ['packycode'])
  const models = await registered.adapters[0].adapter.listModels('packycode')
  assert.deepEqual(models.map(model => model.id), ['deepseek-flash', 'gpt-6.1-sol', 'claude-opus-5-5'])

  assert.deepEqual(registered.directories[0], [{
    provider: 'packycode',
    displayName: 'PackyCode',
    settingsNs: 'packycode-api',
    settingsPath: [],
  }])

  // Both optional services are requested through ctx.inject, never injected.
  assert.deepEqual(ctx.injected, [['settings'], ['connection']])
  assert.equal(registered.rpc.length, 1)
  assert.equal(registered.rpc[0].channel, '/packycode-api')
  assert.ok(registered.effects.some(label => label.includes('loopback')))
})

test('a profile without a connection service still registers the route', () => {
  const { ctx, registered } = stubContext()
  // The connection service never appears, exactly as in a headless profile.
  ctx.inject = (services, callback) => {
    ctx.injected.push(services)
    if (services.includes('connection')) return
    callback(ctx)
  }
  apply(ctx)
  assert.equal(registered.adapters.length, 1)
  assert.deepEqual(registered.rpc, [])
})

test('the RPC surface refuses key material and answers status without one', async () => {
  const { ctx, registered } = stubContext()
  apply(ctx)
  const handler = registered.rpc[0].handler

  const status = await handler('status')
  assert.equal(status.ok, true)
  assert.deepEqual(status.value.keys, [])
  assert.equal(status.value.activeId, undefined)
  assert.equal(status.value.hosts.apiHost, 'https://cf.api.fan')
  assert.equal(status.value.hosts.statusHost, 'https://www.packyapi.com')

  const added = await handler('keys/add', { key: 'sk-abcdefgh12345678', label: 'first' })
  assert.equal(added.ok, true)
  assert.equal(added.value.keys.length, 1)
  assert.equal(added.value.keys[0].label, 'first')
  assert.equal(JSON.stringify(added.value).includes('sk-abcdefgh'), false)

  const listed = await handler('keys/status')
  assert.equal(listed.ok, false)
  assert.match(listed.error.message, /Unknown PackyCode endpoint/u)

  const rejected = await handler('keys/add', { key: 'nope' })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error.message, /printable ASCII/u)
})
