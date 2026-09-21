# pocket-paste v1 实现计划

2026-09-22 定稿。技术验证已完成（见 git 历史与 README），本计划把它推到 v1：
一个可分发的 macOS 菜单栏应用，完整开源，开源版用户自带 API key，
商业版提供订阅制的托管服务。设计系统搁置，不在 v1 范围。

## 0. v1 的定义

v1 完成的判据是下面每一条都成立，缺一条就不是 v1：

1. **开源 CLI 可用。** 克隆仓库，`bun install && bun run setup`，不需要 wrangler，
   配置 Cloudflare 的 account ID 与 API token 后 `paste "文本"` 出图；不配置时
   仍出一张素卡（kind=plain，默认版式）。
2. **macOS 应用可装可用。** 一个 DMG；首次启动引导设置快捷键与提供方；在任何
   应用里复制文字，按快捷键，粘贴得到 PNG 卡片；有顺序的内容得到 GIF。
   预览窗可切画幅、换一版、保存、拖出。
3. **托管模式代码就绪。** 应用里输入订阅凭证即可不配置 Cloudflare 使用；
   托管代理带鉴权、计量、限流、输入上限，不记录文本。部署与计费账号是用户动作。
4. **输入长尾有基线。** 100 条真实剪贴板样本全部渲染，引擎 `verify` 零 finding，
   或者是一条被明确拒绝并给出原因的样本。
5. **CI 绿。** 单元测试与样本渲染在 macOS runner 上跑通；打包工作流能产出未签名
   的应用；签名与公证接入用户提供的证书后即生效。

## 1. 架构

三层，边界与现有代码一一对应：

| 层 | 技术 | 职责 | 对应今天的代码 |
|---|---|---|---|
| 壳 | Tauri 2，Rust | 托盘、全局快捷键、剪贴板、窗口、自动更新、Keychain | 无 |
| 界面 | HTML + TypeScript，跑在 WKWebView | 预览、设置、引导 | 无 |
| 渲染链 | Bun + 引擎（wasm 光栅器 + JS 编译器 + 字体） | 文本 → Jev → DSL → composition → PNG/GIF | run.ts、paste/gen.ts、paste/emoji.ts |

渲染链作为 sidecar 随应用分发：一份 Bun 可执行文件加一棵只读资源树（引擎源码子集、
vendored 编译器、pocketjs.wasm、字体）。运行时在 Application Support 下建一棵可写
的工作树（符号链接指向资源，compositions/paste 与 dist 为真实目录），和今天的
`.work/tree` 是同一个办法。引擎的 build 记录要求构建与启动的 Bun 版本一致，随包
分发同一份 Bun 恰好满足它。

**决策提供方**是一个接口，三种实现，开源版与订阅版是同一个二进制，只差这项设置：

| Provider | 凭证 | 去向 |
|---|---|---|
| `cloudflare` | 用户自己的 account ID + API token | Workers AI REST 端点 `typesafe/jev` |
| `hosted` | 订阅凭证 | 我们部署的代理 worker |
| `none` | 无 | 不问 Jev，kind=plain，默认版式 |

Jev 的答案按文本哈希缓存，同一段文本再次粘贴得到同一张卡；"换一版"是显式操作。

## 2. 仓库布局

```
pocket-paste/
  PLAN.md               本文件（中文，内部）
  README.md             英文
  LICENSE               MIT，与引擎一致
  package.json          bun 脚本入口
  engine.json           引擎的 repo + ref + sha，scripts/engine.ts 按它取回
  engine/               引擎 checkout（gitignore；POCKET_ENGINE 可指向别处）
  core/                 渲染链，TypeScript，跑在 Bun
    src/cli.ts          paste：文本进、图片出（用户直接用，也是 sidecar 入口）
    src/questions.ts    Jev 的七个问题 + 答案 → DSL（纯函数）
    src/dsl.ts          DSL 类型与校验
    src/provider/       cloudflare | hosted | none + 答案缓存
    src/render/         工作树、composition 生成、emoji、引擎驱动、GIF 编码
    tests/              单元测试 + 夹具渲染
    fixtures/           job-*.json 与语料
  app/                  Tauri 2 应用
    src-tauri/          Rust 壳
    src/                界面
  proxy/                Cloudflare worker：dev 模式（wrangler dev）与 hosted 模式
  scripts/              engine.ts、bundle-sidecar.ts、fetch-emoji.ts
```

## 3. 里程碑

每个里程碑列出目标、任务、验收，以及哪些事只有用户能做。顺序按风险排：
最不确定的最先做。

### M1 引擎成为依赖，仓库成形

目标：pocket-paste 不再依赖旁边恰好存在的 checkout，不再把文件复制进引擎目录。

- `engine.json` 钉住引擎的 repo、ref、sha；`scripts/engine.ts` 取回、`bun install`、
  `bun run vendor`、`bun scripts/assets.ts`，或在 `POCKET_ENGINE` 指向现有 checkout
  时直接校验。今天钉的是私有仓库 `feat/transparent-clear` 的 `ca3c076`，因为补丁
  0014（透明）与 0015（仅度量缓存）还没进公开的 `anelikes/pocket-motion`（v0.1.0
  只到补丁 0012）。
- 代码迁入 `core/`，拆成纯函数与副作用两半：问题与答案映射、DSL 校验、emoji 切分
  是纯函数，可以不带引擎测试；工作树、生成、构建、出帧是引擎驱动。
- 生成器改为在工作树里生成 composition，通过绝对路径动态 import 引擎的
  `src/text/fit.ts` 与 `src/text/measure.ts`。
- `package.json`、锁文件、`bun test`；GitHub Actions 跑单元测试，并在 macOS runner
  上取回引擎、渲染五个夹具、比对 digest。
- 验收：五个夹具的 PNG 与迁移前逐字节一致（迁移前先录一次 sha256 作为基线）。

用户动作：合并引擎分支栈（rename-card → keyframe-lints → transparent-clear），
发布到公开仓库并打 tag；之后 `engine.json` 改指公开 tag。这一步不阻塞 M1 到 M6。

### M2 打包 spike：sidecar 脱离仓库运行

目标：证明渲染链能作为随包资源在没有仓库、PATH 上没有 bun 的机器上跑起来。
这是整个计划里唯一可能推翻架构的一步，所以在 GUI 之前做。

- `scripts/bundle-sidecar.ts` 产出 `app/src-tauri/sidecar/`：当前运行的 bun 二进制
  的副本（版本与构建记录一致）+ `resources/engine/`（`src/`、`vendor/pocketjs/`
  的 tools、framework、contracts、hosts/web、tests/png.ts，`node_modules` 只保留
  编译器实际 import 的包，`assets/fonts`）+ `resources/core/`。
- 运行时把 sidecar 目录加进 PATH 再启动引擎，因为引擎用 `Bun.spawn(["bun", …])`
  从 PATH 找 bun。这样不需要改引擎；改引擎为 `process.execPath` 是给上游的建议。
- 工作树建在 `~/Library/Application Support/pocket-paste/work/`；仅度量缓存落在
  工作树的 `dist/.measure/`，随版本失效。
- GIF 改为进程内编码：直接从引擎的帧源拿 RGBA，用 `gifenc` 量化与编码，去掉
  ffmpeg 依赖。同时 PNG 路径不变。
- emoji：量 Noto Emoji 128 px 全集的总大小，20 MB 以内就整套随包，否则随包常用
  子集并保留联网缓存，离线失败要给明确提示。
- 验收：把 sidecar 目录拷到一个临时目录，清空 PATH 里的 bun，`paste` 出图；记录
  冷启动与热启动耗时。

### M3 决策层

目标：三种 Provider 与答案缓存，开源版的 BYO key 路径真实跑通。

- `provider/cloudflare.ts`：REST 调用，超时 5 s，一次重试；探测调用验证凭证；
  错误分类（凭证无效、模型不可用、网络）。
- `provider/hosted.ts`：同一请求体加订阅凭证，指向代理。
- `provider/none.ts`：不调用，返回素卡答案。
- `cache.ts`：按 `sha256(text)` 缓存答案，落 App Support；"换一版"绕过缓存。
- 输入上限（先定 2000 字），超出直接拒绝并说明。
- 验收：用真实 Cloudflare 凭证跑六段样本；凭证错误时错误信息可读；`none` 模式
  五个夹具全部出图。

前置假设要第一时间验证：`typesafe/jev` 能从 Workers AI 的 REST 端点调到，而不只
是 Worker 绑定。

### M4 GUI v1

目标：菜单栏应用把渲染链变成"复制，按键，粘贴"。

- Tauri 2 脚手架，插件：global-shortcut、clipboard-manager、shell（sidecar）、
  updater、positioner、autostart、store；API token 用 Keychain。
- 流程：快捷键 → 读剪贴板文本 → 起 sidecar → PNG/GIF 回写剪贴板 → 预览窗从托盘
  弹出。
- 预览窗：图片、画幅三选一、换一版、保存、拖出、错误态（文本过长、凭证无效、
  离线、放不下）。
- 设置：Provider 与凭证、快捷键、默认画幅、开机自启、输出目录。
- 首次运行引导：辅助功能权限、Provider 选择、试一次。
- 验收：从 DMG 安装后走完引导，六段样本各粘贴一次；应用常驻内存与安装包体积
  记录进 README。

### M5 输入长尾

目标：产品面对真实剪贴板不崩。

- 语料 100 条，来源：聊天、文档、代码、日志、URL、带 emoji、纯英文、繁体、混排、
  超长。放 `core/fixtures/corpus/`。
- 自动化：每条渲染，跑引擎 `verify`，结果写成一张对照表。
- 策略：整条阶梯放不下时按段落截断并加省略号；超长代码行按字号阶梯下探到底后
  截断；非中英文脚本明确拒绝；引用归属的正则改为只匹配行尾；stat 取"最大或带
  单位"的数字而不是第一个；强调词只上色首次出现。
- 验收：v1 定义第 4 条。

### M6 发布工程

目标：能持续出版本。

- LICENSE（MIT）、CONTRIBUTING、SECURITY、issue 模板；README 说明剪贴板内容会
  离开本机去到 Jev，以及三种 Provider 各自去向。
- GitHub Actions：测试、样本渲染、`tauri build` 产未签名 DMG；签名与公证在用户
  提供 Apple 证书与 App Store Connect API key 后启用。
- Tauri updater 的公钥进仓库，私钥在用户手里。
- Homebrew cask 公式。
- 验收：一次 tag 触发的工作流产出可下载的 DMG。

用户动作：Apple Developer 账号、证书、Notarization 凭证；updater 签名密钥。

### M7 订阅层

目标：托管代理与应用内授权就绪，可部署。

- `proxy/`：一个 worker 两种模式。dev 模式无鉴权只监听本地；hosted 模式要求
  Bearer 凭证，KV 计量按月配额，限流，输入上限，不写日志正文。
- 凭证形态：许可证密钥（离线可校验的签名串），应用登录时向代理换取短期 token，
  本地缓存并给 7 天宽限。
- 计费：merchant of record（Paddle 或 LemonSqueezy）的 webhook 写入 KV 里的
  订阅状态；代理只读状态。
- 官网与文档一页，隐私政策与条款。
- 验收：本地 `wrangler dev` 下走完签发、调用、配额耗尽、过期四条路径。

用户动作：Cloudflare 上部署、绑定域名；计费平台开户；条款审阅。

### 之后（不在 v1）

Windows；iOS 分享扩展与 Web 走云渲染；设计系统与风格库作为付费差异化。

## 4. 已定的决策

- 壳用 Tauri 2，不用 Electron 或 Swift。理由：体积、跨平台、Rust 与引擎同源。
- 开源版与订阅版同一个二进制，差别只在 Provider 设置。
- 订阅先卖"免配置"，风格库作为第二个付费理由排在 v1 之后。
- 引擎的分支由用户合并；pocket-paste 只钉引擎的某个 commit，从不写引擎目录。
- Jev 的不确定性用缓存解决，不用阈值硬编码之外的规则。
- ffmpeg 不随包，GIF 进程内编码。

## 5. 风险与退路

| 风险 | 表现 | 退路 |
|---|---|---|
| sidecar 脱离仓库跑不起来 | M2 验收失败 | 云渲染：core 部署为服务，应用只做壳；开源版随之需要自托管渲染服务 |
| Jev 不在 REST 端点 | M3 探测 404 | 开源版改为用户自部署代理 worker（今天的做法），文档化 `wrangler deploy` |
| Bun 二进制体积 | 安装包 40 MB 以上 | 接受；或 `bun build --compile` 加 `BUN_BE_BUN` 复用同一二进制做子进程 |
| 编译器有原生依赖 | node_modules 子集含 .node | 已查：字体烘焙用 opentype.js，纯 JS；@napi-rs/canvas 只在无关工具里 |
| 全局快捷键权限 | 用户不开辅助功能 | 引导页 + 托盘菜单里的手动触发按钮 |

## 6. 用户待办

按需要的时间点排：

1. M1 期间或之后：合并引擎分支栈，公开仓库打 tag。
2. M6：Apple Developer 账号、Developer ID 证书、Notarization API key、updater 密钥。
3. M7：Cloudflare 部署与域名、计费平台开户、条款与隐私政策审阅。
