import assert from 'node:assert/strict'
import test from 'node:test'

import { quotaTotalUsd } from '../src/totals.js'
import { parseTokenUsage } from '../src/balance.js'

test('a key shows remaining plus used as its quota', () => {
  assert.equal(quotaTotalUsd({ name: '战魂銘人-张洋凡', availableUsd: 499.07, usedUsd: 0.93, limitUsd: 500, resetPeriod: 'monthly' }), 500)
  assert.equal(quotaTotalUsd({ availableUsd: 0, usedUsd: 0 }), 0)
})

test('a non-resetting key totals remaining and used without a period limit', () => {
  const usage = parseTokenUsage({ data: { quota_limit: -1, quota_reset_period: 'never', total_granted: 25_000_000,
    total_available: 20_000_000, total_used: 5_000_000, unlimited_quota: false } })
  assert.equal(usage.limitUsd, undefined)
  assert.equal(quotaTotalUsd(usage), 50, 'a key does not need a periodic cap to show its remaining plus used quota')
})

test('periodic caps and grants do not change the displayed quota', () => {
  assert.equal(quotaTotalUsd({ availableUsd: 10, usedUsd: 5, limitUsd: 1, grantedUsd: 50 }), 15)
  assert.equal(quotaTotalUsd({ availableUsd: 20, usedUsd: 5, grantedUsd: 99 }), 25)
})

test('an unlimited or partly read key has no quota amount', () => {
  // An unlimited key's remaining figure is not a balance, however large.
  assert.equal(quotaTotalUsd({ unlimitedQuota: true, availableUsd: 1_000_000, usedUsd: 1_000_000 }), undefined)
  assert.equal(quotaTotalUsd({ availableUsd: 9.5 }), undefined)
  assert.equal(quotaTotalUsd({ limitUsd: 12, grantedUsd: 50 }), undefined)
  assert.equal(quotaTotalUsd(undefined), undefined)
})
