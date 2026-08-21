# Chat Event Producer/Consumer 类型化路线

更新日期：2026-08-21。本文件是 D0-D7 之后的独立开发计划，不是当前 D7 完成声明，也不要求在现有 PR 中重写全部事件系统。

## 目标

把 VCPChat 的聊天相关事件从“可搜索的字符串和回调集合”提升为可审计的事件定义与 producer/consumer 图谱。每个纳入范围的事件最终都应能回答：谁产生、谁消费、传递模式是什么、payload 如何校验、是否是持久事实、terminal 如何定义、何时丢弃、由谁撤销订阅。

这项工作服务于三个目的：

1. 防止 renderer、ChatManager、StreamManager、preload 和 Surface 再次形成隐式反向控制。
2. 让新的聊天能力优先接入显式 capability 或已登记事件，而不是继续增加 `window.*` 或裸字符串。
3. 生成可审查的 producer/consumer 报告，并把关键错误路径接入静态门禁和真实入口测试。

## 不改变的边界

- 不把所有 Electron IPC channel、DOM 原生事件、Classic 页面协议强行改成同一个运行时 EventBus。
- 不在第一阶段替换现有 `electronAPI`、`contextBridge`、插件协议或 `CustomEvent` 的传输实现。
- 不用类型包装掩盖未解决的 owner、持久化或 terminal authority 问题。
- 不把测试 mock 中的事件当成生产 consumer；生产、测试、兼容协议三类证据必须分开。
- 不增加第二份聊天状态。事件只传播事实或请求，当前 snapshot 和 mutation authority 仍由现有 owner 持有。

## 现状分类

当前事件面至少分为四类，迁移顺序不能混淆：

| 类别 | 当前例子 | 主要 owner | 第一阶段处理 |
| --- | --- | --- | --- |
| DOM/UI 事件 | `vcp-renderer-ready`、`vcp-chat-stream-terminal`、`next-ui-overlay-changed` | Surface/DOM owner | 登记 payload、producer、consumer 和 dispose；暂不换传输 |
| preload/Electron subscription | `onHistoryFileUpdated`、`onThemeUpdated`、`onVCPLogStatus`、`onFlowlockCommand` | preload capability + named owner | 登记 channel、参数、返回 disposer、迟到结果规则 |
| renderer 内部事件/回调 | Stream consumer、ChatSurface slots、presentation listeners | kernel/surface owner | 优先改为显式 typed callback 或 capability；禁止新增 ambient callback |
| 公共兼容协议 | `MainChatCommands`、`VCPAppearanceStudio`、Classic/plugin hooks | 对外协议 owner | 固定 API、冻结对象、登记版本和退役条件；不作为内部事件总线 |

原生 DOM `click`、`input`、键盘事件和非聊天窗口 IPC 不在首批图谱范围，除非它们直接改变聊天 durable state 或 stream terminal。

## 目标事件定义

首个版本使用 JavaScript/JSON 可生成的定义模型，不要求立即引入 TypeScript 全仓迁移。定义文件建议放在 `scripts/chat-event-definitions.json`，生成报告放在 `docs/chat-event-producer-consumer.json`。

每条事件定义包含以下字段：

```json
{
  "id": "chat/stream/chunk",
  "transport": "internal-callback",
  "mode": "emit",
  "payload": {
    "required": ["conversationKey", "operationId", "messageId", "textDelta"],
    "optional": ["sequence"],
    "opaqueIds": ["conversationKey", "operationId", "messageId"]
  },
  "producer": [{"owner": "StreamCoordinator", "source": "modules/chat/streamCoordinator.js"}],
  "consumers": [{"owner": "StreamProjection", "source": "modules/renderer/streamProjection.js"}],
  "durability": "transient",
  "terminal": {"kind": "none", "ordering": "sequence-monotonic"},
  "discard": "drop-after-dispose-or-generation-mismatch",
  "lifecycle": {"subscriptionDisposer": true, "quiescentDispose": true},
  "smoke": "test:electron-main-chat-sequences",
  "status": "active"
}
```

字段语义必须固定：

- `id` 是稳定的逻辑事件名，不等于 DOM event name 或 IPC channel。
- `transport` 记录实际载体：`dom-custom-event`、`preload-subscription`、`internal-callback`、`ipc-command`、`public-protocol`。
- `mode` 至少区分 `emit`、`request`、`waterfall`、`serial`、`parallel`；没有明确模式的事件先标 `unclassified`，不能假装已类型化。
- `durability` 只能是 `durable-fact`、`transient`、`request` 或 `projection`。模型/历史可见事实不能标成纯 projection。
- `terminal` 记录是否允许 terminal、terminal 集合、单 terminal 规则和顺序约束。
- `discard` 记录 dispose、generation、conversation identity、selection 或 surface root 失效时的丢弃规则。
- `lifecycle` 必须说明订阅 disposer、in-flight drain、回调异常隔离和 owner。
- `producer` 与 `consumers` 必须包含源码位置和 owner；定义者不能把自己算作 consumer。
- `smoke` 指向真实入口或 focused owner test，不接受只有静态测试文件存在的证据。

## 事件命名与类型策略

逻辑命名采用域/主题/动作三级形式，例如：

- `chat/stream/started`
- `chat/stream/chunk`
- `chat/stream/terminal`
- `chat/history/selected`
- `chat/history/persisted`
- `chat/surface/disposed`
- `chat/presentation/changed`

请求和事实必须分开命名：`chat/send/requested` 不能代替 `chat/message/persisted`。同一动作若既有 request 又有 durable fact，必须登记两条事件及其因果关系。

首阶段类型实现采用三层：

1. JSON 定义负责跨文件登记、报告生成和静态字段完整性。
2. `modules/chat/chatEventTypes.js` 导出冻结的 event id、mode、terminal kind 和 payload guard，供生产代码和测试使用。
3. 各 owner 继续使用自己的 JavaScript API；只有跨 owner 的 payload 才通过 `publishChatEvent/subscribeChatEvent` 或已存在的 capability closure 传递。

不为同一进程内已由静态接口保证的值添加重复 hostile-input 校验；IPC、durable file、插件和公共协议边界必须校验。

## 分阶段计划

### E0：事件面冻结和基线

- 扫描 renderer、modules、preloads、main process、Classic、插件入口和测试，提取事件定义、订阅、发送、回调注册和 disposer。
- 为每个候选事件标注 transport、owner、producer、consumer、生产/测试证据和是否属于聊天范围。
- 建立 `scripts/check-chat-event-inventory.mjs`，先只报告未知项，不阻断既有开发。
- 输出 `docs/chat-event-inventory.json`，把未分类事件单独列为债务，不将“未找到 consumer”直接解释为无效事件。
- 记录当前可观察基线：IPC 次数/顺序、terminal、持久化、DOM/ARIA、监听器和资源计数。

退出条件：范围内事件 100% 有候选 owner，所有未知字符串都有文件和原因；没有删除或改变生产事件。

### E1：逻辑事件定义和 schema

- 建立 `chat-event-definitions.json` 的 schema 和校验脚本。
- 先录入高价值小集合：stream started/chunk/terminal、history selection/persistence、surface mount/dispose、settings/presentation changed。
- 为 operation identity、conversation identity、message identity 建立 opaque-id 约束。
- 为 terminal 事件验证单 terminal、terminal kind 和迟到 chunk 丢弃规则。
- 生成 `docs/chat-event-producer-consumer.json`，报告定义、源码位置、生产消费者、测试消费者、smoke 和退役状态。

退出条件：高价值事件定义可校验、可生成报告，故意缺 producer/consumer/mode/terminal/disposer 的定义会失败。

### E2：内部 stream 事件接缝

- 以 `StreamCoordinator` → `StreamConsumer` 为第一条真实迁移链。
- 让 started/chunk/terminal 使用统一 payload builder 和 operation identity；保留现有 coordinator 和 projection runtime，不迁移 DOM。
- 明确 chunk 的 sequence、terminal arbitration、dispose、generation mismatch 和 consumer exception 规则。
- 增加 focused tests：重复 terminal、过期 chunk、切换 conversation、consumer 抛错、dispose drain、超大/空 chunk。
- 将 `check-chat-kernel-consumers` 扩展为检查定义与实现的一致性，而不是只检查正则。

退出条件：主聊天和独立 Surface 的真实 Electron sequence 通过，且没有新增全局状态或第二份 history。

### E3：history/persistence 事件

- 区分 `requested`、`optimistic-projected`、`persisted`、`persistence-failed` 和 `retracted`，不把一次保存过程压成一个模糊事件。
- 将 persistence authority、mutation queue 和 ChatManager selection generation 写入定义。
- 验证失败保存不会伪造 durable fact；迟到保存结果不能写入新 topic/conversation。
- 对 durable facts 增加 reload/replay 测试，确认事件或事实可以重建用户可见历史。

退出条件：持久化成功、失败、取消、切换和 dispose 的 IPC/文件/DOM 差异都有解释，且 terminal/persistence authority 唯一。

### E4：preload IPC 与 DOM 适配层

- 为 `onHistoryFileUpdated`、`onThemeUpdated`、`onVCPLogStatus`、`onFlowlockCommand` 等聊天相关订阅登记逻辑事件 id 与实际 channel。
- 在 preload capability 中提供 typed adapter：参数归一化、返回 disposer、channel 错误隔离；不把 `ipcRenderer` 暴露给 consumer。
- 为 DOM `CustomEvent` 增加 typed dispatch/subscribe helper，只允许登记过的逻辑事件映射到 DOM name。
- 所有 adapter 都记录 producer、consumer、owner、dispose 和 late-result 规则。

退出条件：生产代码不再新增裸 channel/裸 CustomEvent；现有 Classic/plugin 公共协议保持字节和调用顺序兼容。

### E5：生成式 producer/consumer 图谱

- 从定义文件和源码索引生成事件矩阵、按 owner 的入/出边、孤立 producer、无 consumer projection、无 owner subscription 和未登记 channel 报告。
- 对动态注册的 consumer 允许显式 manifest，不允许通过宽泛正则自证。
- 报告生产、测试、兼容协议三种消费者，避免测试引用掩盖生产无人消费。
- 在 CI 接入 `guard:chat-event-producers`、`guard:chat-event-consumers` 和 `guard:chat-event-docs`。
- 对每个事件要求最小负向控制：缺 disposer、错误 mode、错误 terminal、未知 payload 字段或错误 owner 必须在真实 runner 中失败。

退出条件：图谱可从干净 checkout 生成，定义/源码不一致会阻断 CI；报告能定位到源码行和真实 smoke。

### E6：公共协议和插件边界

- 将 `MainChatCommands`、`VCPAppearanceStudio`、Classic 子页面和插件命令登记为 `public-protocol`，而不是内部 event。
- 为每个公共协议记录 API version、允许字段、冻结性、唯一 owner、兼容范围、动态 smoke 和退役条件。
- 对协议输入在 preload/插件边界校验；内部同进程调用继续使用显式 capability，不反向依赖公共 facade。
- 任何新增公共事件必须同时修改定义、consumer report、协议文档和真实 smoke。

退出条件：公共协议和内部事件没有混用；兼容 facade 不持有第二份状态或生命周期。

### E7：回归、发布和维护

- 完整运行 Chat Kernel、UI System、consumer/Next/design/Classic gates、Electron UI Apps、main-chat、auxiliary crash/reload、lifecycle stress 和 Windows matrix。
- 对模型/用户可见事件增加 keyless replay 或 snapshot；对跨进程事件增加真实 Electron smoke。
- 将事件定义变更纳入 PR 模板：新增事件、变更 payload、terminal、durability、owner、consumer、dispose、smoke 必须逐项说明。
- 每个已退役事件保留 retired record，不复活旧 channel 或 facade；归档文档不能成为当前定义来源。
- 每季度或每个重大协议变更后复核 producer/consumer 图谱，删除只剩历史证据的定义。

退出条件：定义、实现、测试、文档和生成报告一致；未解释的 IPC、持久化、terminal、DOM、ARIA、listener 或 resource 差异阻断发布。

## 测试矩阵

| 层级 | 证明内容 | 典型证据 |
| --- | --- | --- |
| schema/static | 字段完整、id 唯一、mode/transport 合法、源码引用已登记 | `guard:chat-event-*` |
| owner unit | payload、顺序、terminal、dispose、callback error | `tests/chat-event-*.test.js` |
| kernel integration | coordinator/session/history authority 真实协作 | `npm run test:chat-kernel` |
| UI integration | Surface、DOM adapter、ARIA/focus 和迟到结果 | `npm run test:ui-system` |
| Electron | preload channel、窗口 reload/crash、跨 Surface | `test:electron-main-chat-sequences`、`test:electron-ui-apps` |
| replay/snapshot | durable/model/user-visible 结果可重建 | 新增 keyless replay/snapshot |
| platform | Windows 版本、安装方式、GPU/DPI 和资源稳定性 | `test:windows-matrix`、人工 soak |

测试必须验证外部世界：文件、IPC 顺序、DOM/ARIA、terminal、listener/resource 计数，而不是只断言某个函数被调用。

## 关键架构决策

1. 先定义逻辑事件，再绑定 transport。这样不会让 DOM 名称或 IPC channel 成为业务 API。
2. 事件不是状态容器。当前 snapshot、selection、history 和 presentation 仍由唯一 authority 提供。
3. durable fact、transient update、request 和 projection 必须分型，不能用一个 `event` 字段混合。
4. 类型化优先从跨 owner、跨进程和持久化边界开始；同 owner 私有 callback 不为形式统一而包装。
5. 先迁移真实消费者，再删除 ambient facade；静态零引用不能替代动态证据。
6. 图谱生成失败应 fail closed，但未知事件在 E0-E1 只报告不阻断，避免一次扫描阻断正常修复工作。

## 风险和停止条件

- 如果定义引入第二份 stream/history 状态，立即停止并回退到现有 authority。
- 如果 IPC 参数或 Classic/plugin 协议发生未登记变化，停止该切片并恢复 adapter 兼容层。
- 如果 dispose 只发 abort 而不等待真实工作停稳，不得标记该阶段完成。
- 如果事件图只能依赖宽泛 grep、测试文件存在或 producer 自证 consumer，不得接入强制 CI。
- 如果真实 Electron sequence、Windows matrix 或 replay/snapshot 暴露未解释差异，不得宣称行为等价。

## 首个实施切片建议

首个 PR 只做 E0 + E1 的最小闭环：

1. 新增事件盘点脚本和候选 inventory。
2. 定义 5-8 个 stream/history/surface 高价值逻辑事件。
3. 生成第一版 producer/consumer report。
4. 增加 schema 和一个故意错误定义的负向测试。
5. 不修改现有 IPC、DOM 事件和 StreamCoordinator 行为。

该切片完成后再以 E2 迁移 stream 事件。这样可以先验证 Harness 风格的“定义—生成—负向门禁—真实 smoke”闭环，再扩大事件范围，控制对主聊天行为的风险。

