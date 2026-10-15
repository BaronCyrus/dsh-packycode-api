#!/usr/bin/env node
/**
 * Real official CLI → built MCP image tool → image service → durable DSH blocks.
 * Claude replies are deterministic local fixtures. Default image gateway is
 * also mocked. --live performs one low-quality generation and one edit with
 * the separate stored image key. --with-claude additionally uses a real
 * Claude Haiku upstream turn with the stored conversation key (more quota).
 * No DSH is started or restarted, and no CLI user settings are modified.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { createClaudeCliAdapter, createClaudeRunner, createClaudeSearchBridge, createClaudeImageService, createPackyCodeImageClient, DEFAULT_API_HOST, findClaudeBinary, pngDimensions } from '../lib/index.js'
import { readStoredKey } from './stored-key.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const liveClaude = args.includes('--with-claude')
const live = args.includes('--live') || liveClaude
const binary = findClaudeBinary(option('--binary', ''))
const model = option('--model', 'gpt-image-2.5-sunburst')
const key = live ? await readStoredKey({ recordId: 'image-keys' }) : 'sk-mocked-image-key-host-only'
const chatKey = liveClaude ? await readStoredKey() : 'sk-dummy-cli-key-not-real'
const claudeModel = option('--claude-model', liveClaude ? 'claude-haiku-5-5' : 'claude-opus-5-5')
const mockPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jpj8AAAAASUVORK5CYII=', 'base64')
const temporary = await mkdtemp(join(tmpdir(), 'packy-cli-image-check-'))
const output = resolve('.artifacts', `cli-image-check-${Date.now()}`)
await mkdir(output, { recursive: true, mode: 0o700 })
const stored = new Map()
const attachments = {
  imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
  saveImage: async ({ data, mediaType, name }) => {
    const dimensions = pngDimensions(data)
    const ref = { attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`, mediaType, name, bytes: data.length, ...dimensions }
    stored.set(ref.attachmentId, { data, ref })
    return ref
  },
  readImage: async ref => { assert.ok(stored.has(ref.attachmentId)); return stored.get(ref.attachmentId) },
}
const imageRequests = []
const client = createPackyCodeImageClient({
  resolveKey: async () => ({ key }), getHost: () => option('--host', DEFAULT_API_HOST),
  fetchImpl: async (url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${key}`)
    assert.equal(init.redirect, 'error')
    const editing = url.endsWith('/edits')
    const fields = editing ? Object.fromEntries([...init.body].filter(([name]) => name !== 'image[]')) : JSON.parse(init.body)
    assert.equal(fields.model, model)
    assert.equal(fields.quality, 'low')
    if (editing) assert.equal(init.body.getAll('image[]').length, 1)
    imageRequests.push({ operation: editing ? 'edit' : 'generate', model: fields.model, quality: fields.quality })
    return live ? fetch(url, init) : Response.json({ data: [{ b64_json: mockPng.toString('base64') }], quality: fields.quality })
  },
})

let variant
let stage = 0
let toolResults = []
let failure
const requests = []
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    try {
      assert.ok(!raw.includes(key), 'real image key reached fake Claude gateway')
      const body = JSON.parse(raw || '{}')
      if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(req.url.includes('count_tokens') ? 200 : 404, { 'content-type': 'application/json' })
        return res.end(req.url.includes('count_tokens') ? '{"input_tokens":1}' : '{}')
      }
      const imageTool = body.tools?.find(tool => /^mcp__packycode_search_[a-f0-9]+__packycode_image_generate$/u.test(tool.name ?? ''))
      requests.push({ variant, hasImageTool: Boolean(imageTool), officialIdentity: body.system?.some(part => part.text?.startsWith("You are Claude Code, Anthropic's official CLI")) })
      assert.equal(Boolean(imageTool), !['plan', 'title'].includes(variant))
      assert.equal(body.tools?.some(tool => tool.name === 'WebSearch'), false)
      const blocks = body.messages?.flatMap(message => Array.isArray(message.content) ? message.content : []) ?? []
      const results = blocks.filter(block => block.type === 'tool_result' && block.tool_use_id?.startsWith('image_check_'))
      for (const result of results) assert.notEqual(result.is_error, true, 'real CLI reported MCP/permission error')
      toolResults = results
      const resultText = JSON.stringify(results)
      let result = { type: 'text', text: 'Images saved and returned to DSH.' }
      if (imageTool && body.max_tokens !== 1 && stage < 2) {
        const editing = stage === 1
        if (editing) assert.equal(results.length, 1, 'generation tool result missing before edit')
        const handle = /"id"\s*:\s*"(image_[0-9]+)"/u.exec(results.flatMap(result => Array.isArray(result.content) ? result.content : [])
          .filter(part => part.type === 'text').map(part => part.text).join('\n'))?.[1]
        if (editing) assert.ok(handle, 'generated image handle missing')
        result = { type: 'tool_use', id: `image_check_${stage + 1}`, name: imageTool.name, input: {
          prompt: editing ? 'Change only the teapot to bright orange. Preserve the composition and plain white background.' : 'A simple flat illustration of a small blue teapot centered on a plain white background, no text.',
          operation: editing ? 'edit' : 'generate', model: 'settings', quality: 'settings', size: '1024x1024',
          ...(editing ? { referenceIds: [handle] } : {}),
        } }
        stage++
      } else if (imageTool && body.max_tokens !== 1) {
        assert.equal(results.length, 2, 'both MCP image results reach Claude')
        assert.ok(resultText.includes('image/png'), 'native image preview missing')
      }
      const stop = result.type === 'tool_use' ? 'tool_use' : 'end_turn'
      const message = { id: 'msg_image_check', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ...message, content: [result], stop_reason: stop }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      event('message_start', { message })
      event('content_block_start', { index: 0, content_block: result.type === 'tool_use' ? { ...result, input: {} } : { type: 'text', text: '' } })
      event('content_block_delta', { index: 0, delta: result.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(result.input) } : { type: 'text_delta', text: result.text } })
      event('content_block_stop', { index: 0 })
      event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } })
      event('message_stop', {})
      res.end()
    } catch (error) {
      failure ??= error
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'CLI image check fixture failed' } }))
    }
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`
const report = []
try {
  console.log(JSON.stringify({ cli: binary, claudeGateway: liveClaude ? 'live PackyCode' : 'mock', claudeModel, imageGateway: live ? 'live PackyCode' : 'mock', credential: live ? 'packycode-api/image-keys' : 'none', ...(live ? { keyTail: `…${key.slice(-4)}` } : {}) }))
  for (const mode of live ? ['read-only'] : ['read-only', 'edit', 'full', 'plan', 'title']) {
    variant = mode
    stage = 0
    toolResults = []
    let configPath
    const started = Date.now()
    const before = imageRequests.length
    const runner = createClaudeRunner({
      binary, configDir: join(temporary, `config-${mode}`), timeoutMs: live ? 10 * 60_000 : 120_000,
      resolveCredential: async () => ({ baseUrl: liveClaude ? option('--host', DEFAULT_API_HOST) : baseUrl, token: chatKey }),
      createSearchBridge: async ({ signal, mode: cliMode, onImage }) => {
        const image = cliMode === 'plan' ? undefined : createClaudeImageService({
          sessionId: 'cli-image-live-check', messages: [], client, attachments,
          getPreference: () => ({ imageEnabled: true, imageModel: model, imageQuality: 'low' }),
          imageDirectory: output, onImage,
        })
        const bridge = await createClaudeSearchBridge({ image, signal, search: async () => { throw new Error('Search should not be used') }, sanitize: text => text.split(key).join('[redacted]') })
        configPath = bridge.configPath
        const config = await readFile(configPath, 'utf8')
        assert.ok(!config.includes(key) && !config.includes(chatKey))
        return bridge
      },
    })
    try {
      const adapter = createClaudeCliAdapter({ inner: { providerInfo: () => ({}), resolveModel: async (_provider, id) => ({ id }) }, runner,
        resolveMode: () => mode, resolveCwd: () => temporary, resolveAttachments: () => attachments })
      const assembled = new BlockAssembler()
      for await (const chunk of adapter.stream({ provider: 'packycode', model: claudeModel, ...(mode === 'title' ? { purpose: 'session-title' } : {}),
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Please use the provided PackyCode MCP image tool for exactly two steps: (1) Generate one simple flat illustration of a small blue teapot centered on a plain white background, no text. (2) Edit that generated image using its returned image handle, changing only the teapot to bright orange and preserving the composition and white background. Use saved model and quality settings for both calls and size 1024x1024. These two paid calls are authorized; do not retry a failed image request. After both complete, reply briefly.' }] }] })) {
        assembled.push(chunk)
        if (liveClaude && chunk.type === 'block-end' && chunk.block.type === 'image') console.log(JSON.stringify({ progress: 'image returned to DSH', images: assembled.blocks().filter(block => block.type === 'image').length }))
      }
      if (failure) throw failure
      assert.equal(assembled.finish.kind, 'stop', assembled.finish.failure?.message)
      const images = assembled.blocks().filter(block => block.type === 'image')
      const count = ['plan', 'title'].includes(mode) ? 0 : 2
      assert.equal(imageRequests.length - before, count)
      assert.equal(images.length, count)
      const replayed = JSON.parse(JSON.stringify(assembled.message({ kind: 'model', provider: 'packycode', model: claudeModel })))
      assert.deepEqual(replayed.content.filter(block => block.type === 'image'), images)
      assert.ok(!JSON.stringify(replayed).includes(key))
      if (configPath) await assert.rejects(readFile(configPath), error => error.code === 'ENOENT')
      const row = { mode, imageCalls: count, durableImages: images.length, elapsedMs: Date.now() - started, privateConfigRemoved: true }
      report.push(row)
      console.log(JSON.stringify(row))
    } finally { await runner.close() }
  }
  assert.ok(requests.every(request => request.officialIdentity))
  await writeFile(join(output, 'result.json'), JSON.stringify({ liveImageGateway: live, claudeResponses: liveClaude ? 'live PackyCode' : 'local fixtures', report }, null, 2), { mode: 0o600 })
  console.log(`PASS: real official CLI and MCP; Claude replies: ${liveClaude ? 'live PackyCode' : 'local fixtures'}. Results: ${output}`)
} catch (error) {
  console.error(String(error.message).split(key).join('[redacted]').split(chatKey).join('[redacted]').slice(0, 1000))
  process.exitCode = 1
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(temporary, { recursive: true, force: true })
}
