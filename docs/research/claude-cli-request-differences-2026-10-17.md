# Claude Code CLI 与插件直连：剩余请求差异和 403 调查

> 2026-10-19 补记：下文「已确定的兼容缺口」已在 1.3.4 修复，首轮工具请求的 `toolsAdded` 表示与顶层 `context.tools` 都会被识别。1.3.4 起 `cc` 分组的 Claude 请求改由官方 Claude Code CLI 发出。文中的证据链接指向维护者本机被忽略的 `.artifacts/` 目录，不在仓库中。

核对日期：2026-10-17。结论：**应用层和传输层仍有明确差异，但现有证据不能将 PackyCode 的间歇 403 唯一归因于某个字段。另外发现并复现了 DSH 0.2 下首轮工具请求漏掉既定 403 补偿的兼容缺口。** 本次调查未修改生产源码、构建、安装状态或发布版本，未启动、停止或重启 DSH。

## 取证范围

- 仓库与已安装插件均为 1.3.2；工作树起点 `4e45caf07653d7aafaa2504578ac146ed30edab3`，Claude 四个模块与 v1.3.0 相同。已安装文件的 host bundle 与仓库相同，SHA-256：`3690d03a1cd36cf98918fcab3293b9bfeb3cb1195d81926daef8681c62b87b1b`。这里核对的是磁盘文件，没有假定正在运行的进程已重新加载它们。
- 本机 Claude Code 二进制：2.1.295。用临时 HOME、独立配置目录、虚构凭据和只读临时库存文件，直接捕获 CLI 发给回环地址的请求。未读取用户的 CLI 登录凭据或插件 Key。
- 开发依赖：pi-ai 0.85.1 / Anthropic SDK 0.123.0；已安装 DSH 0.2.0-rc.2 的依赖：pi-ai 0.87.1 / SDK 0.124.0。后者从应用归档只读复制到忽略目录，另做完整工具往返与错误注入对照。不能把开发依赖版本直接当成桌面版本。
- 本机 CLI 请求自报 SDK 0.128.0、runtime Node v26.3.0；诊断 Node 为 v24.17.0。运行时头是客户端的声明，不等于独立证明其底层实现。
- 保存了 **58 条本地 HTTP 请求样本**：基础 CLI/开发依赖对照 27 条、已安装宿主依赖对照 11 条、两套依赖下错误注入 20 条；另捕获两份本地 TLS ClientHello。早期本地脚手架试跑不计入该保存样本数。
- **本轮真实网关请求为 0。** 模拟服务的 200/403 用于验证发包结构和补偿分支，不是新的稳定性或真实 403 发生率数据。历史真实结果另行引用，不与这次本地样本混合。

原始证据：[版本](../../.artifacts/claude-request-audit-2026-10-17/installed-versions.json)、[CLI/开发依赖捕获](../../.artifacts/claude-request-audit-2026-10-17/local-capture.json)、[宿主依赖捕获](../../.artifacts/claude-request-audit-2026-10-17/host-capture.json)、[机器可读差异](../../.artifacts/claude-request-audit-2026-10-17/comparison.json)。设备、会话 ID 保存为哈希，认证值不保存。

## 已确定的兼容缺口：新宿主首轮不触发既定补偿

`src/claude-replay.js` 的 `hasToolContext()` 识别顶层 `context.tools`，以及历史 `toolCall` / `toolResult`。新宿主的 pi-ai `Models.streamSimple()` 会先把工具移入首条 system message 的 `toolsAdded`，再调用 provider。这个首轮上下文没有顶层 `tools`，也还没有工具历史，所以检查返回 false，跳过原有补偿。

使用当前已安装 bundle 与实际宿主依赖、相同模拟异常正文复现：

| 场景 | 开发依赖 0.85.1 | 宿主依赖 0.87.1 |
| --- | --- | --- |
| Haiku 首轮已声明工具，先返回指定客户端异常 403 | 原样重发一次，继续工具往返 | 只发 1 次，直接返回 error |
| Sonnet 首轮已声明工具，同样的 403 | 原样重发一次，继续工具往返 | 只发 1 次，直接返回 error |
| Haiku/Sonnet 已带工具结果的回传轮，先返回同样 403 | 重发一次后继续 | 重发一次后继续 |

这是**本地可确定的错误恢复缺陷**，并不制造上游 403，也不能解释历史上为什么拒绝。它还说明“首轮工具请求”与“工具结果回传”不能混为同一触发条件。已确认回传轮仍能通过历史识别进入原有补偿。

建议优先让工具上下文识别兼容新的 transcript 表示，并按新增/移除工具后的实际可用状态判断，保留原模型、错误类别、同字节及一次上限。仅检查是否曾出现 `toolsAdded` 不足以处理工具已经移除的情况。**本次仅定位，尚未修改该逻辑。**

证据：[旧依赖错误注入](../../.artifacts/claude-request-audit-2026-10-17/legacy-refusal-replay.json)、[新宿主错误注入](../../.artifacts/claude-request-audit-2026-10-17/host-refusal-replay.json)、[补偿源码](../../src/claude-replay.js)、本地复制的 `pi-ai/dist/models.js` 与 `utils/transcript.js`。复现命令：

```sh
node .artifacts/claude-request-audit-2026-10-17/capture-local.mjs --refusal-only
node .artifacts/claude-request-audit-2026-10-17/capture-local.mjs --host-peers --refusal-only
```

第二个命令的 `reproducedGap` 表示成功捕获缺陷，不表示模型请求通过；所有注入均为本地假响应。

## 仍存在的请求差异

以下优先级是后续调查顺序，不是对 403 因果关系的置信度。CLI 基线采用相同自定义 Base URL、虚构 Bearer 凭据和 low effort；Sonnet/Opus 用 `stream-json` 输出模式，避免和普通文本模式混比。

| 优先级 | 已确认差异 | 与 403 的关系和边界 |
| --- | --- | --- |
| 高 | **Beta 与会话控制结构**：CLI Haiku 有 8 项 beta，Sonnet/Opus 流式模式有 9 项；插件分别为 1、2 项。CLI 带 `context_management.edits`，工具往返历史还带一条声明 effort 的 `role: system`；插件没有这些结构。 | 可能被私有客户端校验用作特征，但没有证据证明它是拒绝条件。历史上仅替换 CLI beta 集合的两次请求仍是 403，不能把“复制 beta”视作已验证修复。相关正文能力需要配套处理。 |
| 高 | **工具声明与缓存布局**：两端都可声明 `Read`，CLI 使用其原生 schema；插件保留 DSH 工具 schema，并默认增加 `eager_input_streaming: true`、末工具缓存标记。CLI 身份 system block 有缓存标记，插件该块没有。 | 这是比名字更深的应用层差异。CLI 的自定义 Base URL 模式默认关闭细粒度工具流，现场捕获与文档相符。是否触发 PackyCode 校验未知；没有理由直接把 DSH 参数接口改成 CLI 接口。 |
| 高 | **设备 ID 生命周期**：同一个临时 CLI 配置目录下，8 个独立 CLI 进程保持相同 device ID；插件在一个 provider 内一致，创建新 provider 即更换。 | 若服务端关联客户端状态，这可能影响判定；尚无重启前后、只变设备 ID 的真实因果对照。可以评估持久保存插件自己的随机 ID，不需要借用 CLI 的身份数据。 |
| 中 | **SDK 和运行时自动头**：CLI SDK 0.128.0；安装宿主 SDK 0.124.0（开发环境为 0.123.0）。本地 Node fetch 还加入 `accept-language`、`sec-fetch-mode`；header 顺序不同。 | 可能用于客户端分类，但公开资料没有指定允许组合。仅改版本字符串不会改变 SDK 语义。压缩声明的现有 HTTP 抓包来自回环明文端点，不能把其具体值直接外推到 HTTPS。 |
| 中 | **TLS 参数**：同机直接观察到 CLI 与 Node 的密码套件集合/顺序、扩展集合/顺序和支持组不同。 | 传输层确实未复刻。但两者本地都仅声明 HTTP/1.1 ALPN，不能推断是 HTTP/2 差异；该实验也没有协商真实网关 TLS。历史 CLI 经 Node 代理转发仍成功，降低了“必须使用 CLI TLS 指纹才能成功”这个解释的可信度。 |
| 中低 | **工具结果与宿主提示正文**：本次 CLI Read 返回带行号的文本，成功结果省略 `is_error`；插件测试结果是库存 JSON 文本并显式带 `is_error: false`。插件还保留 DSH 环境和权限说明。 | 两种工具结果表达都不能仅凭差异判错。CLI/DSH 的职责不同，原样复制整段 CLI 系统提示可能再次诱发不存在的工具调用或错误目录。是否参与私有内容分类未知。 |
| 低 | **无工具请求的显式限制**：插件设置 `tool_choice: none`，避免网关注入工具后让标题/普通文本任务调用它们。 | 有意保留的行为保护；不是遗漏。不能为了更像 CLI 删除而不验证标题和纯文本场景。 |

Beta、缓存与自定义 Base URL 的一般行为可参照 [Claude Code 网关兼容文档](https://code.claude.com/docs/en/llm-gateway-protocol)。该文档不是 PackyCode 的放行规则，不能从中推导哪个字段必然造成它的 403。TLS 原始观察见 [local-tls.json](../../.artifacts/claude-request-audit-2026-10-17/local-tls.json)。

## 这次已排除的几种混淆

- **输出模式造成的假差异**：CLI 普通文本输出时，Sonnet/Opus 也可以发送 `thinking.display: omitted`；改为 `stream-json` 后，两者发送 `updates` 及对应 beta，与插件一致。不能据普通文本抓包断言插件的 `updates` 不匹配。
- **诊断输出上限造成的假差异**：早期诊断主动设 2048，而 CLI 默认 128000。本次去掉诊断覆盖后，插件也是 128000。没有发现固定的默认上限差异，不能把增加 token 上限作为 403 修复。
- **身份句受启动方式影响**：CLI 不追加宿主系统提示时可使用另一种 Agent SDK 身份句；带追加系统提示时与插件当前身份句一致。因此也不存在唯一适用于全部 CLI 模式的身份句。
- **认证来源需要固定**：本次显式验证 `ANTHROPIC_AUTH_TOKEN` 对应 Bearer，与插件路径相同；`ANTHROPIC_API_KEY` 对应 `x-api-key`。历史真实 CLI 代理对照由代理注入同一插件 Key，没有借用订阅 OAuth。只设置 Base URL 时的普通用户 CLI 则不能自动作此假定。[官方凭据映射](https://code.claude.com/docs/en/llm-gateway-connect#how-the-credential-variable-maps-to-a-header)
- **已经对齐的项**：三模型最终路径都是 `/v1/messages?beta=true`，API 版本、User-Agent、`x-app`、首块 billing 值、适用模式下的 thinking 配置一致；每个请求的 session header 与 metadata 内 session ID 相同。工具 ID、工具名的回传关联也保留。没有找到新的拼错 URL 或 session header 不一致。

## 历史真实失败能支持什么

1. 旧构建 Haiku 的同一正文哈希、同一插件凭据、相同已记录关键头指纹，在 2026-10-16 13:42—13:43 北京时间出现 **403 → 200 → 403**。头指纹记录不包含 affinity 值，不能把它夸大成对每一个网络字节、服务端路由和时间条件都做过控制。可以确定的是：不存在“只要这个正文出现就每次必拒”的结论。
2. 仅追加完整 CLI beta 的历史两次请求仍是 403；其它变体也有偶发成功。每个变体样本少，且来自不同旧构建/时段，不能据此计算今天某项修复的成功率。
3. 历史 CLI 经本机 Node fetch 代理转发的完整工具/多轮对话曾成功。这说明当时至少部分路径接受 Node 转发的 CLI 应用层请求，不能把成功一律解释为 CLI 原生 TLS 放行。
4. 捕获的拒绝含 PackyCode 自定义 `packy_api_error` 客户端异常和 `packy_<nil>` 测试消息判定；普通权限错误、这些策略拒绝、HTTP 200 内流错误和等待 EOF 超时不能混成一种问题。旧记录里的 AUTH 误分类及后续恢复历史保持原样。

证据：[原始差分日志](../../.artifacts/claude-policy-differential-journal.json)、[历史复核](../../.artifacts/claude-policy-replay-summary.json)、[CLI 代理对照脚本](../../.artifacts/claude-cli-local-wire.mjs)、[Sonnet 对照日志](../../.artifacts/claude-cli-source/sonnet-source-journal.json)。这些是历史证据，不是对当前版本的新增网关测试。

PackyAPI 当前公开分组说明仍将 `cc` 标为不支持第三方，将 `cc-sale` 标为支持第三方；这不证明两组模型覆盖相同。本次没有切组或换 Key。公开文档没有公布完整的客户端判定算法，因此能够确认其存在客户端策略，不能确认它具体检查哪一项。[PackyAPI 分组介绍](https://docs.packyapi.ai/docs/token/)

## 建议的后续顺序

1. 先修复并覆盖 DSH 0.2 的工具上下文识别缺口；原有补偿范围和一次上限保持不变。这一项可以用确定的本地回归验证。
2. 若继续验证真实 403，优先按“beta 与对应会话字段”“工具流及缓存布局”“设备 ID 持久性”分别做固定构建、固定模型与凭据、交错次序的有界对照。一次成功只能记为一个样本；首轮和工具回传轮分别统计。
3. SDK/传输差异保留为候选项；不通过伪造 SDK 版本值来代替行为验证，不因为任意 403 扩大重试或禁用 Key。涉及能力字段变化时需兼顾签名历史、token 用量和 DSH 工具语义。
4. 要最终确定网关究竟拒绝了哪个特征，需要其对应 request ID 的服务端判定记录或一个可重复、只改变单一条件的真实失败样本。本次没有取得该内部证据，也未联系服务商。

**交付状态：请求差异已取证；一个新宿主补偿缺口已复现；403 的网关内部触发条件仍未确定。没有据此声称已经修复全部 403 或再次发布。**
