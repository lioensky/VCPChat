# 设计系统上游 PR 架构收敛

> 状态：Classic/Next 功能对等整改中，完成本节门禁前不得重新提交上游审阅
> 基线：`upstream-review/main`
> 原则：只修复本设计分支新增或显著放大的问题，不借设计 PR 重构上游 Classic。

## 责任边界

审查结论必须先与 `upstream-review/main` 比较，再决定是否进入整改范围。

### 上游既有，不在本 PR 整改

- Classic 页面既有 DOM、事件、业务 CSS 和 IPC 组织方式。
- `trayManager` 原有的应用展示清单以及独立窗口启动流程。
- Classic 业务页面内部已有的事件代理或直接 DOM 操作。
- 与本次设计系统无关的服务端、Rust、Splash、AppData、选择助手和启动脚本行为。

设计分支不得为了“顺便优化”这些区域扩大 diff；从完整开发树带入的非设计改动应恢复为上游版本。

### 本分支引入，必须在 PR 前收敛

1. Translator 嵌入 URL 携带 `vcpApiKey` 的敏感信息泄漏。
2. 嵌入应用服务自行猜测 `settings.json` 路径，导致 packaged 路径与主进程权威路径不一致。
3. `topTabManager` 在 Classic 中仍初始化、恢复标签、注册全局监听并可能创建原生 `WebContentsView`。
4. Next 通过 `.click()` 驱动隐藏 Classic 控件，而不是调用共享 command。
5. Appearance Studio、全局设置、DOM dataset 和启动缓存缺少 revision/事务协调，旧预览可能覆盖新提交。
6. 设计分支新增了第二份内嵌应用 allowlist 和 descriptor switch，扩大了上游应用清单的多真源问题。
7. 业务页面直接识别 `wa-*`，使 Web Awesome 从 VCPUI 内核泄漏为业务 API。
8. Next CSS 的组件权威同时散落于兼容层和 `ui-system` 文件。
9. 未启用的实验性 Next 页面及其测试、截图和文档扩大了首个 PR 的维护面。
10. 完整开发树带入了与设计系统无关的主进程、Rust、服务端和业务修复。

## 产品范围

首个上游 PR 只交付：

- 主聊天 Classic/Next presentation；
- 主聊天设置、Appearance Studio、主题与动态壁纸；
- 空会话 VCPChat/Nova 视觉；
- 通用 Next 启动台和标签宿主；
- Notes 与 Translator 的 Next presentation；
- VCPUI、Web Awesome 离线 runtime、字体、图标和必要测试。

Memo、Forum、Log、Plugin Manager、Task、Human ToolBox、VchatManager、RAG Observer 等页面保留上游 Classic 文件，不在仓库中保留禁用的 Next 重建。

## 目标架构

```text
上游业务与 IPC
    ├── Classic presentation（保持上游基线）
    └── Next lifecycle（仅 Next 时 mount）
            ├── MainChatCommands
            ├── AppearanceCoordinator
            ├── AppTabHost + EmbeddedAppAllowlist
            └── VCPUI
                    └── Web Awesome / native fallback
```

### 生命周期

- 静态 Next DOM 可以随 `main.html` 交付，但 Classic 下不得运行 Next 控制器。
- `topTabManager.mount()` 只在进入 Next 后执行；`unmount()` 必须先隐藏原生 view，再等待关闭全部嵌入 session，随后完成 Observer、监听和过期异步任务清理。
- 权威设置加载、保存和 Appearance Studio 使用 `uiModeManager.applyAsync()`；切回 Classic 必须等待原生 view teardown，快速连续切换由 generation 收敛到最后一次请求。
- Notes/Translator 以“业务文档重载”作为 Classic/Next 的可逆边界：模式变化时使用更新后的 `uiMode` URL 重新载入原始页面，避免在同一 document 中逆向拼装已被移动的上游 DOM。
- 所有异步打开、恢复和 WA 加载都携带 generation；过期结果不得修改 DOM 或原生 view。

### 状态

- `settings.json` 是持久化权威；localStorage 只允许作为启动防闪缓存。
- Appearance 预览具有 revision；外部提交发生后，旧 snapshot 不得回滚新状态。
- 兼容 facade 和事件可以保留，但只能代理到协调器，不新增状态源。

### 应用与安全

- 上游 `trayManager` 继续负责名称、图标和独立窗口 action；本分支不复制完整产品 Catalog。
- `EmbeddedAppAllowlist` 只是主进程可信的内嵌 action/path 投影；renderer 只能用它标记可内嵌入口，主进程仍重新验证 action、路径和调用方。
- secret 不进入 URL、日志、sessionStorage 或 renderer 可枚举的应用 descriptor。
- Translator 继续通过上游既有 preload/IPC 获取设置，不在 URL、descriptor 或诊断信息中复制 secret。

### CSS 与组件

- `ui-next.css` 是主聊天 Next shell 的唯一结构权威，使用 `vcp-ui.next-shell` 层；组件样式由对应 `styles/ui-system/*` 文件负责。边界门禁禁止两侧出现完全相同的选择器，避免 cascade 权威再次分叉。
- 业务代码只调用 VCPUI controller；不得查询 `wa-*` 或读取 `--wa-*`。
- 首次 PR 不为禁用页面保留 CSS、runtime bootstrap 或实验测试。

## 实施顺序

1. 删除未启用页面的 Next 重建并同步测试、文档和 runtime allowlist。
2. 修复 Translator secret 传递和嵌入设置路径注入。
3. 将 Next 标签宿主改为显式 mount/unmount，并取消 Classic 启动副作用。
4. 建立最小共享 command，删除 Next 对 Classic 控件的 `.click()` 代理。
5. 为 Appearance 预览/提交增加 revision 协调。
6. 收敛本分支新增的应用 metadata、VCPUI 泄漏和 CSS 权威。
7. 恢复非设计文件到上游，清理行尾噪音并执行最终差异审计。

## 验收门禁

- Classic 启动不初始化 Next 标签宿主、不恢复 Next session、不创建嵌入 view、不加载 WA。
- Classic → Next → Classic 后无残留监听、Observer、原生 view 或未决恢复任务。
- Translator URL 不含服务器密钥；packaged 与 development 使用同一权威设置路径。
- Appearance 的旧预览不能覆盖更新 revision 的设置。
- 仅 Notes、Translator 和主聊天存在 Next 业务 presentation。
- 业务源代码不存在新增的 `wa-*` 依赖。
- 相对 `upstream-review/main` 的非设计文件差异为零；工作树行尾不制造无语义 diff。
- UI、Electron、vendor、ASAR 和设计减法门禁全部通过。

## 堆叠 PR 顺序

每个分支以前一个分支为 base；最终 `codex/design-system-upstream` 的文件树与收敛前验证通过的最终树一致。

1. `codex/design-vendor-assets`：离线字体、图像辅助资源和可复现 Web Awesome runtime。
2. `codex/design-foundation`：VCPUI、WA adapter、token、基础组件与隔离测试。
3. `codex/design-main-shell`：主聊天 Next Shell、侧栏、消息区与输入区视觉。
4. `codex/design-appearance`：Appearance Studio、主题、Nova 与动态壁纸体验。
5. `codex/design-app-tabs`：可信内嵌 allowlist、AppTabHost、Notes 与 Translator。
6. `codex/design-runtime-integration`：对最新上游主聊天业务 DOM、IPC 和设置生命周期的最小接线。
7. `codex/design-system-upstream`：边界门禁、Electron smoke、插件回归与开发文档。

## 2026-08-07 验证结果

- `npm run check:ui-system`：通过；页面门禁报告 `2 active rebuilt, 10 upstream classic`。
- `npm run pack:check`：通过；Web Awesome 3.11.0 离线闭包为 101 文件、0.46 MiB，生成结果可复现。
- `npm run test:electron-ui-apps`：20/20 通过；覆盖主 Shell、全局设置、Notes/Translator Next、上游 Classic 标签宿主和全局 Classic 回退。
- `node --test tests/frontend-plugins.test.js`：5/5 通过。
- Next/Classic 生命周期测试覆盖延迟关闭与快速回切：旧 teardown 完成前不会恢复新的原生 view。
- `git -c core.whitespace=cr-at-eol diff --check upstream-review/main -- ':(exclude)vendor/webawesome-runtime/**'`：通过；vendor 保持上游 npm 产物原字节。

## 2026-08-10 Classic / Next 对抗审查与整改目标

本轮审查只处理设计分支引入或放大的差异，不借机整改上游 Classic。核心目标是：Classic 必须保持最新上游的业务 DOM、行为和 computed style；Next 可以提供独立 presentation，但不得复制业务默认值、修改上游结构化消息语义或依赖隐藏的 Classic 控件。

### 已确认问题

1. `styles/appearance.css` 的字体、字号、内容宽度及外观 token 未限定 `data-ui-mode="next"`，导致切回 Classic 后仍保留 Next 外观参数。Classic 的上游 `15px` 基准字号会被覆盖为 `16px`。
2. Next 创建助手在 renderer 复制完整默认配置，绕过主进程的权威默认值；选择模型时可能与 Classic 创建出不同的上下文限制、主题标记和默认话题。
3. Next 聊天显示模式弹层依赖 `:focus-within`，Escape 把焦点恢复到同一容器后弹层仍保持可见。该问题已在真实 Electron 中复现。
4. Next 顶栏主题快捷按钮不随当前明暗状态更新图标和可访问名称，和 Classic 的状态反馈不一致。
5. 为规避旧 Next 覆盖而删除了上游结构化消息声明中的 `!important`，削弱了日记、工具、思考链等组件抵抗主题覆盖的能力。
6. Next 通知菜单只在异步 command 成功后关闭；command 抛错时可能留下展开菜单和未处理 rejection。
7. 现有对等测试偏重 DOM 存在和 command 调用，缺少 Classic computed style、弹层关闭、主题状态、创建默认值和最小窗口布局断言。
8. Appearance Engine 在 DOM 尚未就绪时安排的材质 SVG 挂载没有在回调执行时复核模式；启动阶段快速切回 Classic 可能让 Next 材质节点延迟泄漏到 Classic。

### 修复准则

- Appearance 的运行时视觉规则只允许在 `html[data-ui-mode="next"]` 下生效；Classic 不继承 Next 字体、字号、密度、圆角、材质或内容宽度。
- 助手默认配置只由主进程构造。renderer 只能传递受限 override，例如用户选择的模型；创建成功后的 UI 导航失败必须返回 warning，不得谎报“创建失败”并诱导重复创建。
- 弹层使用显式 open state、`aria-expanded`、Escape、外部点击和焦点恢复，不再以 `:focus-within` 作为状态真源。
- Classic 结构化消息样式与最新上游逐声明一致；Next 只控制普通消息外层排版。
- Next 快捷按钮必须同步当前状态，而不只是能触发 command。
- 异步菜单 action 无论成功或失败都必须完成菜单关闭和焦点恢复，并向用户反馈失败。
- 延迟挂载的 Next 视觉资源必须在执行时再次核对当前模式，不能只相信安排任务时的状态。

### 新增 PR 门禁

- Classic 下 `body` 的基准字号、字体和消息组件关键声明必须与上游一致。
- Next 聊天显示模式弹层必须通过点击打开，并可由 Escape、外部点击和选择操作关闭。
- 深浅主题切换后，Classic 与 Next 的快捷按钮名称和图标必须表达正确的下一步动作。
- Classic 创建和 Next 选择模型创建必须共享主进程默认配置构造器。
- command 成功但后续列表刷新或选中失败时，结果必须保留 `success: true` 并带 `navigationSuccess: false`。
- DOM 就绪前发生 Next → Classic 切换时，Classic 不得挂载 Next 材质 SVG 或其他延迟视觉资源。
- 900px 最小窗口、多个动态标签和通知栏展开组合必须完成截图与像素级无重叠检查。
