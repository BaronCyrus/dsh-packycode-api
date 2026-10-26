#!/usr/bin/env node
/**
 * Live checks of the cc route with Claude Code as the agent, through the
 * built route and this device's Claude Code CLI; no DSH changes.
 *
 * Each check runs in a scratch working directory and an isolated CLI home.
 * DSH's side — the `claude_code` mirror tool, its permission bridge, the
 * approval answer, the question UI and the plan review — is played by the
 * plugin's own bridge on a stand-in agent, in DSH's order; a title is
 * asked for with DSH's own title request. Every request the CLI made is
 * reported with its status; client-anomaly and anti-abuse refusals are
 * counted apart. `--cli-path` picks another CLI binary.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BlockAssembler, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { redactSecrets } from '../src/secret-redactor.js'
import { dshTitleRequest } from '../tests/fixtures/dsh-session-title.mjs'
import { readStoredKey } from './stored-key.mjs'
import { createVisionFixture } from './vision-fixture.mjs'

export const AGENT_MODELS = Object.freeze(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
export const AGENT_CHECK_KINDS = Object.freeze(['read', 'edit', 'deny', 'plan', 'question', 'image', 'title'])
const SYSTEM = 'You are an AI agent powered by DeepSeek Harness.'
/** Tools as a DSH step offers them; a request without any is no agent's step and is answered once. */
const TOOLS = [
  { name: 'bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'exit_plan_mode', description: 'Present the plan.', parameters: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] } },
]
const PRESETS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
}
const APPROVED_PLAN = 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
const STOCK = { items: [{ sku: 'KB-87', onHand: 42, reserved: 7 }] }

/** One check per kind: its prompt, preset, how DSH answers, and how the outcome is judged. */
const SCENARIOS = {
  read: {
    prompt: '读一下当前目录的 stock.json，按其中 KB-87 的现货减已预留算出可用量，再算一张 50 件订单的缺货量。最后只回复 JSON：{"sku","availableUnits","shortageUnits"}。不要修改任何文件。',
    judge: async ({ answer }) => /"availableUnits"\s*:\s*35/u.test(answer) && /"shortageUnits"\s*:\s*15/u.test(answer),
  },
  edit: {
    preset: 'read-only',
    prompt: '把当前目录 stock.json 里 KB-87 的 reserved 改成 9，其他内容不要动。改完说一句话确认。',
    judge: async ({ workspace, approvals }) => approvals.length > 0 && JSON.parse(await readFile(join(workspace, 'stock.json'), 'utf8')).items[0].reserved === 9,
  },
  deny: {
    preset: 'read-only',
    approve: () => 'rejected',
    prompt: '删除当前目录的 stock.json。',
    judge: async ({ workspace, approvals }) => approvals.length > 0 && (await readFile(join(workspace, 'stock.json'), 'utf8').then(() => true, () => false)),
  },
  plan: {
    planActive: true,
    prompt: '给当前目录的 stock.json 加一个商品 MS-24（现货 16，已预留 4）。先在计划模式里给我一份计划审阅，批准后再改文件。',
    judge: async ({ workspace, plans }) => plans.length > 0 && /^#\s+\S/u.test(plans[0]) && JSON.parse(await readFile(join(workspace, 'stock.json'), 'utf8')).items.some(item => item.sku === 'MS-24'),
  },
  question: {
    prompt: '我要给这个项目选数据库。请先用你的提问工具问我选 Postgres 还是 SQLite（两个选项），拿到答案后只用一句话说明你会用哪个。不要改任何文件。',
    answer: request => ({ answers: request.questions.map(question => ({ id: question.id, selected: [question.options?.find(option => /sqlite/iu.test(option.label))?.label ?? question.options?.[0]?.label ?? 'SQLite'] })) }),
    judge: async ({ answer, questions }) => questions.length > 0 && /sqlite/iu.test(answer),
  },
  image: {
    prompt: '素材库需要给这张商品色卡添加颜色标签。请看图片，只回复 JSON：{"color": 英文小写颜色名, "label": 中文颜色名}。',
    image: true,
    judge: async ({ answer }) => /"color"\s*:\s*"red"/u.test(answer) && /红/u.test(answer),
  },
  title: {
    prompt: '请整理今天的仓库发货安排：核对待发订单与可用库存，把缺货订单单独列出，汇总需要采购补货的商品。',
    title: true,
    // A Chinese title about this request, not a best-effort name for nothing.
    judge: async ({ answer }) => /仓库|发货|库存|缺货|补货|订单/u.test(answer) && answer.length <= 60 && !/[\n{}]/u.test(answer),
  },
}

const classify = text => (/客户端存在异常|anomaly in your client/iu.test(text) ? 'anomaly' : /反滥用|anti-abuse/iu.test(text) ? 'abuse' : 'other')

/** A DSH agent as the plugin's bridge sees it: an agent-scoped registry and listeners. */
function standInAgent(id) {
  const tools = new Map()
  const listeners = { 'tools/pre-execute': [], 'tools/result': [] }
  return {
    id, session: { id }, tools, listeners,
    options: { provider: 'packycode' },
    ctx: {
      tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
      on: (name, listener) => { listeners[name].push(listener); return () => {} },
    },
  }
}

export async function createAgentCheck({ key, cliPath, timeoutMs = 240_000, builtPath = new URL('../lib/index.js', import.meta.url) } = {}) {
  const builtUrl = builtPath instanceof URL ? builtPath : pathToFileURL(resolve(builtPath))
  const { PackyCodeKeyRing, createRouteAdapter, createClaudeCliManager, createClaudeCliTransport, createClaudeAgentBridge, sessionUuid } = await import(builtUrl.href)
  const found = await createClaudeCliManager({ explicitPath: () => cliPath ?? '' }).detect({ force: true })
  if (typeof found.path !== 'string') throw new Error('Claude Code CLI is not installed on this device')
  const home = await mkdtemp(join(tmpdir(), 'packy-agent-check-home-'))
  const scrub = value => redactSecrets(String(value), [key])
  const fixture = createVisionFixture('red')
  const requests = []
  const state = {}
  let bridge
  const transport = createClaudeCliTransport({
    binary: async () => found.path, version: () => found.version, configDir: join(home, 'cli'),
    nestedPermission: (sessionKey, request) => bridge.nestedPermission(sessionKey, request),
  })
  bridge = createClaudeAgentBridge({
    transport,
    services: () => ({
      planMode: { get: () => ({ active: state.planActive }), set: (_agent, active) => { state.planActive = active; return 'queued' } },
      permissionPresets: { current: () => state.preset, presets: PRESETS },
      approval: { request: async request => { state.approvals.push(scrub(request.reason)); return state.approve(request) } },
      userQuestions: { ask: async request => { state.questions.push(request.questions.map(question => question.question)); return state.answer(request) } },
    }),
  })
  let record
  const ring = new PackyCodeKeyRing({ readRecord: async () => record, modifyRecord: async (_id, mutate) => { record = await mutate(record); return record } })
  await ring.add(key, 'agent check')
  let agent
  const adapter = createRouteAdapter({
    ring, fallbackSessionId: randomUUID(), resolveAttachments: () => fixture.attachments,
    keys: { active: () => ring.activeKey(), forRequest: (_model, chosen) => chosen, onKeyFailure: () => {} },
    resolveWorkingDirectory: () => state.workspace,
    claudeCli: {
      followsGroups: () => false,
      choose: () => true,
      fetch: async (input, init, meta) => {
        const observed = { model: JSON.parse(init.body).model, ...(meta.purpose === undefined ? {} : { purpose: meta.purpose }) }
        requests.push(observed)
        const own = meta.purpose === undefined && meta.sessionId === sessionUuid(agent.id)
        if (own) bridge.attach(agent)
        const response = await transport.fetch(input, init, own ? { ...meta, ...bridge.permissionModes(agent) } : meta)
        observed.status = response.status
        if (!response.ok) {
          observed.error = scrub(await response.clone().text()).slice(0, 500)
          observed.refusal = classify(observed.error)
        }
        return response
      },
    },
  })

  /** DSH's tool pipeline for one step's calls, in DSH's order. */
  async function runTools(result, signal, plans) {
    const messages = []
    for (const block of result.blocks().filter(item => item.type === 'tool-call')) {
      const exec = { callId: block.id, name: block.name, arguments: JSON.parse(block.arguments), agent, signal }
      let outcome
      if (block.name === 'exit_plan_mode') {
        plans.push(exec.arguments.plan)
        state.planActive = false
        outcome = { content: [{ type: 'text', text: APPROVED_PLAN }], isError: false }
      } else {
        const definition = agent.tools.get(block.name)
        if (definition === undefined) throw new Error(`DSH does not know the tool ${block.name}`)
        const chain = agent.listeners['tools/pre-execute'].reduceRight((next, listener) => () => listener(exec, next), async () => ({ kind: 'allow' }))
        let decision = await chain()
        if (decision.kind === 'ask') {
          state.approvals.push(scrub(decision.reason))
          decision = await state.approve({ toolName: block.name }) === 'allowed-once' ? { kind: 'allow' } : { kind: 'deny', reason: `the user rejected tool "${block.name}"` }
        }
        if (decision.kind === 'allow') {
          try { outcome = { content: definition.output.render(exec.arguments, await definition.execute(exec.arguments, exec)), isError: false } }
          catch (error) { outcome = { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true } }
        } else outcome = { content: [{ type: 'text', text: `Error: ${decision.reason}` }], isError: true }
        for (const listener of agent.listeners['tools/result']) listener(exec, outcome)
      }
      messages.push(createToolResultMessage({ callId: block.id, content: outcome.content, isError: outcome.isError }))
    }
    return messages
  }

  return {
    cliVersion: found.version,
    async run({ model, kind = 'read', effort = 'low' } = {}) {
      if (!AGENT_MODELS.includes(model) || !AGENT_CHECK_KINDS.includes(kind)) throw new Error('Unsupported agent check')
      const scenario = SCENARIOS[kind]
      const started = Date.now()
      const first = requests.length
      const workspace = await mkdtemp(join(tmpdir(), 'packy-agent-check-work-'))
      await writeFile(join(workspace, 'stock.json'), `${JSON.stringify(STOCK, null, 2)}\n`)
      Object.assign(state, { workspace, preset: scenario.preset ?? 'workspace-write', planActive: scenario.planActive === true, approvals: [], questions: [], approve: scenario.approve ?? (() => 'allowed-once'), answer: scenario.answer ?? (() => ({ answers: [] })) })
      agent = standInAgent(`agent-check-${randomUUID()}`)
      const plans = []
      let answer = ''
      let toolCalls = 0
      const signal = AbortSignal.timeout(timeoutMs)
      try {
        const messages = [createUserMessage({ content: [{ type: 'text', text: scenario.prompt }, ...(scenario.image ? [fixture.block] : [])], source: { kind: 'user' } })]
        for (let index = 0; index < 16; index++) {
          const assembled = new BlockAssembler()
          const prepared = await adapter.prepareCall('packycode', model, signal)
          for await (const chunk of prepared.stream(scenario.title
            ? dshTitleRequest([scenario.prompt], { model, sessionId: agent.id, reasoningEffort: effort, signal })
            : { provider: 'packycode', model, sessionId: agent.id, reasoningEffort: effort, signal, system: SYSTEM, messages: JSON.parse(JSON.stringify(messages)), tools: TOOLS })) assembled.push(chunk)
          if (assembled.finish?.kind === 'error') throw Object.assign(new Error(assembled.finish.failure.message), { code: assembled.finish.failure.code })
          messages.push(assembled.message({ kind: 'model', provider: 'packycode', model, replayState: assembled.replayState }))
          answer = assembled.blocks().filter(block => block.type === 'text').map(block => block.text).join('').trim()
          if (assembled.finish?.kind !== 'tool-calls') break
          toolCalls += assembled.blocks().filter(block => block.type === 'tool-call').length
          messages.push(...await runTools(assembled, signal, plans))
        }
        const ok = await scenario.judge({ answer, workspace, approvals: state.approvals, questions: state.questions, plans })
        return { model, kind, ok, answer: scrub(answer).slice(0, 300), toolCalls, approvals: state.approvals.length, questions: state.questions.length, durationMs: Date.now() - started, requests: requests.slice(first), ...(ok ? {} : { failure: { code: 'CHECK', message: 'The outcome did not match the scenario' } }) }
      } catch (error) {
        return { model, kind, ok: false, answer: scrub(answer).slice(0, 300), toolCalls, durationMs: Date.now() - started, failure: { code: error.code ?? 'CHECK', message: scrub(error instanceof Error ? error.message : error).slice(0, 500) }, requests: requests.slice(first) }
      } finally {
        await rm(workspace, { recursive: true, force: true }).catch(() => {})
      }
    },
    stats: () => transport.stats(),
    async close() {
      await transport.close()
      await rm(home, { recursive: true, force: true }).catch(() => {})
    },
  }
}

export async function main(args = process.argv.slice(2)) {
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
  const selected = option('--model', undefined)
  const kind = option('--kind', undefined)
  if (selected !== undefined && !AGENT_MODELS.includes(selected)) throw new Error('Unknown Claude model')
  if (kind !== undefined && !AGENT_CHECK_KINDS.includes(kind)) throw new Error('Unknown agent check kind')
  const key = await readStoredKey({ label: option('--key-label', undefined) })
  const check = await createAgentCheck({ key, cliPath: option('--cli-path', undefined) })
  const tally = { checks: 0, failed: 0, requests: 0, anomaly: 0, abuse: 0, other: 0 }
  try {
    console.log(`stored key: …${key.slice(-4)} · transport: cli, Claude Code as the agent (Claude Code ${check.cliVersion})`)
    for (const model of selected === undefined ? AGENT_MODELS : [selected]) {
      for (const current of kind === undefined ? AGENT_CHECK_KINDS : [kind]) {
        const outcome = await check.run({ model, kind: current, effort: option('--effort', 'low') })
        console.log(JSON.stringify(outcome))
        tally.checks += 1
        if (!outcome.ok) { tally.failed += 1; process.exitCode = 1 }
        for (const request of outcome.requests) {
          tally.requests += 1
          if (request.refusal !== undefined) tally[request.refusal] += 1
        }
      }
    }
    console.log(JSON.stringify({ summary: tally, processes: check.stats() }))
  } finally { await check.close() }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => { console.error('Agent check could not start:', error instanceof Error ? error.message : 'unknown error'); process.exitCode = 1 })
}
