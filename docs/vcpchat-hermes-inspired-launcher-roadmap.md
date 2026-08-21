# VCPChat 托管启动器：Hermes Agent 对照研究与路线

## 目的

VCPChat 保留现有 `npm start`、BAT、VBS 和桌面入口不变，新增一个独立的托管启动器，解决“依赖未安装、Node/Electron/native 模块不匹配、打包资源不完整、更新中断后无法恢复”等易用性问题。

目标不是复制 Hermes Agent 的 Python/TypeScript 技术栈，而是借鉴它的启动边界、所有权和恢复策略。

## 研究来源

本机研究目录：`/Users/asahi/Documents/Codex/hermes-agent`。

参考的关键实现包括：

- `apps/bootstrap-installer/src-tauri/src/bootstrap.rs`：独立安装器、阶段化执行、取消、状态查询和启动已安装桌面程序。
- `apps/bootstrap-installer/src-tauri/src/update.rs`：更新锁、旧进程退出等待、跨平台 handoff、失败状态回传。
- `apps/desktop/electron/first-run-setup-gate.ts`：首次运行决策门、并发调用合并、超时提示、重试和显式 reset。
- `apps/desktop/electron/updater-process.ts`：Windows/Unix 分开处理更新进程、过滤 Electron 内部参数、旧版本兼容 handoff。
- `README.md` 的 Quick Install / `hermes setup` / `hermes doctor` / `hermes update` 流程：安装、配置、诊断和更新对用户表现为连续且可解释的产品体验。

当前下载受 GitHub 限速影响，目录是源码快照而非完整 Git 历史；研究结论只基于已取得的安装器、更新器、启动门和文档实现，后续网络恢复后再补齐完整 clone 与版本 pin。

## Hermes 的可迁移经验

### 1. 安装根目录与源码目录分离

Hermes 将受管运行时、虚拟环境、缓存、日志和版本目录放在独立的用户目录（Linux/macOS 为 `~/.hermes`，Windows 为 `%LOCALAPPDATA%\\hermes`），不会把修复产生的文件写入只读源码或应用包。

VCPChat 应保持：

- 项目目录只作为开发源；
- `AppData`、日志、锁、版本 staging 和诊断证据进入用户数据根目录；
- ASAR 内只读资源不能作为运行时写入目标。

### 2. 安装器不是应用本身

Hermes 使用独立 Bootstrap Installer 执行安装/修复，完成后再 detached 启动桌面应用并退出安装器。这样更新时不会让正在运行的应用覆盖自己的文件。

VCPChat 的新入口也必须是独立进程；不得让 `main.js` 自己重写当前应用包，也不得改变原有启动脚本。

### 3. 阶段化进度和可取消

Hermes 的安装器先取得 manifest，再逐阶段执行，每个阶段报告状态、日志和失败原因，并允许取消。VCPChat 已有 M4 progress protocol，后续 UI 必须直接消费该协议，不再用不可解释的“加载中”动画。

### 4. 首次运行决策门

Hermes 的 `first-run-setup-gate` 将“本地初始化、远程配置、重试、放弃”建模为一次可恢复决策；重复调用返回同一个 waiter，不会产生多个并发 bootstrap。

VCPChat 应将首次运行建模为：

```text
diagnose → ready
         ↘ repair-required → user-consent → repairing → ready
         ↘ blocked         → recovery UI / export evidence
```

### 5. 更新前退出旧进程

Hermes 更新流程先等待旧桌面进程退出，再执行仓库更新和桌面重建；同时用跨进程 marker 防止两个 updater 并发改写同一工作树。

VCPChat 已有 update lock、版本指针和 rollback 基础，但生产更新仍缺签名下载和完整迁移事务，不能提前宣称完成。

### 6. 平台 handoff 是产品逻辑的一部分

Hermes 对 Windows PowerShell、macOS LaunchServices、Linux shell 分别处理 detached 启动；还过滤 Electron/Chromium 内部参数，避免更新重启时把旧 renderer 参数带入新进程。

VCPChat 后续必须为 macOS、Windows、Linux 保持独立的进程启动/终止适配层，不能只在 macOS 上验证后假设其他平台等价。

## VCPChat 当前状态

已完成的底层能力：

- M0：启动协议、状态根目录和 operation lock。
- M1：只读环境 doctor。
- M2：独立托管开发启动和 ready handshake。
- M3：显式 repair planner、npm/native 修复计划和取消语义。
- M4：阶段进度协议、诊断输出和 secret redaction。
- M5：runtime closure、ASAR/原生模块审计和打包 smoke 基础。
- M6：独立 recovery UI 与失败证据。
- M7：本地 trusted staging、current 指针、健康检查和 rollback。
- M8：发布证据矩阵与外部平台证据缺口记录。

当前 `start:managed` 主要执行 M1 + M2，即“诊断后托管启动”。`npm run vcpchat` 已接通 H1 CLI 状态机；`npm run vcpchat:ui` 和源码树中的双击入口打开独立的准备/恢复 UI。它仍不是 Hermes 的完整图形安装器：尚未由签名安装器创建跨平台快捷方式，也不能在完全没有 Node/Electron 的机器上自举。

H1 同时加入了按项目路径隔离的 state root、完成 marker、深度 Doctor 快路径和 SIGINT/SIGTERM 修复取消。marker 只代表当前 package/package-lock、Node 主版本、Electron 版本和平台架构组合已通过本机 Doctor，不代表跨平台安装包已验证。

## 分阶段开发路线

### H0：完成源码研究与基线固定

- 补齐 Hermes 完整源码 clone，记录 commit pin、许可证和研究日期。
- 保存安装器、first-run gate、update marker、平台 handoff 的行为摘要。
- 为 VCPChat 建立启动器状态图和错误码表。

验收：研究文档可由源码路径逐条复核，不引用无法验证的宣传语。

### H1：统一托管入口（Hermes-like one command）

新增独立命令，例如：

```bash
npm run vcpchat
```

行为：

1. 读取运行状态并获取 operation lock；
2. 执行 doctor；
3. 没有阻塞项时直接启动 Electron；
4. 有可修复问题时显示修复计划、影响范围和预计步骤；
5. 用户确认后执行 repair；
6. repair 完成后重新 doctor，再启动应用。

不得让 `npm start` 自动进入这条路径。

### H2：独立启动器 UI

- 展示当前阶段、实时日志、取消、重试和打开诊断目录。
- 启动器窗口关闭时取消当前操作或转入后台，而不是遗留 orphan process。
- 所有 terminal state 都能恢复显示，renderer reload 不会重新启动第二个 repair。
- 失败页面提供“复制诊断”“重新检查”“打开恢复界面”，不直接吞掉错误。

### H3：环境修复闭环

- npm lock/package identity 校验后才允许 `npm ci`。
- native rebuild、可选 Rust/vendor 修复保持显式 opt-in。
- 下载的工具链必须落在受管目录，记录版本、来源和 hash。
- 修复前后生成 evidence，失败时保留可复现命令但不泄漏 API key。

### H4：跨平台进程与路径适配

- macOS 使用 LaunchServices/正确 app bundle 启动。
- Windows 使用 PowerShell/cmd handoff、`taskkill /T` 和长路径/中文路径测试。
- Linux 使用 detached shell、AppImage 冷启动和信号转发。
- 所有平台都过滤 Electron 内部参数，区分用户参数和运行时参数。

### H5：更新与回滚产品化

- 更新前请求旧主进程优雅退出，并设置有界等待。
- 增加签名/证书验证、下载临时目录、断点续传和磁盘空间预检。
- 版本切换采用 staged → verify → current pointer → health check → rollback。
- 用户数据 migration 必须单独事务化，不能和应用代码覆盖混为一体。

### H6：可观测性和自动化验证

- 将启动流程纳入操作序列测试：首次启动、修复中关闭、renderer reload、重复启动、更新中退出、失败回滚。
- 每个序列结束检查 lock、scope、IPC task、process tree、临时目录和活动 DOM。
- CI 覆盖 macOS、Windows、Linux；本机未验证的平台必须在证据中标记为 pending。
- 增加 30–60 分钟人工 soak 和磁盘/网络/睡眠恢复场景。

## 明确不做的事情

- 不修改现有启动脚本的默认行为。
- 不把 Hermes 的 Python/uv/Node 工具链直接引入 VCPChat。
- 不让启动器接管插件 Loader、动态壁纸或用户数据格式。
- 不在没有签名和跨平台证据时宣称“生产级自动更新已完成”。

## 当前下一步

2026-08-20 起，正式路线改为直接派生 Hermes MIT Bootstrap Installer，而不是继续扩展源码树 Electron Recovery。详细里程碑、许可证归属和验收门见 [`vcpchat-tauri-installer-development-plan.md`](./vcpchat-tauri-installer-development-plan.md)。旧 Recovery 仅作为开发/恢复兼容入口保留。

1. 网络恢复后补齐 Hermes 完整 clone 与 commit pin；当前研究快照已足够支撑 H1/H2 行为对照。
2. 将现有 recovery UI 与 `npm run vcpchat` 的阻塞状态直接联动，形成真正的一键首次运行决策门。
3. 为修复 journal、renderer reload、窗口关闭和 update handoff 增加可恢复的终态查询。
4. 在 Windows/Linux runner 上补齐平台 handoff 和安装包证据，再进入签名下载与用户数据 migration。
5. 保留 H6 操作序列和人工 soak 为发布前门禁，不提前改原有入口。

## 2026-08-20 本机验证证据

已在 macOS arm64 开发环境验证：

- `npm run vcpchat -- --shallow-doctor`：通过，复用现有 Electron 单例，没有产生第二棵进程树。
- `npm run vcpchat:ui` 的 recovery smoke：页面/preload 可见，初始 Doctor 完成后退出，无残留恢复进程。
- `npm run check:ui-system`：通过；包含 UI/生命周期、统一 Surface、Web Awesome、主题和 Bootstrap 测试。
- `npm run test:electron-ui-apps`：22/22 通过。
- `npm run test:electron-main-chat-sequences`：24 个动作、8 次 VCP 请求通过。
- `npm run test:electron-lifecycle-stress`：3 次预热 + 20 轮测量通过；listener、process、scope 和受管资源保持稳定，detached DOM 为 0。
- `npm run pack:check`：Web Awesome runtime 闭包与仓库 vendor tree 通过。
- Bootstrap：26 项通过，覆盖 repair consent、marker、项目隔离、取消、更新 manifest、symlink、rollback 和运行实例门禁。
- Bootstrap/platform boundary：32 项通过，覆盖 Windows/POSIX 终止契约、中文/空格/长路径 profile、macOS bundle helper 排除以及 Windows/Linux bundle layout 解析；这些是跨平台模拟证据，不替代真实 runner。
- 更新安全回归：staging 前磁盘空间预检、候选进程组终止/等待、ready 记录时间窗口和 PID 存活检查均已加入。
- Manifest 签名边界：带 `RSA-SHA256` 签名的 manifest 现在按 canonical JSON 验证，CLI 支持 `--public-key` 或 `VCPCHAT_UPDATE_PUBLIC_KEY`；未签名本地 staging 仍明确属于 trusted-local 模式。
- 网络更新下载器：仅允许无凭据 HTTPS 与同源重定向，签名验证先于文件下载；文件使用 `.part` + Range 续传，并校验 `Content-Range`、声明大小、SHA-256 和完整 closure 后才进入版本 staging。
- 平台进程边界：`modules/bootstrap/platform-process.js` 统一 Windows `taskkill /T` 与 POSIX 进程组 detached 策略，开发启动、恢复、更新和修复 runner 共用同一契约，并有 Windows/POSIX 模拟测试。
- Installer handoff：Recovery UI 通过显式 `--handoff` 等待主应用发布 ready，成功后退出安装器；默认 `npm run vcpchat` 仍会持有前台会话，既有入口行为不变。

以下仍是发布外部证据而非本机已完成事实：Windows PowerShell/NSIS/中文长路径、macOS 签名与公证、Linux AppImage、断网/睡眠恢复和 30–60 分钟人工 soak。磁盘空间逻辑已有单元测试，但尚未在真实磁盘耗尽环境演练。HTTPS 签名下载与断点续传代码已具备，但证书/公钥可信分发和用户数据 migration 事务仍属于生产发布接线范围。
