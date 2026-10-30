import assert from 'node:assert/strict'
import test from 'node:test'

import { createDiagnostics, DIAGNOSTICS_FORMAT, DIAGNOSTICS_LIMITS, summarizeSessionEvents } from '../src/diagnostics.js'
import { createPackyCodeRpc } from '../src/rpc.js'

const KEY = 'sk-diagnostics-fixture-0123456789abcdef'
const PROMPT = 'PRIVATE PROMPT TEXT about the roadmap'
const PATH = '/Users/someone/private/notes.txt'
const chunk = value => ({ type: 'chunk', chunk: value })

/** One truncated turn the way DSH logs it, with private text in every place it can appear. */
const events = [
  { type: 'session', time: 1, data: { cwd: '/Users/someone/project' } },
  { type: 'turn/start', time: 2, data: { turn: 1 } },
  { type: 'user/message', time: 3, data: { message: { role: 'user', content: [{ type: 'text', text: PROMPT }] } } },
  { type: 'session/title', time: 4, data: { title: PROMPT } },
  { type: 'request/header', time: 5, data: { reason: 'initial', header: { config: { provider: 'packycode', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 8192 }, adapterDefaults: {} } } },
  { type: 'assistant/message', time: Date.UTC(2026, 9, 15, 13, 0), data: {
    turn: 1, step: 1,
    message: { role: 'assistant', content: [{ type: 'thinking', text: PROMPT }, { type: 'tool-call', name: 'bash', arguments: { command: `cat ${PATH}` } }] },
    usage: { inputTokens: 1200, cacheReadTokens: 158000, outputTokens: 8192 },
    stream: [chunk({ type: 'block-start', index: 0 }), chunk({ type: 'usage', usage: { inputTokens: 1200, cacheReadTokens: 158000, outputTokens: 8192 } }), chunk({ type: 'finish', reason: { kind: 'max-tokens' } })],
  } },
  { type: 'tool/call', time: 7, data: { name: 'bash', args: { command: `cat ${PATH}` } } },
  { type: 'llm/retry', time: 8, data: { turn: 1, step: 2, provider: 'packycode', retry: 1, maxRetries: 20, failure: { code: 'AUTH', message: `401 invalid key ${KEY} (Bearer abcdefghijklmnop)` } } },
  { type: 'assistant/attempt', time: 9, data: { turn: 1, step: 2, stream: [chunk({ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: `upstream said ${'x'.repeat(400)}` } } })] } },
  { type: 'compaction/applied', time: 10, data: {} },
  { type: 'turn/end', time: 11, data: { turn: 1, reason: { kind: 'max-tokens' } } },
]

test('the summary keeps settings and numbers and nothing a user wrote', () => {
  const summary = summarizeSessionEvents(events, { secrets: [KEY] })
  assert.deepEqual(summary.totals, { turns: 1, steps: 1, maxTokenSteps: 1, retries: 1, failedAttempts: 1, compactionEvents: 1 })
  assert.deepEqual(summary.requestSettings, [{ time: new Date(5).toISOString(), reason: 'initial', provider: 'packycode', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 8192 }])
  assert.deepEqual(summary.maxTokenSteps, [{
    turn: 1, step: 1, time: '2026-10-15T13:00:00.000Z', finish: 'max-tokens', input: 1200, cacheRead: 158000, output: 8192, context: 159200,
  }])
  assert.deepEqual(summary.turnEnds, [{ turn: 1, time: new Date(11).toISOString(), kind: 'max-tokens' }])
  const text = JSON.stringify(summary)
  for (const secret of [PROMPT, PATH, 'notes.txt', 'roadmap', '/Users/someone', KEY, 'abcdefghijklmnop']) {
    assert.equal(text.includes(secret), false, `${secret} must not appear`)
  }
  assert.match(summary.retries[0].message, /\[redacted\]/u)
  assert.equal(summary.retries[0].code, 'AUTH')
  assert.equal(summary.failedAttempts[0].code, 'SERVER')
  assert.ok(summary.failedAttempts[0].message.length <= 161 && summary.failedAttempts[0].message.endsWith('…'), 'long errors are shortened')
})

test('an adapter-supplied output ceiling is marked as such', () => {
  const summary = summarizeSessionEvents([
    { type: 'request/header', time: 1, data: { reason: 'change', header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 256000 }, adapterDefaults: { maxTokens: true } } } },
  ])
  assert.equal(summary.requestSettings[0].maxTokensFromAdapter, true)
})

test('long sessions keep only the newest records of each kind', () => {
  const many = Array.from({ length: 50 }, (_, index) => ({
    type: 'assistant/message', time: index, data: { turn: 1, step: index + 1, usage: { inputTokens: 1, outputTokens: 1 }, stream: [chunk({ type: 'finish', reason: { kind: index % 2 ? 'max-tokens' : 'tool-calls' } })] },
  }))
  const summary = summarizeSessionEvents(many)
  assert.equal(summary.totals.steps, 50)
  assert.equal(summary.totals.maxTokenSteps, 25)
  assert.equal(summary.recentSteps.length, DIAGNOSTICS_LIMITS.steps)
  assert.equal(summary.recentSteps.at(-1).step, 50)
  assert.equal(summary.maxTokenSteps.length, DIAGNOSTICS_LIMITS.truncated)
})

/** The service over a fake session query, ring and group reader. */
function service({ sessions = [], withQuery = true } = {}) {
  const reads = []
  const query = { listSessions: async () => sessions }
  return {
    reads,
    diagnostics: createDiagnostics({
      sessionQuery: () => (withQuery ? query : undefined),
      readEvents: async (sessionId, signal) => { reads.push({ sessionId, signal }); return events },
      ring: { list: async () => ({ keys: [{ id: 'k1', label: 'Alice personal key', active: true }, { id: 'k2', label: 'Spare', active: false, disabled: true }] }) },
      groups: { read: async () => ({ keys: [{ id: 'k1', groups: ['deepseek-sale'], coverage: { 'deepseek-flash': true, 'gpt-6.1-sol': false } }] }) },
      secrets: async () => [KEY],
      ownPackageJsonUrl: new URL('../package.json', import.meta.url),
    }),
  }
}

test('the picker lists recent top-level sessions without their paths', async () => {
  const sessions = [
    { header: { id: 'child', createdAt: 5, cwd: '/x/child', delegationDepth: 1 }, live: true },
    ...Array.from({ length: 25 }, (_, index) => ({ header: { id: `s${index}`, createdAt: 100 - index, cwd: `/Users/someone/work/project-${index}`, delegationDepth: 0 }, live: index === 0 })),
  ]
  const { diagnostics } = service({ sessions })
  const { sessions: listed } = await diagnostics.list()
  assert.equal(listed.length, 20)
  assert.deepEqual(listed[0], { id: 's0', createdAt: new Date(100).toISOString(), live: true, folder: 'project-0' })
  assert.equal(listed.some(item => item.id === 'child'), false, 'subagent sessions are left out')
})

test('a diagnosis names the session, plugin and key groups but no labels or keys', async () => {
  const { diagnostics, reads } = service({ sessions: [{ header: { id: 'session-1', createdAt: 42, cwd: '/Users/someone/work' }, live: false }] })
  const report = await diagnostics.read({ sessionId: 'session-1' })
  assert.equal(reads[0].sessionId, 'session-1')
  assert.equal(report.format, DIAGNOSTICS_FORMAT)
  assert.match(report.plugin.version, /^\d+\.\d+\.\d+/u)
  assert.deepEqual(report.session, { id: 'session-1', createdAt: new Date(42).toISOString(), live: false })
  assert.deepEqual(report.keys, [
    { key: 1, active: true, groups: ['deepseek-sale'], reaches: ['deepseek-flash'] },
    { key: 2, active: false, disabled: true },
  ])
  const text = JSON.stringify(report)
  for (const secret of ['Alice', 'Spare', KEY, '/Users/someone', PROMPT]) assert.equal(text.includes(secret), false, `${secret} must not appear`)
})

test('a diagnosis carries the network section, and is still made when that section fails', async () => {
  const sessions = [{ header: { id: 'session-1', createdAt: 42 }, live: true }]
  const base = {
    sessionQuery: () => ({ listSessions: async () => sessions }),
    readEvents: async () => events,
    ring: { list: async () => ({ keys: [] }) },
    secrets: async () => [KEY],
    ownPackageJsonUrl: new URL('../package.json', import.meta.url),
  }
  const seen = []
  const network = { snapshot: async options => { seen.push(options); return { runtime: { node: 'v24.0.0' }, hosts: [] } } }
  const report = await createDiagnostics({ ...base, network }).read({ sessionId: 'session-1' })
  assert.deepEqual(report.network, { runtime: { node: 'v24.0.0' }, hosts: [] })
  assert.deepEqual(seen, [{ secrets: [KEY] }], 'stored keys are handed over for redaction')

  const broken = { snapshot: async () => { throw new Error('lookup exploded') } }
  const without = await createDiagnostics({ ...base, network: broken }).read({ sessionId: 'session-1' })
  assert.equal(without.network, undefined)
  assert.equal(without.totals.steps, 1)
})

test('the service refuses bad session ids and runtimes without session history', async () => {
  const { diagnostics } = service()
  for (const sessionId of [undefined, '', '../etc/passwd', 'a b']) {
    await assert.rejects(diagnostics.read({ sessionId }), /^Error: PackyCode diagnostics need a session to read$/u)
  }
  const missing = service({ withQuery: false }).diagnostics
  await assert.rejects(missing.list(), /PackyCode diagnostics need DSH session history/u)
  await assert.rejects(missing.read({ sessionId: 'session-1' }), /PackyCode diagnostics need DSH session history/u)
})

test('the RPC channel serves diagnostics and refuses them where the service is absent', async () => {
  const base = { ring: { list: async () => ({ keys: [] }) }, balance: { invalidate() {} }, hosts: () => ({}), preference: {} }
  const { diagnostics } = service({ sessions: [{ header: { id: 'session-1', createdAt: 1 }, live: true }] })
  const handler = createPackyCodeRpc({ ...base, diagnostics })
  const listed = await handler('diagnostics/sessions', {})
  assert.equal(listed.ok, true)
  assert.equal(listed.value.sessions[0].id, 'session-1')
  const read = await handler('diagnostics/session', { sessionId: 'session-1' })
  assert.equal(read.ok, true)
  assert.equal(read.value.totals.maxTokenSteps, 1)
  const refused = await handler('diagnostics/session', { sessionId: '../x' })
  assert.deepEqual(refused, { ok: false, error: { code: 'packycode/request-failed', message: 'PackyCode diagnostics need a session to read', details: {} } })
  const absent = await createPackyCodeRpc(base)('diagnostics/sessions', {})
  assert.equal(absent.error.message, 'PackyCode diagnostics are unavailable in this runtime')
})
