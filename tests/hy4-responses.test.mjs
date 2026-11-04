import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmRuntime } from '@deepseek-ai/dsh-llm'

import { createVisionFixture } from '../scripts/vision-fixture.mjs'
import { PackyCodeKeyRing } from '../src/key-ring.js'
import { createPackyCodeProvider } from '../src/provider.js'
import { createRouteAdapter } from '../src/route.js'
import { dshTitleRequest } from './fixtures/dsh-session-title.mjs'
import { functionCallItem, messageItem, responsesStream, summaryReasoningItem } from './fixtures/responses.mjs'
import { fakeCredentials, hostProvider } from './helpers.mjs'

const KEY = 'sk-fixture-only-not-a-real-key'
const TOOLS = [{
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}]

const hy4 = provider => provider.getModels().find(model => model.id === 'hy4')

/** The route over one fixture key; each request body it sends is kept. */
async function route(t, answer = () => responsesStream(), options = {}) {
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init)
    assert.equal(request.url, 'https://cf.api.fan/v1/responses')
    bodies.push(await request.json())
    return answer()
  })
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add(KEY, 'fixture')
  const adapter = createRouteAdapter({
    ring,
    keys: { active: () => ring.activeKey(), forRequest: (_model, key) => key, onKeyFailure: () => assert.fail('no key failure here') },
    fallbackSessionId: 'hy4-fixture',
    ...options,
  })
  return { adapter, bodies }
}

async function drain(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const ask = (reasoningEffort, extra = {}) => ({
  provider: 'packycode', model: 'hy4', sessionId: 'hy4-session', reasoningEffort,
  messages: [createUserMessage({ content: [{ type: 'text', text: 'Reply with ok' }], source: { kind: 'user' } })],
  ...extra,
})

test('Hy4 uses Responses at high, without the GPT cache key or strict on its tools', async () => {
  const provider = hostProvider(createPackyCodeProvider())
  const requests = []
  const stream = provider.streamSimple(hy4(provider), { messages: [{ role: 'user', content: 'Reply with ok', timestamp: 1 }], tools: TOOLS }, {
    apiKey: KEY, reasoning: 'high', sessionId: 'hy4-session', cacheRetention: 'long', maxTokens: 2048,
    fetch: async (url, init) => {
      requests.push({ url: String(url), key: new Headers(init.headers).get('authorization'), body: JSON.parse(init.body) })
      return responsesStream()
    },
  })
  const result = await stream.result()
  assert.equal(result.stopReason, 'stop', result.errorMessage)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://cf.api.fan/v1/responses')
  assert.equal(requests[0].key, `Bearer ${KEY}`)
  const { body } = requests[0]
  assert.equal(body.model, 'hy4')
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' })
  assert.deepEqual(body.include, ['reasoning.encrypted_content'])
  assert.equal(body.max_output_tokens, 2048)
  // The prefix cache hits without it, so Hy4 is sent no cache key.
  assert.equal(body.prompt_cache_key, undefined)
  assert.equal(body.prompt_cache_retention, undefined)
  assert.equal(body.tools.length, 1)
  assert.equal(Object.hasOwn(body.tools[0], 'strict'), false)
  assert.deepEqual(body.tools[0].parameters, TOOLS[0].parameters)
})

test('Hy4 off sends its documented no_think, which the gateway answers without reasoning', async () => {
  const provider = hostProvider(createPackyCodeProvider())
  let body
  const stream = provider.streamSimple(hy4(provider), { messages: [{ role: 'user', content: 'Reply with ok', timestamp: 1 }] }, {
    apiKey: KEY, reasoning: 'off', sessionId: 'hy4-session',
    fetch: async (_url, init) => { body = JSON.parse(init.body); return responsesStream() },
  })
  assert.equal((await stream.result()).stopReason, 'stop')
  assert.deepEqual(body.reasoning, { effort: 'no_think' })
  assert.equal(body.include, undefined)
})

test('Hy4 reasoning streams as summary text and is replayed unchanged with its tool call and in the next turn', async () => {
  const provider = hostProvider(createPackyCodeProvider())
  const model = hy4(provider)
  const thought = summaryReasoningItem('The user wants the weather, so call get_weather.', 'rs_hy4_first')
  const call = functionCallItem('get_weather', { city: 'Shenzhen' })
  const afterTool = summaryReasoningItem('The tool answered; report it.', 'rs_hy4_second')
  const bodies = []
  const answers = [
    responsesStream([thought, call]),
    responsesStream([afterTool, messageItem('Shenzhen: 26°C, cloudy.', 'msg_hy4_answer')]),
    responsesStream([messageItem('26°C.', 'msg_hy4_follow_up')]),
  ]
  const options = {
    apiKey: KEY, reasoning: 'high', sessionId: 'hy4-session',
    fetch: async (_url, init) => { bodies.push(JSON.parse(init.body)); return answers.shift() },
  }
  const messages = [{ role: 'user', content: 'What is the weather in Shenzhen?', timestamp: 1 }]
  const context = () => ({ systemPrompt: 'Use the tool for weather.', messages, tools: TOOLS })

  const first = provider.streamSimple(model, context(), options)
  let streamed = ''
  for await (const event of first) if (event.type === 'thinking_delta') streamed += event.delta
  const toolTurn = await first.result()
  assert.equal(toolTurn.stopReason, 'toolUse', toolTurn.errorMessage)
  assert.equal(streamed.trim(), thought.summary[0].text)
  assert.equal(toolTurn.content.find(block => block.type === 'thinking').thinking, thought.summary[0].text)
  const toolCall = toolTurn.content.find(block => block.type === 'toolCall')
  assert.deepEqual(toolCall.arguments, { city: 'Shenzhen' })

  messages.push(toolTurn, { role: 'toolResult', toolCallId: toolCall.id, toolName: 'get_weather', content: [{ type: 'text', text: '26°C, cloudy' }], isError: false, timestamp: 2 })
  const answer = await provider.streamSimple(model, context(), options).result()
  assert.equal(answer.stopReason, 'stop', answer.errorMessage)
  const continued = bodies[1].input
  assert.deepEqual(continued.map(item => item.type ?? item.role), ['developer', 'user', 'reasoning', 'function_call', 'function_call_output'])
  // TokenHub asks for the reasoning back unchanged: the item as it arrived.
  assert.deepEqual(continued[2], thought)
  assert.equal(continued[3].call_id, call.call_id)
  assert.equal(continued[3].id, call.id)
  assert.equal(continued[4].call_id, call.call_id)

  // Preserved thinking: a later user turn still carries every earlier item.
  messages.push(answer, { role: 'user', content: 'And in Fahrenheit?', timestamp: 3 })
  assert.equal((await provider.streamSimple(model, context(), options).result()).stopReason, 'stop')
  const next = bodies[2].input
  assert.deepEqual(next.map(item => item.type ?? item.role), ['developer', 'user', 'reasoning', 'function_call', 'function_call_output', 'reasoning', 'message', 'user'])
  assert.deepEqual(next[2], thought)
  assert.deepEqual(next[5], afterTool)
})

test('through the route Hy4 takes off and high, and refuses the efforts it does not document before any request', async t => {
  const { adapter, bodies } = await route(t)
  const prepared = await adapter.prepareCall('packycode', 'hy4')
  for (const reasoningEffort of ['off', 'high']) {
    const finish = (await drain(prepared.stream(ask(reasoningEffort)))).find(chunk => chunk.type === 'finish')
    assert.equal(finish.reason.kind, 'stop', reasoningEffort)
    assert.equal(bodies.at(-1).model, 'hy4')
    assert.equal(bodies.at(-1).reasoning.effort, reasoningEffort === 'off' ? 'no_think' : 'high')
  }
  // The gateway does not refuse these, but Hy4 does not document them and
  // answered them no differently from high.
  for (const reasoningEffort of ['minimal', 'low', 'medium', 'xhigh', 'max']) {
    await assert.rejects(drain(prepared.stream(ask(reasoningEffort))), { code: 'UNSUPPORTED_REASONING_EFFORT' }, reasoningEffort)
  }
  assert.equal(bodies.length, 2)
})

test('Hy4 titles its own sessions, at off, the least effort it offers', async t => {
  const { adapter, bodies } = await route(t, () => responsesStream([messageItem('十月发货单整理')]))
  const prepared = await adapter.prepareCall('packycode', 'hy4')
  const chunks = await drain(prepared.stream(dshTitleRequest(['帮我把十月的发货单整理一下'], { model: 'hy4', sessionId: 'hy4-session', reasoningEffort: 'off' })))
  assert.equal(chunks.find(chunk => chunk.type === 'finish').reason.kind, 'stop')
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '十月发货单整理')
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].model, 'hy4')
  assert.deepEqual(bodies[0].reasoning, { effort: 'no_think' })
})

test('Hy4 images reach Responses through the registered host route', async t => {
  const fixture = createVisionFixture('blue')
  const { adapter, bodies } = await route(t, () => responsesStream([messageItem('blue')]), { resolveAttachments: () => fixture.attachments })
  const llm = new LlmRuntime(new Context())
  const registration = llm.registerAdapter(['packycode'], adapter)
  t.after(() => registration())
  const prepared = await llm.prepareCall({ provider: 'packycode', model: 'hy4', reasoningEffort: 'off', maxTokens: 128 })
  assert.deepEqual([...prepared.inputModalities], ['text', 'image'])
  const chunks = []
  for await (const chunk of prepared.stream({
    ...prepared.config,
    sessionId: 'hy4-vision',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Describe this image.' }, fixture.block], source: { kind: 'user' } })],
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop')
  assert.deepEqual(fixture.reads, [fixture.block.attachment.attachmentId])
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].model, 'hy4')
  const content = bodies[0].input.find(item => item.role === 'user').content
  assert.deepEqual(content.filter(block => block.type === 'input_image'), [
    { type: 'input_image', detail: 'auto', image_url: `data:image/png;base64,${fixture.data.toString('base64')}` },
  ])
})
