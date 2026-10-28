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

import { en, zh } from './client-copy.js'
import { STYLE } from './client-style.js'
import { installImagePresentation, PackyCodeImagesCard, PackyCodeImageShortcut } from './client-images.jsx'
import { fill, KeyBalance, QuotaHover } from './client-balance.jsx'
import { KeyRenameForm, useKeyRename } from './client-key-rename.jsx'
import { DiagnosticsCard } from './client-diagnostics.jsx'

const NS = 'settings.packyCodeApi'
const PROVIDER = 'packycode'
const CHANNEL = '/packycode-api'
const REFRESH_MS = 60_000
/** PackyCode registration through the author's invite link, offered only until a key is stored. */
const INVITE_URL = 'https://www.packyapi.ai/register?aff=Im3l'
/** How long after a search change the panel re-reads what DSH applied (the patch hot-reloads). */
const SEARCH_SETTLE_MS = 1_500
/** While the CLI installs, the panel polls its status this often. */
const INSTALL_POLL_MS = 2_000
/** The auto review counts are re-read this often while the page is open. */
const REVIEW_POLL_MS = 5_000
const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
const OWN_SEARCH_IDS = { auto: 'packycode-api-auto', packycode: 'packycode-api' }
const FOREIGN_NAMES = { codex: 'Codex', kimi: 'Kimi' }
/** The catalog's models by family, for the "reaches" line under each key. */
const MODEL_FAMILIES = [
  ['DeepSeek', ['deepseek-flash', 'deepseek-v4-pro']],
  ['GPT', ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-5.6-sol']],
  ['Grok', ['grok-4.7']],
  ['Gemini', ['gemini-3.8-flash']],
  ['Claude', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']],
  // Not in the picker: auto review's classifier.
  ['Jev', ['jev-latest']],
]

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * The one way this bundle talks to the host. The transport drops an
 * `undefined` payload and the channel's envelope requires the field, so every
 * call carries an object.
 */
function channelCaller(rpc) {
  return (endpoint, payload = {}, signal) => rpc.call(CHANNEL, endpoint, payload, signal).then(response => {
    if (!response?.ok) throw new Error(response?.error?.message ?? 'PackyCode RPC failed')
    return response.value
  })
}

const useCaller = rpc => react.useMemo(() => channelCaller(rpc), [rpc])

function clearMessage(error) {
  const text = typeof error?.message === 'string' && error.message.length > 0 ? error.message : String(error)
  return text.length > 200 ? text.slice(0, 200) : text
}

/** Active key's usage row, preferring the key the ring currently points at. */
function activeUsage(balance) {
  if (balance === undefined) return undefined
  return balance.keys?.find(entry => entry.id === balance.activeId) ?? balance.keys?.[0]
}

/** Which catalog families a key reaches, from its per-model coverage. */
function reachOf(coverage) {
  return MODEL_FAMILIES.flatMap(([name, models]) => {
    const known = models.filter(id => typeof coverage?.[id] === 'boolean')
    if (known.length === 0) return []
    const reached = known.filter(id => coverage[id] === true)
    const state = reached.length === 0 ? 'no' : reached.length === known.length ? 'ok' : 'partial'
    return [{ name, state, reached, missing: known.filter(id => coverage[id] === false) }]
  })
}

// ── primitives ──────────────────────────────────────────────────────────────

function Card({ title, aside, children }) {
  return (
    <section className="pkc-card">
      <header className="pkc-head">
        <h3 className="pkc-title">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  )
}

function Button({ variant, size, children, ...rest }) {
  return <button type="button" className="pkc-btn" data-variant={variant} data-size={size} {...rest}>{children}</button>
}

function Segmented({ label, options, value, disabled, onChange }) {
  return (
    <div className="pkc-seg" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <button
          type="button"
          role="radio"
          key={option.value}
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => value !== option.value && onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

// ── accounts and keys ───────────────────────────────────────────────────────

/** A key's groups and what they reach. */
function KeyGroups({ group, descriptions, loading, t }) {
  if (group === undefined) {
    return loading ? <span className="pkc-meta">{t('groupsChecking')}</span> : null
  }
  if (group.rejected === true) return <span className="pkc-error">{t('groupsRejected')}</span>
  const reach = reachOf(group.coverage)
  const names = Array.isArray(group.groups) ? group.groups : []
  return (
    <>
      <div className="pkc-groups">
        <span className="pkc-label">{t('groupsTitle')}</span>
        {names.length === 0
          ? <span className="pkc-meta">{group.error === undefined ? '—' : `${t('groupsUnknown')}: ${group.error}`}</span>
          : names.map(name => <span className="pkc-tag" key={name} title={descriptions?.[name] ?? name}>{name}</span>)}
      </div>
      {reach.length > 0 && (
        <div className="pkc-reach">
          {reach.map(family => (
            <span
              key={family.name}
              data-state={family.state}
              title={[...family.reached.map(id => `✓ ${id}`), ...family.missing.map(id => `✗ ${id}`)].join('\n')}
            >
              {family.state === 'ok' ? '✓' : family.state === 'partial' ? '◐' : '✕'} {family.name}
              {family.state === 'partial' && ` (${t('groupsPartial')})`}
            </span>
          ))}
        </div>
      )}
      <ClaudeRoute group={group} t={t} />
      {group.stale !== undefined && <span className="pkc-meta">{t('groupsStale')}</span>}
    </>
  )
}

/** Which transport this key's Claude requests take, when the key reaches Claude. */
function ClaudeRoute({ group, t }) {
  const route = group.claudeTransport
  if (route === undefined || !CLAUDE_MODELS.some(id => group.coverage?.[id] === true)) return null
  const hint = route.transport !== 'cli'
    ? t('keyClaudeHttpHint')
    : route.reason === 'unknown'
      ? t('keyClaudeCliUnreadHint')
      : fill(t('keyClaudeCliHint'), { groups: (route.groups ?? []).join(' / ') || 'cc' })
  return (
    <div className="pkc-groups">
      <span className="pkc-chip" data-tone={route.transport === 'cli' ? 'info' : 'neutral'} title={hint}>
        {route.transport === 'cli' ? t('keyClaudeCli') : t('keyClaudeHttp')}
      </span>
    </div>
  )
}

function KeyRow({ entry, row, group, descriptions, groupsLoading, busy, rename, onAction, t }) {
  const editing = rename.renaming?.id === entry.id

  return (
    <div className="pkc-row">
      <div className="pkc-row-top">
        <span className="pkc-row-name">
          {editing
            ? <KeyRenameForm rename={rename} busy={busy} t={t} />
            : <span className="pkc-name">{entry.label}</span>}
          {entry.active && <span className="pkc-chip" data-tone="success">{t('keyActive')}</span>}
          {entry.disabled && <span className="pkc-chip" data-tone="danger">{entry.disabledReason ? `${t('keyDisabled')} · ${entry.disabledReason}` : t('keyDisabled')}</span>}
        </span>
        {!editing && (
          <span className="pkc-actions">
            {!entry.active && !entry.disabled && <Button disabled={busy} onClick={() => onAction('keys/select', { id: entry.id })}>{t('keyUse')}</Button>}
            {entry.disabled && <Button disabled={busy} onClick={() => onAction('keys/enable', { id: entry.id })}>{t('keyEnable')}</Button>}
            <Button variant="ghost" disabled={busy} onClick={() => rename.start(entry)}>{t('keyRename')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => onAction('keys/remove', { id: entry.id })}>{t('keyRemove')}</Button>
          </span>
        )}
      </div>
      <KeyBalance row={row} t={t} />
      <KeyGroups group={group} descriptions={descriptions} loading={groupsLoading} t={t} />
    </div>
  )
}

/**
 * Where to get a key, for a profile that has none. A new-window link: the
 * desktop shell hands http(s) window opens to the system browser, and a web
 * profile opens a new tab.
 */
function RegisterInvite({ t }) {
  return (
    <p className="pkc-note">
      {t('inviteLead')}{' '}
      <a className="pkc-link" href={INVITE_URL} target="_blank" rel="noopener noreferrer">{t('inviteLink')}</a>
    </p>
  )
}

function AccountsCard({ call, t }) {
  const [status, setStatus] = react.useState()
  const [balance, setBalance] = react.useState()
  const [groups, setGroups] = react.useState()
  const [groupsLoading, setGroupsLoading] = react.useState(true)
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState()
  const [draft, setDraft] = react.useState({ key: '', label: '' })
  const generation = react.useRef(0)

  const readGroups = react.useCallback((force = false) => {
    setGroupsLoading(true)
    return call('groups', { force })
      .then(setGroups)
      .catch(() => undefined)
      .finally(() => setGroupsLoading(false))
  }, [call])

  const load = react.useCallback((force = false) => {
    const current = ++generation.current
    setBusy(true)
    setError(undefined)
    void readGroups(force)
    return Promise.all([call('status'), call('balance', { force })])
      .then(([nextStatus, nextBalance]) => {
        if (generation.current !== current) return
        setStatus(nextStatus)
        setBalance(nextBalance)
      })
      .catch(failure => {
        if (generation.current === current) setError({ kind: 'read', message: clearMessage(failure) })
      })
      .finally(() => {
        if (generation.current === current) setBusy(false)
      })
  }, [call, readGroups])

  react.useEffect(() => {
    load(false)
    return () => {
      generation.current += 1
    }
  }, [load])

  /** A refused change says so; a balance read after a stored change is a read. */
  const mutate = (endpoint, payload) => {
    setBusy(true)
    setError(undefined)
    return call(endpoint, payload)
      .then(
        nextStatus => {
          setStatus(nextStatus)
          void readGroups(false)
          return call('balance', { force: true })
            .then(setBalance, failure => setError({ kind: 'read', message: clearMessage(failure) }))
        },
        failure => setError({ kind: 'save', message: clearMessage(failure) }),
      )
      .finally(() => setBusy(false))
  }

  const addKey = event => {
    event.preventDefault()
    if (draft.key.trim() === '') return
    mutate('keys/add', { key: draft.key, label: draft.label }).then(() => setDraft({ key: '', label: '' }))
  }

  const rename = useKeyRename(({ id, label }) => mutate('keys/rename', { id, label }))

  const keys = status?.keys ?? []
  const rows = balance?.keys ?? []
  return (
    <Card
      title={t('accountsTitle')}
      aside={(
        <span className="pkc-actions">
          <Button disabled={busy} onClick={() => load(true)}>{busy ? t('refreshing') : t('refresh')}</Button>
          {keys.length > 0 && <Button variant="danger" disabled={busy} onClick={() => mutate('keys/remove-all', {})}>{t('removeAll')}</Button>}
        </span>
      )}
    >
      {keys.length === 0
        ? (
          <>
            <p className="pkc-note">{t('empty')}</p>
            {/* Only once the host has answered: an unread or failed status says nothing about stored keys. */}
            {status !== undefined && <RegisterInvite t={t} />}
          </>
        )
        : (
          <>
            <div className="pkc-list">
              {keys.map(entry => (
                <KeyRow
                  key={entry.id}
                  entry={entry}
                  row={rows.find(row => row.id === entry.id)}
                  group={groups?.keys?.find(group => group.id === entry.id)}
                  descriptions={groups?.descriptions}
                  groupsLoading={groupsLoading}
                  busy={busy}
                  rename={rename}
                  onAction={mutate}
                  t={t}
                />
              ))}
            </div>
            <p className="pkc-note">{t('keysHint')}</p>
          </>
        )}
      <form className="pkc-add" onSubmit={addKey}>
        <span className="pkc-label">{t('addTitle')}</span>
        <div className="pkc-form">
          <input
            className="pkc-input"
            type="password"
            autoComplete="off"
            placeholder={t('addKeyPlaceholder')}
            value={draft.key}
            onChange={event => setDraft(current => ({ ...current, key: event.target.value }))}
          />
          <input
            className="pkc-input"
            type="text"
            placeholder={t('addLabelPlaceholder')}
            value={draft.label}
            onChange={event => setDraft(current => ({ ...current, label: event.target.value }))}
          />
          <Button type="submit" variant="primary" size="md" disabled={busy || draft.key.trim() === ''}>{t('add')}</Button>
        </div>
      </form>
      {status !== undefined && status.writable !== true && <p className="pkc-note">{t('notWritable')}</p>}
      {error !== undefined && <p className="pkc-error" role="alert">{`${t(error.kind === 'save' ? 'saveError' : 'error')}: ${error.message}`}</p>}
      <details className="pkc-advanced">
        <summary>{t('advanced')}</summary>
        <label className="pkc-field">
          <span className="pkc-label">{t('apiHost')}</span>
          <input
            className="pkc-input"
            type="text"
            disabled={status?.writable !== true}
            defaultValue={status?.hosts?.apiHost ?? ''}
            onBlur={event => mutate('hosts/update', { apiHost: event.target.value, statusHost: status?.hosts?.statusHost })}
          />
        </label>
        <label className="pkc-field">
          <span className="pkc-label">{t('statusHost')}</span>
          <input
            className="pkc-input"
            type="text"
            disabled={status?.writable !== true}
            defaultValue={status?.hosts?.statusHost ?? ''}
            onBlur={event => mutate('hosts/update', { statusHost: event.target.value, apiHost: status?.hosts?.apiHost })}
          />
        </label>
      </details>
    </Card>
  )
}

// ── model visibility ────────────────────────────────────────────────────────

function ModelsCard({ call, t }) {
  const [state, setState] = react.useState()
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState()

  react.useEffect(() => {
    let live = true
    call('models/status').then(value => {
      if (live) setState(value)
    }).catch(failure => {
      if (live) setError(clearMessage(failure))
    })
    return () => { live = false }
  }, [call])

  const models = state?.models ?? []
  const selectedIds = models.filter(model => model.selected).map(model => model.id)
  const disabled = busy || state?.writable !== true
  const update = ids => {
    if (disabled) return
    setBusy(true)
    setError(undefined)
    call('models/update', { selectedIds: ids })
      .then(setState)
      .catch(failure => setError(clearMessage(failure)))
      .finally(() => setBusy(false))
  }

  return (
    <Card title={t('modelsTitle')} aside={state !== undefined && <span className="pkc-meta">{fill(t('modelsCount'), { count: selectedIds.length, total: models.length })}</span>}>
      <p className="pkc-note">{t('modelsIntro')}</p>
      {state === undefined && error === undefined && <p className="pkc-note" role="status">{t('modelsChecking')}</p>}
      {state !== undefined && (
        <>
          <div className="pkc-actions">
            <Button disabled={disabled || selectedIds.length === models.length} onClick={() => update(models.map(model => model.id))}>{t('modelsAll')}</Button>
            <Button disabled={disabled || selectedIds.length === 0} onClick={() => update([])}>{t('modelsNone')}</Button>
          </div>
          <fieldset className="pkc-models" aria-label={t('modelsTitle')} disabled={disabled}>
            {models.map(model => (
              <label key={model.id} className="pkc-model">
                <input
                  type="checkbox"
                  checked={model.selected}
                  onChange={event => update(event.target.checked ? [...selectedIds, model.id] : selectedIds.filter(id => id !== model.id))}
                />
                <span><b>{model.name}</b><span className="pkc-meta pkc-mono">{model.id}</span></span>
              </label>
            ))}
          </fieldset>
          {selectedIds.length === 0 && <p className="pkc-note">{t('modelsEmpty')}</p>}
          {state.writable !== true && <p className="pkc-note">{t('searchNotWritable')}</p>}
        </>
      )}
      {error !== undefined && <p className="pkc-error" role="alert">{`${t('modelsFailed')}: ${error}`}</p>}
    </Card>
  )
}

// ── web search ──────────────────────────────────────────────────────────────

/** Web search routing and backend, written through the host. */
function SearchCard({ call, t }) {
  const [state, setState] = react.useState()
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState()
  const generation = react.useRef(0)

  const read = react.useCallback(() => {
    const current = ++generation.current
    return call('search/status').then(value => {
      if (generation.current === current) setState(value)
    }).catch(failure => {
      if (generation.current === current) setError(clearMessage(failure))
    })
  }, [call])

  react.useEffect(() => {
    read()
    return () => {
      generation.current += 1
    }
  }, [read])

  const update = patch => {
    if (busy || state?.writable !== true) return
    setBusy(true)
    setError(undefined)
    call('search/update', patch)
      .then(value => {
        setState(value)
        // The patch hot-applies after the write; read what DSH settled on.
        window.setTimeout(() => {
          read()
        }, SEARCH_SETTLE_MS)
      })
      .catch(failure => setError(clearMessage(failure)))
      .finally(() => setBusy(false))
  }

  const mode = state?.searchProvider
  const backend = state?.searchBackend
  const models = state?.models ?? {}
  const base = state?.effective?.base
  const runtime = state?.effective?.runtime
  const foreign = Object.entries(state?.foreign ?? {}).filter(([, present]) => present).map(([name]) => FOREIGN_NAMES[name] ?? name)
  const expected = OWN_SEARCH_IDS[mode]
  const overridden = expected !== undefined && state?.applied?.state === 'applied' && base !== undefined && base !== expected
  const disabled = busy || state?.writable !== true
  const modeHint = { default: 'searchModeDefaultHint', auto: 'searchModeAutoHint', packycode: 'searchModePackycodeHint' }[mode]
  const backendHint = backend === 'gpt'
    ? fill(t('searchBackendGptHint'), { model: models.gpt ?? 'gpt-6.1-sol' })
    : fill(t('searchBackendDeepseekHint'), { model: models.deepseek ?? 'deepseek-flash' })

  return (
    <Card title={t('searchTitle')} aside={<span className="pkc-chip" data-tone="neutral">{t('searchScope')}</span>}>
      <p className="pkc-note">{t('searchIntro')}</p>
      {state === undefined && error === undefined && <p className="pkc-note" role="status">{t('searchChecking')}</p>}
      {state !== undefined && (
        <>
          <div className="pkc-setting">
            <span className="pkc-label">{t('searchModeTitle')}</span>
            <div>
              <Segmented
                label={t('searchModeTitle')}
                value={mode}
                disabled={disabled}
                onChange={value => update({ searchProvider: value })}
                options={[
                  { value: 'default', label: t('searchModeDefault') },
                  { value: 'auto', label: t('searchModeAuto') },
                  { value: 'packycode', label: t('searchModePackycode') },
                ]}
              />
              {modeHint !== undefined && <p className="pkc-note">{t(modeHint)}</p>}
            </div>
          </div>
          <div className="pkc-setting">
            <span className="pkc-label">{t('searchBackendTitle')}</span>
            <div>
              <Segmented
                label={t('searchBackendTitle')}
                value={backend}
                disabled={disabled}
                onChange={value => update({ searchBackend: value })}
                options={[
                  { value: 'deepseek', label: t('searchBackendDeepseek') },
                  { value: 'gpt', label: t('searchBackendGpt') },
                ]}
              />
              <p className="pkc-note">{backendHint}</p>
            </div>
          </div>
          {state.available === true && (base !== undefined || runtime !== undefined) && (
            <div className="pkc-status">
              <span className="pkc-dot" data-tone={overridden ? 'warn' : expected !== undefined && base === expected ? 'success' : undefined} />
              <span className="pkc-meta">{fill(t('searchEffective'), { base: base ?? t('searchUnknown'), runtime: runtime ?? base ?? t('searchUnknown') })}</span>
            </div>
          )}
          {overridden && <p className="pkc-warn">{fill(t('searchOverridden'), { base })}</p>}
          {foreign.length > 0 && <p className="pkc-note">{fill(t('searchForeign'), { names: foreign.join(' / ') })}</p>}
          {state.applied?.state === 'failed' && <p className="pkc-error" role="alert">{fill(t('searchApplyFailed'), { error: state.applied.error ?? '' })}</p>}
          {state.available !== true && <p className="pkc-note">{t('searchUnavailable')}</p>}
          {state.writable !== true && <p className="pkc-note">{t('searchNotWritable')}</p>}
          <p className="pkc-note">{t('searchPatchNote')}</p>
        </>
      )}
      {error !== undefined && <p className="pkc-error" role="alert">{`${t('searchLoadFailed')}: ${error}`}</p>}
    </Card>
  )
}

// ── auto review ─────────────────────────────────────────────────────────────

const REVIEW_OUTCOMES = { allowed: 'reviewOutcomeAllowed', denied: 'reviewOutcomeDenied', failed: 'reviewOutcomeFailed' }
const REVIEW_LABELS = { 'jev-latest': 'reviewModelJev', 'deepseek-flash': 'reviewModelFlash', session: 'reviewModelSession' }
const REVIEW_HINTS = { 'jev-latest': 'reviewModelJevHint', 'deepseek-flash': 'reviewModelFlashHint', session: 'reviewModelSessionHint' }

/** Which model DSH's official auto review uses; the official plugin owns the rest. */
function AutoReviewCard({ call, t }) {
  const [state, setState] = react.useState()
  const [groups, setGroups] = react.useState()
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState()
  const generation = react.useRef(0)

  const read = react.useCallback(() => {
    const current = ++generation.current
    return call('auto-review/status').then(value => {
      if (generation.current === current) setState(value)
    }).catch(failure => {
      if (generation.current === current) setError(clearMessage(failure))
    })
  }, [call])

  react.useEffect(() => {
    let live = true
    read()
    // Which keys reach the reviewer: the host's cached group reading.
    call('groups').then(value => {
      if (live) setGroups(value)
    }).catch(() => undefined)
    const timer = window.setInterval(read, REVIEW_POLL_MS)
    return () => {
      live = false
      generation.current += 1
      window.clearInterval(timer)
    }
  }, [call, read])

  const update = patch => {
    if (busy || state?.writable !== true) return
    setBusy(true)
    setError(undefined)
    generation.current += 1
    call('auto-review/update', patch)
      .then(value => setState(value))
      .catch(failure => setError(clearMessage(failure)))
      .finally(() => setBusy(false))
  }

  const label = id => (REVIEW_LABELS[id] === undefined ? id : t(REVIEW_LABELS[id]))
  const model = state?.model
  const enabled = state?.official?.enabled === true
  const keys = groups?.keys ?? []
  const uncovered = model !== undefined && model !== 'session' && keys.length > 0 && keys.every(entry => entry.coverage?.[model] === false)
  const counts = state?.counts
  const last = state?.last
  const disabled = busy || state?.writable !== true

  return (
    <Card
      title={t('reviewTitle')}
      aside={state !== undefined && (
        <span className="pkc-chip" data-tone={enabled ? 'success' : 'neutral'}>{enabled ? t('reviewOfficialOn') : t('reviewOfficialOff')}</span>
      )}
    >
      <p className="pkc-note">{t('reviewIntro')}</p>
      {state === undefined && error === undefined && <p className="pkc-note" role="status">{t('reviewChecking')}</p>}
      {state !== undefined && (
        <>
          {!enabled && <p className="pkc-warn">{t('reviewEnableHint')}</p>}
          <div className="pkc-setting">
            <span className="pkc-label">{t('reviewModelTitle')}</span>
            <div>
              <Segmented
                label={t('reviewModelTitle')}
                value={model}
                disabled={disabled}
                onChange={value => update({ autoReviewModel: value })}
                options={(state.models ?? []).map(entry => ({ value: entry.id, label: label(entry.id) }))}
              />
              {REVIEW_HINTS[model] !== undefined && <p className="pkc-note">{t(REVIEW_HINTS[model])}</p>}
            </div>
          </div>
          {uncovered && <p className="pkc-warn">{fill(t('reviewUncovered'), { model: label(model) })}</p>}
          {counts !== undefined && counts.reviewed > 0 && (
            <div className="pkc-status">
              <span className="pkc-dot" data-tone={counts.failed > 0 ? 'warn' : 'success'} />
              <span className="pkc-meta">{fill(t('reviewCounts'), counts)}</span>
            </div>
          )}
          {last !== undefined && (
            <p className="pkc-meta">{fill(t('reviewLast'), {
              tool: last.tool ?? '',
              outcome: t(REVIEW_OUTCOMES[last.outcome] ?? 'reviewOutcomeFailed'),
              model: last.version ?? label(last.model),
              seconds: typeof last.ms === 'number' ? (last.ms / 1000).toFixed(1) : '?',
            })}</p>
          )}
          {state.writable !== true && <p className="pkc-note">{t('searchNotWritable')}</p>}
          <p className="pkc-note">{t('reviewMenuNote')}</p>
        </>
      )}
      {error !== undefined && <p className="pkc-error" role="alert">{`${t('reviewLoadFailed')}: ${error}`}</p>}
    </Card>
  )
}

// ── Claude Code CLI ─────────────────────────────────────────────────────────

const INSTALL_FAILURES = {
  'npm-missing': () => 'cliNpmMissing',
  permission: cli => (cli.platform === 'win32' ? 'cliPermissionWindows' : 'cliPermission'),
  network: () => 'cliNetwork',
  timeout: () => 'cliTimeout',
  'not-found-after-install': () => 'cliNotFoundAfterInstall',
  'not-installed': () => 'cliUpdateNotInstalled',
  'still-outdated': () => 'cliUpdateStillOutdated',
  'not-updated': () => 'cliUpdateNotUpdated',
  'broken-after-update': () => 'cliUpdateBroken',
}

/** The sentence explaining a failed install or update, by the code the host classified. */
function installFailure(cli, t) {
  const key = INSTALL_FAILURES[cli.install?.code]?.(cli)
  const command = cli.install?.action === 'update' ? cli.updateCommand : cli.command
  return key === undefined ? undefined : fill(t(key), {
    command: command ?? '',
    minVersion: cli.minVersion ?? '',
    version: cli.version ?? '',
    latest: cli.install?.latest ?? cli.latest ?? '',
  })
}

/**
 * Whether this device has the Claude Code CLI that Claude requests on cc
 * keys go through: an installer without one, an updater for one too old or
 * behind npm's latest.
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
  const update = () => {
    setError(undefined)
    call('claude-cli/update').then(setCli).catch(failure => setError(clearMessage(failure)))
  }

  const usable = cli?.installed === true && cli.version !== undefined
  const outdated = usable && cli.outdated === true
  const updateAvailable = usable && !outdated && cli.updateAvailable === true
  const action = cli?.install?.action ?? 'install'
  const failed = cli?.install?.state === 'failed'
  const failure = cli === undefined ? undefined : installFailure(cli, t)
  const processes = cli?.processes
  return (
    <Card
      title={t('cliTitle')}
      aside={<Button disabled={checking || running} onClick={() => check(true)}>{checking ? t('refreshing') : t('cliRecheck')}</Button>}
    >
      <p className="pkc-note">{t('cliIntro')}</p>
      {cli === undefined && error === undefined && <p className="pkc-note">{t('cliChecking')}</p>}
      {usable && !outdated && (
        <>
          <div className="pkc-status">
            <span className="pkc-dot" data-tone="success" />
            <span>{t('cliInstalled')}</span>
            <b>{`${t('cliVersion')} ${cli.version}`}</b>
          </div>
          <span className="pkc-meta">{t('cliPath')} <span className="pkc-mono">{cli.path}</span></span>
          {processes !== undefined && <span className="pkc-meta">{fill(t('cliProcesses'), processes)}</span>}
          {cli.install?.state === 'succeeded' && (
            <p className="pkc-note">{action === 'update'
              ? fill(t(cli.install.from !== undefined && cli.install.from === cli.install.to ? 'cliUpdateUnchanged' : 'cliUpdateSucceeded'), { version: cli.install.to ?? cli.version })
              : t('cliInstallSucceeded')}</p>
          )}
          {updateAvailable && (
            <>
              <p className="pkc-note">{fill(t('cliUpdateAvailable'), { latest: cli.latest ?? '' })}</p>
              <div className="pkc-split">
                <Button size="md" disabled={running || checking} onClick={update}>
                  {running && action === 'update' ? t('cliUpdating') : t('cliUpdate')}
                </Button>
              </div>
              {cli.updateCommand !== undefined && <p className="pkc-note">{fill(t('cliUpdateCommand'), { command: cli.updateCommand })}</p>}
            </>
          )}
        </>
      )}
      {outdated && (
        <div className="pkc-callout">
          <div className="pkc-status">
            <span className="pkc-dot" data-tone="warn" />
            <b>{t('cliOutdated')}</b>
            <span>{`${t('cliVersion')} ${cli.version}`}</span>
          </div>
          <span className="pkc-meta">{t('cliPath')} <span className="pkc-mono">{cli.path}</span></span>
          <p className="pkc-note">{fill(t('cliOutdatedHint'), { minVersion: cli.minVersion ?? '' })}</p>
          <div className="pkc-split">
            <Button variant="primary" size="md" disabled={running || checking} onClick={update}>
              {running && action === 'update' ? t('cliUpdating') : t('cliUpdate')}
            </Button>
          </div>
          {cli.updateCommand !== undefined && <p className="pkc-note">{fill(t('cliUpdateCommand'), { command: cli.updateCommand })}</p>}
        </div>
      )}
      {failed && action === 'update' && (
        <>
          <p className="pkc-error">{failure === undefined ? t('cliUpdateFailed') : `${t('cliUpdateFailed')} · ${failure}`}</p>
          {cli.install.detail !== undefined && cli.install.detail !== '' && <pre className="pkc-detail">{cli.install.detail}</pre>}
        </>
      )}
      {cli !== undefined && !usable && (
        <div className="pkc-callout">
          <div className="pkc-status">
            <span className="pkc-dot" data-tone={cli.installed ? 'danger' : 'warn'} />
            <b>{cli.installed ? t('cliBroken') : t('cliMissing')}</b>
          </div>
          {cli.installed && (
            <>
              <span className="pkc-meta">{t('cliPath')} <span className="pkc-mono">{cli.path}</span></span>
              {cli.error !== undefined && <pre className="pkc-detail">{cli.error}</pre>}
            </>
          )}
          {cli.configuredPath !== undefined && <p className="pkc-note">{fill(t('cliConfiguredMissing'), { path: cli.configuredPath })}</p>}
          <p className="pkc-note">{t('cliMissingHint')}</p>
          <div className="pkc-split">
            <Button variant="primary" size="md" disabled={running || checking} onClick={install}>
              {running && action === 'install' ? t('cliInstalling') : cli.installed ? t('cliReinstall') : t('cliInstall')}
            </Button>
          </div>
          <p className="pkc-note">
            {fill(t('cliInstallCommand'), { command: cli.command ?? '' })}
            {cli.platform === 'win32' && ` ${t('cliWindowsNote')}`}
          </p>
        </div>
      )}
      {failed && action === 'install' && !usable && (
        <>
          <p className="pkc-error">{failure === undefined ? t('cliInstallFailed') : `${t('cliInstallFailed')} · ${failure}`}</p>
          {cli.install.detail !== undefined && cli.install.detail !== '' && <pre className="pkc-detail">{cli.install.detail}</pre>}
        </>
      )}
      {error !== undefined && <p className="pkc-error" role="alert">{`${t('error')}: ${error}`}</p>}
    </Card>
  )
}

// ── plugin version ──────────────────────────────────────────────────────────

/** A release-age wait can end tomorrow, so the date is part of the time. */
function readDateTime(ms) {
  try { return new Date(ms).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
  catch { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') }
}

/** Copy for an update pnpm could not fetch: the source still syncing, or unreachable; with and without its host. */
const UPDATE_BLOCKED = {
  syncing: ['versionUpdateSyncing', 'versionUpdateSyncingFrom'],
  unreachable: ['versionUpdateUnreachable', 'versionUpdateUnreachableFrom'],
}

function VersionCard({ call, t }) {
  const [info, setInfo] = react.useState()
  const [loading, setLoading] = react.useState(true)
  const [error, setError] = react.useState(false)
  const [updating, setUpdating] = react.useState(false)
  const [updateFailed, setUpdateFailed] = react.useState(false)
  /** A version pnpm still holds back under the profile's release-age policy. */
  const [pending, setPending] = react.useState()
  /** A version pnpm could not fetch: its install source still syncing, or unreachable. */
  const [blocked, setBlocked] = react.useState()
  const [updated, setUpdated] = react.useState()
  const [restartHint, setRestartHint] = react.useState(false)
  const generation = react.useRef(0)

  const load = force => {
    const current = ++generation.current
    setLoading(true)
    setError(false)
    call('plugin/version', { force }).then(value => {
      if (generation.current === current) setInfo(value)
    }).catch(() => {
      if (generation.current === current) setError(true)
    }).finally(() => {
      if (generation.current === current) setLoading(false)
    })
  }

  react.useEffect(() => {
    load(false)
    return () => { generation.current += 1 }
  }, [])

  const update = () => {
    setUpdating(true)
    setUpdateFailed(false)
    setPending(undefined)
    setBlocked(undefined)
    call('plugin/update').then(value => {
      if (value?.pending === true) {
        setPending(value)
        return
      }
      if (UPDATE_BLOCKED[value?.failed] !== undefined) {
        setBlocked(value)
        return
      }
      setUpdated(value)
      setRestartHint(false)
    }).catch(() => setUpdateFailed(true)).finally(() => setUpdating(false))
  }

  const installKind = info?.install?.kind
  const showStatus = info !== undefined && updated === undefined
  const canUpdate = showStatus && info.updateAvailable && installKind === 'npm'
  return (
    <Card
      title={t('versionTitle')}
      aside={updated === undefined && (
        <span className="pkc-actions">
          {canUpdate && <Button variant="primary" disabled={updating} onClick={update}>{updating ? t('versionUpdating') : t('versionUpdate')}</Button>}
          <Button disabled={loading || updating} onClick={() => load(true)}>{loading ? t('versionChecking') : t('versionCheck')}</Button>
        </span>
      )}
    >
      {loading && info === undefined && <p className="pkc-note" role="status">{t('versionChecking')}</p>}
      {error && <p className="pkc-error" role="alert">{t('versionFailed')}</p>}
      {showStatus && (
        <div className="pkc-status" role="status">
          <span className="pkc-dot" data-tone={info.updateAvailable ? 'warn' : 'success'} />
          <b>{`v${info.current}`}</b>
          <span className="pkc-meta">
            {info.updateAvailable ? fill(t('versionAvailable'), { version: info.latest }) : t('versionUpToDate')}
            {info.updateAvailable && ` · ${t('versionLatest')} v${info.latest}`}
          </span>
        </div>
      )}
      {showStatus && installKind === 'link' && <p className="pkc-note">{t('versionLinked')}</p>}
      {showStatus && info.updateAvailable && installKind === 'unknown' && <p className="pkc-note">{t('versionManual')}</p>}
      {updateFailed && <p className="pkc-error" role="alert">{t('versionUpdateFailed')}</p>}
      {blocked !== undefined && (
        // Still syncing is a wait, like the release cooldown; an unreachable source is a failure.
        <p className={blocked.failed === 'syncing' ? 'pkc-note' : 'pkc-error'} role={blocked.failed === 'syncing' ? 'status' : 'alert'}>
          {fill(t(UPDATE_BLOCKED[blocked.failed][typeof blocked.registry === 'string' ? 1 : 0]), { version: blocked.version, registry: blocked.registry })}
        </p>
      )}
      {pending !== undefined && <p className="pkc-note" role="status">{typeof pending.availableAt === 'number'
        ? fill(t('versionCoolingUntil'), { version: pending.version, time: readDateTime(pending.availableAt) })
        : fill(t('versionCooling'), { version: pending.version })}</p>}
      {updated !== undefined && (
        <div className="pkc-callout" data-tone="info" role="status">
          <b className="pkc-title">{fill(t('versionUpdated'), { version: updated.version })}</b>
          <p className="pkc-note">{t('versionUpdatedHint')}</p>
          {restartHint && <p className="pkc-note">{t('versionRestartHint')}</p>}
          <div className="pkc-actions">
            <Button variant="primary" onClick={() => window.location.reload()}>{t('versionRefresh')}</Button>
            <Button onClick={() => setRestartHint(true)}>{t('versionRestart')}</Button>
            <Button variant="ghost" onClick={() => setUpdated(undefined)}>{t('versionLater')}</Button>
          </div>
        </div>
      )}
    </Card>
  )
}

// ── the page and the composer chip ──────────────────────────────────────────

function PackyCodeSection({ rpc, t }) {
  const call = useCaller(rpc)
  return (
    <div className="pkc">
      <p className="pkc-intro">{t('intro')}</p>
      <AccountsCard call={call} t={t} />
      <PackyCodeImagesCard call={call} t={t} />
      <ClaudeCliCard call={call} t={t} />
      <ModelsCard call={call} t={t} />
      <SearchCard call={call} t={t} />
      <AutoReviewCard call={call} t={t} />
      <VersionCard call={call} t={t} />
      <DiagnosticsCard call={call} t={t} />
    </div>
  )
}

function PackyCodeComposerQuota({ rpc, t, directory }) {
  const call = useCaller(rpc)
  const snapshot = react.useSyncExternalStore(
    listener => directory.subscribe(listener),
    () => directory.getSnapshot(),
  )
  const enabled = snapshot?.current?.provider === PROVIDER
  const [balance, setBalance] = react.useState()
  const refresh = react.useRef(() => {})

  react.useEffect(() => {
    if (!enabled) {
      setBalance(undefined)
      return undefined
    }
    let live = true
    let pending = false
    // Hovering the figure asks for the host's cached balance as well; one read at a time.
    const tick = () => {
      if (pending) return
      pending = true
      call('balance').then(value => {
        if (live) setBalance(value)
      }).catch(() => {
        if (live) setBalance(undefined)
      }).finally(() => {
        pending = false
      })
    }
    refresh.current = tick
    tick()
    const timer = window.setInterval(tick, REFRESH_MS)
    return () => {
      live = false
      refresh.current = () => {}
      window.clearInterval(timer)
    }
  }, [call, enabled])

  if (!enabled || balance === undefined) return null
  const row = activeUsage(balance)
  // A key whose balance read failed is still usable; say the read failed
  // instead of claiming there is no key.
  return (
    <QuotaHover
      row={row}
      fetchedAt={balance.fetchedAt}
      empty={row?.error === undefined ? t('composerNoKey') : t('composerUnread')}
      copy={{ title: t('composerLabel'), key: t('composerKey'), failed: t('composerUnread') }}
      align="end"
      onRefresh={() => refresh.current()}
      t={t}
    />
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
  const call = channelCaller(connection.rpc)
  installImagePresentation(ctx, t, call)
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
  ctx.inject(['sessions', 'conversation'], scope => {
    const sessions = scope.get('sessions')
    const conversation = scope.get('conversation')
    if (typeof sessions?.scope !== 'function' || typeof conversation?.input?.for !== 'function') return
    scope.slots.inject('conversation.input.left', () => scope.slots.register({
      name: 'conversation.input.left', id: 'packycode-image-create', order: 31,
      inject: sessionId => ({
        call, t, directory: ctx.modelDirectories.directoryFor(sessionId).store,
        prepare: text => {
          const session = sessions.scope(sessionId)
          if (session === undefined) throw new Error('Composer unavailable')
          const input = conversation.input.for(session)
          const draft = input.state.getSnapshot()
          if (draft.phase !== 'plain' || draft.occurrences?.length) throw new Error('Composer busy')
          input.setDraft([draft.draft, text].filter(Boolean).join('\n\n'))
        },
      }),
    }, PackyCodeImageShortcut))
  })
}
