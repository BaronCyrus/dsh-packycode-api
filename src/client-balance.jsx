import * as react from 'react'

import { quotaTotalUsd, sumBalances } from './totals.js'

export const fill = (text, values) => text.replace(/\{(\w+)\}/gu, (match, name) => values[name] === undefined ? match : String(values[name]))

export function formatUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value) }
  catch { return `$${value.toFixed(2)}` }
}

export function readTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  try { return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }
  catch { return new Date(ms).toISOString().slice(11, 16) }
}

const RESET_KEYS = { monthly: 'resetMonthly', weekly: 'resetWeekly', daily: 'resetDaily', never: 'resetNever' }

/** The same quota presentation for conversation and image credential records. */
export function KeyBalance({ row, t }) {
  const usage = row?.usage
  const totalUsd = quotaTotalUsd(usage)
  const figures = [
    usage?.unlimitedQuota === true
      ? [t('keyRemaining'), t('keyUnlimited')]
      : usage?.availableUsd === undefined ? undefined : [t('keyRemaining'), formatUsd(usage.availableUsd)],
    usage?.usedUsd === undefined ? undefined : [t('keyUsed'), formatUsd(usage.usedUsd)],
    totalUsd === undefined ? undefined : [t('accountLimit'), formatUsd(totalUsd)],
  ].filter(Boolean)
  const meta = [
    usage?.name === undefined ? t('keyNameUnknown') : `${t('keyName')} ${usage.name}`,
    RESET_KEYS[usage?.resetPeriod] === undefined ? undefined : t(RESET_KEYS[usage.resetPeriod]),
  ].filter(Boolean).join(' · ')
  const share = usage?.unlimitedQuota !== true && totalUsd > 0 && typeof usage.availableUsd === 'number'
    ? Math.max(0, Math.min(1, usage.availableUsd / totalUsd)) : undefined
  return <>
    <span className="pkc-meta">{meta}</span>
    {figures.length > 0 ? <div className="pkc-figures">
      {figures.map(([label, value]) => <span key={label}>{label}<b>{value}</b></span>)}
    </div> : <span className="pkc-meta">{row?.error === undefined ? t('keyNoBalance') : `${t('loadFailed')}: ${row.error}`}</span>}
    {share !== undefined && <div className="pkc-bar" data-level={share < 0.1 ? 'low' : share < 0.3 ? 'warn' : 'ok'} role="presentation">
      <span style={{ width: `${Math.round(share * 100)}%` }} />
    </div>}
    {row?.stale !== undefined && <span className="pkc-warn">{fill(t('staleNote'), { time: readTime(row.stale.fetchedAt), error: row.stale.error ?? '' })}</span>}
  </>
}

/** Only this card's keys contribute; account-wide billing is never added. */
export function BalanceTotals({ rows, t }) {
  const totals = sumBalances(rows)
  const stale = rows.filter(row => row.stale !== undefined).length
  const known = field => rows.some(row => row.usage?.unlimitedQuota !== true && Number.isFinite(row.usage?.[field]))
  return <>
    <div className="pkc-stats">
      <div className="pkc-stat"><span className="pkc-stat-label">{t('totalRemaining')}</span><span className="pkc-stat-value">
        {known('availableUsd') ? formatUsd(totals.remainingUsd) : totals.unlimited > 0 ? t('keyUnlimited') : '—'}{known('availableUsd') && totals.unlimited > 0 && ` + ${t('keyUnlimited')}`}
      </span></div>
      <div className="pkc-stat"><span className="pkc-stat-label">{t('totalUsed')}</span><span className="pkc-stat-value">{known('usedUsd') ? formatUsd(totals.usedUsd) : '—'}</span></div>
      <div className="pkc-stat"><span className="pkc-stat-label">{t('totalLimit')}</span><span className="pkc-stat-value">{totals.unlimited > 0 ? t('keyUnlimited') : known('availableUsd') && known('usedUsd') ? formatUsd(totals.limitUsd) : '—'}</span></div>
    </div>
    {(totals.unread > 0 || stale > 0) && <p className="pkc-note">{[
      totals.unread > 0 ? fill(t('totalPartial'), { count: totals.unread }) : undefined,
      stale > 0 ? fill(t('totalStale'), { count: stale }) : undefined,
    ].filter(Boolean).join(' ')}</p>}
  </>
}
