# UI 交互与可访问性缺口

> 这是 A0 事实基线，不是完成声明。每一项只有在生产代码、真实入口和行为测试同时更新后才能移到已解决。

## P0：先阻止错误终态

- 统一检查 Modal、Popover、Select 的 Escape 优先级，确保子对话框不会关闭其下方设置或应用 Surface。
- 为所有高频异步操作记录 loading、成功、失败、取消和 dispose 后迟到结果；重点是设置保存、创建助手/群组、Ask Nova、内嵌应用打开和聊天发送。
- 验证应用托盘、通知菜单、账户菜单和 Launchpad 的关闭后焦点恢复及隐藏内容不可聚焦。

## P1：交互合同

- 补齐图标按钮的动作级 `aria-label`、`aria-expanded`、`aria-pressed` 和 `aria-controls` 动态同步。
- 建立真实键盘路径：Tab、Enter/Space、Arrow、Home/End、Escape、ContextMenu/Shift+F10；测试必须从 Electron 真实页面进入。
- Select 代理与 native fallback 需要共享 value、change、required、multiple、reset、focus 和销毁终态。

## P2：视觉和平台证据

- 主题源与生成产物的一致性需要机器门禁；禁止主题层通过 `!important` 改写组件 owner 的结构语义。
- 为 reduced-motion、100/125/150% DPI、Windows/macOS、透明材质、字体加载和 Web Awesome fallback 建立可重复证据。
- 为主聊天启动首帧、快速滚动、设置、创建、托盘、Ask Nova 和内嵌 App 建立带主题/DPI/窗口元数据的视觉基线。

## 明确非目标

- 不重新引入 Classic/Next 双主窗口 presentation。
- 不改动态壁纸插件或前端插件 Loader 生命周期。
- 不把 Web Awesome、VCPUI 或本清单升级成业务状态 Store；清单是审计输入，不是运行时配置。
