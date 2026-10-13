<div align="center">

<img src="docs/assets/dsh-packycode-mascot.png" width="220" height="220" alt="DSH PackyCode API mascot">

# DSH PackyCode API

[简体中文](README.md) · **English**

**Pick models, rotate keys, and read balances in DSH with a PackyCode API key.**

The `PackyCode` model group ships with the plugin. No YAML edits and no separate provider setup.

[![CI](https://github.com/BaronCyrus/dsh-packycode-api/actions/workflows/ci.yml/badge.svg)](https://github.com/BaronCyrus/dsh-packycode-api/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-packycode-api?logo=npm&label=npm)](https://www.npmjs.com/package/dsh-packycode-api)
[![Total npm downloads](https://img.shields.io/npm/dt/dsh-packycode-api?logo=npm&label=total%20downloads)](https://www.npmjs.com/package/dsh-packycode-api)
[![MIT](https://img.shields.io/badge/license-MIT-111111.svg)](LICENSE)
[![Star](https://img.shields.io/github/stars/BaronCyrus/dsh-packycode-api?style=flat&logo=github&label=Star)](https://github.com/BaronCyrus/dsh-packycode-api/stargazers)

[Features](#features) · [Install](#install) · [Daily use](#daily-use) · [Models and groups](#models-and-groups) · [Update and uninstall](#update-and-uninstall)

</div>

## Features

| Capability | What it does |
| --- | --- |
| **Built-in model route** | Adds a `PackyCode` group to the model picker. No provider configuration and no `cordis.patch.yml` edits |
| **Keys used in order** | An exhausted or rejected key is disabled and the next usable key takes over; the failed step is retried on that key |
| **Keys chosen by group** | Each key lists its PackyCode groups and the models they reach; when the active key's groups cannot reach the selected model (no `cc` group for Claude, say), that turn runs on a stored key whose groups can |
| **Visible balance** | Settings lists each key's remaining, used, limit, reset period, and a usage bar, plus a total of those keys. The composer shows the active key's remaining balance |
| **Claude through the local CLI** | `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5` run the official Claude Code CLI on this device. Settings can detect it and install it |
| **Web search through PackyCode** | Optional: DSH's `web_search` searches through PackyCode, with a DeepSeek or GPT backend, for every request or for PackyCode models only |
| **Credentials stay on the machine** | Keys live in the DSH credential file. The browser receives labels, state, and balances only |

## Install

You need **DeepSeek Harness** and a **PackyCode (PackyAPI) API key**. For DSH setup, see the [official instructions](https://github.com/deepseek-ai/deepseek-harness#run).

### 1. Install the plugin

Open the desktop application's **Plugins** page, click **Add plugin**, and enter this as the **package name or address**:

```text
dsh-packycode-api
```

Choose the **official** install source, then click **Install**. To pin a version, enter `dsh-packycode-api@1.1.1`.

Then **manually restart the desktop application**. Refreshing the page does not reload the plugin inside the Host process.

### 2. Add a key

Open **Settings → PackyCode**. Paste the API key under **Add a key**. A label is optional and only distinguishes keys. Click **Add**.

> Do not paste a key into a public issue, chat, or screenshot. The plugin does not read `PACKY_CODE_API_KEY` from the environment, and it does not silently switch to another provider when a request fails.

### 3. Select a model

Choose a model from the `PackyCode` group. `deepseek-flash`, `gpt-6.1-sol`, and `gpt-6-astra` work once a key is stored. The three Claude models also need the Claude Code CLI on this device; see below.

<details>
<summary>Verify the install / other profiles / a local checkout</summary>

The **Plugins** page shows the installed state and version, and is also where you enable, disable, or uninstall.

**For non-desktop profiles only:** `dsh plugin --profile <name> add dsh-packycode-api@1.1.1`. Do not use it for `desktop` — the CLI refuses it (`profile "desktop" is managed exclusively by the Electron application`).

A local checkout can be linked with `dsh plugin --profile <name> add link:/path/to/dsh-packycode-api`.

A profile without a browser can still use the model route. It just has no settings panel and no composer balance.

</details>

## Daily use

**Switch keys.** Keys are used in the order they were added. **Use this key** picks the preferred key, effective from the next turn; **Rename** changes its label (at most 60 characters, empty names are refused); **Re-enable** puts a disabled key back after a top-up or replacement.

**See groups.** Under **Accounts and keys**, each key lists its PackyCode groups (hover for the group's description) and which models they reach: ✓ yes, ◐ partly, ✕ no. The groups come from the gateway itself (its refusal of a model id it cannot route names the token's groups; nothing is billed), matched against PackyCode's public model-group table. Claude needs one of `cc` / `cc-sale` / `cc-expensive` / `claude-officially` (`claude-haiku-5-5` only `cc` and `claude-officially`); GPT needs `codex` / `codex-sale`; DeepSeek needs `deepseek-officially` / `deepseek-sale`.

**Read the balance.** The total at the top of **Accounts and keys** is the remaining, used, and limit of **the keys listed here**, not the bill for every token on the PackyCode account. A key that could not be read is left out of the total and counted in a note; a key whose read failed this time but succeeded before keeps showing its last balance with the time it was read (the composer shows it as `≈US$…`) until DSH restarts. The composer shows the active key's remaining balance only while a PackyCode model is selected. **Refresh** bypasses the roughly 60-second cache. The default model host is `https://cf.api.fan` and the balance host is `https://www.packyapi.ai`; both can be changed under **Advanced: endpoints**. The old default, `https://www.packyapi.com`, is DNS-poisoned on mainland networks and answers `fetch failed` without a proxy; even when settings still name it, `.ai` is tried first.

**Use Claude.** The **Claude Code CLI** card in Settings checks this device. Every Claude turn's reasoning block names the key it ran with (by label only). If the CLI is missing, **Install Claude Code CLI** runs `npm install -g @anthropic-ai/claude-code` (Node.js 18+). No DSH restart is required after that install. Windows also needs [Git for Windows](https://git-scm.com/downloads/win).

**Web search.** DSH's `web_search` calls DeepSeek's official API by default (billed to `DEEPSEEK_API_KEY`). **Settings → PackyCode → Web search** can route it through PackyCode instead:

| Routing | Effect |
| --- | --- |
| Do not take over (default) | DSH's search settings stay as they are |
| Auto (route by model) | PackyCode models search through PackyCode; other models keep their search |
| Always use PackyCode search | Every request DSH's default search would have served goes through PackyCode |

| Backend | Model and protocol | Notes |
| --- | --- | --- |
| DeepSeek (default) | `deepseek-flash`, `/v1/messages` + `web_search_20250305` | A few thousand tokens per search; needs a DeepSeek group |
| GPT | `gpt-6.1-sol`, `/v1/responses` + `web_search` | Usually fresher and more precise, about 20–30K input tokens per search; needs the gateway to route this key's GPT requests to its group |

PackyCode has no dedicated search endpoint: one search is one model call with a server-side search tool, billed to the keys stored here. An exhausted or rejected key rotates exactly as on the model route.

**Claude CLI search.** Both CLI-backed Claude models and the `claude_code` delegation tool use a temporary MCP search tool calling the DeepSeek/GPT backend selected above. Native `WebSearch` is disabled: it sends an additional Claude server-tool subrequest that PackyCode's Claude upstream may reject as an unofficial client even when ordinary turns work.

```text
Claude Code CLI → temporary local MCP web_search → selected PackyCode DeepSeek/GPT backend
```

- **Backend selection applies to CLI; routing selection only applies to DSH.** Even with Off/Do not take over selected, CLI searches use the selected backend, not DSH's default. A backend change applies to the next search.
- Ordinary Claude requests still need a Claude-group key. Search needs a plugin-stored key covering DeepSeek or GPT; it can be another key. Failures are returned to the CLI, with no invented success or automatic switch to another backend.
- Read-only/edit modes auto-approve only this specific read-only MCP search tool, without adding shell or file-write privileges. User/managed denials still apply. CLI `--allowedTools` is an additive auto-approval list, not an exclusive tool whitelist; existing other permissions are preserved.
- At most 8 searches per invocation, 2 concurrently, 2000 characters per query and 8 sources per result, with a 60-second end-to-end search deadline. Title generation allocates no MCP server or search grant.
- Reasoning reports `▸ 网页搜索：PackyCode DeepSeek（MCP，原生 WebSearch 已禁用）` (or GPT). The temporary server binds only `127.0.0.1`; its private config contains an independent one-run capability, never a search API key. CLI completion/cancellation/timeout/plugin unload revokes it and removes the private config, leaving existing user MCP configurations untouched.

<details>
<summary>How web search is wired into DSH</summary>

- The plugin registers two search providers with DSH's `web` service: `packycode-api` (always PackyCode) and `packycode-api-auto` (routes by the initiating session's model). Registering them changes nothing by itself.
- Auto and Always append one `- id: web` entry, marked `# >>> dsh-packycode-api: web search provider`, to the end of the profile's `cordis.patch.yml`. It points the web row's base `searchProvider` at one of those providers; DSH hot-applies the file, no restart needed. Switching back to the default removes the entry and leaves everything else as it was.
- The plugin does not write the web runtime's search slot. Subscription plugins such as Codex and Kimi rewrite that slot whenever the web row restarts, so two writers would restart each other forever. They fall back to the web row's base config for models they do not own, so writing the base coexists with them: Codex models keep Codex search and only the remaining requests reach the choice made here.
- The entry records the base search it replaced as a comment (`# fallback: …`). In Auto, requests from non-PackyCode models go there; if that provider hands a request back to this plugin, it goes straight to DSH's built-in `deepseek-official` instead of looping.
- Results come from structured data only: DeepSeek's `web_search_tool_result` blocks, GPT's `url_citation` annotations and `web_search_call` records. The model's summary is returned as `content`.
- When a key's group does not cover the backend's model (the gateway says `当前令牌未覆盖供应商`), the search tries the next key without disabling this one, and finally suggests switching backends.
- Settings shows the base and runtime search provider in effect, and warns when another plugin's later patch overrides the base.

</details>

<details>
<summary>When a key is rotated</summary>

- **Rotates and disables the current key:** the gateway reports exhausted quota, or it rejects the key (HTTP 401 / invalid token). The harness retries the failed step, which is what actually sends it on the next key.
- **Passes over a key by its groups, without disabling it:** when the group reading shows the active key cannot reach this turn's model and another stored key can, the turn runs on that key (a Claude turn says so in its reasoning: “当前 Key「A」的分组不能用 …，本轮改用 Key「B」”). The active key stays active for every other model. Only evidence counts: a key whose groups are not read yet is used as before.
- **Does not rotate:** rate limits (429); a 400 that this gateway uses for a dead upstream channel; and a 403 that means the group accepts only the vendor's official client. That last case is explained directly instead of being shown as an invalid API key.
- When every stored key is disabled, the request fails and says so. There is no fallback credential.

</details>

## Models and groups

| Model | How it runs | Effort | Token group |
| --- | --- | --- | --- |
| `deepseek-flash` | HTTP, chat/completions | Can be off; `low` / `high` / `max` | `deepseek-officially`, `deepseek-sale` |
| `gpt-6.1-sol` | HTTP, Responses, images allowed | Cannot be off; `low` / `medium` / `high` / `xhigh` / `max` | `codex`, `codex-sale` |
| `gpt-6-astra` | Same | Same | Same |
| `claude-opus-5-5` | Local Claude Code CLI | The picker offers the same levels; the CLI chooses the actual effort | A group the official CLI is allowed to use; see below |
| `claude-sonnet-5-5` | Same | Same | Same |
| `claude-haiku-5-5` | Same; session titles always use this model | Same | Same |

A model in the list does not mean the current token group allows it. When changing groups, do not drop the group that serves the model you still want.

<details>
<summary>Protocol, group, and CLI constraints</summary>

- OpenAI / Codex traffic must use the Responses protocol. `gpt-6.1-sol` and `gpt-6-astra` are pinned to `openai-responses` at `https://cf.api.fan/v1`. Do not put `/responses` in the base URL.
- Codex-group Responses requests must include `prompt_cache_key` or the gateway returns 403. The harness supplies the session id; the plugin adds a fallback when a caller does not.
- The Anthropic base URL has no `/v1` (the client appends `/v1/messages`). The three Claude models declare the Messages protocol in the catalog, but their requests are made by the local CLI.
- The `cc` group accepts only the official Claude CLI. A normal API client gets `403 This API endpoint is only accessible via the official Claude CLI`. This plugin runs the local `claude` binary for that group instead of switching the token to `cc-sale` or pretending to be the official client. If the token has no group the official CLI may use, the three Claude models still will not run.
- Selecting a Claude model when the CLI is missing fails that turn with an install hint. It does not surface as a missing binary name alone.
- The CLI receives this plugin's endpoint and current key (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`) and an isolated config directory, `~/.dsh/packycode-claude-cli`. Without that isolation, `env` in `~/.claude/settings.json` would override the plugin key.
- CLI permission follows the session by default: `read-only` stays read-only, `workspace-write` may edit, and `danger-full-access` with approval disabled may use `full`. The CLI cannot ask the DSH user for approval, so a session that still asks never gets `full`. `claudeCliMode` can pin `read-only`, `edit`, or `full`. An empty `claudeCliPath` is looked up automatically; an empty `claudeCliCwd` uses the session workspace.
- Thinking and tool activity (`▸ Bash`, `▸ Read`, and `✗` on failure) appear in that turn's reasoning block. They are progress, not DSH tool calls. The CLI's own tools are outside the DSH sandbox.
- The reasoning block opens with `▸ 启动 Claude Code CLI…` and then shows the CLI's version and model once it is up. When the gateway throttles or is busy (429, 503 `账号并发排队已满` / per-account wait queue full, and similar), the CLI retries up to 10 times on its own; each retry now shows as `↻ 网关返回 HTTP 503，CLI 自动重试 n/10` instead of looking hung. When the retries run out, the turn says PackyCode's Claude upstream is busy, not that the key is bad. A CLI that prints nothing for 2 minutes after starting is stopped and reported.
- The conversation and its images reach the CLI over stdin (`--input-format stream-json`), not argv: a Windows command line is length-limited and cannot carry an image. Images in the conversation are sent to Claude as images, at the HTTP route's request size (at most 2048×2048, about 1 MiB each; at most 20 images and 20 MiB per turn, dropping the oldest first). An image left out is named with its read-only local copy, which the CLI can open with Read.
- Every run carries `--append-system-prompt` (the delegation note). In `-p` mode the official CLI introduces itself as "You are Claude Code, Anthropic's official CLI for Claude …" when it has appended instructions and as "You are a Claude agent, built on Anthropic's Claude Agent SDK." when it has none; the latter was refused upstream as not coming from the official CLI (403 `only accepts requests from the official Claude Code CLI`). That is the official CLI's own behavior; the plugin does not rewrite its system prompt.
- While the session model is a Claude model, titles are generated with `claude-haiku-5-5`, read-only, in a temporary directory, instead of a full Opus turn.
- While the session model is `gpt-6-astra`, titles are generated with `gpt-6.1-sol` (same Codex group); the turns themselves stay on Astra. Other models title their own sessions.
- The `claude_code` tool can delegate one task to the local CLI while the session model is `gpt-6.1-sol`, `gpt-6-astra`, or `deepseek-flash`. The requested `mode` cannot exceed what the session preset allows.
- An effort level the model does not support is rejected before the request is sent. Do not edit a model's effort map casually.

</details>

## Update and uninstall

**Update:** open **Settings → PackyCode** and, when a newer version is listed, click **Update plugin**. It installs that exact version into the owning profile with DSH's bundled pnpm and reads `package.json` back before reporting success. A local `link:` checkout does not get the button. Then quit and reopen the desktop application. A page refresh does not reload the Host. Reinstalling `dsh-packycode-api` from the **Plugins** page does the same job.

**Uninstall:** if you used PackyCode web search, first switch **Settings → PackyCode → Web search** back to the default. Then remove this plugin on the **Plugins** page and restart the desktop application. Otherwise `cordis.patch.yml` keeps a web entry naming a provider that no longer exists, and `web_search` fails with `configured web provider "packycode-api-auto" is not registered`; delete the block marked `dsh-packycode-api: web search provider` by hand to recover. Uninstalling does not remove other plugins, the profile, or the token in the PackyCode console.

## FAQ

**Web search says "no stored API key's group covers …"?** The search backend's model is not in your token groups (or the gateway currently routes it to another supplier). Pick the other backend under **Settings → PackyCode → Web search**, or add a key whose group covers it.

**One model fails, but the key is valid?** Look at that key's groups and ✓ / ✕ under **Accounts and keys**. When its groups do not cover the model, use a key whose groups do, or add the group to the key in the PackyCode console. With such a key stored, the plugin runs that model on it automatically. A group refusal never disables a key.

**Claude says the gateway refused the request as not coming from the official Claude Code CLI?** The usual cause is that the turn's key has no Claude group: PackyCode answers such a key with that same wording (or a 400 `当前令牌未覆盖供应商`). The error now says so directly — the key, its groups, and the groups the model needs — and that the CLI does not need updating. Only a key that does have a Claude group and is still refused points at the CLI.

**The balance does not match the account bill?** Settings totals only the keys stored here, not other tokens on the same PackyCode account. A key that failed to read is noted separately and is not treated as zero.

**The balance reads `fetch failed` from `https://www.packyapi.com`?** That host, the default through 1.0.4, is DNS-poisoned on mainland networks and only answers through a proxy, so it works on and off. The default is now `https://www.packyapi.ai`. The model list is built into the plugin and never queried from PackyCode, so it is unaffected.

**A Claude model sits on "thinking" with no answer?** Read the reasoning block: `↻ 网关返回 HTTP 503/429` lines mean PackyCode's Claude upstream is queueing or throttling and the CLI is retrying. `▸ 启动 Claude Code CLI…` with no "started" line after it means the local CLI did not come up (on Windows, check Git for Windows and run `claude --version` in a terminal).

**A rate limit disabled the key?** It should not. HTTP 429 does not rotate. Exhausted quota or HTTP 401 does; after a top-up, click **Re-enable**.

**Installing from the Plugins page fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`?** pnpm refuses packages published less than 24 hours ago and checks the whole profile lockfile. The package it names is often another plugin that was just updated, not this one. Retry once it is 24 hours old, or add the reported `name@version` under `minimumReleaseAgeExclude` in the profile's `pnpm-workspace.yaml`. Once this plugin is installed, **Update plugin** in Settings is not subject to that check.

**The CLI is installed, but Claude still fails?** A host launched from Finder or the Start menu usually has a shorter `PATH` than a terminal. The plugin also checks the official install location, common package-manager directories, and `npm prefix -g`. If it still cannot find the binary, set `claudeCliPath` or click **Check again**. After a Host change or a reinstall, quit and reopen the desktop application.

## Security and scope

This is a community plugin, not affiliated with or endorsed by DeepSeek or PackyCode. Model requests go to the PackyCode host you configured. Keeping credentials out of browser responses does not mean inference is local. Claude models also start the official CLI on this device.

Keys stay in the local DSH credential file (`~/.dsh/.credentials.yaml`, owner-only as enforced by DSH). They are not written into settings, logs, or the transcript. Balance requests run only on the host, with a timeout and redirects refused.

Use [Issues](https://github.com/BaronCyrus/dsh-packycode-api/issues) for ordinary bugs. Never include a key, token, or credential-file contents. See [SECURITY.md](SECURITY.md).

## Local development

```sh
git clone https://github.com/BaronCyrus/dsh-packycode-api.git
cd dsh-packycode-api
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` runs every test, rebuilds, and writes a tarball under `.artifacts/`. `lib/` is a committed build; regenerate it with `pnpm run build` after editing `src/`, and do not hand-edit it.

`node scripts/live-check.mjs` checks the live gateway through the same route the plugin registers: balance and groups, one answer per HTTP model, a rotation rehearsal, and the failure classification, printing only the key's last four characters. `--with-cli` also runs the three Claude models through the local Claude Code CLI, and `--with-search` runs one search per backend; the default run spends a small amount of quota.

`node scripts/cli-search-check.mjs` runs the real CLI against a local test gateway and MCP bridge; Claude responses and search data are mocked by default, with no quota consumed. It checks all three permission modes, native-search exclusion and temporary-resource cleanup. `--live --backend deepseek` or `--live --backend gpt` sends the read-only mode's one search to the real backend (edit/full remain mocked). This does not verify actual Claude upstream turns or a running DSH integration.

Read [AGENTS.md](AGENTS.md) before agent-assisted changes or a release. Publishing is the [Publish workflow](.github/workflows/publish.yml), triggered by pushing a `v*` tag. Do not run `npm publish` locally.

## License

[MIT](LICENSE)
