import assert from 'node:assert/strict'
import test from 'node:test'

import { sumBalances } from '../src/totals.js'
import { parseTokenUsage } from '../src/balance.js'

test('adds the per-key quotas a balance read returned', () => {
  const rows = [
    { id: 'a', usage: { name: '战魂銘人-张洋凡', availableUsd: 499.07, usedUsd: 0.93, limitUsd: 500, resetPeriod: 'monthly' } },
    { id: 'b', usage: { name: '战魂銘人-机器人', availableUsd: 500, usedUsd: 0, limitUsd: 500, resetPeriod: 'monthly' } },
  ]
  const totals = sumBalances(rows)
  assert.equal(totals.counted, 2)
  assert.equal(Math.round(totals.remainingUsd * 100) / 100, 999.07)
  assert.equal(Math.round(totals.usedUsd * 100) / 100, 0.93)
  assert.equal(totals.limitUsd, 1000)
  assert.equal(totals.unread, 0)
  assert.equal(totals.unlimited, 0)
})

test('counts only what it can read and reports the rest', () => {
  const rows = [
    { id: 'a', usage: { availableUsd: 10, usedUsd: 1, limitUsd: 11 } },
    { id: 'b', error: 'this API key was rejected (401)' },
  ]
  const totals = sumBalances(rows)
  assert.equal(totals.keys, 2)
  assert.equal(totals.counted, 1)
  assert.equal(totals.unread, 1)
  assert.equal(totals.remainingUsd, 10)
  assert.equal(totals.limitUsd, 11)
})

test('an unlimited key is reported instead of inflating a limit', () => {
  const totals = sumBalances([
    { id: 'a', usage: { availableUsd: 100, usedUsd: 5, limitUsd: 105 } },
    { id: 'b', usage: { unlimitedQuota: true, availableUsd: 0, usedUsd: 0 } },
  ])
  assert.equal(totals.limitUsd, 105)
  assert.equal(totals.unlimited, 1)
})

test('a key without a period limit contributes only what it reports', () => {
  const totals = sumBalances([{ id: 'a', usage: { availableUsd: 2, usedUsd: 1 } }])
  assert.equal(totals.remainingUsd, 2)
  assert.equal(totals.limitUsd, 3)
})

test('a non-resetting key totals remaining and used without a period limit', () => {
  const usage = parseTokenUsage({ data: { quota_limit: -1, quota_reset_period: 'never', total_granted: 25_000_000,
    total_available: 20_000_000, total_used: 5_000_000, unlimited_quota: false } })
  assert.equal(usage.limitUsd, undefined)
  const totals = sumBalances([{ id: 'prepaid-image-key', usage }])
  assert.equal(totals.remainingUsd, 40)
  assert.equal(totals.usedUsd, 10)
  assert.equal(totals.limitUsd, 50, 'a key does not need a periodic cap to show its remaining plus used quota')
})

test('displayed total is remaining plus used, regardless of periodic caps or grants', () => {
  const totals = sumBalances([
    { usage: { availableUsd: 10, usedUsd: 5, limitUsd: 1, grantedUsd: 50 } },
    { usage: { availableUsd: 20, usedUsd: 5, grantedUsd: 99 } },
    { usage: { availableUsd: 0, usedUsd: 0, limitUsd: 0, grantedUsd: 30 } },
    { usage: { limitUsd: 12, grantedUsd: 50 } },
    { usage: { unlimitedQuota: true, availableUsd: 1_000_000, usedUsd: 1_000_000 } },
  ])
  assert.equal(totals.limitUsd, 40)
  assert.equal(totals.limitUsd, totals.remainingUsd + totals.usedUsd)
  assert.equal(totals.unlimited, 1)
})

test('an empty or malformed row list totals to zero', () => {
  assert.deepEqual(sumBalances([]), { keys: 0, counted: 0, unread: 0, unlimited: 0, remainingUsd: 0, usedUsd: 0, limitUsd: 0 })
  assert.equal(sumBalances(undefined).keys, 0)
  assert.equal(sumBalances([null, 7]).keys, 2)
  assert.equal(sumBalances([null, 7]).counted, 0)
})
