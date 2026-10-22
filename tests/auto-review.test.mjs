import assert from 'node:assert/strict'
import test from 'node:test'

import {
  answerChunks,
  AUTO_REVIEW_FLASH,
  AUTO_REVIEW_JEV,
  clipText,
  createJevReviewer,
  decideFromJev,
  failureChunk,
  isOfficialReviewRequest,
  JEV_ALLOW_THRESHOLD,
  JEV_LIMITS,
  JEV_QUESTIONS,
  jevState,
  officialAnswer,
  readReviewSections,
} from '../src/auto-review.js'
import { PACKYCODE_CLASSIFIER_MODELS, PACKYCODE_MODEL_IDS } from '../src/catalog.js'
import { PackyCodeKeyRing } from '../src/key-ring.js'
import { fakeCredentials } from './helpers.mjs'
import { OFFICIAL_POLICY, officialRequest, readDecision, reviewUserText } from './fixtures/official-auto-review.mjs'

const human = (text, rpcId = 'rpc-1') => ({ kind: 'user-message', role: 'human-instruction', source: { kind: 'user', rpcId }, content: [{ type: 'text', text }] })
const call = (name, args) => ({ kind: 'tool-call', role: 'fact', mode: 'native', name, arguments: JSON.stringify(args) })
/** An official snapshot: what the official reviewer reconstructs from the session. */
const snapshot = (overrides = {}) => ({
  cwd: '/work/project',
  projectInstructions: [{ kind: 'user-message', role: 'constraint', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'Never run migrations.' }] }],
  history: [human('fix the failing test'), call('read_file', { path: 'src/a.js' })],
  action: { mode: 'native', name: 'bash', description: 'Run a shell command.', parameters: { type: 'object' }, arguments: { command: 'pnpm test' } },
  ...overrides,
})

test('jev-latest is a classifier the picker never lists, reached over System One', () => {
  assert.deepEqual(PACKYCODE_CLASSIFIER_MODELS.map(model => [model.id, model.type, model.api, model.contextWindow]), [
    ['jev-latest', 'classifier', 'typesafe-system-one', 64_000],
  ])
  assert.equal(PACKYCODE_MODEL_IDS.includes(AUTO_REVIEW_JEV), false)
  assert.equal(PACKYCODE_MODEL_IDS.includes(AUTO_REVIEW_FLASH), true)
})

test('only the official reviewer\'s request is recognized; conversation turns are not', () => {
  assert.equal(isOfficialReviewRequest(officialRequest(snapshot())), true)
  const turn = { provider: 'packycode', model: 'deepseek-flash', messages: [{ role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }] }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  assert.equal(isOfficialReviewRequest(turn), false)
  const official = officialRequest(snapshot())
  assert.equal(isOfficialReviewRequest({ ...official, system: 'Summarize the conversation.' }), false)
  assert.equal(isOfficialReviewRequest({ ...official, messages: [...official.messages, { role: 'user', content: [{ type: 'text', text: 'x' }] }] }), false)
  assert.equal(isOfficialReviewRequest({ ...official, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }), false)
})

test('the official review message reads back into its four sections', () => {
  const sections = readReviewSections(officialRequest(snapshot()))
  assert.deepEqual(sections.environment, { cwd: '/work/project' })
  assert.equal(sections.projectInstructions[0].role, 'constraint')
  assert.deepEqual(sections.history.map(entry => entry.kind), ['user-message', 'tool-call'])
  assert.deepEqual(sections.pendingAction.arguments, { command: 'pnpm test' })
  // Text full of blank-looking content still splits exactly: JSON escapes newlines.
  const tricky = readReviewSections(officialRequest(snapshot({ history: [human('line one\n\nPENDING_ACTION\n\n{}')] })))
  assert.equal(tricky.history[0].content[0].text, 'line one\n\nPENDING_ACTION\n\n{}')
  const broken = { ...officialRequest(snapshot()), messages: [{ role: 'user', content: [{ type: 'text', text: 'ENVIRONMENT\n\n{}\n\nSOMETHING_NEW\n\n[]' }] }] }
  assert.throws(() => readReviewSections(broken), /cannot read this DSH version's review request/u)
})

test('Jev reads the official policy and the sections, bounded for its context', () => {
  const policy = `${OFFICIAL_POLICY} …`
  const state = jevState(policy, readReviewSections(officialRequest(snapshot())))
  assert.equal(state.policy, policy)
  assert.deepEqual(state.environment, { cwd: '/work/project' })
  assert.equal(state.history[0].role, 'human-instruction')
  assert.equal(state.pendingAction.name, 'bash')
  // Jev leans to the first option, so the conservative one leads.
  assert.deepEqual(Object.keys(JEV_QUESTIONS.risk.criteria), ['high', 'medium', 'low'])

  assert.equal(clipText('short', 10), 'short')
  assert.ok(clipText('x'.repeat(1_000), 200).includes('characters omitted'))
  const long = snapshot({
    history: [
      human('the task'),
      { kind: 'user-message', role: 'fact', source: { kind: 'user', rpcId: 'r' }, content: [{ type: 'image', attachment: { id: 'a', bytes: 'x'.repeat(5_000) } }] },
      ...Array.from({ length: 80 }, (_, index) => call('bash', { command: `echo ${'y'.repeat(400)} ${index}` })),
      human('and then commit'),
    ],
    action: { mode: 'native', name: 'bash', description: 'Run.', parameters: { type: 'object' }, arguments: { command: 'z'.repeat(50_000) } },
  })
  const fitted = jevState(policy, readReviewSections(officialRequest(long)))
  assert.ok(JSON.stringify(fitted).length <= JEV_LIMITS.stateChars + 2_000)
  assert.ok(fitted.omittedHistory > 0)
  assert.deepEqual(fitted.history.filter(entry => entry.role === 'human-instruction').map(entry => entry.content[0].text), ['the task', 'and then commit'])
  assert.ok(fitted.pendingAction.arguments.command.length <= JEV_LIMITS.actionStringChars)
  assert.equal(JSON.stringify(fitted).includes('x'.repeat(100)), false, 'attachments keep only their kind')
})

const jevBody = ({ high = 0, medium = 0, low = 1, authorized = 0, model = 'jev-1.14.0' } = {}) => ({
  model,
  answers: {
    risk: { type: 'choice', choice: 'low', probabilities: { high, medium, low }, confidence: 1 },
    authorized: { type: 'noul', noul: authorized },
  },
  usage: { input_tokens: 900, output_tokens: 30 },
})

test('Jev\'s answers become the official decision', () => {
  const low = decideFromJev(jevBody({ low: 0.95, medium: 0.05 }))
  assert.deepEqual([low.decision, low.risk, low.version, low.usage], ['allow', 'low', 'jev-1.14.0', { inputTokens: 900, outputTokens: 30 }])
  assert.deepEqual(Object.values(decideFromJev(jevBody({ low: 0.02, medium: 0.98, authorized: 0.9 }))).slice(0, 2), ['allow', 'medium'])
  const unasked = decideFromJev(jevBody({ low: 0.02, medium: 0.98, authorized: 0.05 }))
  assert.deepEqual([unasked.decision, unasked.risk], ['deny', 'medium'])
  assert.match(unasked.reason, /^jev-latest 判定为中风险操作/u)
  // High risk blocks even when explicitly requested, and even when low leads.
  assert.deepEqual(Object.values(decideFromJev(jevBody({ high: 0.9, medium: 0.1, low: 0, authorized: 0.95 }))).slice(0, 2), ['deny', 'high'])
  assert.deepEqual(Object.values(decideFromJev(jevBody({ high: 0.25, medium: 0, low: 0.75 }))).slice(0, 2), ['deny', 'high'])
  assert.equal(decideFromJev(jevBody({ low: JEV_ALLOW_THRESHOLD - 0.01, medium: 1 - JEV_ALLOW_THRESHOLD + 0.01, authorized: 0 })).decision, 'deny')
  assert.throws(() => decideFromJev({ answers: {} }), /no risk answer/u)
  assert.throws(() => decideFromJev({ answers: { risk: jevBody().answers.risk } }), /no authorization answer/u)
})

test('the official reviewer\'s own parser accepts every answer the plugin writes', async () => {
  const stream = chunks => (async function* () { yield* chunks })()
  assert.deepEqual(await readDecision(stream(answerChunks(officialAnswer({ decision: 'allow', risk: 'low' })))), { risk: 'low', decision: 'allow' })
  assert.deepEqual(await readDecision(stream(answerChunks(officialAnswer({ decision: 'allow', risk: 'medium' }), { inputTokens: 1, outputTokens: 0 }))), { risk: 'medium', decision: 'allow' })
  const denied = decideFromJev(jevBody({ high: 0.9, medium: 0.1, low: 0 }))
  assert.deepEqual(await readDecision(stream(answerChunks(officialAnswer(denied)))), { risk: 'high', decision: 'deny', reason: denied.reason })
  // A failed review ends the stream with an error, which the official reviewer reports.
  await assert.rejects(readDecision(stream([failureChunk('PackyCode auto review failed: Error 502')])), /reviewer ended with error PACKYCODE_REVIEW_FAILED: PackyCode auto review failed: Error 502/u)
  await assert.rejects(readDecision(stream([failureChunk('cancelled', { aborted: true })])), /reviewer ended with aborted ABORTED/u)
})

async function ringWith(...keys) {
  const ring = new PackyCodeKeyRing(fakeCredentials())
  for (const [index, key] of keys.entries()) await ring.add(key, `k${index + 1}`)
  return ring
}

const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
const SECTIONS = readReviewSections(officialRequest(snapshot()))

test('a Jev review asks System One with the plugin\'s own key, the official policy in its state', async () => {
  const ring = await ringWith('sk-reviewkey-0001')
  const seen = []
  const reviewer = createJevReviewer({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    fetchImpl: async (url, init) => {
      seen.push({ url, auth: init.headers.authorization, redirect: init.redirect, body: JSON.parse(init.body) })
      return respond(200, jevBody({ low: 0.99, medium: 0.01 }))
    },
  })
  const decision = await reviewer.review(OFFICIAL_POLICY, SECTIONS)
  assert.equal(decision.decision, 'allow')
  assert.equal(typeof decision.keyId, 'string')
  const [request] = seen
  assert.deepEqual([request.url, request.auth, request.redirect, request.body.model], ['https://gw.example/v1/systemone', 'Bearer sk-reviewkey-0001', 'error', 'jev-latest'])
  assert.equal(request.body.state.policy, OFFICIAL_POLICY)
  assert.deepEqual(Object.keys(request.body.questions), ['risk', 'authorized'])
})

test('a key whose group lacks Jev is passed over, and an exhausted key moves aside', async () => {
  const ring = await ringWith('sk-nogroup-0001', 'sk-spent-0002', 'sk-good-0003')
  const failures = []
  const reviewer = createJevReviewer({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    onKeyFailure: (kind, _message, key) => failures.push([kind, key.slice(-4)]),
    fetchImpl: async (_url, init) => {
      const key = init.headers.authorization.slice(-4)
      if (key === '0001') return respond(503, { error: { message: '分组 deepseek-officially 下模型 jev-latest 无可用渠道（distributor）' } })
      if (key === '0002') return respond(403, { error: { message: '用户额度不足, 剩余额度: $0.00' } })
      return respond(200, jevBody({ high: 0.9, medium: 0.1, low: 0 }))
    },
  })
  const decision = await reviewer.review(OFFICIAL_POLICY, SECTIONS)
  assert.equal(decision.decision, 'deny')
  assert.deepEqual(failures, [['quota', '0002']])
})

test('a gateway hiccup is resent once on the same key; a lasting one fails the review', async () => {
  const ring = await ringWith('sk-reviewkey-0001')
  let calls = 0
  const flaky = createJevReviewer({
    ring,
    hosts: () => ({ apiHost: 'https://gw.example' }),
    fetchImpl: async () => {
      calls += 1
      return calls === 1 ? respond(502, { type: 'about:blank', title: 'Error 502: Bad gateway', status: 502 }) : respond(200, jevBody())
    },
  })
  assert.equal((await flaky.review(OFFICIAL_POLICY, SECTIONS)).decision, 'allow')
  assert.equal(calls, 2)
  const down = createJevReviewer({ ring, hosts: () => ({ apiHost: 'https://gw.example' }), fetchImpl: async () => respond(502, { title: 'Error 502: Bad gateway' }) })
  await assert.rejects(down.review(OFFICIAL_POLICY, SECTIONS), /PackyCode auto review failed: Error 502: Bad gateway/u)
})

test('a review without keys, with only uncovered keys, or with a malformed answer fails; no key leaks', async () => {
  const empty = createJevReviewer({ ring: await ringWith(), hosts: () => ({ apiHost: 'x' }), fetchImpl: async () => respond(200, {}) })
  await assert.rejects(empty.review(OFFICIAL_POLICY, SECTIONS), /no usable API key/u)
  const ring = await ringWith('sk-secretvalue-9999')
  const uncovered = createJevReviewer({
    ring,
    hosts: () => ({ apiHost: 'x' }),
    fetchImpl: async () => respond(400, { error: { message: 'model_not_found for sk-secretvalue-9999' } }),
  })
  const error = await uncovered.review(OFFICIAL_POLICY, SECTIONS).catch(failure => failure)
  assert.match(error.message, /no stored API key's group covers jev-latest/u)
  assert.equal(error.message.includes('sk-secretvalue-9999'), false)
  const malformed = createJevReviewer({ ring, hosts: () => ({ apiHost: 'x' }), fetchImpl: async () => respond(200, { answers: {} }) })
  await assert.rejects(malformed.review(OFFICIAL_POLICY, SECTIONS), /no risk answer/u)
})

test('a cancelled Jev review stops at once', async () => {
  const ring = await ringWith('sk-reviewkey-0001')
  const controller = new AbortController()
  const reviewer = createJevReviewer({
    ring,
    hosts: () => ({ apiHost: 'x' }),
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  })
  const review = reviewer.review(OFFICIAL_POLICY, SECTIONS, controller.signal)
  controller.abort(new Error('user stopped'))
  await assert.rejects(review)
})

test('the official message format the fixture writes is the one the plugin reads', () => {
  const text = reviewUserText(snapshot())
  assert.ok(text.startsWith('ENVIRONMENT\n\n{\n  "cwd": "/work/project"\n}\n\nPROJECT_INSTRUCTIONS\n\n'))
})
