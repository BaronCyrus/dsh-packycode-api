/** Host-only Images API transport and DSH tool. No subscription/LLM key fallback. */
import { randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { IMAGE_MODEL_IDS, IMAGE_QUALITIES, validateImageOptions } from './image-models.js'
import { normalizeHost } from './hosts.js'
import { DEFAULT_API_HOST } from './constants.js'
import { ambientFetch, waitForSharedRequest } from './request.js'

export const IMAGE_TOOL_NAME = 'packycode_image_generate'
export const IMAGE_TIMEOUT_MS = 5 * 60_000
export const MAX_IMAGE_BYTES = 48 * 1024 * 1024
const MAX_REFERENCE_IMAGES = 16
const ENVELOPE_BYTES = 1024 * 1024
const EDIT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const SIGNATURE = '89504e470d0a1a0a'
const ATTACHMENT_ID = /^sha256:[0-9a-f]{64}$/u

export class ImageRequestError extends Error {}

const nonempty = value => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/** Some model calls fill unused object fields with a zero-valued reference. */
function emptyMaskReference(value) {
  return value !== null && typeof value === 'object'
    && (value.attachmentId === '' || value.attachmentId === `sha256:${'0'.repeat(64)}`)
    && value.bytes === 0 && value.width === 0 && value.height === 0
    && (value.name === undefined || value.name === '')
    && (value.originalDimensions === undefined || (value.originalDimensions.width === 0 && value.originalDimensions.height === 0))
}

/** A bounded reader applies to both successful payloads and error envelopes. */
async function readJson(response, maximum, signal) {
  const length = Number(response.headers.get('content-length'))
  if ((Number.isFinite(length) && length > maximum) || response.body === null) {
    await response.body?.cancel().catch(() => undefined)
    throw new ImageRequestError('PackyCode image response is unreadable or exceeds the size limit')
  }
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks = []
  let total = 0
  try {
    signal.throwIfAborted()
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      total += value.byteLength
      if (total > maximum) throw new ImageRequestError('PackyCode image response exceeds the size limit')
      chunks.push(Buffer.from(value))
    }
    try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) }
    catch { throw new ImageRequestError('PackyCode returned an unreadable image response') }
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export function pngDimensions(data) {
  const buffer = Buffer.from(data)
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== SIGNATURE
    || buffer.readUInt32BE(8) !== 13 || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new ImageRequestError('PackyCode returned an invalid PNG image')
  }
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width === 0 || height === 0 || Math.max(width, height) > 3840 || width * height > 8_294_400) {
    throw new ImageRequestError('PackyCode returned unsupported image dimensions')
  }
  return { width, height }
}

export function decodeImagePng(encoded, maximum = MAX_IMAGE_BYTES) {
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > Math.ceil(maximum / 3) * 4
    || encoded.length % 4 !== 0) throw new ImageRequestError('PackyCode returned invalid or oversized base64 image data')
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  for (let index = 0; index < encoded.length - padding; index += 1) {
    const code = encoded.charCodeAt(index)
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47)) {
      throw new ImageRequestError('PackyCode returned invalid base64 image data')
    }
  }
  const data = Buffer.from(encoded, 'base64')
  if (data.length > maximum || data.toString('base64') !== encoded) throw new ImageRequestError('PackyCode returned invalid base64 image data')
  pngDimensions(data)
  return data
}

function imageFailure(status, value) {
  // Never echo gateway bodies, statusText, URLs, or thrown fetch messages:
  // any of them can contain the Authorization value.
  const code = value?.error?.code
  if (code === 'moderation_blocked') return 'PackyCode image request was blocked by the image safety check; revise the prompt or references'
  if (status === 401 || status === 403) return 'PackyCode image key was rejected; check the separate image key and its model permissions'
  if (status === 429) return 'PackyCode image quota or rate limit is unavailable; check the separate image key'
  return `PackyCode image request failed (HTTP ${status}); check model, quality, and image key permissions`
}

/** One paid attempt only. Invalid references never turn an edit into a generation. */
export function createPackyCodeImageClient({ resolveKey, getHost, fetchImpl = ambientFetch, timeoutMs = IMAGE_TIMEOUT_MS }) {
  return {
    async request(args, { signal, images, mask } = {}) {
      const options = validateImageOptions(args)
      const prompt = nonempty(args?.prompt)
      if (prompt === undefined || prompt.length > 32_000) throw new ImageRequestError('PackyCode image prompt must contain 1-32000 characters')
      if (images !== undefined && (!Array.isArray(images) || images.length === 0 || images.length > MAX_REFERENCE_IMAGES)) {
        throw new ImageRequestError('PackyCode image edits require 1-16 reference images')
      }
      if (mask !== undefined && images === undefined) throw new ImageRequestError('PackyCode image mask requires a reference image')
      const timeout = AbortSignal.timeout(timeoutMs)
      const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      let selected
      try { selected = await waitForSharedRequest(Promise.resolve().then(resolveKey), requestSignal) }
      catch {
        if (signal?.aborted) throw new ImageRequestError('PackyCode image request was cancelled')
        if (timeout.aborted) throw new ImageRequestError('PackyCode image request timed out')
        throw new ImageRequestError('PackyCode image credentials could not be read')
      }
      if (typeof selected?.key !== 'string' || selected.key === '') {
        throw new ImageRequestError('PackyCode images need a separate image key; add one under Settings → PackyCode → Images')
      }
      const fields = { ...options, prompt, n: 1, output_format: 'png' }
      let body
      const headers = { authorization: `Bearer ${selected.key}`, accept: 'application/json' }
      if (images === undefined) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(fields)
      } else {
        body = new FormData()
        for (const [key, value] of Object.entries(fields)) body.append(key, String(value))
        for (const [index, image] of images.entries()) {
          if (!EDIT_MEDIA_TYPES.includes(image?.mediaType) || !(image.data instanceof Uint8Array)
            || image.data.byteLength === 0 || image.data.byteLength >= 50 * 1024 * 1024) {
            throw new ImageRequestError('PackyCode reference images must be PNG, JPEG or WebP smaller than 50 MB')
          }
          const extension = image.mediaType === 'image/jpeg' ? 'jpg' : image.mediaType.split('/')[1]
          body.append('image[]', new Blob([image.data], { type: image.mediaType }), `reference-${index + 1}.${extension}`)
        }
        if (mask !== undefined) {
          if (mask.mediaType !== 'image/png' || !(mask.data instanceof Uint8Array) || mask.data.byteLength >= 4 * 1024 * 1024) {
            throw new ImageRequestError('PackyCode image mask must be a PNG smaller than 4 MB')
          }
          const dimensions = pngDimensions(mask.data)
          if (dimensions.width !== images[0].width || dimensions.height !== images[0].height) {
            throw new ImageRequestError('PackyCode image mask must match the first reference image dimensions')
          }
          body.append('mask', new Blob([mask.data], { type: 'image/png' }), 'mask.png')
        }
      }
      try {
        requestSignal.throwIfAborted()
        const host = normalizeHost(getHost(), DEFAULT_API_HOST).replace(/\/v1$/u, '')
        const response = await fetchImpl(`${host}/v1/images/${images === undefined ? 'generations' : 'edits'}`, {
          method: 'POST', redirect: 'error', headers, body, signal: requestSignal,
        })
        if (!response.ok) {
          const value = await readJson(response, 64 * 1024, requestSignal).catch(() => undefined)
          requestSignal.throwIfAborted()
          throw new ImageRequestError(imageFailure(response.status, value))
        }
        const value = await readJson(response, Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + ENVELOPE_BYTES, requestSignal)
        const data = decodeImagePng(value?.data?.[0]?.b64_json)
        const dimensions = pngDimensions(data)
        return {
          data, ...dimensions, requestedModel: options.model, requestedQuality: options.quality, requestedSize: options.size,
          ...(IMAGE_MODEL_IDS.includes(value?.model) ? { reportedModel: value.model } : {}),
          ...(IMAGE_QUALITIES.includes(value?.quality) ? { quality: value.quality } : {}),
        }
      } catch (error) {
        if (signal?.aborted) throw new ImageRequestError('PackyCode image request was cancelled')
        if (timeout.aborted) throw new ImageRequestError('PackyCode image request timed out')
        if (error instanceof ImageRequestError) throw error
        throw new ImageRequestError('PackyCode image connection failed')
      }
    },
  }
}

const referenceSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true, description: 'Complete sha256:<64 lowercase hex> image reference from the current session or read_image. Never a path or filename.' },
    mediaType: { type: 'string', required: true }, bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true }, height: { type: 'integer', required: true }, name: { type: 'string' },
    originalDimensions: { type: 'object', additionalProperties: false, properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } } },
  },
}

/** Select only trusted references already present in this tool call's session. */
async function readReferences(values, attachments, messages, signal) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_REFERENCE_IMAGES) throw new ImageRequestError('PackyCode image edits require 1-16 reference images')
  const available = new Map()
  const visit = content => {
    for (const block of content ?? []) {
      if (block?.type === 'image' && ATTACHMENT_ID.test(block.attachment?.attachmentId)) available.set(block.attachment.attachmentId, block.attachment)
      if (block?.type === 'tool-result' && Array.isArray(block.content)) visit(block.content)
    }
  }
  for (const message of messages ?? []) if (Array.isArray(message?.content)) visit(message.content)
  const ids = values.map(value => value?.attachmentId)
  if (ids.some(id => typeof id !== 'string' || !ATTACHMENT_ID.test(id) || !available.has(id))) {
    throw new ImageRequestError('PackyCode image reference is missing from this session; use read_image and copy its complete attachment reference')
  }
  if (new Set(ids).size !== ids.length) throw new ImageRequestError('PackyCode image references must not contain duplicates')
  const images = []
  let total = 0
  for (const id of ids) {
    signal?.throwIfAborted()
    let stored
    try { stored = await attachments.readImage(available.get(id), signal) }
    catch { throw new ImageRequestError('PackyCode could not read the selected image attachment') }
    const { data, ref } = stored
    if (!(data instanceof Uint8Array) || !EDIT_MEDIA_TYPES.includes(ref?.mediaType)) throw new ImageRequestError('PackyCode image reference must be PNG, JPEG or WebP')
    total += data.byteLength
    if (total > attachments.imageLimits.maxMessageImageBytes) throw new ImageRequestError('PackyCode image references exceed the DSH image limit')
    images.push({ data, mediaType: ref.mediaType, width: ref.width, height: ref.height })
  }
  return images
}

function attachmentProjection(ref) {
  return Object.fromEntries(['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name', 'originalDimensions']
    .filter(key => ref[key] !== undefined).map(key => [key, ref[key]]))
}

export const renderImage = value => [
  { type: 'text', text: `PackyCode · ${value.requestedModel} · ${value.width} × ${value.height} · ${value.requestedQuality}\nOriginal PNG on the DSH host: ${value.localPath}` },
  { type: 'image', attachment: value.image },
]

export const imageResultSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    image: { ...referenceSchema, required: true }, localPath: { type: 'string', required: true },
    width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
    requestedModel: { type: 'string', required: true }, requestedQuality: { type: 'string', required: true }, requestedSize: { type: 'string', required: true },
    reportedModel: { type: 'string' }, quality: { type: 'string' },
  },
}

export function createPackyCodeImageTool({ client, attachments, getPreference, getSessionMessages, imageDirectory, onGenerated }) {
  return defineTool({
    name: IMAGE_TOOL_NAME,
    description: 'Generate or edit images through PackyCode using the separately configured image API key. Use only when the user requests image output. This is independent of the conversation model and Codex subscription. For a new image omit referenceImages; for edits include only the intended images from this session or read_image. Never replace an edit with text-only generation, silently change models or downgrade quality. DSH displays successful image results automatically in the main chat; briefly describe the result. Do not create Markdown image links from localPath, attachmentId, sha256 references or invented URLs: these are not browser image addresses. Rendering may take several minutes.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Complete image description or precise editing instructions.' },
      operation: { type: 'string', enum: ['generate', 'edit'], description: 'Use generate for a new image; edit requires 1-16 real referenceImages. If omitted, nonempty references select editing, while an omitted or empty array selects generation.' },
      model: { type: 'string', enum: ['settings', ...IMAGE_MODEL_IDS], description: 'Use settings (or omit) to follow the PackyCode image setting. Choose an explicit engine only when the user requests one.' },
      quality: { type: 'string', enum: ['settings', ...IMAGE_QUALITIES], description: 'Use settings (or omit) to follow the user image setting. auto is an explicit API quality, not a request to follow settings. xhigh and max require a 2.5 model; never downgrade automatically.' },
      size: { type: 'string', description: 'auto or widthxheight, e.g. 1024x1024; both edges multiples of 16, each <=3840, ratio <=3:1, pixels 655360..8294400.' },
      background: { type: 'string', enum: ['auto', 'opaque', 'transparent'] },
      referenceImages: { type: 'array', items: referenceSchema, description: '1-16 complete attachment references for editing. Omit or use [] for a new image. Paths and unrelated images are not accepted; never drop real references after an edit fails.' },
      maskImage: { ...referenceSchema, description: 'Omit for new images and edits without a mask. Never invent a reference. Optional PNG mask from this session, matching the first reference and under 4 MB; alpha=0 marks the area to edit.' },
    },
    output: {
      schema: imageResultSchema,
      render: (_args, value) => renderImage(value),
      presentationMeta: (_args, value) => ({
        kind: 'packycode-image', requestedModel: value.requestedModel,
        requestedQuality: value.requestedQuality, width: value.width, height: value.height,
      }),
    },
    timeoutMs: IMAGE_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const preference = getPreference()
      if (!preference.imageEnabled) throw new ImageRequestError('PackyCode images are disabled in settings')
      if (exec?.agent?.id === undefined) throw new ImageRequestError('PackyCode images require a session-owned tool call')
      const signal = exec.signal
      const hasReferences = Array.isArray(args.referenceImages) && args.referenceImages.length > 0
      if (args.operation === 'generate' && hasReferences) throw new ImageRequestError('PackyCode image generation cannot include reference images; use edit')
      const editing = args.operation === 'edit' || hasReferences
      const maskImage = emptyMaskReference(args.maskImage) ? undefined : args.maskImage
      if (maskImage !== undefined && !editing) throw new ImageRequestError('PackyCode image mask requires referenceImages')
      let messages
      try { messages = editing ? await getSessionMessages(exec.agent.id) : undefined }
      catch { throw new ImageRequestError('PackyCode could not read the current session image references') }
      const images = editing ? await readReferences(args.referenceImages, attachments, messages, signal) : undefined
      const masks = maskImage === undefined ? undefined : await readReferences([maskImage], attachments, messages, signal)
      if (!getPreference().imageEnabled) throw new ImageRequestError('PackyCode images are disabled in settings')
      const result = await client.request({ ...args,
        model: args.model === 'settings' ? preference.imageModel : args.model ?? preference.imageModel,
        quality: args.quality === 'settings' ? preference.imageQuality : args.quality ?? preference.imageQuality,
      }, { signal, images, mask: masks?.[0] })
      onGenerated?.()
      signal?.throwIfAborted()
      // DSH may resize its chat preview. Preserve the original bytes separately.
      await mkdir(imageDirectory, { recursive: true, mode: 0o700 })
      const localPath = join(imageDirectory, `${randomUUID()}.png`)
      let saved = false
      try {
        const file = await open(localPath, 'wx', 0o600)
        saved = true
        try { await file.writeFile(result.data) } finally { await file.close() }
        const ref = await attachments.saveImage({ data: result.data, mediaType: 'image/png', name: 'packycode-generated.png' })
        const { data: _data, ...metadata } = result
        const value = { ...metadata, image: attachmentProjection(ref), localPath }
        if (exec.parent !== undefined) exec.deferContext(createUserMessage({ content: renderImage(value), source: { kind: 'plugin', plugin: 'packycode-api' } }))
        return value
      } catch {
        if (saved) await rm(localPath, { force: true }).catch(() => undefined)
        throw new ImageRequestError('PackyCode could not save the generated image')
      }
    },
  })
}
