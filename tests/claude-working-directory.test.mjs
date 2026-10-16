import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createRouteAdapter } from '../src/route.js'
import { PackyCodeKeyRing } from '../src/key-ring.js'
import { fakeCredentials } from './helpers.mjs'
import { anthropicStream } from './fixtures/anthropic.mjs'
import { clarifyWorkingDirectory } from '../src/working-directory.js'

const MODEL = 'claude-haiku-5-5'
const MARKER = 'Current working directory (exact JSON string):\n'
const tools = name => [{ name, description: 'Run a command in the session working directory.', parameters: {
  type: 'object', properties: { command: { type: 'string' }, workdir: { type: 'string' } }, required: ['command'],
} }]

async function fixture(t, resolveWorkingDirectory) {
  const ring = new PackyCodeKeyRing(fakeCredentials())
  await ring.add('sk-working-directory-fixture', 'fixture')
  const adapter = createRouteAdapter({ ring, resolveWorkingDirectory, keys: {
    active: () => ring.activeKey(), forRequest: (_model, key) => key, onKeyFailure: () => assert.fail('Unexpected key failure'),
  } })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const body = await new Request(input, init).json()
    requests.push(body)
    return anthropicStream(body.model)
  })
  const send = async (options, prepared = true) => {
    const request = { provider: 'packycode', model: MODEL, sessionId: 'workspace-session', maxTokens: 2048,
      reasoningEffort: 'high', messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '统计当前项目的文件数量。' }] })], ...options }
    const before = JSON.stringify(request)
    const call = prepared ? await adapter.prepareCall('packycode', request.model) : adapter
    const chunks = []
    for await (const chunk of call.stream(request)) chunks.push(chunk)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.equal(JSON.stringify(request), before, 'the original host request must stay unchanged')
    return requests.at(-1)
  }
  return { send, requests }
}

for (const [label, cwd, shell] of [
  ['captured macOS path', '/Volumes/M.2/WorkSpace/OtherWorld', 'bash'],
  ['Windows drive with spaces and CJK', String.raw`C:\Users\测试用户\My Project`, 'pwsh'],
  ['Windows UNC share', String.raw`\\server\share$\项目 A`, 'pwsh'],
  ['Windows extended path', String.raw`\\?\C:\项目\Long Folder`, 'pwsh'],
  ['Windows drive root', 'C:\\', 'pwsh'],
  ['POSIX directory with a real final dot', '/tmp/Project.', 'bash'],
  ['POSIX quotes, dollar and backslash', '/tmp/项目 "quoted" $& \\ folder', 'bash'],
  ['POSIX directory containing a newline', '/tmp/project\nsecond line.', 'bash'],
]) test(`${label}: the real host route separates the cwd value from sentence punctuation`, async t => {
  const { send } = await fixture(t, sessionId => {
    assert.equal(sessionId, 'workspace-session')
    return cwd
  })
  for (const prepared of [true, false]) {
    const wire = await send({ system: `Keep the host instructions.\nYour working directory is ${cwd}.\nKeep approvals enabled.`, tools: tools(shell) }, prepared)
    const system = wire.system.map(block => block.text ?? '').join('\n')
    assert.ok(system.includes(MARKER), 'the ambiguous host sentence must become an explicit JSON path')
    assert.equal(JSON.parse(system.split(MARKER)[1].split('\n')[0]), cwd)
    assert.equal(system.includes(`Your working directory is ${cwd}.`), false)
    assert.ok(system.includes('Keep the host instructions.'))
    assert.ok(system.includes('Keep approvals enabled.'))
    assert.match(system, /workdir/u)
    assert.match(system, /authoritative over generic CLI context/u)
    assert.match(system, /use relative paths and omit workdir/u)
    if (shell === 'pwsh') assert.match(system, /PowerShell/u)
    const parameters = wire.tools[0].input_schema
    assert.equal(parameters.properties.workdir.type, 'string')
    assert.ok(parameters.properties.workdir.description.includes(JSON.stringify(cwd)))
    assert.deepEqual(parameters.required, ['command'])
    assert.equal(wire.output_config.effort, 'high')
    assert.equal(wire.max_tokens, 2048)
  }
})

test('the same adapter reads fresh cwd metadata per session without leaking another workspace', async t => {
  const current = new Map([['first', '/tmp/first'], ['second', String.raw`D:\Other Project`]])
  const { send } = await fixture(t, id => current.get(id))
  for (const sessionId of ['first', 'second', 'first']) {
    const cwd = current.get(sessionId)
    const wire = await send({ sessionId, system: `Your working directory is ${cwd}.`, tools: tools('bash') })
    const system = wire.system.map(block => block.text ?? '').join('\n')
    assert.equal(JSON.parse(system.split(MARKER)[1].split('\n')[0]), cwd)
    if (sessionId === 'first') current.set('first', '/tmp/moved-first.')
  }
})

test('missing, invalid or mismatched metadata never guesses a cwd or trims punctuation', () => {
  const request = { model: MODEL, system: 'Your working directory is /tmp/project.', tools: tools('bash'), sessionId: 'scope' }
  for (const resolve of [undefined, () => undefined, () => '', () => 'relative/path', () => '/wrong',
    () => '/tmp/project\0bad', () => Promise.resolve('/tmp/project'), () => { throw new Error('No agent scope') }]) {
    assert.equal(clarifyWorkingDirectory(request, resolve), request)
  }
  assert.equal(clarifyWorkingDirectory({ ...request, model: 'gpt-6.1-sol' }, () => assert.fail('Not a Claude call')).system, request.system)
  assert.equal(clarifyWorkingDirectory({ ...request, purpose: 'session-title' }, () => assert.fail('No cwd for titles')).system, request.system)
})

test('only a matching host sentence changes, preserving quoted examples, user history and commands', () => {
  const cwd = '/tmp/project.'
  for (const system of [
    `A persona sentence. Your working directory is ${cwd}.`,
    `Header\r\nYour working directory is ${cwd}.\r\nFooter`,
  ]) {
    const request = { model: MODEL, system, tools: tools('bash'), messages: [{ role: 'user', content: `cd ${cwd}.` }] }
    const before = JSON.stringify(request)
    const updated = clarifyWorkingDirectory(request, () => cwd)
    assert.equal(JSON.parse(updated.system.split(MARKER)[1].split('\n')[0]), cwd)
    assert.equal(updated.messages, request.messages)
    assert.equal(JSON.stringify(request), before)
    assert.equal(clarifyWorkingDirectory(updated, () => cwd), updated, 'normalization is idempotent')
  }
  for (const system of [
    `Quote: "Your working directory is ${cwd}."`,
    `Your working directory is ${cwd}. Extra unrecognized text.`,
    `Your working directory is /different/path.`,
    `Use the current directory: ${cwd}`,
  ]) {
    const request = { model: MODEL, system }
    assert.equal(clarifyWorkingDirectory(request, () => cwd), request)
  }
})

test('directory guidance follows available shell tools without treating every platform as Bash', () => {
  const request = { model: MODEL, system: 'Your working directory is C:\\Projects\\demo.' }
  for (const names of [['pwsh'], ['bash'], ['bash', 'pwsh'], ['read']]) {
    const result = clarifyWorkingDirectory({ ...request, tools: names.flatMap(tools) }, () => 'C:\\Projects\\demo')
    assert.equal(result.system.includes('The offered shell uses PowerShell syntax.'), names.length === 1 && names[0] === 'pwsh')
  }
})

test('cwd defaults enrich shell descriptions without changing validation rules or rewriting history arguments', () => {
  const cwd = String.raw`C:\Projects\合法目录.`
  const shell = tools('pwsh')[0]
  shell.parameters.properties.workdir.description = 'Existing sandbox and directory guidance.'
  const command = { role: 'assistant', content: [{ type: 'tool-call', name: 'pwsh', arguments: { command: 'Get-ChildItem C:/unrelated', workdir: 'C:/unrelated' } }] }
  const request = { model: MODEL, system: `Your working directory is ${cwd}.`, tools: [shell, ...tools('custom_command')], messages: [command] }
  const before = JSON.stringify(request)
  const result = clarifyWorkingDirectory(request, () => cwd)
  assert.equal(JSON.stringify(request), before)
  assert.equal(result.messages, request.messages)
  assert.equal(result.tools[1], request.tools[1])
  const parameters = result.tools[0].parameters
  assert.equal(parameters.required, shell.parameters.required)
  assert.equal(parameters.properties.command, shell.parameters.properties.command)
  assert.ok(parameters.properties.workdir.description.startsWith('Existing sandbox and directory guidance.'))
  assert.ok(parameters.properties.workdir.description.includes(JSON.stringify(cwd)))
})
