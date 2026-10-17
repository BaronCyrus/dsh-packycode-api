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

- Claude requests use one of two transports, chosen by the request key's PackyCode groups (or the user's pin): keys in `cc` send them through this device's official Claude Code CLI; every other key uses the plugin's HTTP Messages route. Both carry the same payload; neither has any fallback to the other, to another provider, or to another credential.
- The HTTP route's compatibility headers and session metadata do not load a CLI login or external configuration. Bearer authentication uses only the plugin's selected conversation key; images keep their separate credential record.
- DSH owns tool execution, permissions, plan mode, attachments and history on both routes. Wire tool aliases are restored only for tools offered on that request; unknown aliases are not decoded into host tools. Saved images from older CLI-backed sessions remain readable without executing their old tools.
- Captured client-policy refusals do not disable keys or switch providers or transports. The specific pre-stream anomalies covered by the HTTP route may replay the exact bytes and credential once; ordinary policy refusals, HTTP 429 and accepted streams are excluded. Cancellation aborts the replay.

## The Claude Code CLI transport

- The CLI is a transport, not an agent: it runs with all of its own tools disabled (`--tools ""`), so it cannot read, write or execute anything itself. The tools it can see are the ones DSH offered for that request, served by an MCP bridge; every call is answered with the result DSH produced after running the tool under its own permissions and sandbox.
- The bridge is a per-process Streamable HTTP server bound to `127.0.0.1` on a random port. It requires a random 256-bit capability on every request, rejects foreign `Host` and `Origin` headers, and closes with its process. The capability lives only in an owner-only (`0600`) config file inside an owner-only run directory under the CLI home; it never appears in a command line.
- The CLI runs with an isolated config home (`~/.dsh/packycode-claude-cli`), `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`, and CLAUDE.md, auto-memory, auto-update, telemetry and non-essential traffic disabled. Inherited `ANTHROPIC_*`, `CLAUDE_*`, `MCP_*`, `DISABLE_*` and `ENABLE_*` variables are removed, so the user's own Claude Code login, API key, base URL, model and settings never reach it.
- The request key reaches the child only as `ANTHROPIC_AUTH_TOKEN` in its environment, with the endpoint as `ANTHROPIC_BASE_URL`; it is never written to a file, an argument, a transcript or a log. The DSH system prompt and the conversation transcript the CLI resumes are written to that owner-only run directory and removed when the process ends; directories left by a crashed host are removed after a day.
- The CLI's own retries, model fallback, refusal fallback and compaction are disabled: one DSH step is one API request, and retries follow DSH's policy. Processes are stopped on cancellation, after 20 idle minutes, beyond eight live conversations, and when the plugin unloads.
- Installing the CLI from the settings panel runs `npm install -g @anthropic-ai/claude-code` with constant arguments; on Windows the npm launcher is resolved to the program it forwards to, so no shell parses user text.

## Reporting

Report a security issue through the repository's GitHub issues rather than a public discussion of a live credential. Never paste a key, token, or credential-store value into an issue, a log, or a chat.
