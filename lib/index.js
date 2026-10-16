import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import z from "@deepseek-ai/schemastery";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { constants, existsSync } from "node:fs";
import { HarnessError, LlmError, QUOTA_EXCEEDED_CODE, createUserMessage, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { spawn } from "node:child_process";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { clampThinkingLevel, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { AsyncLocalStorage } from "node:async_hooks";
//#region src/request.js
/**
* The host-side HTTP plumbing every reader shares: fetch resolved at call
* time, one request bounded by a timeout and the caller's cancellation with
* redirects refused, and a shared request one caller's cancellation cannot
* abort for the others.
*
* @module dsh-packycode-api/request
*/
/**
* Resolve fetch at call time. A sibling plugin may wrap `globalThis.fetch`
* and later dismantle that wrapper; a binding captured during `apply()` would
* keep the dead wrapper for the process lifetime.
*/
function ambientFetch(input, init) {
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : void 0));
	if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
	return globalThis.fetch(input, {
		...init,
		headers
	});
}
/** One caller's cancellation must not abort a request other callers share. */
function waitForSharedRequest(promise, signal) {
	if (signal === void 0) return promise;
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		});
	});
}
/**
* A request that got no answer. Node's fetch reports every transport fault as
* a bare `fetch failed`; the message names the part a reader can act on.
*/
var TransportError = class extends Error {
	/**
	* @param cause - what fetch threw.
	* @param state - whether the timeout or the caller ended the request.
	*/
	constructor(cause, { timedOut, aborted, timeoutMs }) {
		const code = typeof cause?.cause?.code === "string" ? cause.cause.code : typeof cause?.code === "string" ? cause.code : void 0;
		const text = cause instanceof Error ? cause.message : String(cause);
		super(timedOut ? `no answer within ${Math.round(timeoutMs / 1e3)}s` : code === void 0 ? text : `${text} (${code})`, { cause });
		this.name = "TransportError";
		/** The system error code, when the transport reported one. */
		this.code = code;
		/** The timeout ended the request. */
		this.timedOut = timedOut;
		/** The caller ended the request. */
		this.aborted = aborted;
	}
};
/**
* One request, bounded by `timeoutMs` and the caller's `signal`, refusing
* redirects. A transport failure throws a {@link TransportError}.
* @param url - the target.
* @param init - fetch options; `redirect` and `signal` are set here.
* @param options - the fetch to use, the timeout, and the caller's signal.
* @returns the response, whatever its status.
*/
async function boundedFetch(url, init, { fetchImpl = ambientFetch, timeoutMs, signal } = {}) {
	const timeout = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
	try {
		return await fetchImpl(url, {
			...init,
			redirect: "error",
			signal: requestSignal
		});
	} catch (error) {
		const aborted = signal?.aborted === true;
		throw new TransportError(error, {
			aborted,
			timedOut: !aborted && timeout.aborted,
			timeoutMs
		});
	}
}
//#endregion
//#region src/cached-read.js
/**
* The read cache the balance, group, and version readers share.
*
* A read inside the TTL answers from the cache. Concurrent unforced reads
* share one request, and one caller cancelling does not abort it for the
* others. A forced read always goes out under the caller's own signal. A read
* that started before an invalidation never repopulates the cache.
*
* @module dsh-packycode-api/cached-read
*/
const clone = (value) => structuredClone(value);
/**
* @param load - `(signal) => Promise<value>`; the value carries `fetchedAt`.
* @param options - the TTL and clock.
* @returns `{ read({ force, signal }), snapshot(), peek(), invalidate() }`.
*/
function createCachedRead(load, { ttlMs, now = Date.now }) {
	let cached;
	let inFlight;
	let generation = 0;
	const start = (signal) => {
		const observed = generation;
		return load(signal).then((value) => {
			if (generation === observed) cached = value;
			return value;
		});
	};
	return Object.freeze({
		/** A copy of the current value; fresh from the network when forced or expired. */
		async read({ force = false, signal } = {}) {
			signal?.throwIfAborted();
			if (!force && cached !== void 0 && now() - cached.fetchedAt < ttlMs) return clone(cached);
			if (force) return clone(await start(signal));
			if (inFlight === void 0) {
				const pending = start();
				inFlight = pending;
				const clear = () => {
					if (inFlight === pending) inFlight = void 0;
				};
				pending.then(clear, clear);
			}
			return clone(await waitForSharedRequest(inFlight, signal));
		},
		/** A copy of the last value, however old, without a request. */
		snapshot() {
			return cached === void 0 ? void 0 : clone(cached);
		},
		/** The last value itself, for synchronous lookups that do not keep it. */
		peek() {
			return cached;
		},
		/** Drop the value; a read already in flight will not restore it. */
		invalidate() {
			generation += 1;
			cached = void 0;
		}
	});
}
//#endregion
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
/** Image credentials never participate in the conversation key ring. */
const IMAGE_KEY_RECORD_ID = "image-keys";
/**
* Model-traffic host. Each model declares the protocol its gateway route
* actually serves: `cf.api.fan/v1` answers chat/completions and responses,
* `cf.api.fan` answers the Anthropic Messages protocol at `/v1/messages`.
*/
const DEFAULT_API_HOST = "https://cf.api.fan";
/**
* Host carrying `/api/usage/token/`. `cf.api.fan` answers 404 for the whole
* `/api/*` family, so per-key quota is read from the PackyAPI host instead.
* PackyAPI now runs on `.ai` (its site and docs moved there); the `.com` name
* is DNS-poisoned on mainland networks, so a host whose fetch does not go
* through a proxy reads `fetch failed` from it.
*/
const DEFAULT_STATUS_HOST = "https://www.packyapi.ai";
/**
* Earlier default status hosts. A profile that saved one keeps working, but
* the current default is tried before it, so an unreachable legacy name
* cannot hold a read up for its whole timeout first.
*/
const LEGACY_STATUS_HOSTS = Object.freeze(["https://www.packyapi.com"]);
/** PackyAPI quotes balances in quota units of 1/500000 USD (new-api convention). */
const QUOTA_PER_USD = 5e5;
/** Balance cache lifetime; a forced read bypasses it. */
const DEFAULT_BALANCE_TTL_MS = 6e4;
/** Bound on every account request this plugin makes. */
const DEFAULT_REQUEST_TIMEOUT_MS = 2e4;
/** Effort level the route requests when a session names none. */
const DEFAULT_REASONING_LEVEL = "high";
//#endregion
//#region src/hosts.js
/**
* Which hosts a read goes to.
*
* PackyCode serves models from `cf.api.fan`, and the per-key `/api/*` family
* plus public pricing from the PackyAPI site (`cf.api.fan` answers 404
* there). A saved legacy status host (`www.packyapi.com`, DNS-poisoned on
* mainland networks) is tried after the current default, never before it.
*
* @module dsh-packycode-api/hosts
*/
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
const unique = (hosts) => [...new Set(hosts.filter((host) => typeof host === "string" && host !== ""))];
/**
* The status hosts one per-key read tries, in order: an explicit override,
* the current default, the legacy defaults, then the model hosts.
* @param hosts - the resolved host settings.
* @returns unique origins.
*/
function statusHostOrder(hosts) {
	const configured = hosts?.statusHost;
	const override = configured === void 0 || LEGACY_STATUS_HOSTS.includes(configured) ? [] : [configured];
	return unique([
		...override,
		DEFAULT_STATUS_HOST,
		...LEGACY_STATUS_HOSTS,
		hosts?.apiHost,
		DEFAULT_API_HOST
	]);
}
//#endregion
//#region src/secret-redactor.js
/**
* Redaction of plugin-owned credentials and ephemeral bridge capabilities.
* Work on decoded strings where possible; JSON-escaped forms also cover
* diagnostics containing serialized data. Delta redaction holds only the
* longest suffix that could still become a secret in the next chunk.
*/
const strings = (values) => [...new Set(values.filter((value) => typeof value === "string" && value !== ""))].sort((a, b) => b.length - a.length);
const variants = (values) => strings(values.flatMap((value) => typeof value === "string" ? [value, JSON.stringify(value).slice(1, -1)] : []));
function redactSecrets(text, values) {
	let safe = String(text);
	for (const secret of variants(values)) safe = safe.split(secret).join("[redacted]");
	return safe;
}
//#endregion
//#region src/balance.js
/**
* Per-key balance.
*
* PackyCode is a new-api style relay, and an API key can read only its own
* figures: `/api/usage/token/` reports the quota of the key that authorized
* the request. The `/v1/dashboard/billing/*` family is per key on this gateway
* as well — `hard_limit_usd` is the key's own grant, `total_usage` its own
* spend in cents, and an unlimited key reports the placeholder limit
* 100000000 — so it adds nothing and is not requested. The account's own
* balance sits behind the dashboard API, which takes a login session rather
* than a key. `cf.api.fan` answers 404 for the whole `/api/*` family, so a read
* tries the status host first and falls back through the other PackyCode
* hosts — the same fallback the PackyCode status tooling uses. A saved legacy
* status host (`www.packyapi.com`, DNS-poisoned on mainland networks) is tried
* after the current default, not before it.
*
* Credentials and response bodies stay host-side; the browser receives only
* the projection built here.
*
* @module dsh-packycode-api/balance
*/
const record$2 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
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
	const data = record$2(payload?.data) ? payload.data : payload;
	if (!record$2(data)) return void 0;
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
function statusMessage(status) {
	if (status === 401) return "this API key was rejected (401)";
	if (status === 402 || status === 403) return "the gateway refused this key's balance read (402/403)";
	if (status === 429) return "the gateway is rate limiting balance reads (429)";
	return `the gateway answered HTTP ${status}`;
}
async function getJson(url, key, { fetchImpl, timeoutMs, signal }) {
	let response;
	try {
		response = await boundedFetch(url, { headers: {
			Authorization: `Bearer ${key}`,
			Accept: "application/json"
		} }, {
			fetchImpl,
			timeoutMs,
			signal
		});
	} catch (error) {
		if (error.aborted) throw error.cause;
		throw new Error(error.message, { cause: error });
	}
	if (!response.ok) throw new Error(statusMessage(response.status));
	try {
		return await response.json();
	} catch {
		throw new Error("the gateway returned unreadable balance data");
	}
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
*
* A read that fails for one key — the gateway throttled it, a host was
* unreachable — keeps showing the last balance that key did report, marked
* `stale` with when it was read and why this read failed, instead of blanking
* the row. These last-good values live in the host process: a page refresh
* keeps them, a restart does not.
* @param options - key listing, host resolution, and transport knobs.
* @returns `{ read({force, signal}), invalidate() }`.
*/
function createBalanceReader({ listKeys, getHosts, fetchImpl = ambientFetch, now = Date.now, ttlMs = DEFAULT_BALANCE_TTL_MS, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
	if (typeof listKeys !== "function") throw new Error("PackyCode balance reader requires listKeys");
	if (typeof getHosts !== "function") throw new Error("PackyCode balance reader requires getHosts");
	/** Last successful per-key usage, by key id. */
	const lastGood = /* @__PURE__ */ new Map();
	const loadKey = async (entry, hosts, signal) => {
		const { payload } = await withFallback(statusHostOrder(hosts), "/api/usage/token/", entry.key, {
			fetchImpl,
			timeoutMs,
			signal
		});
		const usage = parseTokenUsage(payload);
		if (usage === void 0) throw new Error("the gateway returned an unrecognized usage payload");
		return usage;
	};
	const load = async (signal) => {
		signal?.throwIfAborted();
		const hosts = getHosts();
		const keys = await listKeys();
		const secrets = keys.map((entry) => entry.key);
		const safe = (value) => redactSecrets(value, secrets);
		for (const id of lastGood.keys()) if (!keys.some((entry) => entry.id === id)) lastGood.delete(id);
		const entries = [];
		for (const entry of keys) {
			const base = {
				id: entry.id,
				label: safe(entry.label),
				disabled: entry.disabled === true
			};
			try {
				const usage = await loadKey(entry, hosts, signal);
				if (usage.name !== void 0) usage.name = safe(usage.name);
				if (usage.resetPeriod !== void 0) usage.resetPeriod = safe(usage.resetPeriod);
				lastGood.set(entry.id, {
					usage,
					fetchedAt: now()
				});
				entries.push({
					...base,
					usage
				});
			} catch (error) {
				signal?.throwIfAborted();
				const message = safe(error instanceof Error ? error.message : String(error));
				const previous = lastGood.get(entry.id);
				entries.push(previous === void 0 ? {
					...base,
					error: message
				} : {
					...base,
					usage: previous.usage,
					stale: {
						fetchedAt: previous.fetchedAt,
						error: message
					}
				});
			}
		}
		return {
			keys: entries,
			hosts,
			fetchedAt: now()
		};
	};
	const cache = createCachedRead(load, {
		ttlMs,
		now
	});
	return Object.freeze({
		read: (options) => cache.read(options),
		invalidate: () => cache.invalidate()
	});
}
//#endregion
//#region src/diagnostics.js
/**
* A support summary of one DSH session, for reports such as "已达到输出 token
* 上限" or failing requests: which route, reasoning effort and output ceiling
* each request used, how every model step ended and what it consumed, and
* which retries and failures happened.
*
* The summary carries numbers and identifiers only. Message text, reasoning,
* tool arguments and results, titles, paths and key material never enter it;
* error messages are redacted and shortened. A user can paste it into a bug
* report as it is.
*
* @module dsh-packycode-api/diagnostics
*/
const DIAGNOSTICS_FORMAT = "packycode-diagnostics/1";
const SESSION_LIST_LIMIT = 20;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MESSAGE_CHARS = 160;
/** How many of each record the summary keeps, newest last. */
const DIAGNOSTICS_LIMITS = Object.freeze({
	requests: 8,
	truncated: 12,
	steps: 20,
	turns: 10,
	retries: 10,
	attempts: 10
});
const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
/** Identifier-like strings only (routes, models, efforts, reason kinds, codes). */
const word = (value) => typeof value === "string" && /^[\w.:/@[\]-]{1,80}$/u.test(value) ? value : void 0;
const iso = (value) => finite(value) === void 0 ? void 0 : new Date(value).toISOString();
const last = (list, count) => list.slice(Math.max(0, list.length - count));
const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== void 0));
const chunksOf = (stream) => Array.isArray(stream) ? stream.map((item) => item?.chunk).filter((chunk) => chunk !== null && typeof chunk === "object") : [];
/** A provider or harness error message, redacted and shortened. */
function safeMessage$1(text, secrets) {
	if (typeof text !== "string" || text === "") return void 0;
	const safe = redactSecrets(text, secrets).replace(/sk-[A-Za-z0-9_-]{8,}/gu, "sk-[redacted]").replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "Bearer [redacted]").replace(/\s+/gu, " ").trim();
	return safe.length > MESSAGE_CHARS ? `${safe.slice(0, MESSAGE_CHARS)}…` : safe;
}
function failureOf(reason, secrets) {
	const failure = reason?.failure ?? reason?.error;
	return failure === void 0 ? {} : {
		code: word(failure.code),
		message: safeMessage$1(failure.message, secrets)
	};
}
/**
* Summarize one session's events.
* @param events - the session's events in log order.
* @param options - values to redact from error messages.
* @returns the numbers-only summary body.
*/
function summarizeSessionEvents(events, { secrets = [] } = {}) {
	const requests = [];
	const steps = [];
	const turnEnds = [];
	const retries = [];
	const attempts = [];
	let turns = 0;
	let compactions = 0;
	for (const event of events ?? []) {
		const type = event?.type;
		const data = event?.data ?? {};
		if (typeof type !== "string") continue;
		if (/compact/u.test(type)) compactions += 1;
		if (type === "turn/start") turns += 1;
		else if (type === "request/header") {
			const config = data.header?.config ?? {};
			requests.push(compact({
				time: iso(event.time),
				reason: word(data.reason),
				provider: word(config.provider),
				model: word(config.model),
				reasoningEffort: word(config.reasoningEffort),
				maxTokens: finite(config.maxTokens),
				maxTokensFromAdapter: data.header?.adapterDefaults?.maxTokens === true ? true : void 0
			}));
		} else if (type === "assistant/message") {
			const chunks = chunksOf(data.stream);
			const usage = data.usage ?? chunks.find((chunk) => chunk.type === "usage")?.usage ?? {};
			const input = finite(usage.inputTokens);
			const cacheRead = finite(usage.cacheReadTokens);
			steps.push(compact({
				turn: finite(data.turn),
				step: finite(data.step),
				time: iso(event.time),
				finish: word(chunks.find((chunk) => chunk.type === "finish")?.reason?.kind) ?? "none",
				input,
				cacheRead,
				cacheWrite: finite(usage.cacheWriteTokens),
				output: finite(usage.outputTokens),
				context: input === void 0 && cacheRead === void 0 ? void 0 : (input ?? 0) + (cacheRead ?? 0)
			}));
		} else if (type === "assistant/attempt") {
			const reason = chunksOf(data.stream).find((chunk) => chunk.type === "finish")?.reason;
			attempts.push(compact({
				turn: finite(data.turn),
				step: finite(data.step),
				time: iso(event.time),
				finish: word(reason?.kind),
				...failureOf(reason, secrets)
			}));
		} else if (type === "llm/retry") retries.push(compact({
			turn: finite(data.turn),
			step: finite(data.step),
			time: iso(event.time),
			provider: word(data.provider),
			retry: finite(data.retry),
			maxRetries: finite(data.maxRetries),
			...failureOf({ failure: data.failure }, secrets)
		}));
		else if (type === "turn/end") turnEnds.push(compact({
			turn: finite(data.turn),
			time: iso(event.time),
			kind: word(data.reason?.kind),
			...failureOf(data.reason, secrets)
		}));
	}
	const truncated = steps.filter((step) => step.finish === "max-tokens");
	return {
		totals: {
			turns,
			steps: steps.length,
			maxTokenSteps: truncated.length,
			retries: retries.length,
			failedAttempts: attempts.length,
			compactionEvents: compactions
		},
		requestSettings: last(requests, DIAGNOSTICS_LIMITS.requests),
		maxTokenSteps: last(truncated, DIAGNOSTICS_LIMITS.truncated),
		recentSteps: last(steps, DIAGNOSTICS_LIMITS.steps),
		turnEnds: last(turnEnds, DIAGNOSTICS_LIMITS.turns),
		retries: last(retries, DIAGNOSTICS_LIMITS.retries),
		failedAttempts: last(attempts, DIAGNOSTICS_LIMITS.attempts)
	};
}
/**
* The diagnostics service behind the settings card.
* @param options - DSH's session query service (read lazily), the session
*   event reader the image originals already use, the key ring and group
*   reader, the stored secrets to redact, and this package's manifest URL.
*/
function createDiagnostics({ sessionQuery, readEvents, ring, groups, secrets = async () => [], ownPackageJsonUrl }) {
	const query = () => {
		const service = sessionQuery?.();
		if (typeof service?.listSessions !== "function") throw new Error("PackyCode diagnostics need DSH session history, which this runtime does not provide");
		return service;
	};
	const version = async () => {
		try {
			return word(JSON.parse(await readFile(fileURLToPath(ownPackageJsonUrl), "utf8")).version);
		} catch {
			return;
		}
	};
	/** Stored conversation keys by position: state and groups, never labels or keys. */
	const keys = async () => {
		const listed = (await ring.list()).keys ?? [];
		let reading;
		try {
			reading = await groups?.read({ force: false });
		} catch {
			reading = void 0;
		}
		return listed.map((entry, index) => {
			const group = reading?.keys?.find((item) => item.id === entry.id);
			return compact({
				key: index + 1,
				active: entry.active === true,
				disabled: entry.disabled === true ? true : void 0,
				groups: Array.isArray(group?.groups) ? group.groups.map(word).filter(Boolean) : void 0,
				reaches: group?.coverage === void 0 ? void 0 : Object.keys(group.coverage).filter((model) => group.coverage[model] === true)
			});
		});
	};
	return Object.freeze({
		/** Recent top-level sessions, newest first, for the picker. */
		async list(signal) {
			return { sessions: (await query().listSessions(signal)).filter((record) => typeof record?.header?.id === "string" && !(record.header.delegationDepth > 0)).slice(0, SESSION_LIST_LIMIT).map((record) => compact({
				id: record.header.id,
				createdAt: iso(record.header.createdAt),
				live: record.live === true,
				folder: typeof record.header.cwd === "string" && record.header.cwd !== "" ? basename(record.header.cwd) : void 0
			})) };
		},
		/** The numbers-only summary of one session. */
		async read(payload, signal) {
			const sessionId = payload?.sessionId;
			if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new Error("PackyCode diagnostics need a session to read");
			query();
			let events;
			try {
				events = await readEvents(sessionId, signal);
			} catch {
				throw new Error("PackyCode could not read that session");
			}
			const record = (await query().listSessions(signal)).find((item) => item?.header?.id === sessionId);
			return {
				format: DIAGNOSTICS_FORMAT,
				generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
				plugin: compact({ version: await version() }),
				session: compact({
					id: sessionId,
					createdAt: iso(record?.header?.createdAt),
					live: record === void 0 ? void 0 : record.live === true,
					delegationDepth: finite(record?.header?.delegationDepth)
				}),
				keys: await keys(),
				...summarizeSessionEvents(events, { secrets: await secrets() })
			};
		}
	});
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
* 5.5 (platform.claude.com effort docs), GPT-6.1 Sol and GPT-6 Astra
* `reasoning.effort` (developers.openai.com model pages), DeepSeek thinking
* mode (`thinking` toggle plus `low|high|max` effort), Grok 4.7
* (docs.x.ai/developers/grok-4-7), and Gemini 4 Argon
* (ai.google.dev/gemini-api/docs/models/gemini-4-argon and docs/openai).
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
const GEMINI_BASE = `${DEFAULT_API_HOST}/v1beta`;
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
* Claude 5.5 models, GPT-6.1 Sol, and GPT-6 Astra cannot disable reasoning, so `off` is
* pinned unsupported. Claude effort is sent through the native Messages API.
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
/** Grok 4.7 supports low | medium | high | xhigh, with no off or max. */
const GROK_LEVELS = Object.freeze({
	...ALWAYS_THINKING_LEVELS,
	max: null
});
/** Gemini 4 Argon and 3.8 Flash support low | medium | high, with no off. */
const GEMINI_LEVELS = Object.freeze({
	...ALWAYS_THINKING_LEVELS,
	xhigh: null,
	max: null
});
const PACKYCODE_MODELS = Object.freeze([
	Object.freeze({
		id: "deepseek-flash",
		name: "DeepSeek Flash",
		api: "openai-completions",
		provider: PROVIDER,
		baseUrl: COMPLETIONS_BASE,
		reasoning: true,
		input: Object.freeze(["text", "image"]),
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
		id: "gpt-6-astra",
		name: "GPT-6 Astra",
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
		id: "grok-4.7",
		name: "Grok 4.7",
		api: "openai-responses",
		provider: PROVIDER,
		baseUrl: RESPONSES_BASE,
		reasoning: true,
		input: Object.freeze(["text", "image"]),
		cost: NO_COST,
		contextWindow: 5e5,
		maxTokens: 5e5,
		thinkingLevelMap: GROK_LEVELS,
		compat: Object.freeze({ supportsLongCacheRetention: false })
	}),
	Object.freeze({
		id: "gemini-4-argon",
		name: "Gemini 4 Argon",
		api: "google-generative-ai",
		provider: PROVIDER,
		baseUrl: GEMINI_BASE,
		reasoning: true,
		input: Object.freeze(["text", "image"]),
		cost: NO_COST,
		contextWindow: 1048576,
		maxTokens: 65536,
		thinkingLevelMap: GEMINI_LEVELS
	}),
	Object.freeze({
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		api: "google-generative-ai",
		provider: PROVIDER,
		baseUrl: GEMINI_BASE,
		reasoning: true,
		input: Object.freeze(["text", "image"]),
		cost: NO_COST,
		contextWindow: 1048576,
		maxTokens: 65536,
		thinkingLevelMap: GEMINI_LEVELS
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
		contextWindow: 1e6,
		maxTokens: 128e3,
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
//#region src/groups.js
/**
* Which PackyCode token groups each stored key belongs to, and which catalog
* models those groups can serve.
*
* PackyCode routes a request by the token's groups: a key without a Claude
* Code group (`cc`, `cc-sale`, …) is refused for Claude, a key without a Codex
* group for GPT. None of that is visible from the key itself, so a key that
* cannot serve the selected model looked exactly like a client or CLI fault.
*
* Three host-side reads answer it, none of them billed:
* - the gateway refuses a model id it cannot route before contacting any
*   upstream, and its refusal names the token's groups
*   (`已选分组=[codex deepseek-officially kimi-sale]`);
* - `/v1/models` lists the models the key can reach;
* - the public `/api/pricing` lists each model's groups and each group's
*   description.
*
* Every request is bounded by a timeout and refuses redirects. Nothing here
* returns key material: the projection carries group names, their public
* descriptions, and per-model booleans.
*
* @module dsh-packycode-api/groups
*/
/** A model id no gateway routes; its refusal is what names the groups. */
const GROUP_PROBE_MODEL = "dsh-packycode-group-probe";
/** Group membership changes rarely; a forced read bypasses this. */
const DEFAULT_GROUP_TTL_MS = 10 * 6e4;
const SELECTED_GROUPS = /已选分组\s*[=＝:：]\s*\[([^\]]*)\]/u;
const GROUP_NAME = /^[A-Za-z0-9._-]{1,64}$/u;
const INVALID_KEY = /无效的令牌|令牌无效|invalid[\s_-]+api[\s_-]*key|invalid_authentication/iu;
const MAX_GROUPS = 32;
const MAX_DESCRIPTION = 80;
/** Keys read at once. */
const KEY_CONCURRENCY = 4;
const record$1 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** Run `task` over `items`, at most `limit` at a time, keeping their order. */
async function mapLimited(items, limit, task) {
	const results = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await task(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
/** The gateway refused the key itself; it reaches no model at all. */
var RejectedKeyError = class extends Error {
	constructor() {
		super("the gateway rejected this key");
	}
};
/**
* Read the token's groups out of the gateway's routing refusal.
* @param message - the refusal text.
* @returns the group names, or undefined when the text names none.
*/
function parseSelectedGroups(message) {
	const match = SELECTED_GROUPS.exec(typeof message === "string" ? message : "");
	if (match === null) return void 0;
	return [...new Set(match[1].split(/[\s,，、]+/u).filter((name) => GROUP_NAME.test(name)))].slice(0, MAX_GROUPS);
}
/**
* Normalize `/api/pricing`: the groups each catalog model is enabled in, and
* each group's public description.
* @param payload - the parsed pricing body.
* @returns `{ modelGroups, descriptions }`, or undefined when unrecognized.
*/
function parsePricing(payload) {
	if (!record$1(payload) || !Array.isArray(payload.data)) return void 0;
	const modelGroups = {};
	for (const item of payload.data) {
		if (!record$1(item) || !PACKYCODE_MODEL_IDS.includes(item.model_name) || !Array.isArray(item.enable_groups)) continue;
		modelGroups[item.model_name] = [...new Set(item.enable_groups.filter((name) => typeof name === "string" && GROUP_NAME.test(name)))].sort();
	}
	const descriptions = {};
	if (record$1(payload.usable_group)) for (const [name, description] of Object.entries(payload.usable_group)) {
		if (!GROUP_NAME.test(name) || typeof description !== "string") continue;
		const clean = description.replace(/\s+/gu, " ").trim().slice(0, MAX_DESCRIPTION);
		if (clean !== "") descriptions[name] = clean;
	}
	return {
		modelGroups,
		descriptions
	};
}
/**
* Which catalog models a key can reach. Either source decides: a model the
* key's groups are enabled for, or one its model list shows. A model is only
* marked unreachable on evidence; with neither source it is left unknown.
* @param options - the key's groups, its model ids, and pricing's model groups.
* @returns catalog model id → reachable, for the models with evidence.
*/
function catalogCoverage({ groups, models, modelGroups }) {
	const coverage = {};
	for (const id of PACKYCODE_MODEL_IDS) {
		const enabled = modelGroups?.[id];
		const byGroups = groups === void 0 || enabled === void 0 ? void 0 : enabled.some((name) => groups.includes(name));
		const byModels = models === void 0 ? void 0 : models.has(id);
		if (byGroups === true || byModels === true) coverage[id] = true;
		else if (byGroups === false || byModels === false) coverage[id] = false;
	}
	return coverage;
}
async function bodyText(response) {
	try {
		return await response.text();
	} catch {
		return "";
	}
}
function errorMessage(text) {
	try {
		const parsed = JSON.parse(text);
		const message = parsed?.error?.message ?? parsed?.message;
		if (typeof message === "string") return message;
	} catch {}
	return text;
}
/**
* Cached, single-flight group reader.
* @param options - key listing, host resolution, and transport knobs.
* @returns `{ read, snapshot, covers, requiredGroups, invalidate }`.
*/
function createGroupReader({ listKeys, getHosts, fetchImpl = ambientFetch, now = Date.now, ttlMs = DEFAULT_GROUP_TTL_MS, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
	if (typeof listKeys !== "function") throw new Error("PackyCode group reader requires listKeys");
	if (typeof getHosts !== "function") throw new Error("PackyCode group reader requires getHosts");
	/** Last good reading per key id, kept when a later read of that key fails. */
	const lastGood = /* @__PURE__ */ new Map();
	let lastPricing;
	const request = (url, init, signal) => boundedFetch(url, init, {
		fetchImpl,
		timeoutMs,
		signal
	});
	const loadPricing = async (hosts, signal) => {
		const tried = [];
		for (const host of statusHostOrder(hosts)) try {
			const response = await request(`${host}/api/pricing`, { headers: { Accept: "application/json" } }, signal);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const pricing = parsePricing(await response.json());
			if (pricing === void 0) throw new Error("unrecognized pricing payload");
			return pricing;
		} catch (error) {
			signal?.throwIfAborted();
			tried.push(`${host}: ${error.message}`);
		}
		throw new Error(tried.join("; "));
	};
	/** The token's groups, from the gateway's refusal of a model it cannot route. */
	const loadGroups = async (entry, hosts, signal) => {
		const response = await request(`${hosts.apiHost}/v1/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${entry.key}`,
				Accept: "application/json",
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				model: GROUP_PROBE_MODEL,
				max_tokens: 1,
				messages: [{
					role: "user",
					content: "."
				}]
			})
		}, signal);
		const message = errorMessage(await bodyText(response));
		if (response.status === 401 || INVALID_KEY.test(message)) throw new RejectedKeyError();
		return parseSelectedGroups(message);
	};
	/** The models the key can reach. */
	const loadModels = async (entry, hosts, signal) => {
		const response = await request(`${hosts.apiHost}/v1/models`, { headers: {
			Authorization: `Bearer ${entry.key}`,
			Accept: "application/json"
		} }, signal);
		if (response.status === 401) throw new RejectedKeyError();
		if (!response.ok) return void 0;
		const payload = await response.json();
		if (!Array.isArray(payload?.data)) return void 0;
		return new Set(payload.data.map((item) => item?.id).filter((id) => typeof id === "string"));
	};
	/**
	* One key's groups and model list. The two are independent evidence: one
	* failing in transit does not discard the other, and a rejection from
	* either means the gateway refuses the key itself.
	*/
	const readKey = async (entry, hosts, signal) => {
		const results = await Promise.allSettled([loadGroups(entry, hosts, signal), loadModels(entry, hosts, signal)]);
		if (results.some((result) => result.status === "rejected" && result.reason instanceof RejectedKeyError)) return { rejected: true };
		const [groups, models] = results.map((result) => result.status === "fulfilled" ? result.value : void 0);
		if (groups === void 0 && models === void 0) throw results.find((result) => result.status === "rejected")?.reason ?? /* @__PURE__ */ new Error("the gateway named no groups for this key");
		return {
			groups,
			models
		};
	};
	/**
	* Pricing and every key are read concurrently (a few keys at a time), so a
	* slow or broken key does not hold up the reading for the others.
	*/
	const load = async (signal) => {
		signal?.throwIfAborted();
		const hosts = getHosts();
		const keys = await listKeys();
		for (const id of lastGood.keys()) if (!keys.some((entry) => entry.id === id)) lastGood.delete(id);
		const pricingTask = loadPricing(hosts, signal).then((pricing) => {
			lastPricing = pricing;
			return pricing;
		}, () => {
			signal?.throwIfAborted();
			return lastPricing;
		});
		const readings = await mapLimited(keys, KEY_CONCURRENCY, (entry) => readKey(entry, hosts, signal).then((value) => ({ value }), (error) => ({ error })));
		const pricing = await pricingTask;
		signal?.throwIfAborted();
		return {
			keys: keys.map((entry, index) => {
				const { value, error } = readings[index];
				if (value?.rejected === true) {
					lastGood.delete(entry.id);
					return {
						id: entry.id,
						rejected: true,
						coverage: Object.fromEntries(PACKYCODE_MODEL_IDS.map((id) => [id, false])),
						error: new RejectedKeyError().message
					};
				}
				if (value !== void 0) {
					const reading = {
						id: entry.id,
						...value.groups === void 0 ? {} : { groups: value.groups },
						coverage: catalogCoverage({
							groups: value.groups,
							models: value.models,
							modelGroups: pricing?.modelGroups
						})
					};
					lastGood.set(entry.id, {
						value: reading,
						fetchedAt: now()
					});
					return reading;
				}
				const message = error instanceof Error ? error.message : String(error);
				const previous = lastGood.get(entry.id);
				return previous === void 0 ? {
					id: entry.id,
					coverage: {},
					error: message
				} : {
					...previous.value,
					stale: {
						fetchedAt: previous.fetchedAt,
						error: message
					}
				};
			}),
			descriptions: pricing?.descriptions ?? {},
			requirements: pricing?.modelGroups ?? {},
			fetchedAt: now()
		};
	};
	const cache = createCachedRead(load, {
		ttlMs,
		now
	});
	const keyEntry = (keyId) => cache.peek()?.keys.find((candidate) => candidate.id === keyId);
	return Object.freeze({
		/**
		* Read every key's groups; cached for the TTL unless forced.
		* @returns the projection the settings panel shows.
		*/
		read: (options) => cache.read(options),
		/** The last reading, however old, without touching the network. */
		snapshot: () => cache.snapshot(),
		/** Whether any reading exists yet. */
		hasReading: () => cache.peek() !== void 0,
		/**
		* Whether a key's groups reach a model, from the last reading.
		* @returns true, false, or undefined when there is no evidence.
		*/
		covers(keyId, modelId) {
			const value = keyEntry(keyId)?.coverage?.[modelId];
			return typeof value === "boolean" ? value : void 0;
		},
		/** The groups pricing lists for a model, from the last reading. */
		requiredGroups(modelId) {
			const groups = cache.peek()?.requirements?.[modelId];
			return Array.isArray(groups) ? [...groups] : void 0;
		},
		/** The groups the last reading found for a key. */
		groupsOf(keyId) {
			const groups = keyEntry(keyId)?.groups;
			return Array.isArray(groups) ? [...groups] : void 0;
		},
		/** Drop the reading so the next read goes to the network. */
		invalidate: () => cache.invalidate()
	});
}
/**
* Pick the key a request for `modelId` runs with.
*
* The active key serves every model it is not known to be excluded from.
* When the last reading shows its groups cannot reach the model, the next
* usable key in ring order that can — or, failing that, one with no evidence
* either way — serves this request instead. The active pointer itself does
* not move; with no better key the active one is returned, marked uncovered.
* @param modelId - the catalog model of this request.
* @param active - the ring's active key.
* @param usable - the ring's usable keys, in ring order.
* @param covers - `(keyId, modelId) => true | false | undefined`.
* @returns the chosen key, with `switchedFrom` or `uncovered` when it is not
*   simply the active key.
*/
function pickKeyForModel(modelId, active, usable, covers) {
	if (active === void 0) return void 0;
	if (typeof modelId !== "string" || covers(active.id, modelId) !== false) return { ...active };
	const start = usable.findIndex((entry) => entry.id === active.id);
	const others = start < 0 ? usable.filter((entry) => entry.id !== active.id) : [...usable.slice(start + 1), ...usable.slice(0, start)];
	const pick = others.find((entry) => covers(entry.id, modelId) === true) ?? others.find((entry) => covers(entry.id, modelId) === void 0);
	if (pick === void 0) return {
		...active,
		uncovered: true
	};
	return {
		id: pick.id,
		label: pick.label,
		key: pick.key,
		switchedFrom: {
			id: active.id,
			label: active.label
		}
	};
}
//#endregion
//#region src/image-models.js
/** Images API models are separate from the conversational pi-ai catalog. */
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const IMAGE_MODELS = Object.freeze({
	"gpt-image-2": Object.freeze([
		"auto",
		"low",
		"medium",
		"high"
	]),
	"gpt-image-2.5-flare": Object.freeze([
		"auto",
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	]),
	"gpt-image-2.5-sunburst": Object.freeze([
		"auto",
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	])
});
const IMAGE_MODEL_IDS = Object.freeze(Object.keys(IMAGE_MODELS));
const IMAGE_QUALITIES = Object.freeze([
	"auto",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
]);
function validateImageOptions({ model = DEFAULT_IMAGE_MODEL, quality = "auto", size = "auto", background = "auto" } = {}) {
	if (!IMAGE_MODEL_IDS.includes(model)) throw new Error("PackyCode image model is not supported");
	if (!IMAGE_MODELS[model].includes(quality)) throw new Error("PackyCode image quality is not supported by the selected model");
	if (![
		"auto",
		"transparent",
		"opaque"
	].includes(background)) throw new Error("PackyCode image background is not supported");
	if (size !== "auto") {
		const match = typeof size === "string" ? /^(\d{1,4})x(\d{1,4})$/u.exec(size) : null;
		const width = Number(match?.[1]);
		const height = Number(match?.[2]);
		const pixels = width * height;
		if (match === null || width % 16 !== 0 || height % 16 !== 0 || Math.max(width, height) > 3840 || Math.max(width, height) > Math.min(width, height) * 3 || pixels < 655360 || pixels > 8294400) throw new Error("PackyCode image size must be auto or a supported widthxheight resolution");
	}
	return {
		model,
		quality,
		size,
		background
	};
}
//#endregion
//#region src/preferences.js
/**
* Where the plugin's preferences are read from and written to, on both
* settings generations DSH has shipped.
*
* - DSH 0.1.5 installs a settings *section*: the section hands back a live
*   source and writes go through `settings.update(namespace, patch)`.
* - DSH 0.2 has no sections: a preference is a *volatile* Config field of the
*   plugin's own row, read through a live reference, written through
*   `settings.update(rowId, patch)`, and announced by `loader/volatile-update`.
*   Only volatile fields are writable there, so the host overrides stay
*   read-only while web search and model visibility are editable.
*
* @module dsh-packycode-api/preferences
*/
/**
* Mark a preference editable without restarting the plugin. DSH 0.2 stores
* plugin preferences as volatile Config fields and writes only those, so the
* schema version that implements `volatile()` is a peer requirement.
*
* Name the cause when it is missing instead of letting a bare
* `schema.volatile is not a function` reach the host log: the Loader creates
* no fiber for a plugin whose module throws while it is imported, so DSH shows
* nothing at all — no settings section, no model route, no RPC channel — and
* the only explanation is that one log line.
*/
const live = (schema) => {
	if (typeof schema?.volatile !== "function") throw new Error("PackyCode needs @deepseek-ai/schemastery ^3.18.4, which implements Schema.volatile(); the copy resolved for this plugin is older. A plugin installed from a registry has no node_modules of its own, so this usually means a stale dependency tree inside the installed package directory (for example <profile>/node_modules/dsh-packycode-api/node_modules, left by an earlier local-path install) is shadowing the DSH installation. Remove that directory, or uninstall the plugin and install it again, then restart DSH.");
	return schema.volatile();
};
/** Read a Config field that may arrive as a volatile reference. */
const fieldValue = (value) => value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
/** A preference target nothing can write to yet. */
function unwritable(message) {
	return {
		writable: false,
		set: async () => {
			throw new Error(message);
		}
	};
}
/**
* Connect the preferences to the settings service the host provides.
* @param settingsCtx - the scope the `settings` inject handed over.
* @param options - the plugin context and Config, the section namespace, the
*   current source and how to replace it, what to do when the section changes,
*   and the preference targets this fills in (host overrides, search, models).
*/
function connectSettings(settingsCtx, { ctx, Config, namespace, source, setSource, onChange, hostPreference, searchPreference, modelPreference, imagePreference }) {
	const settings = settingsCtx.settings;
	if (typeof settings?.installSection === "function") {
		try {
			settings.installSection(ctx, namespace, Config, source(), {
				setSource: (current) => setSource(typeof current === "function" ? () => current() ?? {} : () => current ?? {}),
				onChange
			});
			if (typeof settings.update === "function") {
				const write = (patch) => settings.update(namespace, patch);
				const target = {
					writable: settings.writable !== false,
					set: write
				};
				Object.assign(hostPreference, target);
				Object.assign(searchPreference, target);
				Object.assign(modelPreference, target);
				if (imagePreference !== void 0) Object.assign(imagePreference, target);
			}
		} catch (error) {
			ctx.logger?.warn?.("packycode-api: host overrides unavailable, defaults stand: %s", error.message);
		}
		return;
	}
	if (typeof settings?.update !== "function") return;
	const rowId = ctx.fiber?.entry?.options?.id ?? namespace;
	const target = {
		writable: settings.writable !== false,
		set: (patch) => settings.update(rowId, patch)
	};
	Object.assign(searchPreference, target);
	Object.assign(modelPreference, target);
	if (imagePreference !== void 0) Object.assign(imagePreference, target);
	if (typeof settings.configure === "function") {
		const scope = typeof settingsCtx.effect === "function" ? settingsCtx : ctx;
		try {
			scope.effect(() => settings.configure({ auto: false }, ctx.fiber), "packycode-api: settings page policy");
		} catch (error) {
			ctx.logger?.warn?.("packycode-api: could not hide the generated settings page: %s", error.message);
		}
	}
}
//#endregion
//#region src/image-settings.js
function readImagePreference(value = {}) {
	const model = fieldValue(value.imageModel);
	const imageModel = IMAGE_MODEL_IDS.includes(model) ? model : DEFAULT_IMAGE_MODEL;
	const quality = fieldValue(value.imageQuality);
	return {
		imageEnabled: fieldValue(value.imageEnabled) !== false,
		imageModel,
		imageQuality: IMAGE_MODELS[imageModel].includes(quality) ? quality : "auto"
	};
}
/** No request is sent by a settings or credential mutation. */
function createImageController({ ring, balance, readPreference, writePreference, isWritable }) {
	let mounted;
	let disposeTool;
	let generation = 0;
	let closed = false;
	const preference = () => readImagePreference(readPreference());
	const reconcile = async () => {
		const current = ++generation;
		const key = await ring.activeKey();
		if (closed || current !== generation) return;
		const enabled = preference().imageEnabled && key !== void 0 && mounted !== void 0;
		if (enabled && disposeTool === void 0) disposeTool = mounted();
		if (!enabled && disposeTool !== void 0) {
			disposeTool();
			disposeTool = void 0;
		}
	};
	const status = async () => ({
		...preference(),
		...await ring.list(),
		writable: isWritable() === true,
		available: mounted !== void 0,
		toolRegistered: disposeTool !== void 0,
		models: IMAGE_MODEL_IDS.map((id) => ({
			id,
			qualities: [...IMAGE_MODELS[id]]
		}))
	});
	return {
		preference,
		status,
		invalidateBalance: () => balance?.invalidate(),
		async readBalance({ force = false, signal } = {}) {
			if (balance === void 0) throw new Error("PackyCode image balance is unavailable in this runtime");
			try {
				const [value, state] = await Promise.all([balance.read({
					force,
					signal
				}), ring.list()]);
				return {
					...value,
					activeId: state.activeId
				};
			} catch {
				throw new Error("PackyCode image balance could not be read");
			}
		},
		reconcile,
		mount(register) {
			mounted = register;
			closed = false;
			reconcile().catch(() => void 0);
			return () => {
				closed = true;
				generation += 1;
				mounted = void 0;
				disposeTool?.();
				disposeTool = void 0;
			};
		},
		async update(value = {}) {
			if (isWritable() !== true) throw new Error("PackyCode image settings are not writable in this profile");
			const patch = {};
			if (Object.hasOwn(value, "imageEnabled")) {
				if (typeof value.imageEnabled !== "boolean") throw new Error("PackyCode image switch must be a boolean");
				patch.imageEnabled = value.imageEnabled;
			}
			if (Object.hasOwn(value, "imageModel")) patch.imageModel = value.imageModel;
			if (Object.hasOwn(value, "imageQuality")) patch.imageQuality = value.imageQuality;
			const next = {
				...preference(),
				...patch
			};
			if (patch.imageModel !== void 0 && patch.imageQuality === void 0 && !IMAGE_MODELS[patch.imageModel]?.includes(next.imageQuality)) patch.imageQuality = next.imageQuality = "auto";
			validateImageOptions({
				model: next.imageModel,
				quality: next.imageQuality
			});
			try {
				await writePreference(patch);
			} catch {
				throw new Error("PackyCode could not save the image settings");
			}
			await reconcile();
			return status();
		},
		async mutate(operation, payload = {}) {
			const operations = {
				add: () => ring.add(payload.key, payload.label),
				rename: () => ring.rename(String(payload.id ?? ""), payload.label),
				remove: () => ring.remove(String(payload.id ?? "")),
				select: () => ring.select(String(payload.id ?? "")),
				enable: () => ring.enable(String(payload.id ?? ""))
			};
			if (!Object.hasOwn(operations, operation)) throw new Error("Unknown PackyCode image key operation");
			await operations[operation]();
			balance?.invalidate();
			await reconcile();
			return status();
		}
	};
}
//#endregion
//#region src/image-conversation.js
/** Project this plugin's durable image results into chat without duplicating context. */
const IMAGE_CHAT_KIND = "packycode-image-output";
const IMAGE_TOOLS = /* @__PURE__ */ new Set(["packycode_image_generate", "claude_code"]);
const hasImage = (content) => Array.isArray(content) && content.some((part) => part.type === "image" && part.attachment);
function successfulImages(event) {
	if (event?.type === "tool/result" && event.data?.meta?.kind === "packycode-image") {
		const message = event.data.message;
		const toolCallId = message?.source?.callId;
		if (message?.source?.kind !== "tool" || typeof toolCallId !== "string" || toolCallId === "" || message.isError === true || !hasImage(message.content)) return [];
		return [{
			type: "tool-result",
			toolCallId,
			content: message.content,
			isError: false,
			meta: event.data.meta
		}];
	}
	if (event?.type === "tool/ptc-dispatch" && IMAGE_TOOLS.has(event.data?.name) && event.data.isError === false && typeof event.data.subCallId === "string" && hasImage(event.data.content)) return [{
		type: "tool-result",
		toolCallId: event.data.subCallId,
		content: event.data.content,
		meta: { kind: "packycode-image" }
	}];
	const source = event?.data?.message?.source;
	if (event?.type !== "assistant/message" || source?.kind !== "model" || source.provider !== "packycode" || !/^claude-/u.test(source.model ?? "")) return [];
	return (event.data.message.content ?? []).flatMap((block, index) => block.type === "image" && block.attachment ? [{
		type: "tool-result",
		toolCallId: `packycode-cli-image-${event.seq}-${index}`,
		content: [block]
	}] : []);
}
const imageConversationNode = {
	kind: IMAGE_CHAT_KIND,
	target: "chat",
	match(event) {
		const images = successfulImages(event);
		if (images.length === 0) return null;
		const id = event.type === "assistant/message" ? `cli:${event.seq}` : event.data?.subCallId ?? event.data?.message?.source?.callId ?? images[0].toolCallId ?? `event:${event.seq}`;
		return {
			id: String(id),
			role: "update"
		};
	},
	start: () => ({}),
	update: (context) => context.state ?? {},
	buildViewNode(context) {
		const results = context.matches.filter((match) => successfulImages(match.event).length > 0);
		if (results.length === 0) return null;
		const turn = (results.find((match) => match.location?.kind === "turn" || match.location?.kind === "step")?.location)?.turn;
		const finished = turn?.end;
		const blocks = [...new Map(results.flatMap(({ event }) => successfulImages(event).map((block) => [block.toolCallId, {
			...block,
			kind: "tool-result"
		}]))).values()];
		const answerSeq = turn?.steps?.at(-1)?.data.get("assistant-step")?.finalNode?.seq;
		const lastImageSeq = Math.max(...results.map((match) => match.event.seq));
		return {
			key: context.key,
			id: context.id,
			kind: IMAGE_CHAT_KIND,
			target: "chat",
			location: { kind: "session" },
			visibility: "visible",
			anchorSeq: answerSeq > lastImageSeq ? answerSeq + .025 : finished === void 0 ? lastImageSeq + .025 : finished.seq - .025,
			data: {
				...turn === void 0 ? {} : { turn: turn.turn },
				blocks
			}
		};
	}
};
//#endregion
//#region src/images.js
/** Host-only Images API transport and DSH tool. No subscription/LLM key fallback. */
const IMAGE_TOOL_NAME = "packycode_image_generate";
const IMAGE_TIMEOUT_MS = 5 * 6e4;
const MAX_IMAGE_BYTES = 48 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 16;
const ENVELOPE_BYTES = 1024 * 1024;
const EDIT_MEDIA_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp"
];
const SIGNATURE = "89504e470d0a1a0a";
const ATTACHMENT_ID$1 = /^sha256:[0-9a-f]{64}$/u;
var ImageRequestError = class extends Error {};
const nonempty = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
/** Explicit absence, including zero-valued placeholders filled by some models. */
function emptyMaskReference(value) {
	if (value === null) return true;
	return value !== void 0 && typeof value === "object" && (value.attachmentId === "" || value.attachmentId === `sha256:${"0".repeat(64)}`) && value.bytes === 0 && value.width === 0 && value.height === 0 && (value.name === void 0 || value.name === "") && (value.originalDimensions === void 0 || value.originalDimensions.width === 0 && value.originalDimensions.height === 0);
}
/** A bounded reader applies to both successful payloads and error envelopes. */
async function readJson(response, maximum, signal) {
	const length = Number(response.headers.get("content-length"));
	if (Number.isFinite(length) && length > maximum || response.body === null) {
		await response.body?.cancel().catch(() => void 0);
		throw new ImageRequestError("PackyCode image response is unreadable or exceeds the size limit");
	}
	const reader = response.body.getReader();
	const cancel = () => {
		reader.cancel().catch(() => void 0);
	};
	signal.addEventListener("abort", cancel, { once: true });
	const chunks = [];
	let total = 0;
	try {
		signal.throwIfAborted();
		while (true) {
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			if (done) break;
			total += value.byteLength;
			if (total > maximum) throw new ImageRequestError("PackyCode image response exceeds the size limit");
			chunks.push(Buffer.from(value));
		}
		try {
			return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
		} catch {
			throw new ImageRequestError("PackyCode returned an unreadable image response");
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => void 0);
		reader.releaseLock();
	}
}
function pngDimensions(data) {
	const buffer = Buffer.from(data);
	if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== SIGNATURE || buffer.readUInt32BE(8) !== 13 || buffer.subarray(12, 16).toString("ascii") !== "IHDR") throw new ImageRequestError("PackyCode returned an invalid PNG image");
	const width = buffer.readUInt32BE(16);
	const height = buffer.readUInt32BE(20);
	if (width === 0 || height === 0 || Math.max(width, height) > 3840 || width * height > 8294400) throw new ImageRequestError("PackyCode returned unsupported image dimensions");
	return {
		width,
		height
	};
}
function decodeImagePng(encoded, maximum = MAX_IMAGE_BYTES) {
	if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > Math.ceil(maximum / 3) * 4 || encoded.length % 4 !== 0) throw new ImageRequestError("PackyCode returned invalid or oversized base64 image data");
	const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
	for (let index = 0; index < encoded.length - padding; index += 1) {
		const code = encoded.charCodeAt(index);
		if (!(code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || code === 43 || code === 47)) throw new ImageRequestError("PackyCode returned invalid base64 image data");
	}
	const data = Buffer.from(encoded, "base64");
	if (data.length > maximum || data.toString("base64") !== encoded) throw new ImageRequestError("PackyCode returned invalid base64 image data");
	pngDimensions(data);
	return data;
}
function imageFailure(status, value) {
	if (value?.error?.code === "moderation_blocked") return "PackyCode image request was blocked by the image safety check; revise the prompt or references";
	if (status === 401 || status === 403) return "PackyCode image key was rejected; check the separate image key and its model permissions";
	if (status === 429) return "PackyCode image quota or rate limit is unavailable; check the separate image key";
	return `PackyCode image request failed (HTTP ${status}); check model, quality, and image key permissions`;
}
/** One paid attempt only. Invalid references never turn an edit into a generation. */
function createPackyCodeImageClient({ resolveKey, getHost, fetchImpl = ambientFetch, timeoutMs = IMAGE_TIMEOUT_MS }) {
	return { async request(args, { signal, images, mask } = {}) {
		const options = validateImageOptions(args);
		const prompt = nonempty(args?.prompt);
		if (prompt === void 0 || prompt.length > 32e3) throw new ImageRequestError("PackyCode image prompt must contain 1-32000 characters");
		if (images !== void 0 && (!Array.isArray(images) || images.length === 0 || images.length > MAX_REFERENCE_IMAGES)) throw new ImageRequestError("PackyCode image edits require 1-16 reference images");
		if (mask !== void 0 && images === void 0) throw new ImageRequestError("PackyCode image mask requires a reference image");
		const timeout = AbortSignal.timeout(timeoutMs);
		const requestSignal = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
		let selected;
		try {
			selected = await waitForSharedRequest(Promise.resolve().then(resolveKey), requestSignal);
		} catch {
			if (signal?.aborted) throw new ImageRequestError("PackyCode image request was cancelled");
			if (timeout.aborted) throw new ImageRequestError("PackyCode image request timed out");
			throw new ImageRequestError("PackyCode image credentials could not be read");
		}
		if (typeof selected?.key !== "string" || selected.key === "") throw new ImageRequestError("PackyCode images need a separate image key; add one under Settings → PackyCode → Images");
		const fields = {
			...options,
			prompt,
			n: 1,
			output_format: "png"
		};
		let body;
		const headers = {
			authorization: `Bearer ${selected.key}`,
			accept: "application/json"
		};
		if (images === void 0) {
			headers["content-type"] = "application/json";
			body = JSON.stringify(fields);
		} else {
			body = new FormData();
			for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
			for (const [index, image] of images.entries()) {
				if (!EDIT_MEDIA_TYPES.includes(image?.mediaType) || !(image.data instanceof Uint8Array) || image.data.byteLength === 0 || image.data.byteLength >= 50 * 1024 * 1024) throw new ImageRequestError("PackyCode reference images must be PNG, JPEG or WebP smaller than 50 MB");
				const extension = image.mediaType === "image/jpeg" ? "jpg" : image.mediaType.split("/")[1];
				body.append("image[]", new Blob([image.data], { type: image.mediaType }), `reference-${index + 1}.${extension}`);
			}
			if (mask !== void 0) {
				if (mask.mediaType !== "image/png") throw new ImageRequestError("PackyCode maskImage must be a separate PNG mask, not an ordinary reference image; omit maskImage or set it to null for edits without a mask");
				if (!(mask.data instanceof Uint8Array) || mask.data.byteLength === 0 || mask.data.byteLength >= 4 * 1024 * 1024) throw new ImageRequestError("PackyCode image mask must be a PNG smaller than 4 MB");
				const dimensions = pngDimensions(mask.data);
				if (dimensions.width !== images[0].width || dimensions.height !== images[0].height) throw new ImageRequestError("PackyCode image mask must match the first reference image dimensions");
				body.append("mask", new Blob([mask.data], { type: "image/png" }), "mask.png");
			}
		}
		try {
			requestSignal.throwIfAborted();
			const response = await fetchImpl(`${normalizeHost(getHost(), DEFAULT_API_HOST).replace(/\/v1$/u, "")}/v1/images/${images === void 0 ? "generations" : "edits"}`, {
				method: "POST",
				redirect: "error",
				headers,
				body,
				signal: requestSignal
			});
			if (!response.ok) {
				const value = await readJson(response, 64 * 1024, requestSignal).catch(() => void 0);
				requestSignal.throwIfAborted();
				throw new ImageRequestError(imageFailure(response.status, value));
			}
			const value = await readJson(response, Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + ENVELOPE_BYTES, requestSignal);
			const data = decodeImagePng(value?.data?.[0]?.b64_json);
			return {
				data,
				...pngDimensions(data),
				requestedModel: options.model,
				requestedQuality: options.quality,
				requestedSize: options.size,
				...IMAGE_MODEL_IDS.includes(value?.model) ? { reportedModel: value.model } : {},
				...IMAGE_QUALITIES.includes(value?.quality) ? { quality: value.quality } : {}
			};
		} catch (error) {
			if (signal?.aborted) throw new ImageRequestError("PackyCode image request was cancelled");
			if (timeout.aborted) throw new ImageRequestError("PackyCode image request timed out");
			if (error instanceof ImageRequestError) throw error;
			throw new ImageRequestError("PackyCode image connection failed");
		}
	} };
}
const referenceSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		attachmentId: {
			type: "string",
			required: true,
			description: "Complete sha256:<64 lowercase hex> image reference from the current session or read_image. Never a path or filename."
		},
		mediaType: {
			type: "string",
			required: true
		},
		bytes: {
			type: "integer",
			required: true
		},
		width: {
			type: "integer",
			required: true
		},
		height: {
			type: "integer",
			required: true
		},
		name: { type: "string" },
		originalDimensions: {
			type: "object",
			additionalProperties: false,
			properties: {
				width: {
					type: "integer",
					required: true
				},
				height: {
					type: "integer",
					required: true
				}
			}
		}
	}
};
/** Select only trusted references already present in this tool call's session. */
async function readReferences(values, attachments, messages, signal) {
	if (!Array.isArray(values) || values.length === 0 || values.length > MAX_REFERENCE_IMAGES) throw new ImageRequestError("PackyCode image edits require 1-16 reference images");
	const available = /* @__PURE__ */ new Map();
	const visit = (content) => {
		for (const block of content ?? []) {
			if (block?.type === "image" && ATTACHMENT_ID$1.test(block.attachment?.attachmentId)) available.set(block.attachment.attachmentId, block.attachment);
			if (block?.type === "tool-result" && Array.isArray(block.content)) visit(block.content);
		}
	};
	for (const message of messages ?? []) if (Array.isArray(message?.content)) visit(message.content);
	const ids = values.map((value) => value?.attachmentId);
	if (ids.some((id) => typeof id !== "string" || !ATTACHMENT_ID$1.test(id) || !available.has(id))) throw new ImageRequestError("PackyCode image reference is missing from this session; use read_image and copy its complete attachment reference");
	if (new Set(ids).size !== ids.length) throw new ImageRequestError("PackyCode image references must not contain duplicates");
	const images = [];
	let total = 0;
	for (const id of ids) {
		signal?.throwIfAborted();
		let stored;
		try {
			stored = await attachments.readImage(available.get(id), signal);
		} catch {
			throw new ImageRequestError("PackyCode could not read the selected image attachment");
		}
		const { data, ref } = stored;
		if (!(data instanceof Uint8Array) || !EDIT_MEDIA_TYPES.includes(ref?.mediaType)) throw new ImageRequestError("PackyCode image reference must be PNG, JPEG or WebP");
		total += data.byteLength;
		if (total > attachments.imageLimits.maxMessageImageBytes) throw new ImageRequestError("PackyCode image references exceed the DSH image limit");
		images.push({
			data,
			mediaType: ref.mediaType,
			width: ref.width,
			height: ref.height
		});
	}
	return images;
}
function attachmentProjection(ref) {
	return Object.fromEntries([
		"attachmentId",
		"mediaType",
		"bytes",
		"width",
		"height",
		"name",
		"originalDimensions"
	].filter((key) => ref[key] !== void 0).map((key) => [key, ref[key]]));
}
const renderImage = (value) => [{
	type: "text",
	text: `PackyCode · ${value.requestedModel} · ${value.width} × ${value.height} · ${value.requestedQuality}\nOriginal PNG on the DSH host: ${value.localPath}`
}, {
	type: "image",
	attachment: value.image
}];
const imageResultSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		image: {
			...referenceSchema,
			required: true
		},
		localPath: {
			type: "string",
			required: true
		},
		width: {
			type: "integer",
			required: true
		},
		height: {
			type: "integer",
			required: true
		},
		requestedModel: {
			type: "string",
			required: true
		},
		requestedQuality: {
			type: "string",
			required: true
		},
		requestedSize: {
			type: "string",
			required: true
		},
		reportedModel: { type: "string" },
		quality: { type: "string" }
	}
};
function createPackyCodeImageTool({ client, attachments, getPreference, getSessionMessages, imageDirectory, onGenerated }) {
	return defineTool({
		name: IMAGE_TOOL_NAME,
		description: "Generate or edit images through PackyCode using the separately configured image API key. Use only when the user requests image output. This is independent of the conversation model and Codex subscription. For a new image omit referenceImages; for edits include only the intended images from this session or read_image. Never replace an edit with text-only generation, silently change models or downgrade quality. DSH displays successful image results automatically in the main chat; briefly describe the result. Do not create Markdown image links from localPath, attachmentId, sha256 references or invented URLs: these are not browser image addresses. Rendering may take several minutes.",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "Complete image description or precise editing instructions."
			},
			operation: {
				type: "string",
				enum: ["generate", "edit"],
				description: "Use generate for a new image; edit requires 1-16 real referenceImages. If omitted, nonempty references select editing, while an omitted or empty array selects generation."
			},
			model: {
				type: "string",
				enum: ["settings", ...IMAGE_MODEL_IDS],
				description: "Use settings (or omit) to follow the PackyCode image setting. Choose an explicit engine only when the user requests one."
			},
			quality: {
				type: "string",
				enum: ["settings", ...IMAGE_QUALITIES],
				description: "Use settings (or omit) to follow the user image setting. auto is an explicit API quality, not a request to follow settings. xhigh and max require a 2.5 model; never downgrade automatically."
			},
			size: {
				type: "string",
				description: "auto or widthxheight, e.g. 1024x1024; both edges multiples of 16, each <=3840, ratio <=3:1, pixels 655360..8294400."
			},
			background: {
				type: "string",
				enum: [
					"auto",
					"opaque",
					"transparent"
				]
			},
			referenceImages: {
				type: "array",
				items: referenceSchema,
				description: "1-16 complete attachment references for editing. Omit or use [] for a new image. Paths and unrelated images are not accepted; never drop real references after an edit fails."
			},
			maskImage: {
				oneOf: [{ type: "null" }, referenceSchema],
				description: "Omit or use null for new images and ordinary reference-image edits, including refining a sketch. Only supply an actual PNG mask provided for masking, matching the first reference and under 4 MB; alpha=0 marks the area to edit. Do not copy an ordinary reference into this field or invent a mask."
			}
		},
		output: {
			schema: imageResultSchema,
			render: (_args, value) => renderImage(value),
			presentationMeta: (_args, value) => ({
				kind: "packycode-image",
				requestedModel: value.requestedModel,
				requestedQuality: value.requestedQuality,
				width: value.width,
				height: value.height
			})
		},
		timeoutMs: IMAGE_TIMEOUT_MS,
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const preference = getPreference();
			if (!preference.imageEnabled) throw new ImageRequestError("PackyCode images are disabled in settings");
			if (exec?.agent?.id === void 0) throw new ImageRequestError("PackyCode images require a session-owned tool call");
			const signal = exec.signal;
			const hasReferences = Array.isArray(args.referenceImages) && args.referenceImages.length > 0;
			if (args.operation === "generate" && hasReferences) throw new ImageRequestError("PackyCode image generation cannot include reference images; use edit");
			const editing = args.operation === "edit" || hasReferences;
			const maskImage = emptyMaskReference(args.maskImage) ? void 0 : args.maskImage;
			if (maskImage !== void 0 && !editing) throw new ImageRequestError("PackyCode image mask requires referenceImages");
			let messages;
			try {
				messages = editing ? await getSessionMessages(exec.agent.id) : void 0;
			} catch {
				throw new ImageRequestError("PackyCode could not read the current session image references");
			}
			const images = editing ? await readReferences(args.referenceImages, attachments, messages, signal) : void 0;
			const repeatedIndex = maskImage === void 0 ? -1 : args.referenceImages.findIndex((ref) => ref.attachmentId === maskImage.attachmentId);
			const repeatedNonPng = repeatedIndex >= 0 && images[repeatedIndex].mediaType !== "image/png";
			const masks = maskImage === void 0 || repeatedNonPng ? void 0 : await readReferences([maskImage], attachments, messages, signal);
			if (!getPreference().imageEnabled) throw new ImageRequestError("PackyCode images are disabled in settings");
			const result = await client.request({
				...args,
				model: args.model === "settings" ? preference.imageModel : args.model ?? preference.imageModel,
				quality: args.quality === "settings" ? preference.imageQuality : args.quality ?? preference.imageQuality
			}, {
				signal,
				images,
				mask: masks?.[0]
			});
			onGenerated?.();
			signal?.throwIfAborted();
			await mkdir(imageDirectory, {
				recursive: true,
				mode: 448
			});
			const localPath = join(imageDirectory, `${randomUUID()}.png`);
			let saved = false;
			try {
				const file = await open(localPath, "wx", 384);
				saved = true;
				try {
					await file.writeFile(result.data);
				} finally {
					await file.close();
				}
				const ref = await attachments.saveImage({
					data: result.data,
					mediaType: "image/png",
					name: "packycode-generated.png"
				});
				const { data: _data, ...metadata } = result;
				const value = {
					...metadata,
					image: attachmentProjection(ref),
					localPath
				};
				if (exec.parent !== void 0) exec.deferContext(createUserMessage({
					content: renderImage(value),
					source: {
						kind: "plugin",
						plugin: "packycode-api"
					}
				}));
				return value;
			} catch {
				if (saved) await rm(localPath, { force: true }).catch(() => void 0);
				throw new ImageRequestError("PackyCode could not save the generated image");
			}
		}
	});
}
//#endregion
//#region src/image-originals.js
/** Session-authorized access to PNGs preserved before DSH normalizes previews. */
const ORIGINAL_CHUNK_BYTES = 256 * 1024;
const ATTACHMENT_ID = /^sha256:[0-9a-f]{64}$/u;
const FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/u;
const unavailable = () => /* @__PURE__ */ new Error("PackyCode original image is unavailable in this session");
/** Read paths only from successful, host-recorded image events, never RPC input. */
function originalFiles(events, attachmentId, directory) {
	const files = [];
	for (const event of events) {
		if (imageConversationNode.match(event) === null) continue;
		const content = event.type === "tool/ptc-dispatch" ? event.data.content : event.data.message.content;
		let candidate;
		for (const part of content) {
			if (part.type === "text" || part.type === "thinking") for (const match of String(part.text ?? "").matchAll(/(?:^|\n)(?:Original PNG on the DSH host: |原图：)([^\r\n]+)/gu)) {
				const path = match[1];
				candidate = dirname(path) === directory && FILE_NAME.test(basename(path)) ? basename(path) : void 0;
			}
			if (part.type === "image") {
				if (part.attachment?.attachmentId === attachmentId && candidate !== void 0) files.push(candidate);
				candidate = void 0;
			}
		}
	}
	return files;
}
function createImageOriginalReader({ imageDirectory, getSessionEvents }) {
	const directory = resolve(imageDirectory);
	async function withFile(payload, signal, read, chunk = false) {
		let file;
		try {
			signal?.throwIfAborted();
			const allowed = chunk ? [
				"sessionId",
				"attachmentId",
				"assetId",
				"offset"
			] : ["sessionId", "attachmentId"];
			if (!payload || typeof payload !== "object" || Object.keys(payload).some((key) => !allowed.includes(key)) || typeof payload.sessionId !== "string" || payload.sessionId.length === 0 || payload.sessionId.length > 200 || !ATTACHMENT_ID.test(payload.attachmentId) || chunk && (!FILE_NAME.test(payload.assetId) || !Number.isSafeInteger(payload.offset) || payload.offset < 0)) throw unavailable();
			const events = await getSessionEvents(payload.sessionId, signal);
			if (!Array.isArray(events)) throw unavailable();
			const candidates = originalFiles(events, payload.attachmentId, directory);
			const name = chunk ? candidates.find((value) => value === payload.assetId) : candidates.at(-1);
			if (name === void 0) throw unavailable();
			const path = join(directory, name);
			if ((await lstat(path)).isSymbolicLink()) throw unavailable();
			file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			const stat = await file.stat();
			if (!stat.isFile() || stat.size < 24 || stat.size > 50331648) throw unavailable();
			const header = Buffer.alloc(24);
			await file.read(header, 0, header.length, 0);
			const dimensions = pngDimensions(header);
			const result = await read(file, name, stat, dimensions);
			signal?.throwIfAborted();
			const after = await file.stat();
			if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw unavailable();
			return result;
		} catch {
			throw unavailable();
		} finally {
			await file?.close().catch(() => void 0);
		}
	}
	return {
		info(payload, signal) {
			return withFile(payload, signal, async (file, assetId, stat, dimensions) => {
				const hash = createHash("sha256");
				const buffer = Buffer.alloc(Math.min(ORIGINAL_CHUNK_BYTES, stat.size));
				let offset = 0;
				while (offset < stat.size) {
					signal?.throwIfAborted();
					const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
					if (bytesRead === 0) throw unavailable();
					hash.update(buffer.subarray(0, bytesRead));
					offset += bytesRead;
				}
				return {
					assetId,
					attachmentId: payload.attachmentId,
					name: `packycode-${assetId}`,
					mediaType: "image/png",
					bytes: stat.size,
					...dimensions,
					sha256: hash.digest("hex")
				};
			});
		},
		chunk(payload, signal) {
			return withFile(payload, signal, async (file, assetId, stat) => {
				if (payload.offset >= stat.size) throw unavailable();
				const buffer = Buffer.alloc(Math.min(ORIGINAL_CHUNK_BYTES, stat.size - payload.offset));
				const { bytesRead } = await file.read(buffer, 0, buffer.length, payload.offset);
				if (bytesRead === 0) throw unavailable();
				return {
					assetId,
					attachmentId: payload.attachmentId,
					offset: payload.offset,
					totalBytes: stat.size,
					encoded: buffer.subarray(0, bytesRead).toString("base64"),
					done: payload.offset + bytesRead === stat.size
				};
			}, true);
		}
	};
}
//#endregion
//#region src/key-chooser.js
/**
* Which stored key a request runs with, and what happens when the gateway
* rejects one.
*
* The ring's active key serves every request it can. A request for a model
* the active key's groups cannot reach — as the last group reading shows —
* runs on the next stored key that can; the active pointer itself does not
* move. A key the gateway reports as exhausted or invalid is marked unusable
* and the ring moves on, so the retry of the failed step resolves the next
* key. Only keys stored in this plugin's ring are ever chosen.
*
* @module dsh-packycode-api/key-chooser
*/
/** How long a request with a choice of keys waits for the first group reading. */
const DEFAULT_GROUP_WAIT_MS = 6e3;
/**
* @param options - the key ring, the group reader, what to do after a key
*   moved aside, a logger, and how long to wait for the first group reading.
* @returns the chooser.
*/
function createKeyChooser({ ring, groups, onRotated, logger, waitMs = DEFAULT_GROUP_WAIT_MS }) {
	/**
	* Key material to ring id. A failure is reported from inside a stream, which
	* carries the request's key but not its id; this index is refreshed on every
	* resolution so the right key is the one that moves aside.
	*/
	const idByKey = /* @__PURE__ */ new Map();
	/** The ring as of the last resolution, for the synchronous per-request choice. */
	let snapshot = [];
	const remember = async () => {
		const entries = await ring.secrets();
		snapshot = entries;
		for (const entry of entries) idByKey.set(entry.key, entry.id);
	};
	const usable = () => snapshot.filter((entry) => entry.disabled !== true);
	const covers = (keyId, modelId) => groups.covers(keyId, modelId);
	/**
	* Keep the group reading fresh for the choice. It only matters with two
	* usable keys or more; the first reading is awaited for at most `waitMs`,
	* later ones refresh in the background.
	*/
	const warm = async () => {
		if (usable().length < 2) return;
		const pending = groups.read().catch(() => void 0);
		if (groups.hasReading()) return;
		let timer;
		await Promise.race([pending, new Promise((resolve) => {
			timer = setTimeout(resolve, waitMs);
		})]);
		clearTimeout(timer);
	};
	/** The active key, after refreshing the ring and, when it matters, the groups. */
	const active = async () => {
		await remember();
		const key = await ring.activeKey();
		if (key !== void 0) await warm();
		return key;
	};
	return Object.freeze({
		remember,
		covers,
		active,
		/**
		* The key one HTTP request for `modelId` runs with, given the active key
		* pi-ai resolved. Synchronous because pi-ai opens its stream synchronously;
		* it reads the ring and groups as of the last {@link active}.
		* @returns the key material to send.
		*/
		forRequest(modelId, apiKey) {
			const current = snapshot.find((entry) => entry.key === apiKey);
			if (current === void 0) return apiKey;
			const chosen = pickKeyForModel(modelId, current, usable(), covers);
			if (chosen?.switchedFrom !== void 0) logger?.info?.("packycode-api: key %s cannot reach %s by its last group reading; this request uses key %s", current.id, modelId, chosen.id);
			return chosen?.key ?? apiKey;
		},
		/**
		* The gateway exhausted or rejected a key: mark it unusable so the ring
		* moves on, then let the caller drop what depended on it.
		* @param kind - `quota` or `invalid-key`.
		* @param _message - the failure text (unused; the kind decides).
		* @param key - the key material the failed request carried.
		* @param knownId - the key's ring id, when the caller has it.
		*/
		onKeyFailure(kind, _message, key, knownId) {
			const id = knownId ?? (key === void 0 ? void 0 : idByKey.get(key));
			if (id === void 0) {
				logger?.warn?.("packycode-api: %s reported for an unidentified key; not rotating", kind);
				return;
			}
			logger?.warn?.("packycode-api: %s on key %s; the next key serves the retry", kind, id);
			ring.disable(id, kind).then(() => onRotated?.()).catch((error) => logger?.warn?.("packycode-api: could not move past key %s: %s", id, error.message));
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
const text$1 = (value) => typeof value === "string" ? value : "";
/** Validate a pasted key before it is stored; the gateway never sees a bad one from us. */
function assertApiKey(value) {
	const key = text$1(value).trim();
	if (key.length < 8 || key.length > 512 || !LEGAL_KEY.test(key)) throw new Error("PackyCode API key must be 8-512 printable ASCII characters without spaces");
	return key;
}
function entry(value) {
	if (value === null || typeof value !== "object") return void 0;
	const key = text$1(value.key);
	if (key === "" || !LEGAL_KEY.test(key)) return void 0;
	const id = text$1(value.id);
	return {
		id: id === "" ? randomUUID().slice(0, 8) : id,
		label: text$1(value.label),
		key,
		addedAt: Number.isFinite(value.addedAt) ? value.addedAt : 0,
		...Number.isFinite(value.disabledAt) ? { disabledAt: value.disabledAt } : {},
		...text$1(value.disabledReason) === "" ? {} : { disabledReason: text$1(value.disabledReason) }
	};
}
/** Tolerate a hand-edited or older record instead of failing the whole route. */
function normalizeState(record) {
	const payload = record !== null && typeof record === "object" && record.kind === "grant" && record.payload !== null && typeof record.payload === "object" ? record.payload : void 0;
	const keys = (Array.isArray(payload?.keys) ? payload.keys : []).map(entry).filter((candidate) => candidate !== void 0);
	const activeId = text$1(payload?.activeId);
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
	#recordKey;
	constructor(credentials, { recordId = KEY_RECORD_ID } = {}) {
		if (typeof credentialKey !== "function") throw new Error("dsh-packycode-api requires @deepseek-ai/dsh-credentials with credentialKey()");
		if (credentials === null || typeof credentials !== "object" || typeof credentials.readRecord !== "function" || typeof credentials.modifyRecord !== "function") throw new Error("dsh-packycode-api requires the DSH credential record API");
		this.#credentials = credentials;
		this.#recordKey = credentialKey(PLUGIN_ID, recordId);
	}
	async #read() {
		return normalizeState(await this.#credentials.readRecord(this.#recordKey));
	}
	/**
	* Replace the record with what `mutate` decides. The store accepts plain
	* JSON only and refuses a payload holding `undefined`, so a field without a
	* value is left out: an emptied ring has no `activeId`, and a disabled mark
	* from a hand-edited record may have no reason. A store failure is reported
	* in the ring's own words, since the store's may quote the credential file.
	*/
	async #write(mutate) {
		let refused = false;
		let next;
		try {
			next = await this.#credentials.modifyRecord(this.#recordKey, async (current) => {
				const state = normalizeState(current);
				let updated;
				try {
					updated = await mutate(state);
				} catch (error) {
					refused = true;
					throw error;
				}
				if (updated === void 0) return current;
				return {
					kind: "grant",
					payload: {
						version: RECORD_VERSION,
						...updated.activeId === void 0 ? {} : { activeId: updated.activeId },
						keys: updated.keys.map((candidate) => ({
							id: candidate.id,
							label: candidate.label,
							key: candidate.key,
							addedAt: candidate.addedAt,
							...candidate.disabledAt === void 0 ? {} : { disabledAt: candidate.disabledAt },
							...candidate.disabledAt === void 0 || candidate.disabledReason === void 0 ? {} : { disabledReason: candidate.disabledReason }
						}))
					}
				};
			});
		} catch (error) {
			if (refused) throw error;
			throw new Error("PackyCode could not save the key change in DSH's credential store", { cause: error });
		}
		return normalizeState(next);
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
		const name = text$1(label).trim().slice(0, 60);
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
	async rename(id, label) {
		const name = text$1(label).trim().slice(0, 60);
		if (name === "") throw new Error("That PackyCode key name cannot be empty");
		return projection(await this.#write((state) => {
			if (!state.keys.some((candidate) => candidate.id === id)) throw new Error("Unknown PackyCode key");
			return {
				activeId: state.activeId,
				keys: state.keys.map((candidate) => candidate.id === id ? {
					...candidate,
					label: name
				} : candidate)
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
				disabledReason: text$1(reason) === "" ? "unusable" : text$1(reason)
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
//#region src/model-selection.js
/** Profile preferences for the models advertised in PackyCode's picker. */
/** Store exclusions so new catalog models are selected by default as well. */
function readHiddenModels(preference) {
	const value = fieldValue(preference?.hiddenModels);
	if (!Array.isArray(value)) return [];
	const hidden = new Set(value);
	return PACKYCODE_MODEL_IDS.filter((id) => hidden.has(id));
}
function createModelSelectionController({ readPreference, writePreference, isWritable, onChange }) {
	const hidden = () => readHiddenModels(readPreference());
	let advertised = hidden().join(",");
	const reconcile = () => {
		const next = hidden().join(",");
		if (next === advertised) return;
		onChange?.();
		advertised = next;
	};
	const status = () => {
		const excluded = new Set(hidden());
		return {
			writable: isWritable() === true,
			models: PACKYCODE_MODELS.map(({ id, name }) => ({
				id,
				name,
				selected: !excluded.has(id)
			}))
		};
	};
	return Object.freeze({
		status,
		reconcile,
		isVisible: (id) => !hidden().includes(id),
		async update({ selectedIds } = {}) {
			if (!Array.isArray(selectedIds) || selectedIds.some((id) => !PACKYCODE_MODEL_IDS.includes(id))) throw new Error("That PackyCode model selection is not supported");
			if (isWritable() !== true) throw new Error("PackyCode settings are not writable in this profile");
			const selected = new Set(selectedIds);
			try {
				await writePreference({ hiddenModels: PACKYCODE_MODEL_IDS.filter((id) => !selected.has(id)) });
			} catch {
				throw new Error("PackyCode could not save the model selection");
			}
			reconcile();
			return status();
		}
	});
}
//#endregion
//#region src/plugin-version.js
/**
* Version self-knowledge for the settings panel.
*
* The running version comes from this package. The latest version comes from
* the npm registry. An in-place update is only offered for a registry install,
* and it installs that exact version with the host's own pnpm — never through
* `dsh plugin --profile desktop`, which the desktop app refuses. Registry
* bodies and package-manager output stay host-side.
*
* @module dsh-packycode-api/plugin-version
*/
const PACKAGE_NAME = "dsh-packycode-api";
const NPM_REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const DEFAULT_VERSION_TTL_MS = 5 * 6e4;
const DEFAULT_VERSION_TIMEOUT_MS = 1e4;
const DEFAULT_UPDATE_TIMEOUT_MS = 18e4;
/** Parse a strict `x.y.z[-pre][+build]` version; anything else is undefined. */
function parseSemver(value) {
	if (typeof value !== "string") return void 0;
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value.trim());
	if (match === null) return void 0;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		pre: match[4]
	};
}
/** Compare two versions: -1/0/1, or undefined when either side is not semver. */
function compareSemver(a, b) {
	const left = parseSemver(a);
	const right = parseSemver(b);
	if (left === void 0 || right === void 0) return void 0;
	for (const key of [
		"major",
		"minor",
		"patch"
	]) if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
	if (left.pre === right.pre) return 0;
	if (left.pre === void 0) return 1;
	if (right.pre === void 0) return -1;
	return left.pre < right.pre ? -1 : 1;
}
/**
* Classify how the running package reached the profile. Only registry specs
* may be updated in place; local checkouts belong to the owner's iteration.
*/
function classifySpec(spec) {
	if (typeof spec !== "string" || spec === "") return "unknown";
	if (/^(?:link|file):/u.test(spec)) return "link";
	if (/^(?:\d|[~^*])/u.test(spec)) return "npm";
	return "unknown";
}
const readManifest = async (path) => {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		return parsed !== null && typeof parsed === "object" ? parsed : void 0;
	} catch {
		return;
	}
};
/**
* A zero exit only proves the command ran. pnpm can skip a too-new version
* and still exit zero, so the landed manifest is what makes the answer true.
*/
async function confirmInstalled({ profileDir, expected, settleDelayMs, attempts = 3 }) {
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		if ((await readManifest(join(profileDir, "node_modules", "dsh-packycode-api", "package.json")))?.version === expected) return;
		if (attempt < attempts) await new Promise((resolve) => {
			setTimeout(resolve, settleDelayMs);
		});
	}
	throw new Error("PackyCode plugin update did not install the requested version");
}
/**
* Find the profile that owns this running installation. pnpm symlinks resolve
* to the same realpath on both sides. When no realpath matches, fall back to
* the only profile that declares the dependency at all.
*/
async function findInstall({ dshHome, ownPackageJsonUrl }) {
	let ownReal;
	try {
		ownReal = await realpath(fileURLToPath(ownPackageJsonUrl));
	} catch {
		ownReal = void 0;
	}
	let entries = [];
	try {
		entries = await readdir(join(dshHome, "profiles"), { withFileTypes: true });
	} catch {
		entries = [];
	}
	const declared = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const profileDir = join(dshHome, "profiles", entry.name);
		const spec = (await readManifest(join(profileDir, "package.json")))?.dependencies?.[PACKAGE_NAME];
		if (typeof spec !== "string") continue;
		declared.push({
			profile: entry.name,
			spec
		});
		if (ownReal === void 0) continue;
		try {
			if (await realpath(join(profileDir, "node_modules", "dsh-packycode-api", "package.json")) === ownReal) return {
				kind: classifySpec(spec),
				profile: entry.name
			};
		} catch {}
	}
	if (declared.length === 1) return {
		kind: classifySpec(declared[0].spec),
		profile: declared[0].profile
	};
	return { kind: "unknown" };
}
const isExistingPath = (value) => typeof value === "string" && value !== "" && existsSync(value);
/** Anchored to the file name so a directory that merely contains the word cannot match. */
const PNPM_SCRIPT = /[\\/]pnpm\.(?:mjs|cjs|js)$/u;
const dshRuntimeRoot = (value) => isExistingPath(value) && existsSync(join(value, "node_modules", "@deepseek-ai", "dsh", "package.json")) ? value : void 0;
/**
* Locate the package manager that owns this profile.
*
* `dsh plugin --profile desktop` is refused by the desktop app, so the update
* installs with pnpm directly. The desktop host puts the bundled pnpm in its
* own arguments; nothing is guessed from the entry script.
*/
function resolvePnpm({ argv } = {}) {
	const entries = Array.isArray(argv) ? argv : [];
	for (const entry of entries) if (isExistingPath(entry) && PNPM_SCRIPT.test(entry)) return entry;
	for (const entry of entries) {
		const root = dshRuntimeRoot(entry);
		if (root === void 0) continue;
		const script = join(root, "..", "pnpm", "bin", "pnpm.mjs");
		if (existsSync(script)) return script;
	}
}
function resolveLauncher({ argv, execPath }) {
	const pnpm = resolvePnpm({ argv });
	if (pnpm === void 0) return {
		command: "pnpm",
		prefix: []
	};
	return {
		command: execPath,
		prefix: [pnpm]
	};
}
/** Run pnpm host-side. Its output is never returned to the browser. */
function spawnRunCommand({ command, args, cwd }, { signal, timeoutMs }) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("PackyCode plugin update aborted"));
			return;
		}
		const controller = new AbortController();
		const onAbort = () => controller.abort(signal.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("PackyCode plugin update timed out")), timeoutMs);
		let settled = false;
		const settle = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			callback(value);
		};
		let child;
		try {
			child = spawn(command, args, {
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				],
				signal: controller.signal,
				...cwd === void 0 ? {} : { cwd }
			});
		} catch (error) {
			settle(reject, error);
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout = (stdout + chunk).slice(-8192);
		});
		child.stderr?.on("data", (chunk) => {
			stderr = (stderr + chunk).slice(-8192);
		});
		child.on("error", (error) => settle(reject, error));
		child.on("close", (code) => {
			if (controller.signal.aborted) {
				const reason = controller.signal.reason;
				settle(reject, reason instanceof Error ? reason : /* @__PURE__ */ new Error("PackyCode plugin update aborted"));
				return;
			}
			settle(resolve, {
				code: code ?? 1,
				stdout,
				stderr
			});
		});
	});
}
/**
* The running version, the latest registry version, which profile installed
* this copy, and registry-spec updates against that profile.
*/
function createPackyCodePluginManager({ fetchImpl = ambientFetch, runCommand = spawnRunCommand, execPath = process.execPath, argv = process.argv, env = process.env, ownPackageJsonUrl = new URL("../package.json", import.meta.url), registryUrl = NPM_REGISTRY_LATEST_URL, now = Date.now, ttlMs = DEFAULT_VERSION_TTL_MS, timeoutMs = DEFAULT_VERSION_TIMEOUT_MS, updateTimeoutMs = DEFAULT_UPDATE_TIMEOUT_MS, settleDelayMs = 250 } = {}) {
	if (typeof fetchImpl !== "function") throw new Error("PackyCode plugin manager requires fetch");
	if (typeof runCommand !== "function") throw new Error("PackyCode plugin manager requires runCommand");
	const dshHome = typeof env.DSH_HOME === "string" && env.DSH_HOME !== "" ? env.DSH_HOME : join(homedir(), ".dsh");
	const launcher = resolveLauncher({
		argv,
		execPath
	});
	let updating = false;
	const fetchLatest = async (signal) => {
		let response;
		try {
			response = await boundedFetch(registryUrl, { headers: { Accept: "application/json" } }, {
				fetchImpl,
				timeoutMs,
				signal
			});
		} catch (error) {
			if (error.aborted) throw error.cause;
			throw new Error("PackyCode plugin version check failed");
		}
		if (!response.ok) throw new Error("PackyCode plugin version check failed");
		let version;
		try {
			version = (await response.json())?.version;
		} catch {
			version = void 0;
		}
		if (parseSemver(version) === void 0) throw new Error("PackyCode plugin version check failed");
		return version;
	};
	const readOwnVersion = async () => {
		const version = (await readManifest(fileURLToPath(ownPackageJsonUrl)))?.version;
		if (parseSemver(version) === void 0) throw new Error("PackyCode plugin version is unavailable");
		return version;
	};
	const load = async (signal) => {
		signal?.throwIfAborted();
		const [current, install, latest] = await Promise.all([
			readOwnVersion(),
			findInstall({
				dshHome,
				ownPackageJsonUrl
			}),
			fetchLatest(signal)
		]);
		return {
			current,
			latest,
			updateAvailable: compareSemver(latest, current) === 1,
			install,
			fetchedAt: now()
		};
	};
	const cache = createCachedRead(load, {
		ttlMs,
		now
	});
	return Object.freeze({
		read: (options) => cache.read(options),
		async update({ signal } = {}) {
			signal?.throwIfAborted();
			if (updating) throw new Error("PackyCode plugin update is already running");
			updating = true;
			try {
				const install = await findInstall({
					dshHome,
					ownPackageJsonUrl
				});
				if (install.kind === "link") throw new Error("PackyCode plugin is installed from a local checkout");
				if (install.kind !== "npm" || install.profile === void 0) throw new Error("PackyCode plugin update could not find the owning profile");
				const latest = await fetchLatest(signal);
				const profileDir = join(dshHome, "profiles", install.profile);
				let result;
				try {
					result = await runCommand({
						command: launcher.command,
						args: [
							...launcher.prefix,
							"add",
							"--save-exact",
							`--config.minimumReleaseAge=0`,
							`${PACKAGE_NAME}@${latest}`
						],
						cwd: profileDir
					}, {
						signal,
						timeoutMs: updateTimeoutMs
					});
				} catch (error) {
					if (signal?.aborted) throw error;
					throw new Error("PackyCode plugin update failed");
				}
				if (result.code !== 0) throw new Error("PackyCode plugin update failed");
				await confirmInstalled({
					profileDir,
					expected: latest,
					settleDelayMs
				});
				cache.invalidate();
				return {
					version: latest,
					profile: install.profile
				};
			} finally {
				updating = false;
			}
		},
		invalidate: () => cache.invalidate()
	});
}
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
* an invalid-API-key problem — the opposite of what happened. This wording
* also covers intermittent client-anomaly refusals; it does not establish
* whether a future request will be accepted.
*/
const CLIENT_POLICY_WORDING = /only accessible via the official|only accepts requests from the official|official\s+claude(?:\s+code)?\s+cli|官方\s*claude(?:\s*code)?\s*cli|请使用标准\s*codex\s*客户端|客户端存在异常|二次分发|API\s*转接/iu;
/** A content-policy refusal observed on an already-authorized request. */
const TEST_MESSAGE_POLICY_CODE = "GATEWAY_TEST_MESSAGE";
const TEST_MESSAGE_PREFIX = `[${TEST_MESSAGE_POLICY_CODE}]`;
/** Match the captured refusal narrowly; a bare 403 is still not evidence. */
function classifyTestMessagePolicy(message) {
	if (typeof message !== "string") return false;
	return message.startsWith(TEST_MESSAGE_PREFIX) || /already connected and authorized/iu.test(message) && /no need to send test messages/iu.test(message) && /verify the connection/iu.test(message);
}
/** Keep the host's status-word classifier from turning this into AUTH. */
function explainTestMessagePolicyFailure() {
	return `${TEST_MESSAGE_PREFIX} PackyCode 将这次请求识别为连通性测试并拒绝。请使用实际业务内容；本次拒绝不表示 Key 失效，也不会禁用或切换 Key。`;
}
/**
* The gateway's answer when a key's groups do not include the model's
* supplier: `model_not_found` / 当前令牌未覆盖供应商. The key is fine for other
* models, so it is never moved aside for this.
*/
const COVERAGE_WORDING = /model_not_found|未覆盖供应商|无可用渠道|no available channel/iu;
/**
* Whether the gateway refused the model for this key's groups.
* @param message - the failure text.
* @returns true for a group-coverage refusal.
*/
function classifyCoverage(message) {
	return COVERAGE_WORDING.test(typeof message === "string" ? message : "");
}
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
* OpenAI's generic transient failure: the sentence its `server_error` carries,
* or the `server_error:` prefix pi-ai writes when the event names the code.
* The gateway can relay it inside a stream it has already answered 200 for —
* an SSE `error` event with a 503 `server_error`, then `response.failed` — so
* no HTTP status comes with it.
*/
const UPSTREAM_SERVER_ERROR = /an error occurred while processing your request\b[\s\S]*\bhelp\.openai\.com\b|^(?:error code\s+)?server_error:/iu;
/**
* Whether a failure is the upstream's transient server error, which a resent
* request clears. The key is not at fault.
* @param message - provider failure text, as pi-ai carries it.
* @returns true for OpenAI's generic `server_error`.
*/
function classifyUpstreamServerError(message) {
	return UPSTREAM_SERVER_ERROR.test(typeof message === "string" ? message : "");
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
	if (classifyClientPolicy(text) || classifyTestMessagePolicy(text)) return void 0;
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
* keeps the failure out of the host's generic retry policy and lets the
* sentence reach the user verbatim, in
* place of the "API key is invalid" the bare 403 would have produced.
* @param keyName - the account name the balance reader saw, when known.
* @returns the replacement sentence.
*/
function explainClientPolicyFailure() {
	return "PackyCode 拒绝了这个客户端：所选分组只允许厂商官方客户端调用（Claude 分组要求官方 Claude CLI，Codex 分组要求标准 Codex 客户端）。这不是 API Key 失效。请检查当前分组的客户端要求；若调整分组，应先在模型广场确认该模型可用。 / This group only serves the vendor’s official client; the API key is fine.";
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
//#region src/gemini-replay.js
/** A bounded resend for the gateway's intermittent Flash signature refusal. */
const waitForRetry = (ms, signal) => setTimeout$1(ms, void 0, { signal });
/** Only a current-turn result for a signed same-model native call qualifies. */
function hasSignedResult(model, context) {
	if (model?.id !== "gemini-3.8-flash" || model.api !== "google-generative-ai") return false;
	const messages = context?.messages ?? [];
	const calls = /* @__PURE__ */ new Set();
	for (const message of messages.slice(messages.findLastIndex((item) => item.role === "user") + 1)) {
		if (message.role === "assistant" && message.provider === model.provider && message.model === model.id && message.api === model.api) for (const block of Array.isArray(message.content) ? message.content : []) {
			const signature = block.thoughtSignature;
			if (block.type === "toolCall" && typeof block.id === "string" && typeof signature === "string" && signature.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(signature)) calls.add(block.id);
		}
		if (message.role === "toolResult" && calls.has(message.toolCallId)) return true;
	}
	return false;
}
function isSignatureRefusal(event) {
	if (event.type !== "error" || event.reason !== "error" || event.error.content?.length) return false;
	const text = event.error.errorMessage ?? "";
	return /\b400\b/u.test(text) && /\b(?:Corrupted|Invalid) thought signature\b/iu.test(text) && !/\b(?:401|403|408|409|429|5\d\d)\b/u.test(text) && classifyGatewayFailure(text) === void 0;
}
/**
* The caller closes over one resolved model/context/key/session. Reopening it
* resends that request once; it never chooses a different key or changes the
* signature. SDK retries remain disabled by the host. Its ordinary retry
* policy still receives any terminal failure after this one compatibility
* resend. Never replay after even a start event has reached the consumer.
*/
function guardGeminiReplay(open, { model, context, signal, wait = waitForRetry } = {}) {
	const initial = open();
	if (!hasSignedResult(model, context) || signal?.aborted) return initial;
	let finalMessage;
	return lazyStream(model, async () => ({
		async *[Symbol.asyncIterator]() {
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const source = attempt === 0 ? initial : open();
				let observed = false;
				let refused;
				for await (const event of source) if (attempt === 0 && !observed && isSignatureRefusal(event)) refused = event;
				else {
					observed = true;
					yield event;
				}
				finalMessage = await source.result();
				if (refused === void 0) return;
				try {
					await wait(1e3, signal);
					signal?.throwIfAborted();
				} catch (error) {
					if (!signal?.aborted) throw error;
					finalMessage = {
						...refused.error,
						stopReason: "aborted",
						errorMessage: "Request aborted"
					};
					yield {
						type: "error",
						reason: "aborted",
						error: finalMessage
					};
					return;
				}
			}
		},
		result: async () => finalMessage
	}));
}
//#endregion
//#region src/claude-replay.js
/** Bounded replay for the gateway's captured, inconsistent tool-request checks. */
const MAX_ERROR_BYTES = 16 * 1024;
const ANOMALY = /我们检测到您的客户端存在异常|We have detected an anomaly in your client/iu;
const STANDARD_CLIENT = /标准\s*Claude\s*Code\s*客户端|standard\s+Claude\s+Code\s+client/iu;
/** Inspect a small clone; the SDK still owns an unrecognised error response. */
async function isReplayableRefusal(response, { allowTestMessage }) {
	if (response.status !== 403) return false;
	if (Number(response.headers.get("content-length")) > MAX_ERROR_BYTES) return false;
	let reader;
	try {
		reader = response.clone().body?.getReader();
		if (reader === void 0) return false;
		const chunks = [];
		let bytes = 0;
		for (;;) {
			const item = await reader.read();
			if (item.done) break;
			bytes += item.value.byteLength;
			if (bytes > MAX_ERROR_BYTES) {
				reader.cancel().catch(() => {});
				return false;
			}
			chunks.push(item.value);
		}
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return value?.error?.type === "packy_api_error" && ANOMALY.test(value.error.message) && STANDARD_CLIENT.test(value.error.message) || allowTestMessage && value?.error?.type === "packy_<nil>" && classifyTestMessagePolicy(value.error.message);
	} catch {
		return false;
	} finally {
		reader?.releaseLock();
	}
}
function hasToolContext(context) {
	return (context.tools?.length ?? 0) > 0 || context.messages?.some((message) => message.role === "toolResult" || Array.isArray(message.content) && message.content.some((block) => block.type === "toolCall"));
}
/**
* Fixed Haiku and Sonnet tool payloads were observed returning both 200 and
* the client-anomaly 403. The already-authorized/test-message replay remains
* limited to Haiku, where that exact pattern was captured too. Retry only
* these refusals, before any model event exists.
* One replay retains the body, headers, key and session; normal policy
* refusals, Opus, capacity errors and accepted streams pass through.
*/
function createClaudeReplayFetch(fetchImpl, { model, context, delayMs = 1e3 } = {}) {
	const allowTestMessage = model?.id === "claude-haiku-5-5";
	const enabled = (allowTestMessage || model?.id === "claude-sonnet-5-5") && hasToolContext(context ?? {});
	return async (input, init) => {
		if (!enabled || init?.body !== void 0 && typeof init.body !== "string") return fetchImpl(input, init);
		const retryInput = input instanceof Request ? input.clone() : input;
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : void 0));
		const firstInit = {
			...init,
			headers: new Headers(headers)
		};
		const retryInit = {
			...init,
			headers: new Headers(headers)
		};
		let replayed = false;
		let response;
		let discarded = false;
		try {
			response = await fetchImpl(input, firstInit);
			if (!await isReplayableRefusal(response, { allowTestMessage })) return response;
			discarded = true;
			const signal = init?.signal ?? (input instanceof Request ? input.signal : void 0);
			signal?.throwIfAborted();
			await setTimeout$1(delayMs, void 0, { signal });
			await response.body?.cancel();
			replayed = true;
			return await fetchImpl(retryInput, retryInit);
		} finally {
			if (!replayed && retryInput instanceof Request && retryInput !== input) retryInput.body?.cancel().catch(() => {});
			if (discarded) response?.body?.cancel().catch(() => {});
		}
	};
}
//#endregion
//#region src/claude-stream.js
/** Observe terminal Anthropic SSE frames without rewriting any response bytes. */
function createClaudeTerminalDetector() {
	const decoder = new TextDecoder();
	let line = "", event = "", data = "", overflow = false, dataOverflow = false, skipLf = false;
	const consume = () => {
		if (overflow) {
			overflow = false;
			dataOverflow = true;
			line = "";
			return;
		}
		const value = line;
		line = "";
		if (value === "") {
			let terminal;
			if (event === "error") terminal = "error";
			else if (event === "message_stop" && !dataOverflow) try {
				if (JSON.parse(data).type === "message_stop") terminal = "message_stop";
			} catch {}
			event = "";
			data = "";
			dataOverflow = false;
			return terminal;
		}
		if (value.startsWith(":")) return;
		const colon = value.indexOf(":");
		const field = colon < 0 ? value : value.slice(0, colon);
		const content = colon < 0 ? "" : value.slice(colon + 1).replace(/^ /u, "");
		if (field === "event") event = content;
		else if (field === "data" && !dataOverflow) if (data.length + content.length > 4096) {
			data = "";
			dataOverflow = true;
		} else data += `${data ? "\n" : ""}${content}`;
	};
	return (chunk) => {
		for (const character of decoder.decode(chunk, { stream: true })) {
			if (character === "\n" && skipLf) {
				skipLf = false;
				continue;
			}
			skipLf = character === "\r";
			if (character === "\n" || character === "\r") {
				const terminal = consume();
				if (terminal) return terminal;
			} else if (!overflow) if (line.length >= 65536) {
				line = "";
				overflow = true;
			} else line += character;
		}
	};
}
/**
* message_stop completes the Messages protocol; transport EOF may arrive late.
* Forward the terminal frame, then close and cancel the upstream reader. Error
* frames remain visible to the provider. This never retries an accepted stream.
*/
function finishClaudeStream(response, signal) {
	if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) return response;
	const reader = response.body.getReader();
	const terminal = createClaudeTerminalDetector();
	let finished = false, abort, pendingCr = false;
	const dispose = (cancel, reason) => {
		signal?.removeEventListener("abort", abort);
		const release = () => {
			try {
				reader.releaseLock();
			} catch {}
		};
		if (cancel) reader.cancel(reason).catch(() => {}).finally(release);
		else release();
	};
	const body = new ReadableStream({
		start(controller) {
			abort = () => {
				if (finished) return;
				finished = true;
				controller.error(signal.reason ?? new DOMException("Request aborted", "AbortError"));
				dispose(true, signal.reason);
			};
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
		},
		async pull(controller) {
			if (finished) return;
			try {
				for (;;) {
					const item = await reader.read();
					if (finished) return;
					if (item.done) {
						if (pendingCr) controller.enqueue(Uint8Array.of(13));
						finished = true;
						controller.close();
						dispose(false);
						return;
					}
					const end = terminal(item.value);
					let chunk = item.value;
					if (pendingCr) {
						const joined = new Uint8Array(chunk.length + 1);
						joined[0] = 13;
						joined.set(chunk, 1);
						chunk = joined;
					}
					pendingCr = !end && chunk.at(-1) === 13;
					if (pendingCr) chunk = chunk.subarray(0, -1);
					if (chunk.length) controller.enqueue(chunk);
					if (end) {
						finished = true;
						controller.close();
						dispose(true);
					}
					if (chunk.length || finished) return;
				}
			} catch (error) {
				if (!finished) {
					finished = true;
					controller.error(error);
					dispose(true, error);
				}
			}
		},
		cancel(reason) {
			finished = true;
			dispose(true, reason);
		}
	});
	const wrapped = new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});
	Object.defineProperty(wrapped, "url", { value: response.url });
	return wrapped;
}
//#endregion
//#region src/claude-tools.js
const BUILTIN_NAMES = Object.freeze({
	bash: "Bash",
	read: "Read",
	write: "Write",
	edit: "Edit",
	glob: "Glob",
	grep: "Grep"
});
/** CLI-compatible wire names, restored to their originals before host dispatch. */
function createClaudeToolNames() {
	const owners = /* @__PURE__ */ new Map(), offered = /* @__PURE__ */ new Map(), clientNames = /* @__PURE__ */ new Set();
	let declaredNames = /* @__PURE__ */ new Set();
	const encode = (name, available = false) => {
		if (typeof name !== "string") return name;
		const slug = name.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 40) || "tool";
		const digest = createHash("sha256").update(name).digest("hex").slice(0, 12);
		const builtin = Object.hasOwn(BUILTIN_NAMES, name) ? BUILTIN_NAMES[name] : void 0;
		const alias = builtin && !declaredNames.has(builtin) ? builtin : `mcp__dsh__${slug}_${digest}`;
		if (owners.has(alias) && owners.get(alias) !== name) throw new Error("Ambiguous Claude tool name");
		owners.set(alias, name);
		if (available) {
			offered.set(alias, name);
			clientNames.add(name);
		}
		return alias;
	};
	const encodeBlock = (block) => {
		if (block?.type === "tool_use") return {
			...block,
			name: encode(block.name)
		};
		if (block?.type === "tool_reference") return {
			...block,
			tool_name: encode(block.tool_name)
		};
		if (block?.type === "tool_result" && Array.isArray(block.content)) return {
			...block,
			content: block.content.map(encodeBlock)
		};
		return block;
	};
	const decodeBlock = (block) => block?.type === "toolCall" && offered.has(block.name) ? {
		...block,
		name: offered.get(block.name)
	} : block;
	const decodeMessage = (message) => Array.isArray(message?.content) ? {
		...message,
		content: message.content.map(decodeBlock)
	} : message;
	const decodeEvent = (event) => ({
		...event,
		...event.partial ? { partial: decodeMessage(event.partial) } : {},
		...event.message ? { message: decodeMessage(event.message) } : {},
		...event.error ? { error: decodeMessage(event.error) } : {},
		...event.toolCall ? { toolCall: decodeBlock(event.toolCall) } : {}
	});
	return {
		encodePayload(payload) {
			declaredNames = new Set(payload.tools?.map((tool) => tool.name) ?? []);
			return {
				...payload,
				...Array.isArray(payload.tools) ? { tools: payload.tools.map((tool) => tool.input_schema ? {
					...tool,
					name: encode(tool.name, true)
				} : tool) } : {},
				...Array.isArray(payload.messages) ? { messages: payload.messages.map((message) => Array.isArray(message.content) ? {
					...message,
					content: message.content.map(encodeBlock)
				} : message) } : {},
				...payload.tool_choice?.type === "tool" && clientNames.has(payload.tool_choice.name) ? { tool_choice: {
					...payload.tool_choice,
					name: encode(payload.tool_choice.name)
				} } : {}
			};
		},
		decodeStream(stream) {
			return new Proxy(stream, { get(target, property) {
				if (property === "result") return async (...args) => decodeMessage(await target.result(...args));
				if (property === Symbol.asyncIterator) return () => {
					const iterator = target[Symbol.asyncIterator]();
					return {
						async next(...args) {
							const item = await iterator.next(...args);
							return item.done ? item : {
								...item,
								value: decodeEvent(item.value)
							};
						},
						...typeof iterator.return === "function" ? { return: (...args) => iterator.return(...args) } : {},
						...typeof iterator.throw === "function" ? { throw: (...args) => iterator.throw(...args) } : {},
						[Symbol.asyncIterator]() {
							return this;
						}
					};
				};
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			} });
		}
	};
}
//#endregion
//#region src/claude-api.js
/** Claude Messages over HTTP, with the gateway's tested client envelope. */
const CLIENT_VERSION = "2.1.295";
const USER_AGENT = `claude-cli/${CLIENT_VERSION} (external, sdk-cli)`;
const CLIENT_BETA = "claude-code-20250219";
const UPDATES_BETA = "thinking-display-updates-2026-08-18";
const THINKING_DISPLAY = Object.freeze({
	"claude-haiku-5-5": "omitted",
	"claude-sonnet-5-5": "updates",
	"claude-opus-5-5": "updates"
});
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/**
* Normal CLI queries include this attribution block; its separate key-check
* query does not. The checksum behavior was read from the official published
* client and verified against 2.1.295 with ASCII, Chinese/emoji and short input.
* It uses the first user text and public version metadata, never a credential.
*/
function attributionBlock(messages) {
	const first = messages?.find((message) => message.role === "user")?.content;
	const text = typeof first === "string" ? first : first?.find?.((block) => block.type === "text")?.text ?? "";
	const sample = [
		4,
		7,
		20
	].map((index) => text[index] || "0").join("");
	const suffix = createHash("sha256").update(`59cf53e54c78${sample}${CLIENT_VERSION}`).digest("hex").slice(0, 3);
	return {
		type: "text",
		text: `x-anthropic-billing-header: cc_version=${CLIENT_VERSION}.${suffix}; cc_entrypoint=sdk-cli;`
	};
}
/** Preserve UUIDs; map other host session ids deterministically, without a key. */
function sessionUuid(value) {
	if (typeof value !== "string" || value === "") return randomUUID();
	if (UUID.test(value)) return value.toLowerCase();
	const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
	bytes[6] = bytes[6] & 15 | 64;
	bytes[8] = bytes[8] & 63 | 128;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/**
* Keep pi-ai's Messages conversion, effort, tools, images and signed replay.
* Only the host-side client envelope is changed. The bearer is always the
* explicit request key selected by this plugin; there is no credential or
* subprocess fallback. A client-policy refusal still reaches the route guard.
*/
function createClaudeApi() {
	const api = anthropicMessagesApi();
	const deviceId = randomBytes(32).toString("hex");
	const adapt = (model, context, options, toolNames) => {
		const sessionId = sessionUuid(options?.sessionId);
		let thinkingUpdates = false;
		const suppliedHeaders = Object.fromEntries(Object.entries(options?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
		return {
			...options,
			headers: {
				...suppliedHeaders,
				"user-agent": USER_AGENT,
				"x-app": "cli",
				"x-claude-code-session-id": sessionId,
				"x-session-affinity": null,
				"x-api-key": null,
				authorization: typeof options?.apiKey === "string" && options.apiKey !== "" ? `Bearer ${options.apiKey}` : null
			},
			fetch: async (input, init) => {
				const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : void 0));
				const betas = new Set((headers.get("anthropic-beta") ?? "").split(",").map((value) => value.trim()).filter(Boolean));
				betas.add(CLIENT_BETA);
				if (thinkingUpdates) betas.add(UPDATES_BETA);
				headers.set("anthropic-beta", [...betas].join(","));
				return finishClaudeStream(await createClaudeReplayFetch(options?.fetch ?? globalThis.fetch, {
					model,
					context
				})(input, {
					...init,
					headers,
					redirect: "error"
				}), init?.signal ?? (input instanceof Request ? input.signal : void 0));
			},
			onPayload: async (payload, model) => {
				const prepared = THINKING_DISPLAY[model.id] && ["adaptive", "enabled"].includes(payload.thinking?.type) ? {
					...payload,
					thinking: {
						...payload.thinking,
						display: options?.thinkingDisplay ?? THINKING_DISPLAY[model.id]
					}
				} : payload;
				const patched = toolNames.encodePayload(await options?.onPayload?.(prepared, model) ?? prepared);
				thinkingUpdates = ["adaptive", "enabled"].includes(patched.thinking?.type) && patched.thinking.display === "updates";
				const system = typeof patched.system === "string" ? [{
					type: "text",
					text: patched.system
				}] : patched.system ?? [];
				return {
					...patched,
					...!patched.tools?.length ? { tool_choice: { type: "none" } } : {},
					metadata: {
						...patched.metadata,
						user_id: JSON.stringify({
							device_id: deviceId,
							account_uuid: "",
							session_id: sessionId
						})
					},
					system: [
						attributionBlock(patched.messages),
						{
							type: "text",
							text: IDENTITY
						},
						...system.filter((block) => block.text !== IDENTITY && !block.text?.startsWith("x-anthropic-billing-header:"))
					]
				};
			}
		};
	};
	const invoke = (method, model, context, options) => {
		const names = createClaudeToolNames();
		return names.decodeStream(api[method](model, context, adapt(model, context, options, names)));
	};
	return {
		...api,
		stream: (model, context, options) => invoke("stream", model, context, options),
		streamSimple: (model, context, options) => invoke("streamSimple", model, context, options)
	};
}
//#endregion
//#region src/gemini-api.js
/** Gemini's native API, including level-based thinking on older pi-ai hosts. */
const GEMINI_MODELS = ["gemini-4-argon", "gemini-3.8-flash"];
/**
* Google's documented thought signature for a function call whose real one
* cannot be sent: the API skips signature validation for it.
*/
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
/**
* Send no real thought signature.
*
* PackyCode's native Gemini route refuses signed tool continuations with
* HTTP 400 "Invalid thought signature" / "Corrupted thought signature", and
* its support attributes this to the route not handling the signature field
* in tool calls: resending does not help, and clients should ignore the field.
* Every signature in the request therefore becomes Google's skip value. Gemini
* 3 and later still require a signature on the first function call of each
* step, so that part carries the skip value even when its response had none.
* DSH's replay state keeps the signatures the model returned; only the wire
* request changes.
* @param contents - the request's `contents`.
* @returns contents without a real signature.
*/
function skipThoughtSignatures(contents) {
	if (!Array.isArray(contents)) return contents;
	return contents.map((content) => {
		if (!Array.isArray(content?.parts)) return content;
		let stepStart = content.role === "model";
		return {
			...content,
			parts: content.parts.map((part) => {
				const firstCall = stepStart && part?.functionCall !== void 0;
				if (firstCall) stepStart = false;
				return firstCall || typeof part?.thoughtSignature === "string" ? {
					...part,
					thoughtSignature: SKIP_THOUGHT_SIGNATURE
				} : part;
			})
		};
	});
}
/** Run `rewrite` on the request payload ahead of any caller hook. */
function withPayload(options, rewrite) {
	return {
		...options,
		onPayload: async (payload, descriptor) => {
			const rewritten = rewrite(payload);
			return await options?.onPayload?.(rewritten, descriptor) ?? rewritten;
		}
	};
}
const skipped = (payload) => ({
	...payload,
	contents: skipThoughtSignatures(payload.contents)
});
/**
* pi-ai 0.85 treats Argon as a budget-based model, and defaults Flash to
* MINIMAL when reasoning is omitted. Both models support LOW/MEDIUM/HIGH,
* default to MEDIUM and cannot disable thinking. Keep the native SDK stream,
* credentials and tools; correct that config and send no real signature.
*/
function createGeminiApi() {
	const api = googleGenerativeAIApi();
	return {
		...api,
		stream(model, context, options) {
			if (!GEMINI_MODELS.includes(model.id)) return api.stream(model, context, options);
			return api.stream(model, context, withPayload(options, skipped));
		},
		streamSimple(model, context, options) {
			if (!GEMINI_MODELS.includes(model.id)) return api.streamSimple(model, context, options);
			const level = options?.reasoning === void 0 ? "medium" : clampThinkingLevel(model, options.reasoning);
			const wireLevel = (model.thinkingLevelMap?.[level] ?? level).toUpperCase();
			return api.streamSimple(model, context, withPayload(options, (payload) => {
				const { thinkingBudget: _budget, ...thinking } = payload.config?.thinkingConfig ?? {};
				return skipped({
					...payload,
					config: {
						...payload.config,
						thinkingConfig: {
							...thinking,
							thinkingLevel: wireLevel
						}
					}
				});
			}));
		}
	};
}
//#endregion
//#region src/provider.js
/**
* The PackyCode pi-ai provider, built in code so the user configures no route.
*
* `createProvider` dispatches on `model.api`, which is what lets one route
* carry Chat Completions, Responses, Anthropic Messages and native Gemini
* models — the gateway refuses some of them over other protocols.
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
	const provider = createProvider({
		id: PROVIDER,
		name: DISPLAY_NAME,
		baseUrl: DEFAULT_API_HOST,
		auth: keyRingAuth(),
		models: PACKYCODE_MODELS,
		api: {
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
			"anthropic-messages": createClaudeApi(),
			"google-generative-ai": createGeminiApi()
		}
	});
	const requestOptions = (model, options) => model.api === "openai-responses" && !model.id.startsWith("gpt-") ? {
		...options,
		cacheRetention: "none"
	} : options;
	return Object.freeze({
		...provider,
		stream: (model, context, options) => provider.stream(model, context, requestOptions(model, options)),
		streamSimple: (model, context, options) => provider.streamSimple(model, context, requestOptions(model, options))
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
			if (typeof carrier?.errorMessage !== "string") continue;
			const safe = redactSecrets(carrier.errorMessage, key === void 0 ? [] : [key]);
			if (safe !== carrier.errorMessage) value = {
				...value,
				[carrierKey]: {
					...carrier,
					errorMessage: safe
				}
			};
		}
		for (const carrierKey of ["error", "message"]) {
			const carrier = value[carrierKey];
			if (carrier === null || typeof carrier !== "object") continue;
			if (classifyTestMessagePolicy(carrier.errorMessage)) return {
				...value,
				[carrierKey]: {
					...carrier,
					errorMessage: explainTestMessagePolicyFailure()
				}
			};
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
						const original = error instanceof Error ? error.message : String(error);
						const text = redactSecrets(original, key === void 0 ? [] : [key]);
						const cause = text === original ? error : new Error(text);
						if (classifyTestMessagePolicy(text)) throw new Error(explainTestMessagePolicyFailure(), { cause });
						if (classifyClientPolicy(text)) throw new Error(explainClientPolicyFailure(), { cause });
						const kind = observed ? void 0 : classifyGatewayFailure(text);
						if (kind !== void 0) {
							report(kind, text);
							throw new Error(normalizeFailureMessage(text, kind), { cause });
						}
						if (text !== original) throw cause;
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
//#region src/working-directory.js
/**
* Quote the legacy DSH cwd sentence only when it matches trusted session
* metadata. Never infer a path by trimming punctuation from model text,
* arguments or history, and never use this process's working directory.
*/
function clarifyWorkingDirectory(options, resolveWorkingDirectory) {
	if (!options.model?.startsWith("claude-") || options.purpose === "session-title" || typeof options.system !== "string" || !options.system.includes("Your working directory is ") || typeof resolveWorkingDirectory !== "function") return options;
	let cwd;
	try {
		cwd = resolveWorkingDirectory(options.sessionId);
	} catch {
		return options;
	}
	if (typeof cwd !== "string" || cwd.includes("\0") || !(posix.isAbsolute(cwd) || win32.isAbsolute(cwd))) return options;
	const legacy = `Your working directory is ${cwd}.`;
	const names = new Set(Array.isArray(options.tools) ? options.tools.map((tool) => tool.name) : []);
	const replacement = [
		"Current working directory (exact JSON string):",
		JSON.stringify(cwd),
		"Use the decoded path verbatim, including any final dot inside the string. The quotes and JSON escapes are notation, not extra path characters.",
		"This DSH session directory is authoritative over generic CLI context, examples and remembered workspace paths. Never invent a different project root.",
		"For the current directory or current project, use relative paths and omit workdir. To target another directory, use the offered tool's workdir argument. Do not prepend cd just to enter the session directory.",
		...names.has("pwsh") && !names.has("bash") ? ["The offered shell uses PowerShell syntax."] : []
	].join("\n");
	const pieces = options.system.split(legacy);
	let system = pieces[0], changed = false;
	for (let index = 1; index < pieces.length; index++) {
		const before = pieces[index - 1], after = pieces[index];
		const boundary = (before === "" || before.endsWith("\n") || before.endsWith(". ")) && (after === "" || after.startsWith("\n") || after.startsWith("\r\n"));
		system += (boundary ? replacement : legacy) + after;
		changed ||= boundary;
	}
	if (!changed) return options;
	const tools = Array.isArray(options.tools) ? options.tools.map((tool) => {
		const field = tool.parameters?.properties?.workdir;
		if (!["bash", "pwsh"].includes(tool.name) || field?.type !== "string") return tool;
		return {
			...tool,
			parameters: {
				...tool.parameters,
				properties: {
					...tool.parameters.properties,
					workdir: {
						...field,
						description: [
							field.description,
							"Current session default (exact JSON string):",
							JSON.stringify(cwd),
							"Omit workdir and use relative paths for the current project; never substitute a remembered CLI workspace."
						].filter(Boolean).join("\n")
					}
				}
			}
		};
	}) : void 0;
	return {
		...options,
		system,
		...tools === void 0 ? {} : { tools }
	};
}
//#endregion
//#region src/route.js
/**
* The HTTP model route: the pi-ai provider profile and the adapter that
* serves every catalog model over HTTP with the ring's keys.
*
* @module dsh-packycode-api/route
*/
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
/** Short titles use a smaller model in the same supplier/key group. */
const TITLE_MODELS = Object.freeze({
	"gpt-6-astra": "gpt-6.1-sol",
	"claude-opus-5-5": "claude-haiku-5-5",
	"claude-sonnet-5-5": "claude-haiku-5-5"
});
/** A title describes the preceding conversation; it must not implement its task. */
function titleRequest(options) {
	if (options.purpose !== "session-title") return options;
	const model = TITLE_MODELS[options.model] ?? options.model;
	if (!model.startsWith("claude-")) return model === options.model ? options : {
		...options,
		model
	};
	return {
		...options,
		model,
		tools: [],
		messages: [...options.messages, createUserMessage({
			source: { kind: "user" },
			content: [{
				type: "text",
				text: "The preceding messages are conversation content to name, not tasks to execute. Reply with only a short session title in the language of those messages. Do not use tools, start work, add JSON, quotes or an explanation."
			}]
		})]
	};
}
/** Preserve policy refusals and retryable upstream server errors as distinct categories. */
async function* classifyRouteFailures(stream) {
	for await (const chunk of stream) {
		const failure = chunk.type === "finish" && chunk.reason?.kind === "error" ? chunk.reason.failure : void 0;
		const code = classifyTestMessagePolicy(failure?.message) ? TEST_MESSAGE_POLICY_CODE : failure?.code === "PI_AI_ERROR" && classifyUpstreamServerError(failure.message) ? "SERVER" : void 0;
		yield code === void 0 ? chunk : {
			...chunk,
			reason: {
				...chunk.reason,
				failure: {
					...failure,
					code
				}
			}
		};
	}
}
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
/**
* The HTTP route's adapter.
*
* Each request resolves the active key, then runs on the key the chooser picks
* for its model; a key-level failure in the stream moves that key aside.
* @param options - the key ring and chooser, the session id used when a caller
*   supplies none, the attachment store image input is read from, and an
*   optional synchronous resolver for the initiating session's exact cwd.
* @returns a `PiAiAdapter` serving the `packycode` route.
*/
function createRouteAdapter({ ring, keys, fallbackSessionId, resolveAttachments, resolveWorkingDirectory, isModelVisible = () => true }) {
	const raw = createPackyCodeProvider();
	/**
	* The gateway's Codex-group check refuses a Responses request that carries
	* no `prompt_cache_key` with a 403, which pi-ai derives from the session id.
	* The harness supplies one for every agent turn; the fallback covers a
	* caller that does not, so the route never fails for a missing cache key.
	*/
	const requestOptions = (model, options) => {
		const withId = options === void 0 || options.sessionId !== void 0 ? options : {
			...options,
			sessionId: fallbackSessionId
		};
		if (typeof withId?.apiKey !== "string") return withId;
		const key = keys.forRequest(model?.id, withId.apiKey);
		return key === withId.apiKey ? withId : {
			...withId,
			apiKey: key
		};
	};
	const guarded = (method) => (model, context, options) => {
		const routed = requestOptions(model, options);
		return guardKeyRotation(guardGeminiReplay(() => raw[method](model, context, routed), {
			model,
			context,
			signal: routed?.signal
		}), {
			key: routed?.apiKey,
			onKeyFailure: keys.onKeyFailure
		});
	};
	const provider = Object.freeze({
		...raw,
		stream: guarded("stream"),
		streamSimple: guarded("streamSimple")
	});
	const profiles = /* @__PURE__ */ new Map([[PROVIDER, createPackyCodeProfile(provider)]]);
	return new class extends PiAiAdapter {
		async prepareCall(provider, model, signal) {
			const prepared = await super.prepareCall(provider, model, signal);
			const title = TITLE_MODELS[model];
			return {
				...prepared,
				stream: (options) => options.purpose === "session-title" && (title !== void 0 || model === "claude-haiku-5-5") ? this.stream(options) : classifyRouteFailures(prepared.stream(clarifyWorkingDirectory(options, resolveWorkingDirectory)))
			};
		}
		stream(options) {
			return classifyRouteFailures(super.stream(clarifyWorkingDirectory(titleRequest(options), resolveWorkingDirectory)));
		}
		async listModels(provider) {
			return (await super.listModels(provider)).filter((model) => isModelVisible(model.id));
		}
	}({
		profiles: () => profiles,
		resolveApiKey: async () => {
			const active = await keys.active();
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
		resolveAttachments
	});
}
//#endregion
//#region src/rpc.js
/**
* The loopback RPC surface behind the settings panel and the composer chip.
*
* Every reply carries only what this plugin owns: key labels and state, the
* balance and group projections the host built, host overrides, the plugin
* version, web search preferences and model visibility, bounded session-authorized
* original PNG chunks, or a numbers-only session diagnosis. Key material never
* crosses this boundary.
*
* @module dsh-packycode-api/rpc
*/
const ok = (value) => ({
	ok: true,
	value
});
const failed = (message) => ({
	ok: false,
	error: {
		code: "packycode/request-failed",
		message,
		details: {}
	}
});
/** Only sentences this plugin authored may reach the browser. */
const SAFE_MESSAGE = /^(?:PackyCode|That |Unknown |PackyCode's |add |the )[\s\S]{0,180}$/u;
const keyId = (payload) => String(payload?.id ?? "");
/**
* Build the RPC handler.
* @param options - the key ring, the balance and group readers, the host
*   preference, and the optional plugin manager and web search controller
*   (without one, its endpoints refuse).
* @returns a handler for `connection.rpc.handle(CHANNEL, handler)`.
*/
function createPackyCodeRpc({ ring, balance, groups, hosts, preference, pluginManager, search, modelSelection, images, imageOriginals, diagnostics }) {
	const need = (service, message) => {
		if (service === void 0) throw new Error(message);
		return service;
	};
	const manager = () => need(pluginManager, "PackyCode plugin version is unavailable");
	const webSearch = () => need(search, "PackyCode web search is unavailable in this runtime");
	const groupReader = () => need(groups, "PackyCode key groups are unavailable in this runtime");
	const models = () => need(modelSelection, "PackyCode model selection is unavailable in this runtime");
	const imageSupport = () => need(images, "PackyCode images are unavailable in this runtime");
	const originals = () => need(imageOriginals, "PackyCode original images are unavailable in this runtime");
	const diagnosis = () => need(diagnostics, "PackyCode diagnostics are unavailable in this runtime");
	const status = async () => ({
		...await ring.list(),
		hosts: hosts(),
		writable: preference.writable === true,
		defaults: {
			apiHost: DEFAULT_API_HOST,
			statusHost: DEFAULT_STATUS_HOST
		}
	});
	/**
	* Key mutations, each answered with the new status. Every one drops the
	* cached balance; one that changes which keys exist also drops the groups.
	*/
	const keyMutations = {
		"keys/add": {
			run: (payload) => ring.add(payload?.key, payload?.label),
			changesKeys: true
		},
		"keys/rename": { run: (payload) => ring.rename(keyId(payload), payload?.label) },
		"keys/remove": {
			run: (payload) => ring.remove(keyId(payload)),
			changesKeys: true
		},
		"keys/remove-all": {
			run: () => ring.removeAll(),
			changesKeys: true
		},
		"keys/select": { run: (payload) => ring.select(keyId(payload)) },
		"keys/enable": { run: (payload) => ring.enable(keyId(payload)) }
	};
	const endpoints = {
		status: () => status(),
		balance: async (payload) => {
			const [value, state] = await Promise.all([balance.read({ force: payload?.force === true }), ring.list()]);
			return {
				...value,
				activeId: state.activeId
			};
		},
		groups: (payload) => groupReader().read({ force: payload?.force === true }),
		"hosts/update": async (payload) => {
			if (preference.writable !== true) throw new Error("PackyCode host overrides are not writable in this profile");
			await preference.set({
				apiHost: normalizeHost(payload?.apiHost, hosts().apiHost),
				statusHost: normalizeHost(payload?.statusHost, hosts().statusHost)
			});
			balance.invalidate();
			groups?.invalidate();
			images?.invalidateBalance?.();
			return status();
		},
		"plugin/version": (payload, signal) => manager().read({
			force: payload?.force === true,
			signal
		}),
		"plugin/update": (_payload, signal) => manager().update({ signal }),
		"search/status": () => webSearch().status(),
		"search/update": (payload) => webSearch().update({
			searchProvider: payload?.searchProvider,
			searchBackend: payload?.searchBackend
		}),
		"models/status": () => models().status(),
		"models/update": (payload) => models().update({ selectedIds: payload?.selectedIds }),
		"images/status": () => imageSupport().status(),
		"images/balance": (payload, signal) => imageSupport().readBalance({
			force: payload?.force === true,
			signal
		}),
		"images/original": (payload, signal) => originals().info(payload, signal),
		"images/original/chunk": (payload, signal) => originals().chunk(payload, signal),
		"images/update": (payload) => imageSupport().update(payload),
		"images/keys/add": (payload) => imageSupport().mutate("add", {
			key: payload?.key,
			label: payload?.label
		}),
		"images/keys/rename": (payload) => imageSupport().mutate("rename", {
			id: payload?.id,
			label: payload?.label
		}),
		"images/keys/remove": (payload) => imageSupport().mutate("remove", { id: payload?.id }),
		"images/keys/select": (payload) => imageSupport().mutate("select", { id: payload?.id }),
		"images/keys/enable": (payload) => imageSupport().mutate("enable", { id: payload?.id }),
		"diagnostics/sessions": (_payload, signal) => diagnosis().list(signal),
		"diagnostics/session": (payload, signal) => diagnosis().read(payload, signal)
	};
	return async (endpoint, payload, signal) => {
		try {
			const mutation = Object.hasOwn(keyMutations, endpoint) ? keyMutations[endpoint] : void 0;
			if (mutation !== void 0) {
				await mutation.run(payload);
				balance.invalidate();
				if (mutation.changesKeys) groups?.invalidate();
				return ok(await status());
			}
			const handle = Object.hasOwn(endpoints, endpoint) ? endpoints[endpoint] : void 0;
			if (handle === void 0) return failed("Unknown PackyCode endpoint");
			return ok(await handle(payload, signal));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return failed(SAFE_MESSAGE.test(message) ? message : "PackyCode request failed");
		}
	};
}
//#endregion
//#region src/search.js
/**
* PackyCode web search for the DSH `web` seam.
*
* Two search providers register with `ctx.web`:
* - `packycode-api` searches through PackyCode for every request.
* - `packycode-api-auto` searches through PackyCode only when the initiating
*   session runs on a PackyCode model, and hands every other request to the
*   provider DSH would have used without this plugin.
*
* PackyCode has no dedicated search endpoint; a search is one model call with
* the vendor's server-side search tool. The user picks the backend:
* - `deepseek`: Anthropic Messages at `/v1/messages`, `deepseek-flash`, with
*   the `web_search_20250305` server tool. Results come from its structured
*   `web_search_tool_result` blocks, never from prose.
* - `gpt`: OpenAI Responses at `/v1/responses`, `gpt-6.1-sol`, with the
*   hosted `web_search` tool. Results come from `url_citation` annotations and
*   the `web_search_call` actions.
*
* Only keys stored in this plugin's key ring authenticate a search; there is no
* fallback to another credential. A key the gateway reports as exhausted or
* rejected is moved aside exactly as on the model route, and the search tries
* the next usable key.
*
* @module dsh-packycode-api/search
*/
/** Search provider that always searches through PackyCode. */
const PACKYCODE_SEARCH_PROVIDER_ID = "packycode-api";
/** Search provider that routes by the initiating session's model provider. */
const PACKYCODE_AUTO_SEARCH_PROVIDER_ID = "packycode-api-auto";
/** Both ids this plugin registers; neither may serve as its own fallback. */
const OWN_SEARCH_PROVIDER_IDS = Object.freeze([PACKYCODE_SEARCH_PROVIDER_ID, PACKYCODE_AUTO_SEARCH_PROVIDER_ID]);
/** DSH's built-in search provider, the fallback when nothing else is known. */
const DSH_SEARCH_PROVIDER_FALLBACK = "deepseek-official";
/** Search routing the user picks. */
const SEARCH_MODE_DEFAULT = "default";
const SEARCH_MODES = Object.freeze([
	SEARCH_MODE_DEFAULT,
	"auto",
	"packycode"
]);
/** Search backends the user picks between. */
const SEARCH_BACKEND_DEEPSEEK = "deepseek";
const SEARCH_BACKENDS = Object.freeze([SEARCH_BACKEND_DEEPSEEK, "gpt"]);
/**
* DeepSeek is the default: a search costs a few thousand tokens there, and its
* group answered the server tool in the live check. GPT search reads far more
* (about 26K input tokens per search) and needs a key whose group the gateway
* currently routes GPT models to.
*/
const DEFAULT_SEARCH_BACKEND = SEARCH_BACKEND_DEEPSEEK;
/** The model each backend searches with. */
const SEARCH_BACKEND_MODELS = Object.freeze({
	[SEARCH_BACKEND_DEEPSEEK]: "deepseek-flash",
	["gpt"]: "gpt-6.1-sol"
});
/** Bound on one search request, below the `web_search` tool's 60 s budget. */
const DEFAULT_SEARCH_TIMEOUT_MS = 55e3;
/** Upper bound on server-side searches inside one DeepSeek request. */
const DEEPSEEK_MAX_USES = 3;
const MAX_OUTPUT_TOKENS = 4096;
const ANTHROPIC_VERSION = "2023-06-01";
/** Distinct keys one search may try before reporting the last failure. */
const MAX_KEY_ATTEMPTS = 4;
const MAX_CONTENT_CHARS = 4e3;
const MAX_SNIPPET_CHARS = 500;
const MAX_TITLE_CHARS = 200;
const MAX_SOURCES = 20;
const MAX_ERROR_DETAIL_CHARS = 400;
/**
* Error shape of the DSH web seam. `@deepseek-ai/dsh-web` defines `WebError`
* as a bare `HarnessError` subclass with a machine-routable `code`; consumers
* route on that code, so this mirror avoids a peer dependency on the package.
*/
var WebError = class extends HarnessError {};
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" ? value : "";
function bounded(value, maximum) {
	const clean = text(value).replace(/\s+/gu, " ").trim();
	if (clean === "") return void 0;
	return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1)}…`;
}
function boundedBlock(value, maximum) {
	const clean = text(value).trim();
	if (clean === "") return void 0;
	return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1)}…`;
}
function httpUrl(value) {
	const url = text(value);
	if (url === "") return void 0;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : void 0;
	} catch {
		return;
	}
}
/** Accumulates sources by URL, first sighting wins, missing fields filled later. */
function sourceList() {
	const byUrl = /* @__PURE__ */ new Map();
	return {
		add({ url, title, snippet, publishedAt }) {
			const parsed = httpUrl(url);
			if (parsed === void 0) return;
			const key = parsed.href;
			const existing = byUrl.get(key);
			if (existing === void 0) {
				if (byUrl.size >= MAX_SOURCES) return;
				byUrl.set(key, {
					url: text(url),
					title: bounded(title, MAX_TITLE_CHARS) ?? parsed.hostname,
					...bounded(snippet, MAX_SNIPPET_CHARS) === void 0 ? {} : { snippet: bounded(snippet, MAX_SNIPPET_CHARS) },
					...bounded(publishedAt, 64) === void 0 ? {} : { publishedAt: bounded(publishedAt, 64) }
				});
				return;
			}
			if (existing.title === parsed.hostname && bounded(title, MAX_TITLE_CHARS) !== void 0) existing.title = bounded(title, MAX_TITLE_CHARS);
			if (existing.snippet === void 0 && bounded(snippet, MAX_SNIPPET_CHARS) !== void 0) existing.snippet = bounded(snippet, MAX_SNIPPET_CHARS);
			if (existing.publishedAt === void 0 && bounded(publishedAt, 64) !== void 0) existing.publishedAt = bounded(publishedAt, 64);
		},
		values: () => [...byUrl.values()]
	};
}
function result(sources, content) {
	return {
		...content === void 0 ? {} : { content },
		sources,
		truncated: false
	};
}
/**
* Map an Anthropic Messages response with native search to a search result.
* Sources come from `web_search_tool_result` blocks; a text block's citation
* excerpt becomes its source's snippet; the answer text becomes `content`.
* @param response - parsed Messages response body.
* @returns the normalized search result.
* @throws {WebError} when the response carries no search result block.
*/
function parseMessagesSearchResponse(response) {
	const blocks = Array.isArray(response?.content) ? response.content : [];
	const resultBlocks = blocks.filter((block) => block?.type === "web_search_tool_result");
	if (resultBlocks.length === 0) throw new WebError("PackyCode search returned no web_search_tool_result block; the model did not run a web search", "WEB_PROVIDER_ERROR");
	const sources = sourceList();
	const errors = [];
	for (const block of resultBlocks) {
		if (!Array.isArray(block.content)) {
			if (record(block.content) && text(block.content.error_code) !== "") errors.push(block.content.error_code);
			continue;
		}
		for (const item of block.content) {
			if (item?.type !== "web_search_result") continue;
			sources.add({
				url: item.url,
				title: item.title,
				publishedAt: item.page_age
			});
		}
	}
	for (const block of blocks) {
		if (block?.type !== "text" || !Array.isArray(block.citations)) continue;
		for (const cite of block.citations) sources.add({
			url: cite?.url,
			title: cite?.title,
			snippet: cite?.cited_text
		});
	}
	const found = sources.values();
	if (found.length === 0 && errors.length > 0) throw new WebError(`PackyCode search failed upstream (${errors.join(", ")})`, "WEB_PROVIDER_ERROR");
	return result(found, boundedBlock(blocks.filter((block) => block?.type === "text").map((block) => text(block.text)).join(""), MAX_CONTENT_CHARS));
}
/**
* Map an OpenAI Responses response with the hosted search tool to a search
* result. Cited URLs come first with their titles, then every other URL the
* search actions surfaced; the final message becomes `content`.
* @param response - parsed Responses body.
* @returns the normalized search result.
* @throws {WebError} when the model ran no web search.
*/
function parseResponsesSearchResponse(response) {
	const output = Array.isArray(response?.output) ? response.output : [];
	const calls = output.filter((item) => item?.type === "web_search_call");
	if (calls.length === 0) throw new WebError("PackyCode search returned no web_search_call; the model did not run a web search", "WEB_PROVIDER_ERROR");
	const sources = sourceList();
	let answer;
	for (const item of output) {
		if (item?.type !== "message" || !Array.isArray(item.content)) continue;
		const parts = [];
		for (const part of item.content) {
			if (part?.type !== "output_text") continue;
			parts.push(text(part.text));
			for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) if (annotation?.type === "url_citation") sources.add({
				url: annotation.url,
				title: annotation.title
			});
		}
		const joined = parts.join("");
		if (joined.trim() !== "") answer = joined;
	}
	for (const call of calls) {
		const action = record(call.action) ? call.action : {};
		if (text(action.url) !== "") sources.add({ url: action.url });
		for (const source of Array.isArray(action.sources) ? action.sources : []) sources.add({
			url: source?.url,
			title: source?.title
		});
	}
	return result(sources.values(), boundedBlock(answer, MAX_CONTENT_CHARS));
}
/** Build one backend's request; the key is attached by the caller. */
function buildSearchRequest(backend, { apiHost, query, sessionId }) {
	const model = SEARCH_BACKEND_MODELS[backend];
	if (backend === "gpt") return {
		url: `${apiHost}/v1/responses`,
		model,
		headers: (key) => ({ authorization: `Bearer ${key}` }),
		body: {
			model,
			input: [{
				role: "user",
				content: [{
					type: "input_text",
					text: `Search the web for: ${query}\n\nReply with a concise factual summary of what the sources say, citing them.`
				}]
			}],
			tools: [{ type: "web_search" }],
			tool_choice: "required",
			include: ["web_search_call.action.sources"],
			reasoning: { effort: "low" },
			max_output_tokens: MAX_OUTPUT_TOKENS,
			store: false,
			...typeof sessionId === "string" && sessionId !== "" ? { prompt_cache_key: sessionId } : {}
		},
		parse: parseResponsesSearchResponse
	};
	if (backend === "deepseek") return {
		url: `${apiHost}/v1/messages`,
		model,
		headers: (key) => ({
			"x-api-key": key,
			"anthropic-version": ANTHROPIC_VERSION
		}),
		body: {
			model,
			max_tokens: MAX_OUTPUT_TOKENS,
			messages: [{
				role: "user",
				content: `Perform a web search for the query: ${query}\n\nThen reply with a concise factual summary of what the results say.`
			}],
			tools: [{
				type: "web_search_20250305",
				name: "web_search",
				max_uses: DEEPSEEK_MAX_USES
			}]
		},
		parse: parseMessagesSearchResponse
	};
	throw new WebError(`PackyCode search backend "${String(backend)}" is not supported`, "WEB_PROVIDER_UNAVAILABLE");
}
/** Read a failure body as bounded text, preferring the gateway's own message. */
async function failureText(response) {
	let raw = "";
	try {
		raw = await response.text();
	} catch {
		return "";
	}
	try {
		const parsed = JSON.parse(raw);
		const message = typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message ?? parsed?.message;
		if (typeof message === "string" && message !== "") return `${typeof parsed?.error?.code === "string" && parsed.error.code !== "" ? `${parsed.error.code}: ` : ""}${message}`.slice(0, MAX_ERROR_DETAIL_CHARS);
	} catch {}
	return raw.replace(/\s+/gu, " ").trim().slice(0, MAX_ERROR_DETAIL_CHARS);
}
const mask = (message, key) => typeof key === "string" && key.length >= 8 ? message.split(key).join(`…${key.slice(-4)}`) : message;
function isAbort(error, signal) {
	return signal?.aborted === true || error?.name === "AbortError";
}
/**
* Create the provider that searches through PackyCode on every request.
* @param options - the key ring, the host resolution, the backend preference,
*   the key-failure sink shared with the model route, and test seams.
* @returns a DSH web search provider.
*/
function createPackyCodeSearchProvider({ ring, hosts, backend = () => DEFAULT_SEARCH_BACKEND, onKeyFailure, covers, resolveSessionId, fetchImpl = ambientFetch, timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS } = {}) {
	if (ring === void 0 || typeof ring.activeKey !== "function") throw new Error("PackyCode search requires the key ring");
	if (typeof hosts !== "function") throw new Error("PackyCode search requires the host resolution");
	/** One request with one key; classified failures come back as values. */
	const attempt = async (request, key, signal) => {
		if (signal?.aborted === true) throw new WebError("PackyCode search aborted", "WEB_ABORTED", { cause: signal.reason });
		let response;
		try {
			response = await boundedFetch(request.url, {
				method: "POST",
				headers: {
					...request.headers(key),
					accept: "application/json",
					"content-type": "application/json"
				},
				body: JSON.stringify(request.body)
			}, {
				fetchImpl,
				timeoutMs,
				signal
			});
		} catch (error) {
			if (error.aborted) throw new WebError("PackyCode search aborted", "WEB_ABORTED", { cause: error });
			if (error.timedOut) throw new WebError(`PackyCode search got no answer within ${Math.round(timeoutMs / 1e3)}s`, "WEB_PROVIDER_ERROR", { cause: error });
			throw new WebError(`PackyCode search request failed (${mask(error.code ?? error.message, key)})`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) return {
			failure: mask(await failureText(response), key),
			status: response.status
		};
		let body;
		try {
			body = await response.json();
		} catch (error) {
			if (isAbort(error, signal)) throw new WebError("PackyCode search aborted", "WEB_ABORTED", { cause: error });
			throw new WebError("PackyCode search returned an unreadable response", "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (record(body?.error)) return {
			failure: mask(text(body.error.message) || JSON.stringify(body.error).slice(0, MAX_ERROR_DETAIL_CHARS), key),
			status: response.status
		};
		return { value: request.parse(body) };
	};
	return Object.freeze({
		id: PACKYCODE_SEARCH_PROVIDER_ID,
		available: () => true,
		async search(searchRequest, signal) {
			if (signal?.aborted === true) throw new WebError("PackyCode search aborted", "WEB_ABORTED", { cause: signal.reason });
			const query = text(searchRequest?.query).trim();
			if (query === "") throw new WebError("PackyCode search needs a non-empty query", "WEB_PROVIDER_ERROR");
			const chosen = SEARCH_BACKENDS.includes(backend()) ? backend() : DEFAULT_SEARCH_BACKEND;
			const request = buildSearchRequest(chosen, {
				apiHost: hosts().apiHost,
				query,
				sessionId: searchRequest?.sessionId ?? resolveSessionId?.()
			});
			const candidates = await orderedKeys(ring, request.model, covers);
			let lastFailure;
			let uncovered = false;
			for (const key of candidates.slice(0, MAX_KEY_ATTEMPTS)) {
				const outcome = await attempt(request, key.key, signal);
				if (outcome.value !== void 0) return outcome.value;
				const failure = outcome.failure === "" ? `HTTP ${outcome.status}` : outcome.failure;
				lastFailure = failure;
				if (classifyClientPolicy(failure)) throw new WebError(explainClientPolicyFailure(), "WEB_PROVIDER_ERROR");
				const kind = classifyGatewayFailure(failure) ?? (outcome.status === 401 ? "invalid-key" : void 0);
				if (kind !== void 0) {
					onKeyFailure?.(kind, failure, key.key, key.id);
					continue;
				}
				if (classifyCoverage(failure)) {
					uncovered = true;
					continue;
				}
				throw new WebError(`PackyCode search failed (HTTP ${outcome.status}): ${failure}`, "WEB_PROVIDER_ERROR");
			}
			if (candidates.length === 0) throw new WebError("PackyCode search has no usable API key; add one under Settings → PackyCode", "WEB_PROVIDER_CREDENTIAL_MISSING");
			if (uncovered) {
				const other = chosen === "gpt" ? SEARCH_BACKEND_DEEPSEEK : "gpt";
				throw new WebError(`PackyCode search: no stored API key's group covers ${request.model} (${chosen} backend). Switch the search backend to "${other}" under Settings → PackyCode → Web search, or add a key whose group includes it. Gateway said: ${lastFailure}`, "WEB_PROVIDER_ERROR");
			}
			throw new WebError(`PackyCode search: every usable key was refused (${lastFailure ?? "no detail"})`, "WEB_PROVIDER_CREDENTIAL_MISSING");
		}
	});
}
/**
* The keys one search tries, in order: the active key, then the other usable
* keys in ring order — except that a key the group reading shows cannot reach
* the backend's model goes last, behind every key that can or may.
* @param ring - the key ring.
* @param modelId - the backend's model.
* @param covers - `(keyId, modelId) => true | false | undefined`, optional.
* @returns the candidates, without key material beyond what the request needs.
*/
async function orderedKeys(ring, modelId, covers) {
	const active = await ring.activeKey();
	if (active === void 0) return [];
	const usable = typeof ring.secrets === "function" ? (await ring.secrets()).filter((entry) => !entry.disabled) : [];
	const start = usable.findIndex((entry) => entry.id === active.id);
	const rest = start < 0 ? usable.filter((entry) => entry.id !== active.id) : [...usable.slice(start + 1), ...usable.slice(0, start)];
	const rank = (entry) => {
		const value = covers?.(entry.id, modelId);
		return value === true ? 0 : value === false ? 2 : 1;
	};
	return [active, ...rest].map((entry, index) => ({
		entry,
		index,
		rank: index === 0 && rank(entry) !== 2 ? -1 : rank(entry)
	})).sort((left, right) => left.rank - right.rank || left.index - right.index).map(({ entry }) => ({
		id: entry.id,
		label: entry.label,
		key: entry.key
	}));
}
/** Marks a request already passing through the auto provider's fallback. */
const delegating = new AsyncLocalStorage();
/**
* Create the provider that searches through PackyCode for PackyCode sessions
* only. Every other request goes to the fallback provider: the search provider
* the web row selected before this plugin's patch, or DSH's built-in search.
*
* Another plugin's router may delegate back to this one (its own fallback is
* the web row's base, which this plugin's patch points here). A request that
* re-enters while already delegating goes straight to DSH's built-in search
* instead of looping.
* @param options - the PackyCode provider, the initiating model provider, a
*   lookup of registered search providers, and the fallback id.
* @returns a DSH web search provider.
*/
function createPackyCodeAutoSearchProvider({ packycode, resolveModelProvider, resolveProvider, resolveFallbackId }) {
	return Object.freeze({
		id: PACKYCODE_AUTO_SEARCH_PROVIDER_ID,
		available: () => true,
		async search(request, signal) {
			if (resolveModelProvider?.() === "packycode") return packycode.search(request, signal);
			const wanted = delegating.getStore() === true ? DSH_SEARCH_PROVIDER_FALLBACK : resolveFallbackId?.() ?? "deepseek-official";
			const id = OWN_SEARCH_PROVIDER_IDS.includes(wanted) ? DSH_SEARCH_PROVIDER_FALLBACK : wanted;
			const provider = resolveProvider?.(id);
			if (provider === void 0 || OWN_SEARCH_PROVIDER_IDS.includes(provider.id) || provider.available?.() !== true) throw new WebError(`PackyCode auto search: the fallback search provider "${id}" is unavailable`, "WEB_PROVIDER_UNAVAILABLE");
			return delegating.run(true, () => provider.search(request, signal));
		}
	});
}
//#endregion
//#region src/search-composition.js
/**
* Point the DSH web row's base search provider at this plugin.
*
* The web runtime has one search slot. Subscription plugins (Codex, Kimi)
* rewrite that slot at runtime whenever the web row restarts, and fall back to
* the row's *base* config for models they do not own. Writing the runtime slot
* here as well would make two switchers restart each other forever. Instead
* this plugin keeps one marked `- id: web` entry in the owning profile's
* `cordis.patch.yml`: the boot layer hot-applies the file, the base config then
* names a PackyCode provider, and every router — or the bare slot, when no
* router holds it — reaches PackyCode for the requests it does not own.
*
* Only the marked entry is ever touched. It is rewritten in place, so a
* sibling plugin that appends its own entry after it never sees this file
* reorder; an unchanged entry is never rewritten. A profile patch replaces the
* whole matched config, so the entry restates the web row's other scalar
* fields. It also records, as a comment, the provider the base named before
* the entry existed, which is where the auto provider sends requests it does
* not serve.
*
* @module dsh-packycode-api/search-composition
*/
const SEARCH_PATCH_FILE = "cordis.patch.yml";
const BLOCK_BEGIN = "# >>> dsh-packycode-api: web search provider (managed in Settings → PackyCode → Web search)";
const BLOCK_END = "# <<< dsh-packycode-api: web search provider";
const BEGIN_PREFIX = "# >>> dsh-packycode-api: web search provider";
const FALLBACK_LINE = /^#\s*fallback:\s*(\S+)\s*$/u;
const PROVIDER_ID = /^[A-Za-z0-9._-]+$/u;
const EMPTY_LIST = /^\[\]\s*$/u;
const LIST_ITEM = /^-(?:\s|$)/u;
const ITEM_HEAD = /^- id: web\s*$/u;
const CONTINUATION = /^\s+\S/u;
const isBegin = (line) => line.trim().startsWith(BEGIN_PREFIX);
const isEnd = (line) => line.trim() === BLOCK_END;
/**
* Find this plugin's entry: the begin marker, its comment lines, the single
* `- id: web` item with its indented lines, and an end marker directly after.
* Anything else — including another entry a YAML rewrite moved inside the
* markers — is not part of it.
* @param lines - the file split into lines.
* @returns the half-open line range and the recorded fallback, or undefined.
*/
function locate(lines) {
	const start = lines.findIndex(isBegin);
	if (start < 0) return void 0;
	let index = start + 1;
	let fallback;
	while (index < lines.length && lines[index].startsWith("#") && !isEnd(lines[index]) && !isBegin(lines[index])) {
		const match = FALLBACK_LINE.exec(lines[index]);
		if (match !== null) fallback = match[1];
		index += 1;
	}
	let provider;
	if (index < lines.length && ITEM_HEAD.test(lines[index])) {
		index += 1;
		while (index < lines.length && CONTINUATION.test(lines[index])) {
			const match = /^\s+searchProvider:\s*['"]?([A-Za-z0-9._-]+)['"]?\s*$/u.exec(lines[index]);
			if (match !== null) provider = match[1];
			index += 1;
		}
	}
	if (index < lines.length && isEnd(lines[index])) index += 1;
	return {
		start,
		end: index,
		fallback,
		provider
	};
}
/** Drop the located entry and any stray end marker left elsewhere. */
function strip(lines) {
	const found = locate(lines);
	return (found === void 0 ? [...lines] : [...lines.slice(0, found.start), ...lines.slice(found.end)]).filter((line) => !isEnd(line));
}
function yamlScalar(value) {
	if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return String(value);
	return /^[A-Za-z0-9._-]+$/u.test(value) ? value : JSON.stringify(value);
}
/** The entry's lines; the web row's other scalar fields are restated, sorted. */
function entryLines(providerId, fallback, baseConfig) {
	const fields = {};
	for (const [key, value] of Object.entries(baseConfig ?? {})) {
		if (key === "searchProvider" || !/^[A-Za-z0-9_]+$/u.test(key)) continue;
		if (typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) fields[key] = value;
	}
	fields.searchProvider = providerId;
	return [
		BLOCK_BEGIN,
		`# fallback: ${fallback}`,
		"- id: web",
		"  config:",
		...Object.keys(fields).sort().map((key) => `    ${key}: ${yamlScalar(fields[key])}`),
		BLOCK_END
	];
}
/** A provider id the auto provider may fall back to. */
function usableFallback(id) {
	return typeof id === "string" && PROVIDER_ID.test(id) && !OWN_SEARCH_PROVIDER_IDS.includes(id) ? id : DSH_SEARCH_PROVIDER_FALLBACK;
}
/**
* Refuse a file this line-level editor cannot extend safely: a flow sequence
* with entries, or a top-level line that is not a list item or comment.
*/
function assertBlockSequence(lines) {
	for (const line of lines) {
		if (line.trim() === "" || line.trimStart().startsWith("#") || CONTINUATION.test(line) || LIST_ITEM.test(line) || EMPTY_LIST.test(line)) continue;
		throw new Error("PackyCode web search could not edit the profile patch: it is not a plain YAML list; set the web search provider by hand");
	}
}
/**
* Maintain this plugin's entry in the owning profile's patch file.
* @param options - where the file is, the web row's current base config, an
*   optional exclusive section (DSH's reload lock), and file-system seams.
* @returns the composition: read the entry, apply a provider, remove it.
*/
function createSearchComposition({ resolvePatchPath, readBaseConfig, runExclusive = (run) => run(), fs = {
	readFile,
	writeFile,
	rename
} } = {}) {
	if (typeof resolvePatchPath !== "function") throw new Error("PackyCode search composition requires resolvePatchPath");
	if (typeof readBaseConfig !== "function") throw new Error("PackyCode search composition requires readBaseConfig");
	let chain = Promise.resolve();
	const serialized = (run) => {
		const next = chain.then(() => runExclusive(run));
		chain = next.then(() => void 0, () => void 0);
		return next;
	};
	const load = async () => {
		const path = await resolvePatchPath();
		if (typeof path !== "string" || path === "") throw new Error("PackyCode web search could not find the profile patch file");
		let content = "";
		try {
			content = await fs.readFile(path, "utf8");
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		const eol = content.includes("\r\n") ? "\r\n" : "\n";
		const lines = content === "" ? [] : content.split(/\r?\n/u);
		if (lines.length > 0 && lines.at(-1) === "") lines.pop();
		return {
			path,
			content,
			eol,
			lines
		};
	};
	const render = ({ eol }, lines) => lines.length === 0 ? "" : `${lines.join(eol)}${eol}`;
	const save = async (file, lines) => {
		const next = render(file, lines);
		if (next === file.content) return false;
		const temporary = `${file.path}.packycode-api.tmp`;
		await fs.writeFile(temporary, next, { mode: 384 });
		await fs.rename(temporary, file.path);
		return true;
	};
	/** The file with this plugin's entry pointing at `providerId`. */
	const applied = (file, providerId) => {
		const found = locate(file.lines);
		assertBlockSequence(found === void 0 ? file.lines : [...file.lines.slice(0, found.start), ...file.lines.slice(found.end)]);
		const base = readBaseConfig() ?? {};
		const fallback = found?.fallback !== void 0 ? usableFallback(found.fallback) : usableFallback(base.searchProvider);
		const entry = entryLines(providerId, fallback, base);
		if (found !== void 0) {
			const before = file.lines.slice(0, found.start).filter((line) => !isEnd(line));
			const after = file.lines.slice(found.end).filter((line) => !isEnd(line));
			while (after.length > 0 && after.at(-1).trim() === "") after.pop();
			return {
				fallback,
				lines: [
					...before,
					...entry,
					...after
				]
			};
		}
		const lines = file.lines.filter((line) => !EMPTY_LIST.test(line) && !isEnd(line));
		while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
		return {
			fallback,
			lines: [...lines, ...entry]
		};
	};
	/** The file without this plugin's entry, or undefined when it holds none. */
	const removed = (file) => {
		if (locate(file.lines) === void 0 && !file.lines.some(isEnd)) return void 0;
		const lines = strip(file.lines);
		while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
		if (!lines.some((line) => LIST_ITEM.test(line)) && !lines.some((line) => EMPTY_LIST.test(line))) lines.push("[]");
		return lines;
	};
	return Object.freeze({
		/** The entry as the file holds it now. */
		async read() {
			const { lines } = await load();
			const found = locate(lines);
			return found === void 0 ? { present: false } : {
				present: true,
				provider: found.provider,
				fallback: usableFallback(found.fallback)
			};
		},
		/**
		* Point the base search provider at `providerId`, keeping the recorded
		* fallback when the entry already exists.
		* @returns whether the file changed, and the fallback the entry records.
		*/
		async apply(providerId) {
			if (!OWN_SEARCH_PROVIDER_IDS.includes(providerId)) throw new Error(`PackyCode web search cannot select "${String(providerId)}"`);
			const current = await load();
			const planned = applied(current, providerId);
			if (render(current, planned.lines) === current.content) return {
				changed: false,
				fallback: planned.fallback
			};
			return serialized(async () => {
				const file = await load();
				const next = applied(file, providerId);
				return {
					changed: await save(file, next.lines),
					fallback: next.fallback
				};
			});
		},
		/** Remove the entry, leaving an empty list when nothing else remains. */
		async remove() {
			if (removed(await load()) === void 0) return { changed: false };
			return serialized(async () => {
				const file = await load();
				const lines = removed(file);
				return { changed: lines === void 0 ? false : await save(file, lines) };
			});
		}
	});
}
/**
* Run `operation` inside DSH's reload transaction, so a patch write never
* overlaps a profile reload or a settings write. A reconcile started from
* inside one of those (a web restart during a reload, a volatile update
* during a settings write) inherits its context, and DSH refuses to nest the
* transaction; that one runs unlocked, after the transaction that started it.
* @param hmr - DSH's `hmr` service, when the host has one.
* @param operation - the write.
* @returns the operation's result.
*/
async function runInReloadTransaction(hmr, operation) {
	if (typeof hmr?.runExclusive !== "function") return operation();
	let started = false;
	try {
		return await hmr.runExclusive(() => {
			started = true;
			return operation();
		});
	} catch (error) {
		if (!started && /cannot be nested/u.test(error?.message ?? "")) return operation();
		throw error;
	}
}
/**
* The composition for the profile this plugin runs in.
* @param options - the plugin context (for `profileContext` and `hmr`), the
*   web row's Loader entry, and where to look for the owning profile when the
*   host does not name its patch file.
* @returns the composition.
*/
function createProfileSearchComposition({ ctx, webEntry, dshHome, ownPackageJsonUrl }) {
	return createSearchComposition({
		resolvePatchPath: async () => {
			const profile = ctx.get?.("profileContext");
			if (typeof profile?.patchPath === "string" && profile.patchPath !== "") return profile.patchPath;
			const install = await findInstall({
				dshHome,
				ownPackageJsonUrl
			});
			return install.profile === void 0 ? void 0 : join(dshHome, "profiles", install.profile, SEARCH_PATCH_FILE);
		},
		readBaseConfig: () => webEntry()?.options?.config ?? {},
		runExclusive: (operation) => runInReloadTransaction(ctx.get?.("hmr"), operation)
	});
}
//#endregion
//#region src/search-controller.js
/**
* Web search wiring: the two search providers, the user's routing and backend
* preference, the profile-patch entry that makes DSH reach them, and the
* projection the settings panel reads.
*
* @module dsh-packycode-api/search-controller
*/
/** Routers other subscription plugins register; shown so the user knows who holds the slot. */
const FOREIGN_ROUTERS = Object.freeze({
	codex: "codex-subscription-auto",
	kimi: "kimi-subscription-auto"
});
/** Normalize a stored preference; anything unknown reads as the default. */
function readSearchChoice(value) {
	const provider = fieldValue(value?.searchProvider);
	const selectedBackend = fieldValue(value?.searchBackend);
	return {
		mode: SEARCH_MODES.includes(provider) ? provider : SEARCH_MODE_DEFAULT,
		backend: SEARCH_BACKENDS.includes(selectedBackend) ? selectedBackend : DEFAULT_SEARCH_BACKEND
	};
}
/** Only sentences this plugin wrote reach the browser. */
function safeMessage(error) {
	const message = error instanceof Error ? error.message : String(error);
	return /^PackyCode /u.test(message) ? message.slice(0, 240) : "PackyCode web search could not update the profile patch";
}
/**
* @param options - the key ring and hosts the search runs with, the key-failure
*   sink and group coverage shared with the model route, the preference reader
*   and writer, the initiating session's provider and id, the web row's Loader
*   entry, the profile-patch composition, a logger, and an optional fetch.
*/
function createSearchController({ ring, hosts, onKeyFailure, covers, readPreference, writePreference, isWritable = () => typeof writePreference === "function", resolveModelProvider, resolveSessionId, webEntry = () => void 0, composition, logger, fetchImpl }) {
	let web;
	let fallbackId;
	let applied = { state: "idle" };
	let chain = Promise.resolve();
	const preference = () => readSearchChoice(readPreference?.());
	const packycode = createPackyCodeSearchProvider({
		ring,
		hosts,
		backend: () => preference().backend,
		onKeyFailure,
		covers,
		resolveSessionId,
		...fetchImpl === void 0 ? {} : { fetchImpl }
	});
	const auto = createPackyCodeAutoSearchProvider({
		packycode,
		resolveModelProvider,
		resolveProvider: (id) => web?.searchProviders?.get?.(id),
		resolveFallbackId: () => fallbackId ?? usableFallback(webEntry()?.options?.config?.searchProvider)
	});
	/** Make the profile patch match the preference; serialized, idempotent. */
	const reconcile = () => {
		const run = async () => {
			if (web === void 0 || composition === void 0) {
				applied = { state: "unavailable" };
				return;
			}
			const { mode } = preference();
			try {
				if (mode === "default") {
					await composition.remove();
					fallbackId = void 0;
					applied = { state: "removed" };
				} else {
					const outcome = await composition.apply(mode === "auto" ? PACKYCODE_AUTO_SEARCH_PROVIDER_ID : PACKYCODE_SEARCH_PROVIDER_ID);
					fallbackId = outcome.fallback;
					applied = {
						state: "applied",
						fallback: outcome.fallback
					};
				}
			} catch (error) {
				applied = {
					state: "failed",
					error: safeMessage(error)
				};
				logger?.warn?.("packycode-api: could not apply the web search selection: %s", error?.message ?? String(error));
			}
		};
		const next = chain.then(run);
		chain = next.then(() => void 0, () => void 0);
		return next;
	};
	const status = () => {
		const { mode, backend } = preference();
		const entry = webEntry();
		const base = entry?.options?.config?.searchProvider;
		const runtime = entry?.fiber?.config?.searchProvider;
		return {
			searchProvider: mode,
			searchBackend: backend,
			writable: isWritable() === true,
			available: web !== void 0,
			models: { ...SEARCH_BACKEND_MODELS },
			effective: {
				...typeof base === "string" ? { base } : {},
				...typeof runtime === "string" ? { runtime } : {}
			},
			applied: { ...applied },
			foreign: Object.fromEntries(Object.entries(FOREIGN_ROUTERS).map(([name, id]) => [name, web?.searchProviders?.has?.(id) === true]))
		};
	};
	return Object.freeze({
		packycode,
		auto,
		/**
		* Register both providers with the web service and reconcile once.
		* @param service - the `web` service, as the inject scope hands it over.
		* @param effect - that scope's effect registrar.
		*/
		register(service, effect) {
			effect(() => {
				web = service;
				const disposePackycode = service.registerSearchProvider(packycode);
				const disposeAuto = service.registerSearchProvider(auto);
				return () => {
					disposeAuto?.();
					disposePackycode?.();
					if (web === service) web = void 0;
				};
			}, "packycode-api: web search providers");
			reconcile();
		},
		reconcile,
		status,
		/** Validate, persist, and apply a preference change. */
		async update(patch) {
			const next = {};
			if (patch?.searchProvider !== void 0) {
				if (!SEARCH_MODES.includes(patch.searchProvider)) throw new Error("That PackyCode search option is not supported");
				next.searchProvider = patch.searchProvider;
			}
			if (patch?.searchBackend !== void 0) {
				if (!SEARCH_BACKENDS.includes(patch.searchBackend)) throw new Error("That PackyCode search backend is not supported");
				next.searchBackend = patch.searchBackend;
			}
			if (Object.keys(next).length === 0) return status();
			if (isWritable() !== true || typeof writePreference !== "function") throw new Error("PackyCode settings are not writable in this profile");
			try {
				await writePreference(next);
			} catch (error) {
				logger?.warn?.("packycode-api: could not save the web search preference: %s", error?.message ?? String(error));
				throw new Error("PackyCode could not save the web search preference", { cause: error });
			}
			await reconcile();
			return status();
		}
	});
}
//#endregion
//#region src/index.js
/**
* dsh-packycode-api — a self-contained PackyCode route for DeepSeek Harness.
*
* The plugin builds its own pi-ai provider, model catalog, key ring, balance
* and group readers, then registers the route through the same public
* `llm.registerAdapter` API the shipped adapters use. Nothing here reads the
* profile's composition config, so installing the package is the whole setup:
* the picker shows the models and the user only pastes API keys.
*
* This module only composes; each concern lives in its own module.
*
* @module dsh-packycode-api
*/
const name = PLUGIN_ID;
/**
* Only the model route is mandatory. `settings`, `web`, `connection`, and
* `tools` are requested through `ctx.inject`: a profile without them (a
* headless run, for one) must still boot with a working route instead of
* blocking on a service it will never see.
*/
const inject = ["llm", "credentials"];
/** Host overrides and preferences; a profile that never sets them keeps the defaults. */
const Config = z.object({
	apiHost: z.string().default(DEFAULT_API_HOST),
	statusHost: z.string().default(DEFAULT_STATUS_HOST),
	/**
	* Web search routing: `default` leaves DSH's search alone, `auto` searches
	* through PackyCode for PackyCode sessions only, `packycode` for every
	* request DSH's own search would have served.
	*/
	searchProvider: live(z.union([...SEARCH_MODES]).default(SEARCH_MODE_DEFAULT)),
	/** Which PackyCode model runs a search: `deepseek` or `gpt`. */
	searchBackend: live(z.union([...SEARCH_BACKENDS]).default(DEFAULT_SEARCH_BACKEND)),
	/** Only the picker is filtered; an existing session can keep its model. */
	hiddenModels: live(z.array(z.string()).default([])),
	imageEnabled: live(z.boolean().default(true)),
	imageModel: live(z.union([...IMAGE_MODEL_IDS]).default(DEFAULT_IMAGE_MODEL)),
	imageQuality: live(z.union([...IMAGE_QUALITIES]).default("auto"))
});
function apply(ctx, config) {
	const ring = new PackyCodeKeyRing(ctx.credentials);
	const imageRing = new PackyCodeKeyRing(ctx.credentials, { recordId: IMAGE_KEY_RECORD_ID });
	let source = () => ({
		apiHost: normalizeHost(config?.apiHost, DEFAULT_API_HOST),
		statusHost: normalizeHost(config?.statusHost, DEFAULT_STATUS_HOST),
		searchProvider: fieldValue(config?.searchProvider),
		searchBackend: fieldValue(config?.searchBackend),
		hiddenModels: fieldValue(config?.hiddenModels),
		imageEnabled: fieldValue(config?.imageEnabled),
		imageModel: fieldValue(config?.imageModel),
		imageQuality: fieldValue(config?.imageQuality)
	});
	const hosts = () => {
		const current = source() ?? {};
		return {
			apiHost: normalizeHost(current.apiHost, DEFAULT_API_HOST),
			statusHost: normalizeHost(current.statusHost, DEFAULT_STATUS_HOST)
		};
	};
	const balance = createBalanceReader({
		listKeys: () => ring.secrets(),
		getHosts: hosts
	});
	const imageBalance = createBalanceReader({
		listKeys: () => imageRing.secrets(),
		getHosts: hosts
	});
	/**
	* Which token groups each key is in, and so which models it can reach.
	* Nothing reads it at boot: the settings panel asks for it, and a request
	* with a choice of keys waits briefly for the first reading.
	*/
	const groups = createGroupReader({
		listKeys: () => ring.secrets(),
		getHosts: hosts
	});
	const keys = createKeyChooser({
		ring,
		groups,
		logger: ctx.logger,
		onRotated: () => balance.invalidate()
	});
	/** The session of the agent this turn runs for, when one is in scope. */
	const currentSession = () => {
		try {
			return ctx.get?.("agents")?.currentInitiator?.()?.session;
		} catch {
			return;
		}
	};
	/** One Loader entry by row id, or undefined outside a Loader composition. */
	const loaderEntry = (id) => {
		try {
			return [...ctx.get?.("loader")?.entries?.() ?? []].find((entry) => entry?.options?.id === id);
		} catch {
			return;
		}
	};
	const fallbackSessionId = `${PLUGIN_ID}-${randomUUID()}`;
	const attachments = () => ctx.get?.("attachments") ?? ctx.attachments;
	const modelPreference = {
		writable: false,
		set: void 0
	};
	let refreshModels = () => {};
	const modelSelection = createModelSelectionController({
		readPreference: () => source() ?? {},
		writePreference: (patch) => modelPreference.set(patch),
		isWritable: () => modelPreference.writable === true && typeof modelPreference.set === "function",
		onChange: () => refreshModels()
	});
	const registration = ctx.llm.registerAdapter([PROVIDER], createRouteAdapter({
		ring,
		keys,
		fallbackSessionId,
		resolveAttachments: attachments,
		isModelVisible: modelSelection.isVisible,
		resolveWorkingDirectory: (sessionId) => {
			const session = currentSession();
			return session && (sessionId === void 0 || session.id === sessionId) ? session.header?.cwd : void 0;
		}
	}));
	refreshModels = () => {
		if (typeof registration?.replace === "function") registration.replace([PROVIDER]);
		else ctx.emit?.("llm/adapters-updated");
	};
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: DISPLAY_NAME,
		settingsNs: SETTINGS_NAMESPACE,
		settingsPath: []
	}]);
	const hostPreference = unwritable("PackyCode host overrides are not writable in this profile");
	const searchPreference = {
		writable: false,
		set: void 0
	};
	const imagePreference = {
		writable: false,
		set: void 0
	};
	const dshHome = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
	const images = createImageController({
		ring: imageRing,
		balance: imageBalance,
		readPreference: () => source() ?? {},
		writePreference: (patch) => imagePreference.set(patch),
		isWritable: () => imagePreference.writable === true && typeof imagePreference.set === "function"
	});
	const imageClient = createPackyCodeImageClient({
		resolveKey: () => imageRing.activeKey(),
		getHost: () => hosts().apiHost
	});
	const search = createSearchController({
		ring,
		hosts,
		onKeyFailure: keys.onKeyFailure,
		covers: keys.covers,
		readPreference: () => source() ?? {},
		writePreference: (patch) => searchPreference.set(patch),
		isWritable: () => searchPreference.writable === true && typeof searchPreference.set === "function",
		resolveModelProvider: () => {
			try {
				return currentSession()?.requestContext?.()?.provider;
			} catch {
				return;
			}
		},
		resolveSessionId: () => {
			const id = currentSession()?.id;
			return typeof id === "string" && id !== "" ? id : fallbackSessionId;
		},
		webEntry: () => loaderEntry("web"),
		composition: createProfileSearchComposition({
			ctx,
			webEntry: () => loaderEntry("web"),
			dshHome,
			ownPackageJsonUrl: new URL("../package.json", import.meta.url)
		}),
		logger: ctx.logger
	});
	ctx.inject(["settings"], (settingsCtx) => connectSettings(settingsCtx, {
		ctx,
		Config,
		namespace: SETTINGS_NAMESPACE,
		source: () => source(),
		setSource: (next) => {
			source = next;
		},
		onChange: () => {
			balance.invalidate();
			imageBalance.invalidate();
			groups.invalidate();
			modelSelection.reconcile();
			images.reconcile().catch(() => void 0);
			search.reconcile();
		},
		hostPreference,
		searchPreference,
		modelPreference,
		imagePreference
	}));
	ctx.on?.("loader/volatile-update", () => {
		modelSelection.reconcile();
		images.reconcile().catch(() => void 0);
		search.reconcile();
	});
	/**
	* Both search providers register with the web service whenever one exists.
	* Registration alone changes nothing; the preference decides whether the
	* profile patch points DSH at them.
	*/
	ctx.inject(["web"], (webCtx) => {
		if (typeof webCtx.web?.registerSearchProvider !== "function") return;
		const scope = typeof webCtx.effect === "function" ? webCtx : ctx;
		search.register(webCtx.web, (callback, label) => scope.effect(callback, label));
	});
	keys.remember().catch(() => void 0);
	/** One session's events from DSH's session query service, without projections. */
	const readSessionEvents = async (sessionId, signal) => {
		const query = ctx.get?.("sessionQuery");
		if (typeof query?.observeSession === "function") {
			const observation = await query.observeSession(sessionId, {
				signal,
				projectionMode: "none"
			});
			try {
				return [...observation.events];
			} finally {
				observation[Symbol.dispose]();
			}
		}
		if (typeof query?.readSession === "function") return (await query.readSession(sessionId)).events;
		return [];
	};
	const handler = createPackyCodeRpc({
		ring,
		balance,
		groups,
		hosts,
		preference: hostPreference,
		pluginManager: createPackyCodePluginManager(),
		search,
		modelSelection,
		images,
		imageOriginals: createImageOriginalReader({
			imageDirectory: join(dshHome, "packycode-api", "images"),
			getSessionEvents: readSessionEvents
		}),
		diagnostics: createDiagnostics({
			sessionQuery: () => ctx.get?.("sessionQuery"),
			readEvents: readSessionEvents,
			ring,
			groups,
			secrets: async () => (await Promise.all([ring.secrets(), imageRing.secrets()])).flat().map((entry) => entry.key),
			ownPackageJsonUrl: new URL("../package.json", import.meta.url)
		})
	});
	/**
	* The shipped Connection getter retains its own service context, whose row
	* need not inject webServer. Register with our injected context explicitly:
	* a first hot install then mounts the channel without rebuilding Connection.
	* The native registry still owns admission and the wire protocol. Its
	* explicit-owner entry is internal, so retain the public RPC contract for
	* other Connection implementations. A headless profile can omit this scope.
	*/
	ctx.inject(["connection", "webServer"], (connectionCtx) => {
		const service = connectionCtx.connection;
		connectionCtx.effect(() => typeof service.register === "function" ? service.register(connectionCtx, CHANNEL, handler) : service.rpc.handle(CHANNEL, handler), "packycode-api: loopback account RPC");
	});
	ctx.inject(["tools", "attachments"], (imageCtx) => {
		const store = imageCtx.attachments;
		if (typeof store?.saveImage !== "function" || typeof store?.readImage !== "function") return;
		(typeof imageCtx.effect === "function" ? imageCtx : ctx).effect(() => images.mount(() => imageCtx.tools.register(createPackyCodeImageTool({
			client: imageClient,
			attachments: store,
			getPreference: images.preference,
			onGenerated: () => imageBalance.invalidate(),
			getSessionMessages: (id) => ctx.get?.("sessions")?.get?.(id)?.deriveMessages?.() ?? [],
			imageDirectory: join(dshHome, "packycode-api", "images")
		}))), "packycode-api: image tool availability");
	});
}
//#endregion
export { CHANNEL, Config, DEFAULT_API_HOST, DEFAULT_IMAGE_MODEL, DEFAULT_SEARCH_BACKEND, DEFAULT_STATUS_HOST, DIAGNOSTICS_FORMAT, DIAGNOSTICS_LIMITS, DISPLAY_NAME, IMAGE_MODELS, IMAGE_MODEL_IDS, IMAGE_QUALITIES, IMAGE_TIMEOUT_MS, IMAGE_TOOL_NAME, LEGACY_STATUS_HOSTS, MAX_IMAGE_BYTES, PACKYCODE_AUTO_SEARCH_PROVIDER_ID, PACKYCODE_MODELS, PACKYCODE_MODEL_IDS, PACKYCODE_SEARCH_PROVIDER_ID, PLUGIN_ID, PROVIDER, PackyCodeKeyRing, SEARCH_BACKENDS, SEARCH_BACKEND_MODELS, SEARCH_MODES, SETTINGS_NAMESPACE, TEST_MESSAGE_POLICY_CODE, apply, assertApiKey, buildSearchRequest, catalogCoverage, classifyClientPolicy, classifyGatewayFailure, classifyTestMessagePolicy, classifyUpstreamServerError, createBalanceReader, createDiagnostics, createGroupReader, createImageController, createKeyChooser, createModelSelectionController, createPackyCodeAutoSearchProvider, createPackyCodeImageClient, createPackyCodeImageTool, createPackyCodeProfile, createPackyCodeProvider, createPackyCodeRpc, createPackyCodeSearchProvider, createProfileSearchComposition, createRouteAdapter, createSearchComposition, createSearchController, decodeImagePng, explainClientPolicyFailure, explainTestMessagePolicyFailure, guardKeyRotation, inject, name, normalizeFailureMessage, normalizeHost, parseMessagesSearchResponse, parsePricing, parseResponsesSearchResponse, parseSelectedGroups, parseTokenUsage, pickKeyForModel, pngDimensions, readHiddenModels, readImagePreference, readSearchChoice, statusHostOrder, summarizeSessionEvents, validateImageOptions };
