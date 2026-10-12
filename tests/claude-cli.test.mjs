import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  CLAUDE_CLI_MODES,
  DEFAULT_CLAUDE_MODE,
  buildClaudeArgs,
  buildClaudeEnvironment,
  createClaudeRunner,
  findClaudeBinary,
  parseClaudeResult,
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

test('an explicit binary path wins and PATH is the fallback', () => {
  assert.equal(findClaudeBinary('/custom/claude'), '/custom/claude')
  assert.equal(typeof findClaudeBinary(''), 'string')
})
