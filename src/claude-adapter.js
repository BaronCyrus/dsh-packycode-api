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
 * system prompt is dropped in favour of the CLI's own.
 *
 * @module dsh-packycode-api/claude-adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/** Models this route serves through the CLI rather than an HTTP API. */
export const CLI_BACKED_MODEL_IDS = Object.freeze(['claude-opus-5-5'])

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
 * Wrap an adapter so the CLI-backed models run through the local CLI.
 *
 * @param options - the inner adapter, the CLI runner, the CLI-backed model ids,
 *   and the mode and working directory each turn runs with.
 * @returns an adapter with the same provider surface.
 */
export function createClaudeCliAdapter({ inner, runner, modelIds = CLI_BACKED_MODEL_IDS, resolveMode, resolveCwd }) {
  if (inner === undefined || inner === null) throw new Error('the CLI adapter needs an inner adapter')
  if (runner === undefined || runner === null) throw new Error('the CLI adapter needs a runner')
  const cliModels = new Set(modelIds)
  /** The mode is read per turn so a settings change applies without a reload. */
  const modeOf = () => (typeof resolveMode === 'function' ? resolveMode() : undefined)
  const cwdOf = () => (typeof resolveCwd === 'function' ? resolveCwd() : undefined)

  async function* cliStream(options) {
    let prompt
    let cwd
    try {
      cwd = cwdOf()
      prompt = renderDelegatedPrompt(options, cwd)
    } catch (error) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: String(error?.message ?? error) } } }
      return
    }
    try {
      let finished
      for await (const event of runner.stream({
        prompt,
        mode: modeOf(),
        model: options.model,
        cwd,
        signal: options.signal,
      })) {
        if (event.type === 'text' && event.text !== '') {
          yield { type: 'text-delta', index: 0, text: event.text }
        } else if (event.type === 'result') {
          finished = event.result
        }
      }
      yield {
        type: 'usage',
        usage: {
          inputTokens: finished?.inputTokens ?? 0,
          outputTokens: finished?.outputTokens ?? 0,
        },
      }
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
