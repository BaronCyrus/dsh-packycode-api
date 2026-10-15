/**
 * Identities and defaults this plugin owns.
 *
 * @module dsh-packycode-api/constants
 */

/** LLM provider route key; the model picker groups models under this id. */
export const PROVIDER = 'packycode'
/** Display name of the route in the picker and settings. */
export const DISPLAY_NAME = 'PackyCode'
/** Loader row id, settings namespace, and credential-record scope. */
export const PLUGIN_ID = 'packycode-api'
/** Loopback RPC channel the browser half talks to. */
export const CHANNEL = '/packycode-api'
/** Settings namespace carrying host overrides. */
export const SETTINGS_NAMESPACE = 'packycode-api'
/** Credential record id inside the plugin's own scope. */
export const KEY_RECORD_ID = 'keys'
/** Image credentials never participate in the conversation key ring. */
export const IMAGE_KEY_RECORD_ID = 'image-keys'

/**
 * Model-traffic host. Each model declares the protocol its gateway route
 * actually serves: `cf.api.fan/v1` answers chat/completions and responses,
 * `cf.api.fan` answers the Anthropic Messages protocol at `/v1/messages`.
 */
export const DEFAULT_API_HOST = 'https://cf.api.fan'
/**
 * Host carrying `/api/usage/token/`. `cf.api.fan` answers 404 for the whole
 * `/api/*` family, so per-key quota is read from the PackyAPI host instead.
 * PackyAPI now runs on `.ai` (its site and docs moved there); the `.com` name
 * is DNS-poisoned on mainland networks, so a host whose fetch does not go
 * through a proxy reads `fetch failed` from it.
 */
export const DEFAULT_STATUS_HOST = 'https://www.packyapi.ai'
/**
 * Earlier default status hosts. A profile that saved one keeps working, but
 * the current default is tried before it, so an unreachable legacy name
 * cannot hold a read up for its whole timeout first.
 */
export const LEGACY_STATUS_HOSTS = Object.freeze(['https://www.packyapi.com'])

/** PackyAPI quotes balances in quota units of 1/500000 USD (new-api convention). */
export const QUOTA_PER_USD = 500000
/** `quota_limit` of -1 means "no period limit", not an amount. */
export const UNLIMITED_QUOTA_SENTINEL = -1

/** Balance cache lifetime; a forced read bypasses it. */
export const DEFAULT_BALANCE_TTL_MS = 60_000
/** Bound on every account request this plugin makes. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

/** Effort level the route requests when a session names none. */
export const DEFAULT_REASONING_LEVEL = 'high'
