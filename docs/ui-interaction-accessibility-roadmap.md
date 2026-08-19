# VCPChat UI 交互与可访问性行为合同路线

> 状态：施工中
> 基线：P1–P3 已完成，P4 仍需同步后的 Windows 复验与人工 soak
> 目的：把“可访问性、键盘、焦点、异步终态、视觉稳定性和资源清理”从分散的实现细节提升为可重复验证的 UI 行为合同。
> 上位路线：[`next-ui-development-roadmap.md`](./next-ui-development-roadmap.md)
> 当前事实：[`next-ui-current-state.md`](./next-ui-current-state.md)

## 1. 为什么建立这条路线

VCPChat 已经具备 Surface owner、LifecycleScope、VCPUI consumer gate、Electron 操作序列和生命周期压力测试，但这些证据主要回答“资源是否清理、公共 API 是否有消费者、跨进程 View 是否恢复”。它们还没有覆盖所有用户实际感知的行为：键盘能否完成任务、焦点是否进入正确上下文、Escape 是否只关闭当前层、Select 是否误触发外层 dismiss、错误是否留在正确字段、主题和 DPI 改变后布局是否稳定、fallback 是否仍遵守同一视觉合同。

这条路线采用 DeepSeek Harness 的三条 UI 化原则：

1. **真实入口**：从真实 Electron 页面、preload、主题和业务 manager 开始测试，不用手工拼装的假页面代替产品入口。
2. **真实终态**：等待业务 Promise、结果事件、DOM/ARIA 状态、持久化结果和资源归零，不用全局 `whenIdle()` 或固定延时猜测完成。
3. **可证明的所有权**：Modal、Popover、Select、Toast、Loading、timer、listener、WebContentsView 和动态 DOM 都有明确 owner；关闭意味着进入 quiescence，而不是只把元素设为不可见。

## 2. 行为合同总模型

所有纳入本路线的交互 Surface 都使用同一抽象模型：

```text
open
  → focus
  → interact
  → commit / cancel / error
  → restore focus
  → teardown to quiescence
```

每个阶段都必须有可观察证据：

| 阶段 | 必须回答的问题 | 典型证据 |
|---|---|---|
| open | 是否只创建一个 Surface，背景是否仍可误操作 | DOM 数量、overlay lease、`aria-expanded`、`aria-hidden` |
| focus | 键盘和屏幕阅读器是否进入正确上下文 | `document.activeElement`、焦点环、dialog/label 关系 |
| interact | 鼠标、键盘、Escape、中文输入和长文本是否等价 | 真实按键、`composedPath()`、value、事件序列 |
| commit | 是否等待真实业务操作并锁定重复提交 | operation Promise、disabled/`aria-busy`、结果事件 |
| cancel/error | 是否只取消当前操作，输入和错误是否可恢复 | abort/dispose、`aria-invalid`、错误文本、持久化未改变 |
| restore focus | 关闭后用户是否回到合理入口 | 触发按钮重新获得焦点 |
| teardown | 迟到结果是否失效、资源是否归零 | detached DOM、listener、timer、Scope、View、反馈计数 |

## 3. 阶段总览

| 阶段 | 状态 | 目标 | 主要产物 | 退出条件 |
|---|---|---|---|---|
| A0 事实与风险基线 | 已完成 | 盘点所有交互层、焦点入口、ARIA 和真实消费者 | `scripts/ui-interaction-inventory.json`、缺口报告、审计门禁 | 每个高频 Surface 有 owner、触发源和终态负责人，且清单引用真实入口 |
| A1 基础交互合同 | 进行中 | 统一 IconButton、focus-visible、ARIA 状态和 Escape 作用域 | 基础规则、静态 gate、键盘工具 | 主窗口关键导航和菜单通过键盘/ARIA 矩阵 |
| A2 Modal/Popover/Select 内核 | 进行中 | 消除误关闭、焦点丢失和层级竞争 | Overlay/Focus contract、真实测试 | 创建、设置、Ask Nova、Account Menu、托盘路径闭环 |
| A3 异步终态与错误恢复 | 进行中 | 统一 loading、disabled、error、提交和取消行为 | 页面状态矩阵、错误字段合同 | 成功/失败/取消/迟到 Promise 均有唯一终态 |
| A4 主题、动画、DPI 与 fallback | 进行中 | 让视觉内核和平台降级遵守同一交互合同 | 主题真源 gate、motion/DPI 矩阵 | Windows/macOS 关键主题和窗口尺寸通过视觉与键盘验证 |
| A5 页面模式和任务级回归 | 进行中 | 把设置、创建、搜索、App、聊天变成固定工作流 | Task journey tests、截图基线 | 高频任务可从真实入口完成并验证世界状态 |
| A6 交付门禁与稳定周期 | 进行中 | 形成持续回归和发布证据 | `npm run check:ui-harness-evidence`、人工 soak 记录、P5 观测 | 一个稳定发布周期无阻塞性回归 |
| A7 条件式逐页演进 | 条件式远期 | 仅在真实需求下迁移一个业务子页面 | 独立页面 PR | consumer/runtime/test/teardown 同步进入 |

A0–A6 是完整落地这套行为合同所需的主路线；A7 不应提前进入当前主 PR。

2026-08-19 进展：交互 inventory 现在必须解析到真实存在的测试文件；通知菜单具备独立 controller 证据，旧 document 级重复绑定已移除；Escape 使用单一优先级 owner；Launchpad 具备方向键/Home/End 与 fallback listener teardown。补充修复了动态 Launchpad 和应用托盘抽屉的隐藏可访问性：关闭时由各自 owner 设置 `inert`，避免运行时生成的应用按钮在隐藏或出场动画期间进入 Tab 顺序；对应 controller/Electron 回归覆盖打开/关闭终态。macOS Electron UI Apps、主聊天序列、20 轮生命周期压力和 pack closure 均通过。A1–A6 仍保持进行中，直至异步状态逐项真实终态、Windows/打包产物、人工 soak 与稳定周期证据完成。

## 4. A0：事实与风险基线

### 4.1 盘点范围

建立一份机器可读但不成为运行时 Store 的审计清单，覆盖：

- 顶栏、动态 Tab、Launchpad、主题/外观、账户菜单、通知菜单、应用托盘；
- 创建助手/群组、全局设置、Agent/Group 设置、Ask Nova、搜索；
- Modal、Popover、Select、Tooltip、Toast、Loading、Confirm、Prompt；
- 主聊天输入、附件、消息操作、流式状态、主题切换；
- 12 个仍为上游 Classic 的业务子页面和所有正式内部 App。

每一项记录：生产 owner、触发按钮、可见 root、焦点入口、Escape 作用域、关闭方式、真实业务 Promise/事件、错误字段、持久化结果、teardown 资源和 Electron 测试入口。

### 4.2 先做对抗式检查

用静态搜索和真实 DOM 检查确认：

- IconButton 是否有可理解的 `aria-label`；
- `aria-expanded`、`aria-hidden`、`aria-invalid` 是否由状态变化动态更新；
- 隐藏面板是否仍在 Tab 顺序、仍能接收鼠标或仍被 screen reader 读取；
- 每个 Modal/Popover 是否保存触发源并在关闭后恢复焦点；
- 是否存在 document-wide dismiss、document-wide observer 或全局 `cancelAll()` 越权清理；
- 业务是否用固定延时等待动画或 DOM，而不是等待真实终态；
- `prefers-reduced-motion` 是否只关 CSS 动画，业务是否仍依赖 `animationend`；
- 主题源文件和实际加载的生成 `styles/themes.css` 是否一致。

### 4.3 交付物与退出条件

- `scripts/ui-interaction-inventory.json`：每个 Surface 的 owner、触发源、终态和测试入口；
- `docs/ui-interaction-accessibility-gaps.md`：按 P0/P1/P2 分类的缺口和明确非目标；
- 一个负向审计脚本，能在出现无 owner dismiss、无焦点恢复声明或孤儿 `aria-controls` 时失败。

退出条件：所有高频 Surface（创建、设置、聊天、账户菜单、托盘、Ask Nova、内嵌 App）均能定位到生产 owner 和真实 Electron 入口；没有把展示页或测试 facade 当成生产证据。

## 5. A1：基础交互合同

### 5.1 IconButton、Tooltip 与键盘

- 所有图标按钮有动作级 `aria-label`，例如“切换明暗主题”，而不是“主题按钮”；
- Tooltip 仅提供视觉提示，不替代键盘和 `aria-label`；
- 图标按钮支持 Tab、Enter/Space、`focus-visible`，不以 hover 作为唯一反馈；
- 动态按钮在状态变化时同步 `aria-pressed`、`aria-expanded` 或 `aria-selected`；
- 图标加载失败时文字和 ARIA 仍然可理解。

### 5.2 导航、菜单和隐藏状态

- Tablist、tabpanel、menu、menuitem、radiogroup 只在真正使用对应语义时声明；
- 隐藏内容同时退出视觉、键盘和辅助技术访问路径；
- 管理面板未打开时，其操作项不能进入 Tab 顺序或被 screen reader 读取；
- 关闭菜单、抽屉和搜索后清理 `aria-expanded`、`aria-hidden`、active class 和焦点。

### 5.3 A1 测试

- 静态 gate：IconButton、孤儿 `aria-controls`、动态状态属性、隐藏面板；
- Electron 键盘矩阵：顶栏、Tab、Launchpad、Account Menu、通知菜单、应用托盘、搜索；
- 每条路径使用真实 `keydown`/`keyup`，不能只调用 click handler；
- 通过后记录焦点、ARIA 和最终 DOM，不把内部函数调用作为唯一断言。

退出条件：主窗口高频导航和菜单可以只用键盘完成；所有打开/关闭状态的 ARIA 属性与真实 DOM 一致；没有隐藏但可聚焦的操作项。

## 6. A2：Modal、Popover、Select 内核

### 6.1 统一 Overlay/Focus 合同

保留现有 `OverlayCoordinator` 和 `LifecycleScope`，不引入第二套全局弹窗 Store。为每个 overlay 明确：

- 触发源和 opening focus；
- modal/non-modal、dismissible、Escape 优先级；
- 内容区域和 backdrop 的边界；
- portal/Shadow DOM 下的 `composedPath()` 命中规则；
- close animation 与语义隐藏的先后关系；
- 关闭后的 focus restore 和 owner dispose。

### 6.2 Select 特别规则

Select 打开后，点击选项、Shadow DOM、portal 下拉层或 Select 自身都不能触发外层 Modal dismiss。选择完成后：

1. value 更新到业务真源；
2. 只派发一次业务变更结果；
3. Select 下拉层关闭；
4. 外层 Modal 保持打开；
5. 焦点回到 Select 或下一个明确控件。

### 6.3 A2 测试

- 创建助手/群组：打开、自动聚焦、Tab、Select、点击内容、点击 backdrop、Escape、恢复焦点；
- 全局设置：Select、原生兼容增强、保存失败后 Modal 保留；
- Ask Nova：取消、重开、迟到结果、关闭后焦点；
- Account Menu、通知菜单、应用托盘：内层操作不误关闭外层；
- renderer reload/crash 后 overlay lease、DOM、焦点和 tab 对账。

退出条件：不存在 Select 误关 Modal、双重 dismiss、焦点丢失、关闭后仍可交互或重复事件；关闭路径达到 quiescence。

## 7. A3：异步终态与错误恢复

### 7.1 统一状态

所有异步 Surface 至少区分：

```text
idle → loading → success
              ↘ failure → recoverable
              ↘ cancelled
```

要求：

- loading 不改变控件尺寸和主要布局；
- 提交期间按钮 disabled，并以文本、spinner 或 `aria-busy` 告知状态；
- 成功等待真实业务 Promise/结果事件，不能用 `setTimeout` 猜测；
- 失败保留用户输入，错误字段使用 `aria-invalid` 与 `aria-describedby`；
- 取消只取消当前 operation，不清理其他 Surface 的反馈；
- dispose 后迟到 Promise 失去提交权，不能重新打开、写入或发布 Toast。

### 7.2 页面状态矩阵

为设置、创建、搜索、App 打开和聊天输入分别记录：初始、加载、空、错误、禁用、只读、长文本、成功、取消、迟到结果和销毁状态。

### 7.3 A3 测试

- URL/API 保存成功和失败；
- 创建助手/群组装载失败、重复提交、成功关闭、失败恢复、dispose 后迟到 Promise；
- item load 逆序完成只有最新请求更新 DOM/cache；
- Ask Nova cancel/timeout/reopen；
- 主聊天发送、流式终止、取消和主题切换期间的按钮/输入状态。

退出条件：每个异步操作只有一个可观察终态；错误可读、可定位、可恢复；没有用全局 idle 或固定时间代替业务完成。

## 8. A4：主题、动画、DPI 与 fallback

### 8.1 主题真源

- 主题源文件作为唯一编辑入口；`styles/themes.css` 由明确脚本生成；
- 新增 `check:theme-source-consistency`，检查源主题与实际加载产物一致；
- 禁止主题通过 `!important` 改写组件行为合同；主题只提供 semantic token；
- 阴影明确区分 `inset` 与 `outside`，气泡默认不使用 outside shadow；
- `backdrop-filter`、透明度、动画和 `content-visibility` 必须按 Surface 记录并可关闭验证。

### 8.2 reduced-motion

减少动画不等于只删除 CSS animation。任何关闭、提交、焦点恢复和资源清理都不能依赖 `animationend`；语义状态应先进入终态，视觉过渡只是附加效果。必须测试主题首帧、Modal 关闭、Select 关闭、滚动和 renderer reload。

### 8.3 fallback 合同

Web Awesome 和 native fallback 可以使用不同内部 DOM，但最终必须一致：尺寸、键盘、value、事件、ARIA、错误表现和 destroy。fallback 不是旧版布局，不能让用户看到第二套产品 UI。

### 8.4 平台矩阵

至少覆盖 Windows 100%/125%/150% DPI、macOS 对照、最小窗口、默认窗口、Aero、纸墨与机芯、壁纸透明材质、无 GPU/低性能降级和字体加载慢场景。

退出条件：启动无错误首帧；主题重新应用不依赖刷新才能恢复；reduced-motion 下业务终态不改变；fallback 与 VCPUI 视觉和键盘合同一致；关键窗口无裁切、横向溢出或底部按钮不可见。

## 9. A5：页面模式和任务级回归

### 9.1 高频任务

建立真实 Electron journey：

- 创建助手/群组：`open → focus → fill → select → submit → success/failure → restore → teardown`；
- 全局设置：`open → search → edit → invalid → save success/failure → reopen`；
- Account Menu：未打开无可访问菜单项，打开后操作、Escape、恢复焦点；
- 应用托盘：打开/关闭、快速切换、内部按钮、注销应用、tab 关闭和 Surface 释放；
- 主聊天：主题切换、长消息、快速滚动、附件、发送/取消、流式错误；
- 组件库：搜索、密度、WA lazy load、candidate/stable 标签、关闭清理。

### 9.2 真实世界断言

每条 journey 至少同时检查：

- 用户可见 DOM 和最终布局；
- 业务 Promise/结果事件；
- 持久化 settings 或业务数据；
- active/focus/ARIA 状态；
- listener、Scope、timer、View、detached DOM 和反馈资源。

退出条件：关键任务能够在鼠标和键盘下完成；成功、失败、取消、重载和崩溃恢复均有可解释 trace；截图基线绑定主题、DPI、窗口、平台和 Electron 版本。

## 10. A6：交付门禁与稳定周期

### 10.1 自动门禁

建议新增或扩展：

- `check:ui-interaction-contract`：ARIA、focus contract、dismiss owner、隐藏状态；
- `check:theme-source-consistency`：主题源/生成产物；
- `test:electron-ui-keyboard`：真实键盘和焦点路径；
- `test:electron-ui-journeys`：页面任务终态；
- `test:electron-visual-matrix`：关键截图/计算样式基线；
- 现有 `guard:next-delta`、`guard:design-subtraction`、`guard:classic-retirement`、`test:electron-lifecycle-stress`。

### 10.2 人工 soak

每次发布候选至少在 Windows 上进行 30–60 分钟：主题切换、创建/设置往返、快速滚动、内嵌 App、reload/crash、DPI/窗口缩放和低性能材质。记录错误日志、renderer/WebContentsView 数量、listener、Scope、heap、detached DOM 和视觉异常。

### 10.3 退出条件

- 自动矩阵全部通过；
- Windows 和 macOS 对照无未解释的交互/视觉差异；
- 一个稳定发布周期内没有资源增长、焦点阻塞、误关闭或错误首帧问题；
- PR 能说明每个新增接口的 producer、consumer、owner、取消、错误和清理路径。

## 11. A7：条件式逐页演进

业务子页面只有在真实产品需求出现时才迁移。每个页面独立 PR 必须同时包含：

1. 现有 DOM、IPC、窗口和错误恢复审计；
2. 窄 command/query/subscribe 合同；
3. 页面消费者、最小 runtime、allowlist 和 teardown；
4. 鼠标/键盘/焦点/ARIA/主题/DPI 测试；
5. Electron 真实入口和生命周期证据。

不因为视觉统一、展示页效果或“以后可能需要”提前迁移 Notes、Translator、Memo、Forum、Workflow 等页面。

## 12. 组织方式和提交边界

每个阶段可独立回滚，建议提交顺序：

1. `docs(ui): establish interaction and accessibility contracts`：A0 清单、规范和缺口报告；
2. `test(ui): add keyboard and focus journey harness`：A1/A2 的真实 Electron 测试基础设施；
3. `fix(ui): unify overlay and async terminal behavior`：Modal、Popover、Select、保存和错误合同；
4. `refactor(ui): make themes and fallbacks share visual contracts`：A4 主题真源、motion、fallback；
5. `test(ui): add task and visual regression matrix`：A5/A6 journey、截图和压力证据；
6. 后续每个业务页面单独提交，不与基础合同混合。

每个提交都必须包含对应测试和文档，不将插件 Loader、业务子页面迁移、动态壁纸重构或新的全局 Store 混入。

## 13. 成本、收益和明确非目标

### 收益

- 误关闭、焦点丢失、Select 冒泡、错误首帧和主题闪烁从偶发问题变为可复现回归；
- 键盘、屏幕阅读器、中文长文本、DPI 和低性能设备的可用性提升；
- fallback 不再表现为旧版第二布局；
- 视觉问题可以定位到 token、Surface、compositor 或生命周期 owner；
- PR 审查能看到真实消费者和真实终态，而不是只看 CSS diff。

### 成本

- 需要维护 Electron 键盘/视觉矩阵和少量跨平台人工 soak；
- 主题生成和源/产物 gate 会限制直接编辑生成 CSS 的便利性；
- 真实入口测试比 jsdom 单元测试慢；
- fallback、DPI 和长文本矩阵会增加验收组合数。

### 非目标

- 不引入 React、Vue、Cordis 或全局 UI Store；
- 不把所有旧页面一次性 VCPUI 化；
- 不把组件展示页独占使用升级为 stable 业务证据；
- 不用截图替代业务终态和生命周期测试；
- 不用 `!important`、固定延时或全局 `whenIdle()` 掩盖状态设计问题。

## 14. 完整落地定义

当且仅当以下条件全部满足，才可称为本路线完成：

1. 高频 Surface 均有生产 owner、触发源、焦点入口、Escape 作用域和真实终态记录；
2. IconButton、菜单、Modal、Popover、Select 和异步表单的键盘/ARIA 合同通过真实 Electron 测试；
3. 成功、失败、取消、重载、崩溃和迟到 Promise 都有唯一终态，关闭后达到 quiescence；
4. 主题源与生成产物一致，关键主题/DPI/GPU/fallback 矩阵通过；
5. 设置、创建、聊天、托盘、内嵌 App 和组件库的任务 journey 能验证 DOM、业务结果、持久化、焦点和资源世界状态；
6. 自动门禁和 Windows/macOS 人工 soak 连续一个稳定周期通过；
7. 任何新的页面迁移都遵守“consumer/runtime/test/teardown 同 PR”规则。
