import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { BlockAssembler, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

import { createClaudeCliTransport, CLI_TOOL_NOTE } from '../src/claude-cli-transport.js'
import { explainCliClientPolicyFailure, explainCliOutdated, explainCliUnavailable } from '../src/failures.js'
import { PackyCodeKeyRing } from '../src/key-ring.js'
import { createRouteAdapter } from '../src/route.js'
import { fakeCredentials } from './helpers.mjs'

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-claude-cli.mjs', import.meta.url))
const KEY = 'sk-cli-transport-fixture-AAAA'
const OTHER_KEY = 'sk-cli-transport-fixture-BBBB'
const SYSTEM = 'You are an AI agent powered by DeepSeek Harness.'
const TOOLS = [
  { name: 'bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'exit_plan_mode', description: 'Present the plan.', parameters: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] } },
]
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const text = result => result.blocks().filter(block => block.type === 'text').map(block => block.text).join('')

/**
 * The route with every Claude request sent through the CLI transport, whose
 * processes are the fake CLI. The parent environment carries ambient Claude
 * settings that must never reach the child.
 */
async function harness(t, script, { env = {}, binary, version = () => '2.1.295' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'packy-fake-cli-'))
  const workspace = await mkdtemp(join(tmpdir(), 'packy-fake-workspace-'))
  await writeFile(join(dir, 'script.json'), JSON.stringify(script))
  const spawned = []
  const transport = createClaudeCliTransport({
    binary: binary ?? (async () => '/fixture/bin/claude'),
    configDir: join(dir, 'home'),
    version,
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options })
      return spawn(process.execPath, [FAKE_CLI, ...args], options)
    },
    parentEnv: { PATH: process.env.PATH, FAKE_CLAUDE_DIR: dir, ANTHROPIC_API_KEY: 'sk-ambient-must-not-leak', ANTHROPIC_MODEL: 'claude-wrong', CLAUDE_CODE_USE_BEDROCK: '1', ...env },
  })
  t.after(() => transport.close())
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add(KEY, 'cc key')
  await ring.add(OTHER_KEY, 'second cc key')
  const failures = []
  let requestKey
  const adapter = createRouteAdapter({
    ring, fallbackSessionId: 'cli-fixture',
    keys: { active: () => ring.activeKey(), forRequest: (_model, key) => requestKey ?? key, onKeyFailure: (kind, _message, key) => failures.push({ kind, key }), awaitGroups: async () => {} },
    resolveWorkingDirectory: () => workspace,
    claudeCli: { followsGroups: () => false, choose: () => true, fetch: (input, init, meta) => transport.fetch(input, init, meta) },
  })
  async function step(messages, extra = {}) {
    const result = new BlockAssembler()
    const call = await adapter.prepareCall('packycode', extra.model ?? 'claude-sonnet-5-5')
    for await (const chunk of call.stream({ provider: 'packycode', model: 'claude-sonnet-5-5', sessionId: 'dsh-session-cli', reasoningEffort: 'high', system: SYSTEM, tools: TOOLS, messages, ...extra })) result.push(chunk)
    return result
  }
  const log = async () => (await readFile(join(dir, 'log.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { transport, step, log, failures, spawned, workspace, useKey: key => { requestKey = key } }
}

const replay = (result, model = 'claude-sonnet-5-5') => result.message({ kind: 'model', provider: 'packycode', model, replayState: result.replayState })
const clone = value => JSON.parse(JSON.stringify(value))

test('a CLI turn carries DSH\'s prompt and tools, and the same process takes the tool results and the next turn', async t => {
  const { step, log, transport, workspace } = await harness(t, [
    { blocks: [{ type: 'thinking', thinking: 'List first.', signature: 'sig-one' }, { type: 'text', text: '我先看看。' }, { type: 'tool_use', id: 'toolu_fixture_1', name: 'mcp__dsh__bash', input: { command: 'ls' } }] },
    { blocks: [{ type: 'text', text: '有两个文件。' }] },
    { blocks: [{ type: 'text', text: '共 2 个。' }] },
  ])
  const messages = [user('列出文件')]
  const first = await step(messages)
  assert.equal(first.finish.kind, 'tool-calls')
  const call = first.blocks().find(block => block.type === 'tool-call')
  assert.equal(call.name, 'bash', 'the MCP name is restored to the DSH tool')
  assert.deepEqual(JSON.parse(call.arguments), { command: 'ls' })
  assert.equal(first.blocks().find(block => block.type === 'text').text, '我先看看。')

  messages.push(replay(first), createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'a.txt\nb.txt' }], isError: false }))
  const second = await step(clone(messages))
  assert.equal(second.finish.kind, 'stop')
  assert.equal(text(second), '有两个文件。')

  messages.push(replay(second), user('数一下'))
  const third = await step(clone(messages))
  assert.equal(text(third), '共 2 个。')

  const entries = await log()
  const starts = entries.filter(entry => entry.kind === 'start')
  assert.equal(starts.length, 1, 'one process served the whole conversation')
  const [start] = starts
  assert.deepEqual(start.tools.map(tool => tool.name), ['bash', 'exit_plan_mode'])
  assert.deepEqual(start.tools[0].inputSchema, TOOLS[0].parameters)
  assert.ok(start.system.startsWith(SYSTEM))
  assert.ok(start.system.endsWith(CLI_TOOL_NOTE))
  assert.ok(!start.system.includes('x-anthropic-billing-header'), 'the HTTP envelope is not forwarded')
  for (const flag of ['-p', '--include-partial-messages', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(start.args.includes(flag), flag)
  assert.equal(start.args[start.args.indexOf('--tools') + 1], '', 'the CLI\'s own tools are off')
  assert.equal(start.args[start.args.indexOf('--model') + 1], 'claude-sonnet-5-5')
  assert.equal(start.args[start.args.indexOf('--effort') + 1], 'high')
  assert.equal(start.args[start.args.indexOf('--allowedTools') + 1], 'mcp__dsh')
  assert.equal(start.cwd, await import('node:fs/promises').then(fs => fs.realpath(workspace)))
  assert.equal(start.env.ANTHROPIC_BASE_URL, 'https://cf.api.fan')
  assert.equal(start.env.CLAUDE_CODE_MAX_RETRIES, '0')
  assert.equal(start.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, '0')
  assert.equal(start.env.ANTHROPIC_API_KEY, undefined, 'an ambient key never reaches the CLI')
  assert.equal(start.env.ANTHROPIC_MODEL, undefined)
  assert.equal(start.env.CLAUDE_CODE_USE_BEDROCK, undefined)
  assert.ok(!JSON.stringify(entries).includes(KEY), 'the key is only in the child environment')

  const requests = entries.filter(entry => entry.kind === 'request')
  assert.deepEqual(requests.map(entry => entry.trigger), ['user', 'tool-results', 'user'])
  assert.deepEqual(requests[0].input, [{ type: 'text', text: '列出文件' }])
  assert.deepEqual(requests[2].input, [{ type: 'text', text: '数一下' }])
  const result = entries.find(entry => entry.kind === 'tool-result')
  assert.equal(result.id, 'toolu_fixture_1')
  assert.deepEqual(result.result.content, [{ type: 'text', text: 'a.txt\nb.txt' }])
  assert.deepEqual(transport.stats(), { live: 1, opened: 1, continued: 2 })
})

test('a changed prompt resumes a new process from DSH\'s own history, signed thinking included', async t => {
  const { step, log } = await harness(t, [
    { blocks: [{ type: 'thinking', thinking: '', signature: 'sig-empty' }, { type: 'tool_use', id: 'toolu_fixture_2', name: 'mcp__dsh__bash', input: { command: 'pwd' } }] },
    { blocks: [{ type: 'text', text: '在工作目录。' }] },
    { blocks: [{ type: 'tool_use', id: 'toolu_plan', name: 'mcp__dsh__exit_plan_mode', input: { plan: '# 计划\n\n1. 改造' } }] },
  ])
  const messages = [user('看看目录')]
  const first = await step(messages)
  messages.push(replay(first), createToolResultMessage({ callId: first.blocks().find(block => block.type === 'tool-call').id, content: [{ type: 'text', text: '/work' }], isError: false }))
  const second = await step(clone(messages))
  messages.push(replay(second), user('计划一下'))
  // Plan mode adds its policy to the system prompt.
  const plan = await step(clone(messages), { system: `${SYSTEM}\n\nPlan mode is active.` })
  assert.equal(plan.finish.kind, 'tool-calls')
  assert.equal(plan.blocks().find(block => block.type === 'tool-call').name, 'exit_plan_mode')

  const starts = (await log()).filter(entry => entry.kind === 'start')
  assert.equal(starts.length, 2)
  assert.equal(starts[1].sessionId, starts[0].sessionId, 'the CLI session id follows the DSH session')
  assert.ok(starts[1].system.includes('Plan mode is active.'))
  const transcript = starts[1].transcript
  assert.deepEqual(transcript.map(entry => entry.type), ['user', 'assistant', 'user', 'assistant'])
  assert.equal(transcript[0].parentUuid, null)
  for (let index = 1; index < transcript.length; index++) assert.equal(transcript[index].parentUuid, transcript[index - 1].uuid)
  assert.deepEqual(transcript[1].message.content[0], { type: 'thinking', thinking: '', signature: 'sig-empty' })
  assert.equal(transcript[1].message.content[1].name, 'mcp__dsh__bash')
  assert.equal(transcript[2].message.content[0].type, 'tool_result')
  assert.ok(!JSON.stringify(transcript).includes('cache_control'), 'cache markers are the CLI\'s to place')
  const requests = (await log()).filter(entry => entry.kind === 'request')
  assert.deepEqual(requests.at(-1).input, [{ type: 'text', text: '计划一下' }])
})

test('an open turn that cannot continue its process resumes with the interrupted-turn switch', async t => {
  const { step, log, useKey } = await harness(t, [
    { blocks: [{ type: 'tool_use', id: 'toolu_fixture_3', name: 'mcp__dsh__bash', input: { command: 'date' } }] },
    { blocks: [{ type: 'text', text: '已继续。' }] },
  ])
  const messages = [user('现在几点')]
  const first = await step(messages)
  messages.push(replay(first), createToolResultMessage({ callId: 'toolu_fixture_3', content: [{ type: 'text', text: '15:00' }], isError: false }))
  // The key rotated after the first step, so its process cannot serve this one.
  useKey(OTHER_KEY)
  const second = await step(clone(messages))
  assert.equal(text(second), '已继续。')
  const entries = await log()
  const starts = entries.filter(entry => entry.kind === 'start')
  assert.equal(starts.length, 2)
  assert.notEqual(starts[1].token, starts[0].token, 'the new process runs with the request\'s key')
  assert.equal(starts[1].env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, '1')
  assert.equal(starts[1].transcript.at(-1).message.content[0].type, 'tool_result')
  assert.equal(entries.filter(entry => entry.kind === 'request').at(-1).trigger, 'resume')
})

test('a steering note beside tool results resumes the open turn instead of riding on the results', async t => {
  const { step, log } = await harness(t, [
    { blocks: [{ type: 'tool_use', id: 'toolu_fixture_4', name: 'mcp__dsh__bash', input: { command: 'ls' } }] },
    { blocks: [{ type: 'text', text: '包含隐藏文件。' }] },
  ])
  const messages = [user('列出文件')]
  const first = await step(messages)
  messages.push(replay(first), createToolResultMessage({ callId: 'toolu_fixture_4', content: [{ type: 'text', text: 'a.txt' }], isError: false }), user('也算上隐藏文件'))
  const second = await step(clone(messages))
  assert.equal(text(second), '包含隐藏文件。')
  const starts = (await log()).filter(entry => entry.kind === 'start')
  assert.equal(starts.length, 2)
  const last = starts[1].transcript.at(-1).message.content
  assert.deepEqual(last.map(block => block.type), ['tool_result', 'text'])
  assert.equal(last[1].text, '也算上隐藏文件')
})

test('a CLI without the tool_use id in MCP calls is still answered by tool name', async t => {
  const { step, log, transport } = await harness(t, [
    { blocks: [{ type: 'tool_use', id: 'toolu_fixture_5', name: 'mcp__dsh__bash', input: { command: 'ls' } }, { type: 'tool_use', id: 'toolu_fixture_6', name: 'mcp__dsh__bash', input: { command: 'pwd' } }] },
    { blocks: [{ type: 'text', text: '好了。' }] },
  ], { env: { FAKE_CLAUDE_NO_META: '1' } })
  const messages = [user('两条命令')]
  const first = await step(messages)
  const calls = first.blocks().filter(block => block.type === 'tool-call')
  assert.equal(calls.length, 2)
  messages.push(replay(first), ...calls.map((call, index) => createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: `result ${index}` }], isError: false })))
  const second = await step(clone(messages))
  assert.equal(text(second), '好了。')
  const results = (await log()).filter(entry => entry.kind === 'tool-result').map(entry => entry.result.content[0].text)
  assert.deepEqual(results, ['result 0', 'result 1'], 'held calls are answered in the order the model made them')
  assert.equal(transport.stats().continued, 1)
})

test('session titles run in a one-shot process that leaves the live conversation alone', async t => {
  const { step, log, transport } = await harness(t, [
    { blocks: [{ type: 'tool_use', id: 'toolu_fixture_7', name: 'mcp__dsh__bash', input: { command: 'ls' } }] },
    { blocks: [{ type: 'text', text: '列出文件' }] },
    { blocks: [{ type: 'text', text: '完成。' }] },
  ])
  const messages = [user('列出文件')]
  const first = await step(messages)
  const title = await step([user('列出文件')], { purpose: 'session-title', system: 'Only a title.' })
  assert.equal(text(title), '列出文件')
  messages.push(replay(first), createToolResultMessage({ callId: 'toolu_fixture_7', content: [{ type: 'text', text: 'a.txt' }], isError: false }))
  const second = await step(clone(messages))
  assert.equal(text(second), '完成。')
  const starts = (await log()).filter(entry => entry.kind === 'start')
  assert.equal(starts.length, 2)
  assert.equal(starts[1].args[starts[1].args.indexOf('--model') + 1], 'claude-haiku-5-5', 'titles run on Haiku')
  assert.deepEqual(starts[1].tools, [])
  assert.notEqual(starts[1].sessionId, starts[0].sessionId)
  assert.equal(transport.stats().continued, 1, 'the live process continued after the title')
})

test('gateway failures relayed by the CLI keep their meaning: quota rotates the key, a client refusal is explained, no CLI retry', async t => {
  const { step, failures, log } = await harness(t, [
    { error: { status: 403, message: '该令牌额度已用尽，请充值', kind: 'authentication_failed', prefix: 'Failed to authenticate. ' } },
    { error: { status: 403, message: '我们检测到您的客户端存在异常，请使用标准 Claude Code 客户端 (request id: 202610171500)', kind: 'authentication_failed', prefix: 'Failed to authenticate. ' } },
    { error: { status: 529, message: 'Overloaded', kind: 'server_error' } },
  ])
  const quota = await step([user('统计订单')])
  assert.equal(quota.finish.kind, 'error')
  assert.match(quota.finish.failure.message, /insufficient quota/u)
  assert.deepEqual(failures.map(failure => failure.kind), ['quota'])

  const policy = await step([user('统计订单')])
  assert.equal(policy.finish.kind, 'error')
  assert.equal(policy.finish.failure.message, explainCliClientPolicyFailure('[Claude Code CLI] 我们检测到您的客户端存在异常，请使用标准 Claude Code 客户端 (request id: 202610171500)'))
  assert.match(policy.finish.failure.message, /官方 Claude Code CLI 发出的请求/u)
  assert.match(policy.finish.failure.message, /request id: 202610171500\)$/u, 'the gateway\'s words end the sentence, without the JSON envelope')
  assert.doesNotMatch(policy.finish.failure.message, /\b40[13]\b/u)
  assert.equal(failures.length, 1, 'a client refusal never moves the key')

  const busy = await step([user('统计订单')])
  assert.equal(busy.finish.kind, 'error')
  assert.match(busy.finish.failure.message, /\b529\b/u)
  assert.equal((await log()).filter(entry => entry.kind === 'request').length, 3, 'one request per step: retries belong to DSH')
})

test('a missing CLI is reported once, with install guidance, and starts nothing', async t => {
  const { step, spawned } = await harness(t, [], { binary: async () => { throw Object.assign(new Error('Claude Code CLI is not installed'), { code: 'CLAUDE_CLI_MISSING' }) } })
  const result = await step([user('你好呀，帮我整理一下')])
  assert.equal(result.finish.kind, 'error')
  assert.equal(result.finish.failure.message, explainCliUnavailable())
  assert.equal(result.finish.failure.code, 'PI_AI_ERROR', 'not a retryable transport failure')
  assert.deepEqual(spawned, [])
})

test('a CLI too old for the plugin\'s options asks for an update', async t => {
  const { step } = await harness(t, [], { env: { FAKE_CLAUDE_REJECT: '--permission-prompts' } })
  const result = await step([user('整理一下')])
  assert.equal(result.finish.kind, 'error')
  assert.equal(result.finish.failure.message, explainCliOutdated(`dsh_cli_outdated: error: unknown option '--permission-prompts'`))
  assert.equal(result.finish.failure.code, 'PI_AI_ERROR')
})

test('a CLI older than the plugin needs is turned away before it starts, by the version its detection found', async t => {
  let detected
  const { step, spawned } = await harness(t, [], {
    // As in the plugin: the version is known once resolving the binary has detected it.
    binary: async () => { detected = '2.1.223'; return '/fixture/bin/claude' },
    version: () => detected,
  })
  const result = await step([user('整理一下')])
  assert.equal(result.finish.kind, 'error')
  assert.equal(result.finish.failure.message, explainCliOutdated('dsh_cli_outdated: Claude Code 2.1.223 is older than 2.1.259'))
  assert.match(result.finish.failure.message, /CLI said: Claude Code 2\.1\.223 is older than 2\.1\.259$/u, 'versions survive the status-number scrub')
  assert.match(result.finish.failure.message, /更新 Claude Code CLI/u)
  assert.equal(result.finish.failure.code, 'PI_AI_ERROR', 'shown once, not retried')
  assert.deepEqual(spawned, [])
})

test('aborting a step stops its CLI process', async t => {
  const { step, transport, log } = await harness(t, [{ delayMs: 5_000, blocks: [{ type: 'text', text: 'too late' }] }])
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  const result = await step([user('慢一点的任务')], { signal: controller.signal })
  assert.equal(result.finish.kind, 'aborted')
  assert.equal(transport.stats().live, 0)
  const starts = (await log()).filter(entry => entry.kind === 'start')
  assert.equal(starts.length, 1)
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.throws(() => process.kill(starts[0].pid, 0), 'the CLI process is gone')
})
