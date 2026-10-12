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
			accountLimit: "额度",
			refresh: "刷新",
			refreshing: "刷新中…",
			keysTitle: "API Key",
			keysHint: "按顺序使用：当前 Key 不可用时自动切到下一个可用 Key。上方的账户余额按备注名逐条列出，可用「重命名」修改备注。",
			keyActive: "使用中",
			keyDisabled: "已停用",
			keyUse: "切到此 Key",
			keyEnable: "重新启用",
			keyRemove: "删除",
			keyRename: "重命名",
			keyRenameSave: "保存",
			keyRenameCancel: "取消",
			keyRenamePlaceholder: "新的备注名",
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
			loadFailed: "读取失败",
			cliTitle: "Claude Code CLI",
			cliChecking: "正在检测本机的 Claude Code CLI…",
			cliInstalled: "已安装",
			cliVersion: "版本",
			cliPath: "位置",
			cliRecheck: "重新检测",
			cliMissing: "未检测到 Claude Code CLI",
			cliMissingHint: "不安装将无法正常使用 Claude 模型（claude-opus-5-5、claude-sonnet-5-5、claude-haiku-5-5）：PackyCode 只把 Claude 模型提供给官方 Claude Code CLI，插件需要调用本机的 CLI 来运行它。其它模型不受影响。",
			cliConfiguredMissing: "设置里指定的 CLI 路径不存在：{path}",
			cliBroken: "找到了 CLI，但无法运行",
			cliInstall: "安装 Claude Code CLI",
			cliReinstall: "重新安装",
			cliInstalling: "正在安装…（通常需要一两分钟，请勿关闭 DSH）",
			cliInstallCommand: "将在本机执行：{command}（需要 Node.js 18 或更高版本）",
			cliInstallSucceeded: "安装完成。",
			cliInstallFailed: "安装失败",
			cliNpmMissing: "没有找到 npm。请先从 https://nodejs.org 安装 Node.js（18 或更高版本），然后再点安装。",
			cliPermission: "npm 没有权限写入全局目录。请在终端执行 sudo {command}，或把 npm 的全局目录改到用户目录后重试。",
			cliPermissionWindows: "npm 没有权限写入全局目录。请以管理员身份打开终端执行 {command}，然后点「重新检测」。",
			cliNetwork: "下载失败，请检查网络或 npm 镜像设置后重试。",
			cliTimeout: "安装超时，请检查网络后重试。",
			cliNotFoundAfterInstall: "npm 显示安装完成，但仍找不到 claude 命令。请在终端执行 claude --version 确认，然后点「重新检测」。",
			cliWindowsNote: "Windows 上 Claude Code 还需要 Git for Windows（https://git-scm.com/downloads/win）。"
		};
		const en = {
			nav: "PackyCode",
			intro: "Paste a PackyCode (PackyAPI) API key to use the built-in model route. Multiple keys are used in order; an exhausted or rejected key hands over to the next one.",
			accountTitle: "Account balance",
			totalRemaining: "Total remaining",
			totalUsed: "Total used",
			totalLimit: "Total limit",
			totalPartial: "{count} key(s) could not be read and are not counted here.",
			accountLimit: "Limit",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			keysTitle: "API keys",
			keysHint: "Used in order: when the active key cannot serve a request, the next usable one takes over. The balances above are listed by these names; use Rename to change one.",
			keyActive: "Active",
			keyDisabled: "Disabled",
			keyUse: "Use this key",
			keyEnable: "Re-enable",
			keyRemove: "Remove",
			keyRename: "Rename",
			keyRenameSave: "Save",
			keyRenameCancel: "Cancel",
			keyRenamePlaceholder: "New name",
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
			loadFailed: "Read failed",
			cliTitle: "Claude Code CLI",
			cliChecking: "Checking this device for the Claude Code CLI…",
			cliInstalled: "Installed",
			cliVersion: "Version",
			cliPath: "Location",
			cliRecheck: "Check again",
			cliMissing: "Claude Code CLI not found",
			cliMissingHint: "Without it the Claude models (claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5) cannot work: PackyCode serves Claude models only to the official Claude Code CLI, so the plugin runs the CLI on this device. Other models are unaffected.",
			cliConfiguredMissing: "The CLI path set in settings does not exist: {path}",
			cliBroken: "The CLI was found but could not run",
			cliInstall: "Install Claude Code CLI",
			cliReinstall: "Reinstall",
			cliInstalling: "Installing… (usually a minute or two; keep DSH open)",
			cliInstallCommand: "Runs on this device: {command} (requires Node.js 18 or later)",
			cliInstallSucceeded: "Installed.",
			cliInstallFailed: "Install failed",
			cliNpmMissing: "npm was not found. Install Node.js 18 or later from https://nodejs.org, then click Install again.",
			cliPermission: "npm cannot write its global directory. Run sudo {command} in a terminal, or point npm’s global prefix at a folder you own, then retry.",
			cliPermissionWindows: "npm cannot write its global directory. Open a terminal as administrator, run {command}, then click Check again.",
			cliNetwork: "The download failed. Check your network or npm registry settings and retry.",
			cliTimeout: "The install timed out. Check your network and retry.",
			cliNotFoundAfterInstall: "npm reported success, but the claude command still cannot be found. Run claude --version in a terminal, then click Check again.",
			cliWindowsNote: "On Windows, Claude Code also needs Git for Windows (https://git-scm.com/downloads/win)."
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
.packyCodeWarning{color:var(--dsw-alias-state-warning-primary,#c27c0e);font-weight:500}
.packyCodeDetail{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all;max-height:160px;overflow:auto}
.packyCodeMono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all}
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
		const INSTALL_POLL_MS = 2e3;
		/** The sentence explaining a failed install, by the code the host classified. */
		function installFailure(cli, t) {
			const command = cli.command ?? "";
			switch (cli.install?.code) {
				case "npm-missing": return t("cliNpmMissing");
				case "permission": return t(cli.platform === "win32" ? "cliPermissionWindows" : "cliPermission").replace("{command}", command);
				case "network": return t("cliNetwork");
				case "timeout": return t("cliTimeout");
				case "not-found-after-install": return t("cliNotFoundAfterInstall");
				default: return;
			}
		}
		/**
		* Whether this device has the Claude Code CLI, which version, and — when it
		* has none — a button that installs it with npm.
		*/
		function ClaudeCliCard({ call, t }) {
			const [cli, setCli] = react.useState();
			const [checking, setChecking] = react.useState(false);
			const [error, setError] = react.useState();
			const check = react.useCallback((force = false) => {
				setChecking(true);
				setError(void 0);
				return call("claude-cli/status", { force }).then(setCli).catch((failure) => setError(clearMessage(failure))).finally(() => setChecking(false));
			}, [call]);
			react.useEffect(() => {
				check(false);
			}, [check]);
			const running = cli?.install?.state === "running";
			react.useEffect(() => {
				if (!running) return void 0;
				let live = true;
				const timer = window.setInterval(() => {
					call("claude-cli/status").then((value) => {
						if (live) setCli(value);
					}).catch(() => void 0);
				}, INSTALL_POLL_MS);
				return () => {
					live = false;
					window.clearInterval(timer);
				};
			}, [call, running]);
			const install = () => {
				setError(void 0);
				call("claude-cli/install").then(setCli).catch((failure) => setError(clearMessage(failure)));
			};
			const usable = cli?.installed === true && cli.version !== void 0;
			const failed = cli?.install?.state === "failed";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "packyCodeCard",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: "packyCodeCardHeader",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "packyCodeCardTitle",
							children: t("cliTitle")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "packyCodeButton",
							disabled: checking || running,
							onClick: () => check(true),
							children: checking ? t("refreshing") : t("cliRecheck")
						})]
					}),
					cli === void 0 && error === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "packyCodeNote",
						children: t("cliChecking")
					}),
					usable && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "packyCodeFigures",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "packyCodeFigure",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "packyCodeFigureLabel",
									children: t("cliInstalled")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "packyCodeFigureValue",
									children: `${t("cliVersion")} ${cli.version}`
								})]
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "packyCodeNote",
							children: [`${t("cliPath")}：`, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "packyCodeMono",
								children: cli.path
							})]
						}),
						cli.install?.state === "succeeded" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "packyCodeNote",
							children: t("cliInstallSucceeded")
						})
					] }),
					cli !== void 0 && !usable && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "packyCodeWarning",
							children: cli.installed ? t("cliBroken") : t("cliMissing")
						}),
						cli.installed && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "packyCodeNote",
							children: [`${t("cliPath")}：`, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "packyCodeMono",
								children: cli.path
							})]
						}), cli.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
							className: "packyCodeDetail",
							children: cli.error
						})] }),
						cli.configuredPath !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "packyCodeNote",
							children: t("cliConfiguredMissing").replace("{path}", cli.configuredPath)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "packyCodeIntro",
							children: t("cliMissingHint")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "packyCodeActions",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "packyCodeButton packyCodeButtonPrimary",
								disabled: running || checking,
								onClick: install,
								children: running ? t("cliInstalling") : cli.installed ? t("cliReinstall") : t("cliInstall")
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "packyCodeNote",
							children: [t("cliInstallCommand").replace("{command}", cli.command ?? ""), cli.platform === "win32" && ` ${t("cliWindowsNote")}`]
						})
					] }),
					failed && !usable && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "packyCodeError",
						children: installFailure(cli, t) === void 0 ? t("cliInstallFailed") : `${t("cliInstallFailed")}：${installFailure(cli, t)}`
					}), cli.install.detail !== void 0 && cli.install.detail !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						className: "packyCodeDetail",
						children: cli.install.detail
					})] }),
					error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "packyCodeError",
						children: `${t("error")}: ${error}`
					})
				]
			});
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
			const [renaming, setRenaming] = react.useState();
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
			const submitRename = (event) => {
				event.preventDefault();
				if (renaming === void 0 || renaming.label.trim() === "") return;
				mutate("keys/rename")({
					id: renaming.id,
					label: renaming.label
				}).then(() => setRenaming(void 0));
			};
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
				const tokenName = usage?.name !== void 0 && usage.name !== row.label ? `${t("keyName")} ${usage.name}` : void 0;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "packyCodeRow",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "packyCodeRowMain",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "packyCodeRowName",
							children: [
								row.label,
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
							children: figures.length > 0 ? [tokenName, ...figures].filter(Boolean).join(" · ") : row.error === void 0 ? t("keyNoBalance") : `${t("loadFailed")}: ${row.error}`
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
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ClaudeCliCard, {
						call,
						t
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "packyCodeCard",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
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
						}), rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "packyCodeNote",
							children: t("empty")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "packyCodeRows",
								children: rows.map(accountRow)
							}),
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
							})
						] })]
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
													renaming?.id === key.id ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
														className: "packyCodeForm",
														onSubmit: submitRename,
														children: [
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																className: "packyCodeInput",
																type: "text",
																maxLength: 60,
																autoFocus: true,
																placeholder: t("keyRenamePlaceholder"),
																value: renaming.label,
																onChange: (event) => setRenaming({
																	id: key.id,
																	label: event.target.value
																}),
																onKeyDown: (event) => event.key === "Escape" && setRenaming(void 0)
															}),
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																type: "submit",
																className: "packyCodeButton",
																disabled: busy || renaming.label.trim() === "",
																children: t("keyRenameSave")
															}),
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																type: "button",
																className: "packyCodeButton",
																onClick: () => setRenaming(void 0),
																children: t("keyRenameCancel")
															})
														]
													}) : key.label,
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
												renaming?.id !== key.id && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "packyCodeButton",
													disabled: busy,
													onClick: () => setRenaming({
														id: key.id,
														label: key.label
													}),
													children: t("keyRename")
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