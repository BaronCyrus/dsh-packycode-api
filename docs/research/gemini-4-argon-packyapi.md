# Gemini 4 Argon 与 Gemini 3.8 Flash 接入核查

核查日期：2026-10-15（Asia/Shanghai）。本说明区分公开官方文档、官方实时目录、用户转述的官方回复与本机实测；不保存凭据。

> 2026-10-27 起 PackyCode 不再提供 `gemini-4-argon`：公开定价目录不再列出它，网关以「当前令牌未覆盖供应商」拒绝。插件已从目录中移除 Argon，Gemini 只保留 3.8 Flash。下文保留 2026-10-15 的核查记录。

## 结论

`gemini-4-argon` 在 Packy 当前只开放 Gemini 原生端点。继续向 `/v1/chat/completions` 发送该模型会得到 `400 protocol_not_supported`。同一个模型、同一个插件已保存的 Key，改用 `/v1beta/models/gemini-4-argon:generateContent` 已返回正常文本；通过 DSH 的 PiAiAdapter 与 pi-ai 0.85.1 的原生流式链路也已验证成功。该结论同时得到下述官方实时目录、用户提供的官方回复与本机实测支持。

没有找到 Packy 提供的 Argon OpenAI 别名或其他允许保留 OpenAI Chat Completions 的接入方式。模型名称应继续使用 `gemini-4-argon`，显示名为 `Gemini 4 Argon`，由插件明确配置 Gemini 协议。

用户随后要求同系列统一：`gemini-3.8-flash` 虽然也支持 OpenAI 端点，插件中同样选择 Gemini 原生协议。两款模型的目录 `api` 均为 `google-generative-ai`，base URL 均为 `https://cf.api.fan/v1beta`。下文的 Flash Completions 实测用于说明网关能力，不是最终插件路由。

## Packy 官方公开资料

1. [Packy Gemini FAQ](https://docs.packyapi.ai/docs/faq/Gemini.html) 的 OpenAI-compatible 教程推荐 `https://cf.api.fan/v1`，但章节和示例明确针对 Gemini 3，示例 ID 是 `gemini-3-pro-preview`。该页面显示最后更新于 2026-08-29，不能据此认定后续所有 Gemini 模型均开放 OpenAI 协议。[固定版本源码](https://github.com/packyme/packy-docs/blob/4114e79687899b543bc7cd0b7648a5d8fd572355/src/docs/faq/Gemini.md)
2. [Packy 分组说明](https://docs.packyapi.ai/docs/token/) 要求根据实时模型广场确认可用模型。其[页面源码](https://github.com/packyme/packy-docs/blob/4114e79687899b543bc7cd0b7648a5d8fd572355/src/docs/token/README.md) 动态加载 `/api/pricing`，按 `enable_groups` 筛选模型，并展示每个模型的 `supported_endpoint_types`。协议必须逐模型确认。
3. 2026-10-15 无凭据读取 [Packy 官方公开定价目录](https://www.packyapi.com/api/pricing) 成功，共 75 个模型；所有包含 `argon` 或 `gemini-4` 的条目只有下面这一项，没有其他 Argon 别名：

   ```json
   {
     "model_name": "gemini-4-argon",
     "enable_groups": ["gemini-slb"],
     "supported_endpoint_types": ["gemini"],
     "model_ratio": 1,
     "completion_ratio": 5,
     "cache_ratio": 0.05
   }
   ```

4. [官方文档仓库](https://github.com/packyme/packy-docs/tree/4114e79687899b543bc7cd0b7648a5d8fd572355) 的 `main` 在本次核查时为 `4114e79687899b543bc7cd0b7648a5d8fd572355`，提交时间 2026-08-29。对 `src/` 与 `README.md` 全文检索 `argon`、`gemini-4`、`generateContent`、`streamGenerateContent`、`v1beta`、`thinkingConfig` 与 `thinkingLevel` 均未命中。公开教程尚未补齐 Argon 原生接入细节；这属于文档覆盖范围，不表示该模型不可用。

公开目录还明确给出 `gemini` 对应 `POST /v1beta/models/{model}:generateContent`，`openai` 对应 `POST /v1/chat/completions`；`group_ratio["gemini-slb"]` 为 3。这直接支持使用 Gemini 原生路径。

`docs.packyapi.com` 与 `docs.packyapi.ai` 本次读取的 Gemini FAQ 内容相同。公开定价接口有成功读取，也有 403 或 TLS 超时，因此目录结论是核查时的快照。

## 用户提供的官方回复

用户在本次会话转述的 Packy 官方回复确认：

- Argon 只挂 `gemini` 端点，没有 OpenAI 端点。
- 非流式请求为 `POST /v1beta/models/gemini-4-argon:generateContent`。
- 使用 `gemini-slb` 分组，倍率为 3。
- 每百万 token 输入 $6、输出 $30、缓存读取 $0.30。

这些内容是用户提供的官方回复，未找到对应公开网页。上述分组、协议及输入/输出/缓存比例与公开目录快照一致；美元单价直接依据用户提供的回复记录。

## Google 官方协议与模型规格

[Google Argon 模型页](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)（更新于 2026-10-14）确认稳定 ID 为 `gemini-4-argon`，支持 text、image、video、audio、PDF 输入和 text 输出；输入、思考、输出共享 1,048,576 token 窗口，同步默认最大输出 65,536。更长输出需要专用 long-decode 流程，不能只扩大普通同步请求的上限。

[Google Argon 迁移说明](https://ai.google.dev/gemini-api/docs/latest-model) 要求使用 `low`、`medium`、`high` 思考档位，默认 `medium`；移除 `temperature`、`top_p`、`top_k`，这些采样参数即使提供也会被忽略。输出上限包括思考 token，过低的上限可能只产生思考或截断回答。

[Google 原生 GenerateContent API](https://ai.google.dev/api/generate-content) 定义 `/v1beta/models/{model}:generateContent` 与 `/v1beta/models/{model}:streamGenerateContent`；原生请求使用 `contents`/`parts`，思考字段为 `generationConfig.thinkingConfig.thinkingLevel`，REST 枚举为 `LOW`、`MEDIUM`、`HIGH`。这是 Google 协议定义；Packy 是否代理每个功能仍以 Packy 目录和实测为准。

[Google OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) 确实列出了 Argon 的 OpenAI `reasoning_effort` 映射，但其 base URL 是 Google 自家的 `https://generativelanguage.googleapis.com/v1beta/openai/`。这不能证明 Packy 网关也启用了该兼容层。

## 本机运行验证

以下是本次会话的实际调用结果，由主 agent 执行，使用插件已经保存的同一个 Key；未切换模型、Key 或供应商，也未读取其他凭据来源。

| 检查 | 配置与结果 |
| --- | --- |
| 原 OpenAI 请求 | `gemini-4-argon` 走 Chat Completions，HTTP 400，`protocol_not_supported` |
| 原生非流式 | `POST https://cf.api.fan/v1beta/models/gemini-4-argon:generateContent`；`x-goog-api-key` 请求头；HTTP 200，`modelVersion=gemini-4-argon`，`finishReason=STOP`，文本 `ok` |
| 原生请求参数 | `contents` 内为 `user`/`parts`/`text`；`maxOutputTokens=2048`；`thinkingConfig.thinkingLevel=LOW` |
| DSH 实际 SDK 链路 | PiAiAdapter + pi-ai 0.85.1；流式 `low`、`medium` 均返回 `ok` 并正常 `stop` |
| 图片与 high | 原生 `high` 档传入蓝色图片，回答 `blue`，正常 `stop` |

探测脚本只在本地忽略目录中运行，Key 仅从插件凭据记录读入内存，不写入脚本或报告。可保留复测的命令为 `node scripts/live-check.mjs --model gemini-4-argon --with-vision`，它使用构建后的插件路由。

本次还发现 pi-ai 0.85.1 对新模型 Argon 仍生成旧的 `thinkingBudget`。插件在发送前按模型明确改为 `thinkingLevel: LOW/MEDIUM/HIGH` 并移除 `thinkingBudget`，保留所声明的思考档位；未提供 effort 时为两款模型明确选择官方默认 `MEDIUM`，避免旧 SDK 给 Flash 选择 `MINIMAL`。此兼容问题来源于本机 SDK 链路观察，不是 Packy 文档原文。

## Gemini 3.8 Flash 补充

用户追加要求测试 `gemini-3.8-flash`，可用后再加入目录。公开官方规格如下。

| 项目 | 官方规格 |
| --- | --- |
| 稳定 ID | `gemini-3.8-flash` |
| 输入上限 | 1,048,576 token |
| 输出上限 | 65,536 token |
| 输入类型 | Text、Image、Video、Audio、PDF |
| 输出类型 | Text |
| 思考档位 | `low`、`medium`、`high` |
| 默认思考 | 开启，`medium` |
| minimal / off | 模型页明确说明 `minimal` 会报错；未声明关闭思考或 `off` 档位 |

来源：[Google Gemini 3.8 Flash 模型页](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)（更新于 2026-09-02）、[Google thinking 档位表](https://ai.google.dev/gemini-api/docs/thinking#controlling-thinking)（更新于 2026-10-14）。

[Google OpenAI compatibility 教程](https://ai.google.dev/gemini-api/docs/openai) 用 `gemini-3.8-flash` 展示 Chat Completions、`reasoning_effort: low`、流式响应、function calling 和图片输入。教程的协议语法可作为实现参考；选择 Packy 上的实际 `api`/base URL 时仍需核对它在 Packy 的 `supported_endpoint_types` 并实际调用。

2026-10-15 的 [Packy 官方公开定价目录](https://www.packyapi.com/api/pricing) 列出 Flash 的 `supported_endpoint_types=["gemini","openai"]`、`enable_groups=["gemini-slb"]`，与 Argon 只支持 `gemini` 有明确区别。主 agent 使用插件已保存的 Key 读取 `/v1/models` 得到相同协议声明，并用现有 pi-ai OpenAI Completions 流式链路实测 `minimal`、`low`、`medium` 均得到 `ok` 和正常 `stop`。目录仍按 Google 明确声明只暴露 `low`、`medium`、`high`；实测接受 `minimal` 不代表 Google 原生规格支持该档。

## 最终原生路由与工具续聊验证

按用户要求，两款模型均已配置为 `google-generative-ai`，共用 `/v1beta`。最终构建的插件通过 `scripts/live-check.mjs --model <模型> --with-vision` 验证：Argon 与 Flash 均返回 `ok`，并分别正确识别红色、蓝色图片。Flash 第一次普通文本请求超过探测脚本的 90 秒期限，完全相同的重试返回 `ok`。普通非流式 `generateContent` 也返回了正确的 `modelVersion=gemini-3.8-flash`。

本地共 304 项测试通过，覆盖两款原生模型的三个思考档位、默认 `MEDIUM`、图片、思考/文本解析、用量和原生工具签名重放。实际网关的工具续聊结果需单独说明：

- Argon 原生工具调用及结果续聊均成功，正常返回 `ok`。
- Flash 一次直接 HTTP 原生两轮调用成功；后续既有 SDK 流式调用，也有完全绕过 SDK、保留上轮完整原生 `content` 的非流式 HTTP 调用失败。错误为 `Corrupted thought signature` 或 `Invalid thought signature`。
- 定向比对确认，SDK 发送的工具签名与返回签名完全相同，且是合法 Base64。将工具定义从 `parametersJsonSchema` 改成 `parameters` 也未消除问题。故不能归因为 SDK 丢失签名或单纯 JSON Schema 格式错误。
- 不依赖 SDK 的失败示例：`POST /v1beta/models/gemini-3.8-flash:generateContent`，第一轮 `echo` 成功；第二轮提交未经改动的上一轮 `content` 与匹配的 `functionResponse`，HTTP 400。`Corrupted` 示例 request id 为 `01M4YRA1414HD5XR1K5WP2FX9D`，`Invalid` 示例为 `01M4YRCTXZDB5NPWJT1M8M07BE`。

这些结果证明网关确实拒绝过未修改的签名，但未证明签名永久无效或必然无法恢复。下述固定响应实验进一步区分了持续性的客户端格式错误与间歇性的网关拒绝。

## 固定签名实验与有限重发处理

同一次原生工具调用的完整返回只读保存在内存中，第二轮请求体固定，所有签名、ID、参数、Key、模型均不变。在 `https://cf.api.fan` 上连续重放时，完全相同的基准请求先返回 HTTP 400，随后返回 HTTP 200、`ok`；所以至少这一类拒绝不能用“签名本身永远无效”解释。失败响应的 request ID 为 `01M…` 格式，成功响应为时间戳格式，但这只是不同处理路径的线索，不能据此断言具体网关架构或缓存根因。

三个独立原生两轮请求中，两组第一次续聊得到 `Corrupted thought signature`，等待 1 秒、原样重发后成功；第三组首次就成功。三组最终均为正常 `ok`。固定响应实验还测试了工具选择、结果 JSON 字段和思考摘要开关；基准请求自己也从失败变成成功，因此不能把其他变体偶然成功当作格式修复。主站地址 `https://www.packyapi.ai` 当时对 Flash 返回 HTTP 403 地区不可用，因此生产路由继续使用 `https://cf.api.fan`。

插件据此增加一个严格受限的处理：

- 仅限 `gemini-3.8-flash` 的原生协议，并且当前 turn 已有同模型、同 provider、带合法 Base64 签名的工具调用及匹配的工具结果。
- 仅对输出任何流事件之前的 HTTP 400 `Corrupted thought signature` / `Invalid thought signature`，等待 1 秒并原样重发一次。模型、协议、Key、签名、请求内容不变；不会重新执行本地工具。
- 鉴权、额度、限速、缺失签名、其他模型与输出后的错误不进入该处理；取消会中止等待。第二次仍失败时保留原错误，交给 DSH 原有错误和重试策略。
- SDK 的通用请求重试仍由宿主关闭；这一次是插件路由对已确认可恢复情形的有限重发，不改变宿主其它请求的重试设置。

321 项本地测试通过，其中回归测试在真实 Google SDK 与 DSH 适配层注入一次 HTTP 400，断言持久化后恢复的签名、请求体、Key 在重发前后完全相同，并检查取消、重发上限、输出后不重发及非目标错误。

最终构建的 `scripts/gemini-tool-check.mjs` 实测 Flash `low` 三组、`high` 一组和 Argon 一组原生工具续聊全部通过；这些最后的实测均首次成功，没有自然触发额外重发。其 HTTP 400 分支由上述实际网关恢复实验与本地 SDK/宿主回归共同验证，不将它误报为最终实测时已触发过该分支。Flash 的文字、红蓝图片检查也通过。

## Completions 对照与公开源码限制

用户追问 Completions 是否也会失败后，又进行了三组 Flash Completions 工具调用与结果续聊，全部正常 `stop`、`ok`，未出现签名错误。这是本次实测结论，不代表该端点永不出错；两个 Gemini 模型仍按用户要求使用原生协议。

[Google 原生签名规则](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures) 要求签名留在原 Part，同 turn 的工具调用不能丢失签名；[原生工具组合说明](https://ai.google.dev/gemini-api/docs/generate-content/tool-combination) 要求返回的 `functionCall.id` 与 `functionResponse.id` 一致。这些约束已在原始 HTTP 复现中保留。

官方 Packy 文档未找到 Gemini 的会话粘性或 `session_id` 约定，未因此加入未经验证的路由头。公开 [New API 原生处理代码](https://github.com/QuantumNous/new-api/blob/718a4e7f9751c5bf1958747cd0c2c895e2b937d4/relay/gemini_handler.go#L91) 显示网关可以解析和重写原生请求，所以客户端原样不等于上游必然原样；但没有证据证明 Packy 的具体部署版本和配置与该源码相同，也不能借此断言其根因。插件没有注入 dummy 签名、跳过验证或删除真实签名。

## 价格来源与限制

Argon 的 Packy 美元价格采用用户提供的官方回复：输入 $6、输出 $30、缓存读 $0.30 / 百万 token。公开 Packy 目录提供 `model_ratio=1`、`completion_ratio=5`、`cache_ratio=0.05` 与分组倍率 3，可核对相对比例。

Flash 的公开 Packy 目录提供 `model_ratio=0.375`、`completion_ratio=5`、`cache_ratio=0.1`，分组倍率同为 3。[Google 官方定价页](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash) 当前 Standard 价格是输入 $0.75、输出 $3.75、缓存读 $0.075 / 百万 token；该价格持续至 2026-12-31，2027-01-01 起分别变为 $1.50、$7.50、$0.15。

若沿用 Argon 官方回复中已经确认的同一 Packy 基准换算，Flash 在 `gemini-slb` 的推导值为输入 $2.25、输出 $11.25、缓存读 $0.225 / 百万 token。此处明确是根据目录倍率推导，并非 Packy 接口直接返回的美元单价；Google 自家价格也不能直接当作 Packy 的最终账单。
