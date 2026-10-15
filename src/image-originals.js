/** Session-authorized access to PNGs preserved before DSH normalizes previews. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { imageConversationNode } from './image-conversation.js'
import { MAX_IMAGE_BYTES, pngDimensions } from './images.js'

export const ORIGINAL_CHUNK_BYTES = 256 * 1024
const ATTACHMENT_ID = /^sha256:[0-9a-f]{64}$/u
const FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/u
const unavailable = () => new Error('PackyCode original image is unavailable in this session')

/** Read paths only from successful, host-recorded image events, never RPC input. */
function originalFiles(events, attachmentId, directory) {
  const files = []
  for (const event of events) {
    if (imageConversationNode.match(event) === null) continue
    const content = event.type === 'tool/ptc-dispatch' ? event.data.content : event.data.message.content
    let candidate
    for (const part of content) {
      if (part.type === 'text' || part.type === 'thinking') {
        for (const match of String(part.text ?? '').matchAll(/(?:^|\n)(?:Original PNG on the DSH host: |原图：)([^\r\n]+)/gu)) {
          const path = match[1]
          candidate = dirname(path) === directory && FILE_NAME.test(basename(path)) ? basename(path) : undefined
        }
      }
      if (part.type === 'image') {
        if (part.attachment?.attachmentId === attachmentId && candidate !== undefined) files.push(candidate)
        candidate = undefined
      }
    }
  }
  return files
}

export function createImageOriginalReader({ imageDirectory, getSessionEvents }) {
  const directory = resolve(imageDirectory)
  async function withFile(payload, signal, read, chunk = false) {
    let file
    try {
      signal?.throwIfAborted()
      const allowed = chunk ? ['sessionId', 'attachmentId', 'assetId', 'offset'] : ['sessionId', 'attachmentId']
      if (!payload || typeof payload !== 'object' || Object.keys(payload).some(key => !allowed.includes(key))
        || typeof payload.sessionId !== 'string' || payload.sessionId.length === 0 || payload.sessionId.length > 200
        || !ATTACHMENT_ID.test(payload.attachmentId)
        || (chunk && (!FILE_NAME.test(payload.assetId) || !Number.isSafeInteger(payload.offset) || payload.offset < 0))) throw unavailable()
      const events = await getSessionEvents(payload.sessionId, signal)
      if (!Array.isArray(events)) throw unavailable()
      const candidates = originalFiles(events, payload.attachmentId, directory)
      const name = chunk ? candidates.find(value => value === payload.assetId) : candidates.at(-1)
      if (name === undefined) throw unavailable()
      const path = join(directory, name)
      if ((await lstat(path)).isSymbolicLink()) throw unavailable()
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const stat = await file.stat()
      if (!stat.isFile() || stat.size < 24 || stat.size > MAX_IMAGE_BYTES) throw unavailable()
      const header = Buffer.alloc(24)
      await file.read(header, 0, header.length, 0)
      const dimensions = pngDimensions(header)
      const result = await read(file, name, stat, dimensions)
      signal?.throwIfAborted()
      const after = await file.stat()
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw unavailable()
      return result
    } catch {
      throw unavailable()
    } finally { await file?.close().catch(() => undefined) }
  }
  return {
    info(payload, signal) {
      return withFile(payload, signal, async (file, assetId, stat, dimensions) => {
        const hash = createHash('sha256')
        const buffer = Buffer.alloc(Math.min(ORIGINAL_CHUNK_BYTES, stat.size))
        let offset = 0
        while (offset < stat.size) {
          signal?.throwIfAborted()
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset)
          if (bytesRead === 0) throw unavailable()
          hash.update(buffer.subarray(0, bytesRead))
          offset += bytesRead
        }
        return { assetId, attachmentId: payload.attachmentId, name: `packycode-${assetId}`, mediaType: 'image/png', bytes: stat.size, ...dimensions, sha256: hash.digest('hex') }
      })
    },
    chunk(payload, signal) {
      return withFile(payload, signal, async (file, assetId, stat) => {
        if (payload.offset >= stat.size) throw unavailable()
        const buffer = Buffer.alloc(Math.min(ORIGINAL_CHUNK_BYTES, stat.size - payload.offset))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, payload.offset)
        if (bytesRead === 0) throw unavailable()
        return { assetId, attachmentId: payload.attachmentId, offset: payload.offset, totalBytes: stat.size,
          encoded: buffer.subarray(0, bytesRead).toString('base64'), done: payload.offset + bytesRead === stat.size }
      }, true)
    },
  }
}
