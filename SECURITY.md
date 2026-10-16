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

## Native Claude requests

- Claude uses the plugin's HTTP Messages route. The plugin has no Claude CLI runner, installer, delegation tool or local MCP bridge. Existing standalone Claude Code installations and configuration are untouched.
- The compatibility headers and session metadata do not load a CLI login or external configuration. Bearer authentication uses only the plugin's selected conversation key; images keep their separate credential record.
- DSH owns tool execution, permissions, plan mode, attachments and history. Wire tool aliases are restored only for tools offered on that request; unknown aliases are not decoded into host tools. Saved images from older CLI-backed sessions remain readable without executing their old tools.
- Captured client-policy refusals do not disable keys or switch providers. The specific pre-stream anomalies covered by the native transport may replay the exact bytes and credential once; ordinary policy refusals, HTTP 429 and accepted streams are excluded. Cancellation aborts the replay.

## Reporting

Report a security issue through the repository's GitHub issues rather than a public discussion of a live credential. Never paste a key, token, or credential-store value into an issue, a log, or a chat.
