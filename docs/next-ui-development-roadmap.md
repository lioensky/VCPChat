# Next UI 开发路线

> 状态：当前权威施工路线<br>
> 基线日期：2026-08-17<br>
> 当前事实与完成度：[`next-ui-current-state.md`](./next-ui-current-state.md)

## 1. 路线目标

后续工作的重点不是继续搭建抽象，而是把已经形成的唯一主窗口 presentation 收敛成一个边界清楚、可证明稳定、适合上游长期维护的增量。

路线遵循四条原则：

1. **真实消费者先于抽象**：没有生产消费者的 runtime、Registry kind 或公共 API 不提前进入主 PR。
2. **所有权先于清理**：副作用必须由创建它的 Surface 释放，子 Surface 不得执行全局清理。
3. **生产 Promise 先于测试 facade**：测试等待真实业务终态；只有跨进程、确实无法直接等待时才增加受限 diagnostics seam。
4. **减法先于新功能**：PR 收敛期不增加业务子页面迁移、插件生命周期改造或新的视觉系统。

## 2. 已完成基线

以下内容不再作为“待建设路线”重复施工：

- 主窗口已收敛为一个规范 presentation。
- Next Shell 已拆为 8 个窄控制器，`topTabManager` 仅保留兼容转发。
- 动态 Surface 已具备 `LifecycleScope`、可撤销注册、迟到结果隔离和只读诊断。
- Ask Nova、Overlay、WebContentsView session、renderer reload/crash 已有确定性回归。
- 主聊天操作序列、故障注入和资源压力门禁已经可用。
- Web Awesome 使用固定、可重复的离线 closure，并通过 VCPUI adapter 隔离。
- 前端插件 Loader 保持上游合同，不由 Next 生命周期接管。

这些能力仍需持续回归，但不再用新的框架或 facade “重新完成一次”。

## 3. 阶段总览

| 阶段 | 状态 | 目标 | 退出条件 |
|---|---|---|---|
| P0 事实基线与文档收敛 | 已完成 | 让代码、测试、文档对当前拓扑使用同一套描述 | 权威关系明确；旧文档不再声明冲突架构 |
| P1 所有权缺陷修复 | 已完成 | 修复展示页跨 owner 清理和 timer 泄漏 | 故障注入可证明只清理本 owner |
| P2 无消费者架构减法 | 已完成 | 删除子页面 runtime、无用 preload API 和多余 settlement 公共面 | 生产消费者报告无孤儿 API；行为门禁不退化 |
| P3 VCPUI 与 Registry 收口 | 已完成 | 校正 stable 组件和 contribution kinds | 每个公共能力至少一个真实消费者 |
| P4 PR 证据与交付 | 自动化完成；人工待验 | 完整验证、人工 soak、形成可审查提交 | 全部门禁通过，工作树边界清楚，PR diff 可解释 |
| P5 合入后稳定周期 | 未开始 | 观察真实环境，不扩张架构 | 一个稳定发布周期无资源和恢复阻塞 |
| P6 按业务逐页演进 | 条件式远期 | 只在真实需求出现时迁移一个子页面 | 页面独立 PR，consumer/runtime/test 同时进入 |

P0–P4 是当前上游 PR 的实际路线。P5–P6 不阻塞当前施工，也不得提前把实现放入本 PR。

## 4. P0：事实基线与文档收敛

### 工作项

1. 用 `next-ui-current-state.md` 记录当前拓扑、生产消费者、测试证据和 PR 阻塞项。
2. 本文只保存后续顺序，不继续维护 M0–M13 与 R0–R6 两套并行状态机。
3. 将 Classic retirement、旧双模式 parity 和历次 PR convergence 文档标为历史记录。
4. 修正 `ui-system.md`、生命周期文档和工程规范中的运行时 Classic/Next 切换表述。
5. 文档中的测试数字必须注明对应 commit/日期，不能当作永远成立的实时结果。

### 退出条件

- 任何开发者只读当前状态文档和本路线，就能区分已完成、部分完成、未开始和非目标。
- 全仓库不存在两份都自称“当前权威”、却描述不同主窗口拓扑的文档。
- `uiMode` 的兼容读取与业务子页面 Classic policy 被明确区分。

## 5. P1：所有权缺陷修复

> 状态：已完成（2026-08-17）。`VCPUI.feedback.owner(scope)` 已提供按 Surface 隔离的 Toast、Dialog 和 Loading 所有权；组件展示页使用子 `LifecycleScope` 管理反馈与模拟 Loading timer。契约测试覆盖跨 owner 隔离、活动/排队 Dialog、重复销毁、timer 迟到和注册失败回滚；Electron UI Apps 22/22 与生命周期压力 3 次预热 + 20 次测量通过。

### 5.1 Feedback owner

为 VCPUI feedback 建立最小 owner handle，不要求重写整个反馈系统：

```js
const feedback = VCPUI.feedback.owner(scope);
feedback.toast(...);
feedback.setLoading(true, ...);
await feedback.dispose();
```

实现必须满足：

- owner dispose 只关闭自己创建的 Toast/Dialog/Loading。
- 全局应用退出仍可使用专门的 root-level `cancelAll()`。
- Loading 使用 owner token 或 handle，不依赖“加一/减一”猜测调用是否成对。
- 展示页 timer 由其 Scope 持有，关闭后不得修改全局反馈层。
- setup 中途失败时，已创建反馈和 timer 原子回滚。

### 5.2 回归测试

新增确定性场景：

1. 主 Surface 打开 Dialog/Toast/Loading。
2. 组件展示页创建自己的反馈并关闭。
3. 主 Surface 的反馈仍存在，展示页反馈全部消失。
4. timer 在展示页关闭后推进，不产生 DOM、计数或未处理异常。

### 退出条件

- 子 Surface 不再调用全局 `cancelAll()`。
- feedback owner 的注册、使用、销毁、重复销毁和失败释放都有测试。
- 生命周期压力基线不增加永久 Scope、listener、timer 或 DOM。

## 6. P2：无消费者架构减法

> 状态：已完成（2026-08-17）。休眠子页面 runtime、无 sender 的 mode preload API、静态 `uiModeManager` 以及 Settings/Creation/item list 的测试专用 settlement 公共面均已删除。页面 gate 保持 `0 active rebuilt / 12 upstream classic`；测试改为等待业务 Promise、保存结果事件和 DOM 终态，`AppTabHost.whenSettled()` 因存在真实 Electron 消费者而保留。

### 6.1 删除休眠的子页面 Next runtime

在当前业务子页面 allowlist 为空的前提下删除：

- runtime bootstrap 与 page rebuild helper。
- 只为它们存在的 runtime CSS、preload role/API 和 mode subscription。
- 没有生产 sender 的 `ui-mode-updated` 接口。
- 仅验证休眠 runtime 的测试和当前式文档。

保留中央 surface policy 对“所有业务子页面继续使用上游页面”的边界检查。未来迁移第一个页面时，从最小 runtime 重新引入，并让页面本身成为同一 PR 的生产消费者。

### 6.2 收缩 settlement/state 公共面

逐个接口填写消费者表：

| 接口 | 当前决定 |
|---|---|
| `AppTabHost.whenSettled()` | 保留；Electron 操作序列真实使用 |
| Settings settlement 全局 facade | 已删除；测试等待真实保存 Promise/结果事件 |
| Creation settlement | 已删除；创建行为等待本次 command promise，不公开全局 idle |
| Identity/item list revision channel | 已删除；保留 `loadItems()` Promise 与旧结果防覆盖 token |
| `uiModeManager` state channel | 已删除；主窗口在 HTML 静态声明 canonical `next` |

禁止新增全局 `whenIdle()`。后台 watcher、动画、插件和网络服务不能被混成一个无法定义的“全应用空闲”。

### 6.3 测试迁移规则

- 可以直接取得 operation promise 时，测试等待 promise。
- 只能观察跨进程终态时，使用带 operation ID、timeout、abort 和单终态保证的受限接口。
- 测试 hook 必须只读，不能成为第二业务 Store。
- 删除 API 前先证明生产 `rg` 消费者为零，并保留行为测试。

### 退出条件

- 页面 runtime gate 仍报告 0 active rebuilt，但产品文件树不再携带不可达实现。
- preload 暴露的每项新增 API 都存在 main/renderer 两端和生产调用者。
- 共享 manager 不再仅为测试维护冻结 snapshot 或 listener。
- Electron smoke、主聊天序列与 Classic 子页面宿主行为保持通过。

## 7. P3：VCPUI 与 Contribution Registry 收口

> 状态：已完成（2026-08-17）。机器可重复的 consumer gate 证明 13 个 Stable 组件均具备真实业务与 Electron 证据，19 个展示或实验组件明确为 Candidate；用户可见的“UI 组件库”继续作为正式内部应用。Contribution Registry 收缩为具有完整生产闭环的 `commands` 与 `apps`，无 producer 的 `menus` 和零 producer/consumer 的 `settings` 已删除。

### 7.1 组件成熟度

生成 VCPUI consumer report，将使用分为：

- 真实业务 Surface
- 组件展示页
- 测试
- 文档

只有第一类存在、且通过 Electron 验证的组件可以标记 `stable`。展示页不能单独把组件升级为稳定 API。

处理顺序：

1. 校正 manifest 状态，不先删除仍被内部组合组件依赖的 primitive。
2. 组件展示页作为正式用户可见内部应用保留在普通 Launchpad。
3. 展示页独占组件保持 `candidate`，不能单独支撑 `stable` 声明。
4. Consumer gate 同时校验 manifest、业务证据、Electron 证据和展示页覆盖。

### 7.2 Registry kinds

- 保留有真实业务消费者的 `commands`。
- `apps` 只在存在正式内部应用 contribution 时保留。
- 已删除没有生产 producer 的 `menus`。
- 已删除零 producer/consumer 的 `settings`。

每种 Registry 都必须满足：register → use → dispose → absent；注册者销毁时仍打开的 UI 也必须关闭。

### 退出条件

- manifest 的每个 `stable` 项都有可定位的业务消费者和验证记录。
- Registry 不包含推测性 kind。
- 组件展示工具不会拥有或清理生产 Surface 的全局状态。
- VCPUI 仍是 UI adapter，不演化为聊天业务框架。

## 8. P4：PR 证据与交付

> 状态（2026-08-17）：已同步 `upstream/main` `a9b36d8d`，macOS 上 UI System、Electron smoke、主聊天序列、20 轮生命周期压力、离线 closure、pack check 与完整 diff check 全部通过。CRLF/LF 冻结基线和生成 vendor whitespace 策略已跨平台化。剩余发布证据为同步后的 Windows 复验和 30–60 分钟人工 soak；完成前不标记 P4 全部完成。

### 8.1 每次提交最小检查

按实际改动选择最小有效集合：

- JS 语法与相关单元测试。
- `npm run guard:next-delta`。
- `npm run guard:classic-retirement`。
- `npm run guard:design-subtraction`。
- `git diff --check upstream/main...HEAD`。

生成的 Web Awesome vendor 文件采用限定目录的 Git whitespace 属性；不得为了让检查变绿而改写第三方正则、提高泄漏阈值或跳过整个仓库检查。

### 8.2 PR 前完整矩阵

```text
npm run check:ui-system
npm run test:electron-ui-apps
npm run test:electron-main-chat-sequences
npm run test:electron-lifecycle-stress
npm run pack:check
git diff --check upstream/main...HEAD
```

另外执行：

- 30–60 分钟人工 soak，记录 renderer、WebContentsView、listener、Scope、heap 趋势和错误日志。
- 明暗主题、最小窗口、通知栏、创建、设置、Ask Nova、内嵌页面和异常恢复人工检查。
- 从干净 archive/clone 验证离线资源和打包，不使用工作区偶然存在的文件。
- 对最新 `upstream/main` 重新归因共享文件冲突；上游问题不借本 PR 扩大修复范围。

### 8.3 提交组织

建议形成四组可独立回滚的提交：

1. `docs(ui): establish current next architecture baseline`
2. `fix(ui): scope feedback effects to surface owners`
3. `refactor(ui): remove dormant runtime and test-only facades`
4. `refactor(ui): narrow vcpui and contribution contracts`

测试与对应实现放在同一主题提交；不要把用户的 `styles/themes.css` 修改、动态壁纸、业务子页面迁移或新的视觉功能混入。

### 退出条件

- 当前状态文档中的所有 PR 阻塞项关闭。
- 完整矩阵和人工 soak 通过，失败 trace 可重放。
- 工作树干净，或只剩明确排除的用户修改。
- PR 描述能解释每个新增运行时接口的两端、owner、取消和清理方式。

## 9. P5：合入后稳定周期

合入后至少经历一个稳定发布周期，再进行命名清理或子页面迁移。此阶段只接受：

- 可由 trace、crash log 或资源斜率复现的缺陷。
- 跨平台 CI 发现的真实差异。
- 上游同步造成的最小兼容修复。

不以“架构看起来更统一”为理由继续移动模块。`nextUi*`、兼容 facade 和历史 CSS 的删除分别提交，且每次删除前证明调用者为零。

## 10. P6：条件式业务页面演进

业务子页面迁移不是当前主 PR 的延续任务。只有出现明确产品需求时，选择一个页面执行：

1. 记录其现有业务 DOM、IPC、独立/内嵌窗口行为和错误恢复。
2. 先建立窄 command/query/subscribe 合同，不复制业务状态。
3. runtime、页面消费者、allowlist、teardown 和 Electron 测试在同一 PR 引入。
4. Classic 业务实现继续作为领域基线；迁移只改变 presentation。
5. 验证成功前不为第二个页面抽象通用框架。

这一路线为未来统一设计语言留出空间，但不重新建立主窗口 Classic/Next 双布局，也不承诺一次性迁移所有页面。

## 11. 新功能 Definition of Done

任何新的 UI 功能合入前必须回答：

1. 谁是业务状态的唯一 owner？
2. 谁拥有 Surface，何时 mount/dispose？
3. listener、Observer、timer、IPC、Object URL 和 contribution 归谁？
4. 请求如何取消，迟到结果如何失去提交权？
5. setup 中途失败如何回滚？
6. 原生 WebContentsView 与 DOM Overlay 如何对账？
7. Web Awesome 不可用时 fallback 是否完整？
8. 接口两端和真实生产消费者分别在哪里？
9. 是否存在 register/use/dispose/absent 和故障注入测试？
10. 能否独立回滚，且不改变插件或用户数据协议？

无法回答其中任一项时，该功能仍是原型，不进入上游 PR。

## 12. 明确不做

- 不改造动态壁纸或其他插件的生命周期。
- 不建立全应用第二 Store、全局 idle 或通用工作流引擎。
- 不提前恢复子页面 Next runtime。
- 不让业务模块直接依赖 `<wa-*>` 或 Web Awesome 私有 Shadow DOM。
- 不重绘上游消息、工具、日记、代码块和媒体组件的视觉语义。
- 不把测试便利性包装成稳定产品 API。
- 不把“策略禁用”当作删除无消费者实现的替代方案。
