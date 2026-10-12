#!/usr/bin/env node
/**
 * Live check for the built plugin.
 *
 * Drives the *built* host bundle against the real PackyCode gateway with the
 * key already stored in the DSH credentials file: it reads the account
 * balance, streams one answer per catalog model (one per protocol), rehearses
 * rotation with a deliberately invalid key in front of the real one, and
 * reports how the real host adapter classifies a key rejection — the
 * classification the harness's retry policy reads.
 *
 * It prints no key material. Run it from the repository root after
 * `pnpm run build`:
 *
 *   node scripts/live-check.mjs
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createModels } from '@earendil-works/pi-ai'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

import {
  CLAUDE_CLI_MODES,
  CLI_BACKED_MODEL_IDS,
  PackyCodeKeyRing,
  createClaudeCliAdapter,
  createClaudeRunner,
  createBalanceReader,
  createPackyCodeProfile,
  createPackyCodeProvider,
  createPackyCodeRpc,
  guardKeyRotation,
} from '../lib/index.js'

const PROVIDER = 'packycode'
const CREDENTIAL_NAME = 'PACKY_CODE_API_KEY'
const SESSION_ID = 'live-check-session'

function readStoredKey() {
  const path = join(homedir(), '.dsh', '.credentials.yaml')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`no DSH credentials file at ${path}; store ${CREDENTIAL_NAME} first`)
  }
  const match = new RegExp(`^\\s*${CREDENTIAL_NAME}:\\s*(.+)$`, 'mu').exec(text)
  if (match === null) throw new Error(`${CREDENTIAL_NAME} is not present in ${path}`)
  return match[1].trim().replace(/^['"]|['"]$/gu, '')
}

/** In-memory stand-in for the DSH credential-record service. */
function fakeCredentials() {
  let record
  let chain = Promise.resolve()
  return {
    async readRecord() {
      return record
    },
    modifyRecord(_key, mutate) {
      const run = chain.then(async () => {
        const next = await mutate(record)
        if (next !== undefined) record = next
        return record
      })
      chain = run.then(() => undefined, () => undefined)
      return run
    },
  }
}

/** Compose the route the way `apply()` composes it, around a given ring. */
function routeWithRing(ring) {
  const idByKey = new Map()
  const remember = async () => {
    for (const entry of await ring.secrets()) idByKey.set(entry.key, entry.id)
  }
  const onKeyFailure = (kind, _message, key) => {
    const id = key === undefined ? undefined : idByKey.get(key)
    console.log(`   ! key failure: ${kind} → disabling ${id ?? 'unknown key'}`)
    if (id !== undefined) void ring.disable(id, kind)
  }
  const raw = createPackyCodeProvider()
  const withSessionId = options => (options === undefined || options.sessionId !== undefined
    ? options
    : { ...options, sessionId: SESSION_ID })
  const piProvider = Object.freeze({
    ...raw,
    stream: (model, context, options) => guardKeyRotation(raw.stream(model, context, withSessionId(options)), {
      key: options?.apiKey,
      onKeyFailure,
    }),
    streamSimple: (model, context, options) => guardKeyRotation(raw.streamSimple(model, context, withSessionId(options)), {
      key: options?.apiKey,
      onKeyFailure,
    }),
  })
  const profile = createPackyCodeProfile(piProvider)
  const models = createModels()
  models.setProvider(piProvider)
  const adapter = new PiAiAdapter({
    profiles: () => new Map([[PROVIDER, profile]]),
    resolveApiKey: async () => {
      await remember()
      const active = await ring.activeKey()
      if (active === undefined) throw new Error('no usable key')
      return active.key
    },
    auth: Object.freeze({
      credentials: {
        async read() { return undefined },
        async list() { return [] },
        async modify() { throw new Error('unused') },
        async delete() { throw new Error('unused') },
      },
      authContext: Object.freeze({ env: async () => undefined, fileExists: async () => false }),
    }),
  })
  return { piProvider, profile, models, adapter, remember }
}

async function streamOnce(models, modelId, apiKey) {
  const model = models.getModel(PROVIDER, modelId)
  if (model === undefined) throw new Error(`unknown model ${modelId}`)
  const stream = models.streamSimple(model, {
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
  }, { apiKey, reasoning: 'high', maxTokens: 8192, sessionId: SESSION_ID })
  let text = ''
  for await (const event of stream) {
    if (event.type === 'text_delta') text += event.delta
  }
  const message = await stream.result()
  // The harness classifies a terminal failure from this field, so a rehearsal
  // that ignored it would call a rejected key a success.
  if (message.stopReason === 'error') throw new Error(message.errorMessage ?? 'provider reported an error')
  if (text.trim() === '') {
    const blocks = (message.content ?? []).map(block => block.type).join(',') || 'none'
    throw new Error(`empty answer (stopReason=${message.stopReason}, blocks=${blocks})`)
  }
  return text.trim()
}

/** Drive one request through the real host adapter and report its classification. */
async function adapterFailure(adapter, modelId) {
  const prepared = await adapter.prepareCall(PROVIDER, modelId)
  let finish
  for await (const chunk of prepared.stream({
    provider: PROVIDER,
    model: modelId,
    reasoningEffort: 'high',
    maxTokens: 256,
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'Reply with exactly: ok' }],
      source: { kind: 'user' },
    })],
  })) {
    if (chunk.type === 'finish') finish = chunk
  }
  return finish?.reason
}

async function main() {
  const key = readStoredKey()
  console.log(`stored key: …${key.slice(-4)} (${key.length} chars)\n`)

  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add(key, 'live-check')
  const { models } = routeWithRing(ring)

  console.log('1) account balance')
  const balance = createBalanceReader({
    listKeys: () => ring.secrets(),
    getHosts: () => ({ apiHost: 'https://cf.api.fan', statusHost: 'https://www.packyapi.com' }),
  })
  const value = await balance.read()
  const row = value.keys[0]
  console.log(`   account: remaining $${value.account.remainingUsd} of $${value.account.hardLimitUsd} (used $${value.account.totalUsageUsd})`)
  console.log(`   key "${row.label}": available $${row.usage?.availableUsd} / limit $${row.usage?.limitUsd} (${row.usage?.resetPeriod ?? 'no period'})${row.error === undefined ? '' : ` ERROR ${row.error}`}\n`)

  console.log('2) one answer per model (one per protocol)')
  for (const id of ['deepseek-flash', 'gpt-6.1-sol', 'gpt-6-astra', 'claude-opus-5-5']) {
    const active = await ring.activeKey()
    try {
      const text = await streamOnce(models, id, active.key)
      console.log(`   ${id.padEnd(16)} → ${text.slice(0, 70)}`)
    } catch (error) {
      console.log(`   ${id.padEnd(16)} → FAILED: ${String(error.message).slice(0, 110)}`)
    }
  }

  console.log('\n3) rotation rehearsal: an invalid key in front of the real one')
  const rotationRing = new PackyCodeKeyRing(fakeCredentials())
  await rotationRing.add('sk-invalid-live-check-0001', 'deliberately invalid')
  await rotationRing.add(key, 'real key')
  const rehearsal = routeWithRing(rotationRing)
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await rehearsal.remember()
    const active = await rotationRing.activeKey()
    console.log(`   attempt ${attempt}: using "${active.label}"`)
    try {
      const text = await streamOnce(rehearsal.models, 'deepseek-flash', active.key)
      console.log(`   attempt ${attempt}: answered → ${text.slice(0, 40)}`)
      break
    } catch (error) {
      console.log(`   attempt ${attempt}: failed → ${String(error.message).slice(0, 100)}`)
    }
  }
  const finalState = await rotationRing.list()
  console.log(`   ring now: ${finalState.keys.map(entry => `${entry.label}=${entry.disabled ? `disabled(${entry.disabledReason})` : 'usable'}`).join(', ')}`)

  console.log('\n4) how the host adapter classifies a rejected key (what the retry policy reads)')
  const rejectedRing = new PackyCodeKeyRing(fakeCredentials())
  await rejectedRing.add('sk-invalid-live-check-0002', 'rejected by the gateway')
  const rejected = routeWithRing(rejectedRing)
  const reason = await adapterFailure(rejected.adapter, 'deepseek-flash')
  console.log(`   finish: ${JSON.stringify(reason)?.slice(0, 160)}`)

  if (process.argv.includes('--with-cli')) {
    console.log('\n5) the model-shaped bridge: choosing a Claude model runs the CLI')
    const bridgeRoute = routeWithRing(ring)
    const bridged = createClaudeCliAdapter({
      inner: bridgeRoute.adapter,
      runner: createClaudeRunner({
        resolveCredential: async () => ({ baseUrl: 'https://cf.api.fan', token: key }),
      }),
      resolveMode: () => 'read-only',
      resolveCwd: () => process.cwd(),
    })
    for (const id of CLI_BACKED_MODEL_IDS) {
      const started = Date.now()
      const prepared = await bridged.prepareCall(PROVIDER, id)
      let text = ''
      let finish
      for await (const chunk of prepared.stream({
        provider: PROVIDER,
        model: id,
        sessionId: SESSION_ID,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Reply with exactly: cli-bridge-ok' }], source: { kind: 'user' } })],
        signal: undefined,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'finish') finish = chunk.reason
      }
      console.log(finish?.kind === 'stop'
        ? `   ${id.padEnd(18)} → ${text.slice(0, 60)} (${Math.round((Date.now() - started) / 1000)}s)`
        : `   ${id.padEnd(18)} → FAILED: ${String(finish?.failure?.message ?? 'no finish').slice(0, 160)}`)
    }
  } else {
    console.log('\n5) model-shaped bridge skipped (pass --with-cli to run the real CLI)')
    console.log(`   CLI-backed models: ${CLI_BACKED_MODEL_IDS.join(', ')} · modes: ${Object.keys(CLAUDE_CLI_MODES).join(', ')}`)
  }

  console.log('\n6) what the settings panel receives over RPC')
  const rpcRing = new PackyCodeKeyRing(fakeCredentials())
  const rpcBalance = createBalanceReader({
    listKeys: () => rpcRing.secrets(),
    getHosts: () => ({ apiHost: 'https://cf.api.fan', statusHost: 'https://www.packyapi.com' }),
  })
  const handler = createPackyCodeRpc({
    ring: rpcRing,
    balance: rpcBalance,
    hosts: () => ({ apiHost: 'https://cf.api.fan', statusHost: 'https://www.packyapi.com' }),
    preference: { writable: false, set: async () => {} },
  })
  const added = await handler('keys/add', { key, label: 'rpc check' })
  console.log(`   keys/add ok=${added.ok}; status=${JSON.stringify(added.value.keys)}`)
  const projection = await handler('balance')
  const active = projection.value.keys.find(entry => entry.id === projection.value.activeId)
  console.log(`   activeId=${projection.value.activeId} label=${active?.label} available=$${active?.usage?.availableUsd} reset=${active?.usage?.resetPeriod}`)
  console.log(`   account remaining=$${projection.value.account.remainingUsd} limit=$${projection.value.account.hardLimitUsd}`)
  console.log(`   projection carries key material: ${JSON.stringify(projection).includes(key) ? 'YES (bug)' : 'no'}`)
}

await main()
