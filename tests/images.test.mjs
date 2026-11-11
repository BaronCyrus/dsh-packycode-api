import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { IMAGE_MODELS, isMiniMaxImageModel, validateImageOptions } from '../src/image-models.js'
import { createPackyCodeImageClient, createPackyCodeImageTool, decodeImagePng, IMAGE_TOOL_NAME } from '../src/images.js'
import { JPEG, WEBP } from './fixtures/images.mjs'

const KEY = 'sk-fixture-image-only-key'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jpj8AAAAASUVORK5CYII=', 'base64')
const REF = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1, name: 'reference.png' }
const imageResponse = (extra = {}) => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }], ...extra }), { headers: { 'content-type': 'application/json' } })
const args = { prompt: 'A blue teapot', model: 'gpt-image-2.6-sunburst', quality: 'max' }
const client = (options = {}) => createPackyCodeImageClient({ resolveKey: async () => ({ key: KEY }), getHost: () => 'https://gateway.invalid', ...options })
const MINIMAX = ['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed']

test('generation sends the exact model-specific quality and no legacy or reasoning fields', async () => {
  for (const [model, qualities] of Object.entries(IMAGE_MODELS).filter(([model]) => !isMiniMaxImageModel(model))) {
    for (const quality of qualities) {
      let request
      const value = await client({ fetchImpl: async (url, init) => { request = { url, ...init }; return imageResponse({ model, quality }) } }).request({ ...args, model, quality })
      assert.equal(request.url, 'https://gateway.invalid/v1/images/generations')
      assert.equal(request.redirect, 'error')
      assert.equal(request.headers.authorization, `Bearer ${KEY}`)
      assert.deepEqual(JSON.parse(request.body), { model, quality, size: 'auto', background: 'auto', prompt: args.prompt, n: 1, output_format: 'png' })
      assert.equal(value.requestedModel, model)
      assert.equal(value.quality, quality)
      assert.equal(JSON.stringify(value).includes(KEY), false)
    }
  }
})

test('MiniMax H3 Image is asked for a PNG as base64 at an explicit size, without quality or background', async () => {
  assert.deepEqual(Object.keys(IMAGE_MODELS).filter(isMiniMaxImageModel), MINIMAX)
  for (const model of MINIMAX) {
    assert.deepEqual([...IMAGE_MODELS[model]], ['auto'])
    const requests = []
    const api = client({ fetchImpl: async (url, init) => { requests.push({ url, ...init }); return imageResponse({ output_format: 'png' }) } })
    // MiniMax renders 4K when no tier is given, so `auto` carries the 2K area.
    const automatic = await api.request({ prompt: args.prompt, model })
    assert.equal(requests[0].url, 'https://gateway.invalid/v1/images/generations')
    assert.equal(requests[0].redirect, 'error')
    assert.equal(requests[0].headers.authorization, `Bearer ${KEY}`)
    assert.deepEqual(JSON.parse(requests[0].body), { model, prompt: args.prompt, n: 1, size: 'auto', area: '2K', output_format: 'png', response_format: 'b64_json' })
    assert.deepEqual([automatic.requestedModel, automatic.requestedQuality, automatic.requestedSize, automatic.quality], [model, 'auto', 'auto', undefined])
    // An explicit size goes without `area`, which MiniMax refuses beside it; nothing else is added.
    await api.request({ prompt: args.prompt, model, quality: 'auto', size: '2720x1536', background: 'opaque' })
    assert.deepEqual(JSON.parse(requests[1].body), { model, prompt: args.prompt, n: 1, size: '2720x1536', output_format: 'png', response_format: 'b64_json' })
    assert.equal(JSON.stringify(automatic).includes(KEY), false)
  }
})

test('MiniMax H3 Image refuses a quality, a transparent background and a mask before any request', async () => {
  let calls = 0
  const api = client({ fetchImpl: async () => { calls += 1; return imageResponse() } })
  for (const model of MINIMAX) {
    for (const quality of ['low', 'medium', 'high', 'xhigh', 'max']) await assert.rejects(() => api.request({ prompt: args.prompt, model, quality }), /quality is not supported by the selected model/u)
    await assert.rejects(() => api.request({ prompt: args.prompt, model, background: 'transparent' }), /transparent background is not supported by the selected model/u)
    await assert.rejects(() => api.request({ prompt: args.prompt, model }, { images: [{ data: PNG, ...REF }], mask: { data: PNG, mediaType: 'image/png' } }), /masks are not supported by the selected model/u)
    for (const size of ['1025x1024', '4096x4096', '4096x1024']) await assert.rejects(() => api.request({ prompt: args.prompt, model, size }), /supported widthxheight/u)
  }
  assert.equal(calls, 0)
})

test('MiniMax H3 Image edits upload the references as multipart without quality, background or mask', async t => {
  let captured
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    captured = { url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('latin1') }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64'), size: '2048x2048' }], output_format: 'png' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const host = `http://127.0.0.1:${server.address().port}/v1`
  await client({ getHost: () => host }).request({ prompt: args.prompt, model: 'MiniMax-H3-Image-Highspeed' }, { images: [{ data: PNG, ...REF }, { data: JPEG, mediaType: 'image/jpeg', width: 1, height: 1 }] })
  assert.equal(captured.url, '/v1/images/edits')
  assert.equal(captured.headers.authorization, `Bearer ${KEY}`)
  assert.match(captured.headers['content-type'], /^multipart\/form-data; boundary=/u)
  assert.match(captured.body, /name="model"\r\n\r\nMiniMax-H3-Image-Highspeed\r\n/u)
  assert.match(captured.body, /name="size"\r\n\r\nauto\r\n/u)
  assert.match(captured.body, /name="area"\r\n\r\n2K\r\n/u)
  assert.match(captured.body, /name="output_format"\r\n\r\npng\r\n/u)
  assert.match(captured.body, /name="response_format"\r\n\r\nb64_json\r\n/u)
  assert.match(captured.body, /name="image\[\]"; filename="reference-1.png"/u)
  assert.match(captured.body, /name="image\[\]"; filename="reference-2.jpg"/u)
  assert.doesNotMatch(captured.body, /name="(?:quality|background|mask|aspect_ratio)"/u)
})

test('a key whose group does not serve the image model is told so, without the gateway text', async () => {
  let calls = 0
  const refusal = () => new Response(JSON.stringify({ error: { code: 'model_not_found', message: `分组 image-sale 下模型 MiniMax-H3-Image 无可用渠道（distributor） ${KEY}`, type: 'packy_api_error' } }), { status: 503 })
  await assert.rejects(() => client({ fetchImpl: async () => { calls += 1; return refusal() } }).request({ prompt: args.prompt, model: 'MiniMax-H3-Image' }), error => {
    assert.match(error.message, /group that does not serve the selected image model/u)
    // The calling model once answered this refusal by switching engines on its own.
    assert.match(error.message, /Do not retry with another model/u)
    assert.equal(error.message.includes(KEY), false)
    assert.equal(error.message.includes('image-sale'), false)
    return true
  })
  assert.equal(calls, 1)
})

test('invalid model, quality, size, prompt and mask are rejected before any network request', async () => {
  let calls = 0
  const api = client({ fetchImpl: async () => { calls += 1; return imageResponse() } })
  for (const change of [
    { model: 'other-provider' }, { model: 'gpt-image-2', quality: 'max' }, { quality: 'ultra' },
    { size: '1025x1024' }, { size: '3840x3840' }, { size: '4096x1024' }, { size: '256x1024' },
    { prompt: '' }, { prompt: 'x'.repeat(32_001) }, { background: 'clear' },
  ]) await assert.rejects(() => api.request({ ...args, ...change }))
  await assert.rejects(() => api.request(args, { mask: {} }), /requires a reference/u)
  await assert.rejects(() => api.request(args, { images: [] }), /1-16/u)
  assert.equal(calls, 0)
  for (const size of ['auto', '1024x1024', '1536x1024', '3840x2160', '2160x3840']) assert.equal(validateImageOptions({ size }).size, size)
})

test('a missing image key fails without calling the gateway or using an ambient credential', async () => {
  let calls = 0
  await assert.rejects(() => client({ resolveKey: async () => undefined, fetchImpl: async () => { calls += 1 } }).request(args), /separate image key/u)
  assert.equal(calls, 0)
})

test('multipart edits reach a real HTTP server with images, quality, mask and an automatic boundary', async t => {
  let captured
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    captured = { url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const host = `http://127.0.0.1:${server.address().port}/v1`
  await client({ getHost: () => host }).request(args, { images: [{ data: PNG, ...REF }], mask: { data: PNG, mediaType: 'image/png' } })
  assert.equal(captured.url, '/v1/images/edits')
  assert.equal(captured.headers.authorization, `Bearer ${KEY}`)
  assert.match(captured.headers['content-type'], /^multipart\/form-data; boundary=/u)
  assert.match(captured.body, /name="image\[\]"; filename="reference-1.png"/u)
  assert.match(captured.body, /name="mask"; filename="mask.png"/u)
  assert.match(captured.body, /name="quality"\r\n\r\nmax/u)
  assert.doesNotMatch(captured.body, /response_format|input_fidelity|reasoning_effort/u)
})

test('invalid edit files and mismatched masks never fall back to a generation', async () => {
  let calls = 0
  const api = client({ fetchImpl: async () => { calls += 1; return imageResponse() } })
  await assert.rejects(() => api.request(args, { images: [{ data: PNG, mediaType: 'image/gif' }] }), /PNG, JPEG or WebP/u)
  await assert.rejects(() => api.request(args, { images: [{ data: PNG, ...REF, width: 2 }], mask: { data: PNG, mediaType: 'image/png' } }), /match the first/u)
  assert.equal(calls, 0)
})

test('upstream errors, metadata and thrown transport errors never echo a key or trigger a retry', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    let calls = 0
    await assert.rejects(() => client({ fetchImpl: async () => { calls += 1; return new Response(JSON.stringify({ error: { message: KEY } }), { status }) } }).request(args), error => {
      assert.equal(String(error).includes(KEY), false)
      assert.match(error.message, /PackyCode image/u)
      return true
    })
    assert.equal(calls, 1)
  }
  await assert.rejects(() => client({ fetchImpl: async () => { throw new Error(`PackyCode ${KEY}`) } }).request(args), error => {
    assert.equal(error.message, 'PackyCode image connection failed')
    assert.equal(error.cause, undefined)
    return true
  })
  const value = await client({ fetchImpl: async () => imageResponse({ model: KEY, quality: KEY, size: KEY }) }).request(args)
  assert.equal(JSON.stringify(value).includes(KEY), false)
  await assert.rejects(() => client({ fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'moderation_blocked', message: KEY } }), { status: 400 }) }).request(args), /revise the prompt/u)
})

test('redirects are refused without forwarding the Authorization header', async t => {
  let followed = false
  const destination = createServer((_request, response) => { followed = true; response.end('unexpected') })
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve))
  const server = createServer((_request, response) => { response.writeHead(307, { location: `http://127.0.0.1:${destination.address().port}` }); response.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => Promise.all([server, destination].map(item => new Promise(resolve => item.close(resolve)))))
  await assert.rejects(() => client({ getHost: () => `http://127.0.0.1:${server.address().port}` }).request(args), /connection failed/u)
  assert.equal(followed, false)
})

test('body reads have a size limit, cancellation and a deadline', async t => {
  await assert.rejects(() => client({ fetchImpl: async () => new Response('{}', { headers: { 'content-length': String(100 * 1024 * 1024) } }) }).request(args), /size limit/u)
  await assert.rejects(() => client({ fetchImpl: async () => new Response('not-json') }).request(args), /unreadable/u)
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 15)
  t.after(() => clearTimeout(deadline))
  const hanging = () => new Response(new ReadableStream({ start() {} }))
  await assert.rejects(() => client({ fetchImpl: hanging }).request(args, { signal: controller.signal }), /cancelled/u)
  const keepAlive = setTimeout(() => {}, 100)
  t.after(() => clearTimeout(keepAlive))
  await assert.rejects(() => client({ fetchImpl: hanging, timeoutMs: 10 }).request(args), /timed out/u)
})

test('PNG decoding rejects malformed, oversized and non-image data', () => {
  assert.deepEqual(decodeImagePng(PNG.toString('base64')), PNG)
  for (const encoded of ['', 'data:image/png;base64,AA==', '%%%%', 'AA==', `${PNG.toString('base64')}\n`]) assert.throws(() => decodeImagePng(encoded))
  assert.throws(() => decodeImagePng(PNG.toString('base64'), 10), /oversized/u)
  // Exercise a large body without a recursive regular expression.
  const large = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)])
  assert.equal(decodeImagePng(large.toString('base64')).length, large.length)
})

async function toolFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'packycode-images-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const calls = []
  const deferred = []
  let enabled = true
  const tool = createPackyCodeImageTool({
    client: client({ fetchImpl: async (url, init) => { calls.push({ url, init }); return imageResponse() } }),
    getPreference: () => ({ imageEnabled: enabled, imageModel: args.model, imageQuality: args.quality }),
    attachments: {
      imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
      readImage: async ref => ({ data: PNG, ref }),
      saveImage: async () => REF,
    },
    getSessionMessages: async () => [{ content: [{ type: 'image', attachment: REF }] }],
    imageDirectory: directory,
    ...options,
  })
  return { tool, calls, deferred, setEnabled: value => { enabled = value }, exec: { signal: new AbortController().signal, agent: { id: 'fixture-session' }, parent: 'parent', deferContext: message => deferred.push(message) } }
}

test('DSH tool saves the original PNG, renders an attachment, and defers child output to the parent', async t => {
  let balanceInvalidated = 0
  const { tool, exec, deferred, calls } = await toolFixture(t, { onGenerated: () => { balanceInvalidated += 1 } })
  assert.equal(tool.name, IMAGE_TOOL_NAME)
  const value = await tool.execute({ prompt: args.prompt }, exec)
  assert.equal(value.requestedModel, args.model)
  assert.equal(value.requestedQuality, args.quality)
  assert.deepEqual(await readFile(value.localPath), PNG)
  assert.equal((await stat(value.localPath)).mode & 0o777, 0o600)
  assert.deepEqual(tool.output.render({}, value).find(block => block.type === 'image').attachment, REF)
  assert.equal(deferred.length, 1)
  assert.equal(calls.length, 1)
  assert.equal(balanceInvalidated, 1)
  assert.equal(JSON.stringify(value).includes(KEY), false)
})

test('new-image tool calls with an empty reference array use generations', async t => {
  const { tool, exec, calls } = await toolFixture(t)
  const value = await tool.execute({ prompt: args.prompt, referenceImages: [] }, exec)
  assert.equal(value.image.attachmentId, REF.attachmentId)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/images\/generations$/u)
})

test('native new-image arguments with a zero placeholder mask use generations', async t => {
  const { tool, exec, calls } = await toolFixture(t)
  await tool.execute({ prompt: args.prompt, referenceImages: [], maskImage: {
    attachmentId: `sha256:${'0'.repeat(64)}`, mediaType: 'image/png', bytes: 0, width: 0, height: 0,
    name: '', originalDimensions: { width: 0, height: 0 },
  } }, exec)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/images\/generations$/u)
})

test('explicit edits still require references and generation never discards real references or masks', async t => {
  const { tool, exec, calls } = await toolFixture(t)
  for (const referenceImages of [undefined, []]) {
    await assert.rejects(() => tool.execute({ prompt: args.prompt, operation: 'edit', ...(referenceImages === undefined ? {} : { referenceImages }) }, exec), /1-16 reference images/u)
  }
  await assert.rejects(() => tool.execute({ prompt: args.prompt, operation: 'generate', referenceImages: [REF] }, exec), /cannot include reference images/u)
  await assert.rejects(() => tool.execute({ prompt: args.prompt, referenceImages: [], maskImage: REF }, exec), /requires referenceImages/u)
  await assert.rejects(() => tool.execute({ prompt: args.prompt, referenceImages: [], maskImage: { ...REF, bytes: 0, width: 0, height: 0 } }, exec), /requires referenceImages/u)
  assert.equal(calls.length, 0)
})

test('settings sentinels follow saved image preferences while explicit overrides remain exact', async t => {
  const { tool, exec, calls } = await toolFixture(t)
  const value = await tool.execute({ prompt: args.prompt, operation: 'generate', model: 'settings', quality: 'settings', referenceImages: [] }, exec)
  assert.equal(value.requestedModel, 'gpt-image-2.6-sunburst')
  assert.equal(value.requestedQuality, 'max')
  assert.equal(JSON.parse(calls[0].init.body).quality, 'max')
  const explicit = await tool.execute({ prompt: args.prompt, model: 'gpt-image-2', quality: 'auto' }, exec)
  assert.equal(explicit.requestedModel, 'gpt-image-2')
  assert.equal(explicit.requestedQuality, 'auto')
})

test('an engine without a quality parameter does not inherit the quality saved for another engine', async t => {
  const { tool, exec, calls } = await toolFixture(t)
  // The saved setting is 2.6 Sunburst at max; MiniMax named for this call takes no quality.
  for (const quality of [undefined, 'settings', 'auto']) {
    const value = await tool.execute({ prompt: args.prompt, model: 'MiniMax-H3-Image', ...(quality === undefined ? {} : { quality }) }, exec)
    assert.deepEqual([value.requestedModel, value.requestedQuality], ['MiniMax-H3-Image', 'auto'])
    assert.equal(Object.hasOwn(JSON.parse(calls.at(-1).init.body), 'quality'), false)
  }
  // An explicit quality it does not have is still refused, and so is a saved
  // quality on an engine that has qualities but not that one.
  await assert.rejects(() => tool.execute({ prompt: args.prompt, model: 'MiniMax-H3-Image', quality: 'max' }, exec), /quality is not supported by the selected model/u)
  await assert.rejects(() => tool.execute({ prompt: args.prompt, model: 'gpt-image-2' }, exec), /quality is not supported by the selected model/u)
  assert.equal(calls.length, 3)
})

test('a real PNG mask on a MiniMax H3 Image edit is refused, never dropped or turned into a generation', async t => {
  const MASK = { ...REF, attachmentId: `sha256:${'b'.repeat(64)}`, name: 'mask.png' }
  const { tool, exec, calls } = await toolFixture(t, { getSessionMessages: async () => [{ content: [{ type: 'image', attachment: REF }, { type: 'image', attachment: MASK }] }] })
  await assert.rejects(() => tool.execute({ prompt: args.prompt, model: 'MiniMax-H3-Image', referenceImages: [REF], maskImage: MASK }, exec), /masks are not supported by the selected model/u)
  assert.equal(calls.length, 0)
  // The same edit without the mask goes to the edits endpoint.
  await tool.execute({ prompt: args.prompt, model: 'MiniMax-H3-Image', referenceImages: [REF], maskImage: null }, exec)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/images\/edits$/u)
  assert.equal(calls[0].init.body.get('mask'), null)
  assert.deepEqual([calls[0].init.body.get('size'), calls[0].init.body.get('area')], ['auto', '2K'])
})

test('DSH edits resolve trusted session references rather than model-supplied metadata', async t => {
  const { tool, exec, calls } = await toolFixture(t)
  await tool.execute({ prompt: args.prompt, referenceImages: [{ ...REF, mediaType: 'image/gif', width: 999 }] }, exec)
  assert.match(calls[0].url, /\/edits$/u)
  const image = calls[0].init.body.get('image[]')
  assert.equal(image.type, 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG)
  const count = calls.length
  await assert.rejects(() => tool.execute({ prompt: args.prompt, referenceImages: [{ ...REF, attachmentId: `sha256:${'b'.repeat(64)}` }] }, exec), /missing from this session/u)
  await assert.rejects(() => tool.execute({ prompt: args.prompt, referenceImages: [{ ...REF, attachmentId: '/tmp/reference.png' }] }, exec), /complete attachment reference/u)
  await assert.rejects(() => tool.execute({ prompt: args.prompt, operation: 'edit', referenceImages: [] }, exec), /1-16/u)
  assert.equal(calls.length, count)
})

for (const [mediaType, bytes] of [['image/jpeg', JPEG], ['image/webp', WEBP]]) test(`a reference-only ${mediaType} edit tolerates a model-filled copy of the same non-PNG image in the optional mask field`, async t => {
  const reference = { ...REF, mediaType, bytes: bytes.length }
  let reads = 0
  const { tool, exec, calls } = await toolFixture(t, {
    getSessionMessages: async () => [{ role: 'user', content: [{ type: 'image', attachment: reference }] }],
    attachments: {
      imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
      readImage: async ref => { reads++; return { data: bytes, ref } },
      saveImage: async () => REF,
    },
  })
  // The user supplied only the reference, no separate mask. Model metadata
  // cannot turn that same stored JPEG/WebP into a PNG mask.
  await tool.execute({ prompt: 'Refine the sketch, preserving its character and pose.', operation: 'edit',
    referenceImages: [reference], maskImage: { ...reference, mediaType: 'image/png' },
  }, exec)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/images\/edits$/u)
  assert.equal(calls[0].init.body.get('mask'), null)
  assert.equal(calls[0].init.body.get('image[]').type, mediaType)
  assert.deepEqual(Buffer.from(await calls[0].init.body.get('image[]').arrayBuffer()), bytes)
  assert.equal(reads, 1, 'a redundant non-mask reference does not need a second attachment read')
})

test('the native tool accepts an explicit null mask for both reference-only edits and new images', async t => {
  const { tool, exec, calls } = await toolFixture(t)
  await tool.execute({ prompt: args.prompt, referenceImages: [REF], maskImage: null }, exec)
  await tool.execute({ prompt: args.prompt, referenceImages: [], maskImage: null }, exec)
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /\/images\/edits$/u)
  assert.equal(calls[0].init.body.get('mask'), null)
  assert.match(calls[1].url, /\/images\/generations$/u)
})

test('mask compatibility preserves PNG masks and never discards a distinct invalid mask', async t => {
  const valid = await toolFixture(t)
  await valid.tool.execute({ prompt: args.prompt, referenceImages: [REF], maskImage: REF }, valid.exec)
  assert.deepEqual(Buffer.from(await valid.calls[0].init.body.get('mask').arrayBuffer()), PNG)

  for (const mediaType of ['image/jpeg', 'image/webp', 'image/png']) {
    const maskRef = { ...REF, attachmentId: `sha256:${'b'.repeat(64)}`, mediaType }
    const maskData = mediaType === 'image/png' ? Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]) : mediaType === 'image/webp' ? WEBP : JPEG
    const fx = await toolFixture(t, {
      getSessionMessages: async () => [{ content: [REF, maskRef].map(attachment => ({ type: 'image', attachment })) }],
      attachments: {
        imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
        readImage: async ref => ({ data: ref.attachmentId === REF.attachmentId ? PNG : maskData, ref }),
        saveImage: async () => REF,
      },
    })
    await assert.rejects(() => fx.tool.execute({ prompt: args.prompt, referenceImages: [REF], maskImage: maskRef }, fx.exec),
      mediaType === 'image/png' ? /PNG smaller than 4 MB/u : /separate PNG mask.*omit maskImage/u)
    assert.equal(fx.calls.length, 0, 'invalid distinct masks never become unmasked edits or generations')
  }
})

test('disabled images and sessionless execution cannot make paid requests', async t => {
  const { tool, exec, calls, setEnabled } = await toolFixture(t)
  setEnabled(false)
  await assert.rejects(() => tool.execute({ prompt: args.prompt }, exec), /disabled/u)
  setEnabled(true)
  await assert.rejects(() => tool.execute({ prompt: args.prompt }, { signal: exec.signal }), /session-owned/u)
  assert.equal(calls.length, 0)
})

test('failing attachment storage cleans the saved original and hides underlying errors', async t => {
  const { tool, exec } = await toolFixture(t, { attachments: { saveImage: async () => { throw new Error(KEY) } } })
  await assert.rejects(() => tool.execute({ prompt: args.prompt }, exec), error => {
    assert.equal(error.message, 'PackyCode could not save the generated image')
    return true
  })
})
