import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmRuntime } from '@deepseek-ai/dsh-llm'

import { createVisionFixture } from '../scripts/vision-fixture.mjs'
import { HY4_IDENTITY_NOTE, withIdentityNote } from '../src/hy4-identity.js'
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

/** The opening of DSH 0.2.1's system prompt, which names the harness and the model id only. */
const DSH_SYSTEM = 'You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent powered by the hy4 model.'

test('Hy4 is told who made it after DSH\'s own instructions, which name only the harness', async () => {
  // Under this prompt Hy4 called itself a DeepSeek model and denied being Hunyuan.
  const provider = hostProvider(createPackyCodeProvider())
  const bodies = []
  const fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return responsesStream() }
  const messages = [{ role: 'user', content: '你是什么模型？', timestamp: 1 }]
  await provider.streamSimple(hy4(provider), { systemPrompt: DSH_SYSTEM, messages }, { apiKey: KEY, reasoning: 'high', fetch }).result()
  assert.deepEqual(bodies[0].input[0], { role: 'developer', content: `${DSH_SYSTEM}\n\n${HY4_IDENTITY_NOTE}` })
  assert.deepEqual(bodies[0].input.slice(1).map(item => item.role), ['user'])
  // A request without instructions gets the note as its only ones.
  await provider.streamSimple(hy4(provider), { messages }, { apiKey: KEY, reasoning: 'off', fetch }).result()
  assert.deepEqual(bodies[1].input.map(item => item.role), ['developer', 'user'])
  assert.equal(bodies[1].input[0].content, HY4_IDENTITY_NOTE)
  // The other models get DSH's instructions as written.
  for (const id of ['deepseek-flash', 'grok-4.7', 'gpt-6.1-terra']) {
    const model = provider.getModels().find(entry => entry.id === id)
    await provider.streamSimple(model, { systemPrompt: DSH_SYSTEM, messages }, { apiKey: KEY, reasoning: 'high', sessionId: 'other-session', fetch }).result()
    assert.deepEqual(bodies.at(-1).input[0], { role: 'developer', content: DSH_SYSTEM }, id)
    assert.equal(JSON.stringify(bodies.at(-1)).includes(HY4_IDENTITY_NOTE), false, id)
  }
})

test('a caller\'s own payload hook sees Hy4\'s note and has the last word', async () => {
  const provider = hostProvider(createPackyCodeProvider())
  let body
  let seen
  const result = await provider.streamSimple(hy4(provider), { systemPrompt: DSH_SYSTEM, messages: [{ role: 'user', content: 'Reply with ok', timestamp: 1 }] }, {
    apiKey: KEY, reasoning: 'high',
    onPayload: payload => { seen = payload.input[0].content; return { ...payload, metadata: { caller: 'kept' } } },
    fetch: async (_url, init) => { body = JSON.parse(init.body); return responsesStream() },
  }).result()
  assert.equal(result.stopReason, 'stop', result.errorMessage)
  assert.ok(seen.endsWith(HY4_IDENTITY_NOTE))
  assert.deepEqual(body.metadata, { caller: 'kept' })
  assert.equal(body.input[0].content.split(HY4_IDENTITY_NOTE).length, 2, 'the note is sent once')
})

test('the note is added once, without touching the payload it was given', () => {
  const payload = Object.freeze({ model: 'hy4', input: Object.freeze([Object.freeze({ role: 'developer', content: DSH_SYSTEM }), Object.freeze({ role: 'user', content: 'hi' })]) })
  const noted = withIdentityNote(payload)
  assert.equal(noted.input[0].content, `${DSH_SYSTEM}\n\n${HY4_IDENTITY_NOTE}`)
  assert.deepEqual(noted.input[1], payload.input[1])
  assert.equal(payload.input[0].content, DSH_SYSTEM)
  assert.equal(withIdentityNote(noted), noted)
  // A body that is not a Responses input list is left alone.
  assert.equal(withIdentityNote(undefined), undefined)
  const text = { model: 'hy4', input: 'hi' }
  assert.equal(withIdentityNote(text), text)
})
