import assert from 'node:assert/strict'
import test from 'node:test'
import { createPackyCodeProvider } from '../src/provider.js'
import { hostProvider } from './helpers.mjs'
import { anthropicStream } from './fixtures/anthropic.mjs'

test('a complete Claude message finishes even when the server keeps the HTTP body open', async t => {
  const controller = new AbortController()
  let cancelled = false
  const bytes = new Uint8Array(await anthropicStream('claude-haiku-5-5', { type: 'text', text: '库存📦 35 件。' }).arrayBuffer())
  t.mock.method(globalThis, 'fetch', async (_input, init) => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(bytes)
      init.signal.addEventListener('abort', () => { if (!cancelled) stream.error(new Error('fixture deadline')) }, { once: true })
    },
    cancel() { cancelled = true },
  }), { headers: { 'content-type': 'text/event-stream' } }))
  const timeout = setTimeout(() => controller.abort(), 1000)
  t.after(() => clearTimeout(timeout))
  const provider = hostProvider(createPackyCodeProvider())
  const model = provider.getModels().find(model => model.id === 'claude-haiku-5-5')
  const result = await provider.streamSimple(model, { messages: [{ role: 'user', content: '整理库存', timestamp: 1 }] }, { apiKey: 'sk-stream-fixture-not-real', signal: controller.signal }).result()
  assert.equal(result.stopReason, 'stop', result.errorMessage)
  assert.equal(result.content.find(block => block.type === 'text').text, '库存📦 35 件。')
  assert.equal(cancelled, true)
})

test('UTF-8 and CRLF delimiters split across network chunks preserve the complete response', async t => {
  const text = await anthropicStream('claude-haiku-5-5', { type: 'text', text: '库存📦 35 件。' }).text()
  const bytes = new TextEncoder().encode(text.replaceAll('\n', '\r\n'))
  let offset = 0
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) controller.close()
      else controller.enqueue(bytes.slice(offset, ++offset))
    },
  }), { headers: { 'content-type': 'text/event-stream' } }))
  const provider = hostProvider(createPackyCodeProvider())
  const model = provider.getModels().find(model => model.id === 'claude-haiku-5-5')
  const result = await provider.streamSimple(model, { messages: [{ role: 'user', content: '整理库存', timestamp: 1 }] }, { apiKey: 'sk-stream-fixture-not-real' }).result()
  assert.equal(result.stopReason, 'stop', result.errorMessage)
  assert.equal(result.content.find(block => block.type === 'text').text, '库存📦 35 件。')
})

test('cancellation interrupts a stalled SSE body and cancels its reader', async t => {
  const controller = new AbortController()
  let cancelled = false
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n')) },
    cancel() { cancelled = true },
  }), { headers: { 'content-type': 'text/event-stream' } }))
  const timer = setTimeout(() => controller.abort(), 30)
  t.after(() => clearTimeout(timer))
  const provider = hostProvider(createPackyCodeProvider())
  const model = provider.getModels().find(model => model.id === 'claude-haiku-5-5')
  const result = await provider.streamSimple(model, { messages: [{ role: 'user', content: '整理库存', timestamp: 1 }] }, { apiKey: 'sk-stream-fixture-not-real', signal: controller.signal }).result()
  assert.equal(result.stopReason, 'aborted')
  assert.equal(cancelled, true)
})
