#!/usr/bin/env node
/**
 * A stand-in for the Claude Code CLI as the agent, as the plugin drives it:
 * stream-json input and output with partial events, permission prompts over
 * stdio (`can_use_tool`), permission modes and their live switch, interrupts,
 * queued user messages, its own session record (`--session-id`, `--resume
 * <id>`, interrupted-turn resume), plan files, and API errors reported as the
 * CLI reports them. It runs scripted tool calls itself: Write and Edit really
 * change files, anything else returns its scripted result.
 *
 * Responses come from `$FAKE_CLAUDE_DIR/script.json` in order, shared by every
 * process of one test; everything the fake saw is appended to `log.jsonl`.
 * No network and no real model.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write('2.1.295 (Claude Code)\n')
  process.exit(0)
}
const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const dir = process.env.FAKE_CLAUDE_DIR
const configDir = process.env.CLAUDE_CONFIG_DIR
const log = entry => appendFileSync(join(dir, 'log.jsonl'), `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
const out = value => process.stdout.write(`${JSON.stringify(value)}\n`)

const unknown = args.find(arg => arg.startsWith('--') && (process.env.FAKE_CLAUDE_REJECT ?? '').split(',').includes(arg))
if (unknown !== undefined) {
  process.stderr.write(`error: unknown option '${unknown}'\n`)
  process.exit(1)
}

/** Take the next scripted response for this test. */
function take() {
  const script = JSON.parse(readFileSync(join(dir, 'script.json'), 'utf8'))
  let state = { next: 0 }
  try { state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) } catch { /* first response */ }
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ next: state.next + 1 }))
  return script[state.next] ?? { blocks: [{ type: 'text', text: 'unscripted' }] }
}

const oneShot = args.includes('-p')
const resumeId = option('--resume')
const sessionId = resumeId ?? option('--session-id') ?? 'one-shot'
const sessionFile = join(configDir, 'projects', process.env.CLAUDE_CODE_PROJECT_DIR_NAME ?? 'unset', `${sessionId}.jsonl`)
const record = entry => {
  if (oneShot) return
  mkdirSync(dirname(sessionFile), { recursive: true })
  appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`)
}
const transcript = resumeId !== undefined && existsSync(sessionFile)
  ? readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : []
let mode = option('--permission-mode') ?? 'default'
const token = process.env.ANTHROPIC_AUTH_TOKEN ?? ''
log({
  kind: 'start',
  args,
  cwd: process.cwd(),
  sessionId,
  resumed: resumeId !== undefined,
  found: resumeId === undefined || existsSync(sessionFile),
  token: createHash('sha256').update(token).digest('hex').slice(0, 12),
  env: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:ANTHROPIC_BASE_URL|CLAUDE_|MCP_|DISABLE_|ANTHROPIC_API_KEY|ANTHROPIC_MODEL)/u.test(name))),
  transcript: transcript.map(entry => ({ type: entry.type, message: entry.message })),
})
if (resumeId !== undefined && !existsSync(sessionFile)) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`No conversation found with session ID: ${resumeId}`] })
  process.exit(1)
}
const TOOLS = oneShot ? [] : ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'EnterPlanMode', 'ExitPlanMode', 'Read', 'WebFetch', 'WebSearch', 'Write']
out({ type: 'system', subtype: 'init', claude_code_version: '2.1.295', session_id: sessionId, model: option('--model'), permissionMode: mode, tools: TOOLS })

const streamEvent = event => out({ type: 'stream_event', event, session_id: sessionId, parent_tool_use_id: null })
const expand = value => (typeof value === 'string' ? value.replaceAll('$CONFIG', configDir) : Array.isArray(value) ? value.map(expand) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)])) : value)

let requestCounter = 0
const permissions = new Map()
/** User messages that arrived while a turn was running. */
const queued = []
let running = false
let interrupted = false

function ask(block) {
  const requestId = `perm-${++requestCounter}`
  out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: block.name, display_name: block.name, input: block.name === 'ExitPlanMode' ? {} : block.input, tool_use_id: block.id, permission_suggestions: [], ...(['ExitPlanMode', 'AskUserQuestion'].includes(block.name) ? { requires_user_interaction: true } : {}) } })
  return new Promise(resolveAnswer => permissions.set(requestId, resolveAnswer))
}

function setMode(next) {
  mode = next
  out({ type: 'system', subtype: 'status', status: null, permissionMode: mode, session_id: sessionId })
}

/** Run one scripted tool call the way the CLI would, permission included. */
async function run(block) {
  // Outside plan mode the CLI refuses its own ExitPlanMode without asking.
  if (block.name === 'ExitPlanMode' && mode !== 'plan') return { type: 'tool_result', tool_use_id: block.id, content: '<tool_use_error>You are not in plan mode. To enter plan mode, call the EnterPlanMode tool first.</tool_use_error>', is_error: true }
  if (block.name === 'EnterPlanMode') {
    setMode('plan')
    return { type: 'tool_result', tool_use_id: block.id, content: 'Entered plan mode.' }
  }
  const asks = block.name === 'ExitPlanMode' || block.name === 'AskUserQuestion' || (block.ask === true && mode !== 'bypassPermissions')
  if (asks) {
    const answer = await ask(block)
    log({ kind: 'permission', id: block.id, tool: block.name, answer })
    if (answer.behavior !== 'allow') return { type: 'tool_result', tool_use_id: block.id, content: answer.message, is_error: true }
    const setModeUpdate = (answer.updatedPermissions ?? []).find(update => update.type === 'setMode')
    if (block.name === 'ExitPlanMode') {
      setMode(setModeUpdate?.mode ?? 'default')
      return { type: 'tool_result', tool_use_id: block.id, content: 'User has approved exiting plan mode. You can now proceed.' }
    }
    if (block.name === 'AskUserQuestion') return { type: 'tool_result', tool_use_id: block.id, content: `Your questions have been answered: ${JSON.stringify(answer.updatedInput?.answers ?? {})}` }
    block = { ...block, input: answer.updatedInput ?? block.input }
  }
  if (block.name === 'Write' && typeof block.input.file_path === 'string') {
    const path = resolve(process.cwd(), block.input.file_path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, String(block.input.content ?? ''))
    return { type: 'tool_result', tool_use_id: block.id, content: `File created successfully at: ${block.input.file_path}` }
  }
  if (block.name === 'Edit' && typeof block.input.file_path === 'string') {
    const path = resolve(process.cwd(), block.input.file_path)
    writeFileSync(path, readFileSync(path, 'utf8').replace(block.input.old_string, block.input.new_string))
    return { type: 'tool_result', tool_use_id: block.id, content: `The file ${block.input.file_path} has been updated.` }
  }
  return { type: 'tool_result', tool_use_id: block.id, content: block.result ?? `ran ${block.name}`, ...(block.error === true ? { is_error: true } : {}) }
}

async function request(trigger, input) {
  log({ kind: 'request', trigger, mode, ...(input === undefined ? {} : { input }), ...(queued.length > 0 ? { injected: queued.splice(0) } : {}) })
  const reply = expand(take())
  if (reply.delayMs !== undefined) await new Promise(resolveDelay => setTimeout(resolveDelay, reply.delayMs))
  if (interrupted) return
  if (reply.exit !== undefined) {
    process.stderr.write(reply.stderr ?? '')
    process.exit(reply.exit)
  }
  if (reply.error !== undefined) {
    const text = `${reply.error.prefix ?? ''}API Error: ${reply.error.status} ${reply.error.message}`
    out({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] }, error: reply.error.kind ?? 'unknown', parent_tool_use_id: null })
    out({ type: 'result', subtype: 'success', is_error: true, api_error_status: reply.error.status, result: text })
    running = false
    return
  }
  const blocks = reply.blocks ?? []
  const uses = blocks.filter(block => block.type === 'tool_use')
  streamEvent({ type: 'message_start', message: { id: `msg_fake_${Date.now()}_${requestCounter++}`, type: 'message', role: 'assistant', model: option('--model'), content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 } } })
  blocks.forEach((block, index) => {
    const wire = block.type === 'tool_use' ? { type: 'tool_use', id: block.id, name: block.name, input: block.input } : block
    if (block.type === 'tool_use') {
      streamEvent({ type: 'content_block_start', index, content_block: { ...wire, input: {} } })
      const json = JSON.stringify(block.input)
      for (const part of [json.slice(0, Math.ceil(json.length / 2)), json.slice(Math.ceil(json.length / 2))]) if (part !== '') streamEvent({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } })
    } else if (block.type === 'thinking') {
      streamEvent({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      if (block.thinking !== '') streamEvent({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } })
      streamEvent({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } })
    } else {
      streamEvent({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
    }
    out({ type: 'assistant', message: { role: 'assistant', model: option('--model'), content: [wire] }, session_id: sessionId, parent_tool_use_id: null })
    streamEvent({ type: 'content_block_stop', index })
  })
  const stop = reply.stop ?? (uses.length > 0 ? 'tool_use' : 'end_turn')
  streamEvent({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } })
  streamEvent({ type: 'message_stop' })
  record({ type: 'assistant', message: { role: 'assistant', content: blocks.map(block => (block.type === 'tool_use' ? { type: 'tool_use', id: block.id, name: block.name, input: block.input } : block)) } })
  if (stop !== 'tool_use') {
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId })
    running = false
    // A message queued too late for this turn starts the next one.
    if (queued.length > 0) startTurn('queued', queued.splice(0).flat())
    return
  }
  const results = []
  for (const use of uses) {
    const result = await run(use)
    if (interrupted) return
    log({ kind: 'tool-result', id: use.id, result })
    results.push(result)
  }
  out({ type: 'user', message: { role: 'user', content: results }, parent_tool_use_id: null })
  record({ type: 'user', message: { role: 'user', content: results } })
  await request('tool-results')
}

let queue = Promise.resolve()
const startTurn = (trigger, content) => {
  queue = queue.then(async () => {
    running = true
    interrupted = false
    if (content !== undefined) record({ type: 'user', message: { role: 'user', content } })
    await request(trigger, content)
  })
}
if (process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN === '1' && resumeId !== undefined) startTurn('resume')

const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.type === 'control_response') {
    const resolveAnswer = permissions.get(message.response?.request_id)
    if (resolveAnswer !== undefined) { permissions.delete(message.response.request_id); resolveAnswer(message.response.response) }
    return
  }
  if (message.type === 'control_request') {
    const request = message.request ?? {}
    log({ kind: 'control', request })
    if (request.subtype === 'set_permission_mode') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { mode: request.mode } } })
      setMode(request.mode)
    } else if (request.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { still_queued: [] } } })
      if (running) {
        interrupted = true
        running = false
        for (const resolveAnswer of permissions.values()) resolveAnswer({ behavior: 'deny', message: 'interrupted' })
        permissions.clear()
        out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null })
        out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId })
      }
    } else {
      out({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'unsupported' } })
    }
    return
  }
  if (message.type !== 'user') return
  if (running) { queued.push(message.message.content); return }
  startTurn('user', message.message.content)
})
lines.on('close', () => { void queue.then(() => process.exit(0)) })
