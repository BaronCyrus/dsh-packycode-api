/**
 * The settings card that turns one session into a numbers-only diagnosis a
 * user can copy into a bug report. The host builds the text; this card only
 * picks the session, shows the result and copies it.
 *
 * @module dsh-packycode-api/client-diagnostics
 */

import * as react from 'react'

const pad = value => String(value).padStart(2, '0')

/** The picker's local date and time; the report itself keeps UTC ISO times. */
function localTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const messageOf = failure => (failure instanceof Error ? failure.message : String(failure))

export function DiagnosticsCard({ call, t }) {
  const [sessions, setSessions] = react.useState()
  const [selected, setSelected] = react.useState('')
  const [report, setReport] = react.useState()
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState()
  const [copied, setCopied] = react.useState()
  const area = react.useRef(null)
  const mounted = react.useRef(true)
  react.useEffect(() => () => { mounted.current = false }, [])

  const loadSessions = react.useCallback(() => {
    setError(undefined)
    return call('diagnostics/sessions')
      .then(value => {
        if (!mounted.current) return
        const list = Array.isArray(value?.sessions) ? value.sessions : []
        setSessions(list)
        setSelected(current => (list.some(item => item.id === current) ? current : list[0]?.id ?? ''))
      })
      .catch(failure => { if (mounted.current) setError(messageOf(failure)) })
  }, [call])
  react.useEffect(() => { void loadSessions() }, [loadSessions])

  const generate = () => {
    if (selected === '') return
    setBusy(true)
    setError(undefined)
    setCopied(undefined)
    call('diagnostics/session', { sessionId: selected })
      .then(value => { if (mounted.current) setReport(JSON.stringify(value, null, 2)) })
      .catch(failure => { if (mounted.current) setError(messageOf(failure)) })
      .finally(() => { if (mounted.current) setBusy(false) })
  }

  /** Copy through the clipboard API, or select everything for a manual copy. */
  const copy = () => {
    if (report === undefined) return
    const selectAll = () => {
      area.current?.focus?.()
      area.current?.select?.()
      if (mounted.current) setCopied('selected')
    }
    const clipboard = globalThis.navigator?.clipboard
    if (typeof clipboard?.writeText !== 'function') {
      selectAll()
      return
    }
    clipboard.writeText(report).then(() => { if (mounted.current) setCopied('copied') }, selectAll)
  }

  const label = item => [localTime(item.createdAt), item.folder ?? t('diagNoFolder'), item.live ? t('diagLive') : undefined].filter(Boolean).join(' · ')

  return <section className="pkc-card">
    <header className="pkc-head">
      <h3 className="pkc-title">{t('diagTitle')}</h3>
      <span className="pkc-actions">
        <button className="pkc-btn" type="button" disabled={busy} onClick={() => { void loadSessions() }}>{t('refresh')}</button>
      </span>
    </header>
    <p className="pkc-note">{t('diagIntro')}</p>
    {sessions !== undefined && sessions.length === 0 && <p className="pkc-note">{t('diagNoSessions')}</p>}
    {sessions !== undefined && sessions.length > 0 && <div className="pkc-form">
      <select className="pkc-input pkc-diag-session" aria-label={t('diagSession')} value={selected} disabled={busy}
        onChange={event => { setSelected(event.target.value); setReport(undefined); setCopied(undefined) }}>
        {sessions.map(item => <option key={item.id} value={item.id}>{label(item)}</option>)}
      </select>
      <button className="pkc-btn" data-variant="primary" data-size="md" type="button" disabled={busy || selected === ''} onClick={generate}>
        {busy ? t('diagGenerating') : t('diagGenerate')}
      </button>
    </div>}
    {report !== undefined && <>
      <textarea ref={area} className="pkc-input pkc-mono pkc-diag-text" readOnly rows={14} value={report} aria-label={t('diagReport')} />
      <div className="pkc-form">
        <button className="pkc-btn" type="button" onClick={copy}>{copied === 'copied' ? t('diagCopied') : t('diagCopy')}</button>
        {copied === 'selected' && <span className="pkc-note">{t('diagSelected')}</span>}
      </div>
      <p className="pkc-note">{t('diagPrivacy')}</p>
    </>}
    {error !== undefined && <p className="pkc-error" role="alert">{`${t('diagError')}: ${error}`}</p>}
  </section>
}
