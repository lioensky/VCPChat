# VCPChat UI 工程规范

> 当前拓扑与组件真实成熟度以 [`next-ui-current-state.md`](./next-ui-current-state.md) 为准。本规范定义新代码要求，不代表清单中所有组件已经达到 `stable`。

## 最终目标

VCPChat 应形成一套以稳定 VCPUI API 组织、视觉一致且可持续演进的桌面端 UI 平台：新增 UI 从统一 Token、字体图标、密度、组件和反馈中组合，不复制控件样式或自行发明交互。基础控件允许由受控的 Web Awesome adapter 提供行为与无障碍内核，但业务模块不能直接依赖第三方标签或 token。上游聊天领域逻辑、业务子页面、主题 IPC 和外部 Electron 应用保持清晰边界；任何新增或迁移界面只有在静态门禁、组件契约测试、视觉矩阵、键盘与焦点、reduced-motion、生命周期清理和真实 Electron 审查全部通过后，才视为完成。

## 参考原则

本轮参考 `C:\VCP\new-api` 的成熟做法，但不复制其 React、Semi UI 或 Tailwind 实现：

- 采用多层背景、四级文本和低透明度填充，减少页面依赖边框分块。
- 控件保持紧凑、稳定的高度，搜索与操作区域在窄窗口下重排。
- 选中态使用弱强调背景和明确文字色，不使用大面积高饱和色块。
- 长内容使用 6px 滚动条和末端渐隐提示，避免“还有内容”不可感知。
- 加载态优先保持布局稳定，使用 Skeleton，而不是让内容区突然收缩。
- 数据页面由筛选、操作、表格、空态和分页组成固定工作流。

VCPChat 保留自身约束：卡片圆角不超过 8px，不使用 `!important`，不在组件样式中声明裸色值，不引入前端框架或新的构建步骤。Web Awesome 必须通过 VCP adapter 使用，不能成为业务页面的公共 API。

新版主聊天面板使用 `--next-chat-surface`，默认由 `--next-theme-chat-surface` / `--next-theme-chat-surface-dark` 覆盖，且默认以半透明表面显示壁纸。主题若明确需要完全实色的聊天面板，才应覆盖这两个变量；不得再以不透明 `--next-surface` 直接盖住 `--chat-wallpaper-*`。

## 系统分层

1. Foundation：Palette、Semantic Token、字体、图标、排版、密度、焦点、动效和层级。
2. Primitive：Button、Input、Divider、Tooltip、Skeleton、ScrollArea 等无业务语义组件。
3. Composite：Field、Toolbar、TableFrame、Pagination、Modal、ConfirmDialog 等组合组件。
4. Pattern：筛选工具栏、设置表单、主从列表、数据表格、空态、异步反馈等页面模式。
5. Application：新版顶栏、应用页、设置、侧栏、聊天输入区和内部应用。

业务代码只能向下依赖，Foundation 和 Primitive 不得引用聊天、Agent、主题商店等业务概念。

### 上游业务 DOM 的渐进增强

现有设置页、侧栏和聊天区拥有大量稳定的 DOM ID、事件引用和 IPC 流程，不采用整页重写。迁移固定分为三步：

该流程仅用于无法立即建立稳定业务接口的兼容表面。新的 Surface 默认采用独立 presentation，并通过 command/query/subscribe/IPC 共享业务；不得把 Enhance 当作全局扫描和改造上游 DOM 的常规手段。

1. Token 化：先消除裸色值、液态玻璃和重复尺寸，但不改变业务 DOM。
2. Enhance：通过 `VCPUI.enhance(name, existingElement)` 把原节点接入组件状态与生命周期，保留原事件和表单提交。`Select` 可使用 Web Awesome Proxy：原生节点仍是表单与业务真源，可见控件由 `wa-select` 提供。
3. Create：只有新页面或已完成业务解耦的区域才使用 `VCPUI.create(name)` 生成完整 DOM。

增强控制器销毁时不得删除业务节点，并必须撤销自己添加的类、ARIA 和 Proxy。一个控件完成真实业务接入并通过 Electron 验证后，才可将对应候选组件升级为 stable。

设置表单统一通过 `settings-bridge.js` 接入增强器。业务保存函数只负责数据与 IPC，并通过 `vcp-settings-save-result` 回报成功或失败；SettingsActionBar 负责脏状态、保存中状态、超时恢复和 ARIA，禁止业务模块再次自行实现一套保存状态机。

搜索模式使用“范围选择 → 多行关键词 → 结果区 → 分页”的固定结构。初始、加载、短关键词、无结果和错误必须复用状态消息样式，不在业务模块拼接内联样式；打开时聚焦关键词输入，Escape 和 UI 模式切换必须关闭并清理搜索状态。

## 组件成熟度

- `candidate`：API 已建立并进入组件库，但尚未经过真实业务迁移。
- `stable`：至少被一个业务界面使用，通过全部自动与人工验证，API 可长期依赖。
- `deprecated`：已有替代方案，保留兼容期并记录移除版本。

成熟度记录在 `component-manifest.js`。新增组件必须先进入清单和组件库，禁止直接在业务页面落一套“临时组件”。

## 工程规则

- VCPUI 样式必须受明确的 `.vcp-ui-scope` 或具体 Surface root 约束；历史 `data-ui-mode="next"` 只能作为兼容选择器，不能成为运行时所有权。
- Web Awesome runtime 和 adapter 只能由真实 VCPUI Surface 按需加载；业务子页面不得仅靠 CSS 隐藏一个仍在运行的组件树。
- 颜色、字号、圆角、阴影、控件高度、间距和 Z-index 只能来自 Token。
- 页面不嵌套卡片；卡片只用于可重复对象、弹窗或确实需要边界的工具。
- 布局密度只能通过 `data-density="comfortable|compact"` 切换。
- 图标按钮必须有 `aria-label`；输入错误必须使用 `aria-invalid`；弹窗必须管理焦点。
- 控制器必须提供 `element/update/focus/destroy`，全局监听、Observer、计时器和未完成 Promise 必须在销毁时清理。
- 业务页面不得使用内联样式、`!important`、裸色值或固定字号绕过系统。
- 组件 API 的不兼容修改需要更新 manifest 版本、规范文档、展示页和契约测试。
- 新版内嵌业务页必须采用共享 Integrated App Shell；禁止在业务 CSS 中复制一套“顶部融合、左上圆角、主面板阴影”的近似实现。
- `AppPageShell` 的 embedded 标题栏隐藏后，业务动作必须在内容工具栏仍可达；standalone 标题栏和 WindowControls 不得因此删除。
- 页面布局按 `rail`、`compact-rail`、`canvas` 三类选择，不能为了视觉统一给单画布页面虚构无业务含义的侧栏。

## 页面完成定义

一个新版 UI 页面只有同时满足以下条件才可以合入：

1. 只使用稳定组件；候选组件需要在同一变更中完成升级验证。
2. 明暗、极简 Aero、壁纸与透明面板主题下层级和可读性正常。
3. 默认窗口、969×696 和应用最小宽度下无水平溢出、裁切、遮挡或布局跳动。
4. 键盘可完成主要流程，焦点可见，弹窗可用 Escape 关闭并恢复焦点。
5. Loading、Empty、Error、Disabled、Readonly 和长文本状态均有明确表现。
6. 切换标签或 UI 模式后没有残留 DOM、监听、Toast、弹窗或未决请求。
7. `npm run check:ui-system` 通过，并完成 Electron 截图与真实交互审查。

## 建设顺序

1. 新版顶栏和应用启动器：统一 IconButton、Tooltip、Tabs、密度和焦点。
2. 通用弹窗与反馈：替换新版业务中的临时 Modal、Toast、Confirm 和 Loading。
3. 设置表单：建立设置分区、Field、校验、保存状态和危险操作模式。
4. 侧栏与数据视图：迁移 List、ScrollArea、TableFrame、Pagination 和筛选工具栏。
5. 聊天输入区：统一输入、附件、工具栏、发送状态和窄窗口行为。
6. 质量增强：加入 Electron 视觉基线、组件交互矩阵和迁移覆盖率报告。
