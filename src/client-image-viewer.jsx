import * as react from 'react'

import { saveOriginalImage } from './client-image-download.js'

/** One plugin-owned overlay; independent of optional host image viewers. */
export function createImageViewer() {
  let image
  let revision = 0
  const listeners = new Set()
  const publish = value => { image = value; for (const listener of [...listeners]) listener() }
  return {
    getSnapshot: () => image,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    open: request => publish({ ...request, revision: ++revision }),
    close: () => publish(undefined),
    dispose() { publish(undefined); listeners.clear() },
  }
}

function ImageDialog({ image, viewer, t }) {
  const dialog = react.useRef(null)
  const close = react.useRef(null)
  const download = react.useRef()
  const [busy, setBusy] = react.useState(false)
  const [progress, setProgress] = react.useState(0)
  const [error, setError] = react.useState(false)
  react.useEffect(() => {
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    close.current?.focus()
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); viewer.close() }
      if (event.key === 'Tab') {
        const buttons = [...(dialog.current?.querySelectorAll('button:not(:disabled),[tabindex="0"]') ?? [])]
        const first = buttons[0], last = buttons.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      download.current?.abort()
      document.body.style.overflow = overflow
      document.removeEventListener('keydown', onKey, true)
      if (image.opener?.isConnected !== false) image.opener?.focus?.()
    }
  }, [image, viewer])
  const save = async () => {
    if (download.current !== undefined) return
    const controller = new AbortController()
    download.current = controller
    setBusy(true); setError(false); setProgress(0)
    try {
      await saveOriginalImage(image.readOriginal, image.attachment, { signal: controller.signal,
        onProgress: value => { if (!controller.signal.aborted) setProgress(value) } })
    } catch (failure) {
      if (!controller.signal.aborted && failure?.name !== 'AbortError') setError(true)
    } finally {
      if (!controller.signal.aborted) { download.current = undefined; setBusy(false) }
    }
  }
  return <div className="pkc-image-backdrop" onClick={event => {
    if (event.target.closest('img, button, [role="alert"]') === null) viewer.close()
  }}>
    <div className="pkc-image-viewer" role="dialog" aria-modal="true" aria-label={t('imagesViewerTitle')} ref={dialog}>
      <div className="pkc-image-viewer-toolbar">
        <span className="pkc-image-viewer-name">{image.attachment.name ?? t('imagesTitle')}</span>
        <button type="button" className="pkc-image-viewer-button" disabled={busy} onClick={save}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></svg>
          {busy ? `${t('imagesDownloadPreparing')} ${progress}%` : t('imagesDownloadOriginal')}
        </button>
        <button ref={close} type="button" className="pkc-image-viewer-button pkc-image-viewer-close" title={t('imagesClosePreview')} aria-label={t('imagesClosePreview')} onClick={() => viewer.close()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <div className="pkc-image-viewer-canvas"><img src={image.src} alt={image.attachment.name ?? t('imagesTitle')} /></div>
      {error && <p className="pkc-image-viewer-error" role="alert">{t('imagesDownloadFailed')}</p>}
    </div>
  </div>
}

export function PackyCodeImageViewer({ viewer, t }) {
  const image = react.useSyncExternalStore(viewer.subscribe, viewer.getSnapshot)
  return image === undefined ? null : <ImageDialog key={image.revision} image={image} viewer={viewer} t={t} />
}
