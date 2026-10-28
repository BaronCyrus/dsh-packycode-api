import assert from 'node:assert/strict'
import test from 'node:test'

import { createPackyCodeProvider } from '../src/provider.js'
import { functionCallItem, messageItem, reasoningItem, responsesStream } from './fixtures/responses.mjs'
import { hostProvider } from './helpers.mjs'

const KEY = 'sk-fixture-only-not-a-real-key'
const TOOLS = [{
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}]

const deepseek = (provider, id = 'deepseek-flash') => provider.getModels().find(model => model.id === id)

test('DeepSeek Flash and V4 Pro use Responses with their documented efforts and without the GPT cache key', async () => {
  const provider = hostProvider(createPackyCodeProvider())
  for (const id of ['deepseek-flash', 'deepseek-v4-pro']) for (const reasoning of ['low', 'high', 'max']) {
    const requests = []
    const stream = provider.streamSimple(deepseek(provider, id), { messages: [{ role: 'user', content: 'Reply with ok', timestamp: 1 }] }, {
      apiKey: KEY, reasoning, sessionId: 'deepseek-session', cacheRetention: 'long', maxTokens: 2048,
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
    assert.equal(requests[0].body.model, id)
    assert.equal(requests[0].body.reasoning.effort, reasoning)
    assert.ok(requests[0].body.include.includes('reasoning.encrypted_content'))
    assert.equal(requests[0].body.max_output_tokens, 2048)
    assert.equal(requests[0].body.prompt_cache_key, undefined, 'only GPT needs the cache key')
    assert.equal(requests[0].body.prompt_cache_retention, undefined)
  }
})

test('DeepSeek off asks Responses for effort none, which the gateway answers without reasoning', async () => {
  const provider = hostProvider(createPackyCodeProvider())
  for (const id of ['deepseek-flash', 'deepseek-v4-pro']) {
    let body
    const stream = provider.streamSimple(deepseek(provider, id), { messages: [{ role: 'user', content: 'Reply with ok', timestamp: 1 }] }, {
      apiKey: KEY, reasoning: 'off', sessionId: 'deepseek-session',
      fetch: async (_url, init) => { body = JSON.parse(init.body); return responsesStream() },
    })
    assert.equal((await stream.result()).stopReason, 'stop', id)
    assert.deepEqual(body.reasoning, { effort: 'none' }, id)
    assert.equal(body.include, undefined, id)
  }
})

test('DeepSeek reasoning streams as thinking and is replayed with the tool call it preceded', async () => {
  const provider = hostProvider(createPackyCodeProvider())
  const model = deepseek(provider)
  const thought = reasoningItem('The user wants the weather, so call get_weather.')
  const call = functionCallItem('get_weather', { city: 'Paris' })
  const bodies = []
  const answers = [responsesStream([thought, call]), responsesStream([messageItem('Paris: 18°C, sunny.')])]
  const options = {
    apiKey: KEY, reasoning: 'high', sessionId: 'deepseek-session',
    fetch: async (_url, init) => { bodies.push(JSON.parse(init.body)); return answers.shift() },
  }
  const messages = [{ role: 'user', content: 'What is the weather in Paris?', timestamp: 1 }]
  const context = () => ({ systemPrompt: 'Use the tool for weather.', messages, tools: TOOLS })

  const first = provider.streamSimple(model, context(), options)
  const thinking = []
  for await (const event of first) if (event.type === 'thinking_delta') thinking.push(event.delta)
  const toolTurn = await first.result()
  assert.equal(toolTurn.stopReason, 'toolUse', toolTurn.errorMessage)
  assert.equal(thinking.join(''), thought.content[0].text)
  const toolCall = toolTurn.content.find(block => block.type === 'toolCall')
  assert.deepEqual(toolCall.arguments, { city: 'Paris' })

  messages.push(toolTurn, { role: 'toolResult', toolCallId: toolCall.id, toolName: 'get_weather', content: [{ type: 'text', text: '18°C, sunny' }], isError: false, timestamp: 2 })
  const second = await provider.streamSimple(model, context(), options).result()
  assert.equal(second.stopReason, 'stop', second.errorMessage)

  const input = bodies[1].input
  assert.deepEqual(input.map(item => item.type ?? item.role), ['developer', 'user', 'reasoning', 'function_call', 'function_call_output'])
  // The gateway hands DeepSeek its reasoning back from this item's text.
  assert.deepEqual(input[2], thought)
  assert.equal(input[3].call_id, call.call_id)
  assert.equal(input[4].call_id, call.call_id)
})
