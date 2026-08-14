# 新版 UI Electron QA 矩阵

> 2026-08-14：业务子页面采用空 allowlist。笔记与翻译也已恢复上游 Classic 文件，首个 PR 不再携带任何业务子页面 Next 重建。参见 `docs/ui-active-surface-policy.md`。

本表只记录当前分支已经在真实 Electron 渲染器中执行过的检查。生成截图是本地诊断产物，不作为仓库内长期基线。

| Surface | Verified | Remaining |
| --- | --- | --- |
| Shell、侧栏、输入区 | 新版字体、Material Symbols、焦点、主题/聊天模式快捷入口、独立托盘最小化；经典模式输入圆角回归 | 最小窗口人工截图复查 |
| 内部应用 | UI 组件库打开后切到经典 UI，会清理 Host、标签、展示页根节点和 Feedback Host | 组件库长时间打开的内存采样 |
| Web Awesome 运行时 | 3.11.0 从锁定 npm 源包生成到 `vendor/webawesome-runtime`；启动时零 WA 请求/注册，打开「UI 组件库」后按需加载；`pack:check` 已验证 101 文件、0.46 MiB 的可复现闭包 | 后续版本升级时重跑闭包生成与 Electron smoke |
| Web Awesome 适配器 | `WebAwesomeAdapter` 契约测试全过（属性/事件/`updateComplete`/refcount 主题/销毁/next 守卫）；业务目录门禁 `check:ui-applications` 生效（禁 `<wa-*>`、裸 `--wa-*`、CDN、未登记 `::part()`）；新增 Lucide 边界门禁（业务页禁直引 lucide 运行时，仅 main.html / ToolBox 许可） | — |
| UiModeController | 契约测试全过（幂等 mount、query/持久设置读取、订阅/销毁）；主进程下发 `?uiMode=`，动态更新以保留嵌入参数的原文档 reload 跨越 presentation 边界 | — |
| 应用页面组件 | `AppPageShell` / `WindowControls` / `AsyncBoundary` 已进清单（candidate）+ 组件库展示 | 业务页面全面接入验收 |
| 全局设置 | 真实 Electron 验证：next 模式下 `#globalSettingsForm` 控件增强、保存栏 SettingsActionBar 脏/保存态、搜索注入、焦点、切经典清理 | 7 个分区逐项真实保存/错误/键盘 Escape |
| 业务弹窗 | 头像裁剪、创建群组、模型、转发、正则、筛选规则与编辑器均可首开，均为 8px 作用域外壳 | 实际规则编辑与提交 |
| 全局搜索 | Ctrl+F 首开、输入聚焦、Escape、模式切换清理、空态 | 带真实结果的分页和跳转 |
| Agent/Group 设置 | 真实 Agent 选择、设置页、折叠区段；新旧模式样式隔离 | 保存、删除、校验、真实 Group 数据 |
| 消息与富内容 | 壁纸透出；消息、代码、工具摘要、思考链、桌面推送、日记、表格；700px 表格不溢出 | 真实长流、错误、工具调用、媒体和最小窗口 |
| 通知与快捷入口 | 三点菜单拆分 Forum 与 Memo；过滤项保留开关/设置的左右键语义；清空保留工具审批；铃铛保留监控右键 | 深浅主题真实鼠标复查 |
| 页面运行时 | `test-page-runtime` 报告 `0 active rebuilt, 12 upstream classic`；Electron 验证通用 Classic 标签宿主及全局 Classic 回退 | 子页面未来必须独立迁移，不在本 PR 保存实验实现 |

### 当前逐页状态

| 页面 | 状态 | 备注 |
| --- | --- | --- |
| 翻译 | 上游 Classic 宿主 | 业务 HTML/JS/CSS 与 `origin/main` 一致 |
| 笔记 | 上游 Classic 宿主 | 业务 HTML/JS/CSS 与 `origin/main` 一致 |
| 便签、日志、插件、任务、记忆、论坛 | 上游 Classic 宿主通过 | 主界面处于 Next 时仍由通用标签宿主打开原始 Classic 文档；无 WA/Next shell |
| Canvas、RAG、Human ToolBox、VchatManager | 上游 Classic，非本 PR 验收面 | 业务文件由边界门禁验证与 `upstream-review/main` 一致 |
| 全局设置 | Next Electron 通过 | 增强、保存栏、搜索、焦点和 Classic 拆除 |

所有本地验证前后均运行：

```bash
npm run check:ui-system
git diff --check
```

组件或页面只有在对应剩余项全部完成，并有新的 Electron 截图审查证据时，才可将 `partial` 升为 `migrated`。
