/**
 * The explicit `claude_code` delegation tool, for asking Claude Code for
 * something while another model drives the session. It shares the runner the
 * CLI-backed models use.
 *
 * @module dsh-packycode-api/claude-tool
 */

import { isAbsolute, join } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { CLAUDE_CLI_MODES, DEFAULT_CLAUDE_MODE } from './claude-cli.js'
import { capClaudeMode } from './permission.js'

/** What a `claude_code` tool run is told about where its task came from. */
export const CLAUDE_TOOL_INSTRUCTIONS = 'This task was delegated to Claude Code by another agent in DeepSeek Harness through its claude_code tool. The task text is self-contained; complete it with your own tools and reply with the final result only.'

/**
 * @param options - the CLI runner, and the most a run may do for a session.
 * @returns the tool definition to register.
 */
export function createClaudeCodeTool({ runner, modeCeiling }) {
  return defineTool({
    name: 'claude_code',
    description: 'Delegate a task to the local Claude Code CLI (the official `claude` binary), which runs it with its own tools and returns its final answer. Use it when the user asks for Claude or when a task suits Claude Code. The child runs with this plugin\'s PackyCode endpoint and API key, in an isolated config home. `mode` bounds what it may do on its own: "read-only" (Read/Grep/Glob), "edit" (also Edit/Write), "full" (bypasses the CLI\'s permission checks, including shell commands); it defaults to, and is capped at, what this session\'s permission preset allows. It starts a fresh CLI session per call, takes tens of seconds, and bills through this plugin\'s stored PackyCode keys. Web searches use the selected DeepSeek/GPT backend through a read-only MCP tool rather than native WebSearch. Its internal tool calls are not part of this session\'s transcript — only the returned answer is.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'The task for Claude Code, written as a self-contained instruction (it does not see this conversation).',
      },
      mode: {
        type: 'string',
        enum: Object.keys(CLAUDE_CLI_MODES),
        description: 'What the CLI may do on its own. Defaults to the most this session\'s permission preset allows; a wider mode is capped to it. Ask for "full" only when the task genuinely needs shell commands.',
      },
      model: {
        type: 'string',
        description: 'Model id passed to the CLI (for example "claude-opus-5-5", "claude-sonnet-5-5", or "claude-haiku-5-5"). Omit to use the CLI\'s own default.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the CLI. Defaults to this session\'s workspace; a relative path resolves against it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          result: { type: 'string', required: true },
          model: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          costUsd: { type: 'number', required: true },
          durationMs: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.result}\n\n— Claude Code CLI · ${value.model || 'default model'} · ${value.mode} · ${Math.round(value.durationMs / 1000)}s · $${value.costUsd.toFixed(4)}`,
      }],
    },
    async execute(args, exec) {
      const sessionCwd = exec?.agent?.session?.header?.cwd
      const requested = typeof args.cwd === 'string' ? args.cwd.trim() : ''
      const cwd = requested === ''
        ? sessionCwd
        : isAbsolute(requested) ? requested : (sessionCwd === undefined ? requested : join(sessionCwd, requested))
      return await runner.run({
        prompt: args.prompt,
        mode: capClaudeMode(args.mode, modeCeiling(exec?.agent?.session)) ?? DEFAULT_CLAUDE_MODE,
        model: args.model,
        appendSystemPrompt: CLAUDE_TOOL_INSTRUCTIONS,
        cwd,
        signal: exec?.signal,
      })
    },
  })
}
