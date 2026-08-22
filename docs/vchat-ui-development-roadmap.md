# VChat UI 统一工程路线

> 目标：把不同开发者实现的 VChat 页面收敛到统一的视觉、结构、交互和质量规范。
> 
> 当前工作树：`codex/app-surfaces-ui-refresh-17dd`
> 
> 当前同步基线：`54282c03`，相对 `upstream/main` 领先 25、落后 0

## 1. 当前已完成

App Surface 视觉分支已经有 20 个页面/共享层提交，覆盖 Notes、Translator、Plugin Manager、Forum、Memo、Log：

- 共享 token、Shell、Content、状态和页面层；
- 六页 opt-in 接入和页面专属布局；
- 统一标题栏、工具栏、图标、卡片、边框和状态文案；
- 空、错误、加载和启动失败状态；
- 静态 `check:app-surfaces` 门禁；
- Electron UI Apps smoke 的页面 opt-in 和布局检查；
- 最近一次上游同步已完成，视觉提交未丢失。

当前 `npm run check:app-surfaces` 已通过。旧设计边界门禁仍需重新归因 `sourceRef` 和页面 JS 文案差异，不能把旧分支数字直接当最终证据。

## 2. 阶段路线

### 阶段 0：事实和规范收口

状态：进行中。

工作：

- 以本路线和工程规范作为共同入口；
- 清理两个相似 worktree/branch 的使用歧义；
- 更新设计边界门禁的基线和 App Surface 允许范围；
- 为六页记录页面合同、owner、业务边界和缺失证据。

退出条件：后续开发只在已同步视觉 worktree 进行，文档和门禁对当前 HEAD 一致。

### 阶段 1：共享视觉系统稳定化

状态：主体已完成，待同步后复验。

工作：

- 固化 `styles/app-surfaces/` token 与 cascade layer；
- 统一标题栏、工具栏、内容宽度、列表密度、控件尺寸和状态模式；
- 移除页面重复 token、滚动条和冲突基础规则；
- 验证深浅主题、窄窗口和无数据状态。

退出条件：六页共享层结构一致，静态门禁通过，页面 JS/IPC 只保留必要展示适配。

### 阶段 2：Translator 样板验收

状态：视觉实现已提交，待同步后的完整证据复验。

工作：

- 验证 Header/Toolbar/Content/状态四类原语；
- 验证源文/结果双栏在窄窗口的折叠策略；
- 验证模型、语言和翻译操作的焦点、禁用和失败状态；
- 验证浅色/深色主题和重复打开/关闭。

退出条件：Electron smoke、布局检查、主题截图和页面合同全部通过，样板风格才可推广。

### 阶段 3：Notes 文档型页面

状态：视觉实现已提交，待复验。

工作：

- 保持文件树、编辑器、预览和保存业务不变；
- 优化侧栏、编辑区、预览区、工具栏和空态层级；
- 保护长文、代码块、表格、Markdown/HTML/Latex/Mermaid 预览可读性；
- 验证窄窗口下侧栏折叠、编辑器滚动和焦点恢复。

退出条件：文档编辑不被统一样式压缩，保存/失败/重开无业务回归。

### 阶段 4：Plugin Manager

状态：视觉实现已提交，待复验。

工作：

- 统一 hero、摘要、插件卡片、分组和生命周期状态；
- 明确启用、禁用、加载失败和缺少配置的视觉差异；
- 不改变插件 Loader、插件协议或服务生命周期。

退出条件：状态可读、窄窗口不溢出、插件业务门禁保持通过。

### 阶段 5：Forum / Memo / Log 内容型页面

状态：视觉实现已提交，待复验。

工作：

- Forum：高密度列表、搜索、筛选、详情和错误状态；
- Memo：列表、编辑器、预览、图谱/工作台的层级与状态；
- Log：窄窗、连续日志、轮询失败和空态反馈；
- 清理共享顶栏和重复 glass/fallback 规则。

退出条件：三页保持内容密度但不拥挤，轮询/网络/文件业务不被视觉层改变。

### 阶段 6：统一视觉回归和证据

状态：部分完成。

工作：

- 为六页补齐静态 token/层级/opt-in 断言；
- 为深浅主题、480px 和关键页面状态保存 Electron 截图/几何证据；
- 将视觉门禁纳入 `check:ui-applications`，但不让 Classic 页面加载 Next runtime；
- 记录缺失的 Windows、打包和人工 soak 证据。

退出条件：每页都有页面合同、静态门禁、Electron 证据和已知缺口说明。

### 阶段 7：跨平台和发布稳定性

状态：未开始。

工作：

- macOS/Windows 真实 Electron 深浅主题和窄窗口验证；
- 30–60 分钟人工操作 soak；
- packaged launch、资源闭包和签名环境验证；
- 任何平台差异归因到 Provider、主题或宿主，不用另一平台替代。

退出条件：发布证据完整，风险可解释，工作树干净。

### 阶段 8：后续页面和设计系统推广

状态：未开始。

只有六页达到稳定验收后，才评估其他业务页面。每次新增页面都必须先写页面合同，再选择迁移或保持 Classic；不能为了形式统一而重建低价值页面。

参考原则：页面视觉遵循 Cherry Studio 的中性、内容优先和语义 token；工程实现遵循 DeepSeek Harness 的 seam、显式 owner、可逆副作用、真实入口测试和证据优先。具体取舍见 [`ui-reference-research-cherry-deepseek.md`](./ui-reference-research-cherry-deepseek.md)。

## 3. 每个阶段的固定交付顺序

1. 记录事实、业务边界和页面合同；
2. 先改共享 token/结构，再改一个真实页面；
3. 用最小测试证明本次回归；
4. 做简化审查，删除无消费者的抽象和重复状态；
5. 补齐主题、窄窗口、键盘、异常和重复打开证据；
6. 更新本路线、当前状态和剩余风险；
7. 以小提交结束，不把多个轴线混在一起。

## 4. 提交顺序

推荐保持以下提交边界：

```text
docs(ui): define engineering charter and roadmap
style(app-surfaces): stabilize shared tokens and layout contract
style(translator): redesign translator surface
style(notes): redesign notes surface
style(plugin-manager): unify plugin states and cards
style(forum-memo-log): unify content surfaces
test(app-surfaces): add visual and layout regression coverage
docs(app-surfaces): record evidence and remaining risks
```

同步上游、修复门禁基线或处理宿主 bug 时单独提交，避免和页面视觉混合。

## 5. 明确非目标

本路线不包含：主聊天业务重写、消息内部重绘、IPC/数据协议变更、插件 Loader 改造、动态壁纸生命周期、全量 React/Vue 化、第二业务 Store、隐藏 DOM 点击代理，以及没有真实产品 owner 的公共组件扩张。

如果未来必须进入这些范围，必须新开路线、重新确认 owner 和验收证据，不能从本路线自然扩张。
