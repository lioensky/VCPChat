# VCPChat 托管启动、安装与恢复架构路线

## 1. 文档目标

VCPChat 当前同时承担两种分发需求：

1. 开发者和高频测试者直接从源码目录运行，以便快速同步上游和迭代；
2. 普通用户希望双击即可运行，不应理解 Node.js、npm、Electron ABI、Cargo 或 `node_modules`。

当前入口主要直接执行 `npm start` 或 `npx electron .`。这使 Electron 主程序同时承受源码是否完整、依赖是否安装、原生模块 ABI 是否匹配、Rust runtime 是否存在、工作目录是否正确等前置条件。任何条件不满足都可能表现为白屏、闪退、按钮失效或多个残留 Electron 进程，而不是可理解、可恢复的启动错误。

本路线的目标不是再造一个业务应用，也不是让 Electron renderer 自动执行包管理器，而是在业务主程序之前建立一个独立、可诊断、可恢复的托管启动边界：

```text
源码/安装包入口
    -> Bootstrap Core
        -> 发现与只读诊断
        -> 必要且受控的修复
        -> 启动主程序
        -> 等待健康确认
        -> 成功退出或进入恢复界面
    -> VCPChat Electron 主程序
```

## 2. 当前仓库事实

截至本文建立时，仓库真实启动和打包状态如下：

- `npm start` 直接运行 `electron .`；
- `start.bat`、`启动Vchat.vbs`、`启动全部.vbs`、`start-desktop.vbs` 分别直接调用 `npm start` 或 `npx electron .`；
- 部分入口依赖 `NativeSplash.exe`，但 Splash 不拥有依赖诊断和失败恢复；
- `启动全部.vbs` 通过根目录 `.vcp_ready` 文件等待主窗口，信号没有运行代际、PID、版本和超时失败原因；
- `package-lock.json` 已存在，但普通启动不会判断其对应的依赖是否已完整安装；
- `better-sqlite3`、`node-pty`、`sharp` 等包含平台或原生二进制，存在 Electron/Node ABI、平台和架构匹配风险；
- `npm run build` 会调用 Cargo 构建 `rust_chat_data_service`，再以临时文件和 rename 部署到 `modules/services/chatDataService/bin/<platform>-<arch>`；
- `npm run pack` 和 `npm run dist` 已使用 `electron-builder`，Rust runtime 已配置为 `asarUnpack`；
- Web Awesome 有离线 runtime 闭包检查，但它不等同于完整安装包启动验证；
- 当前正式门禁能证明现有依赖树中的 Electron 行为，不证明一台没有 Node/npm/Cargo 的干净机器可以启动；
- 用户数据、聊天数据、插件数据和源码目录可能共处于同一开发环境，启动修复必须严格避免对用户数据做隐式清理。

因此，问题不是“缺少一条更长的启动命令”，而是缺少以下产品能力：

- 依赖与运行时状态的单一事实来源；
- 安装/修复/更新的互斥所有权；
- 可恢复的分阶段事务；
- 明确的启动健康协议；
- 自包含发布物和干净安装证据；
- 面向用户的错误分类与恢复路径。

## 2.1 当前实施状态（M0–M2）

截至 2026-08-20，M0–M2 已落地：

- M0：`modules/bootstrap/contracts.js` 与 `modules/bootstrap/launch-protocol.js` 定义错误码、状态、平台 state root、operation lock 和 operation-scoped ready；
- M0：`docs/vcpchat-bootstrap-contracts.md` 冻结 v1 schema 与所有权边界；
- M1：`npm run doctor` 提供只读环境检查，`--deep` 使用当前 Electron embedded Node 实际加载 native modules；
- M2：`npm run start:managed` 默认执行 deep Doctor，取得启动锁、派生项目内 Electron、等待匹配 operation ID/PID 的 renderer ready，并在失败时写入脱敏诊断；
- M2：现有 `npm start`、VBS/BAT、插件 Loader、用户数据协议和主窗口功能保持不变；
- M3：`repair:managed` 已提供 manifest 驱动的显式修复计划、`npm ci`、定向 Electron rebuild、可选 Rust/vendor 阶段、取消、超时、journal、失败 episode 预算和成功指纹；默认只展示计划，未传 `--apply --yes` 不修改环境；
- M4：`vcpchat-bootstrap`、NDJSON progress protocol 和独立 recovery/launcher 编排已加入；原有 `npm start`、所有 BAT/VBS 和既有桌面入口保持原样，未改为调用新入口；
- M5：runtime closure manifest、electron-builder afterPack hook、打包闭包 verifier 和隔离 packed smoke 已加入；真实签名包/各平台产物仍待外部 runner；
- M6：独立 Electron recovery UI、最小 preload、安全启动、重试、日志和退出已加入；尚未接管普通用户安装器；
- M7：独立版本目录 staging、manifest 校验、current 指针、更新锁和 rollback core 已加入；下载签名、旧进程协调和 ready 后自动回滚仍待下一轮接线；
- M8：本地 evidence collector 和跨平台测试矩阵文档已加入；由于当前约束不提交 workflow，CI runner、签名包、Windows/人工 soak 均明确标记为外部证据缺口。

当前命令：

```bash
npm run doctor
npm run doctor -- --deep
npm run start:managed
npm run start:managed -- --desktop-only
npm run start:managed -- --rag-observer-only
```

机器消费 JSON 时使用 `npm run --silent doctor -- --json`，避免 npm 自己的脚本标题混入 stdout。

## 3. 成熟项目调研结论

### 3.1 Hermes Agent

Hermes Agent 与 VCPChat 的相似点是：它不是纯静态桌面 UI，而是桌面壳、语言运行时、依赖环境、后端进程和用户配置的组合。其实现提供了最直接的参考。

#### 安装与运行时隔离

Hermes 的安装脚本负责准备受管理的 Python、Node.js、uv、ripgrep、ffmpeg；Windows 在缺少 Git 时还会安装隔离的 MinGit。默认安装位于独立的 Hermes Home，不要求用户先把所有工具正确安装到系统 PATH，也尽量不干扰系统已有工具。

可借鉴点：

- 运行时版本由产品定义，不把随机系统环境当作事实来源；
- 受管理工具放在产品自己的 home/bin/venv 中；
- Windows 无管理员权限时仍有便携 fallback；
- 安装脚本主动清除会污染模块解析的继承环境变量；
- 平台和特殊环境有显式策略，而不是让安装失败后再猜测。

VCPChat 不需要复制 Hermes 的 Python/uv 体系，但应借鉴“产品拥有自己的运行时闭包”。普通用户产物应自带 Electron、Node runtime、原生模块和 Rust runtime；源码开发启动器则应验证项目声明的 Node/npm/Electron 组合。

#### 独立 Bootstrap Installer

Hermes Desktop 使用独立的 Tauri Bootstrap Installer。它把安装器脚本解析为 manifest，再逐阶段执行，向 UI 流式发送阶段、日志、成功和失败事件。完成后写入 bootstrap-complete marker，只有完成标记和可启动桌面二进制同时存在时，才认为安装成功。

可借鉴点：

- Bootstrap 与业务窗口分离，业务窗口坏了仍能修复；
- 安装步骤先形成 manifest，UI 不猜测 shell 脚本当前做到了哪里；
- 每个阶段是可观测终态，不以“子进程曾经启动”作为成功；
- 完成标记使用临时文件、flush 和 rename 发布；
- 已安装快路径仍验证完成标记和可执行文件，而不是只看目录存在；
- 开发环境优先使用本地安装脚本，正式包使用构建时 pin 的提交或缓存脚本。

VCPChat 第一阶段不必立即引入 Tauri，但 Bootstrap Core 的协议应按未来可由 CLI、原生小窗口或安装器共同消费来设计。

#### 修复不是无条件重装

Hermes 的 `bootstrap-repair-guard` 明确记录过一个典型事故：后端暂时卡顿导致 renderer 未收到 ready，客户端误判环境损坏并反复强制重装 venv，形成长时间重装循环。其修复策略是先做有限次数的软重启，再升级为硬重装。

这是 VCPChat 必须提前避免的坑：

- “没有 ready”不等于“node_modules 损坏”；
- renderer 崩溃不等于 Rust runtime 损坏；
- IPC 超时不等于需要删除依赖；
- 启动器必须区分进程暂时无响应、运行时缺失、ABI 错误、资源缺失和用户配置错误；
- 修复必须从低破坏级别逐级升级，不能第一步删除 `node_modules` 或用户数据。

#### 跨进程更新锁与陈旧锁恢复

Hermes 的 CLI、桌面界面和独立更新器都可能发起更新。它们共享同一个 update marker 作为跨进程锁，记录 PID 和开始时间；只有持有者仍存活且标记未过期才阻止另一个更新。崩溃后的陈旧标记可以自愈，父更新器向子更新进程交接锁时也有明确协议。

可借鉴点：

- VCPChat 的安装、依赖修复、Rust 部署和未来更新必须共享一个锁；
- 锁要包含 PID、启动时间、操作 ID、目标版本和阶段；
- 不能仅以文件存在判断“仍在更新”；
- 锁释放属于所有者生命周期，所有退出路径都必须清理；
- 如果父进程启动子修复进程，需要显式 handoff，而不是两个进程互相等待。

#### 实际 readiness 优先于配置表面状态

Hermes Desktop 会同时读取 setup status 和真实 runtime check；如果“已经配置”与“运行时实际可用”矛盾，最终以运行时检查为主并呈现差异。

VCPChat 同样不能把以下条件直接等同于 ready：

- 配置中写了 VCP 地址；
- 文件夹中存在 runtime 文件；
- `node_modules` 目录存在；
- Electron 子进程存在；
- `.vcp_ready` 文件存在。

必须验证相应能力真的可以使用。

#### 发布路径测试

Hermes 不只测试当前源码。其 CI 会：

- 在 Windows PowerShell 5.1 和 7 中实际运行安装器测试；
- 定时从多个历史 release 安装，再走真实 update 路径升级到当前提交；
- 测试独立桌面包、运行时准备、更新 marker、修复 guard；
- 对下载工具链版本做 pin，避免“latest”元数据服务抖动拖垮 CI；
- 为 Electron 桌面执行真实 Playwright 和截图差异。

对 VCPChat 的启示是：安装器和更新器本身必须作为产品代码测试，不能只测试安装完成后的 renderer。

### 3.2 VS Code

VS Code 将开发预启动和正式产品分得很清楚：

- 源码开发入口执行 preLaunch，获取 Electron、编译源码并准备内置扩展；
- 正式产品构建下载并校验固定 Electron 资源，最终发布自包含应用；
- 业务窗口不负责在普通用户机器上运行 Yarn/npm；
- 开发环境和产品环境通过显式变量和独立构建目录区分；
- WSL、容器和图形环境差异在启动边界有明确分支。

对 VCPChat 的启示：

- `npm run start:managed` 是源码开发入口，不应成为普通用户安装模型；
- 正式包必须自包含，用户启动不执行 `npm ci`；
- 开发预启动可以准备构建物，但产物目录、缓存目录和用户数据目录必须分离；
- Electron 版本与资源需要校验，不从不受控的 PATH 中寻找任意 Electron。

### 3.3 Ollama

Ollama 的安装脚本按平台和架构选择预构建产物，使用临时目录下载和解包，检查必需系统工具，在 Linux 上配置稳定服务入口，并根据硬件能力选择 GPU runtime 或明确降级到 CPU。

可借鉴点：

- 对普通用户分发预构建的 Rust runtime，不要求用户安装 Cargo；
- 明确支持的 OS/架构矩阵，未知组合快速失败；
- 下载和解包使用临时目录，成功后再发布到正式位置；
- 可选能力失败应降级并解释，不应拖垮核心主窗口；
- 安装成功的定义包括服务真正可访问，而不是文件复制完成。

需要避免照搬的部分：VCPChat 不应在普通启动时自动安装系统驱动或使用管理员权限修改广泛的系统状态。

### 3.4 DeepSeek Harness

DeepSeek Harness 不是桌面安装器范例，但它在“可发布运行时闭包”方面很有参考价值：

- 固定 package manager 和 Node engines；
- CI 使用 frozen lockfile；
- 明确验证 workspace runtime closure；
- 发布前验证打包产物能够在干净环境安装；
- 插件安装在 profile 自己的依赖目录，不与核心源码依赖混在一起；
- 通过包边界、消费者检查和平台矩阵减少“源码仓库能跑、发布包不能跑”的差异。

对 VCPChat 的启示：

- 核心运行时、可选插件和开发依赖应形成不同闭包；
- 不能把整个开发 `node_modules` 无差别视为正式产品依赖；
- 应新增 packaged runtime closure 清单和干净安装检查；
- 插件不应有权触发核心依赖重装；
- 启动器只检查插件宿主能力，不重新设计或接管插件生命周期。

## 4. 总体决策

VCPChat 采用两层交付模型：

```text
开发者/高频测试者
    -> Managed Dev Launcher
    -> 验证源码、锁文件、依赖、ABI、Rust runtime
    -> 必要时经用户确认执行受控修复
    -> Electron 源码模式

普通用户
    -> VCPChat.app / VCPChat.exe / AppImage
    -> Packaged Bootstrap Gate
    -> 验证随包资源和本地用户目录
    -> Electron 打包模式
```

两者共享诊断模型、状态机、错误码、日志格式和健康协议，但修复权限不同：

| 能力 | 开发启动 | 正式包启动 |
| --- | --- | --- |
| 检查 lockfile | 是 | 记录构建 provenance，不读取源码 lockfile |
| 执行 `npm ci` | 可选、需受控 | 禁止 |
| 执行 `electron-rebuild` | 可选、需受控 | 禁止，构建产物必须已匹配 |
| 执行 Cargo build | 可选、需受控 | 禁止，使用预构建 runtime |
| 修复用户配置 | 仅显式操作 | 仅显式操作 |
| 启动安全模式 | 是 | 是 |
| 打开诊断报告 | 是 | 是 |
| 自动更新源码 Git | 默认禁止 | 禁止，使用正式更新通道 |

## 5. 架构组件

### 5.1 Bootstrap Core

建议新增独立 Node 模块目录：

```text
modules/bootstrap/
  bootstrap-controller.js
  bootstrap-state.js
  environment-doctor.js
  dependency-fingerprint.js
  repair-planner.js
  operation-lock.js
  runtime-health.js
  launch-supervisor.js
  diagnostic-report.js
  error-codes.js
```

第一阶段由 Node CLI 使用这些模块。未来原生/Tauri 启动窗口应通过结构化 JSON 事件消费同一协议，不复制诊断逻辑。

### 5.2 启动状态机

```text
idle
  -> acquiring-lock
  -> discovering
  -> validating
     -> ready-to-launch
     -> repair-available
     -> blocked
  -> repairing
     -> validating
     -> repair-failed
  -> launching
  -> awaiting-ready
     -> running
     -> startup-timeout
     -> crashed-before-ready
  -> recovering
  -> complete
```

约束：

- 每次运行有唯一 `operationId` 和 generation；
- 同一时刻最多一个 mutating operation；
- 只读 doctor 可以并行，但必须报告当前是否有安装/更新占用；
- 任何异步结果在提交状态前复核 generation 和所有者；
- cancel 只终止当前阶段拥有的子进程，不杀死无关 Electron；
- `complete` 必须来自真实健康确认，不来自固定 sleep。

### 5.3 依赖指纹

开发启动器使用稳定指纹判断是否需要验证或修复：

```json
{
  "schemaVersion": 1,
  "platform": "win32",
  "arch": "x64",
  "node": "22.x",
  "npm": "10.x",
  "electron": "41.7.1",
  "lockfileSha256": "...",
  "nativeModules": {
    "better-sqlite3": "...",
    "node-pty": "...",
    "sharp": "..."
  },
  "rustRuntimeSha256": "...",
  "webAwesomeManifestSha256": "..."
}
```

指纹只能作为“可以跳过昂贵检查”的缓存提示，不能取代关键运行时 probe。指纹文件使用临时写入和原子 rename 发布。

### 5.4 操作锁

锁文件建议位于项目专用状态目录，而不是源码根目录的无版本裸文件：

```text
<state-dir>/bootstrap/operation.lock
```

内容至少包含：

```json
{
  "schemaVersion": 1,
  "operationId": "uuid",
  "pid": 1234,
  "parentPid": 1200,
  "kind": "dependency-repair",
  "startedAt": "2026-08-20T00:00:00Z",
  "targetRevision": "git-sha-or-build-id",
  "stage": "npm-ci"
}
```

锁有效性同时检查 PID 存活、启动时间、操作种类和最大年龄。陈旧锁只在记录诊断证据后移除。父子进程交接使用显式 handoff token，不能仅依赖父 PID 相同。

### 5.5 健康协议

替换或升级当前 `.vcp_ready` 语义。建议主进程在状态目录发布带 operation ID 的 ready record，或通过父子进程 IPC/本地管道返回：

```json
{
  "schemaVersion": 1,
  "operationId": "uuid",
  "pid": 5678,
  "buildId": "git-sha",
  "readyAt": "...",
  "checks": {
    "mainWindow": "ready",
    "preload": "ready",
    "chatDataService": "ready|degraded",
    "pluginHost": "ready|degraded"
  }
}
```

`ready` 应证明：

- 主进程完成核心 IPC 注册；
- 主窗口创建并完成 startup gate；
- preload 契约存在；
- Rust chat data service 按其产品要求 ready 或明确 degraded；
- 不要求所有第三方插件成功，插件失败不得阻塞核心聊天；
- operation ID 与本次启动一致，旧 ready record 不得误判新启动。

### 5.6 错误分类

最低错误码集合：

```text
E_PROJECT_INCOMPLETE
E_NODE_MISSING
E_NODE_UNSUPPORTED
E_NPM_MISSING
E_LOCKFILE_INVALID
E_DEPENDENCY_MISSING
E_DEPENDENCY_CORRUPT
E_NATIVE_ABI_MISMATCH
E_RUST_RUNTIME_MISSING
E_RUST_RUNTIME_INVALID
E_VENDOR_CLOSURE_INVALID
E_OPERATION_BUSY
E_OPERATION_STALE_LOCK
E_INSTALL_NETWORK
E_INSTALL_PERMISSION
E_ELECTRON_SPAWN
E_ELECTRON_CRASH_BEFORE_READY
E_STARTUP_TIMEOUT
E_RUNTIME_DEGRADED
```

每个错误必须包含：

- 用户可读标题；
- 技术详情；
- 证据和日志路径；
- 是否可自动修复；
- 修复破坏级别；
- 推荐下一步；
- 是否允许安全模式启动。

### 5.7 修复等级

借鉴 Hermes 的 repair guard，修复按破坏级别升级：

1. 重新 probe；
2. 重启当前子服务或 Electron；
3. 重新生成缓存/指纹；
4. 针对已确认的单个 native module 执行 rebuild；
5. 严格按 lockfile 执行依赖重装；
6. 重新构建 Rust runtime；
7. 下载/恢复已签名的正式产物；
8. 只有用户明确选择时才重置应用配置；
9. 聊天数据、插件数据和用户设置永不作为通用启动修复步骤删除。

启动超时不能直接跳到第 5 或第 6 级。

## 6. 用户可见形态

### 6.1 第一阶段：CLI/无窗口托管启动

新增：

```text
npm run doctor
npm run start:managed
npm run start:managed -- --desktop-only
npm run start:managed -- --diagnostic
```

正常路径只输出简短状态并自动打开 VCPChat。失败路径保留终端或生成诊断文件。

### 6.2 第二阶段：轻量恢复窗口

仅当操作超过短暂阈值或发生可恢复错误时显示：

```text
VCPChat 正在准备

✓ 项目完整性
✓ JavaScript 依赖
! 原生模块需要修复
  正在重新构建 better-sqlite3...

[取消] [查看日志]
```

正常启动不增加一次额外点击。恢复窗口不加载主应用 renderer、插件和用户主题，避免共因失败。

### 6.3 正式安装包

普通用户仍只看到一个 `VCPChat.app`、`VCPChat.exe` 或 AppImage。Bootstrap Gate 可以在同一产品图标下作为独立轻量进程存在。正式包不显示 npm/Cargo 术语，错误描述以“应用组件损坏/缺失”为主。

## 7. 数据与安全边界

### 7.1 目录分离

至少区分：

```text
source/build root       源码和开发依赖
install root            正式应用只读资源
state root              锁、指纹、ready、诊断
cache root              可删除下载和构建缓存
user data root          聊天、设置、助手、插件数据
logs root               启动和崩溃日志
```

修复器不能通过相对路径从未知 cwd 删除目录。所有变更目标先解析为绝对路径并验证处于允许根目录。

### 7.2 下载与供应链

- 正式产物、Electron、Rust runtime 和未来更新都必须有固定版本和 SHA-256；
- 不在正式用户启动时执行远程 shell；
- 不使用无 pin 的 `latest` 作为安装事务唯一输入；
- 下载到临时目录，校验后原子发布；
- 日志不得记录 API Key、插件 secret、Authorization header 或完整用户配置；
- 正式更新失败保留旧版本，不在原地留下半更新目录；
- CI action 和工具版本应 pin，避免上游元数据临时故障扩大为发布故障。

### 7.3 插件边界

- 不修改 `VCPDistributedServer/frontend-plugin-loader.js` 的现有运行协议；
- 不为动态壁纸建立特殊启动逻辑；
- Bootstrap 只判断核心 plugin host 是否可初始化；
- 单个插件失败记录为 degraded，不触发核心依赖重装；
- 插件依赖未来若需要托管，应使用独立插件环境和独立 manifest，不写入核心 `node_modules`；
- 启动器不扫描、执行或更新未知插件代码来判断核心 ready。

## 8. 分阶段开发路线

### M0：启动事实基线与契约冻结

任务：

- 记录所有现有启动入口、参数和工作目录；
- 列出核心/可选 native modules；
- 定义 Rust runtime、Web Awesome closure 和 Electron bundle 的 provenance；
- 定义 state/cache/user-data/logs 的平台目录；
- 定义错误码、诊断 JSON schema、operation lock schema 和 ready schema；
- 明确哪些失败允许 degraded 启动；
- 为现有 `.vcp_ready` 行为增加事实测试，后续再迁移。

验收：不改变现有启动行为；文档、schema 和测试与仓库事实一致。

### M1：只读 Doctor

新增 `scripts/vcpchat-doctor.mjs` 和 `npm run doctor`。

检查：

- 平台、架构、cwd、路径可写性；
- Node/npm/Electron 版本；
- `package.json` 与 lockfile；
- 关键包和 Electron binary；
- native module 可加载 probe；
- Rust runtime 文件、权限、版本和最小启动 probe；
- Web Awesome runtime manifest；
- 用户数据目录只读健康检查；
- 当前运行进程和 operation lock；
- 最近一次 bootstrap/主进程失败。

Doctor 默认只读。`--json` 输出稳定 schema；`--redact` 默认开启。

验收：在缺依赖、错误 ABI、缺 Rust runtime、不可写目录和陈旧锁 fixture 中给出准确错误，不修改环境。

### M2：Managed Dev Launcher

新增 `scripts/vcpchat-dev-launcher.mjs` 和 `npm run start:managed`。

能力：

- 取得 operation lock；
- 执行 Doctor；
- 正常环境直接启动项目内 Electron binary；
- 等待带 operation ID 的 ready；
- 超时或早退生成诊断；
- 支持 `--desktop-only`、`--rag-observer-only` 和调试参数透传；
- 避免重复启动无关 Electron；
- 默认不执行修复，仅建议或要求显式 `--repair`。

验收：正常启动与 `npm start` 功能一致；缺依赖时不启动半残 Electron；并发两次只有一个 mutating owner。

### M3：受控修复规划器

实现 manifest 驱动的修复阶段：

```text
validate-lockfile
install-dependencies
probe-native-modules
rebuild-native-modules
build-rust-runtime
verify-vendor-closure
publish-fingerprint
```

约束：

- 使用 `npm ci`，不使用无约束 `npm install`；
- 只有 ABI probe 明确失败时才 rebuild；
- Cargo 构建只属于开发模式；
- 每阶段有 timeout、cancel、结构化结果和日志；
- 修复中断后不得发布成功指纹；
- 不触碰用户数据；
- 同一失败 episode 有软重试预算，禁止重装循环。

验收：故障注入覆盖网络失败、npm 退出、rebuild 失败、Cargo 失败、取消和启动器崩溃；下一次运行能识别并恢复。

### M4：独立托管入口与进度协议（不改现有脚本）

M4 不再改造或替换以下旧入口：

- `start.bat`；
- `start debug.bat`；
- `启动Vchat.vbs`；
- `启动全部.vbs`；
- `start-desktop.vbs`；
- `start-rag-observer.vbs`。

新增 `scripts/vcpchat-bootstrap.mjs` 作为独立命令面，提供 `doctor`、`launch`、`repair`、`recovery-ui`、`runtime`、`update` 和 `evidence` 子命令。它们共享 Bootstrap Core 和结构化 NDJSON 进度协议；旧入口仍按上游原样运行。这样开发者可以逐步采用托管入口，普通用户和原有脚本不被隐式改变。

验收：新入口可独立运行、旧入口文件内容不变、两套入口不会共享错误的 ready/lock 所有权。

### M5：打包运行时闭包

建立正式产品 runtime manifest：

- app.asar 文件清单；
- asarUnpack 清单；
- native module 平台/架构/ABI；
- Rust runtime hash；
- Web Awesome vendor closure；
- 插件宿主核心资源；
- build ID、源码 revision 和 Electron version。

新增：

```text
npm run verify:runtime-closure
npm run test:packed-install
```

`test:packed-install` 在临时目录解包实际 `electron-builder --dir` 产物，清除源码 `node_modules` 和开发环境变量影响后启动，等待真实 ready。

验收：打包应用不依赖系统 Node/npm/Cargo，不从源码目录偷取资源。

### M6：轻量 Bootstrap/Recovery UI

在协议稳定后实现独立 UI。技术选择可按维护成本决定：

- 首选小型原生/Tauri 窗口；
- 过渡期可使用隔离 Electron entry，但必须拥有独立 preload、最小依赖闭包且不加载主应用插件；
- UI 只消费 Bootstrap Core 的结构化事件。

界面包括：欢迎/准备、进度、失败、成功四种基础路由；提供重试、低破坏修复、查看日志、安全模式和退出。

验收：主 renderer 故意损坏时恢复 UI 仍可运行；正常路径无额外点击和显著启动延迟。

### M7：正式更新与回滚

更新与开发 `git pull` 完全分离：

- 下载签名/校验后的版本目录；
- 关闭旧进程并等待文件锁释放；
- 使用跨进程 update lock；
- 在 staging 目录验证 runtime closure；
- 原子切换 current 指针或版本目录；
- 启动新版本并等待 ready；
- 未 ready 自动回滚旧版本；
- 用户数据 schema migration 单独事务化并保留备份。

验收：断网、下载损坏、磁盘不足、进程未退出、切换中断、新版本早退均能保留或恢复旧版本。

### M8：发布证据矩阵

CI 分层：

1. 每个 PR：Doctor unit、状态机、锁、manifest、Linux/macOS 基础 pack smoke；
2. 合并 main：完整 runtime closure、Electron packaged smoke；
3. Windows runner：PowerShell 5.1/7、路径空格/中文/长路径、NSIS 安装与卸载；
4. 定时任务：从若干历史正式版本走真实更新到当前版本；
5. 发布候选：macOS 签名/隔离属性、Windows 签名/Defender、Linux AppImage；
6. 人工证据：30–60 分钟运行、睡眠恢复、重启、磁盘不足和无网络。

Windows 实机证据不可由 macOS 自动测试替代。没有证据时标为待验，不宣称完成。

## 9. 测试矩阵

### Doctor

- 无 Node；
- Node 版本不支持；
- 无 npm；
- 无 `node_modules`；
- lockfile 与 package 不一致；
- Electron binary 缺失；
- native module ABI 错误；
- Rust runtime 缺失、无执行权限、启动即崩溃；
- vendor closure 缺失；
- 用户目录只读；
- state lock 正常、陈旧、损坏和外部占用。

### Bootstrap 生命周期

- 重复启动；
- 启动期间取消；
- 子进程迟到退出；
- launcher 自身被杀；
- ready 超时后 Electron 随后迟到 ready；
- 旧 generation ready 文件残留；
- desktop-only 第二实例；
- 主窗口 crash-before-ready；
- 主窗口 ready 后 launcher 正常退出；
- 安装/更新/启动交叉并发。

### 修复

- `npm ci` 网络失败和重试；
- npm 成功但包不可加载；
- rebuild 单模块失败；
- Cargo 缺失；
- Cargo 构建成功但目标文件缺失；
- 临时部署 rename 失败；
- 修复过程中磁盘不足；
- 修复完成 marker 写入失败；
- 相同超时不得无限触发硬重装。

### 打包

- 源码目录重命名或不可访问；
- 系统 PATH 没有 Node/npm/Cargo；
- 无网络启动；
- 路径含空格、中文和长路径；
- macOS arm64/x64；
- Windows x64/arm64（若正式支持）；
- Linux AppImage；
- 打包 Rust runtime 与当前平台匹配；
- 原生模块能在打包 Electron 中加载；
- Notes、Translator、核心插件宿主和主聊天基本 smoke。

## 10. 可观测性与隐私

每次启动生成 bounded structured log：

```text
logs/bootstrap/<date>-<operationId>.jsonl
logs/bootstrap/latest-summary.json
```

事件字段包含：operation ID、阶段、持续时间、退出码、错误码、版本和平台；不包含 API key、完整消息内容、Authorization、用户 prompt 或插件 secret。

保留策略按文件数和总大小双重限制。UI 提供“复制脱敏诊断摘要”，而不是要求用户截图一整段终端。

关键指标：

- cold start ready 时间；
- warm start ready 时间；
- Doctor 各检查耗时；
- repair 触发率和成功率；
- crash-before-ready 比例；
- startup-timeout 比例；
- 错误码分布；
- soft restart 升级为 hard repair 的比例；
- packaged app 从无开发环境机器启动的成功率。

## 11. 明确不做

本路线不授权以下改动：

- 不修改聊天数据、助手、群组、用户设置或插件数据协议；
- 不以“修复启动”为由删除用户数据；
- 不重新设计前端插件 Loader；
- 不特殊改造动态壁纸；
- 不引入第二套主聊天布局；
- 不在 renderer 中运行 npm、Cargo 或更新器；
- 不在每次启动时无条件安装依赖；
- 不把源码 Git 自动更新作为普通用户更新机制；
- 不在第一阶段引入 Tauri、React 或新的大型 UI 框架；
- 不让 Bootstrap Core 依赖 Web Awesome、主应用主题或第三方插件。

## 12. 推荐近期施工切片

第一批 PR 应严格限制在 M0–M2，不立即实现自动重装和正式更新：

1. 建立 schema、错误码和目录策略；
2. 实现只读 `npm run doctor`；
3. 实现 `npm run start:managed`，正常环境只做检查并启动；
4. 用 operation ID 替换裸 `.vcp_ready` 的误判风险，同时保留兼容读取期；
5. 增加缺依赖、错误 ABI、缺 Rust runtime、重复启动、超时和 crash-before-ready 测试；
6. 不改现有 VBS/BAT 默认入口，先并行试运行；
7. 收集一段时间的真实诊断后，再决定自动修复的最小集合。

这样能先获得最大的诊断收益，又不会立刻把包管理、Cargo 和更新写入日常启动路径。

## 13. 完成定义

只有满足以下条件，才能宣称托管启动体系完成：

- 开发源码缺依赖时给出准确诊断和可控修复，不产生半启动 Electron；
- 正式打包产物在没有 Node/npm/Cargo 的干净系统上可启动；
- native modules、Rust runtime、vendor 资源都有构建 provenance 和运行 probe；
- 并发安装、修复和更新不会同时修改同一环境；
- 崩溃后陈旧锁和临时文件可恢复；
- 启动超时不会自动进入无限重装循环；
- 新版本失败能回滚，旧版本和用户数据仍可使用；
- Windows、macOS 和 Linux 的受支持矩阵有对应自动或人工证据；
- Bootstrap 失败仍能显示恢复信息；
- 主应用功能、插件 Loader、用户配置和聊天数据协议没有因为启动器发生隐式改变。

## 14. 参考实现

- Hermes Agent：<https://github.com/nousresearch/hermes-agent>
  - `scripts/install.sh` / `scripts/install.ps1`
  - `hermes_cli/doctor.py`
  - `hermes_cli/update_lock.py`
  - `apps/bootstrap-installer/src-tauri/src/bootstrap.rs`
  - `apps/bootstrap-installer/src-tauri/src/update.rs`
  - `apps/desktop/electron/bootstrap-runner.ts`
  - `apps/desktop/electron/bootstrap-repair-guard.ts`
  - `apps/desktop/src/lib/runtime-readiness.ts`
  - `.github/workflows/install-e2e.yml`
- Visual Studio Code：<https://github.com/microsoft/vscode>
  - `scripts/code.sh`
  - `build/lib/preLaunch.ts`
  - `build/lib/electron.ts`
- Ollama：<https://github.com/ollama/ollama>
  - `scripts/install.sh`
- DeepSeek Harness：本机 `/Users/asahi/Documents/Codex/deepseek-harness`
  - `scripts/verify-runtime-closure.ts`
  - `scripts/release/verify-packed-install.ts`
  - `apps/cli/src/profile-boot.ts`
  - `.github/workflows/ci.yml`
