import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../src/index.js'

/** In-memory credential-record service for the key ring. */
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
 * A context whose settings and connection services behave like the real ones
 * at the two seams this plugin uses: a section install that hands back a live
 * source, and a loopback RPC registration.
 */
function makeContext({ installSection = true, update = true } = {}) {
  const seen = { installed: undefined, updates: [], handler: undefined, adapters: [], injected: [] }
  const ctx = {
    credentials: fakeCredentials(),
    attachments: undefined,
    logger: { warn: () => {} },
    llm: {
      registerAdapter(providers, adapter) {
        seen.adapters.push({ providers, adapter })
        return () => {}
      },
      registerConfigurableProviders() {
        return () => {}
      },
    },
    get: () => undefined,
    inject(services, callback) {
      seen.injected.push(services)
      if (services.includes('settings')) {
        const settings = {
          installSection(owner, ns, schema, entry, hooks) {
            if (!installSection) throw new Error('this profile mounts no settings provider')
            seen.installed = { owner, ns, schema, entry, hooks }
          },
        }
        if (update) {
          settings.update = async (ns, patch) => {
            seen.updates.push({ ns, patch })
          }
        }
        return callback({ settings })
      }
      if (services.includes('tools')) {
        return callback({ tools: { register: () => () => {} } })
      }
      if (services.includes('connection')) {
        return callback({
          connection: {
            rpc: {
              handle(channel, handler) {
                seen.handler = handler
                seen.channel = channel
                return () => {}
              },
            },
          },
        })
      }
      return callback(ctx)
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  return { ctx, seen }
}

test('installs its host-override section under its own namespace', () => {
  const { ctx, seen } = makeContext()
  apply(ctx)
  assert.equal(seen.installed.ns, 'packycode-api')
  assert.equal(seen.installed.entry.apiHost, 'https://cf.api.fan')
  assert.equal(seen.installed.entry.statusHost, 'https://www.packyapi.com')
  assert.equal(typeof seen.installed.hooks.setSource, 'function')
  assert.equal(typeof seen.installed.hooks.onChange, 'function')
})

test('the settings source becomes the host resolution, and writes go back to it', async () => {
  const { ctx, seen } = makeContext()
  apply(ctx)

  const before = await seen.handler('status')
  assert.equal(before.value.hosts.apiHost, 'https://cf.api.fan')
  assert.equal(before.value.writable, true)

  // The real service hands back a getter; a plain value must work too.
  let current = { apiHost: 'https://gateway.example/', statusHost: 'https://status.example' }
  seen.installed.hooks.setSource(() => current)
  const after = await seen.handler('status')
  assert.equal(after.value.hosts.apiHost, 'https://gateway.example')
  assert.equal(after.value.hosts.statusHost, 'https://status.example')

  // A trailing slash is dropped; an unusable value falls back to what stands.
  const updated = await seen.handler('hosts/update', { apiHost: 'https://other.example//', statusHost: 'not a url' })
  assert.equal(updated.ok, true)
  assert.deepEqual(seen.updates[0], {
    ns: 'packycode-api',
    patch: { apiHost: 'https://other.example', statusHost: 'https://status.example' },
  })

  // ...and the section's change hook is wired to drop the balance cache.
  seen.installed.hooks.onChange()
})

test('a runtime whose settings service cannot write keeps the read-only posture', async () => {
  const { ctx, seen } = makeContext({ update: false })
  apply(ctx)
  const status = await seen.handler('status')
  assert.equal(status.value.writable, false)
  const refused = await seen.handler('hosts/update', { apiHost: 'https://x.example' })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /not writable/u)
})

test('a profile without a settings provider still serves its route', () => {
  const { ctx, seen } = makeContext({ installSection: false })
  apply(ctx)
  assert.equal(seen.installed, undefined)
  assert.equal(seen.adapters.length, 1)
  assert.deepEqual(seen.injected, [['settings'], ['connection', 'webServer'], ['tools']])
  assert.equal(seen.channel, '/packycode-api')
})
