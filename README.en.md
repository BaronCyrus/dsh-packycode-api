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

[Features](#features) · [Install](#install) · [Daily use](#daily-use) · [Models and groups](#models-and-groups) · [Update and uninstall](#update-and-uninstall) · [Support](#support-the-author)

</div>

## Features

| Capability | What it does |
| --- | --- |
| **Built-in model route** | Adds a `PackyCode` group to the model picker. No provider configuration and no `cordis.patch.yml` edits |
| **Choose visible models** | All models are selected by default in Settings. Unchecking a model immediately hides it from the picker; existing sessions can keep using it |
| **Keys used in order** | An exhausted or rejected key is disabled and the next usable key takes over; the failed step is retried on that key |
| **Keys chosen by group** | Each key lists its PackyCode groups and the models they reach; when the active key's groups cannot reach the selected model (no `cc` group for Claude, say), that turn runs on a stored key whose groups can |
| **Visible balance** | Settings lists each key's remaining, used, limit, reset period, and a usage bar. The composer shows the active key's remaining balance |
| **Claude route by group** | The `cc` group only serves the official client, so Claude requests on `cc` keys go through this device's Claude Code CLI; `cc-sale`, `cc-expensive`, `claude-officially` and other groups use the plugin's HTTP route. Either way DSH runs the tools and permissions, and plan mode, attachments and the full history behave the same |
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
dsh-packycode-api@1.3.4
```

Choose the **official** install source, then click **Install**. `1.3.4` was the latest release when this was written; the [npm page](https://www.npmjs.com/package/dsh-packycode-api) shows the current one.

> **Always include the version.** With a bare `dsh-packycode-api`, the install prompt shows the newest version on npm, but DSH's bundled pnpm by default installs only versions published at least 24 hours ago, so you can end up several releases behind with no sign of it in the prompt. With an exact version, pnpm installs that version and adds it to the profile's `minimumReleaseAgeExclude` itself. Afterwards, check **Current version** under **Settings → PackyCode → Plugin version**.

A **first install requires no DSH restart**: open **Settings → PackyCode** and add a key immediately. This holds from 1.1.7 on; earlier versions need one restart after a first install, see the FAQ. When updating an already loaded older version, follow the restart guidance in the **Plugin version** card.

### 2. Add a key

Open **Settings → PackyCode**. Paste the API key under **Add a key**. A label is optional and only distinguishes keys. Click **Add**. Until a key has been added, **Accounts and keys** shows the same registration invite link, which opens in the system browser; it disappears once a key is stored.

> Do not paste a key into a public issue, chat, or screenshot. The plugin does not read `PACKY_CODE_API_KEY` from the environment, and it does not silently switch to another provider when a request fails.

### 3. Select a model

Choose a model from the `PackyCode` group. All ten models use the plugin’s HTTP route. Your key’s groups must cover the selected model.

<details>
<summary>Verify the install / other profiles / a local checkout</summary>

The **Plugins** page shows the installed state and version, and is also where you enable, disable, or uninstall.

**For non-desktop profiles only:** `dsh plugin --profile <name> add dsh-packycode-api@1.3.4`. Do not use it for `desktop` — the CLI refuses it (`profile "desktop" is managed exclusively by the Electron application`).

For a local checkout, keep the `link:` prefix: `dsh plugin --profile <name> add link:/path/to/dsh-packycode-api`. **Do not pass a bare path or `file:`** — that install copies the whole checkout, `node_modules` included, into the profile, where it then shadows the packages the DSH installation itself provides and the plugin looks uninstalled; see the FAQ. If you already installed that way, uninstall first and reinstall as above.

A profile without a browser can still use the model route. It just has no settings panel and no composer balance.

</details>

## Daily use

**Choose visible models.** Under **Settings → PackyCode → Visible models**, check the models you want in the picker. All are selected by default, with Select all / Select none controls. The selection is saved in the current profile and applies immediately; unchecking a model does not interrupt an existing session. New catalog models are selected by default.

**Switch keys.** Keys are used in the order they were added. **Use this key** picks the preferred key, effective from the next turn; **Rename** changes its label (at most 60 characters, empty names are refused); **Re-enable** puts a disabled key back after a top-up or replacement.

**See groups.** Under **Accounts and keys**, each key lists its PackyCode groups (hover for the group's description) and which models they reach: ✓ yes, ◐ partly, ✕ no. The groups come from the gateway itself (its refusal of a model id it cannot route names the token's groups; nothing is billed), matched against PackyCode's public model-group table. Check Claude group coverage per model; do not assume `cc-sale` serves all three models; GPT needs `codex` / `codex-sale`; DeepSeek needs `deepseek-officially` / `deepseek-sale`.

**Read the balance.** Each key under **Accounts and keys** shows its own remaining, used, and limit (limit = remaining + used); an unlimited key shows **No quota limit**. Keys are not added up into a total. An API key can read only its own quota, not the PackyCode account's balance, so check the account balance in the PackyCode console. A key that could not be read says why on its own row; a key whose read failed this time but succeeded before keeps showing its last balance with the time it was read (the composer shows it as `≈US$…`) until DSH restarts. The composer shows the active key's remaining balance only while a PackyCode model is selected. **Refresh** bypasses the roughly 60-second cache. The default model host is `https://cf.api.fan` and the balance host is `https://www.packyapi.ai`; both can be changed under **Advanced: endpoints**. The old default, `https://www.packyapi.com`, is DNS-poisoned on mainland networks and answers `fetch failed` without a proxy; even when settings still name it, `.ai` is tried first.

**Use Claude.** Select any Claude model. When the key is in the `cc` group, the plugin sends the request with this device's official Claude Code CLI, so install it first under **Settings → PackyCode → Claude Code CLI** (or run `npm install -g @anthropic-ai/claude-code --allow-scripts=@anthropic-ai/claude-code`), and click **Update Claude Code CLI** there when it is too old; keys in `cc-sale`, `cc-expensive`, `claude-officially` and other groups use the plugin's HTTP route and need no CLI. Under **Accounts and keys**, every key that reaches Claude is marked “Claude via official CLI” or “Claude via HTTP”; the groups alone decide the route, and it cannot be switched by hand. On both routes DSH executes every tool under its own permissions, and plan mode, questions, todos, subagents, attachments, reasoning effort and history behave as for any other model. See “Claude Code CLI route” below.

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

**Claude search.** Claude uses DSH’s `web_search` with the routing choices above and the same stored-key rules as other native models.

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
- **Passes over a key by its groups, without disabling it:** when the group reading shows the active key cannot reach this turn's model and another stored key can, the turn runs on that key. The active key stays active for every other model. Only evidence counts: a key whose groups are not read yet is used as before.
- **Does not rotate:** rate limits (429); a 400 that this gateway uses for a dead upstream channel; and a 403 that means the group accepts only the vendor's official client. The separate 403 saying the client is already authorized and should not send connectivity test messages is classified as `GATEWAY_TEST_MESSAGE`. It explains the refusal without disabling the key. Only Haiku tool context may replay it once under the bounds below.
- When every stored key is disabled, the request fails and says so. There is no fallback credential.

</details>

### Claude Code CLI route

PackyCode's `cc` group (“claude code专用”) only serves the official Claude Code client. The plugin hands Claude requests on keys in that group to the real Claude Code CLI on this device. **The CLI is only the transport; DSH stays the agent:**

- **DSH executes every tool.** The CLI's own Bash, Read, Edit and other tools are all off. The tools DSH offers for the turn (including `exit_plan_mode`, `ask_user_question`, todos, subagents, MCP and image generation) reach the request as `mcp__dsh__<name>` through a local MCP bridge bound to 127.0.0.1. Each call the model makes comes back to DSH, with the same permission prompts, sandbox, plan review and tool cards as over HTTP, and its result goes to the CLI that is waiting for it.
- **DSH's prompt and history, unchanged.** DSH's system prompt is appended to the CLI's own; the history (text, images, signed thinking, tool calls and results) is written as a CLI transcript and resumed; the reasoning effort is passed as `--effort`.
- **One long-lived process per conversation.** A DSH session keeps one CLI process per model: tool results and the next user turn continue it, so requests keep one cacheable prefix. After compaction, a plan-mode switch or a key change, a new process is resumed from DSH's full history; session titles and compaction use one-shot processes. A process idle for 20 minutes stops; at most 8 stay alive.
- **Isolated from your own Claude Code.** It runs with its own config home, `~/.dsh/packycode-claude-cli`, and never reads `~/.claude` settings, CLAUDE.md, MCP configuration or logins; only the key stored in the plugin is passed to the child. Auto-update, telemetry, auto-compaction, auto-memory and model fallback are off, and retries are left to DSH's retry policy, which rotates keys.
- **An outdated CLI is one click away from current.** The plugin needs Claude Code 2.1.259 or later (the first release with the `--permission-prompts` option it passes). An older CLI is stopped before the request with an explanation, and the CLI card marks it too old and offers **Update Claude Code CLI**: an install from the official installer (`~/.local/bin/claude`) runs `claude update`; an npm global install runs `npm install -g @anthropic-ai/claude-code@latest --allow-scripts=@anthropic-ai/claude-code`, because npm 12 skips install scripts by default and `claude update` does not allow them on an npm install, which leaves a CLI that cannot run. Your Claude Code is only updated when you click that button.
- **Failures say why.** A missing CLI, an outdated CLI, and a request from the official CLI that the gateway still refuses each get their own explanation; nothing switches to another route or provider, and no key is disabled.

Known differences: starting a process takes about 0.3–1 s; when a process is resumed in the middle of a tool turn, the CLI adds “Continue from where you left off.” after the tool results, as the official client does. Requires Claude Code 2.1.259 or later (tested with 2.1.295 and 2.1.303). On Windows, Claude Code also needs Git for Windows.

### Image generation and editing

Add the dedicated key under **Settings → PackyCode → Image generation and editing → Add an image key**. This credential record is separate from conversation keys. Image calls use only the selected image key. Adding one does not start a paid test.

The image card shows each image key's remaining, used and limit, its reset period and a usage bar, without adding the keys up. It refreshes every minute or with **Refresh**, preserving a dated last-good reading when a refresh fails. Image key changes and successful generation invalidate the independent balance cache. Only image key quotas are queried, shown apart from conversation key balances.

Choose the image model and quality, then click **Create image** in a PackyCode conversation or explicitly request `packycode_image_generate`. Attach references and describe changes to use `/v1/images/edits`; new images use `/v1/images/generations`. The image model is independent of the conversation model and other image plugins can coexist.

Claude generates and edits images through DSH’s `packycode_image_generate`, with the same separate image key, preferences and balance cache as other models. Saved images from older CLI-backed sessions remain viewable without regeneration.

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
| `gpt-5.6-sol` | Same | Same | Same |
| `grok-4.7` (Grok 4.7) | HTTP, Responses, text/image input; 500K context | Cannot be off; `low` / `medium` / `high` / `xhigh` | The Grok coverage read from the gateway in Settings |
| `gemini-4-argon` (Gemini 4 Argon) | HTTP, native Gemini streaming, text/image input; 1,048,576 context, 65,536 output | Cannot be off; `low` / `medium` / `high` | `gemini-slb` |
| `gemini-3.8-flash` (Gemini 3.8 Flash) | HTTP, native Gemini streaming, text/image input; 1,048,576 input, 65,536 output | Cannot be off; `low` / `medium` / `high` | `gemini-slb` |
| `claude-opus-5-5` | Anthropic Messages, images and native tools: through this device's Claude Code CLI for `cc` keys, HTTP otherwise | Cannot be off; `low` / `medium` / `high` / `xhigh` / `max` | Claude-group coverage reported in Settings |
| `claude-sonnet-5-5` | Same | Same | Same |
| `claude-haiku-5-5` | Same; also generates Claude session titles | Same | Same |

A model in the list does not mean the current token group allows it. When changing groups, do not drop the group that serves the model you still want.

All ten models in the current catalog declare text and image input. DeepSeek Flash follows the [official vision guide](https://api-docs.deepseek.com/guides/vision/); images are read through DSH's attachment service and sent with the Chat Completions request.

Gemini capabilities and limits follow Google's model pages: [Gemini 4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon), [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash). Both models use the native Gemini protocol through `/v1beta/models/{model}:streamGenerateContent`, streaming text, thinking and tool calls; images are read through DSH's attachment service. Thinking levels are sent with `thinkingLevel`. Both routes use the single-stream output limit without automatic continuation beyond 65,536 tokens. Available endpoints and groups follow the [PackyAPI live model catalog](https://www.packyapi.com/api/pricing).

**Gemini tool continuation and thought signatures:** PackyCode's native Gemini route does not handle thought signatures in tool calls correctly. It answers HTTP 400 `Invalid thought signature` / `Corrupted thought signature`, and resending the same request does not help (PackyCode support's answer). For Gemini 4 Argon and Gemini 3.8 Flash the plugin therefore sends none of the signatures the model returned. Wherever a signature is required, it sends Google's documented validator-skip value `skip_thought_signature_validator` ([Google's guide](https://ai.google.dev/gemini-api/docs/thought-signatures)). The protocol, endpoint and model stay the same, and DSH's replay record keeps the original signatures. Google notes that skipped signatures can weaken reasoning continuity across tool steps. Flash keeps its earlier safeguard: after an HTTP 400 signature refusal before any stream event, it waits one second and resends once. Such a 400 is never treated as a failed key.

Grok 4.7's context and reasoning levels follow the [official guide](https://docs.x.ai/developers/grok-4-7). There is no separate text-output limit; the plugin uses the context size as its numeric output ceiling, bounded by the remaining context per request.

Only GPT Responses requests keep `prompt_cache_key`; other Responses models omit it by default. This gateway's Grok route reports a misleading `Incorrect API key provided` error when the field is present.

<details>
<summary>Protocol, group and client compatibility</summary>

- Every model uses HTTP inside the plugin, except Claude requests on `cc` keys, which this device's Claude Code CLI sends. Claude keeps `anthropic-messages`, with a base URL without `/v1`; the SDK appends `/v1/messages`. Model ids, protocols, context limits and effort mappings are unchanged. Both routes share one request builder: DSH's history, attachments, tool schemas and signed replay become a Messages request first, then HTTP or the CLI sends it, and the CLI's raw stream events are parsed by the same protocol code.
- Claude requests over HTTP use the live-verified CLI-compatible headers, bearer authentication, session metadata and identity system prefix while preserving DSH instructions, tool schemas, images and signed replay. The compatibility version is pinned to `2.1.295`.
- The bearer comes only from the plugin’s stored key chosen for the model; the CLI route passes that same key to the child as `ANTHROPIC_AUTH_TOKEN` and clears inherited `ANTHROPIC_*` / `CLAUDE_*` variables. No CLI login, external configuration, ambient key or alternate provider is used.
- The key's groups alone decide the route: it cannot be pinned, and a refusal never switches routes on its own. A key whose groups are not read yet uses HTTP, and a Claude request waits up to about 6 seconds for the first group reading. Client-policy refusals are explained without disabling a key. Server changes may invalidate the envelope; see [PackyCode group policy](https://docs.packyapi.ai/docs/token/).
- Identical Haiku and Sonnet tool requests have been both refused with the captured client-anomaly 403 and accepted. The plugin waits one second and repeats the unchanged request once for that response. Haiku also covers the captured already-authorized/test-message 403, sharing the same one-replay limit. A second refusal remains visible. Opus, plain text, ordinary official-CLI-only refusals, 429s and accepted streams do not trigger this replay. Records retain the original failures; this does not establish a repair of the gateway's internal classifier.
- Claude streams finish at `message_stop` without waiting for the gateway to close the HTTP body, and CRLF delimiters remain intact across network chunks. Stream errors and cancellation still surface; waiting for response headers is not counted as success.
- Offered DSH bash/read/write/edit/glob/grep tools use canonical CLI names such as `Bash` and `Read` over HTTP; other tools use MCP names. Through the CLI every DSH tool is offered as `mcp__dsh__<name>`, and the end of the system prompt says the CLI's own tools are unavailable. Only aliases declared for the current request regain their original names before DSH dispatch; unknown names never grant execution. Arguments, call IDs, results and signed history remain intact. Thinking display follows the CLI defaults: `omitted` for Haiku and `updates` with its required beta for Sonnet and Opus. Reasoning effort and output limits remain unchanged, signatures on empty thinking blocks survive replay, and explicit display options take precedence.
- When the legacy working-directory sentence agrees with the initiating session metadata, Claude receives the exact path as a separate JSON string. Sentence punctuation stays outside the path; real trailing dots, Windows drive/UNC paths, spaces and backslashes remain intact. Commands are never trimmed or rewritten. Shell guidance prefers the current directory or `workdir`, preserving PowerShell syntax for Windows tools.
- Claude turns on both routes retain the full DSH tool loop, permissions and plan mode, using host search and image tools. Claude titles use Haiku on the same route as the conversation; GPT-6 Astra and GPT-5.6 Sol titles use GPT-6.1 Sol.
- The 1.2 `claude_code` delegation tool and the `claudeCliMode` / `claudeCliCwd` settings do not return: the CLI is now a transport and never replaces DSH's tools with its own. `claudeCliPath` applies again and names the CLI (empty means the usual install places, then PATH). 1.3.4's `claudeTransport` is removed, and a value left in a profile is ignored. Separately installed Claude Code is only modified when you click **Update Claude Code CLI** in the CLI card.
- Codex Responses requests still need `prompt_cache_key`; the plugin supplies a missing session identity. Other Responses families omit it.
- After building, `node scripts/claude-check.mjs` checks all three Claude models on order totals, support triage, replenishment, read-only inventory tool roundtrips, product color labels, Chinese titles and plan mode (read-only lookup → plan submitted with `exit_plan_mode` → approval), validating the business answers; `--transport cli` sends all of it through this device's Claude Code CLI. `node scripts/claude-stability.mjs --start --hours 6 --key-label <label>` starts a deadline- and request-budget-limited window. Invoke the same script on a schedule to sample again; `--status` reads the record. Each round records its build and scenario version. A test-message policy refusal fails that check while the other scheduled checks continue; real credential or quota failures still stop the window. Checks never change stored credentials or start DSH.
- For continuous dialogs, use `node scripts/claude-conversation-check.mjs --model claude-haiku-5-5 --rounds 3 --key-label <label> --output .artifacts/claude-conversation.json`. One plugin adapter handles independent sessions; each group retains six user turns and full tool history, validates arithmetic, final JSON and unexpected characters, and stops on a failure without discarding evidence. Requests default to 65 seconds and 2048 output tokens. Diagnostic overrides use `--timeout-ms` (5000–300000) and `--max-tokens` (1024–128000). `--capture-wire` records the synthetic business requests, non-authentication headers and partial stream events for exact replay, without keys. Reports include scenario and adapter lifecycle, configured limits, response-header latency and total response time. These options do not alter the plugin's runtime settings.

</details>

## Update and uninstall

> **Upgrading from 1.3.2 or earlier:** install `dsh-packycode-api@1.3.4` on the Plugins page instead of clicking **Update plugin** in the old settings card. The old button bypasses pnpm's release-age policy: if the version it installs is less than 24 hours old, the profile refuses every other plugin install until that version is 24 hours old. After the install and a restart, the button is the fixed one, and later updates can use it.

**Update:** open **Settings → PackyCode** and, when a newer version is listed, click **Update plugin**. It installs that exact version into the owning profile with DSH's bundled pnpm and reads `package.json` back before reporting success. The install keeps pnpm's release-age policy instead of overriding it: by default pnpm installs the version at once and records it in the profile's `minimumReleaseAgeExclude`; under a stricter pnpm policy the button says when the update can run. A local `link:` checkout does not get the button. Then quit and reopen the desktop application. A page refresh does not reload the Host. Reinstalling from the **Plugins** page works too, again with the version in the package name (for example `dsh-packycode-api@1.3.4`); without it you may get a version that is merely the newest one published at least 24 hours ago.

**Coming back from a local-path install, uninstall first.** An update is a `pnpm add`: it rewrites the files inside the package directory and leaves a `node_modules` that an earlier local-path install left there. That older tree keeps shadowing the packages the DSH installation provides, so the plugin row fails to load with no visible reason. **Uninstall** runs `pnpm remove`, which deletes the package directory outright — only a reinstall after that is clean. `node scripts/install-check.mjs` reports whether a profile is in that state.

**Uninstall:** if you used PackyCode web search, first switch **Settings → PackyCode → Web search** back to the default. Then remove this plugin on the **Plugins** page and restart the desktop application. Otherwise `cordis.patch.yml` keeps a web entry naming a provider that no longer exists, and `web_search` fails with `configured web provider "packycode-api-auto" is not registered`; delete the block marked `dsh-packycode-api: web search provider` by hand to recover. Uninstalling does not remove other plugins, the profile, or the token in the PackyCode console.

## FAQ

**Installed, but Settings shows no PackyCode at all?** The plugin row failed to load at startup, and DSH only records that in the host log — the settings page shows no reason. Check with `node scripts/install-check.mjs` from this repository (read-only, no network); by hand, look for this directory:

```sh
ls ~/.dsh/profiles/desktop/node_modules/dsh-packycode-api/node_modules
```

Output means a leftover tree: a registry install ships no `node_modules`, so this one usually comes from an earlier local-path install (`file:`, or a bare path instead of `link:`). It sits inside the profile directory, and DSH resolves a plugin's imports from inside the profile first, so the plugin gets those old copies — for example `@deepseek-ai/schemastery` 3.18.2, which has no `Schema.volatile()`, so the module throws while it is imported. When an import fails the Loader creates no fiber for that row and no client bundle is composed either, so the model route, the RPC channel, and the settings panel all stay absent.

Recovery: **uninstall** the plugin on the **Plugins** page, **install** it again with the version in the package name (for example `dsh-packycode-api@1.3.4`), then quit and reopen the desktop application. Uninstall runs `pnpm remove` and deletes the whole package directory; reinstalling or clicking **Update** only rewrites files and keeps the leftover tree. Deleting that `node_modules` by hand and restarting works too.

**Right after a first install, every card in Settings shows `transport failure for /packycode-api/…: HTTP 405`?** The installed version is 1.1.6 or earlier, usually because only the bare package name was entered: the install prompt shows the newest version, but pnpm installs the newest one published at least 24 hours ago (see **Install the plugin**). Those older versions can register their settings channel only after DSH restarts and rebuilds its `connection` service. So right after a first install `/packycode-api` does not exist yet, requests fall through to the static page, and it answers 405; the model route and the settings panel itself load normally. From 1.1.7 on, a first install needs no restart. Check which version was installed:

```sh
grep '"version"' ~/.dsh/profiles/desktop/node_modules/dsh-packycode-api/package.json
```

Recovery: quit and reopen the desktop application, and the old version works. Then click **Check for updates** → **Update plugin** under **Settings → PackyCode → Plugin version** (it installs the exact latest version and is not subject to the 24-hour rule), and restart once more.

**Web search says "no stored API key's group covers …"?** The search backend's model is not in your token groups (or the gateway currently routes it to another supplier). Pick the other backend under **Settings → PackyCode → Web search**, or add a key whose group covers it.

**One model fails, but the key is valid?** Look at that key's groups and ✓ / ✕ under **Accounts and keys**. When its groups do not cover the model, use a key whose groups do, or add the group to the key in the PackyCode console. With such a key stored, the plugin runs that model on it automatically. A group refusal never disables a key.

**Claude reports an official-client-only or client-anomaly refusal?** This is a gateway client-policy refusal, not proof of an invalid key. See whether the key is marked “Claude via HTTP” or “via official CLI”: a `cc` key always uses the CLI, and other groups use HTTP. When a request the official CLI sent is still refused, the error carries the gateway's own words (with the request id); update Claude Code (`claude update`) and retry, then send it to PackyCode support if it persists. The plugin does not disable the key or switch providers.

**“Claude Code CLI is not available”?** The key is in `cc`, which needs the CLI on this device. Under **Settings → PackyCode → Claude Code CLI** click Install, or run `npm install -g @anthropic-ai/claude-code --allow-scripts=@anthropic-ai/claude-code` and click Check again; set `claudeCliPath` for an unusual location. Otherwise use a `cc-sale` / `cc-expensive` key.

**“The installed Claude Code CLI is too old”?** This device's CLI is older than 2.1.259. Under **Settings → PackyCode → Claude Code CLI** click **Update Claude Code CLI**, then resend; or run `claude update` in a terminal (for an npm install, the npm command the card shows) and click Check again. For a Homebrew install, run `brew upgrade claude-code`.

**The balance does not match the account bill?** Settings shows only each key stored here, with its own quota, not other tokens on the same PackyCode account. An API key cannot read the account's balance; check it in the PackyCode console. A key that failed to read says so on its own row.

**The balance reads `fetch failed` from `https://www.packyapi.com`?** That host, the default through 1.0.4, is DNS-poisoned on mainland networks and only answers through a proxy, so it works on and off. The default is now `https://www.packyapi.ai`. The model list is built into the plugin and never queried from PackyCode, so it is unaffected.

**A Claude model stays on “thinking”?** Check DSH errors or diagnostics. HTTP 429/503 means gateway queueing or throttling and follows the host retry policy; client-policy refusals are explained directly. Only Claude requests on the CLI route start the local Claude Code CLI, which is stopped and reported if it prints nothing for 90 seconds.

**A rate limit disabled the key?** It should not. HTTP 429 does not rotate. Exhausted quota or HTTP 401 does; after a top-up, click **Re-enable**.

**Installing from the Plugins page fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`?** By default pnpm accepts only versions published at least 24 hours ago and checks the whole profile lockfile. (Entering only this plugin's bare name does not raise this error; it silently installs an older version that has passed 24 hours instead, see **Install the plugin**.) The package it names is often another plugin that was just updated, not this one. Retry once it is 24 hours old, or add the reported `name@version` under `minimumReleaseAgeExclude` in the profile's `pnpm-workspace.yaml`. Once this plugin is installed, **Update plugin** in Settings is not subject to that check.

**Do I need Claude Code installed?** Only for Claude models on a `cc` key. The plugin runs it with its own config home and never touches your Claude Code login or settings; it updates the installation only when you click **Update Claude Code CLI**. Other groups and models do not need it.

**Replies stop at the output token limit (已达到输出 token 上限), or requests keep failing — how do I report it?** Open **Settings → PackyCode → Diagnostics**, pick the session (the 20 most recent, newest first, labelled with their folder name), click **Generate diagnostics** and then **Copy**, and paste the text into an [Issue](https://github.com/BaronCyrus/dsh-packycode-api/issues) or send it to the plugin author. It holds settings and numbers only: the plugin version, the session id and start time, each key's position and groups (no labels, no keys), each request's model, reasoning effort and output limit, the latest steps' token usage and finish reasons, and retry and failure codes (messages redacted and shortened). It contains no conversation text, file paths or keys. Where copying is unavailable, the text is selected instead; press ⌘C or Ctrl+C.

## Security and scope

This is a community plugin, not affiliated with or endorsed by DeepSeek or PackyCode. Model requests go to the PackyCode host you configured. Keeping credentials out of browser responses does not mean inference is local. Claude requests on `cc` keys are sent by a local Claude Code CLI child process: the key reaches it only through its environment, DSH's tools are offered through an MCP bridge bound to 127.0.0.1 behind a random capability, and the tools themselves still run in DSH on the host.

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

`node scripts/live-check.mjs` checks the live gateway through the same route the plugin registers: balance and groups, one answer per HTTP model, a rotation rehearsal, and the failure classification, printing only the key's last four characters. `--with-search` runs one search per backend; the default run spends a small amount of quota.

`node scripts/install-check.mjs` diagnoses an installed plugin that never appears: it reads one profile, lists any host package shadowed by a leftover `node_modules` inside an installed package (with versions) plus the recovery steps, and exits 1 when it finds one. `--profile <name>`, `--home <dir>`, and `--json` are available.

Read [AGENTS.md](AGENTS.md) before agent-assisted changes or a release. Publishing is the [Publish workflow](.github/workflows/publish.yml), triggered by pushing a `v*` tag: it publishes to npm, then creates the GitHub Release from `docs/releases/v<version>.md` with the same tarball. Do not run `npm publish` locally.

## License

[MIT](LICENSE)

## Support the author

This plugin is free and open source, and tips are entirely optional. If it saved you some hassle using PackyCode in DSH, a tip helps keep it current with new models and new DSH releases.

<table align="center">
  <tr>
    <td align="center"><img src="docs/assets/sponsor-wechat.png" width="200" alt="WeChat tip code"><br><b>WeChat</b></td>
    <td align="center"><img src="docs/assets/sponsor-alipay.png" width="200" alt="Alipay payment code"><br><b>Alipay</b></td>
  </tr>
</table>
