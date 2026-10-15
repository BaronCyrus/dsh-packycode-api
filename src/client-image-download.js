/** Original PNG transfer. The chat preview is never used as the download source. */
const MAX_BYTES = 48 * 1024 * 1024
const CHUNK_BYTES = 256 * 1024

export function imageDownloadName(attachment) {
  const value = typeof attachment?.name === 'string' ? attachment.name : 'packycode-generated.png'
  const name = value.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '-').replace(/[. ]+$/u, '').trim().slice(0, 160)
  return name === '' ? 'packycode-generated.png' : name.replace(/\.(png|jpe?g|webp)$/iu, '') + '.png'
}

export async function readOriginalImage(call, sessionId, attachmentId, { signal, onProgress } = {}) {
  signal?.throwIfAborted()
  const ref = await call('images/original', { sessionId, attachmentId }, signal)
  if (ref?.attachmentId !== attachmentId || ref?.mediaType !== 'image/png' || !Number.isSafeInteger(ref.bytes)
    || ref.bytes < 24 || ref.bytes > MAX_BYTES || !/^[0-9a-f]{64}$/u.test(ref.sha256) || typeof ref.assetId !== 'string') throw new Error('Original image metadata is invalid')
  signal?.throwIfAborted()
  const data = new Uint8Array(ref.bytes)
  let offset = 0
  while (offset < data.length) {
    signal?.throwIfAborted()
    const chunk = await call('images/original/chunk', { sessionId, attachmentId, assetId: ref.assetId, offset }, signal)
    signal?.throwIfAborted()
    if (chunk?.attachmentId !== attachmentId || chunk.assetId !== ref.assetId || chunk.offset !== offset || chunk.totalBytes !== ref.bytes
      || typeof chunk.encoded !== 'string' || chunk.encoded.length === 0 || chunk.encoded.length > Math.ceil(CHUNK_BYTES / 3) * 4
      || typeof chunk.done !== 'boolean') throw new Error('Original image chunk is invalid')
    const decoded = atob(chunk.encoded)
    if (decoded.length === 0 || decoded.length > CHUNK_BYTES || offset + decoded.length > data.length) throw new Error('Original image chunk is invalid')
    for (let index = 0; index < decoded.length; index += 1) data[offset + index] = decoded.charCodeAt(index)
    offset += decoded.length
    if (chunk.done !== (offset === data.length)) throw new Error('Original image transfer is incomplete')
    onProgress?.(Math.floor(offset / data.length * 100))
  }
  const digest = await crypto.subtle.digest('SHA-256', data)
  signal?.throwIfAborted()
  const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  if (actual !== ref.sha256) throw new Error('Original image integrity check failed')
  return data
}

export async function saveOriginalImage(read, attachment, { signal, onProgress } = {}) {
  const name = imageDownloadName(attachment)
  let destination
  // Invoke synchronously from the click to preserve Chromium's user activation.
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      destination = await window.showSaveFilePicker({ suggestedName: name, excludeAcceptAllOption: true,
        types: [{ description: 'PNG', accept: { 'image/png': ['.png'] } }] })
    } catch (error) {
      if (error?.name !== 'NotSupportedError') throw error
    }
  }
  signal?.throwIfAborted()
  const data = await read({ signal, onProgress })
  signal?.throwIfAborted()
  if (destination !== undefined) {
    const stream = await destination.createWritable()
    try {
      signal?.throwIfAborted()
      await stream.write(data)
      signal?.throwIfAborted()
      await stream.close()
    } catch (error) { await stream.abort().catch(() => undefined); throw error }
    return
  }
  // Electron's normal download routine opens its native Save dialog when no
  // save path is supplied. Do not open a blob popup (the desktop shell denies it).
  const url = URL.createObjectURL(new Blob([data], { type: 'image/png' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  try { anchor.click() } finally {
    anchor.remove()
    // Allow Chromium's download task to acquire the blob before releasing it.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}
