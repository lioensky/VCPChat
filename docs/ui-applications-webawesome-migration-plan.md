# VCPChat 应用页面与全局设置 Web Awesome 路线图

> 状态：历史页面迁移方案，当前不实施。无生产消费者的业务子页面 Next runtime 已在 P2 删除；未来只允许页面、runtime 与测试在同一独立 PR 引入。
> 基线日期：2026-08-01
> 适用分支：`codex/vcpchat-codex-app-server`
> 当前试验：UI 组件库中的“WA 对照”已完成真实 Electron 渲染验证，但不能据此宣称业务页面已迁移。

## 1. 目标

在不替换主聊天、不改变业务协议和数据权威的前提下，将应用启动器中的目标页面与全局设置迁移到统一、工业级的新版 UI。Web Awesome 作为基础控件的交互、无障碍和状态内核，VCPChat 继续拥有产品视觉、页面布局、复合模式和业务语义。

最终目标不是让页面看起来像 Web Awesome 默认示例，而是实现：

- 所有纳入范围的页面共享 VCPChat Token、字体、图标、密度、焦点、反馈和窗口壳层。
- Button、Input、Select、Dialog、Tabs、Tooltip 等基础控件不再由各页面重复实现。
- 同一业务页面在顶部标签内嵌和独立窗口两种模式下使用同一份 DOM、样式和状态逻辑。
- 原有 IPC、preload、持久化、ToolBox、DistributedServer 和子进程职责不因换 UI 被重写。
- 每个页面均经过自动门禁和真实 Electron 视觉/交互验收，未完成前不标记全量重构完成。

## 2. 范围

### 2.1 纳入范围

| 页面 | 当前入口 | 当前运行形态 | 主要代码 | 计划批次 |
| --- | --- | --- | --- | --- |
| 全局设置 | 顶栏/账户菜单 | 主 Renderer Modal | `main.html`、`modules/global-settings-manager.js`、`styles/setting/` | R5.1 |
| 翻译 | 应用页 | 可内嵌、可独立窗口 | `Translatormodules/` | R5.2 |
| 日志 | 应用页 | 可内嵌、可独立窗口 | `Logmodules/` | R5.2 |
| 插件 | 应用页 | 可内嵌、可独立窗口 | `PluginManagerModules/` | R5.2 |
| 任务 | 应用页 | 可内嵌、可独立窗口 | `Agenttaskmodules/` | R5.2 |
| 笔记 | 应用页 | 可内嵌、可独立窗口 | `Notemodules/notes.*` | R5.3 |
| 便签 | 应用页 | 可内嵌、可独立窗口 | `Notemodules/notemini.*` | R5.3 |
| 记忆 | 应用页 | 可内嵌、可独立窗口 | `Memomodules/` | R5.3 |
| 论坛 | 应用页 | 可内嵌、可独立窗口 | `Forummodules/` | R5.3 |
| 协同 | 应用页 | 独立窗口 | `Canvasmodules/` | R5.4 |
| 骰子 | 应用页 | 独立窗口、本地服务页面 | `Dicemodules/` | R5.4 |
| 监听 | 应用页 | 独立窗口 | `RAGmodules/RAG_Observer.html` | R5.4 |
| 工具 | 应用页 | 独立 Electron 子应用 | `VCPHumanToolBox/` | R5.5 |
| 数据 | 应用页 | 独立 Electron 子应用 | `VchatManager/` | R5.5 |

### 2.2 明确排除

- 主聊天界面、主聊天消息渲染器、主侧栏与主输入区。
- Agent Workbench 与 Codex/Rust Agent Runtime 页面。
- 音乐、主题、终端与桌面。
- 经典 UI 的视觉重构；经典 UI 只保留必要兼容和回归测试。
- ToolBox、DistributedServer、插件协议、存储格式或业务 API 的功能性重写。
- 将所有页面强行改成 React/Vue，或为本轮引入新的前端构建链。

### 2.3 UI Mode 硬边界

本计划的所有视觉和组件改造只在新版 UI mode 生效：

- 只有 `html[data-ui-mode="next"]` 页面可以加载 Web Awesome runtime、adapter CSS 和新版页面模式。
- `classic` 模式继续使用当前 DOM、当前 CSS 和当前交互，不进行视觉“顺手修正”。
- 主窗口内嵌页由 Host 显式下发当前 UI mode，不允许子页面按系统主题或默认值猜测。
- 独立窗口和独立子应用从持久设置/受限 IPC 获取 UI mode，并订阅后续变化。
- 从 `next` 切回 `classic` 时必须调用所有 adapter 的 `destroy()`，移除新增 ARIA、状态、监听、Observer、弹层和 theme link，恢复原业务节点。
- 从 `classic` 切到 `next` 时采用幂等 mount；重复 mode event 不得重复注册组件、监听或提交 handler。
- 经典模式不承担新版页面的测试失败兜底之外的双重开发；所有新增功能仍由原业务层共享，不能只存在于某个 presentation。

当前 UI 组件库试验页仍在主 Renderer 模块求值阶段注册 Web Awesome custom elements。R5.0 必须将它改为仅在新版组件库实际打开时 lazy-load；完成前该试验不能作为正式页面加载模式。

## 3. 架构决策

### 3.1 稳定 API 与实现内核分离

业务页面不得直接依赖 `<wa-*>`。正式迁移路径固定为：

```text
业务页面
  -> VCPUI / VCPPagePatterns
      -> WebAwesomeAdapter（基础行为）
      -> VCP custom composites（产品复合组件）
          -> VCP token / theme / density
```

- `VCPUI` 保持公共组件名称、状态模型和 `element/update/focus/destroy` 生命周期。
- `WebAwesomeAdapter` 负责 Web Awesome 注册、属性/事件转换、`updateComplete`、表单关联和销毁。
- `<wa-*>` 仅允许出现在 adapter 和 UI 组件库试验页；业务模块直接使用视为门禁失败。
- 页面级组件只消费 VCP API，未来即使替换 Web Awesome，也不需要重写业务页面。

### 3.2 本地、固定、无 bundler 加载

- 固定 `@awesome.me/webawesome@3.11.0`，升级必须单独提交并重新执行全矩阵。
- 当前 Renderer 没有 bundler/import map，必须使用包内自包含的 `dist-cdn` 本地构建；名称中的 CDN 不代表联网加载。
- 禁止运行时访问公共 CDN。生产包必须验证 Web Awesome 资源存在于 ASAR/安装目录。
- Theme CSS 只能由 runtime adapter 按引用计数加载/卸载；不得把 Web Awesome 默认主题永久覆盖到整个 VChat。

### 3.3 视觉权威仍是 VCPChat

- 颜色、字号、间距、圆角、阴影、控件高度、Z-index 和动效只来自 `--vcp-ui-*`。
- Web Awesome 的 `--wa-*` 仅在 `webawesome-adapter.css` 中映射，业务 CSS 不直接维护第二套主题。
- Shadow DOM 外观只通过已登记的 `::part()` 和 token adapter 修改。
- 保留 VCPChat 的低圆角、紧凑桌面密度、弱选中态和主题/壁纸层级，不采用 Web Awesome 默认蓝色品牌或默认页面布局。
- 页面布局不默认卡片化。日志、表格、主从列表、画布和编辑器继续使用适合任务的开放布局。

### 3.4 业务与窗口边界不变

- 页面迁移不得改变 IPC channel、preload allowlist、数据库位置、网络协议或业务对象身份。
- `WebContentsView` 内嵌态和 `BrowserWindow` 独立态共用同一个 HTML/JS/CSS 入口。
- 窗口控制通过显式 embedded mode 隐藏，不再长期依赖 Main 注入 `!important` CSS。
- 工具和数据仍是独立 Electron 子应用；R5.5 只共享设计系统运行时和页面模式，不把它们并入主 Renderer。
- 协同、骰子和监听保持当前独立运行模型，除非另有独立架构决策。

## 4. 设计系统增量

### 4.1 Web Awesome 基础适配器

首批建立并冻结：

- `ButtonAdapter`：primary/secondary/outline/ghost/danger、loading、disabled、icon。
- `InputAdapter`、`TextareaAdapter`：校验、readonly、disabled、clear、password。
- `SelectAdapter`：单选、多选、键盘导航、异步 options 更新。
- `CheckboxAdapter`、`SwitchAdapter`、`RadioGroupAdapter`、`RangeAdapter`。
- `TabsAdapter`、`TooltipAdapter`、`DropdownAdapter`。
- `DialogAdapter`、`DrawerAdapter`、`ToastAdapter`、`SpinnerAdapter`。

适配器必须处理 Lit 异步更新，测试不得在属性赋值后立即假定 Shadow DOM 已完成。

### 4.2 VCP 自有复合组件与页面模式

以下能力不直接照搬 Web Awesome，需要由 VCP 定义：

- `AppPageShell`：标题栏、内嵌/独立模式、工具区、滚动区和错误边界。
- `SettingsShell`：分类导航、搜索、Section、脏状态、保存结果和危险操作。
- `FilterToolbar`、`MasterDetail`、`DataTable`、`VirtualLogView`、`Pagination`。
- `EditorToolbar`、`SplitPane`、`InspectorPanel`、`StatusBar`。
- `AsyncBoundary`：loading、empty、error、retry 和 stale 状态。
- `ResourcePreview`：图片、文件、链接、代码和结构化结果。
- `WindowControls`：仅独立窗口显示，内嵌模式不渲染。

### 4.3 统一图标与文案

- 基础命令使用现有 Lucide/图标适配器，不在页面内继续复制 SVG 字符串。
- 图标按钮必须有可访问名称；不使用 emoji 代替产品图标。
- 同一动作统一命名，例如“刷新”“保存”“删除”“重试”“返回”。
- 业务专用图标允许保留，但必须登记来源、尺寸和状态规则。

## 5. 分阶段施工

### R5.0：基础设施与冻结门槛

目标：把试验页升级为可供业务依赖的受控基础设施。

- 建立 `WebAwesomeAdapter`，将当前 showcase 直接 `<wa-*>` 用法限制在试验目录。
- 将 Web Awesome JS/CSS 改为 `next` mode 下按需 lazy-load；经典模式启动和打开旧应用时不得请求这些资源。
- 建立组件加载清单，按页面加载所需组件，不让每个页面自行 import。
- 建立 `AppPageShell`、embedded mode、主题同步和 density 同步。
- 建立 `UiModeController`：统一处理内嵌页、独立窗口和独立子应用的 mode 初始化、订阅、mount 与 teardown。
- 新增门禁：业务目录禁止 `<wa-*>`、裸 `--wa-*`、CDN URL、未登记 `::part()`。
- 增加打包 smoke，验证安装包中 Web Awesome JS/CSS 可解析。
- 在 UI 组件库补齐明暗、紧凑、错误、长文本和键盘状态。

完成门槛：基础 adapter 契约测试、UI guard、Electron showcase、打包资源 smoke 全部通过。

### R5.1：全局设置

目标：以最高复用价值的表单页面验证迁移模式，不改保存逻辑。

- 保留 `globalSettingsForm`、现有 field ID、`global-settings-manager.js` 和设置文件格式。
- 先拆除内联样式和重复 SVG，再以 `enhance()` 接入 Input/Select/Switch/Radio/Range。
- 分类导航迁移到稳定 Tabs/List 模式；支持设置搜索和命中项定位。
- 统一密码显示、校验错误、连接测试、保存中、保存成功和失败状态。
- 保存栏固定在内容区底部；切换分类不丢未保存值。
- 对头像上传、颜色输入、划词助手、语音与高级功能分别做独立回归。

完成门槛：7 个设置分类逐项完成加载、修改、保存、失败、重开恢复和键盘验收。

### R5.2：低耦合工具页

目标：建立可以快速复制的标准数据/表单页面模板。

- 翻译：双栏输入输出、语言选择、交换、复制、loading/error 和长文本。
- 日志：筛选、行数、排序、复制、清空确认、长流与虚拟化/有界渲染。
- 插件：插件列表、筛选、启停、配置编辑、服务器状态和危险操作。
- 任务：任务/Agent 视图、状态筛选、详情与设置对话框。

完成门槛：四页在内嵌和独立窗口中功能一致，无重复标题栏、无滚动抢夺、无状态丢失。

### R5.3：内容与主从页面

目标：迁移拥有复杂本地状态、编辑与内容浏览的页面。

- 笔记：目录/列表/编辑器三段布局、搜索、自动保存、附件与冲突状态。
- 便签：紧凑窗口、置顶、自动保存、颜色/透明度与最小尺寸。
- 记忆：列表、工作台、图谱和详情面板；图谱画布本身不由 Web Awesome 接管。
- 论坛：板块、搜索、瀑布流/列表、发帖、详情、管理设置和富文本。

完成门槛：切换、编辑、保存、搜索、长内容、空态和重开恢复全部基于真实数据验证。

### R5.4：专用交互页面

目标：统一壳层和控件，但尊重画布、3D 与实时观察页面的专用渲染。

- 协同：只迁移工具栏、面板、对话框、状态栏和表单；画布与 diff 核心保持原实现。
- 骰子：迁移 notation 输入、投掷控制、结果历史和错误提示；3D 骰子引擎不改。
- 监听：迁移过滤、暂停、清空、详情与通知卡壳层；高频事件视图采用有界队列和增量 DOM。

完成门槛：resize storm、长时间运行、暂停/恢复、清理和 GPU/内存基线通过。

### R5.5：独立子应用

目标：让工具和数据拥有相同设计语言，但保持独立进程与安全边界。

- 抽出可由多个 Electron 页面加载的 `vcp-ui-runtime` 静态包和共享 token CSS。
- 工具：工具目录、动态参数表单、执行结果、历史和 Workflow Editor 分阶段迁移。
- 数据：数据库列表、表格、查询/筛选、分页、导入导出和危险操作迁移。
- 独立子应用不得反向读取主 Renderer 全局对象；只通过现有 preload/IPC 获取数据。
- Workflow Editor、复杂画布和数据表格允许保留专用渲染器，外围控件统一即可。

完成门槛：独立启动、从应用页启动、异常退出、主题同步和打包后启动全部通过。

### R5.6：收尾与旧样式退役

- 删除已迁移页面的重复 button/input/modal/toast CSS 和内联样式。
- 删除内嵌页面依赖 Main `insertCSS(... !important)` 隐藏窗口按钮的兼容逻辑。
- 生成页面迁移覆盖率：控件数、直接 SVG、inline style、裸色、legacy class。
- 更新组件成熟度、QA 矩阵和截图基线。
- 所有页面通过后，才把计划状态改为 `completed`。

## 6. 页面迁移固定步骤

每个页面必须按同一顺序施工：

1. **事实冻结**：记录入口、窗口模式、IPC、preload、数据源、快捷键和主要状态。
2. **行为测试**：迁移前为核心流程补 hermetic 测试，防止 UI 改造改变业务。
3. **Token 化**：去除裸色、固定字号、重复 radius/shadow 和内联样式。
4. **基础增强**：用 VCP adapter 增强原控件，保留 ID、事件和引用。
5. **复合收敛**：替换页面自制 Modal、Toast、Tabs、Toolbar、Empty/Error。
6. **布局重构**：最后调整页面结构；不得把行为迁移和大布局重写塞进一个不可审查提交。
7. **双模式验收**：同时验证 embedded 与 standalone；仅支持 standalone 的页面验证独立窗口。
8. **旧 CSS 删除**：只有截图和功能回归通过后才删除兼容规则。

每个页面至少拆为“行为基线”“组件接入”“布局/视觉”“旧样式清理”四类提交。

## 7. 测试与验收

### 7.1 自动门禁

- `npm run check:ui-system`
- 新增 `npm run check:ui-applications`
- 页面 JS 语法和 IPC contract tests。
- Adapter 的属性、事件、表单、异步更新和 destroy 契约。
- 禁止业务目录直接使用 `<wa-*>`、`--wa-*`、公共 CDN 和未登记 Shadow Part。
- 打包后资源解析、ASAR 路径和独立子应用启动 smoke。

### 7.2 Electron 功能矩阵

每页必须验证：

- 首开、关闭、重开、复用已有窗口/标签。
- Embedded/standalone 的标题栏、边界、焦点与滚动。
- loading、empty、error、disabled、readonly、长文本与错误数据。
- 主要保存/执行/删除/取消流程和失败恢复。
- 主题切换、density 切换、窗口 resize 和进程 crash 后清理。
- `classic -> next -> classic` 循环两次，确认业务状态不丢失、handler 不重复、旧页面样式不漂移。

### 7.3 视觉与无障碍矩阵

- 浅色、深色、壁纸/透明主题。
- comfortable、compact。
- 1440×900、969×696、页面声明的最小窗口。
- 键盘主流程、可见焦点、Escape、焦点恢复和 screen-reader name。
- `prefers-reduced-motion`。
- 无横向溢出、文字裁切、控件跳动、弹层遮挡和嵌套卡片。

每个批次保存真实 Electron 截图和验证收据：日期、命令、VChat commit、Web Awesome version、运行模式与未通过项。

## 8. 性能预算

- Web Awesome 基础设施的压缩后 JS/CSS 体积在 R5.0 记录基线；后续升级不得无说明增长。
- 页面只加载所需组件，不允许所有独立窗口无条件注册完整组件库。
- 高频日志/RAG 页面禁止每事件全量 `innerHTML`；采用 keyed incremental update、有界缓存或虚拟化。
- 首次可交互、内嵌切换、独立窗口冷启动和内存驻留建立基线；回归超过既定阈值即阻塞合入。
- Lit `updateComplete` 只用于需要读取更新后布局的路径，不在普通事件中重复 await 全组件树。

## 9. 安全与回滚

- 不把 API Key、密码或完整设置对象写入 DOM attribute、日志或 localStorage。
- Dialog、Dropdown 和富文本不得降低现有 CSP；移除 inline style 后逐步收紧 `unsafe-inline`。
- 文件选择、导入导出、插件启停和日志清空保留原审批/确认边界。
- 每页保留独立 feature flag，迁移失败可回退旧 presentation，但不能维护第二套业务状态。
- 回滚只切换 Renderer presentation；数据库、IPC 和业务协议不做双写。

## 10. 完成定义

只有以下条件全部成立，才能声明本轮全量重构完成：

1. 范围内 14 个页面/表面全部通过对应批次门槛。
2. 业务目录不存在直接 Web Awesome 依赖、重复基础控件实现和未登记 Shadow Part。
3. Embedded/standalone 页面使用同一实现，没有两套状态或样式分叉。
4. 全局设置每个分类均通过真实保存与错误恢复。
5. 工具、数据两个独立子应用在开发与打包环境均通过启动和核心流程。
6. 自动门禁、Electron 功能矩阵、视觉矩阵和性能预算全部有当前 commit 的验证收据。
7. 主聊天、Agent、排除应用和经典 UI 没有行为回归。

在上述条件满足前，文档状态只能是 `planned`、`in progress` 或 `partial`，不得使用“重构完成”或“产品可用”。


## 进度记录

### R5.0 基础设施 — 已完成（2026-08-01）
- Web Awesome 3.11.0 以精确 devDependency 锁定，并从 npm 源包生成最小离线闭包到 `vendor/webawesome-runtime/`；`check-ui-system` 与 `pack:check` 校验版本、manifest hash、相对依赖和打包资源。
- `webawesome-comparison.js` 改为动态 `import()` 加载 vendored 组件，仅 `html[data-ui-mode="next"]` 且组件库打开时注册；启动零 WA 资源请求（真实 Electron 验证）。
- 新增 `WebAwesomeAdapter`（`modules/ui-system/webawesome-adapter.js`）：lazy 组件加载、prop/事件翻译、`updateComplete`、refcount 主题、`destroy()`；契约测试通过。
- 新增 `UiModeController`（`modules/ui-system/ui-mode-controller.js`）：内嵌/独立/子应用统一 mode 初始化·订阅·幂等 mount·teardown；主进程向内嵌页下发 `?uiMode=`；契约测试通过。
- **核心控件 WA 化**：VCPUI `Select/Tabs/Tooltip/Modal` 在组件预加载后由 Web Awesome 提供行为内核（保持 `element/update/focus/destroy` 公共契约与事件）；真实 Electron 验证 value/open/close/destroy。
- VCPUI 新增 `AppPageShell` / `WindowControls` / `AsyncBoundary`（candidate，已入清单与组件库）。
- 新增 `npm run check:ui-applications`：业务目录禁 `<wa-*>`、裸 `--wa-*`、CDN、未登记 `::part()`、以及直接引用 `VCPWebAwesome`。
- 新增 `scripts/check-webawesome-pack.mjs`（`pack:check`）打包资源 smoke。
- 新增 `scripts/test-electron-ui-apps-smoke.mjs`（`test:electron-ui-apps`）真实 Electron 逐页验证。

### 架构边界契约（2026-08-02 收紧）
业务页面**只允许依赖 VCPUI**，Web Awesome 是内部实现细节：
```text
业务页面 → VCPUI / VCPPageRebuild → WebAwesomeAdapter → Web Awesome
```
- 业务页禁止出现 `<wa-*>`、裸 `--wa-*`、`VCPWebAwesome`、CDN、未登记 `::part()`（`check-ui-applications` 强制）。
- Tooltip 一律 `VCPUI.create('Tooltip')`；页面重建统一经 `VCPPageRebuild.rebuild` 或 VCPUI API。
- 时序契约：`vcp-ui-runtime-bootstrap.js` 先 `await` WA 组件预载完成再派发 `vcp-ui-runtime-ready`；页面只在 ready 后构建，因此 `VCPUI.create('Select'|'Tabs'|'Modal'|'Tooltip')` 必然 WA-backed，未预载的主渲染器/经典模式回落原生 DOM。

### R5.1 全局设置 — 增强完成（2026-08-01），结构重构未完成
- `settings-bridge.js` 新增 `#globalSettingsForm` 增强路径（Input/Textarea/Select/Range/Switch/Field + SettingsActionBar 保存栏 + 设置搜索）。
- 保存栏接受 `.global-settings-footer`，脏/保存/错误状态沿用 `vcp-settings-save-result`。
- 真实 Electron 验证增强、搜索、脏/保存态、切经典清理。
- 尚未：`styles/setting/*` 迁移 token、分类导航改 VCPUI Tabs/List、逐分类真实保存回归。

### R5.2–R5.5 当前交付状态（2026-08-07）

| 页面 | 首个上游 PR 状态 | 说明 |
|---|---|---|
| 翻译 translator | 上游 Classic | 本 PR 不携带 Next 重建；业务文件与 `origin/main` 一致。 |
| 笔记 notes | 上游 Classic | 本 PR 不携带 Next 重建；业务文件与 `origin/main` 一致。 |
| 其余业务页面 | 上游 Classic | 实验性 Next HTML/CSS/JS、测试和截图均不随本 PR 交付。 |

`test-page-runtime` 必须报告 `0 active rebuilt`；边界门禁逐文件校验所有业务子页面与 `origin/main` 一致。未来页面迁移必须独立开 PR，不在本分支保存不可达实现。

### 后续独立工作

- 全局设置结构重构与逐分类真实保存回归。
- 每个候选业务页分别完成业务回归、生命周期、窄窗口、Electron smoke 后，再单独加入 allowlist。
- 打包后真实资源解析与迁移覆盖率报告。
