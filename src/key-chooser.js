/**
 * Which stored key a request runs with, and what happens when the gateway
 * rejects one.
 *
 * The ring's active key serves every request it can. A request for a model
 * the active key's groups cannot reach — as the last group reading shows —
 * runs on the next stored key that can; the active pointer itself does not
 * move. A key the gateway reports as exhausted or invalid is marked unusable
 * and the ring moves on, so the retry of the failed step resolves the next
 * key. Only keys stored in this plugin's ring are ever chosen.
 *
 * @module dsh-packycode-api/key-chooser
 */

import { pickKeyForModel } from './groups.js'

/** How long a request with a choice of keys waits for the first group reading. */
export const DEFAULT_GROUP_WAIT_MS = 6_000

/**
 * The keys one host-side request (a web search, an auto review) tries, in
 * order: the active key, then the other usable keys in ring order — except
 * that a key the group reading shows cannot reach the model goes last, behind
 * every key that can or may.
 * @param ring - the key ring.
 * @param modelId - the model the request asks.
 * @param covers - `(keyId, modelId) => true | false | undefined`, optional.
 * @returns the candidates, without key material beyond what the request needs.
 */
export async function orderKeysFor(ring, modelId, covers) {
  const active = await ring.activeKey()
  if (active === undefined) return []
  const usable = typeof ring.secrets === 'function' ? (await ring.secrets()).filter(entry => !entry.disabled) : []
  const start = usable.findIndex(entry => entry.id === active.id)
  const rest = start < 0 ? usable.filter(entry => entry.id !== active.id) : [...usable.slice(start + 1), ...usable.slice(0, start)]
  const rank = entry => {
    const value = covers?.(entry.id, modelId)
    return value === true ? 0 : value === false ? 2 : 1
  }
  return [active, ...rest]
    .map((entry, index) => ({ entry, index, rank: index === 0 && rank(entry) !== 2 ? -1 : rank(entry) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ entry }) => ({ id: entry.id, label: entry.label, key: entry.key }))
}

/**
 * @param options - the key ring, the group reader, what to do after a key
 *   moved aside, a logger, and how long to wait for the first group reading.
 * @returns the chooser.
 */
export function createKeyChooser({ ring, groups, onRotated, logger, waitMs = DEFAULT_GROUP_WAIT_MS }) {
  /**
   * Key material to ring id. A failure is reported from inside a stream, which
   * carries the request's key but not its id; this index is refreshed on every
   * resolution so the right key is the one that moves aside.
   */
  const idByKey = new Map()
  /** The ring as of the last resolution, for the synchronous per-request choice. */
  let snapshot = []

  const remember = async () => {
    const entries = await ring.secrets()
    snapshot = entries
    for (const entry of entries) idByKey.set(entry.key, entry.id)
  }
  const usable = () => snapshot.filter(entry => entry.disabled !== true)
  const covers = (keyId, modelId) => groups.covers(keyId, modelId)

  /**
   * Keep the group reading fresh for the choice. It only matters with two
   * usable keys or more; the first reading is awaited for at most `waitMs`,
   * later ones refresh in the background.
   */
  const warm = async () => {
    if (usable().length < 2) return
    const pending = groups.read().catch(() => undefined)
    if (groups.hasReading()) return
    let timer
    await Promise.race([pending, new Promise(resolve => { timer = setTimeout(resolve, waitMs) })])
    clearTimeout(timer)
  }

  /** The active key, after refreshing the ring and, when it matters, the groups. */
  const active = async () => {
    await remember()
    const key = await ring.activeKey()
    if (key !== undefined) await warm()
    return key
  }

  /**
   * Wait at most `waitMs` for a group reading to exist, whatever the number
   * of keys: a Claude request's transport depends on its key's groups.
   */
  const awaitGroups = async () => {
    if (groups.hasReading() || snapshot.length === 0) return
    let timer
    await Promise.race([groups.read().catch(() => undefined), new Promise(resolve => { timer = setTimeout(resolve, waitMs) })])
    clearTimeout(timer)
  }

  return Object.freeze({
    remember,
    covers,
    active,
    awaitGroups,

    /** The ring id of the key material a request carries, as of the last resolution. */
    idOf: key => (typeof key === 'string' ? idByKey.get(key) : undefined),

    /**
     * The key one HTTP request for `modelId` runs with, given the active key
     * pi-ai resolved. Synchronous because pi-ai opens its stream synchronously;
     * it reads the ring and groups as of the last {@link active}.
     * @returns the key material to send.
     */
    forRequest(modelId, apiKey) {
      const current = snapshot.find(entry => entry.key === apiKey)
      if (current === undefined) return apiKey
      const chosen = pickKeyForModel(modelId, current, usable(), covers)
      if (chosen?.switchedFrom !== undefined) {
        logger?.info?.('packycode-api: key %s cannot reach %s by its last group reading; this request uses key %s', current.id, modelId, chosen.id)
      }
      return chosen?.key ?? apiKey
    },

    /**
     * The gateway exhausted or rejected a key: mark it unusable so the ring
     * moves on, then let the caller drop what depended on it.
     * @param kind - `quota` or `invalid-key`.
     * @param _message - the failure text (unused; the kind decides).
     * @param key - the key material the failed request carried.
     * @param knownId - the key's ring id, when the caller has it.
     */
    onKeyFailure(kind, _message, key, knownId) {
      const id = knownId ?? (key === undefined ? undefined : idByKey.get(key))
      if (id === undefined) {
        logger?.warn?.('packycode-api: %s reported for an unidentified key; not rotating', kind)
        return
      }
      logger?.warn?.('packycode-api: %s on key %s; the next key serves the retry', kind, id)
      void ring.disable(id, kind)
        .then(() => onRotated?.())
        .catch(error => logger?.warn?.('packycode-api: could not move past key %s: %s', id, error.message))
    },
  })
}
