# VCPChat 独立 Tauri Installer 开发计划

> 状态：执行中
> 建立日期：2026-08-20
> 目标：基于 Hermes Agent MIT Bootstrap Installer，交付真正独立、可签名、可安装、可更新的 VCPChat 安装器。

## 1. 决策摘要

VCPChat 不再把源码树中的 Electron Recovery 包装成正式安装器。正式安装器直接派生自 Hermes `apps/bootstrap-installer` 的 Tauri 2 + Rust + React 架构，并保留 Nous Research 的 MIT 版权与许可证声明。

旧的 `npm run vcpchat:ui`、`.command`、`.vbs` 和手工 `.app` 只作为开发/恢复兼容入口；它们不能作为发布证据，也不能继续被文档称为生产 Installer。

新工程位于 `apps/bootstrap-installer/`，拥有独立进程、状态、日志、下载、安装、更新和 handoff 生命周期。它不得修改主聊天 DOM、插件 Loader、动态壁纸、消息协议或用户数据格式。

## 2. 上游来源与许可证

派生来源：本机 Hermes Agent 源码快照：

`/Users/asahi/Documents/Codex/hermes-agent/apps/bootstrap-installer`

上游许可证：MIT，Copyright (c) 2025 Nous Research。

执行要求：

- 在新 Installer 工程中保留完整 `LICENSE-HERMES`。
- 在 `THIRD_PARTY_NOTICES.md` 声明派生关系、上游项目和修改范围。
- VCPChat 自有文件可继续使用项目现有许可证；从 Hermes 复制或实质派生的文件必须保留 MIT notice。
- 发布包必须包含第三方许可证文件。
- 当前源码快照缺少 `.git` 历史和它引用的 `scripts/install.sh` / `scripts/install.ps1`；实现以已取得的 Installer 源码和行为合同为依据，不虚构 commit pin。

## 3. 产品边界

### 3.0 版本身份与双模式（重要修正）

VCPChat 当前没有面向用户的 SemVer 发布流，日常更新是用户主动执行 `git pull`。因此不能把 Hermes 的完整 SemVer payload 直接当作默认路径，也不能为了安装器虚构 `1.0.0`。安装器使用 Git revision identity：

```json
{
  "channel": "main",
  "commit": "<full git SHA>",
  "treeHash": "<git tree SHA>",
  "packageLockHash": "<sha256>",
  "electronVersion": "<package.json value>",
  "electronAbi": "<runtime probe>",
  "platform": "darwin|win32|linux",
  "arch": "arm64|x64|...",
  "dirty": false
}
```

安装器有两个明确模式：源码优先模式只定位现有源码并读取 Git、Node/npm、Electron、lockfile 与 native ABI；无源码 fallback 才获取用户指定的 commit 或已签名发布 payload。启动时不自动联网、不自动 `git pull`，dirty 源码阻止覆盖式更新，依赖安装必须使用 `npm ci`，Electron 与 lockfile 不一致时先失败，只有 ABI 不匹配才定向 rebuild。

### 3.1 新 Installer 负责

- 首次安装、修复、更新和卸载前置诊断。
- 在无源码模式下载或释放指定 commit / 签名发布包；源码优先模式不下载源码。
- manifest、文件路径、大小、SHA-256 和发布签名校验。
- 版本 staging、原子 current 切换、健康检查与失败回滚。
- 单操作锁、取消、日志、失败证据和进程树清理。
- 创建平台入口和通过平台原生机制启动已安装 VCPChat。
- macOS `.app/.dmg`、Windows `.exe`、Linux `.AppImage` 打包。

### 3.2 新 Installer 不负责

- 不成为第二个聊天业务 Store。
- 不接管主程序 renderer、IPC、插件 Loader 或动态壁纸生命周期。
- 不在安装器中运行 VCPChat 主窗口业务代码。
- 不直接修改用户聊天数据；数据迁移必须另立事务和版本合同。
- 不以 macOS 证据代替 Windows/Linux 实机证据。

## 4. 目标架构

```text
VCPChat-Setup (Tauri 2 native process)
├── Rust owner
│   ├── operation lock + cancellation
│   ├── manifest and stage executor
│   ├── download / hash / signature verification
│   ├── staging / current pointer / rollback
│   ├── diagnostic log and terminal status
│   └── platform handoff
├── Tauri event channel: installer
└── React presentation
    ├── Welcome
    ├── Progress + optional live output
    ├── Success + explicit launch
    └── Failure + retry + open logs

Installed VCPChat
├── versioned application payloads
├── current version pointer
├── bootstrap/update state
└── user data (separate, never rolled back with application files)
```

源码优先启动序列：`locate-source → inspect-git → check-runtime → check-dependencies → native-abi-probe → final-doctor → ready`。这条序列是只读诊断，不会因为安装器被打开就改变源码树；用户主动更新时才创建 staging 工作区，验证通过后原子切换 current。

唯一 durable source of truth 是 Rust `InstallerState`。React nanostore 只是事件投影；renderer reload 通过 `get_installer_status` 恢复，不得启动第二个操作。

## 5. Hermes 复用映射

| Hermes 合同 | VCPChat 处理 |
|---|---|
| Tauri hidden window + setup decision | 直接复用结构，改为 VCPChat install/repair/update mode |
| `BootstrapHandle` + cancellation channel | 复用并增加明确 terminal outcome 和 generation |
| manifest → sequential stages | 复用事件协议，stage 实现替换为 VCPChat 安装 manifest |
| bounded log buffer | 复用，日志同时持久化到 VCPChat 状态目录 |
| install completion marker | 改为包含版本、manifest hash、平台、架构和完成时间 |
| updater PID marker | 复用跨进程互斥与 stale-owner 规则 |
| macOS `/usr/bin/open` | 复用，目标必须是正式 `.app` bundle |
| Windows detached process | 复用，补充真实 Windows runner 证据 |
| direct desktop stylesheet import | 复用思想；建立 Installer 专用 Aero token 入口，避免加载聊天业务 CSS |
| Hermes install scripts | 不复制产品逻辑，替换为 VCPChat stages |

## 6. Installer 页面合同

### Welcome

- 一个 VCPChat 主程序字标、简短说明和一个主按钮。
- 字体、字号、颜色、圆角来自极简 Aero token。
- Enter/Space 可开始；焦点可见；窄窗口不溢出。

### Progress

- 显示准确阶段、完成数、百分比、当前耗时和取消。
- 日志默认折叠；失败时保留并允许打开日志目录。
- renderer reload 只恢复投影，不创建第二次 install。

### Success

- 明确显示安装完成和“启动 VCPChat”。
- 只有平台 handoff 成功后 Installer 才退出；失败必须留在本页显示原因。

### Failure

- 显示用户可理解的摘要、失败阶段、重试和打开日志。
- 不展示未脱敏的命令、token、路径凭据或环境变量。
- 重试前旧 operation 必须到达 quiescence。

## 7. 里程碑与验收门

### M0：基线与许可证

- 建立本计划、`LICENSE-HERMES`、`THIRD_PARTY_NOTICES.md`。
- 固定 Hermes 来源路径、已知缺口和复用映射。
- 将旧 Recovery 标记为开发入口。

验收：许可证完整；文档不再宣称旧 `.app` 是正式 Installer。

### M1：独立可构建骨架

- 建立 Tauri 2/Rust/React 工程。
- Bundle ID：`com.vcpchat.setup`。
- 二进制名：`VCPChat-Setup`。
- 窗口默认隐藏，由 Rust setup 决定显示。
- 提供 `get_mode`、`get_installer_status` 和日志路径命令。

验收：类型检查、Rust check、macOS debug `.app` 构建通过；双击不依赖源码树 Electron。

### M2：生命周期与事件协议

- 一个进程只允许一个 operation owner。
- start、cancel、terminal outcome、dispose 全路径有所有者。
- Rust 事件：manifest、stage、log、complete、failed。
- React reload 恢复，迟到事件不能覆盖新 generation。

验收：重复 start、cancel、关闭、reload、失败后 retry 的确定性测试通过；无 orphan child。

### M3：VCPChat 安装 manifest

- 阶段至少包含：locate source、inspect git、check runtime、check dependencies、native ABI probe、final Doctor；无源码模式再追加 fetch manifest、download、verify、stage payload、publish current、launch health。
- 复用现有 Node Bootstrap 的 hash/signature/runtime closure 语义，但 Rust 是正式 Installer owner。
- 首个垂直切片只运行无副作用 preflight，不下载、不修改。

验收：本机 preflight 事件真实进入 UI；错误可恢复且日志脱敏。

### M4：安装、切换与回滚

- 用户数据与应用版本目录分离。
- staging 完整校验后才能 publish current。
- health/ready 失败原子回滚。
- cancel 与窗口关闭等待子进程真正退出。

验收：正常安装、损坏 hash、磁盘不足、取消、ready 超时、回滚序列通过。

### M5：平台交付

- macOS：arm64/x64 或 Universal `.app/.dmg`，Developer ID、hardened runtime、公证。
- Windows：x64/arm64 `.exe`，WebView2 bootstrapper、代码签名、PowerShell 5.1/7 实机。
- Linux：AppImage、信号转发、桌面文件和冷启动。

验收：每个平台真实安装、启动、更新、失败恢复和卸载证据；模拟测试不能替代。

### M6：发布与迁移

- 正式更新 manifest、公钥轮换、证书和渠道策略。
- 将用户文档指向正式安装包。
- 旧 Recovery 保留一个发布周期后，根据遥测/支持证据决定删除。

验收：30–60 分钟 soak、断网/睡眠/代理中断、跨版本升级和回退通过。

## 8. 实施顺序

1. 先完成 M0/M1，不连接任何真实安装写操作。
2. 在 M2 证明生命周期终态后接入 M3 preflight。
3. 只有签名 manifest 和 rollback 测试完成后才允许 M4 写正式安装目录。
4. 平台适配分别进入独立证据门，不能在一个平台“顺便完成”。
5. 正式 Installer 可用前，保留所有既有入口，避免破坏上游用户。

## 9. 当前执行记录

- 2026-08-20：确认 Hermes Installer 为 MIT；本机发布包是 11 MB arm64 Mach-O，Developer ID 签名且 Apple 公证。
- 2026-08-20：确认 Hermes 使用 Tauri 2、Rust、React、nanostores，Installer UI 直接复用桌面设计系统。
- 2026-08-20：确认 VCPChat 当前手工 `.app` 不是生产安装器，并通过 Finder/Computer Use 复现 LaunchServices 入口失败。
- 2026-08-20：目标模式开始执行 M0/M1。
- 2026-08-20：M0 完成；新增 `LICENSE-HERMES`、`THIRD_PARTY_NOTICES.md` 和本计划。
- 2026-08-20：M1 骨架完成；新增 `apps/bootstrap-installer` 的 React/Vite、Tauri 2、Rust 状态命令、Aero 四态 UI 和根级 `installer:*` scripts。
- 2026-08-20：M2 最小事件闭环开始执行；Rust 已有单 operation owner、AtomicBool cancel、manifest/stage/log/complete/failed 事件，React 已订阅事件并动态显示阶段与取消。
- 2026-08-20：`test:installer-contract` 3/3、Installer `typecheck`、Installer Vite production build、Rust formatting、JSON 和 `git diff --check` 通过。
- 2026-08-20：Tauri `cargo check` 仍缺 crates.io index 网络响应；`--offline` 明确因本地 index 缺少 `redox_users` 无法解析，原生编译证据保持 pending，不冒充通过。
- 2026-08-20：使用本地 rsproxy cargo index 完成 Tauri `cargo check`、Rust unit tests 2/2 和 release build；修复缺失 icon 后生成真实 `VCPChat Setup.app` 与 `VCPChat Setup_0.1.0_aarch64.dmg`。
- 2026-08-20：Computer Use 实测 release `.app`：窗口可见、欢迎页可访问、点击准备后收到 manifest/stage/complete 事件并进入完成页。产物当前为 arm64、adhoc linker-signed，尚未 Developer ID 签名/公证。
- 2026-08-20：M3 开始；新增 `manifest.rs`，验证 schema/product/version/HTTPS-or-dev URL/SHA-256/size，拒绝明显不安全或不完整 payload。
- 2026-08-20：Tauri release `.app/.dmg` 重新构建包含 manifest 与 handoff 变化；Computer Use 点击“启动 VCPChat”在没有签名 payload 时显示明确错误，而不是静默无动作。
- 2026-08-20：根据实际产品模式修正架构：SemVer/payload 不再是源码存在时的默认路径；新增源码优先与无源码 fallback 双模式、Git revision identity、dirty 防覆盖规则和只读诊断阶段。
- 2026-08-20：Installer Rust owner 新增 `SourceSnapshot` 与 `get_source_snapshot`，读取 full commit、tree hash、lockfile SHA-256、Electron 声明版本、Node/npm 版本和 dirty 状态；源码模式启动不会自动 `git pull` 或安装依赖。
- 2026-08-20：补齐源码分发入口：macOS/Linux/Windows launcher 在存在 native Installer 时传入 `--source-root`；Installer 同时从可执行文件祖先目录兜底定位源码，避免 Finder/桌面启动丢失项目上下文。新增 `launchers/VCPChat-Setup.command` 作为 macOS 明确入口。
- 2026-08-20：全新 fork 端到端验证暴露真实 ABI 缺口：`npm ci` 后 better-sqlite3 使用 Node ABI 147，而 Electron 41 要求 ABI 145。修正 repair manifest 的 `npm exec -- electron-rebuild` 分隔符，并把 deep Doctor 设为 Installer 的最终成功门；修复后 Doctor 报告 native-abi pass，managed launcher 输出 ready handoff 成功。
- 2026-08-20：Installer handoff 设置源码目录下独立 `AppData`，避免多份 Electron 共用默认 userData 造成单实例冲突；managed launcher 记录 `VCPChat 已启动` 后再交还控制权。
- 2026-08-20：新增商业发布就绪矩阵 `docs/vcpchat-installer-commercial-readiness.md`；明确 macOS 垂直切片证据、Computer Use 锁屏缺口、签名/公证及 Windows/Linux 实机阻断项。
- 2026-08-20：Rust operation lock 接入 live-owner 拒绝与 stale PID 自动恢复，避免安装器异常退出后永久阻塞下一次修复。
- 2026-08-20：native ABI probe 从“只 require 包入口”升级为真实加载：better-sqlite3 创建内存数据库、node-pty 检查 spawn API、sharp 执行 metadata；移走 `.node` 的 fresh fork 故障测试现已 fail → targeted rebuild → pass 闭环。
- 2026-08-20：发现 npm workspace 参数会吞掉 `-w`，将 rebuild manifest 改为直接调用 `node_modules/@electron/rebuild/lib/cli.js`，避免 npm CLI 解析歧义。
- 2026-08-20：Welcome 页新增只读“检查更新状态”：读取 branch/upstream/ahead/behind 和 dirty 状态，不联网、不自动 `git fetch`/`git pull`；更新仍需用户明确触发并进入 staging。
- 2026-08-20：新增 `.github/workflows/vcpchat-installer.yml`：macOS arm64、Windows x64、Linux x64 的独立 bundle matrix 和 artifact 上传；CI 绿灯只证明平台打包，不代替签名、公证或实机启动证据。
- 2026-08-21：对照上游 `StartVCPchat.exe`，接入兼容的 `VCP_STARTUP:` 展示进度；最终成功仍以 operation ID、child PID 和 main/preload/renderer ready record 为唯一判据。上游内嵌字体未附商业许可，因此未并入发布包。
- 2026-08-21：Tauri Rust owner 新增单一 active child、stdout/stderr 持久日志、Windows `taskkill /T /F`、POSIX process-group 终止和取消等待；repair、Doctor、launch handoff 不再使用 fire-and-forget 子进程。
- 2026-08-21：无源码模式在 payload download/publish/rollback 未接线时失败闭合，修复原 development manifest 跳过验证后产生假成功的问题。
- 2026-08-21：全新本地 fork 从零验证：初始无 `node_modules`，Installer 实际执行 `npm ci` 安装 961 packages；首次执行捕获 Node ABI 147 / Electron ABI 145 不匹配，并暴露 repair plan 未在依赖安装后安排 rebuild 的真实缺陷。
- 2026-08-21：repair planner 修正为只要执行 `npm ci` 就安排 targeted Electron rebuild；重试完成 better-sqlite3、electron-edge-js、hnswlib-node、node-pty rebuild，final Doctor `pass 10 / warn 1 / fail 0`，其中唯一 warning 为可降级的 VCP-CDS shadow runtime 缺失。
- 2026-08-21：Computer Use 确认 clean fork 的 VCPChat 主窗口真实打开，URL 指向该 fork 的 `main.html`；日志记录 `Published managed bootstrap ready` 和 `VCPChat 已启动`。修复 Electron 继承 stdout 导致 Installer 等待 EOF 后，新 release Installer 在 ready handoff 后自动退出。
- 2026-08-21：补齐 VCP-CDS Rust runtime 构建后，clean fork deep Doctor 达到 `pass 11 / warn 0 / fail 0`；Electron ABI、平台 runtime、vendor closure 与 operation lock 全部通过。
- 2026-08-21：Computer Use 回归发现 Installer 自己生成的 `chatDataService/bin/<platform>` 会把源码判为 dirty；根 `.gitignore` 现忽略可重建平台二进制并保留 README，健康环境可重复“准备”且不会再次安装或编译。
- 2026-08-21：严格冷启动回归发现 `--handoff` 返回后 Node 仍持有 Electron child 句柄；managed launcher 在权威 ready 后调用 `child.unref()`。无既存实例复测确认 Installer 退出码 0 且退出，VCPChat、renderer 与 VCP-CDS 保持运行，主窗口 URL 精确指向 clean fork `main.html`。
- 2026-08-21：启动日志进一步暴露 `audio_engine/audio_server` 是 Linux x86-64 ELF，macOS arm64 预热报 `ENOEXEC`；同时修复 `rust_audio_engine/Cargo.toml` 将大部分公共依赖误放入 Windows target table 的结构错误。
- 2026-08-21：新增 `rust_audio_engine/build-runtime.js`、`audio_engine/bin/<platform>-<arch>` 选择、Doctor `audio-runtime` 检查与 Installer `build-audio-runtime` repair stage。macOS 原生 audio server 实际编译、部署并输出 `RUST_AUDIO_ENGINE_READY`；最终 Doctor `pass 12 / warn 0 / fail 0`。
- 2026-08-21：提交前对抗式审查修复窗口关闭所有权：运行中关闭会 prevent close、取消受管进程树、等待 active child 进入 quiescence 后再退出，避免 `npm ci`、Cargo 或 handoff orphan。
- 2026-08-21：修复跨平台 CI bundle matrix 原环境变量无人消费的问题，改为向 Tauri CLI 传入平台限定 `--bundles`；同时跟踪 Installer 独立 `package.json`、npm lockfile 与 Cargo lockfile，保证 fresh checkout 可构建且依赖解析可复现。
- 2026-08-21：源码提交排除本机 ad-hoc、arm64-only 的根目录 `.app` wrapper；正式契约只要求 `launchers/` 下可重建的 macOS/Windows/Linux 源入口，签名 app 只能作为发布产物生成。
- 2026-08-21：Update 模式新增 dirty worktree 三路决策：命名 stash 后更新、查看最多 50 条修改、或跳过更新并启动现有 VCPChat；不再以 dirty 状态永久阻止用户主动更新。
- 2026-08-21：安全更新事务记录原始 HEAD 与精确 stash commit OID，仅允许 `fetch --prune` + `merge --ff-only @{upstream}`；只有 `stash apply --index <oid>` 成功并能按 OID 找到 reflog 引用后才 drop，绝不依赖 `stash@{0}`。
- 2026-08-21：取消和失败清理使用独立、不可取消的 cleanup owner。更新/Doctor 失败先回到原始 HEAD 并清除事务产生的未跟踪文件，再恢复用户修改；恢复冲突则回到干净 HEAD、保留 stash OID，并显示精确手动恢复命令。
- 2026-08-21：新增隔离 bare remote/clone Git 故障测试，真实覆盖 tracked + untracked 成功恢复、上游冲突后 stash 保留与工作树清理、Doctor 失败后的 HEAD 回滚；Installer 合同门禁增至 17/17。
