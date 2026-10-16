/** Claude Messages over HTTP, with the gateway's tested client envelope. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { createClaudeReplayFetch } from './claude-replay.js'
import { finishClaudeStream } from './claude-stream.js'
import { createClaudeToolNames } from './claude-tools.js'

// Pinned to the request shape verified live on 2026-10-16. No CLI is needed
// to discover this version, send a turn, or run the host's native tools.
const CLIENT_VERSION = '2.1.295'
const USER_AGENT = `claude-cli/${CLIENT_VERSION} (external, sdk-cli)`
const CLIENT_BETA = 'claude-code-20250219'
const UPDATES_BETA = 'thinking-display-updates-2026-08-18'
const THINKING_DISPLAY = Object.freeze({ 'claude-haiku-5-5': 'omitted', 'claude-sonnet-5-5': 'updates', 'claude-opus-5-5': 'updates' })
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * Normal CLI queries include this attribution block; its separate key-check
 * query does not. The checksum behavior was read from the official published
 * client and verified against 2.1.295 with ASCII, Chinese/emoji and short input.
 * It uses the first user text and public version metadata, never a credential.
 */
function attributionBlock(messages) {
  const first = messages?.find(message => message.role === 'user')?.content
  const text = typeof first === 'string' ? first : first?.find?.(block => block.type === 'text')?.text ?? ''
  const sample = [4, 7, 20].map(index => text[index] || '0').join('')
  const suffix = createHash('sha256').update(`59cf53e54c78${sample}${CLIENT_VERSION}`).digest('hex').slice(0, 3)
  return { type: 'text', text: `x-anthropic-billing-header: cc_version=${CLIENT_VERSION}.${suffix}; cc_entrypoint=sdk-cli;` }
}

/** Preserve UUIDs; map other host session ids deterministically, without a key. */
function sessionUuid(value) {
  if (typeof value !== 'string' || value === '') return randomUUID()
  if (UUID.test(value)) return value.toLowerCase()
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Keep pi-ai's Messages conversion, effort, tools, images and signed replay.
 * Only the host-side client envelope is changed. The bearer is always the
 * explicit request key selected by this plugin; there is no credential or
 * subprocess fallback. A client-policy refusal still reaches the route guard.
 */
export function createClaudeApi() {
  const api = anthropicMessagesApi()
  const deviceId = randomBytes(32).toString('hex')
  const adapt = (model, context, options, toolNames) => {
    const sessionId = sessionUuid(options?.sessionId)
    let thinkingUpdates = false
    const suppliedHeaders = Object.fromEntries(Object.entries(options?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]))
    return {
      ...options,
      headers: {
        ...suppliedHeaders,
        'user-agent': USER_AGENT,
        'x-app': 'cli',
        // Claude Code's client constructor uses this header, matching the
        // session_id inside metadata.user_id. Its current native build was
        // also verified against a local dummy endpoint. Do not substitute
        // the unrelated pi-ai affinity header for the vendor session header.
        'x-claude-code-session-id': sessionId,
        'x-session-affinity': null,
        'x-api-key': null,
        authorization: typeof options?.apiKey === 'string' && options.apiKey !== '' ? `Bearer ${options.apiKey}` : null,
      },
      // Add the client beta at the wire boundary, after pi-ai has selected its
      // own feature betas. Setting an options beta would suppress those SDK
      // defaults. Resolve fetch at request time without altering its encoding.
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        const betas = new Set((headers.get('anthropic-beta') ?? '').split(',').map(value => value.trim()).filter(Boolean))
        betas.add(CLIENT_BETA)
        if (thinkingUpdates) betas.add(UPDATES_BETA)
        headers.set('anthropic-beta', [...betas].join(','))
        const fetchImpl = createClaudeReplayFetch(options?.fetch ?? globalThis.fetch, { model, context })
        const response = await fetchImpl(input, { ...init, headers, redirect: 'error' })
        return finishClaudeStream(response, init?.signal ?? (input instanceof Request ? input.signal : undefined))
      },
      onPayload: async (payload, model) => {
        // streamSimple filters provider-specific options such as thinkingDisplay.
        // Apply the CLI's model default at the payload boundary, before the
        // caller hook, preserving explicit display overrides and effort limits.
        const prepared = THINKING_DISPLAY[model.id] && ['adaptive', 'enabled'].includes(payload.thinking?.type)
          ? { ...payload, thinking: { ...payload.thinking, display: options?.thinkingDisplay ?? THINKING_DISPLAY[model.id] } }
          : payload
        const patched = toolNames.encodePayload(await options?.onPayload?.(prepared, model) ?? prepared)
        thinkingUpdates = ['adaptive', 'enabled'].includes(patched.thinking?.type) && patched.thinking.display === 'updates'
        const system = typeof patched.system === 'string' ? [{ type: 'text', text: patched.system }] : patched.system ?? []
        return {
          ...patched,
          // Some gateway channels inject a CLI tool catalog when none was
          // supplied. A title/plain-text request must not call those tools.
          ...(!patched.tools?.length ? { tool_choice: { type: 'none' } } : {}),
          metadata: { ...patched.metadata, user_id: JSON.stringify({ device_id: deviceId, account_uuid: '', session_id: sessionId }) },
          system: [attributionBlock(patched.messages), { type: 'text', text: IDENTITY }, ...system.filter(block => block.text !== IDENTITY && !block.text?.startsWith('x-anthropic-billing-header:'))],
        }
      },
    }
  }
  const invoke = (method, model, context, options) => {
    const names = createClaudeToolNames()
    return names.decodeStream(api[method](model, context, adapt(model, context, options, names)))
  }
  return {
    ...api,
    stream: (model, context, options) => invoke('stream', model, context, options),
    streamSimple: (model, context, options) => invoke('streamSimple', model, context, options),
  }
}
