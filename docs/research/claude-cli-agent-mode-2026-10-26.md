# cc 通道改为 Claude Code 代理模式：设计方案

> 状态：已在 1.4.0 实现（2026-10-26）。文中的实验脚本在维护者本机的会话临时目录里，不在仓库中。
>
> 实现时和下文的差异：
>
> - **提问：** 不改写成 `ask_user_question` 工具，而是在镜像工具里直接调 DSH 的 `userQuestions.ask()`。原因是无头配置不注册这个工具；用的是同一个提问界面。
> - **插话：** DSH 带着插话来要下一步时，CLI 几乎总是已经发出了下一次请求。所以插件先 `interrupt` 这次请求，再把插话作为下一条消息发出，保证 DSH 拿到的那一步回复读过这句话。
> - **镜像工具的注册时机：** 每轮开始时决定这一轮的通道，走 CLI 就注册，否则撤下。原因是 DSH 在调用模型前就定下本步的工具列表，而自动审查只审查列表里有的工具：第一步才注册的话，该步的调用会因 “pending native tool schema is missing” 被拒。模型取会话自己在选择器里选的（DSH 的 `modelSelection` 投影），不取 agent 创建时的配置。
> - **桌面端检查发现、在发版前修掉的问题（2026-10-26）：**
>   - 桌面端（Web 界面）把计划模式放在每个会话的 agent 预设隔离域里，插件用自己的 `ctx.get('planMode')` 取不到，`/plan` 从来没切到 Claude Code；它在 acceptEdits 下改了文件，DSH 却还停在计划审阅。现在经 `agentPresets.serviceFor(agent, …)` 取服务；ExitPlanMode 也只在 CLI 真处于计划模式时才变成计划审阅。
>   - DSH 给自己的 agent 附加的消息（运行环境、每步的时间、技能列表、`AGENTS.md`、审批和计划模式提示）原样转给了 CLI：第一次只读请求就用掉 64K token，第二步的时间提示还被当成插话，打断了 CLI 已经发出的请求。现在只转发用户自己的消息（`src/claude-user-text.js`）。
>   - 先用别的模型建会话、再换成 Claude 时，每轮开始都会按 agent 创建时的模型把镜像工具撤掉，第一步的工具列表里没有它。
>   - 分组读取经本机代理变慢时，第一个请求在 6 秒内没等到分组，按“未知走 HTTP”被网关拒绝；读取失败的结果还会缓存 10 分钟。按维护者的意见改为分组未知时走 CLI，一轮从 CLI 开始就在 CLI 上做完，读取失败 30 秒后重读。同时修了单分组 Key 的新拒绝文案读不出分组的问题（#3）。
> - **其他补充：**
>   - 进程中途意外退出时报 502，交给 DSH 重试，重试时续接原会话。
>   - CLI 自动压缩上下文的那次请求按 `status: compacting` 跳过，不算 DSH 的一步。
>   - CLI 自己发起的轮次（定时任务）会被中断。
>   - 实测 2.1.259 也支持全部用到的参数和控制帧，最低版本不变。

## 1. 为什么要改

用户在 cc Key 上遇到 `本轮运行失败 … 我们检测到您的客户端存在异常 … 请避免任何基于我方 API 二次分发的 API 转接接入`。

**原因：** PackyCode 的 cc 分组按请求内容判断是不是 Claude Code 自己在工作，跟由哪个程序发出无关。现在的 cc 通道（1.3.4 起）把官方 CLI 当传输层用：

- 关掉 CLI 自带的全部工具（`--tools ""`）；
- 把 DSH 的系统提示词追加进去（开头是 "You are an AI agent powered by DeepSeek Harness"）；
- 再把 DSH 的工具通过 MCP 交给 CLI。

请求虽然是官方二进制发的，内容却是 DSH 的 agent，网关因此判它为“转接”。

**实测**（2026-10-25，同一台机器、同一个 cc Key，CLI 2.1.295，部分组合也用 2.1.310 复测）：

| 启动方式 | 结果 |
|---|---|
| 插件现状：`scripts/claude-check.mjs --transport cli`，15 项 | 7 项失败。6 项是带 DSH 工具的请求被判“客户端异常”，另 1 项 Haiku 图片请求触发“反滥用”检测 |
| 插件现状，换一个编码类问题 | 4 次运行都在第一个请求被拒 |
| 保留 CLI 工具，只追加 DSH 系统提示词 | 4/7 个请求被拒（2.1.310：2/4） |
| 只加 DSH 工具（MCP），不追加提示词 | 1/7 被拒 |
| 只加插件那组环境变量（遥测关闭等） | 0/6 |
| CLI 用自己的系统提示词和工具（paseo 的方式），含多轮、授权、换进程续接、计划模式 | **0/79** |

另外，升级到 2.1.310 后结果相同，所以现在报错里“先更新 CLI”的建议是错的。

**paseo 的做法：** 用官方 Agent SDK 的 `query()` 启动用户本机的 CLI。

- 系统提示词用 Claude Code 自带的，默认什么都不追加。
- 工具用 CLI 自己的，也由 CLI 执行。
- 权限请求走 `canUseTool` 回调，交给 paseo 的界面处理。

本方案照这个思路改：**cc Key 的 Claude 会话由 Claude Code 自己当 agent，DSH 负责界面、授权、计划审阅和提问。**

## 2. 不做的事

- **不伪装：** 不把 DSH 的提示词或工具伪装成 Claude Code 的来躲过检测。cc 分组标明“不支持第三方”，那样做等于规避它的客户端检查。
- **不改路由：** 路由仍只看分组，cc 走 CLI，其他分组走 HTTP。不加开关，不在 CLI 和 HTTP 之间自动回退。
- **不碰用户的 Claude 配置：** 不读用户自己的 Claude 登录、设置和环境变量里的密钥，只用插件里保存的 Key。

## 3. 总体结构

```
DSH agent 循环 ──一步──▶ 插件 cc 通道 ──stdin(stream-json)──▶ 常驻 Claude Code CLI ──▶ PackyCode
     ▲   │ 执行本步工具调用        │  ◀──stdout(stream-json)────┘   （CLI 自己的提示词、工具、会话）
     │   ▼                         │
 授权弹窗 / 计划审阅 / 提问  ◀── 镜像工具 claude_code、exit_plan_mode、ask_user_question
```

- **一步 = CLI 的一次 API 响应。** 现在这套“一个 DSH 会话对应一个常驻 CLI 进程、一步一步续接”的骨架原样保留：CLI 每发一次请求，它的流式事件原样回放成 DSH 这一步的 SSE；文本、思考、用量照旧经 pi-ai 解析。
- **变化在工具调用。** CLI 响应里的 `tool_use` 不再是 DSH 工具，改写成下面三种之一：
  - **`claude_code`（镜像工具，新增）**：CLI 的普通工具调用（Bash、Read、Edit、Write、WebFetch、Agent 等），参数改写成 `{tool, input}`。
    - 这个工具注册在该会话的 agent 作用域里（`agent.ctx.tools.register`），只有 cc 会话看得见，会话结束自动撤销。
    - 它**不自己执行**：只负责把 DSH 的授权结论交给 CLI，再把 CLI 执行出的结果显示在卡片上。
  - **`exit_plan_mode`（DSH 自己的工具）**：CLI 的 ExitPlanMode。
  - **`ask_user_question`（DSH 自己的工具）**：CLI 的 AskUserQuestion。
- **一轮结束：** CLI 输出 `result` 且最后一次响应是 `end_turn` 时，这一步以 stop 结束，DSH 这一轮结束。进程留着，等下一条用户消息。

**为什么这样可行：** DSH 是在执行时按名字解析工具（`tools.get(name, agent)`），不会拿本步发给模型的工具列表比对，所以运行中注册的作用域工具能被执行。DSH 的前置检查链返回 `ask` 时，会自动走审批服务，弹窗挂在对应的工具卡片上（`approval.request({ callId })`）；官方“自动审查”也挂在同一条链上（`tools/pre-execute`，prepend）。

## 4. 启动方式

已在真实网关实测：3 个模型共 27 个请求，0 次被拒。

| 参数 / 环境变量 | 作用 | 和现在相比 |
|---|---|---|
| `--input-format stream-json --output-format stream-json --verbose --include-partial-messages` | 双向流 | 不变 |
| `--permission-prompt-tool stdio` | CLI 要授权时发 `can_use_tool` 控制帧给插件 | 新增 |
| `--permission-mode <映射值>`，`--allow-dangerously-skip-permissions` | 见第 6 节；第二个参数用来允许之后切到 bypass | 新增 |
| `--setting-sources user` | 只读插件自己 CLI 目录里的设置，不读项目的 `.claude/settings.json`（避免仓库里的 hooks、env 把 Key 引去别处） | 原来是 `''` |
| `--strict-mcp-config`（不传 MCP 配置） | 不加载项目的 `.mcp.json`，请求里没有 MCP 工具 | 去掉 DSH 的 MCP 桥 |
| `--session-id <uuid>` / `--resume <uuid>` | CLI 自己的会话持久化在 `~/.dsh/packycode-claude-cli/projects/` | 原来是 `--no-session-persistence` 加插件写的转写文件 |
| `--model`、`--effort` | 同现在 | 不变 |
| ~~`--tools ""`、`--append-system-prompt-file`、`--disable-slash-commands`~~ | | **去掉**：系统提示词和工具保持 Claude Code 原样 |
| `CLAUDE_CONFIG_DIR=~/.dsh/packycode-claude-cli`，`ANTHROPIC_BASE_URL`，`ANTHROPIC_AUTH_TOKEN`，剥掉继承的 `ANTHROPIC_*`/`CLAUDE_*` | 隔离和鉴权 | 不变 |
| `DISABLE_AUTOUPDATER`、`DISABLE_TELEMETRY`、`DISABLE_ERROR_REPORTING`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 不自动更新，不发遥测 | 不变 |
| `CLAUDE_CODE_MAX_RETRIES=0`，关掉模型回退 | 一次 API 请求就是 DSH 的一步，重试和换 Key 归 DSH | 不变 |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | 不让 CLI 在插件目录里自己记“记忆” | 不变 |
| ~~`DISABLE_AUTO_COMPACT`、`DISABLE_COMPACT`、`CLAUDE_CODE_DISABLE_CLAUDE_MDS`、MCP 超时三项~~ | | **去掉**：CLI 自己压缩上下文，并读项目里的 CLAUDE.md |

## 5. 一步里的工具调用怎么走

以 CLI 想执行 `rm -rf build` 为例：

1. CLI 的响应流里出现 `tool_use Bash {command}`。插件把它改写成 `claude_code {tool:"Bash", input:{command}}`，本步以 tool-calls 结束。DSH 立刻显示一张终端卡片（镜像工具的 `presentCall`）。
2. **DSH 前置检查**（插件的 agent 作用域 `tools/pre-execute`）：先等 CLI 对这个 `tool_use_id` 的判定。
   - 收到 `can_use_tool`：CLI 要授权，返回 `ask`，理由里写明“Claude Code 请求执行：rm -rf build（由本机 Claude Code 执行，不经过 DSH 沙箱）”。DSH 弹出授权，挂在这张卡片上。
     - 自动审查预设下返回 `allow`，让官方自动审查来判定：它批准就放行，它拒绝时再问用户。
   - 没有请求授权、CLI 已经开始或做完这个调用（只读工具、只读命令）：返回 `allow`。
3. **执行**（镜像工具的 `execute`）：如果 CLI 在等授权，回复 `allow`；然后等 CLI 输出这个调用的 `tool_result`，原样返回。卡片显示真实输出。
4. **被拒**（用户拒绝、审批策略为 never、自动审查拒绝、取消）：DSH 不会执行镜像工具。插件在 `tools/result` 里看到这个结果，就回复 CLI `deny`，并把 DSH 的拒绝原因原样带回去。实测 CLI 会把这段原因作为工具错误交给模型。
5. **下一步**：DSH 带着工具结果再次请求。插件核对这些结果正是 CLI 在等的调用，然后接着回放 CLI 的下一次 API 响应。镜像结果的内容不重复发给 CLI，CLI 手里已经有真实结果。

已录到的 `can_use_tool` 帧：`{subtype, tool_name, display_name, input, description, permission_suggestions, blocked_path, tool_use_id}`。回复格式：

- 允许：`{behavior:"allow", updatedInput}`
- 拒绝：`{behavior:"deny", message}`

## 6. 权限映射

| DSH 状态 | CLI 模式 | CLI 什么时候问 | 谁来回答 |
|---|---|---|---|
| 计划模式开启 | `plan` | ExitPlanMode；计划文件以外的写操作由 CLI 自己拒绝 | DSH 计划审阅（第 7 节） |
| 预设 `workspace-write` + 审批 `ask`（DSH 默认） | `acceptEdits`（待定，见第 16 节） | 非只读的 Bash、工作目录外的文件、WebFetch 等 | DSH 授权弹窗（单次允许） |
| 预设 `auto`（自动审查） | `default` | 写文件、非只读 Bash、WebFetch 等 | 官方自动审查，它拒绝时问用户 |
| 预设 `danger-full-access` + 审批 `never` | `bypassPermissions` | 不问 | — |
| 其他组合（custom） | 审批 `never` 时用 `default`，CLI 问的一律拒绝；审批 `ask` 时同默认预设 | | |

- **运行中切换：** 每一步开始前，读 `permissionPresets.current(session)` 和计划模式状态。和上一步不同时，给常驻进程发 `set_permission_mode`。实测 `set_permission_mode` 对常驻进程立即生效。
- **“总是允许”：** CLI 给的 `permission_suggestions`（总是允许某条命令）不采用。DSH 的审批只有单次允许，同一类调用下次还会问。

## 7. 计划模式

1. DSH `/plan` 后，下一步开始时把 CLI 切到 `plan`。
2. CLI 让模型把计划写进 `<CLI 目录>/plans/<slug>.md`（实测 Sonnet 和 Opus 都写了，文件第一行是 `# 计划…`），然后调用 ExitPlanMode。它的授权请求 `input` 是空的。
3. 插件取计划正文：按本会话里写入 `plans/` 的那次 Write/Edit 找到文件；找不到时，取本会话启动后修改过的最新计划文件。正文开头没有 `#` 标题时补一个。然后把这次调用改写成 DSH 的 `exit_plan_mode {plan}`。
4. DSH 审阅：
   - **批准：** DSH 自己退出计划模式。插件回复 CLI `allow`；实测 CLI 会切回 `default`，插件随后按预设再设一次模式。
   - **继续规划：** DSH 返回带反馈的错误结果。插件回复 CLI `deny`，并附上用户反馈，CLI 留在计划模式里继续改。
   - **关闭审阅自己回复：** 本轮结束，CLI 收到 `deny`。
5. CLI 自己调用 EnterPlanMode 时，插件同步打开 DSH 的计划模式，保证之后的 `exit_plan_mode` 能在 DSH 里运行。

## 8. 向用户提问

CLI 的 AskUserQuestion 改写成 DSH 的 `ask_user_question`：

- 第 i 个问题的 `id` 取 `q<i>`；`question`、`header`、`options` 原样带过去；`multiSelect` 对应 `multi_select`。

DSH 返回 `answers[{id, selected, custom}]` 后，插件回复 CLI：

```
allow, updatedInput: {questions, answers: {"<问题全文>": "<选项, 选项>" 或自定义文本}}
```

这是实测和 paseo 都在用的格式。DSH 的“超时未答”（pending）也回复 `deny` 并说明情况，CLI 这一轮会继续往下走。

## 9. 会话、续接和中途插话

- **对应关系：** 每个 DSH 会话对应一个 CLI 会话 id，映射存在插件的 CLI 目录里。常驻进程沿用现有上限：最多 8 个，空闲 20 分钟停掉，插件卸载时全部停掉。进程没了就用 `--resume <id>` 接上（实测换进程能接着上一轮）。
- **判断是不是接着上一步：** 看请求里最后一条助手消息是不是这个 CLI 会话最近的一次响应，不比较整段历史。这样 DSH 压缩历史前缀后照样能接上。
- **对不上的时候：** 用户编辑重发、DSH 里分叉会话、中途换过别的模型时，用 DSH 历史生成转写文件，新开一个 CLI 会话。沿用现有的 `buildTranscript`，镜像调用还原成 CLI 原来的工具调用；升级前的老会话里 DSH 自己的工具调用压成文字。
- **中途插话：** DSH 把用户插话放在下一步里，插件把它写进 CLI 的 stdin。实测 CLI 会在下一次请求里插入“The user sent a new message while you were working”，留在同一轮里。
- **中断：** 发 `interrupt` 控制帧。实测 CLI 以 `error_during_execution` 结束这一轮，进程保留，下一条消息正常继续。
- **换模型、思考强度或 Key：** 带 `--resume` 重启进程。
- **用户附件：** 图片作为 base64 块放进用户消息。文件由 DSH 转成路径文字，Claude 自己去读；之后可以把 DSH 的附件目录通过 `--add-dir` 加给 CLI，免去每次授权。

## 10. 失败、重试和换 Key

- **重试归 DSH：** CLI 不自己重试，一次请求失败就是 DSH 这一步失败。DSH 的重试策略（最多 20 次）照旧；换到下一个 Key 时，插件带新 Key 重启，并续接被打断的这一轮（`CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`）。已经执行过的工具不会重跑。
- **配额不足和 Key 失效：** 识别、换 Key、禁用 Key 的逻辑不变。
- **报错说明改对（这次一起做）：** “客户端异常”的说明改成：PackyCode 把这次请求判成了非标准客户端，这不是 Key 失效；附上原始错误和 request id。只有 CLI 确实低于最低版本时才建议更新。

## 11. 标题和压缩

- **标题：** 一次性 CLI 进程（Haiku），不追加系统提示词，标题要求写进用户消息。现有的结果清洗（去掉 JSON、引号、标签）保留。
- **压缩：** DSH 对 cc 会话发起的压缩请求，插件在本地生成摘要，不请求网关。真正的上下文在 CLI 会话里，由 CLI 自己压缩；DSH 这边的摘要只在之后换到别的模型时有用。
  - 摘要内容：用户各次请求、最后的结论，以及说明完整上下文在 CLI 会话里。
- **CLI 自动压缩：** CLI 在一轮中途自动压缩时会多发一次请求。插件要识别 `compact_boundary`，不把这次请求当成 DSH 的一步；实现时用本地假网关测。

## 12. 对用户的变化

**能用：**

- DSH 的授权弹窗、权限预设和自动审查；
- 计划审阅和向用户提问；
- 工具卡片：终端、diff、读文件，DSH 重启后也能复现；
- 会话标题、换 Key、用量统计。

**cc 会话里不再适用：**

- DSH 的沙箱：命令和文件改动由 Claude Code 在本机直接执行，只受授权把关。
- DSH 自己的工具：子代理、todo、后台任务、生图、DSH 搜索、goal/schedule/workflow。Claude Code 用它自己的同类工具；它的 WebSearch 可能被 PackyCode 拒绝。
- DSH 的 AGENTS.md 和系统提示词：Claude Code 读项目里的 CLAUDE.md，和平时在终端里用一样。
- DSH 的文件改动面板。

**不受影响：** cc-sale、cc-expensive、claude-officially 和其他所有分组，照旧走 HTTP 和 DSH 自己的 agent。

## 13. 安全

- **保持不变：**
  - CLI 用插件自己的目录，不读用户的登录和设置；
  - 只用插件里的 Key，剥掉继承的环境变量；
  - 不读项目的 `.claude/settings.json` 和 `.mcp.json`；
  - 不在 CLI 和 HTTP 之间回退。
- **新的风险，要写进 README：**
  - Claude Code 的工具直接在本机执行，只通过 DSH 授权把关；
  - `danger-full-access` 预设下完全不问；
  - 计划文件和 CLI 会话记录保存在 `~/.dsh/packycode-claude-cli/`，需要定期清理（建议 30 天）。
- **AGENTS.md 要改：**
  - 把“CLI 只当传输层，必须关掉自己的全部工具，接收 DSH 的 MCP 工具”改成：“cc 通道由 Claude Code 当 agent：使用它自己的系统提示词和工具，不追加 DSH 的提示词、不挂 DSH 的 MCP 工具；它的授权请求必须交给 DSH 的审批，计划和提问交给 DSH 的审阅和提问工具”。
  - 现有的隔离、不回退、改 CLI 参数要跑 `claude-check` 等规则保留。

## 14. 代码改动

| 模块 | 改动 |
|---|---|
| `src/claude-cli-session.js` | 新参数和环境变量；处理 `can_use_tool`、`set_permission_mode`、`interrupt` 控制帧；按 `tool_use_id` 记录工具结果；插话写入 stdin；跟踪计划文件；把 `tool_use` 改写成三种调用 |
| `src/claude-cli-transport.js` | 续接判断改为“最后一条助手消息”锚点；DSH 会话和 CLI 会话 id 的映射；带 `--resume` 重启（换模型、强度、Key）；历史对不上时用转写文件新开 |
| `src/claude-agent-tool.js`（新） | 镜像工具 `claude_code`：卡片展示、等待并回传结果；agent 作用域的 `tools/pre-execute` 和 `tools/result` 监听 |
| `src/claude-permission-mode.js`（新） | DSH 预设和计划模式映射到 CLI 模式 |
| `src/claude-plan.js`（新） | 计划文件定位；ExitPlanMode 改写为 `exit_plan_mode`；AskUserQuestion 改写为 `ask_user_question`；两者结果回传给 CLI |
| `src/claude-api.js`、`src/claude-tools.js` | CLI 路线的工具名改为上述三种 |
| `src/claude-mcp-bridge.js` | 删除 |
| `src/claude-transcript.js` | 保留，用于新开会话；镜像调用还原 |
| `src/route.js`、`src/index.js` | 注入 `approval`、`permissionPresets`、`planMode`、`agents`；标题改为一次性无追加；压缩在本地 |
| `src/failures.js` | 报错说明 |
| `src/client.jsx` | Claude Code CLI 卡片的说明文字 |
| `tests/` | 用假 CLI 讲新协议：授权允许/拒绝、计划、提问、插话、中断、续接、历史对不上、换 Key、标题、压缩 |
| `scripts/claude-check.mjs` | CLI 场景改为 Claude Code 自己的工具；统计“客户端异常”次数 |
| 文档 | AGENTS.md、两份 README、CHANGELOG、`docs/releases/v1.4.0.md` |

建议版本号 1.4.0：cc 会话的行为变化较大。

## 15. 验证计划

1. **先做宿主验证（动手的第一步）：** 用临时 DSH_HOME 跑无头 DSH，确认三件事：
   - 作用域镜像工具能被执行；
   - 前置检查返回 `ask` 时走审批（无头模式没有审批通道，按设计会被拒，用来测拒绝这条路）；
   - `exit_plan_mode`、`ask_user_question` 能来回走通。
   不通的话退回方案 A，见第 16 节。
2. **单测和完整检查：** `pnpm run check`，覆盖第 14 节列的全部情况。
3. **真实网关：** `node scripts/claude-check.mjs --transport cli` 跑三个模型，覆盖只读、授权允许、授权拒绝、计划、提问、多轮、续接；再按“客户端异常”和“反滥用”分别统计次数。`scripts/live-check.mjs` 跑 HTTP 模型，确认不受影响。
4. **桌面版：** 授权弹窗、卡片和计划审阅的实际界面要在桌面版里看。到时需要重启 DSH，我会先问你。

## 16. 风险和待定

- **PackyCode 的判定会变。** 1.0.5 时它曾拒绝 `-p` 不追加提示词时的 SDK 身份句，现在放行。所以每次发版都要跑真实网关统计。
- **宿主接口只读过代码，没在桌面版实测**：作用域注册、审批挂卡片、自动审查对镜像工具的处理。第 15 节第 1 步先验证。（后记：无头验证通过了，但桌面端的 agent 预设和消息注入和无头不同，见文首“桌面端检查”。以后宿主相关的改动要在桌面端看一遍。）
- **退路方案 A：** 一轮只算一步，CLI 的工具活动写进思考区，授权直接调 `approval.request` 弹出、不挂卡片。界面差一些，但不依赖作用域工具。
- **自动审查会多审一次。** 自动审查预设下，它也会审 CLI 已经自己执行完的只读调用。这种审查是事后的，拒绝了也撤不回；会多花审查请求，通常不会拒绝读操作。
- **CLI 自带的定时类工具**（CronCreate、ScheduleWakeup、Workflow 等）在 DSH 宿主下的行为还没测。默认不禁用，因为改工具列表可能影响判定。
- **默认预设映射成什么：**
  - `acceptEdits`：工作目录内改文件不问，和 DSH 的 workspace-write 接近；
  - `default`：每次改文件也问。
  以后可以用 Claude Code 自带的沙箱（`sandbox.enabled` 加 `autoAllowBashIfSandboxed`，macOS 和 Linux 可用）让 Bash 也少问，需要另测是否影响判定。
