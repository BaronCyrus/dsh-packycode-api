import assert from 'node:assert/strict'
import test from 'node:test'

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'

import { PACKYCODE_MODELS, PACKYCODE_MODEL_IDS } from '../src/catalog.js'
import { DEFAULT_API_HOST, DEFAULT_REASONING_LEVEL, PROVIDER } from '../src/constants.js'

const byId = id => PACKYCODE_MODELS.find(model => model.id === id)

test('ships exactly the models verified against the gateway', () => {
  assert.deepEqual([...PACKYCODE_MODEL_IDS], ['deepseek-flash', 'gpt-6.1-sol', 'gpt-6-astra', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
  for (const model of PACKYCODE_MODELS) assert.equal(model.provider, PROVIDER)
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
  assert.equal(byId('gpt-6-astra').maxTokens, 128_000)
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
