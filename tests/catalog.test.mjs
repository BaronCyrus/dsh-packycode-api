import assert from 'node:assert/strict'
import test from 'node:test'

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'

import { PACKYCODE_MODELS, PACKYCODE_MODEL_IDS } from '../src/catalog.js'
import { DEFAULT_API_HOST, DEFAULT_REASONING_LEVEL, PROVIDER } from '../src/constants.js'

const byId = id => PACKYCODE_MODELS.find(model => model.id === id)

test('ships the configured model ids in picker order', () => {
  assert.deepEqual([...PACKYCODE_MODEL_IDS], ['deepseek-flash', 'gpt-6.1-sol', 'gpt-6-astra', 'grok-4.7', 'gemini-4-argon', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
  for (const model of PACKYCODE_MODELS) assert.equal(model.provider, PROVIDER)
})

test('every current model declares the text and image inputs documented by its vendor', () => {
  for (const model of PACKYCODE_MODELS) {
    assert.deepEqual([...model.input], ['text', 'image'], model.id)
  }
})

test('pins each model to the protocol and base URL the gateway serves', () => {
  // OpenAI traffic carries /v1 and never an endpoint path; the SDK appends it.
  assert.equal(byId('deepseek-flash').api, 'openai-completions')
  assert.equal(byId('deepseek-flash').baseUrl, `${DEFAULT_API_HOST}/v1`)
  assert.equal(byId('gpt-6.1-sol').api, 'openai-responses')
  assert.equal(byId('gpt-6.1-sol').baseUrl, `${DEFAULT_API_HOST}/v1`)
  // GPT-6 Astra rides the same Responses route as Sol (the Codex group's protocol).
  assert.equal(byId('gpt-6-astra').api, 'openai-responses')
  assert.equal(byId('gpt-6-astra').baseUrl, `${DEFAULT_API_HOST}/v1`)
  assert.deepEqual([...byId('gpt-6-astra').input], ['text', 'image'])
  assert.equal(byId('gpt-6-astra').contextWindow, 1_050_000)
  // platform.claude.com: every Claude 5.5 model, Haiku included, has a 1M context and 128K output.
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    assert.equal(byId(id).contextWindow, 1_000_000, id)
    assert.equal(byId(id).maxTokens, 128_000, id)
  }
  assert.equal(byId('gpt-6-astra').maxTokens, 128_000)
  assert.equal(byId('grok-4.7').name, 'Grok 4.7')
  assert.equal(byId('grok-4.7').api, 'openai-responses')
  assert.equal(byId('grok-4.7').baseUrl, `${DEFAULT_API_HOST}/v1`)
  assert.deepEqual([...byId('grok-4.7').input], ['text', 'image'])
  assert.equal(byId('grok-4.7').contextWindow, 500_000)
  assert.equal(byId('grok-4.7').maxTokens, 500_000)
  assert.equal(byId('grok-4.7').compat.supportsLongCacheRetention, false)
  assert.equal(byId('gemini-4-argon').name, 'Gemini 4 Argon')
  assert.equal(byId('gemini-4-argon').api, 'google-generative-ai')
  assert.equal(byId('gemini-4-argon').baseUrl, `${DEFAULT_API_HOST}/v1beta`)
  assert.equal(byId('gemini-4-argon').contextWindow, 1_048_576)
  assert.equal(byId('gemini-4-argon').maxTokens, 65_536)
  assert.equal(byId('gemini-3.8-flash').name, 'Gemini 3.8 Flash')
  assert.equal(byId('gemini-3.8-flash').api, 'google-generative-ai')
  assert.equal(byId('gemini-3.8-flash').baseUrl, `${DEFAULT_API_HOST}/v1beta`)
  assert.equal(byId('gemini-3.8-flash').contextWindow, 1_048_576)
  assert.equal(byId('gemini-3.8-flash').maxTokens, 65_536)
  // Anthropic traffic carries no /v1: the Anthropic client appends /v1/messages.
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    assert.equal(byId(id).api, 'anthropic-messages')
    assert.equal(byId(id).baseUrl, DEFAULT_API_HOST)
  }
})

test("offers each vendor's documented effort levels", () => {
  assert.deepEqual(getSupportedThinkingLevels(byId('deepseek-flash')), ['off', 'low', 'high', 'max'])
  assert.deepEqual(getSupportedThinkingLevels(byId('gpt-6.1-sol')), ['low', 'medium', 'high', 'xhigh', 'max'])
  // developers.openai.com: GPT-6 Astra `reasoning.effort` is low | medium | high | xhigh | max.
  assert.deepEqual(getSupportedThinkingLevels(byId('gpt-6-astra')), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(getSupportedThinkingLevels(byId('grok-4.7')), ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(getSupportedThinkingLevels(byId('gemini-4-argon')), ['low', 'medium', 'high'])
  assert.deepEqual(getSupportedThinkingLevels(byId('gemini-3.8-flash')), ['low', 'medium', 'high'])
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    assert.deepEqual(getSupportedThinkingLevels(byId(id)), ['low', 'medium', 'high', 'xhigh', 'max'])
  }
})

test('every model accepts the route default effort', () => {
  for (const model of PACKYCODE_MODELS) {
    assert.ok(
      getSupportedThinkingLevels(model).includes(DEFAULT_REASONING_LEVEL),
      `${model.id} must support ${DEFAULT_REASONING_LEVEL}`,
    )
  }
})

test('declares the wire dialect each protocol needs', () => {
  assert.equal(byId('deepseek-flash').compat.thinkingFormat, 'deepseek')
  assert.equal(byId('deepseek-flash').compat.maxTokensField, 'max_tokens')
  assert.equal(byId('deepseek-flash').compat.requiresReasoningContentOnAssistantMessages, true)
  // Claude 5.x always thinks adaptively and rejects temperature.
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    assert.equal(byId(id).compat.forceAdaptiveThinking, true)
    assert.equal(byId(id).compat.supportsTemperature, false)
  }
  assert.equal(byId('gpt-6.1-sol').compat, undefined)
  assert.equal(byId('gpt-6-astra').compat, undefined)
})
