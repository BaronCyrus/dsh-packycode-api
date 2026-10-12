/**
 * The loopback RPC surface behind the settings panel and the composer chip.
 *
 * Every reply carries only what this plugin owns: key labels and state, the
 * balance projection the host built, and host overrides. Key material never
 * crosses this boundary.
 *
 * @module dsh-packycode-api/rpc
 */

import { DEFAULT_API_HOST, DEFAULT_STATUS_HOST } from './constants.js'

const ok = value => ({ ok: true, value })
const failed = message => ({ ok: false, error: { message } })

/** Only sentences this plugin authored may reach the browser. */
const SAFE_MESSAGE = /^(?:PackyCode|That |Unknown |PackyCode's |add |the )[\s\S]{0,180}$/u

/** Accept an absolute http(s) origin and drop a trailing slash. */
export function normalizeHost(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return fallback
  let url
  try {
    url = new URL(text)
  } catch {
    return fallback
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`
}

/**
 * Build the RPC handler.
 * @param options - the key ring, balance reader, and host preference.
 * @returns a handler for `connection.rpc.handle(CHANNEL, handler)`.
 */
export function createPackyCodeRpc({ ring, balance, hosts, preference }) {
  const status = async () => ({
    ...(await ring.list()),
    hosts: hosts(),
    writable: preference.writable === true,
    defaults: { apiHost: DEFAULT_API_HOST, statusHost: DEFAULT_STATUS_HOST },
  })

  return async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case 'status':
          return ok(await status())
        case 'keys/add': {
          await ring.add(payload?.key, payload?.label)
          balance.invalidate()
          return ok(await status())
        }
        case 'keys/remove': {
          await ring.remove(String(payload?.id ?? ''))
          balance.invalidate()
          return ok(await status())
        }
        case 'keys/remove-all': {
          await ring.removeAll()
          balance.invalidate()
          return ok(await status())
        }
        case 'keys/select': {
          await ring.select(String(payload?.id ?? ''))
          balance.invalidate()
          return ok(await status())
        }
        case 'keys/enable': {
          await ring.enable(String(payload?.id ?? ''))
          balance.invalidate()
          return ok(await status())
        }
        case 'balance': {
          const [value, state] = await Promise.all([balance.read({ force: payload?.force === true }), ring.list()])
          return ok({ ...value, activeId: state.activeId })
        }
        case 'hosts/update': {
          if (preference.writable !== true) throw new Error('PackyCode host overrides are not writable in this profile')
          await preference.set({
            apiHost: normalizeHost(payload?.apiHost, hosts().apiHost),
            statusHost: normalizeHost(payload?.statusHost, hosts().statusHost),
          })
          balance.invalidate()
          return ok(await status())
        }
        default:
          return failed('Unknown PackyCode endpoint')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return failed(SAFE_MESSAGE.test(message) ? message : 'PackyCode request failed')
    }
  }
}
