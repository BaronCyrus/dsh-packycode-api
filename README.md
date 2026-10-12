# dsh-packycode-api

DeepSeek Harness 的 PackyCode（PackyAPI）插件：**填一个 API Key 就能用**，插件自带模型路由，不需要你改任何 YAML。

- **自带路由与模型目录**：安装后模型选择器里直接出现 `PackyCode` 分组，不需要配置 provider。
- **多个 Key 按顺序使用**：某个 Key 额度用尽或被网关拒绝时，自动切到下一个可用 Key，本轮请求由重试接手，不需要你手动改配置。
- **看得到余额**：设置页列出每个 Key 的剩余额度、已用量、重置周期与状态；对话输入框右侧常驻显示当前 Key 的剩余额度。
- **三种协议各就各位**：`deepseek-flash`（chat/completions）、`gpt-6.1-sol`（Responses）、`claude-opus-5-5`（Anthropic Messages），每个模型的档位按厂商官方文档声明。

## 安装

```sh
dsh plugin --profile <profile> add dsh-packycode-api
```

安装后重启 DSH。插件通过自带的 `cordis.patch.yml` 注册自己，profile 的 `dsh.profile.bundles` 会自动包含它。模型路由本身不依赖浏览器：没有 `connection` 服务的 profile（例如 headless）也能用，只是看不到设置面板与输入框额度。

## 使用

1. 打开 **设置 → PackyCode**。
2. 在「添加 Key」里粘贴 PackyCode 的 API Key（可填备注，便于区分多个 Key），点「添加」。
3. 回到对话，在模型选择器里选 `PackyCode` 分组下的模型，例如 `claude-opus-5-5`。

余额会在设置页与输入框右侧显示；「刷新」会强制重新读取（默认 60 秒缓存）。

## 多 Key 轮换

- Key 按添加顺序排列，插件只使用「当前 Key」；点击「切到此 Key」可以手动指定。
- 同一个 Key 出现**额度用尽**（网关会报 `额度/余额/insufficient quota` 之类）或**被拒绝**（HTTP 401 / `无效的令牌`）时，插件会把该 Key 标记为「已停用」并自动切到下一个可用 Key；本轮失败的那一步由 harness 的重试重新执行，从而真正用上新 Key。
- 限速（429）不会切换 Key——那是瞬时问题，由重试吸收即可。
- 网关把上游渠道故障误报成 400（`当前令牌未覆盖供应商 …`）时也不会切换 Key，插件把它当作可重试的瞬时故障。
- Key 充值或更换后，点「重新启用」即可让它重新参与。

## 余额从哪里来

| 数据 | 接口 | 说明 |
| --- | --- | --- |
| 每个 Key 的额度 | `GET {余额接口}/api/usage/token/` | `total_available` / `quota_limit` / `quota_reset_period`；`quota_limit = -1` 表示无周期上限，`unlimited_quota = true` 表示不限额度 |
| 账号额度 | `GET {模型接口}/v1/dashboard/billing/subscription` 与 `/usage` | `hard_limit_usd` 与 `total_usage`，剩余即两者之差 |

额度单位按 new-api 约定换算：`500000 quota = 1 USD`。默认模型接口是 `https://cf.api.fan`，余额接口是 `https://www.packyapi.com`（`cf.api.fan` 不提供 `/api/*` 系列，插件会自动回退到另一个 host）。两者都可以在设置页「高级」里改。

## PackyCode 官方的注意事项（插件已内置）

- **OpenAI / Codex 系模型必须走 Responses 协议**，用 chat/completions 会协议不匹配、流式提前中断 —— `gpt-6.1-sol` 已固定为 `openai-responses`。
- **OpenAI / Codex 的 base_url 要带 `/v1`**，且不要把 `/responses` 这类端点路径写进根地址（客户端自己拼）。插件里是 `https://cf.api.fan/v1`。
- **Anthropic 的 base_url 不能带 `/v1`**（客户端自己拼 `/v1/messages`）—— `claude-opus-5-5` 用的是 `https://cf.api.fan`。
- Codex 分组的 Responses 请求**必须带 `prompt_cache_key`**（否则 403 反代校验）。harness 会带上会话 id；插件在调用方没给 session id 时补一个兜底值。
- 各模型的推理档位按厂商文档声明：`deepseek-flash` = `off/low/high/max`，`gpt-6.1-sol` 与 `claude-opus-5-5` = `low/medium/high/xhigh/max`（后两者无法关闭推理）。请求里声明了模型不支持的档位会被 harness 在发请求前拒绝，所以档位不要随手改。
- **分组决定"能不能用 API 调用"**（PackyCode 控制台里给令牌选的分组）：
  - `cc`（claude code 专用）**只接受官方 Claude CLI**，用 API 调 Claude 会 403 `This API endpoint is only accessible via the official Claude CLI`。要让本插件调 Claude，请选 `cc-sale` 或 `claude-officially`。
  - `codex` / `codex-sale` 要求标准 Codex 客户端形态（插件已内置 `prompt_cache_key` 等必要条件），对应用 `gpt-6.1-sol`。
  - `deepseek-officially` / `deepseek-sale` 对应用 `deepseek-flash`。
  - 换分组时别把这三个分组一起去掉，否则对应模型会失效。
- 插件识别这类"只允许官方客户端"的拒绝：**不重试、不切换也不停用 Key**，并直接给出中文说明（而不是让你看到"API Key 无效"）。

## Claude 模型走本机 Claude Code CLI

PackyCode 的 `cc` 分组只把 Claude 模型提供给**官方 Claude CLI**，API 客户端会被 403 挡住。所以插件的 `claude-opus-5-5` **不是**普通的 HTTP 模型：**在模型选择器里选中它，底层就由本机真正的 `claude` 二进制执行**（其余模型照旧走 pi-ai / HTTP）。

- **凭据**：子进程用**插件配置的 baseURL 与当前 Key**（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`），并使用独立的 `CLAUDE_CONFIG_DIR`（`~/.dsh/packycode-claude-cli`）。隔离是必须的：`~/.claude/settings.json` 里的 `env` 会覆盖进程环境，不隔离就等于用你 CLI 自己配置里的 token，插件 Key 完全不生效。
- **设置项**：
  - `claudeCliPath` — CLI 路径，空则按 `~/.local/bin`、`/usr/local/bin`、`/opt/homebrew/bin`、`PATH` 顺序查找。
  - `claudeCliMode` — 默认 `edit`。`read-only`（Read/Grep/Glob）｜`edit`（另加 Edit/Write）｜`full`（`--dangerously-skip-permissions`，含 shell 命令）。
  - `claudeCliCwd` — 工作目录，空则用**当前会话的工作区**（取不到时退回进程目录）。
- **语义**：一个 CLI 回合 = 一次委派。CLI 用**它自己的**工具与权限系统完成任务并给出最终答案；它无法调用 harness 的工具，所以插件**不会**把工具清单转发给它；系统提示也用 CLI 自己的（只把最近的对话作为上下文，过长按尾部截断）。因此对 `claude-opus-5-5` 而言：DSH 的沙箱/审批不约束子进程内部动作，会话记录里只有最终答案，看不到中间的 Read/Edit 调用。
- **代价**：每次数秒到数十秒，按 PackyCode 计费（实测单次约 **$0.19**，因 CLI 自带大量系统提示与工具说明）。
- 另有 `claude_code` **工具**：当会话由 `gpt-6.1-sol` / `deepseek-flash` 驱动时，可以让模型显式把某个任务委派给 Claude Code（参数含 `prompt` / `mode` / `model` / `cwd`），与上面共用同一个 runner。

## 安全

- API Key 只存在本机 DSH 凭据文件（`~/.dsh/.credentials.yaml`，权限 0600），由 DSH 的 credential record 管理；不会写进设置文档、日志或对话记录。
- 浏览器只能拿到 Key 的**备注、状态和余额**，拿不到 Key 本身。
- 余额请求只在宿主侧发出，带超时并禁止重定向。
- 插件**不会**回退到环境变量里的 `PACKY_CODE_API_KEY`，也不会回退到其它 provider：只用你显式添加的 Key。

## 开发与验证

```sh
pnpm install
pnpm run check          # 全部测试 + 构建 + 打包
node scripts/live-check.mjs   # 真机验证（需要本机已存 PackyCode Key，会消耗少量额度）
```

`scripts/live-check.mjs` 会读取本机已存的 Key，验证：余额读取、三个模型各跑通一次（三种协议各一条）、以及「无效 Key + 真 Key」的轮换演练，并报告 harness 侧的失败分类。

本地迭代时可以把插件 link 进 profile：

```sh
dsh plugin --profile <profile> add link:/path/to/dsh-packycode-api
```

改了 Host 代码必须重启 DSH 才会生效；只改客户端代码刷新浏览器即可。
