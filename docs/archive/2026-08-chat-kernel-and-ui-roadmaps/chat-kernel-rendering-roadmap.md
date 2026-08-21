# VCPChat Chat Kernel、Renderer 与受控 UI 插件化路线

> 归档说明（2026-08-21）：本文是已完成的 C0-C7 历史路线，不再维护当前阶段状态。当前 D0-D7 状态以 `../../chat-kernel-vd7-final-audit.md` 为准。

> 状态：C0–C7 已完成并通过 Windows 最终矩阵；后续扩展继续受本路线合同约束。
> 规范依据：`C:\\VCP\\vchat-develop\\deepseek-harness\\AGENTS.md`、`docs/defensive-patterns.md`、`docs/testing.md` 及相关 skill。

## 目标

让主聊天能够在保持现有行为的前提下，逐步复用于只读独立聊天页、嵌入式聊天应用和展示型 presentation skin。目标不是复制一套业务实现，也不是把任意 DOM/CSS/IPC 暴露给插件，而是建立一个有真实消费者、最小权限和可证明销毁的边界。

## 当前审计结论

`renderer.js`、`modules/messageRenderer.js`、`modules/chatManager.js` 和 `modules/event-listeners.js` 在文件层面分开，但运行时仍共享全局可变状态、固定 DOM ID、`window.*` 单例和 Electron API。现阶段不能安全地把 `renderer.js` 直接作为第二个页面的渲染器复用。已有 `contentPipeline` 等内容模块是可利用的低风险边界，但流式、历史、附件和 DOM 生命周期仍与主窗口耦合。

## 目标拓扑

```text
Chat Domain Kernel
├── ChatContext / Message model
├── History repository
├── Stream session
└── read-only state events
Content Runtime
├── markdown/tool/thought parsing
├── attachment representation
└── stream incremental assembler
Chat Renderer Adapter
├── mount/update/remove/renderBatch
└── destroy → quiescence
Chat Surface
├── MainChatSurface
├── StandaloneReadOnlyChatSurface
├── EmbeddedChatSurface
└── Presentation/Galgame skin
```

Domain 不依赖 `document`、固定选择器或 Electron；内容运行时优先纯函数；Renderer Adapter 接收显式 `root` 与最小依赖；Surface 负责布局、输入、主题、焦点和 owner 生命周期。

## 分阶段施工

| 阶段 | 内容 | 真实消费者与退出条件 |
|---|---|---|
| C0 基线 | 记录调用图、主聊天序列、流式/历史/附件行为 | 现有 Electron 与 UI 测试通过；无行为改动 |
| C1 ChatContext | 将 selected item、topic、history 组合为显式上下文，保留兼容读写边界 | MainChatSurface 是唯一消费者；旧全局引用数量下降并有回归证据 |
| C2 Repository | 完成（生产路径）：ChatManager、TopicList、Search、Stream、Message Edit 均使用同一 `ChatRepository`；缺失时 fail-fast。旧 Electron history API 仅可由测试夹具显式开启 | 真实保存/加载/错误测试；所有生产历史路径使用同一 repository；Domain 不出现 Electron |
| C3 Content Runtime | 已完成：`normalizeMessage`、DOM-free `createRenderModel`、Mermaid/entity transforms、chunk 提取、stream assembler、附件归一化及工具结果/思维链/工具请求/代码块顺序协议均有纯函数 seam；MessageRenderer 仍保留最终 HTML/DOM 投影 | 30 项 Chat Kernel 纯函数/适配测试；主聊天与独立 Surface Electron 序列通过 |
| C4 ChatDomRenderer | 已完成：显式 root、pending quiescence、第二 root、listener disposer、stream transient cleanup、内容延迟工作句柄、Three.js observer/renderer、Mermaid、媒体和附件交互 listener 均有 per-root cleanup | 主窗口与独立 Surface 接入；生命周期压力中 listener/timer/DOM/pending work 稳定、detached roots 为 0 |
| C5 只读 Surface | 已完成：`standalone-chat-history` 已注册为普通 Launchpad 内部应用，Electron smoke 证明独立 root、只读、焦点和关闭 teardown | Electron 真入口、主题/焦点/关闭和 teardown 完整 |
| C6 交互 Surface | 已完成：`standalone-chat-compose` 通过真实 VCP fixture 覆盖成功、失败、取消、断线、重试、pending close、重复关闭和迟到终态隔离 | 使用真实请求/Promise/ARIA 终态；关闭后 owner 与 DOM 不再恢复权限 |
| C7 受控插件化 | 已完成：manifest/loader 已接入独立聊天生产消费者，命名 slot、只读 state、token theme、skin mount、状态更新、provider 失败回滚、重复/迟到注册和统一 teardown 均有测试 | 插件只能读正式状态、无任意 DOM/IPC；register/use/dispose 与卸载后静默均可证明 |

## Harness 决策门槛

- 每个 capability 必须同时有 Definition、Provider、Consumer；没有生产消费者的 facade 删除。
- registration 是 effect，必须返回 disposer；dispose 需达到 quiescence，迟到 Promise 不得重新取得提交权。
- 测试等待真实 operation Promise、结果事件或 DOM/ARIA 终态，禁止全局 `whenIdle()` 和固定延时猜测。
- 插件优先使用命名 slot 和 token，不使用任意 selector；presentation skin 不得伪造业务状态、接管焦点或 Escape。
- 每一阶段独立可回滚；先由主窗口成为第一个消费者，再新增独立 Surface，避免双轨实现。

## 暂不做

不迁移业务子页面、不重写消息协议、不替换 `ChatManager`、不开放任意 IPC/CSS 注入、不引入万能 Store；这些只有在真实消费者和测试同时出现时才进入后续 PR。

## 当前验证证据（2026-08-19）

- `npm run test:chat-kernel`：30/30；包含冻结 render model、DOM-free Mermaid/entity transform、附件协议归一化、工具结果/思维链/工具请求/代码块顺序隔离、slot/provider rollback、卸载后迟到状态静默和交互取消幂等回归。
- Next delta gate 还会检查每个独立 root 的 animation/visibility teardown，以及 Three.js renderer disposal 证据。
- `npm run guard:next-delta`：通过；共享边界 hash 已按审查后的 ChatManager、MessageRenderer、StreamManager 变更更新。
- Next delta gate 现在额外验证 TopicListManager、SearchManager、MessageRenderer/StreamManager 在 renderer 生产入口均收到同一 `ChatRepository`。
- Mermaid placeholder 和 HTML entity 解码已移到 `modules/chat/contentTransforms.js`，不再依赖 `document.createElement`；MessageRenderer 通过依赖注入消费它。
- `npm run test:electron-ui-apps`：24/24；包含只读/交互独立聊天 root、插件展示和 teardown。
- `VCPCHAT_SEQUENCE_RUNS=3 npm run test:electron-main-chat-sequences`：72 actions、28 个 VCP 请求；真实 fixture 覆盖独立聊天成功、失败、取消、断线、pending close/迟到终态，以及主聊天流式、切换、恢复和逆序并发持久化。
- Stream terminal now explicitly flushes and awaits the per-topic history save; the independent-surface fixture waits for the composer Promise terminal (`aria-busy=false`) before starting the next operation.
- `npm run test:electron-lifecycle-stress`：3 次预热 + 20 次循环；nodes/listeners/processes/scopes/resources 保持稳定，detached roots 为 0。
- `tests/stream-manager-terminal-cleanup.test.js`：4/4；流式终态失败和 discard 清理通过。
- `npm run check:ui-applications`：通过；81 个业务文件、12 个上游 Classic 子页面边界保持不变。
- `npm run pack:check`：通过；Web Awesome 离线闭包可复现。
- 延迟高亮与 Pretext idle 回调现在以消息 root 持有句柄，`cleanupMessageDomResources` 在 Surface 销毁时取消它们；独立聊天展示层不再写入 inline style。
- Three.js WebGL renderer 的 MutationObserver 现在与 renderer 同属一个 owner，dispose 时断开；presentation skin 可通过受控 update 接收状态变化，loader 负责订阅与卸载。
- C4/C7 增量审查补充了 Mermaid viewer、附件图片/文件/删除按钮 listener 的显式 disposer；插件 provider 中途失败会回滚已注册贡献，卸载后重复 disposer 与迟到 state update 不再重新取得权限。
- `npm run test:electron-ui-apps`：24/24；一次并行启动中的抽屉首帧断言曾出现偶发失败，立即独立重跑后通过；该不稳定性仍需纳入后续人工 soak，不能当作已完全消除。

最近一次断线回归还验证了独立 composer 在 `error` 终态后解除锁定，并通过受控 terminal event 显示可重试错误；该事件只属于 renderer 内部业务结果，不扩展 preload 或插件公共面。

上述证据覆盖 C0–C7 的阶段退出条件。最终逐项审计与 Windows 矩阵已经完成；未来能力只有在同一变更中具备 Definition、Provider、真实 Consumer、owner teardown 和真实终态测试时才可扩展该公共面。
