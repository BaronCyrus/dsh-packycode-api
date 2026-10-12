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
 * an invalid-API-key problem — the opposite of what happened, and a condition
 * no retry can clear.
 */
const CLIENT_POLICY_WORDING = /only accessible via the official|official claude cli|官方\s*claude\s*cli|请使用标准\s*codex\s*客户端|客户端存在异常|二次分发|API\s*转接/iu

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
  if (classifyClientPolicy(text)) return undefined
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
 * keeps the failure out of the retry policy — no retry can talk a group into
 * serving an API client — and lets the sentence reach the user verbatim, in
 * place of the "API key is invalid" the bare 403 would have produced.
 * @param keyName - the account name the balance reader saw, when known.
 * @returns the replacement sentence.
 */
export function explainClientPolicyFailure() {
  return 'PackyCode 拒绝了这个客户端：所选分组只允许厂商官方客户端调用'
    + '（Claude 分组要求官方 Claude CLI，Codex 分组要求标准 Codex 客户端）。'
    + '这不是 API Key 失效，重试也不会成功。'
    + '请改用允许 API 调用的分组（例如 cc-sale 或 claude-officially），'
    + '或改用 PackyCode 的 gpt-6.1-sol / deepseek-flash。'
    + ' / This group only serves the vendor’s official client; the API key is fine and retrying cannot help.'
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
