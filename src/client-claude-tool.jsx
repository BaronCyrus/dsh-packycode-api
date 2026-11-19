/** Web presentation of the agent-scoped claude_code mirror. */
import * as react from 'react'
import { presentClaudeCall, toolResultText } from './claude-tool-presentation.js'
import { fill } from './client-balance.jsx'

const TASK_STATUS = { pending: 'cliTaskPending', in_progress: 'cliTaskRunning', completed: 'cliTaskDone', deleted: 'cliTaskDeleted' }

export function ClaudeTaskList({ node, t }) {
  const tasks = node.data.tasks
  const done = tasks.filter(task => task.status === 'completed').length
  return <details className="pkc-task-list">
    <summary>{fill(t('cliTaskList'), { done, total: tasks.length })}</summary>
    <ul>{tasks.map(task => <li key={task.id}><span className="pkc-meta">#{task.id}</span>{task.subject && ` ${task.subject}`}
      {TASK_STATUS[task.status] && <span className="pkc-meta">{` · ${t(TASK_STATUS[task.status])}`}</span>}</li>)}</ul>
  </details>
}

function AppliedPatch({ patch, t }) {
  if (patch.hunks.length === 0) return <p>{t('cliFileUnchanged')}</p>
  return <div className="pkc-patch" aria-label={t('cliAppliedDiff')}>
    {patch.hunks.map((hunk, index) => <pre key={index}>
      <span className="pkc-patch-range">{`@@ -${hunk.oldStart} +${hunk.newStart} @@\n`}</span>
      {hunk.lines.map((line, i) => <span key={i} data-change={line[0]}>{line}{'\n'}</span>)}
    </pre>)}
  </div>
}

function CallPreview({ diffs, t }) {
  return <div className="pkc-patch"><b>{t('cliCallPreview')}</b>
    {diffs.map((diff, index) => <pre key={index}>
      {typeof diff.oldText === 'string' && <span data-change="-">{diff.oldText.split('\n').map(line => `-${line}\n`).join('')}</span>}
      <span data-change="+">{diff.newText.split('\n').map(line => `+${line}\n`).join('')}</span>
    </pre>)}
  </div>
}

function useLocalDisclosure() {
  const [expanded, setExpanded] = react.useState(false)
  return { expanded, toggle: () => setExpanded(value => !value) }
}

export function ClaudeToolCard({ block, phase, inspect, openFile, useDisclosure = useLocalDisclosure, t }) {
  const { expanded, toggle } = useDisclosure()
  const settled = phase === 'result' || block?.kind === 'tool-result'
  const raw = (settled ? block?.call : block)?.argsRaw
  const args = react.useMemo(() => {
    try { return JSON.parse(raw) } catch { return undefined }
  }, [raw])
  const call = presentClaudeCall(args)
  const taskStatus = args?.tool === 'TaskUpdate' && Object.hasOwn(TASK_STATUS, args.input?.status) ? TASK_STATUS[args.input.status] : undefined
  const title = taskStatus && args.input.taskId ? fill(t('cliTaskUpdate'), { id: args.input.taskId, status: t(taskStatus) }) : call.title
  const failed = settled && block.isError
  const patch = !failed && block?.meta?.kind === 'claude-file-diff' ? block.meta.patch : undefined
  const state = failed ? (block.error?.code === 'interrupted' ? 'cliToolStopped' : 'cliToolFailed')
    : settled ? 'cliToolDone' : phase === 'preparing' ? 'cliToolPreparing' : 'cliToolRunning'
  const location = call.locations?.[0]
  const output = settled && (expanded || failed) ? toolResultText(block.content) : ''
  return <div className="pkc-mirror">
    <button className="pkc-mirror-toggle" type="button" aria-expanded={expanded} onClick={toggle}>
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <span className="pkc-mirror-title">{args?.tool ? title : 'Claude Code'}</span>
      <span className="pkc-meta">{t(state)}</span>
    </button>
    {failed && !expanded && <div className="pkc-error">{output.split('\n')[0].slice(0, 160)}</div>}
    {expanded && <div className="pkc-mirror-body">
      {Array.isArray(patch?.hunks) ? <AppliedPatch patch={patch} t={t} />
        : call.card === 'diff' && !failed ? <CallPreview diffs={call.diffs} t={t} />
          : raw && <pre>{call.card === 'terminal' ? call.title : JSON.stringify(args?.input ?? args, null, 2) ?? raw}</pre>}
      {output && <pre>{output}</pre>}
      <div className="pkc-actions">
        {location && openFile && <button type="button" className="pkc-btn" onClick={() => openFile(location.path, location.line ? { line: location.line } : undefined)}>{t('cliOpenFile')}</button>}
        {inspect && <button type="button" className="pkc-btn" onClick={inspect}>{t('cliInspectCall')}</button>}
      </div>
    </div>}
  </div>
}
