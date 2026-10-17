/**
 * Per-request facts the route knows but pi-ai does not carry to the wire.
 *
 * DSH hands the route a request's purpose (an agent step, a session title, a
 * compaction) and the initiating session's working directory; pi-ai forwards
 * only the model, messages and transport options to the provider. The route
 * runs each stream's iteration inside an async context holding those facts,
 * so the Claude transport can read them where the request is actually sent.
 * Nothing here is model-visible or leaves the host.
 *
 * @module dsh-packycode-api/request-context
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage()

/** The facts of the request being sent, or undefined outside the route. */
export const currentRequest = () => storage.getStore()

/**
 * Iterate `iterable` with `context` as the current request. Every `next()` —
 * and so every promise the producer creates while it runs — sees the context,
 * however the consumer interleaves several streams.
 * @param context - plain facts; frozen before use.
 * @param iterable - the stream to iterate.
 * @returns an async iterable over the same items.
 */
export function withRequestContext(context, iterable) {
  const store = Object.freeze({ ...context })
  return {
    [Symbol.asyncIterator]() {
      let iterator
      const run = action => storage.run(store, () => {
        iterator ??= iterable[Symbol.asyncIterator]()
        return action(iterator)
      })
      return {
        next: (...args) => run(it => it.next(...args)),
        return: (...args) => run(it => (typeof it.return === 'function' ? it.return(...args) : Promise.resolve({ done: true, value: args[0] }))),
        throw: (...args) => run(it => (typeof it.throw === 'function' ? it.throw(...args) : Promise.reject(args[0]))),
        [Symbol.asyncIterator]() { return this },
      }
    },
  }
}
