# Security

## Credentials

- API keys are stored through the DSH credential service as one `grant` record scoped to this plugin (`packycode-api/keys`), which lands in the local credentials file with the permissions DSH enforces (owner-only).
- Keys never enter the settings document, the session transcript, logs, or an error message. `src/key-ring.js` returns key material only through `secrets()`, which is callable from the host half alone.
- The browser receives key labels, states, and balances — never a key, and never a masked fragment of one. The RPC surface in `src/rpc.js` is the only way in.
- The plugin disables ambient discovery (`authContext.env` and `fileExists` resolve empty), so an exported `PACKY_CODE_API_KEY` cannot authenticate a request behind the user's back.
- There is no fallback to another provider, another credential, or an unauthenticated request. When every stored key is disabled, the request fails with a message that says so.

## Network

- Balance requests carry a timeout (`AbortSignal.timeout`) and `redirect: 'error'`, and go only to the configured hosts plus the PackyAPI fallback host.
- Model traffic goes to the configured model host through the host's own pi-ai adapter, with the harness attribution headers, exactly like a configured provider route.

## Reporting

Report a security issue through the repository's GitHub issues rather than a public discussion of a live credential. Never paste a key, token, or credential-store value into an issue, a log, or a chat.
