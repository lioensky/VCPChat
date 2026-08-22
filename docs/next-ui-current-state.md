# 当前 UI 架构与交付基线

> 状态：当前权威事实文档<br>
> 核对日期：2026-08-21<br>
> 核对范围：当前工作树 `codex/chat-kernel-deep-decoupling-draft-20260821` 的实际代码、门禁与测试结果<br>
> 后续施工顺序：[`next-ui-development-roadmap.md`](./next-ui-development-roadmap.md)

> 文件名中的 `next-ui` 是历史命名。当前主窗口只有一套正式布局；`next` 是现行主窗口 presentation，不再与 Classic 构成可切换的双布局。Classic 仅保留给未迁移的业务子页面和兼容边界。

## 1. 文档用途

本文只回答四个问题：当前代码真实运行成什么样、哪些能力已有生产消费者、哪些能力只有测试或没有消费者、当前是否达到上游 PR 门槛。它不保存迁移过程，也不把计划中的能力写成已经交付。

事实发生变化时，必须在同一变更中更新本文、对应自动门禁和路线状态。历史方案可以保留，但不得继续自称“当前权威架构”。

## 2. 当前产品拓扑

主窗口只有一套规范 presentation，并由 `main.html` 静态声明 `data-ui-mode="next"`。历史 `uiMode` 值只在 settings schema 中兼容归一化，不再对应运行时 manager、状态通道或可切换 UI。

```text
上游聊天、助手、通知、设置与插件业务
├── 既有 manager / renderer / IPC
├── MainChatCommands（共享操作入口）
└── 唯一主窗口 presentation
    ├── NextShellController
    │   ├── AppTabHost
    │   ├── OverlayCoordinator
    │   ├── EmbeddedAppController
    │   ├── LaunchpadController
    │   ├── CreationController
    │   ├── AccountMenuController
    │   └── AssistantSearchController
    ├── VCPUI adapter
    │   └── Web Awesome 离线内核 / native fallback
    └── 上游共享消息、输入、列表和插件业务 DOM
```

业务子页面不等于主窗口 presentation。当前 12 个被检查的子页面全部继续使用上游 Classic 页面，中央启用清单为空；没有生产 HTML 加载子页面 Next runtime。

## 3. 已完成且有证据的能力

| 能力 | 当前状态 | 生产证据或门禁 |
|---|---|---|
| 单一主窗口 presentation | 已完成 | Classic retirement 与 Next delta guard；主窗口不再运行时换壳 |
| Shell 控制器拆分 | 已完成 | `next-shell/` 下 8 个窄控制器；`topTabManager` 为兼容 facade |
| 动态 Surface 生命周期 | 已完成核心范围 | `LifecycleScope`、owner tree、幂等和异步 dispose 测试 |
| Feedback Surface 所有权 | 已完成 | `feedback.owner(scope)` 隔离 Toast/Dialog/Loading；展示页 timer 归属 Scope |
| Overlay 与原生 View 对账 | 已完成 | overlay lease、session 恢复、renderer reload/crash 测试 |
| Ask Nova 取消与迟到结果隔离 | 已完成 | sender-owned task、取消、逆序完成和重开回归 |
| WebContentsView 会话清理 | 已完成 | close/destroy 对账、Escape 隔离、进程与 View 压力测试 |
| 主聊天操作序列 | 已完成可用基线 | 固定 seed、动作覆盖、故障注入、trace 重放 |
| 生命周期诊断 | 已完成 | renderer/main 只读 snapshot，Scope、listener、task、session 指标 |
| Web Awesome 离线闭包 | 已完成 | 固定版本、101 文件 closure、vendor 与 pack check |
| 前端插件兼容边界 | 已完成 | Loader 恢复上游合同；Next 生命周期不接管插件运行时 |
| 上游消息组件视觉语义 | 已保护 | Next 不重绘结构化消息内部组件，边界门禁存在 |

历史完整证据基线（2026-08-17，P3）：UI System 74/74、Electron UI Apps 22/22、24 步主聊天序列通过；生命周期压力测试 3 次预热加 20 次测量后保持 407 个 listener、8 个 Scope、162 项受管资源和 5 个 Electron process，detached root/icon/option 为 0。该结果只证明当时已覆盖路径稳定，不代表当前分支或任意服务、GPU、休眠、第三方插件组合绝对无缺陷。

## 4. 公共能力收口状态

P2 已删除休眠子页面 Next runtime、mode 传播和测试专用 settlement/state facade。中央策略仍报告 `0 active rebuilt, 12 upstream classic`；未来只有在首个真实页面消费者与测试同时进入时才重新引入最小 runtime。设置、创建和 item list 测试改为等待真实 Promise、结果事件或 DOM 终态；具有真实 Electron 消费者的 `AppTabHost.whenSettled()` 继续保留。

### 4.1 Contribution Registry

- `commands`：由 `MainChatCommands` 生产并由 Shell/facade 消费。
- `apps`：由正式内部应用生产，并由 Launchpad、tab host 和 session restore 消费；“UI 组件库”是用户可见的正式内部应用。
- `menus`：因没有生产注册者已删除。
- `settings`：因没有生产 producer 或 consumer 已删除。

保留 Registry 均满足 register → production use → owner dispose → absent；打开中的内部应用注销时，其 tab 与 Surface 同步关闭。

### 4.2 VCPUI 组件成熟度

组件清单现有 13 个 `stable` 和 19 个 `candidate`。Consumer gate 为每个 Stable 组件校验真实业务源码与 Electron 证据，并确认 32 个组件均继续出现在用户可见组件库；展示页独占组件只能保持 Candidate。

## 5. 明确边界

以下内容不属于当前路线：

- 不改变前端插件 Loader、插件卸载或热重载协议。
- 不为动态壁纸建立专属生命周期框架、测试矩阵或数据迁移。
- 不迁移 Notes、Translator、Memo、Forum 等业务子页面的 presentation。
- 不重写上游聊天、消息、输入、流式、附件和工具组件。
- 不引入 React、Vue、Cordis 或新的全应用容器。
- 不为了统一形式，把页面级稳定 singleton 全部迁入 `LifecycleScope`。

若未来要改变任一边界，必须单独立项，并以真实消费者和独立 PR 证明必要性。

## 6. 当前 PR 就绪判断

当前 UI 拓扑已收敛为单一主窗口 presentation。Chat Kernel 深度解耦的 D5/D6 已在范围内通过：`renderer.js` 只承担 composition/lifecycle orchestration，本路线指定的 settings/filter/presentation ambient facade 已退休。D7 仍未完成，原因是缺少跨 Windows/打包/GPU-DPI 矩阵和 30–60 分钟人工 soak；不得将单主机自动化外推为最终发布就绪。D 阶段状态以 [`chat-kernel-vd7-final-audit.md`](./chat-kernel-vd7-final-audit.md) 为唯一权威，测试数字只以该审计及其记录的最近一次执行为准。

以下 P0–P4、同步提交和历史 Windows/macOS 数字均为 2026-08-17 的阶段性验收记录，保留用于追溯，不代表当前分支的最新通过状态。

Windows 生成的 `settingsManager.js` 基线曾错误绑定 CRLF 工作区字节；门禁现统一按 LF 文本语义计算 SHA-256，并用 LF/CRLF 等价断言防复发。Web Awesome 生成产物通过 `.gitattributes` 仅在 `vendor/webawesome-runtime/**` 禁用 text conversion 和 whitespace diagnostics；源码检查保持启用，pack check 会验证该属性没有丢失。

当前分支自动证据（详细阶段状态以最终审计为准）：

- Chat Kernel：146/146；UI System：97/97。
- `npm run check:ui-system`：通过，包含 design subtraction、consumer、Classic、Next、应用运行时和 UI System 全链路。
- Electron UI Apps：24/24；主聊天与辅助窗口证据、当前主机 Windows 矩阵见 [`chat-kernel-vd7-final-audit.md`](./chat-kernel-vd7-final-audit.md)。
- 当前工作树 Windows matrix：六行全部通过，包含 60-cycle lifecycle；30 分钟 manual-soak 观察已生成 artifact，但 checklist 仍为 `manual_observation_required`。
- Electron unpacked packaged 构建当前因 `electron-edge-js` MSBuild exit 1 失败；不能把 source/runtime smoke 外推为 packaged PASS。
- Web Awesome closure 与 pack check：沿用既有通过证据，发布配置矩阵仍属于 D7 未完成项。

尚未闭合的发布证据仍包括 30–60 分钟人工 soak、真实 packaged Electron runtime 和跨配置矩阵；`npm run check:chat-release-evidence` 会在这些证据缺失时明确失败。这不影响 C0–C7 实现退出条件，但不应把自动矩阵代替人工体验观察。本分支现提供 Chat Kernel 与 UI 的 PR 门禁工作流；跨配置 Windows、打包安装和人工 soak 仍需单独执行。

当前文档权威关系已在 2026-08-20 收敛；历史文档可以保留当时的双 presentation 描述，但不得用于描述当前主窗口拓扑。

P1 所有权缺陷已于 2026-08-17 关闭：组件展示页不再调用全局 `cancelAll()`，其 Feedback 与 timer 均由页面 Scope 持有。Windows 验证为 UI System 75/75、Electron UI Apps 22/22、生命周期压力 3 次预热 + 20 次测量通过；压力 checkpoint 保持 8 个 Scope、164 项受管资源、410 个 listener、5 个 Electron process，detached root/icon/option 为 0。

P2 无消费者架构减法已于 2026-08-17 关闭：产品文件树不再携带休眠子页面 runtime、静态 mode facade 或 Settings/Creation/item list 测试 Store；负向边界门禁阻止这些接口在无生产消费者时回归。完整 Windows 验证为 UI System 75/75、Electron UI Apps 22/22、24 步主聊天序列和生命周期压力 3 次预热 + 20 次测量通过。

P3 公共合同收口已于 2026-08-17 关闭：13 个 Stable 组件均具备生产与 Electron 证据，19 个 Candidate 继续用于正式组件库展示；Registry 仅保留 `commands/apps`，内部应用注销会关闭对应 tab 与 Surface。完整 Windows 验证为 UI System 74/74、Electron UI Apps 22/22、24 步主聊天序列和生命周期压力 3 次预热 + 20 次测量通过；压力 checkpoint 保持 8 个 Scope、162 项受管资源、407 个 listener、5 个 Electron process，detached root/icon/option 为 0。

P4 自动门禁已关闭；同步后 Windows 复验和人工 soak 仍待补齐。动态壁纸、插件运行时和业务子页面迁移继续排除在本轮之外。

Chat Kernel 的早期 C0–C7 子路线已有既有证据；当前工作转入 D0–D7 深度解耦路线。不要用早期 C0–C7 的通过记录替代 D5–D7 的退出证据。

深度解耦已完成 D0–D6 的范围内退出：`MainChatSurfaceAdapter`、`StreamCoordinator`、`StreamTransientHistory`、operation-scoped `StreamProjection`、独立 Surface consumer 和 owner-scoped preload subscription 已接入生产；主题、设置/presentation、TTS、Flowlock、辅助 preload 事件、forward、附件和 DOM listener 均已有 named owner。D7 继续只补齐发布配置和人工观察证据，不以重写 UI 或增加 facade 为目标。

D0 consumer baseline 已接入 `check:ui-system`：生产引用、测试引用和 Kernel 禁止反向依赖均由 `guard:chat-kernel-consumers` 重复检查。该报告只记录当前事实，不把 legacy facade 自动升级为稳定公共 API。

D0–D6 已接入生产并具备各自的源码、静态门禁和自动化证据；D7 BLOCKED。历史复核的 115/115、129/129、85/85 等数字保留为历史记录，不能作为当前状态。当前 Chat Kernel、UI System、Electron 和 Windows 单主机证据统一记录在最终审计；多版本/打包/GPU-DPI 配置、packaged native rebuild 和人工 checklist 仍未完成。

最新 vD5 增量已将主聊天选择、history 与 TTS 状态改为显式 capability/owner：`VCPMainChatState` 只读快照替代可变 selection globals，主 history 由 `MainChatStateAuthority` 持有，`TtsSurfaceOwner` 持有 AudioContext、队列和订阅；`TopicSelectionReadiness` 替代 renderer-ready/pending selection 全局字段。Flowlock、AutoTTS 和 Electron 序列测试均已迁移到真实 consumer。该增量当时为 Chat Kernel 113/113；当前测试数字只读取最终审计。辅助 Voice/Rust 并发流场景已纳入主聊天序列。

并发流的终态持久化现在会在 stream terminal 显式 flush 并等待当前 topic 的 ChatRepository 保存；独立交互 Surface 的测试也在下一次请求前等待真实 `aria-busy=false` 终态，避免把 terminal 事件误当成发送 Promise 已完成。

## 7. 文档权威关系

| 文档 | 定位 |
|---|---|
| 本文 | 当前主窗口拓扑和 UI 产品状态的权威 |
| `chat-kernel-vd7-final-audit.md` | D0–D7 阶段状态、自动化证据与 D7 未完成项的唯一权威 |
| `chat-kernel-deep-decoupling-roadmap.md` | D0–D7 仍有效的目标、行为合同、架构决策和退出条件 |
| `next-ui-development-roadmap.md` | UI 后续施工顺序；不重复维护 D 阶段状态 |
| `next-ui-lifecycle-architecture.md` | 生命周期合同和所有权规则 |
| `main-chat-operation-sequence-testing.md` | 操作序列模型、覆盖与故障注入规则 |
| `ui-engineering-standard.md` | 新代码的工程 Definition of Done |
| `ui-interaction-accessibility-roadmap.md` | 键盘、焦点、ARIA、异步终态、主题/DPI/fallback 与任务级回归的完整施工路线 |
| `classic-retirement-architecture.md` | 已完成的主窗口收敛决策与历史施工记录 |
| `design-system-upstream-pr-convergence.md` | 历次 PR 审查和整改日志，不代表当前状态 |
| `upstream-function-parity.md` | 历史双 presentation 验证记录，不再定义当前产品拓扑 |
| `archive/2026-08-chat-kernel-and-ui-roadmaps/` | 已完成、已停止或按时间追加的历史路线；只用于追溯，不声明当前状态 |

## 8. 更新规则

- “已完成”必须同时有生产消费者、自动证据和明确 owner。
- 测试专用 API 不算产品能力；策略禁用的代码不算已交付能力。
- 任何阶段只有全部退出条件满足后才能标为完成，不能用“按需完成”替代状态。
- 新发现的问题先归因于上游或 Next delta，再决定是否进入本路线。
- 路线变化必须保留删除项和非目标，防止后续会话重新扩张范围。
历史证据保留其原始日期和计数；当前 D5/D6 结论与 D7 阻断项只读取最终审计。完整 Windows 配置矩阵和人工 soak 仍待完成。

人工 soak 入口现为 `npm run test:manual-soak`，运行产物写入 `artifacts/manual-soak/` 并固定标记为 `manual_observation_required`；它只提供真实 Electron 采样和人工检查清单，不会替代人工交互或把单台 Windows 观察升级为发布证据。

最新单机 Windows 串行矩阵 artifact 只在 [`chat-kernel-vd7-final-audit.md`](./chat-kernel-vd7-final-audit.md) 维护；resize CDP 仍为显式 skipped，矩阵不代表多版本或安装包覆盖。
