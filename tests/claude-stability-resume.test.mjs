import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resumeStability } from '../scripts/claude-stability-resume.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'packy-resume-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const key = 'sk-resume-fixture-1234'
  const original = { format: 'native-claude-stability/1', status: 'stopped', startedAt: '2026-10-16T02:38:32.919Z', endsAt: '2026-10-16T08:38:32.919Z',
    lastSlot: 9, missedSlots: 1, maxRequests: 120, keyLabel: 'saved fixture', maskedTail: '…1234', sessionId: 'original-session', buildSha256: 'old',
    stopReason: 'stored-key-rejected-or-exhausted; no other credential was used',
    rounds: [{ slot: 9, buildSha256: 'old', startedAt: '2026-10-16T05:03:46Z', finishedAt: '2026-10-16T05:03:48Z', checks: [{ model: 'claude-opus-5-5', kind: 'text', ok: false, durationMs: 1000,
      failure: { code: 'AUTH' }, requests: [{ status: 403, error: 'Your client is already connected and authorized. There is no need to send test messages to verify the connection.' }] }] }],
  }
  const statePath = join(directory, 'state.json'), buildPath = join(directory, 'built.js')
  await writeFile(statePath, JSON.stringify(original))
  await writeFile(buildPath, 'export const verified = true;')
  const options = { statePath, buildPath, now: () => Date.parse('2026-10-16T05:20:00Z'), loadKey: async ({ label }) => { assert.equal(label, 'saved fixture'); return key } }
  return { directory, original, options, read: async () => JSON.parse(await readFile(statePath, 'utf8')) }
}

test('explicit resume preserves the original window, budget, samples, credentials and stopped evidence', async t => {
  const f = await fixture(t)
  const result = await resumeStability(f.options)
  const state = await f.read()
  assert.equal(result.status, 'active')
  for (const field of ['startedAt', 'endsAt', 'lastSlot', 'missedSlots', 'maxRequests', 'keyLabel', 'maskedTail', 'sessionId']) assert.equal(state[field], f.original[field])
  assert.deepEqual(state.rounds, f.original.rounds)
  assert.equal(state.interruptionHistory[0].stopReason, f.original.stopReason)
  assert.equal(state.interruptionHistory[0].correctedCategory, 'GATEWAY_TEST_MESSAGE')
  assert.equal(state.scenarioVersion, 'business-v1')
  assert.equal(state.stopReason, undefined)
  assert.equal(await readFile(state.buildPath, 'utf8'), 'export const verified = true;')
  assert.equal((await readdir(f.directory)).filter(name => name.includes('before-resume')).length, 1)
  await assert.rejects(resumeStability(f.options), /Only the recorded/u)
})

test('resume never extends an expired deadline or revives a real credential fault', async t => {
  for (const cause of ['deadline', 'key', 'auth', 'budget']) {
    const f = await fixture(t)
    const options = { ...f.options }
    if (cause === 'deadline') options.now = () => Date.parse(f.original.endsAt)
    if (cause === 'key') options.loadKey = async () => 'sk-other-fixture-5678'
    if (cause === 'auth') f.original.rounds[0].checks[0].requests[0].error = 'invalid API key'
    if (cause === 'budget') f.original.maxRequests = 1
    await writeFile(options.statePath, JSON.stringify(f.original))
    await assert.rejects(resumeStability(options))
    assert.deepEqual(await f.read(), f.original)
  }
})

test('resume respects an active sampling lock', async t => {
  const f = await fixture(t)
  await writeFile(`${f.options.statePath}.lock`, JSON.stringify({ pid: process.pid }))
  await assert.rejects(resumeStability(f.options), { code: 'EEXIST' })
  assert.deepEqual(await f.read(), f.original)
})
