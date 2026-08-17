# VCP Scriptorium · 共笔文坊

> **A document is a place, not a file.**  
> 文档不是一棵等待序列化的 DOM，也不是某个应用独占的二进制黑箱。  
> 它应当是一份人类可以直接阅读和书写、Agent 可以精确理解和修改、所有参与者都能审阅其来路的共同作品。

Scriptorium 是 VCPChat 内置的 **AI-native 可编程文档与演示创作系统**。

它不是给传统富文本编辑器加上一个聊天窗口，也不是让 AI 模拟鼠标点击工具栏。Scriptorium 从文档模型、编译器、编辑器、运行时、工程容器到协作协议全部围绕同一个前提重建：

**人类编辑渲染后的真实文档；Agent 编辑同一文档的真实源码；两种编辑必须汇入同一份唯一真源。**

这使 Scriptorium 同时具备传统办公软件、源码编辑器、Web 运行时和版本审阅系统的一部分能力，却不需要在“所见即所得”和“源码可控”之间二选一。

---

## 最重要的突破：渲染后即时编辑，但不牺牲源码

Markdown 编辑器通常有两种工作方式：

1. 编辑源码，再在另一侧查看预览；
2. 把 Markdown 编译成 HTML，在富文本 DOM 上编辑，最后猜测如何重新生成源码。

第一种方式割裂写作，第二种方式会破坏源码。

一旦把渲染 DOM 反序列化回 Markdown，原作者的源码表达通常就会丢失：

- Markdown 分隔符风格会被改写；
- 空行、缩进和换行语义会漂移；
- 行内 HTML 的属性顺序与原始写法会消失；
- LaTeX 可能被写回 KaTeX 生成的 DOM；
- Mermaid 可能被写回派生 SVG；
- 脚本创建的 Canvas、SVG、控制节点与临时状态可能污染正文；
- 未被用户触碰的源码也会被格式化器重写。

Scriptorium 没有走这条路。

它实现的是一条 **源码保持型渲染编辑管线**：

```text
Markdown 主导的混合源码唯一真源
（Markdown / HTML / CSS / LaTeX / Mermaid / 可编程岛）
        │
        ▼
混合源码扫描与受保护区域识别
        │
        ▼
带源码字符区间和内容哈希的编译编辑区
        │
        ▼
静态渲染树 / 点击后临时视觉编辑树
        │
        ▼
光标与 Selection 映射回源码字符偏移
        │
        ▼
带 expected 原文校验的区间事务
        │
        ▼
只替换真正发生变化的源码片段
        │
        ▼
重新编译并局部修补渲染区
```

### 1. 编译器不是只输出 HTML

VDOCX 的混合编译器除了生成阅读用 HTML，还会生成一组编辑索引。每个编辑区都包含：

- 当前编译修订内的临时 key；
- 内容类型；
- 流式文字、静态 HTML 块或稳定原子块的边界分类；
- 在唯一源码中的精确字符起止位置；
- 对应源码片段的内容哈希；
- Markdown token 类型；
- 可编程岛的稳定语义 ID。

普通 Markdown 使用 lexer 返回的原始 token 范围切分。围栏代码、Mermaid、块级公式、样式块和可编程岛会先被扫描并保护，不会被 Markdown 编译器吞掉或重写。

换句话说，渲染结果从诞生时就知道自己来自哪一段源码，而不是等到编辑结束后再尝试从 DOM 猜回去。

### 2. 静态渲染树与编辑树是两种不同产物

连续编辑面平时显示正常编译后的文档。用户第一次按下指针时，浏览器仍然面对完整的被动渲染树，因此原生拖选、跨文字选择和右键选择不会被自定义编辑器抢走。

只有在确认用户进行的是折叠点击后，Scriptorium 才会把被点击的局部编译区替换成临时视觉编辑树。

这个编辑树有一个严格不变量：

```text
editableSourceText(visualEditor) === 原始源码片段
```

如果无法满足，系统拒绝进入编辑，而不是冒险写回。

### 3. Markdown 语法没有被删除，只是按上下文显隐

视觉编辑树会保留标题井号、列表前缀、引用符号、粗体、斜体、删除线、代码分隔符以及允许的 HTML 标签骨架。

这些源码字符并未从编辑模型中消失：

- 非当前上下文的标记被隐藏；
- 光标进入相应行时，块级标记显现；
- 光标或选区进入行内语法范围时，成对分隔符显现；
- 语义内容仍以标题、强调、代码等真实视觉样式呈现；
- 静态 HTML 标签始终作为隐藏骨架存在，标签之间的文字保持可视可编辑。

因此，作者看到的是接近最终文档的排版，编辑器操作的却仍然是原始源码字符序列。

### 4. 光标不是 DOM 偏移，而是源码偏移

Scriptorium 为渲染文字节点建立到源码区间的映射。点击、拖选、格式化、复制、粘贴、输入法组合输入和结构插入最终都会转换成源码字符偏移。

多行视觉编辑器会显式处理：

- 行与行之间的源码换行；
- 浏览器 Selection 到局部行偏移的换算；
- 点击前后语法显隐导致的布局变化；
- 两帧后的点击位置再校准；
- 中文输入法的 composition 生命周期；
- Enter、硬换行与浏览器原生富文本行为的差异。

格式工具也不会调用浏览器的富文本命令。粗体、斜体、列表、颜色或高级样式最终都被表达成对真源的 Markdown 或受控 HTML 变换。

### 5. 每次写入都是带防护的源码事务

渲染态编辑不会提交“当前 DOM 长什么样”，只会提交类似下面的事务：

```text
from      = 源码起始字符
to        = 源码结束字符
expected  = 事务开始时该区间的原文
insert    = 编辑后的源码片段
```

提交前系统会检查：

- 当前源码区间是否仍等于 expected；
- 编辑区哈希是否仍与当前源码一致；
- 修改是否跨越 Mermaid、公式、代码或可编程岛等稳定原子边界；
- 文档是否已经在其他入口产生了新修订。

任何映射过期或边界不安全都会让本次写入失败，而不是覆盖未知的新内容。

事务完成后，系统重新编译，只局部替换对应渲染区，并恢复光标。未被编辑的源码字节不会因为一次正文输入而被全篇重新序列化。

### 6. 派生 DOM 永远不是文档真相

KaTeX 输出、Mermaid SVG、脚本创建的 Canvas、运行时 class、动画 style、编辑选框、缩放手柄、拖放提示和临时 data 属性都属于派生状态。

它们可以被渲染、截图、暂停和销毁，但不会被当作文档源码写回。

这正是 Scriptorium 能够同时容纳 Markdown、静态 HTML 和可编程内容，却仍保持源码长期可维护的根本原因。

---

## Flow 编辑引擎：渲染态编辑的近期迭代

VDOCX 的连续流编辑已经从“渲染结果上挂一个 `contenteditable`”升级为编译器、源码映射、浏览器 Selection 和局部渲染协同工作的编辑引擎。

这里的“连续流”并不等于“纯 Markdown 编辑器”。VDOCX 使用的是**以 Markdown 作为普通正文默认表达、同时原生容纳 HTML / CSS / LaTeX / Mermaid / 可编程岛的混合文档源码**。机器字段名 `markdown-hybrid` 描述的是这套源码格式，而不是把文档能力限制为 Markdown：

- 当前混合编译器版本为 `vdoc-hybrid-compiler/3`。它先扫描并保护代码 / Mermaid 围栏、可编程岛、样式块、块级公式和行内公式，再使用 GFM lexer 建立 Markdown token 级编辑区；
- 每个编辑区同时拥有临时 key、类型、flow kind、源码字符区间、内容哈希、Markdown token 类型和岛 ID。普通文字是 `text-flow`，HTML 块拥有独立布局边界，代码、Mermaid、样式、块级公式和可编程岛是 `stable-atomic`；
- 静态渲染树默认保留浏览器原生拖选、跨块选择、复制、右键和系统 Selection。只有确认是折叠点击后，才将局部区域替换成视觉编辑树；无法证明 `editableSourceText === 原始源码片段` 时拒绝激活；
- 编辑树按源码行保留标题、引用、列表、任务列表、表格和行内 Markdown 标记的语义排版。语法字符只按当前光标和选区上下文显隐，静态 HTML 标签则作为隐藏的无损骨架参与源码序列化；
- 中文输入法 composition 不在候选词生命周期内重建编辑 DOM。系统会延迟等待最终 `beforeinput/input`，保留活动编辑器和候选窗，必要时使用文本快照提交，并屏蔽旧编辑器的迟到事件；
- Enter、Backspace、Delete、粘贴、剪切、跨编辑区选择、空白段落和 HTML 块边界均转换为源码事务。显式 `↵` 用于表达可继续编辑的空白行，避免空 DOM 与 Markdown 空行在往返时丢失语义；
- 每次事务都会执行 expected 原文、源码哈希、稳定原子边界和当前修订检查。结构变化时只重建必要区域；结构未变化时尽量保留当前 `contenteditable` DOM、Selection、滚动位置和焦点，并通过局部 patch 恢复光标；
- 编辑器支持按选区将基础格式、高级样式、列表和结构插入表达为 Markdown 或受控 HTML，不调用浏览器富文本命令，也不把浏览器生成的 DOM 反序列化为正文。

因此，Flow 的核心保证不只是“可以直接编辑预览”，而是：**浏览器负责提供自然 Selection，编辑器负责把 Selection 还原为源码偏移，编译器负责证明边界，事务负责拒绝过期写入，渲染器负责局部恢复。**

---

## 一份文档，两类原生工程

Scriptorium 使用自己的 VDOC 工程模型，不是 OOXML 原位编辑器。

### VDOCX：Markdown 主导的混合连续流文稿

VDOCX 不是“Markdown 加几个插件”，而是一种**Markdown 主导的混合文档源码**：

- 标题、段落、列表、任务列表、引文和表格通常优先使用 CommonMark / GFM Markdown；
- 原生 HTML 是与 Markdown 并列的源码表达，用于复杂静态结构、语义标签、布局和局部文字表现；
- 文档级样式独立保存为 `document-css`；源码中的受控 `<style>` 也可以作为被保护的结构区域存在；
- 行内与块级 LaTeX 保留原始公式，由编译器识别并以稳定区域交给公式渲染器；
- Mermaid 保留为 `mermaid` 围栏，由编译器识别并以稳定区域交给 Mermaid 渲染器；
- 需要脚本、Canvas、WebGL、运行时依赖或长期身份的内容进入具有唯一语义 ID 的可编程岛；
- `markdown-hybrid` 是 VDOCX 的源码格式标识，不意味着 HTML、CSS、LaTeX、Mermaid 或可编程岛是 Markdown 的附属扩展；
- 不同语法域拥有各自的边界、编译策略、编辑策略和生命周期，但最终仍保存在同一份可审阅源码真源中。

普通正文不需要也不应被随机永久 ID 淹没。编译块 key 和章节 ID 都是当前修订的临时寻址信息，不会写回正文。

### VPPTX：HTML Scene 演示

VPPTX 不是“文稿分页”，而是独立的页面场景模型：

- 每一页只有一份完整 HTML Scene source；
- 页面源码可同时包含 `<style>`、HTML、依赖声明和内联脚本；
- 演示共享样式独立保存为 `deck-css`；
- 每页拥有稳定页面 ID、名称、备注、资源、转场和时长；
- 页面支持自由坐标对象、图层顺序、动画与交互；
- 画布尺寸、宽高比、主题和默认转场属于演示场景配置；
- 面向 Agent 的 `slideIndex`、`activeSlideIndex` 和页面 `index` 均是从 1 开始的人类页码，插件内部才转换为数组索引；
- 页内脚本由运行时注入当前场景根 `scene`、演示控制 `deck`、生命周期管理器 `runtime`、页内作用域 `document` 和本地动画参数 `anime`。脚本必须以 `scene` 为根查询本页节点，不应依赖 `document.currentScript`、脚本标签物理位置或全局 `document` 查询来识别当前页。

完整页面源码不会被拆成互相漂移的 HTML、CSS、JavaScript 三份草稿。源码面看到的，就是该页被保存和协作的完整真相。

### 编辑态与阅读态解耦

VDOCX 与 VPPTX 的人类 GUI 编辑并不是一个塞进单文件的简化编辑器。源码映射、资源管理、协作协议、Agent 端口、PR 审批、文脉与安全审查等创作能力依赖 VCP 分布式服务器及其前后端运行环境；这是完整编辑态的能力边界。

但作品的阅读与放映不应被创作工具永久绑定。导出的分页文档 HTML 与演示 HTML 是可以脱离 Scriptorium 编辑环境独立运行的浏览器成品：

- 导出物封装运行所需的 JavaScript 依赖，不要求读者安装 VCPChat、Scriptorium 或对应的第三方办公软件；
- 工程字体、图片、音频、视频及其引用会随导出目标完成解析与封装，避免继续依赖编辑期的 `blob:` URL 或工程内部协议；
- VPPTX 导出物携带分页、切页、导播与放映控制能力，可以作为独立演示直接打开；
- VDOCX 分页导出物携带面向纸张的分页、阅读与打印渲染能力；
- 派生运行时与最终内容一同固化，而唯一源码、编辑索引、协作端口和审批基础设施仍留在创作工程中。

因此，Scriptorium 对创作者提供的是联网协作、可编程且可审阅的完整工作台，对读者交付的则是无需连接 VCP 分布式服务、使用现代浏览器即可阅读、放映或打印的自运行作品。编辑态的复杂性不会转嫁给最终受众。

---

## 可编程岛：让文档拥有真正的运行时

VDOCX 中需要程序能力的组件使用稳定语义岛：

```html
<div data-vdoc-island="quarterly-revenue-chart">
    <canvas></canvas>
    <script>
        (() => {
            const root = document.querySelector(
                '[data-vdoc-island="quarterly-revenue-chart"]'
            );
            const canvas = root.querySelector('canvas');
            // 在当前岛内初始化，并通过 runtime 注册清理。
        })();
    </script>
</div>
```

岛模型解决了普通文档结构无法解决的问题：

- 为长期可寻址的可编程组件提供稳定身份；
- 将脚本、局部 DOM、样式和生命周期放在一个源码边界内；
- 让编译器把整个岛视为稳定原子区；
- 防止普通正文随机 ID 化；
- 允许修改已有组件时复用身份，而不是制造重复实例；
- 让 Agent 能精确替换一个组件，同时不接触周围正文。

岛 ID 必须非空、文档内唯一且稳定。岛内样式应以岛根选择器限定作用域；脚本必须位于岛根内部，通过闭包绑定当前根，并从该根开始查询节点，不应把函数、状态或计时器引用挂到 `window` 或 `globalThis`。

### 被管理的执行生命周期

Scriptorium 不只是执行一段脚本。它为每个页面或岛建立可释放的运行时，跟踪：

- `requestAnimationFrame` / `cancelAnimationFrame`；
- `setTimeout` / `clearTimeout`；
- `setInterval` / `clearInterval`；
- `runtime.addCleanup()`；
- Anime.js 实例；
- 视口可见性；
- 脚本生成的运行时节点。

切页、重渲染、切换工作面或关闭文档时，帧、计时器和 interval 会被停止，清理函数逆序执行。离开视口的动画和媒体可以暂停，重新进入时恢复。

内置支持 Anime.js 与 Three.js。常见 CDN 声明在进入工程或审批前会被转换为本地固定依赖；未知公网脚本保留审计信息，但会变成不可执行声明。

VDOCX 阅读分页也不会只对初始静态 HTML 做一次测量。分页器会把文字流、标题、列表、表格、媒体、数学、Mermaid 和交互岛按不同边界处理：普通安全文字可以按字素拆分，表格按行续页，列表保留列表语义，标题尽量与后续内容保持在同页，交互岛和复杂媒体保持原子块。阅读渲染会等待字体、图片、Mermaid 和运行态岛完成初始化，再经过两帧布局稳定，用运行态快照获得真实几何后重新分页；随后清除分页测量阶段产生的运行时节点并重新激活最终运行态。无法拆分且超过页面容量的原子内容会产生可诊断的溢出警告，而不是静默破坏结构。

---

## 人类与 Agent 不是抢同一把鼠标

ScriptoriumCollaborator 让 Agent 以文档协作者而不是远程桌面操作者的身份工作。

Agent 可以同时获得三种互补认知：

### 语义

- 当前文档信息、类型、修订和保存状态；
- 绕过 CSS 的渲染文本；
- VDOCX 标题目录和章节；
- VPPTX 页面目录、页面名称与备注。

### 源码

- 按行读取 Markdown、页面 HTML 或独立 CSS；
- 普通字符串或正则全文检索；
- 当前人类视口附近的源码；
- 编译诊断、源码范围和实际行号。

### 视觉

- 当前阅读视口或指定演示页的真实截图；
- 与截图同时返回的标准 Markdown 语义摘要；
- 显式渲染稳定等待；
- 多步骤串行采集；
- 部分失败时保留此前成功的文本和图片结果。

这让 Agent 可以先理解“写了什么”，再查看“如何实现”，最后确认“看起来怎样”，而不是只依赖 OCR、DOM 或某一种单薄表示。

---

## PR，而不是静默代写

所有针对当前窗口文档的 Agent 写操作都进入 PR 协议。

推荐协作闭环：

1. 读取文档信息与当前 revision；
2. 通过目录、章节、检索或视口源码定位目标；
3. 必要时读取视觉上下文；
4. 使用原文 `target`、替换内容和建议的 `startLine` 形成最小变更；
5. 携带 `maid`、`summary`、`requestId` 与 `expectedRevision` 提交；
6. 人类在文脉面板查看局部源码差异和局部渲染差异；
7. 人类允许、拒绝并可填写回执；
8. 允许后才合并、增加修订、保存变更前后状态并建立快照；
9. Agent 同步取得审批结果。

### 乐观并发保护不是装饰

Scriptorium 在两个时点检查并发：

- 提交预检时，`expectedRevision` 必须匹配当前文档；
- 人类真正批准时，基础修订和 document ID 会再次检查。

即使 PR 等待审批期间人类继续编辑，旧提案也不会覆盖新内容。源码替换在真正合并时还会重新定位 `target`；相同目标可依据 `startLine` 选择最近实例。

`requestId` 提供幂等语义，避免网络重试重复创建或应用同一提案。

### 审阅的是源码差异，也是结果差异

审阅窗口并排展示：

- target / replace 构成的局部源码差异；
- 变更前与变更后的隔离渲染预览。

历史节点保存完整 changeSet 后，即使当前文档早已继续演进，也能基于当时的 before / after 状态复核，而不是拿旧提案强行套在今天的源码上。

### 自动允许始终由人类掌控

人类可以在本地 UI 中按操作类型开启自动允许：

- 源码替换；
- 新增末页；
- 插入页面；
- 删除页面。

Agent 不能通过请求自行开启该策略。命中 refuse 级规则的内容不能自动批准。

---

## 单文档即协作仓库：每个人都可以带着自己的 Agent 团队加入

Scriptorium 的协作能力不只是“多人同时编辑”，而是让**一份文档本身天然具备近似 Git、并且比传统纯文本 Git 更完整的版本协作能力**。

这是因为系统同时保留了两组不可缺失的信息：

- **完整署名**：人类用户与 Agent 都拥有明确、独立的作者身份；每次提案、审批、合并、拒绝、回执和恢复都能追溯到具体参与者；
- **完整文脉**：历史不是一串扁平存档，而是可追踪的图形化节点关系；每个节点同时保存源码变更、渲染结果差异、修订关系与工程快照，形成“图形 DOM / 可视结果 + 唯一源码”的双重版本证据。

因此，版本能力不再依赖把整个工程外置到另一个 Git 仓库后才能成立。**单个 VDOCX 或 VPPTX 文档就是一个自带作者系统、提交记录、差异审阅、审批协议、快照和安全回溯能力的协作仓库。**它既拥有源码 Git 的精确性，又补上了传统 Git 无法直接表达的渲染结果、Agent 提案、人工审批与协作语义，可以视为面向 AI-native 文档的加强版 Git。

这使一种真正的新协作形态成为可能：**多个人类参与者可以分别带着各自的 Agent 团队进入同一份作品。**人类与 Agent 不共享模糊的“共同作者”身份，也不需要争抢同一编辑入口；每支团队都可以理解文档、提出署名变更、接受审阅并取得回执，而所有贡献最终汇入同一唯一真源和同一条可审计文脉。

---

## 文脉：版本历史也是协作历史

Scriptorium 把版本、作者、提案、审批和回执放进同一条“文脉”。

每个节点可以记录：

- 人类或 Agent 作者；
- 名称、摘要和备注；
- 基础修订与结果修订；
- pending、applied、rejected、conflict 或 failed 状态；
- 原始 proposal 与最终 operation；
- 变更前后 source state；
- 审阅者、决定、回执与自动策略来源；
- 工程内嵌版本快照。

人类可以主动创建刻点，也可以查看 Agent PR 的完整来路。

回溯历史不是删除未来。系统会先为当前版本建立安全备份，再从目标节点的内嵌快照创建一次新的恢复记录，因此后续历史仍然存在，回溯本身也成为可审计事件。

---

## 工程容器不是一个巨型 JSON

`.vdocx` 与 `.vpptx` 是 Scriptorium v2 ZIP 工程容器。当前容器将职责分开存放：

```text
manifest.json
source/document.md
source/document.css
lineage/checkpoints.json
resources/media/<sha256>.<ext>
resources/fonts/<sha256>.<ext>
mimetype
```

VDOCX 的混合文档源码和文档 CSS 是独立真实文件，不再埋在一个难以 diff 的 JSON 字符串中。这里的混合文档源码通常以 Markdown 为普通正文入口，但也可以原生包含 HTML、LaTeX、Mermaid、受控样式和可编程岛。VPPTX 的页面场景由清单中的正式页面模型承载。

资源系统使用 SHA-256 内容寻址：

```text
vdoc-resource://media/<sha256>
vdoc-resource://fonts/<sha256>
```

由此获得：

- 相同二进制自动去重；
- 源码中不出现巨大 Base64；
- 打开工程时逐资源校验路径、ID 与实际哈希；
- 编辑期映射为生命周期受控的 `blob:` URL；
- 导出副本中按目标格式转换，不污染工程真源；
- 媒体描述、MIME、原生尺寸和时长可被人类与 Agent 共同理解。

保存与导出通过临时文件替换目标，降低中途失败导致工程损坏的风险。

---

## 四个工作面，同一个文档模型

### 连续编辑

直接在编译后的 VDOCX 文稿或当前 VPPTX 场景中操作。VDOCX 的正文输入走源码保持型映射；视觉对象使用独立定向事务。

### 阅读预览 / 放映预览

VDOCX 进入纸张分页阅读，VPPTX 进入逐页场景预览。分页产物和运行时状态仍然是派生视图，不改变真源。

### 混合源码

CodeMirror 直接连接当前唯一正文源码。VDOCX 使用 Markdown 模式，VPPTX 对应当前页完整 HTML Scene。源码输入实时进入文档模型，并触发诊断与渲染失效。

### CSS 源码

VDOCX 编辑独立 `document-css`，VPPTX 编辑共享 `deck-css`。样式不需要伪装成正文节点，也不会与 Markdown 结构混杂。

---

## 高级样式：可积累、可分发的文字视觉语言

传统文档中的“艺术字”通常是一组封闭预设。Scriptorium 的高级样式不是增加更多固定按钮，而是允许对任意选区中的文字施加受控的 CSS 内联规则，从而组合渐变、描边、阴影、发光、纹理、混合模式、动画及其他浏览器能够表达的字体效果。

更重要的是，这些效果不是只能停留在当前文档中的一次性装饰：

- 高级文字样式可以保存为样式库条目，并以主题或样式包的形式导入、导出和分发；
- 人类可以从选区创建、调整、预览和复用效果，而不必反复手写同一组规则；
- Agent 可以通过协作者命令创建、整体替换、查询和删除非内置样式包；样式包管理需要 `maid` 署名和幂等 `requestId`，作用于全局运行期资产库，不经过当前文档 PR；
- Agent 在创作过程中临时生成、经人类确认有效的字体效果，可以永久收藏并在后续作品中复用；
- 内置 `vcp.scriptorium.classics` 样式包及其中样式永久只读，其他导入包采用完整包原子替换，替换时未提交的旧样式会被删除；
- 样式最终仍以可检查、可审阅的源码表达进入文档，而不是固化成不可理解的位图。

这使字体特效从旧式办公软件的封闭功能，提升为一种可编程、可收藏、可协作演进的视觉资产。

## 高级 SVG：图形既是素材，也是可编程源码

Scriptorium 中的图形不局限于内置形状集合。系统既提供参数化图形与基础图形化调整，也把完整 SVG 视为可保存、可检查和可继续编辑的开放图形源码：

- 支持批量导入和导出 SVG 文件，使外部图形资产可以进入工程，也可以脱离工程继续流通；
- 支持通过图形界面完成常用参数、尺寸、颜色和对象属性调整；
- 支持直接编辑 SVG 源码及附加样式，为基础 GUI 无法覆盖的细节保留完整表达能力；
- 支持由 Agent 创建、编辑、管理和分发高级图形资产，例如复杂设备、角色、动物与场景插画；
- 支持静态 SVG、SMIL 和 SVG 内部 CSS 动画；资产会分类为 `static` 或 `animated`，实例化时会重写内部 ID，避免同一页面中的渐变、剪裁和引用互相冲突；
- SVG 资产包管理需要 `maid` 署名和幂等 `requestId`，作用于全局运行期资产库；内置 `vcp.scriptorium.basic-shapes` 永久只读，其他导入包支持整体替换和删除；
- 资产源码、节点数量和动画数量受安全配额限制，禁止脚本、事件属性、`foreignObject`、危险外部 URL 等主动内容；
- 插入 VDOCX / VPPTX 的图形保存为自包含 SVG 快照，因此删除全局资产包不会破坏历史文档中的既有实例；
- 图形可以作为可复用资产进入作品，而不是退化成失去结构与语义的截图。

因此，简单图标与“PS5 手柄”“骑自行车的鹈鹕”这类复杂创作共享同一种开放表示。图形能力的上限由 SVG、CSS 与 Agent 创作能力共同决定，而不是由编辑器预置了多少种形状决定。

## 人类创作能力

当前工作台提供的不只是源码基础设施，还包括完整的人类编辑入口：

- 新建、打开、保存、另存 VDOCX / VPPTX；
- 导入 HTML、Markdown、TXT、RTF、DOCX 与 PPTX；
- 导出连续流 HTML、分页 HTML、放映 HTML 与 PDF，其中 HTML 成品可脱离编辑服务器直接在现代浏览器运行；
- 标题、段落、引文、列表、表格和跨块选择；
- 字体、字号、粗体、斜体、下划线、删除线、颜色、高亮、对齐和行距；
- 媒体批量插入、逐项描述、原生尺寸和时长读取；
- SVG 批量导入导出、参数化图形、基础图形化编辑、完整源码与动画；
- VDOCX 独占、左环绕和右环绕；
- VPPTX 自由坐标、尺寸、旋转与图层顺序；
- 对象级 CSS、自动作用域和隔离预览；
- 任意文字选区的内联 CSS 特效、高级样式库、永久收藏与样式包导入导出；
- 标题目录、段落索引、查找、统计、缩放和专注模式；
- 会话内撤销 / 重做；
- 持久化刻点、双重差异审阅与安全回溯。

---

## ScriptoriumCollaborator v3.3 命令（Agent Port v5）

插件定义见 [`plugin-manifest.json`](../VCPDistributedServer/Plugin/ScriptoriumCollaborator/plugin-manifest.json)，服务实现见 [`ScriptoriumCollaboratorService.js`](../VCPDistributedServer/Plugin/ScriptoriumCollaborator/ScriptoriumCollaboratorService.js)。

| 命令 | 能力 | 是否修改当前窗口 |
| --- | --- | --- |
| `ListFonts` | 按语言范围列出系统真实字体 | 否 |
| `GetDocumentInfo` | 获取标题、类型、修订、保存状态与场景配置 | 否 |
| `GetRenderedText` | 获取 VDOCX 全文或 VPPTX 页面语义 | 否 |
| `GetOutline` | 获取临时章节索引或稳定页面目录 | 否 |
| `GetSection` | 按当前修订章节读取原始源码与编译语义 | 否 |
| `GetSource` | 按行读取正文、页面或独立 CSS 真源 | 否 |
| `SearchSource` | 字符串或正则检索一种或全部源码 | 否 |
| `GetViewportSource` | 获取人类当前视口附近的源码 | 否 |
| `GetVisualContext` | 同时返回 Markdown 摘要与实际截图 | 否 |
| `GetPrHistory` | 查询刻点、PR、状态与审批回执 | 否 |
| `SubmitSourcePr` | 提交一个或多个 target / replace 真源 PR | 审批后修改 |
| `AddSlide` | 提交完整末页 HTML Scene | 审批后修改 |
| `InsertSlide` | 在指定索引提交完整页面 | 审批后修改 |
| `DeleteSlide` | 提交页面删除 | 审批后修改 |
| `UpdatePresentationConfig` | 提交画布、主题与默认转场配置 | 审批后修改 |
| `CreateProject` | 规范化、审查并直接创建完整工程 | 不修改当前窗口 |
| `GetStorageInfo` | 查询直接落盘目录与覆盖规则 | 否 |

完整字段约定与调用示例以 [`plugin-manifest.json`](../VCPDistributedServer/Plugin/ScriptoriumCollaborator/plugin-manifest.json) 为准。当前插件清单版本为 `3.3.0`，浏览器侧 Agent 端口版本为 `5`。

插件支持 `command1`、`command2`、`command3` 等编号串行调用，也支持显式 `wait` / `sleep` / `delay`。步骤严格顺序执行；中途失败会停止后续步骤，但此前成功的 Markdown 文本和图片回执仍会保留。视觉上下文在指定 VPPTX 页面后会等待切页、资源和布局稳定；串行回执会保留此前成功步骤返回的全部文本和图片，并以 `partial_failure` 与 `failedStep` 标识中途失败。

### Agent 直接创建完整工程

`CreateProject` 不需要先打开一个空白窗口再逐段修改。Agent 可以一次提交完整 VDOCX 或 VPPTX，由 Scriptorium 内核执行：

1. 工程模型规范化；
2. Markdown 主导的混合源码与岛身份校验；
3. 可编程内容审查；
4. 依赖识别；
5. v2 容器打包；
6. 目标目录原子落盘；
7. 创建者署名与首个文脉节点写入。

默认重名策略是自动改名。显式覆盖必须同时提供目标文件当前 SHA-256，防止覆盖一个已在调用后发生变化的文件。

---

## 安全边界

Scriptorium 允许文档拥有程序能力，但不会把“可编程”误写成“无条件信任”。

默认防线包括：

1. **HTML 清理**：移除 iframe、object、embed、事件属性和危险 URL；
2. **CSS 清理**：移除 import、脚本 URL 与旧式 expression；
3. **依赖本地化**：支持的 Anime.js / Three.js CDN 映射到本地固定版本；
4. **外部脚本降级**：未知公网脚本变为不可执行审计声明；
5. **JavaScript 规则审查**：输出 allow、warn 或 refuse；
6. **运行时生命周期**：跟踪持续任务并在场景结束时释放；
7. **Electron 隔离**：渲染窗口不开放 Node.js integration；
8. **PR 审批**：脚本安全通过不代表 Agent 提案自动获得合并权。

refuse 规则覆盖 Node 模块、进程与文件系统、Electron / IPC、动态求值、构造器逃逸、宿主文档破坏、file URL 和特权导航。网络、持久化存储、全局事件、持续任务与 WebGL 会产生警告。

人类可以在本机经过二次确认后关闭脚本规则审查，但这不会关闭 CSP、依赖本地化或 Agent PR 审批。

> **重要说明：当前机制是面向创作文档的纵深防御，不是通用恶意 JavaScript 的形式化安全沙箱。不要在关闭审查后运行不可信文档。**

---

## 架构地图

| 边界 | 实现 |
| --- | --- |
| 混合源码编译与映射（`vdoc-hybrid-compiler/3`） | [`vdoc-hybrid-compiler.js`](vdoc-hybrid-compiler.js) |
| 渲染态源码编辑事务、Selection / IME / 剪切粘贴与局部结构恢复 | [`scriptorium-flow-editor.js`](scriptorium-flow-editor.js) |
| 连续流渲染、运行态快照分页与局部 patch | [`scriptorium-flow-renderer.js`](scriptorium-flow-renderer.js)、[`scriptorium-pagination.js`](scriptorium-pagination.js) |
| 渲染缓存与工作面协调 | [`scriptorium-render-coordinator.js`](scriptorium-render-coordinator.js) |
| 唯一文档模型与真源适配 | [`scriptorium-document-store.js`](scriptorium-document-store.js)、[`scriptorium-flow-adapter.js`](scriptorium-flow-adapter.js)、[`scriptorium-deck-adapter.js`](scriptorium-deck-adapter.js) |
| CodeMirror 真源工作面 | [`scriptorium-source-editor.js`](scriptorium-source-editor.js) |
| 可编程内容审查与依赖规范化 | [`scriptorium-programmable-content.js`](scriptorium-programmable-content.js) |
| 页面与岛运行时 | [`scriptorium-runtime.js`](scriptorium-runtime.js) |
| Agent 语义、源码、视觉与 PR 端口 | [`scriptorium-agent-port.js`](scriptorium-agent-port.js) |
| 双重差异 | [`scriptorium-pr-diff.js`](scriptorium-pr-diff.js) |
| 文脉、快照与回溯 | [`scriptorium-lineage-store.js`](scriptorium-lineage-store.js) |
| v2 ZIP 与内容寻址资源 | [`vdoc-container.js`](vdoc-container.js) |
| 基础工程模型 | [`vdoc-core.js`](vdoc-core.js) |
| 应用界面与模块装配 | [`scriptorium.html`](scriptorium.html)、[`scriptorium.js`](scriptorium.js) |

渲染侧采用按依赖顺序装载的浏览器模块，通过冻结的 `window.ScriptoriumXxx` 接口组合。文档仓库是模型唯一所有者；flow 与 deck 在编辑、渲染、导航和导出上拥有独立策略；共用控制器只依赖稳定端口。

---

## 启动

在 VCPChat 项目根目录安装依赖并启动 Electron：

```bash
npm install
npm start
```

启动后从 VCPChat 的“文坊”入口或托盘菜单进入 Scriptorium。插件调用也可以请求打开窗口；主进程控制服务会等待 Agent 端口就绪。

---

## 明确边界

Scriptorium 重新定义了自己的文档系统，但不假装已经解决所有办公软件问题：

- VDOCX / VPPTX 是 VCP 自有 v2 ZIP 工程，不与 DOCX / PPTX 二进制兼容；
- Office 文件导入是语义或静态版式转换，不保证无损往返；
- VDOCX 虽以 Markdown 作为普通正文的优先表达，但不是纯 Markdown 格式；HTML、CSS、LaTeX、Mermaid 和可编程岛的边界与运行语义属于格式本身；
- 分页器遵循 Web 富文档语义，不追求 Word 排版引擎逐像素一致；
- Markdown 渲染态编辑以“可证明还原原源码”为准，无法建立安全映射的区域会保持原子或拒绝编辑；
- 可编程岛、代码、Mermaid 与块级公式不会像普通段落一样任意跨边界编辑；
- VPPTX 尚不等价于完整桌面演示软件的组合、参考线和图层管理能力；
- SVG 支持源码级编辑，但不提供路径节点与布尔运算 GUI；全局 SVG 资产包的安全配额和清洗也不等价于通用 SVG 沙箱；
- 对象级 CSS 为保证可靠作用域分析，不接受任意复杂 at-rule；
- 会话撤销栈不是长期版本库，长期恢复应使用持久化文脉；
- 规则式脚本审查不是恶意代码形式化沙箱；
- 超大型 WebGL、长时间动画和复杂第三方脚本仍需要谨慎评估资源占用。

这些边界不是用来掩盖不确定性的免责声明，而是 Scriptorium 的设计原则：**无法证明安全、无损或可追踪时，宁可拒绝自动写入，也不伪造一次看似成功的编辑。**

---

## 它究竟做成了什么

Scriptorium 已经把过去互相冲突的几件事连接成一个真实闭环：

```text
人类直接编辑最终渲染结果
        ↓
编辑精确映射回唯一源码
        ↓
Markdown / HTML / CSS / LaTeX / Mermaid / 程序岛长期共存
        ↓
本地工程、资源与历史可独立保存
        ↓
Agent 同时理解语义、源码与真实画面
        ↓
Agent 提交署名、幂等、修订受保护的 PR
        ↓
人类审阅源码差异与渲染差异
        ↓
审批、回执、快照和回溯进入同一条文脉
```

真正重要的不是 Scriptorium “支持 Markdown”或“能运行 Three.js”。

真正重要的是：它证明了一份文档可以同时是 **人类自然书写的成品、Agent 精确操作的源码、受控执行的程序、可验证保存的工程，以及拥有作者与审批历史的共同作品**。

而在这一切发生时，作者点击渲染后的一个字，直接修改它；系统仍然知道这个字来自源码的哪里，仍然保留周围没有被触碰的一切。

这就是共笔文坊的核心。