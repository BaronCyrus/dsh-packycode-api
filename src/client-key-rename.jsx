/**
 * Renaming a stored key, the same way in the conversation and image key
 * cards: the name becomes a text field; Enter or Save stores it, Escape or
 * Cancel keeps the old one. Only the key's id and the new label reach the host.
 *
 * @module dsh-packycode-api/client-key-rename
 */

import * as react from 'react'

/**
 * The rename state a key card keeps.
 * @param save - `({ id, label }) => Promise`; the field closes once it settles.
 * @returns `{ renaming, start, change, cancel, submit }`.
 */
export function useKeyRename(save) {
  const [renaming, setRenaming] = react.useState()
  return {
    renaming,
    start: entry => setRenaming({ id: entry.id, label: entry.label }),
    change: label => setRenaming(current => ({ ...current, label })),
    cancel: () => setRenaming(undefined),
    submit: () => {
      if (renaming === undefined || renaming.label.trim() === '') return
      save({ id: renaming.id, label: renaming.label }).then(() => setRenaming(undefined))
    },
  }
}

/** The field and buttons that stand in for a key's name while it is renamed. */
export function KeyRenameForm({ rename, busy, t }) {
  const label = rename.renaming.label
  return (
    <form className="pkc-form" onSubmit={event => { event.preventDefault(); rename.submit() }}>
      <input
        className="pkc-input"
        type="text"
        maxLength={60}
        autoFocus
        placeholder={t('keyRenamePlaceholder')}
        value={label}
        onChange={event => rename.change(event.target.value)}
        onKeyDown={event => event.key === 'Escape' && rename.cancel()}
      />
      <button type="submit" className="pkc-btn" data-variant="primary" disabled={busy || label.trim() === ''}>{t('keyRenameSave')}</button>
      <button type="button" className="pkc-btn" data-variant="ghost" onClick={rename.cancel}>{t('keyRenameCancel')}</button>
    </form>
  )
}
