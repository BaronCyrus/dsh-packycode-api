/**
 * Route Claude models through the local Claude Code CLI.
 *
 * PackyCode's `cc` group serves its Claude models only to the official CLI, so
 * selecting one of those models runs that CLI instead of an HTTP request. The
 * other models on the route keep using the pi-ai adapter untouched — this
 * adapter only dispatches.
 *
 * A CLI-backed turn is a *delegation*: the CLI runs its own agent loop with
 * its own tools and returns one answer. The CLI cannot call the harness's
 * tools, so `options.tools` is deliberately not forwarded, and the harness's
 * system prompt is dropped in favour of the CLI's own. While it works, its
 * thinking and tool activity stream into a reasoning block and its answer
 * streams as text.
 *
 * A session-title request is not a delegation: it runs on the small model,
 * read-only and outside the workspace, with the title instructions appended,
 * so naming a session does not cost an Opus agent turn.
 *
 * @module dsh-packycode-api/claude-adapter
 */

import { tmpdir } from 'node:os'

import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/** Models this route serves through the CLI rather than an HTTP API. */
export const CLI_BACKED_MODEL_IDS = Object.freeze(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])

/** The model a session title is generated with when the session runs on the CLI. */
export const TITLE_MODEL_ID = 'claude-haiku-5-5'

/** How much of the conversation a delegated prompt carries. */
const MAX_PROMPT_CHARS = 48_000
const MAX_BLOCK_CHARS = 8_000

/** Render one content block as text a CLI prompt can carry. */
function renderBlock(block) {
  if (block === null || typeof block !== 'object') return ''
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (block.type === 'image') return '[图片]'
  if (block.type === 'tool-call' || block.type === 'tool-call-delta') {
    return `[调用工具 ${block.name ?? block.id ?? ''}]`
  }
  if (block.type === 'tool-result') {
    const text = typeof block.content === 'string' ? block.content : ''
    return `[工具结果] ${text.slice(0, MAX_BLOCK_CHARS)}`
  }
  if (block.type === 'reasoning') return ''
  return ''
}

/**
 * Emit text and reasoning as well-formed harness blocks.
 *
 * The harness's stream grammar requires every delta to address an open block
 * of its own type, so each run of one kind is bracketed by `block-start` and
 * `block-end`. Tool progress goes into reasoning: the UI shows it live as the
 * turn's working process, and it never re-enters a later delegated prompt.
 */
function createBlockWriter() {
  let index = -1
  let open
  const close = function* () {
    if (open === undefined) return
    yield { type: 'block-end', index, block: { type: open.kind, text: open.text } }
    open = undefined
  }
  const write = function* (kind, text) {
    if (typeof text !== 'string' || text === '') return
    if (open?.kind !== kind) {
      yield* close()
      index += 1
      open = { kind, text: '' }
      yield { type: 'block-start', index, blockType: kind }
    }
    open.text += text
    yield { type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index, text }
  }
  return {
    /** A CLI content block started; the next write opens a fresh harness block. */
    boundary(kind) {
      if (open !== undefined && open.kind === kind) open.sealed = true
    },
    *write(kind, text) {
      if (open?.sealed === true) yield* close()
      yield* write(kind, text)
    },
    *note(line) {
      const separator = open?.kind === 'reasoning' && open.text !== '' && !open.text.endsWith('\n') ? '\n' : ''
      if (open?.kind === 'reasoning') open.sealed = false
      yield* write('reasoning', `${separator}${line}`)
    },
    close,
  }
}

/**
 * The turn's usage in the harness's disjoint buckets.
 *
 * The prompt side is the CLI's *last* request — the context it actually
 * occupied and how much of it hit the cache — because the harness reads the
 * prompt side as context pressure, and summing a multi-step CLI turn would
 * count the same context once per step. Output is the CLI's whole-turn total.
 */
function turnUsage(lastRequest, finished) {
  const outputTokens = finished?.outputTokens ?? 0
  if (lastRequest !== undefined) {
    return {
      inputTokens: lastRequest.inputTokens,
      outputTokens,
      cacheReadTokens: lastRequest.cacheReadTokens,
      cacheWriteTokens: lastRequest.cacheWriteTokens,
    }
  }
  return {
    inputTokens: finished?.inputTokens ?? 0,
    outputTokens,
    cacheReadTokens: finished?.cacheReadTokens ?? 0,
    cacheWriteTokens: finished?.cacheWriteTokens ?? 0,
  }
}

/**
 * Turn an assembled request into one CLI prompt.
 *
 * The leading system message carries the harness's system prompt, which
 * describes tools this model cannot call; the CLI brings its own instead.
 * @param options - the assembled request.
 * @param cwd - the working directory the CLI will run in, when known.
 * @returns the prompt text.
 */
export function renderDelegatedPrompt(options, cwd) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  const turns = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role === 'system') continue
    const content = Array.isArray(message.content) ? message.content : []
    const text = content.map(renderBlock).filter(part => part !== '').join('\n').trim()
    if (text === '') continue
    const label = message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : String(message.role)
    turns.push(`${label}：${text}`)
  }
  let transcript = turns.join('\n\n')
  if (transcript.length > MAX_PROMPT_CHARS) {
    transcript = `…（较早对话已截断）\n\n${transcript.slice(-MAX_PROMPT_CHARS)}`
  }
  const system = typeof options?.system === 'string' && options.system.trim() !== '' ? options.system.trim() : ''
  const header = [
    '[本回合由 DeepSeek Harness 委派给 Claude Code CLI 执行。请用你自己的工具完成任务，'
      + '直接输出最终结果；不要反问、不要复述流程。]',
    cwd === undefined ? undefined : `[工作目录：${cwd}]`,
    system === '' ? undefined : `[补充说明：${system.slice(0, 2_000)}]`,
  ].filter(part => part !== undefined).join('\n')
  return `${header}\n\n${transcript}`.trim()
}

/**
 * The prompt of a one-shot auxiliary request: its messages' text, verbatim.
 * The caller frames its own input, so nothing is added around it.
 * @param options - the assembled request.
 * @returns the prompt text.
 */
export function renderAuxiliaryPrompt(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  return messages
    .filter(message => message !== null && typeof message === 'object' && message.role !== 'system')
    .flatMap(message => (Array.isArray(message.content) ? message.content : []))
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n\n')
    .trim()
}

/**
 * How one request runs on the CLI: a title request on the small model with
 * the caller's instructions appended, anything else as a delegated turn.
 *
 * The CLI's own system prompt and tool set stay in place even for a title:
 * they are part of what the gateway sees from the official client.
 */
function cliCall(options, { titleModel, cwdOf, modeOf }) {
  if (options?.purpose === 'session-title') {
    return {
      prompt: renderAuxiliaryPrompt(options),
      model: titleModel,
      mode: 'read-only',
      appendSystemPrompt: typeof options.system === 'string' ? options.system : undefined,
      // Outside the workspace, so the CLI loads no project memory into a title.
      cwd: tmpdir(),
    }
  }
  const cwd = cwdOf()
  return { prompt: renderDelegatedPrompt(options, cwd), model: options.model, mode: modeOf(), cwd }
}

/**
 * Wrap an adapter so the CLI-backed models run through the local CLI.
 *
 * @param options - the inner adapter, the CLI runner, the CLI-backed model ids,
 *   the model session titles run on, and the mode and working directory each
 *   turn runs with.
 * @returns an adapter with the same provider surface.
 */
export function createClaudeCliAdapter({ inner, runner, modelIds = CLI_BACKED_MODEL_IDS, titleModel = TITLE_MODEL_ID, resolveMode, resolveCwd }) {
  if (inner === undefined || inner === null) throw new Error('the CLI adapter needs an inner adapter')
  if (runner === undefined || runner === null) throw new Error('the CLI adapter needs a runner')
  const cliModels = new Set(modelIds)
  /** The mode is read per turn so a settings change applies without a reload. */
  const modeOf = () => (typeof resolveMode === 'function' ? resolveMode() : undefined)
  const cwdOf = () => (typeof resolveCwd === 'function' ? resolveCwd() : undefined)

  async function* cliStream(options) {
    let call
    try {
      call = cliCall(options, { titleModel, cwdOf, modeOf })
    } catch (error) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: String(error?.message ?? error) } } }
      return
    }
    const blocks = createBlockWriter()
    // The CLI may print a finished message more than once as it grows.
    const seen = new Set()
    const firstSighting = key => {
      if (key.endsWith(':')) return true
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }
    try {
      let finished
      let lastRequest
      for await (const event of runner.stream({ ...call, signal: options.signal })) {
        switch (event.type) {
          case 'block':
            blocks.boundary(event.kind)
            break
          case 'text':
            yield* blocks.write('text', event.text)
            break
          case 'reasoning':
            yield* blocks.write('reasoning', event.text)
            break
          case 'tool':
            if (firstSighting(`tool:${event.id}`)) yield* blocks.note(`▸ ${event.summary}\n`)
            break
          case 'tool-error':
            if (firstSighting(`error:${event.id}`)) yield* blocks.note(`  ✗ ${event.text === '' ? '失败' : event.text}\n`)
            break
          case 'request-usage':
            lastRequest = event.usage
            break
          case 'result':
            finished = event.result
            break
          default:
            break
        }
      }
      yield* blocks.close()
      yield { type: 'usage', usage: turnUsage(lastRequest, finished) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (error) {
      const message = String(error?.message ?? error)
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message } } }
    }
  }

  return new (class extends LlmAdapter {
    providerInfo(provider) {
      return inner.providerInfo(provider)
    }

    providerRetryPolicy(provider) {
      return inner.providerRetryPolicy?.(provider)
    }

    listModels(provider) {
      return inner.listModels(provider)
    }

    resolveModel(provider, model, signal) {
      return inner.resolveModel(provider, model, signal)
    }

    async prepareCall(provider, model, signal) {
      if (!cliModels.has(model)) return await inner.prepareCall(provider, model, signal)
      const resolved = await inner.resolveModel(provider, model, signal)
      return { model: resolved, stream: options => cliStream(options) }
    }

    stream(options) {
      return cliModels.has(options.model) ? cliStream(options) : inner.stream(options)
    }
  })()
}
