import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, Config, inject, name } from '../src/index.js'
import { fakeCredentials } from './helpers.mjs'
import { PackyCodeKeyRing } from '../src/key-ring.js'
import { fieldValue } from '../src/preferences.js'
import { anthropicStream } from './fixtures/anthropic.mjs'

/**
 * A context that records what the plugin registers. Every service this plugin
 * injects is present, so a wiring mistake in `apply()` fails here rather than
 * at the user's next boot.
 */
function stubContext() {
  const registered = { adapters: [], directories: [], rpc: [], effects: [], tools: [] }
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
    tools: {
      register(definition) {
        registered.tools.push(definition)
        return () => {}
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

/** A configured CLI path that cannot exist, so no test starts a real Claude Code CLI. */
const NO_CLI = '/nonexistent/packycode-test-claude-cli'

test('registers one route and one directory entry, and defers the browser surface', async () => {
  const { ctx, registered } = stubContext()
  apply(ctx, { claudeCliPath: NO_CLI })

  assert.equal(name, 'packycode-api')
  // A profile without a browser surface must still boot: only the route is mandatory.
  assert.deepEqual(inject, ['llm', 'credentials'])

  assert.equal(registered.adapters.length, 1)
  assert.deepEqual(registered.adapters[0].providers, ['packycode'])
  // DSH 0.2.1 lists a route's models only once its key resolves.
  await new PackyCodeKeyRing(ctx.credentials).add('sk-apply-listing-fixture', 'listing')
  const models = await registered.adapters[0].adapter.listModels('packycode')
  assert.deepEqual(models.map(model => model.id), ['deepseek-flash', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'grok-4.7', 'gemini-4-argon', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])

  assert.deepEqual(registered.directories[0], [{
    provider: 'packycode',
    displayName: 'PackyCode',
    settingsNs: 'packycode-api',
    settingsPath: [],
  }])

  // Every optional surface is requested through ctx.inject, never injected.
  // `webServer` rides with `connection`: channel registration writes through
  // `owner.webServer`, so a scope holding only `connection` cannot register.
  // `web` carries the search providers; a profile without it still boots.
  assert.deepEqual(ctx.injected, [['settings'], ['web'], ['connection', 'webServer'], ['tools', 'attachments']])
  assert.equal(registered.rpc.length, 1)
  assert.equal(registered.rpc[0].channel, '/packycode-api')
  assert.ok(registered.effects.some(label => label.includes('loopback')))

  // The CLI is a transport, never a tool the model sees: nothing is registered
  // for it, and the 1.2 delegation settings stay gone.
  assert.deepEqual(registered.tools, [])
  assert.ok(registered.effects.includes('packycode-api: Claude Code CLI processes'))
  assert.equal(fieldValue(Config({}).claudeCliPath), '')
  // The route follows the key's groups; 1.3.4's route pin is gone with the 1.2 settings.
  for (const field of ['claudeTransport', 'claudeCliMode', 'claudeCliCwd']) assert.equal(Object.hasOwn(Config.dict, field), false)
  assert.doesNotThrow(() => Config({ claudeTransport: 'http' }), 'a profile still holding the pin loads')
  const cli = await registered.rpc[0].handler('claude-cli/status')
  assert.equal(cli.ok, true)
  assert.equal(cli.value.installed, false)
  assert.equal(cli.value.configuredPath, NO_CLI)
  assert.equal(Object.hasOwn(cli.value, 'transport'), false)
  assert.equal(cli.value.minVersion, '2.1.259')
  assert.deepEqual(cli.value.processes, { live: 0, opened: 0, continued: 0 })
})

test('native image generation remains registered after CLI delegation is removed', async () => {
  const { ctx, registered } = stubContext()
  ctx.attachments = { saveImage() {}, readImage() {} }
  apply(ctx)
  const reply = await registered.rpc[0].handler('images/keys/add', { key: 'sk-image-fixture', label: 'images' })
  assert.equal(reply.ok, true)
  assert.deepEqual(registered.tools.map(tool => tool.name), ['packycode_image_generate'])
  assert.equal(typeof registered.tools[0].execute, 'function')
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

test('Claude turns on a key outside the CLI-only groups stay on HTTP, ignoring 1.2 CLI settings', async t => {
  const { ctx, registered } = stubContext()
  await new PackyCodeKeyRing(ctx.credentials).add('sk-native-apply-fixture', 'native')
  apply(ctx, { claudeCliPath: NO_CLI, claudeCliMode: 'full', claudeCliCwd: '/nonexistent/workspace' })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    // The group reading: this key is in cc-sale, which accepts third-party clients.
    if (path === '/v1/chat/completions') return Response.json({ error: { message: '当前令牌未覆盖供应商（已选分组=[cc-sale]）' } }, { status: 400 })
    if (path === '/v1/models' || path === '/api/pricing') return Response.json({ data: [] })
    const body = await request.json()
    requests.push(body)
    return anthropicStream(body.model)
  })
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    const prepared = await registered.adapters[0].adapter.prepareCall('packycode', model)
    const chunks = []
    for await (const chunk of prepared.stream({ provider: 'packycode', model, maxTokens: 2048, messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }] })) chunks.push(chunk)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.equal(requests.at(-1).model, model)
  }
  assert.equal(requests.length, 3)
})

test('the registered route clarifies only the initiating session cwd and follows later directory changes', async t => {
  const { ctx, registered } = stubContext()
  const session = { id: 'cwd-session', header: { cwd: '/tmp/真实目录.' } }
  ctx.get = name => name === 'agents' ? { currentInitiator: () => ({ session }) } : undefined
  await new PackyCodeKeyRing(ctx.credentials).add('sk-cwd-apply-fixture', 'fixture')
  apply(ctx)
  const requests = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const body = await new Request(input, init).json(); requests.push(body)
    return anthropicStream(body.model)
  })
  const call = await registered.adapters[0].adapter.prepareCall('packycode', 'claude-haiku-5-5')
  for (const sessionId of ['cwd-session', 'unrelated-session', 'cwd-session']) {
    const cwd = session.header.cwd
    for await (const _ of call.stream({ provider: 'packycode', model: 'claude-haiku-5-5', sessionId,
      system: `Your working directory is ${cwd}.`, maxTokens: 2048,
      messages: [{ role: 'user', content: [{ type: 'text', text: '统计当前目录的文件。' }] }],
    })) { /* Drain the real adapter stream. */ }
    const system = requests.at(-1).system.map(block => block.text ?? '').join('\n')
    assert.equal(system.includes('Current working directory (exact JSON string):'), sessionId === session.id)
    if (sessionId === session.id) assert.ok(system.includes(JSON.stringify(cwd)))
    session.header.cwd = 'C:\\Users\\测试\\Other Project'
  }
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
  assert.equal(status.value.hosts.statusHost, 'https://www.packyapi.ai')

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

test('original image RPC uses a cancellable read-only session observation and always releases its lease', async () => {
  const { ctx, registered } = stubContext()
  let released = 0, broken = false
  const signal = new AbortController().signal
  ctx.get = name => name === 'sessionQuery' ? { async observeSession(id, options) {
    assert.equal(id, 'image-session')
    assert.equal(options.signal, signal)
    assert.equal(options.projectionMode, 'none')
    return { get events() { if (broken) throw new Error('storage unavailable'); return [] }, [Symbol.dispose]() { released += 1 } }
  } } : undefined
  apply(ctx)
  const rpc = registered.rpc[0].handler
  const request = { sessionId: 'image-session', attachmentId: `sha256:${'a'.repeat(64)}` }
  assert.equal((await rpc('images/original', request, signal)).ok, false)
  assert.equal(released, 1)
  broken = true
  assert.equal((await rpc('images/original', request, signal)).ok, false)
  assert.equal(released, 2)
})

test('the plugin listens on llm/stream and leaves every request it does not own to the waterfall', () => {
  const { ctx } = stubContext()
  const listeners = []
  ctx.on = (event, listener) => {
    listeners.push({ event, listener })
    return () => true
  }
  apply(ctx, Config({ claudeCliPath: NO_CLI }))
  const review = listeners.filter(entry => entry.event === 'llm/stream')
  assert.equal(review.length, 1)
  const request = { provider: 'packycode', model: 'deepseek-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  assert.equal(review[0].listener(request, () => 'next'), 'next')
})
