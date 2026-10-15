import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createClaudeImageService, MAX_CLI_IMAGE_CALLS } from '../src/claude-images.js'
import { createClaudeSearchBridge } from '../src/claude-search-mcp.js'
import { createPackyCodeImageClient, IMAGE_TOOL_NAME } from '../src/images.js'

const KEY = 'sk-fixture-image-key-never-given-to-cli'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jpj8AAAAASUVORK5CYII=', 'base64')
const REF = { attachmentId: `sha256:${'a'.repeat(64)}`, bytes: PNG.length, mediaType: 'image/png', width: 1, height: 1, name: 'reference.png' }
const signal = () => new AbortController().signal
const response = () => Response.json({ data: [{ b64_json: PNG.toString('base64') }], quality: 'xhigh' })

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'packy-cli-images-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const calls = []
  const delivered = []
  const reads = []
  let invalidations = 0
  const preference = { imageEnabled: true, imageModel: 'gpt-image-2.5-sunburst', imageQuality: 'xhigh' }
  const refs = new Map([[REF.attachmentId, REF]])
  const attachments = {
    imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
    readImage: async ref => { assert.ok(refs.has(ref.attachmentId)); reads.push(ref); return { ref: refs.get(ref.attachmentId), data: PNG } },
    saveImage: async ({ data, name }) => {
      const ref = { ...REF, name, attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}` }
      refs.set(ref.attachmentId, ref)
      return ref
    },
  }
  const client = createPackyCodeImageClient({ resolveKey: async () => ({ key: KEY }), getHost: () => 'https://gateway.invalid',
    fetchImpl: async (url, init) => { calls.push({ url, ...init }); return options.fetchImpl ? options.fetchImpl(url, init) : response() },
  })
  const service = createClaudeImageService({
    sessionId: 'trusted-dsh-session', messages: [{ content: [{ type: 'image', attachment: REF }] }],
    client, attachments, getPreference: () => preference, imageDirectory: directory,
    onGenerated: () => { invalidations++ }, onImage: result => delivered.push(result), ...options,
  })
  return { directory, calls, delivered, reads, preference, attachments, service, invalidations: () => invalidations }
}

test('a missing host session/store or disabled image setting does not advertise a CLI image service', () => {
  const getPreference = () => ({ imageEnabled: false })
  assert.equal(createClaudeImageService({}), undefined)
  assert.equal(createClaudeImageService({ sessionId: 's', attachments: { readImage() {}, saveImage() {} }, getPreference }), undefined)
})

test('CLI generation and generated-image edits use saved settings and host image keys, and return bounded native MCP images', async t => {
  const fx = await fixture(t)
  assert.equal(fx.service.definition.name, IMAGE_TOOL_NAME)
  assert.equal(fx.service.definition.inputSchema.additionalProperties, false)
  assert.equal(fx.service.definition.annotations.readOnlyHint, false)
  assert.equal(fx.service.definition.annotations.idempotentHint, false)
  const first = await fx.service.call({ prompt: 'A teapot', model: 'settings', quality: 'settings' }, signal())
  assert.equal(first.isError, undefined)
  const metadata = JSON.parse(first.content[0].text)
  assert.equal(metadata.id, 'image_2')
  assert.equal(metadata.requestedModel, 'gpt-image-2.5-sunburst')
  assert.equal(metadata.requestedQuality, 'xhigh')
  assert.equal(metadata.displayedInDsh, true)
  assert.deepEqual(first.content[1], { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') })
  assert.doesNotMatch(first.content[0].text, /b64_json|base64|sk-fixture/u)
  assert.equal(fx.delivered.length, 1)
  assert.deepEqual(await readFile(fx.delivered[0].localPath), PNG)
  if (process.platform !== 'win32') assert.equal((await stat(fx.delivered[0].localPath)).mode & 0o777, 0o600)
  const second = await fx.service.call({ prompt: 'Make it orange', operation: 'edit', referenceIds: [metadata.id], quality: 'max' }, signal())
  assert.equal(second.isError, undefined)
  assert.equal(fx.calls[0].url, 'https://gateway.invalid/v1/images/generations')
  assert.equal(fx.calls[1].url, 'https://gateway.invalid/v1/images/edits')
  assert.equal(JSON.parse(fx.calls[0].body).quality, 'xhigh')
  assert.equal(fx.calls[1].body.get('quality'), 'max')
  assert.equal(fx.calls[1].body.getAll('image[]').length, 1)
  assert.deepEqual(Buffer.from(await fx.calls[1].body.get('image[]').arrayBuffer()), PNG)
  assert.equal(fx.calls[1].headers.authorization, `Bearer ${KEY}`)
  assert.equal(fx.invalidations(), 2)
  assert.doesNotMatch(JSON.stringify(fx.delivered), /sk-fixture|base64|b64_json/u)
  const instructions = fx.service.instructions('mcp__test__image')
  assert.match(instructions, /image_1/u)
  assert.match(instructions, /reference\.png/u)
  assert.doesNotMatch(instructions, /sha256:|sk-fixture|127\.0\.0\.1/u)
})

test('invalid CLI references, injected credentials/paths, and unsupported settings fail before paid work without losing edit intent', async t => {
  const fx = await fixture(t)
  const invalid = [null, {}, { prompt: '' }, { prompt: 'x'.repeat(32001) },
    { prompt: 'edit', operation: 'edit' }, { prompt: 'edit', referenceIds: ['image_99'] },
    { prompt: 'edit', referenceIds: ['image_1', 'image_1'] }, { prompt: 'edit', referenceIds: [REF] },
    { prompt: 'edit', referenceIds: ['/etc/passwd'] }, { prompt: 'edit', referenceIds: [REF.attachmentId] },
    { prompt: 'create', operation: 'generate', referenceIds: ['image_1'] },
    { prompt: 'mask', maskId: 'image_1' }, { prompt: 'mask', referenceIds: ['image_1'], maskId: 'image_99' },
    { prompt: 'x', sessionId: 'foreign-session' }, { prompt: 'x', key: KEY }, { prompt: 'x', path: '/etc/passwd' },
    { prompt: 'x', model: 'other' }, { prompt: 'x', model: 'gpt-image-2', quality: 'max' },
    { prompt: 'x', quality: 'ultra' }, { prompt: 'x', size: '100x100' }, { prompt: 'x', background: 'clear' },
  ]
  for (const args of invalid) assert.equal((await fx.service.call(args, signal())).isError, true, JSON.stringify(args))
  assert.equal(fx.calls.length, 0)
  assert.equal(fx.reads.length, 0)
  const edit = await fx.service.call({ prompt: 'edit it', referenceIds: ['image_1'], maskId: 'image_1' }, signal())
  assert.equal(edit.isError, undefined)
  assert.equal(fx.calls.length, 1)
  assert.match(fx.calls[0].url, /\/edits$/u)
  assert.ok(fx.calls[0].body.get('mask'))
  assert.equal(fx.reads[0].attachmentId, REF.attachmentId)
})

test('image preferences are read at call time; settings sentinel and explicit auto stay distinct', async t => {
  const fx = await fixture(t)
  fx.preference.imageModel = 'gpt-image-2.5-flare'
  fx.preference.imageQuality = 'max'
  await fx.service.call({ prompt: 'one', model: 'settings', quality: 'settings' }, signal())
  await fx.service.call({ prompt: 'two', model: 'gpt-image-2', quality: 'auto' }, signal())
  assert.equal(JSON.parse(fx.calls[0].body).quality, 'max')
  assert.equal(JSON.parse(fx.calls[0].body).model, 'gpt-image-2.5-flare')
  assert.equal(JSON.parse(fx.calls[1].body).quality, 'auto')
  fx.preference.imageEnabled = false
  assert.match((await fx.service.call({ prompt: 'three' }, signal())).content[0].text, /disabled/u)
  assert.equal(fx.calls.length, 2)
})

test('one in-flight image call and a per-run attempt budget prevent parallel or unlimited paid work', async t => {
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let release
  const paused = new Promise(resolve => { release = resolve })
  const fx = await fixture(t, { fetchImpl: async () => { entered(); await paused; return response() } })
  const first = fx.service.call({ prompt: 'one' }, signal())
  await started
  assert.match((await fx.service.call({ prompt: 'parallel' }, signal())).content[0].text, /already running/u)
  release()
  await first
  for (let i = 1; i < MAX_CLI_IMAGE_CALLS; i++) assert.equal((await fx.service.call({ prompt: `image ${i}` }, signal())).isError, undefined)
  assert.match((await fx.service.call({ prompt: 'over budget' }, signal())).content[0].text, /budget/u)
  assert.equal(fx.calls.length, MAX_CLI_IMAGE_CALLS)
})

test('cancelled image requests abort their only gateway attempt and never deliver an image or echo a transport error', async t => {
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const cancellation = new AbortController()
  const fx = await fixture(t, { fetchImpl: async (_url, init) => {
    entered()
    await new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true }))
    throw new Error(KEY)
  } })
  const pending = fx.service.call({ prompt: 'one' }, cancellation.signal)
  await started
  cancellation.abort()
  const result = await pending
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /cancelled/u)
  assert.doesNotMatch(JSON.stringify(result), /sk-fixture/u)
  assert.equal(fx.calls.length, 1)
  assert.equal(fx.delivered.length, 0)
})

test('preview bounds or failures preserve a completed image and its original file', async t => {
  const fx = await fixture(t)
  fx.attachments.readImageRequest = async () => ({ data: new Uint8Array(1024 * 1024 + 1), mediaType: 'image/png' })
  const result = await fx.service.call({ prompt: 'one' }, signal())
  assert.equal(result.isError, undefined)
  assert.equal(result.content.length, 1)
  assert.equal(fx.delivered.length, 1)
  assert.deepEqual(await readFile(fx.delivered[0].localPath), PNG)
  fx.attachments.readImageRequest = async () => { throw new Error(KEY) }
  assert.equal((await fx.service.call({ prompt: 'two' }, signal())).content.length, 1)
  assert.equal(fx.delivered.length, 2)
})

test('MCP image calls share the authenticated transport, keep search separate, support long prompts and cancellation', async t => {
  const fx = await fixture(t)
  const bridge = await createClaudeSearchBridge({ image: fx.service, search: async () => ({ content: 'found', sources: [] }) })
  t.after(() => bridge.close())
  const config = JSON.parse(await readFile(bridge.configPath, 'utf8'))
  const [name, server] = Object.entries(config.mcpServers)[0]
  assert.equal(bridge.imageToolName, `mcp__${name}__${IMAGE_TOOL_NAME}`)
  assert.doesNotMatch(JSON.stringify(config), /sk-fixture|reference\.png|sunburst/u)
  let id = 0
  const rpc = async (method, params) => (await fetch(server.url, { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json()
  const list = (await rpc('tools/list', {})).result.tools
  assert.deepEqual(list.map(tool => tool.name), ['web_search', IMAGE_TOOL_NAME])
  const first = (await rpc('tools/call', { name: IMAGE_TOOL_NAME, arguments: { prompt: 'x'.repeat(32000) } })).result
  assert.equal(first.isError, undefined)
  assert.equal(first.content[1].type, 'image')
  assert.equal((await rpc('tools/call', { name: 'web_search', arguments: { query: 'q' } })).result.isError, undefined)
  assert.equal((await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: IMAGE_TOOL_NAME, arguments: { prompt: 'forbidden' } } }) })).status, 401)
  assert.equal(fx.calls.length, 1)
  await bridge.close()
  await assert.rejects(readFile(bridge.configPath), error => error.code === 'ENOENT')
  await assert.rejects(fetch(server.url, { method: 'POST', headers: server.headers }), /fetch failed/u)
})

test('MCP cancellation notifications and the image deadline abort only their active image request', async t => {
  for (const cancelledBy of ['notification', 'deadline']) {
    let entered
    const started = new Promise(resolve => { entered = resolve })
    let gatewaySignal
    const fx = await fixture(t, { fetchImpl: async (_url, init) => {
      gatewaySignal = init.signal
      entered()
      await new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true }))
      throw new Error(KEY)
    } })
    fx.service.timeoutMs = cancelledBy === 'deadline' ? 100 : 10000
    const bridge = await createClaudeSearchBridge({ image: fx.service, search: async () => ({ content: 'search still works', sources: [] }) })
    t.after(() => bridge.close())
    const server = Object.values(JSON.parse(await readFile(bridge.configPath, 'utf8')).mcpServers)[0]
    const send = async message => fetch(server.url, { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' }, body: JSON.stringify(message) })
    const pending = send({ jsonrpc: '2.0', id: 'paid-image', method: 'tools/call', params: { name: IMAGE_TOOL_NAME, arguments: { prompt: 'a teapot' } } })
    await started
    if (cancelledBy === 'notification') assert.equal((await send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'paid-image' } })).status, 202)
    const result = (await (await pending).json()).result
    assert.equal(result.isError, true)
    assert.equal(gatewaySignal.aborted, true)
    assert.equal(fx.delivered.length, 0)
    assert.doesNotMatch(JSON.stringify(result), /sk-fixture/u)
    const search = await send({ jsonrpc: '2.0', id: 'search', method: 'tools/call', params: { name: 'web_search', arguments: { query: 'q' } } })
    assert.equal((await search.json()).result.isError, undefined)
  }
})
