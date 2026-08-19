# Next UI 当前架构与交付基线

> 状态：当前权威事实文档<br>
> 核对日期：2026-08-19<br>
> 核对范围：`codex/ui-ux-harness-research-20260819` 已提交文件树相对 `upstream/main`<br>
> 后续施工顺序：[`next-ui-development-roadmap.md`](./next-ui-development-roadmap.md)

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
| Escape 与键盘导航所有权 | 已完成核心范围 | 优先级 Escape dispatcher、Launchpad 方向键/Home/End、controller fallback listener dispose 回归 |
| 通知菜单单一所有者 | 已完成 | 旧 `event-listeners` 重复绑定已停用；controller 单测与 Electron 命令计数证明每个动作只执行一次 |
| 全局设置永久 pending | 已完成核心范围 | 保存 IPC 有界等待，超时释放提交锁并进入可恢复失败；新增回归覆盖 |

最近一次完整证据基线（2026-08-17，P3）：UI System 74/74、Electron UI Apps 22/22、24 步主聊天序列通过；生命周期压力测试 3 次预热加 20 次测量后保持 407 个 listener、8 个 Scope、162 项受管资源和 5 个 Electron process，detached root/icon/option 为 0。该结果证明已覆盖路径稳定，不代表任意服务、GPU、休眠或第三方插件组合绝对无缺陷。

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

当前分支已完成 P0–P3 与 P4 自动化门禁。2026-08-19 基于 `upstream/main` `3da77f00` 更新了共享 settings 基线，并恢复了被历史提交链遗漏的优先级 Escape dispatcher 与 Launchpad 键盘/降级监听所有权。两处共享文件已逐段审查并以理由和规范化文本哈希更新冻结基线。

Windows 生成的 `settingsManager.js` 基线曾错误绑定 CRLF 工作区字节；门禁现统一按 LF 文本语义计算 SHA-256，并用 LF/CRLF 等价断言防复发。Web Awesome 生成产物通过 `.gitattributes` 仅在 `vendor/webawesome-runtime/**` 禁用 text conversion 和 whitespace diagnostics；源码检查保持启用，pack check 会验证该属性没有丢失。

同步后的 macOS 自动证据：

- `npm run check:ui-system`：通过（含 Escape dispatcher、Launchpad 与最新共享边界证据）。
- Electron UI Apps：22/22。
- 主聊天操作序列：24 actions、11 action kinds、21 pairs、12 transitions、2 faults、required edge 1/1。
- 生命周期压力：3 次预热 + 20 次测量；861 listener、8 Scope、162 受管资源、5 process、2 renderer process 在全部 checkpoint 恒定，detached root/icon/option 为 0，heap 约 9.8 MiB → 9.7 MiB。
- Web Awesome closure：101 files、0.46 MiB，可重复生成；pack check 通过。
- `git diff --check upstream/main...HEAD`：通过。

尚未完成的发布证据只有同步后 Windows 复验和 30–60 分钟人工 soak。二者不应由 macOS 自动结果代替，因此当前状态是“代码与自动门禁就绪，跨平台/人工发布证据待补”。本分支明确不携带 `.github/workflows/**`，跨平台验证由外部 Windows 环境或上游 CI 执行。

2026-08-19 Harness 路线最新自动证据：`test:ui-system` 86/86，Electron UI Apps 22/22，主聊天序列 24 actions / 11 action kinds / 21 pairs / 12 transitions / 2 faults，生命周期压力 3 次预热加 20 次测量后保持 873 listener、8 Scope、174 项受管资源和 5 个 Electron process，detached root/icon/option 为 0，heap 约 10.2 MiB → 10.1 MiB；Web Awesome 101 文件 closure 与 pack check 通过。这些数字是该次 macOS 运行证据，不替代 Windows 与人工 soak。

本机 `npm run pack` 能生成 macOS arm64 目录。使用隔离 `userData` 和 `VCPCHAT_E2E_TEST=1` 启动打包 app 后，进程可存活但 15 秒内未创建 remote-debugging 端口；`sample` 显示主线程停在原生 `NSAlert runModal`，因此“打包产物实际启动”仍是未通过的 A6 证据。该结果需要在签名/可见桌面环境进一步定位，不被 repo closure 检查替代。

当前文档权威关系已在 2026-08-17 收敛；历史文档可以保留当时的双 presentation 描述，但已明确标记为历史记录。

P1 所有权缺陷已于 2026-08-17 关闭：组件展示页不再调用全局 `cancelAll()`，其 Feedback 与 timer 均由页面 Scope 持有。Windows 验证为 UI System 75/75、Electron UI Apps 22/22、生命周期压力 3 次预热 + 20 次测量通过；压力 checkpoint 保持 8 个 Scope、164 项受管资源、410 个 listener、5 个 Electron process，detached root/icon/option 为 0。

P2 无消费者架构减法已于 2026-08-17 关闭：产品文件树不再携带休眠子页面 runtime、静态 mode facade 或 Settings/Creation/item list 测试 Store；负向边界门禁阻止这些接口在无生产消费者时回归。完整 Windows 验证为 UI System 75/75、Electron UI Apps 22/22、24 步主聊天序列和生命周期压力 3 次预热 + 20 次测量通过。

P3 公共合同收口已于 2026-08-17 关闭：13 个 Stable 组件均具备生产与 Electron 证据，19 个 Candidate 继续用于正式组件库展示；Registry 仅保留 `commands/apps`，内部应用注销会关闭对应 tab 与 Surface。完整 Windows 验证为 UI System 74/74、Electron UI Apps 22/22、24 步主聊天序列和生命周期压力 3 次预热 + 20 次测量通过；压力 checkpoint 保持 8 个 Scope、162 项受管资源、407 个 listener、5 个 Electron process，detached root/icon/option 为 0。

P4 自动门禁已关闭；同步后 Windows 复验和人工 soak 仍待补齐。动态壁纸、插件运行时和业务子页面迁移继续排除在本轮之外。

## 7. 文档权威关系

| 文档 | 定位 |
|---|---|
| 本文 | 当前实现、真实消费者、完成度与 PR 状态的唯一权威 |
| `next-ui-development-roadmap.md` | 从当前状态继续施工的唯一权威顺序 |
| `next-ui-lifecycle-architecture.md` | 生命周期合同和所有权规则 |
| `main-chat-operation-sequence-testing.md` | 操作序列模型、覆盖与故障注入规则 |
| `ui-engineering-standard.md` | 新代码的工程 Definition of Done |
| `ui-interaction-accessibility-roadmap.md` | 键盘、焦点、ARIA、异步终态、主题/DPI/fallback 与任务级回归的完整施工路线 |
| `classic-retirement-architecture.md` | 已完成的主窗口收敛决策与历史施工记录 |
| `design-system-upstream-pr-convergence.md` | 历次 PR 审查和整改日志，不代表当前状态 |
| `upstream-function-parity.md` | 历史双 presentation 验证记录，不再定义当前产品拓扑 |

## 8. 更新规则

- “已完成”必须同时有生产消费者、自动证据和明确 owner。
- 测试专用 API 不算产品能力；策略禁用的代码不算已交付能力。
- 任何阶段只有全部退出条件满足后才能标为完成，不能用“按需完成”替代状态。
- 新发现的问题先归因于上游或 Next delta，再决定是否进入本路线。
- 路线变化必须保留删除项和非目标，防止后续会话重新扩张范围。
