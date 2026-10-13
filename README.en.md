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
| **Visible balance** | Settings lists each key's remaining, used, limit, and reset period, plus a total of those keys. The composer shows the active key's remaining balance |
| **Claude through the local CLI** | `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5` run the official Claude Code CLI on this device. Settings can detect it and install it |
| **Credentials stay on the machine** | Keys live in the DSH credential file. The browser receives labels, state, and balances only |

## Install

You need **DeepSeek Harness** and a **PackyCode (PackyAPI) API key**. For DSH setup, see the [official instructions](https://github.com/deepseek-ai/deepseek-harness#run).

### 1. Install the plugin

Open the desktop application's **Plugins** page, click **Add plugin**, and enter this as the **package name or address**:

```text
dsh-packycode-api
```

Choose the **official** install source, then click **Install**. To pin a version, enter `dsh-packycode-api@1.0.6`.

Then **manually restart the desktop application**. Refreshing the page does not reload the plugin inside the Host process.

### 2. Add a key

Open **Settings → PackyCode**. Paste the API key under **Add a key**. A label is optional and only distinguishes keys. Click **Add**.

> Do not paste a key into a public issue, chat, or screenshot. The plugin does not read `PACKY_CODE_API_KEY` from the environment, and it does not silently switch to another provider when a request fails.

### 3. Select a model

Choose a model from the `PackyCode` group. `deepseek-flash`, `gpt-6.1-sol`, and `gpt-6-astra` work once a key is stored. The three Claude models also need the Claude Code CLI on this device; see below.

<details>
<summary>Verify the install / other profiles / a local checkout</summary>

The **Plugins** page shows the installed state and version, and is also where you enable, disable, or uninstall.

**For non-desktop profiles only:** `dsh plugin --profile <name> add dsh-packycode-api@1.0.6`. Do not use it for `desktop` — the CLI refuses it (`profile "desktop" is managed exclusively by the Electron application`).

A local checkout can be linked with `dsh plugin --profile <name> add link:/path/to/dsh-packycode-api`.

A profile without a browser can still use the model route. It just has no settings panel and no composer balance.

</details>

## Daily use

**Switch keys.** Keys are used in the order they were added. **Use this key** selects one; **Rename** changes its label (at most 60 characters, empty names are refused); **Re-enable** puts a disabled key back after a top-up or replacement.

**Read the balance.** The settings total is the remaining, used, and limit of **the keys listed here**, not the bill for every token on the PackyCode account. A key that could not be read is left out of the total and counted in a note; a key whose read failed this time but succeeded before keeps showing its last balance with the time it was read (the composer shows it as `≈US$…`) until DSH restarts. The composer shows the active key's remaining balance only while a PackyCode model is selected. **Refresh** bypasses the roughly 60-second cache. The default model host is `https://cf.api.fan` and the balance host is `https://www.packyapi.ai`; both can be changed under **Advanced: endpoints**. The old default, `https://www.packyapi.com`, is DNS-poisoned on mainland networks and answers `fetch failed` without a proxy; even when settings still name it, `.ai` is tried first.

**Use Claude.** The **Claude Code CLI** card at the top of Settings checks this device. If the CLI is missing, **Install Claude Code CLI** runs `npm install -g @anthropic-ai/claude-code` (Node.js 18+). No DSH restart is required after that install. Windows also needs [Git for Windows](https://git-scm.com/downloads/win).

<details>
<summary>When a key is rotated</summary>

- **Rotates and disables the current key:** the gateway reports exhausted quota, or it rejects the key (HTTP 401 / invalid token). The harness retries the failed step, which is what actually sends it on the next key.
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

**Uninstall:** remove this plugin on the **Plugins** page, then restart the desktop application. Uninstalling does not remove other plugins, the profile, or the token in the PackyCode console.

## FAQ

**One model fails, but the key is valid?** Check whether the token group covers that model. The `cc` group does not serve Claude to a normal API client; this plugin's Claude models need the local CLI. A group refusal does not disable the key or rotate to the next one.

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

`node scripts/live-check.mjs` checks the live gateway. It reads a key already stored on this machine and spends a small amount of quota.

Read [AGENTS.md](AGENTS.md) before agent-assisted changes or a release. Publishing is the [Publish workflow](.github/workflows/publish.yml), triggered by pushing a `v*` tag. Do not run `npm publish` locally.

## License

[MIT](LICENSE)
