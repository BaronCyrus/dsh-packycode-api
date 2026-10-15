import * as react from 'react'

import { fill, formatUsd, readTime } from './client-balance.jsx'
import { quotaTotalUsd } from './totals.js'

/** Mirror the host's next-usable image key using only its public balance rows. */
function currentImageKey(balance) {
  const keys = balance?.keys ?? []
  const start = Math.max(0, keys.findIndex(row => row.id === balance.activeId))
  for (let offset = 0; offset < keys.length; offset += 1) {
    const row = keys[(start + offset) % keys.length]
    if (row.disabled !== true) return row
  }
  return undefined
}

/** Mounted inside the visible Create image shortcut, so its timer shares that lifetime. */
export function ImageShortcutBalance({ call, t }) {
  const [view, setView] = react.useState({ loading: true })
  const refresh = react.useRef(() => {})
  const tooltipId = react.useId()
  react.useEffect(() => {
    let live = true, generation = 0, pending = false
    const read = async (force = false, reset = false) => {
      if (!live || (pending && !force)) return
      const current = ++generation
      pending = true
      setView(previous => reset ? { loading: true } : { ...previous, loading: true })
      try {
        const balance = await call('images/balance', { force })
        if (live && current === generation) setView({ balance, loading: false })
      } catch {
        if (live && current === generation) setView(previous => ({ ...previous, loading: false, failed: true }))
      } finally {
        if (current === generation) pending = false
      }
    }
    refresh.current = read
    void read()
    const changed = () => { void read(true, true) }
    const timer = window.setInterval(() => { void read() }, 60_000)
    window.addEventListener('packycode-images-updated', changed)
    return () => {
      live = false
      generation += 1
      refresh.current = () => {}
      window.clearInterval(timer)
      window.removeEventListener('packycode-images-updated', changed)
    }
  }, [call])

  const row = currentImageKey(view.balance)
  const usage = row?.usage
  const unlimited = usage?.unlimitedQuota === true
  const remaining = unlimited ? t('keyUnlimited') : formatUsd(usage?.availableUsd)
  const stale = usage !== undefined && (view.failed || row.stale !== undefined)
  const display = remaining ?? (view.loading ? '…' : '—')
  const details = [
    t('imagesComposerLabel'),
    row?.label ? `${t('imagesBalanceKey')}: ${row.label}` : undefined,
    usage?.name ? `${t('keyName')}: ${usage.name}` : undefined,
    `${t('keyRemaining')}: ${remaining ?? '—'}`,
    `${t('keyUsed')}: ${formatUsd(usage?.usedUsd) ?? '—'}`,
    `${t('accountLimit')}: ${unlimited ? t('keyUnlimited') : formatUsd(quotaTotalUsd(usage)) ?? '—'}`,
    stale ? fill(t('composerStale'), { time: readTime(row.stale?.fetchedAt ?? view.balance?.fetchedAt) })
      : view.failed || row?.error ? t('imagesBalanceFailed')
        : view.loading ? t('imagesBalanceLoading')
          : view.balance?.fetchedAt === undefined ? undefined : fill(t('imagesBalanceReadAt'), { time: readTime(view.balance.fetchedAt) }),
  ].filter(Boolean).join('\n')

  return <span className="pkc-image-balance">
    <span className="pkc-composer pkc-image-balance-value" role="status" tabIndex={0}
      aria-label={`${t('imagesComposerLabel')}: ${stale ? '≈' : ''}${display}`} aria-describedby={tooltipId}
      onMouseEnter={() => { void refresh.current() }} onFocus={() => { void refresh.current() }}>
      {stale ? `≈${display}` : display}
    </span>
    <span className="pkc-image-balance-tooltip" id={tooltipId} role="tooltip">{details}</span>
  </span>
}
