# DeepSeek Harness 对 VCPChat UI/UX 的启发研究

> 研究日期：2026-08-19
> 研究对象：`C:\VCP\vchat-develop\deepseek-harness` 的 Agent/工程规范，以及 VCPChat 当前主窗口、VCPUI、内嵌应用、主题和 Electron 交付体系
> 结论性质：设计与工程决策参考，不自动成为施工计划。具体实现以 [`next-ui-current-state.md`](./next-ui-current-state.md) 和 [`next-ui-development-roadmap.md`](./next-ui-development-roadmap.md) 为准。

## 一、结论先行

DeepSeek Harness 对 VCPChat 最有价值的启发，不是“把 VCPChat 做成 Harness”，也不是引入 React、Cordis 或另一套组件库，而是把 UI 看成一个有生产消费者、所有者、终态和证据的产品系统。

VCPChat 已经吸收了其中最重要的架构原则：主窗口单一 presentation、P1 的 Surface 所有权、P2 的无消费者减法、P3 的 VCPUI consumer gate、可撤销 Registry、真实 Electron 操作序列和生命周期压力测试。这些工作解决的是“系统不会因为 UI 抽象而失控”。

剩余的主要问题在产品体验层：主题规则仍可能在编译产物和源主题之间漂移；聊天、设置、内嵌页面和大量旧业务页面的视觉语法还没有一套可量化的任务级标准；视觉回归主要依赖人工截图，尚未像 Harness 的 assembled-app snapshot 一样成为稳定证据；组件成熟度已有证据门禁，但页面模式、信息架构和用户任务成功率还没有同等强度的门禁。

最优方向是“证据驱动的桌面 UI 平台”：保留上游业务语义，统一 Foundation/Primitive/Pattern，按 Surface 管理副作用，使用真实操作终态验证，并建立跨主题、跨窗口尺寸、跨 Electron 平台的视觉和任务回归。不要继续扩张无消费者的页面 runtime、全局 Store、万能 `whenIdle()` 或第三方插件 UI 协议。

## 二、Harness 真正提供了什么

### 2.1 它不是 UI 框架，而是约束系统

Harness 的 `AGENTS.md`、`docs/defensive-patterns.md`、`docs/testing.md` 和 simplification/code-review skills 共同表达了几条规则：

| Harness 规则 | 对 UI 的实际含义 |
|---|---|
| capability seam 必须有 Definition、Provider、Consumer | VCPUI、主题服务、应用 Registry 只有在两端都有真实使用时才应形成公共面 |
| registrations are effects，注册返回 disposer | 菜单、应用、快捷命令、监听器和增强控件都必须有明确 owner 与撤销路径 |
| async state is not synchronous state | `save()`、`open()`、加载、动画和跨进程 View 不能用全局“空闲”猜测终态 |
| dispose 必须到 quiescence | 关闭页面不只是隐藏 DOM，还要让 timer、listener、Promise、WebContentsView 和反馈资源停止 |
| verify the world, not self-report | 测试要看真实 DOM、窗口、文件、事件和资源计数，不能只看控制器返回值 |
| tests describe behavior, not correctness | 测试应该钉住用户可见行为和故障恢复，而不是把内部实现复制成断言 |
| simplification requires consumer proof | 删除 runtime、API、Registry kind 或测试 facade 前必须证明生产消费者不存在 |
| source plane 与 artifact plane 分开 | 主题源文件、生成后的 `styles/themes.css`、vendor 闭包和打包结果应分别验证，不混成一个模糊真源 |

这套约束对 VCPChat 的价值在于：视觉问题不再只是“某个 CSS 看起来不舒服”，而可以追问“哪一个 Surface 生产了这层、谁拥有它、谁消费它、关闭后是否消失、哪个真实入口能复现”。

### 2.2 它强调真实入口，而不是孤立组件

Harness 要求产品可见能力通过真实 Loader、应用组合、浏览器或 CLI 入口验证。对应到 VCPChat：

- 组件测试只能证明 `VCPUI.create()` 的局部合同；不能证明设置页保存、创建助手、应用注销或主题切换完整可用。
- Electron smoke 必须从真实 `main.html`、真实 preload、真实主题加载和真实 tab/app 注册开始。
- 视觉测试应覆盖“打开设置 → 修改 → 保存 → 成功/失败 → 关闭/保留”的工作流，而不是只查询某个按钮是否存在。
- 内嵌页面需要测试 `WebContentsView`、overlay、tab、renderer reload/crash 和主题广播的最终世界状态。

VCPChat 的 24 步主聊天序列、Electron UI Apps、生命周期压力和 12 个 Classic 页面负向 gate 已经是正确方向；下一步应把相同思想扩展到视觉和用户任务，而不只是资源计数。

## 三、对 VCPChat 当前 UI 架构的评价

### 3.1 已经做对的部分

当前文档基线显示，VCPChat 已有以下成熟基础：

1. **主窗口只有一套规范 presentation。** `main.html` 静态声明 canonical presentation，历史 `uiMode` 只做兼容读取。这消除了两套主布局竞争、主题切换换壳和 fallback 误用。
2. **业务语义与 UI 内核分离。** 消息、流式、插件和上游子页面仍保留原有领域语义；VCPUI/Web Awesome 只作为控件行为和无障碍内核，不成为聊天业务框架。
3. **Surface 生命周期有 owner。** `LifecycleScope`、feedback owner、AppTabHost、OverlayCoordinator 和 EmbeddedAppSessionManager 已把 DOM、listener、timer、View、Toast、Dialog 的责任从全局函数中拆出。
4. **公共面经过消费者审计。** P2 删除休眠子页面 runtime、静态 mode facade 和测试专用 settlement/state facade；P3 让 13 个 stable 组件有真实业务与 Electron 证据，Registry 只保留 `commands/apps`。
5. **离线和桌面约束被认真对待。** Web Awesome closure、Electron 进程、renderer crash/reload、Windows ABI 和打包闭包都被纳入交付判断。

这些成果说明 VCPChat 的架构方向是正确的，问题不在于“缺少更多抽象”，而在于将已有架构原则继续下沉到视觉细节和产品任务。

### 3.2 当前仍然暴露的风险

1. **主题存在多级真源。** 主题源文件、运行时生成的 `styles/themes.css`、`appearance-engine` 的 token、主题特例和旧 `chat.css` 规则可能同时影响一个气泡。最近气泡阴影问题就是典型：公共 CSS 已移除阴影，主题总文件仍用 `!important` 恢复阴影，重新应用主题才改变最终结果。
2. **presentation 模式仍然带有历史材质复杂度。** `backdrop-filter`、透明渐变、`content-visibility`、主题壁纸和 Electron GPU 合成叠加后，快速滚动、启动首帧和不同主题可能出现半黑块、光晕、闪烁或视觉错位。
3. **规范定义了页面完成条件，但门禁还不够产品化。** 当前有组件 consumer report、静态边界和 Electron smoke，却缺少统一的“任务完成率、错误恢复时间、焦点路径、视觉差异阈值”报告。
4. **旧业务页面与新主窗口的语法不完全一致。** 这不是马上迁移全部页面的理由，但用户会感知到设置、Agent/Group、Notes、Translator、Forum 等页面的密度、Select、弹窗和主题响应差异。
5. **fallback 仍是用户可见风险。** native fallback 是合理的故障边界，但如果它和 canonical VCPUI 的尺寸、颜色、键盘和弹窗布局差异过大，用户看到的就是“随机两套 UI”。fallback 应是同一视觉合同的第二内核，而不是旧控件裸奔。
6. **视觉回归缺少稳定基线。** 人工截图能发现问题，却难以判断是主题更新、Electron 版本、字体、DPI、GPU 还是 CSS 规则导致，且无法保护快速滚动、首帧和关闭后的残留。

## 四、对视觉系统的具体启发

### 4.1 Foundation：从“颜色集合”升级为可追溯的语义 Token

Harness 的显式配置和单一 owner 思想，适合用于主题系统：

- 每个 token 记录语义用途，而不是只记录颜色，例如 `surface.chat`, `surface.bubble.assistant`, `border.focus`, `accent.status`, `shadow.overlay`。
- 每个主题的源文件是输入，生成的 `styles/themes.css` 是构建产物；禁止手动直接编辑产物，门禁检查源与产物一致。
- 不允许主题通过 `!important` 跨越组件 owner 覆盖行为。主题可以提供 token，组件决定是否使用外阴影、内高光、backdrop 或动画。
- 对透明材质增加显式等级：`solid`、`translucent`、`acrylic`、`mica`，并为 Windows GPU/低性能环境定义可验证的降级路径。
- 阴影 token 分成 `inset` 与 `outside`，默认气泡不使用 outside shadow；overlay、浮层和真正需要脱离页面层级的对象才可使用外阴影。

建议引入一个静态报告：对每个可见 Surface 输出最终计算样式来源、token 名称和是否存在裸色值/`!important`/未声明 backdrop。它不需要变成运行时 Store，只需成为主题变更的构建与 review 证据。

### 4.2 Primitive：组件合同必须覆盖 fallback 和主题矩阵

稳定组件不只是“有 API 和业务调用”，还应具备同一组可观察合同：

- 尺寸：comfortable/compact、最小宽度、窄窗口重排和文字溢出。
- 状态：default、hover、focus-visible、active、disabled、loading、error、readonly。
- 输入：鼠标、键盘、Escape、Tab、Enter、Space、中文输入法和屏幕阅读器语义。
- 内核：Web Awesome 与 native fallback 的 DOM 结构可以不同，但最终的尺寸、value、事件、ARIA 和 teardown 结果必须相同。
- 生命周期：`element/update/focus/destroy` 后没有 detached icon、option、listener 或 timer。

这会把“组件库展示页”从视觉画廊变成可复现的合同实验室，同时不把展示页本身误当成 stable 证据。

### 4.3 Composite/Pattern：页面应围绕任务，而不是围绕卡片

Harness 的 capability consumer 思想可以直接转换成页面结构规则：每个页面先定义生产任务和终态，再选择组件。

| 任务 | 推荐固定结构 | 必须证明的终态 |
|---|---|---|
| 全局设置 | 搜索/分类导航 → 设置分区 → Field → ActionBar | 保存成功关闭；失败保留输入并显示错误；重新打开值一致 |
| 创建助手/群组 | 标题/基础字段 → 模型与能力 → 高级选项 → 操作栏 | 打开、装载失败、提交中锁定、成功关闭、失败恢复、dispose 后迟到结果无效 |
| 聊天 | 顶栏/上下文 → 消息流 → 输入/附件/工具栏 | 流式终止、取消、发送失败、主题切换、快速滚动和长消息稳定 |
| 内嵌应用 | AppPageShell → 内容工具栏 → 页面主体 | tab 激活、reload/crash 恢复、注销关闭 tab、Surface 归零 |
| 组件库 | 搜索 → 状态/密度 → 示例 → WA 对照 | 普通 Launchpad 可达、WA 懒加载、关闭清理、candidate 不冒充 stable |

原则是：不要为了视觉一致给单画布页面虚构侧栏，不要把每块内容都包成卡片，不要让业务模块各自发明保存、加载、错误和空态。

### 4.4 Application：信息架构应服务于“频率 × 重要性 × 风险”

VCPChat 的功能很多，用户不是在浏览设计系统，而是在反复完成聊天、选择助手、管理配置和使用内嵌工具。建议把导航和布局按任务频率组织：

- 一级高频：当前助手/群组、主题/外观、搜索、创建、发送和中断。
- 二级管理：全局设置、Agent/Group 管理、插件、提示词和音频能力。
- 低频工具：Notes、Translator、Forum、Workflow、RAG、文坊等通过 Launchpad/Apps 进入，不在主聊天常驻占空间。
- 风险操作：删除、重置、覆盖保存、插件停用、会话清空统一使用 Confirm/错误反馈和可恢复路径。

主窗口应保持“聊天是画布、导航是工具、设置是工作台、内嵌应用是可关闭的任务页”的关系，不把 Launchpad、通知栏、账户菜单、创建窗和设置窗同时变成相互覆盖的浮层。

## 五、对交互和可访问性的启发

Harness 的“真实入口”和“终态”原则要求把可访问性当作行为合同，而不是属性清单：

- 每个 IconButton 都有可理解的 `aria-label` 和 tooltip；tooltip 不能替代键盘可达性。
- Modal 打开时焦点进入合理控件，Escape 关闭，关闭后恢复触发源；Select 打开后点击弹窗内容不应触发外层 dismiss。
- 所有异步控件有可感知的 loading、disabled、error 和完成反馈，且不会在状态切换时改变按钮尺寸或挤动布局。
- `aria-expanded`、`aria-hidden`、`aria-invalid` 与真实 DOM 状态同步，不靠静态属性应付门禁。
- reduced-motion 不只是关掉 CSS animation，还要避免快速过渡、闪烁首帧和依赖动画完成的业务逻辑。
- 中文长标签、英文长单词、模型名称、URL、代码块、附件名和 125%/150% DPI 都应纳入可视化矩阵。

建议把键盘路径写成和主聊天操作序列类似的模型：`open → focus → interact → commit/cancel → restore focus → teardown`，并在 Electron 中对关键路径做真实按键而非只触发 click。

## 六、对性能和稳定性的启发

### 6.1 把视觉性能问题当作资源所有权问题

快速滚动半黑、气泡阴影溢出、主题切换闪烁等问题通常不是单一属性，而是多个合成层和生命周期叠加。应对每个 Surface 记录：

- 是否使用 `backdrop-filter`、动画、`content-visibility`、阴影和透明背景；
- 是否创建独立 compositor layer；
- 关闭、滚动、主题切换和 renderer reload 后是否恢复；
- detached DOM、listener、timer、WebContentsView 和 heap 是否稳定。

不要用“禁用所有材质”作为默认修复。应先建立最小对照：关闭 backdrop、关闭 content visibility、关闭 outside shadow、禁用动画，逐项确认实际原因，再决定保留视觉效果还是按平台降级。

### 6.2 启动与主题切换必须有稳定首帧

Harness 的 misconfiguration fail loud 可转成 UI 启动规则：

- 首帧先应用已知主题 token，再加载可选壁纸、Web Awesome 和内嵌应用；
- theme source、主题文件缺失、生成 CSS 失败和 adapter failed 分别记录，不把所有情况混成“加载中”；
- 失败时仍显示同一布局合同，而不是出现旧版弹窗或裸 native 控件；
- 主题切换发布 `theme-updated` 后，主窗口和嵌入页面都要能证明最终属性、背景和控件样式一致。

## 七、对测试体系的启发

### 7.1 建立 UI 测试分层

建议采用下面的 VCPChat 版本，而不是把所有检查都塞进一个大脚本：

1. **Token/静态层**：裸色值、`!important`、未授权 `<wa-*>`、组件 manifest、主题源/产物一致性。
2. **组件合同层**：每个 stable 组件的状态、键盘、ARIA、fallback、destroy 和重复 enhance。
3. **页面模式层**：设置、创建、搜索、列表、空态、错误、保存、确认和内嵌 App Shell。
4. **真实 Electron 层**：真实 preload、主题、WebContentsView、tab、窗口尺寸、reload/crash、焦点和截图。
5. **压力与恢复层**：3 次预热 + 20 次测量、快速开关、逆序 Promise、主题切换、关闭后迟到事件。
6. **人工 soak 层**：Windows/macOS、Aero/纸墨与机芯/壁纸/透明材质、DPI、GPU、30–60 分钟真实使用。

### 7.2 从截图走向可解释的视觉基线

截图测试不应只说“像不像”。每张基线应绑定：

- 主题、density、窗口尺寸、DPI、平台、Electron 版本和 GPU 模式；
- 页面/Surface/操作步骤和最终 DOM 状态；
- 允许变化区域，例如时间戳、头像、动态壁纸；
- 视觉差异阈值和人工复核原因；
- 对应的生产消费者和回归缺陷。

首批高价值基线应覆盖：主聊天启动首帧、聊天快速滚动、创建窗、全局设置 Select、Account Menu 未打开/打开状态、Launchpad、内嵌页面切主题、fallback 组件和弹窗关闭后的画面。

### 7.3 测试必须验证世界状态

一个“保存成功”测试应同时验证 Promise/结果事件、表单关闭、settings 持久化和下一次打开的值；一个“注销应用”测试应验证 Registry、tab、DOM、Scope、listener 和 WebContentsView 都消失。不要只验证 `controller.destroy()` 被调用。

## 八、哪些 Harness 做法不应照搬

1. **不引入 Cordis/插件化作为 UI 容器。** VCPChat 的 UI Surface 数量和 Electron 边界不需要把每个 UI 组件变成插件。
2. **不为了抽象而抽象 capability seam。** 当前 VCPUI、主题和 App Registry 只在 producer/consumer 真正独立演进时扩展。
3. **不把所有页面状态改成一个 Store 或全局事件总线。** Harness 反而强调明确 owner、事件和 durable source；VCPChat 应继续按 Surface/业务 manager 拆分。
4. **不把 snapshot 当成绝对正确。** Harness 明确“tests are not golden truth”；视觉快照也必须与真实交互、DOM 终态和生命周期证据结合。
5. **不把 fallback 当作默认双实现。** fallback 是故障边界，必须共享视觉/交互合同；不能以此维护一套旧布局。
6. **不把所有旧页面一次性迁移。** P6 的条件式逐页迁移是正确边界：需求、页面消费者、最小 runtime、teardown 和 Electron 测试同一 PR 进入。

## 九、建议的后续路线

### R1：主题与视觉真源收口，最高优先级

- 认定主题源文件为唯一编辑入口，生成 `styles/themes.css` 并做一致性 gate。
- 删除主题层对组件行为的 `!important` 覆盖；通过 semantic token 控制背景、边框、内高光和阴影。
- 建立 `outside shadow`、`inset highlight`、`backdrop` 的明确许可规则。
- 为纸墨与机芯、Aero、壁纸透明主题增加启动、滚动、切换和重新应用的 Electron 视觉回归。

### R2：页面模式和任务终态合同

- 为设置、创建、搜索、内嵌 App、Launchpad、Account Menu 建立统一状态矩阵。
- 每个页面模式写出 open/focus/loading/success/failure/cancel/dispose 的真实终态。
- 将 modal dismiss、Select 交互、焦点恢复和错误保留纳入真实键盘测试。

### R3：跨平台视觉基线

- Windows 作为优先平台，覆盖 100%/125%/150% DPI、Aero、透明材质和 GPU 合成。
- macOS 作为对照，避免把平台差异误判为业务 CSS 回归。
- 固化 Electron 版本、字体加载和窗口尺寸，允许动态内容通过区域掩码排除。

### R4：组件库升级为合同实验室

- Stable 组件显示业务证据、Electron 测试入口和 fallback 状态；Candidate 显示“展示用途，不代表业务稳定”。
- 每个示例提供键盘、禁用、错误、loading、长文本和销毁检查。
- 组件库仍普通用户可见，但不把展示页独占使用升级为 stable 的依据。

### R5：合入后稳定周期与逐页演进

- P5 期间只修复可追踪的跨平台、GPU、资源斜率和上游同步问题。
- P6 只有在真实产品需求出现时迁移一个子页面；迁移 PR 同时携带业务消费者、最小 runtime、allowlist、teardown 和 Electron 证据。

## 十、优先级、收益与代价

| 方向 | 收益 | 代价/风险 | 建议 |
|---|---|---|---|
| 主题真源与 token gate | 减少“源文件改了但运行时没变”的错觉，降低阴影/背景回归 | 需要整理生成流程和历史主题 | 立即做 |
| 任务终态矩阵 | 减少偶发弹窗、Select、保存和焦点 bug | 测试编写成本上升 | 立即做 |
| Electron 视觉基线 | 能定位 Windows/GPU/DPI 回归 | 快照维护和平台噪声 | 分批做 |
| fallback 同合同 | 真实失败时仍可用，消除两套布局感 | 需要同步 WA/native 细节 | 立即纳入 stable 组件 |
| 全部业务页面迁移 | 视觉统一 | 高 blast radius，容易复制业务状态 | 暂不做 |
| 全局 UI Store/事件总线 | 表面上便于跨页面同步 | owner、竞态和清理复杂度增加 | 明确不做 |
| Cordis/插件化 UI | 扩展性理论上更强 | 与当前 Electron 单应用边界不匹配 | 明确不做 |

## 十一、最终判断

DeepSeek Harness 对 VCPChat 的最大启发是把“好看、能点、没报错”提升为可证明的产品合同：用户任务有清晰结构，组件有真实消费者，副作用有 owner，异步操作有真实终态，失败有可恢复路径，主题和 fallback 不会偷偷产生第二套布局，关闭和崩溃恢复后资源回到基线。

VCPChat 当前 P1–P3 已经完成了这套哲学中最难、也最容易被忽视的架构部分。下一阶段不应该继续添加抽象，而应该把它应用到视觉真源、主题生成、页面模式、键盘/焦点、跨平台截图和任务级回归。这样既能保留组件展示页作为普通用户可见的产品功能，也能避免设计系统逐渐变成一套没有消费者、没有 owner、没有可靠终态的“展示工程”。

### 当前权威入口

- 当前实现与证据：[`next-ui-current-state.md`](./next-ui-current-state.md)
- 后续路线：[`next-ui-development-roadmap.md`](./next-ui-development-roadmap.md)
- UI 工程合同：[`ui-engineering-standard.md`](./ui-engineering-standard.md)
- 生命周期合同：[`next-ui-lifecycle-architecture.md`](./next-ui-lifecycle-architecture.md)
- 组件与 Web Awesome 矩阵：[`ui-components-wa-matrix.md`](./ui-components-wa-matrix.md)
