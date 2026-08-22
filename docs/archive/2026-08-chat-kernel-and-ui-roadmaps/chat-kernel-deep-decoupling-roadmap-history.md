# VCPChat Chat Kernel 深度解耦路线

> 归档说明（2026-08-21）：本文保存 D0-D7 的施工历史和阶段增量，包含已经过期的中间测试数字，不再作为当前执行状态权威。当前合同见 `../../chat-kernel-deep-decoupling-roadmap.md`，当前证据见 `../../chat-kernel-vd7-final-audit.md`。

> vD5/vD6 最终收口（2026-08-21）：vD5、vD6 已达到范围内退出条件，vD7 仍为 BLOCKED。`renderer.js` 现只承担主聊天 composition/lifecycle orchestration；设置/presentation、主题、TTS、Flowlock、辅助 preload 事件、forward、DOM listener、附件瞬态状态和发送/中止策略均由 named owner 持有，所有 owner 按注册逆序等待 dispose。仓内已停止发布和读取 `window.globalSettings`、presentation helpers、`window.checkMessageFilter` 与 bubble-layout helper；保留冻结且不可替换的 `window.VCPMainChatState`、`window.MainChatCommands`、`window.VCPAppearanceStudio` 公共 facade，并由 consumer ledger 记录 owner、生产消费者、动态 smoke 和退役条件。consumer report 另清点 164 个 Classic/feature-local ambient facade 名称作为兼容债务，故 vD6 不表示全仓 `window.*` 清零。最终当前主机矩阵为 `artifacts/windows-matrix/2026-08-21T06-13-58-840Z.json`，六行通过；本轮最新自动化为 Chat Kernel 140/140、UI System 88/88。缺 30-60 分钟人工 soak 和跨 Windows/打包/GPU-DPI 证据，不能宣称 D0-D7 最终完成。

> 行为等价基线（2026-08-21）：未登记差异默认视为回归。当前自动化覆盖主聊天发送/流式/取消/重试、历史与 topic restore、附件、设置/主题/presentation、通知、desktop push、Voice/Rust、Next/Classic 与插件命令入口，并比较 terminal/persistence、DOM、焦点/ARIA、listener/resource 和 crash/reload 终态。本轮真实 Electron 发现 startup restore 在 topic DOM consumer 完成前返回；已让 `ChatManager.selectItem()` 等待 topic projection 并在等待后重检 selection generation，focused regression 与真实序列通过。首轮最终矩阵另记录一次 Puppeteer protocol timeout；随后完整串行矩阵通过，该超时只作为测试基础设施波动证据保留。

> 当前证据增量（2026-08-20）：Chat Kernel 129/129，UI System 86/86；lifecycle stress 3 warmup + 60 measured 稳定；辅助窗口 reload 与三轮 crash recovery 真实序列通过（每轮 opt-in，合计 72 actions / 42 requests）。以下较早数字均为历史追溯记录，不能覆盖当前状态；D7 仍未完成。

> Windows 矩阵增量（2026-08-20）：新增 `npm run test:windows-matrix`，当前 Windows 主机六项串行入口全部通过；证据写入 `artifacts/windows-matrix/`。这只是当前主机的可重复矩阵，不是多版本 Windows/安装包矩阵，也不替代 30–60 分钟人工 soak。

> vD5 增量（2026-08-20）：`MainChatSettingsOwner` 已接管主窗口 settings 对象的 replace/update/ref/snapshot/dispose；`MainChatThemeOwner` 已接管初始主题与 presentation transition/persistence/rollback；`DomListenerOwner` 已收口 presentation quick switcher、字体/布局/用户气泡设置控件、emoticon trigger、quick-new-topic bridge 以及 `setupEventListeners` 的主聊天消息区/发送/输入/附件 listener，并纳入 renderer teardown。global-settings UI 语义保持不变，Electron UI Apps 24/24 复跑通过。Flowlock 与 forward 迁移后的 renderer 内联实现已物理删除，consumer guard 与主聊天 24-action 复跑通过。辅助窗口 held-stream reload 与 opt-in crash-recovery 场景已加入主聊天序列并通过（crash 矩阵三轮合计 72 actions / 42 VCP requests）；lifecycle stress 当前通过 3 warmup + 60 measured，资源指标稳定。当前 Chat Kernel 为 129/129，D7 仍未完成。

> 状态（2026-08-20，复核）：D0、D1 已完成；D2、D3 已具备真实协调器、operation identity、主聊天/独立 Surface/辅助窗口消费者和 Electron 终态证据。StreamProjection 已按 Surface 工厂化，每个 Surface 拥有独立 DOM projection、固定 conversation identity、terminal route 和 quiescent dispose；独立聊天不再读取主窗口 selection/history。D4 已建立 RenderDependencies、SurfaceConversation 和显式 DOM realm/service capability closure。近期增量已加入 operation-scoped projection runtime、owned realm scheduling、Loom/VCP log/status、agent-settings reload、history watcher、group-topic 和 Flowlock 的 owned subscription teardown、嵌入应用 stale session 对账，并收紧 MessageRenderer 的 root/style owner；StreamProjection 现在要求 owning root、显式 view authority 和 transient history provider。D5 正在进行：MainChatSurfaceAdapter 已组合主聊天 stream/operation 生命周期，主窗口发送状态由真实 stream consumer 的 terminal settlement 更新，不再由 DOM projection 反向控制；TtsSurfaceOwner 已接管生产 TTS 状态和订阅，MainChatAuxiliaryEventOwner 已接管 Loom/VCP log/status/group-topic，MainChatFlowlockOwner 已接管 Flowlock command/request 和 RPC 响应，ForwardMessageOwner 已接管 forward modal、目标选择、原始消息读取和附件转发，renderer.js 仍保留主题、设置、Electron 和部分事件 wiring。D6 已删除三个旧全局 facade、全部 legacy history IPC fallback、`initStreamManager` 命名的伪单例入口、生产 `window.ensureAudioContext`、无消费者的 `window.showForwardModal` 与 `window.setChatPresentationMode`；剩余 renderer legacy methods、完整 operation identity 下沉和 ambient DOM 路径仍待收口。D7 未完成。最新本地复核：Chat Kernel 129/129、UI System 85/85、`guard:next-delta` 和 `guard:chat-kernel-consumers` 通过；`npm run test:electron-ui-apps` 24/24 通过，`npm run test:electron-lifecycle-stress` 3 warmup + 60 measured 通过，辅助窗口 crash/reload opt-in 三轮合计 72 actions / 42 requests，主聊天 24-action 通过。辅助窗口更长矩阵、完整 Windows 矩阵、30–60 分钟人工 soak 和 D7 逐项审计仍未完成，不能宣称 D7 或最终解耦完成。
> 规范依据：`C:\VCP\vchat-develop\deepseek-harness\AGENTS.md`、`docs/event-producer-consumer.zh.md`、`docs/defensive-patterns.zh.md` 和 `.agents/skills/dsh-code-review/SKILL.md`。

> vD0–vD7 对抗式复核已记录在 [`chat-kernel-vd-roadmap-review.md`](./chat-kernel-vd-roadmap-review.md)。该复核将 D5 的退出对象收紧为 composition-root responsibility，而不是文件大小；静态 consumer report、单元测试和历史 Electron 记录不能单独证明真实消费者或最终边界。2026-08-20 已修复 `renderer.js:558` 的 TTS capability 作用域错误并通过 Electron UI Apps 24/24、lifecycle stress 3 warmup + 60 measured；辅助窗口 crash/reload 多轮证据、renderer owner 迁移和人工 soak 仍未闭合。

## 目标

把当前仍依赖 `window.*`、固定 DOM、Electron API 和主窗口单例的聊天实现，逐步收敛为三个可验证层：

```text
Chat Domain
├── ChatContext / repository
├── StreamSession
└── durable history and domain events

Content Runtime
├── message normalization
├── protocol transforms
└── immutable render model

Surface Adapter
├── DOM projection
├── input/focus/ARIA
├── theme and slots
└── owner-scoped teardown
```

目标不是删除主窗口或重写消息协议，而是让同一份领域结果可以被主聊天、只读聊天和交互聊天分别消费。`renderer.js` 最终只应负责组装主窗口依赖和 Surface，不再拥有流式业务状态；`messageRenderer.js` 最终只应负责 DOM 投影，不再读写主窗口全局状态。

## 当前耦合审计

D0 的可重复基线由 `npm run guard:chat-kernel-consumers` 生成到 `docs/chat-kernel-consumer-report.json`。该报告把生产入口和测试入口分开列出；报告中的生产引用不是删除清单，而是后续迁移的消费者责任表。

### renderer.js / messageRenderer.js

- `renderer.js` 仍然是主窗口 composition root，同时把固定 DOM、`window.*` facade、Electron API、主题、设置、聊天管理和事件监听连接在一起。
- `messageRenderer.js` 仍通过 `mainRendererReferences` 读取 history、selected item、settings、Electron API 和主窗口 helper；它虽支持显式 root，但不是纯 renderer adapter。
- `chatManager.js` 仍同时负责选择、历史、文件、VCP 请求、业务副作用、DOM 查询和全局按钮状态。
- `window.chatManager`、`window.messageRenderer`、`window.streamManager` 已完成生产迁移并删除；consumer gate 对全生产源码做负向扫描并对 compatibility-global 计数强制为零。其他 renderer legacy methods 仍需逐项审计，不能把三个 facade 的退役误认为 renderer 已纯化。

### StreamManager

`modules/renderer/streamManager.js` 当前拥有每个 StreamProjection 的短生命周期 DOM 投影状态；实时 transport、durable commit 和 Desktop push 已由其他 owner 负责。仍需继续收口的风险是：

- MessageRenderer 的流式 DOM 更新、chunk 队列和 Surface-local active state；
- legacy render helper 的少量主窗口引用；
- Surface-owned scroll/animation and realm access.

这不是单纯的“文件太长”问题，而是多个 owner 共用一组可变状态。后续拆分必须先建立事件和 owner 语义，再移动代码。

## Harness 对应原则

1. **持久事实与实时协调分离**：可回放的消息/流终态进入 history repository；发送按钮、取消、重试和当前运行状态属于实时 Surface 协调，不混入持久 history。
2. **Definition / Provider / Consumer 同时存在**：每个新 session、event 或 service 都必须列出生产方、真实生产消费者和测试入口；只有测试调用的 facade 不得进入公共面。
3. **事件不是万能状态**：事件传递事实变化，不替代当前 snapshot；每个事件必须有明确顺序、终态和丢弃规则。
4. **dispose 达到 quiescence**：取消只表示请求停止；Surface dispose 必须等待 reader、render queue、history save 和 desktop push 的 owner work 停稳，迟到事件保持静默。
5. **跨边界显式注入**：Domain 不读取 `document`、`window` 或 Electron；DOM、通知、焦点和桌面能力由 Surface capability closure 注入。
6. **先迁移消费者再删除 facade**：旧 facade 只有在生产搜索、动态入口和 Electron smoke 都证明没有消费者后才能删除。

## 分阶段计划

| 阶段 | 施工内容 | 必须保留的行为 | 退出证据 |
| --- | --- | --- | --- |
| D0 基线冻结 | 记录 renderer/stream 的调用图、状态变量、事件、定时器、Electron API 和 owner；为每个出口标记 production/test/legacy | 主聊天现有发送、流式、切换、历史、附件行为 | 静态 consumer report、主聊天 24-step、生命周期 baseline |
| D1 Stream protocol | 新建纯函数 `StreamSession`/`StreamState`：`start → chunk → terminal/error/cancel → persist`；只处理 request identity、generation、terminal arbitration 和 immutable events | SSE 解析、chunk 顺序、完成/失败/取消语义不变 | unit 覆盖逆序、重复 terminal、断线、取消、迟到 chunk；无 DOM/Electron import |
| D2 Stream coordinator | 将 reader、AbortController、session registry、per-topic save queue 移入 coordinator；按 session owner 管理 desktop push 和 history persistence | 当前 topic 切换、后台流、并发逆序保存和 retry | 真实 VCP Electron fixture；每个终态等待真实 Promise；dispose 后 active sessions/readers/queues 为 0 |
| D3 Stream consumers | 主聊天和独立 Surface 分别订阅 stream events，转换为各自 render command；发送按钮、通知、桌面 push 由明确 consumer 消费 | 主窗口按钮、通知、桌面 push、流式 DOM 与现状一致 | producer/consumer matrix；缺 consumer 的 event gate 失败；主聊天与独立 Surface 双入口通过 |
| D4 Renderer capability closure | 将 `messageRenderer` 的 marked/settings/helper/electron 依赖收窄为显式 `RenderDependencies`；root、history snapshot、message model 作为参数 | Markdown、工具结果、附件、Mermaid、媒体、编辑和清理行为不变 | Content/DOM 分层测试；renderer adapter 不访问全局 selected/history；静态 gate 禁止新增 `window.*` |
| D5 Main Chat Adapter | 将 `renderer.js` 的 composition、固定 DOM 查询、事件绑定和主窗口 helper 组装到 `MainChatSurfaceAdapter`；ChatManager 只保留 domain commands | 主窗口布局、键盘、主题、设置、通知、插件 Loader 行为不变 | Electron 主聊天完整序列、真实键盘/ARIA 终态、reload/crash recovery、owner diagnostics 稳定 |
| D6 Facade retirement | 迁移 `window.streamManager`、`window.chatManager`、renderer legacy methods 的生产调用者；为保留的兼容调用增加明确 owner/期限 | 仅保留确有生产消费者的兼容入口；测试夹具显式 opt-in | consumer search + dynamic smoke；无生产引用的 facade、字段和 preload API 删除 |
| D7 Final boundary | 删除重复 state/cache、合并唯一 terminal/persistence authority、更新架构和门禁 | 所有 D0 行为矩阵保持；不迁移业务子页面、不改变插件协议 | 全部 Windows 矩阵、30–60 分钟人工 soak、P5 稳定周期入口；文档与 gate 同步 |

## D0–D2 当前施工（部分完成，尚未 exit-ready）

`modules/chat/streamSession.js` 是纯协议层，只负责 session identity、chunk 顺序、四种终态归一化、单终态仲裁和 subscriber 隔离；不读取 DOM、Electron、history 或 desktop push。`modules/chat/streamCoordinator.js` 负责 owner-scoped 实时协调：私有 lease 决定提交权，同一 topic 的不同 message 可并发，直接 Coordinator consumer 可用 replacement identity 撤销旧 attempt；VCP Bridge 将生产 message id 视为单次身份，不提供同 id retry。per-conversation persistence queue、AbortController、owned cleanup 与 `done`/`dispose()` 均等待真实 Promise，不提供全局 registry、Store 或 `whenIdle()`。

D2 的公共 terminal 只在 transport 停稳和 persistence settle 后发布一次。持久化失败形成唯一 `failed` outcome，并保留原 transport outcome 作为只读证据。`ChatHistoryPersistence` 负责 repository read、按 message identity 合并、过滤 renderer-owned pending entry 和 durable write；Coordinator 负责 per-conversation serialization。StreamManager 不再暴露 durable commit 或 legacy finalize facade。投影失败不会以 completed no-op 结束，缺失 initialization 会释放活动消息并进入 persistence failure。StreamManager 仍拥有 `pending/ready/finalized` DOM/history 投影状态，因此全仓唯一 terminal authority 尚未达到退出条件。

## D3-D6 当前施工（vD5/vD6 exit-ready，vD7 未完成）

- 主窗口 preload 事件进入 `VcpStreamBridge → StreamCoordinator → MainChatStreamConsumer`，旧 `renderer.js` 的 start/data/end/error switch 已删除；VoiceChat 和 Rust Assistant 已接入辅助窗口 runtime，Flowlock streaming 由主窗口 bridge 消费。重新生成和本地中止兜底也进入同一 Bridge operation，不再直接启动或 finalize StreamManager。独立交互 Surface 继续共用主窗口 transport，但拥有独立 root、operation-specific `done/cancel` 和可撤销 route lease；主窗口切换话题不会撤销独立 root 的投影权，独立取消也不会中止并发的主窗口请求。它尚未拥有独立 transport coordinator。
- `RenderDependencies` 取代带静默默认值的可变引用袋；root、state refs、repository、transport、Markdown、feedback、DOM realm、Pretext、Flowlock 和 commands 在 mount 时显式提供并冻结。`messageRenderer` 的主渲染路径已消费这些 capability，但仍有少量历史 DOM/兼容调用待 D5/D6 审计。辅助窗口现在显式提供短会话 `MemoryChatRepository`，不再依赖缺失 repository 的静默 fallback。
- `MainChatSurfaceAdapter` 已组合主聊天 Surface、stream route、bridge、capability provider 与 teardown；终态副作用和错误 DOM 已从 `renderer.js` closure 移入 adapter。群聊已持久化的 `full_response`/`remove_message` 事件由显式 `NonStreamingEventConsumer` 消费。`renderer.js` 只保留 DOM 查询、capability/provider 构造、manager/owner/adapter 装配、mount 与逆序 dispose；主题、设置/presentation、TTS、Flowlock、辅助事件、forward 和 DOM listener 均有 named owner。D5 已通过责任门禁与真实 Electron 验收。
- pending assistant、后台历史读取、reply ordering 和终态 message model 已移入纯 `StreamTransientHistory` provider；StreamProjection 只调用其 `prepare/finalize/discard` 并投影返回的只读 message snapshot，不再直接读取 repository 或改写 history 数组。`ChatHistoryPersistence` 继续作为 Coordinator 之后的唯一 durable commit capability；缺少 root、view authority 或 transient provider 时会 fail-fast。
- 生产 `streamOperationId` 现在从 preload 事件桥传入主 Surface consumer、流投影初始化、chunk 和 terminal 校验；`messageId` 仍是 DOM 显示身份，但不再是唯一的生产操作证据。相同 message 的重试由 Bridge 的 operation identity 隔离，Projection 会拒绝不匹配的迟到 chunk/terminal。
- StreamProjection 的 active、累积文本、chunk queue、初始化、上下文、DOM cache、scroll timer 和 segment state 已通过 operation-scoped runtime key（`streamOperationId::messageId`）隔离；重试先撤销旧 operation，再建立新 owner。主聊天完整 20-run/489-action 矩阵已通过，覆盖逆序并发、reload/crash 和终态发送状态。

此前验证记录（历史）：`test:chat-kernel` 107/107、`test:ui-system` 85/85、Electron UI apps 24/24、主聊天完整 20-run/489-action、生命周期压力 3 次预热 + 20 次循环及 connected-DOM 聚焦回归、`guard:next-delta`、`guard:design-subtraction`、`guard:classic-retirement`、`guard:chat-kernel-consumers` 均通过。主聊天真实序列另覆盖独立 Surface 在主话题切换后的持续投影、主/独立并发隔离取消、Flowlock 非流式唯一 durable terminal、VoiceChat/Rust Assistant 成功终态、pending close cancellation、无 thinking 残留和最终新话题持久化。真实 Electron smoke 曾捕获 composition root 未把 transient provider 传入 RenderDependencies 的启动失败，已将该 capability 纳入 fail-fast closure 并复跑通过。D7 仍需辅助窗口并发/reload/crash recovery 的独立长矩阵与 30–60 分钟人工 soak 证据；当前复核结果以上方状态段为准。
- VoiceChat 与 Rust Assistant 的流终态先提交到显式的 transient session repository；窗口关闭会取消并等待真实 stream operation Promise，再由同一窗口 owner 持有的 `ChatHistoryMutationAuthority` 把完整会话写入新建的 durable topic。真实 Electron 测试曾发现局部作用域 authority 导致“创建空话题后静默丢历史”，现已修复并对成功内容、thinking 清理和 durable 文件做断言。窗口在最终 topic 创建前进程异常退出仍可能丢失短会话，这是 D7 soak 与产品恢复策略需要继续评估的已知限制。
- `window.chatManager`、`window.messageRenderer`、`window.streamManager` 已无生产引用并完成删除。consumer gate 自动扫描全部生产 `.js/.mjs/.html`，新增文件若重新读取这些全局会确定性失败；仍保留的 renderer legacy methods 必须逐项提供生产消费者证据。
- ChatManager、TopicListManager、SearchManager 与 StreamManager 已删除 `allowLegacyHistoryFallback`；生产和测试都必须显式注入 `ChatRepository`，不存在绕回 preload `save/getChatHistory` 的隐藏后门。Flowlock 非流式保存同样通过共享 mutation authority，门禁禁止重新引入直接 history IPC。

## Stream Session 目标接口

D6 最新增量已移除主聊天 selection 与 topic-readiness 的无界全局 facade：`VCPMainChatState` 是 composition root 创建的只读 consumer，`TopicSelectionReadiness` 由 TopicListManager 显式注入；辅助 Voice/Rust 并发场景已覆盖 context binding、独立 terminal 和分别关闭。D5/D7 仍以完整 renderer composition 收口和人工 soak 为退出条件。

后续 legacy 审计已完成真实消费者迁移：Middle-click 与 Context-menu 的转发/音频入口通过 Surface capability 注入；settings/filter/presentation 内部消费者也已改用显式 capability。保留 `VCPMainChatState`、`MainChatCommands` 与 `VCPAppearanceStudio` 公共 facade，并在 consumer report 中登记。历史 lifecycle stress 已通过 3 warmup + 60 measured cycles；本次对抗式修复另复跑 3 warmup + 20 measured，不能把历史 60-cycle 误记为当前补丁重跑。CDP `Runtime.callFunctionOn` 曾出现一次协议超时，完整串行矩阵随后通过，但这仍不能替代人工 soak。

第一版只保留真实消费者需要的最小接口，不做通用 Store：

```js
const session = streamCoordinator.start(request, {
    onEvent: event => surface.consume(event),
    signal,
});

await session.done;       // terminal outcome, not merely reader closed
await session.dispose();  // abort, drain, detach, and persist owner work
```

事件采用封闭 discriminant，至少包括：

- `started`：带 session id、conversation key 和 generation；
- `chunk`：只带规范化文本/协议块，不带 DOM；
- `completed`：带最终 message model 和 persistence result；
- `failed`：带可重试错误和是否已持久化；
- `cancelled`：带取消来源；
- `discarded`：Surface 或 generation 已失去提交权。

`reader.close`、AbortSignal、网络断开和 renderer dispose 都必须归一到上述终态之一；同一 session 只允许一个 terminal outcome。

## 关键禁止事项

- 不把 `StreamSession` 做成第二个 `window.streamManager`。
- 不新增全局 `whenIdle()`、万能 Store 或只读 diagnostics facade。
- 不让 stream coordinator 直接操作 DOM、焦点、按钮、Toast 或 CSS。
- 不让 renderer adapter 直接读取 `currentSelectedItemRef`、`currentChatHistoryRef` 或 `window.*`。
- 不在没有真实 Surface consumer 的情况下提前删除兼容 facade。
- 不把持久 history 当作流式 UI 的逐 chunk 状态源；终态保存必须有明确 commit point。

## 测试矩阵

### 纯函数/单元

- chunk 顺序、重复 terminal、空内容 terminal、工具/思维链/代码块协议隔离；
- cancel、disconnect、reader error、dispose during await；
- 两个 topic 逆序完成，只有每个 topic 的最新 durable history 被保留；
- event subscriber 异常隔离，其他 consumer 仍收到终态；
- generation 替换后迟到 chunk 不再有提交权。

### 真实 Electron

- 主聊天成功/失败/取消/断线/重试；
- 独立只读和交互 Surface 同时运行；
- close while pending、reload/crash while pending、重复 dispose；
- 主题、焦点、ARIA、通知、桌面 push 与 stream terminal 对齐；
- 12 个 Classic 子页面保持无新 runtime/consumer。

### 门禁

- `check:next-delta-contract`：Domain/Stream 不得依赖 DOM/Electron；每个 event 有 producer/consumer；禁止新增全局 stream facade；
- `check:design-system-boundary`：所有共享文件有审查理由；
- consumer report：旧 facade 的生产引用为零后才允许删除；
- lifecycle inspector：session、reader、timer、save queue、listener、Surface owner 在 dispose 后归零。

## 完成定义

只有同时满足以下条件，才能把 renderer 深度解耦标记完成：

1. Stream Session 和 coordinator 不导入 DOM、Electron 或主窗口 helper；
2. MessageRenderer 只接收显式 root、render model 和 capability closure；
3. MainChatSurface 是生产组装者，不再让 `renderer.js` 充当业务状态中心；
4. 每个保留 facade 都有至少一个可定位的生产消费者，否则删除；
5. 真实 Electron 证明所有 terminal、persist、cancel、dispose 和 late-result 场景；
6. 完整 Windows 矩阵和人工 soak 通过；
7. 文档、静态 gate、consumer report 和代码在同一提交组中同步。

## 2026-08-20 收口复核与人工 soak 入口

当前 Chat Kernel 为 129/129，UI System 为 85/85；当前 Windows 主机矩阵六项串行通过，生命周期压力为 3 次预热 + 60 次测量，辅助窗口 reload/crash 入口已覆盖。上述结果仍不满足第 6 项：矩阵仅覆盖一台 Windows 主机，未覆盖多版本、打包安装、GPU/DPI 组合，且尚无人工作业记录。

新增 `npm run test:manual-soak`（可用 `VCPCHAT_MANUAL_SOAK_MINUTES=30` 和 `VCPCHAT_MANUAL_SOAK_INTERVAL_SECONDS=60` 调整）。该入口启动真实 Electron、周期采集 renderer lifecycle/heap/process/error 快照，接受 stdin 的 `finish`、`fail`、`abort`，并写入 `artifacts/manual-soak/<timestamp>.json`。产物固定为 `manual_observation_required`，不会把“启动并退出”或自动计时误记为通过；操作员必须逐项记录主聊天流式、历史切换、附件、主题、通知/桌面 push、VoiceChat、Rust Assistant、reload/crash、Classic 子页面和插件协议结果。

本轮决策：人工 soak 采用观察日志与人工检查清单分离。自动脚本只能证明入口、采样和清理可运行，不能替代人的交互覆盖或把短时自动压力测试升级为 D7 证据。`window.globalSettings` 与 presentation/filter helpers 已迁移删除；TopicListManager 的其它 legacy service 读取不属于本次已退休 facade 集合，继续由后续边界审计跟踪。

本轮 D5 增量还将 TopicListManager 的 `uiManager` 与 `itemListManager` 作为显式 capability 注入，移除该模块对这两个 window service 的生产读取；Next delta baseline 已同步更新并通过门禁。剩余 UI service ambient paths（如 main-chat commands、notification renderer 和 appearance studio）仍需按真实消费者逐项迁移，不能以本次 TopicListManager 收口外推为全部完成。

数字更正（2026-08-20）：新增 UI manager lifecycle focused test 后，`test:ui-system` 当前为 86/86；文档中早先的 85/85 仅表示该测试加入前的历史运行。

`MainChatCommands` 现由 composition root 注入 UI、过滤、通知、appearance 和 tab capabilities；主聊天真实序列 `24 actions / 25 requests` 复跑通过。该改动只收口命令内部的 service 获取，不删除 `window.MainChatCommands` facade，因为 Next shell、Classic 菜单和插件命令仍有真实生产消费者。

`notificationRenderer` 现接受 filter capability 与 `DomListenerOwner`；焦点清理和周期过期清理在主 renderer 中由 owner 持有，降低 process-lifetime timer 风险。兼容页面未提供 owner 时仍有 fallback，因此通知模块和 appearance studio 的全部 ambient 读取仍未达到 D5 完成定义。

`uiManager.init()` 现接受主窗口 `DomListenerOwner`，通过 capture 收口 sidebar/navigation listener，数字时钟使用 owner-scoped recursive timeout。该变更证明 UI manager 的 teardown 资源可被主 Surface 回收，但 settings/item-list service 的真实兼容读取仍保留，不能宣称 ambient 依赖已全部消除。

UI manager 的 settings/item-list 读取现由 renderer composition root 显式注入，旧 window fallback 仅用于兼容页面；主聊天 24-action 序列与两个静态 gate 通过。该 capability 收口仍不代表 appearance studio 或所有 UI service 已完成迁移。

Appearance Studio 现由 composition root 注入 settings、appearance engine、UI manager 与 presentation capability，预览/回滚/保存路径优先走显式对象；`test:appearance-studio` 和主聊天序列通过。公共 `window.VCPAppearanceStudio` 仍被 Next shell 与设置 UI 消费，保留 facade 不代表 renderer 业务状态仍由它拥有。

Appearance Studio 的 revision、settings、toast/modal 和 presentation 读取进一步统一为 capability helper；旧 window 访问只作为 fallback。该增量通过 appearance 测试与 Next delta gate，但不改变公共 facade 的保留决策。

最新 `npm run check:ui-system` 全链路通过：静态边界、Classic parity/retirement、Next delta、consumer gate、UI applications、stylelint、UI System 87/87、appearance engine/studio、Next tab lifecycle、WebAwesome adapter 和 lifecycle/topic tests 均通过。该证据仍不覆盖人工 soak、多版本 Windows 或打包安装矩阵。

UI manager 的设置标签中键 modal 操作也已改为由 composition root 注入 `uiHelper`，旧 window helper 只作 fallback；主聊天序列和静态门禁通过。

UI manager 现有幂等 `dispose()`，由主 renderer 的 `ownedRendererSubscriptions` 调用，清除 capability 与 DOM 引用并拒绝 dispose 后重新初始化；这补强了主 Surface 的 quiescent teardown 证据。

人工 soak harness 的 Windows 清理现已复用精确 PID 进程树终止策略，避免 Electron renderer/GPU 子进程残留污染后续矩阵；短时 smoke 仅证明入口和清理可运行，产物仍要求人工逐项审核。

最新 `npm run test:windows-matrix`（2026-08-20 20:49Z）在当前 FlowX13 Windows 主机六项全部通过，artifact 为 `artifacts/windows-matrix/2026-08-20T20-49-30-813Z.json`；resize CDP 仍显式 skipped，矩阵范围仍限单机。
