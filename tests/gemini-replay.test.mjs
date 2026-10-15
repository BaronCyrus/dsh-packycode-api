import assert from 'node:assert/strict'
import test from 'node:test'

import { guardGeminiReplay } from '../src/gemini-replay.js'

const model = { id: 'gemini-3.8-flash', provider: 'packycode', api: 'google-generative-ai' }
const signature = Buffer.from('test signature').toString('base64')
const context = { messages: [
  { role: 'user', content: 'Use echo.' },
  { role: 'assistant', provider: model.provider, api: model.api, model: model.id, content: [{ type: 'toolCall', id: 'call_echo', name: 'echo', arguments: { text: 'ok' }, thoughtSignature: signature }] },
  { role: 'toolResult', toolCallId: 'call_echo', content: [{ type: 'text', text: 'ok' }] },
] }
const message = (stopReason, errorMessage) => ({ role: 'assistant', provider: model.provider, api: model.api, model: model.id, content: [], stopReason, errorMessage, usage: {}, timestamp: 1 })
const refusal = (text = '400 Corrupted thought signature.') => ({ type: 'error', reason: 'error', error: message('error', text) })
const done = { type: 'done', reason: 'stop', message: message('stop') }
const stream = events => ({ async *[Symbol.asyncIterator]() { yield* events }, result: async () => events.at(-1).error ?? events.at(-1).message })

test('a signed Flash replay retries one pre-output 400 without exposing the failed attempt', async () => {
  let opens = 0
  let waits = 0
  const result = guardGeminiReplay(() => stream(++opens === 1 ? [refusal()] : [done]), {
    model, context,
    wait: async (ms, signal) => { assert.equal(ms, 1000); assert.equal(signal, undefined); waits += 1 },
  })
  const events = []
  for await (const event of result) events.push(event)
  assert.equal(opens, 2)
  assert.equal(waits, 1)
  assert.deepEqual(events, [done])
  assert.equal((await result.result()).stopReason, 'stop')
})

test('a permanent signature error is exposed after one resend, without rewriting it', async () => {
  let opens = 0
  const failure = refusal('400 Invalid thought signature. request id: fixture')
  const result = guardGeminiReplay(() => { opens += 1; return stream([failure]) }, { model, context, wait: async () => {} })
  const events = []
  for await (const event of result) events.push(event)
  assert.equal(opens, 2)
  assert.deepEqual(events, [failure])
  assert.equal((await result.result()).errorMessage, failure.error.errorMessage)
})

test('a refusal after any streamed event is never replayed', async () => {
  let opens = 0
  const events = [{ type: 'start', partial: message('pending') }, refusal()]
  const result = guardGeminiReplay(() => { opens += 1; return stream(events) }, { model, context, wait: async () => assert.fail('must not wait') })
  const received = []
  for await (const event of result) received.push(event)
  assert.equal(opens, 1)
  assert.deepEqual(received, events)
})

test('cancelling the backoff emits an aborted finish and never resends', async () => {
  let opens = 0
  const controller = new AbortController()
  const result = guardGeminiReplay(() => { opens += 1; return stream([refusal()]) }, {
    model, context, signal: controller.signal,
    wait: async (_ms, signal) => { assert.equal(signal, controller.signal); controller.abort(); throw new Error('aborted wait') },
  })
  const final = await result.result()
  assert.equal(opens, 1)
  assert.equal(final.stopReason, 'aborted')
  assert.equal(final.errorMessage, 'Request aborted')
})

for (const text of ['400 invalid request', '401 Invalid thought signature.', '429 Invalid thought signature.', '400 insufficient quota: Invalid thought signature.', '400 Missing thought signature.']) {
  test(`unrelated failure is not replayed: ${text}`, async () => {
    let opens = 0
    const original = stream([refusal(text)])
    const result = guardGeminiReplay(() => { opens += 1; return original }, { model, context, wait: async () => assert.fail('must not wait') })
    const events = []
    for await (const event of result) events.push(event)
    assert.equal(opens, 1)
    assert.equal((await result.result()).errorMessage, text)
  })
}

for (const [name, replayModel, messages] of [
  ['Argon', { ...model, id: 'gemini-4-argon' }, context.messages],
  ['initial turn', model, [context.messages[0]]],
  ['missing signature', model, [context.messages[0], { ...context.messages[1], content: [{ ...context.messages[1].content[0], thoughtSignature: undefined }] }, context.messages[2]]],
  ['invalid base64 signature', model, [context.messages[0], { ...context.messages[1], content: [{ ...context.messages[1].content[0], thoughtSignature: 'not-base64' }] }, context.messages[2]]],
  ['foreign model', model, [context.messages[0], { ...context.messages[1], model: 'another-model' }, context.messages[2]]],
  ['unmatched tool result', model, [context.messages[0], context.messages[1], { ...context.messages[2], toolCallId: 'another-call' }]],
  ['new user turn', model, [...context.messages, { role: 'user', content: 'Start a new task.' }]],
]) {
  test(`requests without a current signed native replay retain their stream: ${name}`, () => {
    const original = stream([refusal()])
    const result = guardGeminiReplay(() => original, { model: replayModel, context: { messages }, wait: async () => assert.fail('must not wait') })
    assert.equal(result, original)
  })
}
