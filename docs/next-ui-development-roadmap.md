# Next UI 完整开发路线

## 文档定位

本文是 VCPChat Next UI 后续演进的总路线。它规定阶段顺序、模块边界、合并门槛和长期收敛方向，不替代具体子系统文档：Web Awesome 的加载、定制和离线闭包由 [`next-ui-webawesome-roadmap.md`](./next-ui-webawesome-roadmap.md) 负责，动态资源所有权和竞态规则由 [`next-ui-lifecycle-architecture.md`](./next-ui-lifecycle-architecture.md) 负责，主聊天操作序列测试由 [`main-chat-operation-sequence-testing.md`](./main-chat-operation-sequence-testing.md) 负责，上游 PR 的减法边界由 [`design-system-upstream-pr-convergence.md`](./design-system-upstream-pr-convergence.md) 负责。

当前实现已交付 M0、M2、M3、M5 和 M7 的主要代码；M1、M6、M8 仍处于验证或收敛阶段。Classic 默认，Next 可选；Classic / Next 功能对等整改由 [`upstream-function-parity.md`](./upstream-function-parity.md) 持续回归。动态 Next 表面已接入 `LifecycleScope`，模式切换已串行化，并具备可取消任务、权威状态订阅、只读生命周期诊断、性能预算、受限原生 session 和真实 Electron 恢复/压力门禁。前端插件运行时保持上游实现，不属于本路线的改造范围。

双布局是验证期策略，不是长期目标。终态是把 Classic 的成熟业务行为与 Next 的工作台结构逐区域收敛成一套规范布局，而不是用一份全新实现整体替换另一份。收敛完成后，失去用途的模式分支、重复入口和重复样式才会被清理；上游聊天、会话、助手、通知、设置和插件业务始终只有一份。

## 产品与架构目标

Next UI 的目标不是维护第二套聊天业务，也不是把上游代码迁入新框架。目标是建立一个独立、可卸载、可诊断的 presentation，在不改变聊天数据、插件数据和用户配置协议的前提下，共享上游业务能力。

```text
上游领域数据与业务服务
├── 聊天、会话、助手、群组、通知、设置、插件
├── 受限 IPC 与原生 WebContentsView session
└── 共享 commands / query / subscriptions
             ├── Classic presentation（兼容基线）
             └── NextShellController
                 ├── AppTabHost
                 ├── OverlayCoordinator
                 ├── EmbeddedAppController
                 ├── LaunchpadController
                 ├── CreationController
                 ├── AccountMenuController
                 └── VCPUI → Web Awesome / native fallback
```

长期判断标准不是代码是否“像 VS Code 或 DSH”，而是以下关系是否成立：

1. 业务状态只有一个权威来源，Classic 与 Next 不复制业务数据。
2. 动态副作用都有生命周期所有者，注册贡献能够撤销。
3. renderer、主进程和原生 View 的异步操作有身份、取消和最终状态对账。
4. Classic 不因 Next 的存在改变 DOM 身份、事件语义和启动行为。
5. 每次演进都能独立回滚，不要求一次性重写整个主窗口。

## 明确不采用的路线

- 不引入 Cordis、React、Vue 或新的全应用框架重写 VCPChat。
- 不把所有静态 DOM、CSS 和页面级 singleton 强行迁入 `LifecycleScope`。
- 不把 Classic 隐藏起来再通过 `.click()` 作为 Next 的业务层。
- 不让业务模块直接依赖 `<wa-*>`、Shadow DOM 私有结构或 Web Awesome Token。
- 不在本路线中改变前端插件加载、卸载或热重载协议。
- 不同时进行模块拆分、视觉重设计、Vendor 更新和业务协议修改。
- 不以测试阈值放宽代替泄漏根因修复。

## 阶段总览

| 阶段 | 目标 | 进入条件 | 退出证据 |
|---|---|---|---|
| M0 | 生命周期稳定基线 | 已完成 | 20 轮 Electron 压测资源恒定 |
| M1 | 发布前稳定化（验证中） | M0 | 竞态矩阵、长时 soak 和稳定性门禁通过 |
| M2 | 拆分 Next Shell 协调器（已完成） | M1 | `topTabManager` 退化为兼容 facade |
| M3 | 可取消异步与 IPC 任务（已完成） | M2 的 Overlay/Embedded 边界稳定 | 请求可取消，迟到结果无提交权 |
| M4 | 统一 Next 贡献协议（部分完成） | M3 | Next App/Menu/Command/Setting 注册均可撤销；不改变插件协议 |
| M5 | 状态权威与显式订阅（已完成） | M2–M4 | 无新增隐藏 DOM 代理和全局扫描 |
| M6 | VCPUI 与 Surface 收敛（进行中） | M5 | Next 自有表面统一 create/fallback 生命周期 |
| M7 | 诊断、故障注入与持续门禁（已完成） | 与 M2–M6 同步 | 可定位 owner、任务和原生 session |
| M8 | 性能、安全和恢复能力（验证中） | M3、M7 | 崩溃、休眠、断网与长时运行可恢复 |
| M9 | 主聊天状态模型与差分验证 | 可与 M1、M8 并行 | 可重放操作序列覆盖主要聊天状态与竞态 |
| M10 | 共享业务契约收口 | M9 建立业务 oracle | 两种 presentation 产生同一业务结果 |
| M11 | 区域级布局收敛 | M10 | 顶栏、侧栏、聊天、通知和设置逐个只剩一个实现 |
| M12 | 单一布局切换 | M11 验收完成 | `uiMode` 不再选择两套 presentation，用户配置无损迁移 |
| M13 | 分叉清理与长期门禁 | M12 | 重复 DOM/CSS/facade 被删除，唯一布局基线固定 |

M2–M7 可以按小 PR 交错推进，但不能跳过各自进入条件。M9 应在双布局仍可对照时尽早开始；它既寻找竞态，也为后续布局收敛提供业务 oracle。M11–M13 必须按区域渐进推进，不能把全局 DOM 删除、视觉调整和命名重写塞进一次切换。

## M0：生命周期稳定基线（已完成）

### 已交付

- `LifecycleScope` 与资源诊断。
- Ask Nova、Appearance Studio、设置增强、应用标签、创建弹窗和应用托盘的 owner。
- 可撤销 Next App Registry。
- Classic/Next 串行切换和 stale generation fence。
- 原生 overlay lease、延迟 hide 最终对账和嵌入 session 压力测试。
- Classic 隔离、Web Awesome 离线闭包和打包门禁。

### 维护要求

M0 不是一次性重构。后续任何动态 Next 表面必须遵守生命周期文档；新增全局 listener、Observer、timer、IPC subscription 或注册项时，评审必须能够指出其 owner 和 teardown 测试。

## M1：发布前稳定化

### 目标

冻结结构性扩张，用真实使用验证当前基线。此阶段只接受 P0/P1 稳定性修复、测试缺口和文档修正，不加入新的大型视觉或业务功能。

### 工作项

- 完成 Classic 与 Next 的人工竞态矩阵：快速模式往返、Ask Nova 逆序打开、内嵌应用 + Overlay、设置反复打开、插件管理器冷启动、创建助手期间切换模式。
- 进行至少一次 30–60 分钟真实使用 soak；记录 renderer 数、原生 View 数、内存趋势、错误日志和界面响应。
- 将启动环境错误与 UI 错误分开记录：模型服务、音频二进制、VCP-CDS 或第三方插件失败不能掩盖 UI 是否可恢复。
- 为人工发现的每个竞态先建立确定性复现，再修实现；不只增加延时或重试。
- 固定当前 PR 文件边界，重新同步上游时先通过 subtraction guard，再解决共享文件冲突。

### 退出门槛

- 自动门禁全部通过，人工竞态矩阵无阻塞问题。
- 长时间运行没有持续增长的 listener、renderer、WebContentsView 或动态 Scope。
- 已知非阻塞问题进入文档并标明 owner，不以“暂未复现”关闭。

## M2：拆分 Next Shell 协调器

### 目标

`topTabManager.js` 当前同时管理标签、原生 View、Overlay、启动台、创建流程、搜索和账户菜单。拆分目标是缩小故障域和测试夹具，不改变 DOM、IPC、用户设置或 `window.topTabManager` 调用方。

### 目标模块

```text
modules/ui-system/next-shell/
├── next-shell-controller.js
├── overlay-coordinator.js
├── embedded-app-controller.js
├── app-tab-host.js
├── launchpad-controller.js
├── creation-controller.js
├── account-menu-controller.js
└── assistant-search-controller.js
```

### 拆分顺序

1. `OverlayCoordinator`：唯一持有 overlay owners、原生 View 隐藏/恢复和最终对账。
2. `EmbeddedAppController`：唯一调用 embedded app IPC，管理 session 创建、激活、关闭、恢复和拖出。
3. `AppTabHost`：只管理标签 DOM、active view、会话持久化和键盘语义。
4. `LaunchpadController`：应用目录渲染、应用托盘和内部应用入口。
5. `CreationController`：助手/群组创建 Modal、模型查询和提交状态。
6. `AccountMenuController` 与 `AssistantSearchController`：Next Shell 局部交互。
7. `NextShellController` 组合上述模块；旧 `topTabManager` 只转发兼容 API。

### 接口原则

- 构造时显式注入 DOM host、commands、IPC 和 owner，不从模块内部猜测脚本加载顺序。
- 每个 controller 有幂等 `mount()/dispose()`，只能拥有自己的资源。
- controller 间通过窄方法或订阅通信，不读取对方私有 Map/DOM。
- 旧 facade 在全部调用方迁移前保留，禁止一次性重命名全仓库。

### 验收

- 每次提取前后 Electron 行为和 Scope 基线一致。
- Overlay、Embedded、Tab 各有独立故障注入测试。
- 删除任一 controller 不影响 Classic 启动。
- `topTabManager` 最终不再直接创建 Modal、Observer、原生 session 或应用按钮。

## M3：可取消异步与 IPC 任务协议

### 目标

generation 能阻止迟到结果写 UI，但不能停止已经进入主进程的工作。建立统一任务协议，让 renderer 销毁 owner 时同时取消底层请求，并由主进程验证调用者和任务身份。

### 建议接口

```text
renderer start { requestId, operation, payload }
main validate sender + operation
main own task by sender/requestId
renderer cancel { requestId }
main abort task and settle once
renderer accept result only when owner/generation is current
```

renderer 侧使用一个小型 `TaskHandle`：`requestId`、`promise`、`cancel()`；`LifecycleScope` 持有 `cancel()`。主进程使用 sender WebContents 作为第一层 owner，renderer destroyed 时批量取消其任务。

### 迁移顺序

1. Ask Nova/DeepWiki。
2. 模型列表和主题清单查询。
3. 创建助手/群组后的刷新与导航。
4. 内嵌应用 create/close/detach。
5. 其他 Next 自有长请求。

### 兼容与安全

- 保留现有 preload 方法作为 facade，内部转到任务协议。
- renderer 不得传任意 channel、URL 或文件路径；主进程使用枚举和现有 allowlist。
- cancel 必须幂等；完成、取消和超时只能产生一个终态。
- 断网、主进程拒绝和 renderer 销毁都有确定性测试。

## M4：统一 Next 贡献协议

### 目标

借鉴 VS Code/DSH 的“注册即副作用”，但不引入完整插件容器。将 Next 内部应用、菜单、命令和设置入口统一为返回 disposer 的窄 Registry。

### 推荐模型

```js
const owner = nextSurfaceScope;
owner.own(registerApp(...));
owner.own(registerCommand(...));
owner.own(registerMenuItem(...));
owner.own(registerSettingsEntry(...));
```

`VCPFrontendPlugins` 保持上游接口和行为，不接入上述 Registry。插件 contribution、卸载和热重载若有需求，必须作为独立方案验证，不能由 Next Shell 生命周期隐式接管。

### 工作项

- 定义最小 `Disposable`：函数或 `{ dispose() }`，要求幂等。
- `MainChatCommands` 建立可枚举命令目录；Next presentation 调用命令，不点击 Classic DOM。
- Menu/App/Settings contribution 包含稳定 ID、owner、展示元数据和 action，不携带任意 HTML。
- Registry 注销时关闭仍打开的对应 UI，并删除恢复状态中的失效 contribution。
- Next contribution 的 disposer 必须幂等，并由创建它的 Next Scope 统一持有。

### 暂不开放

- 运行时安装任意远程前端代码。
- 无隔离的第三方 HTML/React 组件贡献。
- 前端插件 HMR；它不属于 Next UI 稳定化范围。

## M5：状态权威与显式订阅

### 目标

减少 `window.*`、DOM 查询和 MutationObserver 作为状态来源。业务状态由现有上游 manager/IPC 权威拥有，Next 通过 query、command 和 subscribe 读取，不复制第二份业务 Store。

### 优先状态域

- UI mode 与 transition state。
- Appearance profile、预览、保存和回滚。
- Embedded session 与 active action。
- 通知过滤、未读和侧栏状态。
- 助手/群组目录与当前选择。
- 主题模式和 Next 自有界面状态。

### 规则

- DOM 只表达 presentation，不作为可持久业务状态的权威来源。
- 新订阅必须返回 unsubscribe，并由 Scope 持有。
- 需要跨 surface 保持的交互状态才建立小型 Store；聊天、会话和连接等业务对象继续由上游 owner 管理。
- `global-settings-updated` 等兼容事件可保留 facade，但只能代理一个权威状态源。
- MutationObserver 只处理确实由上游动态生成且暂无显式事件的 host，并登记淘汰条件。

### 验收

- Next 不通过隐藏 Classic 控件 `.click()` 执行业务。
- 同一设置不会同时由 localStorage、DOM、全局变量和 IPC 各自决定。
- 快速保存、失败回滚和模式往返只发布一次有效状态变化。

## M6：VCPUI 与 Surface 收敛

### 目标

让 VCPUI 保持可替换 UI 内核，而不是演变成第二套业务框架。新建 Next 表面默认使用 `VCPUI.create()`；只有暂时无法抽出业务接口的上游表单才使用局部 `enhance()`。

### 工作项

- 为 Modal、Menu、Settings、List、Tabs 建立统一 mount/destroy/focus 契约。
- Surface 启动时一次性选择 Web Awesome 或 native fallback，不在同次 mount 中半途升级。
- 控件更新、销毁和迟到异步均验证 controller/owner 仍 active。
- 将仍存在的 document-wide UI 激活观察器改成显式 surface 事件或局部 host observer。
- Web Awesome 继续使用固定版本和可重复的 101 文件离线闭包；组件集合变化必须由 manifest 和生成器驱动。
- 无障碍门禁覆盖焦点恢复、Escape 栈、键盘导航、reduced-motion、invalid/disabled 状态和屏幕阅读语义。

### 禁止事项

- 不为视觉统一覆盖上游 Markdown、工具卡、日记、媒体等业务组件语义。
- 不在业务模块中直接创建 WA 标签或读取 WA 私有结构。
- 不通过全局 CSS 修补单个组件生命周期问题。

## M7：诊断、故障注入与持续门禁（已完成）

### 目标

把当前测试脚本中的生命周期诊断变成日常开发能力，让问题能够定位到 owner、资源类型、异步任务和原生 session。

### Lifecycle Inspector

开发模式提供只读诊断面板或控制台 API：

- Scope 所有权树、创建时间、状态和 dispose reason。
- 每个 Scope 的 listener、Observer、timer、subscription、task 和 contribution。
- 当前 overlay owners、active embedded action 和主进程 session。
- 最近的 mode transition、耗时、失败和 stale request。
- 已 disposing 超时的 owner 与仍未 settle 的任务。

生产构建不暴露可修改内部状态的接口，诊断数据不得包含 API Key、聊天正文或文件内容。

### 测试分层

- 每次提交：单元、静态边界、5 轮快速生命周期循环。
- PR：完整 UI、Classic 回归、打包和 20 轮 Electron 压力测试。
- 定期或发布前：30–60 分钟 soak、renderer crash/reload、网络抖动、系统休眠恢复和 GPU 环境验证。
- 所有历史竞态使用延迟/逆序/failure injection 确定性复现，不使用只依赖时间概率的测试。

### 不变量

- Classic 中动态 Next Scope 为零。
- 预热后 Scope 与受管资源在 checkpoint 完全相等。
- renderer/page/process/WebContentsView 不随循环次数增长。
- detached icon、option、Modal host 和 Overlay owner 不高于预热基线。
- 失败 disposer 可观测，但不阻断其他清理和模式收敛。

### 已交付证据

- `window.VCPLifecycleInspector` 汇总 Scope 树、资源年龄、超时 disposing owner、TaskHandle、贡献注册、状态订阅、Overlay、原生 session、最近模式事务和性能样本。
- 主进程诊断 IPC 只允许主 renderer 调用，只返回 action、任务身份和时长，不返回 API Key、聊天正文、路径或文件内容。
- Agent Prompt 模式按钮从每次 render 创建 15 个 listener 收敛为持久 host 上的 5 个委托 listener；恢复上游插件 Loader 后，20 轮压力测试 listener 固定为 405。
- 正常门禁不调用 Chromium 实验性的 `DOM.getDetachedDomNodes`，因为该命令会改变被测对象的原生包装器寿命；它仅保留为显式 debug 模式。常规门禁检查活动 Surface、heap、listener、Scope、资源、page、renderer process 和 WebContentsView。
- 完整 Electron 压力测试通过 3 次预热加 20 次测量，并包含 renderer reload、renderer crash、Overlay、Ask Nova、设置、Agent 设置、应用拖出和 Classic/Next 往返。

## M8：性能、安全和恢复能力（验证中）

### 性能

- 记录 Next mount、模式切换、设置打开、应用创建和原生 View 激活耗时。
- 避免 document subtree Observer、重复 DOM 全量查询和无变化 Select 重建。
- 为内嵌 session 设定明确数量和闲置策略，不能用无限创建掩盖恢复问题。
- Web Awesome 保持按需加载；启动页未使用的组件不进入首屏执行路径。

### 安全

- 所有新增 IPC 验证 sender、operation 枚举和参数边界。
- Renderer 不获得任意 Node、文件系统或 BrowserWindow 控制能力。
- Next contribution 使用数据和受限 action，不接受未净化 HTML、URL 或任意 channel。
- Ask Nova、Markdown 和外链继续执行安全渲染与 URL allowlist。

### 恢复

- renderer reload/crash 后由主进程 session 权威恢复标签，不重复创建 WebContentsView。
- 模式切换、窗口关闭和 app detach 在任一步失败后都能重新对账。
- 恢复策略必须有界，避免 crash/reload loop。
- 断网和服务未配置时保留主聊天可用，不让可选能力阻塞 Shell。

### 已交付证据

- `VCPPerformance` 使用 100 条有界环形历史记录 `next.mount`、`ui-mode.transition`、`settings.open`、`embedded.create` 和 `embedded.activate`；元数据只接受少量标量，不记录用户正文或凭据。
- 默认诊断预算分别为 500ms、1500ms、500ms、10000ms 和 500ms；超预算进入 Inspector，不在真实机器上用脆弱的绝对耗时直接阻塞功能。
- embedded IPC 继续验证主 renderer sender；action 必须来自中央 allowlist，请求 ID/operation 受长度与字符集约束，拖出坐标必须是绝对值不超过 1,000,000 的有限数。
- 同一窗口最多保留 6 个内嵌 `WebContentsView`；重复 action 复用既有 session，超过上限返回确定性错误，不创建第七个进程。
- renderer reload/crash 从主进程 session 权威恢复且不重复创建 View；60 秒内最多自动恢复 3 次，之后停止循环并提示用户。
- 系统 suspend 隐藏原生 View，resume 按最后的 active action 重新校准 bounds/visible；断网后的 Ask Nova 请求可在网络恢复后重新成功，不污染后续 target。

## M9：主聊天状态模型与差分验证

### 目标

把“主聊天在任意操作顺序后仍正确”定义成可执行模型，而不是继续为已知弹窗逐个编写固定脚本。Ask Nova、Appearance Studio 和内嵌应用是 Overlay/异步故障样本；测试权重必须以助手、群组、话题、消息、流式生成、输入区、左右侧栏和通知为主。

### 参考状态模型

```text
App
├── boot: fresh | unconfigured | ready | reconnecting
├── identity: no-selection | agent(id) | group(id)
├── topic: none | selected(id) | creating | deleting
├── conversation: empty | history | sending | streaming | cancelling | failed
├── shell: left-panel × right-panel × active-tab
├── overlay: none | settings | appearance | create | ask-nova | confirm
└── embedded: none | active(action) | hidden | crashed | recovering
```

状态模型只保存可观察业务事实，不复制应用实现。每个 action 定义前置条件、执行适配器、期望状态和 settle 条件；例如没有选中助手时不能发送，流式响应期间可以取消但不能产生第二个活动请求。

### 操作集合

- 主聊天高权重：选择/切换助手或群组、创建、切换/创建/删除话题、发送、停止、重新生成、加载历史、删除最后一条消息、附件和输入草稿。
- Shell 中权重：左右侧栏、通知、窄栏、搜索、主题、聊天显示模式、应用标签和设置。
- Overlay 低权重：Ask Nova、Appearance Studio、创建弹窗、确认框与 Escape 栈。
- 故障注入：IPC 延迟/拒绝/逆序返回、断网、renderer reload/crash、原生 View crash、系统 suspend/resume。

### 每步不变量

- 选中的助手/群组、标题、列表选中态和 manager 权威 ID 一致；任意时刻只有一个活动会话和话题。
- 空状态只在“没有真实消息且没有发送/流式任务”时出现，不能覆盖历史或首条流式消息。
- 输入区只有一个，发送产生至多一个活动请求；停止后任务、按钮和流式状态最终一致。
- 左右面板的可见性、宽度、`aria` 状态和实际 bounds 一致，拖拽不能产生负数或不可恢复宽度。
- Escape 只关闭当前最上层 Overlay/子页面，不能级联关闭主窗口；Overlay owner 最终归零。
- 活动应用标签与主进程可见 `WebContentsView` 一致；关闭、崩溃和恢复不产生重复 session。
- 到达 quiescent checkpoint 后，Scope、listener、IPC Task、Overlay owner、活动 DOM、WebContentsView、renderer/page/process 不随序列增长。

### 执行与可重放

- 使用固定 seed 的轻量序列生成器，不因测试引入完整应用框架；失败时输出 seed、最短操作 trace、模型状态和真实 snapshot。
- 先执行前置条件过滤，再通过事件、状态订阅或显式 `whenSettled()` 等待；禁止用固定 sleep 猜测完成。
- 自动缩短失败 trace：删除操作块并重放，直到获得仍可复现的最短序列。
- 双布局阶段对同一 trace 运行 Classic 和 Next，比较业务 snapshot 而不是像素；布局区域完成收敛后改为唯一实现的模型验证。

### 测试分层

- 每次提交：纯模型与 controller 测试，数百条短序列。
- PR：真实 Electron 运行固定回归 seed 加 10–20 条生成序列。
- 定期/发布前：30–60 分钟长序列、GPU、休眠和断网；失败 seed 永久加入回归集合。

## M10：共享业务契约收口

- 以 M9 的业务 snapshot 作为 oracle，将剩余入口收敛到 `command / query / subscribe`。
- 把通知清理、主题状态、助手/群组选择、设置导航等仍含 DOM 业务逻辑的 command 移到对应 manager/service。
- 为聊天列表、输入区、助手列表、话题列表、通知列表和设置内容定义稳定 host；布局只摆放业务 surface，不成为状态权威。
- 前端插件 Loader 和插件行为保持上游边界；本路线不增加插件专属场景，也不借布局或操作序列测试改造插件运行方式。
- 建立依赖门禁，禁止新的 `presentation -> 隐藏控件`、`business -> nextUi*` 和 renderer 任意 IPC channel 依赖。

## M11：区域级布局收敛

布局按区域合并，不做一次性 Classic 删除：

1. 主聊天与输入区：保留上游消息、工具、附件和流式语义，统一空状态和输入控制器。
2. 左侧栏：统一助手/群组、话题、搜索、创建、窄栏和账户入口的 DOM 与行为。
3. 顶栏：统一窗口、主题、显示模式和应用标签入口。
4. 右侧栏：统一通知数据、过滤、清空、拖拽和快捷操作。
5. 设置：统一 navigation、表单 host、Appearance Studio 和保存/回滚事务。
6. Overlay/应用：统一 Escape 栈、焦点、AppTabHost 和原生 View 对账。

每个区域遵循同一循环：冻结 Classic/Next 行为 snapshot → 选择最终结构与交互 → 两种模式临时路由到同一实现 → 运行 M9 序列 → 删除该区域重复实现。Classic 中仍值得保留的密度、颜色或紧凑观感进入 Appearance preset，而不是继续维持第二套布局。

## M12：单一布局切换

- 全部区域收敛后，`uiMode` 不再选择两套 DOM；布局设置只剩唯一规范布局，外观差异由主题、密度和 Appearance profile 表达。
- 旧 `uiMode` 配置做无损迁移，保留主题、壁纸、侧栏宽度、字体和聊天数据；不静默重置用户外观。
- `uiModeManager` 收缩为兼容读取与一次性迁移，模式 preview/切换事务和子页面广播按真实调用方逐步退出。
- 回滚依赖上一稳定安装包和向后兼容配置，不在生产包中永久隐藏第二套 Shell。
- 主 Shell 收敛不强迫 Notes、Translator 等独立页面在同一提交完成迁移。

## M13：分叉清理与长期门禁

- 在调用方归零后删除重复 DOM、条件 CSS、Classic/Next facade 和只验证双模式往返的测试。
- `nextUi*` ID、`.next-ui-*` class 和模块名最后单独机械重命名；不与功能收敛混在同一提交。
- 根 Shell 使用页面级 owner，Modal、Menu、App Tab、Overlay 和原生 View 继续使用动态子 Scope。
- 固定唯一布局的启动、内存、listener、进程与 WebContentsView 基线，M9 状态序列成为长期回归门禁。
- 产品和代码命名最终从 “Next UI” 收敛为普通 “VCPChat UI”。

## 建议 PR 序列

每个 PR 只改变一个可验证关系，并从最新上游分支开始同步：

1. 当前生命周期基线与文档。
2. 提取 `OverlayCoordinator`，不改变视觉。
3. 提取 `EmbeddedAppController` 与 session 对账。
4. 提取 `AppTabHost`，保留 `topTabManager` facade。
5. 提取 Launchpad/Creation/Account/Search controller。
6. Ask Nova 可取消任务协议。
7. Embedded app 可取消任务协议与主进程任务 owner。
8. Command/Menu/App/Settings contribution disposer。
9. 状态权威与全局 Observer 减法。
10. Lifecycle Inspector 与 CI 分层。
11. 性能、安全和恢复专项。
12. 主聊天纯状态模型、snapshot oracle 和固定 seed runner。
13. Electron 操作适配器、故障注入、trace 重放与最小化。
14. 共享业务契约和插件 DOM 锚点收口。
15. 主聊天、左栏、顶栏、右栏、设置和应用区域分别收敛。
16. 单一布局配置迁移与完整发布验证。
17. `nextUi*` 命名、兼容 facade 和条件 CSS 的独立机械清理。

模块拆分 PR 不夹带视觉调整；协议 PR 不夹带 Web Awesome 升级；功能对等回归修复不借机重写上游业务组件。每个 PR 必须可以独立 revert，并在 PR 描述中列出用户可见变化、生命周期 owner、失败策略和验证命令。

## 新功能 Definition of Done

任何新的 Next 功能在合并前必须回答：

1. 业务状态的权威 owner 是谁？
2. UI surface 的 Scope 是谁，何时 dispose？
3. listener、Observer、timer、IPC subscription、Object URL 和注册贡献归谁？
4. 异步请求如何取消，迟到结果如何失去提交权？
5. Overlay 与原生 WebContentsView 如何对账？
6. 该功能是否只依赖共享业务契约，所在区域收敛后是否无需 Classic/Next 模式分支？
7. Web Awesome 失败时 native fallback 是否完整？
8. setup 中途失败如何回滚已取得的资源？
9. 是否有 register → use → dispose → absent、快速往返和失败注入测试？
10. 是否改变用户数据或 IPC；若改变，迁移与回滚是什么？插件协议禁止在本路线中改变。

无法回答其中任一项时，功能仍处于原型阶段，不进入上游 PR。

## 当前推荐的下一步

1. 当前稳定性 PR 冻结构，只接收操作序列稳定复现的 P0/P1 修复。
2. M9 的第一阶段已落地：主聊天纯模型、seed/trace/minimizer、真实 Electron adapter 和受控 JSON/SSE fixture 已能发现并回归选择与流式竞态。
3. 下一阶段补齐 hold/fail/disconnect、reload/crash、IPC 逆序完成和失败工件，再执行资源斜率长测；不扩大到插件专属行为。
4. 用同一业务 trace 对照 Classic/Next；每收敛一个布局区域，就把该区域从差分测试切换为唯一实现的模型测试。
5. 区域全部收敛并通过完整发布验证后，再迁移 `uiMode` 并清理分叉、兼容 facade 与 `nextUi*` 命名。
