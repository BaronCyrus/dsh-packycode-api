#!/usr/bin/env node
/**
 * Live native Gemini tool continuation through the built route and durable
 * DSH message assembler. Reads only the plugin's stored key; no DSH process
 * is started or modified. Each round spends two small model calls, plus the
 * route's one possible resend of a refused signature.
 *
 * node scripts/gemini-tool-check.mjs [--model gemini-3.8-flash]
 *   [--rounds 1..5] [--reasoning low|medium|high] [--key-label LABEL]
 */
import { createHash, randomUUID } from 'node:crypto'
import { BlockAssembler, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

import { PackyCodeKeyRing, createRouteAdapter } from '../lib/index.js'
import { readStoredKey } from './stored-key.mjs'

const arg = name => {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}
const model = arg('--model') ?? 'gemini-3.8-flash'
const rounds = Number(arg('--rounds') ?? 1)
const reasoningEffort = arg('--reasoning') ?? 'low'
if (model !== 'gemini-3.8-flash') throw new Error('choose a native Gemini catalog model')
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('--rounds must be 1..5')
if (!['low', 'medium', 'high'].includes(reasoningEffort)) throw new Error('--reasoning must be low, medium or high')
const key = await readStoredKey({ label: arg('--key-label') })
const mask = value => String(value).split(key).join(`…${key.slice(-4)}`)
let record
const ring = new PackyCodeKeyRing({
  readRecord: async () => record,
  modifyRecord: async (_id, mutate) => { record = await mutate(record) ?? record; return record },
})
await ring.add(key, 'live check')
const adapter = createRouteAdapter({
  ring, fallbackSessionId: 'gemini-tool-live-check',
  keys: { active: () => ring.activeKey(), forRequest: (_model, token) => token, onKeyFailure: kind => console.log(`key failure: ${kind}`) },
})
const tools = [{ name: 'echo', description: 'Return the supplied text unchanged.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }]
const originalFetch = globalThis.fetch
let replayHashes = []
let replayStatuses = []
// Diagnostic instrumentation is confined to this isolated CLI process. Only
// counts and equality are printed; bodies, signatures and headers stay private.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  let isReplay = false
  if (request.method === 'POST' && url.pathname === `/v1beta/models/${model}:streamGenerateContent`) {
    const body = await request.clone().json()
    isReplay = body.contents?.some(content => content.parts?.some(part => part.functionResponse)) ?? false
    if (isReplay) replayHashes.push(createHash('sha256').update(JSON.stringify(body)).digest('hex'))
  }
  const response = await originalFetch(input, init)
  if (isReplay) replayStatuses.push(response.status)
  return response
}
const turn = async messages => {
  const assembled = new BlockAssembler()
  const prepared = await adapter.prepareCall('packycode', model)
  for await (const chunk of prepared.stream({
    provider: 'packycode', model, sessionId: 'gemini-tool-live-check',
    reasoningEffort, maxTokens: 2048, signal: AbortSignal.timeout(90000), tools, messages,
  })) assembled.push(chunk)
  return assembled
}
try {
  console.log(`${model} · ${reasoningEffort} · stored key …${key.slice(-4)}`)
  let passed = 0
  for (let round = 1; round <= rounds; round += 1) {
    console.log(`round ${round}: tool call`)
    const text = `ping-${randomUUID()}`
    const messages = [createUserMessage({ content: [{ type: 'text', text: `Call echo once with text "${text}". After the tool returns, reply with exactly: ok` }], source: { kind: 'user' } })]
    const first = await turn(messages)
    const call = first.blocks().find(block => block.type === 'tool-call' && block.name === 'echo')
    if (call === undefined || JSON.parse(call.arguments).text !== text) throw new Error(mask(`tool call failed: ${JSON.stringify(first.finish)}`))
    const signed = first.replayState?.blocks.some(block => typeof block.thoughtSignature === 'string' && block.thoughtSignature.length > 0)
    if (!signed) throw new Error('the native tool call carried no durable thought signature')
    messages.push(first.message({ kind: 'model', provider: 'packycode', model, replayState: first.replayState }))
    messages.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text }], isError: false }))
    replayHashes = []
    replayStatuses = []
    const second = await turn(JSON.parse(JSON.stringify(messages)))
    const answer = second.blocks().filter(block => block.type === 'text').map(block => block.text).join('').trim()
    const unchanged = new Set(replayHashes).size === 1
    console.log(mask(JSON.stringify({ round, finish: second.finish, answer, replaySends: replayHashes.length, replayStatuses, unchanged })))
    if (second.finish.kind !== 'stop' || answer.toLowerCase() !== 'ok' || !unchanged) throw new Error('native tool continuation failed')
    passed += 1
  }
  console.log(`${passed}/${rounds} native tool continuations passed`)
} catch (error) {
  console.error(mask(error.message))
  process.exitCode = 1
} finally {
  globalThis.fetch = originalFetch
}
