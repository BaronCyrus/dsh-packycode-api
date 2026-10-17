/**
 * Hand DSH's conversation to the Claude Code CLI.
 *
 * The CLI resumes a conversation from a JSONL transcript (`--resume <file>`)
 * and sends exactly those messages — text, images, signed thinking, tool calls
 * and results — before the new input. DSH's history, already converted to the
 * Anthropic Messages shape by the native route, is written in the CLI's
 * classic transcript format, so the CLI's request carries the same history the
 * HTTP route would have sent. Request-level cache markers are dropped: the CLI
 * places its own.
 *
 * @module dsh-packycode-api/claude-transcript
 */

import { randomUUID } from 'node:crypto'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A copy without `cache_control` anywhere in the block tree. */
export function withoutCacheControl(value) {
  if (Array.isArray(value)) return value.map(withoutCacheControl)
  if (!record(value)) return value
  const copy = {}
  for (const [key, item] of Object.entries(value)) {
    if (key !== 'cache_control') copy[key] = withoutCacheControl(item)
  }
  return copy
}

/** Content as a block array. */
export const contentBlocks = content => (typeof content === 'string'
  ? (content === '' ? [] : [{ type: 'text', text: content }])
  : Array.isArray(content) ? content : [])

/**
 * One message in a canonical shape, for comparing requests: pi-ai sends the
 * newest message as blocks with a cache marker and the same message as a
 * plain string once it is older, and tool results either way.
 */
export function canonicalMessage(message) {
  const canonical = block => (block?.type === 'tool_result' ? { ...block, content: contentBlocks(block.content) } : block)
  return { role: message?.role, content: contentBlocks(withoutCacheControl(message?.content)).map(canonical) }
}

/** Whether a message carries tool results, i.e. continues an open turn. */
export const hasToolResult = message => message?.role === 'user' && contentBlocks(message.content).some(block => block?.type === 'tool_result')

/** The tool_use ids an assistant message asked for, in order. */
export const toolUseIds = message => (message?.role === 'assistant'
  ? contentBlocks(message.content).filter(block => block?.type === 'tool_use').map(block => block.id)
  : [])

/** Merge consecutive messages of the same role; the CLI expects alternation. */
export function alternate(messages) {
  const merged = []
  for (const message of messages) {
    const previous = merged.at(-1)
    if (previous !== undefined && previous.role === message.role) {
      merged[merged.length - 1] = { role: message.role, content: [...contentBlocks(previous.content), ...contentBlocks(message.content)] }
    } else merged.push({ role: message.role, content: contentBlocks(message.content) })
  }
  return merged
}

/**
 * Split a request into what the CLI resumes and what it receives as input.
 *
 * - At a turn boundary, trailing user messages are the new input: they go to
 *   the CLI's stdin as one message, after the resumed history.
 * - Inside a turn (the newest message carries tool results, possibly with a
 *   steering note), everything is resumed and the CLI continues the open turn.
 *   Feeding the note over stdin instead would make the CLI close the turn with
 *   a synthetic reply first.
 * @param messages - the request's Anthropic messages.
 * @returns `{ history, input, continues }`; `input` is a content array or
 *   undefined, `continues` is true for an open turn.
 */
export function splitConversation(messages) {
  const clean = alternate(withoutCacheControl(Array.isArray(messages) ? messages : []))
  const last = clean.at(-1)
  if (last === undefined) return { history: [], input: undefined, continues: false }
  if (last.role !== 'user') throw new Error('Claude Code CLI cannot continue a conversation that ends with an assistant message')
  if (hasToolResult(last)) return { history: clean, input: undefined, continues: true }
  return { history: clean.slice(0, -1), input: last.content, continues: false }
}

/**
 * Serialize history as a CLI transcript.
 * @param history - alternating Anthropic messages, oldest first.
 * @param options - the CLI session id, working directory, model, and the CLI
 *   version string recorded in each entry.
 * @returns JSONL text, one entry per message.
 */
export function buildTranscript(history, { sessionId, cwd, model, version = '0.0.0', now = Date.now } = {}) {
  const start = now() - history.length * 1000
  let parentUuid = null
  const lines = history.map((message, index) => {
    const uuid = randomUUID()
    const content = contentBlocks(message.content)
    const entry = {
      parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId,
      version,
      type: message.role,
      message: message.role === 'assistant'
        ? {
          id: `msg_dsh_${uuid.replaceAll('-', '')}`,
          type: 'message',
          role: 'assistant',
          model,
          content,
          stop_reason: content.some(block => block?.type === 'tool_use') ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        }
        : { role: 'user', content },
      uuid,
      timestamp: new Date(start + index * 1000).toISOString(),
    }
    parentUuid = uuid
    return JSON.stringify(entry)
  })
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}
