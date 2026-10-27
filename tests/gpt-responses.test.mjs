import assert from 'node:assert/strict'
import test from 'node:test'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { PackyCodeKeyRing } from '../src/key-ring.js'
import { createRouteAdapter } from '../src/route.js'
import { responsesStream } from './fixtures/responses.mjs'
import { fakeCredentials } from './helpers.mjs'

const KEY = 'sk-fixture-only-not-a-real-key'

/** DSH 0.2.1's bash parameters, compiled: only `description` and `command` are required. */
const BASH = Object.freeze({
  name: 'bash',
  description: 'Execute a bash command (`bash -c`) and return its stdout/stderr.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Clear, concise description of what this command does.' },
      command: { type: 'string', description: 'The bash command to execute.' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds.' },
      sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: 'The narrowest wider sandbox mode for a one-shot retry of the exact command the sandbox just denied; the retry asks the user for approval.' },
      justification: { type: 'string', description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.' },
    },
    required: ['description', 'command'],
  },
})

/** The route over one fixture key, with every request body it sends. */
async function route(t) {
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
  const send = async (model, options) => {
    const prepared = await adapter.prepareCall('packycode', model)
    let finish
    for await (const chunk of prepared.stream({
      provider: 'packycode', model, sessionId: `${model}-session`,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Reply with ok' }], source: { kind: 'user' } })],
      ...options,
    })) if (chunk.type === 'finish') finish = chunk.reason
    assert.equal(finish.kind, 'stop', model)
    return bodies.at(-1)
  }
  return { bodies, send }
}

test('GPT-6.1 Terra takes each documented effort through the route, and off as effort none', async t => {
  const { bodies, send } = await route(t)
  for (const reasoningEffort of ['off', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const body = await send('gpt-6.1-terra', { reasoningEffort })
    assert.equal(body.model, 'gpt-6.1-terra')
    // The Codex group refuses a Responses request without it.
    assert.equal(body.prompt_cache_key, 'gpt-6.1-terra-session')
    // PackyCode passes `none` through to Terra, which then answers without reasoning.
    assert.equal(body.reasoning.effort, reasoningEffort === 'off' ? 'none' : reasoningEffort)
  }
  assert.equal(bodies.length, 6)
})

test('GPT sends DSH\'s tools with strict false, so the model may leave the sandbox escalation pair out', async t => {
  const { send } = await route(t)
  // Without `strict`, PackyCode's GPT route made the model fill every optional
  // parameter, and edit/write refused the empty justification it gave.
  for (const model of ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-5.6-sol']) {
    const [tool] = (await send(model, { reasoningEffort: 'high', tools: [BASH] })).tools
    assert.equal(tool.name, 'bash', model)
    assert.equal(tool.strict, false, model)
    assert.deepEqual(tool.parameters, BASH.parameters, model)
  }
  // DeepSeek and Grok leave optional parameters out without the field.
  for (const model of ['deepseek-flash', 'grok-4.7']) {
    const [tool] = (await send(model, { reasoningEffort: 'high', tools: [BASH] })).tools
    assert.equal(Object.hasOwn(tool, 'strict'), false, model)
    assert.deepEqual(tool.parameters, BASH.parameters, model)
  }
})
