# VCPChat Chat Kernel 深度解耦路线

> 状态：D0–D5 已完成可重复边界与主窗口生产接入，D6–D7 施工中；未满足全部退出条件前不得宣称 renderer 已完成解耦。
> 规范依据：`C:\VCP\vchat-develop\deepseek-harness\AGENTS.md`、`docs/event-producer-consumer.zh.md`、`docs/defensive-patterns.zh.md` 和 `.agents/skills/dsh-code-review/SKILL.md`。

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
- 兼容 facade（`window.chatManager`、`window.streamManager` 等）仍是生产入口的一部分，不能贸然删除；必须先迁移真实消费者并由门禁证明零生产引用。

### StreamManager

`modules/renderer/streamManager.js` 同时拥有：

- 请求和 SSE/流式读取；
- chunk 队列、pending history、当前 active stream；
- 当前 topic/history 的读写；
- MessageRenderer DOM 更新；
- 主窗口发送按钮、通知、桌面 push、焦点和动画；
- debounce/flush/并发保存；
- `window.*` 和 Electron API 兼容入口。

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

## D0–D2 当前施工

`modules/chat/streamSession.js` 已建立纯协议层，只负责 session identity、chunk 顺序、四种终态归一化、单终态仲裁和 subscriber 隔离；不读取 DOM、Electron、history 或 desktop push。`modules/chat/streamCoordinator.js` 已建立 owner-scoped 协调层：Coordinator 私有 lease 决定提交权，同一 topic 的不同 message 可并发，同一 message retry 会撤销旧 attempt；per-conversation persistence queue、AbortController、owned cleanup 与 `done`/`dispose()` 均等待真实 Promise，不提供全局 registry、Store 或 `whenIdle()`。

D2 的公共 terminal 只在 transport 停稳和 persistence settle 后发布一次。持久化失败不会先发布 completed 再补发 failed，而是形成唯一 `failed` outcome，并保留原 transport outcome 作为只读证据。D3 将把该闭合 handle 接入主聊天与独立 Surface；旧 `streamManager` 在完成生产迁移前仍是过渡 adapter，不能提前删除。

## D3–D5 当前施工

- 主窗口 preload 事件已经统一进入 `VcpStreamBridge → StreamCoordinator → MainChatStreamConsumer`，旧 `renderer.js` 的 start/data/end/error switch 已删除；独立交互 Surface 通过 message-scoped route 获得自己的 DOM projection owner。
- `RenderDependencies` 取代带静默默认值的可变引用袋；root、state refs、repository、transport、Markdown、feedback 和 commands 必须在 mount 时完整提供并冻结。
- `MainChatSurfaceAdapter` 已成为主聊天 Surface、stream route、bridge 与 teardown 的 composition owner；`renderer.js` 仍保留其他主窗口模块 wiring，D6 继续迁移可删除的 legacy facade。
- `window.chatManager`、`window.messageRenderer`、`window.streamManager` 目前仍被 VoiceChat、Rust Assistant、Flowlock、设置与旧模块真实消费。它们属于经 consumer report 证明的过渡兼容入口，不能在生产引用归零前删除。

## Stream Session 目标接口

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
