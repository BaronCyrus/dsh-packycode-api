/**
 * Test doubles shared across the suite.
 */

/**
 * An in-memory DSH credential-record service with the real one's semantics
 * at the seam the key ring uses: reads answer the committed record, and
 * modifications are serialized read-decide-replace operations.
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
    modifyRecord(_key, mutate) {
      const run = chain.then(async () => {
        const next = await mutate(record)
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
