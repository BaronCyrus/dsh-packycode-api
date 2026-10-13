import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  CLAUDE_CLI_MODES,
  DEFAULT_APPEND_SYSTEM_PROMPT,
  DEFAULT_CLAUDE_MODE,
  buildClaudeArgs,
  buildClaudeEnvironment,
  buildClaudeInput,
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

/** A spawn stand-in that records its call and stdin, and replays a scripted child. */
function stubSpawn({ stdout = `${JSON.stringify(PAYLOAD)}\n`, stderr = '', code = 0, hang = false } = {}) {
  const calls = []
  const spawnImpl = (binary, args, options) => {
    const call = { binary, args, options, stdin: '', stdinClosed: false }
    calls.push(call)
    const child = new EventEmitter()
    child.stdin = {
      on: () => child.stdin,
      end: input => {
        call.stdin += input ?? ''
        call.stdinClosed = true
      },
    }
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

test('builds the argv the CLI documents, with the prompt kept off it', () => {
  assert.deepEqual(buildClaudeArgs({}), [
    '-p', '--output-format', 'json',
    '--append-system-prompt', DEFAULT_APPEND_SYSTEM_PROMPT,
    '--allowedTools', ...CLAUDE_CLI_MODES[DEFAULT_CLAUDE_MODE].allowedTools,
  ])
  const full = buildClaudeArgs({ mode: 'full', model: 'claude-opus-5-5' })
  assert.deepEqual(full, ['-p', '--output-format', 'json', '--model', 'claude-opus-5-5', '--append-system-prompt', DEFAULT_APPEND_SYSTEM_PROMPT, '--dangerously-skip-permissions'])
  assert.deepEqual(buildClaudeArgs({ mode: 'read-only' }).slice(-4), ['--allowedTools', 'Read', 'Grep', 'Glob'])
  // A streaming run reads its prompt as stream-json from stdin.
  assert.deepEqual(buildClaudeArgs({ stream: true }).slice(0, 7), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'])
  // Extra instructions are appended; the CLI's own system prompt and tools stay.
  const titled = buildClaudeArgs({ mode: 'read-only', model: 'claude-haiku-5-5', appendSystemPrompt: '  Return only the title.  ' })
  assert.deepEqual(titled.slice(3), ['--model', 'claude-haiku-5-5', '--append-system-prompt', 'Return only the title.', '--allowedTools', 'Read', 'Grep', 'Glob'])
  assert.equal(titled.includes('--system-prompt'), false)
  assert.equal(titled.includes('--tools'), false)
  // Every run carries appended instructions: in print mode that is what makes
  // the official CLI introduce itself to the model as Claude Code.
  const blank = buildClaudeArgs({ appendSystemPrompt: '   ' })
  assert.equal(blank[blank.indexOf('--append-system-prompt') + 1], DEFAULT_APPEND_SYSTEM_PROMPT)
})

test('builds the stdin payload: plain text, or one stream-json user message with images', () => {
  assert.equal(buildClaudeInput({ prompt: '多行\n提示' }), '多行\n提示')
  const line = buildClaudeInput({
    stream: true,
    content: [
      { type: 'text', text: '看图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: '' },
    ],
  })
  assert.ok(line.endsWith('\n'))
  assert.deepEqual(JSON.parse(line), {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
  })
  assert.deepEqual(JSON.parse(buildClaudeInput({ stream: true, prompt: 'hi' })).message.content, [{ type: 'text', text: 'hi' }])
})

test('refuses a missing prompt, an unknown mode, an oversized prompt, and images without streaming', () => {
  assert.throws(() => buildClaudeInput({ prompt: '   ' }), /non-empty prompt/u)
  assert.throws(() => buildClaudeArgs({ mode: 'yolo' }), /mode must be one of/u)
  assert.throws(() => buildClaudeInput({ prompt: 'x'.repeat(100_001) }), /too long/u)
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
  assert.throws(() => buildClaudeInput({ content: [image] }), /streaming CLI input/u)
  assert.throws(() => buildClaudeInput({ stream: true, content: Array.from({ length: 21 }, () => image) }), /at most 20 images/u)
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
  // The prompt arrives on stdin, which is then closed; argv never carries it.
  assert.equal(calls[0].stdin, 'say ok')
  assert.equal(calls[0].stdinClosed, true)
  assert.equal(calls[0].args.includes('say ok'), false)
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe'])
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
  // The runner unrefs its timer, and this stub is not a real process, so
  // nothing else keeps the loop alive. Node 22's test runner then cancels the
  // still-pending assertion instead of waiting for the timeout.
  const pin = setInterval(() => {}, 1000)
  try {
    await assert.rejects(() => runner.run({ prompt: 'x' }), /timed out/u)
  } finally {
    clearInterval(pin)
  }
})

const STREAM_LINES = [
  { type: 'system', subtype: 'init', claude_code_version: '2.1.295', model: 'claude-opus-5-5' },
  { type: 'system', subtype: 'status', status: 'requesting' },
  { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1240, error_status: 503, error: 'server_error' },
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
    { type: 'started', version: '2.1.295', model: 'claude-opus-5-5' },
    { type: 'retry', attempt: 1, maxRetries: 10, delayMs: 1240, status: 503, error: 'server_error' },
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
  assert.deepEqual(JSON.parse(calls[0].stdin).message.content, [{ type: 'text', text: 'x' }])
  assert.equal(events.filter(event => event.type === 'result').length, 1)
  const { result } = events.at(-1)
  assert.equal(result.outputTokens, 300)
  assert.equal(result.cacheReadTokens, 85_760)
  assert.equal(result.cacheWriteTokens, 886)
  assert.deepEqual(events.filter(event => event.type === 'text'), [{ type: 'text', text: '完成' }])
})

test('each run resolves its key for its own model and names that key, never the token', async () => {
  const { spawnImpl, calls } = stubSpawn({ stdout: `${STREAM_LINES.map(line => JSON.stringify(line)).join('\n')}\n` })
  const asked = []
  let label = 'no-cc'
  const runner = createClaudeRunner({
    resolveCredential: async ({ model }) => {
      asked.push(model)
      return {
        baseUrl: 'https://cf.api.fan',
        token: label === 'no-cc' ? 'sk-without-claude-AAAA' : 'sk-with-claude-BBBB',
        label,
        model,
        groups: label === 'no-cc' ? ['codex'] : ['cc'],
        required: ['cc', 'cc-sale'],
        covers: label !== 'no-cc',
      }
    },
    spawnImpl,
  })
  const run = async () => {
    const events = []
    for await (const event of runner.stream({ prompt: 'x', model: 'claude-opus-5-5' })) events.push(event)
    return events
  }
  const first = await run()
  label = 'cc'
  const second = await run()
  // Resolved per run: the second run sees the switch.
  assert.deepEqual(asked, ['claude-opus-5-5', 'claude-opus-5-5'])
  assert.equal(calls[0].options.env.ANTHROPIC_AUTH_TOKEN, 'sk-without-claude-AAAA')
  assert.equal(calls[1].options.env.ANTHROPIC_AUTH_TOKEN, 'sk-with-claude-BBBB')
  assert.deepEqual(first[0], { type: 'key', label: 'no-cc', model: 'claude-opus-5-5', groups: ['codex'], required: ['cc', 'cc-sale'], covers: false })
  assert.equal(second[0].label, 'cc')
  assert.doesNotMatch(JSON.stringify([...first, ...second]), /sk-with|sk-without/u)
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
      queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify(STREAM_LINES.find(line => line.event?.delta?.type === 'thinking_delta'))}\n`))
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

test('a streaming CLI that prints nothing after starting is stopped with its stderr', async () => {
  const { spawnImpl } = stubSpawn({ hang: true })
  let child
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://cf.api.fan', token: 'sk-k' }),
    spawnImpl: (...args) => {
      child = spawnImpl(...args)
      queueMicrotask(() => child.stderr.emit('data', 'waiting for git-bash'))
      return child
    },
    startupTimeoutMs: 20,
  })
  const pin = setInterval(() => {}, 1000)
  try {
    await assert.rejects(async () => {
      for await (const _event of runner.stream({ prompt: 'x' })) {
        // nothing arrives
      }
    }, /printed nothing within 0s of starting and was stopped: waiting for git-bash/u)
  } finally {
    clearInterval(pin)
  }
  assert.equal(child.signalCode, 'SIGTERM')
})

test('the startup watchdog leaves a JSON run alone: it prints only at the end', async () => {
  const { spawnImpl } = stubSpawn()
  const runner = createClaudeRunner({
    resolveCredential: async () => ({ baseUrl: 'https://cf.api.fan', token: 'sk-k' }),
    spawnImpl,
    startupTimeoutMs: 1,
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal((await runner.run({ prompt: 'x' })).result, 'cli-ok')
})
