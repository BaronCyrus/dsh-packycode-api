/**
 * The MCP server through which the Claude Code CLI sees DSH's tools.
 *
 * The CLI runs with its own tools disabled. Each tool the DSH request offers
 * is listed here instead, so the CLI's request carries DSH's exact names,
 * descriptions and schemas (under the `mcp__dsh__` prefix). A call the model
 * makes is never executed here: DSH executes it — with its own permissions,
 * sandbox, plan-mode gate and UI — and the result it sends on the next step
 * answers the call the CLI is holding open.
 *
 * One server per CLI process: a stateless, JSON-response Streamable HTTP
 * endpoint bound to 127.0.0.1, guarded by a random capability that only the
 * owner-only config file carries. No API key or user data crosses it.
 *
 * @module dsh-packycode-api/claude-mcp-bridge
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

/** The MCP server name; the CLI exposes its tools as `mcp__dsh__<name>`. */
export const MCP_SERVER_NAME = 'dsh'
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`
/** Tool arguments can carry whole files; bound them, but generously. */
const MAX_BODY_BYTES = 64 * 1024 * 1024
const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = value => (typeof value === 'string' && value.length <= 256) || (typeof value === 'number' && Number.isSafeInteger(value))

class RpcError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** An Anthropic tool_result block as an MCP CallToolResult. */
export function toolResultToMcp(block) {
  const parts = typeof block?.content === 'string' ? [{ type: 'text', text: block.content }] : Array.isArray(block?.content) ? block.content : []
  const content = []
  for (const part of parts) {
    if (part?.type === 'text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text })
    else if (part?.type === 'image' && part.source?.type === 'base64') content.push({ type: 'image', data: part.source.data, mimeType: part.source.media_type })
    else if (part !== undefined) content.push({ type: 'text', text: JSON.stringify(part) })
  }
  return { content, ...(block?.is_error === true ? { isError: true } : {}) }
}

/**
 * Start a bridge.
 * @param options - the tools to list (Anthropic tool definitions whose names
 *   carry the `mcp__dsh__` prefix), and the call sink: `onCall({ toolUseId,
 *   name, arguments })` returns a promise of the MCP result; `toolUseId` is
 *   undefined when the CLI does not send it.
 * @returns `{ url, authorization, setTools, close }`.
 */
export async function startClaudeMcpBridge({ tools = [], onCall, version = '1.0.0', serverFactory = createServer } = {}) {
  if (typeof onCall !== 'function') throw new Error('the Claude MCP bridge needs a call sink')
  const capability = Buffer.from(`Bearer ${randomBytes(32).toString('hex')}`)
  let listed = []
  const setTools = next => {
    listed = (Array.isArray(next) ? next : [])
      .filter(tool => typeof tool?.name === 'string' && tool.name.startsWith(MCP_TOOL_PREFIX) && record(tool.input_schema))
      .map(tool => ({ name: tool.name.slice(MCP_TOOL_PREFIX.length), description: typeof tool.description === 'string' ? tool.description : '', inputSchema: tool.input_schema }))
  }
  setTools(tools)
  let closed = false
  let origin

  const reply = (res, status, value) => {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(value === undefined ? '' : JSON.stringify(value))
  }
  const authorized = req => {
    const actual = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '')
    return actual.length === capability.length && timingSafeEqual(actual, capability)
  }

  const dispatch = async message => {
    const params = message.params
    switch (message.method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title: 'DeepSeek Harness', version },
        }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: listed }
      case 'tools/call': {
        if (!record(params) || typeof params.name !== 'string') throw new RpcError(-32602, 'Invalid tool call')
        // Current CLIs name the model's tool_use id; the sink matches older ones by name.
        const id = params._meta?.['claudecode/toolUseId']
        return onCall({ toolUseId: typeof id === 'string' && id !== '' ? id : undefined, name: params.name, arguments: params.arguments })
      }
      default:
        throw new RpcError(-32601, 'Method not found')
    }
  }

  const handle = async (req, res) => {
    // Loopback only, capability required; Host/Origin checks also refuse DNS
    // rebinding and browser cross-origin calls.
    if (closed || req.headers.host !== new URL(origin).host || (req.headers.origin !== undefined && req.headers.origin !== origin)) return reply(res, 403)
    if (!authorized(req)) return reply(res, 401)
    if (req.url !== '/mcp') return reply(res, 404)
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return reply(res, 405)
    }
    const declared = req.headers['content-length']
    if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) return reply(res, 413)
    const chunks = []
    let size = 0
    try {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length
        if (size > MAX_BODY_BYTES) { req.resume(); return reply(res, 413) }
        chunks.push(chunk)
      }
    } catch { return reply(res, 400) }
    let message
    try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
    if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (Object.hasOwn(message, 'id') && !validId(message.id))) {
      // A JSON-RPC response from the client (to a request this server never makes) is accepted and ignored.
      if (record(message) && message.jsonrpc === '2.0' && message.method === undefined) return reply(res, 202)
      return reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } })
    }
    if (!Object.hasOwn(message, 'id')) return reply(res, 202)
    try {
      const result = await dispatch(message)
      reply(res, 200, { jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      reply(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: error instanceof RpcError ? error.code : -32603, message: error instanceof RpcError ? error.message : 'Internal error' } })
    }
  }

  const server = serverFactory((req, res) => { void handle(req, res).catch(() => reply(res, 500)) })
  // A call stays open while DSH executes the tool, which can wait on the user.
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.maxConnections = 32
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  server.unref()
  origin = `http://127.0.0.1:${server.address().port}`

  let closing
  return {
    url: `${origin}/mcp`,
    authorization: capability.toString(),
    setTools,
    close() {
      if (closing !== undefined) return closing
      closed = true
      closing = new Promise(resolve => server.close(() => resolve()))
      server.closeAllConnections()
      return closing
    },
  }
}
