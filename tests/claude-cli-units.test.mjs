import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import test from 'node:test'

import { buildCliArgs, buildCliEnvironment, cliErrorMessage } from '../src/claude-cli-session.js'
import { baseUrlOf, CLI_TOOL_NOTE, describeRequest, dshSystemText, planContinuation } from '../src/claude-cli-transport.js'
import { startClaudeMcpBridge, toolResultToMcp } from '../src/claude-mcp-bridge.js'
import { buildTranscript, canonicalMessage, splitConversation } from '../src/claude-transcript.js'
import { cliToolName, createClaudeToolNames } from '../src/claude-tools.js'
import { claudeTransportFor, CLI_ONLY_GROUPS } from '../src/claude-transport.js'

test('cc keys use the CLI; cc-sale, cc-expensive, claude-officially, delisted claude-sale and unknown keys keep HTTP; nothing pins a route', () => {
  assert.deepEqual(CLI_ONLY_GROUPS, ['cc'])
  assert.deepEqual(claudeTransportFor({ groups: ['codex', 'cc'] }), { transport: 'cli', reason: 'group', groups: ['cc'] })
  assert.equal(claudeTransportFor({ groups: ['claude-sale'] }).transport, 'http', 'claude-sale is delisted; it is added back when it returns')
  assert.equal(claudeTransportFor({ groups: ['cc', 'cc-sale'] }).transport, 'cli', 'a gated group present means the official client')
  assert.deepEqual(claudeTransportFor({ groups: ['cc-sale'] }), { transport: 'http', reason: 'group', groups: ['cc-sale'] })
  assert.equal(claudeTransportFor({ groups: ['cc-expensive', 'codex'] }).transport, 'http')
  assert.deepEqual(claudeTransportFor({ groups: ['claude-officially', 'cc-sale'] }), { transport: 'http', reason: 'group', groups: ['claude-officially', 'cc-sale'] })
  assert.deepEqual(claudeTransportFor({ groups: undefined }), { transport: 'http', reason: 'unknown' })
  assert.deepEqual(claudeTransportFor({ preference: 'http', groups: ['cc'] }), { transport: 'cli', reason: 'group', groups: ['cc'] }, 'no pin overrides the groups')
})

test('tool names through the CLI are the MCP names the model sees, unambiguous and within 64 characters', () => {
  assert.equal(cliToolName('bash'), 'mcp__dsh__bash')
  assert.equal(cliToolName('exit_plan_mode'), 'mcp__dsh__exit_plan_mode')
  assert.equal(cliToolName('read-image'), 'mcp__dsh__read-image')
  for (const odd of ['mcp__github__create_issue', 'tool with spaces', '工具', 'x'.repeat(60)]) {
    const name = cliToolName(odd)
    assert.match(name, /^mcp__dsh__[a-zA-Z0-9-]+(?:_[a-zA-Z0-9-]+)*_[a-f0-9]{12}$/u, odd)
    assert.ok(name.length <= 64, odd)
    assert.ok(!name.slice('mcp__dsh__'.length).includes('__'), odd)
  }
  assert.notEqual(cliToolName('a b'), cliToolName('a_b '))

  const names = createClaudeToolNames({ cli: true })
  const payload = names.encodePayload({
    tools: [{ name: 'bash', input_schema: { type: 'object' } }, { name: 'read', input_schema: { type: 'object' } }],
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] }],
  })
  assert.deepEqual(payload.tools.map(tool => tool.name), ['mcp__dsh__bash', 'mcp__dsh__read'], 'no built-in spellings through the CLI')
  assert.equal(payload.messages[0].content[0].name, 'mcp__dsh__bash')
  // Over HTTP the CLI-compatible built-in spellings stay.
  const http = createClaudeToolNames().encodePayload({ tools: [{ name: 'bash', input_schema: { type: 'object' } }] })
  assert.equal(http.tools[0].name, 'Bash')
})

test('a request is split at the turn boundary, or resumed whole inside an open turn', () => {
  const marked = { type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }
  const boundary = splitConversation([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'context snapshot' }] },
    { role: 'user', content: [marked] },
  ])
  assert.equal(boundary.continues, false)
  assert.deepEqual(boundary.history.map(message => message.role), ['user', 'assistant'])
  assert.deepEqual(boundary.history[0].content, [{ type: 'text', text: 'first' }])
  assert.deepEqual(boundary.input, [{ type: 'text', text: 'context snapshot' }, { type: 'text', text: 'second' }], 'consecutive user messages become one input, without cache markers')

  const open = splitConversation([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'mcp__dsh__bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
    { role: 'user', content: 'steer' },
  ])
  assert.equal(open.continues, true)
  assert.equal(open.input, undefined)
  assert.deepEqual(open.history.at(-1).content.map(block => block.type), ['tool_result', 'text'])

  assert.deepEqual(splitConversation([]), { history: [], input: undefined, continues: false })
  assert.throws(() => splitConversation([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'prefill' }]), /ends with an assistant message/u)
})

test('the transcript is a parent-linked chain the CLI resumes verbatim', () => {
  const lines = buildTranscript([
    { role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 't', name: 'mcp__dsh__bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
  ], { sessionId: '11111111-2222-4333-8444-555555555555', cwd: '/work', model: 'claude-opus-5-5', version: '2.1.295', now: () => 10_000_000 }).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lines.length, 3)
  assert.equal(lines[0].parentUuid, null)
  assert.equal(lines[1].parentUuid, lines[0].uuid)
  assert.equal(lines[2].parentUuid, lines[1].uuid)
  for (const line of lines) {
    assert.equal(line.sessionId, '11111111-2222-4333-8444-555555555555')
    assert.equal(line.cwd, '/work')
    assert.equal(line.isSidechain, false)
  }
  assert.equal(lines[1].type, 'assistant')
  assert.equal(lines[1].message.model, 'claude-opus-5-5')
  assert.equal(lines[1].message.stop_reason, 'tool_use')
  assert.deepEqual(lines[1].message.content[0], { type: 'thinking', thinking: '', signature: 's' })
  assert.ok(lines[0].timestamp < lines[1].timestamp)
  assert.equal(buildTranscript([], {}), '')
})

test('requests compare by content, not by where pi-ai put cache markers or string shorthands', () => {
  assert.deepEqual(canonicalMessage({ role: 'user', content: 'hi' }), canonicalMessage({ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }))
  assert.deepEqual(
    canonicalMessage({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }),
    canonicalMessage({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok' }], cache_control: { type: 'ephemeral' } }] }),
  )
})

test('a live process continues only its own tool results or the next user turn', () => {
  const body = messages => ({ model: 'claude-sonnet-5-5', system: [{ type: 'text', text: 'x-anthropic-billing-header: cc' }, { type: 'text', text: 'DSH prompt' }], tools: [{ name: 'mcp__dsh__bash', input_schema: { type: 'object' } }], messages })
  const first = describeRequest(body([{ role: 'user', content: [{ type: 'text', text: 'go', cache_control: { type: 'ephemeral' } }] }]), { apiKey: 'k', baseUrl: 'u', cwd: '/w' })
  assert.equal(first.system, `DSH prompt\n\n${CLI_TOOL_NOTE}`)
  const assistant = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__dsh__bash', input: {} }] }
  const results = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }
  const awaiting = { session: { closed: false, state: 'awaiting-tools', pendingToolIds: ['t1'] }, baseline: first.normalized, signature: first.signature }
  const next = describeRequest(body([{ role: 'user', content: 'go' }, assistant, results]), { apiKey: 'k', baseUrl: 'u', cwd: '/w' })
  const plan = planContinuation(awaiting, next)
  assert.equal(plan.kind, 'tools')
  assert.deepEqual([...plan.results.keys()], ['t1'])
  // Anything else is not a continuation.
  assert.equal(planContinuation(awaiting, describeRequest(body([{ role: 'user', content: 'go' }, assistant, results]), { apiKey: 'other', baseUrl: 'u', cwd: '/w' })), undefined, 'another key')
  assert.equal(planContinuation(awaiting, describeRequest(body([{ role: 'user', content: 'changed' }, assistant, results]), { apiKey: 'k', baseUrl: 'u', cwd: '/w' })), undefined, 'another history')
  assert.equal(planContinuation(awaiting, describeRequest(body([{ role: 'user', content: 'go' }, assistant, { role: 'user', content: [results.content[0], { type: 'text', text: 'steer' }] }]), { apiKey: 'k', baseUrl: 'u', cwd: '/w' })), undefined, 'a steering note')
  assert.equal(planContinuation({ ...awaiting, session: { ...awaiting.session, closed: true } }, next), undefined, 'a closed process')
  const idle = { session: { closed: false, state: 'idle', pendingToolIds: [] }, baseline: first.normalized, signature: first.signature }
  const turn = planContinuation(idle, describeRequest(body([{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, { role: 'user', content: 'more' }]), { apiKey: 'k', baseUrl: 'u', cwd: '/w' }))
  assert.deepEqual(turn, { kind: 'turn', content: [{ type: 'text', text: 'more' }] })
})

test('the DSH system prompt is forwarded without the HTTP route\'s envelope', () => {
  assert.equal(dshSystemText([
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.295.abc; cc_entrypoint=sdk-cli;' },
    { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK." },
    { type: 'text', text: 'DSH one' },
    { type: 'text', text: 'DSH two', cache_control: { type: 'ephemeral' } },
  ]), 'DSH one\n\nDSH two')
  assert.equal(dshSystemText('plain'), 'plain')
  assert.equal(baseUrlOf('https://cf.api.fan/v1/messages?beta=true'), 'https://cf.api.fan')
  assert.equal(baseUrlOf('https://example.test/proxy/v1/messages'), 'https://example.test/proxy')
})

test('CLI arguments and environment: DSH\'s endpoint and key only, the CLI\'s own tools, retries and fallbacks off', () => {
  const args = buildCliArgs({ model: 'claude-opus-5-5', effort: 'max', systemFile: '/run/system.md', mcpConfigFile: '/run/mcp.json', sessionId: 'abc' })
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', ''])
  assert.equal(args[args.indexOf('--session-id') + 1], 'abc')
  assert.ok(!args.includes('--resume'))
  assert.ok(!args.join(' ').includes('Bearer'), 'the capability stays in the private config file')
  const resumed = buildCliArgs({ model: 'claude-opus-5-5', systemFile: 's', mcpConfigFile: 'm', transcriptFile: '/run/t.jsonl' })
  assert.equal(resumed[resumed.indexOf('--resume') + 1], '/run/t.jsonl')
  assert.ok(!resumed.includes('--effort'))

  const env = buildCliEnvironment({ baseUrl: 'https://cf.api.fan', apiKey: 'sk-fixture', configDir: '/home/cli', maxTokens: 2048, continues: true,
    parent: { PATH: '/bin', HTTPS_PROXY: 'http://proxy', ANTHROPIC_API_KEY: 'sk-ambient', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', ANTHROPIC_BASE_URL: 'https://elsewhere', MCP_TIMEOUT: '1', DISABLE_PROMPT_CACHING: '1' } })
  assert.equal(env.PATH, '/bin')
  assert.equal(env.HTTPS_PROXY, 'http://proxy')
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://cf.api.fan')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-fixture')
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
  assert.equal(env.MCP_TIMEOUT, undefined)
  assert.equal(env.DISABLE_PROMPT_CACHING, undefined, 'the user\'s CLI tweaks do not change DSH\'s requests')
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/cli')
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '0')
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '2048')
  assert.equal(env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, '1')
  assert.equal(env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, '0')
  assert.throws(() => buildCliEnvironment({ baseUrl: 'x', apiKey: '' }), /no PackyCode API key/u)
  assert.equal(cliErrorMessage('Failed to authenticate. API Error: 403 客户端存在异常'), '客户端存在异常')
  assert.equal(cliErrorMessage('API Error: Request rejected (429) · concurrency_queue_full'), 'concurrency_queue_full')
  assert.equal(cliErrorMessage('plain'), 'plain')
})

/** One JSON-RPC exchange with a bridge. */
function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, incoming => {
      const chunks = []
      incoming.on('data', chunk => chunks.push(chunk))
      incoming.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        resolve({ status: incoming.statusCode, body: raw === '' ? undefined : JSON.parse(raw) })
      })
    })
    outgoing.on('error', reject)
    outgoing.end(JSON.stringify(body))
  })
}

test('the MCP bridge lists the request\'s tools and holds each call for DSH\'s result, behind its capability', async t => {
  const calls = []
  let release
  const bridge = await startClaudeMcpBridge({
    tools: [{ name: 'mcp__dsh__bash', description: 'Run.', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }, { name: 'Bash', description: 'not ours', input_schema: { type: 'object' } }],
    onCall: call => { calls.push(call); return new Promise(resolve => { release = resolve }) },
  })
  t.after(() => bridge.close())
  const auth = { authorization: bridge.authorization }
  assert.equal((await post(bridge.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401)
  assert.equal((await post(bridge.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { ...auth, host: 'evil.example' })).status, 403)
  assert.equal((await post(bridge.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { ...auth, origin: 'https://evil.example' })).status, 403)

  const init = await post(bridge.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, auth)
  assert.equal(init.body.result.protocolVersion, '2025-06-18')
  assert.equal(init.body.result.serverInfo.name, 'dsh')
  assert.equal((await post(bridge.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth)).status, 202)
  const list = await post(bridge.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth)
  assert.deepEqual(list.body.result.tools.map(tool => tool.name), ['bash'], 'only DSH\'s tools, without the prefix the CLI adds back')
  assert.equal((await post(bridge.url, { jsonrpc: '2.0', id: 3, method: 'resources/list' }, auth)).body.error.code, -32601)

  const pending = post(bridge.url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bash', arguments: { command: 'ls' }, _meta: { 'claudecode/toolUseId': 'toolu_x' } } }, auth)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(calls, [{ toolUseId: 'toolu_x', name: 'bash', arguments: { command: 'ls' } }])
  release(toolResultToMcp({ type: 'tool_result', tool_use_id: 'toolu_x', content: [{ type: 'text', text: 'a.txt' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }], is_error: true }))
  assert.deepEqual((await pending).body.result, { content: [{ type: 'text', text: 'a.txt' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }], isError: true })
  await bridge.close()
  await assert.rejects(post(bridge.url, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, auth))
})

test('tool results map to MCP content in order, with string results and success unmarked', () => {
  assert.deepEqual(toolResultToMcp({ type: 'tool_result', tool_use_id: 't', content: 'plain' }), { content: [{ type: 'text', text: 'plain' }] })
  assert.deepEqual(toolResultToMcp({ type: 'tool_result', tool_use_id: 't', content: [] }), { content: [] })
})
