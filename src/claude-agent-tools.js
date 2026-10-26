/**
 * DSH's side of the cc route: Claude Code's tool calls as DSH tool calls.
 *
 * Each tool call Claude Code makes reaches DSH as a call of the `claude_code`
 * mirror tool, registered in the calling agent's own scope. DSH shows it like
 * its own tools (a terminal for Bash, a diff for an edit) and runs its
 * permission policy on it: when Claude Code asks for permission, the call asks
 * DSH's user — or DSH's Auto review — and the answer goes back to the CLI. The
 * CLI executes the call itself; the mirror only waits for its result and
 * shows it. Claude Code's questions are put to DSH's question UI, and its plan
 * mode follows DSH's.
 *
 * @module dsh-packycode-api/claude-agent-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { sessionUuid } from './claude-api.js'
import { MIRROR_TOOL, toolResultText } from './claude-cli-session.js'
import { claudePermissionMode } from './claude-permission-mode.js'

export { MIRROR_TOOL }

/** DSH's Auto review preset: the review answers what the CLI asks about. */
const AUTO_PRESET = 'auto'
/** Claude Code tools DSH answers with its own UI rather than an approval prompt. */
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'EnterPlanMode'])
const GONE = 'This Claude Code tool call can no longer continue: its Claude Code CLI process has ended. Send the request again to resume the session.'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const short = (value, limit = 300) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit)

/** The salient part of a Claude Code tool call, for titles and approval prompts. */
function subjectOf(tool, input) {
  const value = record(input) ? input : {}
  return value.command ?? value.file_path ?? value.notebook_path ?? value.url ?? value.pattern ?? value.query ?? value.description ?? value.path ?? undefined
}

/**
 * What DSH shows while a Claude Code tool call is pending.
 * @param args - the mirror call's `{ tool, input }`.
 * @returns a terminal, diff or generic card.
 */
export function presentClaudeCall(args) {
  const tool = String(args?.tool ?? 'tool')
  const input = record(args?.input) ? args.input : {}
  const path = typeof input.file_path === 'string' ? input.file_path : undefined
  if (tool === 'Bash' && typeof input.command === 'string') {
    return { card: 'terminal', title: input.command, ...(typeof input.description === 'string' ? { description: input.description } : {}) }
  }
  if (tool === 'Edit' && path !== undefined) {
    return { card: 'diff', title: `Edit ${path}`, diffs: [{ path, oldText: String(input.old_string ?? ''), newText: String(input.new_string ?? '') }], locations: [{ path }] }
  }
  if (tool === 'MultiEdit' && path !== undefined && Array.isArray(input.edits)) {
    return { card: 'diff', title: `Edit ${path}`, diffs: input.edits.map(edit => ({ path, oldText: String(edit?.old_string ?? ''), newText: String(edit?.new_string ?? '') })), locations: [{ path }] }
  }
  if (tool === 'Write' && path !== undefined) {
    return { card: 'diff', title: `Write ${path}`, diffs: [{ path, oldText: null, newText: String(input.content ?? '') }], locations: [{ path }] }
  }
  if (tool === 'Read' && path !== undefined) {
    return { card: 'generic', title: `Read ${path}`, kind: 'read', locations: [{ path, ...(Number.isSafeInteger(input.offset) && input.offset > 0 ? { line: input.offset } : {}) }] }
  }
  if (tool === 'Glob' || tool === 'Grep') return { card: 'generic', title: `${tool} ${short(input.pattern)}`, kind: 'search', rawInput: input }
  if (tool === 'WebFetch' || tool === 'WebSearch') return { card: 'generic', title: `${tool} ${short(input.url ?? input.query)}`, kind: 'fetch' }
  if (tool === 'AskUserQuestion') return { card: 'generic', title: short(input.questions?.[0]?.question ?? 'AskUserQuestion'), kind: 'other' }
  const subject = subjectOf(tool, input)
  return { card: 'generic', title: subject === undefined ? tool : `${tool} ${short(subject, 120)}`, kind: 'other', rawInput: input }
}

/**
 * What DSH shows once a Claude Code tool call has finished.
 * @param args - the mirror call's `{ tool, input }`.
 * @param result - DSH's durable result projection.
 * @returns a terminal or diff card, or undefined for the raw result.
 */
export function presentClaudeResult(args, result) {
  const call = presentClaudeCall(args)
  if (call.card === 'terminal') return { card: 'terminal', output: toolResultText(result?.content) }
  if (call.card === 'diff' && result?.isError !== true) return { card: 'diff', diffs: call.diffs }
  return undefined
}

/**
 * The reason DSH's approval prompt gives for one Claude Code permission prompt.
 * @param request - the CLI's `can_use_tool` request (tool name and input).
 * @returns `{ reason, displayReason }` as DSH's approval takes them.
 */
export function approvalReason(request) {
  const tool = String(request?.tool_name ?? request?.display_name ?? 'tool')
  const subject = subjectOf(tool, request?.input) ?? request?.blocked_path ?? request?.description
  const detail = subject === undefined ? tool : `${tool}: ${short(subject)}`
  return {
    reason: `Claude Code asks to run ${detail}. Claude Code runs it on this device itself, outside DeepSeek Harness's sandbox.`,
    displayReason: {
      zh: `Claude Code 请求执行 ${detail}。这一步由本机的 Claude Code 直接执行，不经过 DSH 的沙箱。`,
      en: `Claude Code asks to run ${detail}. Claude Code runs it on this device directly, outside DSH's sandbox.`,
    },
  }
}

/** DSH's refusal of a call, in the words Claude Code reads. */
export function refusalMessage(result) {
  const text = toolResultText(result?.content).replace(/^Error:\s*/u, '').trim()
  if (/rejected tool/iu.test(text)) return 'The user rejected this call in DeepSeek Harness.'
  if (/cancel|abort/iu.test(text)) return 'DeepSeek Harness cancelled this call.'
  return `DeepSeek Harness did not allow this call${text === '' ? '.' : `: ${text}`}`
}

/** Claude Code's AskUserQuestion questions as DSH's question service takes them. */
export function questionsFor(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : []
  return questions.map((question, index) => ({
    id: `q${index + 1}`,
    question: String(question?.question ?? ''),
    ...(typeof question?.header === 'string' && question.header !== '' ? { header: question.header } : {}),
    ...(Array.isArray(question?.options) && question.options.length > 0
      ? { options: question.options.map(option => ({ label: String(option?.label ?? ''), ...(typeof option?.description === 'string' && option.description !== '' ? { description: option.description } : {}) })) }
      : {}),
    ...(question?.multiSelect === true ? { multiSelect: true } : {}),
  }))
}

/** DSH's answer batch as the `answers` Claude Code's AskUserQuestion takes. */
export function answersFor(input, answer) {
  const answers = {}
  const questions = Array.isArray(input?.questions) ? input.questions : []
  questions.forEach((question, index) => {
    const item = answer?.answers?.find(entry => entry?.id === `q${index + 1}`)
    const custom = typeof item?.custom === 'string' ? item.custom.trim() : ''
    const value = custom !== '' ? custom : (Array.isArray(item?.selected) ? item.selected : []).join(', ')
    if (value !== '') answers[String(question?.question ?? '')] = value
  })
  return answers
}

/**
 * Create the bridge.
 * @param options - the CLI transport, a reader of the DSH services an agent
 *   uses (`services(agent)` → `userQuestions`, `planMode`, `permissionPresets`,
 *   `approval`; on the Web surface plan mode lives in the agent's preset), and
 *   a logger.
 * @returns `{ attach(agent), detach(agent), isAttached(agent), permissionModes(agent), nestedPermission(key, request) }`.
 */
export function createClaudeAgentBridge({ transport, services = () => ({}), logger } = {}) {
  /** Per agent: its transport key, the calls it executed, and the disposer of its mirror tool. */
  const attached = new WeakMap()
  /** Live agents by CLI-transport key, for prompts about calls DSH was never shown. */
  const agents = new Map()

  const presetOf = agent => {
    try { return services(agent).permissionPresets?.current?.(agent.session) } catch { return undefined }
  }

  const mirrorTool = (key, executed) => defineTool({
    name: MIRROR_TOOL,
    description: 'Shows one tool call Claude Code made in a PackyCode cc session, which Claude Code runs itself. Only the PackyCode plugin uses this tool; never call it yourself.',
    parameters: {
      tool: { type: 'string', required: true, description: 'The Claude Code tool name.' },
      input: { type: 'object', required: true, additionalProperties: true, description: 'The Claude Code tool input.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    isConcurrencySafe: () => true,
    presentCall: args => presentClaudeCall(args),
    presentResult: (args, result) => presentClaudeResult(args, result),
    async execute(_args, exec) {
      const call = transport.toolCall(key, exec.callId)
      if (call === undefined) throw new Error(GONE)
      executed.add(exec.callId)
      // DSH cancelled the turn: Claude Code stops its own work too.
      const onAbort = () => { void transport.interrupt(key) }
      exec.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        if (call.name === 'AskUserQuestion') await askUser(call, exec)
        else {
          if (call.name === 'EnterPlanMode') {
            try { services(exec.agent).planMode?.set?.(exec.agent, true) } catch { /* the CLI still plans; DSH shows it as ordinary turns */ }
          }
          call.allow()
        }
        const result = await call.result(exec.signal)
        const text = toolResultText(result.content)
        if (result.isError) throw new Error(text === '' ? 'Claude Code reported an error for this call.' : text)
        return { content: text }
      } finally {
        exec.signal?.removeEventListener('abort', onAbort)
      }
    },
  })

  /** Put Claude Code's questions to DSH's question UI and pass the answers back. */
  const askUser = async (call, exec) => {
    const service = services(exec.agent).userQuestions
    const questions = questionsFor(call.input)
    if (typeof service?.ask !== 'function' || questions.length === 0) {
      const message = 'DeepSeek Harness has no way to ask the user here; continue with your best judgment and say what you assumed.'
      call.deny(message)
      throw new Error(message)
    }
    let answer
    try {
      answer = await service.ask({ questions, agent: exec.agent, signal: exec.signal })
    } catch (error) {
      call.deny(`The user did not answer in DeepSeek Harness (${short(error?.message ?? error, 200)}); continue without the answer.`)
      throw error
    }
    call.allow({ ...call.input, answers: answersFor(call.input, answer) })
  }

  return Object.freeze({
    /**
     * Give an agent the mirror tool and its permission bridge. Both live in
     * the agent's own scope and unwind with it; attaching again after
     * {@link detach} only registers the tool again.
     * @param agent - the DSH agent a cc Claude request runs for.
     */
    attach(agent) {
      if (agent === undefined || agent.ctx?.tools === undefined) return
      const known = attached.get(agent)
      if (known !== undefined) {
        known.dispose ??= agent.ctx.tools.register(mirrorTool(known.key, known.executed))
        return
      }
      const key = sessionUuid(agent.id)
      agents.set(key, new WeakRef(agent))
      const executed = new Set()
      attached.set(agent, { key, executed, dispose: agent.ctx.tools.register(mirrorTool(key, executed)) })
      agent.ctx.on('tools/pre-execute', async (exec, next) => {
        if (exec.name !== MIRROR_TOOL) return next()
        const downstream = await next()
        if (downstream.kind !== 'allow') return downstream
        const call = transport.toolCall(key, exec.callId)
        if (call === undefined) return { kind: 'deny', reason: GONE }
        if (INTERACTIVE_TOOLS.has(call.name)) return { kind: 'allow' }
        let decision
        try { decision = await call.decision(exec.signal) } catch { return exec.signal?.aborted ? { kind: 'cancel' } : { kind: 'deny', reason: GONE } }
        // Claude Code ran or settled the call itself, or Auto review already judged it.
        if (decision !== 'ask' || presetOf(agent) === AUTO_PRESET) return { kind: 'allow' }
        return { kind: 'ask', ...approvalReason(call.request ?? { tool_name: call.name, input: call.input }) }
      })
      agent.ctx.on('tools/result', (exec, result) => {
        if (exec.name !== MIRROR_TOOL) return
        // DSH cancelled the turn: Claude Code stops its own work too.
        if (exec.signal?.aborted) void transport.interrupt(key)
        if (executed.has(exec.callId)) return
        // DSH refused or cancelled the call before it ran: Claude Code must not run it.
        transport.toolCall(key, exec.callId)?.deny(refusalMessage(result))
      })
      logger?.debug?.('packycode-api: Claude Code tools attached to %s', agent.id)
    },
    /**
     * Withdraw the mirror tool from an agent that moved to another model, so
     * that model is not offered it.
     * @param agent - the DSH agent.
     */
    detach(agent) {
      const known = agent === undefined ? undefined : attached.get(agent)
      if (known?.dispose === undefined) return
      try { known.dispose() } catch { /* the agent's scope already unwound */ }
      known.dispose = undefined
    },
    /** Whether an agent currently has the mirror tool. */
    isAttached: agent => attached.get(agent)?.dispose !== undefined,
    /**
     * The Claude Code permission mode for an agent's next step, and the one
     * to switch to when a plan is approved.
     * @param agent - the DSH agent.
     * @returns `{ permissionMode, approvedMode }`.
     */
    permissionModes(agent) {
      const service = services(agent)
      let planActive = false
      try { planActive = service.planMode?.get?.(agent)?.active === true } catch { /* no plan mode in this profile */ }
      const preset = presetOf(agent)
      const spec = preset === undefined ? undefined : service.permissionPresets?.presets?.[preset]
      const base = { preset, sandbox: spec?.sandbox, approval: spec?.approval }
      return { permissionMode: claudePermissionMode({ ...base, planActive }), approvedMode: claudePermissionMode(base) }
    },
    /**
     * Ask DSH about a call it was never shown (a subagent's), without a card.
     * @param key - the CLI-transport key of the session.
     * @param request - the CLI's `can_use_tool` request.
     * @returns the answer for the CLI.
     */
    async nestedPermission(key, request) {
      const agent = agents.get(key)?.deref()
      const approval = agent === undefined ? undefined : services(agent).approval
      if (agent === undefined || typeof approval?.request !== 'function') return { behavior: 'deny', message: 'DeepSeek Harness has no way to ask the user about this call.' }
      try {
        const outcome = await approval.request({ agent, toolName: MIRROR_TOOL, ...approvalReason(request) })
        return outcome === 'allowed-once'
          ? { behavior: 'allow', updatedInput: record(request?.input) ? request.input : {} }
          : { behavior: 'deny', message: outcome === 'rejected' ? 'The user rejected this call in DeepSeek Harness.' : 'DeepSeek Harness did not allow this call.' }
      } catch (error) {
        return { behavior: 'deny', message: `DeepSeek Harness could not ask about this call (${short(error?.message ?? error, 200)}).` }
      }
    },
  })
}
