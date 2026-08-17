# Next UI 当前架构与交付基线

> 状态：当前权威事实文档<br>
> 核对日期：2026-08-17<br>
> 核对范围：`codex/design-system-upstream-latest` 已提交文件树相对 `upstream/main`<br>
> 后续施工顺序：[`next-ui-development-roadmap.md`](./next-ui-development-roadmap.md)

## 1. 文档用途

本文只回答四个问题：当前代码真实运行成什么样、哪些能力已有生产消费者、哪些能力只有测试或没有消费者、当前是否达到上游 PR 门槛。它不保存迁移过程，也不把计划中的能力写成已经交付。

事实发生变化时，必须在同一变更中更新本文、对应自动门禁和路线状态。历史方案可以保留，但不得继续自称“当前权威架构”。

## 2. 当前产品拓扑

主窗口只有一套规范 presentation。历史 `uiMode` 值仍可兼容读取，但不再切换主窗口的两棵 UI；`uiModeManager` 当前只是兼容 facade。

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
| Overlay 与原生 View 对账 | 已完成 | overlay lease、session 恢复、renderer reload/crash 测试 |
| Ask Nova 取消与迟到结果隔离 | 已完成 | sender-owned task、取消、逆序完成和重开回归 |
| WebContentsView 会话清理 | 已完成 | close/destroy 对账、Escape 隔离、进程与 View 压力测试 |
| 主聊天操作序列 | 已完成可用基线 | 固定 seed、动作覆盖、故障注入、trace 重放 |
| 生命周期诊断 | 已完成 | renderer/main 只读 snapshot，Scope、listener、task、session 指标 |
| Web Awesome 离线闭包 | 已完成 | 固定版本、101 文件 closure、vendor 与 pack check |
| 前端插件兼容边界 | 已完成 | Loader 恢复上游合同；Next 生命周期不接管插件运行时 |
| 上游消息组件视觉语义 | 已保护 | Next 不重绘结构化消息内部组件，边界门禁存在 |

最近一次完整证据基线：UI System 75/75、Electron UI Apps 22/22、36 步主聊天序列通过；生命周期压力测试 3 次预热加 20 次测量后 listener、Scope、受管资源、process 和 renderer process 均保持恒定，detached root/icon/option 为 0。该结果证明已覆盖路径稳定，不代表任意服务、GPU、休眠或第三方插件组合绝对无缺陷。

## 4. 当前未完成或名不副实的能力

### 4.1 组件展示页的反馈所有权错误

组件展示页销毁时调用全局 `VCPUI.feedback.cancelAll()`，会取消其他 Surface 拥有的 Dialog、Toast 和 Loading；展示页的模拟 Loading timer 也没有属于页面 Scope。这是实际生命周期缺陷，必须在 PR 前修复。

### 4.2 子页面 Next runtime 没有生产消费者

以下能力已进入产品文件树，但当前没有生产页面使用：

- `vcp-ui-runtime-bootstrap.js`
- `vcp-page-rebuild.js`
- 子页面 mode controller 传播
- preload `onUiModeUpdated`
- runtime CSS 与对应测试/文档

中央策略报告 `0 wired, 0 active rebuilt, 12 upstream classic`。这些代码不能以“以后可能迁移页面”为理由留在首个主窗口 PR；应先删除，待第一个真实业务页面迁移时与消费者一起引入。

### 4.3 Settlement 接口扩张超过生产需要

`AppTabHost.whenSettled()` 已被真实 Electron 操作序列使用，应保留。Settings、Creation、Identity 和 item list 的部分 revision/settlement API 目前主要或完全只有测试消费者，却被安装到生产窗口并暴露为全局接口。

测试需要确定性等待是合理目标，但默认方案应是等待真实 operation promise，或使用受限 diagnostics/test seam；不能仅为了测试方便扩大共享业务 manager 的公共合同。

### 4.4 Contribution Registry 只有部分种类成立

- `commands`：有真实业务消费者，应保留。
- `apps`：目前主要服务组件展示应用，需要随展示页产品定位重新判断。
- `menus`：有消费端但没有稳定生产注册者。
- `settings`：没有生产 producer 或 consumer。

Registry 应遵循“第一个真实消费者与抽象同时进入”的规则。没有消费者的 contribution kind 不视为已完成能力。

### 4.5 VCPUI 组件成熟度声明过宽

组件清单中部分 `stable` 组件只有展示页、测试或文档消费者，与“至少一个真实业务界面使用”的工程规则冲突。首次主 PR 前需要生成消费者报告，只有具备业务使用和 Electron 验证的组件可保持 `stable`；其余降为 `candidate` 或退出公共 API。

### 4.6 兼容 facade 尚未确定退役条件

`uiModeManager` 始终归一到 `next`，状态不会变化。若上游从未发布过其旧 API，应直接删除；若确有外部兼容对象，必须记录消费者、兼容期限和删除条件。不能让静态空壳永久成为第二状态源的外观。

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

当前分支适合继续稳定化开发，但尚未达到干净的上游主 PR 门槛。阻塞项是：

1. 修复组件展示页跨 owner 的全局反馈清理和未受管 timer。
2. 让 `git diff --check upstream/main...HEAD` 对生成 vendor 文件采用安全、限定范围的 whitespace 策略并通过。
3. 删除或隔离零消费者的子页面 Next runtime 和 preload mode API。
4. 缩减测试专用 settlement/state 公共面。
5. 校正 contribution kinds 与 VCPUI `stable` 声明。
当前文档权威关系已在 2026-08-17 收敛；历史文档可以保留当时的双 presentation 描述，但已明确标记为历史记录。

上述五项阻塞关闭后，还需要重新运行完整 UI、Electron smoke、主聊天序列、生命周期压力和离线打包门禁。用户本地 `styles/themes.css` 修改必须继续独立处理，不得误入架构收敛提交。

## 7. 文档权威关系

| 文档 | 定位 |
|---|---|
| 本文 | 当前实现、真实消费者、完成度与 PR 状态的唯一权威 |
| `next-ui-development-roadmap.md` | 从当前状态继续施工的唯一权威顺序 |
| `next-ui-lifecycle-architecture.md` | 生命周期合同和所有权规则 |
| `main-chat-operation-sequence-testing.md` | 操作序列模型、覆盖与故障注入规则 |
| `ui-engineering-standard.md` | 新代码的工程 Definition of Done |
| `classic-retirement-architecture.md` | 已完成的主窗口收敛决策与历史施工记录 |
| `design-system-upstream-pr-convergence.md` | 历次 PR 审查和整改日志，不代表当前状态 |
| `upstream-function-parity.md` | 历史双 presentation 验证记录，不再定义当前产品拓扑 |

## 8. 更新规则

- “已完成”必须同时有生产消费者、自动证据和明确 owner。
- 测试专用 API 不算产品能力；策略禁用的代码不算已交付能力。
- 任何阶段只有全部退出条件满足后才能标为完成，不能用“按需完成”替代状态。
- 新发现的问题先归因于上游或 Next delta，再决定是否进入本路线。
- 路线变化必须保留删除项和非目标，防止后续会话重新扩张范围。
