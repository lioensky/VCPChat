# Chat Kernel vD0-vD7 Final Audit

审计日期：2026-08-21。本文是发布前状态审计，不是整个路线完成声明。vD5/vD6 已达到当前退出条件；vD7 仍缺人工 soak 和跨 Windows/打包/GPU-DPI 证据，因此不得标记 D0-vD7 最终完成。

| 阶段 | 退出条件 | 当前证据 | 状态 |
| --- | --- | --- | --- |
| vD0 | owner、producer、consumer、失败入口和工作树边界冻结 | `docs/chat-kernel-consumer-report.json`、当前执行合同、当前 git 状态 | PASS（工作树仍含用户改动） |
| vD1 | StreamSession/State 无 DOM/Electron，terminal/generation/late-event 可复现 | `npm run test:chat-kernel` 144/144 | PASS |
| vD2 | coordinator 等待真实 reader、terminal 和 persistence，dispose 达到 quiescence | coordinator/history/operation tests、lifecycle stress | PASS |
| vD3 | 主聊天、独立 Surface、VoiceChat、Rust Assistant 有真实隔离 consumer | 主聊天序列、辅助 reload/crash matrix、consumer gate | PASS（当前主机真实入口） |
| vD4 | RenderDependencies、root、render model、capability closure 显式化 | render dependency/surface/projection tests、Next delta gate | PASS |
| vD5 | `renderer.js` 只作主聊天 composition/lifecycle root；业务状态、副作用和资源由 named owner 持有 | owner modules、renderer responsibility gate、UI/主聊天 Electron、本补丁 20-cycle lifecycle | PASS |
| vD6 | 本路线目标的内部 ambient consumers 清零；保留 facade 窄化、冻结、唯一 owner、有真实消费者和动态 smoke | facade ledger、retired-global negative gate、Electron UI Apps/Next/Classic | PASS（范围限定） |
| vD7 | 唯一 terminal/persistence authority、发布配置矩阵、30-60 分钟人工 soak、逐项审计 | 当前主机矩阵、辅助恢复、manual-soak harness | BLOCKED：缺多版本/打包/GPU-DPI Windows 证据；缺人工 checklist 记录 |

## vD5 责任审计

- `renderer.js` 只保留 DOM root 查询、provider/capability 构造、manager/adapter/owner 装配、mount 和逆序 dispose。
- 设置 projection、表单同步、presentation normalize/apply、字体和气泡布局由 `MainChatSettingsPresentationOwner` 持有；主题、TTS、Flowlock、辅助 preload 事件、forward modal、DOM listener、附件瞬态状态和发送/中止策略分别由 named owner 持有。
- `MainChatAttachmentOwner` 提供唯一稳定 attachment ref 和 preview projection；`MainChatSendOwner` 持有 send/interrupt DOM/ARIA、interruptible message 选择、group/agent 中止分派及失败时 coordinator-owned local cancel。`renderer.js` 只注入 capability，并按注册逆序等待所有 owner dispose。
- `renderer.js` 不拥有 stream terminal、durable persistence、TTS queue、history cache 或 preload business-event 状态；静态门禁禁止这些责任回流。
- preload subscription、ChatManager 与 UIManager 的异步 consumer/observer/theme subscription 现在都是 owned effect。dispose 会先 abort/invalidate generation，再撤销 producer，并等待 in-flight consumer、last-open save 和 outgoing persistence queue；迟到 Canvas/theme/settings 结果不再投影。
- 本轮真实 Electron 首次暴露 startup restore 在 topic DOM consumer 完成前返回。`ChatManager.selectItem()` 现等待 `topicListManager.loadTopicList()`，并在等待后重新校验 selection generation；回归测试证明 restore 不会早于 topic projection 完成。
- 对抗式复核发现 selection authority 的冻结值仍被 ChatManager、SettingsManager 和 MessageRenderer 原地写入，附件 ref 存在数组别名竞态，InputEnhancer 与 settings/presentation owner 在 dispose 后仍可能投影迟到结果。现已统一改为 clone-and-set、owned attachment append、tracked async task 与 generation guard。
- 文件变更触发的 history sync 现捕获 item/topic generations 和 conversation identity；读取返回后只允许仍为当前选择的同步提交 DOM 与 history。选择切换、较新的同步或 dispose 都会使旧同步失效；`chat-manager-selection-race` 覆盖切换与 dispose 两条迟到结果路径。

## vD6 facade 审计

- 已删除并由负向门禁禁止：`window.globalSettings`、`window.applyChatPresentationMode`、`window.normalizeChatPresentationMode`、`window.checkMessageFilter`、`window.applyChatBubbleLayoutSettings`。
- 仓内 weather、settings、notification renderer、Next shell、Appearance Studio、Flowlock 和 global settings manager 已改用显式 settings/filter/presentation capability。
- 保留 `window.VCPMainChatState`、`window.MainChatCommands` 与 `window.VCPAppearanceStudio`。三者均由唯一 owner 以 `Object.defineProperty` 发布，value 冻结且属性不可写、不可配置；`VCPMainChatState` 只暴露只读 snapshot，不包含 mutation refs。生产消费者、公共方法、动态 smoke 和退役条件登记在 consumer report。
- 测试不再替换公共 facade；临时命令覆盖通过 contribution registry 或显式 test adapter 完成。
- consumer report 当前清点 164 个直接发布的 ambient facade 名称。除上述三个受支持公共 facade 外，其余统一标记为 `legacy-or-feature-local-ambient` 兼容债务；vD6 PASS 只表示本路线指定的 settings/filter/presentation 与旧 chat/renderer/stream facade 已退休，不表示全仓所有 `window.*` 已消失。
- facade gate 现在把每个保留 facade 绑定到具体 npm smoke 入口与协议断言片段，不再仅以测试文件存在作为动态覆盖证明。

## 当前自动化证据

- Chat Kernel：144/144。
- UI System：92/92；`npm run check:ui-system` 已在本次门禁修正后复跑，完整链路通过。
- Electron UI Apps：24/24；主聊天：24 actions / 25 VCP requests；辅助 crash recovery：24 actions / 27 VCP requests。
- Windows 当前主机最终矩阵：`artifacts/windows-matrix/2026-08-21T06-13-58-840Z.json`，六行全部通过。Settings resize CDP 能力显式 skipped，不计为通过。
- 历史最终矩阵包含 3 warmup + 60 measured。当前精确补丁（包括 Electron fixture 协议超时与进程树清理修正）的最新复跑为 3 warmup + 20 measured：connected elements 2569、listeners 876、lifecycle resources 163 保持稳定；detached roots/icons/options 均为 0。不得把历史 60-cycle 记录描述为本补丁的重跑证据。
- 矩阵 `artifacts/windows-matrix/2026-08-21T05-51-24-115Z.json` 与较早的 `2026-08-21T05-10-03-018Z.json` 在主聊天行发生 Puppeteer `Runtime.callFunctionOn` protocol timeout，没有产品断言或失败快照；同一最终代码的独立序列和随后完整串行矩阵通过。失败 artifact 保留为当前主机测试基础设施波动证据，不用于证明产品 PASS。
- 本次复核也观察到并发或协议超时后 Electron fixture 可能遗留测试进程树。主聊天与 lifecycle harness 现使用启动 PID 的 Windows `taskkill /T /F` 精确清理，并配置独立 protocol timeout；清理验证后只保留复核前已存在的用户 Electron 进程。后续协议超时仍记为失败证据，不通过无限重试升级为产品 PASS。
- 人工 soak 入口为 `npm run test:manual-soak`；产物状态固定为 `manual_observation_required`，短时 smoke 不能当作人工通过。

## 文档权威与归档

- 当前产品/UI 拓扑只在 `next-ui-current-state.md` 维护。
- 当前 D0-D7 合同只在 `chat-kernel-deep-decoupling-roadmap.md` 维护；当前阶段和测试数字只在本文维护。
- C0-C7 路线、D0-D7 时间线审查日志、旧 Web Awesome 并行 presentation 路线和已停止的整页迁移计划已移入 `docs/archive/2026-08-chat-kernel-and-ui-roadmaps/`。归档只用于追溯，不得覆盖当前状态。

## 未完成项与完成所需证据

1. 在要求支持的 Windows 版本、打包安装方式、GPU/DPI 组合上运行同一矩阵，并分别保存环境、命令、退出码和 stderr。
2. 运行 30-60 分钟人工 soak；操作员逐项验证发送/流式/取消/重试、历史切换、附件、主题与设置、通知/desktop push、VoiceChat、Rust Assistant、reload/crash、Classic 页面和插件协议，并填写 artifact checklist。
3. 完成人工 soak 与跨配置矩阵后，重新运行静态门禁和真实 Electron 入口，再进行 vD7 逐项审计。

在上述证据齐全前，不得调用整体目标完成标记，也不得在发布说明中宣称 vD7 或最终深度解耦完成。
