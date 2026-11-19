/** Applied Claude Code file hunks as DSH display data, independent of model history. */
import { resolve } from 'node:path'
import { redactSecrets } from './secret-redactor.js'

/** Read only the edit fields of a single, unambiguously matched tool result. */
export function appliedClaudePatch(call, output, cwd, key) {
  const path = call.input?.file_path
  if (!['Write', 'Edit', 'MultiEdit'].includes(call.name) || typeof path !== 'string' || !path
    || typeof output?.filePath !== 'string' || !output.filePath || resolve(cwd ?? '.', output.filePath) !== resolve(cwd ?? '.', path)
    || !Array.isArray(output.structuredPatch)) return undefined
  const safe = value => redactSecrets(value, [key])
  const patch = { path: safe(path), created: output.type === 'create', hunks: [] }
  if (output.structuredPatch.length === 0) {
    if (patch.created && typeof output.content === 'string') {
      patch.hunks.push({ oldStart: 0, newStart: 1, lines: safe(output.content).split('\n').map(line => `+${line}`) })
      return patch
    }
    return typeof output.originalFile === 'string' && output.content === output.originalFile ? patch : undefined
  }
  for (const hunk of output.structuredPatch) {
    if (!Array.isArray(hunk?.lines) || !Number.isSafeInteger(hunk.oldStart) || hunk.oldStart < 0 || !Number.isSafeInteger(hunk.newStart) || hunk.newStart < 0) return undefined
    let before = 0, after = 0
    for (const line of hunk.lines) {
      if (line === '\\ No newline at end of file') continue
      if (typeof line !== 'string' || ![' ', '-', '+'].includes(line[0])) return undefined
      if (line[0] !== '+') before++
      if (line[0] !== '-') after++
    }
    if (before !== hunk.oldLines || after !== hunk.newLines) return undefined
    patch.hunks.push({ oldStart: hunk.oldStart, newStart: hunk.newStart, lines: hunk.lines.map(safe) })
  }
  return patch
}

/** Native DSH cards take before/after snippets, one per applied contextual hunk. */
export function claudePatchDiffs(patch) {
  return patch.hunks.map(({ lines }) => ({
    path: patch.path,
    oldText: patch.created ? null : lines.filter(line => ' -'.includes(line[0])).map(line => line.slice(1)).join('\n'),
    newText: lines.filter(line => ' +'.includes(line[0])).map(line => line.slice(1)).join('\n'),
  }))
}
