window.__ModuleLoader__.load({
	id: "dsh-packycode-api",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/totals.js
		/**
		* Totals across the keys a balance read returned.
		*
		* The per-key quota (`/api/usage/token/`) is what a key can spend, so the
		* combined figure is the sum of those rows. PackyCode also reports account
		* level billing (`/v1/dashboard/billing/*`), which is a different scope — it
		* counts every token on the account — and is deliberately not what this sum
		* shows.
		*
		* @module dsh-packycode-api/totals
		*/
		const amount = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
		/**
		* Add up the balance rows the host returned.
		* @param rows - the `keys` array of a balance projection.
		* @returns summed amounts plus the conditions that make a sum incomplete:
		*   keys whose read failed, and keys with no quota limit at all.
		*/
		function sumBalances(rows) {
			const total = {
				keys: 0,
				counted: 0,
				unread: 0,
				unlimited: 0,
				remainingUsd: 0,
				usedUsd: 0,
				limitUsd: 0
			};
			for (const row of Array.isArray(rows) ? rows : []) {
				total.keys += 1;
				const usage = row?.usage;
				if (usage === void 0) {
					total.unread += 1;
					continue;
				}
				total.counted += 1;
				if (usage.unlimitedQuota === true) {
					total.unlimited += 1;
					continue;
				}
				const remaining = amount(usage.availableUsd);
				const used = amount(usage.usedUsd);
				const limit = amount(usage.limitUsd);
				if (remaining !== void 0) total.remainingUsd += remaining;
				if (used !== void 0) total.usedUsd += used;
				if (limit !== void 0) total.limitUsd += limit;
			}
			return total;
		}
		//#endregion
		//#region src/client.jsx
		/**
		* Browser half: the PackyCode settings page and the composer balance chip.
		*
		* Every number here comes from the host over the plugin's own loopback RPC
		* channel; no key material crosses it, and each read is a bounded projection
		* the host built.
		*
		* @module dsh-packycode-api/client
		*/
		const NS = "settings.packyCodeApi";
		const PROVIDER = "packycode";
		const CHANNEL = "/packycode-api";
		const REFRESH_MS = 6e4;
		const zh = {
			nav: "PackyCode",
			intro: "填入 PackyCode（PackyAPI）的 API Key 即可使用内置模型路由；多个 Key 按顺序使用，额度用尽或失效时自动切到下一个。",
			accountTitle: "账户余额",
			totalRemaining: "合计剩余",
			totalUsed: "合计已用",
			totalLimit: "合计额度",
			totalPartial: "有 {count} 个 Key 未读到余额，未计入合计。",
			siteAccount: "PackyCode 账号（含同账号其它用量）",
			accountLimit: "额度",
			refresh: "刷新",
			refreshing: "刷新中…",
			keysTitle: "API Key",
			keysHint: "按顺序使用：当前 Key 不可用时自动切到下一个可用 Key。上方的账户余额按 PackyCode 账户名逐条列出。",
			keyActive: "使用中",
			keyDisabled: "已停用",
			keyUse: "切到此 Key",
			keyEnable: "重新启用",
			keyRemove: "删除",
			keyUnlimited: "不限额度",
			keyNoBalance: "余额未知",
			keyRemaining: "剩余",
			keyUsed: "已用",
			keyName: "账户名",
			keyNameUnknown: "账户名待读取",
			resetMonthly: "每月",
			resetWeekly: "每周",
			resetDaily: "每日",
			addTitle: "添加 Key",
			addKeyPlaceholder: "粘贴 API Key",
			addLabelPlaceholder: "备注（可选）",
			add: "添加",
			removeAll: "清空全部",
			empty: "还没有 Key。添加一个即可在模型选择器里看到 PackyCode 的模型。",
			advanced: "高级：接口地址",
			apiHost: "模型接口地址",
			statusHost: "余额接口地址",
			save: "保存",
			saved: "已保存",
			notWritable: "当前 profile 不允许写入设置，改动只在本次运行内生效。",
			composerLabel: "PackyCode 剩余额度",
			composerNoKey: "无可用 Key",
			error: "读取 PackyCode 状态失败",
			loadFailed: "读取失败"
		};
		const en = {
			nav: "PackyCode",
			intro: "Paste a PackyCode (PackyAPI) API key to use the built-in model route. Multiple keys are used in order; an exhausted or rejected key hands over to the next one.",
			accountTitle: "Account balance",
			totalRemaining: "Total remaining",
			totalUsed: "Total used",
			totalLimit: "Total limit",
			totalPartial: "{count} key(s) could not be read and are not counted here.",
			siteAccount: "PackyCode account (includes this account’s other usage)",
			accountLimit: "Limit",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			keysTitle: "API keys",
			keysHint: "Used in order: when the active key cannot serve a request, the next usable one takes over. The balances above are listed per PackyCode account.",
			keyActive: "Active",
			keyDisabled: "Disabled",
			keyUse: "Use this key",
			keyEnable: "Re-enable",
			keyRemove: "Remove",
			keyUnlimited: "No quota limit",
			keyNoBalance: "Balance unknown",
			keyRemaining: "Remaining",
			keyUsed: "Used",
			keyName: "Account name",
			keyNameUnknown: "Account name not read yet",
			resetMonthly: "monthly",
			resetWeekly: "weekly",
			resetDaily: "daily",
			addTitle: "Add a key",
			addKeyPlaceholder: "Paste API key",
			addLabelPlaceholder: "Label (optional)",
			add: "Add",
			removeAll: "Remove all",
			empty: "No keys yet. Add one and the PackyCode models appear in the model picker.",
			advanced: "Advanced: endpoints",
			apiHost: "Model endpoint",
			statusHost: "Balance endpoint",
			save: "Save",
			saved: "Saved",
			notWritable: "This profile does not allow settings writes; changes apply to this run only.",
			composerLabel: "PackyCode remaining balance",
			composerNoKey: "No usable key",
			error: "Could not read PackyCode status",
			loadFailed: "Read failed"
		};
		const STYLE = `
.packyCodeSection{display:flex;flex-direction:column;gap:16px;font-size:13px;line-height:20px}
.packyCodeIntro{color:var(--dsw-alias-label-secondary)}
.packyCodeCard{display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:12px;background:var(--dsw-alias-bg-module-platform)}
.packyCodeCardHeader{display:flex;align-items:center;justify-content:space-between;gap:12px}
.packyCodeCardTitle{font-weight:600}
.packyCodeFigures{display:flex;flex-wrap:wrap;gap:18px}
.packyCodeFigure{display:flex;flex-direction:column;gap:2px}
.packyCodeFigureLabel{color:var(--dsw-alias-label-tertiary);font-size:12px}
.packyCodeFigureValue{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.packyCodeRows{display:flex;flex-direction:column;gap:10px}
.packyCodeRow{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-module-platform)}
.packyCodeRowMain{display:flex;flex-direction:column;gap:2px;min-width:180px}
.packyCodeRowName{display:flex;align-items:center;gap:8px;font-weight:500}
.packyCodeRowMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
.packyCodeChip{padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.packyCodeChipActive{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-brand-primary,currentColor)}
.packyCodeActions{display:flex;flex-wrap:wrap;gap:8px}
.packyCodeForm{display:flex;flex-wrap:wrap;gap:8px}
.packyCodeInput{flex:1 1 220px;min-width:0;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35));background:var(--dsw-alias-bg-module-platform);color:inherit;font:inherit}
.packyCodeButton{height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35));background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary,inherit);font:inherit;cursor:pointer}
.packyCodeButton:disabled{opacity:.55;cursor:default}
/* Emphasis without a themed fill: the brand colour may be light in either
   theme, and a filled button then hides its own label. */
.packyCodeButtonPrimary{border-color:var(--dsw-alias-brand-primary,currentColor);font-weight:600}
.packyCodeNote{color:var(--dsw-alias-label-tertiary);font-size:12px}
.packyCodeError{color:var(--dsw-alias-state-error-primary,#d9534f);font-size:12px}
.packyCodeAdvanced summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}
.packyCodeAdvancedBody{display:flex;flex-direction:column;gap:10px;padding-top:10px}
.packyCodeField{display:flex;flex-direction:column;gap:4px}
.packyCodeComposer{display:inline-flex;align-items:center;flex:0 0 auto;height:28px;box-sizing:border-box;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;user-select:none}
@media(max-width:640px){.packyCodeRow{align-items:flex-start;flex-direction:column}.packyCodeActions{width:100%}}
`;
		const unwrap = (response) => {
			if (!response?.ok) throw new Error(response?.error?.message ?? "PackyCode RPC failed");
			return response.value;
		};
		function formatUsd(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
			try {
				return new Intl.NumberFormat(void 0, {
					style: "currency",
					currency: "USD"
				}).format(value);
			} catch {
				return `$${value.toFixed(2)}`;
			}
		}
		function resetLabel(period, t) {
			switch (period) {
				case "monthly": return t("resetMonthly");
				case "weekly": return t("resetWeekly");
				case "daily": return t("resetDaily");
				default: return;
			}
		}
		/** Active key's usage row, preferring the key the ring currently points at. */
		function activeUsage(balance) {
			if (balance === void 0) return void 0;
			return balance.keys?.find((entry) => entry.id === balance.activeId) ?? balance.keys?.[0];
		}
		function clearMessage(error) {
			const text = typeof error?.message === "string" && error.message.length > 0 ? error.message : String(error);
			return text.length > 200 ? text.slice(0, 200) : text;
		}
		function PackyCodeSection({ rpc, t }) {
			const call = react.useMemo(() => (endpoint, payload = {}) => rpc.call(CHANNEL, endpoint, payload).then(unwrap), [rpc]);
			const [status, setStatus] = react.useState();
			const [balance, setBalance] = react.useState();
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState();
			const [draft, setDraft] = react.useState({
				key: "",
				label: ""
			});
			const generation = react.useRef(0);
			const load = react.useCallback((force = false) => {
				const current = ++generation.current;
				setBusy(true);
				setError(void 0);
				return Promise.all([call("status"), call("balance", { force })]).then(([nextStatus, nextBalance]) => {
					if (generation.current !== current) return;
					setStatus(nextStatus);
					setBalance(nextBalance);
				}).catch((failure) => {
					if (generation.current === current) setError(clearMessage(failure));
				}).finally(() => {
					if (generation.current === current) setBusy(false);
				});
			}, [call]);
			react.useEffect(() => {
				load(false);
				return () => {
					generation.current += 1;
				};
			}, [load]);
			const mutate = (endpoint) => (payload) => {
				setBusy(true);
				setError(void 0);
				return call(endpoint, payload).then((nextStatus) => {
					setStatus(nextStatus);
					return call("balance", { force: true });
				}).then((nextBalance) => setBalance(nextBalance)).catch((failure) => setError(clearMessage(failure))).finally(() => setBusy(false));
			};
			const addKey = (event) => {
				event.preventDefault();
				if (draft.key.trim() === "") return;
				mutate("keys/add")({
					key: draft.key,
					label: draft.label
				}).then(() => setDraft({
					key: "",
					label: ""
				}));
			};
			const account = balance?.account;
			const rows = balance?.keys ?? [];
			const usageOf = (id) => rows.find((row) => row.id === id);
			const keys = status?.keys ?? [];
			const totals = sumBalances(rows);
			/** One account row: the PackyCode token name carries the match to a key. */
			const accountRow = (row) => {
				const usage = row.usage;
				const figures = [
					usage?.unlimitedQuota === true ? t("keyUnlimited") : usage?.availableUsd === void 0 ? void 0 : `${t("keyRemaining")} ${formatUsd(usage.availableUsd)}`,
					usage?.usedUsd === void 0 ? void 0 : `${t("keyUsed")} ${formatUsd(usage.usedUsd)}`,
					usage?.limitUsd === void 0 ? void 0 : `${t("accountLimit")} ${formatUsd(usage.limitUsd)}`,
					resetLabel(usage?.resetPeriod, t) === void 0 ? void 0 : resetLabel(usage.resetPeriod, t)
				].filter(Boolean);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "packyCodeRow",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "packyCodeRowMain",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "packyCodeRowName",
							children: [
								usage?.name ?? row.label,
								row.id === status?.activeId && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "packyCodeChip packyCodeChipActive",
									children: t("keyActive")
								}),
								row.disabled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "packyCodeChip",
									children: t("keyDisabled")
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "packyCodeRowMeta",
							children: figures.length > 0 ? figures.join(" · ") : row.error === void 0 ? t("keyNoBalance") : `${t("loadFailed")}: ${row.error}`
						})]
					})
				}, row.id);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "packyCodeSection",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "packyCodeIntro",
						children: t("intro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "packyCodeCard",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
								className: "packyCodeCardHeader",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "packyCodeCardTitle",
									children: t("accountTitle")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "packyCodeButton",
									disabled: busy,
									onClick: () => load(true),
									children: busy ? t("refreshing") : t("refresh")
								})]
							}),
							rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "packyCodeNote",
								children: t("empty")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "packyCodeRows",
								children: rows.map(accountRow)
							}),
							rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "packyCodeNote",
								children: t("empty")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "packyCodeFigures",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "packyCodeFigure",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "packyCodeFigureLabel",
												children: t("totalRemaining")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "packyCodeFigureValue",
												children: [totals.counted === 0 ? "—" : formatUsd(totals.remainingUsd) ?? "—", totals.unlimited > 0 && ` + ${t("keyUnlimited")}`]
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "packyCodeFigure",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "packyCodeFigureLabel",
												children: t("totalUsed")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "packyCodeFigureValue",
												children: totals.counted === 0 ? "—" : formatUsd(totals.usedUsd) ?? "—"
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "packyCodeFigure",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "packyCodeFigureLabel",
												children: t("totalLimit")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "packyCodeFigureValue",
												children: totals.counted === 0 || totals.unlimited > 0 ? t("keyUnlimited") : formatUsd(totals.limitUsd) ?? "—"
											})]
										})
									]
								}),
								totals.unread > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "packyCodeNote",
									children: t("totalPartial").replace("{count}", String(totals.unread))
								}),
								account?.error === void 0 && account !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "packyCodeNote",
									children: `${t("siteAccount")}：${t("keyRemaining")} ${formatUsd(account.remainingUsd) ?? "—"} · ${t("keyUsed")} ${formatUsd(account.totalUsageUsd) ?? "—"} · ${t("accountLimit")} ${formatUsd(account.hardLimitUsd) ?? "—"}`
								})
							] })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "packyCodeCard",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
								className: "packyCodeCardHeader",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "packyCodeCardTitle",
									children: t("keysTitle")
								}), keys.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "packyCodeButton",
									disabled: busy,
									onClick: () => mutate("keys/remove-all")({}),
									children: t("removeAll")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "packyCodeNote",
								children: t("keysHint")
							}),
							keys.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "packyCodeNote",
								children: t("empty")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "packyCodeRows",
								children: keys.map((key) => {
									const row = usageOf(key.id);
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "packyCodeRow",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "packyCodeRowMain",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "packyCodeRowName",
												children: [
													key.label,
													key.active && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "packyCodeChip packyCodeChipActive",
														children: t("keyActive")
													}),
													key.disabled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "packyCodeChip",
														children: `${t("keyDisabled")}: ${key.disabledReason ?? ""}`.trim()
													})
												]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "packyCodeRowMeta",
												children: row?.usage?.name === void 0 ? t("keyNameUnknown") : `${t("keyName")} ${row.usage.name}`
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "packyCodeActions",
											children: [
												!key.active && !key.disabled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "packyCodeButton",
													disabled: busy,
													onClick: () => mutate("keys/select")({ id: key.id }),
													children: t("keyUse")
												}),
												key.disabled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "packyCodeButton",
													disabled: busy,
													onClick: () => mutate("keys/enable")({ id: key.id }),
													children: t("keyEnable")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "packyCodeButton",
													disabled: busy,
													onClick: () => mutate("keys/remove")({ id: key.id }),
													children: t("keyRemove")
												})
											]
										})]
									}, key.id);
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
								className: "packyCodeForm",
								onSubmit: addKey,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										className: "packyCodeInput",
										type: "password",
										autoComplete: "off",
										placeholder: t("addKeyPlaceholder"),
										value: draft.key,
										onChange: (event) => setDraft((current) => ({
											...current,
											key: event.target.value
										}))
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										className: "packyCodeInput",
										type: "text",
										placeholder: t("addLabelPlaceholder"),
										value: draft.label,
										onChange: (event) => setDraft((current) => ({
											...current,
											label: event.target.value
										}))
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "submit",
										className: "packyCodeButton packyCodeButtonPrimary",
										disabled: busy || draft.key.trim() === "",
										children: t("add")
									})
								]
							}),
							status?.writable !== true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "packyCodeNote",
								children: t("notWritable")
							}),
							error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "packyCodeError",
								children: `${t("error")}: ${error}`
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						className: "packyCodeAdvanced",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: t("advanced") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "packyCodeAdvancedBody",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "packyCodeField",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "packyCodeFigureLabel",
									children: t("apiHost")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: "packyCodeInput",
									type: "text",
									disabled: status?.writable !== true,
									defaultValue: status?.hosts?.apiHost ?? "",
									onBlur: (event) => mutate("hosts/update")({
										apiHost: event.target.value,
										statusHost: status?.hosts?.statusHost
									})
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "packyCodeField",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "packyCodeFigureLabel",
									children: t("statusHost")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: "packyCodeInput",
									type: "text",
									disabled: status?.writable !== true,
									defaultValue: status?.hosts?.statusHost ?? "",
									onBlur: (event) => mutate("hosts/update")({
										statusHost: event.target.value,
										apiHost: status?.hosts?.apiHost
									})
								})]
							})]
						})]
					})
				]
			});
		}
		function PackyCodeComposerQuota({ rpc, t, directory }) {
			const call = react.useMemo(() => (endpoint, payload = {}) => rpc.call(CHANNEL, endpoint, payload).then(unwrap), [rpc]);
			const enabled = react.useSyncExternalStore((listener) => directory.subscribe(listener), () => directory.getSnapshot())?.current?.provider === PROVIDER;
			const [balance, setBalance] = react.useState();
			react.useEffect(() => {
				if (!enabled) {
					setBalance(void 0);
					return;
				}
				let live = true;
				const tick = () => {
					call("balance").then((value) => {
						if (live) setBalance(value);
					}).catch(() => {
						if (live) setBalance(void 0);
					});
				};
				tick();
				const timer = window.setInterval(tick, REFRESH_MS);
				return () => {
					live = false;
					window.clearInterval(timer);
				};
			}, [call, enabled]);
			if (!enabled || balance === void 0) return null;
			const usage = activeUsage(balance)?.usage;
			const display = usage?.unlimitedQuota === true ? t("keyUnlimited") : formatUsd(usage?.availableUsd) ?? t("composerNoKey");
			const label = `${t("composerLabel")}: ${display}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "packyCodeComposer",
				role: "status",
				"aria-label": label,
				title: label,
				children: display
			});
		}
		const inject = [
			"slots",
			"locale",
			"connection",
			"modelDirectories"
		];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "packycode-api: copy");
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-packycode-api";
				tag.textContent = STYLE;
				document.head.append(tag);
				return () => tag.remove();
			}, "packycode-api: style");
			const connection = ctx.get("connection");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "packycode-api",
				order: 17,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({
					rpc: connection.rpc,
					t
				})
			}, PackyCodeSection));
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "packycode-api-balance",
				order: 17,
				locale: NS,
				inject: (sessionId) => ({
					rpc: connection.rpc,
					t,
					directory: ctx.modelDirectories.directoryFor(sessionId).store
				})
			}, PackyCodeComposerQuota));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map