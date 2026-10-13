/**
 * Which hosts a read goes to.
 *
 * PackyCode serves models and the billing endpoints from `cf.api.fan`, and
 * the per-key `/api/*` family plus public pricing from the PackyAPI site
 * (`cf.api.fan` answers 404 there). A saved legacy status host
 * (`www.packyapi.com`, DNS-poisoned on mainland networks) is tried after the
 * current default, never before it.
 *
 * @module dsh-packycode-api/hosts
 */

import { DEFAULT_API_HOST, DEFAULT_STATUS_HOST, LEGACY_STATUS_HOSTS } from './constants.js'

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

const unique = hosts => [...new Set(hosts.filter(host => typeof host === 'string' && host !== ''))]

/**
 * The status hosts one per-key read tries, in order: an explicit override,
 * the current default, the legacy defaults, then the model hosts.
 * @param hosts - the resolved host settings.
 * @returns unique origins.
 */
export function statusHostOrder(hosts) {
  const configured = hosts?.statusHost
  const override = configured === undefined || LEGACY_STATUS_HOSTS.includes(configured) ? [] : [configured]
  return unique([...override, DEFAULT_STATUS_HOST, ...LEGACY_STATUS_HOSTS, hosts?.apiHost, DEFAULT_API_HOST])
}

/**
 * The hosts the account read tries: the model hosts first (they serve the
 * billing endpoints), then the status hosts.
 * @param hosts - the resolved host settings.
 * @returns unique origins.
 */
export function accountHostOrder(hosts) {
  return unique([hosts?.apiHost, DEFAULT_API_HOST, ...statusHostOrder(hosts)])
}
