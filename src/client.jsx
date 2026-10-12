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

import { sumBalances } from './totals.js'

const NS = 'settings.packyCodeApi'
const PROVIDER = 'packycode'
const CHANNEL = '/packycode-api'
const REFRESH_MS = 60_000

const zh = {
  nav: 'PackyCode',
  intro: '填入 PackyCode（PackyAPI）的 API Key 即可使用内置模型路由；多个 Key 按顺序使用，额度用尽或失效时自动切到下一个。',
  accountTitle: '账户余额',
  totalRemaining: '合计剩余',
  totalUsed: '合计已用',
  totalLimit: '合计额度',
  totalPartial: '有 {count} 个 Key 未读到余额，未计入合计。',
  siteAccount: 'PackyCode 账号（含同账号其它用量）',
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
  cliTitle: 'Claude Code CLI',
  cliChecking: '正在检测本机的 Claude Code CLI…',
  cliInstalled: '已安装',
  cliVersion: '版本',
  cliPath: '位置',
  cliRecheck: '重新检测',
  cliMissing: '未检测到 Claude Code CLI',
  cliMissingHint: '不安装将无法正常使用 Claude 模型（claude-opus-5-5、claude-sonnet-5-5、claude-haiku-5-5）：PackyCode 只把 Claude 模型提供给官方 Claude Code CLI，插件需要调用本机的 CLI 来运行它。其它模型不受影响。',
  cliConfiguredMissing: '设置里指定的 CLI 路径不存在：{path}',
  cliBroken: '找到了 CLI，但无法运行',
  cliInstall: '安装 Claude Code CLI',
  cliReinstall: '重新安装',
  cliInstalling: '正在安装…（通常需要一两分钟，请勿关闭 DSH）',
  cliInstallCommand: '将在本机执行：{command}（需要 Node.js 18 或更高版本）',
  cliInstallSucceeded: '安装完成。',
  cliInstallFailed: '安装失败',
  cliNpmMissing: '没有找到 npm。请先从 https://nodejs.org 安装 Node.js（18 或更高版本），然后再点安装。',
  cliPermission: 'npm 没有权限写入全局目录。请在终端执行 sudo {command}，或把 npm 的全局目录改到用户目录后重试。',
  cliPermissionWindows: 'npm 没有权限写入全局目录。请以管理员身份打开终端执行 {command}，然后点「重新检测」。',
  cliNetwork: '下载失败，请检查网络或 npm 镜像设置后重试。',
  cliTimeout: '安装超时，请检查网络后重试。',
  cliNotFoundAfterInstall: 'npm 显示安装完成，但仍找不到 claude 命令。请在终端执行 claude --version 确认，然后点「重新检测」。',
  cliWindowsNote: 'Windows 上 Claude Code 还需要 Git for Windows（https://git-scm.com/downloads/win）。',
}

const en = {
  nav: 'PackyCode',
  intro: 'Paste a PackyCode (PackyAPI) API key to use the built-in model route. Multiple keys are used in order; an exhausted or rejected key hands over to the next one.',
  accountTitle: 'Account balance',
  totalRemaining: 'Total remaining',
  totalUsed: 'Total used',
  totalLimit: 'Total limit',
  totalPartial: '{count} key(s) could not be read and are not counted here.',
  siteAccount: 'PackyCode account (includes this account’s other usage)',
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
  cliTitle: 'Claude Code CLI',
  cliChecking: 'Checking this device for the Claude Code CLI…',
  cliInstalled: 'Installed',
  cliVersion: 'Version',
  cliPath: 'Location',
  cliRecheck: 'Check again',
  cliMissing: 'Claude Code CLI not found',
  cliMissingHint: 'Without it the Claude models (claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5) cannot work: PackyCode serves Claude models only to the official Claude Code CLI, so the plugin runs the CLI on this device. Other models are unaffected.',
  cliConfiguredMissing: 'The CLI path set in settings does not exist: {path}',
  cliBroken: 'The CLI was found but could not run',
  cliInstall: 'Install Claude Code CLI',
  cliReinstall: 'Reinstall',
  cliInstalling: 'Installing… (usually a minute or two; keep DSH open)',
  cliInstallCommand: 'Runs on this device: {command} (requires Node.js 18 or later)',
  cliInstallSucceeded: 'Installed.',
  cliInstallFailed: 'Install failed',
  cliNpmMissing: 'npm was not found. Install Node.js 18 or later from https://nodejs.org, then click Install again.',
  cliPermission: 'npm cannot write its global directory. Run sudo {command} in a terminal, or point npm’s global prefix at a folder you own, then retry.',
  cliPermissionWindows: 'npm cannot write its global directory. Open a terminal as administrator, run {command}, then click Check again.',
  cliNetwork: 'The download failed. Check your network or npm registry settings and retry.',
  cliTimeout: 'The install timed out. Check your network and retry.',
  cliNotFoundAfterInstall: 'npm reported success, but the claude command still cannot be found. Run claude --version in a terminal, then click Check again.',
  cliWindowsNote: 'On Windows, Claude Code also needs Git for Windows (https://git-scm.com/downloads/win).',
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
.packyCodeWarning{color:var(--dsw-alias-state-warning-primary,#c27c0e);font-weight:500}
.packyCodeDetail{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all;max-height:160px;overflow:auto}
.packyCodeMono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all}
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

const INSTALL_POLL_MS = 2_000

/** The sentence explaining a failed install, by the code the host classified. */
function installFailure(cli, t) {
  const command = cli.command ?? ''
  switch (cli.install?.code) {
    case 'npm-missing': return t('cliNpmMissing')
    case 'permission': return t(cli.platform === 'win32' ? 'cliPermissionWindows' : 'cliPermission').replace('{command}', command)
    case 'network': return t('cliNetwork')
    case 'timeout': return t('cliTimeout')
    case 'not-found-after-install': return t('cliNotFoundAfterInstall')
    default: return undefined
  }
}

/**
 * Whether this device has the Claude Code CLI, which version, and — when it
 * has none — a button that installs it with npm.
 */
function ClaudeCliCard({ call, t }) {
  const [cli, setCli] = react.useState()
  const [checking, setChecking] = react.useState(false)
  const [error, setError] = react.useState()

  const check = react.useCallback((force = false) => {
    setChecking(true)
    setError(undefined)
    return call('claude-cli/status', { force })
      .then(setCli)
      .catch(failure => setError(clearMessage(failure)))
      .finally(() => setChecking(false))
  }, [call])

  react.useEffect(() => {
    check(false)
  }, [check])

  const running = cli?.install?.state === 'running'
  react.useEffect(() => {
    if (!running) return undefined
    let live = true
    const timer = window.setInterval(() => {
      call('claude-cli/status').then(value => {
        if (live) setCli(value)
      }).catch(() => undefined)
    }, INSTALL_POLL_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [call, running])

  const install = () => {
    setError(undefined)
    call('claude-cli/install').then(setCli).catch(failure => setError(clearMessage(failure)))
  }

  const usable = cli?.installed === true && cli.version !== undefined
  const failed = cli?.install?.state === 'failed'
  return (
    <section className="packyCodeCard">
      <header className="packyCodeCardHeader">
        <span className="packyCodeCardTitle">{t('cliTitle')}</span>
        <button type="button" className="packyCodeButton" disabled={checking || running} onClick={() => check(true)}>
          {checking ? t('refreshing') : t('cliRecheck')}
        </button>
      </header>
      {cli === undefined && error === undefined && <span className="packyCodeNote">{t('cliChecking')}</span>}
      {usable && (
        <>
          <div className="packyCodeFigures">
            <span className="packyCodeFigure">
              <span className="packyCodeFigureLabel">{t('cliInstalled')}</span>
              <span className="packyCodeFigureValue">{`${t('cliVersion')} ${cli.version}`}</span>
            </span>
          </div>
          <span className="packyCodeNote">
            {`${t('cliPath')}：`}
            <span className="packyCodeMono">{cli.path}</span>
          </span>
          {cli.install?.state === 'succeeded' && <span className="packyCodeNote">{t('cliInstallSucceeded')}</span>}
        </>
      )}
      {cli !== undefined && !usable && (
        <>
          <span className="packyCodeWarning">{cli.installed ? t('cliBroken') : t('cliMissing')}</span>
          {cli.installed && (
            <>
              <span className="packyCodeNote">
                {`${t('cliPath')}：`}
                <span className="packyCodeMono">{cli.path}</span>
              </span>
              {cli.error !== undefined && <pre className="packyCodeDetail">{cli.error}</pre>}
            </>
          )}
          {cli.configuredPath !== undefined && (
            <span className="packyCodeNote">{t('cliConfiguredMissing').replace('{path}', cli.configuredPath)}</span>
          )}
          <span className="packyCodeIntro">{t('cliMissingHint')}</span>
          <div className="packyCodeActions">
            <button type="button" className="packyCodeButton packyCodeButtonPrimary" disabled={running || checking} onClick={install}>
              {running ? t('cliInstalling') : cli.installed ? t('cliReinstall') : t('cliInstall')}
            </button>
          </div>
          <span className="packyCodeNote">
            {t('cliInstallCommand').replace('{command}', cli.command ?? '')}
            {cli.platform === 'win32' && ` ${t('cliWindowsNote')}`}
          </span>
        </>
      )}
      {failed && !usable && (
        <>
          <span className="packyCodeError">
            {installFailure(cli, t) === undefined ? t('cliInstallFailed') : `${t('cliInstallFailed')}：${installFailure(cli, t)}`}
          </span>
          {cli.install.detail !== undefined && cli.install.detail !== '' && <pre className="packyCodeDetail">{cli.install.detail}</pre>}
        </>
      )}
      {error !== undefined && <span className="packyCodeError">{`${t('error')}: ${error}`}</span>}
    </section>
  )
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
  // The headline figure is what these keys can spend together, not the
  // account-level billing number PackyCode reports beside it.
  const totals = sumBalances(rows)

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

      <ClaudeCliCard call={call} t={t} />

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
        {rows.length === 0
          ? <span className="packyCodeNote">{t('empty')}</span>
          : (
            <>
              <div className="packyCodeFigures">
                <span className="packyCodeFigure">
                  <span className="packyCodeFigureLabel">{t('totalRemaining')}</span>
                  <span className="packyCodeFigureValue">
                    {totals.counted === 0 ? '—' : formatUsd(totals.remainingUsd) ?? '—'}
                    {totals.unlimited > 0 && ` + ${t('keyUnlimited')}`}
                  </span>
                </span>
                <span className="packyCodeFigure">
                  <span className="packyCodeFigureLabel">{t('totalUsed')}</span>
                  <span className="packyCodeFigureValue">{totals.counted === 0 ? '—' : formatUsd(totals.usedUsd) ?? '—'}</span>
                </span>
                <span className="packyCodeFigure">
                  <span className="packyCodeFigureLabel">{t('totalLimit')}</span>
                  <span className="packyCodeFigureValue">
                    {totals.counted === 0 || totals.unlimited > 0 ? t('keyUnlimited') : formatUsd(totals.limitUsd) ?? '—'}
                  </span>
                </span>
              </div>
              {totals.unread > 0 && (
                <span className="packyCodeNote">{t('totalPartial').replace('{count}', String(totals.unread))}</span>
              )}
              {account?.error === undefined && account !== undefined && (
                <span className="packyCodeNote">
                  {`${t('siteAccount')}：${t('keyRemaining')} ${formatUsd(account.remainingUsd) ?? '—'}`
                    + ` · ${t('keyUsed')} ${formatUsd(account.totalUsageUsd) ?? '—'}`
                    + ` · ${t('accountLimit')} ${formatUsd(account.hardLimitUsd) ?? '—'}`}
                </span>
              )}
            </>
          )}
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
