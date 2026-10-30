/**
 * How this process reached PackyCode: how each request to the plugin's own
 * hosts ended at the transport level, which addresses a failed connection
 * tried and how each of them failed, and the runtime settings and name
 * resolution that decide those connections.
 *
 * Node's fetch reports every transport fault as a bare `fetch failed`, and
 * the OpenAI SDK turns that into "Connection error." or "Request timed out."
 * depending on which undici runs under fetch: the same connection, refused
 * after 0.5 s on every address, reads differently on two machines. undici
 * publishes the real cause on `diagnostics_channel`. This module listens
 * there for the plugin's hosts only and keeps identifiers and numbers: host
 * names, server addresses, paths without their query, error names and codes,
 * statuses and durations. It never reads headers or bodies.
 *
 * @module dsh-packycode-api/network
 */

import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import * as dns from 'node:dns'
import * as net from 'node:net'

import { safeMessage } from './diagnostics.js'

/** How much the log keeps, and how long one host lookup may take. */
export const NETWORK_LIMITS = Object.freeze({ failures: 12, samples: 50, lookupMs: 3000 })

const CHANNELS = Object.freeze({
  create: 'undici:request:create',
  headers: 'undici:request:headers',
  error: 'undici:request:error',
  connected: 'undici:client:connected',
  connectError: 'undici:client:connectError',
})

const NAME = /^[\w.:-]{1,60}$/u
const PATH = /^\/[\w.:/@%~+-]{0,79}$/u
const word = value => (typeof value === 'string' && NAME.test(value) ? value : undefined)
const compact = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))

function hostnameOf(origin) {
  try {
    return new URL(String(origin)).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** The request path with its query dropped: a query may carry a credential. */
function pathOf(path) {
  const bare = typeof path === 'string' ? path.split(/[?#]/u)[0] : undefined
  return bare !== undefined && PATH.test(bare) ? bare : undefined
}

/** A caller's cancellation, as opposed to a transport fault. */
const isAbort = error => (error?.name === 'AbortError' && typeof error?.code !== 'string') || error?.code === 'ABORT_ERR'

/** `Name CODE` for the error and each cause under it. */
function chainOf(error) {
  const chain = []
  for (let current = error, depth = 0; current !== null && typeof current === 'object' && depth < 3; current = current.cause, depth++) {
    const label = [word(current.name) ?? word(current.constructor?.name), word(current.code)].filter(Boolean).join(' ')
    if (label !== '') chain.push(label)
  }
  return chain.length === 0 ? undefined : chain
}

/** Each address a connection tried and how it failed, from the error or a cause under it. */
function attemptsOf(error) {
  const entry = item => (net.isIP(item?.address ?? '') === 0 ? undefined : [item.address, word(item.code)].filter(Boolean).join(' '))
  for (let current = error, depth = 0; current !== null && typeof current === 'object' && depth < 3; current = current.cause, depth++) {
    if (Array.isArray(current.errors)) {
      const list = current.errors.map(entry).filter(Boolean)
      return list.length === 0 ? undefined : list
    }
    const single = entry(current)
    if (single !== undefined) return [single]
  }
  return undefined
}

function summary(samples) {
  if (samples.length === 0) return undefined
  const sorted = [...samples].sort((a, b) => a - b)
  const at = share => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]
  return { median: at(0.5), p90: at(0.9), max: sorted.at(-1) }
}

/** Which scheme each proxy variable names: lower case first, as DSH reads them. Never the proxy itself. */
function proxySchemes(env) {
  const read = name => {
    const value = [env?.[name], env?.[name.toUpperCase()]].find(item => typeof item === 'string' && item.trim() !== '')
    if (value === undefined) return undefined
    try {
      return word(new URL(value.trim()).protocol.replace(/:$/u, '')) ?? 'invalid'
    } catch {
      return 'invalid'
    }
  }
  const schemes = compact({ https: read('https_proxy'), http: read('http_proxy'), all: read('all_proxy'), noProxy: read('no_proxy') === undefined ? undefined : true })
  return Object.keys(schemes).length === 0 ? 'none' : schemes
}

/** The settings that decide how Node opens a connection. */
function runtimeOf(env) {
  const call = fn => (typeof fn === 'function' ? fn() : undefined)
  return compact({
    node: process.version,
    platform: process.platform,
    // Node tries a host's addresses in turn, IPv6 and IPv4 alternating, and
    // gives every address but the last this long before moving on.
    autoSelectFamily: call(net.getDefaultAutoSelectFamily),
    attemptTimeoutMs: call(net.getDefaultAutoSelectFamilyAttemptTimeout),
    dnsOrder: call(dns.getDefaultResultOrder),
    proxy: proxySchemes(env),
  })
}

/** The addresses a connection to `hostname` would try, asked the way `net.connect` asks. */
const defaultLookup = hostname => dns.promises.lookup(hostname, process.platform === 'win32' ? { all: true } : { all: true, hints: dns.ADDRCONFIG })

/**
 * The network log behind the diagnostics card.
 * @param options - the plugin's host origins (read on every request), the
 *   environment the proxy variables come from, and test seams for the clock,
 *   the lookup and its bound.
 */
export function createNetworkLog({ hosts, env = process.env, now = Date.now, clock = () => performance.now(), lookupAll = defaultLookup, lookupMs = NETWORK_LIMITS.lookupMs } = {}) {
  const watched = () => {
    const names = []
    for (const origin of hosts?.() ?? []) {
      const name = hostnameOf(origin)
      if (name !== undefined && !names.includes(name)) names.push(name)
    }
    return names
  }
  const stats = new Map()
  const statsFor = host => {
    let entry = stats.get(host)
    if (entry === undefined) {
      entry = { requests: 0, answered: 0, statuses: {}, failed: { connect: 0, request: 0, response: 0 }, aborted: 0, headersMs: [], connects: { ok: 0, afterFallback: 0, ipv6: 0 } }
      stats.set(host, entry)
    }
    return entry
  }
  const requests = new WeakMap()
  const connectErrors = new WeakSet()
  const failures = []
  let since
  let listening

  // A subscriber that throws surfaces as an uncaught exception in the host
  // process, so every handler swallows its own faults.
  const guard = handler => message => {
    try {
      handler(message)
    } catch { /* diagnostics must never break a request */ }
  }
  const handlers = {
    [CHANNELS.create]: ({ request }) => {
      const host = hostnameOf(request?.origin)
      if (host === undefined || !watched().includes(host)) return
      requests.set(request, { host, path: pathOf(request.path), startedAt: clock(), answered: false })
      statsFor(host).requests += 1
    },
    [CHANNELS.headers]: ({ request, response }) => {
      const entry = requests.get(request)
      if (entry === undefined) return
      entry.answered = true
      const stat = statsFor(entry.host)
      stat.answered += 1
      const status = response?.statusCode
      if (Number.isInteger(status)) stat.statuses[status] = (stat.statuses[status] ?? 0) + 1
      stat.headersMs.push(Math.round(clock() - entry.startedAt))
      if (stat.headersMs.length > NETWORK_LIMITS.samples) stat.headersMs.shift()
    },
    // undici publishes a failed connection here first, then the same error
    // to every request that waited on it.
    [CHANNELS.connectError]: ({ error }) => {
      if (error !== null && typeof error === 'object') connectErrors.add(error)
    },
    [CHANNELS.connected]: ({ connectParams, socket }) => {
      const host = typeof connectParams?.hostname === 'string' ? connectParams.hostname.toLowerCase() : undefined
      if (host === undefined || !watched().includes(host)) return
      const connects = statsFor(host).connects
      connects.ok += 1
      // More than one attempted address: an earlier one timed out or failed.
      if (Array.isArray(socket?.autoSelectFamilyAttemptedAddresses) && socket.autoSelectFamilyAttemptedAddresses.length > 1) connects.afterFallback += 1
      if (socket?.remoteFamily === 'IPv6') connects.ipv6 += 1
    },
    [CHANNELS.error]: ({ request, error }) => {
      const entry = requests.get(request)
      if (entry === undefined) return
      requests.delete(request)
      const stat = statsFor(entry.host)
      if (isAbort(error)) {
        stat.aborted += 1
        return
      }
      const stage = connectErrors.has(error) ? 'connect' : entry.answered ? 'response' : 'request'
      stat.failed[stage] += 1
      failures.push(compact({
        time: new Date(now()).toISOString(),
        host: entry.host,
        path: entry.path,
        stage,
        afterMs: Math.round(clock() - entry.startedAt),
        error: chainOf(error),
        attempts: attemptsOf(error),
        message: typeof error?.message === 'string' ? error.message.slice(0, 1000) : undefined,
      }))
      if (failures.length > NETWORK_LIMITS.failures) failures.shift()
    },
  }
  const subscribed = Object.entries(handlers).map(([name, handler]) => [name, guard(handler)])

  const stop = () => {
    if (!listening) return
    listening = false
    for (const [name, handler] of subscribed) unsubscribe(name, handler)
  }

  /** One host's addresses, or why there are none; never longer than `lookupMs`. */
  const resolve = async hostname => {
    let timer
    try {
      const list = await Promise.race([
        lookupAll(hostname),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('lookup timed out'), { code: 'LOOKUP_TIMEOUT' })), lookupMs)
          timer.unref?.()
        }),
      ])
      return { resolved: (Array.isArray(list) ? list : []).map(item => item?.address).filter(address => net.isIP(address ?? '') !== 0) }
    } catch (error) {
      return { lookupError: word(error?.code) ?? 'LOOKUP_FAILED' }
    } finally {
      clearTimeout(timer)
    }
  }

  const countsOf = stat => {
    if (stat === undefined) return {}
    const nonZero = counts => Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0))
    const failed = nonZero(stat.failed)
    return compact({
      requests: stat.requests,
      answered: stat.answered,
      statuses: Object.keys(stat.statuses).length === 0 ? undefined : { ...stat.statuses },
      failed: Object.keys(failed).length === 0 ? undefined : failed,
      aborted: stat.aborted === 0 ? undefined : stat.aborted,
      headersMs: summary(stat.headersMs),
      connects: stat.connects.ok === 0 ? undefined : nonZero(stat.connects),
    })
  }

  return Object.freeze({
    /**
     * Start listening; returns the function that stops it.
     * @returns the disposer the plugin's effect runs on unload.
     */
    start() {
      if (!listening) {
        listening = true
        since = now()
        for (const [name, handler] of subscribed) subscribe(name, handler)
      }
      return stop
    },
    stop,

    /**
     * What the log saw since it started, the runtime settings, and how each
     * host resolves now.
     * @param options - stored secrets to redact from error messages.
     */
    async snapshot({ secrets = [] } = {}) {
      const names = watched()
      const lookups = await Promise.all(names.map(resolve))
      return compact({
        since: since === undefined ? undefined : new Date(since).toISOString(),
        runtime: runtimeOf(env),
        hosts: names.map((host, index) => ({ host, ...lookups[index], ...countsOf(stats.get(host)) })),
        recentFailures: failures.map(failure => compact({ ...failure, message: safeMessage(failure.message, secrets) })),
      })
    },
  })
}
