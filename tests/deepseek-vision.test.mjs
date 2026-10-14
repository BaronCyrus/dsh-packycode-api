import assert from 'node:assert/strict'
import test from 'node:test'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { createVisionFixture } from '../scripts/vision-fixture.mjs'
import { PackyCodeKeyRing } from '../src/key-ring.js'
import { createRouteAdapter } from '../src/route.js'
import { fakeCredentials } from './helpers.mjs'

test('DeepSeek images reach Chat Completions through the registered host route', async t => {
  const fixture = createVisionFixture('red')
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add('sk-fixture-only-not-a-real-key', 'fixture')
  const adapter = createRouteAdapter({
    ring,
    keys: {
      active: () => ring.activeKey(),
      forRequest: (_model, key) => key,
      onKeyFailure: () => assert.fail('the fixture key must not be rejected'),
    },
    fallbackSessionId: 'vision-fixture',
    resolveAttachments: () => fixture.attachments,
  })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init)
    requests.push({ url: request.url, body: await request.json() })
    const events = [
      { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta: { role: 'assistant', content: 'red' }, finish_reason: null }] },
      { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })
  const prepared = await adapter.prepareCall('packycode', 'deepseek-flash')
  const chunks = []
  for await (const chunk of prepared.stream({
    provider: 'packycode', model: 'deepseek-flash', sessionId: 'vision-fixture',
    reasoningEffort: 'off', maxTokens: 128,
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'Describe this image.' }, fixture.block],
      source: { kind: 'user' },
    })],
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop')
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'red')
  assert.deepEqual(fixture.reads, [fixture.block.attachment.attachmentId])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://cf.api.fan/v1/chat/completions')
  assert.equal(requests[0].body.model, 'deepseek-flash')
  const content = requests[0].body.messages.find(message => message.role === 'user').content
  assert.deepEqual(content[0], { type: 'text', text: 'Describe this image.' })
  // The host also adds a text description of the request preview. What
  // matters here is that it preserves the pixels rather than only that text.
  assert.deepEqual(content.filter(block => block.type === 'image_url'), [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${fixture.data.toString('base64')}` } },
  ])
})
