# GPT Image 2 / 2.5 / 2.6 与 MiniMax H3 Image：Images API 核查

核查日期：2026-10-15（Asia/Shanghai）。协议核查部分只查阅公开资料；末尾另记录用户添加独立图片 Key 并授权测试后的 PackyCode 网关结果。协议能力与实际网关结果分开记录，不记录任何完整凭据。

## 模型与质量

三个模型都可直接用于 `POST /v1/images/generations` 与 `POST /v1/images/edits`，不应送进文字模型的 Chat Completions 路由。生成请求为 JSON；编辑可以上传 multipart 图片，也可以发送 JSON 图片引用。[官方 OpenAPI：两个路径及请求 schema](https://github.com/openai/openai-openapi/blob/main/openapi.json)

| 模型 ID | `quality` | 默认值 |
| --- | --- | --- |
| `gpt-image-2` | `auto`、`low`、`medium`、`high` | `auto` |
| `gpt-image-2.5-flare` | `auto`、`low`、`medium`、`high`、`xhigh`、`max` | `auto` |
| `gpt-image-2.5-sunburst` | `auto`、`low`、`medium`、`high`、`xhigh`、`max` | `auto` |

这张表同时适用于生成与编辑；`xhigh` / `max` 不能发给 `gpt-image-2`。质量是 Images API 的 `quality` 字段，不是文字模型的 `reasoning_effort`。[官方质量说明与 GPT Image 2 兼容章节](https://developers.openai.com/api/docs/guides/image-generation#customize-image-output)、[Sunburst 模型页](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)、[OpenAPI：CreateImageRequest / CreateImageEditRequest](https://github.com/openai/openai-openapi/blob/main/openapi.json)

## 尺寸和输出

三个模型支持 `size: "auto"` 或 `WIDTHxHEIGHT`。推荐预设为 `1024x1024`、`1536x1024`、`1024x1536`；自定义值的两边须为 16 的倍数、每边不超过 3840、宽高比在 1:3 至 3:1 之间、总像素在 655,360 至 8,294,400 之间。高于 `2560x1440` 的分辨率为实验能力；4K 同时包括横向 `3840x2160` 和纵向 `2160x3840`。[官方尺寸说明](https://developers.openai.com/api/docs/guides/image-generation#customize-image-output)、[GPT Image 2 尺寸章节](https://developers.openai.com/api/docs/guides/image-generation#earlier-gpt-image-models)

- `output_format` 支持 `png`（默认）、`jpeg`、`webp`；`output_compression` 为 0–100，仅用于 JPEG/WebP，PNG 请求应省略。[官方输出格式说明](https://developers.openai.com/api/docs/guides/image-generation#output-format)
- `background` 支持 `auto`（默认）、`opaque`、`transparent`；透明输出必须使用 PNG/WebP。2.5 两款明确支持透明背景，`gpt-image-2` 的透明能力仍标为 preview。[官方 OpenAPI：background](https://github.com/openai/openai-openapi/blob/main/openapi.json)
- `n` 支持 1–10，默认 1；本插件可选择一次只生成一张以限制成本。[官方 OpenAPI：CreateImageRequest / CreateImageEditRequest](https://github.com/openai/openai-openapi/blob/main/openapi.json)
- GPT Image 非流式结果以 `data[].b64_json` 返回；`output_format` 决定解码后的图片类型。不要发送 legacy `response_format`，它不受 GPT Image 支持；官方也不为这些模型返回 `data[].url` 或 `revised_prompt`。[官方 OpenAPI：Image / ImagesResponse / response_format](https://github.com/openai/openai-openapi/blob/main/openapi.json)
- 两端点可返回 SSE；事件分别为 `image_generation.partial_image` / `image_generation.completed` 与 `image_edit.partial_image` / `image_edit.completed`。`partial_images` 范围 0–3，预览数量未必达到请求值；预览另计用量，首次实现可先采用非流式 JSON。[官方流式说明](https://developers.openai.com/api/docs/guides/image-generation#streaming)、[官方 OpenAPI：端点响应示例](https://github.com/openai/openai-openapi/blob/main/openapi.json)

## 编辑输入与 mask

Multipart 使用 `image`（单图）或重复的 `image[]`（多图），最多 16 张；每张必须为 PNG、WebP 或 JPG，大小小于 50 MB。发送 `model`、`prompt` 和选定的质量等表单字段；让 HTTP 客户端为 FormData 自动设置带 boundary 的 Content-Type。[官方 multipart 示例](https://developers.openai.com/api/docs/guides/image-generation#edit-images)、[官方 OpenAPI：CreateImageEditRequest.image](https://github.com/openai/openai-openapi/blob/main/openapi.json)

`mask` 是可选 PNG，透明区域（alpha=0）指示要编辑的位置，尺寸须与第一张输入图一致；多图输入时只作用于第一张。模型把 mask 作为引导，不能保证修改区域与轮廓完全吻合。[官方 mask 说明](https://developers.openai.com/api/docs/guides/image-generation#edit-an-image-using-a-mask)、[官方 OpenAPI：CreateImageEditRequest.mask](https://github.com/openai/openai-openapi/blob/main/openapi.json)

官方资料存在一个明确差异：`CreateImageEditRequest.mask` 要求 **小于 4 MB**；指南的 Mask requirements 则写图与 mask 格式、尺寸一致且小于 50 MB。实现建议采用更严格的 PNG mask <4 MB，并在需要 mask 时使用相同尺寸的 PNG 输入，直到实际网关验证更宽限制；不要把指南的 50 MB 直接当作 mask 已确认上限。[OpenAPI mask schema](https://github.com/openai/openai-openapi/blob/main/openapi.json)、[指南 Mask requirements](https://developers.openai.com/api/docs/guides/image-generation#mask-requirements)

2026-10-15 再核对：[官方编辑 API 参考](https://developers.openai.com/api/reference/python/resources/images/methods/edit)仍将 `mask` 列为可选 PNG、与输入同尺寸且 <4 MB。用户随后报告“完善草图”触发同样的 mask 校验，并确认仅上传原图，没有单独遮罩。当前本机没有该报错会话的调用参数；离线回放可用“JPEG/WebP 参考图又被模型重复填到 mask 字段”复现完全相同的报错，不能据此声称已取得同事设备的原始参数。工具现支持 `maskImage: null` / CLI `maskId: null` 明确表示无遮罩，并只兼容宿主已验证的同一个非 PNG 参考附件被重复填入 mask 的情况。真实 PNG mask 和不同附件的 mask 保留原有检查；没有放宽 4 MB 限制，没有把编辑换成生图，也没有新增付费重试。

JSON 编辑的字段为 `images: [{ image_url: "…" }]` 或 `images: [{ file_id: "…" }]`，每项二选一；`image_url` 可为完整 URL 或 data URL。JSON 的可选 mask 同样为图片引用对象。这是官方额外能力，不能据此假定 PackyCode 也支持它。[官方 OpenAPI：EditImageBodyJsonParam / ImageRefParam](https://github.com/openai/openai-openapi/blob/main/openapi.json)

`gpt-image-2` 必须省略 `input_fidelity`，其图片输入始终按高保真处理。当前通用 schema 只明确为 GPT Image 1 / 1.5 声明可调 high/low，没有明确说明 2.5 两款可调；本次集成建议三款均省略此字段，不推断 2.5 的未记载行为。[官方高保真说明](https://developers.openai.com/api/docs/guides/image-generation#image-input-fidelity)、[官方 OpenAPI：InputFidelity](https://github.com/openai/openai-openapi/blob/main/openapi.json)

## 本插件实现与后续实测建议

以下是基于上面协议的工程建议，不是已通过的 PackyCode 运行结论：

1. 将图片模型、图片 Key 和设置独立保存；只使用用户在本插件图片入口添加的 Key；请求、解码和错误处理均在宿主侧执行。
2. UI 的质量菜单随模型变化；以 `auto` 为默认，切换到 `gpt-image-2` 时拒绝或显式清除不支持的 `xhigh` / `max`，不能暗中换模型。
3. 先对接 JSON 生成和 multipart 编辑，发送 `quality` / `size` / `output_format` 等白名单字段；省略 `input_fidelity`、`response_format` 和旧 `style`。
4. 用户填入独立图片 Key 后，逐模型生成一张低质量标准尺寸图片，再验证一次编辑；单独验证 2.5 高档质量、透明背景与 mask，记录实际接受的参数，不把构建成功当作网关成功。
5. 对图片响应设大小、超时和取消边界；不在日志记录 Key、原始 Authorization 或可能回显凭据的响应体。错误按 HTTP 状态与稳定错误码分类，用户需修改输入的图片错误不自动重试。[官方图片错误处理说明](https://developers.openai.com/api/docs/guides/image-generation#handling-blocked-requests-and-other-errors)

## PackyCode 网关实测（2026-10-15）

用户自行重开 DSH 并在本插件中保存专用图片 Key 后，使用 `lib/index.js` 中已构建的图片 client 调用 `https://cf.api.fan`。凭据只从 `packycode-api/image-keys` 读取；没有写入或切换实际凭据、对话 Key、DSH 设置或会话。DSH 桌面设置页可见图片开关、Sunburst、max 和独立 Key，旧版 Host 缓存问题已解除。

测试生成提示为白底居中的蓝色茶壶；编辑以该次生成的 PNG 为输入，只将茶壶改为橙色、保留构图和白底。每次输出请求 `1024x1024`、PNG、`n: 1`。生图使用 JSON generations；编辑使用 multipart edits；不自动换模型、降档或重试。

| 请求型号 | 请求 quality | 生图 | 编辑 | 响应回报 quality |
| --- | --- | --- | --- | --- |
| `gpt-image-2` | `low` | 通过 | 通过 | 首组日志未记录此字段 |
| `gpt-image-2.5-flare` | `low` | 通过 | 通过 | 首组日志未记录此字段 |
| `gpt-image-2.5-sunburst` | `low` | 通过 | 通过 | 两次均为 `low` |
| `gpt-image-2.5-sunburst` | `xhigh` | 通过 | 通过 | 两次均为 `xhigh` |
| `gpt-image-2.5-sunburst` | `max` | 通过 | 通过 | 两次均为 `max` |

共 10 次真实请求（5 次生图、5 次编辑），无失败、无重试，全部返回可解码的 1024×1024 PNG。10 张图片经视觉检查，生图为蓝色茶壶，编辑变为橙色，白底与构图保留；输出 SHA-256 也均不同。日志经宿主侧检查不含完整图片 Key。

`xhigh` 生图用时 43.130 秒、编辑 48.064 秒；`max` 生图 83.537 秒、编辑 91.358 秒。两种高档质量的生成、编辑响应分别明确回报 `quality: "xhigh"` / `quality: "max"`。PNG 文件大小不用于推断质量档位。Sunburst 响应未提供可识别的 `model` 字段，结论是这些请求型号在当前 Key / 网关下可用，以及已回报的 quality 与请求一致，不据此独立证明网关内部的模型身份。

本次是已构建插件图片 client 的真实网关测试；桌面确认了设置和 Key 加载，没有新建 DSH 对话来运行完整的模型 → 工具 → 聊天预览流程。透明背景、mask、自定义大尺寸及其它质量档位不在本轮范围内。测试日志与 PNG 保存在本地 `.artifacts/image-live-*.log` 和 `.artifacts/image-check-*/`；汇总记录（参数、耗时、质量回报、文件路径、SHA-256）为 `.artifacts/image-live-results-2026-10-15.json`。这些文件不进入 Git 或 npm 包。

## 原生工具参数回放与兼容修复（2026-10-15）

后续桌面对话暴露了 client 级验证未覆盖的参数问题：模型给新图请求填入 `referenceImages: []`，同时附带一个 `attachmentId` 全零、字节数与宽高均为 0 的占位 mask。工具按字段是否存在判断操作，反复报 `PackyCode image edits require 1-16 reference images`，请求尚未到网关。本地开发链接确实指向当前仓库；该错误在最新源码中同样可复现。

回归测试先复现同样错误，再验证修复：空引用数组表示没有参考图；只把明确的零值、空 ID / 全零 ID 遮罩占位视为未提供。`operation: edit` 仍要求有效参考图，`operation: generate` 拒绝非空参考图，真实无效附件和真实遮罩不能变成新图请求。工具专用的 `model: settings` / `quality: settings` 可明确跟随已保存的设置，`settings` 不会发给网关。

修复后，通过已构建的 `createPackyCodeImageTool().execute()` 回放原生参数结构（提示词替换为公共茶壶测试描述），只发出一次 `/v1/images/generations` 请求并成功返回 PNG，耗时 12.267 秒，`size: auto` 的实际图片为 1329×1183。结果可渲染成图片附件，日志和结果均不含完整 Key。该检查使用真实专用图片 Key、真实网关和本地附件测试适配器；它验证了工具参数路径，仍不等同于自动驱动整个桌面对话。记录在本地 `.artifacts/native-image-argument-replay-results.json`。

## GPT Image 2.6 替换 2.5（2026-11-05）

2026-11-05 的 `/api/pricing` 在 `image` 分组列出 `gpt-image-2.6-flare` 和 `gpt-image-2.6-sunburst`，端点为 `image-generation`；2.5 两款仍在列表里。插件的设置卡、`packycode_image_generate` 工具和 `scripts/image-check.mjs` 改为 2.6 两款，`gpt-image-2` 不变。

官方[生图指南](https://developers.openai.com/api/docs/guides/image-generation)把 2.6 和 2.5 的 Sunburst / Flare 写在同一句质量说明里：`low`、`medium`、`high`、`xhigh`、`max`。`auto` 依据同一指南的通用输出设置说明保留。2.6 的 [Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst) 和 [Flare](https://developers.openai.com/api/docs/models/gpt-image-2.6-flare) 模型页都把 `v1/images/edits` 标为支持、`v1/responses` 标为不支持。尺寸限制、透明背景和 mask 在指南里只写在 2.5 的章节中，2.6 没有单独说明；插件沿用原有尺寸校验，本轮没有单独验证这几项。指南另写 2.6 支持 complexity、markup 编辑、SVG 和 GIF 输出，插件没有接入这些参数。

已保存的 `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` 设置：从 Config schema 里直接删掉这两个值，会让选过它们的用户的插件 Config 解析失败。schema 把它们保留为隐藏值，读取图片偏好时映射到同名的 2.6 型号，质量不变；设置卡和工具只提供 2.6，并拒绝 2.5 的 id。

网关实测同前：已构建的图片 client 调用 `https://cf.api.fan`，Key 只从 `packycode-api/image-keys` 读取（尾号 …ECMQ），提示和编辑指令与 2026-10-15 相同，每次 `1024x1024`、PNG、`n: 1`，无重试。

| 请求型号 | 请求 quality | 生图 | 编辑 | 响应回报 quality | 生图 / 编辑耗时 |
| --- | --- | --- | --- | --- | --- |
| `gpt-image-2` | `low` | 通过 | 未测 | `low` | 11.6 秒 |
| `gpt-image-2.6-flare` | `low` | 通过 | 通过 | `low` | 5.7 秒（另一轮 6.4）/ 9.0 秒 |
| `gpt-image-2.6-flare` | `xhigh` | 通过 | 通过 | `xhigh` | 13.7 / 14.7 秒 |
| `gpt-image-2.6-flare` | `max` | 通过 | 通过 | `max` | 24.3 / 26.1 秒 |
| `gpt-image-2.6-sunburst` | `auto` | 通过 | 未测 | `low` | 16.1 秒 |
| `gpt-image-2.6-sunburst` | `low` | 通过 | 通过 | `low` | 13.3 / 16.8 秒 |
| `gpt-image-2.6-sunburst` | `xhigh` | 通过 | 通过 | `xhigh` | 50.6 / 64.4 秒 |
| `gpt-image-2.6-sunburst` | `max` | 通过 | 通过 | `max` | 95.9 / 96.6 秒 |

共 15 次请求全部成功，均返回 1024×1024 PNG。抽查的生图为白底蓝色茶壶，编辑后茶壶变橙、构图和白底保留。`auto` 发出后网关回报 `low`。响应没有可识别的 `model` 字段，所以结论仍是这些型号在当前 Key 和网关下可用、回报的 quality 与请求一致，不独立证明网关内部的模型身份。本轮没有在 DSH 桌面对话里跑完整的模型 → 工具 → 聊天预览流程。PNG 保存在本地 `.artifacts/image-check-*/`，不进入 Git 或 npm 包。

## MiniMax H3 Image 接入（2026-11-11）

2026-11-11 的 `/api/pricing` 在 `image` 分组列出 `MiniMax-H3-Image` 和 `MiniMax-H3-Image-Highspeed`，端点类型为 `image-generation`（`/v1/images/generations`，附加路径 `/v1/images/edits`），计费方式 `image_billing: "token"`；两款都不在 `image-sale` 分组。站内公告（`/api/status` 的 `announcements`，同日发布）写两个端点两款都支持、编辑支持 1~16 张参考图、「两款模型参数与限制相同，Highspeed 版本出图更快」。PackyCode 的文档仓库还没有这两个型号的页面。

### MiniMax 官方协议

来源：MiniMax 的[生图指南](https://platform.minimax.io/docs/guides/image-generation)、[文生图参考](https://platform.minimax.io/docs/api-reference/image-generation-h3-generations)和[图片编辑参考](https://platform.minimax.io/docs/api-reference/image-generation-h3-edits)。H3 Image 的原生接口就是这两个 Images API 路径，字段与 GPT Image 不同：

| 字段 | MiniMax H3 Image |
| --- | --- |
| `prompt` | 必填，最长 32000 字符 |
| `n` | 1–10，默认 1 |
| `size` | `auto`（默认）或 `WIDTHxHEIGHT`：面积 655,360–20,000,000 像素，宽高比 1:3 至 3:1，不缩放不取整，越界返回 400；没有 16 的倍数要求 |
| `area` | `1K` / `2K` / `4K`，**默认 `4K`**；与 `WIDTHxHEIGHT` 的 `size` 同时发送返回 400 |
| `aspect_ratio` | `auto` 或 `X:Y`；与 `WIDTHxHEIGHT` 的 `size` 同时发送返回 400 |
| `output_format` | `png` / `jpeg` / `jpg` / `webp`，**默认 `jpeg`** |
| `response_format` | `url`（默认）或 `b64_json`；`b64_json` 时 PNG 总面积上限 20,000,000 像素 |
| `quality`、`background` | schema 里没有；指南把透明背景列为不支持 |
| `mask` | 不支持，返回 400 |
| 编辑参考图 | multipart 的 `image` 或 `image[]`，1–16 张，JPG / PNG / WEBP / HEIC / HEIF，单张不超过 64 MiB，边长 128–8192 |

响应为 `data[].b64_json`（或 `url`）加每张图的实际 `size` 和 `revised_prompt`，顶层有 `output_format` 和 `usage`，没有 `quality` 字段。官方写服务端最多等待 600 秒，接口不幂等，重试会再次生成并计费。两款参数与限制相同；Highspeed 的输入图片和输出单价是标准版的两倍。

### 插件的请求形状

- 两款进入 `IMAGE_MODELS`，质量只有 `auto`，请求不带 `quality` 和 `background`。
- 显式发送 `output_format: "png"` 和 `response_format: "b64_json"`：插件只保存 PNG 原图，不下载网关给的链接。
- `size` 为 `auto` 时附带 `area: "2K"`（`MINIMAX_AUTO_AREA`），比例由模型按描述或参考图决定。不这样做，MiniMax 按默认 `4K` 出图，像素和费用是 2K 的四倍，并超过插件保存图片的上限（单边 3840、8,294,400 像素）。显式尺寸不带 `area`（两者同发返回 400）。
- 显式尺寸沿用原有校验（两边为 16 的倍数、单边不超过 3840、宽高比不超过 3:1、655,360–8,294,400 像素），是 MiniMax 允许范围的子集；4K 档暂不提供。
- 透明背景和 mask 在发出请求前拒绝，不丢弃后照常生图。工具调用为本次请求点名 MiniMax、而设置里保存的是另一型号的质量时，按 `auto` 处理；显式传入它没有的质量仍被拒绝。
- 网关的路由拒绝（`error.code: "model_not_found"`，如 `分组 image-sale 下模型 MiniMax-H3-Image 无可用渠道`）改为提示图片 Key 所在分组不提供该型号，并明确要求不要换型号重试、让用户在设置里选型号或换 Key，不回显网关原文。
- 超时仍是插件原有的 5 分钟，低于官方的 600 秒建议；实测 2K 生图和编辑都在 30 秒内。

### 网关实测（2026-11-11）

已构建的图片 client 调用 `https://cf.api.fan`，Key 只从 `packycode-api/image-keys` 读取（尾号 …ECMQ），提示和编辑指令同前（白底蓝色茶壶；编辑为改成橙色），每次 `n: 1`、PNG，无重试。

这把 Key 当天先在 `image-sale` 分组：两款 MiniMax 型号都被网关在到达上游前拒绝（HTTP 503 `model_not_found`），没有产生图片。用户把它改到 `image` 分组后：

| 请求型号 | 请求尺寸 | 生图 | 编辑 | 返回尺寸 | 生图 / 编辑耗时 |
| --- | --- | --- | --- | --- | --- |
| `MiniMax-H3-Image` | `1024x1024` | 通过 | 通过 | 1024×1024 | 11.4 / 16.3 秒 |
| `MiniMax-H3-Image-Highspeed` | `1024x1024` | 通过 | 通过 | 1024×1024 | 8.1 / 9.8 秒 |
| `MiniMax-H3-Image` | `auto`（附带 `area: "2K"`） | 通过 | 通过 | 2048×2048 | 14.6 / 25.6 秒 |

6 次请求全部返回可解码的 PNG（`data[].b64_json`），尺寸与请求一致。抽查的生图为白底蓝色茶壶，编辑后茶壶为橙色。响应没有 `model` 和 `quality` 字段，带每张图的 `size`、`revised_prompt` 和 `usage`。

另用一次直接请求确认网关转发 `area`：JSON 生图发 `size: "auto"` 加 `area: "1K"` 和一段宽幅风景描述，返回 1568×672 的 PNG（约 105 万像素，比例由模型选定），`usage.output_tokens` 为 4116。multipart 编辑同样转发 `area`（上表第三行的编辑返回 2048×2048）。1K 这张图的输出 token 与 2K 档的起点（约 4096）接近，所以 `auto` 选 2K。本轮没有测透明背景和 mask 的上游行为（插件在发出前拒绝）、4K 档、多张参考图和 5 分钟以上的请求。

同日用同一把 Key 回归 `gpt-image-2.6-flare` 的 `low`：生图 34.1 秒、编辑 48.5 秒，都成功，响应回报 `model: gpt-image-2.6-flare` 和 `quality: low`；请求的是 `1024x1024`，两次返回的 PNG 都是 1254×1254（2026-11-05 同样的请求返回 1024×1024）。GPT Image 的请求字段本次没有改动。

### 图片 Key 的分组（2026-11-11）

图片 Key 所在分组决定它能用哪些型号：`gpt-image-*` 同时列在 `image` 和 `image-sale`，MiniMax 两款只列在 `image`。桌面对话里用 `image-sale` 的 Key 选 MiniMax 生图时，工具返回分组提示，对话模型（DeepSeek Flash）随即自行换了型号重试，这违背「不自动换型号」。因此：

- 插件对图片 Key 复用对话 Key 的分组读取器（`createGroupReader`，`modelIds` 传图片型号）：向 `/v1/chat/completions` 发一个网关无法路由的模型名，从拒绝文本里读出分组；读 `/v1/models` 得到这把 Key 能用的模型；读公开的 `/api/pricing` 得到每个型号所在的分组。三个读取都不计费、有超时、拒绝重定向，返回浏览器的只有分组名、分组说明和每个型号的布尔值。
- 实测（Key 在 `image` 分组）：拒绝文本为 `分组 image 下模型 dsh-packycode-group-probe 无可用渠道（distributor）`，`/v1/models` 列出 `MiniMax-H3-Image`、`MiniMax-H3-Image-Highspeed`、`gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-2.6-flare`、`gpt-image-2.6-sunburst`，已构建的读取器 2.7 秒读完，五个型号都判为可用。
- `/api/pricing` 的内容随请求出口变化：同一时刻从本机直连只返回 42 个模型、13 个分组，没有 Claude 和 `gpt-image-*`，也没有 `image-sale`；经代理返回 85 个模型、26 个分组。所以型号是否可用以「分组命中」或「`/v1/models` 列出」任一为准，只有两者都有反证时才判为不可用；定价里查不到型号时，设置卡不显示「需要分组」。
- 设置卡在每个图片 Key 下显示分组；型号列表只列当前使用的 Key 可用的型号，下方说明被隐藏的型号；已保存的型号若不可用，保留在列表里并标注，另给警告，不自动改设置。分组没读到时不隐藏任何型号。图片请求只用当前使用的 Key，不会换到另一把 Key。
