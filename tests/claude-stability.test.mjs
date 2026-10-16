import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sampleStability } from '../scripts/claude-stability.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'packy-stability-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let time = Date.parse('2026-10-16T02:30:00Z'), closed = 0
  const calls = []
  const key = 'sk-only-stored-stability-fixture-0001'
  const options = { statePath: join(directory, 'state.json'), start: true, keyLabel: 'stored fixture', now: () => time, buildHash: async () => 'build-1',
    loadKey: async ({ label }) => { assert.equal(label, 'stored fixture'); return key },
    makeCheck: async ({ key: supplied }) => { assert.equal(supplied, key); return {
      run: async ({ model, kind }) => { calls.push({ model, kind }); return { model, kind, ok: true, durationMs: 10, requests: [{ status: 200 }] } },
      close: () => { closed++ },
    } },
  }
  return { options, calls, key, advance: milliseconds => { time += milliseconds }, closed: () => closed, state: async () => JSON.parse(await readFile(options.statePath, 'utf8')) }
}

test('stability samples all models, rotates features and does not repeat a time slot', async t => {
  const f = await fixture(t)
  const first = await sampleStability(f.options)
  assert.equal(first.passed, 4)
  assert.deepEqual(f.calls.map(call => call.kind), ['text', 'text', 'text', 'tool'])
  assert.equal((await sampleStability(f.options)).due, false)
  assert.equal(f.calls.length, 4)
  f.advance(15 * 60_000)
  assert.equal((await sampleStability(f.options)).passed, 8)
  assert.equal(f.calls.at(-1).kind, 'image')
  f.advance(30 * 60_000)
  const later = await sampleStability(f.options)
  assert.equal(later.missedSlots, 1)
  assert.equal(later.maxSampleGapMs, 30 * 60_000)
  assert.equal(f.closed(), 3)
  assert.ok(!(await readFile(f.options.statePath, 'utf8')).includes(f.key))
})

test('deadline completes the window without reading a key or issuing more requests', async t => {
  const f = await fixture(t)
  await sampleStability(f.options)
  f.advance(6 * 3_600_000)
  const done = await sampleStability({ ...f.options, loadKey: async () => assert.fail('deadline must prevent authentication') })
  assert.equal(done.status, 'complete')
  assert.equal(f.calls.length, 4)
})

test('a changed build, missing key or changed key stops rather than switching credentials', async t => {
  for (const changed of ['build', 'missing', 'key']) {
    const f = await fixture(t)
    await sampleStability(f.options)
    f.advance(15 * 60_000)
    const overrides = changed === 'build' ? { buildHash: async () => 'build-2' }
      : changed === 'missing' ? { loadKey: async () => { throw new Error('unavailable') } }
        : { loadKey: async () => 'sk-different-key-9999' }
    assert.equal((await sampleStability({ ...f.options, ...overrides })).status, 'stopped')
    assert.equal(f.calls.length, 4)
  }
})

test('gateway capacity failures are recorded and the remaining round waits for the next slot', async t => {
  const f = await fixture(t)
  const options = { ...f.options, makeCheck: async () => ({ run: async ({ model, kind }) => ({ model, kind, ok: false, durationMs: 10, failure: { message: `echoed ${f.key}` }, requests: [{ status: 429 }] }), close() {} }) }
  const summary = await sampleStability(options)
  assert.equal(summary.failed, 1)
  assert.equal(summary.requests, 1)
  assert.equal((await f.state()).rounds[0].skippedChecks, 3)
  assert.ok(!(await readFile(f.options.statePath, 'utf8')).includes(f.key))
})

test('an existing lock prevents overlapping paid work', async t => {
  const f = await fixture(t)
  await writeFile(`${f.options.statePath}.lock`, 'locked')
  assert.equal((await sampleStability(f.options)).status, 'busy')
  assert.equal(f.calls.length, 0)
})

test('a credential fault stops the window without spending on other models', async t => {
  const f = await fixture(t)
  let calls = 0
  const result = await sampleStability({ ...f.options, makeCheck: async () => ({
    run: async ({ model, kind }) => { calls++; return { model, kind, ok: false, durationMs: 1, failure: { code: 'AUTH', message: 'invalid key' }, requests: [{ status: 401 }] } },
    close() {},
  }) })
  assert.equal(result.status, 'stopped')
  assert.equal(calls, 1)
  assert.match((await f.state()).stopReason, /no other credential/u)
})

test('a test-message refusal records each scheduled check without retries or stopping the window', async t => {
  const f = await fixture(t)
  let calls = 0
  const result = await sampleStability({ ...f.options, makeCheck: async () => ({
    run: async ({ model, kind }) => { calls++; return { model, kind, ok: false, durationMs: 1, failure: { code: 'GATEWAY_TEST_MESSAGE' }, requests: [{ status: 403, streamError: { code: 'GATEWAY_TEST_MESSAGE' } }] } },
    close() {},
  }) })
  assert.equal(result.status, 'active')
  assert.equal(result.failed, 4)
  assert.equal(result.statuses['403'], 4)
  assert.equal(result.http200StreamFailures, 0)
  assert.equal(calls, 4)
  const state = await f.state()
  assert.equal(state.stopReason, undefined)
  assert.equal(state.rounds[0].skippedChecks, undefined)
  assert.equal(state.rounds[0].scenarioVersion, 'business-v1')
  f.advance(15 * 60_000)
  assert.equal((await sampleStability(f.options)).passed, 4)
})

test('a dead lock owner requests attention rather than silently skipping the entire window', async t => {
  const f = await fixture(t)
  await writeFile(`${f.options.statePath}.lock`, JSON.stringify({ pid: 99999999, at: '2026-10-16T02:00:00Z' }))
  const status = await sampleStability(f.options)
  assert.equal(status.status, 'busy')
  assert.equal(status.needsAttention, true)
  assert.equal(status.ownerRunning, false)
  assert.equal(f.calls.length, 0)
})

test('a pinned artifact keeps sampling while another build changes, with per-build results', async t => {
  const f = await fixture(t)
  await sampleStability(f.options)
  const state = await f.state()
  state.buildPath = join(tmpdir(), 'immutable-old-build.mjs')
  await writeFile(f.options.statePath, JSON.stringify(state))
  f.advance(15 * 60_000)
  let supplied
  const makeCheck = f.options.makeCheck
  const summary = await sampleStability({ ...f.options,
    buildHash: async path => path === state.buildPath ? 'build-1' : 'different-current-build',
    makeCheck: async options => { supplied = options.builtPath; return makeCheck(options) },
  })
  assert.equal(summary.status, 'active')
  assert.equal(supplied, state.buildPath)
  assert.equal(summary.builds['build-1'].rounds, 2)
  assert.equal(summary.builds['build-1'].passed, 8)
})

for (const [model, slot] of [['Haiku', 6], ['Sonnet', 3]]) test(`${model} tool sampling reserves its bounded replays before spending the remaining budget`, async t => {
  const f = await fixture(t)
  await sampleStability(f.options)
  const state = await f.state()
  state.maxRequests = 10 // Four spent; six remain, less than this round's seven.
  await writeFile(f.options.statePath, JSON.stringify(state))
  f.advance(slot * 15 * 60_000)
  const result = await sampleStability(f.options)
  assert.equal(result.status, 'stopped')
  assert.equal(f.calls.length, 4)
  assert.equal((await f.state()).stopReason, 'request-budget-reached')
})
