/**
 * Which transport a Claude request uses: the plugin's own Messages HTTP client,
 * or the official Claude Code CLI on this device.
 *
 * PackyCode's `cc` group ("claude code专用") serves only the official client,
 * so a key in it sends its Claude requests through the real CLI.
 * `cc-expensive`, `cc-sale` and `claude-officially` keep the native HTTP
 * route. The groups decide: a cc key cannot be sent over HTTP, where the
 * gateway refuses it as a third-party client, and no other key needs the CLI.
 * (`claude-sale` is delisted for now; it joins the CLI list if it returns.)
 *
 * A key whose groups are not read yet goes to the CLI: over HTTP a cc key is
 * always refused, while the official client is served by every Claude group.
 * The HTTP route takes over once the reading shows a group that allows it.
 *
 * On the CLI, Claude Code is the agent and DSH shows its work; on HTTP, DSH's
 * own agent loop runs. No other provider or credential is ever substituted.
 *
 * @module dsh-packycode-api/claude-transport
 */

/** Groups whose Claude requests are sent by the official Claude Code client. */
export const CLI_ONLY_GROUPS = Object.freeze(['cc'])
/** Claude groups whose requests use the plugin's HTTP route. */
export const HTTP_CLAUDE_GROUPS = Object.freeze(['cc-expensive', 'cc-sale', 'claude-officially'])

/** Whether a catalog model is served over the Anthropic Messages protocol. */
export const isClaudeModel = modelId => typeof modelId === 'string' && modelId.startsWith('claude-')

/**
 * Decide the transport for a Claude request.
 * @param options - the request key's groups, as the last group reading saw
 *   them (undefined when there is no reading yet).
 * @returns `{ transport: 'cli' | 'http', reason, groups? }`. `reason` is
 *   `group` (the key's groups decided) or `unknown` (no reading yet: the CLI,
 *   which every Claude group serves).
 */
export function claudeTransportFor({ groups } = {}) {
  if (!Array.isArray(groups)) return { transport: 'cli', reason: 'unknown' }
  const gated = groups.filter(name => CLI_ONLY_GROUPS.includes(name))
  return gated.length > 0
    ? { transport: 'cli', reason: 'group', groups: gated }
    : { transport: 'http', reason: 'group', groups: groups.filter(name => HTTP_CLAUDE_GROUPS.includes(name)) }
}
