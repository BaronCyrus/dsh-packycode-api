import assert from 'node:assert/strict'
import test from 'node:test'
import { format } from 'node:util'

import { answerChunks } from '../src/auto-review.js'
import { createAutoReviewController, DSH_AUTO_REVIEW_ROW, readAutoReviewChoice } from '../src/auto-review-controller.js'
import { OFFICIAL_POLICY, officialRequest, readDecision } from './fixtures/official-auto-review.mjs'

const SNAPSHOT = {
  cwd: '/work/project',
  projectInstructions: [],
  history: [{ kind: 'user-message', role: 'human-instruction', source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: 'run the tests' }] }],
  action: { mode: 'native', name: 'bash', description: 'Run a shell command.', parameters: { type: 'object' }, arguments: { command: 'pnpm test' } },
}

/** The controller around fakes for Jev, DSH's LLM service and the host lookups. */
function harness({ model = 'jev-latest', jev, flashAnswer = '{"risk":"low","decision":"allow"}', entry, presets = [], writable = true } = {}) {
  const values = { autoReviewModel: model }
  const writes = []
  const logs = []
  const reviews = []
  const streamed = []
  let controller
  const stream = options => {
    streamed.push(options)
    // DSH's service runs the waterfall again; the listener must let it through.
    let reachedAdapter = false
    const reroutedAgain = controller.listener(options, () => {
      reachedAdapter = true
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'reasoning-delta', index: 0, text: 'thinking' }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } }
        for (const chunk of answerChunks(flashAnswer)) yield chunk.type === 'finish' ? chunk : { ...chunk, index: chunk.index + 1, ...(chunk.block ? { block: chunk.block } : {}) }
      })()
    })
    return (async function* () {
      yield* reroutedAgain
      assert.equal(reachedAdapter, true, 'the re-addressed request reaches the adapter')
    })()
  }
  controller = createAutoReviewController({
    jev: {
      async review(policy, sections, signal) {
        reviews.push({ policy, sections, signal })
        return typeof jev === 'function' ? jev(policy, sections, signal) : { decision: 'allow', risk: 'low', version: 'jev-1.14.0' }
      },
    },
    stream,
    readPreference: () => values,
    writePreference: async patch => {
      writes.push(patch)
      Object.assign(values, patch)
    },
    isWritable: () => writable,
    loaderEntry: id => (id === DSH_AUTO_REVIEW_ROW ? entry : undefined),
    presetNames: () => presets,
    logger: { info: (...args) => logs.push(['info', format(...args)]), warn: (...args) => logs.push(['warn', format(...args)]) },
  })
  const sessionModel = () => (async function* () { throw new Error('the session model must not answer this review') })()
  return { controller, values, writes, logs, reviews, streamed, sessionModel }
}

test('the stored preference reads as jev-latest unless it names another reviewer', () => {
  assert.deepEqual(readAutoReviewChoice(undefined), { model: 'jev-latest' })
  assert.deepEqual(readAutoReviewChoice({ autoReviewModel: { get: () => 'session' } }), { model: 'session' })
  assert.deepEqual(readAutoReviewChoice({ autoReviewModel: 'deepseek-flash' }), { model: 'deepseek-flash' })
  assert.deepEqual(readAutoReviewChoice({ autoReviewModel: 'gpt-6.1-sol' }), { model: 'jev-latest' })
})

test('every request that is not the official review goes on untouched', () => {
  const { controller, reviews } = harness()
  const next = () => 'the rest of the waterfall'
  const turn = { provider: 'packycode', model: 'deepseek-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  assert.equal(controller.listener(turn, next), 'the rest of the waterfall')
  assert.equal(controller.listener({ ...officialRequest(SNAPSHOT), system: 'Summarize this session.' }, next), 'the rest of the waterfall')
  assert.equal(reviews.length, 0)
})

test('with the session model chosen, the official review is left to DSH', () => {
  const { controller, reviews } = harness({ model: 'session' })
  assert.equal(controller.listener(officialRequest(SNAPSHOT), () => 'session model'), 'session model')
  assert.equal(reviews.length, 0)
})

test('jev-latest answers the official review in the official format', async () => {
  const { controller, reviews, logs, sessionModel } = harness()
  const signal = new AbortController().signal
  const decision = await readDecision(controller.listener(officialRequest(SNAPSHOT, { signal }), sessionModel))
  assert.deepEqual(decision, { risk: 'low', decision: 'allow' })
  const [review] = reviews
  assert.equal(review.policy, OFFICIAL_POLICY)
  assert.equal(review.sections.pendingAction.name, 'bash')
  assert.equal(review.signal, signal)
  const status = controller.status()
  assert.deepEqual(status.counts, { reviewed: 1, allowed: 1, denied: 0, failed: 0 })
  assert.deepEqual([status.last.tool, status.last.outcome, status.last.version], ['bash', 'allowed', 'jev-1.14.0'])
  assert.equal(logs.length, 1)
  assert.match(logs[0][1], /^packycode-api: auto review allowed bash \(jev-1\.14\.0, low risk, \d+ ms\)$/u)
})

test('a Jev denial carries its reason to the official reviewer', async () => {
  const reason = 'jev-latest 判定为中风险操作，且没有找到你对此操作的明确指示'
  const { controller, sessionModel } = harness({ jev: () => ({ decision: 'deny', risk: 'medium', reason }) })
  assert.deepEqual(await readDecision(controller.listener(officialRequest(SNAPSHOT), sessionModel)), { risk: 'medium', decision: 'deny', reason })
  assert.equal(controller.status().counts.denied, 1)
})

test('a failed Jev review ends the stream with its error, which DSH turns into a refused call', async () => {
  const { controller, logs, sessionModel } = harness({ jev: () => { throw new Error('PackyCode auto review failed: Error 502: Bad gateway') } })
  await assert.rejects(readDecision(controller.listener(officialRequest(SNAPSHOT), sessionModel)), /reviewer ended with error PACKYCODE_REVIEW_FAILED: PackyCode auto review failed: Error 502/u)
  assert.equal(controller.status().counts.failed, 1)
  assert.equal(logs[0][0], 'warn')
  // A request in a format this version cannot read fails the same way.
  const unreadable = { ...officialRequest(SNAPSHOT), messages: [{ role: 'user', content: [{ type: 'text', text: 'ENVIRONMENT\n\n{}\n\nNEW_SECTION\n\n[]' }] }] }
  await assert.rejects(readDecision(controller.listener(unreadable, sessionModel)), /cannot read this DSH version's review request/u)
})

test('a cancelled review ends as aborted and is not counted as a failure', async () => {
  const stopped = new AbortController()
  const { controller, sessionModel } = harness({
    jev: () => {
      stopped.abort()
      throw new Error('aborted')
    },
  })
  await assert.rejects(readDecision(controller.listener(officialRequest(SNAPSHOT, { signal: stopped.signal }), sessionModel)), /reviewer ended with aborted ABORTED/u)
  assert.equal(controller.status().counts.failed, 0)
})

test('DeepSeek Flash gets the official request itself, addressed to the PackyCode route', async () => {
  const { controller, streamed, sessionModel } = harness({ model: 'deepseek-flash' })
  const request = officialRequest(SNAPSHOT, { provider: 'openai-codex', model: 'gpt-6.1-sol' })
  assert.deepEqual(await readDecision(controller.listener(request, sessionModel)), { risk: 'low', decision: 'allow' })
  const [routed] = streamed
  assert.deepEqual([routed.provider, routed.model], ['packycode', 'deepseek-flash'])
  assert.equal(routed.system, request.system)
  assert.equal(routed.messages, request.messages)
  assert.equal(routed.temperature, 0)
  assert.deepEqual(controller.status().counts, { reviewed: 1, allowed: 1, denied: 0, failed: 0 })
})

test('Flash\'s answers are counted as the official reviewer will read them', async () => {
  const deny = harness({ model: 'deepseek-flash', flashAnswer: '{"risk":"high","decision":"deny","reason":"sends a key out"}' })
  assert.deepEqual(await readDecision(deny.controller.listener(officialRequest(SNAPSHOT), deny.sessionModel)), { risk: 'high', decision: 'deny', reason: 'sends a key out' })
  assert.equal(deny.controller.status().counts.denied, 1)
  const prose = harness({ model: 'deepseek-flash', flashAnswer: 'Looks fine to me.' })
  await assert.rejects(readDecision(prose.controller.listener(officialRequest(SNAPSHOT), prose.sessionModel)))
  assert.equal(prose.controller.status().counts.failed, 1)
})

test('the status says whether DSH\'s auto review is on, and the preference is validated', async () => {
  const off = harness()
  assert.deepEqual(off.controller.status().official, { enabled: false, offered: false })
  assert.deepEqual(off.controller.status().models.map(entry => entry.id), ['jev-latest', 'deepseek-flash', 'session'])
  const on = harness({ entry: { options: { id: DSH_AUTO_REVIEW_ROW }, disabled: false }, presets: ['read-only', 'workspace-write', 'danger-full-access', 'auto'] })
  assert.deepEqual(on.controller.status().official, { enabled: true, offered: true })
  const disabled = harness({ entry: { options: { id: DSH_AUTO_REVIEW_ROW, disabled: true }, disabled: true } })
  assert.equal(disabled.controller.status().official.enabled, false)

  await assert.rejects(on.controller.update({ autoReviewModel: 'gpt-6.1-sol' }), /model is not supported/u)
  assert.deepEqual(on.writes, [])
  assert.equal((await on.controller.update({ autoReviewModel: 'session' })).model, 'session')
  assert.deepEqual(on.writes, [{ autoReviewModel: 'session' }])
  const locked = harness({ writable: false })
  await assert.rejects(locked.controller.update({ autoReviewModel: 'deepseek-flash' }), /not writable/u)
})
