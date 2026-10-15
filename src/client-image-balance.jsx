import * as react from 'react'

import { QuotaHover } from './client-balance.jsx'

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

  return <QuotaHover
    row={currentImageKey(view.balance)} fetchedAt={view.balance?.fetchedAt}
    loading={view.loading} failed={view.failed === true} empty={view.loading ? '…' : '—'}
    copy={{ title: t('imagesComposerLabel'), key: t('imagesBalanceKey'), failed: t('imagesBalanceFailed'), loading: t('imagesBalanceLoading') }}
    onRefresh={() => { void refresh.current() }} t={t} />
}
