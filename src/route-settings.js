/**
 * Profile preferences for the HTTP route's step retry count and stream idle
 * watchdog timeout.
 *
 * @module dsh-packycode-api/route-settings
 */

import { fieldValue } from './preferences.js'

export const DEFAULT_MAX_RETRIES = 20
export const MIN_MAX_RETRIES = 0
export const MAX_MAX_RETRIES = 100

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000
export const MIN_STREAM_IDLE_TIMEOUT_MS = 30 * 1000
export const MAX_STREAM_IDLE_TIMEOUT_MS = 60 * 60 * 1000

export const ROUTE_SETTINGS_DEFAULTS = Object.freeze({
  maxRetries: DEFAULT_MAX_RETRIES,
  streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
})

export const ROUTE_SETTINGS_LIMITS = Object.freeze({
  maxRetries: Object.freeze({ min: MIN_MAX_RETRIES, max: MAX_MAX_RETRIES }),
  streamIdleTimeoutMs: Object.freeze({ min: MIN_STREAM_IDLE_TIMEOUT_MS, max: MAX_STREAM_IDLE_TIMEOUT_MS }),
})

const inRange = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max

/** Read the effective retry count and stream idle timeout from a preference snapshot. */
export function readRouteSettings(preference) {
  const retries = fieldValue(preference?.maxRetries)
  const timeout = fieldValue(preference?.streamIdleTimeoutMs)
  return {
    maxRetries: inRange(retries, MIN_MAX_RETRIES, MAX_MAX_RETRIES) ? retries : DEFAULT_MAX_RETRIES,
    streamIdleTimeoutMs: inRange(timeout, MIN_STREAM_IDLE_TIMEOUT_MS, MAX_STREAM_IDLE_TIMEOUT_MS)
      ? timeout
      : DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  }
}

export function createRouteSettingsController({ readPreference, writePreference, isWritable, onChange }) {
  const current = () => readRouteSettings(readPreference?.())
  let applied = current()

  const reconcile = () => {
    const next = current()
    if (next.maxRetries === applied.maxRetries && next.streamIdleTimeoutMs === applied.streamIdleTimeoutMs) return
    applied = next
    onChange?.()
  }

  const status = () => ({
    writable: isWritable?.() === true,
    ...current(),
    defaults: ROUTE_SETTINGS_DEFAULTS,
    limits: ROUTE_SETTINGS_LIMITS,
  })

  return Object.freeze({
    read: current,
    status,
    reconcile,
    async update(patch = {}) {
      const hasRetries = patch?.maxRetries !== undefined
      const hasTimeout = patch?.streamIdleTimeoutMs !== undefined
      if (!hasRetries && !hasTimeout) {
        throw new Error('That PackyCode retry or timeout setting is not supported')
      }
      if (hasRetries && !inRange(patch.maxRetries, MIN_MAX_RETRIES, MAX_MAX_RETRIES)) {
        throw new Error(`That PackyCode retry count must be an integer from ${MIN_MAX_RETRIES} to ${MAX_MAX_RETRIES}`)
      }
      if (hasTimeout && !inRange(patch.streamIdleTimeoutMs, MIN_STREAM_IDLE_TIMEOUT_MS, MAX_STREAM_IDLE_TIMEOUT_MS)) {
        throw new Error(`That PackyCode stream idle timeout must be between ${MIN_STREAM_IDLE_TIMEOUT_MS / 1000}s and ${MAX_STREAM_IDLE_TIMEOUT_MS / 1000}s`)
      }
      if (isWritable?.() !== true) throw new Error('PackyCode settings are not writable in this profile')
      const nextPatch = {
        ...(hasRetries ? { maxRetries: patch.maxRetries } : {}),
        ...(hasTimeout ? { streamIdleTimeoutMs: patch.streamIdleTimeoutMs } : {}),
      }
      try {
        await writePreference(nextPatch)
      } catch {
        throw new Error('PackyCode could not save the retry and timeout settings')
      }
      reconcile()
      return status()
    },
  })
}
