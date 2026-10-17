/**
 * Which transport a Claude request uses: the plugin's own Messages HTTP client,
 * or the official Claude Code CLI on this device.
 *
 * PackyCode's `cc` group ("claude code专用") serves only the official client,
 * so a key in it sends its Claude requests through the real CLI.
 * `cc-expensive`, `cc-sale` and `claude-officially` keep the native HTTP
 * route. The user can pin either transport in the settings panel.
 * (`claude-sale` is delisted for now; it joins the CLI list if it returns.)
 *
 * Only the transport changes: DSH's agent loop, tools, permissions, plan mode,
 * attachments and history are identical on both, and no other provider or
 * credential is ever substituted.
 *
 * @module dsh-packycode-api/claude-transport
 */

/** Groups whose Claude requests are sent by the official Claude Code client. */
export const CLI_ONLY_GROUPS = Object.freeze(['cc'])
/** Claude groups whose requests use the plugin's HTTP route. */
export const HTTP_CLAUDE_GROUPS = Object.freeze(['cc-expensive', 'cc-sale', 'claude-officially'])

/** `auto` follows the key's groups; `cli` and `http` pin one transport. */
export const CLAUDE_TRANSPORTS = Object.freeze(['auto', 'cli', 'http'])
export const DEFAULT_CLAUDE_TRANSPORT = 'auto'

/** Whether a catalog model is served over the Anthropic Messages protocol. */
export const isClaudeModel = modelId => typeof modelId === 'string' && modelId.startsWith('claude-')

/** Read the stored preference; anything unknown is the default. */
export function readClaudeTransport(value) {
  return CLAUDE_TRANSPORTS.includes(value) ? value : DEFAULT_CLAUDE_TRANSPORT
}

/**
 * Decide the transport for a Claude request.
 * @param options - the stored preference and the request key's groups, as the
 *   last group reading saw them (undefined when there is no reading yet).
 * @returns `{ transport: 'cli' | 'http', reason, groups? }`. `reason` is
 *   `preference`, `group` (the key's groups decided), or `unknown` (no reading
 *   yet; the native HTTP route stands, as it did before this choice existed).
 */
export function claudeTransportFor({ preference, groups } = {}) {
  const pinned = readClaudeTransport(preference)
  if (pinned !== 'auto') return { transport: pinned, reason: 'preference' }
  if (!Array.isArray(groups)) return { transport: 'http', reason: 'unknown' }
  const gated = groups.filter(name => CLI_ONLY_GROUPS.includes(name))
  return gated.length > 0
    ? { transport: 'cli', reason: 'group', groups: gated }
    : { transport: 'http', reason: 'group', groups: groups.filter(name => HTTP_CLAUDE_GROUPS.includes(name)) }
}
