import * as react from 'react'

import { IMAGE_CHAT_KIND, imageConversationNode } from './image-conversation.js'
import { BalanceTotals, KeyBalance } from './client-balance.jsx'
import { ImageShortcutBalance } from './client-image-balance.jsx'

const imageModelLabel = id => id.replace('gpt-image-', 'GPT Image ').replace('-flare', ' Flare').replace('-sunburst', ' Sunburst')

/** Only projections come back from the host; the password draft is cleared on success. */
export function PackyCodeImagesCard({ call, t }) {
  const [state, setState] = react.useState()
  const [draft, setDraft] = react.useState({ key: '', label: '' })
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState()
  const [balance, setBalance] = react.useState()
  const [balanceError, setBalanceError] = react.useState()
  const [balanceLoading, setBalanceLoading] = react.useState(true)
  const balanceGeneration = react.useRef(0)
  const mounted = react.useRef(false)
  const readBalance = async (force = false) => {
    if (!mounted.current) return
    const generation = ++balanceGeneration.current
    setBalanceLoading(true)
    setBalanceError(undefined)
    try {
      const value = await call('images/balance', { force })
      if (mounted.current && balanceGeneration.current === generation) setBalance(value)
    } catch (failure) {
      if (mounted.current && balanceGeneration.current === generation) setBalanceError(String(failure?.message ?? t('imagesBalanceFailed')).slice(0, 200))
    } finally {
      if (mounted.current && balanceGeneration.current === generation) setBalanceLoading(false)
    }
  }
  react.useEffect(() => {
    mounted.current = true
    call('images/status').then(value => { if (mounted.current) setState(value) })
      .catch(() => { if (mounted.current) setError(t('imagesLoadFailed')) })
    void readBalance()
    const timer = window.setInterval(() => { void readBalance() }, 60_000)
    return () => { mounted.current = false; balanceGeneration.current += 1; window.clearInterval(timer) }
  }, [call, t])
  const mutate = async (endpoint, payload = {}) => {
    setBusy(true)
    setError(undefined)
    try {
      const value = await call(endpoint, payload)
      if (mounted.current) setState(value)
      if (mounted.current && endpoint.startsWith('images/keys/')) {
        setBalance(undefined)
        void readBalance(true)
      }
      window.dispatchEvent(new Event('packycode-images-updated'))
      return true
    } catch (failure) {
      if (mounted.current) setError(String(failure?.message ?? t('imagesLoadFailed')).slice(0, 200))
      return false
    } finally { if (mounted.current) setBusy(false) }
  }
  const disabled = busy || state?.writable !== true
  const models = state?.models ?? []
  const qualities = models.find(model => model.id === state?.imageModel)?.qualities ?? []
  const rows = (state?.keys ?? []).map(entry => balance?.keys?.find(row => row.id === entry.id) ?? { id: entry.id })
  return <section className="pkc-card">
    <header className="pkc-head"><h3 className="pkc-title">{t('imagesTitle')}</h3><span className="pkc-actions">
      <button className="pkc-btn" type="button" disabled={busy || balanceLoading} onClick={() => { void readBalance(true) }}>{balanceLoading ? t('refreshing') : t('refresh')}</button>
    </span></header>
    <p className="pkc-note">{t('imagesIntro')}</p>
    {state !== undefined && <>
      <label className="pkc-setting"><span className="pkc-label">{t('imagesEnabled')}</span>
        <select className="pkc-input pkc-image-choice" value={String(state.imageEnabled)} disabled={disabled}
          onChange={event => { void mutate('images/update', { imageEnabled: event.target.value === 'true' }) }}>
          <option value="true">{t('imagesOn')}</option><option value="false">{t('imagesOff')}</option>
        </select>
      </label>
      <label className="pkc-setting"><span className="pkc-label">{t('imagesModel')}</span>
        <select className="pkc-input pkc-image-choice" value={state.imageModel} disabled={disabled || !state.imageEnabled}
          onChange={event => { void mutate('images/update', { imageModel: event.target.value, imageQuality: 'auto' }) }}>
          {models.map(model => <option key={model.id} value={model.id}>{imageModelLabel(model.id)}</option>)}
        </select>
      </label>
      <label className="pkc-setting"><span className="pkc-label">{t('imagesQuality')}</span>
        <select className="pkc-input pkc-image-choice" value={state.imageQuality} disabled={disabled || !state.imageEnabled}
          onChange={event => { void mutate('images/update', { imageQuality: event.target.value }) }}>
          {qualities.map(quality => <option key={quality} value={quality}>{t(`imagesQuality_${quality}`)}</option>)}
        </select>
      </label>
      <p className="pkc-note">{t('imagesQualityHint')}</p>
      {(state.keys ?? []).length > 0 && <>
        <BalanceTotals rows={rows} t={t} />
        <p className="pkc-note">{balanceLoading ? t('imagesBalanceLoading') : t('imagesBalanceHint')}</p>
      </>}
      <div className="pkc-list">
        {(state.keys ?? []).map(entry => <div className="pkc-row" key={entry.id}>
          <div className="pkc-row-top"><span className="pkc-row-name"><span className="pkc-name">{entry.label}</span>
            {entry.active && <span className="pkc-chip" data-tone="success">{t('keyActive')}</span>}
          </span><span className="pkc-actions">
            {!entry.active && <button className="pkc-btn" type="button" disabled={busy} onClick={() => { void mutate('images/keys/select', { id: entry.id }) }}>{t('keyUse')}</button>}
            <button className="pkc-btn" data-variant="danger" type="button" disabled={busy} onClick={() => { void mutate('images/keys/remove', { id: entry.id }) }}>{t('keyRemove')}</button>
          </span></div>
          <KeyBalance row={rows.find(row => row.id === entry.id)} t={t} />
        </div>)}
      </div>
      {(state.keys ?? []).length === 0 && <p className="pkc-note">{t('imagesNoKey')}</p>}
      <form className="pkc-add" onSubmit={event => {
        event.preventDefault()
        if (busy || draft.key.trim() === '') return
        void mutate('images/keys/add', draft).then(saved => { if (saved && mounted.current) setDraft({ key: '', label: '' }) })
      }}>
        <span className="pkc-label">{t('imagesAddKey')}</span><div className="pkc-form">
          <input className="pkc-input" type="password" autoComplete="off" aria-label={t('imagesAddKey')} placeholder={t('imagesKeyPlaceholder')}
            value={draft.key} disabled={busy} onChange={event => setDraft(current => ({ ...current, key: event.target.value }))} />
          <input className="pkc-input" type="text" maxLength={60} aria-label={t('addLabelPlaceholder')} placeholder={t('addLabelPlaceholder')}
            value={draft.label} disabled={busy} onChange={event => setDraft(current => ({ ...current, label: event.target.value }))} />
          <button className="pkc-btn" data-variant="primary" data-size="md" type="submit" disabled={busy || draft.key.trim() === ''}>{t('add')}</button>
        </div>
      </form>
      {!state.available && <p className="pkc-note">{t('imagesUnavailable')}</p>}
      {!state.writable && <p className="pkc-note">{t('searchNotWritable')}</p>}
    </>}
    {error !== undefined && <p className="pkc-error" role="alert">{error}</p>}
    {balanceError !== undefined && <p className="pkc-error" role="alert">{`${t('imagesBalanceFailed')}: ${balanceError}`}</p>}
  </section>
}

/** A draft shortcut names this provider explicitly when other image tools exist. */
export function PackyCodeImageShortcut({ call, t, directory, prepare }) {
  const snapshot = react.useSyncExternalStore(listener => directory.subscribe(listener), () => directory.getSnapshot())
  const active = snapshot?.current?.provider === 'packycode'
  const [ready, setReady] = react.useState(false)
  const [error, setError] = react.useState()
  react.useEffect(() => {
    let live = true
    let generation = 0
    const refresh = () => {
      if (!active) return
      const current = ++generation
      void call('images/status').then(value => {
        if (live && current === generation) setReady(value.imageEnabled && value.available && value.keys.some(key => !key.disabled))
      }).catch(() => { if (live && current === generation) setReady(false) })
    }
    setReady(false)
    refresh()
    window.addEventListener('packycode-images-updated', refresh)
    return () => { live = false; window.removeEventListener('packycode-images-updated', refresh) }
  }, [call, active])
  if (!active || !ready) return null
  return <span className="pkc-image-shortcut"><button className="pkc-btn" type="button" title={t('imagesShortcutHint')} onClick={() => {
    try { prepare(t('imagesDraft')); setError(undefined) } catch { setError(t('imagesDraftBusy')) }
  }}>{t('imagesCreate')}</button><ImageShortcutBalance call={call} t={t} />{error && <span className="pkc-error" role="alert">{error}</span>}</span>
}

function GeneratedImage({ attachment, loadImage, openImage, t }) {
  const [url, setUrl] = react.useState()
  const [failed, setFailed] = react.useState(false)
  const [attempt, setAttempt] = react.useState(0)
  react.useEffect(() => {
    let live = true
    setUrl(undefined)
    setFailed(false)
    Promise.resolve().then(() => loadImage(attachment)).then(value => { if (live) setUrl(value) }, () => { if (live) setFailed(true) })
    return () => { live = false }
  }, [attachment, loadImage, attempt])
  return <button className="pkc-generated-image" type="button" title={t('imagesOpen')} aria-label={t('imagesOpen')}
    disabled={!url && !failed} onClick={event => {
      if (failed) { setAttempt(value => value + 1); return }
      openImage(url, attachment, event.currentTarget)
    }}>
    {url ? <img src={url} alt={attachment.name ?? t('imagesTitle')} /> : <span>{failed ? t('imagesRetryPreview') : t('imagesLoadingPreview')}</span>}
  </button>
}

export function PackyCodeImageResult({ block, t, loadImage, openImage }) {
  const settled = block?.kind === 'tool-result'
  const failed = settled && block.isError === true
  const images = settled ? (block.content ?? []).filter(part => part.type === 'image' && part.attachment) : []
  const error = failed ? block.content?.find(part => part.type === 'text')?.text : undefined
  return <div className="pkc-image-result">
    <div className="pkc-status"><b>{t('imagesTitle')}</b><span className="pkc-meta">PackyCode · {t(!settled ? 'imagesGenerating' : failed ? 'imagesFailed' : 'imagesDone')}</span></div>
    {images.map(part => <GeneratedImage key={part.attachment.attachmentId} attachment={part.attachment} t={t} loadImage={loadImage} openImage={openImage} />)}
    {typeof block?.meta?.requestedModel === 'string' && <p className="pkc-meta">{block.meta.requestedModel} · {String(block.meta.requestedQuality ?? 'auto')} · {block.meta.width} × {block.meta.height}</p>}
    {error && <p className="pkc-error" role="alert">{error}</p>}
  </div>
}

function ImageChatOutput({ node, ...props }) {
  return <div className="pkc-image-chat">{node.data.blocks.map(block => <PackyCodeImageResult key={block.toolCallId} block={block} {...props} />)}</div>
}

export function installImagePresentation(ctx, t) {
  ctx.inject(['uiConversation'], scope => {
    const conversation = scope.get('uiConversation')
    if (typeof conversation?.events?.register !== 'function' || typeof conversation?.imageUrl !== 'function') return
    const imageProps = sessionId => ({
      t,
      loadImage: attachment => conversation.imageUrl(sessionId, attachment),
      openImage: (src, attachment, opener) => {
        const viewer = scope.get('nativeImageViewer')
        if (viewer?.open?.({ items: [{ id: attachment.attachmentId, src, name: attachment.name ?? 'packycode-generated.png', width: attachment.width, height: attachment.height }], opener, source: 'packycode-generated' }) === true) return
        window.open(src, '_blank', 'noopener,noreferrer')
      },
    })
    scope.effect(() => conversation.events.register(imageConversationNode), 'packycode-api: image results in chat')
    scope.slots.inject('conversation.chat.node', () => scope.slots.register({ name: 'conversation.chat.node', key: IMAGE_CHAT_KIND, inject: imageProps }, ImageChatOutput))
    scope.slots.inject('tool.call.toolview', () => scope.slots.register({ name: 'tool.call.toolview', key: 'packycode_image_generate', inject: imageProps }, PackyCodeImageResult))
  })
}
