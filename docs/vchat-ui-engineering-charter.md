# VChat UI 工程开发规范

> 状态：当前 App Surface 视觉工程的总规范
> 
> 适用分支：`codex/app-surfaces-ui-refresh-17dd`
> 
> 最近上游同步：`54282c03 Merge upstream/main into app surfaces refresh`

## 1. 工程目标

VChat 的不同页面由不同开发者、不同阶段分别实现，已经形成明显的质量和体验差异：页面结构、视觉语言、主题适配、交互状态、响应式行为和 CSS 组织方式都不一致。

本工程的目标不是单纯“给页面换皮”，也不是重写业务，而是建立一套可持续的 UI 工程规范，使 VChat 的不同页面：

- 看起来属于同一个产品；
- 遵循同一套页面结构和交互状态合同；
- 在深浅主题、窄窗口、加载失败和重复打开等场景下保持可用；
- 由统一 token、组件模式和门禁约束，而不是依赖个人习惯；
- 保留原有业务、IPC、数据协议和插件行为。

最终判断标准是：页面是否遵守 VChat 的视觉/交互合同，并且没有改变既有业务真相。

## 2. 统一的对象

### 2.1 视觉语言

统一颜色、字体、字号层级、页面背景、面板、边框、圆角、阴影、间距、密度、按钮、输入框、选择器、徽标、滚动条、焦点态、悬停态和禁用态。

页面可以有自己的内容气质，但不能各自重新定义基础色、页面间距、标题栏、工具栏和状态样式。

### 2.2 页面骨架

业务页面默认遵循：

```text
App Surface
├── Header       标题、图标、返回、主要操作
├── Toolbar      搜索、筛选、次要操作
├── Content      列表、卡片、编辑器、表格或详情
└── Status       加载、空、错误、保存反馈和状态信息
```

共享层提供骨架和合同，页面层只负责内容布局与真正独有的视觉规则。

### 2.3 交互状态

每个页面必须明确首开、加载中、空数据、错误、禁用、保存中、保存成功/失败、关闭、返回、Escape、焦点恢复、窄窗口和主题切换行为。

## 3. 架构边界

VChat 有两条相关但不能混淆的 UI 轨道：

1. 主窗口 Next/VCPUI 设计系统：负责主聊天 Shell、设置、通知、应用标签、Overlay、Provider 和生命周期。
2. Classic App Surface 视觉统一：负责 Notes、Translator、Plugin Manager、Forum、Memo、Log 六个独立业务页面的视觉和布局。

两条轨道共享设计原则，但不共享运行时 owner，也不把 Classic 子页面强行迁入 Next runtime。

### 允许修改

- CSS、cascade layer、设计 token 和页面布局包装；
- 空/错/加载/保存等展示状态；
- 页面专属的视觉文案和图标；
- 页面专属静态门禁、布局测试和截图证据；
- 为解决明确宿主问题所需的最小适配。

### 默认禁止修改

- 主聊天消息内部渲染、输入、流式和附件协议；
- manager、IPC、聊天数据和用户配置协议；
- 前端插件 Loader、插件卸载/热重载和动态壁纸生命周期；
- 通过隐藏 Classic DOM 或模拟点击代理业务操作；
- 为展示方便新增第二业务 Store；
- 为局部页面引入 React、Vue、Solid 或新的全局容器。

若必须越过边界，必须单独说明 producer、consumer、owner、回滚方案和证据，不能顺手扩大范围。

## 4. CSS 和组件规则

Classic App Surface 使用 `styles/app-surfaces/`；主窗口 Next/VCPUI 使用 `styles/ui-system/`。两者不得互相偷偷加载运行时或覆盖对方的 owner 合同。

App Surface 共享层采用以下 cascade layers：

```text
vcp.tokens → vcp.surface → vcp.components → vcp.page → vcp.overrides
```

- `vcp.tokens`：颜色桥接、间距、尺寸、密度、圆角、阴影和布局合同；
- `vcp.surface`：Header、Toolbar、Content、Status、滚动区和焦点；
- `vcp.components`：按钮、输入、列表、卡片、徽标、空/错/加载状态；
- `vcp.page`：单个页面真正独有的内容布局；
- `vcp.overrides`：例外，仅允许在提交说明中记录原因。

禁止 `!important`、重复定义共享 token、页面自带滚动条体系、无理由的裸色和无理由的固定字号。卡片不嵌套堆叠，选中态使用弱强调，加载态尽量保持布局稳定。

## 5. 页面合同

每次改造页面前，先在提交或对应文档中写清：

- 业务 manager、IPC 和唯一真相；
- 当前 DOM/state 入口；
- 用户动作、键盘和焦点行为；
- 加载、空、错误、禁用、脏数据和保存状态；
- 关闭、Escape、导航和焦点恢复；
- 必须保持的上游行为；
- 可以变化的视觉结构。

动态页面还必须指定一个 owner 负责 listener、Observer、timer、IPC task、Overlay、WebContentsView 和临时 DOM。`mount` 要能原子回滚，`dispose` 要幂等并达到 quiescence；所有 `await` 后都要检查当前 generation/owner，迟到结果失去提交权。

## 6. 质量门禁

不同改动只运行与风险相称的证据：

- 共享 token/页面 CSS：`lint:ui-system`、`check:app-surfaces`、`git diff --check`；
- 页面结构或状态：对应页面静态门禁和 Electron UI Apps smoke；
- Provider/controller：focused unit test、UI System gate 和失败回滚测试；
- 生命周期、Overlay、IPC、View：操作序列、逆序异步和压力测试；
- 主题/响应式视觉：真实 Electron 深浅主题、480px 窄窗口和截图/几何检查；
- 跨平台或打包声明：macOS 与 Windows 真实证据，不能用一个平台替代另一个。

绿色单测不等于视觉完成；旧证据必须标明日期、平台和 HEAD，不能直接引用为当前事实。

## 7. 分支与同步规则

- App Surface 视觉施工在独立 worktree/分支进行，不污染主架构工作树；
- 当前完整视觉施工树为 `/Users/asahi/Documents/Codex/2026-08-02/grok-build-github/vchat-app-surfaces-ui`；
- 上游同步前先记录 `git status`、merge-base、领先/落后关系和冲突演练；
- 同步优先合并 `upstream/main`，解决基础文档、package 和门禁基线冲突后再运行页面门禁；
- 不直接把上游业务改动重写进视觉提交；
- 每个页面和每个基础能力保持小提交，可独立审查、回滚和归因；
- 未经明确要求，不推送远程、不创建 PR、不合并回主架构分支。

## 8. Definition of Done

一个页面或能力只有同时满足以下条件才可标记完成：

1. 业务 owner 和展示 owner 清晰；
2. 视觉 token、结构和状态遵守共享合同；
3. 深浅主题、窄窗口、键盘、焦点和异常状态已验证；
4. 业务 DOM、manager、IPC、协议和插件边界未被无意改变；
5. 失败挂载可回滚，关闭/重开无迟到结果和资源泄漏；
6. 相关静态、单元、Electron 或跨平台证据已记录；
7. 变更可以独立回滚，且工作树和文档状态一致。

本规范与 `next-ui-current-state.md`、`vcp-ui-provider-architecture.md`、`next-ui-lifecycle-architecture.md` 和 `styles/app-surfaces/README.md` 一起构成工程约束；若事实冲突，以当前代码和最新证据为准并在同一变更中更新文档。

参考项目的取舍记录见 [`ui-reference-research-cherry-deepseek.md`](./ui-reference-research-cherry-deepseek.md)：Cherry Studio 提供内容优先的视觉方向，DeepSeek Harness 提供 seam、owner、真实入口和证据哲学。
