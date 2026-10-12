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

/** The key's quota is exhausted; move to the next key. */
export const QUOTA_FAILURE = 'quota'
/** The gateway rejected the key itself; move to the next key. */
export const INVALID_KEY_FAILURE = 'invalid-key'

/**
 * Classify a gateway failure message.
 *
 * Quota wording wins over a status token: an exhausted balance is often
 * reported as 402/403, and only the key's own rejection may read as 401.
 * @param message - provider failure text, as pi-ai carries it.
 * @returns the failure kind, or undefined when the key is not at fault.
 */
export function classifyGatewayFailure(message) {
  const text = typeof message === 'string' ? message : ''
  if (text === '') return undefined
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
export function normalizeFailureMessage(message, kind) {
  const text = typeof message === 'string' && message.length > 0 ? message : 'PackyCode request failed'
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
