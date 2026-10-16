#!/usr/bin/env node
/** Explicitly resume only the recorded test-message misclassification; never extend the window. */
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { classifyTestMessagePolicy, TEST_MESSAGE_POLICY_CODE } from '../src/failures.js'
import { CLAUDE_SCENARIO_VERSION } from './claude-scenarios.mjs'
import { summarizeStability } from './claude-stability.mjs'
import { readStoredKey } from './stored-key.mjs'

export async function resumeStability({ statePath, buildPath = 'lib/index.js', now = Date.now, loadKey = readStoredKey } = {}) {
  if (!statePath) throw new Error('A stability state path is required')
  const path = resolve(statePath)
  const lock = await open(`${path}.lock`, 'wx', 0o600)
  try {
    const resumedAt = new Date(now()).toISOString()
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: resumedAt }))
    const original = await readFile(path, 'utf8')
    const state = JSON.parse(original)
    if (!Number.isFinite(Date.parse(state.endsAt)) || now() >= Date.parse(state.endsAt)) throw new Error('The original stability deadline has passed')
    const last = state.rounds?.at(-1)?.checks?.at(-1)
    const refused = last?.requests?.at(-1)
    if (state.status !== 'stopped' || state.stopReason !== 'stored-key-rejected-or-exhausted; no other credential was used'
      || last?.failure?.code !== 'AUTH' || refused?.status !== 403 || !classifyTestMessagePolicy(refused.error)) {
      throw new Error('Only the recorded test-message policy misclassification can be resumed here')
    }
    const key = await loadKey({ label: state.keyLabel })
    if (`…${key.slice(-4)}` !== state.maskedTail) throw new Error('The stored key no longer matches the observation window')
    if (summarizeStability(state).requests >= state.maxRequests) throw new Error('The original request budget is exhausted')
    const current = await readFile(resolve(buildPath))
    const sha256 = createHash('sha256').update(current).digest('hex')
    const directory = resolve(dirname(path), 'claude-stability-builds', sha256)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const snapshot = resolve(directory, 'index.mjs')
    try {
      if (!(await readFile(snapshot)).equals(current)) throw new Error('Snapshot integrity mismatch')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await writeFile(snapshot, current, { flag: 'wx', mode: 0o600 })
    }
    // Preserve the original AUTH classification and stop reason as evidence.
    await writeFile(`${path}.before-resume-${now()}.json`, original, { flag: 'wx', mode: 0o600 })
    state.interruptionHistory ??= []
    state.interruptionHistory.push({ stoppedAt: state.rounds.at(-1).finishedAt, resumedAt, stopReason: state.stopReason,
      correctedCategory: TEST_MESSAGE_POLICY_CODE, previousBuildSha256: state.buildSha256, buildSha256: sha256,
      reason: 'user-authorized policy classification repair and business scenarios; original deadline and budget retained' })
    state.buildHistory ??= [{ sha256: state.buildSha256, effectiveAt: state.startedAt, reason: 'original sampling build' }]
    state.buildHistory.push({ sha256, previousSha256: state.buildSha256, effectiveAt: resumedAt, reason: 'verified test-message policy classification and business scenarios' })
    state.scenarioHistory ??= [{ version: state.scenarioVersion ?? 'connectivity-v1', effectiveAt: state.startedAt }]
    state.scenarioHistory.push({ version: CLAUDE_SCENARIO_VERSION, effectiveAt: resumedAt })
    state.scenarioVersion = CLAUDE_SCENARIO_VERSION
    state.buildSha256 = sha256
    state.buildPath = snapshot
    state.status = 'active'
    delete state.stopReason
    state.summary = summarizeStability(state)
    const temporary = `${path}.${process.pid}.resume.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
    return { status: state.status, resumedAt, startedAt: state.startedAt, endsAt: state.endsAt, buildSha256: sha256, scenarioVersion: state.scenarioVersion,
      preservedRounds: state.rounds.length, requestsSpent: state.summary.requests, maxRequests: state.maxRequests }
  } finally { await lock.close(); await unlink(`${path}.lock`) }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
  try { console.log(JSON.stringify(await resumeStability({ statePath: option('--state'), buildPath: option('--build', 'lib/index.js') }), null, 2)) }
  catch { console.error('Stability resume refused; state, deadline and stored credentials were not changed.'); process.exitCode = 1 }
}
