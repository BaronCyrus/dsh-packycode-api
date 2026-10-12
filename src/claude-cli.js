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
 * @param options - the prompt, the permission mode, an optional model, and
 *   whether the caller consumes the streaming protocol.
 * @returns argv after the binary name.
 */
export function buildClaudeArgs({ prompt, mode = DEFAULT_CLAUDE_MODE, model, stream = false } = {}) {
  const text = typeof prompt === 'string' ? prompt : ''
  if (text.trim() === '') throw new Error('claude_code needs a non-empty prompt')
  if (text.length > MAX_PROMPT_CHARS) {
    throw new Error(`claude_code prompt is too long (${text.length} > ${MAX_PROMPT_CHARS} characters)`)
  }
  const spec = CLAUDE_CLI_MODES[mode]
  if (spec === undefined) {
    throw new Error(`claude_code mode must be one of ${Object.keys(CLAUDE_CLI_MODES).join(', ')}`)
  }
  const args = ['-p', text, '--output-format', stream ? 'stream-json' : 'json']
  if (stream) args.push('--include-partial-messages', '--verbose')
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
 * Read one `--output-format stream-json` event.
 * @param event - a parsed stream-json line.
 * @returns what the caller can act on, or undefined for noise.
 */
export function readClaudeStreamEvent(event) {
  if (event === null || typeof event !== 'object') return undefined
  if (event.type === 'stream_event') {
    const inner = event.event
    if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') {
      return { type: 'text', text: inner.delta.text }
    }
    return undefined
  }
  if (event.type === 'result') return { type: 'result', result: event }
  return undefined
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

  /**
   * Spawn one CLI process and own its lifetime: capture both pipes, enforce the
   * timeout, and kill the process — with a grace period — when the caller
   * aborts. Both public entry points share it.
   */
  const start = async ({ prompt, mode, model, cwd, signal, stream, onStdout }) => {
    const args = buildClaudeArgs({ prompt, mode, model, stream })
    const { baseUrl, token } = await resolveCredential()
    const env = buildClaudeEnvironment({ baseUrl, token, configDir })
    const child = spawnImpl(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const state = { stdout: '', stderr: '', timedOut: false, settled: false }
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
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        state.timedOut = true
        kill()
      }, timeoutMs)
      : undefined
    timer?.unref?.()
    const onAbort = () => kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    const release = () => {
      if (state.settled) return
      state.settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    // Both pipes are owned here: a caller that awaits before attaching would
    // otherwise miss the first chunks a fast CLI writes.
    child.stdout?.on('data', chunk => {
      const text = String(chunk)
      state.stdout = (state.stdout + text).slice(-MAX_CAPTURE_BYTES)
      onStdout?.(text)
    })
    child.stderr?.on('data', chunk => {
      state.stderr = (state.stderr + String(chunk)).slice(-MAX_CAPTURE_BYTES)
    })
    const closed = new Promise((resolve, reject) => {
      child.on('error', error => {
        release()
        reject(new Error(`claude_code could not run ${binary}: ${error.message}`, { cause: error }))
      })
      child.on('close', (code, killSignal) => {
        release()
        if (state.timedOut) {
          reject(new Error(`claude_code timed out after ${Math.round(timeoutMs / 1000)}s`))
          return
        }
        if (signal?.aborted === true) {
          reject(new Error('claude_code was aborted'))
          return
        }
        resolve({ code, killSignal })
      })
    })
    closed.catch(() => undefined)
    return { child, state, closed }
  }

  return Object.freeze({
    /**
     * Run one delegated task to completion, reading only its final result.
     * @param options - prompt, mode, model, working directory, and cancellation.
     * @returns the CLI's answer plus its own accounting.
     */
    async run({ prompt, mode = DEFAULT_CLAUDE_MODE, model, cwd, signal } = {}) {
      const startedAt = Date.now()
      const { state, closed } = await start({ prompt, mode, model, cwd, signal, stream: false })
      const { code, killSignal } = await closed
      const parsed = parseClaudeResult(state.stdout)
      if (parsed === undefined) throw new Error(failureMessage(undefined, code ?? killSignal, state.stderr))
      if (parsed.is_error === true || code !== 0) throw new Error(failureMessage(parsed, code, state.stderr))
      const usage = parsed.usage ?? {}
      return {
        result: typeof parsed.result === 'string' ? parsed.result : '',
        model: typeof parsed.model === 'string' ? parsed.model : (model ?? ''),
        mode,
        costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0,
        durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : Date.now() - startedAt,
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      }
    },

    /**
     * Run one delegated task, yielding its answer as the CLI produces it.
     * The final `result` event carries the CLI's own accounting.
     * @param options - as {@link run}.
     * @returns an async generator of `text` and one closing `result` event.
     */
    async *stream({ prompt, mode = DEFAULT_CLAUDE_MODE, model, cwd, signal } = {}) {
      const startedAt = Date.now()
      let buffer = ''
      let sawResult
      const lines = []
      const { state, closed } = await start({
        prompt,
        mode,
        model,
        cwd,
        signal,
        stream: true,
        onStdout: chunk => {
          buffer += chunk
          let index = buffer.indexOf('\n')
          while (index !== -1) {
            lines.push(buffer.slice(0, index))
            buffer = buffer.slice(index + 1)
            index = buffer.indexOf('\n')
          }
        },
      })
      const drain = function* () {
        while (lines.length > 0) {
          const line = lines.shift().trim()
          if (line === '' || !line.startsWith('{')) continue
          let parsed
          try {
            parsed = JSON.parse(line)
          } catch {
            continue
          }
          const event = readClaudeStreamEvent(parsed)
          if (event === undefined) continue
          if (event.type === 'result') sawResult = event.result
          yield event
        }
      }
      let finished = false
      const completion = closed.then(() => {
        finished = true
      }, error => {
        finished = true
        throw error
      })
      completion.catch(() => undefined)
      while (!finished || lines.length > 0) {
        if (lines.length === 0) {
          if (finished) break
          await new Promise(resolve => setTimeout(resolve, 15))
          continue
        }
        yield* drain()
      }
      await completion
      if (buffer.trim().startsWith('{')) {
        try {
          const event = readClaudeStreamEvent(JSON.parse(buffer.trim()))
          if (event?.type === 'result') sawResult = event.result
        } catch {
          // A truncated tail is not a result.
        }
      }
      if (sawResult === undefined) {
        throw new Error(failureMessage(undefined, undefined, state.stderr))
      }
      if (sawResult.is_error === true) throw new Error(failureMessage(sawResult, 0, state.stderr))
      const usage = sawResult.usage ?? {}
      yield {
        type: 'result',
        result: {
          result: typeof sawResult.result === 'string' ? sawResult.result : '',
          model: typeof sawResult.model === 'string' ? sawResult.model : (model ?? ''),
          mode,
          costUsd: typeof sawResult.total_cost_usd === 'number' ? sawResult.total_cost_usd : 0,
          durationMs: typeof sawResult.duration_ms === 'number' ? sawResult.duration_ms : Date.now() - startedAt,
          inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
          outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
        },
      }
    },
  })
}
