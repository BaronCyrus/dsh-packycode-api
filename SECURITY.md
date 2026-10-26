# Security

## Credentials

- API keys are stored through the DSH credential service as one `grant` record scoped to this plugin (`packycode-api/keys`), which lands in the local credentials file with the permissions DSH enforces (owner-only).
- Keys never enter the settings document, the session transcript, logs, or an error message. `src/key-ring.js` returns key material only through `secrets()`, which is callable from the host half alone.
- The browser receives key labels, states, and balances — never a key, and never a masked fragment of one. The RPC surface in `src/rpc.js` is the only way in.
- The plugin disables ambient discovery (`authContext.env` and `fileExists` resolve empty), so an exported `PACKY_CODE_API_KEY` cannot authenticate a request behind the user's back.
- There is no fallback to another provider, another credential, or an unauthenticated request. When every stored key is disabled, the request fails with a message that says so.

## Network

- Balance requests carry a timeout (`AbortSignal.timeout`) and `redirect: 'error'`, and go only to the configured hosts plus the PackyAPI fallback host.
- Model traffic goes to the configured model host through the plugin's pi-ai adapter. Protocol-specific compatibility headers are applied host-side; credentials remain scoped to the selected plugin key.

## Claude requests

- Claude requests use one of two routes, chosen only by the request key's PackyCode groups: on keys in `cc`, and on a key whose groups are not read yet, this device's official Claude Code CLI carries out the session as the agent; every other key uses the plugin's HTTP Messages route with DSH's own agent. A turn that starts on the CLI finishes there. Neither route has any fallback to the other after a failure, to another provider, or to another credential.
- The HTTP route's compatibility headers and session metadata do not load a CLI login or external configuration. Bearer authentication uses only the plugin's selected conversation key; images keep their separate credential record.
- On the HTTP route DSH owns tool execution, permissions, plan mode, attachments and history. Wire tool aliases are restored only for tools offered on that request; unknown aliases are not decoded into host tools. Saved images from older CLI-backed sessions remain readable without executing their old tools.
- Captured client-policy refusals do not disable keys or switch providers or transports. The specific pre-stream anomalies covered by the HTTP route may replay the exact bytes and credential once; ordinary policy refusals, HTTP 429 and accepted streams are excluded. Cancellation aborts the replay.

## The Claude Code CLI route

- Claude Code is the agent: it runs with its own system prompt and its own tools, so it reads, writes and executes on this device itself, with the user's privileges and outside DSH's sandbox. The plugin never adds DSH's prompt or tools to it, and of DSH's messages it passes on only the user's own (DSH's runtime context, skill catalog, `AGENTS.md` and notices stay in DSH).
- Every permission prompt it sends (`--permission-prompt-tool stdio`) is answered by DSH: the call appears as a `claude_code` tool card, and DSH's approval — the user, or Auto review under the `auto` preset — decides it under the session's permission preset. The CLI's permission mode follows that preset: plan mode is `plan`, `workspace-write` is `acceptEdits`, `read-only` and `auto` are `default`, and only `danger-full-access` (approval `never`) is `bypassPermissions`, which asks nothing. A refusal is passed back with its reason and the call does not run. Calls the CLI allows by itself (reads, read-only commands) run without a prompt and are shown afterwards. Prompts about calls DSH never showed (a subagent's) go to DSH's approval without a card. Plans go to DSH's plan review and questions to DSH's question UI; the plugin never answers a prompt on its own.
- The CLI runs with an isolated config home (`~/.dsh/packycode-claude-cli`), `--setting-sources user` (only that home's settings: never `~/.claude` or a project's `.claude/settings.json` and hooks) and `--strict-mcp-config` with no servers (never a project's `.mcp.json`), so a repository cannot point the CLI at another endpoint or run hooks with the key. Auto-memory, background tasks, auto-update, telemetry and non-essential traffic are disabled. Inherited `ANTHROPIC_*`, `CLAUDE_*`, `MCP_*`, `DISABLE_*` and `ENABLE_*` variables are removed, so the user's own Claude Code login, API key, base URL, model and settings never reach it. A project's `CLAUDE.md` is read as Claude Code always reads it.
- The request key reaches the child only as `ANTHROPIC_AUTH_TOKEN` in its environment, with the endpoint as `ANTHROPIC_BASE_URL`; it is never written to a file, an argument, a transcript or a log. Claude Code keeps its own session records and plan files in the CLI home's `projects/dsh-packycode` and `plans` directories; when a session is rebuilt from DSH's history, the plugin writes that transcript there as an owner-only (`0600`) file. `dsh-sessions.json` maps DSH sessions to Claude Code sessions by ids and response fingerprints only.
- The CLI's own retries and model and refusal fallbacks are disabled: one DSH step is one API request, and retries follow DSH's policy. Turns Claude Code would start on its own (scheduled prompts) are interrupted, because DSH could not show them. Processes are stopped on cancellation, after 20 idle minutes, beyond eight live conversations, and when the plugin unloads.
- Installing the CLI from the settings panel runs `npm install -g @anthropic-ai/claude-code` with constant arguments; on Windows the npm launcher is resolved to the program it forwards to, so no shell parses user text.

## Reporting

Report a security issue through the repository's GitHub issues rather than a public discussion of a live credential. Never paste a key, token, or credential-store value into an issue, a log, or a chat.
