/**
 * Totals across the keys a balance read returned.
 *
 * The per-key quota (`/api/usage/token/`) is what a key can spend, so the
 * combined figure is the sum of those rows. PackyCode also reports account
 * level billing (`/v1/dashboard/billing/*`), which is a different scope — it
 * counts every token on the account — and is deliberately not what this sum
 * shows.
 *
 * @module dsh-packycode-api/totals
 */

const amount = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/**
 * Add up the balance rows the host returned.
 * @param rows - the `keys` array of a balance projection.
 * @returns summed amounts plus the conditions that make a sum incomplete:
 *   keys whose read failed, and keys with no quota limit at all.
 */
export function sumBalances(rows) {
  const total = { keys: 0, counted: 0, unread: 0, unlimited: 0, remainingUsd: 0, usedUsd: 0, limitUsd: 0 }
  for (const row of Array.isArray(rows) ? rows : []) {
    total.keys += 1
    const usage = row?.usage
    if (usage === undefined) {
      total.unread += 1
      continue
    }
    total.counted += 1
    if (usage.unlimitedQuota === true) {
      total.unlimited += 1
      continue
    }
    const remaining = amount(usage.availableUsd)
    const used = amount(usage.usedUsd)
    const limit = amount(usage.limitUsd)
    if (remaining !== undefined) total.remainingUsd += remaining
    if (used !== undefined) total.usedUsd += used
    if (limit !== undefined) total.limitUsd += limit
  }
  return total
}
