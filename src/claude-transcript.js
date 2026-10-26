/**
 * Start a Claude Code session from DSH's conversation.
 *
 * When a cc session's history is not one the CLI holds — it began on another
 * model, a message was edited, the session was forked — the transport writes
 * DSH's history into the CLI's session store in its classic transcript format
 * and resumes it, so Claude Code continues with the same conversation: text,
 * images, signed thinking, and its own tool calls and results. Request-level
 * cache markers are dropped: the CLI places its own.
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

/** The DSH tool every Claude Code tool call is shown as, and DSH's plan review. */
const MIRROR_TOOL = 'claude_code'
const PLAN_TOOL = 'exit_plan_mode'
const FLAT_LIMIT = 8000

/**
 * DSH's history as Claude Code's own history: each `claude_code` call becomes
 * the Claude Code tool call it mirrored, a plan review becomes ExitPlanMode,
 * and calls of DSH's own tools (from before the session reached Claude Code,
 * or from another model) become plain text, with their results, because
 * Claude Code has no such tools.
 * @param messages - Anthropic messages, oldest first.
 * @returns messages Claude Code can resume.
 */
export function toCliHistory(messages) {
  const flattened = new Set()
  const flatText = (label, value) => ({ type: 'text', text: `[${label}] ${(typeof value === 'string' ? value : JSON.stringify(value)).slice(0, FLAT_LIMIT)}` })
  const convert = message => {
    const blocks = contentBlocks(message?.content)
    if (message?.role === 'assistant') {
      return {
        role: 'assistant',
        content: blocks.map(block => {
          if (block?.type !== 'tool_use') return block
          if (block.name === MIRROR_TOOL && typeof block.input?.tool === 'string') return { type: 'tool_use', id: block.id, name: block.input.tool, input: record(block.input.input) ? block.input.input : {} }
          if (block.name === PLAN_TOOL) return { type: 'tool_use', id: block.id, name: 'ExitPlanMode', input: {} }
          flattened.add(block.id)
          return flatText(`DSH 工具调用 ${block.name}`, block.input ?? {})
        }),
      }
    }
    return {
      role: 'user',
      content: blocks.map(block => {
        if (block?.type !== 'tool_result' || !flattened.has(block.tool_use_id)) return block
        const content = typeof block.content === 'string' ? block.content : contentBlocks(block.content).map(part => (part?.type === 'text' ? part.text : `[${part?.type}]`)).join('\n')
        return flatText(block.is_error === true ? 'DSH 工具出错' : 'DSH 工具结果', content)
      }),
    }
  }
  return alternate(withoutCacheControl(Array.isArray(messages) ? messages : []).map(convert))
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
