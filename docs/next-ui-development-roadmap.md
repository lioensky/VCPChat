# Next UI 完整开发路线

## 文档定位

本文是 VCPChat Next UI 后续演进的总路线。它规定阶段顺序、模块边界、合并门槛和长期收敛方向，不替代具体子系统文档：Web Awesome 的加载、定制和离线闭包由 [`next-ui-webawesome-roadmap.md`](./next-ui-webawesome-roadmap.md) 负责，动态资源所有权和竞态规则由 [`next-ui-lifecycle-architecture.md`](./next-ui-lifecycle-architecture.md) 负责，上游 PR 的减法边界由 [`design-system-upstream-pr-convergence.md`](./design-system-upstream-pr-convergence.md) 负责。

当前实现基线已推进至 M8：Classic 默认，Next 可选；Classic / Next 功能对等整改由 [`upstream-function-parity.md`](./upstream-function-parity.md) 持续回归；动态 Next 表面已接入 `LifecycleScope`，模式切换已串行化，Next App 与前端插件注册可撤销，并具备可取消任务、权威状态订阅、只读生命周期诊断、性能预算、受限原生 session 和真实 Electron 恢复/压力门禁。

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
- 不在没有卸载、异常和资源归零测试前开放前端插件热重载。
- 不同时进行模块拆分、视觉重设计、Vendor 更新和业务协议修改。
- 不以测试阈值放宽代替泄漏根因修复。

## 阶段总览

| 阶段 | 目标 | 进入条件 | 退出证据 |
|---|---|---|---|
| M0 | 生命周期稳定基线 | 已完成 | 20 轮 Electron 压测资源恒定 |
| M1 | 发布前稳定化（已完成） | M0 | 竞态矩阵和稳定性门禁通过 |
| M2 | 拆分 Next Shell 协调器（已完成） | M1 | `topTabManager` 退化为兼容 facade |
| M3 | 可取消异步与 IPC 任务（已完成） | M2 的 Overlay/Embedded 边界稳定 | 请求可取消，迟到结果无提交权 |
| M4 | 统一贡献与前端插件协议（已完成） | M3 | App/Menu/Command/Setting 注册均可撤销 |
| M5 | 状态权威与显式订阅（已完成） | M2–M4 | 无新增隐藏 DOM 代理和全局扫描 |
| M6 | VCPUI 与 Surface 收敛（已完成） | M5 | Next 自有表面统一 create/fallback 生命周期 |
| M7 | 诊断、故障注入与持续门禁（已完成） | 与 M2–M6 同步 | 可定位 owner、任务和原生 session |
| M8 | 性能、安全和恢复能力（已完成） | M3、M7 | 崩溃、休眠、断网与长时运行可恢复 |
| M9 | Classic 去留决策 | M1–M8，功能对等已完成 | 有稳定性和维护成本证据决定继续并行或覆盖 Classic |

M2–M7 可以按小 PR 交错推进，但不能跳过各自进入条件。M9 是产品决策，不由代码完成度自动触发。

## M0：生命周期稳定基线（已完成）

### 已交付

- `LifecycleScope` 与资源诊断。
- Ask Nova、Appearance Studio、设置增强、应用标签、创建弹窗、应用托盘和前端插件的 owner。
- 可撤销 Next App/前端插件 Registry。
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
5. 前端插件 discovery 和其他长请求。

### 兼容与安全

- 保留现有 preload 方法作为 facade，内部转到任务协议。
- renderer 不得传任意 channel、URL 或文件路径；主进程使用枚举和现有 allowlist。
- cancel 必须幂等；完成、取消和超时只能产生一个终态。
- 断网、主进程拒绝和 renderer 销毁都有确定性测试。

## M4：统一贡献与前端插件协议

### 目标

借鉴 VS Code/DSH 的“注册即副作用”，但不引入完整插件容器。将 Next 内部应用、菜单、命令和设置入口统一为返回 disposer 的窄 Registry。

### 推荐模型

```js
const owner = pluginContext.scope;
owner.own(registerApp(...));
owner.own(registerCommand(...));
owner.own(registerMenuItem(...));
owner.own(registerSettingsEntry(...));
```

现有 `VCPFrontendPlugins.register(id, instance)` 保持布尔返回兼容。新能力通过附加 API 和 `getScope(id)` 提供，不能破坏动态壁纸、Auto TTS 或第三方插件的既有启动路径。

### 工作项

- 定义最小 `Disposable`：函数或 `{ dispose() }`，要求幂等。
- `MainChatCommands` 建立可枚举命令目录；Next presentation 调用命令，不点击 Classic DOM。
- Menu/App/Settings contribution 包含稳定 ID、owner、展示元数据和 action，不携带任意 HTML。
- Registry 注销时关闭仍打开的对应 UI，并删除恢复状态中的失效 contribution。
- 插件开发文档要求 `destroy()` 幂等；外部卸载使用 Loader `unregister()`，不直接调用实例 `destroy()`。

### 暂不开放

- 运行时安装任意远程前端代码。
- 无隔离的第三方 HTML/React 组件贡献。
- 前端插件 HMR。只有 register → use → unregister → absent、失败 setup 回滚和重复 reload 测试全部具备后，才单独评估 HMR。

## M5：状态权威与显式订阅

### 目标

减少 `window.*`、DOM 查询和 MutationObserver 作为状态来源。业务状态由现有上游 manager/IPC 权威拥有，Next 通过 query、command 和 subscribe 读取，不复制第二份业务 Store。

### 优先状态域

- UI mode 与 transition state。
- Appearance profile、预览、保存和回滚。
- Embedded session 与 active action。
- 通知过滤、未读和侧栏状态。
- 助手/群组目录与当前选择。
- 主题模式、壁纸可见性和插件状态。

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
- PR：完整 UI、Classic 回归、插件、打包和 20 轮 Electron 压力测试。
- 定期或发布前：30–60 分钟 soak、renderer crash/reload、网络抖动、系统休眠恢复、GPU/视频壁纸和插件组合。
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
- Agent Prompt 模式按钮从每次 render 创建 15 个 listener 收敛为持久 host 上的 5 个委托 listener；20 轮压力测试 listener 固定为 426。
- 正常门禁不调用 Chromium 实验性的 `DOM.getDetachedDomNodes`，因为该命令会改变被测对象的原生包装器寿命；它仅保留为显式 debug 模式。常规门禁检查活动 Surface、heap、listener、Scope、资源、page、renderer process 和 WebContentsView。
- 完整 Electron 压力测试通过 3 次预热加 20 次测量，并包含 renderer reload、renderer crash、Overlay、Ask Nova、设置、Agent 设置、应用拖出和 Classic/Next 往返。

## M8：性能、安全和恢复能力（已完成）

### 性能

- 记录 Next mount、模式切换、设置打开、应用创建和原生 View 激活耗时。
- 避免 document subtree Observer、重复 DOM 全量查询和无变化 Select 重建。
- 为内嵌 session 设定明确数量和闲置策略，不能用无限创建掩盖恢复问题。
- Web Awesome 保持按需加载；启动页未使用的组件不进入首屏执行路径。

### 安全

- 所有新增 IPC 验证 sender、operation 枚举和参数边界。
- Renderer 不获得任意 Node、文件系统或 BrowserWindow 控制能力。
- 插件 contribution 使用数据和受限 action，不接受未净化 HTML、URL 或任意 channel。
- Ask Nova、Markdown 和外链继续执行安全渲染与 URL allowlist。

### 恢复

- renderer reload/crash 后由主进程 session 权威恢复标签，不重复创建 WebContentsView。
- 模式切换、窗口关闭和 app detach 在任一步失败后都能重新对账。
- 恢复策略必须有界，避免 crash/reload loop。
- 断网、服务未配置和插件失败时保留主聊天可用，不让可选能力阻塞 Shell。

### 已交付证据

- `VCPPerformance` 使用 100 条有界环形历史记录 `next.mount`、`ui-mode.transition`、`settings.open`、`embedded.create` 和 `embedded.activate`；元数据只接受少量标量，不记录用户正文或凭据。
- 默认诊断预算分别为 500ms、1500ms、500ms、10000ms 和 500ms；超预算进入 Inspector，不在真实机器上用脆弱的绝对耗时直接阻塞功能。
- embedded IPC 继续验证主 renderer sender；action 必须来自中央 allowlist，请求 ID/operation 受长度与字符集约束，拖出坐标必须是绝对值不超过 1,000,000 的有限数。
- 同一窗口最多保留 6 个内嵌 `WebContentsView`；重复 action 复用既有 session，超过上限返回确定性错误，不创建第七个进程。
- renderer reload/crash 从主进程 session 权威恢复且不重复创建 View；60 秒内最多自动恢复 3 次，之后停止循环并提示用户。
- 系统 suspend 隐藏原生 View，resume 按最后的 active action 重新校准 bounds/visible；断网后的 Ask Nova 请求可在网络恢复后重新成功，不污染后续 target。

## M9：Classic 去留决策

### 已完成的功能对等基线

Classic / Next 的入口和交互对等整改已经完成，权威清单见 [`upstream-function-parity.md`](./upstream-function-parity.md)。下列能力不再是待开发项目，而是后续每个阶段都必须保持的回归基线：

- 左键、右键、长按和悬停语义。
- 快捷入口的位置和可发现性，而不仅是功能在某个菜单中存在。
- 通知、主题、聊天显示模式、壁纸和应用托盘。
- 助手/群组创建、搜索、选择、设置和模型状态。
- 输入区、消息结构化内容、附件、工具、日记和流式状态。
- 窄侧栏、左右面板、窗口控制、键盘和无障碍行为。
- 无配置、首次配置、断网、失败和恢复路径。

新增功能若只存在于 Next，必须明确属于 Next 的增量能力；上游 Classic 原有能力则不得在拆分或协议演进中退化。自动门禁与真实 Electron 人工检查继续共同执行，不能因为“已完成功能对等”而删除回归矩阵。

### 决策门槛

在以下条件全部满足前，Classic 保持默认：

- 已完成的功能对等清单持续无 P0/P1 回归。
- 至少一个完整发布周期没有资源增长或主窗口卡死类回归。
- 上游作者和实际用户完成真实工作流验证。
- Classic/Next 双维护成本已经高于迁移成本，并有明确回退方案。

满足门槛后只有两种明确选择：

1. 继续并行：Classic 是长期产品选项，两套 presentation 都进入正式测试矩阵。
2. Next 覆盖 Classic：先把共享业务接口稳定，再分阶段删除 Classic presentation；不保留隐藏 Classic DOM 作为永久后端。

不能长期处于“Next 默认但依赖隐藏 Classic、Classic 又无人维护”的中间状态。

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
12. 功能对等回归复核；Classic 决策单独提案，不再安排一轮功能补做。

模块拆分 PR 不夹带视觉调整；协议 PR 不夹带 Web Awesome 升级；功能对等回归修复不借机重写上游业务组件。每个 PR 必须可以独立 revert，并在 PR 描述中列出用户可见变化、生命周期 owner、失败策略和验证命令。

## 新功能 Definition of Done

任何新的 Next 功能在合并前必须回答：

1. 业务状态的权威 owner 是谁？
2. UI surface 的 Scope 是谁，何时 dispose？
3. listener、Observer、timer、IPC subscription、Object URL 和注册贡献归谁？
4. 异步请求如何取消，迟到结果如何失去提交权？
5. Overlay 与原生 WebContentsView 如何对账？
6. Classic 是否完全不挂载该 surface，或者共享 DOM 如何恢复原身份？
7. Web Awesome 失败时 native fallback 是否完整？
8. setup 中途失败如何回滚已取得的资源？
9. 是否有 register → use → dispose → absent、快速往返和失败注入测试？
10. 是否改变用户数据、插件协议或 IPC；若改变，迁移与回滚是什么？

无法回答其中任一项时，功能仍处于原型阶段，不进入上游 PR。

## 当前推荐的下一步

1. 冻结构，只接收真实测试发现的稳定性修复；继续运行发布前 30–60 分钟 soak、GPU/视频壁纸和第三方插件组合测试。
2. 将快速单元/边界门禁用于每次提交，将 20 轮 Electron 压测、打包与 Classic 回归用于 PR。
3. 保持 Classic 默认和 Next 可选至少一个完整发布周期，收集真实用户的崩溃、恢复和维护成本证据。
4. M9 由上游作者与产品验证共同决定；无论继续双布局还是由 Next 覆盖 Classic，都不得恢复隐藏 DOM click 代理或第二份业务状态。
