<div align="center">

<img src="docs/assets/dsh-packycode-mascot.png" width="220" height="220" alt="DSH PackyCode API 吉祥物">

# DSH PackyCode API

**简体中文** · [English](README.en.md)

**用 PackyCode 的 API Key，在 DSH 里选模型、轮换 Key、看余额。**

安装后自带 `PackyCode` 模型分组，不用改 YAML，也不用另配 provider。

[![CI](https://github.com/BaronCyrus/dsh-packycode-api/actions/workflows/ci.yml/badge.svg)](https://github.com/BaronCyrus/dsh-packycode-api/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-packycode-api?logo=npm&label=npm)](https://www.npmjs.com/package/dsh-packycode-api)
[![npm 总下载量](https://img.shields.io/npm/dt/dsh-packycode-api?logo=npm&label=%E6%80%BB%E4%B8%8B%E8%BD%BD%E9%87%8F)](https://www.npmjs.com/package/dsh-packycode-api)
[![MIT](https://img.shields.io/badge/license-MIT-111111.svg)](LICENSE)
[![Star](https://img.shields.io/github/stars/BaronCyrus/dsh-packycode-api?style=flat&logo=github&label=Star)](https://github.com/BaronCyrus/dsh-packycode-api/stargazers)

[功能](#功能) · [安装](#安装) · [日常使用](#日常使用) · [模型与分组](#模型与分组) · [更新与卸载](#更新与卸载)

</div>

## 功能

| 能力 | 使用体验 |
| --- | --- |
| **自带模型路由** | 安装后模型选择器出现 `PackyCode` 分组，不需要配置 provider，也不用改 `cordis.patch.yml` |
| **多 Key 按顺序使用** | 额度用尽或 Key 被拒绝时自动切到下一个可用 Key；失败的那一步由重试接手 |
| **余额一眼可见** | 设置页列出每个 Key 的剩余、已用、额度和重置周期，并给出这些 Key 的合计；输入框右侧显示当前 Key 的剩余额度 |
| **Claude 走本机 CLI** | `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5` 由本机官方 Claude Code CLI 执行；设置页可以检测并一键安装 |
| **凭据不离开本机** | Key 只存在 DSH 凭据文件里。浏览器只能看到备注、状态和余额，拿不到 Key |

## 安装

先准备好 **DeepSeek Harness** 和 **PackyCode（PackyAPI）的 API Key**。尚未安装 DSH，可查看 [DSH 官方说明](https://github.com/deepseek-ai/deepseek-harness#run)。

### 1. 安装插件

打开桌面应用的**插件**页，点击**添加插件**，在**包名或地址**中填入：

```text
dsh-packycode-api
```

在**安装源**中选择**官方源**，然后点击**安装**。需要固定版本时填入 `dsh-packycode-api@1.0.2`。

完成后**手动重启桌面应用**。仅刷新页面不会重新加载 Host 里的插件。

### 2. 添加 Key

打开 **设置 → PackyCode**，在「添加 Key」里粘贴 API Key。备注可选，用来区分多个 Key。点「添加」。

> 不要把 Key 粘贴到公开 Issue、聊天记录或截图里。插件不会读取环境变量 `PACKY_CODE_API_KEY`，也不会在失败时偷偷改用别的 provider。

### 3. 选择模型

回到对话，在模型选择器里选 `PackyCode` 分组下的模型。`deepseek-flash` 和 `gpt-6.1-sol` 添加 Key 后即可用。三个 Claude 模型还需要本机装有 Claude Code CLI，见下文。

<details>
<summary>检查安装 / 其它 profile / 本地目录</summary>

桌面应用的**插件**页可以看到已安装状态与版本，也可以在那里启用、停用或卸载。

**仅用于非 desktop profile：** `dsh plugin --profile <name> add dsh-packycode-api@1.0.2`。不要对 `desktop` 使用它 —— CLI 会直接拒绝（`profile "desktop" is managed exclusively by the Electron application`）。

本地开发可以用绝对路径：`dsh plugin --profile <name> add link:/path/to/dsh-packycode-api`。

没有浏览器的 profile 也能走模型路由，只是看不到设置页和输入框额度。

</details>

## 日常使用

**换 Key。** Key 按添加顺序使用。点「切到此 Key」可以指定当前 Key；「重命名」改备注（最多 60 字，不能为空）；充值或更换后点「重新启用」。

**看余额。** 设置页的合计是**已列出的这些 Key** 的剩余、已用与额度，不是 PackyCode 账号下全部令牌的账单。读失败的 Key 不计入合计，并会注明个数。输入框右侧只在选中 PackyCode 模型时显示当前 Key 的剩余额度。「刷新」会跳过约 60 秒的缓存。默认模型接口是 `https://cf.api.fan`，余额接口是 `https://www.packyapi.com`，可在「高级：接口地址」里改。

**用 Claude。** 设置页顶部的「Claude Code CLI」卡片会检测本机 CLI。没装时点「安装 Claude Code CLI」，本机执行 `npm install -g @anthropic-ai/claude-code`（需要 Node.js 18+）。装好后不用重启 DSH。Windows 上另外需要 [Git for Windows](https://git-scm.com/downloads/win)。

<details>
<summary>什么时候会自动切换 Key</summary>

- **会切换并停用当前 Key：** 额度用尽（网关报额度、余额、insufficient quota 之类），或 Key 被拒绝（HTTP 401 / `无效的令牌`）。失败的那一步由 harness 重试，从而用上新 Key。
- **不会切换：** 限速（429）；网关把上游渠道故障误报成 400（`当前令牌未覆盖供应商 …`）；以及「只允许官方客户端」的 403。后一种会直接说明原因，而不是显示成 API Key 无效。
- 全部 Key 都停用时，请求失败并说明没有可用 Key，不会回退到别的凭据。

</details>

## 模型与分组

| 模型 | 怎么调用 | 推理档位 | 适合的令牌分组 |
| --- | --- | --- | --- |
| `deepseek-flash` | HTTP，chat/completions | 可关；`low` / `high` / `max` | `deepseek-officially`、`deepseek-sale` |
| `gpt-6.1-sol` | HTTP，Responses，可带图 | 不能关；`low` / `medium` / `high` / `xhigh` / `max` | `codex`、`codex-sale` |
| `claude-opus-5-5` | 本机 Claude Code CLI | 选择器档位同上，实际档位由 CLI 决定 | 要能给官方 CLI 用的分组，见下 |
| `claude-sonnet-5-5` | 同上 | 同上 | 同上 |
| `claude-haiku-5-5` | 同上；会话标题也固定走它 | 同上 | 同上 |

列表里看得到模型，不代表当前令牌分组一定放行。换分组时不要把对应分组一起去掉。

<details>
<summary>协议、分组和 CLI 的具体约束</summary>

- OpenAI / Codex 必须走 Responses。`gpt-6.1-sol` 已固定为 `openai-responses`，base URL 是 `https://cf.api.fan/v1`，不要把 `/responses` 写进根地址。
- Codex 分组的 Responses 请求必须带 `prompt_cache_key`，否则 403。harness 会带会话 id；没有会话 id 时插件补一个兜底值。
- Anthropic 的 base URL 不带 `/v1`（客户端自己拼 `/v1/messages`）。三个 Claude 模型虽然目录里声明了 Messages 协议，实际请求由本机 CLI 发出。
- `cc`（Claude Code 专用）只接受官方 Claude CLI。用普通 API 客户端调 Claude 会 403：`This API endpoint is only accessible via the official Claude CLI`。本插件因此调用本机 `claude`，而不是改去 `cc-sale`，也不是伪造客户端身份。令牌如果没有开放给官方 CLI 的分组，这三个模型仍然不可用。
- 选了 Claude 模型但本机没有 CLI 时，这一回合会直接说明未安装，并指向设置页的安装按钮。
- CLI 使用插件配置的地址和当前 Key（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`），以及独立配置目录 `~/.dsh/packycode-claude-cli`。不隔离的话，`~/.claude/settings.json` 里的 `env` 会盖掉插件 Key。
- CLI 权限默认跟随当前会话：`read-only` → 只读，`workspace-write` → 可编辑，`danger-full-access` 且不再审批 → `full`。CLI 不能向 DSH 弹审批，所以只要会话还要审批，就不会给它 `full`。也可把设置项 `claudeCliMode` 固定成 `read-only` / `edit` / `full`。`claudeCliPath` 留空则自动查找；`claudeCliCwd` 留空则用当前会话工作区。
- 思考过程和工具调用（`▸ Bash`、`▸ Read`，失败时带 `✗`）会出现在这一回合的思考区。它们是进度，不是 DSH 的工具调用。CLI 自己的工具不受 DSH 沙箱约束。
- 会话跑在 Claude 模型上时，生成标题改用 `claude-haiku-5-5`，只读、临时目录，避免为起标题跑一整轮 Opus。
- 另有 `claude_code` 工具：当前模型是 `gpt-6.1-sol` 或 `deepseek-flash` 时，可以把一个任务委派给本机 Claude Code。请求的 `mode` 不会超过会话权限允许的上限。
- 声明了模型不支持的推理档位会被 harness 在发请求前拒绝，不要随手改档位映射。

</details>

## 更新与卸载

**更新：** 在桌面应用的**插件**页重新安装 `dsh-packycode-api`（或 `dsh-packycode-api@版本`），然后完全退出并重新打开桌面应用。只刷新页面不会重载 Host。

**卸载：** 在**插件**页卸载本插件，然后重启桌面应用。卸载不会删除其它插件、整个 profile，也不会撤销 PackyCode 控制台里的令牌。

## 常见问题

**某个模型不可用，但 Key 是有效的？** 先看令牌分组是否覆盖这个模型。`cc` 分组不会把 Claude 交给普通 API 客户端；本插件的 Claude 模型要靠本机 CLI。分组拒绝不会停用 Key，也不会切到下一个 Key。

**余额对不上账号账单？** 设置页合计的是这里列出的 Key，不含同账号下没添加到本插件的其它令牌。个别 Key 读失败时会单独注明，不会被算成 0。

**限速之后 Key 被停用了？** 不该发生。429 不会切换 Key。额度用尽或 401 才会停用；充值后点「重新启用」。

**装了 CLI 还是不能用 Claude？** 从 Finder 或开始菜单启动时，`PATH` 往往比终端短。插件会再查官方安装位置、常见包管理器目录和 `npm prefix -g`。仍找不到就在设置里填 `claudeCliPath`，或点「重新检测」。改的是 Host 或重新安装了插件时，要完全退出并重启桌面应用。

## 安全边界

本项目是社区插件，与 DeepSeek、PackyCode 无隶属或背书关系。模型请求会发到你配置的 PackyCode 接口；凭据不返回浏览器，不代表推理在本地完成。Claude 模型还会在本机启动官方 CLI。

Key 存在本机 DSH 凭据文件（`~/.dsh/.credentials.yaml`，权限由 DSH 设为仅所有者可读），不进设置文档、日志或对话记录。余额请求只在宿主侧发出，带超时并禁止重定向。

普通问题请提交 [Issue](https://github.com/BaronCyrus/dsh-packycode-api/issues)。不要附带 Key、令牌或凭据文件内容。更多说明见 [SECURITY.md](SECURITY.md)。

## 本地开发

```sh
git clone https://github.com/BaronCyrus/dsh-packycode-api.git
cd dsh-packycode-api
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` 会跑全部测试、重新构建，并在 `.artifacts/` 打出 tarball。`lib/` 是已提交的构建产物，改 `src/` 后用 `pnpm run build` 生成，不要手改。

真机网关用 `node scripts/live-check.mjs` 验证。它会读本机已保存的 Key，并消耗少量额度。

使用 Agent 修改或发布时，先读 [AGENTS.md](AGENTS.md)。发布由推送 `v*` 标签触发 [Publish workflow](.github/workflows/publish.yml)，不要在本机执行 `npm publish`。

## License

[MIT](LICENSE)
