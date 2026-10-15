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
| **自选显示的模型** | 设置页的模型列表默认全选；取消勾选后，切换列表立即隐藏该模型，已有会话仍可继续使用 |
| **多 Key 按顺序使用** | 额度用尽或 Key 被拒绝时自动切到下一个可用 Key；失败的那一步由重试接手 |
| **按分组选 Key** | 每个 Key 后面列出它所在的 PackyCode 分组和能用的模型；当前 Key 的分组用不了所选模型（例如没有 cc 分组却选了 Claude）时，这一轮自动改用分组合适的 Key |
| **余额一眼可见** | 设置页列出每个 Key 的剩余、已用、额度、重置周期和用量条，并给出这些 Key 的合计；输入框右侧显示当前 Key 的剩余额度 |
| **Claude 走本机 CLI** | `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5` 由本机官方 Claude Code CLI 执行；设置页可以检测并一键安装 |
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
dsh-packycode-api@1.2.9
```

在**安装源**中选择**官方源**，然后点击**安装**。`1.2.9` 是写这份说明时的最新版，当前最新版本号以 [npm 页面](https://www.npmjs.com/package/dsh-packycode-api) 为准。

> **一定要带版本号。** 只填 `dsh-packycode-api` 时，安装前的提示显示的是 npm 上的最新版，但 DSH 自带的 pnpm 默认只安装发布满 24 小时的版本，实际装上的可能是好几个版本之前的旧版，而安装提示里看不出这一点。填写精确版本时，pnpm 会直接安装这个版本，并自动把它加入 profile 的 `minimumReleaseAgeExclude`。装好后可以在 **设置 → PackyCode → 插件版本** 核对「当前版本」。

首次安装后**无需重启 DSH**，可直接打开**设置 → PackyCode** 添加 Key。这适用于 1.1.7 及以后的版本；更早的版本首次安装后要重启一次，见「常见问题」。更新已加载的旧版时，按「插件版本」卡片的重启提示操作。

### 2. 添加 Key

打开 **设置 → PackyCode**，在「添加 Key」里粘贴 API Key。备注可选，用来区分多个 Key。点「添加」。还没有添加过 Key 时，「账户与 Key」里会显示同一个注册邀请链接，点击后在系统浏览器中打开；添加 Key 之后就不再显示。

> 不要把 Key 粘贴到公开 Issue、聊天记录或截图里。插件不会读取环境变量 `PACKY_CODE_API_KEY`，也不会在失败时偷偷改用别的 provider。

### 3. 选择模型

回到对话，在模型选择器里选 `PackyCode` 分组下的模型。`deepseek-flash`、`gpt-6.1-sol`、`gpt-6-astra`、`grok-4.7`、`gemini-4-argon` 和 `gemini-3.8-flash` 通过 HTTP 调用；三个 Claude 模型还需要本机装有 Claude Code CLI，见下文。Key 的分组必须覆盖所选模型。

<details>
<summary>检查安装 / 其它 profile / 本地目录</summary>

桌面应用的**插件**页可以看到已安装状态与版本，也可以在那里启用、停用或卸载。

**仅用于非 desktop profile：** `dsh plugin --profile <name> add dsh-packycode-api@1.2.9`。不要对 `desktop` 使用它 —— CLI 会直接拒绝（`profile "desktop" is managed exclusively by the Electron application`）。

本地开发要加 `link:` 前缀：`dsh plugin --profile <name> add link:/path/to/dsh-packycode-api`。**不要直接写路径（或 `file:`）** —— 那样的安装会把整个仓库目录（连同 `node_modules`）复制进 profile，之后它会在 profile 内部挡住 DSH 自带的包，插件看起来像没装，见「常见问题」。已经那样装过的话，先卸载再按上面的方式重装。

没有浏览器的 profile 也能走模型路由，只是看不到设置页和输入框额度。

</details>

## 日常使用

**选择显示的模型。** 在 **设置 → PackyCode → 显示的模型** 中勾选要在切换列表里看到的模型，默认全选，也支持「全选」和「全不选」。选择保存在当前 profile，修改后立即生效；取消勾选不会中断已有会话。后续新增的模型默认勾选。

**换 Key。** Key 按添加顺序使用。点「切到此 Key」指定优先使用的 Key，下一轮就生效；「重命名」改备注（最多 60 字，不能为空）；充值或更换后点「重新启用」。

**看分组。** 「账户与 Key」里每个 Key 下面列出它所在的 PackyCode 分组（鼠标悬停可看分组说明），以及能用哪些模型：✓ 可用、◐ 部分可用、✕ 不可用。分组由网关自己报出（对一个不存在的模型 id 的拒绝里会写明「已选分组」，不产生费用），再对照 PackyCode 公开的模型分组表。Claude 需要 `cc` / `cc-sale` / `cc-expensive` / `claude-officially` 之一（`claude-haiku-5-5` 只在 `cc` 和 `claude-officially`）；GPT 需要 `codex` / `codex-sale`；DeepSeek 需要 `deepseek-officially` / `deepseek-sale`。

**看余额。** 「账户与 Key」顶部的合计是**已列出的这些 Key** 的剩余、已用与额度，不是 PackyCode 账号下全部令牌的账单。读失败的 Key 不计入合计，并会注明个数；某个 Key 这次读失败但之前读到过，会继续显示上次的余额并注明读取时间（输入框里显示为 `≈US$…`），重启 DSH 后才清空。输入框右侧只在选中 PackyCode 模型时显示当前 Key 的剩余额度。「刷新」会跳过约 60 秒的缓存。默认模型接口是 `https://cf.api.fan`，余额接口是 `https://www.packyapi.ai`，可在「高级：接口地址」里改。旧默认值 `https://www.packyapi.com` 在国内网络下 DNS 被污染、直连会 `fetch failed`，即使设置里保存的是它，插件也会先试 `.ai`。

**用 Claude。** 设置页的「Claude Code CLI」卡片会检测本机 CLI。每一轮 Claude 对话的思考区都会写明这一轮用的是哪个 Key（只显示备注名）。没装时点「安装 Claude Code CLI」，本机执行 `npm install -g @anthropic-ai/claude-code`（需要 Node.js 18+）。装好后不用重启 DSH。Windows 上另外需要 [Git for Windows](https://git-scm.com/downloads/win)。

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

**Claude CLI 的搜索。** Claude 模型和 `claude_code` 委派工具都通过临时 MCP 搜索工具使用上表选定的 DeepSeek/GPT 后端，原生 `WebSearch` 被禁用。原因是原生搜索会额外发一个 Claude 服务端搜索子请求，PackyCode 的 Claude 上游可能把它拒为「不是官方 CLI」，即使普通对话能正常工作。新的调用链是：

```text
Claude Code CLI → 本机临时 MCP web_search → 插件选定的 DeepSeek/GPT 后端
```

- **后端选择对 CLI 生效；路由选择只影响 DSH。** 即使选了「不接管」，CLI 搜索仍用这里选的后端，不转到 DSH 默认搜索。更改后端后下一次搜索即使用新选择。
- Claude 普通对话仍需要 Claude 分组；搜索需要存入插件的 Key 覆盖 DeepSeek 或 GPT 分组，可以是另一个 Key。搜索错误会返回给 CLI，不伪造成功、不自动切另一个后端。
- 只读、编辑模式单独自动允许这个只读 MCP 搜索工具，不增加 Shell 或文件写权限；用户/管理员的拒绝规则仍有效。CLI 的 `--allowedTools` 是自动批准列表，不是可用工具的排他列表，已有其他工具权限保持原样。
- 每轮最多 8 次搜索，最多同时 2 次；查询不超过 2000 字符，每次最多 8 个来源，整体搜索预算 60 秒。标题生成不启动 MCP 或进行搜索。
- 思考区会显示 `▸ 网页搜索：PackyCode DeepSeek（MCP，原生 WebSearch 已禁用）`（或 GPT）。临时服务只监听 `127.0.0.1`，配置中仅含本机一次性凭证，不含搜索 API Key；CLI 结束、取消、超时或插件卸载时关闭并清理，不修改用户现有 MCP 配置。

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
- **按分组改用，不停用：** 分组读数显示当前 Key 用不了这一轮的模型、而另一个 Key 能用时，这一轮直接用那个 Key（Claude 轮次会在思考区写明「当前 Key「A」的分组不能用 …，本轮改用 Key「B」」）。「使用中」的 Key 不变，其它模型照常用它。只在有证据时才改用：分组还没读到的 Key 照旧使用。
- **不会切换：** 限速（429）；网关把上游渠道故障误报成 400（`当前令牌未覆盖供应商 …`）；以及「只允许官方客户端」的 403。后一种会直接说明原因，而不是显示成 API Key 无效。
- 全部 Key 都停用时，请求失败并说明没有可用 Key，不会回退到别的凭据。

</details>

### 图片生成与编辑

在 **设置 → PackyCode → 图片生成与编辑 → 添加图片 Key** 填入专用 Key。它与「账户与 Key」里的对话 Key 分开保存；图片请求只用此处选择的 Key。添加 Key 不会自动发起付费测试。

图片卡片会显示每个图片 Key 的剩余、已用、限额（接口有提供时）、重置周期和使用进度，并单独汇总图片额度。余额每分钟更新，也可点卡片右上角的「刷新」；读取失败时保留上次余额并标出时间。图片 Key 变更或生图成功后会清理图片余额缓存。仅查询专用图片 Key 的额度，不叠加账户级账单，也不混入对话 Key 的合计。

选择请求型号与质量后，可在 PackyCode 对话里点 **创建图片** 补充描述，或明确要求使用 `packycode_image_generate`。上传参考图后描述修改要求会调用 `/v1/images/edits`；新图调用 `/v1/images/generations`。图片型号独立于对话型号，其他插件的图片工具仍可并存。

三个 Claude 模型走本机官方 CLI 时，以及 `claude_code` 委派时，均可通过临时 MCP 图片工具生图和编辑：`Claude Code CLI → 本机 MCP → 插件图片服务 → PackyCode Images API`。它复用同一份图片设置、独立图片 Key 和余额缓存；图片 Key 不会交给 CLI。CLI 只使用宿主提供的本会话图片句柄（`referenceIds` / 可选 `maskId`），可以继续编辑本轮刚生成的图片。成功结果作为图片保存进 DSH 会话，聊天重放也能展示，PNG 原图另存本机。每轮最多四次图片尝试、同一时间一张；请求取消时一并停止图片请求。计划模式和标题生成不开放生图工具。创建图片按钮在 Claude 对话中保留。

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
| `grok-4.7`（Grok 4.7） | HTTP，Responses，可带图；500k 上下文 | 不能关；`low` / `medium` / `high` / `xhigh` | 以设置页从网关读取的 Grok 分组覆盖为准 |
| `gemini-4-argon`（Gemini 4 Argon） | HTTP，Gemini 原生流式，可带图；1,048,576 上下文，65,536 输出 | 不能关；`low` / `medium` / `high` | `gemini-slb` |
| `gemini-3.8-flash`（Gemini 3.8 Flash） | HTTP，Gemini 原生流式，可带图；1,048,576 输入，65,536 输出 | 不能关；`low` / `medium` / `high` | `gemini-slb` |
| `claude-opus-5-5` | 本机 Claude Code CLI | 选择器档位同上，实际档位由 CLI 决定 | 能给官方 CLI 用的分组，比如cc分组 |
| `claude-sonnet-5-5` | 同上 | 同上 | 同上 |
| `claude-haiku-5-5` | 同上；会话标题也固定走它 | 同上 | 同上 |

列表里看得到模型，不代表当前令牌分组一定放行。换分组时不要把对应分组一起去掉。

当前目录中的 9 个模型都声明了文字和图像输入。DeepSeek Flash 的识图能力按 [官方图像理解文档](https://api-docs.deepseek.com/zh-cn/guides/vision/) 配置；图片通过 DSH 附件服务读取，再随 chat/completions 请求发送。

Gemini 的能力与限制来自 Google 官方模型页：[Gemini 4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)、[Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)。两款模型统一使用 Gemini 原生协议，通过 `/v1beta/models/{model}:streamGenerateContent` 流式返回文字、思考和工具调用，图片仍由 DSH 附件服务读取。思考档位通过 `thinkingLevel` 传入。两者均使用单次流式输出上限，不执行超过 65,536 token 的自动续写。可用端点与分组以 [PackyAPI 实时模型目录](https://www.packyapi.com/api/pricing) 为准。

**Flash 原生工具续聊：** 网关偶尔会拒绝原样回传的有效签名，返回 `Corrupted thought signature` / `Invalid thought signature`。插件仅在当前工具续聊、HTTP 400 且尚未输出任何流事件时，等待 1 秒，用相同 Key、签名及请求原样重发一次；再次失败时仍返回原错误，不更换协议或模型。文字、图片和工具续聊均已实测；该处理缓解网关的间歇性拒绝，不能保证修复持续性的上游签名错误。

Grok 4.7 的上下文与推理档位来自 [官方文档](https://docs.x.ai/developers/grok-4-7)。官方没有单独限制文字输出长度；插件将输出上限设为上下文大小，并按每次请求的剩余上下文收紧。

Responses 请求只有 GPT 模型保留 `prompt_cache_key`，其他 Responses 模型默认省略。当前网关的 Grok 路由会将这个字段误报成 `Incorrect API key provided`。

<details>
<summary>协议、分组和 CLI 的具体约束</summary>

- OpenAI / Codex 必须走 Responses。`gpt-6.1-sol` 和 `gpt-6-astra` 已固定为 `openai-responses`，base URL 是 `https://cf.api.fan/v1`，不要把 `/responses` 写进根地址。
- Codex 分组的 Responses 请求必须带 `prompt_cache_key`，否则 403。harness 会带会话 id；没有会话 id 时插件补一个兜底值。
- Anthropic 的 base URL 不带 `/v1`（客户端自己拼 `/v1/messages`）。三个 Claude 模型虽然目录里声明了 Messages 协议，实际请求由本机 CLI 发出。
- `cc`（Claude Code 专用）只接受官方 Claude CLI。用普通 API 客户端调 Claude 会 403：`This API endpoint is only accessible via the official Claude CLI`。本插件因此调用本机 `claude`，而不是改去 `cc-sale`，也不是伪造客户端身份。令牌如果没有开放给官方 CLI 的分组，这三个模型仍然不可用。
- 选了 Claude 模型但本机没有 CLI 时，这一回合会直接说明未安装，并指向设置页的安装按钮。
- CLI 使用插件配置的地址和当前 Key（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`），以及独立配置目录 `~/.dsh/packycode-claude-cli`。不隔离的话，`~/.claude/settings.json` 里的 `env` 会盖掉插件 Key。
- CLI 权限默认跟随当前会话：`read-only` → 只读，`workspace-write` → 可编辑，`danger-full-access` 且不再审批 → `full`。CLI 不能向 DSH 弹审批，所以只要会话还要审批，就不会给它 `full`。也可把设置项 `claudeCliMode` 固定成 `read-only` / `edit` / `full`。DSH 计划模式优先于该映射和这个固定档：CLI 以 `--permission-mode plan --permission-prompt-tool stdio` 只读探索，每轮在工作目录内创建一个独占的隐藏临时计划目录（CLI 不接受工作区外的自定义计划目录）；只存计划工件，不改项目代码或设置，工作区不可写时明确失败。`ExitPlanMode` 交给 DSH 审阅，不允许 CLI 在同一进程开始实施；只在本轮目录中查找未显式提交的计划，结束时清理。原生和 PTC 工具模式都支持审阅，完整计划及审阅反馈会带到下一轮；超过对话预算会明确报错，不静默截断约束。批准或 `/plan off` 在下一步生效，同一工具批次内的委派仍遵守当前计划状态。会话标题不进入计划模式。`claudeCliPath` 留空则自动查找；`claudeCliCwd` 留空则用当前会话工作区。
- 思考过程和工具调用（`▸ Bash`、`▸ Read`，失败时带 `✗`）会出现在这一回合的思考区。它们是进度，不是 DSH 的工具调用。CLI 自己的工具不受 DSH 沙箱约束。
- 思考区第一行是「▸ 启动 Claude Code CLI…」，CLI 起来后显示版本和模型。网关限流或繁忙（429、503 `账号并发排队已满` 等）时，CLI 会自己重试最多 10 次，每次重试都会显示成 `↻ 网关返回 HTTP 503，CLI 自动重试 n/10`，不再像卡住。重试用完仍失败时，会说明是 PackyCode 的 Claude 上游繁忙，不是 Key 的问题。CLI 启动后 2 分钟内没有任何输出会被停止并报告原因。
- 对话记录和图片通过 stdin 交给 CLI（`--input-format stream-json`），不走命令行参数：Windows 命令行长度有上限，而且命令行带不了图片。对话里的图片会以图片形式发给 Claude（与 HTTP 路由相同的压缩规格：每张不超过 2048×2048、约 1 MiB；一回合最多 20 张、合计 20 MiB，超出时先舍弃最早的）。没随消息发出的图片会写明本机只读副本的路径，CLI 需要时可以用 Read 读取。
- 每次运行都带 `--append-system-prompt`（委派说明）。在 `-p` 模式下，官方 CLI 有追加说明时会以 "You are Claude Code, Anthropic's official CLI for Claude …" 自我介绍，没有时是 "You are a Claude agent, built on Anthropic's Claude Agent SDK."；后者曾被上游当成非官方 CLI 拒绝（403 `only accepts requests from the official Claude Code CLI`）。这是官方 CLI 自己的行为，插件没有改写它的系统提示词。
- 会话跑在 Claude 模型上时，生成标题改用 `claude-haiku-5-5`，只读、临时目录，避免为起标题跑一整轮 Opus。DSH 的标题要求在 CLI 里只是追加在它自己系统提示词后面的一段，「在吗」这类很短的消息曾被起成 `{"title": "Casual greeting check-in"}` 这样的英文 JSON。所以插件会在提示词末尾再强调一次：只回标题纯文本，用消息原文的语言（中文、日文、韩文按文字直接点名）。回复里仍带 JSON、代码块、引号或「Title:」前缀时，插件会先剥掉再交给 DSH。如果回复有好几行（模型把思考或解释也写了出来，分不清哪行是标题），或者只是「对话标题」这类占位词，就不给标题，DSH 会保留按首条消息生成的默认标题。
- 会话跑在 `gpt-6-astra` 上时，标题改由 `gpt-6.1-sol` 生成（同一个 Codex 分组）；对话本身仍然用 Astra。其它模型的标题由会话模型自己生成。
- 另有 `claude_code` 工具：当前模型是 `gpt-6.1-sol`、`gpt-6-astra` 或 `deepseek-flash` 时，可以把一个任务委派给本机 Claude Code。请求的 `mode` 不会超过会话权限允许的上限；会话处于计划模式时，这个委派也只规划，并把计划正文交回父模型。
- 声明了模型不支持的推理档位会被 harness 在发请求前拒绝，不要随手改档位映射。

</details>

## 更新与卸载

**更新：** 打开 **设置 → PackyCode**，有新版本时点「更新插件」。它会在当前 profile 目录里用 DSH 自带的 pnpm 安装精确版本，并读回 `package.json` 确认版本落地。本地 `link:` 开发安装不会出现这个按钮。完成后完全退出并重新打开桌面应用。只刷新页面不会重载 Host。也可以在**插件**页重新安装，同样要填写带版本号的包名（例如 `dsh-packycode-api@1.2.9`），否则装上的可能是发布满 24 小时的旧版。

**从本地路径安装切回官方源时，必须先卸载。** 「更新」是 `pnpm add`，它只重写包目录里的文件，不会删除更早一次本地路径安装留在包目录内的 `node_modules`；那份旧依赖会继续挡住 DSH 自带的包，插件行加载失败且看不出原因。「卸载」执行的是 `pnpm remove`，会删掉整个包目录，重装才是干净的。用 `node scripts/install-check.mjs` 可以确认当前 profile 是否处于这个状态。

**卸载：** 用过 PackyCode 网页搜索的话，先在 **设置 → PackyCode → 网页搜索** 切回「不接管」，再到**插件**页卸载本插件，然后重启桌面应用。否则 `cordis.patch.yml` 里会留下指向已卸载后端的 web 配置，`web_search` 会报 `configured web provider "packycode-api-auto" is not registered`；这时手动删掉带 `dsh-packycode-api: web search provider` 标记的那一段即可。卸载不会删除其它插件、整个 profile，也不会撤销 PackyCode 控制台里的令牌。

## 常见问题

**装好了，但设置里完全没有 PackyCode 这一项？** 说明插件行在启动时加载失败了 —— DSH 只在宿主日志里记录这件事，设置页不会显示原因。先用仓库里的 `node scripts/install-check.mjs` 查一次（只读，不发网络请求）；手动检查则是看这个目录是否存在：

```sh
ls ~/.dsh/profiles/desktop/node_modules/dsh-packycode-api/node_modules
```

有输出就是残留：从 npm 安装的包不会自带 `node_modules`，这一份通常来自更早一次「本地路径」安装（`file:` 或直接写路径，而不是 `link:`）。它位于 profile 目录内部，而 DSH 解析插件导入时优先使用 profile 内的副本，所以插件拿到的仍是那份旧依赖 —— 例如 `@deepseek-ai/schemastery` 3.18.2 没有 `Schema.volatile()`，模块在导入阶段就抛错。导入失败时 Loader 不会为这一行创建 fiber，客户端 bundle 也不会被组合，于是模型路由、RPC 通道和设置页全都不会出现。

修复：到**插件**页**卸载**本插件，再用带版本号的包名重新**安装**（例如 `dsh-packycode-api@1.2.9`），然后完全退出并重新打开桌面应用。卸载执行的是 `pnpm remove`，会删掉整个包目录；直接重装或点「更新」只重写文件，不会清掉这份残留。也可以手动删掉上面那个 `node_modules` 再重启。

**首次安装后，设置页每张卡片都显示 `transport failure for /packycode-api/…: HTTP 405`？** 实际装上的是 1.1.6 或更早的版本，通常是因为安装时只填了包名：安装提示显示的是最新版，pnpm 实际装的却是发布满 24 小时的旧版（见「安装插件」）。这些旧版要等 DSH 重启、重建它的 `connection` 服务之后，才能注册设置通道。所以首次安装后 `/packycode-api` 通道还不存在，请求落到静态页面，返回 405；模型路由和设置页本身照常加载。1.1.7 起首次安装不需要重启。先确认装上的版本：

```sh
grep '"version"' ~/.dsh/profiles/desktop/node_modules/dsh-packycode-api/package.json
```

处理：完全退出并重新打开桌面应用，旧版即可正常使用。然后在 **设置 → PackyCode → 插件版本** 点「检查更新」→「更新插件」（它会固定安装最新版，不受 24 小时规则限制），再重启一次。

**某个模型不可用，但 Key 是有效的？** 看「账户与 Key」里这个 Key 的分组和 ✓ / ✕：分组不覆盖这个模型时，换一个分组合适的 Key，或在 PackyCode 控制台给 Key 加上对应分组。存了分组合适的 Key 时，插件会自动用它跑这个模型。分组拒绝不会停用 Key。

**Claude 报「PackyCode 的上游拒绝了这次 Claude Code CLI 请求」或「只接受官方 Claude Code CLI」？** 最常见的原因是这一轮用的 Key 没有 Claude 分组：PackyCode 对这种 Key 也会回这句话（或 400 `当前令牌未覆盖供应商`）。现在报错会直接写明「本轮使用的 Key「…」所在分组（…）不包含能用 claude-… 的分组」，并说明不需要更新 CLI。只有 Key 确实有 Claude 分组时仍被拒，才需要按报错里的提示检查 CLI 版本或联系 PackyCode。

**余额对不上账号账单？** 设置页合计的是这里列出的 Key，不含同账号下没添加到本插件的其它令牌。个别 Key 读失败时会单独注明，不会被算成 0。

**余额显示 `读取失败: https://www.packyapi.com: fetch failed`？** 这是 1.0.4 及更早版本的默认余额接口在国内网络下被 DNS 污染，开了代理才能连上，所以有时正常、有时失败。新版本默认改用 `https://www.packyapi.ai`。模型列表是插件内置的，不需要向 PackyCode 查询，不受影响。

**选了 Claude 模型一直显示「深度求索中」？** 看思考区：有 `↻ 网关返回 HTTP 503/429` 说明 PackyCode 的 Claude 上游在排队或限流，CLI 正在自动重试；只有「▸ 启动 Claude Code CLI…」没有「已启动」，说明本机 CLI 没起来（Windows 上先确认装了 Git for Windows，并在终端执行 `claude --version`）。

**限速之后 Key 被停用了？** 不该发生。429 不会切换 Key。额度用尽或 401 才会停用；充值后点「重新启用」。

**插件页安装报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`？** pnpm 默认只接受发布满 24 小时的版本，并且会检查 profile 里的整个 lockfile。（只填本插件的包名不会报这个错，而是悄悄装上满 24 小时的旧版，见「安装插件」。）报错里点名的往往是另一个刚更新过的插件，不是本插件。等它发布满 24 小时再重试，或把报错里的 `包名@版本` 加到 profile 目录 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 下。已安装本插件后，设置页的「更新插件」不受这个限制。

**网页搜索报「no stored API key's group covers …」？** 所选搜索后端的模型不在你的令牌分组里（或网关暂时把它路由到了别的供应商）。在 **设置 → PackyCode → 网页搜索** 换一个后端，或添加分组覆盖它的 Key。

**装了 CLI 还是不能用 Claude？** 从 Finder 或开始菜单启动时，`PATH` 往往比终端短。插件会再查官方安装位置、常见包管理器目录和 `npm prefix -g`。仍找不到就在设置里填 `claudeCliPath`，或点「重新检测」。改的是 Host 或重新安装了插件时，要完全退出并重启桌面应用。

**回答被截断（「已达到输出 token 上限」）、请求反复失败，怎么反馈？** 打开 **设置 → PackyCode → 诊断信息**，选出问题的会话（最近 20 个，按时间倒序，标着所在文件夹名），点「生成诊断信息」再点「复制」，把内容贴到 [Issue](https://github.com/BaronCyrus/dsh-packycode-api/issues) 或发给插件作者。内容只有设置和数字：插件版本、会话 id 与创建时间、每个 Key 的序号与分组（不含备注名和 Key 本身）、每次请求用的模型、推理档位和输出上限、最近若干步的 token 用量与结束原因，以及重试和失败的错误码（错误信息已脱敏并截短）。不含对话内容、文件路径和 Key。复制不可用时，文本会被全选，按 ⌘C 或 Ctrl+C 即可。

## 安全边界

本项目是社区插件，与 DeepSeek、PackyCode 无隶属或背书关系。模型请求会发到你配置的 PackyCode 接口；凭据不返回浏览器，不代表推理在本地完成。Claude 模型还会在本机启动官方 CLI。

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

真机网关用 `node scripts/live-check.mjs` 验证：它通过插件注册的同一条路由，读余额和分组、让每个 HTTP 模型回答一次、演练 Key 轮换和失败分类，只打印 Key 的末 4 位。加 `--with-cli` 会用本机 Claude Code CLI 跑三个 Claude 模型，加 `--with-search` 会每个搜索后端各搜一次；默认运行只消耗少量额度。

Claude CLI 的 MCP 接口验证用 `node scripts/cli-search-check.mjs`：运行真实 CLI，普通 Claude 响应和搜索数据默认由本地测试服务模拟，不消费额度；会检查三种权限模式、原生搜索禁用和临时资源清理。加 `--live --backend deepseek` 或 `--live --backend gpt` 会让只读模式的那一次搜索走真实后端（其它两种模式仍模拟）。这不等于验证了真实 Claude 上游对话或运行中的 DSH 集成。

图片 MCP 验证用 `node scripts/cli-image-check.mjs`：真实官方 CLI 依次生图、用生成结果编辑，并经 DSH 消息组装器验证持久化图片；默认 Claude 和图片网关响应均在本地模拟，同时检查只读/编辑/完全权限、计划模式、标题和临时配置清理。加 `--live` 会用已保存的独立图片 Key 向真实图片网关发出一次 Sunburst `low` 生图与一次编辑，结果写入 `.artifacts/`；Claude 回复仍由本地模拟网关提供。加 `--with-claude` 则连 Claude 也走真实网关，默认 Haiku，另消费对话额度；两者都不启动或重启 DSH，也不等于验证了运行中桌面会话。

计划模式另用 `node scripts/cli-plan-check.mjs` 验证：真实 CLI 对接本地模拟网关，检查 stdio 计划提交、并发计划归属、本轮文件回退、旧计划隔离、实际拒绝次数上限和清理；不读取真实凭据、不消费额度、不启动 DSH。

排查「装了却看不到插件」用 `node scripts/install-check.mjs`：它只读当前 profile，列出被包内残留 `node_modules` 挡住的宿主包（含版本）和对应的修复步骤，发现问题时以退出码 1 结束；`--profile <name>`、`--home <dir>` 可指定其它 profile，`--json` 输出结构化结果。

使用 Agent 修改或发布时，先读 [AGENTS.md](AGENTS.md)。发布由推送 `v*` 标签触发 [Publish workflow](.github/workflows/publish.yml)，不要在本机执行 `npm publish`。

## License

[MIT](LICENSE)
