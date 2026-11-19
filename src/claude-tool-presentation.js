/** Shared labels and call previews for DSH host and web tool cards. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const short = (value, limit = 300) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit)

/** Text shared by error messages, native tool cards, and the web tool view. */
export function toolResultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (block?.type === 'text' ? block.text : block?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n')
}

/** The salient part of a Claude Code tool call, for titles and approval prompts. */
export function subjectOf(tool, input) {
  const value = record(input) ? input : {}
  return value.command ?? value.file_path ?? value.notebook_path ?? value.url ?? value.pattern ?? value.query ?? value.description ?? value.path ?? undefined
}

/**
 * What DSH shows while a Claude Code tool call is pending.
 * @param args - the mirror call's `{ tool, input }`.
 * @returns a terminal, diff or generic card.
 */
export function presentClaudeCall(args) {
  const tool = String(args?.tool ?? 'tool')
  const input = record(args?.input) ? args.input : {}
  const path = typeof input.file_path === 'string' ? input.file_path : undefined
  if (tool === 'Bash' && typeof input.command === 'string') {
    return { card: 'terminal', title: input.command, ...(typeof input.description === 'string' ? { description: input.description } : {}) }
  }
  if (tool === 'Edit' && path !== undefined) {
    return { card: 'diff', title: `Edit ${path}`, diffs: [{ path, oldText: String(input.old_string ?? ''), newText: String(input.new_string ?? '') }], locations: [{ path }] }
  }
  if (tool === 'MultiEdit' && path !== undefined && Array.isArray(input.edits)) {
    return { card: 'diff', title: `Edit ${path}`, diffs: input.edits.map(edit => ({ path, oldText: String(edit?.old_string ?? ''), newText: String(edit?.new_string ?? '') })), locations: [{ path }] }
  }
  if (tool === 'Write' && path !== undefined) {
    return { card: 'diff', title: `Write ${path}`, diffs: [{ path, oldText: null, newText: String(input.content ?? '') }], locations: [{ path }] }
  }
  if (tool === 'Read' && path !== undefined) {
    return { card: 'generic', title: `Read ${path}`, kind: 'read', locations: [{ path, ...(Number.isSafeInteger(input.offset) && input.offset > 0 ? { line: input.offset } : {}) }] }
  }
  if (tool === 'Glob' || tool === 'Grep') return { card: 'generic', title: `${tool} ${short(input.pattern)}`, kind: 'search', rawInput: input }
  if (tool === 'WebFetch' || tool === 'WebSearch') return { card: 'generic', title: `${tool} ${short(input.url ?? input.query)}`, kind: 'fetch' }
  if (tool === 'AskUserQuestion') return { card: 'generic', title: short(input.questions?.[0]?.question ?? 'AskUserQuestion'), kind: 'other' }
  if (tool === 'TaskCreate' && input.subject) return { card: 'generic', title: `TaskCreate · ${short(input.subject)}`, kind: 'other', rawInput: input }
  if (tool === 'TaskUpdate' && input.taskId) return { card: 'generic', title: `Task #${short(input.taskId, 40)} · ${short(input.status ?? input.subject ?? 'update')}`, kind: 'other', rawInput: input }
  const subject = subjectOf(tool, input)
  return { card: 'generic', title: subject === undefined ? tool : `${tool} ${short(subject, 120)}`, kind: 'other', rawInput: input }
}
