import { randomUUID } from "node:crypto";
import { LlmError, QUOTA_EXCEEDED_CODE, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import z from "@deepseek-ai/schemastery";
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
/** Opus 5.5 and GPT-6.1 Sol cannot disable reasoning, so `off` is pinned unsupported. */
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
/** The key's quota is exhausted; move to the next key. */
const QUOTA_FAILURE = "quota";
/** The gateway rejected the key itself; move to the next key. */
const INVALID_KEY_FAILURE = "invalid-key";
/**
* Classify a gateway failure message.
*
* Quota wording wins over a status token: an exhausted balance is often
* reported as 402/403, and only the key's own rejection may read as 401.
* @param message - provider failure text, as pi-ai carries it.
* @returns the failure kind, or undefined when the key is not at fault.
*/
function classifyGatewayFailure(message) {
	const text = typeof message === "string" ? message : "";
	if (text === "") return void 0;
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
function normalizeFailureMessage(message, kind) {
	const text = typeof message === "string" && message.length > 0 ? message : "PackyCode request failed";
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
* balance projection the host built, and host overrides. Key material never
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
* @param options - the key ring, balance reader, and host preference.
* @returns a handler for `connection.rpc.handle(CHANNEL, handler)`.
*/
function createPackyCodeRpc({ ring, balance, hosts, preference }) {
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
	statusHost: z.string().default(DEFAULT_STATUS_HOST)
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
	const adapter = new PiAiAdapter({
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
		preference
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
}
//#endregion
export { CHANNEL, Config, DEFAULT_API_HOST, DEFAULT_STATUS_HOST, DISPLAY_NAME, PACKYCODE_MODELS, PACKYCODE_MODEL_IDS, PLUGIN_ID, PROVIDER, PackyCodeKeyRing, SETTINGS_NAMESPACE, apply, assertApiKey, classifyGatewayFailure, createBalanceReader, createPackyCodeProfile, createPackyCodeProvider, createPackyCodeRpc, guardKeyRotation, inject, name, normalizeFailureMessage, normalizeHost, parseBillingSubscription, parseBillingUsage, parseTokenUsage };
