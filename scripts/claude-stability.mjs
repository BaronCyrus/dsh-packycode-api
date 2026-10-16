#!/usr/bin/env node
/** One bounded sampling round per invocation; the thread heartbeat supplies cadence. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CLAUDE_MODELS, createClaudeCheck } from './claude-check.mjs'
import { readStoredKey } from './stored-key.mjs'
import { redactSecrets } from '../src/secret-redactor.js'
import { TEST_MESSAGE_POLICY_CODE } from '../src/failures.js'
import { CLAUDE_SCENARIO_VERSION } from './claude-scenarios.mjs'

const INTERVAL_MS = 15 * 60_000
const FORMAT = 'native-claude-stability/1'
const DEFAULT_BUILD = new URL('../lib/index.js', import.meta.url)
const hashBuild = async (path = DEFAULT_BUILD) => createHash('sha256').update(await readFile(path)).digest('hex')
const iso = time => new Date(time).toISOString()

export function summarizeStability(state) {
  const checks = state.rounds.flatMap(round => round.checks)
  const requests = checks.flatMap(check => check.requests ?? [])
  const durations = checks.map(check => check.durationMs).sort((a, b) => a - b)
  const gaps = state.rounds.slice(1).map((round, index) => Date.parse(round.startedAt) - Date.parse(state.rounds[index].startedAt))
  const builds = {}
  for (const round of state.rounds) {
    const hash = round.buildSha256 ?? state.buildHistory?.[0]?.sha256 ?? state.buildSha256
    const entry = builds[hash] ??= { rounds: 0, passed: 0, failed: 0, requests: 0, firstSampleAt: round.startedAt, lastSampleAt: round.finishedAt }
    entry.rounds++
    entry.passed += round.checks.filter(check => check.ok).length
    entry.failed += round.checks.filter(check => !check.ok).length
    entry.requests += round.checks.reduce((sum, check) => sum + (check.requests?.length ?? 0), 0)
    entry.lastSampleAt = round.finishedAt
  }
  return {
    status: state.status, startedAt: state.startedAt, endsAt: state.endsAt,
    lastSampleAt: state.rounds.at(-1)?.finishedAt,
    requestedWindowMs: Date.parse(state.endsAt) - Date.parse(state.startedAt),
    observedSpanMs: state.rounds.length === 0 ? 0 : Date.parse(state.rounds.at(-1).finishedAt) - Date.parse(state.rounds[0].startedAt),
    maxSampleGapMs: gaps.length === 0 ? 0 : Math.max(...gaps),
    rounds: state.rounds.length, missedSlots: state.missedSlots,
    activeBuildSha256: state.buildSha256, builds,
    passed: checks.filter(check => check.ok).length, failed: checks.filter(check => !check.ok).length,
    recoveredChecks: checks.filter(check => check.recovered === true).length,
    streamFailures: requests.filter(request => request.streamError !== undefined).length,
    http200StreamFailures: requests.filter(request => request.status === 200 && request.streamError !== undefined).length,
    scenarioVersions: [...new Set(state.rounds.map(round => round.scenarioVersion ?? 'connectivity-v1'))],
    requests: requests.length,
    statuses: Object.fromEntries([...new Set(requests.map(request => String(request.status ?? 'transport')))].map(status => [status, requests.filter(request => String(request.status ?? 'transport') === status).length])),
    checkLatencyMs: { median: durations[Math.floor(durations.length / 2)], p95: durations[Math.max(0, Math.ceil(durations.length * .95) - 1)] },
    models: Object.fromEntries(CLAUDE_MODELS.map(model => {
      const rows = checks.filter(check => check.model === model)
      return [model, { passed: rows.filter(check => check.ok).length, failed: rows.filter(check => !check.ok).length, kinds: [...new Set(rows.map(check => check.kind))] }]
    })),
  }
}

/** No keys are persisted, no model traffic after the deadline, no overlapping rounds. */
export async function sampleStability({ statePath, start = false, hours = 6, keyLabel, now = Date.now, buildHash = hashBuild, loadKey = readStoredKey, makeCheck = createClaudeCheck } = {}) {
  if (!statePath) throw new Error('A stability state path is required')
  if (!Number.isFinite(hours) || hours <= 0 || hours > 12) throw new Error('Stability duration must be greater than zero and at most 12 hours')
  const path = resolve(statePath)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  let lock
  try { lock = await open(`${path}.lock`, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') {
      // A crashed runner must become visible rather than silently blocking
      // every remaining sample. Never remove another invocation's lock here.
      let needsAttention = false
      let ownerRunning
      try {
        const lease = JSON.parse(await readFile(`${path}.lock`, 'utf8'))
        if (Number.isSafeInteger(lease.pid) && lease.pid > 0) {
          try { process.kill(lease.pid, 0); ownerRunning = true } catch (cause) { ownerRunning = cause.code !== 'ESRCH' }
          needsAttention = ownerRunning === false || now() - Date.parse(lease.at) > 8 * 60_000
        }
      } catch { /* The owner may be between creating and writing its lease. */ }
      return { status: 'busy', statePath: path, needsAttention, ownerRunning }
    }
    throw error
  }
  let state
  let key
  const save = async () => {
    state.summary = summarizeStability(state)
    const serialized = JSON.stringify(state, null, 2)
    const safe = key === undefined ? serialized : redactSecrets(serialized, [key])
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${safe}\n`, { mode: 0o600 })
    await rename(temporary, path)
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: iso(now()) }))
    try { state = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Stability state could not be read safely')
      if (!start) throw new Error('Initialize this stability window with --start first')
      if (typeof keyLabel !== 'string' || keyLabel === '') throw new Error('Starting requires a stored key label')
      const started = now()
      state = { format: FORMAT, status: 'active', startedAt: iso(started), endsAt: iso(started + hours * 3_600_000), intervalMs: INTERVAL_MS,
        keyLabel, buildSha256: await buildHash(), scenarioVersion: CLAUDE_SCENARIO_VERSION, sessionId: randomUUID(), maxRequests: Math.ceil(hours * 4) * 5,
        lastSlot: -1, missedSlots: 0, rounds: [] }
    }
    if (state.format !== FORMAT || !Array.isArray(state.rounds) || !Number.isFinite(Date.parse(state.endsAt))) throw new Error('Unsupported stability state')
    if (state.status !== 'active') return state.summary ?? summarizeStability(state)
    if (now() >= Date.parse(state.endsAt)) {
      state.status = 'complete'
      state.completedAt = iso(now())
      await save()
      return state.summary
    }
    const builtPath = state.buildPath ?? DEFAULT_BUILD
    let currentHash
    try { currentHash = await buildHash(builtPath) } catch {
      state.status = 'stopped'
      state.stopReason = 'pinned-artifact-unavailable'
      await save()
      return state.summary
    }
    if (currentHash !== state.buildSha256) {
      state.status = 'stopped'
      state.stopReason = 'built-artifact-changed; do not mix different implementations in one window'
      await save()
      return state.summary
    }
    const slot = Math.floor((now() - Date.parse(state.startedAt)) / state.intervalMs)
    if (slot <= state.lastSlot) return { ...summarizeStability(state), due: false }
    const extra = { model: CLAUDE_MODELS[Math.floor(slot / 3) % 3], kind: ['tool', 'image', 'title'][slot % 3] }
    // Haiku and Sonnet tool turns can each replay one client anomaly. Reserve
    // their worst-case seven requests without raising the window's budget.
    const roundBudget = ['claude-haiku-5-5', 'claude-sonnet-5-5'].includes(extra.model) && extra.kind === 'tool' ? 7 : 5
    if (summarizeStability(state).requests + roundBudget > state.maxRequests) {
      state.status = 'stopped'
      state.stopReason = 'request-budget-reached'
      await save()
      return state.summary
    }
    try { key = await loadKey({ label: state.keyLabel }) } catch {
      state.status = 'stopped'
      state.stopReason = 'stored-key-unavailable; no other credential was used'
      await save()
      return state.summary
    }
    const tail = `…${key.slice(-4)}`
    if (state.maskedTail !== undefined && state.maskedTail !== tail) {
      state.status = 'stopped'
      state.stopReason = 'stored-key-changed'
      await save()
      return state.summary
    }
    state.maskedTail = tail
    state.missedSlots += Math.max(0, slot - state.lastSlot - 1)
    state.lastSlot = slot
    const round = { slot, startedAt: iso(now()), buildSha256: state.buildSha256, scenarioVersion: CLAUDE_SCENARIO_VERSION, checks: [] }
    const check = await makeCheck({ key, sessionId: state.sessionId, builtPath })
    try {
      const cases = [...CLAUDE_MODELS.map((model, index) => ({ model, kind: 'text', variant: slot + index })), { ...extra, variant: slot }]
      for (const current of cases) {
        if (now() >= Date.parse(state.endsAt)) break
        // Abort the current request at the window boundary as well.
        const signal = AbortSignal.timeout(Math.max(1, Date.parse(state.endsAt) - now()))
        const result = await check.run({ ...current, signal })
        round.checks.push(result)
        if (result.failure?.code === TEST_MESSAGE_POLICY_CODE) {
          round.note = 'gateway-test-message-policy; record this failure without retrying, changing the key or skipping the other scheduled checks'
        }
        if (['AUTH', 'QUOTA', 'MISSING_CREDENTIAL'].includes(result.failure?.code)) {
          state.status = 'stopped'
          state.stopReason = 'stored-key-rejected-or-exhausted; no other credential was used'
          break
        }
        if ((result.requests ?? []).some(request => [429, 503].includes(request.status))) {
          round.skippedChecks = cases.length - round.checks.length
          round.note = 'gateway-capacity; wait until next scheduled sample without retrying'
          break
        }
      }
    } finally { check.close() }
    round.finishedAt = iso(now())
    state.rounds.push(round)
    state.nextDueAt = iso(Date.parse(state.startedAt) + (slot + 1) * state.intervalMs)
    await save()
    return state.summary
  } finally {
    await lock.close()
    await unlink(`${path}.lock`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
  const statePath = option('--state', '.artifacts/claude-stability-2026-10-16.json')
  if (args.includes('--status')) {
    const state = JSON.parse(await readFile(resolve(statePath), 'utf8'))
    console.log(JSON.stringify({ ...summarizeStability(state), stopReason: state.stopReason, nextDueAt: state.nextDueAt }, null, 2))
    return
  }
  const result = await sampleStability({ statePath, start: args.includes('--start'), hours: Number(option('--hours', 6)), keyLabel: option('--key-label', undefined) })
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => { console.error('Claude stability check failed; stored credentials were not printed or changed.'); process.exitCode = 1 })
}
