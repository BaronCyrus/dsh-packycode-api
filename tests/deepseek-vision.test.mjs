import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmRuntime, textOnlyImageText } from '@deepseek-ai/dsh-llm'

import { createVisionFixture } from '../scripts/vision-fixture.mjs'
import { PackyCodeKeyRing } from '../src/key-ring.js'
import { createRouteAdapter } from '../src/route.js'
import { fakeCredentials } from './helpers.mjs'
import { messageItem, responsesStream } from './fixtures/responses.mjs'

test('DeepSeek images reach Responses through the registered host route', async t => {
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
    return responsesStream([messageItem('red')])
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
  assert.equal(requests[0].url, 'https://cf.api.fan/v1/responses')
  assert.equal(requests[0].body.model, 'deepseek-flash')
  const content = requests[0].body.input.find(item => item.role === 'user').content
  assert.deepEqual(content[0], { type: 'input_text', text: 'Describe this image.' })
  // The host also adds a text description of the request preview. What
  // matters here is that it preserves the pixels rather than only that text.
  assert.deepEqual(content.filter(block => block.type === 'input_image'), [
    { type: 'input_image', detail: 'auto', image_url: `data:image/png;base64,${fixture.data.toString('base64')}` },
  ])
})

test('DeepSeek V4 Pro takes no images, so DSH sends it a note in place of an image already in the session', async t => {
  // The gateway drops an image sent to V4 Pro without an error, and the model
  // then reasons at length about a picture it never got. DSH's composer will
  // not attach one to a text-only model, and its LLM runtime turns an image
  // already in the history into a note, e.g. after a switch from Flash.
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
  const llm = new LlmRuntime(new Context())
  const registration = llm.registerAdapter(['packycode'], adapter)
  t.after(() => registration())
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    bodies.push(await new Request(input, init).json())
    return responsesStream([messageItem('ok')])
  })
  const prepared = await llm.prepareCall({ provider: 'packycode', model: 'deepseek-v4-pro', reasoningEffort: 'off', maxTokens: 128 })
  assert.deepEqual([...prepared.inputModalities], ['text'])
  const chunks = []
  for await (const chunk of prepared.stream({
    ...prepared.config,
    sessionId: 'vision-fixture',
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'Describe this image.' }, fixture.block],
      source: { kind: 'user' },
    })],
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop')
  assert.deepEqual(fixture.reads, [], 'the image is never read for V4 Pro')
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].model, 'deepseek-v4-pro')
  const content = bodies[0].input.find(item => item.role === 'user').content
  // pi-ai joins the user's text blocks into one input_text.
  assert.deepEqual(content, [{ type: 'input_text', text: `Describe this image.${textOnlyImageText(fixture.block.attachment)}` }])
})
