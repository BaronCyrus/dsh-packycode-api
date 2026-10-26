import assert from 'node:assert/strict'
import test from 'node:test'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { PackyCodeKeyRing } from '../src/key-ring.js'
import { createRouteAdapter } from '../src/route.js'
import { dshTitleRequest } from './fixtures/dsh-session-title.mjs'
import { fakeCredentials } from './helpers.mjs'

const KEY = 'sk-fixture-only-not-a-real-key'

const sse = events => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
  headers: { 'Content-Type': 'text/event-stream' },
})

function answered() {
  const item = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Title', annotations: [] }] }
  return sse([
    { type: 'response.created', sequence_number: 0, response: { id: 'resp_fixture', object: 'response', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'Title' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } } },
  ])
}

const request = model => ({
  provider: 'packycode', model, sessionId: 'fixture-session', reasoningEffort: 'high',
  messages: [createUserMessage({ content: [{ type: 'text', text: 'Name this session.' }], source: { kind: 'user' } })],
})

async function drain(stream) {
  let finish
  for await (const chunk of stream) if (chunk.type === 'finish') finish = chunk.reason
  return finish
}

test('a GPT session title runs on GPT-6.1 Sol, which every GPT key group serves', async t => {
  const models = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    models.push(JSON.parse(await new Request(input, init).text()).model)
    return answered()
  })
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add(KEY, 'fixture')
  const adapter = createRouteAdapter({
    ring,
    keys: { active: () => ring.activeKey(), forRequest: (_model, key) => key, onKeyFailure: () => assert.fail('no key failure here') },
  })
  for (const model of ['gpt-6-astra', 'gpt-5.6-sol']) {
    const prepared = await adapter.prepareCall('packycode', model)
    assert.equal((await drain(prepared.stream(dshTitleRequest(['Name this session.'], { model, sessionId: 'fixture-session', reasoningEffort: 'low' })))).kind, 'stop')
    assert.equal(models.at(-1), 'gpt-6.1-sol', model)
    // The conversation itself stays on the chosen model.
    assert.equal((await drain(prepared.stream(request(model)))).kind, 'stop')
    assert.equal(models.at(-1), model)
  }
})
