/** Images API models are separate from the conversational pi-ai catalog. */
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2'
export const IMAGE_MODELS = Object.freeze({
  'gpt-image-2': Object.freeze(['auto', 'low', 'medium', 'high']),
  'gpt-image-2.5-flare': Object.freeze(['auto', 'low', 'medium', 'high', 'xhigh', 'max']),
  'gpt-image-2.5-sunburst': Object.freeze(['auto', 'low', 'medium', 'high', 'xhigh', 'max']),
})
export const IMAGE_MODEL_IDS = Object.freeze(Object.keys(IMAGE_MODELS))
export const IMAGE_QUALITIES = Object.freeze(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])

export function validateImageOptions({ model = DEFAULT_IMAGE_MODEL, quality = 'auto', size = 'auto', background = 'auto' } = {}) {
  if (!IMAGE_MODEL_IDS.includes(model)) throw new Error('PackyCode image model is not supported')
  if (!IMAGE_MODELS[model].includes(quality)) throw new Error('PackyCode image quality is not supported by the selected model')
  if (!['auto', 'transparent', 'opaque'].includes(background)) throw new Error('PackyCode image background is not supported')
  if (size !== 'auto') {
    const match = typeof size === 'string' ? /^(\d{1,4})x(\d{1,4})$/u.exec(size) : null
    const width = Number(match?.[1])
    const height = Number(match?.[2])
    const pixels = width * height
    if (match === null || width % 16 !== 0 || height % 16 !== 0
      || Math.max(width, height) > 3840 || Math.max(width, height) > Math.min(width, height) * 3
      || pixels < 655_360 || pixels > 8_294_400) {
      throw new Error('PackyCode image size must be auto or a supported widthxheight resolution')
    }
  }
  return { model, quality, size, background }
}
