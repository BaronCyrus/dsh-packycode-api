/** Paid opt-in check, run only after the user adds a separate image key. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createPackyCodeImageClient, DEFAULT_API_HOST, IMAGE_MODEL_IDS, validateImageOptions } from '../lib/index.js'
import { readStoredKey } from './stored-key.mjs'

async function main() {
  const args = process.argv.slice(2)
  const flags = new Map()
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (['--all', '--edit'].includes(flag)) flags.set(flag, true)
    else if (['--model', '--quality', '--host'].includes(flag) && typeof args[index + 1] === 'string' && !args[index + 1].startsWith('--')) flags.set(flag, args[++index])
    else throw new Error('Usage: node scripts/image-check.mjs [--all] [--edit] [--model <id>] [--quality <quality>] [--host <url>]')
  }
  const models = flags.has('--all') ? IMAGE_MODEL_IDS : [flags.get('--model') ?? 'gpt-image-2.5-sunburst']
  const quality = flags.get('--quality') ?? 'low'
  for (const model of models) validateImageOptions({ model, quality, size: '1024x1024' })
  const key = await readStoredKey({ recordId: 'image-keys' })
  console.log(JSON.stringify({ credential: 'packycode-api/image-keys', keyTail: `…${key.slice(-4)}`, models, quality }))
  const client = createPackyCodeImageClient({ resolveKey: async () => ({ key }), getHost: () => flags.get('--host') ?? DEFAULT_API_HOST })
  const directory = resolve('.artifacts', `image-check-${Date.now()}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let reference
  for (const model of models) {
    const started = Date.now()
    const image = await client.request({ model, quality, size: '1024x1024', prompt: 'A simple flat illustration of a small blue teapot on a plain white background, centered, no text.' })
    const path = resolve(directory, `${model}.png`)
    await writeFile(path, image.data, { flag: 'wx', mode: 0o600 })
    reference = image
    console.log(JSON.stringify({ operation: 'generation', model, quality, reportedModel: image.reportedModel ?? null, reportedQuality: image.quality ?? null, width: image.width, height: image.height, bytes: image.data.length, elapsedMs: Date.now() - started, path }))
  }
  if (flags.has('--edit')) {
    const model = models.at(-1)
    const started = Date.now()
    const image = await client.request({ model, quality, size: '1024x1024', prompt: 'Change only the teapot to bright orange. Preserve the composition and white background.' }, {
      images: [{ data: reference.data, mediaType: 'image/png', width: reference.width, height: reference.height }],
    })
    const path = resolve(directory, `${model}-edit.png`)
    await writeFile(path, image.data, { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ operation: 'edit', model, quality, reportedModel: image.reportedModel ?? null, reportedQuality: image.quality ?? null, width: image.width, height: image.height, bytes: image.data.length, elapsedMs: Date.now() - started, path }))
  }
}

main().catch(error => {
  // All transport errors are authored by the image client. No response body,
  // request headers, credential document, or exception cause is printed.
  console.error(error.message)
  process.exitCode = 1
})
