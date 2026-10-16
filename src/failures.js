/**
 * Failure classification for the two conditions that move the key ring along.
 *
 * The gateway reports an exhausted key and a rejected key in Chinese, and the
 * harness classifies failures by fixed English/status wording it recognizes
 * (`isQuotaExceededError`, `\b401\b`). Normalizing here is what makes the
 * harness's retry policy re-run the step — and therefore what lets the retry
 * pick up the next key. Rewriting is honest about what happened: this plugin
 * knows the key's condition from the gateway's own words plus its balance
 * reader, so the sentence it substitutes says no more than that.
 *
 * @module dsh-packycode-api/failures
 */

/** Terminal quota, balance, or credit wording, in the gateway's own languages. */
const QUOTA_WORDING = /额度|余额|配额|欠费|insufficient[\s_-]+(?:quota|balance|credits?)|quota[\s_-]+(?:exceeded|exhausted|reached)|out[\s_-]+of[\s_-]+(?:credits?|budget)/iu
/** A rejected key names itself; a bare 403 does not, and must not disable one. */
const INVALID_KEY_WORDING = /无效的令牌|令牌无效|无效密钥|密钥无效|invalid[\s_-]+api[\s_-]*key|invalid_authentication|api key is invalid/iu
const INVALID_KEY_STATUS = /\b401\b/

/**
 * A gateway group that only serves its vendor's official client. These arrive
 * as 403, which the harness reads as an authentication failure and renders as
 * an invalid-API-key problem — the opposite of what happened. This wording
 * also covers intermittent client-anomaly refusals; it does not establish
 * whether a future request will be accepted.
 */
const CLIENT_POLICY_WORDING = /only accessible via the official|only accepts requests from the official|official\s+claude(?:\s+code)?\s+cli|官方\s*claude(?:\s*code)?\s*cli|请使用标准\s*codex\s*客户端|客户端存在异常|二次分发|API\s*转接/iu

/** A content-policy refusal observed on an already-authorized request. */
export const TEST_MESSAGE_POLICY_CODE = 'GATEWAY_TEST_MESSAGE'
const TEST_MESSAGE_PREFIX = `[${TEST_MESSAGE_POLICY_CODE}]`

/** Match the captured refusal narrowly; a bare 403 is still not evidence. */
export function classifyTestMessagePolicy(message) {
  if (typeof message !== 'string') return false
  return message.startsWith(TEST_MESSAGE_PREFIX)
    || (/already connected and authorized/iu.test(message)
      && /no need to send test messages/iu.test(message)
      && /verify the connection/iu.test(message))
}

/** Keep the host's status-word classifier from turning this into AUTH. */
export function explainTestMessagePolicyFailure() {
  return `${TEST_MESSAGE_PREFIX} PackyCode 将这次请求识别为连通性测试并拒绝。请使用实际业务内容；本次拒绝不表示 Key 失效，也不会禁用或切换 Key。`
}

/**
 * The gateway's answer when a key's groups do not include the model's
 * supplier: `model_not_found` / 当前令牌未覆盖供应商. The key is fine for other
 * models, so it is never moved aside for this.
 */
const COVERAGE_WORDING = /model_not_found|未覆盖供应商|无可用渠道|no available channel/iu

/**
 * Whether the gateway refused the model for this key's groups.
 * @param message - the failure text.
 * @returns true for a group-coverage refusal.
 */
export function classifyCoverage(message) {
  return COVERAGE_WORDING.test(typeof message === 'string' ? message : '')
}

/** The key's quota is exhausted; move to the next key. */
export const QUOTA_FAILURE = 'quota'
/** The gateway rejected the key itself; move to the next key. */
export const INVALID_KEY_FAILURE = 'invalid-key'
/** The gateway refuses this client for the route; the key is not at fault. */
export const CLIENT_POLICY_FAILURE = 'client-policy'

/**
 * Whether the gateway is refusing this client rather than this credential.
 * @param message - provider failure text, as pi-ai carries it.
 * @returns true when the route is gated to a vendor's official client.
 */
export function classifyClientPolicy(message) {
  return CLIENT_POLICY_WORDING.test(typeof message === 'string' ? message : '')
}

/**
 * OpenAI's generic transient failure: the sentence its `server_error` carries,
 * or the `server_error:` prefix pi-ai writes when the event names the code.
 * The gateway can relay it inside a stream it has already answered 200 for —
 * an SSE `error` event with a 503 `server_error`, then `response.failed` — so
 * no HTTP status comes with it.
 */
const UPSTREAM_SERVER_ERROR = /an error occurred while processing your request\b[\s\S]*\bhelp\.openai\.com\b|^(?:error code\s+)?server_error:/iu

/**
 * Whether a failure is the upstream's transient server error, which a resent
 * request clears. The key is not at fault.
 * @param message - provider failure text, as pi-ai carries it.
 * @returns true for OpenAI's generic `server_error`.
 */
export function classifyUpstreamServerError(message) {
  return UPSTREAM_SERVER_ERROR.test(typeof message === 'string' ? message : '')
}

/**
 * Classify a gateway failure message.
 *
 * Quota wording wins over a status token: an exhausted balance is often
 * reported as 402/403, and only the key's own rejection may read as 401. A
 * client-policy refusal is not a key fault and is classified separately.
 * @param message - provider failure text, as pi-ai carries it.
 * @returns the failure kind, or undefined when the key is not at fault.
 */
export function classifyGatewayFailure(message) {
  const text = typeof message === 'string' ? message : ''
  if (text === '') return undefined
  if (classifyClientPolicy(text) || classifyTestMessagePolicy(text)) return undefined
  if (QUOTA_WORDING.test(text)) return QUOTA_FAILURE
  if (INVALID_KEY_WORDING.test(text)) return INVALID_KEY_FAILURE
  if (INVALID_KEY_STATUS.test(text)) return INVALID_KEY_FAILURE
  return undefined
}

/**
 * Rewrite a failure message so the harness classifies it as quota or auth.
 *
 * A bare status token is neutralized first: an exhausted balance arrives as
 * 402 or 403 on some gateway routes, and the harness's auth rule matches
 * 401/403 before it reads any wording, which would send the failure into a
 * category the retry policy does not re-run.
 * @param message - the original provider failure text.
 * @param kind - the classification of {@link classifyGatewayFailure}.
 * @returns text the harness routes to QUOTA or AUTH.
 */
/**
 * Explain a client-policy refusal so the user reads the real cause.
 *
 * The sentence must not read as any other failure the harness knows: it
 * deliberately carries no HTTP status and none of the words the classifier
 * matches for auth, quota, rate limits, timeouts, or transport faults. That
 * keeps the failure out of the host's generic retry policy and lets the
 * sentence reach the user verbatim, in
 * place of the "API key is invalid" the bare 403 would have produced.
 * @param keyName - the account name the balance reader saw, when known.
 * @returns the replacement sentence.
 */
export function explainClientPolicyFailure() {
  return 'PackyCode 拒绝了这个客户端：所选分组只允许厂商官方客户端调用'
    + '（Claude 分组要求官方 Claude CLI，Codex 分组要求标准 Codex 客户端）。'
    + '这不是 API Key 失效。'
    + '请检查当前分组的客户端要求；若调整分组，应先在模型广场确认该模型可用。'
    + ' / This group only serves the vendor’s official client; the API key is fine.'
}

/**
 * Rewrite a failure message so the harness classifies it as quota or auth.
 *
 * A bare status token is neutralized first: an exhausted balance arrives as
 * 402 or 403 on some gateway routes, and the harness's auth rule matches
 * 401/403 before it reads any wording, which would send the failure into a
 * category the retry policy does not re-run.
 * @param message - the original provider failure text.
 * @param kind - the classification of {@link classifyGatewayFailure}.
 * @param options - optional account name for the policy explanation.
 * @returns text the harness routes to QUOTA or AUTH, or a policy explanation.
 */
export function normalizeFailureMessage(message, kind, options = {}) {
  const text = typeof message === 'string' && message.length > 0 ? message : 'PackyCode request failed'
  if (kind === CLIENT_POLICY_FAILURE) return explainClientPolicyFailure(options.keyName)
  if (kind === QUOTA_FAILURE) {
    return `${neutralizeAuthStatus(text)} — PackyCode: insufficient quota for this API key; trying the next key`
  }
  if (kind === INVALID_KEY_FAILURE) {
    return `${neutralizeAuthStatus(text)} — PackyCode: 401 invalid_authentication for this API key; trying the next key`
  }
  return text
}

function neutralizeAuthStatus(text) {
  return text.replace(/\b(?:401|403)\b/gu, 'HTTP')
}
