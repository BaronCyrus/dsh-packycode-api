/**
 * Which of DSH's messages Claude Code receives on the cc route.
 *
 * There Claude Code is the agent, with its own system prompt, environment,
 * tools, project instructions and plan mode. DSH still adds model-visible
 * messages of its own to a turn, written for its native agent: the runtime
 * and time context, its skill catalog, the project's AGENTS.md, and notices
 * about approval, plan mode, the model and its tools. They describe DSH's
 * agent rather than the user's request, Claude Code has its own version of
 * each, and PackyCode's cc group refuses requests that carry DSH's agent
 * content. So only what the user meant for the agent is passed on.
 *
 * @module dsh-packycode-api/claude-user-text
 */

/**
 * DSH message sources whose text the user meant for the agent: their own
 * words, a scheduled prompt they wrote, a session they referenced, and a
 * message another agent sent this one.
 */
export const FORWARDED_SOURCES = Object.freeze(['user', 'schedule', 'session-reference', 'agent-message'])

/**
 * The user texts of a request Claude Code receives.
 * @param messages - the DSH messages of the request, with their sources.
 * @returns `(text) => boolean`: whether a user text block is passed on.
 */
export function forwardedUserText(messages) {
  const texts = new Set()
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'user' || !FORWARDED_SOURCES.includes(message.source?.kind)) continue
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.add(block.text)
    }
  }
  return text => texts.has(text)
}
