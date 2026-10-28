import assert from 'node:assert/strict'
import test from 'node:test'

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'

import { PACKYCODE_MODELS, PACKYCODE_MODEL_IDS } from '../src/catalog.js'
import { DEFAULT_API_HOST, DEFAULT_REASONING_LEVEL, PROVIDER } from '../src/constants.js'

const byId = id => PACKYCODE_MODELS.find(model => model.id === id)

test('ships the configured model ids in picker order', () => {
  assert.deepEqual([...PACKYCODE_MODEL_IDS], ['deepseek-flash', 'deepseek-v4-pro', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-5.6-sol', 'grok-4.7', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
  for (const model of PACKYCODE_MODELS) assert.equal(model.provider, PROVIDER)
})

test('every current model declares the inputs documented by its vendor', () => {
  // api-docs.deepseek.com: DeepSeek V4 Pro does not take images; every other model does.
  for (const model of PACKYCODE_MODELS) {
    assert.deepEqual([...model.input], model.id === 'deepseek-v4-pro' ? ['text'] : ['text', 'image'], model.id)
  }
})

test('pins each model to the protocol and base URL the gateway serves', () => {
  // OpenAI-protocol traffic carries /v1 and never an endpoint path; the SDK appends it.
  // PackyCode serves DeepSeek Flash on Responses as well (`/api/pricing`: `openai-response`).
  assert.equal(byId('deepseek-flash').api, 'openai-responses')
  assert.equal(byId('deepseek-flash').baseUrl, `${DEFAULT_API_HOST}/v1`)
  // The gateway refuses a Responses output limit above 393,216 for DeepSeek Flash.
  assert.ok(byId('deepseek-flash').maxTokens <= 393_216)
  // api-docs.deepseek.com: V4 Pro has Flash's 1M context and 384K output, and
  // the gateway caps it at 393,216 too.
  assert.equal(byId('deepseek-v4-pro').name, 'DeepSeek V4 Pro')
  assert.equal(byId('deepseek-v4-pro').api, 'openai-responses')
  assert.equal(byId('deepseek-v4-pro').baseUrl, `${DEFAULT_API_HOST}/v1`)
  assert.equal(byId('deepseek-v4-pro').contextWindow, 1_000_000)
  assert.equal(byId('deepseek-v4-pro').maxTokens, 384_000)
  // No catalog model uses Chat Completions any more.
  assert.deepEqual(PACKYCODE_MODELS.filter(model => model.api === 'openai-completions').map(model => model.id), [])
  assert.equal(byId('gpt-6.1-sol').api, 'openai-responses')
  assert.equal(byId('gpt-6.1-sol').baseUrl, `${DEFAULT_API_HOST}/v1`)
  // developers.openai.com: GPT-6.1 Terra calls tools only over Responses; text and image input, 1,050,000 context and 128,000 output.
  assert.equal(byId('gpt-6.1-terra').name, 'GPT-6.1 Terra')
  assert.equal(byId('gpt-6.1-terra').api, 'openai-responses')
  assert.equal(byId('gpt-6.1-terra').baseUrl, `${DEFAULT_API_HOST}/v1`)
  assert.equal(byId('gpt-6.1-terra').contextWindow, 1_050_000)
  assert.equal(byId('gpt-6.1-terra').maxTokens, 128_000)
  // GPT-6 Astra rides the same Responses route as Sol (the Codex group's protocol).
  assert.equal(byId('gpt-6-astra').api, 'openai-responses')
  assert.equal(byId('gpt-6-astra').baseUrl, `${DEFAULT_API_HOST}/v1`)
  assert.deepEqual([...byId('gpt-6-astra').input], ['text', 'image'])
  assert.equal(byId('gpt-6-astra').contextWindow, 1_050_000)
  // developers.openai.com: GPT-5.6 Sol serves Responses with text and image input, 1,050,000 context and 128,000 output.
  assert.equal(byId('gpt-5.6-sol').api, 'openai-responses')
  assert.equal(byId('gpt-5.6-sol').baseUrl, `${DEFAULT_API_HOST}/v1`)
  assert.equal(byId('gpt-5.6-sol').contextWindow, 1_050_000)
  assert.equal(byId('gpt-5.6-sol').maxTokens, 128_000)
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
  assert.deepEqual(getSupportedThinkingLevels(byId('deepseek-v4-pro')), ['off', 'low', 'high', 'max'])
  assert.deepEqual(getSupportedThinkingLevels(byId('gpt-6.1-sol')), ['low', 'medium', 'high', 'xhigh', 'max'])
  // developers.openai.com: GPT-6.1 Terra also takes `none`, and through PackyCode it answered without reasoning, so it can be off.
  assert.deepEqual(getSupportedThinkingLevels(byId('gpt-6.1-terra')), ['off', 'low', 'medium', 'high', 'xhigh', 'max'])
  // developers.openai.com: GPT-6 Astra `reasoning.effort` is low | medium | high | xhigh | max.
  assert.deepEqual(getSupportedThinkingLevels(byId('gpt-6-astra')), ['low', 'medium', 'high', 'xhigh', 'max'])
  // GPT-5.6 Sol documents `none` too, but it is not offered: through PackyCode it answered at medium.
  assert.deepEqual(getSupportedThinkingLevels(byId('gpt-5.6-sol')), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(getSupportedThinkingLevels(byId('grok-4.7')), ['low', 'medium', 'high', 'xhigh'])
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
  // DeepSeek over Responses needs no Chat Completions dialect: `off` sends
  // `reasoning.effort: "none"`, and reasoning replays as Responses items.
  for (const id of ['deepseek-flash', 'deepseek-v4-pro']) {
    assert.equal(byId(id).compat, undefined, id)
    assert.equal(byId(id).thinkingLevelMap.off, undefined, id)
  }
  // Claude 5.x always thinks adaptively and rejects temperature.
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    assert.equal(byId(id).compat.forceAdaptiveThinking, true)
    assert.equal(byId(id).compat.supportsTemperature, false)
  }
  // PackyCode's GPT route treats a tool without `strict` as strict, so GPT
  // declares strict support and pi-ai sends `strict: false`; nothing else changes.
  for (const id of ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-5.6-sol']) {
    assert.deepEqual({ ...byId(id).compat }, { supportsStrictMode: true }, id)
  }
  // DeepSeek and Grok leave optional parameters out without it.
  assert.equal(byId('grok-4.7').compat.supportsStrictMode, undefined)
  // Terra's off keeps pi-ai's Responses default, `reasoning.effort: "none"`.
  assert.equal(byId('gpt-6.1-terra').thinkingLevelMap.off, undefined)
})
