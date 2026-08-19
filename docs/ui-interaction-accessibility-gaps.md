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

当前 A1 证据：`npm run guard:ui-interaction` 已接入 `check:ui-system`，验证清单中的生产入口、ARIA 控件目标和静态隐藏焦点内容；动态 App Tab 已支持 Arrow/Home/End，账户菜单已支持 roving focus，单元测试覆盖这些路径；真实 Electron 键盘矩阵仍需在后续交付证据中完成。

当前 A2 证据：`OverlayCoordinator` 的 modal lease 已记录 root/generation，旧 Surface 的迟到关闭事件不会释放重开后的新 lease；`tests/overlay-coordinator.test.js` 覆盖该故障注入。Select、创建、设置和 Ask Nova 的完整真实 Electron overlay 矩阵仍未完成。

当前 A3 证据：创建 Surface 已在生产代码中用 generation、dialog Scope 和 task ownership 拒绝关闭后的迟到结果；`tests/creation-controller.test.js` 已覆盖提交失败恢复和 dispose 后迟到成功不发布反馈。设置保存、Ask Nova、聊天流式和应用打开仍需补齐统一状态矩阵与真实 Electron 证据。

当前 A4 证据：`test:ui-motion-contract` 已接入 `check:ui-system`，检查高频 Surface 存在 reduced-motion 规则且不会保留非零动画时长；它不替代 Electron 的 reduced-motion、DPI、GPU 和 WA/native fallback 矩阵，后者仍是未完成证据。

当前 A3 状态矩阵：`scripts/ui-async-state-matrix.json` 和 `guard:ui-async-state` 已把创建、设置、Ask Nova、聊天流和内嵌应用统一要求为 idle/loading/success/failure/cancelled/late-result-after-dispose 六类终态，并绑定生产源文件和测试入口；门禁证明覆盖清单完整，不宣称每条终态的真实 Electron 证据已经完成。

## P2：视觉和平台证据

- 主题源与生成产物的一致性需要机器门禁；禁止主题层通过 `!important` 改写组件 owner 的结构语义。
- 为 reduced-motion、100/125/150% DPI、Windows/macOS、透明材质、字体加载和 Web Awesome fallback 建立可重复证据。
- 为主聊天启动首帧、快速滚动、设置、创建、托盘、Ask Nova 和内嵌 App 建立带主题/DPI/窗口元数据的视觉基线。

## 明确非目标

- 不重新引入 Classic/Next 双主窗口 presentation。
- 不改动态壁纸插件或前端插件 Loader 生命周期。
- 不把 Web Awesome、VCPUI 或本清单升级成业务状态 Store；清单是审计输入，不是运行时配置。
