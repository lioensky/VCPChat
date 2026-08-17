# VCPChat UI 原生设计系统

> 定位：实现参考。当前拓扑、消费者和完成度以 [`next-ui-current-state.md`](./next-ui-current-state.md) 为准，后续施工以 [`next-ui-development-roadmap.md`](./next-ui-development-roadmap.md) 为准。

主窗口当前只有一套规范 presentation，`main.html` 静态声明 `data-ui-mode="next"`，不再存在 `uiModeManager`。`VCPUI` 服务于该主窗口及明确启用的新增 Surface；业务子页面目前全部继续使用上游页面，并不因主窗口采用 VCPUI 而自动加载 Web Awesome。

公共 API 继续使用原生 DOM、CSS Layer 和 ES Module。基础控件允许在 `VCPUI` 内部受控采用 Web Awesome Web Components，但业务页面不得直接依赖 `<wa-*>`。系统不引入 Vue、React 或新的构建步骤。

Web Awesome runtime 只能在真实 VCPUI Surface 需要时按需加载；Surface 销毁时必须释放其 adapter/controller。“UI 组件库”是普通用户可见的正式内部应用，但仍不能作为组件 `stable` 或业务页面已迁移的唯一证据。

`VCPUI.create('Select')` 用于新代码，直接返回统一 controller；`VCPUI.enhance('Select', nativeSelect)` 用于旧页面，在 next mode 创建可见的 Web Awesome Proxy，并保留隐藏原生 select 作为 `.value/.options`、旧事件和表单提交的兼容真源。动态表单使用 `VCPUI.observeControls(root)` 接入，同一原生节点重复 enhance 必须返回同一 controller。业务代码不得查询或操作 `wa-select`。

## 目录

- `styles/ui-system/`：字体、Token、组件和组件库应用样式。
- `modules/ui-system/vcp-ui.js`：组件注册表、工厂和反馈系统。
- `modules/ui-system/component-manifest.js`：组件类别、成熟度、版本和别名清单。
- `modules/ui-system/next-ui-apps.js`：新版 UI 内部应用注册表。
- `modules/ui-system/component-showcase.js`：用户可见的“UI 组件库”应用。
- `modules/ui-system/webawesome-comparison.js`：Web Awesome 受控试验页，不是业务 API。
- `modules/ui-system/webawesome-runtime-manifest.js`：WA 版本、locale 与运行组件的唯一清单。
- `styles/ui-system/webawesome-adapter.css`：将 Web Awesome token 映射到 VCPChat 主题的唯一入口。
- `scripts/build-webawesome-runtime.mjs`：从锁定 npm 包生成并校验最小离线闭包。
- `scripts/check-ui-system.mjs`：作用域、色值、字号、内联样式和注册唯一性门禁。

## Token 分层

`tokens.css` 中的变量分为三层：

1. Palette：基础强调色和状态色。
2. Semantic：背景、文本、边框、表面、焦点和阴影。
3. Component：控件高度、输入背景、悬停和聚焦边框。

现有 VCPChat 主题变量优先作为颜色来源。主题可在未来覆盖 `--vcp-ui-*`，设计系统本身不修改主题 IPC 或 `styles/themes.css`。

间距以 4px 为基准；字号只能引用 `--vcp-ui-font-*`；组件和展示页不得声明 Hex、RGB 或 HSL 裸色值。所有动效必须在 `prefers-reduced-motion` 下静态降级。

设计系统支持 `comfortable` 和 `compact` 两种密度。密度通过作用域上的 `data-density` 控制，不允许业务页面单独压缩某个组件的高度和 padding：

```js
VCPUI.setDensity(container, 'compact');
```

语义颜色使用 `bg-0` 至 `bg-4`、`text-0` 至 `text-3` 和 `fill-0` 至 `fill-2` 表达层级。组件不得直接推导新的透明度色值。

## 组件接口

```js
const button = window.VCPUI.create('Button', {
    label: '保存',
    variant: 'primary',
    size: 'md'
});

container.append(button.element);
button.update({ loading: true });
button.focus();
button.destroy();
```

控制器统一暴露 `element`、`update(patch)`、`focus()` 和 `destroy()`。组件状态使用 `data-variant`、`data-size`、`data-state` 和标准 `aria-*` 表达。输入类组件触发原生 `input`、`change` 事件。

已有业务 DOM 不应为了使用组件而一次性重建。使用增强接口保留原节点、ID、事件和业务引用：

```js
const controller = VCPUI.enhance('Range', existingRangeInput, {
    label: '语速',
    size: 'md'
});

controller.destroy(); // 清理组件状态，但不删除原 input
```

`enhance` 只用于已登记的渐进增强器。新增增强器必须保证 `destroy()` 后恢复原节点的组件类、ARIA 和 `data-*` 状态，不能接管 IPC 或业务数据。

当前清单包含 13 个稳定组件家族和 19 个候选组件。`scripts/check-vcpui-consumers.mjs` 校验 Stable 的真实业务与 Electron 证据，并确保 32 个组件全部保留在用户可见组件库；展示页独占组件保持 Candidate。

Contribution Registry 只包含 `commands` 与 `apps`。前者承载主窗口命令，后者承载正式内部应用及 Launchpad/tab 生命周期；它不是 `VCPFrontendPlugins` 的替代协议。

反馈接口：

```js
VCPUI.feedback.toast('保存成功', { variant: 'success' });
const accepted = await VCPUI.feedback.confirm({ message: '确定删除吗？', danger: true });
const name = await VCPUI.feedback.prompt({ title: '项目名称', required: true });
VCPUI.feedback.setLoading(true, '正在保存');
VCPUI.feedback.setLoading(false);
```

Confirm 和 Prompt 按 FIFO 执行；Loading 当前使用引用计数。`cancelAll()` 只允许根应用退出或全局故障恢复使用，内部应用必须只释放自己拥有的反馈；owner-scoped feedback 是当前路线 P1 的阻塞工作。

## 内部应用

```js
window.nextUiApps.register({
    id: 'example-app',
    title: '示例应用',
    icon: 'widgets',
    kind: 'internal',
    mount(container, context) {
        return () => container.replaceChildren();
    }
});
```

同一应用 ID 只打开一个顶部标签。关闭活动标签时优先激活左侧相邻标签；没有左侧标签则返回首页。外部 Electron 应用仍通过原有托盘 IPC 打开。

### Integrated App Shell

新版内嵌业务页统一使用 `vcp-ui-integrated-shell`，让页面内容与 VChat 顶部导航形成同一应用表面。`AppPageShell` 仍是窗口生命周期外壳，但在 `data-embedded="true"` 时隐藏重复标题栏；独立窗口继续显示标题和窗口按钮。

页面只允许选择一种真实信息结构：

- `data-layout="rail"`：笔记、翻译、记忆等左侧检索/分类，右侧工作的主从布局。
- `data-layout="compact-rail"`：确有稳定图标工具轨的密集工具页面。
- `data-layout="canvas"`：插件、任务、论坛、日志、便签等单一工作画布。

共同 DOM 合同为 `vcp-ui-integrated-layout`、`vcp-ui-integrated-rail`、`vcp-ui-integrated-main` 和 `vcp-ui-integrated-content-toolbar`。主表面统一使用左上圆角、顶部/左侧边线和轻阴影；外层及 rail 明确使用 `--vcp-ui-bg-1`，不得依赖透明 Electron 子视图碰巧混出相近颜色。

嵌入模式隐藏标题栏前，标题栏内的业务动作必须迁移到内容工具栏或页面原有操作区。不得隐藏刷新、创建、设置、保存或危险操作；窗口最小化、最大化、关闭只在独立窗口出现。

## 迁移台账

下列状态以实际 Electron 检查为准，`partial` 不得视为完成：

业务子页面采用显式 allowlist。首个上游 PR 的 allowlist 为空；包括笔记与翻译在内的子页面均保持上游 Classic 文件，不保留禁用的 AppPageShell 重建，详见 `docs/ui-active-surface-policy.md`。

| Surface | Status | Evidence required before stable |
| --- | --- | --- |
| 顶栏、标签、应用启动器 | migrated | 明暗主题、标签关闭、内部应用复用，以及 Host/标签/反馈容器清理 |
| 全局 Toast 与反馈 Host | migrated | owner 隔离、并发清理与展示页关闭后跨 owner 保留 |
| 聊天输入、附件与发送/中断 | migrated | 禁用、焦点、附件、发送与中断状态 |
| 侧栏、话题列表与通知抽屉 | migrated | 选中、滚动、通知打开与窄窗口 |
| 全局设置弹窗 | partial | 双栏导航、内容滚动、保存栏以及浅色默认/深色 700×500 真实审查已通过；每个分区的保存、错误与键盘关闭仍待完成 |
| Agent/Group 编辑表单 | partial | Agent/Group 已统一为扁平纯色设置模式；Input、Textarea、Select、Switch、Field、Range、SettingsSection 和 SettingsActionBar 已通过设置桥自动增强，并接收真实保存、删除、取消和失败状态。完整键盘焦点及 Electron 视觉矩阵仍待完成 |
| 其他业务弹窗 | partial | 通用外壳、输入和操作区已进入新版 Token 作用域；头像裁剪、全局搜索和筛选规则外壳已通过 Electron 首开、焦点和窄窗口检查，筛选规则编辑器及实际操作仍待逐项验证 |
| 聊天消息、工具调用和富文本内容 | partial | 基础消息、代码、附件、工具结果、摘要、思考链、桌面推送、日记与 Markdown 表格已 Token 化；消息表面、窄表格已验证壁纸透出与无横向溢出，长内容、错误、加载与最小窗口的完整矩阵仍待完成 |

迁移时应复用现有组件或补充通用能力，不在业务模块复制组件 CSS。经典 UI 不进入迁移范围。任何 `partial` 或 `pending` 表面都不能用于宣称新版重构已完成。

提交前运行：

```bash
npm run check:ui-system
```

该命令依次执行语法检查、Stylelint、静态门禁和 JSDOM 组件契约测试。

真实 Electron 验证记录与剩余矩阵见 [新版 UI Electron QA 矩阵](./ui-system-qa-matrix.md)。

应用页与全局设置迁移见 [VCPChat 应用页面与全局设置 Web Awesome 全量重构计划](./ui-applications-webawesome-migration-plan.md)。
