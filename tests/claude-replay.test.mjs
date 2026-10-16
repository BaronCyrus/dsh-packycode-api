import assert from 'node:assert/strict'
import test from 'node:test'
import { createPackyCodeProvider } from '../src/provider.js'
import { anthropicStream } from './fixtures/anthropic.mjs'

const KEY = 'sk-haiku-replay-fixture-not-a-real-key'
const ANOMALY = 'We have detected an anomaly in your client. Please use the standard Claude Code client. (request_ori_id: fixture-origin)'
const anomaly = () => Response.json({ error: { type: 'packy_api_error', message: ANOMALY } }, { status: 403 })
const TEST_MESSAGE = 'Your client is already connected and authorized. Please use it normally. There is no need to send test messages such as hi or hello to verify the connection.'
const testMessageRefusal = () => Response.json({ error: { type: 'packy_<nil>', message: TEST_MESSAGE } }, { status: 403 })
const tools = [{ name: 'echo', description: 'Echo text', parameters: { type: 'object', properties: { text: { type: 'string' } } } }]
const user = { role: 'user', content: 'Use echo', timestamp: 1 }

async function run(t, respond, { modelId = 'claude-haiku-5-5', context = { messages: [user], tools }, signal, onPayload } = {}) {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init)
    requests.push({ body: await request.text(), headers: Object.fromEntries(request.headers), signal: init?.signal })
    return respond(requests.length)
  })
  const provider = createPackyCodeProvider()
  const model = provider.getModels().find(item => item.id === modelId)
  const result = await provider.streamSimple(model, context, { apiKey: KEY, sessionId: 'haiku-replay-session', reasoning: 'low', maxTokens: 2048, maxRetries: 0, signal, onPayload }).result()
  return { result, requests }
}

for (const modelId of ['claude-haiku-5-5', 'claude-sonnet-5-5']) test(`${modelId} repeats an upstream client anomaly once with the same bytes, headers, key and session`, async t => {
  let hooks = 0
  const { result, requests } = await run(t, count => count === 1
    ? new Response(JSON.stringify({ error: { type: 'packy_api_error', message: ANOMALY } }), { status: 403, headers: { 'content-type': 'text/event-stream' } })
    : anthropicStream(modelId), { modelId, onPayload: payload => { hooks++; return payload } })
  assert.equal(result.stopReason, 'stop', result.errorMessage)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].body, requests[1].body)
  assert.deepEqual(requests[0].headers, requests[1].headers)
  assert.equal(hooks, 1, 'request preparation must not run again on replay')
  assert.equal(requests[1].headers.authorization, `Bearer ${KEY}`)
})

for (const modelId of ['claude-haiku-5-5', 'claude-sonnet-5-5']) test(`${modelId} surfaces a repeated anomaly after exactly one replay`, async t => {
  const { result, requests } = await run(t, () => anomaly(), { modelId })
  assert.equal(result.stopReason, 'error')
  assert.equal(requests.length, 2)
  assert.match(result.errorMessage, /anomaly/iu)
})

test('Haiku tool requests replay the captured false test-message refusal once without changing the request', async t => {
  let hooks = 0
  const { result, requests } = await run(t, count => count === 1 ? testMessageRefusal() : anthropicStream('claude-haiku-5-5'), { onPayload: payload => { hooks++; return payload } })
  assert.equal(result.stopReason, 'stop', result.errorMessage)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].body, requests[1].body)
  assert.deepEqual(requests[0].headers, requests[1].headers)
  assert.equal(hooks, 1)
})

test('a second test-message refusal or client anomaly shares the same one-replay ceiling', async t => {
  for (const second of [testMessageRefusal, anomaly]) {
    const { result, requests } = await run(t, count => count === 1 ? testMessageRefusal() : second())
    assert.equal(result.stopReason, 'error')
    assert.equal(requests.length, 2)
    t.mock.restoreAll()
  }
})

for (const [name, error] of [['test-message', { type: 'packy_<nil>', message: TEST_MESSAGE }], ['client-anomaly', { type: 'packy_api_error', message: ANOMALY }]]) {
  test(`a real gateway ${name} JSON 403 is recognised even when mislabeled as an event stream`, async t => {
    const { result, requests } = await run(t, count => count === 1
      ? new Response(JSON.stringify({ error }), { status: 403, headers: { 'content-type': 'text/event-stream' } })
      : anthropicStream('claude-haiku-5-5'))
    assert.equal(result.stopReason, 'stop', result.errorMessage)
    assert.equal(requests.length, 2)
    assert.equal(requests[0].body, requests[1].body)
  })
}

test('a historical tool result also qualifies when the current tool catalog is empty', async t => {
  const context = { messages: [user, { role: 'assistant', api: 'anthropic-messages', provider: 'packycode', model: 'claude-haiku-5-5', content: [{ type: 'toolCall', id: 'tool_fixture', name: 'echo', arguments: { text: 'ok' } }], stopReason: 'toolUse', timestamp: 2, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }, { role: 'toolResult', toolCallId: 'tool_fixture', toolName: 'echo', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 3 }] }
  const { result, requests } = await run(t, count => count === 1 ? anomaly() : anthropicStream('claude-haiku-5-5'), { context })
  assert.equal(result.stopReason, 'stop', result.errorMessage)
  assert.equal(requests.length, 2)
})

test('ordinary policy refusals, other models, plain requests and capacity failures are not replayed', async t => {
  const cases = [
    { respond: () => Response.json({ error: { type: 'packy_api_error', message: 'This API endpoint is only accessible via the official Claude CLI' } }, { status: 403 }) },
    { respond: () => anomaly(), modelId: 'claude-opus-5-5' },
    { respond: testMessageRefusal, modelId: 'claude-sonnet-5-5' },
    { respond: () => anomaly(), modelId: 'claude-sonnet-5-5', context: { messages: [user] } },
    { respond: () => anomaly(), context: { messages: [user] } },
    { respond: testMessageRefusal, context: { messages: [user] } },
    { respond: testMessageRefusal, modelId: 'claude-opus-5-5' },
    { respond: () => Response.json({ error: { type: 'authentication_error', message: TEST_MESSAGE } }, { status: 403 }) },
    { respond: () => Response.json({ error: { message: 'Too many pending requests' } }, { status: 429 }) },
    { respond: () => new Response('not JSON', { status: 403 }) },
    { respond: () => new Response(JSON.stringify({ error: { type: 'packy_<nil>', message: TEST_MESSAGE, padding: 'x'.repeat(17 * 1024) } }), { status: 403, headers: { 'content-type': 'text/event-stream' } }) },
  ]
  for (const { respond, ...options } of cases) {
    const { result, requests } = await run(t, respond, options)
    assert.equal(result.stopReason, 'error')
    assert.equal(requests.length, 1)
    t.mock.restoreAll()
  }
})

for (const modelId of ['claude-haiku-5-5', 'claude-sonnet-5-5']) test(`${modelId} never replays an HTTP 200 streaming error`, async t => {
  const { result, requests } = await run(t, () => new Response(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'packy_api_error', message: ANOMALY } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }), { modelId })
  assert.equal(result.stopReason, 'error')
  assert.equal(requests.length, 1)
})

test('cancellation during the retry delay prevents a second request', async t => {
  const controller = new AbortController()
  const { result, requests } = await run(t, () => { setTimeout(() => controller.abort(), 10); return anomaly() }, { signal: controller.signal })
  assert.equal(result.stopReason, 'aborted')
  assert.equal(requests.length, 1)
})
