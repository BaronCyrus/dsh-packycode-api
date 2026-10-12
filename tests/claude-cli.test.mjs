import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  CLAUDE_CLI_MODES,
  DEFAULT_CLAUDE_MODE,
  buildClaudeArgs,
  buildClaudeEnvironment,
  createClaudeRunner,
  findClaudeBinary,
  parseClaudeResult,
  readClaudeStreamEvents,
  summarizeToolUse,
} from '../src/claude-cli.js'

const PAYLOAD = {
  is_error: false,
  result: 'cli-ok',
  type: 'result',
  duration_ms: 22736,
  total_cost_usd: 0.18625375,
  usage: { input_tokens: 2, output_tokens: 7 },
}

/** A spawn stand-in that records its call and replays a scripted child. */
function stubSpawn({ stdout = `${JSON.stringify(PAYLOAD)}\n`, stderr = '', code = 0, hang = false } = {}) {
  const calls = []
  const spawnImpl = (binary, args, options) => {
    calls.push({ binary, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.exitCode = null
    child.signalCode = null
    child.kill = signal => {
      child.signalCode = signal
      queueMicrotask(() => child.emit('close', null, signal))
      return true
    }
    if (!hang) {
      queueMicrotask(() => {
        if (stdout !== '') child.stdout.emit('data', stdout)
        if (stderr !== '') child.stderr.emit('data', stderr)
        child.exitCode = code
        child.emit('close', code, null)
      })
    }
    return child
  }
  return { spawnImpl, calls }
}

test('builds the argv the CLI documents', () => {
  assert.deepEqual(buildClaudeArgs({ prompt: 'do it' }), ['-p', 'do it', '--output-format', 'json', '--allowedTools', ...CLAUDE_CLI_MODES[DEFAULT_CLAUDE_MODE].allowedTools])
  const full = buildClaudeArgs({ prompt: 'do it', mode: 'full', model: 'claude-opus-5-5' })
  assert.deepEqual(full, ['-p', 'do it', '--output-format', 'json', '--model', 'claude-opus-5-5', '--dangerously-skip-permissions'])
  assert.deepEqual(buildClaudeArgs({ prompt: 'x', mode: 'read-only' }).slice(4), ['--allowedTools', 'Read', 'Grep', 'Glob'])
  // Extra instructions are appended; the CLI's own system prompt and tools stay.
  const titled = buildClaudeArgs({ prompt: 'x', mode: 'read-only', model: 'claude-haiku-5-5', appendSystemPrompt: '  Return only the title.  ' })
  assert.deepEqual(titled.slice(4), ['--model', 'claude-haiku-5-5', '--append-system-prompt', 'Return only the title.', '--allowedTools', 'Read', 'Grep', 'Glob'])
  assert.equal(titled.includes('--system-prompt'), false)
  assert.equal(titled.includes('--tools'), false)
  assert.equal(buildClaudeArgs({ prompt: 'x', appendSystemPrompt: '   ' }).includes('--append-system-prompt'), false)
})

test('refuses a missing prompt, an unknown mode, and an oversized prompt', () => {
  assert.throws(() => buildClaudeArgs({ prompt: '   ' }), /non-empty prompt/u)
  assert.throws(() => buildClaudeArgs({ prompt: 'x', mode: 'yolo' }), /mode must be one of/u)
  assert.throws(() => buildClaudeArgs({ prompt: 'x'.repeat(100_001) }), /too long/u)
})

test('the child environment carries this plugin endpoint and key, not the ambient ones', () => {
  const env = buildClaudeEnvironment({
    baseUrl: 'https://cf.api.fan',
    token: 'sk-plugin-key',
    configDir: '/tmp/claude-home',
    parent: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ambient', CLAUDE_CODE_OAUTH_TOKEN: 'oat', HOME: '/Users/x' },
  })
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://cf.api.fan')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-plugin-key')
  // An isolated config home is what stops ~/.claude/settings.json from winning.
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/claude-home')
  assert.equal('ANTHROPIC_API_KEY' in env, false)
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false)
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.DISABLE_AUTOUPDATER, '1')
  assert.throws(() => buildClaudeEnvironment({ baseUrl: 'https://cf.api.fan', token: '' }), /no PackyCode API key/u)
})

test('reads the payload the CLI prints', () => {
  assert.equal(parseClaudeResult(JSON.stringify(PAYLOAD)).result, 'cli-ok')
  assert.equal(parseClaudeResult(`warning: something\n${JSON.stringify(PAYLOAD)}\n`).is_error, false)
  assert.equal(parseClaudeResult('not json at all'), undefined)
  assert.equal(parseClaudeResult('{"other":1}'), undefined)
})

test('runs the binary with the resolved credential and returns its accounting', async () => {
  const { spawnImpl, calls } = stubSpawn()
  const runner = createClaudeRunner({
    binary: '/opt/claude',
    configDir: '/tmp/claude-home',
    resolveCredential: async () => ({ baseUrl: 'https://cf.api.fan', token: 'sk-plugin-key' }),
    spawnImpl,
  })
  const value = await runner.run({ prompt: 'say ok', mode: 'read-only', cwd: '/work' })
  assert.equal(value.result, 'cli-ok')
  assert.equal(value.costUsd, 0.18625375)
  assert.equal(value.mode, 'read-only')
  assert.equal(value.outputTokens, 7)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].binary, '/opt/claude')
  assert.equal(calls[0].options.cwd, '/work')
  assert.equal(calls[0].options.env.ANTHROPIC_AUTH_TOKEN, 'sk-plugin-key')
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, '/tmp/claude-home')
})

test("a failing CLI reports the reason it printed", async () => {
  const { spawnImpl } = stubSpawn({
    stdout: `${JSON.stringify({ is_error: true, result: 'Failed to authenticate. API Error: 401 无效的令牌' })}\n`,
    code: 1,
  })
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://cf.api.fan', token: 'sk-k' }),
    spawnImpl,
  })
  await assert.rejects(() => runner.run({ prompt: 'x' }), /Failed to authenticate/u)
})

test('a CLI that prints nothing reports its stderr', async () => {
  const { spawnImpl } = stubSpawn({ stdout: '', stderr: 'boom from the CLI', code: 2 })
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://cf.api.fan', token: 'sk-k' }),
    spawnImpl,
  })
  await assert.rejects(() => runner.run({ prompt: 'x' }), /code 2: boom from the CLI/u)
})

test('an abort kills the child instead of leaving it running', async () => {
  const { spawnImpl, calls } = stubSpawn({ hang: true })
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://cf.api.fan', token: 'sk-k' }),
    spawnImpl,
  })
  const controller = new AbortController()
  const pending = runner.run({ prompt: 'long task', signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort()
  await assert.rejects(() => pending, /aborted/u)
  assert.equal(calls.length, 1)
})

test('a timeout stops a hung CLI', async () => {
  const { spawnImpl } = stubSpawn({ hang: true })
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://cf.api.fan', token: 'sk-k' }),
    spawnImpl,
    timeoutMs: 20,
  })
  await assert.rejects(() => runner.run({ prompt: 'x' }), /timed out/u)
})

const STREAM_LINES = [
  { type: 'system', subtype: 'init' },
  { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 2, cache_creation_input_tokens: 443, cache_read_input_tokens: 42_880, output_tokens: 1 } } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一想' } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"comm' } } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'git   status\n--short' } }], usage: { input_tokens: 2, cache_creation_input_tokens: 443, cache_read_input_tokens: 42_880 } } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'fatal: not a git repository' }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'fine' }] } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成' } } },
  { type: 'result', is_error: false, result: '完成', total_cost_usd: 0.2, usage: { input_tokens: 4, output_tokens: 300, cache_read_input_tokens: 85_760, cache_creation_input_tokens: 886 } },
]

test('reads live text, thinking, tool calls, tool failures, and request usage from stream-json', () => {
  const events = STREAM_LINES.flatMap(readClaudeStreamEvents)
  assert.deepEqual(events.slice(0, -1), [
    { type: 'request-usage', usage: { inputTokens: 2, cacheReadTokens: 42_880, cacheWriteTokens: 443 } },
    { type: 'block', kind: 'reasoning' },
    { type: 'reasoning', text: '想一想' },
    { type: 'request-usage', usage: { inputTokens: 2, cacheReadTokens: 42_880, cacheWriteTokens: 443 } },
    { type: 'tool', id: 'toolu_1', summary: 'Bash · git status --short' },
    { type: 'tool-error', id: 'toolu_1', text: 'fatal: not a git repository' },
    { type: 'block', kind: 'text' },
    { type: 'text', text: '完成' },
  ])
  assert.equal(events.at(-1).type, 'result')
})

test('a tool summary names the input a reader looks for', () => {
  assert.equal(summarizeToolUse('Read', { file_path: '/a/b.cs', limit: 20 }), 'Read · /a/b.cs')
  assert.equal(summarizeToolUse('Grep', { pattern: 'foo', path: '/x' }), 'Grep · foo')
  assert.equal(summarizeToolUse('TodoWrite', { todos: [] }), 'TodoWrite')
  assert.equal(summarizeToolUse('Bash', { command: 'x'.repeat(400) }).length, 'Bash · '.length + 160)
})

test('the streaming runner yields events as they arrive and closes with the summed accounting', async () => {
  const { spawnImpl, calls } = stubSpawn({ stdout: `${STREAM_LINES.map(line => JSON.stringify(line)).join('\n')}\n` })
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://cf.api.fan', token: 'sk-k' }),
    spawnImpl,
  })
  const events = []
  for await (const event of runner.stream({ prompt: 'x' })) events.push(event)
  assert.ok(calls[0].args.includes('--include-partial-messages'))
  assert.equal(events.filter(event => event.type === 'result').length, 1)
  const { result } = events.at(-1)
  assert.equal(result.outputTokens, 300)
  assert.equal(result.cacheReadTokens, 85_760)
  assert.equal(result.cacheWriteTokens, 886)
  assert.deepEqual(events.filter(event => event.type === 'text'), [{ type: 'text', text: '完成' }])
})

/** A spawn stand-in whose stdout is a real byte stream fed the given buffers. */
function byteStreamSpawn(buffers) {
  const spawnImpl = () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exitCode = null
    child.signalCode = null
    child.kill = () => true
    child.stdout.on('end', () => {
      child.exitCode = 0
      child.emit('close', 0, null)
    })
    queueMicrotask(async () => {
      for (const buffer of buffers) {
        child.stdout.write(buffer)
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      child.stdout.end()
    })
    return child
  }
  return spawnImpl
}

test('a multi-byte character split across two pipe reads arrives intact', async () => {
  const bytes = Buffer.from(`${JSON.stringify({ ...PAYLOAD, result: '中文回答' })}\n`)
  const cut = bytes.indexOf(Buffer.from('文')) + 1
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://cf.api.fan', token: 'sk-k' }),
    spawnImpl: byteStreamSpawn([bytes.subarray(0, cut), bytes.subarray(cut)]),
  })
  const value = await runner.run({ prompt: 'x' })
  assert.equal(value.result, '中文回答')
})

test('a consumer that stops reading early kills the streaming CLI', async () => {
  const { spawnImpl } = stubSpawn({ hang: true })
  let child
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://cf.api.fan', token: 'sk-k' }),
    spawnImpl: (...args) => {
      child = spawnImpl(...args)
      queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify(STREAM_LINES[3])}\n`))
      return child
    },
  })
  for await (const event of runner.stream({ prompt: 'x' })) {
    assert.equal(event.type, 'reasoning')
    break
  }
  assert.equal(child.signalCode, 'SIGTERM')
})

test('an explicit binary path wins and PATH is the fallback', () => {
  assert.equal(findClaudeBinary('/custom/claude'), '/custom/claude')
  assert.equal(typeof findClaudeBinary(''), 'string')
})
