/**
 * Bridge to the local Claude Code CLI.
 *
 * The gateway's `cc` group serves its Claude models only to the official CLI,
 * so this module runs that CLI — the real binary, not an imitation of it — as
 * a subprocess and hands its final answer back to the harness. The child gets
 * the plugin's own endpoint and key through the environment, plus an isolated
 * `CLAUDE_CONFIG_DIR`: `~/.claude/settings.json` env wins over an inherited
 * environment, so without that isolation the user's own CLI configuration
 * would silently override both.
 *
 * @module dsh-packycode-api/claude-cli
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * What the delegated CLI may do on its own. The CLI runs its own tool loop;
 * these are its permission switches, not the harness's sandbox.
 */
export const CLAUDE_CLI_MODES = Object.freeze({
  'read-only': Object.freeze({ allowedTools: Object.freeze(['Read', 'Grep', 'Glob']) }),
  edit: Object.freeze({ allowedTools: Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit']) }),
  full: Object.freeze({ skipPermissions: true }),
})

export const DEFAULT_CLAUDE_MODE = 'edit'
/** Isolated CLI home; the plugin owns the endpoint and key it runs with. */
export const DEFAULT_CLAUDE_CONFIG_DIR = join(homedir(), '.dsh', 'packycode-claude-cli')
export const DEFAULT_CLAUDE_TIMEOUT_MS = 30 * 60 * 1000

/** Argument lists travel through argv, which the kernel bounds. */
const MAX_PROMPT_CHARS = 100_000
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024
const KILL_GRACE_MS = 3_000

const CANDIDATE_BINARIES = Object.freeze([
  join(homedir(), '.local', 'bin', 'claude'),
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
])

/**
 * Locate the Claude Code CLI.
 * @param explicit - a configured path, when the deployment names one.
 * @returns an absolute path when one exists, otherwise the bare name so PATH decides.
 */
export function findClaudeBinary(explicit) {
  const configured = typeof explicit === 'string' ? explicit.trim() : ''
  if (configured !== '') return configured
  for (const candidate of CANDIDATE_BINARIES) {
    if (existsSync(candidate)) return candidate
  }
  return 'claude'
}

/**
 * Build the CLI arguments for one delegated task.
 * @param options - the prompt, the permission mode, and an optional model.
 * @returns argv after the binary name.
 */
export function buildClaudeArgs({ prompt, mode = DEFAULT_CLAUDE_MODE, model } = {}) {
  const text = typeof prompt === 'string' ? prompt : ''
  if (text.trim() === '') throw new Error('claude_code needs a non-empty prompt')
  if (text.length > MAX_PROMPT_CHARS) {
    throw new Error(`claude_code prompt is too long (${text.length} > ${MAX_PROMPT_CHARS} characters)`)
  }
  const spec = CLAUDE_CLI_MODES[mode]
  if (spec === undefined) {
    throw new Error(`claude_code mode must be one of ${Object.keys(CLAUDE_CLI_MODES).join(', ')}`)
  }
  const args = ['-p', text, '--output-format', 'json']
  const named = typeof model === 'string' ? model.trim() : ''
  if (named !== '') args.push('--model', named)
  if (spec.skipPermissions === true) args.push('--dangerously-skip-permissions')
  else args.push('--allowedTools', ...spec.allowedTools)
  return args
}

/**
 * The child's environment: this plugin's endpoint and key, an isolated config
 * home, and the CLI's own network-noise switches off.
 * @param options - credential, config home, and the parent environment.
 * @returns the environment for the child process.
 */
export function buildClaudeEnvironment({ baseUrl, token, configDir = DEFAULT_CLAUDE_CONFIG_DIR, parent = process.env } = {}) {
  if (typeof token !== 'string' || token === '') throw new Error('claude_code has no PackyCode API key to run with')
  const env = { ...parent }
  // A defined ANTHROPIC_API_KEY wins inside the CLI, and an ambient one would
  // authenticate the wrong account; an OAuth token would bypass the relay.
  delete env.ANTHROPIC_API_KEY
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  delete env.CLAUDE_CODE_USE_BEDROCK
  delete env.CLAUDE_CODE_USE_VERTEX
  return {
    ...env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_BUG_COMMAND: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}

/**
 * Read the CLI's `--output-format json` payload.
 * @param stdout - the child's stdout.
 * @returns the parsed payload, or undefined when nothing usable was printed.
 */
export function parseClaudeResult(stdout) {
  const text = typeof stdout === 'string' ? stdout : ''
  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const value = JSON.parse(trimmed)
      if (value !== null && typeof value === 'object' && ('result' in value || 'is_error' in value)) return value
    } catch {
      // Not the payload line; keep looking.
    }
  }
  return undefined
}

/** Turn a CLI failure into a message that names what the CLI reported. */
function failureMessage(parsed, exitCode, stderr) {
  const reported = typeof parsed?.result === 'string' && parsed.result.trim() !== '' ? parsed.result.trim() : undefined
  if (reported !== undefined) return `Claude Code CLI failed: ${reported}`
  const detail = (typeof stderr === 'string' ? stderr : '').trim().split('\n').slice(-4).join(' ').slice(0, 400)
  return detail === ''
    ? `Claude Code CLI exited with code ${exitCode ?? 'unknown'}`
    : `Claude Code CLI exited with code ${exitCode ?? 'unknown'}: ${detail}`
}

/**
 * A Claude Code CLI runner.
 * @param options - binary, config home, credential resolution, and process seams.
 * @returns `{ run({ prompt, mode, model, cwd, signal }) }`.
 */
export function createClaudeRunner({
  binary = findClaudeBinary(),
  configDir = DEFAULT_CLAUDE_CONFIG_DIR,
  resolveCredential,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_CLAUDE_TIMEOUT_MS,
} = {}) {
  if (typeof resolveCredential !== 'function') throw new Error('the Claude Code CLI runner needs resolveCredential')
  return Object.freeze({
    /**
     * Run one delegated task to completion.
     * @param options - prompt, mode, model, working directory, and cancellation.
     * @returns the CLI's answer plus its own accounting.
     */
    async run({ prompt, mode, model, cwd, signal } = {}) {
      const args = buildClaudeArgs({ prompt, mode, model })
      const { baseUrl, token } = await resolveCredential()
      const env = buildClaudeEnvironment({ baseUrl, token, configDir })
      const effectiveMode = mode ?? DEFAULT_CLAUDE_MODE
      return await new Promise((resolve, reject) => {
        let child
        try {
          child = spawnImpl(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (error) {
          reject(new Error(`claude_code could not start ${binary}: ${error.message}`, { cause: error }))
          return
        }
        let stdout = ''
        let stderr = ''
        let settled = false
        let timedOut = false
        const startedAt = Date.now()
        const kill = () => {
          if (child.exitCode !== null || child.signalCode !== null) return
          child.kill('SIGTERM')
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch {
              // Already gone.
            }
          }, KILL_GRACE_MS)
          timer.unref?.()
        }
        const timer = timeoutMs > 0 ? setTimeout(() => {
          timedOut = true
          kill()
        }, timeoutMs) : undefined
        timer?.unref?.()
        const onAbort = () => kill()
        signal?.addEventListener('abort', onAbort, { once: true })
        const capture = (target, chunk) => (target + chunk).slice(-MAX_CAPTURE_BYTES)
        child.stdout?.on('data', chunk => {
          stdout = capture(stdout, String(chunk))
        })
        child.stderr?.on('data', chunk => {
          stderr = capture(stderr, String(chunk))
        })
        const finish = () => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        }
        child.on('error', error => {
          finish()
          reject(new Error(`claude_code could not run ${binary}: ${error.message}`, { cause: error }))
        })
        child.on('close', (code, killSignal) => {
          finish()
          const parsed = parseClaudeResult(stdout)
          if (timedOut) {
            reject(new Error(`claude_code timed out after ${Math.round(timeoutMs / 1000)}s`))
            return
          }
          if (signal?.aborted === true) {
            reject(new Error('claude_code was aborted'))
            return
          }
          if (parsed === undefined) {
            reject(new Error(failureMessage(undefined, code ?? killSignal, stderr)))
            return
          }
          if (parsed.is_error === true || code !== 0) {
            reject(new Error(failureMessage(parsed, code, stderr)))
            return
          }
          const usage = parsed.usage ?? {}
          resolve({
            result: typeof parsed.result === 'string' ? parsed.result : '',
            model: typeof parsed.model === 'string' ? parsed.model : (model ?? ''),
            mode: effectiveMode,
            costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0,
            durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : Date.now() - startedAt,
            inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
            outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
          })
        })
      })
    },
  })
}
