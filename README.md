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

[功能](#功能) · [安装](#安装) · [日常使用](#日常使用) · [模型与分组](#模型与分组) · [更新与卸载](#更新与卸载) · [支持作者](#支持作者)

</div>

## 功能

| 能力 | 使用体验 |
| --- | --- |
| **自带模型路由** | 安装后模型选择器出现 `PackyCode` 分组，不需要配置 provider，也不用改 `cordis.patch.yml` |
| **自选显示的模型** | 设置页的模型列表默认全选；取消勾选后，切换列表立即隐藏该模型，已有会话仍可继续使用 |
| **多 Key 按顺序使用** | 额度用尽或 Key 被拒绝时自动切到下一个可用 Key；失败的那一步由重试接手 |
| **按分组选 Key** | 每个 Key 后面列出它所在的 PackyCode 分组和能用的模型；当前 Key 的分组用不了所选模型（例如没有 cc 分组却选了 Claude）时，这一轮自动改用分组合适的 Key |
| **余额一眼可见** | 设置页列出每个 Key 的剩余、已用、额度、重置周期和用量条；输入框右侧显示当前 Key 的剩余额度 |
| **Claude 按分组选通道** | `cc` 分组只接受官方客户端，这些 Key 的 Claude 请求由本机 Claude Code CLI 发出；`cc-sale`、`cc-expensive`、`claude-officially` 等分组走插件内 HTTP。两条通道都由 DSH 执行工具、审批权限，计划模式、附件和完整对话历史完全一致 |
| **网页搜索可走 PackyCode** | 可选：DSH 的 `web_search` 改用 PackyCode 搜索，后端在 DeepSeek 与 GPT 之间切换；可只对 PackyCode 模型生效 |
| **图片生成与编辑** | 独立图片 Key，支持 GPT Image 2 / 2.5 Flare / 2.5 Sunburst、型号与质量设置、参考图编辑和 PNG 原图保存；已通过网关生图与编辑实测 |
| **凭据不离开本机** | Key 只存在 DSH 凭据文件里。浏览器只能看到备注、状态和余额，拿不到 Key |

<img width="774" height="455" alt="截屏2026-10-15 10 34 28" src="https://github.com/user-attachments/assets/060c4192-00ea-40e6-9b85-bbec605b5c31" />
<img width="575" height="522" alt="截屏2026-10-15 10 34 49" src="https://github.com/user-attachments/assets/89cf89ca-fce3-427d-95cb-94fa2b05d6aa" />
<img width="272" height="425" alt="截屏2026-10-13 10 07 46" src="https://github.com/user-attachments/assets/040fc57a-2dd2-4195-9bbc-5fa3357d1eb1" />

## 安装

先准备好 **DeepSeek Harness** 和 **PackyCode（PackyAPI）的 API Key**。尚未安装 DSH，可查看 [DSH 官方说明](https://github.com/deepseek-ai/deepseek-harness#run)。还没有 API Key 的，可以通过[这个邀请链接](https://www.packyapi.ai/register?aff=Im3l)注册 PackyCode 申请。

### 1. 安装插件

打开桌面应用的**插件**页，点击**添加插件**，在**包名或地址**中填入**带版本号**的包名：

```text
dsh-packycode-api@1.3.4
```

在**安装源**中选择**官方源**，然后点击**安装**。`1.3.4` 是写这份说明时的最新版，当前最新版本号以 [npm 页面](https://www.npmjs.com/package/dsh-packycode-api) 为准。

> **一定要带版本号。** 只填 `dsh-packycode-api` 时，安装前的提示显示的是 npm 上的最新版，但 DSH 自带的 pnpm 默认只安装发布满 24 小时的版本，实际装上的可能是好几个版本之前的旧版，而安装提示里看不出这一点。填写精确版本时，pnpm 会直接安装这个版本，并自动把它加入 profile 的 `minimumReleaseAgeExclude`。装好后可以在 **设置 → PackyCode → 插件版本** 核对「当前版本」。

首次安装后**无需重启 DSH**，可直接打开**设置 → PackyCode** 添加 Key。这适用于 1.1.7 及以后的版本；更早的版本首次安装后要重启一次，见「常见问题」。更新已加载的旧版时，按「插件版本」卡片的重启提示操作。

### 2. 添加 Key

打开 **设置 → PackyCode**，在「添加 Key」里粘贴 API Key。备注可选，用来区分多个 Key。点「添加」。还没有添加过 Key 时，「账户与 Key」里会显示同一个注册邀请链接，点击后在系统浏览器中打开；添加 Key 之后就不再显示。

> 不要把 Key 粘贴到公开 Issue、聊天记录或截图里。插件不会读取环境变量 `PACKY_CODE_API_KEY`，也不会在失败时偷偷改用别的 provider。

### 3. 选择模型

回到对话，在模型选择器里选 `PackyCode` 分组下的模型。十个模型都通过插件内 HTTP 调用；Key 的分组必须覆盖所选模型。

<details>
<summary>检查安装 / 其它 profile / 本地目录</summary>

桌面应用的**插件**页可以看到已安装状态与版本，也可以在那里启用、停用或卸载。

**仅用于非 desktop profile：** `dsh plugin --profile <name> add dsh-packycode-api@1.3.4`。不要对 `desktop` 使用它 —— CLI 会直接拒绝（`profile "desktop" is managed exclusively by the Electron application`）。

本地开发要加 `link:` 前缀：`dsh plugin --profile <name> add link:/path/to/dsh-packycode-api`。**不要直接写路径（或 `file:`）** —— 那样的安装会把整个仓库目录（连同 `node_modules`）复制进 profile，之后它会在 profile 内部挡住 DSH 自带的包，插件看起来像没装，见「常见问题」。已经那样装过的话，先卸载再按上面的方式重装。

没有浏览器的 profile 也能走模型路由，只是看不到设置页和输入框额度。

</details>

## 日常使用

**选择显示的模型。** 在 **设置 → PackyCode → 显示的模型** 中勾选要在切换列表里看到的模型，默认全选，也支持「全选」和「全不选」。选择保存在当前 profile，修改后立即生效；取消勾选不会中断已有会话。后续新增的模型默认勾选。

**换 Key。** Key 按添加顺序使用。点「切到此 Key」指定优先使用的 Key，下一轮就生效；「重命名」改备注（最多 60 字，不能为空）；充值或更换后点「重新启用」。

**看分组。** 「账户与 Key」里每个 Key 下面列出它所在的 PackyCode 分组（鼠标悬停可看分组说明），以及能用哪些模型：✓ 可用、◐ 部分可用、✕ 不可用。分组由网关自己报出（对一个不存在的模型 id 的拒绝里会写明「已选分组」，不产生费用），再对照 PackyCode 公开的模型分组表。Claude 的分组覆盖要按具体模型确认，不能假定 `cc-sale` 支持全部三个型号；GPT 需要 `codex` / `codex-sale`；DeepSeek 需要 `deepseek-officially` / `deepseek-sale`。

**看余额。** 「账户与 Key」里每个 Key 显示它自己的剩余、已用与额度（额度 = 剩余 + 已用），不限额的 Key 显示「不限额度」；多个 Key 不相加成合计。API Key 只能读到自己的额度，读不到 PackyCode 账号的总余额，账号余额请到 PackyCode 控制台查看。读失败的 Key 会在它那一行注明原因；某个 Key 这次读失败但之前读到过，会继续显示上次的余额并注明读取时间（输入框里显示为 `≈US$…`），重启 DSH 后才清空。输入框右侧只在选中 PackyCode 模型时显示当前 Key 的剩余额度。「刷新」会跳过约 60 秒的缓存。默认模型接口是 `https://cf.api.fan`，余额接口是 `https://www.packyapi.ai`，可在「高级：接口地址」里改。旧默认值 `https://www.packyapi.com` 在国内网络下 DNS 被污染、直连会 `fetch failed`，即使设置里保存的是它，插件也会先试 `.ai`。

**用 Claude。** 直接选择三个 Claude 模型之一。Key 在 `cc` 分组时，插件用本机的官方 Claude Code CLI 发出请求，需要先在 **设置 → PackyCode → Claude Code CLI** 一键安装（或自行 `npm install -g @anthropic-ai/claude-code`）；`cc-sale`、`cc-expensive`、`claude-officially` 等分组直接走插件内 HTTP，不需要 CLI。「账户与 Key」里每个能用 Claude 的 Key 会标出「Claude 经官方 CLI」或「Claude 经 HTTP」，也可以在 CLI 卡片里固定为「始终用 CLI」或「始终用 HTTP」。无论哪条通道，工具都由 DSH 执行并按 DSH 的权限审批，计划模式、提问、待办、子代理、附件、思考档位和历史都和其它模型一样。详见下方「Claude Code CLI 通道」。

**网页搜索。** DSH 的 `web_search` 默认调用 DeepSeek 官方接口（用 `DEEPSEEK_API_KEY` 计费）。在 **设置 → PackyCode → 网页搜索** 里可以改走 PackyCode：

| 搜索路由 | 效果 |
| --- | --- |
| 不接管（默认） | 不改 DSH 的搜索设置 |
| 自动（按模型路由） | PackyCode 模型用 PackyCode 搜索，其他模型照旧 |
| 始终使用 PackyCode 搜索 | 原本走 DSH 默认搜索的请求都改走 PackyCode |

| 搜索后端 | 模型与协议 | 说明 |
| --- | --- | --- |
| DeepSeek（默认） | `deepseek-flash`，`/v1/messages` + `web_search_20250305` | 每次约几千 token；需要 DeepSeek 分组 |
| GPT | `gpt-6.1-sol`，`/v1/responses` + `web_search` | 结果通常更新、更准，每次约 2–3 万输入 token；需要网关把这个 Key 的 GPT 请求路由到它的分组 |

PackyCode 没有专用搜索接口：一次搜索就是一次带服务端搜索工具的模型调用，用这里的 Key 计费，额度用尽或 Key 被拒绝时同样切到下一个 Key。

**Claude 的搜索。** Claude 对话使用 DSH 的 `web_search`，遵守上表的路由选择，搜索所用 Key 与其它原生模型遵循同一规则。

<details>
<summary>网页搜索是怎么接进 DSH 的</summary>

- 插件向 DSH 的 `web` 服务注册两个搜索后端：`packycode-api`（始终走 PackyCode）和 `packycode-api-auto`（按发起会话的模型路由）。只注册不会改变任何行为。
- 选「自动」或「始终」时，插件在当前 profile 的 `cordis.patch.yml` 末尾写入一段带 `# >>> dsh-packycode-api: web search provider` 标记的 `- id: web` 配置，把 web 行的基础 `searchProvider` 指向上面的后端；DSH 会热加载这个文件，不用重启。切回「不接管」会删掉这段，其它内容原样保留。
- 不直接改 web 运行时的搜索槽位：Codex、Kimi 等订阅插件每次 web 重启都会重写那个槽位，两边都写会互相触发重启。它们对自己不负责的模型会回退到 web 行的基础配置，所以写基础配置能和它们共存：Codex 模型仍走 Codex 搜索，其余请求才轮到这里的选择。
- 这段配置用注释记下写入前的基础搜索（`# fallback: …`）。「自动」模式下非 PackyCode 模型的请求交给它；如果它又把请求转回本插件，就直接交给 DSH 内置的 `deepseek-official`，不会循环。
- 结果只取结构化数据：DeepSeek 用 `web_search_tool_result` 块，GPT 用 `url_citation` 标注和 `web_search_call` 记录；模型写的摘要作为 `content` 一并返回。
- 当前 Key 的分组覆盖不到所选后端的模型（网关报 `当前令牌未覆盖供应商`）时，会试下一个 Key，不停用 Key；都不行就提示切换后端。
- 设置页会显示当前生效的基础搜索和运行时搜索。如果另一个插件的补丁排在后面并覆盖了基础搜索，这里会提示。

</details>

<details>
<summary>什么时候会自动切换 Key</summary>

- **会切换并停用当前 Key：** 额度用尽（网关报额度、余额、insufficient quota 之类），或 Key 被拒绝（HTTP 401 / `无效的令牌`）。失败的那一步由 harness 重试，从而用上新 Key。
- **按分组改用，不停用：** 分组读数显示当前 Key 用不了这一轮的模型、而另一个 Key 能用时，这一轮直接用那个 Key。「使用中」的 Key 不变，其它模型照常用它。只在有证据时才改用：分组还没读到的 Key 照旧使用。
- **不会切换：** 限速（429）；网关把上游渠道故障误报成 400（`当前令牌未覆盖供应商 …`）；以及「只允许官方客户端」的 403。网关表示「客户端已授权，无需发送连通性测试消息」的 403 单独记为 `GATEWAY_TEST_MESSAGE`，直接说明请求被当作测试消息拒绝，不禁用 Key。仅 Haiku 工具上下文可按下方规则原样重发一次。
- 全部 Key 都停用时，请求失败并说明没有可用 Key，不会回退到别的凭据。

</details>

### Claude Code CLI 通道

PackyCode 的 `cc` 分组（「claude code专用」）只接受官方 Claude Code 客户端。插件把这个分组的 Key 的 Claude 请求交给本机真实的 Claude Code CLI 发出，**CLI 只负责传输，Agent 仍然是 DSH**：

- **工具全部由 DSH 执行。** CLI 自带的 Bash、Read、Edit 等工具全部关闭；DSH 本轮提供的工具（包括 `exit_plan_mode`、`ask_user_question`、待办、子代理、MCP、生图等）通过只监听 127.0.0.1 的本机 MCP 桥，以 `mcp__dsh__<工具名>` 出现在请求里。模型发起的调用交回 DSH 执行，权限审批、沙箱、计划模式的审阅界面和工具卡片都与 HTTP 通道相同，结果再交给等待中的 CLI。
- **提示与历史保持 DSH 原样。** DSH 的系统提示追加在 CLI 官方提示之后；历史（文字、图片、带签名的思考、工具调用与结果）由插件写成 CLI 的会话记录后续接，思考档位以 `--effort` 传入。
- **一个会话一个常驻进程。** 同一个 DSH 会话、同一模型复用一个 CLI 进程：工具结果和下一轮消息直接续接，请求前缀不变，网关缓存照常命中。历史被压缩、切换计划模式或换 Key 时，用 DSH 的完整历史恢复一个新进程；会话标题和压缩用一次性进程。空闲 20 分钟的进程自动结束，最多同时保留 8 个。
- **与你自己的 Claude Code 隔离。** 使用独立配置目录 `~/.dsh/packycode-claude-cli`，不读取 `~/.claude` 的设置、CLAUDE.md、MCP 配置和登录状态；只把插件保存的 Key 交给子进程。自动更新、遥测、自动压缩、自动记忆和模型回退都关闭，失败重试交还给 DSH 的重试策略（会按 Key 轮换）。
- **出错会说清原因。** 未安装 CLI、CLI 版本过旧、官方 CLI 发出的请求仍被网关拒绝，分别给出说明和下一步，不会改走其它通道或提供商，也不会停用 Key。

已知差异：新进程启动约 0.3–1 秒；在一轮工具调用中途恢复进程时，CLI 会按官方行为在工具结果后附上一句 “Continue from where you left off.”。需要 Claude Code 2.1 以上（实测 2.1.295）。Windows 上 Claude Code 还需要 Git for Windows。

### 图片生成与编辑

在 **设置 → PackyCode → 图片生成与编辑 → 添加图片 Key** 填入专用 Key。它与「账户与 Key」里的对话 Key 分开保存；图片请求只用此处选择的 Key。添加 Key 不会自动发起付费测试。

图片卡片会显示每个图片 Key 的剩余、已用、额度、重置周期和使用进度，不汇总合计。余额每分钟更新，也可点卡片右上角的「刷新」；读取失败时保留上次余额并标出时间。图片 Key 变更或生图成功后会清理图片余额缓存。仅查询专用图片 Key 的额度，与对话 Key 的余额分开显示。

选择请求型号与质量后，可在 PackyCode 对话里点 **创建图片** 补充描述，或明确要求使用 `packycode_image_generate`。上传参考图后描述修改要求会调用 `/v1/images/edits`；新图调用 `/v1/images/generations`。图片型号独立于对话型号，其他插件的图片工具仍可并存。

Claude 与其它模型一样，通过 DSH 的 `packycode_image_generate` 工具生图、编辑图片并回传会话，使用独立的图片 Key、设置和余额缓存。旧版 CLI 会话已经保存的图片仍可查看，无需重新生成。

**详情里有图、主聊天却显示「图片无法预览」：** 图片结果会在主聊天单独展示，收起思维链或工具详情时仍可见，包括 PTC 嵌套调用。修复版重新打开历史对话也会用已保存的附件补出图片卡片，无需再次生图；模型回复里遗留的无效本机路径图片链接不影响这张卡片。

工具调用可将 `model` 和 `quality` 设为 `settings` 来跟随已保存的图片设置；`auto` 是一个明确的 API 质量档位。新图可省略 `referenceImages` 或传空数组；显式指定 `operation: edit` 时必须提供有效参考图，错误的真实参考图不会被丢弃后改生成新图。

`gpt-image-2` 的质量为 `auto / low / medium / high`；两款 2.5 另支持 `xhigh / max`。质量按 Images API 的 `quality` 原样发送，不作为文字推理强度；不会自动换型号、降档或重试付费请求。输出先采用 PNG，每次一张，聊天预览之外的原图保存在 `~/.dsh/packycode-api/images/`（设置了 `DSH_HOME` 时跟随该目录）。参考图与可选 PNG mask 必须来自当前会话；不能用路径替代附件引用。

点击生成图可在应用内查看大图，右上角关闭按钮左侧的「下载原图」可选择保存位置，另存本机保留的完整 PNG。取消保存不会报错；若原图已被移走或删除，会提示失败，不会改为下载聊天缩略图。已有会话也可使用此功能，前提是记录对应的本机原图仍存在。

用户填入图片 Key 后，可运行 `node scripts/image-check.mjs --all --edit` 验证三个型号与一次编辑；用 `--model <型号> --edit` 单独验证某个型号的生图和编辑，搭配 `--quality xhigh` 或 `--quality max` 验证质量。测试会消耗图片额度，输出写入 `.artifacts/`，日志只显示 Key 的掩码尾号，并记录网关回报的型号/质量。

2026-10-15 实测：三个型号均通过 `low` 生图与编辑；Sunburst 额外通过 `xhigh`、`max` 生图与编辑，两档响应的 quality 均与请求一致。合计 10 次成功请求，无重试，全部返回 1024×1024 PNG；编辑正确改色并保留构图。xhigh 生成/编辑约 43/48 秒，max 约 84/91 秒。这是已构建图片 client 的网关验证；本轮未新建 DSH 对话验证完整聊天流程。完整范围和记录见[协议核查与网关实测](docs/research/image-api.md)。

## 模型与分组

| 模型 | 怎么调用 | 推理档位 | 适合的令牌分组 |
| --- | --- | --- | --- |
| `deepseek-flash` | HTTP，chat/completions，可带图 | 可关；`low` / `high` / `max` | `deepseek-officially`、`deepseek-sale` |
| `gpt-6.1-sol` | HTTP，Responses，可带图 | 不能关；`low` / `medium` / `high` / `xhigh` / `max` | `codex`、`codex-sale` |
| `gpt-6-astra` | 同上 | 同上 | 同上 |
| `gpt-5.6-sol` | 同上 | 同上 | 同上 |
| `grok-4.7`（Grok 4.7） | HTTP，Responses，可带图；500k 上下文 | 不能关；`low` / `medium` / `high` / `xhigh` | 以设置页从网关读取的 Grok 分组覆盖为准 |
| `gemini-4-argon`（Gemini 4 Argon） | HTTP，Gemini 原生流式，可带图；1,048,576 上下文，65,536 输出 | 不能关；`low` / `medium` / `high` | `gemini-slb` |
| `gemini-3.8-flash`（Gemini 3.8 Flash） | HTTP，Gemini 原生流式，可带图；1,048,576 输入，65,536 输出 | 不能关；`low` / `medium` / `high` | `gemini-slb` |
| `claude-opus-5-5` | Anthropic Messages，可带图和原生工具：`cc` 分组经本机 Claude Code CLI，其它分组走 HTTP | 不能关；`low` / `medium` / `high` / `xhigh` / `max` | 以设置页读取的 Claude 分组覆盖为准 |
| `claude-sonnet-5-5` | 同上 | 同上 | 同上 |
| `claude-haiku-5-5` | 同上；Claude 会话标题固定走它 | 同上 | 同上 |

列表里看得到模型，不代表当前令牌分组一定放行。换分组时不要把对应分组一起去掉。

当前目录中的 10 个模型都声明了文字和图像输入。DeepSeek Flash 的识图能力按 [官方图像理解文档](https://api-docs.deepseek.com/zh-cn/guides/vision/) 配置；图片通过 DSH 附件服务读取，再随 chat/completions 请求发送。

Gemini 的能力与限制来自 Google 官方模型页：[Gemini 4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)、[Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)。两款模型统一使用 Gemini 原生协议，通过 `/v1beta/models/{model}:streamGenerateContent` 流式返回文字、思考和工具调用，图片仍由 DSH 附件服务读取。思考档位通过 `thinkingLevel` 传入。两者均使用单次流式输出上限，不执行超过 65,536 token 的自动续写。可用端点与分组以 [PackyAPI 实时模型目录](https://www.packyapi.com/api/pricing) 为准。

**Gemini 工具续聊的思维签名：** PackyCode 的 Gemini 原生通道在工具调用场景下不能正确处理思维签名，会返回 HTTP 400 `Invalid thought signature` / `Corrupted thought signature`，原样重发也无济于事（PackyCode 客服的答复）。因此插件对 Gemini 4 Argon 和 Gemini 3.8 Flash 不再回传模型返回的签名，而是按 [Google 文档](https://ai.google.dev/gemini-api/docs/thought-signatures) 在需要签名的位置填入跳过校验的值 `skip_thought_signature_validator`。协议、端点和模型都不变，DSH 的回放记录仍保留原始签名。Google 提示跳过签名可能削弱多步工具调用之间的推理连贯性。Flash 仍保留原有兜底：HTTP 400 签名拒绝且尚未输出任何流事件时，等待 1 秒原样重发一次。这类 400 不会被当作 Key 失效。

Grok 4.7 的上下文与推理档位来自 [官方文档](https://docs.x.ai/developers/grok-4-7)。官方没有单独限制文字输出长度；插件将输出上限设为上下文大小，并按每次请求的剩余上下文收紧。

Responses 请求只有 GPT 模型保留 `prompt_cache_key`，其他 Responses 模型默认省略。当前网关的 Grok 路由会将这个字段误报成 `Incorrect API key provided`。

<details>
<summary>协议、分组与客户端兼容性</summary>

- 除 `cc` 分组 Key 的 Claude 请求经本机 Claude Code CLI 发出外，其余模型均在插件内通过 HTTP 调用。Claude 使用 `anthropic-messages`，base URL 不带 `/v1`；SDK 会拼出 `/v1/messages`。模型、协议、上下文和档位映射保持不变。两条通道共用同一套请求构建：DSH 历史、附件、工具 schema 和签名回放先由插件转换成 Messages 请求，再交给 HTTP 或 CLI 发送，CLI 返回的原始流事件按同一协议解析。
- 走 HTTP 的 Claude 请求带上实测通过的 CLI 兼容请求头、Bearer 认证、会话元数据和身份系统提示前缀，并保留原始 DSH 系统说明、工具 schema、附件及签名回放。兼容版本固定为 `2.1.295`。
- Bearer 只来自插件保存并按模型选中的 Key；CLI 通道把同一个 Key 以 `ANTHROPIC_AUTH_TOKEN` 交给子进程，并清除继承环境里的 `ANTHROPIC_*` / `CLAUDE_*` 变量。不读取 CLI 登录状态、外部配置或环境 Key，不切换其它提供商。
- 通道由当前 Key 的分组决定（或在 CLI 卡片里固定），不会因为某次拒绝而自动换通道。分组还没读到时按 HTTP 发送；带 Claude 的请求会先等待最多约 6 秒的首次分组读取。客户端政策拒绝会直接说明原因，不禁用 Key。服务端规则变化可能使兼容处理失效，详见 [PackyCode 分组政策](https://docs.packyapi.ai/docs/token/)。
- Haiku 与 Sonnet 的工具请求都已出现「客户端异常」403 后相同请求成功的情况。插件只对这一特定响应等待 1 秒、原样重发一次；Haiku 另覆盖已捕获的「客户端已授权，无需发送测试消息」403，两种错误共用一次上限。再次拒绝仍会报错。Opus、纯文本请求、普通「只允许官方 CLI」拒绝、429 和已经开始的响应流不触发这次重发。原始失败保留在实测记录中；这不是网关内部判定已得到修复的证明。
- Claude 流收到 `message_stop` 后即可完成，不再等网关关闭 HTTP 连接；跨分片的 CRLF 换行保持完整。流内错误与取消仍会返回，未收到响应头的等待也不会被当作成功。
- DSH 的 bash/read/write/edit/glob/grep 在 HTTP 请求中使用已声明的 CLI 标准名称（如 `Bash`、`Read`），其它工具使用 MCP 命名；经 CLI 时所有 DSH 工具都以 `mcp__dsh__<名称>` 提供，并在系统提示末尾说明 CLI 自带工具不可用。回到 DSH 时仅还原本次实际提供的工具名称，未知名称不会获得执行权限。工具参数、调用 id、结果和历史签名不变。思考展示采用 CLI 默认：Haiku 为 `omitted`，Sonnet / Opus 为 `updates`（附带相应 beta）。所选推理强度和输出上限不变，空思考块的签名仍完整回传；明确指定的显示模式优先。
- Claude 请求中的旧工作目录句式会在与当前会话元数据一致时转换为单独的 JSON 路径，避免把提示语的句号复制进路径。真实目录名中的点、Windows 盘符、UNC、空格和反斜杠保持不变；命令参数不会被自动修剪。命令工具优先使用当前目录或 `workdir`，Windows 的 PowerShell 工具保持其原有语法。
- 两条通道的 Claude 对话都保留完整 DSH 工具循环、权限及计划模式；网页搜索和生图使用宿主工具。会话标题由 `claude-haiku-5-5` 生成（与对话走同一条通道）；GPT-6 Astra 与 GPT-5.6 Sol 的标题交给 GPT-6.1 Sol。
- 1.2.x 的 `claude_code` 委派工具和 `claudeCliMode`、`claudeCliCwd` 设置不再恢复：CLI 现在只是传输通道，不再用自带工具代替 DSH 执行任务。`claudeCliPath` 重新生效，用于指定 CLI 位置（留空则按常见安装位置和 PATH 查找）；`claudeTransport` 为 `auto` / `cli` / `http`。用户独立安装的 Claude Code 不会被改动。
- Codex 的 Responses 请求仍需要 `prompt_cache_key`；插件补上缺失的会话标识，其它 Responses 模型省略该字段。
- 构建后可用 `node scripts/claude-check.mjs` 验证三个 Claude 模型的订单核算、工单归类、库存补货、只读库存查询工具回传、商品色卡标注、中文标题和计划模式（只读查询 → `exit_plan_mode` 提交计划 → 审批），并核对业务答案；加 `--transport cli` 则全部经本机 Claude Code CLI 发出。`node scripts/claude-stability.mjs --start --hours 6 --key-label <备注名>` 开始有截止时间和请求上限的采样；定时执行同一脚本继续采样，用 `--status` 查看记录。业务场景版本和每轮构建分别记录；测试消息拒绝将对应检查记为失败，其余预定检查继续，真实凭据或额度错误仍会停止整个窗口。测试不改变已保存的凭据，也不启动 DSH。
- 连续对话可用 `node scripts/claude-conversation-check.mjs --model claude-haiku-5-5 --rounds 3 --key-label <备注名> --output .artifacts/claude-conversation.json`：同一插件适配器处理独立会话，每组保留六轮对话和完整工具历史，检查追问中的数值一致性、最终 JSON 和异常字符；遇到失败停止该批次并保留记录。单请求默认 65 秒、输出上限 2048 token；诊断可通过 `--timeout-ms`（5000–300000）和 `--max-tokens`（1024–128000）显式调整。`--capture-wire` 记录这组模拟业务的完整请求、非认证头和中断前的流事件，用于精确重放；不记录 Key。报告包含场景版本、适配器生命周期、所用上限、首响应和完整响应耗时。这些选项不修改插件的运行参数。

</details>

## 更新与卸载

> **从 1.3.2 或更早版本升级：** 请在插件页填写 `dsh-packycode-api@1.3.4` 安装，不要点旧版设置页里的「更新插件」。旧按钮安装时会绕过 pnpm 的发布冷却期：装到的版本如果发布还不满 24 小时，这个 profile 在它满 24 小时之前就装不了其他插件。装好并重启后，按钮就换成了修好的版本，以后直接点即可。

**更新：** 打开 **设置 → PackyCode**，有新版本时点「更新插件」。它会在当前 profile 目录里用 DSH 自带的 pnpm 安装精确版本，并读回 `package.json` 确认版本落地。安装遵守 pnpm 的发布冷却策略，不会绕过它：默认情况下 pnpm 会直接装上这个版本，并把它记进 profile 的 `minimumReleaseAgeExclude`；如果你给 pnpm 配了更严格的策略，按钮会提示什么时候可以更新。本地 `link:` 开发安装不会出现这个按钮。完成后完全退出并重新打开桌面应用。只刷新页面不会重载 Host。也可以在**插件**页重新安装，同样要填写带版本号的包名（例如 `dsh-packycode-api@1.3.4`），否则装上的可能是发布满 24 小时的旧版。

**从本地路径安装切回官方源时，必须先卸载。** 「更新」是 `pnpm add`，它只重写包目录里的文件，不会删除更早一次本地路径安装留在包目录内的 `node_modules`；那份旧依赖会继续挡住 DSH 自带的包，插件行加载失败且看不出原因。「卸载」执行的是 `pnpm remove`，会删掉整个包目录，重装才是干净的。用 `node scripts/install-check.mjs` 可以确认当前 profile 是否处于这个状态。

**卸载：** 用过 PackyCode 网页搜索的话，先在 **设置 → PackyCode → 网页搜索** 切回「不接管」，再到**插件**页卸载本插件，然后重启桌面应用。否则 `cordis.patch.yml` 里会留下指向已卸载后端的 web 配置，`web_search` 会报 `configured web provider "packycode-api-auto" is not registered`；这时手动删掉带 `dsh-packycode-api: web search provider` 标记的那一段即可。卸载不会删除其它插件、整个 profile，也不会撤销 PackyCode 控制台里的令牌。

## 常见问题

**装好了，但设置里完全没有 PackyCode 这一项？** 说明插件行在启动时加载失败了 —— DSH 只在宿主日志里记录这件事，设置页不会显示原因。先用仓库里的 `node scripts/install-check.mjs` 查一次（只读，不发网络请求）；手动检查则是看这个目录是否存在：

```sh
ls ~/.dsh/profiles/desktop/node_modules/dsh-packycode-api/node_modules
```

有输出就是残留：从 npm 安装的包不会自带 `node_modules`，这一份通常来自更早一次「本地路径」安装（`file:` 或直接写路径，而不是 `link:`）。它位于 profile 目录内部，而 DSH 解析插件导入时优先使用 profile 内的副本，所以插件拿到的仍是那份旧依赖 —— 例如 `@deepseek-ai/schemastery` 3.18.2 没有 `Schema.volatile()`，模块在导入阶段就抛错。导入失败时 Loader 不会为这一行创建 fiber，客户端 bundle 也不会被组合，于是模型路由、RPC 通道和设置页全都不会出现。

修复：到**插件**页**卸载**本插件，再用带版本号的包名重新**安装**（例如 `dsh-packycode-api@1.3.4`），然后完全退出并重新打开桌面应用。卸载执行的是 `pnpm remove`，会删掉整个包目录；直接重装或点「更新」只重写文件，不会清掉这份残留。也可以手动删掉上面那个 `node_modules` 再重启。

**首次安装后，设置页每张卡片都显示 `transport failure for /packycode-api/…: HTTP 405`？** 实际装上的是 1.1.6 或更早的版本，通常是因为安装时只填了包名：安装提示显示的是最新版，pnpm 实际装的却是发布满 24 小时的旧版（见「安装插件」）。这些旧版要等 DSH 重启、重建它的 `connection` 服务之后，才能注册设置通道。所以首次安装后 `/packycode-api` 通道还不存在，请求落到静态页面，返回 405；模型路由和设置页本身照常加载。1.1.7 起首次安装不需要重启。先确认装上的版本：

```sh
grep '"version"' ~/.dsh/profiles/desktop/node_modules/dsh-packycode-api/package.json
```

处理：完全退出并重新打开桌面应用，旧版即可正常使用。然后在 **设置 → PackyCode → 插件版本** 点「检查更新」→「更新插件」（它会固定安装最新版，不受 24 小时规则限制），再重启一次。

**某个模型不可用，但 Key 是有效的？** 看「账户与 Key」里这个 Key 的分组和 ✓ / ✕：分组不覆盖这个模型时，换一个分组合适的 Key，或在 PackyCode 控制台给 Key 加上对应分组。存了分组合适的 Key 时，插件会自动用它跑这个模型。分组拒绝不会停用 Key。

**Claude 报「只接受官方 Claude Code CLI」或「客户端存在异常」？** 这是网关的客户端政策拒绝，不等于 Key 失效。看这个 Key 下方标的是「Claude 经 HTTP」还是「经官方 CLI」：`cc` 分组的 Key 应该走 CLI，若 CLI 卡片被固定成了「始终用 HTTP」，改回「按分组自动」。经官方 CLI 发出的请求仍被拒时，错误里会附上网关原文（含 request id），先把 Claude Code 更新到最新版（`claude update`）再试，仍失败可发给 PackyCode 客服。插件不会因此禁用 Key 或切换提供商。

**提示「本机没有可用的 Claude Code CLI」？** 当前 Key 在 `cc` 分组，需要本机 CLI。到 **设置 → PackyCode → Claude Code CLI** 点「安装」，或在终端执行 `npm install -g @anthropic-ai/claude-code` 后点「重新检测」；装在非常规位置时可在配置里填 `claudeCliPath`。不想装的话，换用 `cc-sale` / `cc-expensive` 分组的 Key。

**余额对不上账号账单？** 设置页只显示这里列出的每个 Key 自己的额度，不含同账号下没添加到本插件的其它令牌。API Key 读不到账号的总余额，请到 PackyCode 控制台查看。个别 Key 读失败时会在它那一行注明。

**余额显示 `读取失败: https://www.packyapi.com: fetch failed`？** 这是 1.0.4 及更早版本的默认余额接口在国内网络下被 DNS 污染，开了代理才能连上，所以有时正常、有时失败。新版本默认改用 `https://www.packyapi.ai`。模型列表是插件内置的，不需要向 PackyCode 查询，不受影响。

**选了 Claude 模型一直显示「深度求索中」？** 查看 DSH 的错误或诊断信息。429/503 表示网关排队或限流，按宿主重试策略处理；客户端政策拒绝会直接说明原因。只有走 CLI 通道的 Claude 请求会启动本机 Claude Code CLI，它在 90 秒内毫无输出会被结束并报告。

**限速之后 Key 被停用了？** 不该发生。429 不会切换 Key。额度用尽或 401 才会停用；充值后点「重新启用」。

**插件页安装报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`？** pnpm 默认只接受发布满 24 小时的版本，并且会检查 profile 里的整个 lockfile。（只填本插件的包名不会报这个错，而是悄悄装上满 24 小时的旧版，见「安装插件」。）报错里点名的往往是另一个刚更新过的插件，不是本插件。等它发布满 24 小时再重试，或把报错里的 `包名@版本` 加到 profile 目录 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 下。已安装本插件后，设置页的「更新插件」不受这个限制。

**网页搜索报「no stored API key's group covers …」？** 所选搜索后端的模型不在你的令牌分组里（或网关暂时把它路由到了别的供应商）。在 **设置 → PackyCode → 网页搜索** 换一个后端，或添加分组覆盖它的 Key。

**需要安装 Claude Code 吗？** 只有 Key 在 `cc` 分组、又要用 Claude 模型时需要（或在 CLI 卡片里固定了「始终用 CLI」）。插件用独立配置目录运行它，不改动你自己的 Claude Code 安装、登录和设置；其它分组和其它模型都不需要。

**回答被截断（「已达到输出 token 上限」）、请求反复失败，怎么反馈？** 打开 **设置 → PackyCode → 诊断信息**，选出问题的会话（最近 20 个，按时间倒序，标着所在文件夹名），点「生成诊断信息」再点「复制」，把内容贴到 [Issue](https://github.com/BaronCyrus/dsh-packycode-api/issues) 或发给插件作者。内容只有设置和数字：插件版本、会话 id 与创建时间、每个 Key 的序号与分组（不含备注名和 Key 本身）、每次请求用的模型、推理档位和输出上限、最近若干步的 token 用量与结束原因，以及重试和失败的错误码（错误信息已脱敏并截短）。不含对话内容、文件路径和 Key。复制不可用时，文本会被全选，按 ⌘C 或 Ctrl+C 即可。

## 安全边界

本项目是社区插件，与 DeepSeek、PackyCode 无隶属或背书关系。模型请求会发到你配置的 PackyCode 接口；凭据不返回浏览器，不代表推理在本地完成。`cc` 分组的 Claude 请求由本机 Claude Code CLI 子进程发出：Key 只以环境变量交给它，DSH 工具通过只监听 127.0.0.1、带随机凭证的 MCP 桥提供，工具本身仍由 DSH 在宿主侧执行。

Key 存在本机 DSH 凭据文件（`~/.dsh/.credentials.yaml`，权限由 DSH 设为仅所有者可读），不进设置文档、日志或对话记录。余额请求只在宿主侧发出，带超时并禁止重定向。

普通问题请提交 [Issue](https://github.com/BaronCyrus/dsh-packycode-api/issues)，请求出错时可附上「诊断信息」卡片生成的内容。不要附带 Key、令牌或凭据文件内容。更多说明见 [SECURITY.md](SECURITY.md)。

## 本地开发

```sh
git clone https://github.com/BaronCyrus/dsh-packycode-api.git
cd dsh-packycode-api
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` 会跑全部测试、重新构建，并在 `.artifacts/` 打出 tarball。`lib/` 是已提交的构建产物，改 `src/` 后用 `pnpm run build` 生成，不要手改。

真机网关用 `node scripts/live-check.mjs` 验证：它通过插件注册的同一条路由，读余额和分组、让每个 HTTP 模型回答一次、演练 Key 轮换和失败分类，只打印 Key 的末 4 位。加 `--with-search` 会每个搜索后端各搜一次；默认运行只消耗少量额度。

排查「装了却看不到插件」用 `node scripts/install-check.mjs`：它只读当前 profile，列出被包内残留 `node_modules` 挡住的宿主包（含版本）和对应的修复步骤，发现问题时以退出码 1 结束；`--profile <name>`、`--home <dir>` 可指定其它 profile，`--json` 输出结构化结果。

使用 Agent 修改或发布时，先读 [AGENTS.md](AGENTS.md)。发布由推送 `v*` 标签触发 [Publish workflow](.github/workflows/publish.yml)：先发布到 npm，再用 `docs/releases/v<版本>.md` 和同一个包创建 GitHub Release。不要在本机执行 `npm publish`。

## License

[MIT](LICENSE)

## 支持作者

本插件免费开源，赞赏全凭心意。如果它让你在 DSH 里用 PackyCode 省了不少折腾，欢迎扫码支持，让插件持续跟上新模型和新版 DSH。

<table align="center">
  <tr>
    <td align="center"><img src="docs/assets/sponsor-wechat.png" width="200" alt="微信赞赏码"><br><b>微信赞赏</b></td>
    <td align="center"><img src="docs/assets/sponsor-alipay.png" width="200" alt="支付宝收款码"><br><b>支付宝</b></td>
  </tr>
</table>
