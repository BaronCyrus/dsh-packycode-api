import assert from 'node:assert/strict'
import test from 'node:test'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { classifyGatewayFailure, classifyUpstreamServerError } from '../src/failures.js'
import { PackyCodeKeyRing } from '../src/key-ring.js'
import { createRouteAdapter } from '../src/route.js'
import { fakeCredentials } from './helpers.mjs'

const KEY = 'sk-fixture-only-not-a-real-key'
const MODEL = 'gpt-6.1-sol'
/** OpenAI's `server_error` sentence, as the Codex group relayed it on 2026-10-16. */
const SERVER_ERROR = 'An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists.'

const sse = events => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
  headers: { 'Content-Type': 'text/event-stream' },
})
const OPENING = [
  { type: 'response.created', sequence_number: 0, response: { id: 'resp_fixture', object: 'response', status: 'in_progress', output: [] } },
  { type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_fixture', object: 'response', status: 'in_progress', output: [] } },
]
const failed = error => ({ type: 'response.failed', sequence_number: 4, response: { id: 'resp_fixture', object: 'response', status: 'failed', error, incomplete_details: null } })

/** The captured shape: HTTP 200, an `error` event carrying a 503 `server_error`, then `response.failed`. */
const relayed = () => sse([
  ...OPENING,
  { type: 'error', error: { message: SERVER_ERROR, type: 'server_error', param: null, code: 'server_error' }, status: 503, sequence_number: 3 },
  failed({ type: 'server_error', param: null, code: 'server_error', message: SERVER_ERROR }),
])

function answered() {
  const item = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }
  return sse([
    OPENING[0],
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'ok' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } } },
  ])
}

async function route(t, respond) {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init)
    requests.push({ url: request.url, body: await request.text() })
    return respond(requests.length)
  })
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add(KEY, 'fixture')
  const adapter = createRouteAdapter({
    ring,
    keys: { active: () => ring.activeKey(), forRequest: (_model, key) => key, onKeyFailure: () => assert.fail('an upstream server error must not move the key aside') },
  })
  return { adapter, ring, requests }
}

const request = () => ({
  provider: 'packycode', model: MODEL, sessionId: 'fixture-session', reasoningEffort: 'high',
  messages: [createUserMessage({ content: [{ type: 'text', text: 'Reply with ok' }], source: { kind: 'user' } })],
})

async function finishOf(stream) {
  let finish
  for await (const chunk of stream) if (chunk.type === 'finish') finish = chunk.reason
  return finish
}

test('recognizes OpenAI\'s server_error in every form pi-ai can carry it', () => {
  for (const message of [
    SERVER_ERROR,
    `${SERVER_ERROR} Please include the request ID req_0123456789abcdef in your message.`,
    `server_error: ${SERVER_ERROR}`,
    `Error Code server_error: ${SERVER_ERROR}`,
    'server_error: Something else went wrong upstream.',
  ]) assert.equal(classifyUpstreamServerError(message), true, message)
  for (const message of [
    undefined,
    '',
    'invalid_prompt: Invalid prompt: your prompt was flagged.',
    'Error Code invalid_prompt: Invalid prompt.',
    'An error occurred while preparing the request.',
    '当前令牌额度已用完',
    'Your organization must be verified to use this model.',
  ]) assert.equal(classifyUpstreamServerError(message), false, String(message))
  assert.equal(classifyGatewayFailure(SERVER_ERROR), undefined, 'the key is not at fault')
})

test('a server error relayed inside an accepted stream is filed as SERVER, which the route retries', async t => {
  const { adapter, ring, requests } = await route(t, () => relayed())
  const prepared = await adapter.prepareCall('packycode', MODEL)
  const finish = await finishOf(prepared.stream(request()))
  assert.equal(finish.kind, 'error')
  assert.equal(finish.failure.code, 'SERVER')
  assert.equal(finish.failure.message, SERVER_ERROR, 'the upstream sentence reaches the user unchanged')
  const policy = adapter.providerRetryPolicy('packycode')
  assert.ok(policy.retryableCodes.includes('SERVER'))
  assert.ok(!policy.retryableCodes.includes('PI_AI_ERROR'))
  assert.equal(requests.length, 1)
  assert.equal(new URL(requests[0].url).pathname, '/v1/responses')
  assert.equal((await ring.activeKey()).key, KEY)
})

test('the unprepared stream path files it the same way', async t => {
  const { adapter } = await route(t, () => relayed())
  const finish = await finishOf(adapter.stream(request()))
  assert.equal(finish.failure.code, 'SERVER')
  assert.equal(finish.failure.message, SERVER_ERROR)
})

test('the other server_error shapes are filed as SERVER too', async t => {
  const shapes = [
    sse([...OPENING, { type: 'error', code: 'server_error', message: SERVER_ERROR, param: null, sequence_number: 3 }]),
    sse([...OPENING, failed({ code: 'server_error', message: SERVER_ERROR })]),
  ]
  const { adapter } = await route(t, count => shapes[count - 1])
  for (let index = 0; index < shapes.length; index++) {
    const prepared = await adapter.prepareCall('packycode', MODEL)
    const finish = await finishOf(prepared.stream(request()))
    assert.equal(finish.failure.code, 'SERVER', finish.failure.message)
  }
})

test('other unclassified failures and answers pass through unchanged', async t => {
  const responses = [
    sse([...OPENING, failed({ code: 'invalid_prompt', message: 'Invalid prompt: your prompt was flagged.' })]),
    answered(),
  ]
  const { adapter } = await route(t, count => responses[count - 1])
  const refused = await finishOf((await adapter.prepareCall('packycode', MODEL)).stream(request()))
  assert.equal(refused.failure.code, 'PI_AI_ERROR')
  assert.equal(refused.failure.message, 'invalid_prompt: Invalid prompt: your prompt was flagged.')
  const prepared = await adapter.prepareCall('packycode', MODEL)
  let text = ''
  let finish
  for await (const chunk of prepared.stream(request())) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason
  }
  assert.equal(finish.kind, 'stop')
  assert.equal(text, 'ok')
})
