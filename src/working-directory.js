import { posix, win32 } from 'node:path'

/**
 * Quote the legacy DSH cwd sentence only when it matches trusted session
 * metadata. Never infer a path by trimming punctuation from model text,
 * arguments or history, and never use this process's working directory.
 */
export function clarifyWorkingDirectory(options, resolveWorkingDirectory) {
  if (!options.model?.startsWith('claude-') || options.purpose === 'session-title'
    || typeof options.system !== 'string' || !options.system.includes('Your working directory is ')
    || typeof resolveWorkingDirectory !== 'function') return options

  let cwd
  try { cwd = resolveWorkingDirectory(options.sessionId) } catch { return options }
  if (typeof cwd !== 'string' || cwd.includes('\0') || !(posix.isAbsolute(cwd) || win32.isAbsolute(cwd))) return options

  const legacy = `Your working directory is ${cwd}.`
  const names = new Set(Array.isArray(options.tools) ? options.tools.map(tool => tool.name) : [])
  const replacement = [
    'Current working directory (exact JSON string):',
    JSON.stringify(cwd),
    'Use the decoded path verbatim, including any final dot inside the string. The quotes and JSON escapes are notation, not extra path characters.',
    'This DSH session directory is authoritative over generic CLI context, examples and remembered workspace paths. Never invent a different project root.',
    'For the current directory or current project, use relative paths and omit workdir. To target another directory, use the offered tool\'s workdir argument. Do not prepend cd just to enter the session directory.',
    ...(names.has('pwsh') && !names.has('bash') ? ['The offered shell uses PowerShell syntax.'] : []),
  ].join('\n')

  // Match an entire host sentence, either on its own line or after the
  // persona sentence used by older DSH profiles. Literal splitting preserves
  // backslashes, dollar signs, newlines and legitimate trailing dots.
  const pieces = options.system.split(legacy)
  let system = pieces[0], changed = false
  for (let index = 1; index < pieces.length; index++) {
    const before = pieces[index - 1], after = pieces[index]
    const boundary = (before === '' || before.endsWith('\n') || before.endsWith('. '))
      && (after === '' || after.startsWith('\n') || after.startsWith('\r\n'))
    system += (boundary ? replacement : legacy) + after
    changed ||= boundary
  }
  if (!changed) return options
  const tools = Array.isArray(options.tools) ? options.tools.map(tool => {
    const field = tool.parameters?.properties?.workdir
    if (!['bash', 'pwsh'].includes(tool.name) || field?.type !== 'string') return tool
    return { ...tool, parameters: { ...tool.parameters, properties: { ...tool.parameters.properties, workdir: {
      ...field,
      description: [field.description, 'Current session default (exact JSON string):', JSON.stringify(cwd),
        'Omit workdir and use relative paths for the current project; never substitute a remembered CLI workspace.'].filter(Boolean).join('\n'),
    } } } }
  }) : undefined
  return { ...options, system, ...(tools === undefined ? {} : { tools }) }
}
