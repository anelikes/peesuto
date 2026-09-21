# pocket-paste v1 实现计划（第二版）

2026-09-22 改版。第一版把产品定义为"复制文字，粘贴出卡片"；当天晚些时候用户
把定位改为：**首先是一个智能剪贴板，其次是一个借复制粘贴进入的 AI 动作入口**。
卡片、GIF、视频是其中一个动作，锦上添花。整个应用开源；用户隐私是硬约束，
决策用的小模型和生成用的大模型都必须支持自部署接入。

第一版计划已完成的部分（core/ 迁移、引擎钉住、sidecar 打包验证、单元测试与
CI）全部保留，它们是新计划的底座。

## 0. 定位与原则

- **主体是剪贴板历史加智能挑选。** 复制过的东西按快捷键随时可取；粘贴时，应用
  读取当前输入框的上下文，让决策模型从最近的历史里挑出最合理的一条，预选给
  用户，回车即粘贴。
- **动作是可配置的。** "粘贴为卡片"、"粘贴译文"、"粘贴摘要"都是动作：一个
  触发方式（快捷键、提示词、菜单）、一个输入、一类模型、一个输出形态。内置几
  个，用户可以自己加，动作包可以分发。
- **本地优先，出网显式。** 历史本地加密存储；密码框与密码管理器默认排除；纯
  本地模式下所有非模型功能可用；任何内容离开本机都是用户显式选择的结果，
  并可审计。
- **模型双轨、三种接入。** 决策类（Jev 或同类小模型）和生成类（LLM）各自独立
  配置；每类都支持自带 key、自部署端点、托管服务三种接入。自部署就是一个
  base URL 加可选凭证。
- **开源全部，订阅卖托管与内容。** 应用、核心算法、动作格式、风格包格式全部
  MIT。订阅解锁的是托管的模型调用（免配置）和官方的风格包、动作包。

## 1. v1 的定义

1. **历史可用。** 安装后自动记录复制的文字与图片；快捷键弹出面板，搜索、回车
   粘贴、置顶、删除、一键清空；密码管理器与 Concealed 类型的内容不进历史。
2. **智能挑选可用。** 在支持辅助功能的输入框里按粘贴快捷键，面板把决策模型
   挑出的一条放在首位并高亮，回车粘贴；无上下文或无模型时退化为最近优先。
   附一份三十个真实场景的命中率探测表。
3. **动作可用。** 内置五个动作：智能粘贴、粘贴为卡片、粘贴为 GIF、粘贴译文、
   粘贴摘要；用户可用提示词加快捷键新建动作；动作以 JSON 文件存于
   App Support，格式有文档。
4. **双轨 Provider 可用。** 决策类：Jev 经 Cloudflare 自带 key、任意兼容端点
   （自部署代理或托管）、无。生成类：任意 OpenAI 兼容端点（Ollama、vLLM、
   LM Studio、各家云）、Anthropic、托管、无。凭证在 Keychain；离线模式一键
   切换。
5. **隐私可核。** 设置里能看到每类数据去向；本地日志只记出网的去向与字节数，
   不记内容；历史库用 Keychain 里的密钥加密；README 有隐私说明。
6. **可发布。** DMG、自动更新、CI 绿；签名公证接入用户证书即生效。

## 2. 架构

四层：

| 层 | 技术 | 职责 |
|---|---|---|
| 壳 | Tauri 2，Rust | 托盘、全局快捷键、剪贴板轮询与写入、粘贴模拟、辅助功能上下文采集、加密存储、Keychain、窗口 |
| 界面 | HTML + TypeScript | 历史面板、挑选确认条、动作结果、设置、引导 |
| Core | TypeScript，Bun，长驻 sidecar | 挑选与动作的逻辑、Provider 双轨、出网层、渲染链、CLI |
| 引擎 | Pocket Motion | 卡片、GIF、视频的确定性渲染 |

**壳与 Core 的分工。** 所有需要常驻、需要系统权限、需要每秒写盘的事在壳里：
每 250 ms 读一次 pasteboard 的 changeCount，新内容按类型（文本、RTF、HTML、
图片、文件 URL）落库；粘贴模拟是写 pasteboard 再合成一次 ⌘V 键事件；上下文
采集走 AXUIElement。所有"判断"在 Core 里：挑选、动作运行、模型调用、渲染。
Core 以长驻进程运行，壳启动时拉起一次，通过 stdin/stdout 的 JSON 行协议交互
（`pick`、`run-action`、`render`、`health`），这样挑选的往返不含进程启动开销，
测量缓存和连接也保温。`paste` CLI 继续存在，供开源用户和脚本使用。

**上下文采集分级。** L0 只有前台应用；L1 加聚焦控件的角色与标签；L2 加光标
前后各 N 字符。原生与 Electron 应用一般能到 L2，Chromium 网页要开启无障碍
才有 L2，密码框（AXSecureTextField）不采集且不弹智能挑选。挑选问题按级别
退化，L0 时决策模型只看应用和候选。

**挑选问题的形状。** state 是应用标识、控件角色、光标前后文、最近 N 条候选
的摘要（截断，不含被排除的项）；问题是一个 Choice 覆盖候选加"都不合适"，
加一个 Noul 问"此处是否该粘贴"。答案只用于排序与预选，粘贴永远由用户按键
确认。命中率经探测验证后，再考虑对高置信度跳过确认。

**Provider 双轨。**

| 类 | 实现 | 凭证 | 说明 |
|---|---|---|---|
| Decider | `jev-cloudflare` | account ID + token | Workers AI REST，自带 key |
| Decider | `jev-endpoint` | 可选 bearer | 任意兼容 `{state, questions}` 的 URL：自部署的 proxy/ 或托管 |
| Decider | `none` | 无 | 启发式：最近优先、同应用亲和 |
| Generator | `openai-compatible` | 可选 key | base URL + model：Ollama、vLLM、LM Studio、云服务 |
| Generator | `anthropic` | key | 自带 key |
| Generator | `hosted` | 订阅凭证 | 托管代理 |
| Generator | `none` | 无 | 生成类动作不可用，提示配置 |

两类共用一个出网层：唯一的 fetch 出口，受"离线模式"开关约束，记录去向、
时间、字节数到本地日志，不记内容。

**动作声明。** 一个动作是一份 JSON：

```
{ "id": "translate-en", "name": "粘贴译文", "trigger": { "hotkey": "Cmd+Alt+V" },
  "input": "clipboard", "needs": "generator",
  "prompt": "Translate to English. Output only the translation.\n\n{{input}}",
  "output": "text" }
```

`needs` 是 `decider`、`generator`、`render` 或 `none`；`output` 是 `text`、
`image`、`gif`、`video`、`file`。内置动作：`paste-smart`（挑选）、`paste-card`
（走渲染链，含第一版的七个 Jev 问题）、`paste-gif`、`paste-translate`、
`paste-summary`。用户动作放 `<App Support>/actions/*.json`；动作包是一个目录，
格式与内置相同。风格包同理是目录（`core/src/catalog.ts` 已按可合并设计）。

**存储。** SQLite，字段级加密，密钥在 Keychain；图片存缩略图与原图文件；
排除规则：`org.nspasteboard.ConcealedType`、`org.nspasteboard.TransientType`、
应用黑名单（预置 1Password、Bitwarden、Keychain Access 等）；保留期限；
一键清空真正删除文件。

## 3. 仓库布局

```
pocket-paste/
  PLAN.md  README.md  LICENSE  package.json  engine.json
  engine/                引擎 checkout（gitignore；POCKET_ENGINE 可指向别处）
  core/
    src/cli.ts           paste CLI（保留）
    src/daemon.ts        长驻 sidecar：JSON 行协议
    src/pick/            挑选：候选摘要、上下文分级、问题、启发式退化
    src/actions/         动作声明、校验、运行时、内置动作
    src/provider/        decider/ 与 generator/ 两轨，egress.ts 出网层，cache.ts
    src/render/          卡片渲染链（第一版）
    src/catalog.ts       目录与风格包合并
    src/questions.ts  src/dsl.ts  src/engine.ts
    tests/  fixtures/
  app/                   Tauri 2
    src-tauri/src/       clipboard.rs 轮询与写入、paste.rs 粘贴模拟、
                         context.rs AX 采集、store.rs 加密存储、secrets.rs、
                         sidecar.rs 长驻进程、hotkeys.rs、tray.rs
    src/                 history 面板、confirm 条、result 视图、settings、onboarding
  proxy/                 可自部署的 Jev 代理 worker（dev 与 hosted 两种模式）
  scripts/               engine.ts、bundle-sidecar.ts、fetch-emoji.ts、probe-pick.ts
```

## 4. 里程碑

按风险和依赖排序。M0 已完成，其余从 M1 开始。

### M0 底座（已完成，2026-09-22）

core/ 迁移且五个夹具逐字节一致；`engine.json` 钉住引擎；`scripts/engine.ts`
取回与校验；单元测试与 CI；sidecar 打包验证通过：无仓库、PATH 上无 bun 的
干净环境里，资源树 73 MB 加 Bun 58 MB，冷启动约 3.2 s，热启动约 0.8 s。
GIF 改为进程内编码（gifenc，帧间差分，体积是 ffmpeg 版的一半，ffmpeg 不再是
运行时依赖）；Noto Emoji 128 px 全集 3,583 张共 19.0 MiB，低于 20 MB 阈值，
随包分发（`scripts/fetch-emoji.ts` 拉取，`bundle-sidecar.ts` 打包，运行时先查
随包集，再查缓存，最后才联网）。Cloudflare REST provider 已实现并有桩测试，
真实调用待用户提供 API token（本会话不读取 wrangler 的 OAuth 凭证文件）。

### M1 剪贴板历史（壳，已完成 2026-09-22）

`clipboard.rs` 轮询与排除、`store.rs` AES-256-GCM 字段加密的 SQLite（密钥在
Keychain）、图片与缩略图加密落盘、保留期清理、锁定态与重新开始；
`paste.rs` 粘贴模拟；历史面板搜索、方向键、回车、置顶、删除、清空。
cargo 测试 12 个，原文件扫描无明文。待人工：连续复制一百次、密码管理器实测。

- `clipboard.rs`：轮询 changeCount，类型识别，排除规则，去重。
- `store.rs`：SQLite 加密存储，保留策略，缩略图。
- `paste.rs`：写 pasteboard、合成 ⌘V、可选恢复原内容；需要辅助功能权限。
- 历史面板：快捷键弹出、搜索、方向键、回车粘贴、置顶、删除、清空。
- 验收：v1 定义第 1 条；连续复制一百次不丢不重；密码管理器内容不入库。

### M2 上下文采集与智能挑选（Core 侧已完成 2026-09-22；`context.rs` 待壳）

`core/src/pick/` 落地：候选摘要、三级上下文的问题构造、答案到排序的融合、
启发式退化；36 个测试；合成场景探测启发式 top-1 19/30、top-3 30/30
（`baselines/pick.md`）。代理已放行挑选请求的形状。

- `context.rs`：AX 采集，三级降级，密码框短路。
- `core/src/pick/`：候选摘要、问题构造、答案到排序、`none` 启发式。
- `scripts/probe-pick.ts`：用记录的三十个场景量命中率（场景文件本地生成，
  不入库）。
- 验收：v1 定义第 2 条；探测表进 `baselines/pick.md`。

### M3 Provider 双轨与出网层（已完成 2026-09-22，真实调用待凭证）

decider 三种、generator 四种、`egress.ts` 唯一出口与离线开关、去向日志、
凭证引用经 SecretStore 解析、配置文件不含明文密钥；89 个测试。待用户：
Cloudflare token 验证 REST；本机 Ollama 验证翻译。

- Decider 三种、Generator 四种实现；`egress.ts` 唯一出口，离线开关，去向日志。
- Cloudflare REST 真实跑通；本地 Ollama 跑通翻译；凭证入 Keychain。
- 答案缓存按内容哈希。
- 验收：v1 定义第 4、5 条。前置假设要第一时间验证：`typesafe/jev` 能从
  Workers AI 的 REST 端点调到。

### M4 动作系统（已完成 2026-09-22，编辑器待 GUI）

`core/src/actions/`：声明格式与校验、用户文件与动作包加载、五个内置动作、
运行时；`docs/actions.md`；`paste --action <id>` 命令行入口。

- 声明格式与校验、运行时、五个内置动作、自定义动作编辑器。
- `paste-card` 与 `paste-gif` 接现有渲染链；视频输出依赖引擎的 render 与
  ffmpeg，v1 里作为"检测到 ffmpeg 才启用"的动作。
- 动作包目录格式与文档。
- 验收：v1 定义第 3 条。

### M5 GUI 整合与引导（已完成 2026-09-22，bundled 端到端验证进行中）

`core/src/daemon.ts` 与 `docs/daemon.md`：JSON 行协议。壳侧 `daemon.rs`
常驻接入、`context.rs` 辅助功能采集、智能挑选面板、动作菜单与结果视图、
五个设置面板（通用、双轨 Provider、动作、隐私、排除）、引导；标识符改为
`dev.pocketpaste.desktop`。dev 模式无人值守跑通挑选与动作；截图与真实模型
调用受本机权限与凭证限制未做。

- 托盘、历史面板、挑选确认条、动作结果视图、设置（双轨 Provider、隐私、
  排除、快捷键、动作）、引导（辅助功能权限是必需项：粘贴模拟与上下文采集
  都靠它）。
- Core 改为长驻 sidecar；CLI 保留。
- 验收：从 DMG 安装后走完引导，六个动作各用一次。

### M6 长尾与隐私审计（语料侧已完成 2026-09-22；隐私实测待壳）

一百条语料：94 渲染、13 截断、6 明确拒绝（不支持的文字系统）、0 崩溃，
verify 零活动 finding（`baselines/corpus.md`，`scripts/corpus.ts` 可重跑）。
隐私审计清单在 `docs/privacy-audit.md`，剪贴板探针在
`scripts/pasteboard-probe.swift`；逐项实测在壳的存储与排除落地后进行。

- 卡片语料一百条，`verify` 零 finding 或明确拒绝。
- 隐私审计清单：每类数据去向、关闭方法、验证步骤；对 1Password、Bitwarden、
  Keychain Access 与 Concealed 类型逐一实测。

### M7 发布工程

LICENSE、CONTRIBUTING、SECURITY、隐私说明；GitHub Actions 出未签名 DMG；签名
公证与 updater 密钥待用户提供；Homebrew cask。

### M8 订阅（代理侧已完成 2026-09-22，部署与计费待用户）

`proxy/` hosted 模式：订阅 token、月配额、限流、`/v1/ask`、`/v1/generate`、
`/v1/me`、`/v1/packs`、admin 与计费 webhook，126 个测试；`docs/subscription.md`。

托管 decider 与 generator 代理（鉴权、计量、限流、不记内容）；许可证密钥与
应用内授权；风格包与动作包分发；计费用 merchant of record；官网与条款。

## 5. 已定的决策

- 主体是智能剪贴板，卡片是动作。（2026-09-22 用户）
- 决策模型与生成模型分轨，每轨都支持自带 key、自部署端点、托管。（2026-09-22 用户）
- 隐私是硬约束：本地优先、出网显式可审计、历史加密、密码类默认排除。（2026-09-22 用户）
- 挑选第一版是预选加确认，不自动粘贴。
- Core 长驻，壳负责系统集成与存储。
- 壳用 Tauri 2；开源版与订阅版同一二进制；引擎分支由用户合并，pocket-paste
  只钉 commit。
- 开源核心算法与所有格式；订阅解锁托管调用与官方风格包、动作包。
- ffmpeg 不随包：GIF 进程内编码，视频动作按 ffmpeg 存在与否启用。
- v1 完成后不停，继续 M6 到 M8；独立模块交给子 agent 并行。

## 6. 风险与退路

| 风险 | 表现 | 退路 |
|---|---|---|
| Chromium 网页拿不到上下文 | 浏览器里只有 L0/L1 | 按级别退化，浏览器里以应用与站点亲和排序 |
| 粘贴模拟被应用拦截 | 合成 ⌘V 无效 | 面板里提供"仅复制到剪贴板"并提示手动粘贴 |
| 挑选命中率不够 | 探测表低于可用线 | 保留历史面板与最近优先，挑选降为排序提示 |
| 隐私事故 | 内容意外出网 | 唯一出网层加离线开关，日志可核，默认本地 |
| Jev 不在 REST 端点 | M3 探测 404 | 自部署 proxy/ 作为默认路径 |
| 长驻 sidecar 内存 | 常驻 Bun 进程 | 空闲 N 分钟后退出，下次调用再拉起 |

## 7. 用户待办

0. 一个 Cloudflare API token（Workers AI 读权限），用于验证 `typesafe/jev`
   的 REST 路径：`PASTE_PROVIDER=cloudflare PASTE_CF_ACCOUNT_ID=… PASTE_CF_TOKEN=…
   bun run paste "…"`。
1. 引擎分支栈合并与公开 tag（不阻塞 M1 到 M6）。
2. M7：Apple Developer 账号、证书、Notarization、updater 密钥。
3. M8：Cloudflare 部署与域名、计费平台、条款审阅。
