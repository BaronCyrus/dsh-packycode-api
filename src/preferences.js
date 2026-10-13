/**
 * Where the plugin's preferences are read from and written to, on both
 * settings generations DSH has shipped.
 *
 * - DSH 0.1.5 installs a settings *section*: the section hands back a live
 *   source and writes go through `settings.update(namespace, patch)`.
 * - DSH 0.2 has no sections: a preference is a *volatile* Config field of the
 *   plugin's own row, read through a live reference, written through
 *   `settings.update(rowId, patch)`, and announced by `loader/volatile-update`.
 *   Only volatile fields are writable there, so the host overrides stay
 *   read-only while the web search preference is editable.
 *
 * @module dsh-packycode-api/preferences
 */

/**
 * Mark a preference editable without restarting the plugin. DSH 0.2 stores
 * plugin preferences as volatile Config fields and writes only those; an older
 * schema library has no `volatile()` and keeps a plain field.
 */
export const live = schema => (typeof schema.volatile === 'function' ? schema.volatile() : schema)

/** Read a Config field that may arrive as a volatile reference. */
export const fieldValue = value => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value)

/** A preference target nothing can write to yet. */
export function unwritable(message) {
  return {
    writable: false,
    set: async () => {
      throw new Error(message)
    },
  }
}

/**
 * Connect the preferences to the settings service the host provides.
 * @param settingsCtx - the scope the `settings` inject handed over.
 * @param options - the plugin context and Config, the section namespace, the
 *   current source and how to replace it, what to do when the section changes,
 *   and the two preference targets this fills in (host overrides, search).
 */
export function connectSettings(settingsCtx, { ctx, Config, namespace, source, setSource, onChange, hostPreference, searchPreference }) {
  const settings = settingsCtx.settings
  if (typeof settings?.installSection === 'function') {
    try {
      settings.installSection(ctx, namespace, Config, source(), {
        // The section hands back the live source; it may answer with a plain
        // value on a runtime that does not wrap it in a getter.
        setSource: current => setSource(typeof current === 'function' ? () => current() ?? {} : () => current ?? {}),
        onChange,
      })
      if (typeof settings.update === 'function') {
        const write = patch => settings.update(namespace, patch)
        Object.assign(hostPreference, { writable: true, set: write })
        Object.assign(searchPreference, { writable: true, set: write })
      }
    } catch (error) {
      ctx.logger?.warn?.('packycode-api: host overrides unavailable, defaults stand: %s', error.message)
    }
    return
  }
  if (typeof settings?.update !== 'function') return
  const rowId = ctx.fiber?.entry?.options?.id ?? namespace
  Object.assign(searchPreference, { writable: settings.writable !== false, set: patch => settings.update(rowId, patch) })
  if (typeof settings.configure === 'function') {
    // The PackyCode panel is the editor; no generated duplicate page.
    const scope = typeof settingsCtx.effect === 'function' ? settingsCtx : ctx
    try {
      scope.effect(() => settings.configure({ auto: false }, ctx.fiber), 'packycode-api: settings page policy')
    } catch (error) {
      ctx.logger?.warn?.('packycode-api: could not hide the generated settings page: %s', error.message)
    }
  }
}
