/**
 * The loopback RPC surface behind the settings panel and the composer chip.
 *
 * Every reply carries only what this plugin owns: key labels and state, the
 * balance and group projections the host built, host overrides, whether this
 * device has the Claude Code CLI, the plugin version, and the web search
 * preference. Key material never crosses this boundary.
 *
 * @module dsh-packycode-api/rpc
 */

import { DEFAULT_API_HOST, DEFAULT_STATUS_HOST } from './constants.js'
import { normalizeHost } from './hosts.js'

export { normalizeHost } from './hosts.js'

const ok = value => ({ ok: true, value })
const failed = message => ({ ok: false, error: { message } })

/** Only sentences this plugin authored may reach the browser. */
const SAFE_MESSAGE = /^(?:PackyCode|That |Unknown |PackyCode's |add |the )[\s\S]{0,180}$/u

const keyId = payload => String(payload?.id ?? '')

/**
 * Build the RPC handler.
 * @param options - the key ring, the balance and group readers, the host
 *   preference, and the optional Claude Code CLI manager, plugin manager, and
 *   web search controller (without one, its endpoints refuse).
 * @returns a handler for `connection.rpc.handle(CHANNEL, handler)`.
 */
export function createPackyCodeRpc({ ring, balance, groups, hosts, preference, claudeCli, pluginManager, search }) {
  const need = (service, message) => {
    if (service === undefined) throw new Error(message)
    return service
  }
  const cli = () => need(claudeCli, 'PackyCode Claude Code CLI support is unavailable in this runtime')
  const manager = () => need(pluginManager, 'PackyCode plugin version is unavailable')
  const webSearch = () => need(search, 'PackyCode web search is unavailable in this runtime')
  const groupReader = () => need(groups, 'PackyCode key groups are unavailable in this runtime')

  const status = async () => ({
    ...(await ring.list()),
    hosts: hosts(),
    writable: preference.writable === true,
    defaults: { apiHost: DEFAULT_API_HOST, statusHost: DEFAULT_STATUS_HOST },
  })

  /**
   * Key mutations, each answered with the new status. Every one drops the
   * cached balance; one that changes which keys exist also drops the groups.
   */
  const keyMutations = {
    'keys/add': { run: payload => ring.add(payload?.key, payload?.label), changesKeys: true },
    'keys/rename': { run: payload => ring.rename(keyId(payload), payload?.label) },
    'keys/remove': { run: payload => ring.remove(keyId(payload)), changesKeys: true },
    'keys/remove-all': { run: () => ring.removeAll(), changesKeys: true },
    'keys/select': { run: payload => ring.select(keyId(payload)) },
    'keys/enable': { run: payload => ring.enable(keyId(payload)) },
  }

  const endpoints = {
    status: () => status(),
    balance: async payload => {
      const [value, state] = await Promise.all([balance.read({ force: payload?.force === true }), ring.list()])
      return { ...value, activeId: state.activeId }
    },
    groups: payload => groupReader().read({ force: payload?.force === true }),
    'hosts/update': async payload => {
      if (preference.writable !== true) throw new Error('PackyCode host overrides are not writable in this profile')
      await preference.set({
        apiHost: normalizeHost(payload?.apiHost, hosts().apiHost),
        statusHost: normalizeHost(payload?.statusHost, hosts().statusHost),
      })
      balance.invalidate()
      groups?.invalidate()
      return status()
    },
    'claude-cli/status': payload => cli().status({ force: payload?.force === true }),
    // Starts the install and answers at once; the panel polls the status
    // instead of holding one request open for minutes.
    'claude-cli/install': () => {
      cli().install()
      return cli().status()
    },
    'plugin/version': (payload, signal) => manager().read({ force: payload?.force === true, signal }),
    'plugin/update': (_payload, signal) => manager().update({ signal }),
    'search/status': () => webSearch().status(),
    'search/update': payload => webSearch().update({
      searchProvider: payload?.searchProvider,
      searchBackend: payload?.searchBackend,
    }),
  }

  return async (endpoint, payload, signal) => {
    try {
      const mutation = Object.hasOwn(keyMutations, endpoint) ? keyMutations[endpoint] : undefined
      if (mutation !== undefined) {
        await mutation.run(payload)
        balance.invalidate()
        if (mutation.changesKeys) groups?.invalidate()
        return ok(await status())
      }
      const handle = Object.hasOwn(endpoints, endpoint) ? endpoints[endpoint] : undefined
      if (handle === undefined) return failed('Unknown PackyCode endpoint')
      return ok(await handle(payload, signal))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return failed(SAFE_MESSAGE.test(message) ? message : 'PackyCode request failed')
    }
  }
}
