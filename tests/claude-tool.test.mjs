import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../src/index.js'

/**
 * A stand-in for the `claude` binary: it records the argv and the environment
 * it was given, then prints the JSON payload the real CLI prints.
 */
function writeStubCli(dir) {
  const record = join(dir, 'invocation.json')
  const script = join(dir, 'claude-stub.mjs')
  writeFileSync(script, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { stdin += chunk })
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({
    argv: process.argv.slice(2),
    stdin,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    token: process.env.ANTHROPIC_AUTH_TOKEN,
    configDir: process.env.CLAUDE_CONFIG_DIR,
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    cwd: process.cwd(),
  }))
  process.stdout.write(JSON.stringify({
    is_error: false,
    result: 'stub-answer',
    duration_ms: 1234,
    total_cost_usd: 0.5,
    usage: { input_tokens: 3, output_tokens: 4 },
  }) + '\\n')
})
`)
  chmodSync(script, 0o755)
  return { script, record }
}

function fakeCredentials(seedKey) {
  let record = seedKey === undefined ? undefined : {
    kind: 'grant',
    payload: { version: 1, activeId: 'k1', keys: [{ id: 'k1', label: 'stub', key: seedKey, addedAt: 1 }] },
  }
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

function contextWithTools(credentials, dir) {
  const registered = { tools: [], effects: [], injected: [] }
  const ctx = {
    credentials,
    attachments: undefined,
    logger: { warn: () => {} },
    llm: { registerAdapter: () => () => {}, registerConfigurableProviders: () => () => {} },
    get: () => undefined,
    inject(services, callback) {
      registered.injected.push(services)
      if (services.includes('settings')) return callback({ settings: { installSection: () => {} } })
      if (services.includes('connection')) return callback({ connection: { rpc: { handle: () => () => {} } } })
      if (services.includes('tools')) {
        return callback({
          tools: {
            register(definition) {
              registered.tools.push(definition)
              return () => {}
            },
          },
        })
      }
      return callback(ctx)
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    configDir: dir,
  }
  return { ctx, registered }
}

test('the registered tool runs the CLI with the plugin endpoint, key, and session workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'packy-cli-'))
  const { script, record } = writeStubCli(dir)
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const { ctx, registered } = contextWithTools(fakeCredentials('sk-stub-tool-key-0001'), dir)
  apply(ctx, { claudeCliPath: script, apiHost: 'https://cf.example', statusHost: 'https://status.example' })

  assert.equal(registered.tools.length, 1)
  const tool = registered.tools[0]
  const value = await tool.execute(
    { prompt: 'summarize the repo', mode: 'read-only' },
    { signal: undefined, agent: { session: { header: { cwd: workspace } } } },
  )

  assert.equal(value.result, 'stub-answer')
  assert.equal(value.costUsd, 0.5)
  assert.equal(value.durationMs, 1234)
  assert.equal(value.mode, 'read-only')

  const seen = JSON.parse(readFileSync(record, 'utf8'))
  // The plugin's endpoint and key reach the child, not the user's ~/.claude.
  assert.equal(seen.baseUrl, 'https://cf.example')
  assert.equal(seen.token, 'sk-stub-tool-key-0001')
  assert.equal(seen.apiKey, null)
  assert.match(seen.configDir, /packycode-claude-cli/u)
  // The default working directory is the session workspace.
  assert.equal(seen.cwd, realpathSync(workspace))
  // The task arrives on stdin; argv carries the switches and the delegation note.
  assert.equal(seen.stdin, 'summarize the repo')
  assert.equal(seen.argv.includes('summarize the repo'), false)
  assert.deepEqual(seen.argv.slice(0, 4), ['-p', '--output-format', 'json', '--append-system-prompt'])
  assert.match(seen.argv[4], /claude_code tool/u)
  assert.deepEqual(seen.argv.slice(5), ['--allowedTools', 'Read', 'Grep', 'Glob'])

  // A rendered result carries the answer plus the CLI's accounting.
  const [block] = tool.output.render({}, value)
  assert.match(block.text, /stub-answer/u)
  assert.match(block.text, /read-only/u)
  assert.match(block.text, /\$0\.5000/u)
})

test('a call without a usable key fails before spawning anything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'packy-cli-'))
  const { script } = writeStubCli(dir)
  const { ctx, registered } = contextWithTools(fakeCredentials(undefined), dir)
  apply(ctx, { claudeCliPath: script })
  await assert.rejects(
    () => registered.tools[0].execute({ prompt: 'x' }, { agent: { session: { header: { cwd: dir } } } }),
    /needs a usable PackyCode API key/u,
  )
})

test('an explicit cwd resolves against the session workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'packy-cli-'))
  const { script, record } = writeStubCli(dir)
  const workspace = join(dir, 'workspace')
  mkdirSync(join(workspace, 'sub'), { recursive: true })
  const { ctx, registered } = contextWithTools(fakeCredentials('sk-stub-tool-key-0002'), dir)
  apply(ctx, { claudeCliPath: script })
  await registered.tools[0].execute(
    { prompt: 'work there', mode: 'full', cwd: 'sub' },
    { agent: { session: { header: { cwd: workspace } } } },
  )
  const seen = JSON.parse(readFileSync(record, 'utf8'))
  assert.equal(seen.cwd, realpathSync(join(workspace, 'sub')))
  assert.equal(seen.argv.includes('--dangerously-skip-permissions'), true)
})

/** Host permission services as the base bundle provides them. */
function permissionServices(sandbox, approval) {
  return name => ({
    sandboxPolicy: { resolve: () => ({ mode: sandbox }) },
    approval: { effectivePolicy: () => approval },
  })[name]
}

test('without any plugin setting the CLI follows the session permission preset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'packy-cli-'))
  const { script, record } = writeStubCli(dir)
  const { ctx, registered } = contextWithTools(fakeCredentials('sk-stub-tool-key-0003'), dir)
  ctx.get = permissionServices('danger-full-access', 'never')
  apply(ctx, { claudeCliPath: script })
  const exec = { agent: { session: { header: { cwd: dir } } } }

  const value = await registered.tools[0].execute({ prompt: 'run the tests' }, exec)
  assert.equal(value.mode, 'full')
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).argv.includes('--dangerously-skip-permissions'), true)

  ctx.get = permissionServices('workspace-write', 'ask')
  const capped = await registered.tools[0].execute({ prompt: 'run the tests', mode: 'full' }, exec)
  assert.equal(capped.mode, 'edit', 'a sandboxed session caps a wider request')
})

test('an explicit plugin mode still wins over the session preset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'packy-cli-'))
  const { script } = writeStubCli(dir)
  const { ctx, registered } = contextWithTools(fakeCredentials('sk-stub-tool-key-0004'), dir)
  ctx.get = permissionServices('danger-full-access', 'never')
  apply(ctx, { claudeCliPath: script, claudeCliMode: 'read-only' })
  const value = await registered.tools[0].execute({ prompt: 'x' }, { agent: { session: { header: { cwd: dir } } } })
  assert.equal(value.mode, 'read-only')
})
