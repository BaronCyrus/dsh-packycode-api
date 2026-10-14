import assert from 'node:assert/strict'
import test from 'node:test'

import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

import { PACKYCODE_MODEL_IDS } from '../src/catalog.js'
import { DEFAULT_REASONING_LEVEL, DISPLAY_NAME, PROVIDER } from '../src/constants.js'
import { createPackyCodeProfile } from '../src/index.js'
import { createPackyCodeProvider } from '../src/provider.js'

/**
 * The route composed exactly as `apply()` composes it, driven through the real
 * host adapter. Resolution and call preparation must work without reading a
 * credential or opening a model stream.
 */
function route({ reads = [] } = {}) {
  const provider = createPackyCodeProvider()
  const profile = createPackyCodeProfile(provider)
  const profiles = new Map([[PROVIDER, profile]])
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => {
      reads.push('credential')
      return 'sk-test-not-a-real-key'
    },
    auth: Object.freeze({
      credentials: {
        async read() { return undefined },
        async list() { return [] },
        async modify() { throw new Error('unused') },
        async delete() { throw new Error('unused') },
      },
      authContext: Object.freeze({ env: async () => undefined, fileExists: async () => false }),
    }),
  })
  return { adapter, profile, reads }
}

test('the real adapter advertises the route under its display name', async () => {
  const { adapter, reads } = route()
  assert.deepEqual(adapter.providerInfo(PROVIDER), { id: PROVIDER, name: DISPLAY_NAME })
  const models = await adapter.listModels(PROVIDER)
  assert.deepEqual(models.map(model => model.id), [...PACKYCODE_MODEL_IDS])
  // Catalog reads never touch a credential.
  assert.deepEqual(reads, [])
})

test('resolved metadata carries context, modalities, and the vendor efforts', async () => {
  const { adapter } = route()
  const claude = await adapter.resolveModel(PROVIDER, 'claude-opus-5-5')
  assert.equal(claude.context.contextWindow, 1_000_000)
  assert.deepEqual([...claude.inputModalities], ['text', 'image'])
  assert.deepEqual(claude.reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(claude.reasoning.defaultEffort, DEFAULT_REASONING_LEVEL)
  assert.equal(claude.defaultMaxTokens, undefined)

  const deepseek = await adapter.resolveModel(PROVIDER, 'deepseek-flash')
  assert.deepEqual(deepseek.reasoning.efforts.map(effort => effort.id), ['off', 'low', 'high', 'max'])
  assert.deepEqual([...deepseek.inputModalities], ['text', 'image'])
})

test('preparing a call returns the model and a stream, without opening one', async () => {
  const { adapter, reads } = route()
  const prepared = await adapter.prepareCall(PROVIDER, 'gpt-6.1-sol')
  assert.equal(prepared.model.id, 'gpt-6.1-sol')
  assert.equal(typeof prepared.stream, 'function')
  assert.deepEqual(reads, [])
})

test('the profile carries the retry policy that makes rotation reachable', () => {
  const { profile } = route()
  assert.equal(profile.reasoning, DEFAULT_REASONING_LEVEL)
  assert.equal(profile.retryPolicy.mode, 'normal')
  // One route serves every model, so this budget applies to all of them.
  assert.equal(profile.retryPolicy.maxRetries, 20)
  for (const code of ['QUOTA', 'AUTH', 'INVALID_REQUEST', 'SERVER', 'TRANSPORT']) {
    assert.ok(profile.retryPolicy.retryableCodes.includes(code), `${code} must be retryable`)
  }
  assert.ok(profile.modelErrors instanceof Map)
  assert.ok(profile.configuredMaxTokens instanceof Map)
})
