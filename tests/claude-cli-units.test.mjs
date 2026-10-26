import assert from 'node:assert/strict'
import test from 'node:test'

import { answersFor, approvalReason, presentClaudeCall, presentClaudeResult, questionsFor, refusalMessage } from '../src/claude-agent-tools.js'
import { buildCliArgs, buildCliEnvironment, cliErrorMessage, MIRROR_TOOL, PLAN_TOOL, responseFingerprint, toolResultText } from '../src/claude-cli-session.js'
import { baseUrlOf, compactionSummary, describeRequest, dshSystemText, messageFingerprint, planAnswer, planContinuation, splitAtLastAnswer, titlePrompt } from '../src/claude-cli-transport.js'
import { claudePermissionMode } from '../src/claude-permission-mode.js'
import { buildTranscript, toCliHistory } from '../src/claude-transcript.js'
import { createClaudeToolNames } from '../src/claude-tools.js'
import { claudeTransportFor, CLI_ONLY_GROUPS } from '../src/claude-transport.js'
import { dshTitleRequest } from './fixtures/dsh-session-title.mjs'

test('cc keys and keys with unread groups use the CLI; cc-sale, cc-expensive, claude-officially and delisted claude-sale keep HTTP; nothing pins a route', () => {
  assert.deepEqual(CLI_ONLY_GROUPS, ['cc'])
  assert.deepEqual(claudeTransportFor({ groups: ['codex', 'cc'] }), { transport: 'cli', reason: 'group', groups: ['cc'] })
  assert.equal(claudeTransportFor({ groups: ['claude-sale'] }).transport, 'http', 'claude-sale is delisted; it is added back when it returns')
  assert.equal(claudeTransportFor({ groups: ['cc', 'cc-sale'] }).transport, 'cli', 'a gated group present means the official client')
  assert.deepEqual(claudeTransportFor({ groups: ['cc-sale'] }), { transport: 'http', reason: 'group', groups: ['cc-sale'] })
  assert.equal(claudeTransportFor({ groups: ['cc-expensive', 'codex'] }).transport, 'http')
  assert.deepEqual(claudeTransportFor({ groups: ['claude-officially', 'cc-sale'] }), { transport: 'http', reason: 'group', groups: ['claude-officially', 'cc-sale'] })
  assert.deepEqual(claudeTransportFor({ groups: undefined }), { transport: 'cli', reason: 'unknown' }, 'a key whose groups are unread uses the client every Claude group serves')
  assert.deepEqual(claudeTransportFor({ preference: 'http', groups: ['cc'] }), { transport: 'cli', reason: 'group', groups: ['cc'] }, 'no pin overrides the groups')
})

test('through the CLI nothing is renamed; over HTTP the CLI-compatible built-in spellings stay', () => {
  const payload = { tools: [{ name: 'bash', input_schema: { type: 'object' } }], messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: MIRROR_TOOL, input: {} }] }] }
  const cli = createClaudeToolNames({ cli: true })
  assert.equal(cli.encodePayload(payload), payload)
  const stream = {}
  assert.equal(cli.decodeStream(stream), stream)
  const http = createClaudeToolNames().encodePayload({ tools: [{ name: 'bash', input_schema: { type: 'object' } }] })
  assert.equal(http.tools[0].name, 'Bash')
})

test('DSH\'s permission settings map to the Claude Code permission mode that keeps each preset\'s promise', () => {
  assert.equal(claudePermissionMode({ planActive: true, preset: 'danger-full-access' }), 'plan', 'plan mode wins')
  assert.equal(claudePermissionMode({ preset: 'workspace-write' }), 'acceptEdits')
  assert.equal(claudePermissionMode({ preset: 'read-only' }), 'default')
  assert.equal(claudePermissionMode({ preset: 'danger-full-access' }), 'bypassPermissions')
  assert.equal(claudePermissionMode({ preset: 'danger-full-access', approval: 'ask' }), 'acceptEdits')
  assert.equal(claudePermissionMode({ preset: 'auto' }), 'default', 'Auto review judges what the CLI asks about')
  assert.equal(claudePermissionMode({ preset: 'team-default', sandbox: 'workspace-write', approval: 'ask' }), 'acceptEdits', 'a renamed preset maps by its sandbox')
  assert.equal(claudePermissionMode({ preset: 'yolo', sandbox: 'danger-full-access', approval: 'never' }), 'bypassPermissions')
  assert.equal(claudePermissionMode({ preset: 'custom' }), 'default')
  assert.equal(claudePermissionMode(), 'default')
})

test('CLI arguments and environment: Claude Code\'s own prompt and tools, permission prompts over stdio, the plugin\'s home and key only', () => {
  const args = buildCliArgs({ model: 'claude-opus-5-5', effort: 'max', permissionMode: 'acceptEdits', cliSessionId: 'abc' })
  for (const flag of ['--input-format', '--include-partial-messages', '--allow-dangerously-skip-permissions', '--strict-mcp-config']) assert.ok(args.includes(flag), flag)
  assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], 'stdio')
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits')
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'user', 'never a project\'s settings, hooks or MCP servers')
  assert.equal(args[args.indexOf('--session-id') + 1], 'abc')
  assert.equal(args[args.indexOf('--effort') + 1], 'max')
  for (const flag of ['-p', '--tools', '--append-system-prompt', '--append-system-prompt-file', '--system-prompt', '--mcp-config', '--disable-slash-commands', '--no-session-persistence', '--resume']) assert.ok(!args.includes(flag), flag)
  const resumed = buildCliArgs({ model: 'claude-opus-5-5', cliSessionId: 'abc', resume: true })
  assert.equal(resumed[resumed.indexOf('--resume') + 1], 'abc')
  assert.ok(!resumed.includes('--session-id'))
  assert.equal(resumed[resumed.indexOf('--permission-mode') + 1], 'default')
  const title = buildCliArgs({ model: 'claude-haiku-5-5', oneShot: true })
  assert.ok(title.includes('-p'))
  assert.deepEqual(title.slice(title.indexOf('--tools'), title.indexOf('--tools') + 2), ['--tools', ''], 'a title has no tools')
  assert.ok(title.includes('--no-session-persistence'))
  assert.ok(!title.includes('--permission-prompt-tool'))

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
  assert.equal(env.CLAUDE_CODE_PROJECT_DIR_NAME, 'dsh-packycode')
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '0')
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '2048')
  assert.equal(env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, '1')
  assert.equal(env.DISABLE_TELEMETRY, '1')
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1')
  for (const removed of ['CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT', 'CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT']) assert.equal(env[removed], undefined, removed)
  assert.throws(() => buildCliEnvironment({ baseUrl: 'x', apiKey: '' }), /no PackyCode API key/u)
  assert.equal(cliErrorMessage('Failed to authenticate. API Error: 403 客户端存在异常'), '客户端存在异常')
  assert.equal(cliErrorMessage('API Error: Request rejected (429) · concurrency_queue_full'), 'concurrency_queue_full')
  assert.equal(cliErrorMessage('plain'), 'plain')
})

test('a request tells the transport its model, effort and DSH system text; the HTTP envelope is not part of it', () => {
  const request = describeRequest({ model: 'claude-sonnet-5-5', max_tokens: 8000, output_config: { effort: 'high' }, system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.295.abc;' }, { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK." }, { type: 'text', text: '只回复标题。' }], messages: [] }, { apiKey: 'sk-a', baseUrl: 'https://cf.api.fan', cwd: '/w' })
  assert.equal(request.model, 'claude-sonnet-5-5')
  assert.equal(request.effort, 'high')
  assert.equal(request.maxTokens, 8000)
  assert.equal(request.system, '只回复标题。')
  assert.notEqual(request.signature, describeRequest({ model: 'claude-sonnet-5-5', max_tokens: 8000, output_config: { effort: 'high' }, messages: [] }, { apiKey: 'sk-b', baseUrl: 'https://cf.api.fan', cwd: '/w' }).signature, 'another key is another process')
  assert.equal(dshSystemText('plain'), 'plain')
  assert.equal(baseUrlOf('https://cf.api.fan/v1/messages?beta=true'), 'https://cf.api.fan')
})

test('a served response and DSH\'s replay of it have the same fingerprint, whatever pi-ai did with cache markers', () => {
  const served = responseFingerprint({ toolIds: ['toolu_1'], text: '我先看看。' })
  assert.equal(messageFingerprint({ role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: '我先看看。', cache_control: { type: 'ephemeral' } }, { type: 'tool_use', id: 'toolu_1', name: MIRROR_TOOL, input: { tool: 'Bash', input: {} } }] }), served)
  assert.equal(messageFingerprint({ role: 'assistant', content: '完成。' }), responseFingerprint({ text: '完成。' }))
  assert.notEqual(messageFingerprint({ role: 'assistant', content: '完成了。' }), responseFingerprint({ text: '完成。' }))
  const split = splitAtLastAnswer([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }, { type: 'text', text: 'note' }] }])
  assert.equal(split.index, 1)
  assert.deepEqual([...split.results.keys()], ['t'])
  assert.deepEqual(split.other, [{ type: 'text', text: 'note' }])
})

test('a live process continues only the response it served: DSH\'s tool results, a plan review, a note, or the next turn', () => {
  const answer = { role: 'assistant', content: [{ type: 'text', text: '先列目录。' }, { type: 'tool_use', id: 'toolu_1', name: MIRROR_TOOL, input: { tool: 'Bash', input: { command: 'ls' } } }] }
  const served = { fingerprint: messageFingerprint(answer), toolIds: ['toolu_1'] }
  const session = { closed: false, state: 'awaiting-tools', pendingToolIds: ['toolu_1'], served }
  const result = { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'a.txt' }] }
  assert.deepEqual(planContinuation(session, { messages: [{ role: 'user', content: '列文件' }, answer, { role: 'user', content: [result] }] }), { kind: 'continue' })
  assert.deepEqual(planContinuation(session, { messages: [{ role: 'user', content: '列文件' }, answer, { role: 'user', content: [result, { type: 'text', text: '只要 txt' }] }] }), { kind: 'continue', steer: [{ type: 'text', text: '只要 txt' }] })
  assert.equal(planContinuation(session, { messages: [{ role: 'user', content: '列文件' }, answer, { role: 'user', content: [{ type: 'text', text: '没结果' }] }] }), undefined, 'every pending call must be answered')
  assert.equal(planContinuation(session, { messages: [{ role: 'user', content: '列文件' }, { role: 'assistant', content: '别的回答' }, { role: 'user', content: [result] }] }), undefined, 'another history')
  assert.equal(planContinuation({ ...session, closed: true }, { messages: [answer, { role: 'user', content: [result] }] }), undefined)

  const done = { role: 'assistant', content: '有两个文件。' }
  const idle = { closed: false, state: 'idle', pendingToolIds: [], served: { fingerprint: messageFingerprint(done), toolIds: [] } }
  assert.deepEqual(planContinuation(idle, { messages: [done, { role: 'user', content: '数一下' }] }), { kind: 'turn', content: [{ type: 'text', text: '数一下' }] })
  assert.deepEqual(planContinuation(idle, { messages: [done, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'ABORTED' }, { type: 'text', text: '继续' }] }] }), { kind: 'turn', content: [{ type: 'text', text: '继续' }] }, 'results a cancelled turn left behind are not news')
  assert.equal(planContinuation(idle, { messages: [done] }), undefined)

  const plan = { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_plan', name: PLAN_TOOL, input: { plan: '# 方案' } }] }
  const planned = { closed: false, state: 'awaiting-tools', pendingToolIds: ['toolu_plan'], served: { fingerprint: messageFingerprint(plan), toolIds: ['toolu_plan'], planId: 'toolu_plan' } }
  const approved = planContinuation(planned, { messages: [plan, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_plan', content: 'Plan approved — plan mode exited; carry out the plan starting with your next step.' }] }] }, { approvedMode: 'acceptEdits' })
  assert.deepEqual(approved, { kind: 'continue', exitPlan: { id: 'toolu_plan', approved: true, mode: 'acceptEdits' } })
})

test('DSH\'s plan review becomes the answer Claude Code\'s ExitPlanMode waits for', () => {
  assert.deepEqual(planAnswer({ content: 'Plan approved — plan mode exited; carry out the plan starting with your next step.' }, 'bypassPermissions'), { approved: true, mode: 'bypassPermissions' })
  const feedback = planAnswer({ is_error: true, content: [{ type: 'text', text: 'Error: The user chose to keep planning; their feedback: 先别动数据库' }] })
  assert.equal(feedback.approved, false)
  assert.match(feedback.message, /先别动数据库/u)
  assert.match(planAnswer({ is_error: true, content: 'Error: The user chose to keep planning; revise the plan and present it again.' }).message, /keep planning/u)
  assert.match(planAnswer({ content: 'The user dismissed the plan review to reply in their own words; plan mode remains active.' }).message, /stay in plan mode/u)
})

test('DSH\'s history becomes Claude Code\'s own: mirrored calls are its tool calls, DSH\'s own tools become text', () => {
  const history = toCliHistory([
    { role: 'user', content: [{ type: 'text', text: '看看文件', cache_control: { type: 'ephemeral' } }] },
    { role: 'assistant', content: [{ type: 'text', text: '先用 DSH 读。' }, { type: 'tool_use', id: 'dsh_1', name: 'read', input: { path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'dsh_1', content: 'hello' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'cc_1', name: MIRROR_TOOL, input: { tool: 'Bash', input: { command: 'ls' } } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cc_1', content: 'a.txt' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'cc_2', name: PLAN_TOOL, input: { plan: '# 方案' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cc_2', content: 'Plan approved' }] },
  ])
  assert.deepEqual(history[1].content[1], { type: 'text', text: '[DSH 工具调用 read] {"path":"a.txt"}' })
  assert.deepEqual(history[2].content[0], { type: 'text', text: '[DSH 工具结果] hello' })
  assert.deepEqual(history[3].content[0], { type: 'tool_use', id: 'cc_1', name: 'Bash', input: { command: 'ls' } })
  assert.equal(history[4].content[0].type, 'tool_result')
  assert.deepEqual(history[5].content[0], { type: 'tool_use', id: 'cc_2', name: 'ExitPlanMode', input: {} })
  assert.ok(!JSON.stringify(history).includes('cache_control'))
  const lines = buildTranscript(history, { sessionId: 's', cwd: '/w', model: 'claude-opus-5-5', version: '2.1.295', now: () => 1_800_000_000_000 }).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lines.length, history.length)
  assert.equal(lines[0].parentUuid, null)
  assert.equal(lines[1].parentUuid, lines[0].uuid)
  assert.equal(lines[3].message.stop_reason, 'tool_use')
})

test('Claude Code\'s tool calls show as DSH\'s terminal, diff and read cards', () => {
  assert.deepEqual(presentClaudeCall({ tool: 'Bash', input: { command: 'npm test', description: 'Run tests' } }), { card: 'terminal', title: 'npm test', description: 'Run tests' })
  assert.deepEqual(presentClaudeCall({ tool: 'Edit', input: { file_path: 'a.js', old_string: 'x', new_string: 'y' } }).diffs, [{ path: 'a.js', oldText: 'x', newText: 'y' }])
  assert.deepEqual(presentClaudeCall({ tool: 'Write', input: { file_path: 'b.md', content: '# B' } }).diffs, [{ path: 'b.md', oldText: null, newText: '# B' }])
  assert.equal(presentClaudeCall({ tool: 'Read', input: { file_path: 'c.js', offset: 10 } }).locations[0].line, 10)
  assert.equal(presentClaudeCall({ tool: 'WebFetch', input: { url: 'https://example.com' } }).kind, 'fetch')
  assert.equal(presentClaudeCall({ tool: 'Task', input: { description: '查日志' } }).title, 'Task 查日志')
  assert.deepEqual(presentClaudeResult({ tool: 'Bash', input: { command: 'ls' } }, { content: [{ type: 'text', text: 'a.txt' }], isError: false }), { card: 'terminal', output: 'a.txt' })
  assert.equal(presentClaudeResult({ tool: 'Read', input: { file_path: 'c.js' } }, { content: [], isError: false }), undefined)
  assert.equal(toolResultText([{ type: 'text', text: 'a' }, { type: 'image', source: {} }]), 'a\n[image]')
})

test('an approval prompt names what Claude Code asks to run, and a refusal reaches Claude Code in plain words', () => {
  const ask = approvalReason({ tool_name: 'Bash', input: { command: 'rm -rf build' } })
  assert.match(ask.reason, /Bash: rm -rf build/u)
  assert.match(ask.displayReason.zh, /不经过 DSH 的沙箱/u)
  assert.match(approvalReason({ tool_name: 'Write', input: { file_path: '/etc/hosts' } }).reason, /\/etc\/hosts/u)
  assert.equal(refusalMessage({ content: [{ type: 'text', text: 'Error: the user rejected tool "claude_code"' }] }), 'The user rejected this call in DeepSeek Harness.')
  assert.match(refusalMessage({ content: [{ type: 'text', text: 'Error: Auto review denied tool "claude_code": risky' }] }), /did not allow this call: Auto review denied/u)
})

test('Claude Code\'s questions go to DSH\'s question UI and the answers come back by question text', () => {
  const input = { questions: [{ question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: 'SQL' }, { label: 'Mongo' }] }, { question: '哪些服务？', multiSelect: true, options: [{ label: 'api' }, { label: 'web' }] }] }
  assert.deepEqual(questionsFor(input), [
    { id: 'q1', question: 'Which database?', header: 'DB', options: [{ label: 'Postgres', description: 'SQL' }, { label: 'Mongo' }] },
    { id: 'q2', question: '哪些服务？', options: [{ label: 'api' }, { label: 'web' }], multiSelect: true },
  ])
  assert.deepEqual(answersFor(input, { answers: [{ id: 'q1', selected: ['Postgres'] }, { id: 'q2', selected: ['api', 'web'] }] }), { 'Which database?': 'Postgres', '哪些服务？': 'api, web' })
  assert.deepEqual(answersFor(input, { answers: [{ id: 'q1', selected: [], custom: 'SQLite' }, { id: 'q2', selected: [] }] }), { 'Which database?': 'SQLite' })
})

test('DSH\'s compaction of a cc session is a record written without a model, and a title request is the user\'s words', () => {
  const summary = compactionSummary([
    { role: 'user', content: '把 version 改成 2.4.2' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: MIRROR_TOOL, input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
    { role: 'assistant', content: '已改成 2.4.2。' },
    { role: 'user', content: 'COMPACTION INSTRUCTION' },
  ])
  assert.match(summary, /Claude Code 自己的会话/u)
  assert.match(summary, /1\. 把 version 改成 2\.4\.2/u)
  assert.match(summary, /已改成 2\.4\.2。/u)
  assert.ok(!summary.includes('COMPACTION INSTRUCTION'))
  const title = dshTitleRequest(['整理今天的发货安排'])
  const input = title.messages[0].content[0].text
  const prompt = titlePrompt({ system: title.system, messages: [{ role: 'user', content: input }, { role: 'user', content: 'Reply with only a short session title.' }] })
  assert.ok(prompt.startsWith(title.system))
  assert.ok(prompt.includes(`用户：${input}`))
  assert.match(prompt, /Reply with only a short session title\.$/u)
})
