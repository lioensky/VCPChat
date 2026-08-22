# Chat Kernel vD0–vD7 对抗式审查与开发记录

> 归档说明（2026-08-21）：本文是按时间追加的审查日志，仅用于追溯决策和历史证据，不再声明当前阶段状态。当前状态以 `../../chat-kernel-vd7-final-audit.md` 为准。

> 本文记录深度解耦路线的当前审查结论、退出条件和实现决策。它只记录本项目的代码与测试证据；DeepSeek Harness 文档用于审查标准，不替代本项目的真实测试。

## 1. 审查结论

### 1.1 不能把静态消费者报告当成真实消费者证明

`check-chat-kernel-consumers.mjs` 能证明生产源码中存在引用，不能证明 Electron 启动后该调用路径已连接到真实 producer，也不能证明终态、取消或 dispose 的行为。删除 facade 前必须同时具备静态零引用、动态入口 smoke 和行为测试。

### 1.2 不能把单元测试数量当成退出条件

当前 `test:chat-kernel` 为 138/138，`test:ui-system` 为 87/87，说明纯 kernel 与 UI controller 契约有证据；它们不能单独证明 renderer composition、preload 订阅、Electron 窗口恢复或真实 DOM 生命周期。vD5/vD6 的 PASS 还依赖 renderer responsibility gate、facade ledger、真实 Electron UI/主聊天/辅助恢复和 60-cycle lifecycle；vD7 仍不能由测试数量证明。

### 1.3 “拆文件”不等于“拆 owner”

历史上 `renderer.js` 同时持有选择、topic、history、发送状态、TTS 队列、设置/主题、preload 事件和主 Surface 组装。当前这些责任已迁入 named owner 或现有 manager；D5 的验收仍以 owner 和可观察关系为准，而不是文件行数或新建模块数量。

### 1.4 terminal authority 的表述需要收紧

Coordinator 已负责 transport/persistence 终态，但 `StreamManager` 仍拥有 DOM projection 的 active、queue、pending 和 finalized 状态。路线不得把“唯一 terminal authority”写成“全仓只有一个状态对象”；应分别证明 transport terminal、durable commit、Surface projection terminal 三者的责任和顺序。

### 1.5 历史 Electron 记录不能覆盖当前失败

主聊天 20-run/489-action/173-request 和旧 lifecycle 记录是历史证据。当前分支必须重新运行真实入口；失败、超时、主进程 stderr 和子进程清理结果要分别记录，不能因存在旧的通过报告而标记 D7 完成。

## 2. vD0–vD7 修订路线

| 阶段 | 当前目标 | 必须证明的事实 | 禁止用作替代的证据 |
| --- | --- | --- | --- |
| vD0 | 冻结当前 owner、consumer、失败入口和基线 | report、动态入口、当前失败复现、未提交工作树边界齐全 | 仅看文件名或历史 commit |
| vD1 | 保持纯 StreamSession/State 协议 | 无 DOM/Electron；terminal、generation、迟到事件和 subscriber 隔离可复现 | DOM fixture 伪装成 kernel 证据 |
| vD2 | 保持 Coordinator 的 transport/persistence 顺序 | 每次 terminal 等待真实 reader 与 persistence Promise；dispose 达到 quiescence | `reader.close()` 或 `whenIdle()` 作为完成证明 |
| vD3 | 证明每个事件有真实 consumer | 主聊天、独立 Surface、辅助窗口各自消费并隔离 operation identity | 仅 producer/consumer 静态计数 |
| vD4 | 收口 RenderDependencies 与 Surface capability | MessageRenderer 只读显式 root、render model 和 capability closure；缺 capability fail-fast | 隐藏 global/ref fallback |
| vD5 | 把 renderer.js 变成 composition root | 只负责 DOM bindings、provider 构造、adapter mount/dispose；业务状态和副作用由 named owner 持有 | 以拆出几个文件或减少行数宣称完成 |
| vD6 | 退休所有无消费者 legacy surface | 每个保留出口有生产消费者、动态 smoke、期限和 owner；否则删除 | 测试夹具引用或导出本身自证 |
| vD7 | 最终边界与发布证明 | 单一 terminal/persistence authority、完整 Windows 矩阵、辅助窗口恢复、30–60 分钟人工 soak、逐项审计 | 旧报告、单元绿灯或短时压力测试 |

## 3. vD5 施工顺序

1. **vD5.0 启动闭包**：修复 `initAudioContext` 作用域/初始化顺序；所有 capability 在 mount 前构造，缺失时 fail-fast；Electron UI smoke 必须先恢复。
2. **vD5.1 状态 owner**：把主聊天 selection/topic/history、发送/取消 operation、TTS session/queue 分别交给 named owner；禁止 renderer 通过大量 getter/setter ref 继续充当隐式 Store。
3. **vD5.2 事件 owner**：把 preload subscription、Flowlock、VCP log/group-topic、history watcher、notification side effect 迁入 `MainChatEventBridge` 或更窄的真实 consumer。
4. **vD5.3 DOM adapter**：保留固定 DOM 查询和组合，移除 renderer 中的业务分支；统一主 Surface 与 auxiliary Surface 的 capability 创建路径，避免两套 RenderDependencies 语义。
5. **vD5.4 legacy retirement**：逐项删除 `window.ensureAudioContext`、`window.showForwardModal` 和其它无消费者出口；每次删除同时更新 report、动态 smoke 和行为测试。

## 4. 决策记录

### 决策 vD-001：先修启动闭包，再迁移 owner

**原因**：当前 Electron smoke 在 composition 阶段因 `initAudioContext` 未定义失败。继续迁移会把启动失败与结构变化混在一起，无法判断回归来源。

**结果**：第一项代码变更只修复 TTS capability 的作用域和占位覆盖，不改变聊天协议或用户行为；修复后必须重跑真实 Electron smoke。

**验证结果（2026-08-20）**：`node --check renderer.js` 通过；8 个主聊天 adapter/event/capability focused tests 通过；`npm run test:electron-ui-apps` 通过，24/24 场景通过。该修复解除 Electron UI smoke 的启动阻塞，但不代表 vD5 或 vD7 完成。

### 决策 vD-002：renderer.js 的 Definition of Done 是责任约束

**原因**：减少文件大小不能证明状态和副作用已经迁移。

**结果**：D5 完成判据改为可观察 owner 关系：renderer 不写 history、不拥有 stream/TTS 队列、不处理 preload 业务事件，只组装并 dispose adapter。

### 决策 vD-003：保留历史证据，但禁止冒充当前状态

**原因**：旧的 20-run、lifecycle 和 Electron UI 报告仍有追溯价值，但当前分支已出现新的启动失败。

**结果**：文档将历史运行与当前复核分开记录；当前失败必须有命令、退出码、错误位置和恢复状态。

## 5. 当前基线与未决问题

- 当前静态门禁：`guard:chat-kernel-consumers`、`guard:next-delta`、renderer responsibility 与 retired-global gates 通过。
- 当前纯测试：Chat Kernel 138/138、UI System 87/87 通过。
- 当前真实入口基线：Electron UI Apps 24/24、主聊天 24 actions / 25 requests、辅助 crash recovery 24 actions / 27 requests、60-cycle lifecycle 和当前主机六行矩阵通过。vD5/vD6 已 exit-ready；人工 soak 与跨配置 Windows 矩阵仍未完成。
- 当前已知恢复风险：VoiceChat/Rust Assistant 在最终 topic 创建前进程异常可能丢失短会话，需要在 vD7 soak/recovery 中验证或制定产品策略。
- 当前工作树的 `styles/themes.css` 修改与 `audio_engine/AppData/` 未跟踪内容不属于本路线变更，开发时必须保持隔离。

2026-08-20 vD5.0 复核（历史）：TTS capability 修复后，`npm run test:electron-ui-apps` 通过 24/24；`npm run test:electron-lifecycle-stress` 通过 3 次预热 + 20 次测量，documents、connected DOM、detached DOM、listeners、scopes 和 owner resources 均稳定。该记录已被后续 60-cycle 复核扩展，不能单独作为当前 D7 证据。

### 决策 vD-004：TTS 由 Surface owner 持有

**原因**：AudioContext、播放源、队列、session identity 和 preload subscriptions 原先是 renderer 全局可变状态，停止与异步 decode 之间存在迟到结果重新播放的风险。

**结果（2026-08-20，历史增量）**：`TtsSurfaceOwner` 已接管生产订阅、session replacement、播放源停止、迟到 decode 隔离和异步 dispose；`window.ensureAudioContext` 已从生产组装删除。该增量当时为 115/115；当前 Chat Kernel 为 129/129。TTS 旧函数体已删除，renderer 中仍有其它状态和事件 owner 待迁移，因此 vD5.1 仍未完成。

### 决策 vD-005：删除无生产消费者的 renderer facade

**原因**：`window.showForwardModal` 与 `window.setChatPresentationMode` 只有定义，没有生产读取；继续保留会让 consumer report 误把兼容入口当成公共合同。

**结果（2026-08-20）**：两个 facade 已删除；forward 通过 Surface capability，presentation 更新通过 `window.applyChatPresentationMode` 的现有真实消费者。consumer gate 通过，Electron UI Apps 24/24 通过。`window.globalSettings`、主题和过滤入口仍有真实生产消费者，暂不删除。

### 决策 vD-006：所有 renderer preload 订阅必须进入同一 teardown owner

**原因**：`onReloadAgentSettings` 与 `onHistoryFileUpdated` 原先直接注册，虽然聊天内容测试通过，但 renderer dispose 不能证明这些监听器已经撤销；迟到 watcher 可能重新写入已替换的 Surface。

**结果（2026-08-20，进行中）**：两类订阅已使用 `ownedRendererSubscriptions` 管理并等待异步 dispose；Loom、VCP log/status 也已由 `MainChatAuxiliaryEventOwner` 接管。Flowlock command/request 已移入 `MainChatFlowlockOwner`，并覆盖未知命令、缺失 manager、响应失败和迟到回调隔离；forward modal、目标选择、原始消息读取和附件转发已移入 `ForwardMessageOwner`；`MainChatSettingsOwner` 现持有主窗口 settings 对象并提供稳定 ref、replace/update/snapshot/dispose，避免设置加载替换局部 owner。剩余 document/window listeners 仍待迁移，两个新 owner 仍需真实 Electron 矩阵覆盖。主聊天 24-action、lifecycle stress 和 Electron UI smoke 保持通过。

**vD5.4 清理（2026-08-20）**：已从 `renderer.js` 物理删除迁移后的 Flowlock 与 forward 内联实现；源码中不再保留 `messageToForward`、`selectedForwardTarget` 或旧 `flowlockCommandHandler`。consumer guard 与主聊天 24-action 序列复跑通过。剩余 listener owner 化及辅助窗口长矩阵仍未完成。

**vD5.3 listener 增量（2026-08-20）**：新增 `DomListenerOwner`，收口聊天 presentation quick switcher 及字体/布局/用户气泡设置控件的 DOM listener 注册，并在 renderer capability dispose 时反注册。owner 的移除和迟到 add 行为有 focused test；Electron UI Apps 24/24 通过。DOMContentLoaded、主聊天按钮 wiring、Rust 设置控件和 `setupEventListeners` 仍需后续逐项审计。

本轮追加：主聊天 emoticon trigger 与 quick-new-topic bridge listener 也纳入 `DomListenerOwner`；主聊天 24-action 序列复跑通过。`setupEventListeners` 模块仍有大量直接注册，不能把当前局部收口外推为全部 listener 完成。

**主聊天事件 owner 增量（2026-08-20）**：`setupEventListeners` 现在接收显式 `listenerOwner`，消息区点击、发送按钮 click/contextmenu、输入框 keydown/input/mousedown 和附件按钮 click 均通过 owner 注册并可 teardown；主聊天 24-action 与 Electron UI Apps 24/24 通过。模块其余设置/通知/Rust listeners 仍待迁移。

**模块 listener 捕获增量（2026-08-20）**：`DomListenerOwner.capture()` 在 `setupEventListeners` 同步组装期间临时捕获模块直接调用的 `EventTarget.addEventListener`，函数结束立即恢复原型，并由 owner 记录反注册；focused capture test、主聊天 24-action 和 Electron UI Apps 24/24 通过。该机制不替代逐项 consumer 审计，异步/运行期注册和 MutationObserver 仍需明确 owner。

**异步 DOM 资源增量（2026-08-20）**：renderer 的 DOMContentLoaded 注册、emoticon trigger observer 与 quick-new-topic observer 已归入 `DomListenerOwner`；`own()` 支持 observer/disposable teardown，并有幂等 focused test。主聊天 24-action 复跑通过。`setupEventListeners` 内的 timer 和运行期临时 listener 仍需独立清理审计。

**timer/临时 listener 增量（2026-08-20）**：`DomListenerOwner.timeout()` 现管理 `setupEventListeners` 的滚动条隐藏、设置导航动画、上下文菜单延迟注册、助手长按与侧栏长按 timer；运行期 document click 通过显式 owner 注册。dispose 会取消 pending timeout，focused cancellation test 与主聊天 24-action 通过。

**主题/presentation owner 增量（2026-08-20）**：新增 `MainChatThemeOwner`，接管初始 light/dark 主题投影、presentation mode 规范化、DOM class、settings authority 更新、pretext/layout 协调、持久化失败回滚与 dispose 后隔离。renderer 保留的同名函数仅为 composition/compatibility 委托。focused rollback tests、主聊天 24-action 和 Electron UI Apps 24/24 通过；appearance-studio 仍通过现有 facade 消费，尚不能删除 facade。

**辅助窗口恢复增量（2026-08-20）**：主聊天真实序列新增 VoiceChat 与 Rust Assistant 各自的 held-stream reload 场景；释放迟到结果后重新加载的辅助 renderer 必须恢复可输入且无 thinking/streaming 残留。串行真实序列通过，当前为 24 actions / 25 VCP requests。该证据仍不是完整 crash/reload 长矩阵或人工 soak。

**Crash 矩阵结果（2026-08-20）**：首次 opt-in 运行暴露了真实产品缺陷：VoiceChat/Rust Assistant 的主进程窗口 owner 在 `render-process-gone` 后仍保留坏 BrowserWindow，导致 reopen 复用失效 renderer。已在 `voiceHandlers.js` 与 `assistantHandlers.js` 释放 owner 并销毁坏窗口；随后 `VCPCHAT_AUX_CRASH_MATRIX=1` 真实序列通过，24 actions / 27 VCP requests，覆盖两类辅助窗口 crash 后重建、可输入状态和无 transient thinking/streaming 残留。该证据仍是单次 opt-in，不等同于完整长时间 crash soak。

**生命周期压力结果（2026-08-20）**：当前代码复跑 `VCPCHAT_STRESS_CYCLES=60 npm run test:electron-lifecycle-stress` 通过（3 warmup + 60 measured）。baseline 到 cycle-60 保持 connectedElements=2569、listeners=875、detachedRoots=0、lifecycleActiveResources=163、processes=5；人工 soak 仍未完成。

**Windows 入口复核（2026-08-20）**：`node scripts/test-settings-wa-electron.mjs` 通过 1–7 项（仅窗口 resize CDP 能力跳过）；`node scripts/test-next-ui-tab-lifecycle.mjs` 通过；Electron UI Apps 24/24 通过。旧 `test-top-tab-session.mjs` 直接 eval 旧 facade、未组装 `VCPNextShellController`，因此不能作为当前产品 tab reload 证据，已由真实 tab lifecycle 入口替代并记录。

并行 stability 尝试曾因同时启动多个 Electron 进程触发 CDP `Runtime.callFunctionOn` timeout；串行主聊天序列随后通过 24 actions / 25 requests。并行 timeout 不计为源码回归，也不覆盖人工 soak 缺口。

**当前证据汇总（2026-08-20）**：Chat Kernel 129/129、UI System 85/85、Electron UI Apps 24/24；生命周期压力为 3 次预热 + 60 次测量；辅助窗口 reload/crash opt-in 三轮合计 72 actions / 42 requests；设置入口 1–7 与真实 Next UI tab lifecycle 通过。完整 Windows 配置矩阵、30–60 分钟人工 soak 和 D7 逐项审计仍未完成。

**vD5 listener 审计增量（2026-08-20）**：对抗式复核发现 `filterManager.subscribe`、`onDoToggleNotificationsSidebar` 和 `onCreateUnlockedTopic` 原先没有把 disposer 交给 renderer owner，现已通过 `listenerOwner.own(...)` 纳入同一 teardown。`setupEventListeners` 的临时 `EventTarget` 捕获改为 `try/finally`；异常时释放原型捕获并撤销 `eventListenersBound`，允许安全重试。`window.globalSettings`、presentation mode helpers 与 `checkMessageFilter` 仍有真实生产消费者，保留为兼容桥并列入 D5/D6 责任表，不以静态定义删除。

**vD5.3 input enhancer 增量（2026-08-20）**：`inputEnhancer` 的拖拽、粘贴、提及建议和跨窗口附件回调现在接受主 renderer 的 `DomListenerOwner`；重初始化会先撤销旧资源，跨窗口 preload disposer 也进入同一 owner。focused owner test 与 `npm run test:electron-ui-apps`（24/24）已通过。TopicListManager 仍有独立的动态列表 listener，需要在后续 D5/D6 审计中证明其宿主生命周期，不能把 input enhancer 的迁移外推为全部 DOM listener 完成。

**vD5.3 topic-list 增量（2026-08-20）**：TopicListManager 现在接受独立的 `topicListDomListenerOwner`；Next UI 搜索/管理工具与话题区快捷键通过该 owner 注册，渐进渲染的 topic item listener 在每次重绘前撤销，observer、Sortable、滚动监听和上下文菜单由 manager dispose 清理。`topic-list-mode-lifecycle.test.js` 两项通过，`guard:next-delta` 已更新共享基线 hash/rationale。TopicListManager 仍直接读取若干 legacy UI services（例如 `window.uiManager`），这些是业务兼容消费者，尚未纳入 D7 删除范围。

**vD5.3 timer 审计增量（2026-08-20）**：`modules/renderer/enhancedColorUtils.js` 原先在模块加载时安装每小时 `setInterval`，没有 renderer owner，可能让进程生命周期超出 Surface dispose。已删除该常驻 interval，TTL 缓存改为按访问清理；focused lifecycle test 验证模块加载不创建 process-lifetime interval。该变更不改变颜色提取或缓存结果。

**当前真实入口复核（2026-08-20）**：TopicListManager 与 enhancedColorUtils 变更后，串行 `npm run test:electron-main-chat-sequences` 通过（24 actions / 25 VCP requests）；`VCPCHAT_STRESS_CYCLES=60 npm run test:electron-lifecycle-stress` 通过（3 warmup + 60 measured）。baseline 到 cycle-60 保持 connectedElements=2569、listeners=875、detachedRoots=0、lifecycleActiveResources=163，heap 约 10.3–10.4 MiB。该结果加强了生命周期证据，但仍不是 30–60 分钟人工 soak 或完整 Windows 配置矩阵。

**Windows 矩阵入口增量（2026-08-20）**：新增 `npm run test:windows-matrix`，串行运行 UI/Classic 24 项、Settings WA、Next tab lifecycle、主聊天默认、辅助 crash recovery 和 60-cycle lifecycle，并将每项命令、环境、退出码和截断输出写入 `artifacts/windows-matrix/<timestamp>.json`。当前 Windows 主机 `FlowX13` 的最新矩阵六项全部通过；Settings WA 的旧第 8 项断言曾在 `uiMode=next` 后等待 SettingsShell 消失，已修正为验证 canonical Next SettingsShell 在 reload 后保持。窗口 resize CDP 能力仍明确记录为 skipped，不伪装成通过。该入口覆盖当前主机，不等同于多版本 Windows/打包安装矩阵，也不替代人工 soak。

## 6. 开发记录规则

每个非机械代码变更必须在本文件或对应架构文档记录：问题复现、owner 选择、被放弃的替代方案、静态/单元/真实入口验证命令及结果。测试失败只能标记为失败或阻塞，不能用 agent 判断、旧报告或“理论上等价”替代源码和运行证据。

## 7. 人工 soak 执行入口（vD7 未完成）

`npm run test:manual-soak` 启动 hermetic Electron 主窗口并按固定间隔记录 renderer lifecycle、heap、进程数、页面错误和 stderr。可通过 `VCPCHAT_MANUAL_SOAK_MINUTES` 设置 30–60 分钟时长；stdin 输入 `finish`、`fail` 或 `abort` 可提前结束。每次运行写入 `artifacts/manual-soak/<timestamp>.json`，状态恒为 `manual_observation_required`，不会自动声明通过。

操作员必须在运行期间覆盖：主聊天发送/流式/取消/重试、历史与话题切换、附件、主题、通知和桌面 push、VoiceChat、Rust Assistant、reload/crash recovery、Classic 子页面及插件协议，并观察 detached roots、listeners、heap 斜率和错误日志。当前尚无人工填写的通过记录，因此 vD7 仍保持未完成；单台 Windows 矩阵也不能代表多版本、打包安装或 GPU/DPI 矩阵。

逐项退出审计固定在 [`chat-kernel-vd7-final-audit.md`](./chat-kernel-vd7-final-audit.md)。当前审计将 vD5/vD6 标记为 PASS、vD7 标记为 BLOCKED；审计文档本身不替代运行证据。

**vD5.3 settings capability 增量（2026-08-20）**：`global-settings-manager` 保存路径现在优先接收 composition root 注入的 `normalizeChatPresentationMode`、`applyChatPresentationMode`、`applyChatBubbleLayoutSettings` 和 appearance provider，不再把主 renderer 的 presentation owner 当作隐式业务依赖；旧 window bridge 仅作为独立旧测试/兼容环境的 fallback。`tests/global-settings-save.test.mjs`、`node --check modules/global-settings-manager.js` 和 `node --check renderer.js` 通过。该增量减少 ambient DOM/global 依赖，但不代表 renderer 已完成 composition-only 收口。

**vD5.3 command capability 增量（2026-08-20）**：`MainChatCommands` 增加 `configureCapabilities()`，由 renderer composition root 注入 ui helper、UI manager、item list、filter、notification、appearance studio 和 top-tab capabilities；命令内部优先使用注入对象，window facade 仅作为兼容 fallback。`node --check modules/mainChatCommands.js`、`node --check renderer.js`、`guard:chat-kernel-consumers` 与 `guard:next-delta` 通过。Next shell 及 Classic 入口仍通过既有 `window.MainChatCommands` command facade，故未删除该公共 facade；剩余 `notificationRenderer`、appearance-studio 和 UI manager 内部 ambient 读取继续按真实消费者审计。

**vD5.3 notification lifecycle 增量（2026-08-20）**：`notificationRenderer` 增加 filter capability 注入和 listener-owner 配置；focus cleanup 与 30 秒过期清理优先由 `DomListenerOwner` 持有，避免生产 notification timer 脱离 renderer dispose。主聊天真实序列 24 actions / 25 requests、`node --check` 和 Next delta gate 通过。若独立旧页面未配置 owner，兼容 fallback 仍保留，因此该增量不等同于所有通知路径已完成 owner 化。

**vD5.3 UI manager lifecycle 增量（2026-08-20）**：`uiManager.init()` 接受 `listenerOwner`，使用 owner capture 收口 sidebar/navigation 的直接 DOM listener，并将数字时钟从常驻 `setInterval` 改为 owner-scoped recursive timeout；renderer composition root 传入主窗口 `DomListenerOwner`。`node --check modules/uiManager.js`、`node --check renderer.js`、`guard:next-delta` 和主聊天 Electron 24-action 序列通过。UI manager 内部仍读取 settings/item-list globals 的真实服务，暂不删除，继续列入 D5/D6 审计。

**vD5.3 UI manager capability 增量（2026-08-20）**：UI manager 现在由 renderer composition root 注入 `settingsManager` 与 `itemListManager`，settings reload/display、mouse-state reset 和 unread badge 更新优先走显式 capability；window service 仅作为旧页面 fallback。`node --check`、两项 consumer/Next gate 和主聊天 24-action 序列通过。该迁移不改变 UI manager 对外 facade，避免破坏 Classic 子页面和插件协议。

**vD5.3 appearance capability 增量（2026-08-20）**：Appearance Studio 增加 `configureCapabilities()`，由 composition root 注入 settings、appearance engine、UI manager、presentation normalizer 和 presentation applier；主题/预览/回滚路径优先使用显式 capability，旧 window bridge 保留为独立旧页面 fallback。`test:appearance-studio`、主聊天 24-action、`node --check` 和 `guard:next-delta` 通过。Appearance Studio 的公共 window facade 仍有 Next shell 与设置 UI 真实消费者，不能删除。

本轮补充审计：Appearance Studio 的 settings、appearance revision、toast/modal 和 presentation 读取均改为通过 capability helper 优先解析，减少残余 ambient 访问；`test:appearance-studio` 与 `guard:next-delta` 复跑通过。剩余 window 访问仅作为旧页面兼容 fallback 或公共 facade 暴露，仍需最终 consumer report 逐项确认。

**完整 UI System 复核（2026-08-20）**：`npm run check:ui-system` 全链路通过，包含 design subtraction、Classic parity/retirement、Next delta、Chat Kernel consumer、UI application/page runtime、stylelint、VCPUI consumer gate、UI System 85/85、appearance engine/studio、Next tab lifecycle、WebAwesome adapter 和 lifecycle/topic tests。该复核证明当前 UI 组合与静态边界稳定，但不替代 D7 人工 soak 或多主机 Windows 矩阵。

**vD5.3 UI helper capability 增量（2026-08-20）**：UI manager 的设置标签中键打开 modal 路径现优先使用 renderer 注入的 `uiHelper`，window helper 仅保留兼容 fallback；`node --check`、两项静态 gate 和主聊天 24-action 序列通过。

**vD5.3 UI manager dispose 增量（2026-08-20）**：UI manager 增加幂等 `dispose()`，撤销 capability 引用和 DOM 元素引用；renderer 在初始化后把该 disposer 注册到 `ownedRendererSubscriptions`，与 `DomListenerOwner` 一起完成主 Surface teardown。重复 dispose 安全，dispose 后重新 init 明确失败；`node --check`、静态 gates 和主聊天 24-action 序列通过。

**vD7 soak harness cleanup 增量（2026-08-20）**：`test-electron-manual-soak.mjs` 现在在 Windows 使用精确 PID 的 `taskkill /T /F` 终止 Electron 子进程树，并等待父进程退出；Linux/macOS 使用 SIGTERM/SIGKILL fallback。短时真实启动复核成功生成 observation artifact，仍固定为 `manual_observation_required`，不构成人工 soak 通过。

### 决策 vD-007：内部 ambient globals 全部迁移，公共 facade 分层保留

**原因**：把所有 `window.*` 一次性删除会破坏 Next、Classic 或插件公共命令协议；继续保留可变 settings/filter/presentation 全局又会形成第二状态权威。

**结果（2026-08-21）**：停止发布并删除 `window.globalSettings`、`window.applyChatPresentationMode`、`window.normalizeChatPresentationMode`、`window.checkMessageFilter` 和 `window.applyChatBubbleLayoutSettings`。内部消费者改用 settings snapshot/accessor、message-filter evaluator 和 presentation normalize/apply capability，写操作继续由既有 manager 持有。`window.VCPMainChatState`、`window.MainChatCommands` 与 `window.VCPAppearanceStudio` 作为公共 facade 保留，value 冻结且 window property 不可写、不可配置；测试通过 contribution registry/test adapter 覆盖，不再替换 facade。consumer report 同时清点 164 个 Classic/feature-local ambient 名称；它们是显式兼容债务，不属于本决策已经退休的目标集合。

### 决策 vD-008：selection 完成必须包含 topic projection consumer

**原因**：最终真实 Electron 序列发现 reload 后 durable selection 和 history 已恢复，但 `topic-item.active` 尚未投影；`selectItem()` 启动 `loadTopicList()` 后直接返回，producer commit 与 consumer completion 没有同一完成语义。

**结果（2026-08-21）**：`ChatManager.selectItem()` 等待 `topicListManager.loadTopicList()`，随后重新校验 selection generation，再持久化并返回。focused regression 证明 startup restore 不会早于 topic projection；主聊天 24 actions / 25 requests 与最终 Windows 矩阵通过。

### vD5/vD6 最终证据与限制

2026-08-21 最终当前主机矩阵 `artifacts/windows-matrix/2026-08-21T06-13-58-840Z.json` 六行通过。Lifecycle 为 3 warmup + 60 measured，connected elements 2569、listeners 876、processes 5、owner resources 163 稳定，detached roots/icons/options 为 0。严格 D5 复核后新增 `MainChatAttachmentOwner` 与 `MainChatSendOwner`，移除 `renderer.js` 对附件数组、发送按钮 DOM/ARIA、interruptible message 选择、group/agent 中止分派和本地取消回退的所有权；selection/topic 统一读取 `MainChatStateAuthority` refs，owner teardown 按注册逆序等待。`VCPMainChatState` 同时纳入 facade ledger，并以冻结、不可替换的只读 snapshot facade 保留给 Flowlock/AutoTTS。Chat Kernel 最终为 138/138，UI System 为 87/87。

矩阵 `2026-08-21T05-51-24-115Z.json` 和较早的 `2026-08-21T05-10-03-018Z.json` 均在主聊天行发生 Puppeteer `Runtime.callFunctionOn` protocol timeout，未产生产品断言或失败快照；同一最终代码的独立主聊天 sequence 与随后完整六行矩阵通过。失败 artifact 保留为测试基础设施波动证据，不能删除或用于证明产品 PASS。

vD5、vD6 标记 PASS；vD7 继续 BLOCKED。尚缺 30-60 分钟人工 soak checklist，以及支持范围内多 Windows 版本、打包方式、GPU/DPI 组合证据。

### 2026-08-21 对抗式补救复核

复核暴露并修复五类边界缺陷：selection authority 冻结值仍被原地修改；`VCPMainChatState` snapshot 嵌套对象可变且暴露 history ref；settings/presentation owner 未达到 quiescent dispose；attachment ref 存在外部数组别名与 durable-save 竞态；facade gate 只检查 smoke 文件存在。修复采用 clone-and-set authority、递归克隆冻结 consumer snapshot、tracked async generation guard、copy/freeze/append attachment owner，以及 npm smoke 入口和具体协议断言绑定。focused regression 33/33、Chat Kernel 140/140、UI System 88/88、完整 `check:ui-system`、consumer/Next gates、主聊天 24 actions / 25 requests 均通过。本补丁 lifecycle 复跑为 3 warmup + 20 measured，资源计数稳定且 detached roots/icons/options 为 0；历史 60-cycle 证据仍保留，但不冒充本补丁重跑。

**UI manager lifecycle focused test（2026-08-20）**：新增 `tests/ui-manager-lifecycle.test.mjs`，真实加载 UI manager facade，验证初始化后 `dispose()` 幂等、capability/DOM 引用撤销且 dispose 后重新 init 明确拒绝；该测试已纳入 `test:ui-system`。

**当前 Windows 矩阵复核（2026-08-20 20:49Z）**：`npm run test:windows-matrix` 在 FlowX13 / win32 / x64 / Node 22.17.1 上六项全部通过：UI/Classic 24/24、Settings WA、Next tab lifecycle、主聊天 24 actions / 25 requests、辅助 crash recovery 24 actions / 27 requests、lifecycle stress 3 warmup + 60 measured。最新 artifact 为 `artifacts/windows-matrix/2026-08-20T20-49-30-813Z.json`。Settings WA 的 resize CDP 能力仍按 skipped 记录；该矩阵仍只覆盖当前主机，不代表多版本、打包安装或 GPU/DPI 组合。
