import assert from 'node:assert/strict'
import test from 'node:test'

import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

import { PACKYCODE_MODEL_IDS } from '../src/catalog.js'
import { DEFAULT_REASONING_LEVEL, DISPLAY_NAME, PROVIDER } from '../src/constants.js'
import { createPackyCodeProfile, createRouteAdapter } from '../src/index.js'
import { PackyCodeKeyRing } from '../src/key-ring.js'
import { createPackyCodeProvider } from '../src/provider.js'
import { fakeCredentials } from './helpers.mjs'

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
  // DSH 0.2.1 lists a route only after its key resolves; that one check is
  // the only credential read a catalog read makes.
  assert.ok(reads.length <= 1, `listing read the credential ${reads.length} times`)
})

test('without a usable key the route lists no models instead of failing, where DSH lists only with a key', async () => {
  // DSH 0.2.1 resolves the key before it lists and shows nothing without one;
  // DSH 0.2.0 lists the catalog regardless.
  const probe = route()
  await probe.adapter.listModels(PROVIDER)
  const listsOnlyWithKey = probe.reads.length > 0
  const ring = new PackyCodeKeyRing(fakeCredentials())
  const adapter = createRouteAdapter({ ring, keys: { active: () => ring.activeKey(), forRequest: (_model, key) => key, onKeyFailure() {} } })
  const expected = listsOnlyWithKey ? [] : [...PACKYCODE_MODEL_IDS]
  assert.deepEqual((await adapter.listModels(PROVIDER)).map(model => model.id), expected, 'no key stored')
  const { keys: [stored] } = await ring.add('sk-listing-fixture-not-a-real-key', 'fixture')
  assert.deepEqual((await adapter.listModels(PROVIDER)).map(model => model.id), [...PACKYCODE_MODEL_IDS])
  await ring.disable(stored.id, 'quota')
  assert.deepEqual((await adapter.listModels(PROVIDER)).map(model => model.id), expected, 'every key moved aside')
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

  const terra = await adapter.resolveModel(PROVIDER, 'gpt-6.1-terra')
  assert.equal(terra.name, 'GPT-6.1 Terra')
  assert.equal(terra.context.contextWindow, 1_050_000)
  assert.deepEqual([...terra.inputModalities], ['text', 'image'])
  assert.deepEqual(terra.reasoning.efforts.map(effort => effort.id), ['off', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(terra.reasoning.defaultEffort, DEFAULT_REASONING_LEVEL)

  const gemini = await adapter.resolveModel(PROVIDER, 'gemini-4-argon')
  assert.equal(gemini.name, 'Gemini 4 Argon')
  assert.equal(gemini.context.contextWindow, 1_048_576)
  assert.deepEqual([...gemini.inputModalities], ['text', 'image'])
  assert.deepEqual(gemini.reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  assert.equal(gemini.reasoning.defaultEffort, DEFAULT_REASONING_LEVEL)
  const flash = await adapter.resolveModel(PROVIDER, 'gemini-3.8-flash')
  assert.equal(flash.name, 'Gemini 3.8 Flash')
  assert.equal(flash.context.contextWindow, 1_048_576)
  assert.deepEqual([...flash.inputModalities], ['text', 'image'])
  assert.deepEqual(flash.reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
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
