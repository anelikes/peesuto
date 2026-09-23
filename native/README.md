# Peesuto 原生 macOS 桌面层

这里是 SwiftUI + AppKit 原生版的第一阶段实现。应用界面不使用 Tauri、WebView 或
Electron；业务处理继续调用仓库内的 Bun Core，图片、GIF 和视频继续由 Pocket Motion
渲染链路生成。旧桌面源码与专用构建依赖已删除，本目录是唯一桌面应用入口。

本目录提供可构建的原生应用，不代表 [迁移计划](../docs/native-migration.md) N1–N5
全部完成，也不代表所有真实应用、显示器、输入法和权限场景已经验收。

## 构建真实应用

在仓库根目录执行。需要 macOS、Swift 5.9 或更新的构建工具、Bun，以及已完成
vendor、WASM、字体等资源准备的 Pocket Motion checkout。checkout 的 HEAD 必须与
[`engine.json`](../engine.json) 中的 SHA 一致；脚本检查版本，不会替你切换引擎源码。

```sh
bun install
bun scripts/build-native.ts --engine /absolute/path/to/prepared-pocket-motion
open native/dist/Peesuto.app
```

构建脚本执行 Swift release 构建，打包 Bun、Core、引擎和资源，并进行本地 ad-hoc
签名与签名结构检查。输出为 `native/dist/Peesuto.app`，目标架构为当前构建机器的
架构，最低系统版本为 macOS 13.0（与打包的 Bun 一致）。尚未提供通用二进制、Developer ID 签名、
公证或安装盘发布链路。

首次成功打包后，只修改 Swift 桌面代码时可以复用暂存资源：

```sh
bun scripts/build-native.ts --skip-resources
```

`--skip-resources` 复用 `native/.bundle/` 中现有的 Bun、Core 和引擎资源；它不会
重新收集 Core 代码或重新验证引擎版本。修改 Core、引擎版本或资源后，应重新运行
带 `--engine` 的完整构建，避免打开包含旧业务代码的应用。

直接运行 `swift build --package-path native` 只构建 Swift 可执行文件，不生成含
完整资源的 `.app`，不能代替上述打包步骤。

## 隔离预览

```sh
bun scripts/build-native.ts --engine /absolute/path/to/prepared-pocket-motion --preview
open "native/dist/Peesuto Preview.app"
```

已有暂存资源时：

```sh
bun scripts/build-native.ts --preview --skip-resources
```

预览应用使用 `com.peesuto.desktop.preview` 标识，在系统临时目录中创建
`peesuto-native-preview-<进程号>`，包含合成历史和独立测试密钥。它不会读取正式
历史、访问用户 Keychain、监听剪贴板、捕获其他应用的输入上下文或注册全局快捷键。
它仍使用真实打包的 Core 和 Pocket Motion，可检查图片/GIF/视频动作及原生预览。
预览模式的菜单栏直接动作禁用；快捷键设置可录入和校验，但不注册系统快捷键。

预览中的“复制”和“粘贴”是显式操作，仍可能写入系统剪贴板；“导出”会将结果保存
到选择的位置。隔离的是后台采集、历史与凭据，不是这些用户主动触发的输出操作。
预览目录和渲染输出会保留在临时目录中便于检查；下次启动预览时，已退出的预览进程留下的目录会被清理。

## 正式数据兼容

普通构建沿用 `com.peesuto.desktop` 标识及
`~/Library/Application Support/com.peesuto.desktop/`。启动时如果发现同一标识的
另一个 Peesuto 进程，会提示退出其他版本并终止本次启动；应先退出旧版，再启动
原生版。

- 历史沿用 `history.sqlite` 的表结构；文本和预览使用 AES-256-GCM，格式为
  12 字节 nonce、密文和 16 字节认证标签。
- 图片沿用 `images/<id>.bin` 和 `<id>.thumb.bin`，文件内容加密。
- 历史密钥仍在 Keychain service `com.peesuto.desktop` 的
  `pocket-paste/history-key` 项中，以 Base64 保存。
- `settings.json` 和 `providers.json` 沿用现有字段。修改设置保留未编辑的字段；
  切换 provider 类型时清理旧类型的配置。
- 凭据只保存在 Keychain，通过内存中的 `config.set` 交给 Core；不会写入
  `providers.json`。只读取各 provider 对应的标准凭据账户。
- 缺失或不匹配的历史密钥会使历史不可用，不会自动生成替代密钥覆盖已有数据。

正式启动会执行现有保留期限规则并在捕获剪贴板时写入历史。保留应用标识不保证
本地重新签名后的 Keychain 或辅助功能授权自动继承。

## 已实现的路径

- 原生菜单栏入口、可搜索历史列表、置顶/删除和同面板内容预览。
- 单独显示推荐项，推荐结果不替换当前选择；键盘选择、复制、粘贴及返回结果视图。
- 文本、图片和文件剪贴板记录；排除应用、敏感/临时剪贴板类型过滤、记录暂停。
- 全局打开快捷键、前台应用与可用的辅助功能上下文、焦点恢复和粘贴；缺少辅助功能
  权限时可使用复制。
- 原生 PNG/GIF/MP4 结果预览、复制/粘贴及导出。MP4 使用 AVPlayerView；翻译、摘要等动作使用已有 Core/provider。
- 8 类 × 2 变种的媒体模板：文档、引用、代码、数据、列表、对话、表格、对比。原文
  本地解析，Jev 受限选择模板/变种/动效；结果视图可换风格和输出格式，详见
  [模板说明](../docs/templates.md)。其余 4 类尚未实现。
- 独立的快捷键设置：按键录入、清除停用、重复/占用检测、失败保留原绑定。
- 中文、英文、跟随系统；通用、快捷键、AI 与动作、历史与隐私设置。
- 加密历史、缩略图、去重、保留期限、Keychain 和 provider 设置兼容层。
- JSON lines Core 客户端、超时与错误处理、进程重启后的配置恢复，以及负责进程组
  的 `PeesutoCoreHost`，便于退出时清理 Core 和渲染子进程。
- 任务 accepted/running/completed/failed 状态；运行期间不计入空闲退出时间。

## 直接粘贴为媒体

普通原生版默认绑定：`⌘⇧V` 打开面板，`⌘⌥1` 图片，`⌘⌥2` GIF，`⌘⌥3` 视频。
在「设置 → 快捷键」点击对应按钮后按键录入，保存生效；清除即可停用。
如果系统注册冲突，设置保留旧绑定并报错；首次启动冲突会提示并尝试保留面板快捷键。

先复制文字，再在目标输入框按快捷键。应用读取当前剪贴板快照，显示非抢焦点的状态
浮窗，直接生成结果，无需选择历史。目标应用、窗口、输入框、选区和内容都未改变且
辅助功能可用时自动粘贴；无法验证目标时只复制结果。期间复制了新内容则保留新剪贴板，
可从浮窗「查看结果」手动处理。不支持该媒体类型的目标应用仍可能拒绝粘贴。

视频需要本机已安装 ffmpeg（例如 `brew install ffmpeg`）。依次使用显式路径配置、
`PEESUTO_FFMPEG_PATH`、PATH、macOS 的 `/opt/homebrew/bin/ffmpeg` 和
`/usr/local/bin/ffmpeg`；当前安装包不内嵌或自动安装 ffmpeg。缺失时在调用模型和渲染前
报错，PNG/GIF 不依赖它。输出使用唯一文件名，后续生成不会覆盖已复制的文件。

## 尚未完成

- 账户、订阅与扩展包管理界面；已有 Core 扩展能力不等于原生管理界面已经迁完。
- 动作编辑器、自定义动作的快捷键，以及原迁移计划中的其他高级设置。
- 自动更新、正式签名、公证与正式分发。CI 已改为原生构建；手动构建工作流仅输出
  本地 ad-hoc 签名的验证包，不创建 Release 或更新元数据。
- 视频编码器独立分发及目标应用粘贴兼容验收。
- 渲染细分进度、精细取消和独立渲染调度。已有有限生命周期事件；取消仍终止整个
  Core，耗时渲染仍占用串行处理队列。
- 完整的真实环境验收，包括多屏、全屏、中文输入法、权限拒绝/恢复、目标应用粘贴
  兼容，以及启动、常驻内存和渲染峰值测量。

## 测试与打包冒烟

```sh
swift test --package-path native
```

测试使用合成数据库、固定测试密钥和隔离的测试对象，覆盖既有存储格式、错误密钥
保护、文件/图片历史、配置保留、凭据引用限制和系统集成辅助逻辑。测试通过不能替代
真实应用的窗口、权限与粘贴检查。

构建完整 `.app` 后运行：

```sh
native/.build/release/PeesutoSmoke native/dist/Peesuto.app
# 已安装 ffmpeg 时连同 MP4 验证：
native/.build/release/PeesutoSmoke native/dist/Peesuto.app --video
```

也可以将路径改为 `"native/dist/Peesuto Preview.app"`。冒烟程序使用临时目录、
合成文本和固定测试密钥，以离线本地规则配置启动应用内打包的 Core，检查健康状态、
动作列表，并实际生成 PNG 和 GIF 文件；`--video` 还生成 MP4，用 AVFoundation 验证
视频可播放、含视频轨道且时长大于零。它不读取正式历史或用户 Keychain，不调用
付费模型服务。成功时输出 `PASS` 和临时输出路径；结果保留供检查。

冒烟检查验证图片可解码、GIF 多帧及可选视频可播放，不等同于视觉质量、真实粘贴或完整
迁移验收已经通过。每次实际验收结果应另行记录，不从构建成功推断。

## 代码位置

| 目录 | 职责 |
|---|---|
| `Sources/Peesuto/` | SwiftUI 面板/设置、AppKit 窗口与应用状态 |
| `Sources/PeesutoKit/` | 存储、设置、Keychain、系统集成和 Core 通信 |
| `Sources/PeesutoCoreHost/` | Core 启动与进程组 |
| `Sources/PeesutoSmoke/` | 完整 bundle 的隔离冒烟检查 |
| `Tests/PeesutoKitTests/` | 原生模块测试 |
| `Resources/` | 应用图标与 Bun 的本地签名权限配置 |
| `../scripts/build-native.ts` | Swift 构建、资源打包与 `.app` 组装 |

架构边界与后续验收以 [迁移方案](../docs/native-migration.md) 和
[PLAN.md](../PLAN.md) 为准。
