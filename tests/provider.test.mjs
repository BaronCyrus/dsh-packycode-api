import assert from 'node:assert/strict'
import test from 'node:test'

import { isQuotaExceededError } from '@deepseek-ai/dsh-llm'

import { PACKYCODE_MODEL_IDS } from '../src/catalog.js'
import { DISPLAY_NAME, PROVIDER } from '../src/constants.js'
import { createPackyCodeProvider, guardKeyRotation } from '../src/provider.js'

/** A pi-ai shaped stream: an async iterable plus `.result()`. */
function fakeStream(items, { throwAt } = {}) {
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (const [index, item] of items.entries()) {
        if (throwAt === index) throw new Error(throwAt === 0 && items.length === 0 ? 'transport' : 'boom')
        yield item
      }
      if (throwAt !== undefined && throwAt >= items.length) throw new Error('late boom')
    },
    result: async () => ({ ok: true }),
  }
  return stream
}

test('builds one route carrying all three protocols', () => {
  const provider = createPackyCodeProvider()
  assert.equal(provider.id, PROVIDER)
  assert.equal(provider.name, DISPLAY_NAME)
  assert.deepEqual(provider.getModels().map(model => model.id), [...PACKYCODE_MODEL_IDS])
  assert.equal(typeof provider.stream, 'function')
  assert.equal(typeof provider.streamSimple, 'function')
})

test('a terminal quota event moves the ring and is rewritten for the classifier', async () => {
  const failures = []
  const event = {
    type: 'error',
    error: { errorMessage: '403 {"error":{"message":"当前令牌额度已用完"}}' },
  }
  const guarded = guardKeyRotation(fakeStream([event]), {
    key: 'sk-aaaaaaaaaaaaaaaa',
    onKeyFailure: (...args) => failures.push(args),
  })
  const received = []
  for await (const item of guarded) received.push(item)

  assert.equal(failures.length, 1)
  assert.equal(failures[0][0], 'quota')
  assert.equal(failures[0][2], 'sk-aaaaaaaaaaaaaaaa')
  assert.equal(isQuotaExceededError(received[0].error.errorMessage), true)
  // The wrapper keeps `result()` and every other member reachable.
  assert.deepEqual(await guarded.result(), { ok: true })
})

test('a rejected key reported as a terminal event normalizes to auth', async () => {
  const failures = []
  const guarded = guardKeyRotation(fakeStream([
    { type: 'done', message: { errorMessage: '401 {"error":{"message":"无效的令牌"}}' } },
  ]), { key: 'sk-bbbbbbbbbbbbbbbbbb', onKeyFailure: (...args) => failures.push(args) })
  const received = []
  for await (const item of guarded) received.push(item)
  assert.equal(failures[0][0], 'invalid-key')
  assert.match(received[0].message.errorMessage, /\b401\b/u)
})

test('a pre-chunk transport failure is attributed and rewritten when it is a key fault', async () => {
  const failures = []
  const guarded = guardKeyRotation(fakeStream([], { throwAt: 0 }), {
    key: 'sk-cccccccccccccccccccc',
    onKeyFailure: (...args) => failures.push(args),
  })
  await assert.rejects(async () => {
    for await (const _item of guarded) void _item
  }, /boom/u)
  // A generic failure names no key condition, so nothing rotates.
  assert.deepEqual(failures, [])
})

test('a mid-stream failure never blames the key', async () => {
  const failures = []
  const guarded = guardKeyRotation(fakeStream([{ type: 'text', text: 'hi' }], { throwAt: 1 }), {
    key: 'sk-dddddddddddddddddddd',
    onKeyFailure: (...args) => failures.push(args),
  })
  await assert.rejects(async () => {
    for await (const _item of guarded) void _item
  }, /late boom/u)
  assert.deepEqual(failures, [])
})

test('an unrelated stream passes through untouched', () => {
  assert.equal(guardKeyRotation(null), null)
  assert.equal(guardKeyRotation('nope'), 'nope')
})

test('a client-policy refusal is explained without touching the key ring', async () => {
  const failures = []
  const policy = '403 {"error":{"type":"packy_api_error","message":"This API endpoint is only accessible via the official Claude CLI (request id: 01M4Q6FJ0)"}}'
  const guarded = guardKeyRotation(fakeStream([{ type: 'error', error: { errorMessage: policy } }]), {
    key: 'sk-eeeeeeeeeeeeeeeeeeee',
    onKeyFailure: (...args) => failures.push(args),
  })
  const received = []
  for await (const item of guarded) received.push(item)
  assert.deepEqual(failures, [], 'no key may be disabled for a client-policy refusal')
  assert.match(received[0].error.errorMessage, /这不是 API Key 失效/u)
  assert.equal(isQuotaExceededError(received[0].error.errorMessage), false)
})

test('a thrown client-policy refusal is explained too', async () => {
  const failures = []
  const guarded = guardKeyRotation(fakeStream([], { throwAt: 0 }), {
    key: 'sk-ffffffffffffffffffff',
    onKeyFailure: (...args) => failures.push(args),
  })
  // Replace the transport failure with the policy error for this case.
  const policyStream = {
    async *[Symbol.asyncIterator]() {
      throw new Error('403 {"error":{"message":"This API endpoint is only accessible via the official Claude CLI"}}')
    },
  }
  const guardedPolicy = guardKeyRotation(policyStream, {
    key: 'sk-ffffffffffffffffffff',
    onKeyFailure: (...args) => failures.push(args),
  })
  await assert.rejects(async () => {
    for await (const _item of guardedPolicy) void _item
  }, /这不是 API Key 失效/u)
  assert.deepEqual(failures, [])
  // The original key-fault path is unchanged for a generic failure.
  await assert.rejects(async () => {
    for await (const _item of guarded) void _item
  }, /boom/u)
})
