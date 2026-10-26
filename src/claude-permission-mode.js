/**
 * Which Claude Code permission mode a DSH session's permission settings mean.
 *
 * On the cc route Claude Code is the agent and runs its own tools, so DSH's
 * sandbox does not confine them. The CLI's permission mode decides which calls
 * it asks about; DSH's approval answers what it asks. The mapping keeps each
 * preset's promise: plan mode only plans, workspace-write edits the workspace
 * freely and asks for anything else, full access never asks, and Auto review
 * gets every call the CLI would ask about.
 *
 * @module dsh-packycode-api/claude-permission-mode
 */

/** Claude Code permission modes the transport sets. */
export const CLAUDE_PERMISSION_MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'bypassPermissions'])

/** DSH's Auto review preset name, owned by its official auto-review plugin. */
const AUTO_PRESET = 'auto'

/** Sandbox modes of DSH's shipped presets, by preset name. */
const PRESET_SANDBOX = Object.freeze({
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'danger-full-access': 'danger-full-access',
})

/**
 * The Claude Code permission mode for a session.
 * @param options - whether plan mode is active (or selected for this step),
 *   the session's preset name, and the preset's sandbox mode and approval
 *   policy when DSH reports them.
 * @returns one of {@link CLAUDE_PERMISSION_MODES}.
 */
export function claudePermissionMode({ planActive = false, preset, sandbox, approval } = {}) {
  if (planActive) return 'plan'
  // Auto review judges every call; the CLI asks about each one it would ask a user about.
  if (preset === AUTO_PRESET) return 'default'
  const box = sandbox ?? PRESET_SANDBOX[preset]
  if (box === 'danger-full-access') return approval === 'ask' ? 'acceptEdits' : 'bypassPermissions'
  if (box === 'workspace-write') return 'acceptEdits'
  return 'default'
}
