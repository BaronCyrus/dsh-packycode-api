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

import { CLAUDE_MIN_VERSION } from './claude-binary.js'

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

/** Prefix of every failure the Claude Code CLI transport relays from the gateway. */
export const CLI_MARK = '[Claude Code CLI]'
/** The CLI could not be found or started; the transport's error type says so. */
export const CLI_UNAVAILABLE = 'dsh_cli_unavailable'
/** The installed CLI refused an option the transport needs. */
export const CLI_OUTDATED = 'dsh_cli_outdated'

/**
 * The message a relayed failure carried. pi-ai reports an HTTP error as its
 * status followed by the JSON body; the gateway's or CLI's own sentence is
 * that body's `error.message`.
 */
function relayedMessage(message) {
  const text = typeof message === 'string' ? message : ''
  const start = text.indexOf('{')
  if (start >= 0) {
    try {
      const body = JSON.parse(text.slice(start))
      const inner = body?.error?.message ?? body?.message
      if (typeof inner === 'string') return inner
    } catch { /* not a JSON body */ }
  }
  return text
}

/** Whether a failure says the Claude Code CLI is missing. */
export const classifyCliUnavailable = message => typeof message === 'string' && message.includes(CLI_UNAVAILABLE)
/** Whether a failure says the Claude Code CLI is too old for this plugin. */
export const classifyCliOutdated = message => typeof message === 'string' && message.includes(CLI_OUTDATED)

/**
 * Explain a missing CLI. Like every explanation here it carries no status
 * token and no transport wording, so DSH shows it once instead of retrying a
 * request that cannot start.
 * @returns the replacement sentence.
 */
export function explainCliUnavailable(message) {
  // Local start-up detail, without anything the host would read as a status or transport fault.
  const detail = relayedMessage(message).replace(/^[\s\S]*?dsh_cli_unavailable:?\s*/u, '').replace(/\b\d{3}\b/gu, '')
    .replace(/\b(?:network|connection|socket|fetch|timed?\s*out|timeout|terminated)\b/giu, '…').trim().slice(0, 300)
  return '本机没有可用的 Claude Code CLI，而当前 Key 所在的 Claude 分组（cc）只接受官方 Claude Code 客户端。'
    + '请在 设置 → PackyCode → Claude Code CLI 一键安装，或在终端执行 npm install -g @anthropic-ai/claude-code --allow-scripts=@anthropic-ai/claude-code，然后重发这条消息。'
    + '也可以改用 cc-sale / cc-expensive 分组的 Key，它们走插件内置的 HTTP 通道。'
    + (detail === '' || detail === 'dsh_cli_unavailable' ? '' : `（启动失败：${detail}）`)
    + ' / Claude Code CLI is not available, and this key\'s Claude group only serves the official client. Install it under Settings → PackyCode (npm install -g @anthropic-ai/claude-code --allow-scripts=@anthropic-ai/claude-code), then resend.'
}

/**
 * Explain a CLI that is too old for the options this plugin passes.
 * @param message - the CLI's own complaint.
 * @returns the replacement sentence.
 */
export function explainCliOutdated(message) {
  // Bare status-like numbers go; the versions in a dotted x.y.z stay readable.
  const detail = relayedMessage(message).replace(/^[\s\S]*?dsh_cli_outdated:?\s*/u, '').replace(/(?<![\d.])\d{3}(?!\d|\.\d)/gu, '').slice(0, 300)
  return `本机的 Claude Code CLI 版本过旧，插件需要 ${CLAUDE_MIN_VERSION} 或更新版本。`
    + '请在 设置 → PackyCode → Claude Code CLI 点「更新 Claude Code CLI」，或在终端执行 claude update，然后重发这条消息。'
    + ` / The installed Claude Code CLI is too old for this plugin (needs ${CLAUDE_MIN_VERSION} or later). Update it under Settings → PackyCode, or run claude update, then resend. CLI said: ${detail}`
}

/**
 * Explain a client-policy refusal of a request the official CLI itself sent.
 * The HTTP route's advice (use the official client) does not apply; the
 * gateway's words are kept, without their status, for a support request.
 * @param message - the relayed failure text.
 * @returns the replacement sentence.
 */
export function explainCliClientPolicyFailure(message) {
  const detail = relayedMessage(message)
    .replace(/^[\s\S]*?\[Claude Code CLI\]\s*/u, '')
    .replace(/\b(?:401|403)\b/gu, 'HTTP')
    .slice(0, 600)
  return 'PackyCode 拒绝了这次由官方 Claude Code CLI 发出的请求，认为客户端异常。这不是 API Key 失效。'
    + '请先把 Claude Code CLI 更新到最新版本（claude update）再试；仍然失败时，请把下面的原始错误（含 request id）发给 PackyCode 客服。'
    + ` / The gateway refused a request the official Claude Code CLI sent; the API key is fine. Gateway said: ${detail}`
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
