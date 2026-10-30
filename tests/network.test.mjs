import assert from 'node:assert/strict'
import { channel } from 'node:diagnostics_channel'
import dns from 'node:dns'
import { createServer } from 'node:http'
import net from 'node:net'
import test from 'node:test'

import { createNetworkLog, NETWORK_LIMITS } from '../src/network.js'

/** A loopback server answering each path with `routes[path]`, or a 404. */
async function serve(t, routes) {
  const server = createServer((req, res) => {
    const route = routes[req.url.split('?')[0]]
    if (route === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    route(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return server.address().port
}

/** A loopback port nothing listens on. */
async function closedPort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

test('requests to the plugin hosts are counted and timed, and nothing else is', async t => {
  const port = await serve(t, {
    '/v1/responses': (req, res) => req.resume().on('end', () => res.end('{}')),
    '/api/usage/token/': (req, res) => {
      res.statusCode = 429
      res.end()
    },
    '/v1/elsewhere': (req, res) => res.end(),
  })
  const log = createNetworkLog({ hosts: () => [`http://127.0.0.1:${port}`], lookupAll: async () => [{ address: '127.0.0.1', family: 4 }] })
  t.after(log.start())

  const secretQuery = 'sk-query-secret-0123456789'
  const secretHeader = 'sk-header-secret-0123456789'
  await (await fetch(`http://127.0.0.1:${port}/v1/responses?key=${secretQuery}`, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${secretHeader}` } })).text()
  await (await fetch(`http://127.0.0.1:${port}/api/usage/token/`)).text()
  // Another host name for the same server: not one of the plugin's hosts.
  await (await fetch(`http://localhost:${port}/v1/elsewhere`)).text()

  const snapshot = await log.snapshot()
  assert.equal(snapshot.hosts.length, 1)
  const [host] = snapshot.hosts
  assert.equal(host.host, '127.0.0.1')
  assert.deepEqual(host.resolved, ['127.0.0.1'])
  assert.equal(host.requests, 2)
  assert.equal(host.answered, 2)
  assert.deepEqual(host.statuses, { 200: 1, 429: 1 })
  assert.equal(host.failed, undefined)
  assert.ok(host.connects.ok >= 1, 'the connection was seen')
  assert.ok(host.headersMs.median >= 0 && host.headersMs.max >= host.headersMs.median)
  assert.deepEqual(snapshot.recentFailures, [])
  assert.match(snapshot.since, /^\d{4}-\d\d-\d\dT/u)
  const text = JSON.stringify(snapshot)
  for (const secret of [secretQuery, secretHeader, 'Bearer', 'localhost', 'elsewhere']) assert.equal(text.includes(secret), false, `${secret} must not appear`)
})

test('a connection refused on every address keeps each address and its error', async t => {
  const port = await closedPort()
  // Two addresses make Node try them in turn and fail with an AggregateError,
  // the shape a host with A and AAAA records fails with.
  const realLookup = dns.lookup
  dns.lookup = (host, options, callback) => {
    if (typeof options === 'function') [options, callback] = [{}, options]
    if (host !== 'packy.test') return realLookup(host, options, callback)
    const list = [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]
    return process.nextTick(callback, null, options?.all ? list : list[0].address, options?.all ? undefined : 4)
  }
  t.after(() => { dns.lookup = realLookup })
  const log = createNetworkLog({ hosts: () => ['https://packy.test'], lookupAll: async () => [{ address: '127.0.0.1' }, { address: '::1' }] })
  t.after(log.start())

  await assert.rejects(fetch(`http://packy.test:${port}/v1/responses`, { method: 'POST', body: '{}' }), /fetch failed/u)

  const snapshot = await log.snapshot()
  assert.deepEqual(snapshot.hosts[0].resolved, ['127.0.0.1', '::1'])
  assert.equal(snapshot.hosts[0].requests, 1)
  assert.deepEqual(snapshot.hosts[0].failed, { connect: 1 })
  const [failure] = snapshot.recentFailures
  assert.equal(failure.host, 'packy.test')
  assert.equal(failure.path, '/v1/responses')
  assert.equal(failure.stage, 'connect')
  assert.match(failure.error[0], /^AggregateError /u)
  assert.equal(failure.attempts.length, 2)
  assert.equal(failure.attempts[0], '127.0.0.1 ECONNREFUSED')
  assert.match(failure.attempts[1], /^::1 E[A-Z]+$/u)
  assert.ok(failure.afterMs >= 0 && failure.afterMs < 5000)
})

test('a cancelled request is counted apart; a timeout and a cut response are failures', async t => {
  const port = await serve(t, {
    '/v1/slow': () => {},
    '/v1/cut': (req, res) => {
      res.writeHead(200, { 'content-length': '100' })
      res.write('partial')
      setTimeout(() => req.socket.destroy(), 20)
    },
  })
  const log = createNetworkLog({ hosts: () => [`http://127.0.0.1:${port}`], lookupAll: async () => [] })
  t.after(log.start())

  const cancelled = new AbortController()
  setTimeout(() => cancelled.abort(), 30)
  await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/slow`, { signal: cancelled.signal }), { name: 'AbortError' })
  await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/slow`, { signal: AbortSignal.timeout(30) }), { name: 'TimeoutError' })
  await assert.rejects((await fetch(`http://127.0.0.1:${port}/v1/cut`)).text())

  const snapshot = await log.snapshot()
  const [host] = snapshot.hosts
  assert.equal(host.requests, 3)
  assert.equal(host.aborted, 1)
  assert.deepEqual(host.failed, { request: 1, response: 1 })
  assert.deepEqual(snapshot.recentFailures.map(failure => [failure.path, failure.stage, failure.error]), [
    ['/v1/slow', 'request', ['TimeoutError']],
    ['/v1/cut', 'response', ['SocketError UND_ERR_SOCKET']],
  ])
})

test('undici 8 connect timeouts and connections that needed a later address are read from its events', async t => {
  let ticks = 1000
  const log = createNetworkLog({ hosts: () => ['https://cf.api.fan'], now: () => Date.UTC(2026, 9, 30, 5, 19, 37), clock: () => ticks, lookupAll: async () => [] })
  t.after(log.start())
  const failed = (address, code) => Object.assign(new Error(`connect ${code} ${address}:443`), { code, address, port: 443 })
  const aggregate = Object.assign(new AggregateError([
    failed('104.18.15.63', 'ETIMEDOUT'), failed('2606:4700::6812:f3f', 'ENETUNREACH'),
    failed('104.18.14.63', 'ETIMEDOUT'), failed('2606:4700::6812:e3f', 'ENETUNREACH'),
  ]), { code: 'ETIMEDOUT' })
  // undici 8 rewrites the AggregateError and keeps it as the cause.
  const error = Object.assign(new Error('Connect Timeout Error (attempted addresses: 104.18.15.63:443, 2606:4700::6812:f3f:443, 104.18.14.63:443, 2606:4700::6812:e3f:443, timeout: 10000ms) sk-stored-key-0123456789', { cause: aggregate }), { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' })
  const request = { origin: 'https://cf.api.fan', path: '/v1/responses', method: 'POST' }

  channel('undici:request:create').publish({ request })
  ticks += 504
  channel('undici:client:connectError').publish({ connectParams: { hostname: 'cf.api.fan' }, error })
  channel('undici:request:error').publish({ request, error })
  channel('undici:client:connected').publish({ connectParams: { hostname: 'cf.api.fan' }, socket: { remoteFamily: 'IPv4', autoSelectFamilyAttemptedAddresses: ['104.18.15.63:443', '2606:4700::6812:f3f:443', '104.18.14.63:443'] } })
  channel('undici:client:connected').publish({ connectParams: { hostname: 'cf.api.fan' }, socket: { remoteFamily: 'IPv6', autoSelectFamilyAttemptedAddresses: ['2606:4700::6812:f3f:443'] } })
  // Payloads the log cannot read change nothing and throw nothing.
  for (const name of ['undici:request:create', 'undici:request:headers', 'undici:request:error', 'undici:client:connected', 'undici:client:connectError']) {
    channel(name).publish({})
    channel(name).publish({ request: null, connectParams: null, error: null })
  }

  const snapshot = await log.snapshot({ secrets: ['sk-stored-key-0123456789'] })
  assert.equal(snapshot.since, '2026-10-30T05:19:37.000Z')
  assert.deepEqual(snapshot.hosts, [{ host: 'cf.api.fan', resolved: [], requests: 1, answered: 0, failed: { connect: 1 }, connects: { ok: 2, afterFallback: 1, ipv6: 1 } }])
  const [failure] = snapshot.recentFailures
  assert.deepEqual({ ...failure, message: undefined }, {
    time: '2026-10-30T05:19:37.000Z',
    host: 'cf.api.fan',
    path: '/v1/responses',
    stage: 'connect',
    afterMs: 504,
    error: ['ConnectTimeoutError UND_ERR_CONNECT_TIMEOUT', 'AggregateError ETIMEDOUT'],
    attempts: ['104.18.15.63 ETIMEDOUT', '2606:4700::6812:f3f ENETUNREACH', '104.18.14.63 ETIMEDOUT', '2606:4700::6812:e3f ENETUNREACH'],
    message: undefined,
  })
  assert.match(failure.message, /^Connect Timeout Error \(attempted addresses: 104\.18\.15\.63:443/u)
  assert.equal(failure.message.includes('sk-stored-key'), false, 'stored keys are redacted')
  assert.ok(failure.message.length <= 161)

  for (let index = 0; index < NETWORK_LIMITS.failures + 3; index++) {
    const next = { origin: 'https://cf.api.fan', path: `/v1/n${index}`, method: 'POST' }
    channel('undici:request:create').publish({ request: next })
    channel('undici:request:error').publish({ request: next, error: Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' }) })
  }
  const later = await log.snapshot()
  assert.equal(later.recentFailures.length, NETWORK_LIMITS.failures)
  assert.equal(later.recentFailures.at(-1).path, `/v1/n${NETWORK_LIMITS.failures + 2}`)
  assert.equal(later.hosts[0].failed.request, NETWORK_LIMITS.failures + 3)
})

test('the runtime section names the connection settings and proxy schemes, never a proxy or its credentials', async () => {
  const env = {
    https_proxy: 'http://alice:hunter2@proxy.corp.example:8080',
    http_proxy: '',
    ALL_PROXY: 'socks5://127.0.0.1:7891',
    NO_PROXY: 'internal.example',
  }
  const { runtime } = await createNetworkLog({ hosts: () => [], env }).snapshot()
  assert.equal(runtime.node, process.version)
  assert.equal(runtime.platform, process.platform)
  assert.equal(runtime.autoSelectFamily, net.getDefaultAutoSelectFamily())
  assert.equal(runtime.attemptTimeoutMs, net.getDefaultAutoSelectFamilyAttemptTimeout())
  assert.equal(runtime.dnsOrder, dns.getDefaultResultOrder())
  assert.deepEqual(runtime.proxy, { https: 'http', all: 'socks5', noProxy: true })
  for (const secret of ['alice', 'hunter2', 'proxy.corp', '8080', '7891', 'internal.example']) assert.equal(JSON.stringify(runtime).includes(secret), false, `${secret} must not appear`)

  assert.equal((await createNetworkLog({ hosts: () => [], env: {} }).snapshot()).runtime.proxy, 'none')
})

test('a lookup is bounded and says why a host has no addresses; a stopped log hears nothing', async () => {
  const lookupAll = host => (host === 'slow.test'
    ? new Promise(() => {})
    : Promise.reject(Object.assign(new Error('not found'), { code: 'ENOTFOUND' })))
  const log = createNetworkLog({ hosts: () => ['https://slow.test', 'https://missing.test', 'https://slow.test/v1'], lookupAll, lookupMs: 30 })
  const stop = log.start()
  assert.equal(log.start(), stop, 'starting twice keeps one subscription')
  channel('undici:request:create').publish({ request: { origin: 'https://slow.test', path: '/v1/responses' } })
  stop()
  channel('undici:request:create').publish({ request: { origin: 'https://slow.test', path: '/v1/responses' } })

  const snapshot = await log.snapshot()
  assert.deepEqual(snapshot.hosts, [
    { host: 'slow.test', lookupError: 'LOOKUP_TIMEOUT', requests: 1, answered: 0 },
    { host: 'missing.test', lookupError: 'ENOTFOUND' },
  ])
})
