#!/usr/bin/env node
/**
 * Built Claude route checks with fixtures; no DSH changes. `--transport cli`
 * runs the cc route's checks instead, with Claude Code as the agent
 * (scripts/claude-agent-check.mjs); `--cli-path` picks another CLI binary,
 * e.g. an older release to check compatibility.
 */
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BlockAssembler, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { redactSecrets } from '../src/secret-redactor.js'
import { readStoredKey } from './stored-key.mjs'
import { createVisionFixture } from './vision-fixture.mjs'
import { CLAUDE_SCENARIO_VERSION, createBusinessScenario, matchesBusinessAnswer, matchesPlan, PLAN_POLICY } from './claude-scenarios.mjs'

export const CLAUDE_MODELS = Object.freeze(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
export const CLAUDE_CHECK_KINDS = Object.freeze(['text', 'tool', 'image', 'title', 'plan'])
const BASE_SYSTEM = 'You are an assistant inside DeepSeek Harness. Follow the user request using only the supplied DSH tools.'

/** One isolated in-memory ring. Stored credentials can never be changed. */
export async function createClaudeCheck({ key, sessionId = randomUUID(), timeoutMs = 65_000, maxRetries = 0, retryDelayMs = 1500, transport = 'http', builtPath = new URL('../lib/index.js', import.meta.url) } = {}) {
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) throw new Error('Claude checks allow at most two transient retries')
  if (transport !== 'http') throw new Error('The cc route runs Claude Code as the agent; check it with scripts/claude-agent-check.mjs')
  const builtUrl = builtPath instanceof URL ? builtPath : pathToFileURL(resolve(builtPath))
  if (builtUrl.protocol !== 'file:') throw new Error('Claude checks require a local built artifact')
  const { PackyCodeKeyRing, createRouteAdapter } = await import(builtUrl.href)
  let record
  const ring = new PackyCodeKeyRing({ readRecord: async () => record, modifyRecord: async (_id, mutate) => { record = await mutate(record); return record } })
  await ring.add(key, 'native Claude check')
  const scrub = value => redactSecrets(String(value), [key])
  const fixture = createVisionFixture('red')
  const failures = []
  const requests = []
  const adapter = createRouteAdapter({ ring, fallbackSessionId: sessionId, resolveAttachments: () => fixture.attachments,
    keys: { active: () => ring.activeKey(), forRequest: (_model, chosen) => chosen, onKeyFailure: kind => failures.push(kind) },
  })
  const original = globalThis.fetch
  const observedFetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== 'https://cf.api.fan' || url.pathname !== '/v1/messages') throw new Error('Unexpected Claude check target')
    const payload = await request.clone().json()
    const observed = { model: payload.model, effort: payload.output_config?.effort, tools: (payload.tools ?? []).map(tool => tool.name) }
    requests.push(observed)
    try {
      const response = await original(request)
      observed.status = response.status
      observed.contentType = response.headers.get('content-type')
      if (!response.ok) {
        const detail = scrub(await response.clone().text())
        observed.error = detail.slice(0, 500)
        const requestId = /request id:\s*([A-Z0-9-]{10,80})/iu.exec(detail)?.[1]
        if (requestId !== undefined) observed.requestId = requestId
      }
      return response
    } catch (error) {
      observed.error = scrub(error instanceof Error ? error.message : error).slice(0, 500)
      throw error
    }
  }
  globalThis.fetch = observedFetch

  const message = content => createUserMessage({ content, source: { kind: 'user' } })
  async function turn(model, messages, { kind, effort, signal, scenario }) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const requestStart = requests.length
      const assembled = new BlockAssembler()
      const prepared = await adapter.prepareCall('packycode', model, signal)
      for await (const chunk of prepared.stream({
        provider: 'packycode', model, sessionId, reasoningEffort: effort, maxTokens: 2048,
        signal: signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        system: kind === 'title' ? '只回复一个简短中文会话标题，不要 JSON、引号或解释。' : kind === 'plan' ? `${BASE_SYSTEM}\n\n${PLAN_POLICY}` : BASE_SYSTEM,
        messages, ...(scenario.tools === undefined ? {} : { tools: scenario.tools }), ...(kind === 'title' ? { purpose: 'session-title' } : {}),
      })) assembled.push(chunk)
      if (assembled.finish?.kind === 'error') {
        const error = new Error(assembled.finish.failure.message)
        error.code = assembled.finish.failure.code
        if (requests.length > requestStart) requests.at(-1).streamError = { code: error.code, message: scrub(error.message).slice(0, 500) }
        if (attempt < maxRetries && !signal?.aborted && assembled.blocks().length === 0 && ['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'TIMEOUT'].includes(error.code)) {
          await delay(retryDelayMs * (2 ** attempt), undefined, { signal })
          continue
        }
        throw error
      }
      if (requests.length > requestStart) requests.at(-1).streamFinish = assembled.finish?.kind
      return assembled
    }
  }

  return {
    async run({ model, kind = 'text', effort = 'low', signal, variant = 0 } = {}) {
      if (!CLAUDE_MODELS.includes(model) || !CLAUDE_CHECK_KINDS.includes(kind)) throw new Error('Unsupported Claude check')
      const started = Date.now()
      const firstRequest = requests.length
      let answer
      let toolCalls = 0
      const scenario = createBusinessScenario(kind, variant)
      const identity = { model, kind, effort, scenarioVersion: CLAUDE_SCENARIO_VERSION, scenario: scenario.id }
      try {
        const messages = [message([{ type: 'text', text: scenario.prompt }, ...(kind === 'image' ? [fixture.block] : [])])]
        let result = await turn(model, messages, { kind, effort, signal, scenario })
        if (kind === 'plan') {
          // DSH's loop in plan mode: run the read-only lookup, then review the plan.
          let plan
          for (let step = 0; step < 4 && plan === undefined; step++) {
            const calls = result.blocks().filter(block => block.type === 'tool-call')
            if (calls.length === 0) throw new Error(`Plan mode ended without exit_plan_mode (${result.finish?.kind})`)
            messages.push(result.message({ kind: 'model', provider: 'packycode', model, replayState: result.replayState }))
            for (const call of calls) {
              toolCalls += 1
              if (call.name === 'exit_plan_mode') {
                plan = JSON.parse(call.arguments).plan
                if (!matchesPlan(plan)) throw new Error('The submitted plan did not start with a heading about the request')
                messages.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'Plan approved — plan mode exited; carry out the plan starting with your next step.' }], isError: false }))
              } else if (call.name === 'lookup_inventory') {
                messages.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: JSON.stringify(scenario.toolResult) }], isError: false }))
              } else throw new Error(`Plan mode called an unexpected tool: ${call.name}`)
            }
            result = await turn(model, JSON.parse(JSON.stringify(messages)), { kind, effort, signal, scenario })
          }
          if (plan === undefined) throw new Error('No plan was submitted within four steps')
          // After approval the model may start implementing; the check stops there.
          if (!['stop', 'tool-calls'].includes(result.finish?.kind)) throw new Error(`Unexpected finish after approval: ${result.finish?.kind}`)
          const observed = requests.slice(firstRequest)
          return { ...identity, ok: true, recovered: observed.some(request => request.status >= 400 || request.error !== undefined || request.streamError !== undefined), plan: scrub(plan).slice(0, 300), toolCalls, durationMs: Date.now() - started, requests: observed }
        }
        if (kind === 'tool') {
          const calls = result.blocks().filter(block => block.type === 'tool-call')
          toolCalls = calls.length
          if (calls.length !== 1 || calls[0].name !== scenario.tools[0].name) throw new Error('Expected one inventory lookup')
          const args = JSON.parse(calls[0].arguments)
          if (Object.keys(args).length !== 1 || args.sku !== scenario.toolArguments.sku) throw new Error('Inventory lookup SKU did not match the order')
          messages.push(result.message({ kind: 'model', provider: 'packycode', model, replayState: result.replayState }))
          messages.push(createToolResultMessage({ callId: calls[0].id, content: [{ type: 'text', text: JSON.stringify(scenario.toolResult) }], isError: false }))
          result = await turn(model, JSON.parse(JSON.stringify(messages)), { kind, effort, signal, scenario })
        }
        answer = result.blocks().filter(block => block.type === 'text').map(block => block.text).join('').trim()
        if (result.finish?.kind !== 'stop') throw new Error(`Unexpected finish: ${result.finish?.kind}`)
        if (!matchesBusinessAnswer(scenario, answer)) throw new Error('The business answer did not match the supplied records')
        if (kind === 'title') {
          if (requests.at(-1).model !== 'claude-haiku-5-5') throw new Error('Claude title did not use Haiku')
        }
        const observed = requests.slice(firstRequest)
        return { ...identity, ok: true, recovered: observed.some(request => request.status >= 400 || request.error !== undefined || request.streamError !== undefined), answer: scrub(answer), toolCalls, durationMs: Date.now() - started, requests: observed }
      } catch (error) {
        return { ...identity, ok: false, ...(answer === undefined ? {} : { answer: scrub(answer) }), toolCalls, durationMs: Date.now() - started,
          failure: { code: error.code ?? 'CHECK', message: scrub(error instanceof Error ? error.message : error).slice(0, 500) }, requests: requests.slice(firstRequest) }
      }
    },
    async close() {
      if (globalThis.fetch === observedFetch) globalThis.fetch = original
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
  const selected = option('--model', undefined)
  const kind = option('--kind', undefined)
  if (selected !== undefined && !CLAUDE_MODELS.includes(selected)) throw new Error('Unknown Claude model')
  if (kind !== undefined && !CLAUDE_CHECK_KINDS.includes(kind)) throw new Error('Unknown Claude check kind')
  const transport = option('--transport', 'http')
  if (transport === 'cli') {
    const { main: agentMain } = await import('./claude-agent-check.mjs')
    return agentMain(args.filter((arg, index) => arg !== '--transport' && args[index - 1] !== '--transport'))
  }
  const key = await readStoredKey({ label: option('--key-label', undefined) })
  const check = await createClaudeCheck({ key, transport, maxRetries: Number(option('--retry-transient', 0)) })
  try {
    console.log(`stored key: …${key.slice(-4)} · transport: ${transport}`)
    for (const model of selected === undefined ? CLAUDE_MODELS : [selected]) {
      for (const current of kind === undefined ? CLAUDE_CHECK_KINDS : [kind]) {
        const outcome = await check.run({ model, kind: current, effort: option('--effort', 'low') })
        console.log(JSON.stringify(outcome))
        if (!outcome.ok) process.exitCode = 1
      }
    }
  } finally { await check.close() }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => { console.error('Claude check could not start:', error instanceof Error ? error.message : 'unknown error'); process.exitCode = 1 })
}
