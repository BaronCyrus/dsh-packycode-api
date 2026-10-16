/**
 * The quota total one key shows.
 *
 * The per-key quota (`/api/usage/token/`) is what a key can spend. Its
 * displayed total is remaining plus used, so a key without a periodic cap
 * still shows one. Settings shows each key on its own row and adds nothing
 * across keys: an API key cannot read the PackyCode account's own balance,
 * and an unlimited key has no amount to add.
 *
 * @module dsh-packycode-api/totals
 */

const amount = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** Displayed key quota is remaining plus used, independent of a period cap. */
export function quotaTotalUsd(usage) {
  if (usage?.unlimitedQuota === true) return undefined
  const remaining = amount(usage?.availableUsd)
  const used = amount(usage?.usedUsd)
  if (remaining === undefined || used === undefined) return undefined
  return amount(Number((remaining + used).toFixed(6)))
}
