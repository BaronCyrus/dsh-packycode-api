import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.js'

const CHAT_KEY = 'sk-chat-only-image-wiring-fixture'
const IMAGE_KEY = 'sk-image-only-image-wiring-fixture'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jpj8AAAAASUVORK5CYII=', 'base64')

test('plugin composition bridges CLI images with isolated stored keys and omits paid tools from plans, titles and disabled settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'packy-image-wiring-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  t.after(() => { if (previousDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousDshHome })
  const binary = join(directory, 'claude')
  const log = join(directory, 'calls.jsonl')
  await writeFile(binary, `#!/usr/bin/env node
const { readFileSync, appendFileSync } = require('node:fs')
if (process.argv.includes('--version')) { console.log('2.1.295 (Claude Code)'); process.exit(0) }
const args = process.argv.slice(2)
process.stdin.once('data', async () => {
  try {
    let imageTool = false
    let path
    if (args.includes('--mcp-config')) {
      path = args[args.indexOf('--mcp-config') + 1]
      const config = JSON.parse(readFileSync(path, 'utf8'))
      const [name, server] = Object.entries(config.mcpServers)[0]
      let id = 0
      const rpc = async (method, params) => (await fetch(server.url, { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json()
      const list = (await rpc('tools/list', {})).result.tools
      imageTool = list.some(tool => tool.name === 'packycode_image_generate')
      if (imageTool) {
        const toolName = 'mcp__' + name + '__packycode_image_generate'
        if (!args.includes(toolName)) throw new Error('image permission missing')
        for (const input of [{ prompt: 'Generate a blue teapot' }, { prompt: 'Edit the session reference', operation: 'edit', referenceIds: ['image_1'] }]) {
          const result = (await rpc('tools/call', { name: 'packycode_image_generate', arguments: input })).result
          if (result.isError) throw new Error(result.content[0].text)
        }
      }
    }
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ path, args, imageTool, token: process.env.ANTHROPIC_AUTH_TOKEN, imageKeyLeaked: Object.values(process.env).some(value => value.includes(${JSON.stringify(IMAGE_KEY)})) }) + '\\n')
    console.log(JSON.stringify({ type: 'result', is_error: false, result: 'done' }))
    process.exit(0)
  } catch (error) { console.log(JSON.stringify({ type: 'result', is_error: true, result: error.message })); process.exit(1) }
})
`)
  await chmod(binary, 0o755)
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    if (!/\/images\/(generations|edits)$/u.test(url)) throw new Error('unexpected gateway request')
    requests.push({ url, ...init })
    return Response.json({ data: [{ b64_json: PNG.toString('base64') }] })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  let planning = false
  const records = new Map()
  const reference = { attachmentId: `sha256:${'a'.repeat(64)}`, bytes: PNG.length, width: 1, height: 1, mediaType: 'image/png' }
  const attachments = {
    imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
    readImage: async ref => ({ ref, data: PNG }),
    saveImage: async () => ({ ...reference, attachmentId: `sha256:${'b'.repeat(64)}` }),
  }
  const session = { id: 'trusted-image-session', header: { cwd: directory }, requestContext: () => ({ provider: 'packycode' }) }
  const seen = { dispose: [] }
  const services = { agents: { currentInitiator: () => ({ session }) }, attachments, planMode: { get: () => ({ active: planning }) } }
  const ctx = {
    credentials: { readRecord: async id => records.get(id), modifyRecord: async (id, mutate) => { const next = await mutate(records.get(id)); records.set(id, next); return next } },
    get: name => services[name],
    logger: { warn() {}, info() {} },
    llm: { registerAdapter: (_providers, adapter) => { seen.adapter = adapter }, registerConfigurableProviders() {} },
    inject(names, callback) {
      if (names.includes('settings')) callback({ settings: {
        installSection: (_owner, _ns, _schema, base, hooks) => { seen.preferences = { ...base }; hooks.setSource(() => seen.preferences) },
        update: async (_ns, patch) => Object.assign(seen.preferences, patch),
      } })
      if (names.includes('connection')) callback({ effect: ctx.effect, connection: { rpc: { handle: (_channel, handler) => { seen.rpc = handler } } } })
      if (names.includes('tools')) callback({ tools: { register: () => () => {} }, attachments })
    },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') seen.dispose.push(dispose); return dispose },
  }
  apply(ctx, { claudeCliPath: binary, claudeCliCwd: directory, claudeCliMode: 'read-only' })
  t.after(async () => { for (const dispose of seen.dispose) await dispose() })
  await seen.rpc('keys/add', { key: CHAT_KEY, label: 'conversation' })
  await seen.rpc('images/keys/add', { key: IMAGE_KEY, label: 'images' })
  await seen.rpc('images/update', { imageModel: 'gpt-image-2.5-sunburst', imageQuality: 'max' })
  const turn = async purpose => {
    const assembled = new BlockAssembler()
    for await (const chunk of seen.adapter.stream({ provider: 'packycode', model: 'claude-opus-5-5', purpose,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'make an image' }, { type: 'image', attachment: reference }] }] })) assembled.push(chunk)
    assert.equal(assembled.finish.kind, 'stop', assembled.finish.failure?.message)
    return assembled.blocks().filter(block => block.type === 'image')
  }
  assert.equal((await turn()).length, 2)
  assert.equal(requests.length, 2)
  for (const request of requests) assert.equal(new Headers(request.headers).get('authorization'), `Bearer ${IMAGE_KEY}`)
  assert.equal(JSON.parse(requests[0].body).quality, 'max')
  assert.equal(requests[1].body.get('quality'), 'max')
  assert.equal(requests[1].body.getAll('image[]').length, 1)
  planning = true
  assert.equal((await turn()).length, 0)
  planning = false
  await turn('session-title')
  await seen.rpc('images/update', { imageEnabled: false })
  assert.equal((await turn()).length, 0)
  assert.equal(requests.length, 2, 'plans/titles/disabled images make no paid image requests')
  const logged = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(logged.map(item => item.imageTool), [true, false, false, false])
  for (const invocation of logged) {
    assert.equal(invocation.token, CHAT_KEY)
    assert.equal(invocation.imageKeyLeaked, false)
    assert.ok(!JSON.stringify(invocation.args).includes(IMAGE_KEY))
    if (invocation.path) await assert.rejects(readFile(invocation.path), error => error.code === 'ENOENT')
  }
})
