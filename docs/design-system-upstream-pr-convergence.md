# 设计系统上游 PR 架构收敛

> 状态：历史 PR 审查与整改日志，不代表当前实现或 PR 就绪度。当前判断见 [`next-ui-current-state.md`](./next-ui-current-state.md)，后续路线见 [`next-ui-development-roadmap.md`](./next-ui-development-roadmap.md)。
>
> 历史状态：Classic/Next 功能对等整改已完成；本节门禁曾作为后续重构与上游 PR 的回归基线。
> 上游基线：`origin/main`
> 减法源快照：`a1f76dffea8105999e465da45d8e52558cd80c47`
> 原则：只修复本设计分支新增或显著放大的问题，不借设计 PR 重构上游 Classic。

默认策略：首次启动、缺失 `uiMode` 或设置读取失败时进入 Classic。Next 是用户主动选择并保存的可选布局；已经保存为 Next 的用户保持原偏好。

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
- 主聊天设置、Appearance Studio 与主题；
- 空会话 VCPChat/Nova 视觉；
- 通用 Next 启动台和标签宿主；
- 通用标签宿主；业务子页面（包括 Notes 与 Translator）保持 Classic；
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
- 通用标签宿主固定以 `uiMode=classic` 打开业务子页面；主界面选择 Next 不改变子页面 presentation。
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
- 仅主聊天和全局设置存在 Next presentation；业务子页面保持上游 Classic。
- 业务源代码不存在新增的 `wa-*` 依赖。
- 相对 `upstream-review/main` 的非设计文件差异为零；工作树行尾不制造无语义 diff。
- UI、Electron、vendor、ASAR 和设计减法门禁全部通过。

## 堆叠 PR 顺序

每个分支以前一个分支为 base；最终 `codex/design-system-upstream` 的文件树与收敛前验证通过的最终树一致。

1. `codex/design-vendor-assets`：离线字体、图像辅助资源和可复现 Web Awesome runtime。
2. `codex/design-foundation`：VCPUI、WA adapter、token、基础组件与隔离测试。
3. `codex/design-main-shell`：主聊天 Next Shell、侧栏、消息区与输入区视觉。
4. `codex/design-appearance`：Appearance Studio、主题与 Nova 体验。
5. `codex/design-app-tabs`：可信内嵌 allowlist 与 AppTabHost；业务子页面保持 Classic。
6. `codex/design-runtime-integration`：对最新上游主聊天业务 DOM、IPC 和设置生命周期的最小接线。
7. `codex/design-system-upstream`：边界门禁、Electron smoke、插件回归与开发文档。

## 2026-08-07 验证结果

- `npm run check:ui-system`：需通过；页面门禁报告 `0 active rebuilt, 12 upstream classic`。
- `npm run pack:check`：通过；Web Awesome 3.11.0 离线闭包为 101 文件、0.46 MiB，生成结果可复现。
- `npm run test:electron-ui-apps`：需覆盖主 Shell、全局设置、全部上游 Classic 子页面标签宿主和全局 Classic 回退。
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

## 2026-08-10 第二轮对抗审查：PR 阻塞项

以下问题均由设计分支新增的入口、运行时或资源布局引入，不归入上游既有技术债。在全部关闭前，分支不得重新提交上游 PR。

1. vendored Web Awesome 的 `package.json` 被上游通用 ignore 规则吞掉，导致干净 clone 和打包门禁失败。
2. Appearance Studio 使用部分对象调用通用 `save-settings`，触发 IPC 对缺失字段补默认值，可能重置续写延迟和分布式日志开关。
3. 布局预览真实切换 UI mode，离开 Next 时会关闭内嵌 WebContentsView，只恢复标签 ID，无法保证未保存页面状态。
4. 全局设置在 Classic 下仍被强制重建为 Next SettingsShell，违反 Classic 上游基线约束。
5. Appearance Studio 先持久化再应用本地状态；后续应用失败时只回滚界面，磁盘与当前界面可能分叉。
6. Next 最大化按钮没有同步最大化/还原图标、标题和无障碍状态。
7. Next 动态标签关闭按钮使用嵌套交互元素，缺少有效键盘关闭路径和 tab 语义。

### 修复策略

- `save-settings` 明确支持 patch 语义：只规范调用方实际传入的字段，不为缺失字段写默认值。完整全局设置表单继续提交完整对象。
- Appearance Studio 的保存必须成为可恢复事务；持久化成功后若本地应用失败，要把原持久化字段写回磁盘。
- UI mode 预览不得销毁内嵌应用。预览只切换 presentation，持久化提交或明确离开 Next 时才允许执行原生 view teardown。
- Classic 全局设置只保留上游 DOM 与样式；布局切换字段仍可存在，但 VCPUI SettingsShell 仅在 Next 挂载。
- 所有新 vendor 文件必须能从 `git archive HEAD` 重建并通过离线资源门禁。
- 窗口按钮和动态标签必须具备状态同步、合法 DOM 语义和完整键盘路径。

### 新增验收门禁

- 从 `git archive HEAD` 解包后运行 Web Awesome pack check 必须通过。
- 用部分外观 patch 保存时，未包含的设置字段逐项保持原值。
- Appearance Studio 预览 Classic 后取消，已打开的内嵌页面实例和未保存状态保持不变。
- Classic 打开全局设置时不得出现 `.vcp-ui-settings-shell`、Web Awesome proxy 或 `vcp-global-settings-next`。
- 模拟“磁盘保存成功、本地应用失败”时，磁盘设置必须恢复到保存前快照。
- 最大化/还原状态和动态标签关闭操作必须通过鼠标与键盘测试。

### 2026-08-10 整改结果

上述七项阻塞问题均已关闭：

1. `.gitignore` 明确放行 `vendor/webawesome-runtime/package.json`；模拟干净归档补入该文件后离线 pack check 通过。
2. `save-settings` 已改为真正的 patch 语义，缺失的续写延迟和分布式日志字段不会被补默认值。
3. Next → Classic 的外观预览只隐藏原生 view，不关闭 WebContentsView 或销毁标签；返回 Next 时复用原实例。
4. Classic 全局设置不挂载 SettingsShell、VCPUI proxy 或 Next host class，teardown 后重新绑定上游导航。
5. Appearance Studio 保存失败会同时补偿回写磁盘与 `window.globalSettings`，随后恢复界面快照，避免三份状态分叉。
6. Next 最大化按钮订阅真实窗口状态，切换最大化/还原图标、名称和 `aria-pressed`。
7. 动态标签使用 `div[role=tab]`、roving tabindex 和原生关闭按钮；Enter/Space 可激活标签，不再嵌套交互元素。

最新上游已刷新至 `b735b3ff`。新增的 8 个提交仅涉及 Scriptorium 的 14 个文件，与设计系统整改没有重叠；当前工作文件树已接收这些文件，后续提交时应单独整理为上游同步提交。

验证结果：

- 设计系统测试链、Appearance、UI mode、标签生命周期和 Web Awesome adapter 全部通过。
- `npm run test:electron-ui-apps`：20/20 通过。
- `node --test tests/frontend-plugins.test.js`：6/6 通过。
- `npm run pack:check` 及模拟干净归档的 Web Awesome pack check 通过。
- 完整 subtraction guard 仅被用户本地、明确不纳入本轮的 `styles/themes.css` 修改阻塞；排除该用户文件后没有其他设计边界失败。
- 最新上游自身的 Scriptorium CDN 本地化冒烟仍超时，`tests/test-export-inline.cjs` 也可在与上游相同字节的测试及 `vendor/three.min.js` 上复现失败。二者属于上游基线，不计入本 PR 引入问题。

## 2026-08-12 上游同步与 PR 门禁复验

- 已合并 `origin/main` `856c1db0`；相对最新上游为 `0 behind`，合并仅产生 `.gitignore` 一处文本冲突，双方规则均已保留。
- `package-lock.json` 已补齐 `encoding@0.1.13`；独立临时目录执行 `npm ci --ignore-scripts --no-audit --no-fund` 成功安装 962 个包。
- `vendor/webawesome-runtime/**` 通过 `.gitattributes` 固定为原始字节，避免 Windows 行尾转换破坏 manifest 哈希。
- `npm run pack:check` 通过；从 `git archive HEAD vendor/webawesome-runtime` 解包后，manifest 中 101 个文件的 SHA-256 全部匹配。
- subtraction guard 固定使用 Agent 减法源快照 `a1f76dffea8105999e465da45d8e52558cd80c47`，上游基线使用 `origin/main`；中文路径不再被 Git quote 转义误判，差异检查由逐文件子进程改为集合比较。
- `npm run check:ui-system` 通过。
- `npm run test:electron-ui-apps`：20/20 通过。
- `node --test tests/frontend-plugins.test.js`：6/6 通过。
- 最终 PR 三点 diff 为 342 个文件：109 个设计资产、102 个 Web Awesome vendor 文件，其余为 UI 源码、样式、测试、文档和窄 preload/IPC 集成。未发现 Agent/Codex/Rust runtime、生成截图、数据库、日志、原生二进制或构建目录。

## 2026-08-14 Next UI 稳定性根治

Next 后续完整阶段与合并门槛见 [`next-ui-development-roadmap.md`](./next-ui-development-roadmap.md)；动态资源所有权、可撤销 Registry、串行模式切换、资源归零门禁及 2026-08-15 对抗审查结论见 [`next-ui-lifecycle-architecture.md`](./next-ui-lifecycle-architecture.md)。

作者在真实操作中报告了 Ask Nova 白屏/重开卡死、内嵌便签按 Escape 级联关闭主窗口、Agent 设置后进程数上涨，以及窄通知栏 Dock 文字挤压图标。四项现象共享两个底层问题：原生 `WebContentsView` 与 renderer DOM 没有统一的可见性所有权；内嵌页面仍沿用独立 `BrowserWindow` 的关闭语义。

### 根因与不变量

- `WebContentsView` 始终绘制在 renderer DOM 之上。启动台或模态窗即使具有更高 `z-index`，也无法覆盖尚未由主进程隐藏的子视图。所有 DOM 覆盖层必须先取得 overlay lease，等待活动子视图隐藏后才能显示，最后一个 lease 释放后才允许恢复子视图。
- `BrowserWindow.fromWebContents()` 可能把子视图解析到其 owner。内嵌页面不得发送通用 `close-window`；它只能请求关闭自己的 session。通用窗口控制同时校验 `event.sender === win.webContents`，作为纵深防御。
- `webContents.close()` 只发起异步销毁。Session 不能在 `destroyed` 前被视为可重新创建；同一 action 的新建必须等待旧 close promise 完成，防止快速开关累积 renderer 进程。
- Ask Nova 使用 VCPUI 的确定性原生 DOM Modal。复杂、带取消 IPC 的应用模态窗不参与 Web Awesome custom-element upgrade 和 hide animation，避免关闭/换目标重开时出现两个异步 dialog 生命周期。
- Agent 设置初始化必须幂等，订阅和 PromptManager 在 page lifecycle 结束时释放。设置页本身不创建 WebContents；压力测试必须把设置 DOM/adapter 计数与内嵌 app 进程计数分开测量。
- 通知栏宽度不超过 280px 时，固定 Dock 是纯图标栏。文字强制隐藏，按钮取消胶囊 padding/gap，SVG 保持 18px 不收缩。该规则与旧胶囊 `!important` 声明放在同一 cascade layer，避免层叠反转。

### 回归门禁

- Ask Nova：关闭一个进行中的目标后立即打开另一目标，只允许存在一个 modal host；旧请求取消不能污染新请求。
- 内嵌便签：连续五次打开并按 Escape，每次只销毁对应 WebContents/标签，主窗口持续存在。
- 进程生命周期：同一内嵌 action 必须等待前一 session 的 `destroyed`；退出 Next 时等待所有 close promise。
- Agent 设置：连续十二次 Agent/设置页往返，Browser target 数、VCPUI adapter 数及提示词 DOM 不增长。
- 窄 Dock：240px 通知栏中固定应用文字不可见、四个图标均保持可见且按钮无横向溢出。

### 2026-08-15 生命周期第二轮对抗审查

本轮审查只覆盖 Next 主窗口、通用内嵌应用、模态层和主 renderer。

- 内嵌会话以主进程为权威。renderer reload 或 crash 时先隐藏而不销毁 `WebContentsView`；新 renderer 通过 `embedded-vchat-app:list` 对账标签、活动 action 和已有 session，禁止遗留一个“无标签但仍覆盖窗口”的原生页面。
- 主 renderer 非正常退出后自动恢复，但使用有界策略：60 秒内最多三次，成功运行 30 秒后清零；超过阈值停止 reload loop，并由原生错误框让用户选择重试或退出。
- 所有 renderer DOM 覆盖层使用 owner lease。全局设置、创建助手、Appearance Studio、Ask Nova 和应用托盘设置只有在原生内嵌页隐藏后才展示；多个覆盖层并存时，只有最后一个 owner 释放才恢复内嵌页。
- Appearance Studio 的未保存确认属于同一个 owner。第一次 Escape 只能打开确认层，不能恢复底层 WebContentsView；回滚异常也通过 `finally` 释放 owner，避免页面永久隐藏。
- 新覆盖层出现时先收起通知三点菜单和账户菜单，避免一个 Escape 同时落到多个 surface。应用托盘抽屉取消延迟绑定时同步取消 timer，避免残留 document click listener。
- 标签恢复期间禁止逐个激活原生 view，待 renderer 完成全部对账后只激活最终选中的 action，避免隐藏标签在启动/reload 时短暂闪到前台。
- 内嵌 session 在 renderer 已 crash 时不再发送状态 IPC；状态保留在主进程，待新 renderer 主动读取，避免恢复期间的二次异常。

自动化现在真实执行：便签拖出独立窗口与 Escape、renderer reload、CDP `Page.crash`、内嵌页上依次打开托盘设置/全局设置/Appearance、未保存确认的 Escape 所有权、Ask Nova 请求取消、Classic ↔ Next 往返及 Agent 设置 DOM/adapter 计数。20 个完整循环后 heap、listener、page、process 和 renderer process 均保持在允许范围内。

后续 detached DOM 专项诊断把长压测中的线性增长定位到全局设置图标规范化：恢复记录保存了已经被 Lucide adapter 替换掉的临时 `<span class="vcp-ui-icon">`。该字段不参与恢复，却让每次 Classic → Next 往返多保留三个 span 及其属性节点。恢复记录现只持有容器和上游原始 SVG；压力门禁单独统计 `detachedVcpIcons` 并要求不得高于预热基线。原始设置导航节点是 Classic 可逆恢复所需的固定快照；Ask Nova 首次加载产生的单个 `<template>` 在对照采样中保持固定，不属于线性泄漏。

进一步 Classic/Next 对照发现 Agent 设置的两个 TTS Select 也曾被 document-wide `VCPUI.observeControls()` 越权捕获。该页面明确声明 `data-settings-presentation="classic"`，本应由上游原生 DOM 独占；全局 observer 现在排除 Agent、Group 和全局设置表单。TTS 模型列表同时改为结构相同时只更新 `select.value`，不再无条件重建相同 options。Classic 连续三轮保持零 controller，Next 压测也保持 `detachedOptions` 为零；门禁现同时禁止 detached VCP icon 与 Select option 高于预热基线。
