/** Display data for the native task tools Claude Code actually ran. */
export const CLAUDE_TASKS = 'packycode-claude-tasks'
const taskStatus = value => ['pending', 'in_progress', 'completed'].includes(value)

/** Only task identity, title and state enter the DSH view. */
export function nativeTaskChange(name, input, output, text, listId, safe) {
  if (output?.success === false) return undefined
  if (name === 'TodoWrite' || name === 'TaskList') {
    const todos = name === 'TodoWrite'
    const rows = todos ? input?.todos : output?.tasks
    if (!Array.isArray(rows)) return undefined
    const tasks = []
    for (const [index, row] of rows.entries()) {
      const id = todos ? String(index + 1) : row?.id
      const subject = todos ? row?.content : row?.subject
      if (typeof id !== 'string' || !id || typeof subject !== 'string' || !taskStatus(row?.status)) return undefined
      tasks.push({ id: safe(id), subject: safe(subject), status: row.status })
    }
    return { kind: CLAUDE_TASKS, listId: todos ? `${listId}/todos` : listId, replace: true, tasks }
  }
  if (name === 'TaskCreate') {
    const created = /^Task #(\S+) created successfully:\s*(.+)$/su.exec(text)
    const id = output?.task?.id ?? created?.[1]
    const subject = output?.task?.subject ?? created?.[2] ?? input?.subject
    if (typeof id !== 'string' || !id || typeof subject !== 'string' || !subject) return undefined
    return { kind: CLAUDE_TASKS, listId, tasks: [{ id: safe(id), subject: safe(subject), status: 'pending' }] }
  }
  if (name === 'TaskUpdate') {
    const id = input?.taskId
    if (typeof id !== 'string' || !id || (output?.taskId !== undefined && output.taskId !== id)
      || (output?.success !== true && /^Updated task #(\S+)/u.exec(text)?.[1] !== id)) return undefined
    const task = { id: safe(id) }
    if (typeof input.subject === 'string' && input.subject) task.subject = safe(input.subject)
    if (taskStatus(input.status) || input.status === 'deleted') task.status = input.status
    if (!task.subject && !task.status) return undefined
    return { kind: CLAUDE_TASKS, listId, tasks: [task] }
  }
  return undefined
}

function applyTaskChange(tasks, meta) {
  if (meta.replace) return meta.tasks
  const byId = new Map(tasks.map(task => [task.id, task]))
  for (const task of meta.tasks) {
    if (task.status === 'deleted') byId.delete(task.id)
    else byId.set(task.id, { ...byId.get(task.id), ...task })
  }
  return [...byId.values()]
}

export const claudeTaskNode = {
  kind: CLAUDE_TASKS,
  target: 'chat',
  match(event) {
    const meta = event?.data?.meta
    if (event?.type !== 'tool/result' || meta?.kind !== CLAUDE_TASKS || event.data.message?.source?.kind !== 'tool' || event.data.message.isError
      || typeof meta.listId !== 'string' || !Array.isArray(meta.tasks)
      || !meta.tasks.every(task => typeof task?.id === 'string' && (task.subject === undefined || typeof task.subject === 'string')
        && (task.status === undefined || task.status === 'deleted' || taskStatus(task.status)))) return null
    return { id: meta.listId, role: 'start' }
  },
  start: (_context, match) => applyTaskChange([], match.event.data.meta),
  update: (context, match) => applyTaskChange(context.state, match.event.data.meta),
  buildViewNode(context) {
    if (!context.state) return null
    return { kind: CLAUDE_TASKS, key: context.key, id: context.id, target: 'chat',
      location: { kind: 'session' }, visibility: context.state.length ? 'visible' : 'hidden', anchorSeq: context.matches.at(-1).event.seq + 0.025,
      data: { tasks: context.state } }
  },
}
