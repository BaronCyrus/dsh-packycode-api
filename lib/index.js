import { randomUUID } from "node:crypto";
import { isAbsolute, join, posix, win32 } from "node:path";
import { LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { homedir, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
//#region src/constants.js
/**
* Identities and defaults this plugin owns.
*
* @module dsh-packycode-api/constants
*/
/** LLM provider route key; the model picker groups models under this id. */
const PROVIDER = "packycode";
/** Display name of the route in the picker and settings. */
const DISPLAY_NAME = "PackyCode";
/** Loader row id, settings namespace, and credential-record scope. */
const PLUGIN_ID = "packycode-api";
/** Loopback RPC channel the browser half talks to. */
const CHANNEL = "/packycode-api";
/** Settings namespace carrying host overrides. */
const SETTINGS_NAMESPACE = "packycode-api";
/** Credential record id inside the plugin's own scope. */
const KEY_RECORD_ID = "keys";
/**
* Model-traffic host. Each model declares the protocol its gateway route
* actually serves: `cf.api.fan/v1` answers chat/completions and responses,
* `cf.api.fan` answers the Anthropic Messages protocol at `/v1/messages`.
*/
const DEFAULT_API_HOST = "https://cf.api.fan";
/**
* Host carrying `/api/usage/token/`. `cf.api.fan` answers 404 for the whole
* `/api/*` family, so per-key quota is read from the PackyAPI host instead.
*/
const DEFAULT_STATUS_HOST = "https://www.packyapi.com";
/** PackyAPI quotes balances in quota units of 1/500000 USD (new-api convention). */
const QUOTA_PER_USD = 5e5;
/** Balance cache lifetime; a forced read bypasses it. */
const DEFAULT_BALANCE_TTL_MS = 6e4;
/** Bound on every account request this plugin makes. */
const DEFAULT_REQUEST_TIMEOUT_MS = 2e4;
/** Effort level the route requests when a session names none. */
const DEFAULT_REASONING_LEVEL = "high";
//#endregion
//#region src/balance.js
/**
* Account and per-key balance.
*
* PackyCode is a new-api style relay: `/api/usage/token/` reports the quota of
* the key that authorized the request, and `/v1/dashboard/billing/*` reports
* the account. Only the second family exists on the model host (`cf.api.fan`
* answers 404 for `/api/*`), so a read tries the configured host first and
* falls back to the PackyAPI host — the same fallback the PackyCode status
* tooling uses.
*
* Credentials and response bodies stay host-side; the browser receives only
* the projection built here.
*
* @module dsh-packycode-api/balance
*/
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => structuredClone(value);
function number(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
}
function money(quota) {
	const value = number(quota);
	if (value === void 0) return void 0;
	return Math.round(value / QUOTA_PER_USD * 1e6) / 1e6;
}
/** Normalize one quoted amount, treating the "no period limit" sentinel as absent. */
function quotaFields(prefix, quota) {
	const value = number(quota);
	if (value === void 0 || value === -1) return {};
	return {
		[`${prefix}Quota`]: value,
		[`${prefix}Usd`]: money(value)
	};
}
/**
* Normalize `/api/usage/token/`.
* @param payload - the endpoint's payload, wrapped or bare.
* @returns a small projection, or undefined when the shape is unrecognized.
*/
function parseTokenUsage(payload) {
	const data = record(payload?.data) ? payload.data : payload;
	if (!record(data)) return void 0;
	if (![
		"name",
		"quota_limit",
		"total_granted",
		"total_used",
		"total_available",
		"unlimited_quota",
		"quota_reset_period"
	].some((field) => data[field] !== void 0)) return void 0;
	const expiresAt = number(data.expires_at);
	return {
		unlimitedQuota: data.unlimited_quota === true,
		...typeof data.name === "string" && data.name !== "" ? { name: data.name } : {},
		...quotaFields("limit", data.quota_limit),
		...quotaFields("granted", data.total_granted),
		...quotaFields("used", data.total_used),
		...quotaFields("available", data.total_available),
		...typeof data.quota_reset_period === "string" && data.quota_reset_period !== "" ? { resetPeriod: data.quota_reset_period } : {},
		...expiresAt === void 0 || expiresAt <= 0 ? {} : { expiresAt }
	};
}
/** Normalize `/v1/dashboard/billing/subscription`. */
function parseBillingSubscription(payload) {
	if (!record(payload)) return void 0;
	return {
		...number(payload.soft_limit_usd) === void 0 ? {} : { softLimitUsd: number(payload.soft_limit_usd) },
		...number(payload.hard_limit_usd) === void 0 ? {} : { hardLimitUsd: number(payload.hard_limit_usd) },
		...number(payload.system_hard_limit_usd) === void 0 ? {} : { systemHardLimitUsd: number(payload.system_hard_limit_usd) },
		...number(payload.access_until) === void 0 || number(payload.access_until) <= 0 ? {} : { accessUntil: number(payload.access_until) }
	};
}
/** Normalize `/v1/dashboard/billing/usage`. */
function parseBillingUsage(payload) {
	if (!record(payload)) return void 0;
	const total = number(payload.total_usage);
	return total === void 0 ? {} : { totalUsageUsd: Math.round(total * 1e6) / 1e6 };
}
function statusMessage(status) {
	if (status === 401) return "this API key was rejected (401)";
	if (status === 402 || status === 403) return "the account cannot be read with this key (402/403)";
	return `the gateway answered HTTP ${status}`;
}
async function getJson(url, key, { fetchImpl, timeoutMs, signal }) {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal === void 0 ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
	const response = await fetchImpl(url, {
		headers: {
			Authorization: `Bearer ${key}`,
			Accept: "application/json"
		},
		redirect: "error",
		signal: requestSignal
	});
	if (!response.ok) throw new Error(statusMessage(response.status));
	return response.json();
}
async function withFallback(hosts, path, key, options) {
	const tried = [];
	for (const host of hosts) try {
		return {
			payload: await getJson(`${host}${path}`, key, options),
			host
		};
	} catch (error) {
		tried.push(`${host}: ${error instanceof Error ? error.message : String(error)}`);
	}
	throw new Error(tried.join("; "));
}
/**
* Cached, single-flight balance reader.
* @param options - key listing, host resolution, and transport knobs.
* @returns `{ read({force, signal}), invalidate() }`.
*/
function createBalanceReader({ listKeys, getHosts, fetchImpl = fetch, now = Date.now, ttlMs = DEFAULT_BALANCE_TTL_MS, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
	if (typeof listKeys !== "function") throw new Error("PackyCode balance reader requires listKeys");
	if (typeof getHosts !== "function") throw new Error("PackyCode balance reader requires getHosts");
	let cached;
	let inFlight;
	let generation = 0;
	const loadKey = async (entry, hosts, signal) => {
		const { payload } = await withFallback([.../* @__PURE__ */ new Set([
			hosts.statusHost,
			DEFAULT_STATUS_HOST,
			hosts.apiHost,
			DEFAULT_API_HOST
		])], "/api/usage/token/", entry.key, {
			fetchImpl,
			timeoutMs,
			signal
		});
		const usage = parseTokenUsage(payload);
		if (usage === void 0) throw new Error("the gateway returned an unrecognized usage payload");
		return usage;
	};
	/**
	* The account endpoints need one working key. Candidates are ordered by
	* evidence: a key whose per-key read just succeeded, then the key that
	* answered this read last time, then the rest — so an invalid key sitting
	* first in the ring cannot blank the account total.
	*/
	let accountKeyId;
	const loadAccount = async (keys, hosts, signal, usableIds = []) => {
		const candidates = [.../* @__PURE__ */ new Set([
			...usableIds,
			accountKeyId,
			...keys.filter((entry) => entry.disabled !== true).map((entry) => entry.id)
		])].map((id) => keys.find((entry) => entry.id === id)).filter((entry) => entry !== void 0);
		if (candidates.length === 0) throw new Error("add a PackyCode API key to read the account balance");
		const hostsToTry = [.../* @__PURE__ */ new Set([
			hosts.apiHost,
			DEFAULT_API_HOST,
			hosts.statusHost,
			DEFAULT_STATUS_HOST
		])];
		const options = {
			fetchImpl,
			timeoutMs,
			signal
		};
		let lastError;
		for (const key of candidates) try {
			const subscription = parseBillingSubscription((await withFallback(hostsToTry, "/v1/dashboard/billing/subscription", key.key, options)).payload);
			const usage = parseBillingUsage((await withFallback(hostsToTry, "/v1/dashboard/billing/usage", key.key, options)).payload);
			const remaining = subscription?.hardLimitUsd === void 0 || usage?.totalUsageUsd === void 0 ? void 0 : Math.round((subscription.hardLimitUsd - usage.totalUsageUsd) * 1e6) / 1e6;
			accountKeyId = key.id;
			return {
				...subscription,
				...usage,
				...remaining === void 0 ? {} : { remainingUsd: remaining },
				keyId: key.id
			};
		} catch (error) {
			lastError = error;
		}
		throw lastError;
	};
	const load = async (signal) => {
		signal?.throwIfAborted();
		const hosts = getHosts();
		const keys = await listKeys();
		const entries = [];
		const usableIds = [];
		for (const entry of keys) {
			const base = {
				id: entry.id,
				label: entry.label,
				disabled: entry.disabled === true
			};
			try {
				entries.push({
					...base,
					usage: await loadKey(entry, hosts, signal)
				});
				usableIds.push(entry.id);
			} catch (error) {
				entries.push({
					...base,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
		let account;
		try {
			account = await loadAccount(keys, hosts, signal, usableIds);
		} catch (error) {
			account = { error: error instanceof Error ? error.message : String(error) };
		}
		return {
			keys: entries,
			account,
			hosts,
			fetchedAt: now()
		};
	};
	return Object.freeze({
		async read({ force = false, signal } = {}) {
			signal?.throwIfAborted();
			if (!force && cached !== void 0 && now() - cached.fetchedAt < ttlMs) return clone(cached);
			const createPending = (requestSignal) => {
				const observedGeneration = generation;
				return load(requestSignal).then((value) => {
					if (generation === observedGeneration) cached = value;
					return value;
				});
			};
			if (force) return clone(await createPending(signal));
			const pending = inFlight ?? createPending();
			if (inFlight === void 0) {
				inFlight = pending;
				const clear = () => {
					if (inFlight === pending) inFlight = void 0;
				};
				pending.then(clear, clear);
			}
			return clone(await pending);
		},
		invalidate() {
			generation += 1;
			cached = void 0;
		}
	});
}
//#endregion
//#region src/claude-adapter.js
/**
* Route Claude models through the local Claude Code CLI.
*
* PackyCode's `cc` group serves its Claude models only to the official CLI, so
* selecting one of those models runs that CLI instead of an HTTP request. The
* other models on the route keep using the pi-ai adapter untouched — this
* adapter only dispatches.
*
* A CLI-backed turn is a *delegation*: the CLI runs its own agent loop with
* its own tools and returns one answer. The CLI cannot call the harness's
* tools, so `options.tools` is deliberately not forwarded, and the harness's
* system prompt is dropped in favour of the CLI's own. While it works, its
* thinking and tool activity stream into a reasoning block and its answer
* streams as text.
*
* A session-title request is not a delegation: it runs on the small model,
* read-only and outside the workspace, with the title instructions appended,
* so naming a session does not cost an Opus agent turn.
*
* @module dsh-packycode-api/claude-adapter
*/
/** Models this route serves through the CLI rather than an HTTP API. */
const CLI_BACKED_MODEL_IDS = Object.freeze([
	"claude-opus-5-5",
	"claude-sonnet-5-5",
	"claude-haiku-5-5"
]);
/** The model a session title is generated with when the session runs on the CLI. */
const TITLE_MODEL_ID = "claude-haiku-5-5";
/** How much of the conversation a delegated prompt carries. */
const MAX_PROMPT_CHARS$1 = 48e3;
const MAX_BLOCK_CHARS = 8e3;
/** Render one content block as text a CLI prompt can carry. */
function renderBlock(block) {
	if (block === null || typeof block !== "object") return "";
	if (block.type === "text" && typeof block.text === "string") return block.text;
	if (block.type === "image") return "[图片]";
	if (block.type === "tool-call" || block.type === "tool-call-delta") return `[调用工具 ${block.name ?? block.id ?? ""}]`;
	if (block.type === "tool-result") return `[工具结果] ${(typeof block.content === "string" ? block.content : "").slice(0, MAX_BLOCK_CHARS)}`;
	if (block.type === "reasoning") return "";
	return "";
}
/**
* Emit text and reasoning as well-formed harness blocks.
*
* The harness's stream grammar requires every delta to address an open block
* of its own type, so each run of one kind is bracketed by `block-start` and
* `block-end`. Tool progress goes into reasoning: the UI shows it live as the
* turn's working process, and it never re-enters a later delegated prompt.
*/
function createBlockWriter() {
	let index = -1;
	let open;
	const close = function* () {
		if (open === void 0) return;
		yield {
			type: "block-end",
			index,
			block: {
				type: open.kind,
				text: open.text
			}
		};
		open = void 0;
	};
	const write = function* (kind, text) {
		if (typeof text !== "string" || text === "") return;
		if (open?.kind !== kind) {
			yield* close();
			index += 1;
			open = {
				kind,
				text: ""
			};
			yield {
				type: "block-start",
				index,
				blockType: kind
			};
		}
		open.text += text;
		yield {
			type: kind === "text" ? "text-delta" : "reasoning-delta",
			index,
			text
		};
	};
	return {
		/** A CLI content block started; the next write opens a fresh harness block. */
		boundary(kind) {
			if (open !== void 0 && open.kind === kind) open.sealed = true;
		},
		*write(kind, text) {
			if (open?.sealed === true) yield* close();
			yield* write(kind, text);
		},
		*note(line) {
			const separator = open?.kind === "reasoning" && open.text !== "" && !open.text.endsWith("\n") ? "\n" : "";
			if (open?.kind === "reasoning") open.sealed = false;
			yield* write("reasoning", `${separator}${line}`);
		},
		close
	};
}
/**
* The turn's usage in the harness's disjoint buckets.
*
* The prompt side is the CLI's *last* request — the context it actually
* occupied and how much of it hit the cache — because the harness reads the
* prompt side as context pressure, and summing a multi-step CLI turn would
* count the same context once per step. Output is the CLI's whole-turn total.
*/
function turnUsage(lastRequest, finished) {
	const outputTokens = finished?.outputTokens ?? 0;
	if (lastRequest !== void 0) return {
		inputTokens: lastRequest.inputTokens,
		outputTokens,
		cacheReadTokens: lastRequest.cacheReadTokens,
		cacheWriteTokens: lastRequest.cacheWriteTokens
	};
	return {
		inputTokens: finished?.inputTokens ?? 0,
		outputTokens,
		cacheReadTokens: finished?.cacheReadTokens ?? 0,
		cacheWriteTokens: finished?.cacheWriteTokens ?? 0
	};
}
/**
* Turn an assembled request into one CLI prompt.
*
* The leading system message carries the harness's system prompt, which
* describes tools this model cannot call; the CLI brings its own instead.
* @param options - the assembled request.
* @param cwd - the working directory the CLI will run in, when known.
* @returns the prompt text.
*/
function renderDelegatedPrompt(options, cwd) {
	const messages = Array.isArray(options?.messages) ? options.messages : [];
	const turns = [];
	for (const message of messages) {
		if (message === null || typeof message !== "object") continue;
		if (message.role === "system") continue;
		const text = (Array.isArray(message.content) ? message.content : []).map(renderBlock).filter((part) => part !== "").join("\n").trim();
		if (text === "") continue;
		const label = message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : String(message.role);
		turns.push(`${label}：${text}`);
	}
	let transcript = turns.join("\n\n");
	if (transcript.length > MAX_PROMPT_CHARS$1) transcript = `…（较早对话已截断）\n\n${transcript.slice(-48e3)}`;
	const system = typeof options?.system === "string" && options.system.trim() !== "" ? options.system.trim() : "";
	return `${[
		"[本回合由 DeepSeek Harness 委派给 Claude Code CLI 执行。请用你自己的工具完成任务，直接输出最终结果；不要反问、不要复述流程。]",
		cwd === void 0 ? void 0 : `[工作目录：${cwd}]`,
		system === "" ? void 0 : `[补充说明：${system.slice(0, 2e3)}]`
	].filter((part) => part !== void 0).join("\n")}\n\n${transcript}`.trim();
}
/**
* The prompt of a one-shot auxiliary request: its messages' text, verbatim.
* The caller frames its own input, so nothing is added around it.
* @param options - the assembled request.
* @returns the prompt text.
*/
function renderAuxiliaryPrompt(options) {
	return (Array.isArray(options?.messages) ? options.messages : []).filter((message) => message !== null && typeof message === "object" && message.role !== "system").flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n\n").trim();
}
/**
* How one request runs on the CLI: a title request on the small model with
* the caller's instructions appended, anything else as a delegated turn.
*
* The CLI's own system prompt and tool set stay in place even for a title:
* they are part of what the gateway sees from the official client.
*/
function cliCall(options, { titleModel, cwdOf, modeOf }) {
	if (options?.purpose === "session-title") return {
		prompt: renderAuxiliaryPrompt(options),
		model: titleModel,
		mode: "read-only",
		appendSystemPrompt: typeof options.system === "string" ? options.system : void 0,
		cwd: tmpdir()
	};
	const cwd = cwdOf();
	return {
		prompt: renderDelegatedPrompt(options, cwd),
		model: options.model,
		mode: modeOf(),
		cwd
	};
}
/**
* Wrap an adapter so the CLI-backed models run through the local CLI.
*
* @param options - the inner adapter, the CLI runner, the CLI-backed model ids,
*   the model session titles run on, and the mode and working directory each
*   turn runs with.
* @returns an adapter with the same provider surface.
*/
function createClaudeCliAdapter({ inner, runner, modelIds = CLI_BACKED_MODEL_IDS, titleModel = TITLE_MODEL_ID, resolveMode, resolveCwd }) {
	if (inner === void 0 || inner === null) throw new Error("the CLI adapter needs an inner adapter");
	if (runner === void 0 || runner === null) throw new Error("the CLI adapter needs a runner");
	const cliModels = new Set(modelIds);
	/** The mode is read per turn so a settings change applies without a reload. */
	const modeOf = () => typeof resolveMode === "function" ? resolveMode() : void 0;
	const cwdOf = () => typeof resolveCwd === "function" ? resolveCwd() : void 0;
	async function* cliStream(options) {
		let call;
		try {
			call = cliCall(options, {
				titleModel,
				cwdOf,
				modeOf
			});
		} catch (error) {
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						code: "PI_AI_ERROR",
						message: String(error?.message ?? error)
					}
				}
			};
			return;
		}
		const blocks = createBlockWriter();
		const seen = /* @__PURE__ */ new Set();
		const firstSighting = (key) => {
			if (key.endsWith(":")) return true;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		};
		try {
			let finished;
			let lastRequest;
			for await (const event of runner.stream({
				...call,
				signal: options.signal
			})) switch (event.type) {
				case "block":
					blocks.boundary(event.kind);
					break;
				case "text":
					yield* blocks.write("text", event.text);
					break;
				case "reasoning":
					yield* blocks.write("reasoning", event.text);
					break;
				case "tool":
					if (firstSighting(`tool:${event.id}`)) yield* blocks.note(`▸ ${event.summary}\n`);
					break;
				case "tool-error":
					if (firstSighting(`error:${event.id}`)) yield* blocks.note(`  ✗ ${event.text === "" ? "失败" : event.text}\n`);
					break;
				case "request-usage":
					lastRequest = event.usage;
					break;
				case "result":
					finished = event.result;
					break;
				default: break;
			}
			yield* blocks.close();
			yield {
				type: "usage",
				usage: turnUsage(lastRequest, finished)
			};
			yield {
				type: "finish",
				reason: { kind: "stop" }
			};
		} catch (error) {
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						code: "PI_AI_ERROR",
						message: String(error?.message ?? error)
					}
				}
			};
		}
	}
	return new class extends LlmAdapter {
		providerInfo(provider) {
			return inner.providerInfo(provider);
		}
		providerRetryPolicy(provider) {
			return inner.providerRetryPolicy?.(provider);
		}
		listModels(provider) {
			return inner.listModels(provider);
		}
		resolveModel(provider, model, signal) {
			return inner.resolveModel(provider, model, signal);
		}
		async prepareCall(provider, model, signal) {
			if (!cliModels.has(model)) return await inner.prepareCall(provider, model, signal);
			return {
				model: await inner.resolveModel(provider, model, signal),
				stream: (options) => cliStream(options)
			};
		}
		stream(options) {
			return cliModels.has(options.model) ? cliStream(options) : inner.stream(options);
		}
	}();
}
//#endregion
//#region src/locate.js
/**
* Finding programs on macOS, Linux, and Windows.
*
* A desktop app launched from Finder or the Start menu inherits a much shorter
* PATH than a terminal, so a lookup that trusts PATH alone misses an npm or
* Claude Code install the user can run from their shell. These helpers walk
* PATH the way the platform's own shell would, and know the usual install
* directories it may lack.
*
* @module dsh-packycode-api/locate
*/
/** The path flavour of `platform`, so a Windows layout is testable on macOS. */
const pathFor = (platform) => platform === "win32" ? win32 : posix;
const listDirectory = (directory) => {
	try {
		return readdirSync(directory);
	} catch {
		return [];
	}
};
/** The environment's PATH key: Windows spells it `Path` and compares case-insensitively. */
function pathKey(env, platform = process.platform) {
	if (platform !== "win32") return "PATH";
	return Object.keys(env ?? {}).find((name) => name.toUpperCase() === "PATH") ?? "Path";
}
/** Numeric `vX.Y.Z` ordering, newest first, for nvm's per-version directories. */
function newestFirst(a, b) {
	const parts = (value) => value.replace(/^v/u, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
	const left = parts(a);
	const right = parts(b);
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const delta = (right[index] ?? 0) - (left[index] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}
/**
* The `bin` directories of every Node version nvm installed, newest first.
* @param options - home directory, environment, and a directory reader.
* @returns absolute directories; empty when nvm is absent.
*/
function nvmBinDirs({ home, env = process.env, platform = process.platform, readdir = listDirectory } = {}) {
	if (platform === "win32") return [];
	const path = pathFor(platform);
	const root = path.join(env.NVM_DIR ?? path.join(home, ".nvm"), "versions", "node");
	return readdir(root).filter((name) => /^v\d/u.test(name)).sort(newestFirst).map((name) => path.join(root, name, "bin"));
}
/**
* Look a program up on PATH.
* @param names - file names to try in each directory, in order (on Windows
*   pass the real file names, e.g. `claude.exe` and `claude.cmd`).
* @param options - platform, environment, and an existence check.
* @returns the first existing absolute path, or undefined.
*/
function searchPath(names, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
	const path = pathFor(platform);
	const value = env?.[pathKey(env, platform)];
	if (typeof value !== "string" || value === "") return void 0;
	for (const raw of value.split(platform === "win32" ? ";" : ":")) {
		const directory = raw.trim().replace(/^"(.*)"$/u, "$1");
		if (directory === "") continue;
		for (const name of names) {
			const candidate = path.join(directory, name);
			if (exists(candidate)) return candidate;
		}
	}
}
/**
* An environment whose PATH starts with the directory a program lives in.
*
* npm's and the npm-installed CLI's launchers start with `#!/usr/bin/env node`,
* and nvm, Homebrew, and the official installers put `node` beside them; a
* GUI-launched host whose PATH lacks that directory would otherwise fail with
* `env: node: No such file or directory`.
* @param env - the environment to extend; not modified.
* @param program - the program's path; a bare name leaves PATH alone.
* @param platform - which path rules apply.
* @returns a new environment.
*/
function withProgramDirOnPath(env, program, platform = process.platform) {
	const path = pathFor(platform);
	if (typeof program !== "string" || !path.isAbsolute(program)) return { ...env };
	const key = pathKey(env, platform);
	const separator = platform === "win32" ? ";" : ":";
	const directory = path.dirname(program);
	const entries = (typeof env?.[key] === "string" ? env[key] : "").split(separator).filter((entry) => entry !== "");
	if (entries.includes(directory)) return { ...env };
	return {
		...env,
		[key]: [directory, ...entries].join(separator)
	};
}
//#endregion
//#region src/claude-cli.js
/**
* Bridge to the local Claude Code CLI.
*
* The gateway's `cc` group serves its Claude models only to the official CLI,
* so this module runs that CLI — the real binary, not an imitation of it — as
* a subprocess and hands its final answer back to the harness. The child gets
* the plugin's own endpoint and key through the environment, plus an isolated
* `CLAUDE_CONFIG_DIR`: `~/.claude/settings.json` env wins over an inherited
* environment, so without that isolation the user's own CLI configuration
* would silently override both.
*
* @module dsh-packycode-api/claude-cli
*/
/**
* What the delegated CLI may do on its own. The CLI runs its own tool loop;
* these are its permission switches, not the harness's sandbox.
*/
const CLAUDE_CLI_MODES = Object.freeze({
	"read-only": Object.freeze({ allowedTools: Object.freeze([
		"Read",
		"Grep",
		"Glob"
	]) }),
	edit: Object.freeze({ allowedTools: Object.freeze([
		"Read",
		"Grep",
		"Glob",
		"Edit",
		"Write",
		"NotebookEdit"
	]) }),
	full: Object.freeze({ skipPermissions: true })
});
const DEFAULT_CLAUDE_MODE = "edit";
/** Isolated CLI home; the plugin owns the endpoint and key it runs with. */
const DEFAULT_CLAUDE_CONFIG_DIR = join(homedir(), ".dsh", "packycode-claude-cli");
const DEFAULT_CLAUDE_TIMEOUT_MS = 1800 * 1e3;
/** Argument lists travel through argv, which the kernel bounds. */
const MAX_PROMPT_CHARS = 1e5;
const KILL_GRACE_MS = 3e3;
/** The npm package the official CLI ships as. */
const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";
/** What the turn reports when no CLI could be started at all. */
const CLAUDE_MISSING_MESSAGE = "Claude Code CLI is not installed on this device, and Claude models on the PackyCode route run through it. Install it under Settings → PackyCode, or run: npm install -g @anthropic-ai/claude-code";
/** The CLI's file names on PATH: the native installer ships an `.exe`, npm a `.cmd` launcher. */
const claudeFileNames = (platform) => platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
/**
* Where the official installer, npm, and the common Node managers put the CLI,
* in the order they are tried. PATH is searched after these.
* @param options - platform, home directory, environment, and a directory reader.
* @returns absolute candidate paths.
*/
function claudeBinaryCandidates({ platform = process.platform, home = homedir(), env = process.env, readdir } = {}) {
	const path = pathFor(platform);
	if (platform === "win32") {
		const appData = env.APPDATA ?? path.join(home, "AppData", "Roaming");
		return [
			path.join(home, ".local", "bin", "claude.exe"),
			path.join(appData, "npm", "claude.cmd"),
			...env.NVM_SYMLINK ? [path.join(env.NVM_SYMLINK, "claude.cmd")] : [],
			path.join(env.ProgramFiles ?? "C:\\Program Files", "nodejs", "claude.cmd")
		];
	}
	return [
		path.join(home, ".local", "bin", "claude"),
		path.join(home, ".claude", "local", "claude"),
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
		path.join(home, ".npm-global", "bin", "claude"),
		path.join(home, ".volta", "bin", "claude"),
		...nvmBinDirs({
			home,
			env,
			platform,
			readdir
		}).map((directory) => path.join(directory, "claude"))
	];
}
/**
* Locate an installed Claude Code CLI.
* @param options - a configured path (wins when it exists), plus platform,
*   home, environment, and file-system seams.
* @returns an absolute path, or undefined when none is installed.
*/
function locateClaudeBinary({ explicit, platform = process.platform, home = homedir(), env = process.env, exists = existsSync, readdir } = {}) {
	const configured = typeof explicit === "string" ? explicit.trim() : "";
	if (configured !== "") {
		if (pathFor(platform).isAbsolute(configured)) return exists(configured) ? configured : void 0;
		return searchPath(platform === "win32" && !/\.[a-z]+$/iu.test(configured) ? [`${configured}.exe`, `${configured}.cmd`] : [configured], {
			platform,
			env,
			exists
		});
	}
	for (const candidate of claudeBinaryCandidates({
		platform,
		home,
		env,
		readdir
	})) if (exists(candidate)) return candidate;
	return searchPath(claudeFileNames(platform), {
		platform,
		env,
		exists
	});
}
/**
* Locate the Claude Code CLI.
* @param explicit - a configured path, when the deployment names one.
* @returns an absolute path when one exists, otherwise the configured value or
*   the bare name, so starting it reports what is missing.
*/
function findClaudeBinary(explicit) {
	const configured = typeof explicit === "string" ? explicit.trim() : "";
	return locateClaudeBinary({ explicit: configured }) ?? (configured === "" ? "claude" : configured);
}
/** The program an npm `.cmd` launcher runs, relative to the launcher's own directory. */
const SHIM_TARGET = /"%(?:~dp0|dp0%)\\([^"%]+?\.(?:c?js|mjs|exe))"/giu;
/**
* Turn a located CLI into something `spawn` can start without a shell.
*
* On Windows npm installs `claude.cmd`, and Node refuses to start a `.cmd`
* without `shell: true` — which would hand the prompt to `cmd.exe` to parse.
* The launcher only forwards to a program beside it, so that program is
* started directly instead: `node <cli.js>` or the packaged `.exe`.
* @param binary - the located CLI.
* @param options - platform and file-system seams.
* @returns the command and the arguments that precede the CLI's own.
*/
function resolveSpawnCommand(binary, { platform = process.platform, exists = existsSync, readFile = (file) => readFileSync(file, "utf8") } = {}) {
	if (platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(binary)) return {
		command: binary,
		args: []
	};
	const path = pathFor(platform);
	const directory = path.dirname(binary);
	let relative;
	try {
		relative = [...readFile(binary).matchAll(SHIM_TARGET)].map((match) => match[1]).find((target) => !/^node\.exe$/iu.test(target));
	} catch {}
	const target = relative === void 0 ? path.join(directory, "node_modules", ...CLAUDE_NPM_PACKAGE.split("/"), "cli.js") : path.join(directory, relative);
	if (!exists(target)) throw new Error(`Claude Code CLI launcher ${binary} points at a missing program; reinstall it with npm install -g ${CLAUDE_NPM_PACKAGE}`);
	if (/\.exe$/iu.test(target)) return {
		command: target,
		args: []
	};
	const bundledNode = path.join(directory, "node.exe");
	return {
		command: exists(bundledNode) ? bundledNode : "node",
		args: [target]
	};
}
/**
* Build the CLI arguments for one delegated task.
* @param options - the prompt, the permission mode, an optional model, whether
*   the caller consumes the streaming protocol, and optional instructions
*   appended to the CLI's own system prompt. The CLI's system prompt and tool
*   set are never replaced: they are part of what the official client sends.
* @returns argv after the binary name.
*/
function buildClaudeArgs({ prompt, mode = DEFAULT_CLAUDE_MODE, model, stream = false, appendSystemPrompt } = {}) {
	const text = typeof prompt === "string" ? prompt : "";
	if (text.trim() === "") throw new Error("claude_code needs a non-empty prompt");
	if (text.length > MAX_PROMPT_CHARS) throw new Error(`claude_code prompt is too long (${text.length} > ${MAX_PROMPT_CHARS} characters)`);
	const spec = CLAUDE_CLI_MODES[mode];
	if (spec === void 0) throw new Error(`claude_code mode must be one of ${Object.keys(CLAUDE_CLI_MODES).join(", ")}`);
	const args = [
		"-p",
		text,
		"--output-format",
		stream ? "stream-json" : "json"
	];
	if (stream) args.push("--include-partial-messages", "--verbose");
	const named = typeof model === "string" ? model.trim() : "";
	if (named !== "") args.push("--model", named);
	const appended = typeof appendSystemPrompt === "string" ? appendSystemPrompt.trim() : "";
	if (appended !== "") args.push("--append-system-prompt", appended);
	if (spec.skipPermissions === true) args.push("--dangerously-skip-permissions");
	else args.push("--allowedTools", ...spec.allowedTools);
	return args;
}
/**
* The child's environment: this plugin's endpoint and key, an isolated config
* home, and the CLI's own network-noise switches off.
* @param options - credential, config home, and the parent environment.
* @returns the environment for the child process.
*/
function buildClaudeEnvironment({ baseUrl, token, configDir = DEFAULT_CLAUDE_CONFIG_DIR, parent = process.env } = {}) {
	if (typeof token !== "string" || token === "") throw new Error("claude_code has no PackyCode API key to run with");
	const env = { ...parent };
	delete env.ANTHROPIC_API_KEY;
	delete env.CLAUDE_CODE_OAUTH_TOKEN;
	delete env.CLAUDE_CODE_USE_BEDROCK;
	delete env.CLAUDE_CODE_USE_VERTEX;
	return {
		...env,
		ANTHROPIC_BASE_URL: baseUrl,
		ANTHROPIC_AUTH_TOKEN: token,
		CLAUDE_CONFIG_DIR: configDir,
		DISABLE_AUTOUPDATER: "1",
		DISABLE_TELEMETRY: "1",
		DISABLE_ERROR_REPORTING: "1",
		DISABLE_BUG_COMMAND: "1",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
	};
}
/**
* Read the CLI's `--output-format json` payload.
* @param stdout - the child's stdout.
* @returns the parsed payload, or undefined when nothing usable was printed.
*/
function parseClaudeResult(stdout) {
	const text = typeof stdout === "string" ? stdout : "";
	for (const line of text.split("\n").reverse()) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const value = JSON.parse(trimmed);
			if (value !== null && typeof value === "object" && ("result" in value || "is_error" in value)) return value;
		} catch {}
	}
}
/** Turn a CLI failure into a message that names what the CLI reported. */
function failureMessage(parsed, exitCode, stderr) {
	const reported = typeof parsed?.result === "string" && parsed.result.trim() !== "" ? parsed.result.trim() : void 0;
	if (reported !== void 0) return `Claude Code CLI failed: ${reported}`;
	const detail = (typeof stderr === "string" ? stderr : "").trim().split("\n").slice(-4).join(" ").slice(0, 400);
	return detail === "" ? `Claude Code CLI exited with code ${exitCode ?? "unknown"}` : `Claude Code CLI exited with code ${exitCode ?? "unknown"}: ${detail}`;
}
const MAX_TOOL_SUMMARY_CHARS = 160;
/** Tool inputs worth showing, in the order a reader looks for them. */
const TOOL_SUMMARY_FIELDS = Object.freeze([
	"command",
	"file_path",
	"notebook_path",
	"pattern",
	"url",
	"query",
	"description",
	"prompt",
	"path"
]);
function oneLine(text, limit = MAX_TOOL_SUMMARY_CHARS) {
	const flat = String(text).replace(/\s+/gu, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}
/**
* A one-line description of one tool call, for progress display.
* @param name - the CLI tool name.
* @param input - the tool call's input object.
* @returns e.g. `Bash · git status`.
*/
function summarizeToolUse(name, input) {
	const label = typeof name === "string" && name !== "" ? name : "tool";
	if (input === null || typeof input !== "object") return label;
	for (const field of TOOL_SUMMARY_FIELDS) {
		const value = input[field];
		if (typeof value === "string" && value.trim() !== "") return `${label} · ${oneLine(value)}`;
	}
	return label;
}
/** One API request's prompt side, in the harness's disjoint buckets. */
function promptUsageOf(usage) {
	if (usage === null || typeof usage !== "object" || typeof usage.input_tokens !== "number") return void 0;
	return {
		inputTokens: usage.input_tokens,
		cacheReadTokens: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0,
		cacheWriteTokens: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0
	};
}
function toolResultText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "").join(" ");
}
/**
* Read one `--output-format stream-json` line.
*
* The CLI prints both partial deltas (`stream_event`) and each finished
* message (`assistant`/`user`); deltas carry the live text and thinking, the
* finished messages carry complete tool inputs and results.
* @param event - a parsed stream-json line.
* @returns what the caller can act on; empty for noise.
*/
function readClaudeStreamEvents(event) {
	if (event === null || typeof event !== "object") return [];
	if (event.type === "stream_event") {
		const inner = event.event;
		switch (inner?.type) {
			case "message_start": {
				const usage = promptUsageOf(inner.message?.usage);
				return usage === void 0 ? [] : [{
					type: "request-usage",
					usage
				}];
			}
			case "content_block_start": {
				const kind = inner.content_block?.type;
				if (kind === "text") return [{
					type: "block",
					kind: "text"
				}];
				if (kind === "thinking") return [{
					type: "block",
					kind: "reasoning"
				}];
				return [];
			}
			case "content_block_delta": {
				const delta = inner.delta;
				if (delta?.type === "text_delta" && typeof delta.text === "string") return [{
					type: "text",
					text: delta.text
				}];
				if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") return [{
					type: "reasoning",
					text: delta.thinking
				}];
				return [];
			}
			default: return [];
		}
	}
	if (event.type === "assistant") {
		const events = (Array.isArray(event.message?.content) ? event.message.content : []).filter((block) => block?.type === "tool_use").map((block) => ({
			type: "tool",
			id: String(block.id ?? ""),
			summary: summarizeToolUse(block.name, block.input)
		}));
		const usage = promptUsageOf(event.message?.usage);
		return usage === void 0 ? events : [{
			type: "request-usage",
			usage
		}, ...events];
	}
	if (event.type === "user") return (Array.isArray(event.message?.content) ? event.message.content : []).filter((block) => block?.type === "tool_result" && block.is_error === true).map((block) => ({
		type: "tool-error",
		id: String(block.tool_use_id ?? ""),
		text: oneLine(toolResultText(block.content))
	}));
	if (event.type === "result") return [{
		type: "result",
		result: event
	}];
	return [];
}
/**
* A Claude Code CLI runner.
* @param options - binary (a path, or a function resolving one per run so a
*   CLI installed after startup is picked up), config home, credential
*   resolution, and process seams.
* @returns `{ run({ prompt, mode, model, cwd, signal }) }`.
*/
function createClaudeRunner({ binary = findClaudeBinary(), configDir = DEFAULT_CLAUDE_CONFIG_DIR, resolveCredential, spawnImpl = spawn, timeoutMs = DEFAULT_CLAUDE_TIMEOUT_MS, platform = process.platform } = {}) {
	if (typeof resolveCredential !== "function") throw new Error("the Claude Code CLI runner needs resolveCredential");
	/**
	* Spawn one CLI process and own its lifetime: capture both pipes, enforce the
	* timeout, and kill the process — with a grace period — when the caller
	* aborts. Both public entry points share it.
	*/
	const start = async ({ prompt, mode, model, appendSystemPrompt, cwd, signal, stream, onStdout }) => {
		const args = buildClaudeArgs({
			prompt,
			mode,
			model,
			stream,
			appendSystemPrompt
		});
		const { baseUrl, token } = await resolveCredential();
		const program = typeof binary === "function" ? await binary() : binary;
		const command = resolveSpawnCommand(program, { platform });
		const env = withProgramDirOnPath(buildClaudeEnvironment({
			baseUrl,
			token,
			configDir
		}), program, platform);
		const child = spawnImpl(command.command, [...command.args, ...args], {
			cwd,
			env,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		const state = {
			stdout: "",
			stderr: "",
			timedOut: false,
			settled: false
		};
		const kill = () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGTERM");
			setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
			}, KILL_GRACE_MS).unref?.();
		};
		const timer = timeoutMs > 0 ? setTimeout(() => {
			state.timedOut = true;
			kill();
		}, timeoutMs) : void 0;
		timer?.unref?.();
		const onAbort = () => kill();
		signal?.addEventListener("abort", onAbort, { once: true });
		const release = () => {
			if (state.settled) return;
			state.settled = true;
			if (timer !== void 0) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		child.stdout?.setEncoding?.("utf8");
		child.stderr?.setEncoding?.("utf8");
		child.stdout?.on("data", (chunk) => {
			const text = String(chunk);
			state.stdout = (state.stdout + text).slice(-4194304);
			onStdout?.(text);
		});
		child.stderr?.on("data", (chunk) => {
			state.stderr = (state.stderr + String(chunk)).slice(-4194304);
		});
		const closed = new Promise((resolve, reject) => {
			child.on("error", (error) => {
				release();
				reject(error.code === "ENOENT" && !(pathFor(platform).isAbsolute(program) && existsSync(program)) ? new Error(CLAUDE_MISSING_MESSAGE, { cause: error }) : new Error(`claude_code could not run ${program}: ${error.message}`, { cause: error }));
			});
			child.on("close", (code, killSignal) => {
				release();
				if (state.timedOut) {
					reject(/* @__PURE__ */ new Error(`claude_code timed out after ${Math.round(timeoutMs / 1e3)}s`));
					return;
				}
				if (signal?.aborted === true) {
					reject(/* @__PURE__ */ new Error("claude_code was aborted"));
					return;
				}
				resolve({
					code,
					killSignal
				});
			});
		});
		closed.catch(() => void 0);
		return {
			child,
			state,
			closed,
			kill
		};
	};
	return Object.freeze({
		/**
		* Run one delegated task to completion, reading only its final result.
		* @param options - prompt, mode, model, working directory, and cancellation.
		* @returns the CLI's answer plus its own accounting.
		*/
		async run({ prompt, mode = DEFAULT_CLAUDE_MODE, model, cwd, signal } = {}) {
			const startedAt = Date.now();
			const { state, closed } = await start({
				prompt,
				mode,
				model,
				cwd,
				signal,
				stream: false
			});
			const { code, killSignal } = await closed;
			const parsed = parseClaudeResult(state.stdout);
			if (parsed === void 0) throw new Error(failureMessage(void 0, code ?? killSignal, state.stderr));
			if (parsed.is_error === true || code !== 0) throw new Error(failureMessage(parsed, code, state.stderr));
			const usage = parsed.usage ?? {};
			return {
				result: typeof parsed.result === "string" ? parsed.result : "",
				model: typeof parsed.model === "string" ? parsed.model : model ?? "",
				mode,
				costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0,
				durationMs: typeof parsed.duration_ms === "number" ? parsed.duration_ms : Date.now() - startedAt,
				inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
				outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0
			};
		},
		/**
		* Run one delegated task, yielding its answer as the CLI produces it.
		* The final `result` event carries the CLI's own accounting, summed over
		* every request the CLI made.
		* @param options - as {@link run}, plus optional `appendSystemPrompt`
		*   instructions.
		* @returns an async generator of {@link readClaudeStreamEvents} events and
		*   one closing `result` event.
		*/
		async *stream({ prompt, mode = DEFAULT_CLAUDE_MODE, model, appendSystemPrompt, cwd, signal } = {}) {
			const startedAt = Date.now();
			let buffer = "";
			let sawResult;
			const lines = [];
			const { state, closed, kill } = await start({
				prompt,
				mode,
				model,
				appendSystemPrompt,
				cwd,
				signal,
				stream: true,
				onStdout: (chunk) => {
					buffer += chunk;
					let index = buffer.indexOf("\n");
					while (index !== -1) {
						lines.push(buffer.slice(0, index));
						buffer = buffer.slice(index + 1);
						index = buffer.indexOf("\n");
					}
				}
			});
			const drain = function* () {
				while (lines.length > 0) {
					const line = lines.shift().trim();
					if (line === "" || !line.startsWith("{")) continue;
					let parsed;
					try {
						parsed = JSON.parse(line);
					} catch {
						continue;
					}
					for (const event of readClaudeStreamEvents(parsed)) if (event.type === "result") sawResult = event.result;
					else yield event;
				}
			};
			let finished = false;
			const stopIfAbandoned = () => {
				if (!finished) kill();
			};
			const completion = closed.then(() => {
				finished = true;
			}, (error) => {
				finished = true;
				throw error;
			});
			completion.catch(() => void 0);
			try {
				while (!finished || lines.length > 0) {
					if (lines.length === 0) {
						if (finished) break;
						await new Promise((resolve) => setTimeout(resolve, 15));
						continue;
					}
					yield* drain();
				}
			} finally {
				stopIfAbandoned();
			}
			await completion;
			if (buffer.trim().startsWith("{")) try {
				const event = readClaudeStreamEvents(JSON.parse(buffer.trim())).find((item) => item.type === "result");
				if (event !== void 0) sawResult = event.result;
			} catch {}
			if (sawResult === void 0) throw new Error(failureMessage(void 0, void 0, state.stderr));
			if (sawResult.is_error === true) throw new Error(failureMessage(sawResult, 0, state.stderr));
			const usage = sawResult.usage ?? {};
			yield {
				type: "result",
				result: {
					result: typeof sawResult.result === "string" ? sawResult.result : "",
					model: typeof sawResult.model === "string" ? sawResult.model : model ?? "",
					mode,
					costUsd: typeof sawResult.total_cost_usd === "number" ? sawResult.total_cost_usd : 0,
					durationMs: typeof sawResult.duration_ms === "number" ? sawResult.duration_ms : Date.now() - startedAt,
					inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
					outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
					cacheReadTokens: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0,
					cacheWriteTokens: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0
				}
			};
		}
	});
}
//#endregion
//#region src/claude-install.js
/**
* Detecting, and installing, the local Claude Code CLI.
*
* Claude models on this route run through the official CLI, so the settings
* panel shows whether this device has one (and which version), and offers to
* install it with `npm install -g @anthropic-ai/claude-code` — the same command
* on macOS and Windows. Installation runs on the host, never in a shell built
* from user text: npm's arguments are constants.
*
* @module dsh-packycode-api/claude-install
*/
const CLAUDE_INSTALL_COMMAND = `npm install -g ${CLAUDE_NPM_PACKAGE}`;
const INSTALL_ARGS = Object.freeze([
	"install",
	"-g",
	CLAUDE_NPM_PACKAGE
]);
const PREFIX_ARGS = Object.freeze(["prefix", "-g"]);
const VERSION_TIMEOUT_MS = 2e4;
const PREFIX_TIMEOUT_MS = 2e4;
const INSTALL_TIMEOUT_MS = 900 * 1e3;
/** A detection is reused this long; the panel's refresh and an install bypass it. */
const DETECTION_TTL_MS = 300 * 1e3;
const DETAIL_CHARS = 800;
/**
* The version `claude --version` prints, e.g. `2.1.3 (Claude Code)`.
* @param output - the command's stdout.
* @returns the semantic version, or undefined.
*/
function parseClaudeVersion(output) {
	return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u.exec(typeof output === "string" ? output : "")?.[1];
}
/** The last lines of a command's output, bounded for display. */
function detailOf(...texts) {
	const tail = texts.filter((text) => typeof text === "string").join("\n").split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => line.trim() !== "").slice(-8).join("\n");
	return tail.length > DETAIL_CHARS ? tail.slice(-800) : tail;
}
/**
* Where npm usually lives, in the order tried after PATH.
* @param options - platform, home, environment, the host's own Node, and a directory reader.
* @returns absolute candidate paths.
*/
function npmCandidates({ platform = process.platform, home = homedir(), env = process.env, execPath = process.execPath, readdir } = {}) {
	const path = pathFor(platform);
	const name = platform === "win32" ? "npm.cmd" : "npm";
	const beside = typeof execPath === "string" && execPath !== "" ? [path.join(path.dirname(execPath), name)] : [];
	if (platform === "win32") return [
		...beside,
		...env.NVM_SYMLINK ? [path.join(env.NVM_SYMLINK, name)] : [],
		path.join(env.ProgramFiles ?? "C:\\Program Files", "nodejs", name)
	];
	return [
		...beside,
		"/opt/homebrew/bin/npm",
		"/usr/local/bin/npm",
		path.join(home, ".volta", "bin", "npm"),
		...nvmBinDirs({
			home,
			env,
			platform,
			readdir
		}).map((directory) => path.join(directory, "npm"))
	];
}
/**
* Locate npm: PATH first (the one the user's terminal runs), then the usual places.
* @param options - as {@link npmCandidates}, plus an existence check.
* @returns an absolute path, or undefined.
*/
function locateNpm({ platform = process.platform, home = homedir(), env = process.env, execPath = process.execPath, exists = existsSync, readdir } = {}) {
	const onPath = searchPath(platform === "win32" ? ["npm.cmd"] : ["npm"], {
		platform,
		env,
		exists
	});
	if (onPath !== void 0) return onPath;
	return npmCandidates({
		platform,
		home,
		env,
		execPath,
		readdir
	}).find((candidate) => exists(candidate));
}
/**
* Classify an npm failure so the panel can say what to do about it.
* @param result - the captured npm run.
* @returns `{ code, detail }`.
*/
function explainNpmFailure(result) {
	const detail = detailOf(result?.error?.message, result?.stderr, result?.stdout);
	if (/\bEACCES\b|\bEPERM\b|permission denied|operation not permitted/iu.test(detail)) return {
		code: "permission",
		detail
	};
	if (/\bENOTFOUND\b|\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|network/iu.test(detail)) return {
		code: "network",
		detail
	};
	if (/timed out after/iu.test(detail)) return {
		code: "timeout",
		detail
	};
	return {
		code: "failed",
		detail: detail === "" ? `npm exited with code ${result?.code ?? "unknown"}` : detail
	};
}
/**
* Run a command to completion and capture its output. Never rejects: a
* missing program or a timeout comes back as `error`.
*/
function runCaptured(spawnImpl, command, args, options, timeoutMs) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawnImpl(command, args, {
				...options,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				],
				windowsHide: true
			});
		} catch (error) {
			resolve({
				code: null,
				stdout: "",
				stderr: "",
				error
			});
			return;
		}
		let stdout = "";
		let stderr = "";
		let done = false;
		const finish = (outcome) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({
				stdout,
				stderr,
				...outcome
			});
		};
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {}
			finish({
				code: null,
				error: /* @__PURE__ */ new Error(`timed out after ${Math.round(timeoutMs / 1e3)}s`)
			});
		}, timeoutMs);
		timer.unref?.();
		child.stdout?.setEncoding?.("utf8");
		child.stderr?.setEncoding?.("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout = (stdout + String(chunk)).slice(-65536);
		});
		child.stderr?.on("data", (chunk) => {
			stderr = (stderr + String(chunk)).slice(-65536);
		});
		child.on("error", (error) => finish({
			code: null,
			error
		}));
		child.on("close", (code) => finish({
			code,
			error: void 0
		}));
	});
}
/**
* The CLI manager behind the settings panel and the runner.
* @param options - the configured CLI path (a function, so a settings change
*   applies without a restart), plus platform, environment, and process seams.
* @returns `{ binary, detect, install, status }`.
*/
function createClaudeCliManager({ explicitPath = () => "", platform = process.platform, home = homedir(), env = process.env, execPath = process.execPath, configDir = DEFAULT_CLAUDE_CONFIG_DIR, spawnImpl = spawn, exists = existsSync, readFile = (file) => readFileSync(file, "utf8"), readdir, now = () => Date.now() } = {}) {
	const path = pathFor(platform);
	const configured = () => {
		const value = explicitPath();
		return typeof value === "string" ? value.trim() : "";
	};
	const locateOptions = () => ({
		platform,
		home,
		env,
		exists,
		readdir
	});
	const npm = () => locateNpm({
		...locateOptions(),
		execPath
	});
	/**
	* Run npm. On Windows npm is a `.cmd` launcher, which Node starts only
	* through `cmd.exe`; that is safe here because every argument is a constant.
	*/
	const runNpm = (program, args, timeoutMs) => runCaptured(spawnImpl, platform === "win32" ? `"${program}"` : program, args, {
		env: withProgramDirOnPath(env, program, platform),
		shell: platform === "win32"
	}, timeoutMs);
	/** npm's global bin directory, read once; a GUI PATH often lacks it. */
	let globalBin;
	const npmGlobalBin = async () => {
		if (globalBin !== void 0) return globalBin === "" ? void 0 : globalBin;
		const program = npm();
		if (program === void 0) return void 0;
		const result = await runNpm(program, PREFIX_ARGS, PREFIX_TIMEOUT_MS);
		const prefix = result.code === 0 ? result.stdout.trim().split(/\r?\n/u).at(-1)?.trim() ?? "" : "";
		globalBin = prefix === "" ? "" : platform === "win32" ? prefix : path.join(prefix, "bin");
		return globalBin === "" ? void 0 : globalBin;
	};
	const locate = async () => {
		const found = locateClaudeBinary({
			explicit: configured(),
			...locateOptions()
		});
		if (found !== void 0 || configured() !== "") return found;
		const bin = await npmGlobalBin();
		if (bin === void 0) return void 0;
		return claudeFileNames(platform).map((name) => path.join(bin, name)).find((candidate) => exists(candidate));
	};
	const probe = async () => {
		const found = await locate();
		if (found === void 0) return configured() === "" ? { installed: false } : {
			installed: false,
			configuredPath: configured()
		};
		let command;
		try {
			command = resolveSpawnCommand(found, {
				platform,
				exists,
				readFile
			});
		} catch (error) {
			return {
				installed: true,
				path: found,
				error: error.message
			};
		}
		const result = await runCaptured(spawnImpl, command.command, [...command.args, "--version"], { env: {
			...withProgramDirOnPath(env, found, platform),
			CLAUDE_CONFIG_DIR: configDir,
			DISABLE_AUTOUPDATER: "1",
			DISABLE_TELEMETRY: "1",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
		} }, VERSION_TIMEOUT_MS);
		const version = result.code === 0 ? parseClaudeVersion(result.stdout) : void 0;
		if (version !== void 0) return {
			installed: true,
			path: found,
			version
		};
		return {
			installed: true,
			path: found,
			error: detailOf(result.error?.message, result.stderr, result.stdout) || `exited with code ${result.code ?? "unknown"}`
		};
	};
	let detection;
	let detecting;
	const detect = async ({ force = false } = {}) => {
		if (!force && detection !== void 0 && now() - detection.checkedAt < DETECTION_TTL_MS) return detection;
		if (detecting !== void 0) return detecting;
		detecting = probe().catch((error) => ({
			installed: false,
			error: error instanceof Error ? error.message : String(error)
		})).then((value) => {
			detection = {
				...value,
				checkedAt: now()
			};
			return detection;
		}).finally(() => {
			detecting = void 0;
		});
		return detecting;
	};
	let installation = { state: "idle" };
	let installing;
	const install = () => {
		if (installing !== void 0) return installation;
		const program = npm();
		if (program === void 0) {
			installation = {
				state: "failed",
				code: "npm-missing",
				finishedAt: now()
			};
			return installation;
		}
		installation = {
			state: "running",
			startedAt: now(),
			npm: program
		};
		installing = runNpm(program, INSTALL_ARGS, INSTALL_TIMEOUT_MS).then(async (result) => {
			globalBin = void 0;
			if (result.code !== 0) {
				installation = {
					state: "failed",
					...explainNpmFailure(result),
					finishedAt: now()
				};
				await detect({ force: true });
				return;
			}
			const found = await detect({ force: true });
			installation = found.installed && found.version !== void 0 ? {
				state: "succeeded",
				finishedAt: now()
			} : {
				state: "failed",
				code: "not-found-after-install",
				detail: detailOf(result.stdout, result.stderr),
				finishedAt: now()
			};
		}).catch((error) => {
			installation = {
				state: "failed",
				code: "failed",
				detail: error instanceof Error ? error.message : String(error),
				finishedAt: now()
			};
		}).finally(() => {
			installing = void 0;
		});
		return installation;
	};
	return Object.freeze({
		/**
		* The CLI the runner should start: the last detected one while it still
		* exists, otherwise a fresh lookup — so a CLI installed after startup,
		* from the panel or a terminal, is used without restarting.
		*/
		async binary() {
			if (detection?.path !== void 0 && exists(detection.path)) return detection.path;
			return await locate() ?? (configured() === "" ? "claude" : configured());
		},
		detect,
		install,
		/** Wait for an install in flight; for tests and scripts. */
		settled: () => installing ?? Promise.resolve(),
		/**
		* What the settings panel shows. While an install runs, the last detection
		* stands instead of probing a half-written package.
		*/
		async status({ force = false } = {}) {
			const value = installing === void 0 ? await detect({ force }) : detection;
			return {
				installed: value?.installed === true,
				...value?.version === void 0 ? {} : { version: value.version },
				...value?.path === void 0 ? {} : { path: value.path },
				...value?.configuredPath === void 0 ? {} : { configuredPath: value.configuredPath },
				...value?.error === void 0 ? {} : { error: value.error },
				...value?.checkedAt === void 0 ? {} : { checkedAt: value.checkedAt },
				platform,
				command: CLAUDE_INSTALL_COMMAND,
				install: { ...installation }
			};
		}
	});
}
//#endregion
//#region src/key-ring.js
/**
* The PackyCode key ring.
*
* Keys live in one DSH credential *record* (`packycode-api/keys`), which is
* the cross-process-serialized read-decide-replace space the credential
* service owns. A key the gateway exhausts or rejects is marked unusable and
* the ring moves the active pointer to the next usable key, so the next
* attempt — the harness retry of the failed step — resolves a different key
* through the adapter's per-request `resolveApiKey`.
*
* @module dsh-packycode-api/key-ring
*/
/** Printable ASCII without spaces: what an HTTP header can carry unchanged. */
const LEGAL_KEY = /^[\x21-\x7E]+$/u;
const RECORD_VERSION = 1;
const MAX_KEYS = 32;
const RECORD_KEY = typeof credentialKey === "function" ? credentialKey(PLUGIN_ID, KEY_RECORD_ID) : void 0;
const text = (value) => typeof value === "string" ? value : "";
/** Validate a pasted key before it is stored; the gateway never sees a bad one from us. */
function assertApiKey(value) {
	const key = text(value).trim();
	if (key.length < 8 || key.length > 512 || !LEGAL_KEY.test(key)) throw new Error("PackyCode API key must be 8-512 printable ASCII characters without spaces");
	return key;
}
function entry(value) {
	if (value === null || typeof value !== "object") return void 0;
	const key = text(value.key);
	if (key === "" || !LEGAL_KEY.test(key)) return void 0;
	const id = text(value.id);
	return {
		id: id === "" ? randomUUID().slice(0, 8) : id,
		label: text(value.label),
		key,
		addedAt: Number.isFinite(value.addedAt) ? value.addedAt : 0,
		...Number.isFinite(value.disabledAt) ? { disabledAt: value.disabledAt } : {},
		...text(value.disabledReason) === "" ? {} : { disabledReason: text(value.disabledReason) }
	};
}
/** Tolerate a hand-edited or older record instead of failing the whole route. */
function normalizeState(record) {
	const payload = record !== null && typeof record === "object" && record.kind === "grant" && record.payload !== null && typeof record.payload === "object" ? record.payload : void 0;
	const keys = (Array.isArray(payload?.keys) ? payload.keys : []).map(entry).filter((candidate) => candidate !== void 0);
	const activeId = text(payload?.activeId);
	return {
		activeId: keys.some((candidate) => candidate.id === activeId) ? activeId : keys[0]?.id,
		keys
	};
}
/**
* The next free `Key N` name. The ring shrinks on removal, so numbering follows
* the highest name in use instead of the current key count — otherwise removing
* the first key and adding another produces a second "Key 2".
* @param keys - the stored keys.
* @returns an unused default label.
*/
function nextDefaultLabel(keys) {
	const used = new Set(keys.map((candidate) => candidate.label));
	let index = keys.length + 1;
	while (used.has(`Key ${index}`)) index += 1;
	return `Key ${index}`;
}
/** The public shape: what a browser or a log may see, never key material. */
function projection(state) {
	return {
		activeId: state.activeId,
		keys: state.keys.map((candidate) => ({
			id: candidate.id,
			label: candidate.label,
			addedAt: candidate.addedAt,
			active: candidate.id === state.activeId,
			disabled: candidate.disabledAt !== void 0,
			...candidate.disabledAt === void 0 ? {} : {
				disabledAt: candidate.disabledAt,
				disabledReason: candidate.disabledReason
			}
		}))
	};
}
var PackyCodeKeyRing = class {
	#credentials;
	constructor(credentials) {
		if (RECORD_KEY === void 0) throw new Error("dsh-packycode-api requires @deepseek-ai/dsh-credentials with credentialKey()");
		if (credentials === null || typeof credentials !== "object" || typeof credentials.readRecord !== "function" || typeof credentials.modifyRecord !== "function") throw new Error("dsh-packycode-api requires the DSH credential record API");
		this.#credentials = credentials;
	}
	async #read() {
		return normalizeState(await this.#credentials.readRecord(RECORD_KEY));
	}
	async #write(mutate) {
		return normalizeState(await this.#credentials.modifyRecord(RECORD_KEY, async (current) => {
			const updated = await mutate(normalizeState(current));
			if (updated === void 0) return current;
			return {
				kind: "grant",
				payload: {
					version: RECORD_VERSION,
					activeId: updated.activeId,
					keys: updated.keys.map((candidate) => ({
						id: candidate.id,
						label: candidate.label,
						key: candidate.key,
						addedAt: candidate.addedAt,
						...candidate.disabledAt === void 0 ? {} : {
							disabledAt: candidate.disabledAt,
							disabledReason: candidate.disabledReason
						}
					}))
				}
			};
		}));
	}
	/** The keys as the browser may see them. */
	async list() {
		return projection(await this.#read());
	}
	/** Raw key material for the host-side balance reader; never crosses the RPC boundary. */
	async secrets() {
		return (await this.#read()).keys.map((candidate) => ({
			id: candidate.id,
			label: candidate.label,
			key: candidate.key,
			disabled: candidate.disabledAt !== void 0
		}));
	}
	/**
	* The key a request should use: the active one when it is usable, otherwise
	* the next usable key in insertion order, wrapping once.
	* @returns the chosen entry, or undefined when every key is unusable.
	*/
	async activeKey() {
		const state = await this.#read();
		if (state.keys.length === 0) return void 0;
		const usable = (candidate) => candidate.disabledAt === void 0;
		const start = Math.max(0, state.keys.findIndex((candidate) => candidate.id === state.activeId));
		for (let offset = 0; offset < state.keys.length; offset += 1) {
			const candidate = state.keys[(start + offset) % state.keys.length];
			if (usable(candidate)) return {
				id: candidate.id,
				label: candidate.label,
				key: candidate.key
			};
		}
	}
	async add(key, label) {
		const value = assertApiKey(key);
		const name = text(label).trim().slice(0, 60);
		return projection(await this.#write((state) => {
			if (state.keys.length >= MAX_KEYS) throw new Error(`PackyCode accepts at most ${MAX_KEYS} keys`);
			if (state.keys.some((candidate) => candidate.key === value)) throw new Error("That PackyCode API key is already stored");
			const added = {
				id: randomUUID().slice(0, 8),
				label: name === "" ? nextDefaultLabel(state.keys) : name,
				key: value,
				addedAt: Date.now()
			};
			return {
				activeId: state.activeId ?? added.id,
				keys: [...state.keys, added]
			};
		}));
	}
	async remove(id) {
		return projection(await this.#write((state) => {
			const remaining = state.keys.filter((candidate) => candidate.id !== id);
			if (remaining.length === state.keys.length) throw new Error("Unknown PackyCode key");
			return {
				activeId: state.activeId === id ? (remaining.find((candidate) => candidate.disabledAt === void 0) ?? remaining[0])?.id : state.activeId,
				keys: remaining
			};
		}));
	}
	async removeAll() {
		return projection(await this.#write(() => ({
			activeId: void 0,
			keys: []
		})));
	}
	async select(id) {
		return projection(await this.#write((state) => {
			if (!state.keys.some((candidate) => candidate.id === id)) throw new Error("Unknown PackyCode key");
			return {
				activeId: id,
				keys: state.keys
			};
		}));
	}
	/** Clear a rotation mark so a topped-up or replaced key is tried again. */
	async enable(id) {
		return projection(await this.#write((state) => {
			if (!state.keys.some((candidate) => candidate.id === id)) throw new Error("Unknown PackyCode key");
			return {
				activeId: state.activeId,
				keys: state.keys.map((candidate) => candidate.id === id ? {
					id: candidate.id,
					label: candidate.label,
					key: candidate.key,
					addedAt: candidate.addedAt
				} : candidate)
			};
		}));
	}
	/**
	* Mark a key unusable and move the active pointer on. Called from the stream
	* guard, so the retry of the failed step resolves the next key.
	*/
	async disable(id, reason) {
		return projection(await this.#write((state) => {
			const now = Date.now();
			const keys = state.keys.map((candidate) => candidate.id === id ? {
				...candidate,
				disabledAt: now,
				disabledReason: text(reason) === "" ? "unusable" : text(reason)
			} : candidate);
			if (!keys.some((candidate) => candidate.id === id)) return {
				activeId: state.activeId,
				keys: state.keys
			};
			return {
				activeId: state.activeId === id ? (keys.find((candidate) => candidate.id !== id && candidate.disabledAt === void 0) ?? keys.find((candidate) => candidate.id !== id))?.id : state.activeId,
				keys
			};
		}));
	}
};
//#endregion
//#region src/permission.js
/**
* The Claude Code CLI mode a session's own permissions allow.
*
* A CLI-backed turn runs the CLI's own tool loop, outside the harness sandbox
* and approval flow. Deriving its mode from the session's permission preset
* means the user grants it once, in the place they already grant the harness
* itself, instead of in a separate plugin setting.
*
* @module dsh-packycode-api/permission
*/
/** Configured value meaning "follow the session's permission preset". */
const AUTO_CLAUDE_MODE = "auto";
const RANK = Object.freeze({
	"read-only": 0,
	edit: 1,
	full: 2
});
/**
* Map the harness's two permission knobs onto a CLI mode.
*
* The CLI cannot ask the harness user for approval, so it skips its own
* permission checks only when the session itself neither sandboxes nor asks.
* @param sandbox - the session's resolved sandbox mode.
* @param approval - the session's effective approval policy.
* @returns a CLI mode, or `undefined` for an unknown sandbox mode.
*/
function claudeModeFor(sandbox, approval) {
	switch (sandbox) {
		case "read-only": return "read-only";
		case "workspace-write": return "edit";
		case "danger-full-access": return approval === "never" ? "full" : "edit";
		default: return;
	}
}
/**
* Read a session's CLI mode from the host's permission services.
* @param ctx - the plugin context; services are read without an inject requirement.
* @param session - the session whose permission state is read.
* @returns a CLI mode, or `undefined` when the session or the services are absent.
*/
function claudeModeForSession(ctx, session) {
	if (session === void 0 || session === null) return void 0;
	try {
		const sandbox = ctx.get?.("sandboxPolicy")?.resolve?.({ session })?.mode;
		const approval = ctx.get?.("approval")?.effectivePolicy?.(session);
		return claudeModeFor(sandbox, approval);
	} catch {
		return;
	}
}
/**
* The narrower of two modes; an unknown ceiling leaves the request as it is.
* @param requested - the mode a caller asked for.
* @param ceiling - the most the session allows.
* @returns the mode the CLI runs with.
*/
function capClaudeMode(requested, ceiling) {
	if (ceiling === void 0 || RANK[ceiling] === void 0) return requested;
	if (requested === void 0 || RANK[requested] === void 0) return ceiling;
	return RANK[requested] > RANK[ceiling] ? ceiling : requested;
}
//#endregion
//#region src/catalog.js
/**
* The built-in PackyCode model catalog.
*
* The gateway's own guidance for these routes, which the base URLs and pinned
* protocols below exist to satisfy:
* - OpenAI/Codex traffic takes `/v1` in the base URL and never an endpoint
*   path — the SDK appends `/responses` or `/chat/completions` itself.
* - Anthropic traffic takes `https://cf.api.fan` with **no** `/v1`: the
*   Anthropic client appends `/v1/messages` itself.
* - A model asked over the wrong protocol does not fail cleanly; the stream
*   ends early. So every model pins the protocol its vendor serves here.
*
* Effort levels come from each vendor's documentation, because an effort the
* model does not support is refused before the request is sent: Claude Opus
* 5.5 (platform.claude.com effort docs), GPT-6.1 Sol `reasoning.effort`
* (developers.openai.com model page), DeepSeek thinking mode (`thinking`
* toggle plus `low|high|max` effort).
*
* @module dsh-packycode-api/catalog
*/
/** pi-ai never reads this gateway's pricing; the harness zeroes cost anyway. */
const NO_COST = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
});
const COMPLETIONS_BASE = `${DEFAULT_API_HOST}/v1`;
const RESPONSES_BASE = `${DEFAULT_API_HOST}/v1`;
const MESSAGES_BASE = DEFAULT_API_HOST;
/**
* pi-ai thinking-level maps. A level pinned to `null` is unsupported; an
* absent key keeps pi-ai's own default for that level, which is how `off`
* stays available for DeepSeek (`off` sends nothing and the deepseek dialect
* then emits `thinking: disabled`).
*/
const DEEPSEEK_LEVELS = Object.freeze({
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: "max"
});
/**
* Claude 5.5 models and GPT-6.1 Sol cannot disable reasoning, so `off` is
* pinned unsupported. The Claude models run through the CLI, which picks its
* own effort, so for them these levels only shape the picker.
*/
const ALWAYS_THINKING_LEVELS = Object.freeze({
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max"
});
const PACKYCODE_MODELS = Object.freeze([
	Object.freeze({
		id: "deepseek-flash",
		name: "DeepSeek Flash",
		api: "openai-completions",
		provider: PROVIDER,
		baseUrl: COMPLETIONS_BASE,
		reasoning: true,
		input: Object.freeze(["text"]),
		cost: NO_COST,
		contextWindow: 1e6,
		maxTokens: 384e3,
		thinkingLevelMap: DEEPSEEK_LEVELS,
		compat: Object.freeze({
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
			requiresReasoningContentOnAssistantMessages: true,
			supportsDeveloperRole: false
		})
	}),
	Object.freeze({
		id: "gpt-6.1-sol",
		name: "GPT-6.1 Sol",
		api: "openai-responses",
		provider: PROVIDER,
		baseUrl: RESPONSES_BASE,
		reasoning: true,
		input: Object.freeze(["text", "image"]),
		cost: NO_COST,
		contextWindow: 105e4,
		maxTokens: 128e3,
		thinkingLevelMap: ALWAYS_THINKING_LEVELS
	}),
	Object.freeze({
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "anthropic-messages",
		provider: PROVIDER,
		baseUrl: MESSAGES_BASE,
		reasoning: true,
		input: Object.freeze(["text", "image"]),
		cost: NO_COST,
		contextWindow: 1e6,
		maxTokens: 128e3,
		thinkingLevelMap: ALWAYS_THINKING_LEVELS,
		compat: Object.freeze({
			forceAdaptiveThinking: true,
			supportsTemperature: false
		})
	}),
	Object.freeze({
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5",
		api: "anthropic-messages",
		provider: PROVIDER,
		baseUrl: MESSAGES_BASE,
		reasoning: true,
		input: Object.freeze(["text", "image"]),
		cost: NO_COST,
		contextWindow: 1e6,
		maxTokens: 128e3,
		thinkingLevelMap: ALWAYS_THINKING_LEVELS,
		compat: Object.freeze({
			forceAdaptiveThinking: true,
			supportsTemperature: false
		})
	}),
	Object.freeze({
		id: "claude-haiku-5-5",
		name: "Claude Haiku 5.5",
		api: "anthropic-messages",
		provider: PROVIDER,
		baseUrl: MESSAGES_BASE,
		reasoning: true,
		input: Object.freeze(["text", "image"]),
		cost: NO_COST,
		contextWindow: 2e5,
		maxTokens: 64e3,
		thinkingLevelMap: ALWAYS_THINKING_LEVELS,
		compat: Object.freeze({
			forceAdaptiveThinking: true,
			supportsTemperature: false
		})
	})
]);
/** Every model id this catalog advertises, in picker order. */
const PACKYCODE_MODEL_IDS = Object.freeze(PACKYCODE_MODELS.map((model) => model.id));
//#endregion
//#region src/failures.js
/**
* Failure classification for the two conditions that move the key ring along.
*
* The gateway reports an exhausted key and a rejected key in Chinese, and the
* harness classifies failures by fixed English/status wording it recognizes
* (`isQuotaExceededError`, `\b401\b`). Normalizing here is what makes the
* harness's retry policy re-run the step — and therefore what lets the retry
* pick up the next key. Rewriting is honest about what happened: this plugin
* knows the key's condition from the gateway's own words plus its balance
* reader, so the sentence it substitutes says no more than that.
*
* @module dsh-packycode-api/failures
*/
/** Terminal quota, balance, or credit wording, in the gateway's own languages. */
const QUOTA_WORDING = /额度|余额|配额|欠费|insufficient[\s_-]+(?:quota|balance|credits?)|quota[\s_-]+(?:exceeded|exhausted|reached)|out[\s_-]+of[\s_-]+(?:credits?|budget)/iu;
/** A rejected key names itself; a bare 403 does not, and must not disable one. */
const INVALID_KEY_WORDING = /无效的令牌|令牌无效|无效密钥|密钥无效|invalid[\s_-]+api[\s_-]*key|invalid_authentication|api key is invalid/iu;
const INVALID_KEY_STATUS = /\b401\b/;
/**
* A gateway group that only serves its vendor's official client. These arrive
* as 403, which the harness reads as an authentication failure and renders as
* an invalid-API-key problem — the opposite of what happened, and a condition
* no retry can clear.
*/
const CLIENT_POLICY_WORDING = /only accessible via the official|official claude cli|官方\s*claude\s*cli|请使用标准\s*codex\s*客户端|客户端存在异常|二次分发|API\s*转接/iu;
/** The key's quota is exhausted; move to the next key. */
const QUOTA_FAILURE = "quota";
/** The gateway rejected the key itself; move to the next key. */
const INVALID_KEY_FAILURE = "invalid-key";
/**
* Whether the gateway is refusing this client rather than this credential.
* @param message - provider failure text, as pi-ai carries it.
* @returns true when the route is gated to a vendor's official client.
*/
function classifyClientPolicy(message) {
	return CLIENT_POLICY_WORDING.test(typeof message === "string" ? message : "");
}
/**
* Classify a gateway failure message.
*
* Quota wording wins over a status token: an exhausted balance is often
* reported as 402/403, and only the key's own rejection may read as 401. A
* client-policy refusal is not a key fault and is classified separately.
* @param message - provider failure text, as pi-ai carries it.
* @returns the failure kind, or undefined when the key is not at fault.
*/
function classifyGatewayFailure(message) {
	const text = typeof message === "string" ? message : "";
	if (text === "") return void 0;
	if (classifyClientPolicy(text)) return void 0;
	if (QUOTA_WORDING.test(text)) return QUOTA_FAILURE;
	if (INVALID_KEY_WORDING.test(text)) return INVALID_KEY_FAILURE;
	if (INVALID_KEY_STATUS.test(text)) return INVALID_KEY_FAILURE;
}
/**
* Rewrite a failure message so the harness classifies it as quota or auth.
*
* A bare status token is neutralized first: an exhausted balance arrives as
* 402 or 403 on some gateway routes, and the harness's auth rule matches
* 401/403 before it reads any wording, which would send the failure into a
* category the retry policy does not re-run.
* @param message - the original provider failure text.
* @param kind - the classification of {@link classifyGatewayFailure}.
* @returns text the harness routes to QUOTA or AUTH.
*/
/**
* Explain a client-policy refusal so the user reads the real cause.
*
* The sentence must not read as any other failure the harness knows: it
* deliberately carries no HTTP status and none of the words the classifier
* matches for auth, quota, rate limits, timeouts, or transport faults. That
* keeps the failure out of the retry policy — no retry can talk a group into
* serving an API client — and lets the sentence reach the user verbatim, in
* place of the "API key is invalid" the bare 403 would have produced.
* @param keyName - the account name the balance reader saw, when known.
* @returns the replacement sentence.
*/
function explainClientPolicyFailure() {
	return "PackyCode 拒绝了这个客户端：所选分组只允许厂商官方客户端调用（Claude 分组要求官方 Claude CLI，Codex 分组要求标准 Codex 客户端）。这不是 API Key 失效，重试也不会成功。请改用允许 API 调用的分组（例如 cc-sale 或 claude-officially），或改用 PackyCode 的 gpt-6.1-sol / deepseek-flash。 / This group only serves the vendor’s official client; the API key is fine and retrying cannot help.";
}
/**
* Rewrite a failure message so the harness classifies it as quota or auth.
*
* A bare status token is neutralized first: an exhausted balance arrives as
* 402 or 403 on some gateway routes, and the harness's auth rule matches
* 401/403 before it reads any wording, which would send the failure into a
* category the retry policy does not re-run.
* @param message - the original provider failure text.
* @param kind - the classification of {@link classifyGatewayFailure}.
* @param options - optional account name for the policy explanation.
* @returns text the harness routes to QUOTA or AUTH, or a policy explanation.
*/
function normalizeFailureMessage(message, kind, options = {}) {
	const text = typeof message === "string" && message.length > 0 ? message : "PackyCode request failed";
	if (kind === "client-policy") return explainClientPolicyFailure(options.keyName);
	if (kind === "quota") return `${neutralizeAuthStatus(text)} — PackyCode: insufficient quota for this API key; trying the next key`;
	if (kind === "invalid-key") return `${neutralizeAuthStatus(text)} — PackyCode: 401 invalid_authentication for this API key; trying the next key`;
	return text;
}
function neutralizeAuthStatus(text) {
	return text.replace(/\b(?:401|403)\b/gu, "HTTP");
}
//#endregion
//#region src/provider.js
/**
* The PackyCode pi-ai provider, built in code so the user configures no route.
*
* `createProvider` dispatches on `model.api`, which is what lets one route
* carry a chat/completions model, a Responses model, and an Anthropic Messages
* model — the gateway refuses each of them over the other protocols.
*
* @module dsh-packycode-api/provider
*/
const TERMINAL_EVENTS = /* @__PURE__ */ new Set(["error", "done"]);
/**
* The api-key method pi-ai consults before it honours a request's `apiKey`
* override. Resolution itself stays empty: this plugin authenticates from its
* own key ring through the adapter, and ambient `PACKY_CODE_API_KEY` discovery
* is disabled at the adapter's auth context.
* @returns the provider auth for this route.
*/
function keyRingAuth() {
	return { apiKey: {
		name: DISPLAY_NAME,
		resolve: () => Promise.resolve({
			auth: {},
			source: DISPLAY_NAME
		})
	} };
}
/** Build the route's pi-ai provider (unguarded; the plugin wraps its streams). */
function createPackyCodeProvider() {
	return createProvider({
		id: PROVIDER,
		name: DISPLAY_NAME,
		baseUrl: DEFAULT_API_HOST,
		auth: keyRingAuth(),
		models: PACKYCODE_MODELS,
		api: {
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
			"anthropic-messages": anthropicMessagesApi()
		}
	});
}
/**
* Observe a pi-ai event stream and hand a key-level failure to the plugin.
*
* pi-ai reports request failures as terminal events carrying the assistant
* message's `errorMessage`, and transport failures as thrown errors. Both are
* classified here; the substituted sentence is what makes the harness's retry
* policy re-run the step, which is the mechanism that reaches the next key. A
* thrown failure is only attributed to the key when no chunk arrived: a stream
* that broke mid-answer had already been accepted by the gateway.
* @param stream - the pi-ai event stream.
* @param options - the request's key plus the failure sink.
* @returns the same stream, with key-level failures classified and rewritten.
*/
function guardKeyRotation(stream, { onKeyFailure, key } = {}) {
	if (stream === null || typeof stream !== "object") return stream;
	let observed = false;
	const report = (kind, message) => onKeyFailure?.(kind, message, key);
	const inspect = (value) => {
		if (value === null || typeof value !== "object" || !TERMINAL_EVENTS.has(value.type)) return value;
		for (const carrierKey of ["error", "message"]) {
			const carrier = value[carrierKey];
			if (carrier === null || typeof carrier !== "object") continue;
			if (classifyClientPolicy(carrier.errorMessage)) return {
				...value,
				[carrierKey]: {
					...carrier,
					errorMessage: explainClientPolicyFailure()
				}
			};
			const kind = classifyGatewayFailure(carrier.errorMessage);
			if (kind === void 0) continue;
			report(kind, carrier.errorMessage);
			return {
				...value,
				[carrierKey]: {
					...carrier,
					errorMessage: normalizeFailureMessage(carrier.errorMessage, kind)
				}
			};
		}
		return value;
	};
	return new Proxy(stream, { get(target, prop, receiver) {
		if (prop === Symbol.asyncIterator) return () => {
			const iterator = Reflect.get(target, Symbol.asyncIterator).call(target);
			return {
				next: async (...args) => {
					try {
						const item = await iterator.next(...args);
						observed = true;
						if (item === null || typeof item !== "object" || item.done === true) return item;
						const value = inspect(item.value);
						return value === item.value ? item : {
							...item,
							value
						};
					} catch (error) {
						const text = error instanceof Error ? error.message : String(error);
						if (classifyClientPolicy(text)) throw new Error(explainClientPolicyFailure(), { cause: error });
						const kind = observed ? void 0 : classifyGatewayFailure(text);
						if (kind !== void 0) {
							report(kind, text);
							throw new Error(normalizeFailureMessage(text, kind), { cause: error });
						}
						throw error;
					}
				},
				...typeof iterator.return === "function" ? { return: (...args) => iterator.return(...args) } : {},
				...typeof iterator.throw === "function" ? { throw: (...args) => iterator.throw(...args) } : {}
			};
		};
		const value = Reflect.get(target, prop, receiver);
		return typeof value === "function" ? value.bind(target) : value;
	} });
}
//#endregion
//#region src/rpc.js
/**
* The loopback RPC surface behind the settings panel and the composer chip.
*
* Every reply carries only what this plugin owns: key labels and state, the
* balance projection the host built, host overrides, and whether this device
* has the Claude Code CLI. Key material never crosses this boundary.
*
* @module dsh-packycode-api/rpc
*/
const ok = (value) => ({
	ok: true,
	value
});
const failed = (message) => ({
	ok: false,
	error: { message }
});
/** Only sentences this plugin authored may reach the browser. */
const SAFE_MESSAGE = /^(?:PackyCode|That |Unknown |PackyCode's |add |the )[\s\S]{0,180}$/u;
/** Accept an absolute http(s) origin and drop a trailing slash. */
function normalizeHost(value, fallback) {
	const text = typeof value === "string" ? value.trim() : "";
	if (text === "") return fallback;
	let url;
	try {
		url = new URL(text);
	} catch {
		return fallback;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return fallback;
	return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}
/**
* Build the RPC handler.
* @param options - the key ring, balance reader, host preference, and the
*   Claude Code CLI manager (optional: without it the CLI endpoints refuse).
* @returns a handler for `connection.rpc.handle(CHANNEL, handler)`.
*/
function createPackyCodeRpc({ ring, balance, hosts, preference, claudeCli }) {
	const requireCli = () => {
		if (claudeCli === void 0) throw new Error("PackyCode Claude Code CLI support is unavailable in this runtime");
		return claudeCli;
	};
	const status = async () => ({
		...await ring.list(),
		hosts: hosts(),
		writable: preference.writable === true,
		defaults: {
			apiHost: DEFAULT_API_HOST,
			statusHost: DEFAULT_STATUS_HOST
		}
	});
	return async (endpoint, payload) => {
		try {
			switch (endpoint) {
				case "status": return ok(await status());
				case "keys/add":
					await ring.add(payload?.key, payload?.label);
					balance.invalidate();
					return ok(await status());
				case "keys/remove":
					await ring.remove(String(payload?.id ?? ""));
					balance.invalidate();
					return ok(await status());
				case "keys/remove-all":
					await ring.removeAll();
					balance.invalidate();
					return ok(await status());
				case "keys/select":
					await ring.select(String(payload?.id ?? ""));
					balance.invalidate();
					return ok(await status());
				case "keys/enable":
					await ring.enable(String(payload?.id ?? ""));
					balance.invalidate();
					return ok(await status());
				case "balance": {
					const [value, state] = await Promise.all([balance.read({ force: payload?.force === true }), ring.list()]);
					return ok({
						...value,
						activeId: state.activeId
					});
				}
				case "hosts/update":
					if (preference.writable !== true) throw new Error("PackyCode host overrides are not writable in this profile");
					await preference.set({
						apiHost: normalizeHost(payload?.apiHost, hosts().apiHost),
						statusHost: normalizeHost(payload?.statusHost, hosts().statusHost)
					});
					balance.invalidate();
					return ok(await status());
				case "claude-cli/status": return ok(await requireCli().status({ force: payload?.force === true }));
				case "claude-cli/install": {
					const cli = requireCli();
					cli.install();
					return ok(await cli.status());
				}
				default: return failed("Unknown PackyCode endpoint");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return failed(SAFE_MESSAGE.test(message) ? message : "PackyCode request failed");
		}
	};
}
//#endregion
//#region src/index.js
/**
* dsh-packycode-api — a self-contained PackyCode route for DeepSeek Harness.
*
* The plugin builds its own pi-ai provider, model catalog, key ring, and
* balance reader, then registers the route through the same public
* `llm.registerAdapter` API the shipped adapters use. Nothing here reads the
* profile's composition config, so installing the package is the whole setup:
* the picker shows the models and the user only pastes API keys.
*
* @module dsh-packycode-api
*/
const name = PLUGIN_ID;
/**
* Only the model route is mandatory. `connection` carries the browser RPC
* surface, and `settings` the host overrides: a profile without them (a
* headless run, for one) must still boot with a working route instead of
* blocking on a service it will never see.
*/
const inject = ["llm", "credentials"];
/** Host overrides; a profile that never installs this section keeps the defaults. */
const Config = z.object({
	apiHost: z.string().default(DEFAULT_API_HOST),
	statusHost: z.string().default(DEFAULT_STATUS_HOST),
	/** Path to the Claude Code CLI binary; empty means "look in the usual places, then PATH". */
	claudeCliPath: z.string().default(""),
	/**
	* What the CLI may do on its own during a CLI-backed turn. `auto` follows the
	* session's permission preset, so nothing needs configuring here.
	*/
	claudeCliMode: z.union([
		AUTO_CLAUDE_MODE,
		"read-only",
		"edit",
		"full"
	]).default(AUTO_CLAUDE_MODE),
	/** Working directory for CLI-backed turns; empty means "the session's workspace". */
	claudeCliCwd: z.string().default("")
});
/**
* Request-level bounds from the shipped pi-ai adapter: a bounded image payload
* keeps a long session completing requests instead of being refused by a
* gateway size cap.
*/
const REQUEST_LIMITS = Object.freeze({
	streamIdleTimeoutMs: 600 * 1e3,
	maxRequestImageBytes: 20 * 1024 * 1024,
	requestImagePixelBudget: 2048 * 2048,
	requestImageMaxBytes: 1024 * 1024
});
/**
* pi-ai's credential store over the key ring.
*
* Reads answer with the active key so pi-ai's own auth reporting stays honest,
* while writes are refused: the ring owns them, because only the ring can move
* the active pointer past a key the gateway rejected.
* @param ring - the plugin's key ring.
* @returns a pi-ai `CredentialStore`.
*/
function ringCredentialStore(ring) {
	const managed = () => {
		throw new Error("PackyCode API keys are managed in the PackyCode settings section");
	};
	return {
		async read() {
			const active = await ring.activeKey();
			return active === void 0 ? void 0 : {
				type: "api_key",
				key: active.key
			};
		},
		async list() {
			return await ring.activeKey() === void 0 ? [] : [{
				providerId: PROVIDER,
				type: "api_key"
			}];
		},
		modify: managed,
		delete: managed
	};
}
/**
* The provider profile this route runs on.
*
* `modelErrors` and `configuredMaxTokens` are required by the host adapter;
* they stay empty because the catalog is fixed and no model carries a
* per-request output cap of its own.
* @param provider - the route's pi-ai provider.
* @returns the frozen profile handed to `PiAiAdapter`.
*/
function createPackyCodeProfile(provider) {
	return Object.freeze({
		provider: PROVIDER,
		displayName: DISPLAY_NAME,
		piProvider: provider,
		reasoning: DEFAULT_REASONING_LEVEL,
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_LIMITS,
		cacheRetention: "short",
		retryPolicy: resolveRetryPolicy({
			mode: "normal",
			maxRetries: 20,
			retryableCodes: [
				"EMPTY_RESPONSE",
				"RATE_LIMIT",
				"SERVER",
				"TIMEOUT",
				"TRANSPORT",
				QUOTA_EXCEEDED_CODE,
				"AUTH",
				"INVALID_REQUEST"
			]
		}, `${PLUGIN_ID}.retryPolicy`)
	});
}
function apply(ctx, config) {
	const balanceReaderOptions = {};
	const ring = new PackyCodeKeyRing(ctx.credentials);
	/**
	* Key material to ring id. A failure is reported from inside a stream, which
	* carries the request's key but not its id; this index is refreshed on every
	* resolution so the right key is the one that moves aside.
	*/
	const idByKey = /* @__PURE__ */ new Map();
	const rememberKeys = async () => {
		for (const entry of await ring.secrets()) idByKey.set(entry.key, entry.id);
	};
	let source = () => ({
		apiHost: normalizeHost(config?.apiHost, DEFAULT_API_HOST),
		statusHost: normalizeHost(config?.statusHost, DEFAULT_STATUS_HOST)
	});
	const hosts = () => {
		const current = source() ?? {};
		return {
			apiHost: normalizeHost(current.apiHost, DEFAULT_API_HOST),
			statusHost: normalizeHost(current.statusHost, DEFAULT_STATUS_HOST)
		};
	};
	const balance = createBalanceReader({
		...balanceReaderOptions,
		listKeys: () => ring.secrets(),
		getHosts: hosts
	});
	const onKeyFailure = (kind, _message, key) => {
		const id = key === void 0 ? void 0 : idByKey.get(key);
		if (id === void 0) {
			ctx.logger?.warn?.("packycode-api: %s reported for an unidentified key; not rotating", kind);
			return;
		}
		ctx.logger?.warn?.("packycode-api: %s on key %s; the next key serves the retry", kind, id);
		ring.disable(id, kind).then(() => balance.invalidate()).catch((error) => ctx.logger?.warn?.("packycode-api: could not move past key %s: %s", id, error.message));
	};
	const raw = createPackyCodeProvider();
	/**
	* The gateway's Codex-group check refuses a Responses request that carries no
	* `prompt_cache_key` with a 403, which pi-ai derives from the session id. The
	* harness supplies one for every agent turn; this fallback covers a caller
	* that does not, so the route never fails for a missing cache key.
	*/
	const fallbackSessionId = `${PLUGIN_ID}-${randomUUID()}`;
	const withSessionId = (options) => options === void 0 || options.sessionId !== void 0 ? options : {
		...options,
		sessionId: fallbackSessionId
	};
	const profile = createPackyCodeProfile(Object.freeze({
		...raw,
		stream: (model, context, options) => guardKeyRotation(raw.stream(model, context, withSessionId(options)), {
			key: options?.apiKey,
			onKeyFailure
		}),
		streamSimple: (model, context, options) => guardKeyRotation(raw.streamSimple(model, context, withSessionId(options)), {
			key: options?.apiKey,
			onKeyFailure
		})
	}));
	const profiles = /* @__PURE__ */ new Map([[PROVIDER, profile]]);
	/**
	* The Claude Code CLI runner. PackyCode's `cc` group serves its Claude
	* models only to the official CLI, so CLI-backed models below are run by
	* that CLI itself — with this plugin's endpoint and key, in an isolated
	* config home.
	*/
	const claudeCli = createClaudeCliManager({ explicitPath: () => config?.claudeCliPath });
	const claudeRunner = createClaudeRunner({
		binary: () => claudeCli.binary(),
		resolveCredential: async () => {
			const active = await ring.activeKey();
			if (active === void 0) throw new Error("Claude Code CLI needs a usable PackyCode API key; add one under Settings → PackyCode");
			return {
				baseUrl: hosts().apiHost,
				token: active.key
			};
		}
	});
	/** The session of the agent this turn runs for, when one is in scope. */
	const currentSession = () => {
		try {
			return ctx.get?.("agents")?.currentInitiator?.()?.session;
		} catch {
			return;
		}
	};
	/** The session's own workspace, so a CLI turn edits the project in view. */
	const resolveCliCwd = () => {
		const configured = typeof config?.claudeCliCwd === "string" ? config.claudeCliCwd.trim() : "";
		if (configured !== "") return configured;
		const cwd = currentSession()?.header?.cwd;
		return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
	};
	/**
	* The most a CLI turn may do: an explicit setting when the profile names
	* one, otherwise what the session's permission preset allows.
	*/
	const configuredCliMode = () => {
		const configured = config?.claudeCliMode;
		return configured === void 0 || configured === "auto" ? void 0 : configured;
	};
	const cliModeCeiling = (session) => configuredCliMode() ?? claudeModeForSession(ctx, session);
	const resolveCliMode = () => cliModeCeiling(currentSession()) ?? "edit";
	/**
	* Dispatch per model: CLI-backed ids run the Claude Code CLI, everything
	* else keeps the pi-ai path.
	*/
	const adapter = createClaudeCliAdapter({
		inner: new PiAiAdapter({
			profiles: () => profiles,
			resolveApiKey: async () => {
				await rememberKeys();
				const active = await ring.activeKey();
				if (active === void 0) throw new LlmError("No usable PackyCode API key: add one under Settings → PackyCode, or re-enable the keys this plugin moved past.", "MISSING_CREDENTIAL");
				return active.key;
			},
			auth: Object.freeze({
				credentials: ringCredentialStore(ring),
				authContext: Object.freeze({
					env: async () => void 0,
					fileExists: async () => false
				})
			}),
			resolveAttachments: () => ctx.get?.("attachments") ?? ctx.attachments
		}),
		runner: claudeRunner,
		resolveMode: resolveCliMode,
		resolveCwd: resolveCliCwd
	});
	ctx.llm.registerAdapter([PROVIDER], adapter);
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: DISPLAY_NAME,
		settingsNs: SETTINGS_NAMESPACE,
		settingsPath: []
	}]);
	const preference = {
		writable: false,
		set: async () => {
			throw new Error("PackyCode host overrides are not writable in this profile");
		}
	};
	ctx.inject(["settings"], (settingsCtx) => {
		try {
			settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, source(), {
				setSource: (current) => {
					source = typeof current === "function" ? () => current() ?? {} : () => current ?? {};
				},
				onChange: () => balance.invalidate()
			});
			if (typeof settingsCtx.settings.update === "function") {
				preference.writable = true;
				preference.set = (patch) => settingsCtx.settings.update(SETTINGS_NAMESPACE, patch);
			}
		} catch (error) {
			ctx.logger?.warn?.("packycode-api: host overrides unavailable, defaults stand: %s", error.message);
		}
	});
	rememberKeys().catch(() => void 0);
	const handler = createPackyCodeRpc({
		ring,
		balance,
		hosts,
		preference,
		claudeCli
	});
	/**
	* Connection registers a channel through `owner.webServer`, read on its own
	* row's fiber — which is why this plugin ships the `connection` inject patch
	* in `cordis.patch.yml`. Without that service the read is refused, the
	* channel never reaches the web server, and the browser answers HTTP 405
	* while the boot log stays clean. A profile with neither service (a headless
	* run) simply never runs this callback.
	*/
	ctx.inject(["connection", "webServer"], (connectionCtx) => {
		ctx.effect(() => connectionCtx.connection.rpc.handle(CHANNEL, handler), "packycode-api: loopback account RPC");
	});
	/**
	* The explicit delegation tool, for asking Claude Code for something while
	* another model drives the session. It shares the runner the CLI-backed
	* models use.
	*/
	ctx.inject(["tools"], (toolsCtx) => {
		ctx.effect(() => toolsCtx.tools.register(defineTool({
			name: "claude_code",
			description: "Delegate a task to the local Claude Code CLI (the official `claude` binary), which runs it with its own tools and returns its final answer. Use it when the user asks for Claude or when a task suits Claude Code. The child runs with this plugin's PackyCode endpoint and API key, in an isolated config home. `mode` bounds what it may do on its own: \"read-only\" (Read/Grep/Glob), \"edit\" (also Edit/Write), \"full\" (bypasses the CLI's permission checks, including shell commands); it defaults to, and is capped at, what this session's permission preset allows. It starts a fresh CLI session per call, takes tens of seconds, and bills through the same PackyCode key. Its internal tool calls are not part of this session's transcript — only the returned answer is.",
			parameters: {
				prompt: {
					type: "string",
					required: true,
					description: "The task for Claude Code, written as a self-contained instruction (it does not see this conversation)."
				},
				mode: {
					type: "string",
					enum: Object.keys(CLAUDE_CLI_MODES),
					description: "What the CLI may do on its own. Defaults to the most this session's permission preset allows; a wider mode is capped to it. Ask for \"full\" only when the task genuinely needs shell commands."
				},
				model: {
					type: "string",
					description: "Model id passed to the CLI (for example \"claude-opus-5-5\", \"claude-sonnet-5-5\", or \"claude-haiku-5-5\"). Omit to use the CLI's own default."
				},
				cwd: {
					type: "string",
					description: "Working directory for the CLI. Defaults to this session's workspace; a relative path resolves against it."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						result: {
							type: "string",
							required: true
						},
						model: {
							type: "string",
							required: true
						},
						mode: {
							type: "string",
							required: true
						},
						costUsd: {
							type: "number",
							required: true
						},
						durationMs: {
							type: "number",
							required: true
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `${value.result}\n\n— Claude Code CLI · ${value.model || "default model"} · ${value.mode} · ${Math.round(value.durationMs / 1e3)}s · $${value.costUsd.toFixed(4)}`
				}]
			},
			async execute(args, exec) {
				const sessionCwd = exec?.agent?.session?.header?.cwd;
				const requested = typeof args.cwd === "string" ? args.cwd.trim() : "";
				const cwd = requested === "" ? sessionCwd : isAbsolute(requested) ? requested : sessionCwd === void 0 ? requested : join(sessionCwd, requested);
				return await claudeRunner.run({
					prompt: args.prompt,
					mode: capClaudeMode(args.mode, cliModeCeiling(exec?.agent?.session)) ?? "edit",
					model: args.model,
					cwd,
					signal: exec?.signal
				});
			}
		})), "packycode-api: claude_code tool");
	});
}
//#endregion
export { AUTO_CLAUDE_MODE, CHANNEL, CLAUDE_CLI_MODES, CLAUDE_INSTALL_COMMAND, CLAUDE_MISSING_MESSAGE, CLAUDE_NPM_PACKAGE, CLI_BACKED_MODEL_IDS, Config, DEFAULT_API_HOST, DEFAULT_STATUS_HOST, DISPLAY_NAME, PACKYCODE_MODELS, PACKYCODE_MODEL_IDS, PLUGIN_ID, PROVIDER, PackyCodeKeyRing, SETTINGS_NAMESPACE, TITLE_MODEL_ID, apply, assertApiKey, buildClaudeArgs, buildClaudeEnvironment, capClaudeMode, classifyClientPolicy, classifyGatewayFailure, claudeBinaryCandidates, claudeModeFor, claudeModeForSession, createBalanceReader, createClaudeCliAdapter, createClaudeCliManager, createClaudeRunner, createPackyCodeProfile, createPackyCodeProvider, createPackyCodeRpc, explainClientPolicyFailure, explainNpmFailure, findClaudeBinary, guardKeyRotation, inject, locateClaudeBinary, locateNpm, name, normalizeFailureMessage, normalizeHost, npmCandidates, parseBillingSubscription, parseBillingUsage, parseClaudeResult, parseClaudeVersion, parseTokenUsage, readClaudeStreamEvents, renderAuxiliaryPrompt, renderDelegatedPrompt, resolveSpawnCommand, summarizeToolUse };
