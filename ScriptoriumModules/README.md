# VCP Scriptorium · 共笔文坊

> Alpha 原型：以 HTML、CSS 与受控 JavaScript 为共同语言的人机协作文档工作台。

Scriptorium 是 VCPChat 内置的本地富文档与演示创作空间。它同时面向人类作者和 VCP Agent：人类可以直接编辑渲染后的文字与版式，Agent 可以读取文档语义、源码和视觉上下文，并通过可审阅的 PR 修改文档。

它不是 DOCX/PPTX 的原位 OOXML 编辑器。Scriptorium 使用自己的 VDOC 工程模型：

- **VDOCX**：连续流文稿工程，扩展名为 `.vdocx`。
- **VPPTX**：逐页演示工程，扩展名为 `.vpptx`。
- 原生 `.docx`、`.pptx` 是导入源；导入后应保存为对应的 VDOC 工程。
- VDOCX / VPPTX 是 VCP 自有 ZIP 容器，不是 OOXML，也不再接受旧式裸 JSON 工程。
- 容器根目录的 `document.json` 保存文档模型与资源清单；`resources/media/` 和 `resources/fonts/` 分别保存媒体与字体二进制。
- 内部资源使用 SHA-256 内容寻址和去重，源码只保存 `vdoc-resource://media/<sha256>` 或 `vdoc-resource://fonts/<sha256>` 短引用。

> A document is a place, not a file.  
> 文档不是一个文件，而是人类与协作者共同抵达的地方。

## Alpha 已经能做什么

### 文稿与演示

- 新建、打开、保存和另存 VDOCX / VPPTX 工程。
- 连续流文稿编辑与分页阅读预览。
- 演示页面新增、删除、切换、静态缩略图和放映预览。
- HTML 与 CSS 源码编辑、格式化、诊断和即时应用。
- 字体、字号、粗体、斜体、下划线、删除线、文字颜色、高亮、行距和对齐。
- 跨文本块选择、全文选择和右键快捷格式栏。
- 插入段落、标题、引文、3 × 3 表格以及参数化 SVG 图形。
- 图片、视频、音频和 SVG 图形使用统一视觉对象协议。
- VDOCX 对象支持独占、左侧文字环绕、右侧文字环绕及段落锚点拖放。
- VPPTX 对象支持自由坐标拖拽、方向键微调和置顶/置底/逐层调整。
- 选中对象后可拖动四角手柄调整尺寸；按住 Shift 可保持原始宽高比。
- 右键对象可打开属性检查器，事务式编辑名称、描述、尺寸、旋转和 SVG 外观。
- 图形可直接编辑独立 SVG 源码；所有视觉对象均可附加限定在本对象内的 CSS，并在隔离 iframe 中实时预览。
- 标题目录、段落索引、字数与字符数统计。
- VDOCX 纯文专注模式：正文扩展至整个窗口，仅保留低存在感的文档名与返回控制；VPPTX 不显示该入口。
- 50%–200% 缩放，以及 Ctrl/Command + 滚轮指针中心缩放。
- 高级样式库、隔离预览、样式包导入导出和工程内嵌样式。
- KaTeX 数学节点渲染。
- 最多 80 个窗口内撤销历史快照；连续输入按约 2 秒合并为一轮历史操作。

### 导入与导出

可导入：

- HTML / HTM
- Markdown
- TXT
- RTF
- DOCX（语义导入）
- PPTX（静态版式导入）

可导出：

- VDOCX 文稿：连续流 HTML、分页 HTML、PDF。
- VPPTX 演示：单文件可播放 HTML、逐页 PDF。
- 演示 HTML 支持键盘翻页、底部控制条、全屏和页面内交互脚本。
- VDOCX 与 VPPTX 导出 HTML 时，会统一尝试将 `file:` 和普通 HTTP 图片、音频转换为 `data:`，提高单文件跨平台播放能力；HTTPS 公网资源与视频保持原链接。
- 受支持的 Anime.js / Three.js 依赖会在导出时嵌入单文件 HTML。

导入是面向 Scriptorium 模型的转换，不保证对原生 Office 文件进行像素级或可逆还原。DOCX 会提取正文语义、标题和显式分页信息；PPTX 以静态页面结构进入 VPPTX。

### 文脉与版本

文脉已经是工程数据，而不是 UI 占位：

- 人类可以创建带名称和备注的刻点。
- 刻点包含操作元数据、源码状态、changeSet 和工程内嵌版本快照。
- Agent PR 会以 pending、applied、rejected、conflict 或 failed 状态进入同一条文脉。
- 每次审批都可填写回执，并记录审阅者、时间和是否自动批准。
- 可查看文脉节点的记录、变更内容与审批信息。
- 可回溯到带快照的历史节点。
- 回溯前会自动保存当前版本，且不会删除后续文脉。

## 核心设计：源码是唯一真相

Scriptorium 不把实时渲染 DOM 当作文档存储。

### VDOCX

一份 VDOCX 以 Markdown-first 混合 Source Buffer 作为唯一正文真源。它可以同时包含：

- Markdown 标题、段落、列表、引文与表格
- 行内 HTML 与稳定 HTML island
- LaTeX 与 Mermaid 原文
- 可编程内容及其依赖声明
- 独立的文档级 `documentCss`

### VPPTX

一份 VPPTX 包含：

- 一份演示共享 `deckCss`
- 多个 slide
- 每个 slide 只有一个完整 source，其中可包含页面 `<style>`、HTML、依赖声明和内联 `<script>`
- 页面名称、转场、时长、备注与资源元数据

### 为什么不序列化渲染树

可编程页面会在运行时创建 Canvas、SVG、控制节点，或持续修改 class、style 和 data 属性。若把渲染树整体写回工程，这些瞬态状态会污染源码并在每次重渲染时重复累积。

因此人类在渲染面进行的修改使用定向写入：

1. 每个可编辑文本块拥有稳定的 `data-vdoc-text` 标识。
2. 文本编辑只更新该标识对应节点的内部语义 HTML。
3. 块级格式只同步明确允许的属性。
4. 新增和删除结构块只修改对应源码锚点。
5. 视觉对象使用稳定的 `data-vdoc-object-id` 定位；拖拽、环绕、图层和属性检查器只更新该对象。
6. 未被显式编辑的源码节点保持原样。

视觉对象采用统一语义：

- `data-vdoc-object` 表示 shape、image、video、audio 或 media-group。
- `data-vdoc-object-id` 是定向编辑所需的稳定身份。
- `data-vdoc-object-layout` 在 VDOCX 中表示 block、float-left 或 float-right，在 VPPTX 中表示 free。
- 参数化图形保留 `data-vdoc-shape-*` 高层参数，并同时保存可独立导出的标准 SVG。
- 自定义 SVG 必须使用单一 `<svg>` 根；检查器会校验 XML，并移除脚本、事件属性、独立执行宿主和危险外部引用。
- 对象附加 CSS 的原始内容保存在对象直属 `<style data-vdoc-object-style>` 中，运行规则会自动增加当前 `data-vdoc-object-id` 作用域；`:object` 可显式表示对象外壳。
- 对象 CSS 当前只接受普通选择器规则，不接受 `@import`、媒体查询、容器查询、关键帧或其他 `@` 规则。
- 编辑器选择框、缩放手柄、拖拽状态和落点提示只存在于编辑 ShadowRoot，不进入源码或导出文件。

Agent 也不直接操作实时 DOM，而是读取和修改同一份完整源码。

## 四个工作面

### 连续编辑

人类直接编辑渲染结果。VDOCX 使用连续流画布；VPPTX 使用当前页面画布。页面内脚本产生的运行时 DOM 不会被误写回工程。

VDOCX 可从右上角进入纯文专注模式。进入时会自动切回连续编辑工作面，并隐藏标题栏、格式工具、篇章、文脉、状态栏、工作区外框和环境装饰，让正文占据完整窗口。界面只保留右上角一个默认弱化的“文档名 + 返回”浮层；悬停或聚焦时才增强显示。点击“返回”或按 `Esc` 可退出。VPPTX 不提供专注模式入口；切换或载入演示工程时也会自动结束已有专注状态。

### 阅读 / 放映预览

VDOCX 通过本地分页器生成纸页预览；VPPTX 生成逐页放映预览。离开视口的页面会暂停动画和媒体，以降低长文档资源占用。

### HTML 源码

使用 CodeMirror 编辑当前完整源码。演示中该工作面始终对应当前页，切页前会先提交旧页缓冲区。

### CSS 源码

VDOCX 编辑文档全局 CSS；VPPTX 编辑整套演示共享的 `deckCss`。单页样式仍位于该页完整 HTML source 中。

## 人机协作工作流

ScriptoriumCollaborator 是 VCP 分布式服务器中的 hybrid service。它通过 Electron 主进程控制服务与当前 Scriptorium 窗口通信，Agent 不直接获得文件系统或渲染进程权限。

推荐流程：

1. Agent 调用 **GetDocumentInfo** 获取文档类型、当前修订和页面状态。
2. 使用 **GetOutline**、**GetRenderedText**、**GetSource**、**SearchSource** 或 **GetViewportSource** 定位内容。
3. 需要检查视觉结果时调用 **GetVisualContext** 获取语义摘要和真实截图。
4. Agent 使用 `maid` 署名、`summary` 摘要、`requestId` 幂等键和建议的 `expectedRevision` 提交 PR。
5. 提案进入右侧文脉，人类查看局部渲染差异、局部源码差异与安全诊断。
6. 人类允许或拒绝，并可填写回执。
7. 允许后才执行变更、增加修订、生成 changeSet 和版本快照并保存工程。
8. Agent 获得审批结果；等待超过 5 分钟时返回 `PR_RECEIPT_TIMEOUT`，但提案仍保留在文脉中。

### 自动允许策略

自动允许只能由人类在 Scriptorium UI 中启用，并按操作类型单独勾选。Agent 无法通过工具参数开启它。

当前 UI 可配置的类型包括：

- 源码替换
- 新增末页
- 插入页面
- 删除页面

命中 refuse 级安全规则的提案永远不会自动批准，必须由人类打开审阅后手动决定。

## ScriptoriumCollaborator 命令

插件定义位于 [`plugin-manifest.json`](../VCPDistributedServer/Plugin/ScriptoriumCollaborator/plugin-manifest.json)，服务实现位于 [`ScriptoriumCollaboratorService.js`](../VCPDistributedServer/Plugin/ScriptoriumCollaborator/ScriptoriumCollaboratorService.js)。

| 命令 | 用途 | 写操作 |
| --- | --- | --- |
| ListFonts | 按 all、zh-CN 或 en 列出真实系统字体 | 否 |
| GetDocumentInfo | 获取类型、标题、修订、保存状态和 scene | 否 |
| GetRenderedText | 获取文稿全文或演示页面的纯文本语义 | 否 |
| GetOutline | 获取文稿标题目录或演示页面目录 | 否 |
| GetSection | 按 ID 或索引读取 VDOCX 章节 | 否 |
| GetSource | 按行读取完整 HTML source 或 deck-css | 否 |
| SearchSource | 普通字符串或正则源码检索 | 否 |
| GetViewportSource | 获取当前可见文本块附近的源码 | 否 |
| GetVisualContext | 返回语义摘要和 JPEG/PNG 截图 | 否 |
| GetPrHistory | 查询刻点、PR、状态和审批回执 | 否 |
| SubmitSourcePr | 提交 target/replace 源码替换 PR | 是 |
| AddSlide | 向 VPPTX 末尾提交完整页面 PR | 是 |
| InsertSlide | 向 VPPTX 指定位置提交完整页面 PR | 是 |
| DeleteSlide | 提交删除页面 PR | 是 |
| UpdatePresentationConfig | 提交画布、宽高比、主题和转场配置 PR | 是 |
| CreateProject | 规范化并直接落盘完整 VDOCX / VPPTX | 直接创建文件 |
| GetStorageInfo | 查询 Agent 工程落盘目录与冲突策略 | 否 |

完整参数和 VCP 工具调用示例以插件清单为准。

### 字体发现与使用约定

Scriptorium 不要求 Agent 通过专用“字体管理”命令应用系统字体。字体名称是 CSS 源码的一部分，推荐流程如下：

1. Agent 先调用 **ListFonts**，按 `all`、`zh-CN` 或 `en` 查询当前机器真实安装的字体。
2. 将返回的准确字体族名称直接写入完整源码的 `font-family`，并提供合适的回退字体栈。
3. 系统字体不需要 `@font-face`、资源 ID或额外的应用命令；只要当前机器已安装，编辑、预览与导出渲染即可直接使用。
4. 不应凭空猜测字体名称。需要指定字体时应优先查询 **ListFonts**，避免 CSS 因字体不存在而静默回退。
5. 系统字体不具备跨机器可移植性。若需要在其他设备保持同一字形，应使用 `@font-face` 引用明确的字体文件 URL。
6. 外部字体 URL默认保留原样；用户勾选“收纳外链”并保存后，可确认的字体文件会进入 ZIP 的 `resources/fonts/`，CSS URL会替换为 `vdoc-resource://fonts/<sha256>` 短引用。
7. Agent 只需操作字体名称和 CSS 引用，不读取或输出字体二进制、blob URL或 base64。

例如，**ListFonts** 返回 `Microsoft YaHei` 后，Agent 可以在文档级样式、演示共享 `deckCss` 或单页 `<style>` 中使用 `font-family: "Microsoft YaHei", sans-serif`。若需要嵌入外部字体，则在源码中声明 `@font-face`，再由保存侧按用户选择决定是否收纳。

### 串行调用

插件支持 VCP 编号串行参数：`command1`、`command2`、`command3`……，并严格按编号执行。

- 未编号字段作为所有步骤的公共参数。
- 支持 wait、sleep、delay 步骤。
- 等待默认 1000 ms，最大 30000 ms。
- 任一步失败后停止后续步骤。
- 响应仍保留此前成功步骤的完整文本与图片回执。
- 多页视觉采集会等待切页、字体、图片和合成帧稳定后截图。

### 直接创建工程

**CreateProject** 不修改当前窗口模型，也不进入当前窗口 PR 审批。它会让 Scriptorium 内核先完成规范化和可编程内容审查，再原子写入：

- `AppData/ScriptoriumDocument/VDOCX`
- `AppData/ScriptoriumDocument/VPPTX`

默认重名策略为 rename。overwrite 必须同时提供目标文件当前的 SHA-256 `expectedFileHash`，否则拒绝覆盖。`openAfterCreate` 只请求打开新工程；若窗口中有未保存内容，最终切换仍由人类决定。

## AI 可理解的原生多媒体

VDOCX 与 VPPTX 的完整 HTML 源码可以原生引用图片、视频、音频及其他 Web 多媒体内容。媒体节点、来源、内容语义和时间信息共同保留在文档真相中，使人类与 Agent 看到同一份可阅读、可编辑、可追踪的多媒体上下文。

- 人类点击“插入媒体”后进入应用内模态窗，可以输入单个 `src`，也可以多选本地文件并为每项填写独立的 `description`。
- 人类或 AI 输入的原始 `description` 同时写入媒体节点及其语义容器；`data-vdoc-description` 补充媒体类型、原生分辨率和时长等技术信息。
- 图片和视频记录原生宽高；音频和视频记录机器可读秒数及格式化原生时长。Agent 可据此设计版式、转场、字幕、动画和交互时间轴。
- 本地文件会直接注册到 ZIP 的 `resources/media/`，HTML 源码只保存 `vdoc-resource://media/<sha256>`，不会出现媒体 base64。
- 外部 `file:`、VCP HTTP 和公网 HTTPS URL 默认保持原样。勾选工具栏“收纳外链”后，保存事务才尝试将可确认的媒体和字体收纳进工程。
- 网络资源是否可收纳由响应 MIME、`Content-Disposition`、扩展名和文件头共同判定。HTML 网页、登录页、`application/octet-stream` 及其他无法确认类型的响应不收纳，继续作为通用 URL 保留。
- 普通 `<a href>` 超链接不参与资源扫描；保存收纳逻辑只处理媒体 `src` 与 `@font-face` 字体 URL。
- 编辑和预览期间，内部短引用映射为生命周期受控的 `blob:` URL；导出单文件 HTML/PDF 时，只在导出副本中转换为 `data:` URL，不会污染工程源码。
- 在此之后，VDOCX 与 VPPTX 共用的 HTML 导出适配层还会扫描图片 `src` / `srcset`、`picture source`、SVG `image`、视频封面及音频源，将尚未收纳的 `file:` 和普通 HTTP 图片、音频临时内联为 `data:`。
- HTTPS 被视为公网资源并保持原链接；视频文件不进行 Base64 内联。无法读取、类型不匹配或超过内联体积上限的资源也保留原 URL，并在导出结果中汇总提示。
- Agent 只读取原始 URL或内部短引用，以及资源名称、MIME、大小、描述、原生尺寸和时长等结构化元数据，不读取 ZIP 二进制或 base64。
- Agent 通过超栈追踪管线嵌入或修改媒体时，也应填写同一套 `description` 与媒体源信息字段，供后续内容、视觉、动画和审阅 Agent 延续理解。

这使 VCP 原生文档中的媒体不仅能够播放，还能被人类描述、被 Agent 理解、被超栈追踪、被文脉审阅，并持续参与动画与交互编排。

## 可编程内容

VDOCX 文档和 VPPTX 页面可以携带 CSS 动画及内联 JavaScript。运行时提供受跟踪的：

- requestAnimationFrame / cancelAnimationFrame
- setTimeout / clearTimeout
- setInterval / clearInterval
- `runtime.addCleanup()`
- 当前文档岛或页面范围内的 scoped document 查询

切页、重渲染或关闭文档时，Scriptorium 会停止已跟踪的帧、定时器和 interval，并逆序执行清理函数。

受支持的本地库：

- Anime.js
- Three.js

常见 CDN 地址会在源码进入审批或工程落盘前转换为本地固定依赖；其他外部脚本会保留审计信息，但变为不可执行声明。

## 安全模型

默认安全策略由三层组成：

1. HTML/CSS 清理：移除 iframe、object、embed 等独立执行宿主，移除事件属性和危险 URL scheme。
2. 依赖本地化：受支持库映射到本地文件，未知公网脚本不直接加载。
3. JavaScript 审查：按 allow、warn、refuse 输出诊断；refuse 脚本不执行。

refuse 规则覆盖 Node 模块、process/global、文件系统、进程执行、Electron/IPC、二次动态求值、构造器逃逸、宿主文档破坏、file URL 和特权导航等。网络、持久化存储、全局事件、持续运行任务和 WebGL 会产生 warn。

人类可在本机经过二次确认后关闭脚本审查。此设置不写入工程，且不会取消 PR 审批、外部依赖本地化或 CSP。

**重要：这是 Alpha 级纵深防御，不是通用恶意 JavaScript 沙箱。** 审查基于规则扫描，scoped document 主要用于作用域约束与兼容性。不要在关闭审查后打开不可信的可编程文档。

## 文件与数据安全

- 渲染窗口启用 context isolation，且不开放 Node.js integration。
- 专属预加载桥只暴露文档、字体、主题、窗口和 Agent 请求相关能力。
- 工程和导出文件最大 100 MB。
- 保存与导出先写同目录临时文件，再替换目标文件。
- 最近文件列表保存在 `AppData/Scriptorium/recent.json`。
- Agent 写操作要求 maid 署名、summary 和主进程侧 requestId。
- PR 记录提交时的 documentId；审批时若当前窗口已切换工程，将以冲突状态拒绝应用。
- target/replace 在真正合并时重新定位，目标已变化时不会盲目覆盖。

## 工程结构

当前渲染侧采用按依赖顺序装载的经典浏览器模块。模块通过冻结的 `window.ScriptoriumXxx` 接口暴露纯函数或控制器工厂。

| 模块组 | 文件与职责 |
| --- | --- |
| 组合与外壳 | [`scriptorium.js`](scriptorium.js) 只负责依赖检查、端口和控制器装配、启动与统一释放；[`scriptorium-shell.js`](scriptorium-shell.js) 负责顶层 UI、模式、缩放、快捷键和主题生命周期 |
| 文档所有权 | [`scriptorium-document-store.js`](scriptorium-document-store.js) 是 document、identity、dirty、revision、generation 与资源解析器的唯一仓库 |
| 类型适配 | [`scriptorium-flow-adapter.js`](scriptorium-flow-adapter.js) 与 [`scriptorium-deck-adapter.js`](scriptorium-deck-adapter.js) 提供源码、CSS、编译、渲染、编辑、导航、导出和 PR 预览的多态边界 |
| 编辑 | [`scriptorium-dom-selection.js`](scriptorium-dom-selection.js) 提供纯 DOM Selection 原语；[`scriptorium-flow-editor.js`](scriptorium-flow-editor.js) 与 [`scriptorium-deck-editor.js`](scriptorium-deck-editor.js) 分别拥有两套编辑事务；[`scriptorium-formatting.js`](scriptorium-formatting.js) 只路由当前 EditorPort |
| 渲染 | [`scriptorium-render-primitives.js`](scriptorium-render-primitives.js)、[`scriptorium-flow-renderer.js`](scriptorium-flow-renderer.js)、[`scriptorium-deck-renderer.js`](scriptorium-deck-renderer.js) 与 [`scriptorium-render-coordinator.js`](scriptorium-render-coordinator.js) 分别负责原语、类型渲染和协调 |
| 历史与源码 | [`scriptorium-edit-history.js`](scriptorium-edit-history.js) 负责 edit burst 与 undo/redo；[`scriptorium-source-editor.js`](scriptorium-source-editor.js) 负责 CodeMirror 外壳 |
| 导出 | [`scriptorium-export.js`](scriptorium-export.js)、[`scriptorium-flow-export.js`](scriptorium-flow-export.js)、[`scriptorium-deck-export.js`](scriptorium-deck-export.js) 与 [`scriptorium-export-resources.js`](scriptorium-export-resources.js) |
| 内容能力 | [`scriptorium-media.js`](scriptorium-media.js)、[`scriptorium-find.js`](scriptorium-find.js)、[`scriptorium-navigation.js`](scriptorium-navigation.js)、[`scriptorium-style-ui.js`](scriptorium-style-ui.js) |
| 文脉与 Agent | [`scriptorium-lineage-store.js`](scriptorium-lineage-store.js)、[`scriptorium-lineage-ui.js`](scriptorium-lineage-ui.js)、[`scriptorium-pr-diff.js`](scriptorium-pr-diff.js) 与 [`scriptorium-agent-port.js`](scriptorium-agent-port.js) |
| 运行时与对象 | [`scriptorium-runtime.js`](scriptorium-runtime.js) 负责可编程内容生命周期；[`scriptorium-objects.js`](scriptorium-objects.js) 通过 LayoutPort 支持 flow 与 free-canvas 对象 |
| 基础内核 | [`vdoc-core.js`](vdoc-core.js)、[`vdoc-hybrid-compiler.js`](vdoc-hybrid-compiler.js)、[`vdoc-container.js`](vdoc-container.js)、[`scriptorium-pagination.js`](scriptorium-pagination.js)、[`vdoc-style-library.js`](vdoc-style-library.js) |
| 页面与宿主 | [`scriptorium.html`](scriptorium.html)、[`scriptorium.css`](scriptorium.css)、[`../preloads/docx.js`](../preloads/docx.js)、[`../modules/ipc/docxHandlers.js`](../modules/ipc/docxHandlers.js) |

## 启动

在 VCPChat 项目根目录安装依赖并启动 Electron：

```bash
npm install
npm start
```

启动后可从 VCPChat 的“文坊”入口或托盘菜单打开 Scriptorium。

也可由插件调用自动打开窗口；控制服务会等待渲染侧 `window.ScriptoriumAgent` 就绪。

## 验证与架构门禁

当前全量重构遵循 [`AGENT.md`](AGENT.md)：旧测试脚本已废弃，不读取或运行旧测试，不执行单元测试或语法检查。当前门禁以产品事务不变量和人工场景验收为准。

模块边界必须持续满足：

- Document store 是文档模型的唯一仓库；所有正式修改通过 DocumentPort 事务。
- flow/deck 的编辑、渲染和导出语义分别由对应策略拥有。
- 共用控制器只依赖稳定端口，不读取文档内部结构，不建立 kind 条件树。
- 基础模块不调用组合根，不保留旧调用点兼容代理。
- 保存、导出及其他跨 `await` 操作捕获 generation、document ID，并在需要稳定输入时校验 revision。
- AbortController、observer、timer、运行时和订阅由创建它们的控制器释放。
- 人工验收按新架构的 VDOCX、VPPTX、内容、导出和文脉场景执行，详细清单见 [`Scriptorium主模块拆分研究.md`](../开发文档/Scriptorium主模块拆分研究.md) 第 10 节。

### 视觉对象 GUI 手工验证

视觉对象涉及指针捕获、Shadow DOM、缩放、分页浮动和可编程运行时竞态，自动测试只能覆盖装载和源码一致性。每轮相关修改至少手工检查：

1. 在 VDOCX 中分别插入矩形、椭圆、箭头和图片。
2. 拖到不同段落前后，检查落点指示线和撤销/重做。
3. 切换独占、左环绕和右环绕，检查连续编辑、阅读分页、HTML 与 PDF。
4. 右键打开属性检查器；修改后取消应完全还原，应用应只产生一个历史节点。
5. 粘贴常见图标 SVG，检查即时预览、应用、保存重开；再输入错误 XML、`script` 和 `on*` 属性，检查诊断与清理。
6. 为图形和媒体分别附加普通 CSS；检查 `:object`、后代选择器及隔离预览，并确认规则不影响其他对象。
7. 在 50%、100% 和 200% 缩放下拖动四个角；检查最小尺寸、Shift 等比和松手后的单次历史提交。
8. 在 VDOCX 缩放对象后检查文字环绕与分页重排；在 VPPTX 从左上角缩放时检查右下对边保持及坐标保存。
9. 在 VPPTX 不同缩放比例下拖拽，检查保存后的坐标与重新打开位置。
10. 用右键菜单逐层调整对象，检查重叠顺序、缩略图、放映 HTML 和 PDF。
11. 检查视频/音频原生控件仍可操作，图注仍可编辑，对象空白区仍可拖动。
12. 在带 Anime.js、Three.js 或自定义脚本的页面操作对象，检查重渲染后脚本生命周期正常恢复。
13. 切页、切模式、保存、撤销和关闭模态窗时检查没有遗留选择框、手柄、拖拽状态或属性草稿。
14. 打开旧工程中的 `.vdoc-media`，确认自动迁移对象身份且媒体资源短引用未被 blob URL 污染。

## Alpha 已知限制

- VDOCX / VPPTX 是 VCP 自有 ZIP 格式，与原生 DOCX / PPTX 不二进制兼容。
- Office 导入是语义或静态版式转换，不是无损往返编辑。
- 工具栏“插入媒体”支持外部 `src` 和本地文件批量插入。本地媒体进入独立资源区；源码记录布局、原始文件信息、原生分辨率、逐项描述及音视频时长。
- 文档环绕当前使用矩形边界和 CSS 浮动，不提供不规则 `shape-outside`、任意页面坐标或正文 z-index。
- 当前提供四角尺寸手柄，不提供四条边的独立手柄；PPT 对象尚未提供框选、多选、组合、参考线和完整图层面板。
- SVG 图形支持完整源码替换，但不提供可视化路径节点编辑或布尔运算；自定义 SVG 内部结构也不保证能反向映射到填充、描边等参数化 GUI。
- 对象 CSS 为便于可靠作用域分析，暂不支持 `@` 规则、嵌套规则和关键帧；复杂动画仍应放入文档或页面完整源码。
- 分页器面向 Web 富文档语义，不追求 Word 排版引擎逐像素一致。
- JavaScript 安全审查不是完整沙箱；关闭审查后不应运行不可信源码。
- 当前工程格式版本为 `vcp-vdocx` version 1，Alpha 阶段仍可能演进。
- 撤销栈只存在于当前窗口会话；需要长期恢复时应使用持久化文脉刻点。
- 无法确认真实文件类型的外部 URL 不会自动收纳，需要保持网络可访问或由用户改为明确的媒体/字体文件地址。
- 大型复杂 WebGL 页面、长时间动画和第三方脚本兼容性仍需更多压力测试。

## Alpha 定位

这个版本已经完成了可实际使用的核心闭环：

**人类编辑渲染结果 → 源码定向同步 → 本地工程保存 → Agent 读取语义/源码/画面 → 提交署名 PR → 人类查看双重差异 → 审批与回执 → 文脉持久化 → 可回溯版本。**

它仍不是面向普通用户发布的稳定 Office 替代品，但已经是一套能够继续验证“人类写作 + Agent 源码协作 + 可编程富文档”方向的 Alpha 原型。