import assert from 'node:assert/strict'
import test from 'node:test'
import { createClaudeCheck } from '../scripts/claude-check.mjs'
import { anthropicStream } from './fixtures/anthropic.mjs'
import { createBusinessScenario } from '../scripts/claude-scenarios.mjs'

const orderAnswer = JSON.stringify({ itemSubtotalCents: 44300, amountDueCents: 43500 })

for (const maxRetries of [0, 1]) {
  test(`native live checker retains capacity evidence with ${maxRetries} transient retries`, async t => {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const request = new Request(input, init)
      const body = await request.json()
      if (++calls === 1) return Response.json({ error: { message: 'Too many pending requests' } }, { status: 429 })
      return anthropicStream(body.model, { type: 'text', text: orderAnswer })
    })
    const check = await createClaudeCheck({ key: 'sk-live-check-fixture-only', maxRetries, retryDelayMs: 1 })
    t.after(() => check.close())
    const result = await check.run({ model: 'claude-haiku-5-5' })
    assert.equal(result.ok, maxRetries === 1)
    assert.deepEqual(result.requests.map(request => request.status), maxRetries === 1 ? [429, 200] : [429])
    assert.equal(calls, maxRetries + 1)
    if (maxRetries === 1) assert.equal(result.recovered, true)
  })
}

test('an HTTP 200 stream failure remains visible after a successful retry', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const body = await new Request(input, init).json()
    if (++calls === 1) return new Response(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: '503 upstream overloaded' } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    return anthropicStream(body.model, { type: 'text', text: orderAnswer })
  })
  const check = await createClaudeCheck({ key: 'sk-live-check-fixture-only', maxRetries: 1, retryDelayMs: 1 })
  t.after(() => check.close())
  const result = await check.run({ model: 'claude-haiku-5-5' })
  assert.equal(result.ok, true)
  assert.equal(result.recovered, true)
  assert.equal(result.requests[0].status, 200)
  assert.equal(result.requests[0].streamError.code, 'SERVER')
  assert.equal(result.requests[1].streamFinish, 'stop')
})

test('a business answer with incorrect arithmetic fails even with a complete HTTP 200', async t => {
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const body = await new Request(input, init).json()
    assert.match(body.messages[0].content[0].text, /采购订单/u)
    return anthropicStream(body.model, { type: 'text', text: '{"itemSubtotalCents":44300,"amountDueCents":45500}' })
  })
  const check = await createClaudeCheck({ key: 'sk-business-fixture-only' })
  t.after(() => check.close())
  const result = await check.run({ model: 'claude-opus-5-5' })
  assert.equal(result.ok, false)
  assert.equal(result.failure.code, 'CHECK')
  assert.equal(result.requests[0].status, 200)
  assert.equal(result.requests[0].streamFinish, 'stop')
  assert.equal(result.scenarioVersion, 'business-v1')
})

test('business inventory tools replay their lookup result and verify the shortage', async t => {
  const scenario = createBusinessScenario('tool', 0)
  const requests = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const body = await new Request(input, init).json()
    requests.push(body)
    return requests.length === 1
      ? anthropicStream(body.model, { type: 'tool_use', id: 'inventory_result', name: 'lookup_inventory', input: { sku: 'KB-87' } })
      : anthropicStream(body.model, { type: 'text', text: JSON.stringify(scenario.expected) })
  })
  const check = await createClaudeCheck({ key: 'sk-business-fixture-only' })
  t.after(() => check.close())
  const result = await check.run({ model: 'claude-haiku-5-5', kind: 'tool' })
  assert.equal(result.ok, true)
  assert.equal(result.toolCalls, 1)
  assert.equal(result.requests.length, 2)
  const replay = requests[1].messages.flatMap(item => item.content).find(block => block.type === 'tool_result')
  assert.ok(JSON.stringify(replay).includes('42'))
  assert.ok(JSON.stringify(replay).includes('KB-87'))
  assert.equal(result.scenario, 'stock-fulfillment-KB-87')
})

test('the checker keeps raw test-message 403 evidence without treating it as a key fault or retrying', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return Response.json({ error: { type: 'packy_<nil>', message: 'Your client is already connected and authorized. There is no need to send test messages to verify the connection.' } }, { status: 403 })
  })
  const check = await createClaudeCheck({ key: 'sk-business-fixture-only', maxRetries: 2, builtPath: new URL('../src/index.js', import.meta.url) })
  t.after(() => check.close())
  const result = await check.run({ model: 'claude-opus-5-5' })
  assert.equal(result.failure.code, 'GATEWAY_TEST_MESSAGE')
  assert.equal(result.requests[0].status, 403)
  assert.match(result.requests[0].error, /already connected and authorized/u)
  assert.equal(result.requests[0].streamError.code, 'GATEWAY_TEST_MESSAGE')
  assert.equal(calls, 1)
})

for (const recovers of [true, false]) {
  test(`Haiku inventory continuation preserves the raw policy refusal and ${recovers ? 'recovers once' : 'surfaces the second refusal'}`, async t => {
    const bodies = []
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const request = new Request(input, init)
      const body = await request.text()
      bodies.push(body)
      if (bodies.length === 1) return anthropicStream('claude-haiku-5-5', { type: 'tool_use', id: 'stock_lookup', name: 'lookup_inventory', input: { sku: 'KB-87' } })
      if (recovers && bodies.length === 3) return anthropicStream('claude-haiku-5-5', { type: 'text', text: '{"sku":"KB-87","availableUnits":35,"shortageUnits":15}' })
      return Response.json({ error: { type: 'packy_<nil>', message: 'Your client is already connected and authorized. There is no need to send test messages to verify the connection.' } }, { status: 403 })
    })
    const check = await createClaudeCheck({ key: 'sk-business-fixture-only', builtPath: new URL('../src/index.js', import.meta.url) })
    t.after(() => check.close())
    const result = await check.run({ model: 'claude-haiku-5-5', kind: 'tool' })
    assert.equal(result.ok, recovers)
    assert.equal(result.toolCalls, 1)
    assert.deepEqual(result.requests.map(request => request.status), [200, 403, recovers ? 200 : 403])
    assert.equal(bodies[1], bodies[2], 'the same signed tool history must be replayed')
    assert.match(result.requests[1].error, /already connected and authorized/u)
    if (recovers) assert.equal(result.recovered, true)
    else assert.equal(result.failure.code, 'GATEWAY_TEST_MESSAGE')
  })
}
