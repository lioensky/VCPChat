# VCP Scriptorium · 共笔文坊

> Alpha 原型：以 HTML、CSS 与受控 JavaScript 为共同语言的人机协作文档工作台。

Scriptorium 是 VCPChat 内置的本地富文档与演示创作空间。它同时面向人类作者和 VCP Agent：人类可以直接编辑渲染后的文字与版式，Agent 可以读取文档语义、源码和视觉上下文，并通过可审阅的 PR 修改文档。

它不是 DOCX/PPTX 的原位 OOXML 编辑器。Scriptorium 使用自己的 VDOC 工程模型：

- **VDOCX**：连续流文稿工程，扩展名为 `.vdocx`。
- **VPPTX**：逐页演示工程，扩展名为 `.vpptx`。
- 原生 `.docx`、`.pptx` 是导入源；导入后应保存为对应的 VDOC 工程。
- 工程文件当前是 UTF-8 JSON，而不是 ZIP/OOXML 容器。

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
- 插入段落、标题、引文和 3 × 3 表格。
- 标题目录、段落索引、字数与字符数统计。
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

一份 VDOCX 只有一个完整 HTML source。它可以同时包含：

- 文档级 `<style>`
- 完整正文 HTML
- 本地依赖声明
- 内联交互 `<script>`

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
5. 未被显式编辑的源码节点保持原样。

Agent 也不直接操作实时 DOM，而是读取和修改同一份完整源码。

## 四个工作面

### 连续编辑

人类直接编辑渲染结果。VDOCX 使用连续流画布；VPPTX 使用当前页面画布。页面内脚本产生的运行时 DOM 不会被误写回工程。

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

| 文件 | 职责 |
| --- | --- |
| [`scriptorium.html`](scriptorium.html) | 编辑器 UI、对话框与本地依赖装载 |
| [`scriptorium.css`](scriptorium.css) | 文坊视觉系统与响应式布局 |
| [`scriptorium.js`](scriptorium.js) | 编辑器组合根；共享状态、渲染/选择编排与 UI 事件（持续拆分中） |
| [`scriptorium-async.js`](scriptorium-async.js) | latest-wins 令牌、文档上下文快照与命名串行队列 |
| [`scriptorium-runtime.js`](scriptorium-runtime.js) | 文档岛与幻灯片可编程运行时、脚本审查及资源生命周期 |
| [`scriptorium-source-editor.js`](scriptorium-source-editor.js) | CodeMirror 适配、源码诊断、格式化与颜色工具 |
| [`scriptorium-session.js`](scriptorium-session.js) | 新建、打开、导入、保存、未保存决策、最近文档与刻点持久化 |
| [`vdoc-core.js`](vdoc-core.js) | VDOC 模型、规范化、序列化和源码清理 |
| [`scriptorium-pagination.js`](scriptorium-pagination.js) | 连续流、分页预览与分页 HTML |
| [`scriptorium-agent.js`](scriptorium-agent.js) | 渲染侧 Agent 读取、PR、审批和版本协议 |
| [`scriptorium-programmable-content.js`](scriptorium-programmable-content.js) | 依赖本地化与脚本安全审查 |
| [`vdoc-style-library.js`](vdoc-style-library.js) | 高级样式注册、预览、编译与样式包 |
| [`scriptorium-visibility.js`](scriptorium-visibility.js) | 页面可见性与运行时暂停 |
| [`scriptorium-pretext-bridge.js`](scriptorium-pretext-bridge.js) | Pretext 文本测量桥 |
| [`../preloads/docx.js`](../preloads/docx.js) | 最小权限 Electron API |
| [`../modules/ipc/docxHandlers.js`](../modules/ipc/docxHandlers.js) | 窗口、文件、字体、导入导出和 Agent IPC |
| [`../modules/services/scriptoriumImportService.js`](../modules/services/scriptoriumImportService.js) | HTML/Markdown/TXT/RTF/DOCX 语义导入 |
| [`../modules/services/scriptoriumPptxImportService.js`](../modules/services/scriptoriumPptxImportService.js) | PPTX 静态版式导入 |
| [`../modules/services/scriptoriumAgentControlService.js`](../modules/services/scriptoriumAgentControlService.js) | Agent 窗口控制、截图和工程落盘 |
| [`../VCPDistributedServer/Plugin/ScriptoriumCollaborator`](../VCPDistributedServer/Plugin/ScriptoriumCollaborator) | VCP hybrid service 与工具清单 |

## 启动

在 VCPChat 项目根目录安装依赖并启动 Electron：

```bash
npm install
npm start
```

启动后可从 VCPChat 的“文坊”入口或托盘菜单打开 Scriptorium。

也可由插件调用自动打开窗口；控制服务会等待渲染侧 `window.ScriptoriumAgent` 就绪。

## 验证

### 静态语法检查

```bash
node --check ScriptoriumModules/scriptorium.js
node --check ScriptoriumModules/scriptorium-async.js
node --check ScriptoriumModules/scriptorium-runtime.js
node --check ScriptoriumModules/scriptorium-source-editor.js
node --check ScriptoriumModules/scriptorium-session.js
node --check ScriptoriumModules/scriptorium-agent.js
node --check ScriptoriumModules/vdoc-core.js
node --check ScriptoriumModules/scriptorium-programmable-content.js
node --check modules/ipc/docxHandlers.js
node --check modules/services/scriptoriumAgentControlService.js
node --check VCPDistributedServer/Plugin/ScriptoriumCollaborator/ScriptoriumCollaboratorService.js
```

### Node 测试

```bash
node tests/scriptorium-async.test.js
node tests/scriptorium-collaborator.test.js
node tests/scriptorium-importers.test.js
```

### 异步与模块边界约定

Scriptorium 仍使用按顺序加载的经典浏览器脚本，以兼容当前 Electron 页面和全局模块。新增模块应采用小型显式接口，不再向 [`scriptorium.js`](scriptorium.js) 继续堆叠无关职责。

异步操作必须声明一致性语义：

- 打开、导入和路径跳转使用 **latest-wins**；较早请求即使更晚完成也不得覆盖最后一次用户意图。
- 保存、导出、视觉采集和其他跨 `await` 操作必须捕获文档 generation 与 document ID；需要稳定输入时还要检查 revision。
- 同一资源上的写操作使用命名串行队列；任务失败不得阻塞后续任务。
- 异步 `finally` 只能清理自己发起时所属的文档状态，不能修改已切换的新文档。
- 渲染定时器、动画帧和观察器继续使用 disposer / AbortController 管理生命周期。

当前已完成首轮主模块拆分：

1. `scriptorium-runtime.js` 已接管文档/幻灯片可编程运行时，并统一原先重复的 RAF、timeout、interval 与 cleanup 跟踪。
2. `scriptorium-source-editor.js` 已接管 CodeMirror、源码诊断、格式化和颜色工具。
3. `scriptorium-session.js` 已接管打开、保存、导入、最近文档、未保存决策和刻点持久化。
4. `scriptorium.js` 通过显式上下文创建控制器，仅保留兼容代理供尚未迁移的调用点使用。

后续按以下顺序继续拆分：

1. `scriptorium-selection.js`：选区、块选择、格式命令与定向源码同步。
2. `scriptorium-lineage-ui.js`：PR 审阅、差异预览、刻点展示与版本回溯。
3. `scriptorium-renderer.js`：文档样式、连续渲染、分页预览、缩略图与数学渲染。
4. `scriptorium-export.js`：连续 HTML、分页 HTML、演示 HTML 与 PDF 导出构建。
5. `scriptorium-shell.js`：控件绑定、面板、缩放、键盘与应用初始化。

依赖方向保持单向：基础模块不调用组合根；控制器只接收显式上下文；跨模块操作通过注入的函数完成。每次只迁移一个高内聚边界，并保持现有全局 API 与 Electron 冒烟测试通过，避免一次性的大爆炸式重写。

### Electron 冒烟与集成测试

Windows CMD 中先清除可能残留的 Electron Node 模式：

```bat
set ELECTRON_RUN_AS_NODE=
npx electron tests/scriptorium-electron-smoke.js
npx electron tests/scriptorium-vpptx-electron.test.js
npx electron tests/scriptorium-cdn-localization-electron.test.js
```

主冒烟测试覆盖编辑器装载、文稿创建、分页、编辑、Agent PR 审批、运行时安全和截图；截图写入 `AppData/Scriptorium/scriptorium-smoke.png`。

## Alpha 已知限制

- VDOCX / VPPTX 是 VCP 自有格式，与原生 DOCX / PPTX 不二进制兼容。
- Office 导入是语义或静态版式转换，不是无损往返编辑。
- 图片资源本地化层尚未接入；工具栏“插入图片”目前只显示提示。
- 工具栏中的项目符号和编号列表按钮尚未接入编辑命令。
- 分页器面向 Web 富文档语义，不追求 Word 排版引擎逐像素一致。
- JavaScript 安全审查不是完整沙箱；关闭审查后不应运行不可信源码。
- 当前工程格式版本为 `vcp-vdocx` version 1，Alpha 阶段仍可能演进。
- 撤销栈只存在于当前窗口会话；需要长期恢复时应使用持久化文脉刻点。
- 外部图片、媒体和字体的可移植资源打包仍需继续完善。
- 大型复杂 WebGL 页面、长时间动画和第三方脚本兼容性仍需更多压力测试。

## Alpha 定位

这个版本已经完成了可实际使用的核心闭环：

**人类编辑渲染结果 → 源码定向同步 → 本地工程保存 → Agent 读取语义/源码/画面 → 提交署名 PR → 人类查看双重差异 → 审批与回执 → 文脉持久化 → 可回溯版本。**

它仍不是面向普通用户发布的稳定 Office 替代品，但已经是一套能够继续验证“人类写作 + Agent 源码协作 + 可编程富文档”方向的 Alpha 原型。