/** Images API models are separate from the conversational pi-ai catalog. */
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2'
export const IMAGE_MODELS = Object.freeze({
  'gpt-image-2': Object.freeze(['auto', 'low', 'medium', 'high']),
  'gpt-image-2.6-flare': Object.freeze(['auto', 'low', 'medium', 'high', 'xhigh', 'max']),
  'gpt-image-2.6-sunburst': Object.freeze(['auto', 'low', 'medium', 'high', 'xhigh', 'max']),
  // MiniMax H3 Image has no `quality` parameter: `auto` is the only choice
  // and nothing is sent for it.
  'MiniMax-H3-Image': Object.freeze(['auto']),
  'MiniMax-H3-Image-Highspeed': Object.freeze(['auto']),
})
export const IMAGE_MODEL_IDS = Object.freeze(Object.keys(IMAGE_MODELS))
/**
 * MiniMax's H3 Image models take the Images API paths with their own fields
 * (platform.minimax.io/docs/api-reference/image-generation-h3-generations and
 * -h3-edits): no `quality`, `background` or `mask`, a JPEG link unless PNG and
 * `b64_json` are asked for, and 4K output unless a size is given.
 */
export const isMiniMaxImageModel = model => typeof model === 'string' && model.startsWith('MiniMax-H3-Image')
/**
 * The resolution tier sent with `size: auto`, where MiniMax picks the shape
 * from the prompt or the references. Its own default is the 4K tier, four
 * times the pixels and price of 2K and past the size this plugin stores.
 * `area` cannot go with an explicit size (400); the gateway forwards it.
 */
export const MINIMAX_AUTO_AREA = '2K'
/**
 * Engines the settings once offered, mapped to the ones that replaced them.
 * A saved setting still names them, so the Config schema keeps them as hidden
 * values (dropping them would fail the plugin's Config at load) and reading
 * the preference moves them to their successor with the same quality.
 */
export const RETIRED_IMAGE_MODELS = Object.freeze({
  'gpt-image-2.5-flare': 'gpt-image-2.6-flare',
  'gpt-image-2.5-sunburst': 'gpt-image-2.6-sunburst',
})
export const IMAGE_QUALITIES = Object.freeze(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])

export function validateImageOptions({ model = DEFAULT_IMAGE_MODEL, quality = 'auto', size = 'auto', background = 'auto' } = {}) {
  if (!IMAGE_MODEL_IDS.includes(model)) throw new Error('PackyCode image model is not supported')
  if (!IMAGE_MODELS[model].includes(quality)) throw new Error('PackyCode image quality is not supported by the selected model')
  if (!['auto', 'transparent', 'opaque'].includes(background)) throw new Error('PackyCode image background is not supported')
  if (background === 'transparent' && isMiniMaxImageModel(model)) throw new Error('PackyCode image transparent background is not supported by the selected model')
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
