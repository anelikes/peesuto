# Peesuto v1 实现计划（第三版：原生 macOS 桌面层）

2026-09-22 更新。**已确定长期架构：SwiftUI + AppKit 桌面层，保留 TypeScript / Bun
Core 与独立的 Pocket Motion；旧 Tauri 桌面、界面 WebView 与专用构建依赖已删除，不使用 Electron。**
图片、GIF、视频生成是产品核心能力，与智能剪贴板和 AI 动作共同组成产品，不再定位为
锦上添花。Bun 是业务与渲染运行依赖，不是界面运行环境。

**实施状态：原生迁移部分完成。** `native/` 可构建独立的 SwiftUI + AppKit `.app`，
已打通加密历史、系统集成、Bun 通信、图片/GIF/视频动作与中英文；视频需本机 ffmpeg。
已实现当前剪贴板直跑快捷键、非抢焦点状态浮窗和有限任务生命周期事件。旧 `app/` 源码已删除，
`native/` 是唯一桌面入口；功能与发布验收仍未全部完成。M0–M8 保留历史记录；N1 已完成，
N2–N4 部分实现，N5 已切换原生 CI/打包并移除旧桌面，正式签名、更新与发布未完成。构建命令见 [native/README.md](native/README.md)，完整边界与验收见
[原生迁移方案](docs/native-migration.md)。M9 hooks 仍未开始，不随本次迁移扩展范围。

**模板首批已落地并构建：** 8 类 × 2 种设计变体，PNG/GIF/MP4 共用结构化模板管线；
原生结果页可切换模板、风格、动效及格式。358 项 Core 测试、35 项 Swift 测试及
独立的真实引擎/打包冒烟验收通过，详见 [本批验收记录](baselines/templates-native-0.1.0.md)。
流程图、时间轴、活动卡与诗歌模板留待后续批次。

## 0. 定位与原则

- **剪贴板是日常入口。** 复制过的东西按快捷键随时可取；粘贴时，应用
  读取当前输入框的上下文，让决策模型从最近的历史里挑出最合理的一条，预选给
  用户，回车即粘贴。
- **图片、GIF、视频生成是核心能力。** 保留 Pocket Motion 的画面描述、动画与确定性
  帧渲染能力；当前已接入 PNG/GIF/MP4。视频依赖用户本机 ffmpeg，未内嵌或自动安装；
  正式编码器分发与交付验收仍待完成。
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
2. **智能挑选可用。** 在支持辅助功能的输入框里按粘贴快捷键，面板把推荐
   结果作为独立推荐项，历史列表保持稳定的最近顺序；用户明确选中后回车粘贴。
   无上下文或无模型时退化为规则与最近优先。现有三十个合成场景探测不能代表真实
   命中率，原生版验收补充真实场景记录。
3. **动作可用。** 内置六个动作：智能粘贴、粘贴为卡片、粘贴为 GIF、粘贴为视频、粘贴译文、
   粘贴摘要；用户可用提示词加快捷键新建动作；动作以 JSON 文件存于
   App Support，格式有文档。
4. **双轨 Provider 可用。** 决策类：Jev 经 Cloudflare 自带 key、任意兼容端点
   （自部署代理或托管）、无。生成类：任意 OpenAI 兼容端点（Ollama、vLLM、
   LM Studio、各家云）、Anthropic、托管、无。凭证在 Keychain；离线模式一键
   切换。
5. **隐私可核。** 设置里能看到每类数据去向；本地日志只记出网的去向与字节数，
   不记内容；历史库用 Keychain 里的密钥加密；README 有隐私说明。
6. **原生 GUI 可用。** 一个日常面板承载搜索、历史、动作与结果预览；设置独立。
   中文、英文、跟随系统保留；普通用户流程不暴露 sidecar、引擎路径和调试日志。
7. **核心输出完整。** PNG/GIF 保持既有渲染结果；视频动作已接入 MP4，当前使用
   本机 ffmpeg。正式编码器分发、目标应用兼容与完整视频验收仍是独立交付项。
8. **可发布。** 真实原生 `.app`、DMG、原生更新链路与 CI；签名与公证须验证。
   最低 macOS 13.0，当前仅 arm64。前端构建成功不等于原生应用已构建或可交付。

## 2. 架构

以下是目标架构；当前实现对照与迁移顺序见 [原生迁移方案](docs/native-migration.md)。

| 层 | 技术 | 职责 |
|---|---|---|
| 桌面与系统集成 | Swift + AppKit | 菜单栏、全局快捷键、剪贴板、粘贴模拟、辅助功能上下文、加密存储、Keychain、窗口与焦点、进程管理 |
| 原生界面 | SwiftUI，由 AppKit 承载 | 日常面板、动作与结果预览、设置、权限引导、中英文 |
| Core（保留） | TypeScript + Bun，本地独立进程 | 智能挑选、动作、Provider 双轨、模型出网控制、卡片决策与编排、渲染调度、GIF 编码、CLI |
| 引擎（保留） | 独立的 Pocket Motion，版本由 `engine.json` 钉住 | composition 构建、画面与动画帧的确定性渲染、引擎的视频编码链路 |

**桌面层与 Core 的分工。** 系统权限、剪贴板采集、历史数据库与密钥、快捷键和
粘贴操作由 Swift/AppKit 负责；这些能力已有原生实现与合成测试，旧 Rust 桌面层已删除。
现有格式兼容与真实跨应用行为仍需持续验收，不能因源码删除宣称全部场景已通过。所有业务判断、模型适配、动作格式与渲染编排留在 Core，CLI 继续保留。
订阅、包安装、更新等桌面层请求继续遵守离线策略和无内容日志约束。

**通信与生命周期。** 初期兼容现有 stdin/stdout JSON 行协议；原生界面与历史操作
不等待 Core 启动。Core 按需启动、连续任务复用、无活动任务时空闲退出，重启后先
同步配置与凭证。现有协议串行处理，已加入按请求启用的有限生命周期事件；取消仍
终止整个 Core 进程组，细分进度、单任务取消和能力协商尚未实现，详见
[daemon 文档](docs/daemon.md)。长渲染不能阻塞历史操作与轻量请求是后续调度目标，
但同一引擎资源树的构建仍须串行或隔离，不能简单并行所有任务。

**渲染边界。** 保留 Bun 是明确的长期选择：当前 Pocket Motion 的构建与运行宿主
都依赖它。界面原生化不要求去掉后台 JS/WASM，也不重写 Pocket Motion 的 Rust 核心。
Core 对桌面层提供任务接口，桌面层不直接导入引擎内部模块。PNG/GIF 继续使用现有
渲染链；`paste-video` 和 `run-action` 已支持视频，通过本机 ffmpeg 输出 MP4。
打包应用尚未内嵌或自动安装 ffmpeg，缺少依赖时明确报错，不影响 PNG/GIF。

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
（走渲染链，含第一版的七个 Jev 问题）、`paste-gif`、`paste-video`、`paste-translate`、
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
  native/                SwiftUI + AppKit 原生工程、系统/存储/通信模块与测试
  docs/native-migration.md 原生迁移边界、GUI 方向与验收
  proxy/                 可自部署的 Jev 代理 worker（dev 与 hosted 两种模式）
  scripts/               engine.ts、build-native.ts（原生 .app 构建与打包）、bundle-sidecar.ts、
                         fetch-emoji.ts、probe-pick.ts
```

## 4. 里程碑

**当前优先级：N1–N5 原生迁移。** M0–M8 是此前 Tauri/Core 工作的历史记录，
其中的构建大小、测试数量与耗时仅代表记录时环境；遗留待办不因迁移计划而自动完成。

### N1 原生骨架与 Core 接入（已完成，2026-09-22）

新增 `native/`，SwiftUI + AppKit 菜单栏、面板、设置窗口与中英文基础；复用 Bun Core
和 JSON 行接口，打出包含 Bun、Core、引擎与资源的真实 `.app`。历史面板不等待 Core。
验收已通过：release `.app` 内含 Swift 程序、Bun、Core 与钉住的引擎；从 `/tmp`、
`PATH=/usr/bin:/bin` 运行打包冒烟，PNG/GIF 生成成功。实际打开隔离原生预览应用，
核对结果布局、返回流程与中英文切换。记录见 [原生第一版验收](baselines/native-0.1.0.md)。

### N2 系统能力与数据兼容（部分完成）

已实现上述系统能力的原生模块与合成兼容测试；真实用户数据迁移、跨应用粘贴、多屏与
权限流程仍待完整验收；旧桌面源码已按产品决策移除，历史代码可从 Git 查阅。

迁移剪贴板监听、排除规则、AX 上下文、快捷键、焦点恢复、粘贴、加密 SQLite、图片、
Keychain、保留期、设置与凭证。保留应用标识和数据格式；读旧版样本并验证旧版回读，
不得因读取或权限失败自动清库。测试新旧客户端不能同时采集或写入同一生产数据目录。

### N3 GUI 与动作工作流重做（部分完成）

已实现原生历史/结果面板、通用/AI/隐私设置与中英文，以及可按键录入、清除停用的
快捷键设置。默认 ⌘⌥1/2/3 分别生成图片/GIF/视频，直接使用当前剪贴板文字，无需
先选历史或打开主面板；受保护内容仍排除。状态浮窗不激活应用、不抢输入焦点。
生成后仅在前台目标、窗口、输入控件、选区与内容仍匹配且权限可用时自动粘贴；
无法确认目标时降级为复制，生成期间若剪贴板变化则保留新内容，仅保留可手动操作的结果。
账户/扩展包管理 GUI、动作编辑器、任意自定义动作的快捷键入口和高级设置仍未完成。

本轮模板注册表覆盖 **8 类 × 2 个变种**：文档、引用、代码、数据、列表、对话、表格、对比。
内容从原文和明确语法本地解析；Jev 仅在兼容的模板/变种/动效选项中选择，不生成或改写
内容。结果视图可换风格、切换图片/GIF/视频格式。其余 4 类仍属后续，不计入已实现范围；
细节与约束见 [模板说明](docs/templates.md)。旧 DSL 夹具继续保留，不代表新增模板全部验收。

日常面板采用搜索、稳定历史顺序、独立推荐、选中项动作、同面板结果预览；设置按用户
任务组织，减少文字与入口。迁移已有动作、Provider、订阅与包管理，不暴露开发环境配置。
验收覆盖键盘、中英文、权限拒绝、动作错误、长文本、图片、多屏、全屏与输入法。

### N4 任务协议、性能与核心输出（部分完成）

已实现客户端请求关联、超时、配置恢复和通过进程组停止 Core/渲染子进程；当前取消
会终止整个 Core。`run-action`/`render` 可选择接收 accepted/running/completed/failed
生命周期事件，最终响应格式不变，没有估算百分比。已修复任务执行期间 idle timer
误退出，任务完成后才重新计时。视频内置动作已接入，需本机 ffmpeg；协议仍串行，
细分渲染进度、能力协商与不阻塞轻量请求的独立调度尚未完成。

完善协议版本/能力协商、进度、取消、超时与崩溃恢复；渲染隔离不阻塞轻量请求，
引擎构建并发遵守资源隔离约束。保留 PNG/GIF 夹具摘要，补齐视频编码器正式交付与验收。
测量全部相关进程的冷/热耗时、空闲/渲染峰值内存与磁盘占用；优化帧缓存与空闲退出，
不承诺未经测量的收益。视频编码验收区分逐帧一致性与容器字节一致性。

### N5 原生交付与移除旧桌面层（源码与构建切换完成，正式发布未完成）

已删除旧桌面源代码、专用依赖/配置和旧发布流程。CI 改为 Swift 测试/release 编译，
引擎夹具与完整原生 `.app` 的 PNG/GIF 冒烟；`bundle-sidecar` 默认输出 `native/.bundle`。
手动构建工作流仅上传原生验证 ZIP，不响应 tag 自动发布、不创建 Release、不使用旧
更新签名与元数据。引擎依赖的 Rust/WASM 保留；不删除生产用户数据与历史发布产物。

尚需实现 Developer ID 签名、公证、DMG 安装包、原生更新机制、Homebrew cask 与正式分发
（旧桌面从未发布，无旧安装需要升级桥接）；签名与公证的具体步骤见 [docs/RELEASING.md](docs/RELEASING.md)。移除旧项目并不等于缺失 GUI、真实数据/权限/粘贴验收已完成。
交付准确的 `native/dist/Peesuto.app` 路径、版本与验证记录，不能以编译通过代替实际应用验收。

以下 M0–M8 仅为历史成果与待办记录，其中旧桌面命令/文件已不可用于当前 checkout，
旧发布能力不代表现行原生应用已实现；当前入口以 `native/README.md` 为准：

### M0 底座（已完成，2026-09-22）

core/ 迁移且五个夹具逐字节一致；`engine.json` 钉住引擎；`scripts/engine.ts`
取回与校验；单元测试与 CI；sidecar 打包验证通过：无仓库、PATH 上无 bun 的
干净环境里，资源树 73 MB 加 Bun 58 MB，冷启动约 3.2 s，热启动约 0.8 s。
GIF 改为进程内编码（gifenc，帧间差分，体积是当时 ffmpeg 版的一半，PNG/GIF 路径
不再依赖 ffmpeg；视频编码另计）；Noto Emoji 128 px 全集 3,583 张共 19.0 MiB，低于 20 MB 阈值，
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

### M3 Provider 双轨与出网层（已完成 2026-09-22，Jev 真实调用待凭证）

decider 三种、generator 四种、`egress.ts` 唯一出口与离线开关、去向日志、
凭证引用经 SecretStore 解析、配置文件不含明文密钥；89 个测试。待用户：
Cloudflare token 验证 REST。

本机 Ollama 0.30 已真实跑通翻译与摘要（qwen3.5:4b），并由此修了一个 bug：
带思考的模型把 `maxTokens` 全花在 `reasoning` 上、`content` 为空，动作却报
成功。生成器现在识别这种回答、用 `reasoning_effort: "none"` 重试一次并记住；
`reasoning` 与 `timeoutMs` 可在设置、providers.json、环境变量里钉死；
生成器返回空文本的动作按错误处理。

Laya 评估（2026-09-22，用户提议用它做免费本地 decider）：接口与 Jev 同形、
答案字段同名，本机 M4 上一张卡片约 100 ms；但零样本质量低于现有启发式：
卡片 kind 准确率 35–41%（规则分类器 91%），挑选 top-1 最好 57%（启发式
63%）。结论：暂不内置；实验脚本在 `scripts/laya/`，数字在
`baselines/laya.md`。免费离线的首跑路径应是启发式挑选加规则化 kind 判定，
生成类动作用 Ollama。Laya 若按我们的问题微调，可经 endpoint decider 直接接入。

随后落地（同日）：decider 新增 `rules`（默认，规则化 kind + 长度几何，挑选走启发式）
与 `laya`（本地模型选项，不内置，`docs/laya.md` 写安装；挑选混合权重 0.3）。
用户的取舍：Laya 不如 Jev 聪明，但胜在本地与隐私，所以必须是一个可选项。

- Decider 三种、Generator 四种实现；`egress.ts` 唯一出口，离线开关，去向日志。
- Cloudflare REST 真实跑通；本地 Ollama 跑通翻译；凭证入 Keychain。
- 答案缓存按内容哈希。
- 验收：v1 定义第 4、5 条。前置假设要第一时间验证：`typesafe/jev` 能从
  Workers AI 的 REST 端点调到。

### M4 动作系统（已完成 2026-09-22，编辑器待 GUI）

`core/src/actions/`：声明格式与校验、用户文件与动作包加载、五个内置动作、
运行时；`docs/actions.md`；`paste --action <id>` 命令行入口。

- 声明格式与校验、运行时、五个内置动作、自定义动作编辑器。
- **M4 记录时状态：** `paste-card` 与 `paste-gif` 已接现有渲染链，视频尚未实现，
  当时 `run-action` 拒绝 video。后续原生 N4 已新增 `paste-video`，见上文当前状态。
- 动作包目录格式与文档。
- 验收：v1 定义第 3 条。

### M5 GUI 整合与引导（已完成 2026-09-22，bundled 端到端已验证）

`core/src/daemon.ts` 与 `docs/daemon.md`：JSON 行协议。壳侧 `daemon.rs`
常驻接入、`context.rs` 辅助功能采集、智能挑选面板、动作菜单与结果视图、
五个设置面板（通用、双轨 Provider、动作、隐私、排除）、引导；标识符改为
`com.peesuto.desktop`。dev 模式无人值守跑通挑选与动作；打包路径：daemon 从
Contents/Resources 启动，引擎 190 ms 安装（APFS clone），卡片冷 1.5 s、热
0.55 s；debug 包 203 MB（未 strip 的二进制 46 MB，Bun 58 MB，资源 98 MB）。
截图与真实模型调用受本机权限与凭证限制未做。

- 托盘、历史面板、挑选确认条、动作结果视图、设置（双轨 Provider、隐私、
  排除、快捷键、动作）、引导（辅助功能权限是必需项：粘贴模拟与上下文采集
  都靠它）。
- Core 改为长驻 sidecar；CLI 保留。
- 历史验收目标：从 DMG 安装后走完引导，五个内置动作各用一次。

### M6 长尾与隐私审计（已完成可自动化部分 2026-09-22；人工项待用户）

一百条语料：94 渲染、13 截断、6 明确拒绝（不支持的文字系统）、0 崩溃，
verify 零活动 finding（`baselines/corpus.md`，`scripts/corpus.ts` 可重跑）。
隐私审计清单在 `docs/privacy-audit.md`，剪贴板探针在
`scripts/pasteboard-probe.swift`；五项自动实测全部通过
（`baselines/privacy-0.1.0.md`）：Concealed/Transient 不入库、黑名单应用跳过、
原文件无明文、离线不出网且日志无内容、删除与清空真正删文件。待人工：密码
管理器真机、AXSecureTextField、辅助功能授权流程。

- 卡片语料一百条，`verify` 零 finding 或明确拒绝。
- 隐私审计清单：每类数据去向、关闭方法、验证步骤；对 1Password、Bitwarden、
  Keychain Access 与 Concealed 类型逐一实测。

### M7 发布工程（已完成可做部分 2026-09-22；签名公证待用户）

LICENSE、CONTRIBUTING、SECURITY、issue 与 PR 模板、`docs/RELEASING.md`、
Homebrew cask 骨架；`release.yml` 由 tag 或手动触发，在 macOS runner 上取引擎、
打 sidecar、`tauri build`；没有签名私钥时自动关闭 updater 产物。本机 release
构建：.app 167 MB、DMG 141 MB，未签名应用可启动（首次需右键打开）。updater
在配置公钥后启用，30 s 后与每日检查一次。待用户：Apple 证书与公证、updater
密钥对、GitHub 仓库与 secrets。

### M8 订阅（代码侧已完成 2026-09-22，部署与计费待用户）

`proxy/` hosted 模式：订阅 token、月配额、限流、`/v1/ask`、`/v1/generate`、
`/v1/me`、`/v1/packs`、admin 与计费 webhook，126 个测试；`docs/subscription.md`。
应用侧：订阅面板（许可证密钥入 Keychain、`/v1/me` 显示、一键双轨托管）、
风格包浏览、安装（SHA-256 校验、zip-slip 防护）、移除；Core 侧风格包目录片段
合并进目录并直达 Jev 的选项与卡片（`docs/packs/example-neon`）。对假代理验证
通过；真实端点待部署。

托管 decider 与 generator 代理（鉴权、计量、限流、不记内容）；许可证密钥与
应用内授权；风格包与动作包分发；计费用 merchant of record；官网与条款。

### M9 生命周期事件与 hooks（v1.1，方案已定 2026-09-22，未开始）

来源：用户提出参考 deepseek-harness 的「一切皆插件」（Cordis：服务、带派发
模式的类型化事件、可撤销注册、按 id 打补丁的组合）。结论是**借思想不借框架**：
我们的主干是固定的四步（复制、入库、挑选、粘贴）跨两个进程，隐私承诺需要一个
不可被插件绕过的特权核心，第三方插件又恰好能看到每一条复制过的密钥。所以不做
「没有特权核心」，做一小组有名字、有派发模式的事件，加一种外部形态的 hook。

**特权层先于一切事件。** 密码管理器与 Concealed/Transient 排除、密码框短路、唯一
出网层与离线开关、历史加密，都在任何事件触发之前执行；没有事件能关掉它们；hook
只看到已被允许的内容。这是与 harness 刻意不同的一点。

**事件表**（派发模式决定 hook 能做什么）：

| 事件 | 模式 | 触发方 | hook 可以 |
|---|---|---|---|
| `clipboard/admit` | bail | 壳的轮询器，经 daemon | 否决入库，或返回脱敏后的文本 |
| `clipboard/stored` | emit | daemon | 只观察 |
| `pick/candidates` | waterfall | daemon，挑选之前 | 过滤、重排候选 |
| `paste/before` | waterfall | 壳在合成 ⌘V 之前，与挑选同一次往返 | 改写将要粘贴的文本 |
| `paste/after` | emit | 壳 | 只观察 |
| `action/result` | waterfall | daemon | 后处理动作输出 |

**第一种外部形态：命令式 hook**，`<appData>/hooks.json`。每条声明事件名、匹配
条件（应用 bundle id、文本正则）、一条命令、超时。事件 JSON 从 stdin 进、结果从
stdout 出；退出码 2 是否决并带原因；其他非零视为失败不阻断，只记日志。规则参照
harness 的 `hook-protocol`（匹配、执行、超时、结果合并、失败不阻断）。语言无关，
进程隔离，与「动作是 JSON 声明」一致，社区可贡献。示例用途：从终端复制的东西像
token 就不入库；粘贴到 Slack 时 Markdown 转 mrkdwn；粘贴 URL 时去掉 utm 参数。

**预算。** `clipboard/admit` 总预算 200 ms，超时按「入库」处理，一个慢 hook 不能
丢内容；`paste/before` 发生在用户确认之后，不影响面板一百毫秒弹出的目标；只观察
的事件异步跑。

**加载。** hook 与动作一样由 daemon 加载，注册带 disposer，`hooks.reload` 与
`actions.reload` 同一套；动作包、风格包按 id 插入，用户按 id 覆盖（借它的
bundle/patch 模式），订阅解锁的官方包与用户定义叠得清楚。

**不做。** 进程内代码插件（daemon 加载第三方 JS）推后：Bun 没有可靠隔离，若做，
走与官方包相同的信任路径（签名、声明权限、与订阅体系绑定）。

- 验收：六个事件各有测试；`hooks.json` 三个示例各跑通；超时与否决语义有测试；
  隐私审计清单新增「hook 看不到被排除的内容」一项；`docs/hooks.md`。
- 本阶段未开始；原生迁移不实现 hooks，后续重新评估接口和规模。

## 5. 已定的决策

- 剪贴板是日常入口；图片、GIF、视频生成是核心能力，不是附加功能。（2026-09-22 用户更新）
- 决策模型与生成模型分轨，每轨都支持自带 key、自部署端点、托管。（2026-09-22 用户）
- 隐私是硬约束：本地优先、出网显式可审计、历史加密、密码类默认排除。（2026-09-22 用户）
- 挑选第一版是预选加确认，不自动粘贴。
- SwiftUI + AppKit 是唯一桌面层；已移除 Tauri 与界面 WebView，不引入 Electron。
- 保留 TypeScript/Bun Core 与 Pocket Motion，作为长期架构，不以全部 Swift 为后续目标。
- Core 按需启动、任务间复用、无活动任务时空闲退出；桌面层负责系统集成与存储。
- 开源版与订阅版同一二进制；Pocket Motion 独立维护，本仓库钉 commit，不直接修改引擎 checkout。
- 开源核心算法与所有格式；订阅解锁托管调用与官方风格包、动作包。
- PNG/GIF 路径不依赖 ffmpeg；视频动作已启用并使用本机 ffmpeg，应用不内嵌或自动
  安装编码器。N4 仍需完成正式编码器分发决策与完整交付验收。
- 先执行 N1–N5；M8 的部署与计费待办仍单独处理，M9 hooks 不自动启动。
- 扩展性借 deepseek-harness 的思想不借框架：命名事件加派发模式、命令式 hook、
  可撤销注册；特权核心保留，隐私层先于一切事件。（2026-09-22 用户）
- 免费本地首跑：decider 默认 `rules`；Laya 作为本地模型选项保留，不内置。（2026-09-22 用户）
- 最低 macOS 由 12.0 提高到 13.0：随包的 Bun 二进制 minos 为 13.0，12 上无法运行 Core；
  同时可直接使用 SMAppService 实现登录项。（2026-09-23）

## 6. 风险与退路

| 风险 | 表现 | 退路 |
|---|---|---|
| Chromium 网页拿不到上下文 | 浏览器里只有 L0/L1 | 按级别退化，浏览器里以应用与站点亲和排序 |
| 粘贴模拟被应用拦截 | 合成 ⌘V 无效 | 面板里提供"仅复制到剪贴板"并提示手动粘贴 |
| 挑选命中率不够 | 探测表低于可用线 | 保留历史面板与最近优先，挑选降为排序提示 |
| 隐私事故 | 内容意外出网 | 唯一出网层加离线开关，日志可核，默认本地 |
| Jev 不在 REST 端点 | M3 探测 404 | 自部署 proxy/ 作为默认路径 |
| Core 与渲染内存 | Bun、WASM、字体与全帧 GIF 缓存 | 按需启动、任务完成后空闲退出、限制帧缓存；测量整个进程树 |
| 长渲染阻塞请求 | 当前 daemon 串行处理 | 隔离渲染工作；同一引擎构建串行，取消不能只隐藏 UI |
| 旧数据或授权失效 | 数据、Keychain 或 TCC 身份变化 | 保持标识与格式，副本验收；读取失败进入锁定态，不清库 |
| 原生更新链路缺失 | 首个原生版本发布后无法自动推送修复 | 旧桌面从未发布，无需桥接；N5 在首发前选定并验证原生更新方案（建议 Sparkle） |
| hook 拖慢或丢内容 | 慢 hook 卡住入库或粘贴 | 入库 200 ms 预算超时即存；粘贴改写只在确认后；失败不阻断 |

## 7. 用户待办

0. （已完成 2026-09-22）Cloudflare 直连 Jev 已用真实 token 验证：Workers AI 的 REST
   路由是 `POST /accounts/<id>/ai/run` 带 `{model, input}`，返回的 `result` 是
   `{state: "Completed", result: {answers}}`，两处都已改；热调用 700–800 ms，四类
   样本 kind 全对。token 放在仓库根的 `.env`（`PASTE_CF_TOKEN`、`PASTE_CF_ACCOUNT_ID`，
   已 gitignore，Bun 自动加载），跑 `PASTE_PROVIDER=cloudflare bun run paste …` 即可。
1. （已完成 2026-09-22）引擎分支栈已重放到公开的 anelikes/pocket-motion：
   v0.2.0 = 补丁 0013 到 0015，v0.2.1 = fileURLToPath 修复；engine.json 钉 v0.2.1，
   CI 无需任何凭证。qianiaoo/pocketjs-motion 只作归档，之后的引擎迭代都在公开
   仓库。`~/.pocket-paste/engine` 的绕行还在，等 v0.2.1 随包发布后再拆。
2. N5 签名：Developer ID Application 证书只能由团队的 Account Holder 创建；用户本机
   生成 CSR 交给 Account Holder 签发，再导出 .p12。随后按 docs/RELEASING.md
   「Signing & notarization」提供 notarytool 凭证与 CI secrets。
3. 更新方案决策：原生版需选定更新机制（建议 Sparkle，EdDSA 签名的 appcast）。
   同时决定是否删除已不再使用的 `TAURI_SIGNING_PRIVATE_KEY` 仓库 secret 与本机
   `~/.tauri` 密钥：从未发布过任何版本，没有安装依赖它，删除无兼容影响。
4. DMG 与 Homebrew cask 是 N5 工作，由 agent 在签名可用后完成；用户只需审阅发布。
5. M8（不变）：Cloudflare 部署与域名（peesuto.com，托管默认 api.peesuto.com）、计费平台、
   条款审阅。对外产品名 Peesuto，内部名与路径仍是 pocket-paste。
