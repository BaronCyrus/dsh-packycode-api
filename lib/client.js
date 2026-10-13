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
		//#region src/client-copy.js
		/**
		* The settings panel's copy, in both languages DSH ships.
		*
		* @module dsh-packycode-api/client-copy
		*/
		const zh = {
			nav: "PackyCode",
			intro: "填入 PackyCode（PackyAPI）的 API Key 即可使用内置模型路由。多个 Key 按顺序使用：额度用尽或失效时自动切到下一个；某个 Key 的分组用不了所选模型时，自动改用分组合适的 Key。",
			accountsTitle: "账户与 Key",
			refresh: "刷新",
			refreshing: "刷新中…",
			totalRemaining: "合计剩余",
			totalUsed: "合计已用",
			totalLimit: "合计额度",
			totalPartial: "有 {count} 个 Key 未读到余额，未计入合计。",
			totalStale: "其中 {count} 个 Key 本次读取失败，显示的是上次读到的余额。",
			staleNote: "上次读取于 {time}，本次读取失败：{error}",
			empty: "还没有 Key。添加一个即可在模型选择器里看到 PackyCode 的模型。",
			keysHint: "按顺序使用：当前 Key 不可用时自动切到下一个；「切到此 Key」指定优先使用的 Key。",
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
			accountLimit: "额度",
			keyName: "账户名",
			keyNameUnknown: "账户名待读取",
			resetMonthly: "每月重置",
			resetWeekly: "每周重置",
			resetDaily: "每日重置",
			loadFailed: "读取失败",
			removeAll: "清空全部",
			addTitle: "添加 Key",
			addKeyPlaceholder: "粘贴 API Key",
			addLabelPlaceholder: "备注（可选）",
			add: "添加",
			notWritable: "当前 profile 不允许写入设置，改动只在本次运行内生效。",
			error: "读取 PackyCode 状态失败",
			groupsTitle: "分组",
			groupsChecking: "正在读取分组…",
			groupsUnknown: "分组未读到",
			groupsRejected: "Key 被网关拒绝",
			groupsReach: "可用",
			groupsMiss: "不可用",
			groupsPartial: "部分",
			groupsStale: "分组为上次读取的结果",
			advanced: "高级：接口地址",
			apiHost: "模型接口地址",
			statusHost: "余额接口地址",
			composerLabel: "PackyCode 剩余额度",
			composerNoKey: "无可用 Key",
			composerUnread: "余额读取失败",
			composerStale: "上次读取于 {time}，本次读取失败",
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
			cliWindowsNote: "Windows 上 Claude Code 还需要 Git for Windows（https://git-scm.com/downloads/win）。",
			versionTitle: "插件版本",
			versionCurrent: "当前版本",
			versionLatest: "最新版本",
			versionCheck: "检查更新",
			versionChecking: "正在检查更新…",
			versionFailed: "无法检查最新版本。",
			versionUpToDate: "已是最新版本",
			versionAvailable: "发现新版本 v{version}",
			versionLinked: "当前是本地开发安装，请在插件仓库拉取代码并重新构建。",
			versionManual: "无法在这里更新。请在桌面应用的插件页重新安装 dsh-packycode-api。",
			versionUpdate: "更新插件",
			versionUpdating: "正在更新…",
			versionUpdateFailed: "更新失败，请重试，或在插件页重新安装。",
			versionUpdated: "已更新到 v{version}。",
			versionUpdatedHint: "新版本需要完全退出并重新打开桌面应用才会生效；只刷新页面不会重载 Host 里的插件。",
			versionRestart: "如何重启",
			versionRestartHint: "插件无法安全地重启桌面应用。请完全退出 DSH，再重新打开。",
			versionRefresh: "刷新界面",
			versionLater: "稍后",
			searchTitle: "网页搜索",
			searchScope: "DSH 全局设置",
			searchIntro: "DSH 的 web_search 和 Claude CLI 的 MCP 搜索可使用这里选择的 DeepSeek/GPT 后端。每次搜索是独立的模型调用，用插件保存的 Key 计费。",
			searchCliHint: "Claude CLI 始终通过 MCP 使用这里的搜索后端，原生 WebSearch 已禁用。下面的路由选项只控制 DSH 全局搜索，不影响 CLI。",
			searchChecking: "正在读取搜索设置…",
			searchLoadFailed: "搜索设置读取或保存失败",
			searchModeTitle: "DSH 路由",
			searchModeDefault: "不接管",
			searchModeDefaultHint: "不改动 DSH 的搜索路由（默认）。切回此项会移除本插件写入 profile 的搜索补丁。",
			searchModeAuto: "按模型",
			searchModeAutoHint: "PackyCode 模型用 PackyCode 搜索；其他模型仍走原来的搜索（DSH 默认搜索，或其他插件的设置）。",
			searchModePackycode: "始终 PackyCode",
			searchModePackycodeHint: "原本由 DSH 默认搜索处理的请求都改走 PackyCode。Codex、Kimi 等订阅插件接管的模型仍按它们自己的设置。",
			searchBackendTitle: "搜索后端",
			searchBackendDeepseek: "DeepSeek",
			searchBackendDeepseekHint: "{model}：每次搜索约几千 token；需要 Key 的分组包含 DeepSeek。",
			searchBackendGpt: "GPT",
			searchBackendGptHint: "{model}：结果通常更新、更准，但每次搜索约 2–3 万输入 token；需要 Key 的分组包含 Codex。",
			searchEffective: "当前生效：基础搜索 {base} · 运行时 {runtime}",
			searchPatchNote: "「按模型」和「始终」会在本 profile 的 cordis.patch.yml 里写入一段带标记的 web 配置，热加载生效，无需重启。卸载插件前请先切回「不接管」。",
			searchApplyFailed: "写入搜索补丁失败：{error}",
			searchForeign: "检测到 {names} 订阅插件：它们接管的模型仍按各自的搜索设置，其余请求才会到达这里的选择。",
			searchOverridden: "基础搜索现在是 {base}，不是 PackyCode：可能还在热加载，或被其他插件的补丁覆盖。",
			searchUnavailable: "当前运行环境没有 DSH 网页搜索服务，全局路由暂不生效；Claude CLI 的 MCP 搜索不受影响。",
			searchNotWritable: "当前 profile 不允许写入设置。",
			searchUnknown: "未知"
		};
		const en = {
			nav: "PackyCode",
			intro: "Paste a PackyCode (PackyAPI) API key to use the built-in model route. Keys are used in order: an exhausted or rejected key hands over to the next one, and a key whose groups cannot reach the selected model is passed over for one whose groups can.",
			accountsTitle: "Accounts and keys",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			totalRemaining: "Total remaining",
			totalUsed: "Total used",
			totalLimit: "Total limit",
			totalPartial: "{count} key(s) could not be read and are not counted here.",
			totalStale: "{count} of these keys failed this read and show their last read balance.",
			staleNote: "Last read at {time}; this read failed: {error}",
			empty: "No keys yet. Add one and the PackyCode models appear in the model picker.",
			keysHint: "Used in order: when the active key cannot serve a request, the next one takes over. “Use this key” picks the preferred key.",
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
			accountLimit: "Limit",
			keyName: "Account",
			keyNameUnknown: "Account name not read yet",
			resetMonthly: "resets monthly",
			resetWeekly: "resets weekly",
			resetDaily: "resets daily",
			loadFailed: "Read failed",
			removeAll: "Remove all",
			addTitle: "Add a key",
			addKeyPlaceholder: "Paste API key",
			addLabelPlaceholder: "Label (optional)",
			add: "Add",
			notWritable: "This profile does not allow settings writes; changes apply to this run only.",
			error: "Could not read PackyCode status",
			groupsTitle: "Groups",
			groupsChecking: "Reading groups…",
			groupsUnknown: "Groups not read",
			groupsRejected: "Key rejected by the gateway",
			groupsReach: "Reaches",
			groupsMiss: "Not",
			groupsPartial: "partly",
			groupsStale: "groups from the last read",
			advanced: "Advanced: endpoints",
			apiHost: "Model endpoint",
			statusHost: "Balance endpoint",
			composerLabel: "PackyCode remaining balance",
			composerNoKey: "No usable key",
			composerUnread: "Balance unavailable",
			composerStale: "last read at {time}; this read failed",
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
			cliWindowsNote: "On Windows, Claude Code also needs Git for Windows (https://git-scm.com/downloads/win).",
			versionTitle: "Plugin version",
			versionCurrent: "Current version",
			versionLatest: "Latest version",
			versionCheck: "Check for updates",
			versionChecking: "Checking for updates…",
			versionFailed: "Could not check the latest version.",
			versionUpToDate: "Up to date",
			versionAvailable: "v{version} is available",
			versionLinked: "Installed from a local checkout. Pull and rebuild the plugin repository instead.",
			versionManual: "This install cannot be updated here. Reinstall dsh-packycode-api from the desktop Plugins page.",
			versionUpdate: "Update plugin",
			versionUpdating: "Updating…",
			versionUpdateFailed: "The update failed. Try again, or reinstall from the Plugins page.",
			versionUpdated: "Updated to v{version}.",
			versionUpdatedHint: "Quit and reopen the desktop application. Refreshing the page does not reload the plugin inside the Host.",
			versionRestart: "How to restart",
			versionRestartHint: "The plugin cannot safely restart the desktop application. Quit DSH completely, then open it again.",
			versionRefresh: "Refresh page",
			versionLater: "Later",
			searchTitle: "Web search",
			searchScope: "DSH-wide setting",
			searchIntro: "DSH’s web_search and Claude CLI’s MCP search can use the DeepSeek/GPT backend selected here. Each search is a separate model call billed to the plugin-stored keys.",
			searchCliHint: "Claude CLI always uses this backend through MCP; native WebSearch is disabled. The routing options below only control DSH-wide search, not CLI search.",
			searchChecking: "Reading the search preference…",
			searchLoadFailed: "Could not read or save the search preference",
			searchModeTitle: "DSH routing",
			searchModeDefault: "Off",
			searchModeDefaultHint: "Leave DSH search routing untouched (the default). Switching back here removes the search patch this plugin wrote into the profile.",
			searchModeAuto: "By model",
			searchModeAutoHint: "PackyCode models search through PackyCode; other models keep the search they had (DSH’s default, or another plugin’s choice).",
			searchModePackycode: "Always PackyCode",
			searchModePackycodeHint: "Every request DSH’s default search would have served goes through PackyCode. Models another subscription plugin (Codex, Kimi) routes keep that plugin’s choice.",
			searchBackendTitle: "Search backend",
			searchBackendDeepseek: "DeepSeek",
			searchBackendDeepseekHint: "{model}: a few thousand tokens per search; needs a key whose group includes DeepSeek.",
			searchBackendGpt: "GPT",
			searchBackendGptHint: "{model}: usually fresher and more precise, but about 20–30K input tokens per search; needs a key whose group includes Codex.",
			searchEffective: "In effect: base search {base} · runtime {runtime}",
			searchPatchNote: "By model and Always write a marked web entry into this profile’s cordis.patch.yml; it hot-applies, no restart needed. Switch back to Off before uninstalling the plugin.",
			searchApplyFailed: "Could not write the search patch: {error}",
			searchForeign: "{names} subscription plugin detected: the models it routes keep its own search choice; only the other requests reach the choice made here.",
			searchOverridden: "The base search is {base}, not PackyCode: the reload may still be running, or another plugin’s patch overrides it.",
			searchUnavailable: "This runtime has no DSH web search service; global routing has no effect. Claude CLI’s MCP search is unaffected.",
			searchNotWritable: "This profile does not allow settings writes.",
			searchUnknown: "unknown"
		};
		//#endregion
		//#region src/client-style.js
		/**
		* The settings panel's stylesheet, built only from DSH design tokens so it
		* follows the host theme (light and dark) and matches the host's own settings
		* pages: settings cards, hairline-divided rows, 0.5px tags, layer-1 inputs.
		* Fallbacks cover hosts that predate the settings-card tokens.
		*
		* @module dsh-packycode-api/client-style
		*/
		const STYLE = `
.pkc{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.pkc-intro{margin:0;color:var(--dsw-alias-label-tertiary)}
.pkc-card{display:flex;flex-direction:column;gap:14px;padding:16px 18px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4,rgba(127,127,127,.3)));border-radius:var(--dsw-radius-xl,20px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2))}
.pkc-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:28px}
.pkc-title{display:flex;align-items:center;gap:8px;margin:0;font-size:15px;font-weight:600;line-height:22px}
.pkc-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.pkc-warn{margin:0;color:var(--dsw-alias-state-warn-label,#dd8629);font-size:12px;line-height:18px}
.pkc-error{margin:0;color:var(--dsw-alias-state-error-primary,#ec1313);font-size:12px;line-height:18px}
.pkc-label{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.pkc-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;word-break:break-all}
.pkc-detail{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all;max-height:160px;overflow:auto}

.pkc-btn{box-sizing:border-box;display:inline-flex;flex:none;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.pkc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.pkc-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.pkc-btn:disabled{opacity:.4;cursor:not-allowed}
.pkc-btn[data-size=md]{height:32px;padding:0 14px;border-radius:var(--dsw-radius-md,12px);font-size:13px}
.pkc-btn[data-variant=primary]{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.pkc-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.pkc-btn[data-variant=ghost]{border-color:transparent;color:var(--dsw-alias-label-secondary)}
.pkc-btn[data-variant=danger]{border-color:transparent;color:var(--dsw-alias-state-error-primary)}
.pkc-btn[data-variant=danger]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}

.pkc-input{box-sizing:border-box;flex:1 1 200px;min-width:0;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.pkc-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.pkc-input::placeholder{color:var(--dsw-alias-label-caption)}
.pkc-input:disabled{opacity:.5}
.pkc-form{display:flex;flex-wrap:wrap;align-items:center;gap:8px}

.pkc-chip{flex:none;padding:0 8px;border-radius:999px;font-size:11px;font-weight:500;line-height:18px;white-space:nowrap}
.pkc-chip[data-tone=success]{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}
.pkc-chip[data-tone=danger]{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.pkc-chip[data-tone=info]{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}
.pkc-chip[data-tone=neutral]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.pkc-tag{flex:none;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs,4px);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;line-height:18px;cursor:default}
.pkc-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.pkc-dot[data-tone=success]{background:var(--dsw-alias-state-success-primary)}
.pkc-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary)}
.pkc-dot[data-tone=danger]{background:var(--dsw-alias-state-error-primary)}

.pkc-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.pkc-stat{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-interactive-bg-hover)}
.pkc-stat-label{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.pkc-stat-value{font-size:20px;font-weight:600;line-height:28px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.pkc-list{display:flex;flex-direction:column}
.pkc-row{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l2)}
.pkc-row:first-child{border-top:0;padding-top:2px}
.pkc-row-top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px}
.pkc-row-name{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;font-weight:500}
.pkc-row-name>.pkc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pkc-actions{display:flex;flex-wrap:wrap;gap:4px}
.pkc-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.pkc-figures{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 16px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.pkc-figures b{margin-left:4px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.pkc-bar{height:4px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-interactive-bg-active)}
.pkc-bar>span{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-state-success-primary)}
.pkc-bar[data-level=warn]>span{background:var(--dsw-alias-state-warn-primary)}
.pkc-bar[data-level=low]>span{background:var(--dsw-alias-state-error-primary)}
.pkc-groups{display:flex;flex-wrap:wrap;align-items:center;gap:6px 6px}
.pkc-groups>.pkc-label{margin-right:2px}
.pkc-reach{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;font-size:12px;line-height:18px}
.pkc-reach>span{display:inline-flex;align-items:center;gap:4px;cursor:default}
.pkc-reach>span[data-state=ok]{color:var(--dsw-alias-state-success-primary)}
.pkc-reach>span[data-state=partial]{color:var(--dsw-alias-state-warn-label,#dd8629)}
.pkc-reach>span[data-state=no]{color:var(--dsw-alias-label-caption);text-decoration:line-through}
.pkc-add{display:flex;flex-direction:column;gap:8px;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2)}

.pkc-setting{display:grid;grid-template-columns:112px minmax(0,1fr);gap:6px 16px;align-items:start}
.pkc-setting>.pkc-label{padding-top:5px}
.pkc-setting>div{display:flex;flex-direction:column;gap:6px;min-width:0}
.pkc-seg{display:inline-flex;flex-wrap:wrap;align-self:flex-start;gap:2px;max-width:100%;padding:2px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-interactive-bg-hover)}
.pkc-seg>button{height:28px;padding:0 12px;border:0;border-radius:calc(var(--dsw-radius-md,12px) - 2px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.pkc-seg>button:hover:not(:disabled):not([aria-checked=true]){color:var(--dsw-alias-label-primary)}
.pkc-seg>button[aria-checked=true]{background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:var(--dsw-shadow-lv1)}
.pkc-seg>button:disabled{cursor:not-allowed;opacity:.5}
.pkc-status{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;font-size:13px}
.pkc-status>b{font-weight:600;font-variant-numeric:tabular-nums}
.pkc-callout{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-state-warn-tertiary)}
.pkc-callout[data-tone=info]{background:var(--dsw-alias-state-business-tertiary)}
.pkc-callout>.pkc-title{font-size:13px}
.pkc-split{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}

.pkc-advanced>summary{width:fit-content;padding:2px 4px;margin-left:-4px;border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px;cursor:pointer}
.pkc-advanced>summary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pkc-advanced[open]>summary{margin-bottom:10px}
.pkc-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}

.pkc-composer{display:inline-flex;flex:0 0 auto;align-items:center;box-sizing:border-box;height:28px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:20px;font-variant-numeric:tabular-nums;white-space:nowrap;user-select:none}

@media (max-width:640px){
  .pkc-stats{grid-template-columns:1fr}
  .pkc-setting{grid-template-columns:1fr}
  .pkc-setting>.pkc-label{padding-top:0}
}
`;
		//#endregion
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
		const INSTALL_POLL_MS = 2e3;
		/** How long after a search change the panel re-reads what DSH applied (the patch hot-reloads). */
		const SEARCH_SETTLE_MS = 1500;
		const OWN_SEARCH_IDS = {
			auto: "packycode-api-auto",
			packycode: "packycode-api"
		};
		const FOREIGN_NAMES = {
			codex: "Codex",
			kimi: "Kimi"
		};
		/** The catalog's models by family, for the "reaches" line under each key. */
		const MODEL_FAMILIES = [
			["DeepSeek", ["deepseek-flash"]],
			["GPT", ["gpt-6.1-sol", "gpt-6-astra"]],
			["Claude", [
				"claude-opus-5-5",
				"claude-sonnet-5-5",
				"claude-haiku-5-5"
			]]
		];
		/**
		* The one way this bundle talks to the host. The transport drops an
		* `undefined` payload and the channel's envelope requires the field, so every
		* call carries an object.
		*/
		function channelCaller(rpc) {
			return (endpoint, payload = {}) => rpc.call(CHANNEL, endpoint, payload).then((response) => {
				if (!response?.ok) throw new Error(response?.error?.message ?? "PackyCode RPC failed");
				return response.value;
			});
		}
		const useCaller = (rpc) => react.useMemo(() => channelCaller(rpc), [rpc]);
		/** Substitute `{name}` placeholders in a copy string. */
		const fill = (text, values) => text.replace(/\{(\w+)\}/gu, (match, name) => values[name] === void 0 ? match : String(values[name]));
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
		/** The clock time of an epoch-millisecond reading, for a "last read at" note. */
		function readTime(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
			try {
				return new Date(ms).toLocaleTimeString(void 0, {
					hour: "2-digit",
					minute: "2-digit"
				});
			} catch {
				return new Date(ms).toISOString().slice(11, 16);
			}
		}
		function clearMessage(error) {
			const text = typeof error?.message === "string" && error.message.length > 0 ? error.message : String(error);
			return text.length > 200 ? text.slice(0, 200) : text;
		}
		const RESET_KEYS = {
			monthly: "resetMonthly",
			weekly: "resetWeekly",
			daily: "resetDaily"
		};
		const resetLabel = (period, t) => RESET_KEYS[period] === void 0 ? void 0 : t(RESET_KEYS[period]);
		/** Active key's usage row, preferring the key the ring currently points at. */
		function activeUsage(balance) {
			if (balance === void 0) return void 0;
			return balance.keys?.find((entry) => entry.id === balance.activeId) ?? balance.keys?.[0];
		}
		/** How much of a key's limit is left, for its bar; undefined without a limit. */
		function remainingShare(usage) {
			if (usage?.unlimitedQuota === true || typeof usage?.limitUsd !== "number" || usage.limitUsd <= 0) return void 0;
			if (typeof usage.availableUsd !== "number") return void 0;
			return Math.max(0, Math.min(1, usage.availableUsd / usage.limitUsd));
		}
		/** Which catalog families a key reaches, from its per-model coverage. */
		function reachOf(coverage) {
			return MODEL_FAMILIES.flatMap(([name, models]) => {
				const known = models.filter((id) => typeof coverage?.[id] === "boolean");
				if (known.length === 0) return [];
				const reached = known.filter((id) => coverage[id] === true);
				return [{
					name,
					state: reached.length === 0 ? "no" : reached.length === known.length ? "ok" : "partial",
					reached,
					missing: known.filter((id) => coverage[id] === false)
				}];
			});
		}
		function Card({ title, aside, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "pkc-card",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
					className: "pkc-head",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: "pkc-title",
						children: title
					}), aside]
				}), children]
			});
		}
		function Button({ variant, size, children, ...rest }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "pkc-btn",
				"data-variant": variant,
				"data-size": size,
				...rest,
				children
			});
		}
		function Segmented({ label, options, value, disabled, onChange }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "pkc-seg",
				role: "radiogroup",
				"aria-label": label,
				children: options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					role: "radio",
					"aria-checked": value === option.value,
					disabled,
					onClick: () => value !== option.value && onChange(option.value),
					children: option.label
				}, option.value))
			});
		}
		/** A key's groups and what they reach. */
		function KeyGroups({ group, descriptions, loading, t }) {
			if (group === void 0) return loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "pkc-meta",
				children: t("groupsChecking")
			}) : null;
			if (group.rejected === true) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "pkc-error",
				children: t("groupsRejected")
			});
			const reach = reachOf(group.coverage);
			const names = Array.isArray(group.groups) ? group.groups : [];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "pkc-groups",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "pkc-label",
						children: t("groupsTitle")
					}), names.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "pkc-meta",
						children: group.error === void 0 ? "—" : `${t("groupsUnknown")}: ${group.error}`
					}) : names.map((name) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "pkc-tag",
						title: descriptions?.[name] ?? name,
						children: name
					}, name))]
				}),
				reach.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "pkc-reach",
					children: reach.map((family) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						"data-state": family.state,
						title: [...family.reached.map((id) => `✓ ${id}`), ...family.missing.map((id) => `✗ ${id}`)].join("\n"),
						children: [
							family.state === "ok" ? "✓" : family.state === "partial" ? "◐" : "✕",
							" ",
							family.name,
							family.state === "partial" && ` (${t("groupsPartial")})`
						]
					}, family.name))
				}),
				group.stale !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "pkc-meta",
					children: t("groupsStale")
				})
			] });
		}
		function KeyRow({ entry, row, group, descriptions, groupsLoading, busy, renaming, onRename, onAction, t }) {
			const usage = row?.usage;
			const share = remainingShare(usage);
			const figures = [
				usage?.unlimitedQuota === true ? [t("keyRemaining"), t("keyUnlimited")] : usage?.availableUsd === void 0 ? void 0 : [t("keyRemaining"), formatUsd(usage.availableUsd)],
				usage?.usedUsd === void 0 ? void 0 : [t("keyUsed"), formatUsd(usage.usedUsd)],
				usage?.limitUsd === void 0 ? void 0 : [t("accountLimit"), formatUsd(usage.limitUsd)]
			].filter(Boolean);
			const meta = [usage?.name === void 0 ? t("keyNameUnknown") : `${t("keyName")} ${usage.name}`, resetLabel(usage?.resetPeriod, t)].filter(Boolean).join(" · ");
			const editing = renaming?.id === entry.id;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "pkc-row",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "pkc-row-top",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "pkc-row-name",
							children: [
								editing ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
									className: "pkc-form",
									onSubmit: (event) => {
										event.preventDefault();
										onRename.submit();
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: "pkc-input",
											type: "text",
											maxLength: 60,
											autoFocus: true,
											placeholder: t("keyRenamePlaceholder"),
											value: renaming.label,
											onChange: (event) => onRename.change(event.target.value),
											onKeyDown: (event) => event.key === "Escape" && onRename.cancel()
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
											type: "submit",
											variant: "primary",
											disabled: busy || renaming.label.trim() === "",
											children: t("keyRenameSave")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
											variant: "ghost",
											onClick: onRename.cancel,
											children: t("keyRenameCancel")
										})
									]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "pkc-name",
									children: entry.label
								}),
								entry.active && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "pkc-chip",
									"data-tone": "success",
									children: t("keyActive")
								}),
								entry.disabled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "pkc-chip",
									"data-tone": "danger",
									children: entry.disabledReason ? `${t("keyDisabled")} · ${entry.disabledReason}` : t("keyDisabled")
								})
							]
						}), !editing && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "pkc-actions",
							children: [
								!entry.active && !entry.disabled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									disabled: busy,
									onClick: () => onAction("keys/select", { id: entry.id }),
									children: t("keyUse")
								}),
								entry.disabled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									disabled: busy,
									onClick: () => onAction("keys/enable", { id: entry.id }),
									children: t("keyEnable")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "ghost",
									disabled: busy,
									onClick: () => onRename.start(entry),
									children: t("keyRename")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "danger",
									disabled: busy,
									onClick: () => onAction("keys/remove", { id: entry.id }),
									children: t("keyRemove")
								})
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "pkc-meta",
						children: meta
					}),
					figures.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "pkc-figures",
						children: figures.map(([label, value]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [label, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: value })] }, label))
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "pkc-meta",
						children: row?.error === void 0 ? t("keyNoBalance") : `${t("loadFailed")}: ${row.error}`
					}),
					share !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "pkc-bar",
						"data-level": share < .1 ? "low" : share < .3 ? "warn" : "ok",
						role: "presentation",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { width: `${Math.round(share * 100)}%` } })
					}),
					row?.stale !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "pkc-warn",
						children: fill(t("staleNote"), {
							time: readTime(row.stale.fetchedAt),
							error: row.stale.error ?? ""
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyGroups, {
						group,
						descriptions,
						loading: groupsLoading,
						t
					})
				]
			});
		}
		function AccountsCard({ call, t }) {
			const [status, setStatus] = react.useState();
			const [balance, setBalance] = react.useState();
			const [groups, setGroups] = react.useState();
			const [groupsLoading, setGroupsLoading] = react.useState(true);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState();
			const [draft, setDraft] = react.useState({
				key: "",
				label: ""
			});
			const [renaming, setRenaming] = react.useState();
			const generation = react.useRef(0);
			const readGroups = react.useCallback((force = false) => {
				setGroupsLoading(true);
				return call("groups", { force }).then(setGroups).catch(() => void 0).finally(() => setGroupsLoading(false));
			}, [call]);
			const load = react.useCallback((force = false) => {
				const current = ++generation.current;
				setBusy(true);
				setError(void 0);
				readGroups(force);
				return Promise.all([call("status"), call("balance", { force })]).then(([nextStatus, nextBalance]) => {
					if (generation.current !== current) return;
					setStatus(nextStatus);
					setBalance(nextBalance);
				}).catch((failure) => {
					if (generation.current === current) setError(clearMessage(failure));
				}).finally(() => {
					if (generation.current === current) setBusy(false);
				});
			}, [call, readGroups]);
			react.useEffect(() => {
				load(false);
				return () => {
					generation.current += 1;
				};
			}, [load]);
			const mutate = (endpoint, payload) => {
				setBusy(true);
				setError(void 0);
				return call(endpoint, payload).then((nextStatus) => {
					setStatus(nextStatus);
					readGroups(false);
					return call("balance", { force: true });
				}).then(setBalance).catch((failure) => setError(clearMessage(failure))).finally(() => setBusy(false));
			};
			const addKey = (event) => {
				event.preventDefault();
				if (draft.key.trim() === "") return;
				mutate("keys/add", {
					key: draft.key,
					label: draft.label
				}).then(() => setDraft({
					key: "",
					label: ""
				}));
			};
			const rename = {
				start: (entry) => setRenaming({
					id: entry.id,
					label: entry.label
				}),
				change: (label) => setRenaming((current) => ({
					...current,
					label
				})),
				cancel: () => setRenaming(void 0),
				submit: () => {
					if (renaming === void 0 || renaming.label.trim() === "") return;
					mutate("keys/rename", {
						id: renaming.id,
						label: renaming.label
					}).then(() => setRenaming(void 0));
				}
			};
			const keys = status?.keys ?? [];
			const rows = balance?.keys ?? [];
			const totals = sumBalances(rows);
			const staleCount = rows.filter((row) => row.stale !== void 0).length;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
				title: t("accountsTitle"),
				aside: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "pkc-actions",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
						disabled: busy,
						onClick: () => load(true),
						children: busy ? t("refreshing") : t("refresh")
					}), keys.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
						variant: "danger",
						disabled: busy,
						onClick: () => mutate("keys/remove-all", {}),
						children: t("removeAll")
					})]
				}),
				children: [
					keys.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "pkc-note",
						children: t("empty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pkc-stats",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "pkc-stat",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "pkc-stat-label",
										children: t("totalRemaining")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "pkc-stat-value",
										children: [totals.counted === 0 ? "—" : formatUsd(totals.remainingUsd) ?? "—", totals.unlimited > 0 && ` + ${t("keyUnlimited")}`]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "pkc-stat",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "pkc-stat-label",
										children: t("totalUsed")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "pkc-stat-value",
										children: totals.counted === 0 ? "—" : formatUsd(totals.usedUsd) ?? "—"
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "pkc-stat",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "pkc-stat-label",
										children: t("totalLimit")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "pkc-stat-value",
										children: totals.counted === 0 ? "—" : totals.unlimited > 0 ? t("keyUnlimited") : formatUsd(totals.limitUsd) ?? "—"
									})]
								})
							]
						}),
						(totals.unread > 0 || staleCount > 0) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "pkc-note",
							children: [totals.unread > 0 ? fill(t("totalPartial"), { count: totals.unread }) : void 0, staleCount > 0 ? fill(t("totalStale"), { count: staleCount }) : void 0].filter(Boolean).join(" ")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "pkc-list",
							children: keys.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyRow, {
								entry,
								row: rows.find((row) => row.id === entry.id),
								group: groups?.keys?.find((group) => group.id === entry.id),
								descriptions: groups?.descriptions,
								groupsLoading,
								busy,
								renaming,
								onRename: rename,
								onAction: mutate,
								t
							}, entry.id))
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "pkc-note",
							children: t("keysHint")
						})
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						className: "pkc-add",
						onSubmit: addKey,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "pkc-label",
							children: t("addTitle")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pkc-form",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: "pkc-input",
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
									className: "pkc-input",
									type: "text",
									placeholder: t("addLabelPlaceholder"),
									value: draft.label,
									onChange: (event) => setDraft((current) => ({
										...current,
										label: event.target.value
									}))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									type: "submit",
									variant: "primary",
									size: "md",
									disabled: busy || draft.key.trim() === "",
									children: t("add")
								})
							]
						})]
					}),
					status !== void 0 && status.writable !== true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "pkc-note",
						children: t("notWritable")
					}),
					error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "pkc-error",
						role: "alert",
						children: `${t("error")}: ${error}`
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						className: "pkc-advanced",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: t("advanced") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "pkc-field",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "pkc-label",
									children: t("apiHost")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: "pkc-input",
									type: "text",
									disabled: status?.writable !== true,
									defaultValue: status?.hosts?.apiHost ?? "",
									onBlur: (event) => mutate("hosts/update", {
										apiHost: event.target.value,
										statusHost: status?.hosts?.statusHost
									})
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "pkc-field",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "pkc-label",
									children: t("statusHost")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: "pkc-input",
									type: "text",
									disabled: status?.writable !== true,
									defaultValue: status?.hosts?.statusHost ?? "",
									onBlur: (event) => mutate("hosts/update", {
										statusHost: event.target.value,
										apiHost: status?.hosts?.apiHost
									})
								})]
							})
						]
					})
				]
			});
		}
		/** Web search routing and backend, written through the host. */
		function SearchCard({ call, t }) {
			const [state, setState] = react.useState();
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState();
			const generation = react.useRef(0);
			const read = react.useCallback(() => {
				const current = ++generation.current;
				return call("search/status").then((value) => {
					if (generation.current === current) setState(value);
				}).catch((failure) => {
					if (generation.current === current) setError(clearMessage(failure));
				});
			}, [call]);
			react.useEffect(() => {
				read();
				return () => {
					generation.current += 1;
				};
			}, [read]);
			const update = (patch) => {
				if (busy || state?.writable !== true) return;
				setBusy(true);
				setError(void 0);
				call("search/update", patch).then((value) => {
					setState(value);
					window.setTimeout(() => {
						read();
					}, SEARCH_SETTLE_MS);
				}).catch((failure) => setError(clearMessage(failure))).finally(() => setBusy(false));
			};
			const mode = state?.searchProvider;
			const backend = state?.searchBackend;
			const models = state?.models ?? {};
			const base = state?.effective?.base;
			const runtime = state?.effective?.runtime;
			const foreign = Object.entries(state?.foreign ?? {}).filter(([, present]) => present).map(([name]) => FOREIGN_NAMES[name] ?? name);
			const expected = OWN_SEARCH_IDS[mode];
			const overridden = expected !== void 0 && state?.applied?.state === "applied" && base !== void 0 && base !== expected;
			const disabled = busy || state?.writable !== true;
			const modeHint = {
				default: "searchModeDefaultHint",
				auto: "searchModeAutoHint",
				packycode: "searchModePackycodeHint"
			}[mode];
			const backendHint = backend === "gpt" ? fill(t("searchBackendGptHint"), { model: models.gpt ?? "gpt-6.1-sol" }) : fill(t("searchBackendDeepseekHint"), { model: models.deepseek ?? "deepseek-flash" });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
				title: t("searchTitle"),
				aside: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "pkc-chip",
					"data-tone": "neutral",
					children: t("searchScope")
				}),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "pkc-note",
						children: t("searchIntro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "pkc-note",
						children: t("searchCliHint")
					}),
					state === void 0 && error === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "pkc-note",
						role: "status",
						children: t("searchChecking")
					}),
					state !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pkc-setting",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "pkc-label",
								children: t("searchModeTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Segmented, {
								label: t("searchModeTitle"),
								value: mode,
								disabled,
								onChange: (value) => update({ searchProvider: value }),
								options: [
									{
										value: "default",
										label: t("searchModeDefault")
									},
									{
										value: "auto",
										label: t("searchModeAuto")
									},
									{
										value: "packycode",
										label: t("searchModePackycode")
									}
								]
							}), modeHint !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "pkc-note",
								children: t(modeHint)
							})] })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pkc-setting",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "pkc-label",
								children: t("searchBackendTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Segmented, {
								label: t("searchBackendTitle"),
								value: backend,
								disabled,
								onChange: (value) => update({ searchBackend: value }),
								options: [{
									value: "deepseek",
									label: t("searchBackendDeepseek")
								}, {
									value: "gpt",
									label: t("searchBackendGpt")
								}]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "pkc-note",
								children: backendHint
							})] })]
						}),
						state.available === true && (base !== void 0 || runtime !== void 0) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pkc-status",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "pkc-dot",
								"data-tone": overridden ? "warn" : expected !== void 0 && base === expected ? "success" : void 0
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "pkc-meta",
								children: fill(t("searchEffective"), {
									base: base ?? t("searchUnknown"),
									runtime: runtime ?? base ?? t("searchUnknown")
								})
							})]
						}),
						overridden && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "pkc-warn",
							children: fill(t("searchOverridden"), { base })
						}),
						foreign.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "pkc-note",
							children: fill(t("searchForeign"), { names: foreign.join(" / ") })
						}),
						state.applied?.state === "failed" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "pkc-error",
							role: "alert",
							children: fill(t("searchApplyFailed"), { error: state.applied.error ?? "" })
						}),
						state.available !== true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "pkc-note",
							children: t("searchUnavailable")
						}),
						state.writable !== true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "pkc-note",
							children: t("searchNotWritable")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "pkc-note",
							children: t("searchPatchNote")
						})
					] }),
					error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "pkc-error",
						role: "alert",
						children: `${t("searchLoadFailed")}: ${error}`
					})
				]
			});
		}
		const INSTALL_FAILURES = {
			"npm-missing": () => "cliNpmMissing",
			permission: (cli) => cli.platform === "win32" ? "cliPermissionWindows" : "cliPermission",
			network: () => "cliNetwork",
			timeout: () => "cliTimeout",
			"not-found-after-install": () => "cliNotFoundAfterInstall"
		};
		/** The sentence explaining a failed install, by the code the host classified. */
		function installFailure(cli, t) {
			const key = INSTALL_FAILURES[cli.install?.code]?.(cli);
			return key === void 0 ? void 0 : fill(t(key), { command: cli.command ?? "" });
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
			const failure = cli === void 0 ? void 0 : installFailure(cli, t);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
				title: t("cliTitle"),
				aside: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
					disabled: checking || running,
					onClick: () => check(true),
					children: checking ? t("refreshing") : t("cliRecheck")
				}),
				children: [
					cli === void 0 && error === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "pkc-note",
						children: t("cliChecking")
					}),
					usable && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pkc-status",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "pkc-dot",
									"data-tone": "success"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("cliInstalled") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: `${t("cliVersion")} ${cli.version}` })
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "pkc-meta",
							children: [
								t("cliPath"),
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "pkc-mono",
									children: cli.path
								})
							]
						}),
						cli.install?.state === "succeeded" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "pkc-note",
							children: t("cliInstallSucceeded")
						})
					] }),
					cli !== void 0 && !usable && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "pkc-callout",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "pkc-status",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "pkc-dot",
									"data-tone": cli.installed ? "danger" : "warn"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: cli.installed ? t("cliBroken") : t("cliMissing") })]
							}),
							cli.installed && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "pkc-meta",
								children: [
									t("cliPath"),
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "pkc-mono",
										children: cli.path
									})
								]
							}), cli.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
								className: "pkc-detail",
								children: cli.error
							})] }),
							cli.configuredPath !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "pkc-note",
								children: fill(t("cliConfiguredMissing"), { path: cli.configuredPath })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "pkc-note",
								children: t("cliMissingHint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "pkc-split",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
									variant: "primary",
									size: "md",
									disabled: running || checking,
									onClick: install,
									children: running ? t("cliInstalling") : cli.installed ? t("cliReinstall") : t("cliInstall")
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "pkc-note",
								children: [fill(t("cliInstallCommand"), { command: cli.command ?? "" }), cli.platform === "win32" && ` ${t("cliWindowsNote")}`]
							})
						]
					}),
					failed && !usable && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "pkc-error",
						children: failure === void 0 ? t("cliInstallFailed") : `${t("cliInstallFailed")} · ${failure}`
					}), cli.install.detail !== void 0 && cli.install.detail !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						className: "pkc-detail",
						children: cli.install.detail
					})] }),
					error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "pkc-error",
						children: `${t("error")}: ${error}`
					})
				]
			});
		}
		function VersionCard({ call, t }) {
			const [info, setInfo] = react.useState();
			const [loading, setLoading] = react.useState(true);
			const [error, setError] = react.useState(false);
			const [updating, setUpdating] = react.useState(false);
			const [updateFailed, setUpdateFailed] = react.useState(false);
			const [updated, setUpdated] = react.useState();
			const [restartHint, setRestartHint] = react.useState(false);
			const generation = react.useRef(0);
			const load = (force) => {
				const current = ++generation.current;
				setLoading(true);
				setError(false);
				call("plugin/version", { force }).then((value) => {
					if (generation.current === current) setInfo(value);
				}).catch(() => {
					if (generation.current === current) setError(true);
				}).finally(() => {
					if (generation.current === current) setLoading(false);
				});
			};
			react.useEffect(() => {
				load(false);
				return () => {
					generation.current += 1;
				};
			}, []);
			const update = () => {
				setUpdating(true);
				setUpdateFailed(false);
				call("plugin/update").then((value) => {
					setUpdated(value);
					setRestartHint(false);
				}).catch(() => setUpdateFailed(true)).finally(() => setUpdating(false));
			};
			const installKind = info?.install?.kind;
			const showStatus = info !== void 0 && updated === void 0;
			const canUpdate = showStatus && info.updateAvailable && installKind === "npm";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
				title: t("versionTitle"),
				aside: updated === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "pkc-actions",
					children: [canUpdate && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
						variant: "primary",
						disabled: updating,
						onClick: update,
						children: updating ? t("versionUpdating") : t("versionUpdate")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
						disabled: loading || updating,
						onClick: () => load(true),
						children: loading ? t("versionChecking") : t("versionCheck")
					})]
				}),
				children: [
					loading && info === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "pkc-note",
						role: "status",
						children: t("versionChecking")
					}),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "pkc-error",
						role: "alert",
						children: t("versionFailed")
					}),
					showStatus && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "pkc-status",
						role: "status",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "pkc-dot",
								"data-tone": info.updateAvailable ? "warn" : "success"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: `v${info.current}` }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "pkc-meta",
								children: [info.updateAvailable ? fill(t("versionAvailable"), { version: info.latest }) : t("versionUpToDate"), info.updateAvailable && ` · ${t("versionLatest")} v${info.latest}`]
							})
						]
					}),
					showStatus && installKind === "link" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "pkc-note",
						children: t("versionLinked")
					}),
					showStatus && info.updateAvailable && installKind === "unknown" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "pkc-note",
						children: t("versionManual")
					}),
					updateFailed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "pkc-error",
						role: "alert",
						children: t("versionUpdateFailed")
					}),
					updated !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "pkc-callout",
						"data-tone": "info",
						role: "status",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", {
								className: "pkc-title",
								children: fill(t("versionUpdated"), { version: updated.version })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "pkc-note",
								children: t("versionUpdatedHint")
							}),
							restartHint && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "pkc-note",
								children: t("versionRestartHint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "pkc-actions",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
										variant: "primary",
										onClick: () => window.location.reload(),
										children: t("versionRefresh")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
										onClick: () => setRestartHint(true),
										children: t("versionRestart")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
										variant: "ghost",
										onClick: () => setUpdated(void 0),
										children: t("versionLater")
									})
								]
							})
						]
					})
				]
			});
		}
		function PackyCodeSection({ rpc, t }) {
			const call = useCaller(rpc);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "pkc",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "pkc-intro",
						children: t("intro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountsCard, {
						call,
						t
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SearchCard, {
						call,
						t
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ClaudeCliCard, {
						call,
						t
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(VersionCard, {
						call,
						t
					})
				]
			});
		}
		function PackyCodeComposerQuota({ rpc, t, directory }) {
			const call = useCaller(rpc);
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
			const row = activeUsage(balance);
			const usage = row?.usage;
			const display = usage?.unlimitedQuota === true ? t("keyUnlimited") : formatUsd(usage?.availableUsd) ?? (row?.error === void 0 ? t("composerNoKey") : t("composerUnread"));
			const stale = row?.stale !== void 0 && usage !== void 0;
			const label = stale ? `${t("composerLabel")}: ${display}（${fill(t("composerStale"), { time: readTime(row.stale.fetchedAt) })}）` : `${t("composerLabel")}: ${display}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "pkc-composer",
				role: "status",
				"aria-label": label,
				title: label,
				children: stale ? `≈${display}` : display
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