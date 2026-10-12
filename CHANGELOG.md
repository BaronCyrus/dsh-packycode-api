# Changelog

## 0.1.0

First release.

- Ships a self-contained `packycode` LLM route: the plugin builds its own pi-ai provider, model catalog, retry policy, key ring, and balance reader, and registers them through `llm.registerAdapter`. Installing the package is the whole setup.
- Built-in catalog: `deepseek-flash` (openai-completions), `gpt-6.1-sol` (openai-responses), `claude-opus-5-5` (anthropic-messages), each pinned to the protocol and base URL the gateway serves and carrying the vendor's documented effort levels.
- Multiple API keys in one credential record, used in order. A key the gateway exhausts (`额度/余额/insufficient quota`) or rejects (401 / `无效的令牌`) is marked disabled and the active pointer moves to the next usable key, so the harness retry of the failed step resolves a different key.
- Route retry policy retries `QUOTA`, `AUTH`, and `INVALID_REQUEST` in addition to the defaults: the first two make rotation reachable, the last absorbs this gateway's misleading 400 when an upstream channel is dead.
- A Responses request without a `prompt_cache_key` is refused by the gateway's Codex-group check with 403. The harness supplies a session id; the plugin adds a per-process fallback when a caller does not.
- Balance display: the settings section lists every key with its available/used quota, reset period, and state; the composer shows the active key's remaining balance. Reads come from `/api/usage/token/` with a host fallback, plus the account's `/v1/dashboard/billing/*` pair.
- Validation: 39 offline tests (key ring, balance parsing and fallback, failure classification, catalog contract, stream guard, `apply()` wiring with and without a connection service, and the real `PiAiAdapter` resolving every advertised model and preparing its call). `scripts/live-check.mjs` verified against the live gateway: balance read, one answer from each of the three models, a rotation rehearsal with an invalid key in front of the real one, and the host adapter classifying the rejected key as `AUTH`.
- The plugin injects only `llm` and `credentials`; the browser RPC surface is requested through `ctx.inject(['connection'], …)`. An isolated end-to-end boot (headless profile in a scratch `DSH_HOME`) proved this matters: with `connection` in the inject list the entry stayed pending and the boot failed, and without it the same boot answered through `packycode/gpt-6.1-sol`.
