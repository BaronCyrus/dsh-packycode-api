import assert from 'node:assert/strict'
import test from 'node:test'

import { isQuotaExceededError } from '@deepseek-ai/dsh-llm'

import {
  INVALID_KEY_FAILURE,
  QUOTA_FAILURE,
  classifyGatewayFailure,
  normalizeFailureMessage,
} from '../src/failures.js'

const AUTH_STATUS = /\b(?:401|403)\b/u

test('recognizes an exhausted key from the gateway wording', () => {
  assert.equal(classifyGatewayFailure('402 {"error":{"message":"当前令牌额度已用完"}}'), QUOTA_FAILURE)
  assert.equal(classifyGatewayFailure('insufficient quota'), QUOTA_FAILURE)
  assert.equal(classifyGatewayFailure('余额不足，请充值'), QUOTA_FAILURE)
})

test('recognizes a rejected key from its status or wording', () => {
  assert.equal(classifyGatewayFailure('401 {"error":{"message":"无效的令牌"}}'), INVALID_KEY_FAILURE)
  assert.equal(classifyGatewayFailure('invalid api key'), INVALID_KEY_FAILURE)
  assert.equal(classifyGatewayFailure('api key is invalid'), INVALID_KEY_FAILURE)
})

test('leaves transient gateway faults to the key it already used', () => {
  const channelFault = '400 {"error":{"code":"model_not_found","message":"当前令牌未覆盖供应商 \\"Anthropic\\"（模型=claude-opus-5-5）"}}'
  assert.equal(classifyGatewayFailure(channelFault), undefined)
  assert.equal(classifyGatewayFailure('503 {"error":{"message":"分组 cc-sale 下模型 claude-opus-5-5 无可用渠道"}}'), undefined)
  assert.equal(classifyGatewayFailure(''), undefined)
  assert.equal(classifyGatewayFailure(undefined), undefined)
})

test('a normalized quota failure lands in the harness quota category', () => {
  const raw = '403 {"error":{"message":"当前令牌额度已用完 (request id: 01M4)"}}'
  const kind = classifyGatewayFailure(raw)
  assert.equal(kind, QUOTA_FAILURE)
  const normalized = normalizeFailureMessage(raw, kind)
  assert.equal(isQuotaExceededError(normalized), true)
  // The gateway's 403 must not send this into the auth category first.
  assert.equal(AUTH_STATUS.test(normalized), false)
  // The gateway's own sentence survives, so the user sees what happened.
  assert.match(normalized, /当前令牌额度已用完/u)
  assert.match(normalized, /trying the next key/u)
})

test('a normalized key rejection lands in the harness auth category', () => {
  const raw = '{"error":{"message":"无效的令牌 (request id: 01M4)"}}'
  const kind = classifyGatewayFailure(raw)
  assert.equal(kind, INVALID_KEY_FAILURE)
  const normalized = normalizeFailureMessage(raw, kind)
  assert.equal(AUTH_STATUS.test(normalized), true)
  assert.equal(isQuotaExceededError(normalized), false)
  assert.match(normalized, /invalid_authentication/u)
})
