import assert from 'node:assert/strict'
import test from 'node:test'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { PackyCodeKeyRing } from '../src/key-ring.js'
import { createRouteAdapter } from '../src/route.js'
import { responsesStream } from './fixtures/responses.mjs'
import { fakeCredentials } from './helpers.mjs'

const KEY = 'sk-fixture-only-not-a-real-key'

test('GPT-6.1 Terra takes each documented effort through the route, and off as effort none', async t => {
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    bodies.push(JSON.parse(await new Request(input, init).text()))
    return responsesStream()
  })
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add(KEY, 'fixture')
  const adapter = createRouteAdapter({
    ring,
    keys: { active: () => ring.activeKey(), forRequest: (_model, key) => key, onKeyFailure: () => assert.fail('no key failure here') },
  })
  const prepared = await adapter.prepareCall('packycode', 'gpt-6.1-terra')
  for (const reasoningEffort of ['off', 'low', 'medium', 'high', 'xhigh', 'max']) {
    let finish
    for await (const chunk of prepared.stream({
      provider: 'packycode', model: 'gpt-6.1-terra', sessionId: 'terra-session', reasoningEffort,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Reply with ok' }], source: { kind: 'user' } })],
    })) if (chunk.type === 'finish') finish = chunk.reason
    assert.equal(finish.kind, 'stop', reasoningEffort)
    const body = bodies.at(-1)
    assert.equal(body.model, 'gpt-6.1-terra')
    // The Codex group refuses a Responses request without it.
    assert.equal(body.prompt_cache_key, 'terra-session')
    // PackyCode passes `none` through to Terra, which then answers without reasoning.
    assert.equal(body.reasoning.effort, reasoningEffort === 'off' ? 'none' : reasoningEffort)
  }
  assert.equal(bodies.length, 6)
})
