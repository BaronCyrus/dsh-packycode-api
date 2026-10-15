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
 *   read-only while web search and model visibility are editable.
 *
 * @module dsh-packycode-api/preferences
 */

/**
 * Mark a preference editable without restarting the plugin. DSH 0.2 stores
 * plugin preferences as volatile Config fields and writes only those, so the
 * schema version that implements `volatile()` is a peer requirement.
 *
 * Name the cause when it is missing instead of letting a bare
 * `schema.volatile is not a function` reach the host log: the Loader creates
 * no fiber for a plugin whose module throws while it is imported, so DSH shows
 * nothing at all — no settings section, no model route, no RPC channel — and
 * the only explanation is that one log line.
 */
export const live = schema => {
  if (typeof schema?.volatile !== 'function') {
    throw new Error(
      'PackyCode needs @deepseek-ai/schemastery ^3.18.4, which implements Schema.volatile(); '
      + 'the copy resolved for this plugin is older. A plugin installed from a registry has no node_modules of its own, '
      + 'so this usually means a stale dependency tree inside the installed package directory '
      + '(for example <profile>/node_modules/dsh-packycode-api/node_modules, left by an earlier local-path install) '
      + 'is shadowing the DSH installation. Remove that directory, or uninstall the plugin and install it again, then restart DSH.',
    )
  }
  return schema.volatile()
}

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
 *   and the preference targets this fills in (host overrides, search, models).
 */
export function connectSettings(settingsCtx, { ctx, Config, namespace, source, setSource, onChange, hostPreference, searchPreference, modelPreference }) {
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
        const target = { writable: settings.writable !== false, set: write }
        Object.assign(hostPreference, target)
        Object.assign(searchPreference, target)
        Object.assign(modelPreference, target)
      }
    } catch (error) {
      ctx.logger?.warn?.('packycode-api: host overrides unavailable, defaults stand: %s', error.message)
    }
    return
  }
  if (typeof settings?.update !== 'function') return
  const rowId = ctx.fiber?.entry?.options?.id ?? namespace
  const target = { writable: settings.writable !== false, set: patch => settings.update(rowId, patch) }
  Object.assign(searchPreference, target)
  Object.assign(modelPreference, target)
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
