# GPT Image 2 / 2.5 Images API 核查

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
