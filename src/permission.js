/**
 * The Claude Code CLI mode a session's own permissions allow.
 *
 * A CLI-backed turn runs the CLI's own tool loop, outside the harness sandbox
 * and approval flow. Deriving its mode from the session's permission preset
 * means the user grants it once, in the place they already grant the harness
 * itself, instead of in a separate plugin setting.
 *
 * @module dsh-packycode-api/permission
 */

/** Configured value meaning "follow the session's permission preset". */
export const AUTO_CLAUDE_MODE = 'auto'

const RANK = Object.freeze({ 'read-only': 0, edit: 1, full: 2 })

/**
 * Map the harness's two permission knobs onto a CLI mode.
 *
 * The CLI cannot ask the harness user for approval, so it skips its own
 * permission checks only when the session itself neither sandboxes nor asks.
 * @param sandbox - the session's resolved sandbox mode.
 * @param approval - the session's effective approval policy.
 * @returns a CLI mode, or `undefined` for an unknown sandbox mode.
 */
export function claudeModeFor(sandbox, approval) {
  switch (sandbox) {
    case 'read-only':
      return 'read-only'
    case 'workspace-write':
      return 'edit'
    case 'danger-full-access':
      return approval === 'never' ? 'full' : 'edit'
    default:
      return undefined
  }
}

/**
 * Read a session's CLI mode from the host's permission services.
 * @param ctx - the plugin context; services are read without an inject requirement.
 * @param session - the session whose permission state is read.
 * @returns a CLI mode, or `undefined` when the session or the services are absent.
 */
export function claudeModeForSession(ctx, session) {
  if (session === undefined || session === null) return undefined
  try {
    const sandbox = ctx.get?.('sandboxPolicy')?.resolve?.({ session })?.mode
    const approval = ctx.get?.('approval')?.effectivePolicy?.(session)
    return claudeModeFor(sandbox, approval)
  } catch {
    return undefined
  }
}

/**
 * The narrower of two modes; an unknown ceiling leaves the request as it is.
 * @param requested - the mode a caller asked for.
 * @param ceiling - the most the session allows.
 * @returns the mode the CLI runs with.
 */
export function capClaudeMode(requested, ceiling) {
  if (ceiling === undefined || RANK[ceiling] === undefined) return requested
  if (requested === undefined || RANK[requested] === undefined) return ceiling
  return RANK[requested] > RANK[ceiling] ? ceiling : requested
}
