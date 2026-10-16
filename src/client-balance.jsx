import * as react from 'react'

import { quotaTotalUsd } from './totals.js'

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

/**
 * A composer quota figure with the same details for either key ring. The help
 * cursor marks it; hovering or focusing it shows the key, its account, the
 * remaining, used and total quota and when it was read, and asks the caller
 * for an unforced read.
 * @param props.copy - the ring's own lines: `title`, `key`, `failed`, `loading`.
 * @param props.empty - what the figure shows while the remaining quota is unknown.
 * @param props.align - `end` opens the details leftward, for the composer's right side.
 */
export function QuotaHover({ row, fetchedAt, loading = false, failed = false, empty, copy, align, onRefresh, t }) {
  const tooltipId = react.useId()
  const usage = row?.usage
  const unlimited = usage?.unlimitedQuota === true
  const remaining = unlimited ? t('keyUnlimited') : formatUsd(usage?.availableUsd)
  const stale = usage !== undefined && (failed || row.stale !== undefined)
  const display = remaining ?? empty
  const details = [
    copy.title,
    row?.label ? `${copy.key}: ${row.label}` : undefined,
    usage?.name ? `${t('keyName')}: ${usage.name}` : undefined,
    `${t('keyRemaining')}: ${remaining ?? '—'}`,
    `${t('keyUsed')}: ${formatUsd(usage?.usedUsd) ?? '—'}`,
    `${t('accountLimit')}: ${unlimited ? t('keyUnlimited') : formatUsd(quotaTotalUsd(usage)) ?? '—'}`,
    stale ? fill(t('composerStale'), { time: readTime(row.stale?.fetchedAt ?? fetchedAt) })
      : failed || row?.error ? copy.failed
        : loading ? copy.loading
          : fetchedAt === undefined ? undefined : fill(t('quotaReadAt'), { time: readTime(fetchedAt) }),
  ].filter(Boolean).join('\n')
  const refresh = () => { onRefresh?.() }
  return <span className="pkc-quota" data-align={align}>
    <span className="pkc-composer pkc-quota-value" role="status" tabIndex={0}
      aria-label={`${copy.title}: ${stale ? '≈' : ''}${display}`} aria-describedby={tooltipId}
      onMouseEnter={refresh} onFocus={refresh}>
      {stale ? `≈${display}` : display}
    </span>
    <span className="pkc-quota-tooltip" id={tooltipId} role="tooltip">{details}</span>
  </span>
}
