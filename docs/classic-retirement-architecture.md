# Classic 退场与单一布局收敛记录

> 状态：历史决策与已完成施工记录，不再作为当前路线。当前事实见 [`next-ui-current-state.md`](./next-ui-current-state.md)，后续顺序见 [`next-ui-development-roadmap.md`](./next-ui-development-roadmap.md)。主窗口只有一个规范 presentation；旧 `uiMode` 值仅作为读取兼容缝保留，不再触发运行时换壳。
>
> 上位路线：[`next-ui-development-roadmap.md`](./next-ui-development-roadmap.md)。业务竞态 oracle：[`main-chat-operation-sequence-testing.md`](./main-chat-operation-sequence-testing.md)。功能对等基线：[`upstream-function-parity.md`](./upstream-function-parity.md)。

## 1. 决策摘要

VCPChat 主窗口的 Classic presentation 已完成退场。施工核对证实，Classic 与 Next 从来不是两套完整主窗口：消息、输入、侧栏、通知和设置的大部分 DOM 与业务调用本来就是共享的。本轮只收口少量真实分叉、让 Next 新 Surface 稳定常驻，并删除 `uiMode` 门控与失效样式，没有重写共享聊天业务。

最终目标是：

```text
上游业务 owner / manager / main-process service
             │
             ├── command：改变业务状态
             ├── query：读取不可变 snapshot
             └── subscribe：订阅后续 snapshot，返回 disposer
                         │
                         └── 唯一 VCPChat presentation
                             ├── Shell 与区域 host
                             ├── VCPUI（仅 UI 内核）
                             └── Web Awesome / native fallback
```

Classic 的成熟业务行为保留，Next 的工作台结构保留；被删除的是 Classic 专属 presentation 规则、模式分支和兼容 facade，不是上游聊天、插件、设置、侧栏、通知或数据协议。

本路线采用以下约束：

1. 不进行全窗口替换；先区分真正双实现、Next 新增 Surface 与原本共享的核心，只对少量真实分叉执行契约收口。
2. 不建立第二份聊天或应用业务 Store；现有上游 manager 继续是 provider 与权威 owner。
3. M4、M6 按区域即时补齐，不以“抽象完成率”阻塞 M10。
4. 主聊天与输入区不作为迁移对象；其流式、历史、工具与附件语义只由现有稳定性路线保护。
5. R4 已将主窗口切到唯一规范布局；旧 `classic` 配置仍可读取，但规范化为 `next`。主题、壁纸、字体、侧栏宽度、聊天和插件数据没有迁移或重置。

## 2. 先区分三类区域

Classic 与 Next 不是两套完整应用。当前主聊天正文和输入区本来就复用同一个 `#chatMessages`、`#messageInput`、发送/附件/表情按钮、`chatManager`、`messageRenderer` 和 `streamManager`。Next 的主要变化集中在外层 Shell、顶栏、启动台、应用标签、空会话视觉、外观样式和部分动态 Surface。

退场 inventory 必须先把区域分为三类：

| 类型 | 例子 | 正确动作 |
|---|---|---|
| A：真正双 presentation/控制流 | 顶栏、左右侧栏的部分入口、设置展示、模式切换 facade | 建立共享契约，临时共用实现，再删除旧分支 |
| B：Next 新增动态 Surface | Ask Nova、Launchpad、AppTabHost、Appearance Studio | 保留 Next 实现，证明 lifecycle/fallback 正确，不制造 Classic 对应物 |
| C：已经共享的业务核心 | 消息 DOM、消息 renderer、输入 textarea、发送与流式管理 | 不迁移、不重写；只审查少量模式 CSS、空态投影和 Shell 边界 |

因此 Classic 退场不是六次区域迁移。实际工作由三部分组成：少量 A 类行为分支收口、B 类 Next Surface 的常驻验收、C 类共享核心保护；随后机械移除模式门控和 Classic 专属 CSS。

## 3. 为什么施工没有采用“复制 Next 后直接删除 Classic”

功能对等已经完成，但功能入口相同不等于内部状态与生命周期相同。直接删除 Classic 会暴露四类风险：

- **隐藏的业务所有权**：部分命令仍读取或修改 DOM，例如从 `body.classList` 判断主题、直接删除通知节点、直接更新 Next 最大化按钮。
- **双实现状态漂移**：Classic 和 Next 可能各自持有 active、expanded、selected 等展示状态，异步完成顺序不同就会分叉。
- **生命周期错觉**：DOM 被隐藏或移除不代表 listener、IPC、timer、WebContents 或自定义元素行为已经销毁。
- **回滚失真**：如果新旧实现同时改变业务协议，回退旧布局也无法恢复旧行为。

因此 Classic 退场不是 CSS 删除任务，而是业务所有权与 presentation 边界的收敛任务。

## 4. 外部项目的经验与踩坑

### 4.1 DeepSeek Harness：稳定能力缝隙，但不预先拆包

DeepSeek Harness 将可替换能力区分为 Service Definition、Service Provider 与 Consumer。契约、实现和消费者只有在确实独立演进时才拆包；只有一个合理 provider/consumer 时，预先拆分只会增加样板与耦合。

对 VCPChat 的意义：

- 现有上游 manager/service 是 provider，不复制一套 Next provider。
- Classic、Next、未来唯一布局只是 consumer。
- 契约先保持同仓库、普通 JavaScript 模块；不引入 Cordis 或完整 DI 容器。
- snapshot 携带单调 revision/generation；迟到任务即使无法物理取消，也不能提交旧版本。

Harness 的 projection 进一步证明：一致 snapshot 应来自权威事件/状态，而不是由消费者分别拼装。VCPChat 不照搬事件溯源，只借用“一个权威状态、不可变投影、版本化提交权”的原则。

本地参考：

- [`DeepSeek Harness capability seams`](/Users/asahi/Documents/Codex/deepseek-harness/.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)
- [`Session Projection`](/Users/asahi/Documents/Codex/deepseek-harness/packages/session/session-projection/README.zh.md)
- [`Session Persistence`](/Users/asahi/Documents/Codex/deepseek-harness/packages/session/session-persistence/README.md)

### 4.2 VS Code：命令、上下文与注册资源都不是 DOM

VS Code 的 `CommandsRegistry.registerCommand()` 返回 `IDisposable`，调用者通过 `ICommandService.executeCommand()` 执行业务。Context Key Service 提供 scoped state 和条件匹配；Workbench contribution 按生命周期阶段或实际需求实例化，实例统一进入 `DisposableStore`。

它解决的典型问题是：

- 按钮被替换后，命令仍存在，行为不依赖旧按钮。
- 一个区域销毁时，其命令、listener 与 contribution 可以一起撤销。
- 可见/启用状态是业务投影，不靠查询某个隐藏 DOM 的 class。
- 延迟 contribution 不阻塞首屏，也不会因脚本求值顺序提前启动。

VCPChat 应借用：稳定命令 ID、`query/subscribe`、scoped disposer、按需 mount。不要照搬 VS Code 的完整 DI、Extension Host、全局 Command Palette 或 Context Key 表达式语言。

公开参考：

- [VS Code CommandsRegistry](https://github.com/microsoft/vscode/blob/main/src/vs/platform/commands/common/commands.ts)
- [VS Code Context Key Service](https://github.com/microsoft/vscode/blob/main/src/vs/platform/contextkey/common/contextkey.ts)
- [VS Code DisposableStore](https://github.com/microsoft/vscode/blob/main/src/vs/base/common/lifecycle.ts)
- [VS Code Workbench Contributions](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/common/contributions.ts)

### 4.3 React Strict Mode：重复 setup 才会暴露缺失 cleanup

React 在开发模式额外执行一次 setup → cleanup → setup，用来暴露连接、listener 和 ref 只增加不移除的问题。其官方示例中，聊天连接在每次切换房间后持续增长，直到 effect 返回对称的 disconnect。

VCPChat 不引入 React，但应保留同一测试思想：每个动态 surface 必须通过 mount → dispose → mount，第二次 mount 的 owner、listener、DOM host、IPC task 和 View 数量与第一次相同。只测“打开一次能用”不能证明生命周期正确。

参考：[React StrictMode](https://react.dev/reference/react/StrictMode)

### 4.4 Electron：关闭窗口不自动销毁 WebContentsView

Electron `BaseWindow` 文档明确说明：关闭包含 `WebContentsView` 的窗口不会自动销毁该 View 的 `webContents`；应用必须显式 `close()`，否则会内存泄漏。`close`、`closed`、renderer destroyed 和 View 从树中移除也是不同终态。

这与 VCPChat 已经遇到的“分页应用关闭后 renderer 进程残留”“Escape 级联关闭主窗口”是同一类所有权错误。区域收敛不能只检查标签 DOM 消失，必须检查：

- session 从主进程表注销；
- `webContents` 到达 destroyed/closed 终态；
- overlay lease 已归还；
- 主窗口 owner 仍存活；
- 重开同一 action 不复用 closing session，也不创建重复 session。

参考：[Electron BaseWindow：Resource management](https://www.electronjs.org/docs/latest/api/base-window#resource-management)

### 4.5 Web Components：定义与升级不是可回滚事务

`customElements.define()` 将名称永久加入当前页面的 CustomElementRegistry；同名或同 constructor 再次定义会抛出 `NotSupportedError`。定义出现后，已连接的未知元素会自动升级，prototype 被替换并执行 lifecycle callbacks。平台没有对应的 `undefine()`。

因此 Web Awesome 加载失败不能被理解为“页面回到从未加载组件库的状态”。若一批动态 import 部分成功，已有标签可能已经升级。正确边界是：

- surface mount 前一次性选定 WA 或 native provider；
- 同一次 mount 中不半途切换 provider；
- 业务代码只依赖 VCPUI controller，不读取 WA Shadow DOM；
- fallback 保证新 surface 可创建，不承诺撤销全局 custom element definition。

参考：

- [CustomElementRegistry.define()](https://developer.mozilla.org/en-US/docs/Web/API/CustomElementRegistry/define)
- [CustomElementRegistry.upgrade()](https://developer.mozilla.org/en-US/docs/Web/API/CustomElementRegistry/upgrade)

### 4.6 Strangler Fig：大爆炸替换通常失败，过渡层也不能永久化

Martin Fowler 对 Strangler Fig 的总结是：大型系统的实际行为难以完整枚举，一次性重写看似直接，实际经常失败；更稳妥的路线是先找到 seam，将小块行为逐步迁出并在每一步交付价值。过渡架构虽然最终会删除，但它用短期成本换取了可观察、可回滚的迁移。

对 VCPChat 的额外警告是：过渡层必须有删除条件。否则 `uiModeManager`、Classic/Next facade 和两套 CSS 会从临时安全网变成永久维护成本。每个兼容 facade 都必须登记 owner、调用方数量和“归零后删除”的阶段。

参考：[Strangler Fig Application](https://martinfowler.com/bliki/StranglerFigApplication.html)

## 5. 施工前事实、缺口与处理结果

### 已具备的基础

- Classic/Next 功能对等已完成，并有持续回归清单。
- `LifecycleScope`、TaskHandle、State Channel、OverlayCoordinator、AppTabHost 与 Embedded session 诊断已存在。
- Contribution Registry 已支持 command/app/menu/setting 的数据校验、owner 与 disposer。
- M9 已有共享业务模型、固定 seed、trace、受控 HTTP/SSE 与部分差分验证。
- 上游插件 Loader 保持原实现，不被 Classic 退场路线接管。
- 主聊天与输入区已经是共享实现：Classic/Next 使用相同 DOM identity、manager、message renderer、stream manager 和事件入口。Next 只增加空会话视觉、输入按钮/间距等模式样式与外层布局。

### 施工前阻止直接删除 Classic 的缺口

1. `MainChatCommands` 曾包含 presentation 逻辑：通知 DOM 所有权和窗口按钮同步现已分别移交 notification renderer 与 `VCPWindowState`。
2. 通知按钮移动和两套快捷手势曾是真实模式分支；唯一顶栏与菜单语义现已固定。
3. Topic 与 Settings enhancement 不是第二套业务；常驻模式和生命周期压力测试现已证明不会重复 mount。
4. `uiModeManager` enter/leave 与条件 CSS 曾承担运行时往返；现已退化为兼容读取，CSS 已机械提升为规范样式。
5. M4/M6 按真实动态 surface 完成 disposer 与 lifecycle contract，没有扩张成全应用抽象工程。
6. renderer reload/crash、IPC 逆序与资源斜率已经纳入 M9/R6 自动门禁，不被误算成 UI 重写。

### 当前主窗口拓扑核对

| 表面 | 共享证据 | Next 实际差异 | 退场动作 |
|---|---|---|---|
| 消息正文 | 同一个 `#chatMessages`、message renderer、chat/stream manager；`messages.css` 只改滚动条 chrome | 空会话视觉覆盖在共享容器上 | 不迁移 renderer；只保护空态 projection 和上游结构化消息语义 |
| 输入区 | 同一个 `#messageInput`、发送/附件/表情/新话题按钮和事件；输入卡片/textarea 基础样式由共享 `chat.css` 提供 | Next 改按钮、focus、间距与发送强调样式 | 保留设计样式；删除 Classic 后机械提升 mode selector，不重写发送流程 |
| 左侧栏 | 同一 sidebar、助手/话题列表和 manager | Next 宽/窄视觉、品牌图标、Topic 管理装饰与部分手势差异 | 决定唯一手势；装饰常驻或删除，不迁移列表业务 |
| 通知 | 同一 `notificationsSidebar`、通知列表和事件 | 通知按钮在共享 Header/Next host 间移动，Next 增加菜单 presentation | 收口清空命令和按钮位置；不重建通知列表 |
| 设置 | 同一全局/Agent/Group 表单和 settings manager | Settings Bridge/VCPUI 对原生表单做可逆 enhance，Appearance Studio 是 Next 新 Surface | 验证 enhance 常驻与保存回滚；不复制表单状态 |
| 工作台能力 | 无 Classic 对应物 | Next 顶栏、Launchpad、AppTabHost、Ask Nova、Appearance Studio、WA runtime | 直接保留并做常驻生命周期验收 |

## 6. M10 最小业务契约

不建立一个包揽全应用的 Mega Store。每个已有业务 owner 只补足最小接口：

```js
domain.execute(command, payload, { signal, expectedRevision })
domain.getSnapshot()
domain.subscribe(listener, { immediate: true }) // returns disposer
```

Snapshot 规则：

- 返回不可变普通数据，不返回 DOM、controller 或可变内部 Map。
- 携带单调 `revision`；同一 revision 表示同一业务事实。
- `subscribe(..., { immediate: true })` 先给出当前 snapshot，再发送后续版本，避免 mount 时丢事件。
- listener 注册与撤销幂等；异常 listener 不阻断其他消费者。
- command 返回业务结果，不返回“请点击哪个按钮”或 UI 节点。
- 长操作携带 request/operation identity；取消、完成、失败只能提交一个终态。

### 领域清单

| 领域 | 权威 owner | 最小 command | 最小 snapshot | 退场前必须消除 |
|---|---|---|---|---|
| Window | 主进程窗口服务 | minimize、tray、maximize、close | maximized、focused、visible | command 直接更新 `nextUi*` 按钮 |
| Theme/Appearance | Appearance/主题服务 | setTheme、preview、commit、rollback | themeMode、profile、dirty、revision | 从 `body.classList` 推导业务主题 |
| Notification | 通知/过滤 manager | filter、clear、open target | unread、filter、items、panel state | 直接删除 `.notification-item` |
| Identity | item/chat manager | select、create、refresh | items、selected identity、loading | Classic/Next 各自决定选中项 |
| Topic | topic manager | select、create、delete、lock | topics、selected topic、generation | 通过列表 class 反推当前话题 |
| Settings | settings manager | load、navigate、preview、save、rollback | section、values、dirty、saving、error | 表单 DOM 成为唯一状态副本 |
| Conversation | 现有 chat/stream manager（已共享） | 保持现有 send、stop、retry、edit | 只在 Shell/测试确有需要时补最小 phase snapshot | 为形式统一重包共享聊天流程，或建立第二份聊天 Store |
| Overlay/App | coordinators + main session manager | open、close、activate、detach | stack、active app、session state | DOM 消失即视为 session 关闭 |

契约模块可以与现有 manager 放在一起。只有第二个 provider 真正出现时才拆包；不得为了 M10 创建新的框架目录层级。

M10 不要求每一行都创建新模块。Window、Theme、通知清空/按钮位置、助手快捷手势等确有 presentation 分叉的地方优先收口；Identity、Topic、Settings、Conversation 若审查证明 Classic/Next 已经走同一 manager 和 DOM，就以“共享实现证据 + 回归门禁”完成，不再进行抽象迁移。

## 7. M4 与 M6 的投入边界

### M4：按需完成，不能成为抽象工程

M4 的必要完成范围：

- 当前收敛区域中的动态 command/menu/app/setting 注册必须返回 disposer。
- contribution 被撤销时，打开的对应 UI 与恢复记录必须清理。
- owner 销毁后注册表中不存在其 contribution。
- 稳定 ID 冲突大声失败；定义不接受任意 HTML、URL 或 IPC channel。

以下不做：把所有静态按钮注册成 command、重写上游插件协议、增加远程 UI contribution、为了统一目录迁移所有模块。

### M6：只完成关键动态 surface 契约

M6 的必要完成范围：

- Modal、Menu、Tabs、Settings dynamic host 有统一 mount/destroy/focus。
- Escape 只关闭 overlay 栈顶并恢复触发点焦点。
- mount 开始时一次性选择 WA/native provider。
- setup 中途失败原子回滚；迟到异步检查 owner/generation。
- mount → dispose → mount 后资源回到基线。

以下不做：重建所有上游表单、组件化聊天富文本、让所有页面使用 Web Awesome、以 CSS 覆盖上游业务组件语义。

M4/M6 不阻塞 M10 启动；某个真实变更单元进入 R 阶段时，只补它实际需要的 M4/M6 能力。

## 8. R0–R6 实施阶段

当前实施快照：

| 阶段 | 状态 | 主要证据 |
|---|---|---|
| R0 | 已完成 | [`classic-retirement-inventory.md`](./classic-retirement-inventory.md) 与 `guard:classic-retirement` 固定 A/B/C 拓扑 |
| R1 | 已完成 | `VCPWindowState`、通知 renderer 所有权及 business/presentation 依赖门禁 |
| R2 | 已完成 | Next Surface 常驻；3 轮预热 + 20 轮 Electron 压测中 listener 409、Scope 8、资源 165、进程 5、renderer 2、page 2 恒定，detached 指标为 0 |
| R3 | 已完成 | 共享消息、输入、侧栏、通知和设置 DOM/业务 owner 保持不变；上游消息视觉语义门禁保留 |
| R4 | 已完成 | 主窗口始终规范化为 `next`；旧配置不能触发 remount，子应用模式策略独立保留 |
| R5 | 已完成 | Classic 主窗口 DOM/代理/条件 CSS 已机械删除或提升，机械脚本可审计 |
| R6 | 本地完成，CI 持续验证 | macOS ARM64 smoke、操作序列、资源斜率、离线闭包与 unpacked package 已通过；Windows/macOS workflow 负责跨平台发布证据 |

这里的“Classic 退场”只指主窗口 presentation。内嵌 Notes、Translator 及其他上游子页面按 `ui-surface-policy` 保留独立页面策略，不由主窗口 `uiMode` 兼容缝控制。

### R0：实际拓扑与模式分支清单

**实施状态：已完成。**

**目标**：证明哪些内容真的分叉，避免把共享 DOM 当成迁移对象。

**工作**：

- 记录施工前 Classic 默认与 Next 可选行为，作为历史对照。
- 将节点/控制流标记为 A（真实模式分支）、B（Next 新 Surface）或 C（共享核心）。
- 记录 `uiMode` JS 分支、`html[data-ui-mode]` CSS、enter/leave controller、Classic-only 节点和 Next-only 节点。
- 对聊天、侧栏、通知和设置保存 DOM identity、manager 调用链与 listener owner 证据。

**验收**：

- inventory 能逐项回答“删除 Classic 时是删分支、常驻 Next Surface，还是完全不动”。
- 主聊天/输入区被确认为 C 类，不存在重写任务。
- 已知 P0/P1 竞态继续有确定性回归，但不计作退场迁移量。

### R1：收口真实业务分支（最小 M10）

**实施状态：已完成。**

**目标**：只处理当前确实由模式决定的行为，不建立全应用服务层。

**范围**：

- Window 最大化状态不再直接同步 Next 按钮。
- Theme command 不再从 presentation class 推导权威状态。
- 通知清空不再直接删除 DOM；通知按钮移动只属于 presentation。
- 明确划词助手右键/长按、通知快捷入口、Topic 管理图标等最终唯一语义。
- 加入 `presentation -> hidden control`、`business -> nextUi*` 门禁。

**验收**：

- 新增契约可在无 DOM 测试中执行，并返回幂等 unsubscribe/disposer。
- 没有为了 M10 包装聊天、流式、侧栏或设置的共享业务流程。
- Classic/Next 的用户可见结果不变。

### R2：Next 新 Surface 常驻准备

**实施状态：已完成。**

**目标**：证明 Next-only 的顶栏、Launchpad/AppTab、Ask Nova、Appearance Studio 和 VCPUI runtime 可以从“进入 Next 时挂载”转为页面常驻，而不需要 Classic 对应实现。

**验收**：

- 每个 Surface mount 一次，重复同步不增加 listener、Observer、Scope、Task 或 View。
- Ask Nova、Overlay、AppTab 与 WebContentsView 的 close/reload/crash/恢复保持可对账。
- Web Awesome/native provider 在 mount 前一次性选定，失败不阻塞共享主聊天。
- 20 轮 Surface 操作后资源回到预热基线。

### R3：共享核心保护与视觉决策

**实施状态：已完成。**

**目标**：冻结唯一布局要保留的视觉与手势，不迁移共享业务。

**工作**：

- 确定顶栏、侧栏宽/窄、通知入口、助手手势和设置增强的最终行为。
- Classic 中值得保留的密度/紧凑观感转为 Appearance preset 或 token。
- 证明 `#chatMessages`、`#messageInput`、输入按钮、侧栏列表、通知列表和设置表单在模式切换时保持同一 identity。
- 空会话视觉继续只是消息区上的 projection；聊天显示模式继续独立于 `uiMode`。

**验收**：

- 上游消息、代码、工具、日记、媒体、附件与插件语义没有被重新实现。
- Settings Bridge 常驻/销毁对同一业务表单可逆，不生成第二份表单状态。
- Topic/Notification 的 Next 装饰不会复制业务 listener。

### R4：单一布局切换

**实施状态：已完成。**

**目标**：让 Next Shell 成为唯一 presentation，停止运行时 Classic/Next 往返。

**进入条件**：R0 inventory 完整，R1 真实分支已收口，R2 Surface 常驻稳定，R3 产品行为已决定，并至少经过一个稳定验证周期。

**工作**：

- 新装、旧 Classic 配置和旧 Next 配置统一进入规范布局。
- `uiModeManager` 退化为一次性兼容读取，不再执行 enter/leave 往返。
- Next-only Surface 在启动时按正确阶段 mount；共享核心不 remount。
- 保留旧配置可读性，不重置主题、壁纸、字体、侧栏宽度、聊天或插件数据。

**验收**：

- 三种配置启动路径数据与外观参数不丢失。
- 主聊天 DOM identity 从启动到使用全程不变。
- 完整 Electron、打包、Windows/macOS smoke、资源斜率与人工验收通过。
- downgrade 到上一稳定包不会因新配置字段崩溃。

### R5：机械删除模式门控

**实施状态：已完成。**

**目标**：在行为已经单一后删除死代码，不夹带设计改动。

**工作与验收**：

- 删除 Classic-only 节点、无调用方 facade、运行时模式切换和只验证双模式往返的测试。
- 将仍有效的 `html[data-ui-mode="next"]` 规则机械提升为默认规则，删除失效 Classic override；每批 CSS 有截图差分。
- `nextUi*` ID/class/module 重命名放在独立提交，业务模块不再依赖 presentation 名称。
- 每个清理提交可独立 revert，不修改聊天/插件/设置协议。

### R6：稳定发布与最终收尾

**实施状态：本地工程验收完成；跨平台发布验收由 CI 持续执行。** 本地环境为 macOS ARM64，不能据此声称 Windows runtime 已人工运行。

**目标**：以唯一布局运行一个稳定验证周期，再删除最后的兼容读取。

**验收**：

- 30–60 分钟 soak、reload/crash、断网、休眠恢复和 View 压测通过。
- 唯一布局的 heap、listener、Scope、Task、page、renderer process、WebContentsView 基线进入 CI。
- 用户没有依赖 Classic 回退才能完成的已知流程。
- 发布与 downgrade 验证完成后，删除最后的 `uiMode` 兼容读取并归档路线文档。

## 9. 每个变更单元的 Definition of Done

变更单元只有同时满足以下适用条件才能标记完成：

1. inventory 已说明它属于 A、B 或 C；不能默认所有区域都需要新契约。
2. A 类有明确业务 owner 和必要的 `command/query/subscribe`；B 类有唯一 lifecycle owner；C 类保持既有共享 provider。
3. snapshot 不包含 DOM；presentation 不直接写持久业务状态。
4. 所有 subscription、listener、timer、Observer、Task、contribution 和 View 有 owner。
5. mount、dispose、重复 mount、失败 mount 和迟到完成均有测试。
6. 同一业务 trace 的 model 与 observed snapshot 一致。
7. A 类区域的 Classic 旧行为实现已真正删除，而不是只隐藏；B 类证明单一 Next owner；C 类用共享 DOM/call-path 证据替代“删除旧实现”。
8. 删除可以单独 revert，不要求恢复其他已完成单元。
9. 至少完成一次真实 Electron 人工检查；动态区域完成资源斜率检查。
10. 文档 inventory 更新，兼容 facade 调用方计数下降。

## 10. 测试与发布门禁

### 每次提交

- 领域 contract 单元测试。
- register/use/dispose/absent 生命周期测试。
- 当前区域固定操作 trace。
- 结构依赖、Classic 隔离、CSS 作用域与 `git diff --check`。

### PR

- Classic 与 Next 在尚未收口的 A 类行为上运行相同 trace。
- 已经共享的 C 类核心直接运行唯一实现的模型测试，不制造伪双模式测试。
- Electron 主聊天、应用 View、Overlay、设置与打包 smoke。
- Windows/macOS 平台矩阵；Linux 对系统托盘、窗口装饰和 modal 差异单独记录。

### 定期与发布前

- 30–60 分钟真实使用 soak。
- renderer reload/crash、断网、IPC 逆序、系统休眠恢复。
- 资源斜率而非单点内存值：heap、listener、Scope、Task、page、renderer process、WebContentsView。
- Web Awesome 离线加载失败与 native fallback。
- 键盘、焦点、Escape、reduced-motion 与屏幕阅读语义。

延迟清理必须有明确上界和 quiescent checkpoint；不能要求所有有界 debounce/timer 在每个动作后立即为零，也不能用提高阈值掩盖持续增长。

## 11. 停止条件与风险控制

出现以下任一情况，当前区域停止扩张并回到最后一个稳定提交：

- 为迁移 UI 必须修改聊天、插件或用户数据协议，但没有独立迁移设计。
- 新 contract 变成第二份业务 Store，开始与现有 manager 双向同步。
- 为了路线形式统一而包装或复制已经共享的聊天/输入业务流程。
- 无法用确定性 trace 说明旧实现和新实现的业务差异。
- 资源只能依赖 GC 最终回收，owner 无法指出明确 teardown。
- Web Awesome 私有 Shadow DOM 或标签进入业务模块。
- 一个 PR 同时包含区域收敛、视觉重设计、Vendor 升级和协议修改。
- 为了通过测试放宽泄漏/超时阈值，却没有解释实际生命周期。

## 12. 完成大目标的最终判定

“Classic 主窗口 presentation 已完成工程退场”的判定如下：

- R0–R6 全部完成，所有 A 类分支已收口、B 类 Surface 只有一个 owner、C 类核心保持共享实现。
- `uiMode` 只剩兼容读取或已经从运行时删除。
- 用户数据与外观配置完成无损迁移，上一稳定包仍能安全读取配置。
- 上游消息、插件与业务组件语义未被 VCPUI/Web Awesome 重写。
- Windows 与 macOS 发布 smoke、Electron 稳定性和操作序列作为合并/发布门禁持续通过；本地只记录实际运行的平台。
- 仓库不存在隐藏 Classic DOM、双份业务 listener 或 `business -> nextUi*` 依赖。
- 唯一布局至少经历一个稳定发布验证周期后，再在后续独立变更中评估删除最后的兼容读取。

本轮已经完成主窗口单一布局的代码收敛。旧 `uiMode` 兼容读取、子应用独立 Classic 页面策略和跨平台持续验证不代表主窗口仍维护两套 presentation；它们分别属于降级兼容、子应用产品策略和发布门禁。
