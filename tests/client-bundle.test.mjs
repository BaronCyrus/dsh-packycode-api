import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = path.join(root, 'lib', 'client.js')
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

/** Every member the bundle may ask for, tolerant of React's surface. */
function stubRequire(id) {
  if (id === 'react' || id === 'react/jsx-runtime') {
    return new Proxy({}, { get: () => () => ({}) })
  }
  throw new Error(`client bundle required an undeclared module: ${id}`)
}

test('the client bundle carries the loader wrapper and exports apply/inject', { skip: existsSync(bundlePath) ? false : 'lib/client.js is not built yet' }, () => {
  const source = readFileSync(bundlePath, 'utf8')
  const loads = []
  const sandbox = {
    window: { __ModuleLoader__: { load: spec => loads.push(spec) } },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)

  assert.equal(loads.length, 1)
  const spec = loads[0]
  // The loader keys the bundle by package name; a mismatch makes it invisible.
  assert.equal(spec.id, manifest.name)
  assert.equal(typeof spec.factory, 'function')
  const exports = spec.factory(stubRequire)
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], ['slots', 'locale', 'connection', 'modelDirectories'])
})

test('the package declares the client surface the loader requires', () => {
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  for (const declared of manifest.dsh.client.inject) {
    assert.ok(
      manifest.peerDependencies[declared] !== undefined || declared.startsWith('@deepseek-ai/dsh-client-'),
      `${declared} must be a declared peer`,
    )
  }
})

test('the shipped patch registers this plugin and repairs the connection row', () => {
  const patch = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  const ids = [...patch.matchAll(/^\s*- id:\s*(\S+)\s*$/gmu)].map(match => match[1])
  assert.deepEqual(ids, ['packycode-api', 'connection'])
  assert.match(patch, new RegExp(`name: '${manifest.name}'`, 'u'))
  // The browser channel cannot register without this service on that fiber.
  const connection = patch.slice(patch.indexOf('- id: connection'))
  assert.match(connection, /name: '@deepseek-ai\/dsh-client-connection'/u)
  assert.match(connection, /inject: \[credentials, webRuntime, webServer\]/u)
})
