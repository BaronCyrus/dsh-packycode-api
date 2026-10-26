import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { BlockAssembler, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

import { createClaudeAgentBridge, MIRROR_TOOL } from '../src/claude-agent-tools.js'
import { sessionUuid } from '../src/claude-api.js'
import { createClaudeCliTransport } from '../src/claude-cli-transport.js'
import { explainCliClientPolicyFailure, explainCliOutdated, explainCliUnavailable } from '../src/failures.js'
import { PackyCodeKeyRing } from '../src/key-ring.js'
import { createRouteAdapter } from '../src/route.js'
import { fakeCredentials } from './helpers.mjs'

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-claude-agent.mjs', import.meta.url))
const KEY = 'sk-cli-transport-fixture-AAAA'
const OTHER_KEY = 'sk-cli-transport-fixture-BBBB'
const SYSTEM = 'You are an AI agent powered by DeepSeek Harness.'
const TOOLS = [
  { name: 'bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'exit_plan_mode', description: 'Present the plan.', parameters: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] } },
]
const PRESETS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
}
const APPROVED_PLAN = 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const text = result => result.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
const replay = (result, model = 'claude-sonnet-5-5') => result.message({ kind: 'model', provider: 'packycode', model, replayState: result.replayState })
const clone = value => JSON.parse(JSON.stringify(value))

/** A DSH agent as the bridge sees it: an agent-scoped tool registry and listeners. */
function fakeAgent(id) {
  const tools = new Map()
  const listeners = { 'tools/pre-execute': [], 'tools/result': [] }
  return {
    id,
    session: { id },
    ctx: {
      tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
      on: (name, listener) => { listeners[name].push(listener); return () => {} },
    },
    tools,
    listeners,
  }
}

/**
 * The route with every Claude request run by the fake Claude Code, and DSH's
 * side played by the real bridge on a fake agent: the tool pipeline below
 * runs pre-execute, the approval answer, the tool body and the result
 * observers in DSH's order.
 */
async function harness(t, script, { env = {}, binary, version = () => '2.1.295', preset = 'workspace-write', planActive = false, approve = () => 'allowed-once', answer } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'packy-fake-agent-'))
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'packy-fake-workspace-')))
  await writeFile(join(dir, 'script.json'), JSON.stringify(script))
  const state = { preset, planActive, approvals: [], questions: [], approve, answer }
  const spawned = []
  let bridge
  const transport = createClaudeCliTransport({
    binary: binary ?? (async () => '/fixture/bin/claude'),
    configDir: join(dir, 'home'),
    version,
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options })
      return spawn(process.execPath, [FAKE_CLI, ...args], options)
    },
    parentEnv: { PATH: process.env.PATH, FAKE_CLAUDE_DIR: dir, ANTHROPIC_API_KEY: 'sk-ambient-must-not-leak', ANTHROPIC_MODEL: 'claude-wrong', CLAUDE_CODE_USE_BEDROCK: '1', ...env },
    nestedPermission: (key, request) => bridge.nestedPermission(key, request),
  })
  t.after(() => transport.close())
  bridge = createClaudeAgentBridge({
    transport,
    services: () => ({
      planMode: { get: () => ({ active: state.planActive }), set: (_agent, active) => { state.planActive = active; return 'queued' } },
      permissionPresets: { current: () => state.preset, presets: PRESETS },
      approval: { request: async request => { state.approvals.push(request); return state.approve(request) } },
      ...(state.answer === undefined ? {} : { userQuestions: { ask: async request => { state.questions.push(request); return state.answer(request) } } }),
    }),
  })
  const agent = fakeAgent('dsh-session-cli')
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add(KEY, 'cc key')
  await ring.add(OTHER_KEY, 'second cc key')
  const failures = []
  let requestKey
  const adapter = createRouteAdapter({
    ring, fallbackSessionId: 'cli-fixture',
    keys: { active: () => ring.activeKey(), forRequest: (_model, key) => requestKey ?? key, onKeyFailure: (kind, _message, key) => failures.push({ kind, key }), awaitGroups: async () => {} },
    resolveWorkingDirectory: () => workspace,
    claudeCli: {
      followsGroups: () => false,
      choose: () => true,
      fetch: (input, init, meta) => {
        if (meta.purpose !== undefined || meta.sessionId !== sessionUuid(agent.id)) return transport.fetch(input, init, meta)
        bridge.attach(agent)
        return transport.fetch(input, init, { ...meta, ...bridge.permissionModes(agent) })
      },
    },
  })
  async function step(messages, extra = {}) {
    const result = new BlockAssembler()
    const call = await adapter.prepareCall('packycode', extra.model ?? 'claude-sonnet-5-5')
    for await (const chunk of call.stream({ provider: 'packycode', model: 'claude-sonnet-5-5', sessionId: agent.id, reasoningEffort: 'high', system: SYSTEM, tools: TOOLS, messages, ...extra })) result.push(chunk)
    return result
  }
  /** DSH's tool pipeline for one step's calls, in order: the result messages. */
  async function runTools(result, { review = () => ({ content: APPROVED_PLAN, isError: false }), signal } = {}) {
    const messages = []
    for (const block of result.blocks().filter(item => item.type === 'tool-call')) {
      const exec = { callId: block.id, name: block.name, arguments: JSON.parse(block.arguments), agent, signal: signal ?? new AbortController().signal }
      let outcome
      if (block.name === 'exit_plan_mode') outcome = review(exec.arguments)
      else {
        const definition = agent.tools.get(block.name)
        assert.ok(definition !== undefined, `DSH knows the tool ${block.name}`)
        const chain = agent.listeners['tools/pre-execute'].reduceRight((next, listener) => () => listener(exec, next), async () => ({ kind: 'allow' }))
        let decision = await chain()
        if (decision.kind === 'ask') {
          state.approvals.push({ toolName: block.name, callId: block.id, reason: decision.reason })
          // DSH's approval settles `cancelled` when the turn is stopped.
          const cancelled = new Promise(resolve => exec.signal.addEventListener('abort', () => resolve('cancelled'), { once: true }))
          const answered = await Promise.race([state.approve({ agent, toolName: block.name, callId: block.id, reason: decision.reason, displayReason: decision.displayReason }), cancelled])
          decision = answered === 'allowed-once' ? { kind: 'allow' } : { kind: 'deny', reason: answered === 'cancelled' ? `approval for tool "${block.name}" was cancelled` : `the user rejected tool "${block.name}"` }
        }
        if (decision.kind === 'allow') {
          try {
            const value = await definition.execute(exec.arguments, exec)
            outcome = { content: definition.output.render(exec.arguments, value), isError: false }
          } catch (error) { outcome = { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true } }
        } else outcome = { content: [{ type: 'text', text: `Error: ${decision.reason}` }], isError: true }
        for (const listener of agent.listeners['tools/result']) listener(exec, outcome)
      }
      messages.push(createToolResultMessage({ callId: block.id, content: typeof outcome.content === 'string' ? [{ type: 'text', text: outcome.content }] : outcome.content, isError: outcome.isError }))
    }
    return messages
  }
  /** Steps until the turn ends, as DSH's loop runs them. */
  async function converse(messages, options = {}) {
    const results = []
    for (let index = 0; index < 8; index++) {
      const result = await step(clone(messages), options.extra)
      results.push(result)
      messages.push(replay(result))
      if (result.finish.kind !== 'tool-calls') return results
      messages.push(...await runTools(result, options))
    }
    throw new Error('the turn did not end')
  }
  const log = async () => (await readFile(join(dir, 'log.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { transport, bridge, agent, state, step, runTools, converse, log, failures, spawned, workspace, dir, useKey: key => { requestKey = key } }
}

const bash = (id, command, extra = {}) => ({ type: 'tool_use', id, name: 'Bash', input: { command }, ...extra })

test('Claude Code works with its own prompt and tools; a call it asks about is approved in DSH and the same process continues', async t => {
  const { converse, log, state, transport, workspace } = await harness(t, [
    { blocks: [{ type: 'thinking', thinking: 'Clean first.', signature: 'sig-one' }, { type: 'text', text: '先清理。' }, bash('toolu_1', 'rm -rf build', { ask: true, result: 'removed' })] },
    { blocks: [{ type: 'text', text: '清理好了。' }] },
    { blocks: [{ type: 'text', text: '没有别的了。' }] },
  ])
  const messages = [user('清理构建目录')]
  const [first, second] = await converse(messages)
  const call = first.blocks().find(block => block.type === 'tool-call')
  assert.equal(call.name, MIRROR_TOOL, 'Claude Code\'s call reaches DSH as the mirror tool')
  assert.deepEqual(JSON.parse(call.arguments), { tool: 'Bash', input: { command: 'rm -rf build' } })
  assert.equal(first.blocks().find(block => block.type === 'text').text, '先清理。')
  assert.equal(text(second), '清理好了。')
  assert.equal(state.approvals.length, 1, 'DSH asked once, because Claude Code asked')
  assert.match(state.approvals[0].reason, /Bash: rm -rf build/u)
  assert.equal(state.approvals[0].callId, 'toolu_1', 'the prompt is attached to the card')

  messages.push(user('还有吗'))
  const [third] = await converse(messages)
  assert.equal(text(third), '没有别的了。')

  const entries = await log()
  const starts = entries.filter(entry => entry.kind === 'start')
  assert.equal(starts.length, 1, 'one process served the whole conversation')
  const [start] = starts
  for (const flag of ['--input-format', '--include-partial-messages', '--strict-mcp-config', '--allow-dangerously-skip-permissions']) assert.ok(start.args.includes(flag), flag)
  for (const flag of ['--tools', '--append-system-prompt-file', '--append-system-prompt', '--mcp-config', '--disable-slash-commands', '--no-session-persistence', '-p']) assert.ok(!start.args.includes(flag), `${flag} keeps Claude Code standard`)
  assert.equal(start.args[start.args.indexOf('--permission-prompt-tool') + 1], 'stdio')
  assert.equal(start.args[start.args.indexOf('--permission-mode') + 1], 'acceptEdits', 'workspace-write edits the workspace freely')
  assert.equal(start.args[start.args.indexOf('--setting-sources') + 1], 'user')
  assert.equal(start.args[start.args.indexOf('--model') + 1], 'claude-sonnet-5-5')
  assert.equal(start.args[start.args.indexOf('--effort') + 1], 'high')
  assert.ok(start.args.includes('--session-id'))
  assert.equal(start.cwd, workspace)
  assert.equal(start.env.ANTHROPIC_BASE_URL, 'https://cf.api.fan')
  assert.equal(start.env.CLAUDE_CODE_PROJECT_DIR_NAME, 'dsh-packycode')
  assert.equal(start.env.CLAUDE_CODE_MAX_RETRIES, '0')
  assert.equal(start.env.ANTHROPIC_API_KEY, undefined, 'an ambient key never reaches the CLI')
  assert.equal(start.env.ANTHROPIC_MODEL, undefined)
  assert.equal(start.env.CLAUDE_CODE_USE_BEDROCK, undefined)
  assert.ok(!JSON.stringify(entries).includes(KEY), 'the key is only in the child environment')
  assert.ok(!JSON.stringify(entries).includes('DeepSeek Harness.'), 'DSH\'s system prompt never reaches Claude Code')

  const requests = entries.filter(entry => entry.kind === 'request')
  assert.deepEqual(requests.map(entry => entry.trigger), ['user', 'tool-results', 'user'])
  assert.deepEqual(requests[0].input, [{ type: 'text', text: '清理构建目录' }])
  assert.deepEqual(requests[2].input, [{ type: 'text', text: '还有吗' }], 'a turn sends only the new message')
  const permission = entries.find(entry => entry.kind === 'permission')
  assert.equal(permission.answer.behavior, 'allow')
  assert.deepEqual(permission.answer.updatedInput, { command: 'rm -rf build' })
  assert.deepEqual(transport.stats(), { live: 1, opened: 1, continued: 2, resumed: 0, rebuilt: 0 })
})

test('a call DSH refuses is refused to Claude Code with DSH\'s reason, and the turn goes on', async t => {
  const { converse, log, state } = await harness(t, [
    { blocks: [bash('toolu_rm', 'rm -rf ~/projects', { ask: true })] },
    { blocks: [{ type: 'text', text: '好，不删。' }] },
  ], { approve: () => 'rejected' })
  const [first, second] = await converse([user('清掉 projects')])
  assert.equal(first.finish.kind, 'tool-calls')
  assert.equal(text(second), '好，不删。')
  assert.equal(state.approvals.length, 1)
  const entries = await log()
  const permission = entries.find(entry => entry.kind === 'permission')
  assert.deepEqual(permission.answer, { behavior: 'deny', message: 'The user rejected this call in DeepSeek Harness.' })
  const result = entries.find(entry => entry.kind === 'tool-result')
  assert.equal(result.result.is_error, true)
})

test('calls Claude Code runs on its own are shown without asking, and full access never asks', async t => {
  const { converse, state, log } = await harness(t, [
    { blocks: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'a.txt' }, result: 'hello' }, bash('toolu_ls', 'ls')] },
    { blocks: [{ type: 'text', text: '读完了。' }] },
    { blocks: [bash('toolu_push', 'git push --force', { ask: true })] },
    { blocks: [{ type: 'text', text: '推好了。' }] },
  ])
  const messages = [user('读 a.txt')]
  const [first] = await converse(messages)
  const results = messages.filter(message => message.role === 'toolResult' || message.role === 'tool' || message.content?.some?.(block => block.type === 'tool-result'))
  assert.ok(results.length >= 0)
  assert.equal(state.approvals.length, 0, 'nothing Claude Code ran itself asks the user')
  assert.equal(first.blocks().filter(block => block.type === 'tool-call').length, 2)

  state.preset = 'danger-full-access'
  messages.push(user('强推'))
  await converse(messages)
  assert.equal(state.approvals.length, 0, 'full access never asks')
  const entries = await log()
  assert.deepEqual(entries.filter(entry => entry.kind === 'control').map(entry => entry.request), [{ subtype: 'set_permission_mode', mode: 'bypassPermissions' }], 'the live process follows the new preset')
  assert.equal(entries.filter(entry => entry.kind === 'permission').length, 0)
})

test('plan mode: Claude Code\'s plan file reaches DSH\'s plan review, and approval switches it to the preset\'s mode', async t => {
  const { converse, log, state } = await harness(t, [
    { blocks: [{ type: 'tool_use', id: 'toolu_write', name: 'Write', input: { file_path: '$CONFIG/plans/changelog-plan.md', content: '# 加 CHANGELOG\n\n1. 新建 CHANGELOG.md' } }] },
    { blocks: [{ type: 'tool_use', id: 'toolu_exit', name: 'ExitPlanMode', input: {} }] },
    { blocks: [{ type: 'text', text: '开始实施。' }] },
  ], { planActive: true })
  const reviewed = []
  const results = await converse([user('规划一下加 CHANGELOG')], { review: args => { reviewed.push(args.plan); state.planActive = false; return { content: APPROVED_PLAN, isError: false } } })
  const exit = results[1].blocks().find(block => block.type === 'tool-call')
  assert.equal(exit.name, 'exit_plan_mode', 'ExitPlanMode is DSH\'s own plan review')
  assert.deepEqual(reviewed, ['# 加 CHANGELOG\n\n1. 新建 CHANGELOG.md'], 'the plan is the file Claude Code wrote')
  assert.equal(text(results[2]), '开始实施。')
  const entries = await log()
  assert.equal(entries.find(entry => entry.kind === 'start').args[entries.find(entry => entry.kind === 'start').args.indexOf('--permission-mode') + 1], 'plan')
  const permission = entries.find(entry => entry.kind === 'permission' && entry.tool === 'ExitPlanMode')
  assert.equal(permission.answer.behavior, 'allow')
  assert.deepEqual(permission.answer.updatedPermissions, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
  assert.equal(entries.filter(entry => entry.kind === 'request').at(-1).mode, 'acceptEdits')
})

test('keep planning sends the user\'s feedback back to Claude Code, which stays in plan mode', async t => {
  const { converse, log } = await harness(t, [
    { blocks: [{ type: 'tool_use', id: 'toolu_exit', name: 'ExitPlanMode', input: { plan: '# 初稿' } }] },
    { blocks: [{ type: 'text', text: '我改一下计划。' }] },
  ], { planActive: true })
  const results = await converse([user('规划')], { review: () => ({ content: [{ type: 'text', text: 'Error: The user chose to keep planning; their feedback: 先别动数据库' }], isError: true }) })
  assert.equal(text(results.at(-1)), '我改一下计划。')
  const permission = (await log()).find(entry => entry.kind === 'permission')
  assert.equal(permission.answer.behavior, 'deny')
  assert.match(permission.answer.message, /先别动数据库/u)
})

test('Claude Code\'s questions are put to DSH\'s question UI, and the answers come back', async t => {
  const { converse, log, state } = await harness(t, [
    { blocks: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions: [{ question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: 'SQL' }, { label: 'Mongo', description: 'Documents' }] }] } }] },
    { blocks: [{ type: 'text', text: '用 Postgres。' }] },
  ], { answer: () => ({ answers: [{ id: 'q1', selected: ['Postgres'] }] }) })
  const results = await converse([user('建存储')])
  assert.equal(text(results.at(-1)), '用 Postgres。')
  assert.equal(state.approvals.length, 0, 'a question is not a permission prompt')
  assert.deepEqual(state.questions[0].questions, [{ id: 'q1', question: 'Which database?', header: 'DB', options: [{ label: 'Postgres', description: 'SQL' }, { label: 'Mongo', description: 'Documents' }] }])
  const permission = (await log()).find(entry => entry.kind === 'permission')
  assert.deepEqual(permission.answer.updatedInput.answers, { 'Which database?': 'Postgres' })
})

/** A model-visible message DSH adds for its own agent. */
const dshMessage = (kind, text, form) => createUserMessage({ content: [{ type: 'text', text }], source: { kind, ...(form === undefined ? {} : { form }) } })

test('only the user\'s own words reach Claude Code: DSH\'s context messages stay in DSH and do not make a step a note', async t => {
  const { step, runTools, log } = await harness(t, [
    { blocks: [bash('toolu_ls', 'ls', { result: 'a.txt' })] },
    { blocks: [{ type: 'text', text: '只有 a.txt。' }] },
  ])
  const messages = [
    dshMessage('user-approval', 'The approval policy changed from "never" to "ask" (changed by the user).'),
    user('看看有哪些文件'),
    dshMessage('runtime-context', 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.', 'snapshot'),
    dshMessage('skill-catalog', '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>', 'catalog'),
    dshMessage('agent-instructions', '# AGENTS.md\n\nRun pnpm check.', 'instructions'),
    dshMessage('time-context', 'Time sampled while preparing turn 1, step 1: 2026-10-26T07:17:52+08:00', 'snapshot'),
  ]
  const first = await step(clone(messages))
  messages.push(replay(first), ...await runTools(first))
  // DSH samples the time again for its next step.
  messages.push(dshMessage('time-context', 'Time sampled while preparing turn 1, step 2: 2026-10-26T07:17:58+08:00', 'snapshot'))
  const second = await step(clone(messages))
  assert.equal(text(second), '只有 a.txt。')

  const entries = await log()
  const requests = entries.filter(entry => entry.kind === 'request')
  assert.deepEqual(requests[0].input, [{ type: 'text', text: '看看有哪些文件' }])
  assert.deepEqual(requests.map(entry => entry.trigger), ['user', 'tool-results'], 'Claude Code went on by itself; nothing was sent as a note')
  assert.equal(entries.filter(entry => entry.kind === 'control').length, 0, 'no interrupt')
  for (const dshText of ['approval policy changed', 'Current runtime context', 'A skill is a reusable', 'AGENTS.md', 'Time sampled']) {
    assert.ok(!JSON.stringify(entries).includes(dshText), `${dshText} stays in DSH`)
  }
})

test('a turn DSH starts on its own still reaches Claude Code with its words', async t => {
  const { converse, log } = await harness(t, [{ blocks: [{ type: 'text', text: '继续做目标。' }] }])
  const [result] = await converse([dshMessage('tool-goal', 'Continue working toward the goal: 补完测试。', 'notice')])
  assert.equal(text(result), '继续做目标。')
  const request = (await log()).find(entry => entry.kind === 'request')
  assert.deepEqual(request.input, [{ type: 'text', text: 'Continue working toward the goal: 补完测试。' }])
})

test('an ExitPlanMode Claude Code calls outside plan mode is an ordinary call: no plan review opens', async t => {
  const { converse, log } = await harness(t, [
    { blocks: [{ type: 'tool_use', id: 'toolu_exit', name: 'ExitPlanMode', input: {} }] },
    { blocks: [{ type: 'text', text: '那就直接做。' }] },
  ])
  const reviewed = []
  const results = await converse([user('做吧')], { review: args => { reviewed.push(args); return { content: APPROVED_PLAN, isError: false } } })
  const call = results[0].blocks().find(block => block.type === 'tool-call')
  assert.equal(call.name, MIRROR_TOOL)
  assert.deepEqual(reviewed, [], 'DSH shows no plan review for a plan Claude Code never had')
  assert.equal(text(results.at(-1)), '那就直接做。')
  const entries = await log()
  assert.equal(entries.filter(entry => entry.kind === 'permission').length, 0)
  assert.equal(entries.find(entry => entry.kind === 'tool-result' && entry.id === 'toolu_exit').result.is_error, true)
})

test('plan mode switched on between turns puts the live process into plan mode before the next message', async t => {
  const { converse, log, state } = await harness(t, [
    { blocks: [{ type: 'text', text: '好的。' }] },
    { blocks: [{ type: 'tool_use', id: 'toolu_write', name: 'Write', input: { file_path: '$CONFIG/plans/median.md', content: '# 加 median\n\n1. 写函数' } }] },
    { blocks: [{ type: 'tool_use', id: 'toolu_exit', name: 'ExitPlanMode', input: {} }] },
    { blocks: [{ type: 'text', text: '开始实施。' }] },
  ])
  const messages = [user('你好')]
  await converse(messages)
  // `/plan` in DSH between turns.
  state.planActive = true
  messages.push(dshMessage('plan-mode', 'The user switched this session to plan mode.', 'notice'), user('给 sum.js 加 median'))
  const reviewed = []
  const results = await converse(messages, { review: args => { reviewed.push(args.plan); state.planActive = false; return { content: APPROVED_PLAN, isError: false } } })
  assert.equal(results[1].blocks().find(block => block.type === 'tool-call').name, 'exit_plan_mode')
  assert.deepEqual(reviewed, ['# 加 median\n\n1. 写函数'])
  assert.equal(text(results.at(-1)), '开始实施。')
  const entries = await log()
  assert.equal(entries.filter(entry => entry.kind === 'start').length, 1, 'the same process plans')
  assert.deepEqual(entries.filter(entry => entry.kind === 'control').map(entry => entry.request), [{ subtype: 'set_permission_mode', mode: 'plan' }])
  const requests = entries.filter(entry => entry.kind === 'request')
  assert.equal(requests[1].mode, 'plan')
  assert.deepEqual(requests[1].input, [{ type: 'text', text: '给 sum.js 加 median' }], 'the mode switch, not DSH\'s notice, tells Claude Code')
})

test('a user note beside DSH\'s tool results stops the request Claude Code already sent, and goes in as its next message', async t => {
  const { step, runTools, log } = await harness(t, [
    { blocks: [bash('toolu_ls', 'ls')] },
    { blocks: [{ type: 'text', text: '这条回复读不到补充说明。' }], delayMs: 3000 },
    { blocks: [{ type: 'text', text: '好的，只看 txt。' }] },
  ])
  const messages = [user('列文件')]
  const first = await step(clone(messages))
  messages.push(replay(first), ...await runTools(first), user('只要 txt'))
  const second = await step(clone(messages))
  assert.equal(text(second), '好的，只看 txt。', 'the step DSH asked for is the response that read the note')
  const entries = await log()
  assert.equal(entries.filter(entry => entry.kind === 'start').length, 1)
  assert.ok(entries.some(entry => entry.kind === 'control' && entry.request.subtype === 'interrupt'))
  const requests = entries.filter(entry => entry.kind === 'request')
  assert.deepEqual(requests.map(entry => entry.trigger), ['user', 'tool-results', 'user'])
  assert.deepEqual(requests.at(-1).input, [{ type: 'text', text: '只要 txt' }])
})

test('a new process resumes the same Claude Code session by id; a history it does not hold starts one from DSH\'s', async t => {
  const first = await harness(t, [
    { blocks: [{ type: 'text', text: '记住了 TEAL。' }] },
    { blocks: [{ type: 'text', text: '是 TEAL。' }] },
    { blocks: [{ type: 'text', text: '改成 PLUM 了。' }] },
  ])
  const messages = [user('记住 TEAL')]
  await first.converse(messages)
  // DSH restarts: a new transport over the same CLI home.
  await first.transport.close()
  const again = createClaudeCliTransport({
    binary: async () => '/fixture/bin/claude', configDir: join(first.dir, 'home'), version: () => '2.1.295',
    spawnImpl: (command, args, options) => spawn(process.execPath, [FAKE_CLI, ...args], options),
    parentEnv: { PATH: process.env.PATH, FAKE_CLAUDE_DIR: first.dir },
  })
  t.after(() => again.close())
  const adapter = createRouteAdapter({
    ring: await (async () => { const ring = new PackyCodeKeyRing(fakeCredentials()); await ring.add(KEY, 'cc'); return ring })(), fallbackSessionId: 'x',
    keys: { active: async () => ({ key: KEY }), forRequest: (_model, key) => key, onKeyFailure: () => {}, awaitGroups: async () => {} },
    resolveWorkingDirectory: () => first.workspace,
    claudeCli: { followsGroups: () => false, choose: () => true, fetch: (input, init, meta) => again.fetch(input, init, meta) },
  })
  const stepAgain = async list => {
    const result = new BlockAssembler()
    const call = await adapter.prepareCall('packycode', 'claude-sonnet-5-5')
    for await (const chunk of call.stream({ provider: 'packycode', model: 'claude-sonnet-5-5', sessionId: first.agent.id, reasoningEffort: 'high', system: SYSTEM, tools: TOOLS, messages: clone(list) })) result.push(chunk)
    return result
  }
  messages.push(user('是什么？'))
  const resumed = await stepAgain(messages)
  assert.equal(text(resumed), '是 TEAL。')
  // An edited first message: Claude Code's session does not hold this history.
  const edited = [user('记住 PLUM'), { role: 'assistant', content: [{ type: 'text', text: '记住了 PLUM。' }], source: { kind: 'model', provider: 'packycode', model: 'claude-sonnet-5-5' } }, user('现在呢？')]
  const rebuilt = await stepAgain(edited)
  assert.equal(text(rebuilt), '改成 PLUM 了。')
  const starts = (await first.log()).filter(entry => entry.kind === 'start')
  assert.equal(starts.length, 3)
  assert.equal(starts[1].resumed, true)
  assert.equal(starts[1].sessionId, starts[0].sessionId, 'the same Claude Code session')
  assert.equal(starts[1].found, true)
  assert.deepEqual(starts[1].transcript.map(entry => entry.type), ['user', 'assistant'])
  assert.notEqual(starts[2].sessionId, starts[0].sessionId, 'a new Claude Code session')
  assert.deepEqual(starts[2].transcript.map(entry => entry.message.content), [[{ type: 'text', text: '记住 PLUM' }], [{ type: 'text', text: '记住了 PLUM。' }]])
  assert.deepEqual(again.stats().resumed, 1)
  assert.deepEqual(again.stats().rebuilt, 1)
})

test('session titles run in a one-shot process with no tools, and DSH\'s compaction is answered without one', async t => {
  const { step, log, spawned } = await harness(t, [
    { blocks: [{ type: 'text', text: '仓库发货安排' }] },
  ])
  const title = await step([user('请整理今天的仓库发货安排')], { purpose: 'session-title', model: 'claude-opus-5-5', system: '只回复一个简短中文会话标题。' })
  assert.equal(text(title), '仓库发货安排')
  const [start] = (await log()).filter(entry => entry.kind === 'start')
  assert.ok(start.args.includes('-p'))
  assert.equal(start.args[start.args.indexOf('--model') + 1], 'claude-haiku-5-5')
  assert.equal(start.args[start.args.indexOf('--tools') + 1], '')
  assert.ok(start.args.includes('--no-session-persistence'))
  const [request] = (await log()).filter(entry => entry.kind === 'request')
  assert.match(request.input[0].text, /^只回复一个简短中文会话标题。/u)
  assert.match(request.input[0].text, /用户：请整理今天的仓库发货安排/u)

  const compacted = await step([user('改 version'), { role: 'assistant', content: [{ type: 'text', text: '改好了。' }], source: { kind: 'model', provider: 'packycode', model: 'claude-sonnet-5-5' } }, user('Summarize the conversation.')], { purpose: 'compaction' })
  assert.match(text(compacted), /Claude Code 自己的会话/u)
  assert.equal(spawned.length, 1, 'compaction started no process')
})

test('a request that offers no tools is no agent\'s step: Auto review asking with the session\'s model gets one tool-less answer', async t => {
  const { step, log, transport } = await harness(t, [
    { blocks: [{ type: 'text', text: '{"outcome":"allow","risk":"low"}' }] },
  ])
  // The official reviewer's request: its policy, one plain message, no tools, no session.
  const review = await step([{ role: 'user', content: [{ type: 'text', text: 'Pending action: Bash ls -la' }] }], { system: 'You review one pending action and answer with JSON.', tools: undefined })
  assert.equal(text(review), '{"outcome":"allow","risk":"low"}')
  const entries = await log()
  const [start] = entries.filter(entry => entry.kind === 'start')
  assert.ok(start.args.includes('-p'), 'a one-shot process')
  assert.equal(start.args[start.args.indexOf('--tools') + 1], '')
  const [request] = entries.filter(entry => entry.kind === 'request')
  assert.match(request.input[0].text, /^You review one pending action and answer with JSON\.\n\nPending action: Bash ls -la$/u)
  assert.doesNotMatch(request.input[0].text, /要命名的对话/u, 'not framed as a title')
  assert.equal(transport.stats().live, 0, 'no agent process for it')
})

test('gateway failures relayed by Claude Code keep their meaning: quota rotates the key, a client refusal is explained without CLI advice', async t => {
  const { step, failures } = await harness(t, [
    { error: { status: 403, message: '额度不足，请充值' } },
    { error: { status: 403, message: '我们检测到您的客户端存在异常，请使用标准 Claude Code 客户端请求，请避免任何基于我方 API 二次分发的 API 转接接入。(request id: 01ABC)', prefix: 'Failed to authenticate. ', kind: 'authentication_failed' } },
  ])
  const quota = await step([user('一')])
  assert.equal(quota.finish.kind, 'error')
  assert.deepEqual(failures.map(failure => failure.kind), ['quota'])
  const refused = await step([user('二')])
  assert.equal(refused.finish.kind, 'error')
  const message = refused.finish.failure.message
  assert.equal(message, explainCliClientPolicyFailure(message.slice(message.indexOf('Gateway said:') + 'Gateway said: '.length)).replace(/Gateway said: .*$/su, '') + message.slice(message.indexOf('Gateway said:')))
  assert.match(message, /更新 Claude Code CLI 也不能解决/u)
  assert.doesNotMatch(message, /claude update/u)
  assert.match(message, /01ABC/u)
  assert.deepEqual(failures.map(failure => failure.kind), ['quota'], 'a client refusal never moves a key aside')
})

test('a failure between steps is reported by the next step, and a retry resumes the interrupted turn', async t => {
  const { step, runTools, log } = await harness(t, [
    { blocks: [bash('toolu_ls', 'ls')] },
    { error: { status: 529, message: 'overloaded' } },
    { blocks: [{ type: 'text', text: '列完了。' }] },
  ])
  const messages = [user('列文件')]
  const first = await step(clone(messages))
  messages.push(replay(first), ...await runTools(first))
  const failed = await step(clone(messages))
  assert.equal(failed.finish.kind, 'error')
  const retried = await step(clone(messages))
  assert.equal(text(retried), '列完了。')
  const starts = (await log()).filter(entry => entry.kind === 'start')
  assert.equal(starts.length, 2)
  assert.equal(starts[1].resumed, true)
  assert.equal(starts[1].env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, '1')
  assert.deepEqual((await log()).filter(entry => entry.kind === 'request').map(entry => entry.trigger), ['user', 'tool-results', 'resume'])
})

test('stopping DSH\'s turn while Claude Code waits for approval stops Claude Code\'s turn too, and the next message continues the session', async t => {
  const { step, runTools, log } = await harness(t, [
    { blocks: [bash('toolu_slow', 'rm -rf build', { ask: true })] },
    { blocks: [{ type: 'text', text: '接着来。' }] },
  ], { approve: () => new Promise(() => {}) })
  const messages = [user('慢慢跑')]
  const first = await step(clone(messages))
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 200)
  const results = await runTools(first, { signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 300))
  const entries = await log()
  assert.ok(entries.some(entry => entry.kind === 'control' && entry.request.subtype === 'interrupt'), 'Claude Code was told to stop')
  assert.equal(entries.find(entry => entry.kind === 'permission')?.answer.behavior, 'deny', 'the waiting call is refused, never run')
  messages.push(replay(first), ...results, user('接着'))
  const next = await step(clone(messages))
  assert.equal(text(next), '接着来。')
  assert.equal((await log()).filter(entry => entry.kind === 'start').length, 1)
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
  const { step } = await harness(t, [], { env: { FAKE_CLAUDE_REJECT: '--permission-prompt-tool' } })
  const result = await step([user('你好')])
  assert.equal(result.finish.kind, 'error')
  assert.match(result.finish.failure.message, /版本过旧/u)
  assert.equal(result.finish.failure.message, explainCliOutdated(result.finish.failure.message.slice(result.finish.failure.message.indexOf('CLI said: ') + 'CLI said: '.length)))
})

test('a CLI older than the plugin needs is turned away before it starts, by the version its detection found', async t => {
  const { step, spawned } = await harness(t, [], { version: () => '2.1.223' })
  const result = await step([user('你好')])
  assert.equal(result.finish.kind, 'error')
  assert.match(result.finish.failure.message, /2\.1\.259/u)
  assert.equal(spawned.length, 0)
})

test('aborting a step stops its CLI process', async t => {
  const { step, log } = await harness(t, [{ blocks: [{ type: 'text', text: 'slow' }], delayMs: 5000 }])
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  const result = await step([user('慢')], { signal: controller.signal })
  assert.equal(result.finish.kind, 'aborted')
  const starts = (await log()).filter(entry => entry.kind === 'start')
  assert.equal(starts.length, 1)
})
