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
| **Choose visible models** | All models are selected by default in Settings. Unchecking a model immediately hides it from the picker; existing sessions can keep using it |
| **Keys used in order** | An exhausted or rejected key is disabled and the next usable key takes over; the failed step is retried on that key |
| **Keys chosen by group** | Each key lists its PackyCode groups and the models they reach; when the active key's groups cannot reach the selected model (no `cc` group for Claude, say), that turn runs on a stored key whose groups can |
| **Visible balance** | Settings lists each key's remaining, used, limit, reset period, and a usage bar, plus a total of those keys. The composer shows the active key's remaining balance |
| **Claude through the local CLI** | `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5` run the official Claude Code CLI on this device. Settings can detect it and install it |
| **Web search through PackyCode** | Optional: DSH's `web_search` searches through PackyCode, with a DeepSeek or GPT backend, for every request or for PackyCode models only |
| **Image generation and editing** | Separate image keys, GPT Image 2 / 2.5 Flare / 2.5 Sunburst, model and quality settings, reference edits and original PNG storage; generation and editing verified against the gateway |
| **Credentials stay on the machine** | Keys live in the DSH credential file. The browser receives labels, state, and balances only |

<img width="774" height="455" alt="截屏2026-10-15 10 34 28" src="https://github.com/user-attachments/assets/c5eaa535-dd1e-4e2f-be9f-c181404d4dd6" />
<img width="575" height="522" alt="截屏2026-10-15 10 34 49" src="https://github.com/user-attachments/assets/3cf4d090-a4f9-49fe-9ab3-3aab21d6e909" />
<img width="257" height="309" alt="截屏2026-10-15 10 37 21" src="https://github.com/user-attachments/assets/621cd800-17a2-42f6-8dfe-c1b4be09af61" />


## Install

You need **DeepSeek Harness** and a **PackyCode (PackyAPI) API key**. For DSH setup, see the [official instructions](https://github.com/deepseek-ai/deepseek-harness#run). No API key yet? You can register with PackyCode and apply for one through [this invite link](https://www.packyapi.ai/register?aff=Im3l).

### 1. Install the plugin

Open the desktop application's **Plugins** page, click **Add plugin**, and enter the package name **with a version** as the **package name or address**:

```text
dsh-packycode-api@1.2.11
```

Choose the **official** install source, then click **Install**. `1.2.11` was the latest release when this was written; the [npm page](https://www.npmjs.com/package/dsh-packycode-api) shows the current one.

> **Always include the version.** With a bare `dsh-packycode-api`, the install prompt shows the newest version on npm, but DSH's bundled pnpm by default installs only versions published at least 24 hours ago, so you can end up several releases behind with no sign of it in the prompt. With an exact version, pnpm installs that version and adds it to the profile's `minimumReleaseAgeExclude` itself. Afterwards, check **Current version** under **Settings → PackyCode → Plugin version**.

A **first install requires no DSH restart**: open **Settings → PackyCode** and add a key immediately. This holds from 1.1.7 on; earlier versions need one restart after a first install, see the FAQ. When updating an already loaded older version, follow the restart guidance in the **Plugin version** card.

### 2. Add a key

Open **Settings → PackyCode**. Paste the API key under **Add a key**. A label is optional and only distinguishes keys. Click **Add**. Until a key has been added, **Accounts and keys** shows the same registration invite link, which opens in the system browser; it disappears once a key is stored.

> Do not paste a key into a public issue, chat, or screenshot. The plugin does not read `PACKY_CODE_API_KEY` from the environment, and it does not silently switch to another provider when a request fails.

### 3. Select a model

Choose a model from the `PackyCode` group. `deepseek-flash`, `gpt-6.1-sol`, `gpt-6-astra`, `grok-4.7`, `gemini-4-argon`, and `gemini-3.8-flash` use HTTP. The three Claude models also need the Claude Code CLI on this device; see below. Your key's groups must cover the selected model.

<details>
<summary>Verify the install / other profiles / a local checkout</summary>

The **Plugins** page shows the installed state and version, and is also where you enable, disable, or uninstall.

**For non-desktop profiles only:** `dsh plugin --profile <name> add dsh-packycode-api@1.2.11`. Do not use it for `desktop` — the CLI refuses it (`profile "desktop" is managed exclusively by the Electron application`).

For a local checkout, keep the `link:` prefix: `dsh plugin --profile <name> add link:/path/to/dsh-packycode-api`. **Do not pass a bare path or `file:`** — that install copies the whole checkout, `node_modules` included, into the profile, where it then shadows the packages the DSH installation itself provides and the plugin looks uninstalled; see the FAQ. If you already installed that way, uninstall first and reinstall as above.

A profile without a browser can still use the model route. It just has no settings panel and no composer balance.

</details>

## Daily use

**Choose visible models.** Under **Settings → PackyCode → Visible models**, check the models you want in the picker. All are selected by default, with Select all / Select none controls. The selection is saved in the current profile and applies immediately; unchecking a model does not interrupt an existing session. New catalog models are selected by default.

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

### Image generation and editing

Add the dedicated key under **Settings → PackyCode → Image generation and editing → Add an image key**. This credential record is separate from conversation keys. Image calls use only the selected image key. Adding one does not start a paid test.

The image card shows each image key's remaining/used quota, limits when supplied, reset period, usage bar and separate totals. It refreshes every minute or with **Refresh**, preserving a dated last-good reading when a refresh fails. Image key changes and successful generation invalidate the independent balance cache. Only image key quotas are queried; account-wide billing and conversation key totals are kept separate.

Choose the image model and quality, then click **Create image** in a PackyCode conversation or explicitly request `packycode_image_generate`. Attach references and describe changes to use `/v1/images/edits`; new images use `/v1/images/generations`. The image model is independent of the conversation model and other image plugins can coexist.

All three CLI-backed Claude models and the `claude_code` delegation tool also support generation and editing through a temporary MCP image tool: `Claude Code CLI → local MCP → host image service → PackyCode Images API`. It shares the image preferences, dedicated image key and balance cache; the image key never reaches the CLI. References use host-scoped session handles (`referenceIds` / optional `maskId`), including images generated earlier in the same run. Successful images are persisted in DSH messages for chat replay, with original PNG files saved separately. Each run allows at most four image attempts, one at a time; cancellation aborts image work. Plan mode and session titles do not expose the paid image tool. **Create image** remains available in Claude conversations.

**Image visible in tool details but unavailable in the final answer:** a standalone main-chat gallery remains visible when reasoning/tool details are collapsed, including PTC child calls. Reopening an existing conversation restores the gallery from its saved attachments without regenerating or spending image quota. An old invalid Markdown image link to a host path does not affect this gallery.

Tool callers can set `model` and `quality` to `settings` to follow the saved preferences; `auto` is an explicit API quality. New images may omit `referenceImages` or pass an empty array. Explicit `operation: edit` requires valid references, and invalid real references are never discarded in favor of new-image generation.

Image 2 accepts `auto / low / medium / high`; both 2.5 models also accept `xhigh / max`. These are Images API `quality` values, separate from text reasoning effort. There is no automatic model substitution, quality downgrade or paid retry. Each call returns one PNG; original bytes are saved under `~/.dsh/packycode-api/images/` (following `DSH_HOME` when set), alongside the chat preview. References and optional PNG masks must belong to the current session; file paths cannot replace attachment references.

Click a generated image to open the in-app large preview. **Download original**, immediately left of Close, opens a save-location picker for the complete preserved PNG. Cancelling is harmless; a moved or deleted original reports a retryable error instead of downloading the chat thumbnail. Saved conversations also support this as long as their original file is still on this host.

After adding the image key, `node scripts/image-check.mjs --all --edit` checks all three engines and one edit. Use `--model <id> --edit` for generation and editing on a specific engine, adding `--quality xhigh` or `--quality max` to check a quality. This consumes image quota, saves outputs under `.artifacts/`, and prints only a masked key tail plus the gateway-reported model/quality.

Live checks on 2026-10-15 passed generation and editing at `low` on all three engines. Sunburst also passed both operations at `xhigh` and `max`, with matching quality values in the responses. All 10 requests succeeded without retries and returned 1024×1024 PNGs; visual inspection confirmed the requested color edits with composition preserved. Generate/edit times were about 43/48 seconds at xhigh and 84/91 seconds at max. These are built-client gateway checks; no desktop conversation was created to verify the full chat flow in this run. See the [protocol research and gateway results](docs/research/image-api.md) for scope and evidence.

## Models and groups

| Model | How it runs | Effort | Token group |
| --- | --- | --- | --- |
| `deepseek-flash` | HTTP, chat/completions, images allowed | Can be off; `low` / `high` / `max` | `deepseek-officially`, `deepseek-sale` |
| `gpt-6.1-sol` | HTTP, Responses, images allowed | Cannot be off; `low` / `medium` / `high` / `xhigh` / `max` | `codex`, `codex-sale` |
| `gpt-6-astra` | Same | Same | Same |
| `grok-4.7` (Grok 4.7) | HTTP, Responses, text/image input; 500K context | Cannot be off; `low` / `medium` / `high` / `xhigh` | The Grok coverage read from the gateway in Settings |
| `gemini-4-argon` (Gemini 4 Argon) | HTTP, native Gemini streaming, text/image input; 1,048,576 context, 65,536 output | Cannot be off; `low` / `medium` / `high` | `gemini-slb` |
| `gemini-3.8-flash` (Gemini 3.8 Flash) | HTTP, native Gemini streaming, text/image input; 1,048,576 input, 65,536 output | Cannot be off; `low` / `medium` / `high` | `gemini-slb` |
| `claude-opus-5-5` | Local Claude Code CLI | The picker offers the same levels; the CLI chooses the actual effort | A group the official CLI is allowed to use; see below |
| `claude-sonnet-5-5` | Same | Same | Same |
| `claude-haiku-5-5` | Same; session titles always use this model | Same | Same |

A model in the list does not mean the current token group allows it. When changing groups, do not drop the group that serves the model you still want.

All nine models in the current catalog declare text and image input. DeepSeek Flash follows the [official vision guide](https://api-docs.deepseek.com/guides/vision/); images are read through DSH's attachment service and sent with the Chat Completions request.

Gemini capabilities and limits follow Google's model pages: [Gemini 4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon), [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash). Both models use the native Gemini protocol through `/v1beta/models/{model}:streamGenerateContent`, streaming text, thinking and tool calls; images are read through DSH's attachment service. Thinking levels are sent with `thinkingLevel`. Both routes use the single-stream output limit without automatic continuation beyond 65,536 tokens. Available endpoints and groups follow the [PackyAPI live model catalog](https://www.packyapi.com/api/pricing).

**Gemini tool continuation and thought signatures:** PackyCode's native Gemini route does not handle thought signatures in tool calls correctly. It answers HTTP 400 `Invalid thought signature` / `Corrupted thought signature`, and resending the same request does not help (PackyCode support's answer). For Gemini 4 Argon and Gemini 3.8 Flash the plugin therefore sends none of the signatures the model returned. Wherever a signature is required, it sends Google's documented validator-skip value `skip_thought_signature_validator` ([Google's guide](https://ai.google.dev/gemini-api/docs/thought-signatures)). The protocol, endpoint and model stay the same, and DSH's replay record keeps the original signatures. Google notes that skipped signatures can weaken reasoning continuity across tool steps. Flash keeps its earlier safeguard: after an HTTP 400 signature refusal before any stream event, it waits one second and resends once. Such a 400 is never treated as a failed key.

Grok 4.7's context and reasoning levels follow the [official guide](https://docs.x.ai/developers/grok-4-7). There is no separate text-output limit; the plugin uses the context size as its numeric output ceiling, bounded by the remaining context per request.

Only GPT Responses requests keep `prompt_cache_key`; other Responses models omit it by default. This gateway's Grok route reports a misleading `Incorrect API key provided` error when the field is present.

<details>
<summary>Protocol, group, and CLI constraints</summary>

- OpenAI / Codex traffic must use the Responses protocol. `gpt-6.1-sol` and `gpt-6-astra` are pinned to `openai-responses` at `https://cf.api.fan/v1`. Do not put `/responses` in the base URL.
- Codex-group Responses requests must include `prompt_cache_key` or the gateway returns 403. The harness supplies the session id; the plugin adds a fallback when a caller does not.
- The Anthropic base URL has no `/v1` (the client appends `/v1/messages`). The three Claude models declare the Messages protocol in the catalog, but their requests are made by the local CLI.
- The `cc` group accepts only the official Claude CLI. A normal API client gets `403 This API endpoint is only accessible via the official Claude CLI`. This plugin runs the local `claude` binary for that group instead of switching the token to `cc-sale` or pretending to be the official client. If the token has no group the official CLI may use, the three Claude models still will not run.
- Selecting a Claude model when the CLI is missing fails that turn with an install hint. It does not surface as a missing binary name alone.
- The CLI receives this plugin's endpoint and current key (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`) and an isolated config directory, `~/.dsh/packycode-claude-cli`. Without that isolation, `env` in `~/.claude/settings.json` would override the plugin key.
- CLI permission follows the session by default: `read-only` stays read-only, `workspace-write` may edit, and `danger-full-access` with approval disabled may use `full`. The CLI cannot ask the DSH user for approval, so a session that still asks never gets `full`. `claudeCliMode` can pin `read-only`, `edit`, or `full`. DSH plan mode wins over that mapping and over the pin: the CLI runs read-only with `--permission-mode plan --permission-prompt-tool stdio`, using one private hidden temporary plan directory inside the working directory per invocation (the CLI rejects custom plan directories outside the project root). This stores only planning artifacts, changes no project code or settings, and fails explicitly for an unwritable workspace. `ExitPlanMode` hands the plan to DSH for review; it never starts implementation in that CLI process. File fallback reads only this invocation's directory, which is cleaned afterwards. Review works in native and PTC tool modes, and the complete plan and review feedback reach the next turn; exceeding the conversation budget fails explicitly instead of silently truncating constraints. Approval or `/plan off` takes effect from the next step; delegations in the same tool batch keep the current plan state. Session titles stay out of plan mode. An empty `claudeCliPath` is looked up automatically; an empty `claudeCliCwd` uses the session workspace.
- Thinking and tool activity (`▸ Bash`, `▸ Read`, and `✗` on failure) appear in that turn's reasoning block. They are progress, not DSH tool calls. The CLI's own tools are outside the DSH sandbox.
- The reasoning block opens with `▸ 启动 Claude Code CLI…` and then shows the CLI's version and model once it is up. When the gateway throttles or is busy (429, 503 `账号并发排队已满` / per-account wait queue full, and similar), the CLI retries up to 10 times on its own; each retry now shows as `↻ 网关返回 HTTP 503，CLI 自动重试 n/10` instead of looking hung. When the retries run out, the turn says PackyCode's Claude upstream is busy, not that the key is bad. A CLI that prints nothing for 2 minutes after starting is stopped and reported.
- The conversation and its images reach the CLI over stdin (`--input-format stream-json`), not argv: a Windows command line is length-limited and cannot carry an image. Images in the conversation are sent to Claude as images, at the HTTP route's request size (at most 2048×2048, about 1 MiB each; at most 20 images and 20 MiB per turn, dropping the oldest first). An image left out is named with its read-only local copy, which the CLI can open with Read.
- Every run carries `--append-system-prompt` (the delegation note). In `-p` mode the official CLI introduces itself as "You are Claude Code, Anthropic's official CLI for Claude …" when it has appended instructions and as "You are a Claude agent, built on Anthropic's Claude Agent SDK." when it has none; the latter was refused upstream as not coming from the official CLI (403 `only accepts requests from the official Claude Code CLI`). That is the official CLI's own behavior; the plugin does not rewrite its system prompt.
- While the session model is a Claude model, titles are generated with `claude-haiku-5-5`, read-only, in a temporary directory, instead of a full Opus turn. Inside the CLI, DSH's title rules are only an appendix to the CLI's own system prompt, and a very short message such as 在吗 used to come back as English JSON (`{"title": "Casual greeting check-in"}`). The prompt therefore ends by restating them: the bare title as plain text, in the language of the messages (Chinese, Japanese and Korean are named by their script). A reply that still arrives in JSON, a code fence, quotes or after a "Title:" label is unwrapped before DSH reads it. A reply of several lines (the model wrote out its thinking or an explanation, so the title line cannot be told) or a bare placeholder such as "Session title" yields no title, and DSH keeps its default title from the first message.
- While the session model is `gpt-6-astra`, titles are generated with `gpt-6.1-sol` (same Codex group); the turns themselves stay on Astra. Other models title their own sessions.
- The `claude_code` tool can delegate one task to the local CLI while the session model is `gpt-6.1-sol`, `gpt-6-astra`, or `deepseek-flash`. The requested `mode` cannot exceed what the session preset allows. While the session is in plan mode the delegation plans too, and returns the plan text to the parent model.
- An effort level the model does not support is rejected before the request is sent. Do not edit a model's effort map casually.

</details>

## Update and uninstall

**Update:** open **Settings → PackyCode** and, when a newer version is listed, click **Update plugin**. It installs that exact version into the owning profile with DSH's bundled pnpm and reads `package.json` back before reporting success. A local `link:` checkout does not get the button. Then quit and reopen the desktop application. A page refresh does not reload the Host. Reinstalling from the **Plugins** page works too, again with the version in the package name (for example `dsh-packycode-api@1.2.11`); without it you may get a version that is merely the newest one published at least 24 hours ago.

**Coming back from a local-path install, uninstall first.** An update is a `pnpm add`: it rewrites the files inside the package directory and leaves a `node_modules` that an earlier local-path install left there. That older tree keeps shadowing the packages the DSH installation provides, so the plugin row fails to load with no visible reason. **Uninstall** runs `pnpm remove`, which deletes the package directory outright — only a reinstall after that is clean. `node scripts/install-check.mjs` reports whether a profile is in that state.

**Uninstall:** if you used PackyCode web search, first switch **Settings → PackyCode → Web search** back to the default. Then remove this plugin on the **Plugins** page and restart the desktop application. Otherwise `cordis.patch.yml` keeps a web entry naming a provider that no longer exists, and `web_search` fails with `configured web provider "packycode-api-auto" is not registered`; delete the block marked `dsh-packycode-api: web search provider` by hand to recover. Uninstalling does not remove other plugins, the profile, or the token in the PackyCode console.

## FAQ

**Installed, but Settings shows no PackyCode at all?** The plugin row failed to load at startup, and DSH only records that in the host log — the settings page shows no reason. Check with `node scripts/install-check.mjs` from this repository (read-only, no network); by hand, look for this directory:

```sh
ls ~/.dsh/profiles/desktop/node_modules/dsh-packycode-api/node_modules
```

Output means a leftover tree: a registry install ships no `node_modules`, so this one usually comes from an earlier local-path install (`file:`, or a bare path instead of `link:`). It sits inside the profile directory, and DSH resolves a plugin's imports from inside the profile first, so the plugin gets those old copies — for example `@deepseek-ai/schemastery` 3.18.2, which has no `Schema.volatile()`, so the module throws while it is imported. When an import fails the Loader creates no fiber for that row and no client bundle is composed either, so the model route, the RPC channel, and the settings panel all stay absent.

Recovery: **uninstall** the plugin on the **Plugins** page, **install** it again with the version in the package name (for example `dsh-packycode-api@1.2.11`), then quit and reopen the desktop application. Uninstall runs `pnpm remove` and deletes the whole package directory; reinstalling or clicking **Update** only rewrites files and keeps the leftover tree. Deleting that `node_modules` by hand and restarting works too.

**Right after a first install, every card in Settings shows `transport failure for /packycode-api/…: HTTP 405`?** The installed version is 1.1.6 or earlier, usually because only the bare package name was entered: the install prompt shows the newest version, but pnpm installs the newest one published at least 24 hours ago (see **Install the plugin**). Those older versions can register their settings channel only after DSH restarts and rebuilds its `connection` service. So right after a first install `/packycode-api` does not exist yet, requests fall through to the static page, and it answers 405; the model route and the settings panel itself load normally. From 1.1.7 on, a first install needs no restart. Check which version was installed:

```sh
grep '"version"' ~/.dsh/profiles/desktop/node_modules/dsh-packycode-api/package.json
```

Recovery: quit and reopen the desktop application, and the old version works. Then click **Check for updates** → **Update plugin** under **Settings → PackyCode → Plugin version** (it installs the exact latest version and is not subject to the 24-hour rule), and restart once more.

**Web search says "no stored API key's group covers …"?** The search backend's model is not in your token groups (or the gateway currently routes it to another supplier). Pick the other backend under **Settings → PackyCode → Web search**, or add a key whose group covers it.

**One model fails, but the key is valid?** Look at that key's groups and ✓ / ✕ under **Accounts and keys**. When its groups do not cover the model, use a key whose groups do, or add the group to the key in the PackyCode console. With such a key stored, the plugin runs that model on it automatically. A group refusal never disables a key.

**Claude says the gateway refused the request as not coming from the official Claude Code CLI?** The usual cause is that the turn's key has no Claude group: PackyCode answers such a key with that same wording (or a 400 `当前令牌未覆盖供应商`). The error now says so directly — the key, its groups, and the groups the model needs — and that the CLI does not need updating. Only a key that does have a Claude group and is still refused points at the CLI.

**The balance does not match the account bill?** Settings totals only the keys stored here, not other tokens on the same PackyCode account. A key that failed to read is noted separately and is not treated as zero.

**The balance reads `fetch failed` from `https://www.packyapi.com`?** That host, the default through 1.0.4, is DNS-poisoned on mainland networks and only answers through a proxy, so it works on and off. The default is now `https://www.packyapi.ai`. The model list is built into the plugin and never queried from PackyCode, so it is unaffected.

**A Claude model sits on "thinking" with no answer?** Read the reasoning block: `↻ 网关返回 HTTP 503/429` lines mean PackyCode's Claude upstream is queueing or throttling and the CLI is retrying. `▸ 启动 Claude Code CLI…` with no "started" line after it means the local CLI did not come up (on Windows, check Git for Windows and run `claude --version` in a terminal).

**A rate limit disabled the key?** It should not. HTTP 429 does not rotate. Exhausted quota or HTTP 401 does; after a top-up, click **Re-enable**.

**Installing from the Plugins page fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`?** By default pnpm accepts only versions published at least 24 hours ago and checks the whole profile lockfile. (Entering only this plugin's bare name does not raise this error; it silently installs an older version that has passed 24 hours instead, see **Install the plugin**.) The package it names is often another plugin that was just updated, not this one. Retry once it is 24 hours old, or add the reported `name@version` under `minimumReleaseAgeExclude` in the profile's `pnpm-workspace.yaml`. Once this plugin is installed, **Update plugin** in Settings is not subject to that check.

**The CLI is installed, but Claude still fails?** A host launched from Finder or the Start menu usually has a shorter `PATH` than a terminal. The plugin also checks the official install location, common package-manager directories, and `npm prefix -g`. If it still cannot find the binary, set `claudeCliPath` or click **Check again**. After a Host change or a reinstall, quit and reopen the desktop application.

**Replies stop at the output token limit (已达到输出 token 上限), or requests keep failing — how do I report it?** Open **Settings → PackyCode → Diagnostics**, pick the session (the 20 most recent, newest first, labelled with their folder name), click **Generate diagnostics** and then **Copy**, and paste the text into an [Issue](https://github.com/BaronCyrus/dsh-packycode-api/issues) or send it to the plugin author. It holds settings and numbers only: the plugin version, the session id and start time, each key's position and groups (no labels, no keys), each request's model, reasoning effort and output limit, the latest steps' token usage and finish reasons, and retry and failure codes (messages redacted and shortened). It contains no conversation text, file paths or keys. Where copying is unavailable, the text is selected instead; press ⌘C or Ctrl+C.

## Security and scope

This is a community plugin, not affiliated with or endorsed by DeepSeek or PackyCode. Model requests go to the PackyCode host you configured. Keeping credentials out of browser responses does not mean inference is local. Claude models also start the official CLI on this device.

Keys stay in the local DSH credential file (`~/.dsh/.credentials.yaml`, owner-only as enforced by DSH). They are not written into settings, logs, or the transcript. Balance requests run only on the host, with a timeout and redirects refused.

Use [Issues](https://github.com/BaronCyrus/dsh-packycode-api/issues) for ordinary bugs; for a failing request, attach the text from the **Diagnostics** card. Never include a key, token, or credential-file contents. See [SECURITY.md](SECURITY.md).

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

`node scripts/cli-image-check.mjs` checks the real official CLI generating an image, editing its result, and persisting both through DSH's message assembler. Default model/image responses are local fixtures, covering read-only/edit/full/plan/title modes and temporary-config cleanup. `--live` makes one real Sunburst low-quality generation and one edit using the stored image key, while Claude replies remain local fixtures. `--with-claude` additionally uses a real Claude upstream turn (Haiku by default), consuming conversation quota too. Outputs go under `.artifacts/`; neither option starts DSH or claims a running desktop conversation was tested.

`node scripts/cli-plan-check.mjs` checks plan mode with the real CLI and a local fake gateway: stdio handoff, concurrent plan ownership, invocation-only file fallback, stale-plan exclusion, actual denial limits and cleanup. It reads no real credentials, spends no quota and starts no DSH instance.

`node scripts/install-check.mjs` diagnoses an installed plugin that never appears: it reads one profile, lists any host package shadowed by a leftover `node_modules` inside an installed package (with versions) plus the recovery steps, and exits 1 when it finds one. `--profile <name>`, `--home <dir>`, and `--json` are available.

Read [AGENTS.md](AGENTS.md) before agent-assisted changes or a release. Publishing is the [Publish workflow](.github/workflows/publish.yml), triggered by pushing a `v*` tag: it publishes to npm, then creates the GitHub Release from `docs/releases/v<version>.md` with the same tarball. Do not run `npm publish` locally.

## License

[MIT](LICENSE)
