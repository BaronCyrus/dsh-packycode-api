#!/usr/bin/env node
/**
 * A stand-in for the Claude Code CLI's print mode, as the plugin drives it:
 * stream-json input and output with partial events, MCP tools over HTTP with
 * the tool_use id in `_meta`, sequential held tool calls, `--resume <file>`,
 * interrupted-turn resume, and API errors reported as the CLI reports them.
 *
 * Responses come from `$FAKE_CLAUDE_DIR/script.json` in order, shared by every
 * process of one test; everything the fake saw is appended to `log.jsonl`.
 * No network beyond the plugin's loopback MCP bridge, and no real model.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write('2.1.295 (Claude Code)\n')
  process.exit(0)
}
const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const dir = process.env.FAKE_CLAUDE_DIR
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

const config = JSON.parse(readFileSync(option('--mcp-config'), 'utf8')).mcpServers.dsh
let rpcId = 0
async function rpc(method, params) {
  const id = method.startsWith('notifications/') ? undefined : ++rpcId
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...config.headers },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }),
  })
  if (id === undefined) return undefined
  const body = await response.json()
  if (body.error !== undefined) throw new Error(body.error.message)
  return body.result
}

const transcriptFile = option('--resume')
const transcript = transcriptFile === undefined ? [] : readFileSync(transcriptFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
const sessionId = option('--session-id') ?? transcript[0]?.sessionId
const token = process.env.ANTHROPIC_AUTH_TOKEN ?? ''
await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.295' } })
await rpc('notifications/initialized')
const { tools } = await rpc('tools/list')
log({
  kind: 'start',
  args,
  cwd: process.cwd(),
  sessionId,
  token: createHash('sha256').update(token).digest('hex').slice(0, 12),
  env: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:ANTHROPIC_BASE_URL|CLAUDE_|MCP_|MAX_MCP_|DISABLE_|ANTHROPIC_API_KEY|ANTHROPIC_MODEL)/u.test(name))),
  system: readFileSync(option('--append-system-prompt-file'), 'utf8'),
  tools,
  transcript: transcript.map(entry => ({ type: entry.type, parentUuid: entry.parentUuid, uuid: entry.uuid, sessionId: entry.sessionId, cwd: entry.cwd, message: entry.message })),
})
out({ type: 'system', subtype: 'init', claude_code_version: '2.1.295', session_id: sessionId, model: option('--model'), tools: tools.map(tool => `mcp__dsh__${tool.name}`) })

const streamEvent = event => out({ type: 'stream_event', event, session_id: sessionId })

async function request(trigger, input) {
  log({ kind: 'request', trigger, ...(input === undefined ? {} : { input }) })
  const reply = take()
  if (reply.delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, reply.delayMs))
  if (reply.exit !== undefined) {
    process.stderr.write(reply.stderr ?? '')
    process.exit(reply.exit)
  }
  if (reply.error !== undefined) {
    const text = `${reply.error.prefix ?? ''}API Error: ${reply.error.status} ${reply.error.message}`
    out({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] }, error: reply.error.kind ?? 'unknown' })
    out({ type: 'result', subtype: 'success', is_error: true, api_error_status: reply.error.status, result: text })
    return
  }
  const blocks = reply.blocks ?? []
  const uses = blocks.filter(block => block.type === 'tool_use')
  streamEvent({ type: 'message_start', message: { id: `msg_fake_${Date.now()}`, type: 'message', role: 'assistant', model: option('--model'), content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 } } })
  blocks.forEach((block, index) => {
    if (block.type === 'tool_use') {
      streamEvent({ type: 'content_block_start', index, content_block: { ...block, input: {} } })
      streamEvent({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    } else if (block.type === 'thinking') {
      streamEvent({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      if (block.thinking !== '') streamEvent({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } })
      streamEvent({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } })
    } else {
      streamEvent({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
    }
    out({ type: 'assistant', message: { role: 'assistant', model: option('--model'), content: [block] }, session_id: sessionId })
    streamEvent({ type: 'content_block_stop', index })
  })
  const stop = reply.stop ?? (uses.length > 0 ? 'tool_use' : 'end_turn')
  streamEvent({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } })
  streamEvent({ type: 'message_stop' })
  if (stop !== 'tool_use') {
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId })
    return
  }
  // Like the real CLI: one held call at a time, each answered before the next.
  const results = []
  for (const use of uses) {
    const result = await rpc('tools/call', { name: use.name.replace(/^mcp__dsh__/u, ''), arguments: use.input, ...(process.env.FAKE_CLAUDE_NO_META === '1' ? {} : { _meta: { 'claudecode/toolUseId': use.id } }) })
    log({ kind: 'tool-result', id: use.id, result })
    results.push({ type: 'tool_result', tool_use_id: use.id, content: result.content, ...(result.isError ? { is_error: true } : {}) })
  }
  out({ type: 'user', message: { role: 'user', content: results } })
  await request('tool-results')
}

let queue = Promise.resolve()
const last = transcript.at(-1)
if (process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN === '1' && last?.type === 'user' && last.message.content.some(block => block.type === 'tool_result')) {
  queue = queue.then(() => request('resume'))
}
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.type !== 'user') return
  queue = queue.then(() => request('user', message.message.content))
})
lines.on('close', () => { void queue.then(() => process.exit(0)) })
