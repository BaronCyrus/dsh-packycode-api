import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createImageOriginalReader, ORIGINAL_CHUNK_BYTES } from '../src/image-originals.js'
import { MAX_IMAGE_BYTES } from '../src/images.js'
import { createPackyCodeRpc } from '../src/rpc.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jpj8AAAAASUVORK5CYII=', 'base64')
const attachmentId = `sha256:${'a'.repeat(64)}`
const assetId = 'a1b2c3d4-1234-4567-89ab-123456789abc.png'
const image = { type: 'image', attachment: { attachmentId, mediaType: 'image/png', bytes: 100, width: 1, height: 1 } }
const request = { sessionId: 'image-session', attachmentId }

async function fixture(t, protocol = 'native') {
  const directory = await mkdtemp(join(tmpdir(), 'packy-originals-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const localPath = join(directory, assetId)
  const original = Buffer.concat([PNG, Buffer.alloc(ORIGINAL_CHUNK_BYTES + 100, 7)])
  await writeFile(localPath, original)
  const content = [{ type: 'text', text: `PackyCode\nOriginal PNG on the DSH host: ${localPath}` }, image]
  const event = protocol === 'native' ? { type: 'tool/result', data: { meta: { kind: 'packycode-image' },
    message: { source: { kind: 'tool', callId: 'generated' }, content } } }
    : protocol === 'ptc' ? { type: 'tool/ptc-dispatch', data: { name: 'packycode_image_generate', subCallId: 'nested', isError: false, content } }
      : { type: 'assistant/message', seq: 3, data: { message: { source: { kind: 'model', provider: 'packycode', model: 'claude-opus-5-5' },
        content: [{ type: 'thinking', text: `▸ 图片已保存：gpt-image-2\n原图：${localPath}\n` }, image] } } }
  const events = [event]
  const reader = createImageOriginalReader({ imageDirectory: directory, getSessionEvents: async id => id === request.sessionId ? events : [] })
  return { reader, rpc: createPackyCodeRpc({ imageOriginals: reader }), events, event, original, localPath, directory }
}

for (const protocol of ['native', 'ptc', 'cli']) test(`${protocol} original download reads the exact preserved PNG through bounded session-authorized RPC chunks`, async t => {
  const fx = await fixture(t, protocol)
  const info = await fx.rpc('images/original', request)
  assert.equal(info.ok, true)
  const ref = info.value
  assert.equal(ref.bytes, fx.original.length, 'download is larger than the normalized chat preview')
  assert.equal(ref.assetId, assetId)
  assert.equal(ref.sha256, createHash('sha256').update(fx.original).digest('hex'))
  assert.equal(JSON.stringify(info).includes(fx.directory), false, 'original RPC does not accept or disclose host paths')
  const chunks = []
  let offset = 0
  while (offset < ref.bytes) {
    const response = await fx.rpc('images/original/chunk', { ...request, assetId, offset })
    assert.equal(response.ok, true)
    const chunk = response.value
    assert.equal(chunk.offset, offset)
    const data = Buffer.from(chunk.encoded, 'base64')
    assert.ok(data.length <= ORIGINAL_CHUNK_BYTES)
    chunks.push(data); offset += data.length
    assert.equal(chunk.done, offset === ref.bytes)
  }
  assert.equal(chunks.length, 2)
  assert.deepEqual(Buffer.concat(chunks), fx.original)
})

test('original RPC rejects other sessions, fabricated references, arbitrary paths and non-image event sources', async t => {
  const fx = await fixture(t)
  for (const payload of [{ ...request, sessionId: 'other-session' }, { ...request, attachmentId: `sha256:${'b'.repeat(64)}` },
    { ...request, path: fx.localPath }, { ...request, assetId }, { ...request, sessionId: '' }]) {
    assert.equal((await fx.rpc('images/original', payload)).ok, false)
  }
  const original = fx.event
  for (const replacement of [
    { type: 'user/message', data: original.data },
    { ...original, data: { ...original.data, meta: { kind: 'another-plugin' } } },
    { ...original, data: { ...original.data, message: { ...original.data.message, isError: true } } },
  ]) {
    fx.events[0] = replacement
    assert.equal((await fx.rpc('images/original', request)).ok, false)
  }
})

test('original reads reject traversal, symlinks, missing files and oversized files without disclosing storage errors', async t => {
  const fx = await fixture(t)
  const text = fx.event.data.message.content[0]
  text.text = 'Original PNG on the DSH host: /tmp/another-user-file.png'
  assert.equal((await fx.rpc('images/original', request)).ok, false)
  text.text = `Original PNG on the DSH host: ${fx.localPath}`
  await rm(fx.localPath)
  await symlink(join(fx.directory, 'missing-target'), fx.localPath)
  const symlinkFailure = await fx.rpc('images/original', request)
  assert.equal(symlinkFailure.ok, false)
  assert.equal(JSON.stringify(symlinkFailure).includes(fx.directory), false)
  await rm(fx.localPath)
  assert.equal((await fx.rpc('images/original', request)).ok, false)
  await writeFile(fx.localPath, Buffer.alloc(100, 65))
  assert.equal((await fx.rpc('images/original', request)).ok, false)
  assert.equal((await fx.rpc('images/original/chunk', { ...request, assetId, offset: 0 })).ok, false)
  await writeFile(fx.localPath, PNG)
  await truncate(fx.localPath, MAX_IMAGE_BYTES + 1)
  assert.equal((await fx.rpc('images/original', request)).ok, false)
})

test('original chunks refuse invalid ranges, unrelated assets and cancelled requests', async t => {
  const fx = await fixture(t)
  for (const offset of [-1, 0.5, NaN, Infinity, fx.original.length, Number.MAX_SAFE_INTEGER]) {
    assert.equal((await fx.rpc('images/original/chunk', { ...request, assetId, offset })).ok, false)
  }
  assert.equal((await fx.rpc('images/original/chunk', { ...request, assetId: '../file.png', offset: 0 })).ok, false)
  assert.equal((await fx.rpc('images/original/chunk', { ...request, assetId: assetId.replace('a1b2c3d4', '11111111'), offset: 0 })).ok, false)
  const signal = AbortSignal.abort()
  assert.equal((await fx.rpc('images/original', request, signal)).ok, false)
  assert.equal((await fx.rpc('images/original/chunk', { ...request, assetId, offset: 0 }, signal)).ok, false)
})
