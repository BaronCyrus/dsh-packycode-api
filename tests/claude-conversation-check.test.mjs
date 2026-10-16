import assert from 'node:assert/strict'
import test from 'node:test'
import { createClaudeConversationClient, runClaudeConversation } from '../scripts/claude-conversation-check.mjs'
import { anthropicStream } from './fixtures/anthropic.mjs'

const key = 'sk-continuous-fixture-not-a-real-key'
const builtPath = new URL('../src/index.js', import.meta.url)
const answers = ['库存 42 件，预留 7 件，可用 35 件。', '可以发出 35 件，还缺 15 件。', '总需求 70 件，可用 35 件，总缺货 35 件。', '|1|50|35|15|\n|2|20|0|20|', '第一单还缺 5 件，第二单还缺 20 件，共缺 25 件。', '{"firstShortage":5,"secondShortage":20,"totalShortage":25}']

for (const correct of [true, false]) {
  test(`continuous dialog retains all history and ${correct ? 'passes' : 'rejects incorrect final memory'}`, async t => {
    const bodies = [], sessions = []
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const request = new Request(input, init), body = await request.json()
      bodies.push(body)
      const session = JSON.parse(body.metadata.user_id).session_id
      sessions.push(session)
      assert.equal(request.headers.get('x-claude-code-session-id'), session)
      if (bodies.length === 1) return anthropicStream(body.model, { type: 'tool_use', id: 'stock_fixture', name: 'lookup_inventory', input: { sku: 'KB-87' } })
      const answer = !correct && bodies.length === 7 ? '{"firstShortage":15,"secondShortage":20,"totalShortage":35}' : answers[bodies.length - 2]
      return anthropicStream(body.model, { type: 'text', text: answer })
    })
    const result = await runClaudeConversation({ key, builtPath })
    assert.equal(result.ok, correct)
    assert.equal(result.turns.length, 6)
    assert.deepEqual(bodies.map(body => body.messages.length), [1, 3, 5, 7, 9, 11, 13])
    assert.equal(new Set(sessions).size, 1)
    assert.ok(bodies[6].messages.some(message => message.content?.some?.(block => block.type === 'tool_result')))
    assert.equal(result.requests.length, 7)
    assert.ok(result.requests.every(request => request.wireUtf8Valid))
    assert.equal(JSON.stringify(result).includes(key), false)
    if (!correct) assert.equal(result.failure.code, 'CHECK')
  })
}

test('a real policy refusal stops the conversation without discarding evidence or rotating credentials', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return new Response(JSON.stringify({ error: { type: 'packy_<nil>', message: `Your client is already connected and authorized. There is no need to send test messages to verify the connection. ${key}` } }), { status: 403, headers: { 'content-type': 'text/event-stream' } })
  })
  const result = await runClaudeConversation({ key, builtPath })
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'GATEWAY_TEST_MESSAGE')
  assert.equal(requests, 2)
  assert.equal(result.turns.length, 1)
  assert.deepEqual(result.keyFailures, [])
  assert.deepEqual(result.requests.map(request => request.status), [403, 403])
  assert.equal(JSON.stringify(result).includes(key), false)
})

test('replacement characters are visible failures even when the HTTP 200 business values are right', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1
    ? anthropicStream('claude-haiku-5-5', { type: 'tool_use', id: 'stock_fixture', name: 'lookup_inventory', input: { sku: 'KB-87' } })
    : anthropicStream('claude-haiku-5-5', { type: 'text', text: `0\uFFFD${answers[0]}` }))
  const result = await runClaudeConversation({ key, builtPath })
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'OUTPUT_ENCODING')
  assert.deepEqual(result.requests.map(request => request.status), [200, 200])
  assert.equal(result.requests[1].wireUtf8Valid, true)
  assert.equal(result.requests[1].wireAnswerHasReplacement, true)
  assert.equal(requests, 2)
})

test('failed streams retain their partial wire events and a credential-free request for exact replay', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n'))
      setTimeout(() => controller.error(new Error(`fixture stream interruption ${key}`)), 15)
    },
  }), { headers: { 'content-type': 'text/event-stream' } }))
  const result = await runClaudeConversation({ key, builtPath, captureWire: true })
  assert.equal(result.ok, false)
  const request = result.requests[0]
  assert.equal(request.wireComplete, false)
  assert.equal(request.wireEvents.ping, 1)
  assert.ok(request.responseBytes > 0)
  assert.equal(request.wireUtf8Valid, undefined, 'an interrupted capture is not a complete UTF-8 validation')
  assert.equal(request.wireSnapshot.headers.authorization, undefined)
  assert.equal(request.wireSnapshot.headers['x-api-key'], undefined)
  assert.equal(JSON.parse(request.wireSnapshot.body).model, 'claude-haiku-5-5')
  assert.equal(JSON.stringify(result).includes(key), false)
})

test('a shared plugin instance keeps its device identity across independent conversations', async t => {
  let count = 0
  const metadata = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init), body = await request.json()
    metadata.push(JSON.parse(body.metadata.user_id))
    const step = count++ % 7
    return anthropicStream(body.model, step === 0
      ? { type: 'tool_use', id: `lookup_${count}`, name: body.tools[0].name, input: { sku: 'KB-87' } }
      : { type: 'text', text: answers[step - 1] })
  })
  const client = await createClaudeConversationClient({ key, builtPath })
  const pending = client.run()
  await assert.rejects(client.run(), /already has an active check/u)
  const first = await pending, second = await client.run()
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.adapterLifecycle, 'shared-adapter')
  assert.equal(new Set(metadata.map(x => x.device_id)).size, 1)
  assert.equal(new Set(metadata.map(x => x.session_id)).size, 2)
  await assert.rejects(client.run({ key: 'different-fixture' }), /cannot change credentials/u)
  assert.equal(count, 14)
})
