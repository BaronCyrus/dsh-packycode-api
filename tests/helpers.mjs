/**
 * Test doubles shared across the suite.
 */

/**
 * DSH 0.2.0-rc.2 `credentials-local` refuses a grant payload holding anything
 * JSON cannot represent — `undefined` included — before it writes the file.
 */
function assertJsonValue(where, value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    throw new TypeError(`credentials-local: ${where} holds a non-finite number`)
  }
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value))) {
    if (seen.has(value)) throw new TypeError(`credentials-local: ${where} is cyclic`)
    seen.add(value)
    for (const nested of Object.values(value)) assertJsonValue(where, nested, seen)
    seen.delete(value)
    return
  }
  throw new TypeError(`credentials-local: ${where} holds a value JSON cannot represent`)
}

/**
 * An in-memory DSH credential-record service with the real one's semantics
 * at the seam the key ring uses: reads answer the committed record,
 * modifications are serialized read-decide-replace operations, and a grant
 * payload must be plain JSON.
 * @param options - an optional record to start from.
 * @returns `{ readRecord, modifyRecord, payload }`; `payload()` is a
 *   test-only view of the stored grant payload.
 */
export function fakeCredentials({ record: initial } = {}) {
  let record = initial
  let chain = Promise.resolve()
  return {
    async readRecord() {
      return record
    },
    modifyRecord(key, mutate) {
      const run = chain.then(async () => {
        const next = await mutate(record)
        if (next?.kind === 'grant') assertJsonValue(`record "${key}" payload`, next.payload, new Set())
        if (next !== undefined) record = next
        return record
      })
      chain = run.then(() => undefined, () => undefined)
      return run
    },
    payload() {
      return record?.payload
    },
  }
}

/**
 * A key-ring record holding one key, as the ring itself would store it.
 * @param key - the key material.
 * @returns the credential record.
 */
export function singleKeyRecord(key) {
  return { kind: 'grant', payload: { version: 1, activeId: 'k1', keys: [{ id: 'k1', label: 'stub', key, addedAt: 1 }] } }
}
