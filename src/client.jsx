/**
 * Browser half: the PackyCode settings page and the composer balance chip.
 *
 * Every number here comes from the host over the plugin's own loopback RPC
 * channel; no key material crosses it, and each read is a bounded projection
 * the host built.
 *
 * @module dsh-packycode-api/client
 */

import * as react from 'react'

const NS = 'settings.packyCodeApi'
const PROVIDER = 'packycode'
const CHANNEL = '/packycode-api'
const REFRESH_MS = 60_000

const zh = {
  nav: 'PackyCode',
  intro: '填入 PackyCode（PackyAPI）的 API Key 即可使用内置模型路由；多个 Key 按顺序使用，额度用尽或失效时自动切到下一个。',
  accountTitle: '账户余额',
  accountSummary: '账号合计剩余',
  accountUsed: '账号合计已用',
  accountLimit: '额度',
  refresh: '刷新',
  refreshing: '刷新中…',
  keysTitle: 'API Key',
  keysHint: '按顺序使用：当前 Key 不可用时自动切到下一个可用 Key。上方的账户余额按 PackyCode 账户名逐条列出。',
  keyActive: '使用中',
  keyDisabled: '已停用',
  keyUse: '切到此 Key',
  keyEnable: '重新启用',
  keyRemove: '删除',
  keyUnlimited: '不限额度',
  keyNoBalance: '余额未知',
  keyRemaining: '剩余',
  keyUsed: '已用',
  keyName: '账户名',
  keyNameUnknown: '账户名待读取',
  resetMonthly: '每月',
  resetWeekly: '每周',
  resetDaily: '每日',
  addTitle: '添加 Key',
  addKeyPlaceholder: '粘贴 API Key',
  addLabelPlaceholder: '备注（可选）',
  add: '添加',
  removeAll: '清空全部',
  empty: '还没有 Key。添加一个即可在模型选择器里看到 PackyCode 的模型。',
  advanced: '高级：接口地址',
  apiHost: '模型接口地址',
  statusHost: '余额接口地址',
  save: '保存',
  saved: '已保存',
  notWritable: '当前 profile 不允许写入设置，改动只在本次运行内生效。',
  composerLabel: 'PackyCode 剩余额度',
  composerNoKey: '无可用 Key',
  error: '读取 PackyCode 状态失败',
  loadFailed: '读取失败',
}

const en = {
  nav: 'PackyCode',
  intro: 'Paste a PackyCode (PackyAPI) API key to use the built-in model route. Multiple keys are used in order; an exhausted or rejected key hands over to the next one.',
  accountTitle: 'Account balance',
  accountSummary: 'Account total left',
  accountUsed: 'Account total used',
  accountLimit: 'Limit',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  keysTitle: 'API keys',
  keysHint: 'Used in order: when the active key cannot serve a request, the next usable one takes over. The balances above are listed per PackyCode account.',
  keyActive: 'Active',
  keyDisabled: 'Disabled',
  keyUse: 'Use this key',
  keyEnable: 'Re-enable',
  keyRemove: 'Remove',
  keyUnlimited: 'No quota limit',
  keyNoBalance: 'Balance unknown',
  keyRemaining: 'Remaining',
  keyUsed: 'Used',
  keyName: 'Account name',
  keyNameUnknown: 'Account name not read yet',
  resetMonthly: 'monthly',
  resetWeekly: 'weekly',
  resetDaily: 'daily',
  addTitle: 'Add a key',
  addKeyPlaceholder: 'Paste API key',
  addLabelPlaceholder: 'Label (optional)',
  add: 'Add',
  removeAll: 'Remove all',
  empty: 'No keys yet. Add one and the PackyCode models appear in the model picker.',
  advanced: 'Advanced: endpoints',
  apiHost: 'Model endpoint',
  statusHost: 'Balance endpoint',
  save: 'Save',
  saved: 'Saved',
  notWritable: 'This profile does not allow settings writes; changes apply to this run only.',
  composerLabel: 'PackyCode remaining balance',
  composerNoKey: 'No usable key',
  error: 'Could not read PackyCode status',
  loadFailed: 'Read failed',
}

const STYLE = `
.packyCodeSection{display:flex;flex-direction:column;gap:16px;font-size:13px;line-height:20px}
.packyCodeIntro{color:var(--dsw-alias-label-secondary)}
.packyCodeCard{display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:12px;background:var(--dsw-alias-bg-module-platform)}
.packyCodeCardHeader{display:flex;align-items:center;justify-content:space-between;gap:12px}
.packyCodeCardTitle{font-weight:600}
.packyCodeFigures{display:flex;flex-wrap:wrap;gap:18px}
.packyCodeFigure{display:flex;flex-direction:column;gap:2px}
.packyCodeFigureLabel{color:var(--dsw-alias-label-tertiary);font-size:12px}
.packyCodeFigureValue{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.packyCodeRows{display:flex;flex-direction:column;gap:10px}
.packyCodeRow{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-module-platform)}
.packyCodeRowMain{display:flex;flex-direction:column;gap:2px;min-width:180px}
.packyCodeRowName{display:flex;align-items:center;gap:8px;font-weight:500}
.packyCodeRowMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
.packyCodeChip{padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.packyCodeChipActive{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-brand-primary,currentColor)}
.packyCodeActions{display:flex;flex-wrap:wrap;gap:8px}
.packyCodeForm{display:flex;flex-wrap:wrap;gap:8px}
.packyCodeInput{flex:1 1 220px;min-width:0;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35));background:var(--dsw-alias-bg-module-platform);color:inherit;font:inherit}
.packyCodeButton{height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35));background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary,inherit);font:inherit;cursor:pointer}
.packyCodeButton:disabled{opacity:.55;cursor:default}
/* Emphasis without a themed fill: the brand colour may be light in either
   theme, and a filled button then hides its own label. */
.packyCodeButtonPrimary{border-color:var(--dsw-alias-brand-primary,currentColor);font-weight:600}
.packyCodeNote{color:var(--dsw-alias-label-tertiary);font-size:12px}
.packyCodeError{color:var(--dsw-alias-state-error-primary,#d9534f);font-size:12px}
.packyCodeAdvanced summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}
.packyCodeAdvancedBody{display:flex;flex-direction:column;gap:10px;padding-top:10px}
.packyCodeField{display:flex;flex-direction:column;gap:4px}
.packyCodeComposer{display:inline-flex;align-items:center;flex:0 0 auto;height:28px;box-sizing:border-box;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;user-select:none}
@media(max-width:640px){.packyCodeRow{align-items:flex-start;flex-direction:column}.packyCodeActions{width:100%}}
`

const unwrap = response => {
  if (!response?.ok) throw new Error(response?.error?.message ?? 'PackyCode RPC failed')
  return response.value
}

function formatUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value)
  } catch {
    return `$${value.toFixed(2)}`
  }
}

function resetLabel(period, t) {
  switch (period) {
    case 'monthly': return t('resetMonthly')
    case 'weekly': return t('resetWeekly')
    case 'daily': return t('resetDaily')
    default: return undefined
  }
}

/** Active key's usage row, preferring the key the ring currently points at. */
function activeUsage(balance) {
  if (balance === undefined) return undefined
  return balance.keys?.find(entry => entry.id === balance.activeId) ?? balance.keys?.[0]
}

function clearMessage(error) {
  const text = typeof error?.message === 'string' && error.message.length > 0 ? error.message : String(error)
  return text.length > 200 ? text.slice(0, 200) : text
}

function PackyCodeSection({ rpc, t }) {
  const call = react.useMemo(
    // The transport drops an `undefined` payload, and the channel's envelope
    // schema requires the field — so every call carries an object.
    () => (endpoint, payload = {}) => rpc.call(CHANNEL, endpoint, payload).then(unwrap),
    [rpc],
  )
  const [status, setStatus] = react.useState()
  const [balance, setBalance] = react.useState()
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState()
  const [draft, setDraft] = react.useState({ key: '', label: '' })
  const generation = react.useRef(0)

  const load = react.useCallback((force = false) => {
    const current = ++generation.current
    setBusy(true)
    setError(undefined)
    return Promise.all([call('status'), call('balance', { force })])
      .then(([nextStatus, nextBalance]) => {
        if (generation.current !== current) return
        setStatus(nextStatus)
        setBalance(nextBalance)
      })
      .catch(failure => {
        if (generation.current === current) setError(clearMessage(failure))
      })
      .finally(() => {
        if (generation.current === current) setBusy(false)
      })
  }, [call])

  react.useEffect(() => {
    load(false)
    return () => {
      generation.current += 1
    }
  }, [load])

  const mutate = endpoint => payload => {
    setBusy(true)
    setError(undefined)
    return call(endpoint, payload)
      .then(nextStatus => {
        setStatus(nextStatus)
        return call('balance', { force: true })
      })
      .then(nextBalance => setBalance(nextBalance))
      .catch(failure => setError(clearMessage(failure)))
      .finally(() => setBusy(false))
  }

  const addKey = event => {
    event.preventDefault()
    if (draft.key.trim() === '') return
    mutate('keys/add')({ key: draft.key, label: draft.label }).then(() => setDraft({ key: '', label: '' }))
  }

  const account = balance?.account
  const rows = balance?.keys ?? []
  const usageOf = id => rows.find(row => row.id === id)
  const keys = status?.keys ?? []

  /** One account row: the PackyCode token name carries the match to a key. */
  const accountRow = row => {
    const usage = row.usage
    const figures = [
      usage?.unlimitedQuota === true
        ? t('keyUnlimited')
        : usage?.availableUsd === undefined ? undefined : `${t('keyRemaining')} ${formatUsd(usage.availableUsd)}`,
      usage?.usedUsd === undefined ? undefined : `${t('keyUsed')} ${formatUsd(usage.usedUsd)}`,
      usage?.limitUsd === undefined ? undefined : `${t('accountLimit')} ${formatUsd(usage.limitUsd)}`,
      resetLabel(usage?.resetPeriod, t) === undefined ? undefined : resetLabel(usage.resetPeriod, t),
    ].filter(Boolean)
    return (
      <div className="packyCodeRow" key={row.id}>
        <span className="packyCodeRowMain">
          <span className="packyCodeRowName">
            {usage?.name ?? row.label}
            {row.id === status?.activeId && <span className="packyCodeChip packyCodeChipActive">{t('keyActive')}</span>}
            {row.disabled && <span className="packyCodeChip">{t('keyDisabled')}</span>}
          </span>
          <span className="packyCodeRowMeta">
            {figures.length > 0 ? figures.join(' · ') : (row.error === undefined ? t('keyNoBalance') : `${t('loadFailed')}: ${row.error}`)}
          </span>
        </span>
      </div>
    )
  }

  return (
    <div className="packyCodeSection">
      <p className="packyCodeIntro">{t('intro')}</p>

      <section className="packyCodeCard">
        <header className="packyCodeCardHeader">
          <span className="packyCodeCardTitle">{t('accountTitle')}</span>
          <button type="button" className="packyCodeButton" disabled={busy} onClick={() => load(true)}>
            {busy ? t('refreshing') : t('refresh')}
          </button>
        </header>
        {rows.length === 0
          ? <span className="packyCodeNote">{t('empty')}</span>
          : <div className="packyCodeRows">{rows.map(accountRow)}</div>}
        {account?.error === undefined
          ? (
            <div className="packyCodeFigures">
              <span className="packyCodeFigure">
                <span className="packyCodeFigureLabel">{t('accountSummary')}</span>
                <span className="packyCodeFigureValue">{formatUsd(account?.remainingUsd) ?? '—'}</span>
              </span>
              <span className="packyCodeFigure">
                <span className="packyCodeFigureLabel">{t('accountUsed')}</span>
                <span className="packyCodeFigureValue">{formatUsd(account?.totalUsageUsd) ?? '—'}</span>
              </span>
              <span className="packyCodeFigure">
                <span className="packyCodeFigureLabel">{t('accountLimit')}</span>
                <span className="packyCodeFigureValue">{formatUsd(account?.hardLimitUsd) ?? '—'}</span>
              </span>
            </div>
          )
          : <span className="packyCodeNote">{account === undefined ? t('keyNoBalance') : `${t('loadFailed')}: ${account.error}`}</span>}
      </section>

      <section className="packyCodeCard">
        <header className="packyCodeCardHeader">
          <span className="packyCodeCardTitle">{t('keysTitle')}</span>
          {keys.length > 0 && (
            <button type="button" className="packyCodeButton" disabled={busy} onClick={() => mutate('keys/remove-all')({})}>
              {t('removeAll')}
            </button>
          )}
        </header>
        <span className="packyCodeNote">{t('keysHint')}</span>
        {keys.length === 0
          ? <span className="packyCodeNote">{t('empty')}</span>
          : (
            <div className="packyCodeRows">
              {keys.map(key => {
                const row = usageOf(key.id)
                return (
                  <div className="packyCodeRow" key={key.id}>
                    <span className="packyCodeRowMain">
                      <span className="packyCodeRowName">
                        {key.label}
                        {key.active && <span className="packyCodeChip packyCodeChipActive">{t('keyActive')}</span>}
                        {key.disabled && <span className="packyCodeChip">{`${t('keyDisabled')}: ${key.disabledReason ?? ''}`.trim()}</span>}
                      </span>
                      <span className="packyCodeRowMeta">
                        {row?.usage?.name === undefined ? t('keyNameUnknown') : `${t('keyName')} ${row.usage.name}`}
                      </span>
                    </span>
                    <span className="packyCodeActions">
                      {!key.active && !key.disabled && (
                        <button type="button" className="packyCodeButton" disabled={busy} onClick={() => mutate('keys/select')({ id: key.id })}>
                          {t('keyUse')}
                        </button>
                      )}
                      {key.disabled && (
                        <button type="button" className="packyCodeButton" disabled={busy} onClick={() => mutate('keys/enable')({ id: key.id })}>
                          {t('keyEnable')}
                        </button>
                      )}
                      <button type="button" className="packyCodeButton" disabled={busy} onClick={() => mutate('keys/remove')({ id: key.id })}>
                        {t('keyRemove')}
                      </button>
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        <form className="packyCodeForm" onSubmit={addKey}>
          <input
            className="packyCodeInput"
            type="password"
            autoComplete="off"
            placeholder={t('addKeyPlaceholder')}
            value={draft.key}
            onChange={event => setDraft(current => ({ ...current, key: event.target.value }))}
          />
          <input
            className="packyCodeInput"
            type="text"
            placeholder={t('addLabelPlaceholder')}
            value={draft.label}
            onChange={event => setDraft(current => ({ ...current, label: event.target.value }))}
          />
          <button type="submit" className="packyCodeButton packyCodeButtonPrimary" disabled={busy || draft.key.trim() === ''}>
            {t('add')}
          </button>
        </form>
        {status?.writable !== true && <span className="packyCodeNote">{t('notWritable')}</span>}
        {error !== undefined && <span className="packyCodeError">{`${t('error')}: ${error}`}</span>}
      </section>

      <details className="packyCodeAdvanced">
        <summary>{t('advanced')}</summary>
        <div className="packyCodeAdvancedBody">
          <label className="packyCodeField">
            <span className="packyCodeFigureLabel">{t('apiHost')}</span>
            <input
              className="packyCodeInput"
              type="text"
              disabled={status?.writable !== true}
              defaultValue={status?.hosts?.apiHost ?? ''}
              onBlur={event => mutate('hosts/update')({ apiHost: event.target.value, statusHost: status?.hosts?.statusHost })}
            />
          </label>
          <label className="packyCodeField">
            <span className="packyCodeFigureLabel">{t('statusHost')}</span>
            <input
              className="packyCodeInput"
              type="text"
              disabled={status?.writable !== true}
              defaultValue={status?.hosts?.statusHost ?? ''}
              onBlur={event => mutate('hosts/update')({ statusHost: event.target.value, apiHost: status?.hosts?.apiHost })}
            />
          </label>
        </div>
      </details>
    </div>
  )
}

function PackyCodeComposerQuota({ rpc, t, directory }) {
  const call = react.useMemo(
    // Same envelope rule as the settings panel: the payload field is required.
    () => (endpoint, payload = {}) => rpc.call(CHANNEL, endpoint, payload).then(unwrap),
    [rpc],
  )
  const snapshot = react.useSyncExternalStore(
    listener => directory.subscribe(listener),
    () => directory.getSnapshot(),
  )
  const enabled = snapshot?.current?.provider === PROVIDER
  const [balance, setBalance] = react.useState()

  react.useEffect(() => {
    if (!enabled) {
      setBalance(undefined)
      return undefined
    }
    let live = true
    const tick = () => {
      call('balance').then(value => {
        if (live) setBalance(value)
      }).catch(() => {
        if (live) setBalance(undefined)
      })
    }
    tick()
    const timer = window.setInterval(tick, REFRESH_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [call, enabled])

  if (!enabled || balance === undefined) return null
  const row = activeUsage(balance)
  const usage = row?.usage
  const display = usage?.unlimitedQuota === true
    ? t('keyUnlimited')
    : formatUsd(usage?.availableUsd) ?? t('composerNoKey')
  const label = `${t('composerLabel')}: ${display}`
  return (
    <span className="packyCodeComposer" role="status" aria-label={label} title={label}>
      {display}
    </span>
  )
}

export const inject = ['slots', 'locale', 'connection', 'modelDirectories']

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'packycode-api: copy')
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-packycode-api'
    tag.textContent = STYLE
    document.head.append(tag)
    return () => tag.remove()
  }, 'packycode-api: style')
  const connection = ctx.get('connection')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'packycode-api',
    order: 17,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ rpc: connection.rpc, t }),
  }, PackyCodeSection))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'packycode-api-balance',
    order: 17,
    locale: NS,
    inject: sessionId => ({
      rpc: connection.rpc,
      t,
      directory: ctx.modelDirectories.directoryFor(sessionId).store,
    }),
  }, PackyCodeComposerQuota))
}
