# Classic / Next 功能对等历史清单

> 状态：历史双 presentation 验证记录。主窗口现已收敛为单一 presentation；当前事实与回归范围见 [`next-ui-current-state.md`](./next-ui-current-state.md)。

本清单保留当时上游 PR 前的人工与 Electron 验收证据，不再定义当前产品拓扑。

| 功能 | Classic | Next | 交互与状态 | 验证 |
| --- | --- | --- | --- | --- |
| 左侧栏模式 | 助手按钮右键切换窄栏、右键长按隐藏 | 左上角按钮单击切换窄栏、长按隐藏 | toast、`aria-pressed`、重启恢复 | Electron + 人工 |
| 通知侧栏 | 铃铛左键开关、右键监控 | 同一铃铛在聊天头与通知头之间移动 | `aria-expanded`、标题、激活态 | Electron + 人工 |
| 明暗主题 | 聊天头快捷按钮 | Next 顶栏快捷按钮 | 即时应用并持久化 | Electron + 人工 |
| 主题选择 | Classic 主题入口 | Next 顶栏调色板按钮 | 打开主题窗口 | Electron + 人工 |
| 聊天显示模式 | 标题栏气泡/统一/刊物 | Next 顶栏显示模式弹层 | 显式展开状态、方向键、Home/End、Escape、外部点击、焦点恢复、持久化 | Electron + 人工 |
| 最小化到托盘 | 独立标题栏按钮 | Next 独立窗口按钮 | 不得与普通最小化混淆 | Electron + 人工 |
| Forum / Memo | 通知头按钮左键/右键 | 三点菜单内拆分为 Forum、Memo 两项 | 单击对应项目，执行后关闭菜单并恢复焦点 | Electron + 人工 |
| 通知过滤 | 通知头按钮左键/右键 | 三点菜单过滤项左键/右键 | `aria-checked`、开启/关闭文字、保存失败回滚 | Electron + 人工 |
| 清空通知 | 通知头一键清空 | 三点菜单一键清空 | 保留工具审批通知 | Electron + 人工 |
| 应用托盘 | 右下角固定应用与更多抽屉 | 保持相同位置和应用能力 | 固定项持久化、抽屉、悬停、启动 | Electron + 人工 |
| 创建助手/群组 | Classic 创建按钮/群组弹窗 | Next 创建弹窗 | 共用创建 command、默认配置、加载、选中、进入设置 | Electron + 人工 |
| Ask Nova | 无对应入口 | Next 启动台模态对话 | 焦点、Escape、取消请求、不直接跳转 | Electron |
| 助手情绪 | 列表悬停播放 | 保持上游悬停语义 | 动画与文本均可见 | Electron + 人工 |
| 结构化消息 | 上游代码、引用、工具和日记样式 | 直接继承上游内部组件样式 | 左侧强调线、状态色、动画、复制与预览 | Electron + 人工 |
| Classic 外观隔离 | 上游字体、15px 基准字号、原内容宽度 | Appearance Profile 只在 Next 生效 | Classic computed style 不受 Next 预览或已保存配置污染 | Electron + computed style |
| 创建默认配置 | 主进程权威默认值 | 同一默认值，仅传模型 override | 创建成功与后续导航失败分开报告，避免重复创建 | IPC + Electron |
| 全局设置 | 上游 Classic 模态框 | Next SettingsShell | Classic 不挂载 VCPUI shell；两种模式均可选择布局 | Electron + computed style |
| 外观保存 | 完整表单保存 | Appearance Studio patch 保存 | 不重置未提交字段；本地应用失败时恢复磁盘快照 | IPC + Electron |
| 动态标签 | 不适用 | 标签打开、关闭、拖出、恢复 | 合法 tab 语义、键盘关闭、切换预览不销毁实例 | Electron |

## 第二轮整改状态

- Classic 全局设置已恢复上游 presentation，不再被 Next SettingsShell 接管。
- Appearance Studio 的部分保存、失败补偿和内存回滚已经覆盖自动测试。
- Classic 预览不会关闭内嵌应用；真正保存 Classic 后才执行 teardown。
- 最大化按钮和动态标签的状态、DOM 与键盘语义已经纳入契约测试。
- Web Awesome 干净 clone 所需 package metadata 已纳入版本控制边界。

## PR 门禁

- `npm run guard:classic-parity`：静态检查 Classic 共享控件、八个设置分类、输入区 SVG 和 Next CSS 作用域。
- `npm run test:electron-ui-apps`：以 `uiMode: classic` 启动主窗口，验证 Classic 标题栏、输入按钮、通知快捷按钮、全局设置导航和 Next runtime 隔离；再验证允许的 Notes/Translator Classic 页面。
- 深色和浅色模式分别检查所有可见入口。
- 在完整、头像窄栏、左栏隐藏和通知栏展开状态下重复检查。
- 对标记了左右键或长按的控件执行真实鼠标操作。
- 在最小窗口尺寸检查顶栏按钮、通知菜单和应用托盘不溢出。
- 自动测试通过后仍需完成一次真实 Electron 人工检查。
