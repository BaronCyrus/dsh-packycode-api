import assert from 'node:assert/strict'
import test from 'node:test'

import { BlockAssembler, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

import { createVisionFixture } from '../scripts/vision-fixture.mjs'
import { SKIP_THOUGHT_SIGNATURE, skipThoughtSignatures } from '../src/gemini-api.js'
import { PackyCodeKeyRing } from '../src/key-ring.js'
import { createPackyCodeProvider } from '../src/provider.js'
import { createRouteAdapter } from '../src/route.js'
import { fakeCredentials, hostProvider } from './helpers.mjs'

const KEY = 'sk-fixture-only-not-a-real-key'
const TEXT_SIGNATURE = Buffer.from('fixture text signature').toString('base64')
const TOOL_SIGNATURE = Buffer.from('fixture tool signature').toString('base64')
const user = { role: 'user', content: 'Reply with ok', timestamp: 1 }

function nativeStream(parts = [{ text: 'Checked.', thought: true }, { text: 'ok', thoughtSignature: TEXT_SIGNATURE }], model = 'gemini-3.8-flash') {
  return new Response(`data: ${JSON.stringify({
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 4, totalTokenCount: 16 },
    modelVersion: model,
  })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
}

test('the durable host replay resends the exact same signed request and key once', async t => {
  const requests = capture(t, (_request, count, model) => {
    if (count === 1) return nativeStream([{ functionCall: { id: 'call_echo', name: 'echo', args: { text: 'ok' } }, thoughtSignature: TOOL_SIGNATURE }], model)
    if (count === 2) return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Corrupted thought signature.' } }, { status: 400 })
    return nativeStream([{ text: 'ok' }], model)
  })
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add(KEY, 'fixture')
  const adapter = createRouteAdapter({
    ring,
    keys: { active: () => ring.activeKey(), forRequest: (_model, key) => key, onKeyFailure: () => assert.fail('a signature refusal must not rotate the key') },
  })
  const model = 'gemini-3.8-flash'
  const turn = async messages => {
    const result = new BlockAssembler()
    const prepared = await adapter.prepareCall('packycode', model)
    for await (const chunk of prepared.stream({ provider: 'packycode', model, messages, reasoningEffort: 'low', maxTokens: 2048 })) result.push(chunk)
    return result
  }
  const messages = [createUserMessage({ content: [{ type: 'text', text: 'Use echo, then reply ok.' }], source: { kind: 'user' } })]
  const first = await turn(messages)
  const call = first.blocks().find(block => block.type === 'tool-call')
  assert.ok(call)
  messages.push(first.message({ kind: 'model', provider: 'packycode', model, replayState: first.replayState }))
  messages.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'ok' }], isError: false }))
  const second = await turn(JSON.parse(JSON.stringify(messages)))
  assert.equal(second.finish.kind, 'stop')
  assert.equal(second.blocks().filter(block => block.type === 'text').map(block => block.text).join(''), 'ok')
  assert.equal(requests.length, 3)
  assert.deepEqual(requests[1].body, requests[2].body)
  assert.equal(requests[1].key, KEY)
  assert.equal(requests[2].key, KEY)
  assert.equal(requests[2].body.contents.flatMap(item => item.parts).find(part => part.functionCall).thoughtSignature, SKIP_THOUGHT_SIGNATURE)
  assert.ok(!JSON.stringify(requests.map(request => request.body)).includes(TOOL_SIGNATURE), 'no real signature goes over the wire')
  assert.ok(JSON.stringify(first.replayState).includes(TOOL_SIGNATURE), 'DSH replay state keeps the returned signature')
  assert.equal((await ring.activeKey()).key, KEY)
})

test('requests carry Google\'s skip value instead of any real thought signature', () => {
  const contents = [
    { role: 'user', parts: [{ text: 'Read both files.' }] },
    { role: 'model', parts: [
      { thought: true, text: 'Plan.', thoughtSignature: TEXT_SIGNATURE },
      { functionCall: { name: 'read', args: { path: 'a' } }, thoughtSignature: TOOL_SIGNATURE },
      { functionCall: { name: 'read', args: { path: 'b' } } },
    ] },
    { role: 'user', parts: [{ functionResponse: { name: 'read', response: { output: 'A' } } }, { functionResponse: { name: 'read', response: { output: 'B' } } }] },
    { role: 'model', parts: [{ text: 'Next.' }, { functionCall: { name: 'read', args: { path: 'c' } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'read', response: { output: 'C' } } }] },
    { role: 'model', parts: [{ text: 'Done.', thoughtSignature: TEXT_SIGNATURE }] },
  ]
  const before = JSON.stringify(contents)
  const sent = skipThoughtSignatures(contents)
  assert.equal(JSON.stringify(contents), before, 'the input is not mutated')
  assert.deepEqual(sent[1].parts.map(part => part.thoughtSignature), [SKIP_THOUGHT_SIGNATURE, SKIP_THOUGHT_SIGNATURE, undefined], 'only the first call of a parallel step needs one')
  assert.deepEqual(sent[3].parts.map(part => part.thoughtSignature), [undefined, SKIP_THOUGHT_SIGNATURE], 'a step whose call came back unsigned gets one')
  assert.equal(sent[5].parts[0].thoughtSignature, SKIP_THOUGHT_SIGNATURE)
  assert.deepEqual(sent[0], contents[0])
  assert.deepEqual(sent[2], contents[2])
  assert.ok(!JSON.stringify(sent).includes(TOOL_SIGNATURE) && !JSON.stringify(sent).includes(TEXT_SIGNATURE))
  assert.equal(skipThoughtSignatures(undefined), undefined)
})

function capture(t, respond = (_request, _count, model) => nativeStream(undefined, model)) {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init)
    const call = { url: new URL(request.url), key: request.headers.get('x-goog-api-key'), body: await request.json() }
    requests.push(call)
    return respond(call, requests.length, call.url.pathname.match(/\/models\/([^:]+)/u)[1])
  })
  return requests
}

for (const id of ['gemini-3.8-flash']) {
  test(`${id} streams its three thinking levels through the native SDK without thinkingBudget`, async t => {
    const requests = capture(t)
    const provider = hostProvider(createPackyCodeProvider())
    const model = provider.getModels().find(model => model.id === id)
    for (const reasoning of ['low', 'medium', 'high']) {
      const stream = provider.streamSimple(model, { systemPrompt: 'Be concise.', messages: [user] }, {
        apiKey: KEY, reasoning, maxTokens: 2048,
      })
      const events = []
      for await (const event of stream) events.push(event)
      const result = await stream.result()
      assert.equal(result.stopReason, 'stop', result.errorMessage)
      assert.equal(result.api, 'google-generative-ai')
      assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.delta).join(''), 'ok')
      assert.equal(events.filter(event => event.type === 'thinking_delta').map(event => event.delta).join(''), 'Checked.')
      assert.equal(result.content.find(block => block.type === 'text').textSignature, TEXT_SIGNATURE)
      assert.equal(result.usage.input, 10)
      assert.equal(result.usage.output, 6, 'thinking tokens count toward output')
      const { url, key, body } = requests.at(-1)
      assert.equal(url.origin, 'https://cf.api.fan')
      assert.equal(url.pathname, `/v1beta/models/${id}:streamGenerateContent`)
      assert.equal(url.searchParams.get('alt'), 'sse')
      assert.equal(url.searchParams.has('key'), false, 'credentials stay out of URLs')
      assert.equal(key, KEY)
      assert.deepEqual(body.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: reasoning.toUpperCase() })
      assert.equal(body.generationConfig.maxOutputTokens, 2048)
      assert.equal(body.systemInstruction.parts[0].text, 'Be concise.')
      assert.equal(body.reasoning_effort, undefined)
      assert.equal(body.messages, undefined)
    }
    assert.equal(requests.length, 3)
  })

  test(`${id} defaults to medium and preserves an async payload hook after level normalization`, async t => {
    const requests = capture(t)
    const provider = hostProvider(createPackyCodeProvider())
    const model = provider.getModels().find(model => model.id === id)
    let callbacks = 0
    const result = await provider.streamSimple(model, { messages: [user] }, {
      apiKey: KEY,
      onPayload: async (payload, descriptor) => {
        callbacks += 1
        assert.equal(descriptor.id, model.id)
        assert.equal(payload.config.thinkingConfig.thinkingLevel, 'MEDIUM')
        assert.equal(payload.config.thinkingConfig.thinkingBudget, undefined)
        return { ...payload, config: { ...payload.config, maxOutputTokens: 512 } }
      },
    }).result()
    assert.equal(result.stopReason, 'stop', result.errorMessage)
    assert.equal(callbacks, 1)
    assert.equal(requests[0].body.generationConfig.maxOutputTokens, 512)
  })

  test(`${id} images reach the native endpoint through the registered host route`, async t => {
    const requests = capture(t, (_request, _count, model) => nativeStream([{ text: 'red' }], model))
    const image = createVisionFixture('red')
    const ring = new PackyCodeKeyRing(fakeCredentials())
    await ring.add(KEY, 'fixture')
    const adapter = createRouteAdapter({
      ring, resolveAttachments: () => image.attachments,
      keys: { active: () => ring.activeKey(), forRequest: (_model, key) => key, onKeyFailure: () => assert.fail('the fixture key must not be rejected') },
    })
    const prepared = await adapter.prepareCall('packycode', id)
    const chunks = []
    for await (const chunk of prepared.stream({
      provider: 'packycode', model: id, reasoningEffort: 'high', maxTokens: 2048,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Describe this image.' }, image.block], source: { kind: 'user' } })],
    })) chunks.push(chunk)
    assert.equal(chunks.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop')
    assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'red')
    assert.deepEqual(image.reads, [image.block.attachment.attachmentId])
    const pixels = requests[0].body.contents.flatMap(message => message.parts).filter(part => part.inlineData)
    assert.deepEqual(pixels, [{ inlineData: { mimeType: 'image/png', data: image.data.toString('base64') } }])
    assert.equal(requests[0].body.generationConfig.thinkingConfig.thinkingLevel, 'HIGH')
    assert.equal(requests[0].key, KEY)
  })

  test(`${id} replays native tool calls with the skip signature and their tool results`, async t => {
    const requests = capture(t, (_request, count, model) => count === 1
      ? nativeStream([{ functionCall: { name: 'echo', args: { text: 'ok' } }, thoughtSignature: TOOL_SIGNATURE }], model)
      : nativeStream([{ text: 'ok' }], model))
    const provider = hostProvider(createPackyCodeProvider())
    const model = provider.getModels().find(model => model.id === id)
    const tools = [{ name: 'echo', description: 'Echo a message.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }]
    const options = { apiKey: KEY, reasoning: 'low' }
    const first = await provider.streamSimple(model, { messages: [user], tools }, options).result()
    assert.equal(first.stopReason, 'toolUse', first.errorMessage)
    const call = first.content.find(block => block.type === 'toolCall')
    assert.equal(call.name, 'echo')
    assert.equal(call.thoughtSignature, TOOL_SIGNATURE)
    const second = await provider.streamSimple(model, {
      tools,
      messages: [user, first, { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 2 }],
    }, options).result()
    assert.equal(second.stopReason, 'stop', second.errorMessage)
    assert.equal(requests[0].body.tools[0].functionDeclarations[0].name, 'echo')
    const replayed = requests[1].body.contents.flatMap(message => message.parts)
    assert.equal(replayed.find(part => part.functionCall).thoughtSignature, SKIP_THOUGHT_SIGNATURE)
    assert.equal(replayed.find(part => part.functionResponse).functionResponse.name, 'echo')
    assert.equal(second.api, 'google-generative-ai')
    const direct = await provider.stream(model, {
      tools,
      messages: [user, first, { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 2 }],
    }, { apiKey: KEY }).result()
    assert.equal(direct.stopReason, 'stop', direct.errorMessage)
    assert.equal(requests[2].body.contents.flatMap(message => message.parts).find(part => part.functionCall).thoughtSignature, SKIP_THOUGHT_SIGNATURE, 'the direct stream path skips it too')
  })
}
