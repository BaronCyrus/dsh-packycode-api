import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS, IMAGE_MODEL_IDS, validateImageOptions } from './image-models.js'
import { fieldValue } from './preferences.js'

export function readImagePreference(value = {}) {
  const model = fieldValue(value.imageModel)
  const imageModel = IMAGE_MODEL_IDS.includes(model) ? model : DEFAULT_IMAGE_MODEL
  const quality = fieldValue(value.imageQuality)
  return {
    imageEnabled: fieldValue(value.imageEnabled) !== false,
    imageModel,
    imageQuality: IMAGE_MODELS[imageModel].includes(quality) ? quality : 'auto',
  }
}

/** No request is sent by a settings or credential mutation. */
export function createImageController({ ring, balance, readPreference, writePreference, isWritable }) {
  let mounted
  let disposeTool
  let generation = 0
  let closed = false
  const preference = () => readImagePreference(readPreference())
  const reconcile = async () => {
    const current = ++generation
    const key = await ring.activeKey()
    if (closed || current !== generation) return
    const enabled = preference().imageEnabled && key !== undefined && mounted !== undefined
    if (enabled && disposeTool === undefined) disposeTool = mounted()
    if (!enabled && disposeTool !== undefined) { disposeTool(); disposeTool = undefined }
  }
  const status = async () => ({
    ...preference(),
    ...(await ring.list()),
    writable: isWritable() === true,
    available: mounted !== undefined,
    toolRegistered: disposeTool !== undefined,
    models: IMAGE_MODEL_IDS.map(id => ({ id, qualities: [...IMAGE_MODELS[id]] })),
  })
  return {
    preference,
    status,
    invalidateBalance: () => balance?.invalidate(),
    async readBalance({ force = false, signal } = {}) {
      if (balance === undefined) throw new Error('PackyCode image balance is unavailable in this runtime')
      try {
        const [value, state] = await Promise.all([balance.read({ force, signal }), ring.list()])
        return { ...value, activeId: state.activeId }
      } catch {
        throw new Error('PackyCode image balance could not be read')
      }
    },
    reconcile,
    mount(register) {
      mounted = register
      closed = false
      void reconcile().catch(() => undefined)
      return () => {
        closed = true
        generation += 1
        mounted = undefined
        disposeTool?.()
        disposeTool = undefined
      }
    },
    async update(value = {}) {
      if (isWritable() !== true) throw new Error('PackyCode image settings are not writable in this profile')
      const patch = {}
      if (Object.hasOwn(value, 'imageEnabled')) {
        if (typeof value.imageEnabled !== 'boolean') throw new Error('PackyCode image switch must be a boolean')
        patch.imageEnabled = value.imageEnabled
      }
      if (Object.hasOwn(value, 'imageModel')) patch.imageModel = value.imageModel
      if (Object.hasOwn(value, 'imageQuality')) patch.imageQuality = value.imageQuality
      const next = { ...preference(), ...patch }
      // Changing engines resets an incompatible saved quality; explicit
      // incompatible choices are rejected before persisting anything.
      if (patch.imageModel !== undefined && patch.imageQuality === undefined
        && !IMAGE_MODELS[patch.imageModel]?.includes(next.imageQuality)) patch.imageQuality = next.imageQuality = 'auto'
      validateImageOptions({ model: next.imageModel, quality: next.imageQuality })
      try { await writePreference(patch) } catch { throw new Error('PackyCode could not save the image settings') }
      await reconcile()
      return status()
    },
    async mutate(operation, payload = {}) {
      const operations = {
        add: () => ring.add(payload.key, payload.label),
        rename: () => ring.rename(String(payload.id ?? ''), payload.label),
        remove: () => ring.remove(String(payload.id ?? '')),
        select: () => ring.select(String(payload.id ?? '')),
        enable: () => ring.enable(String(payload.id ?? '')),
      }
      if (!Object.hasOwn(operations, operation)) throw new Error('Unknown PackyCode image key operation')
      await operations[operation]()
      balance?.invalidate()
      await reconcile()
      return status()
    },
  }
}
