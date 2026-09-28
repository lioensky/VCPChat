# VCPChat — 分布式 AI 原生全栈引擎 (v2.0)

<p align="center">
  <img src="assets/E1-Vchat主界面.jpg" alt="VCPChat Banner" width="88%" style="border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.2);" />
</p>

<p align="center">
  <a href="vcpchatREADME_en.md">English</a> | 
  <a href="vcpchatREADME_jp.md">日本語</a> | 
  <a href="vcpchatREADME_ru.md">Русский</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Release-v2.0_NextVchat-6366f1?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/Electron-v44_(Node_ABI_149)-47848F?style=flat-square&logo=electron" alt="Electron" />
  <img src="https://img.shields.io/badge/Renderer-V4_Engine-10b981?style=flat-square" alt="Renderer" />
  <img src="https://img.shields.io/badge/Scriptorium-V3_Architecture-f59e0b?style=flat-square" alt="Scriptorium" />
  <img src="https://img.shields.io/badge/Audio-Rust_Rubato_F64-ef4444?style=flat-square&logo=rust" alt="Rust Audio" />
  <a href="https://deepwiki.com/lioensky/VCPChat"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki" /></a>
</p>

---

## 🌟 什么是 VCPChat？

> **VCPChat 不再仅仅是一个聊天客户端，它是一个打通 AI-UI-App-OS 边界的分布式全栈 AI 原生运行环境与可编程创作操作系统。**

传统 AI 交互长期局限于“单向文本流式输出”与“脆弱的标签拼接”。VCPChat 通过对前端 IPC、多媒体管线与后端 API 进行深度虚拟化解耦，实现了真正的**人机共生协作环境**：
- **人机共笔，唯一真源**：人类直观编辑渲染后的成品，Agent 精确修改底层源码，三态解耦对账仲裁，彻底杜绝 DOM 反序列化污染；
- **流式对话即高性能运行时**：V4 引擎彻底终结竞态，语义级 Div 岛隔离保护，涟漪渐进渲染与墓碑冻结驱动极限能效；
- **全景子程序操作系统**：涵盖编程协作、动态图表、富文档创作、Web 自动化、3D 视听舞台、神经拓扑记忆等 **27+ 官方独立子程序群**；
- **物理极限的轻量化**：V2.0 达成内存常态 **< 300MB**、**CLS 0.00** 零抖动、启动提速 35% 的惊人表现。

> ⚠️ **新手必读**：首次启动后请立即在「全局设置」中设置您的**用户名**，以避免系统依赖服务报错！  
> 🔗 **配套后端**：[VCPToolBox 核心生态](https://github.com/lioensky/VCPToolBox)  
> 📦 **资源扩展**：[下载壁纸包](https://github.com/lioensky/VCPChat/releases) | [下载音频解码包](https://github.com/lioensky/VCPChat/releases/tag/%E8%A7%A3%E7%A0%81%E5%99%A8core)

---

## 📑 目录

- [🌟 什么是 VCPChat？](#-什么是-vcpchat)
- [⚡ V2.0 时代：重磅架构跃迁](#-v20-时代重磅架构跃迁)
- [🏛️ 四大核心支柱 (Core Pillars)](#️-四大核心支柱-core-pillars)
  - [1. 📝 VCPScriptorium V3 — 原生可编程共笔文坊](#1--vcpscriptorium-v3--原生可编程共笔文坊)
  - [2. ⚡ VCPMessageRenderer V4 — 流式应用运行时](#2--vcpmessagerenderer-v4--流式应用运行时)
  - [3. 🎵 VMusic 舞台与纯 Rust 音频引擎](#3--vmusic-舞台与纯-rust-音频引擎)
  - [4. 🛠️ VCPProjectForge — V工程协同模组](#4-️-vcpprojectforge--v工程协同模组)
- [📱 官方全景子程序矩阵 (The Official App Suite)](#-官方全景子程序矩阵-the-official-app-suite)
  - [💬 对话与交互核心](#-对话与交互核心)
  - [📝 创作与全能生产力](#-创作与全能生产力)
  - [🧠 认知、记忆与深度研究](#-认知记忆与深度研究)
  - [🌐 Web 自动化与智能体互联](#-web-自动化与智能体互联)
  - [🛠️ 开发者工具与系统运维](#️-开发者工具与系统运维)
  - [🎨 视听、体感与趣味生活](#-视听体感与趣味生活)
- [🧠 认知决策前沿：JEV 扩散神经网络与自然语言调用](#-认知决策前沿jev-扩散神经网络与自然语言调用)
- [🚀 快速开始与环境部署](#-快速开始与环境部署)
- [🛠️ 技术栈与全栈解耦架构](#️-技术栈与全栈解耦架构)
- [📸 界面与视效展示](#-界面与视效展示)
- [📜 开源协议与免责声明](#-开源协议与免责声明)

---

## ⚡ V2.0 时代：重磅架构跃迁

经过持续全栈重构，VCPChat 2.0 (NextVchat) 在性能与交互范式上树立了全新标杆：

| 维度 | 突破指标 / 架构特性 | 带来的质变体验 |
| :--- | :--- | :--- |
| **极致能效表现** | **内存占用常态 < 300MB**<br>LCP 0.6s / CLS 0.00 / INP 8ms | 告别庞大 Electron 应用的笨重迟缓，启动速度跃升 35%，无微像素抖动，响应如丝般顺滑。 |
| **底层引擎换代** | **升级至 Electron 44**<br>统一 `NODE_MODULE_VERSION 149` | 深度优化现代 V8 执行效率与系统安全沙箱，原生 C++/Rust 模块彻底规避 ABI 失配。 |
| **Chat Kernel 独立** | **独立 Chat Core 与消息投影解耦**<br>独立 VCPAgentChatCore 服务 | 主聊天、分窗口、VoiceChat 与各子应用完全解耦，迟到数据与多话题异步事件互不串线。 |
| **NextUI 统一设计系统** | **声明式 Schema 设置**<br>全量样式归入 `styles/ui-system/` | 告别 `!important` 恶意竞争；动态直出标准化原语；全局磨砂模糊一次性计算；Retro 拟物动态图标套件。 |
| **多标签页与窗口管理** | **动态 IPC 标签页挂载**<br>自由拖拽生成独立物理子窗口 | 话题多标签拆分、子应用无缝挂载为主窗口标签页，支持动态生命周期预热与按需释放。 |
| **Rust 伴生套件体系** | **Rust 启动器 / 守护进程 / 麦克风监听** | 启动器可视化监听进程并持久化日志；无缝实现系统输入法穿透级语音捕获；SIMD 内存级时钟对齐。 |

---

## 🏛️ 四大核心支柱 (Core Pillars)

### 1. 📝 VCPScriptorium V3 — 原生可编程共笔文坊

> **人类负责主笔，AI 负责呈现；人类编辑渲染后的成品，AI 编辑渲染前的源码。**

VCPScriptorium 彻底抛弃了“富文本反序列化破坏 Markdown”的陈旧范式，构建了独立的源码保持型编译与渲染管线：

- **渲染态记事本级直接编辑**：
  直接在已经完成渲染的 Markdown、HTML、LaTeX 公式、Mermaid 图表、甚至 3D/JS 动画中修改文字、换行、圈选、设置粗斜体；所有操作均通过字符偏移映射精准落回底层真源，**不破坏周围未修改的代码结构**。
- **三态解耦与对账仲裁**：
  彻底解耦**输入态**、**渲染态**和**源码事件态**，建立独立事务队列仲裁机制，完美解决中文输入法 (IME) 合成与高频并发编辑下的竞态问题。
- **双原生工程模型**：
  - **VDOCX (`.vdocx`)**：面向文章与长篇流式文档，以 `markdown-hybrid` 为唯一真源，自带自研排版引擎与分页器，导出后可直接用现代浏览器打开并呈现完美分页的 Docx 布局（阅读器彻底解耦）。
  - **VPPTX (`.vpptx`)**：面向演示与交互发布，采用独立 HTML Scene 场景模型，自带 VCP 导播外框、自由坐标对象与可编程转场。
- **受控可编程岛 (Programmable Islands)**：
  支持在文档中嵌入 Anime.js、Three.js、Pixi.js、Python (Pyodide/本地原生)、LaTeX 与 Canvas。每个岛具备唯一的稳定语义 ID 与可释放生命周期，切页或重渲时自动清理定时器与动画帧。
- **文脉协同仓库 (Single Document as Git-like Repo)**：
  每份文档自带署名历史、版本分支与安全回溯。Agent 写操作统一走 **PR 提案协议**，支持在文脉面板中同时对比**源码差异 (CodeMirror Diff)** 与**隔离渲染差异**，由人类审核批准后幂等合入。
- **AI-Native 创作资产**：
  文字描边/发光/渐变及 SVG 图形全面资产化，Agent 可自主批量生成、检索并应用矢量图形与字体样式包。

---

### 2. ⚡ VCPMessageRenderer V4 — 流式应用运行时

V4 渲染引擎不再满足于“打字机逐字显示”，而是将每一条流式消息构筑为一个**高性能、自包含的隔离微型应用**：

- **彻底终结流式竞态**：
  采用流式会话 ID、代次序号（Revision Token）与消息身份三维校验。网络抖动、重试重发、快速切换话题时，旧任务与迟到数据无法跨界写入 DOM，杜绝串线与内容吞噬。
- **预览 — 终稿双阶段安全提交**：
  流式生成期采用低开销轻量管线渐进渲染；消息结束后统一切换至规范终稿并清空排队任务，彻底解决“流式期间正常、生成完毕后样式变样”的顽疾。
- **语义级 Div 岛防御**：
  即使 Agent 在流式生成中输出了未闭合、非对称嵌套的 `<div>`、`<script>`、`<style>` 或错误占位符，引擎仍能根据语义作用域自动收敛，绝不破坏消息外壳与主界面布局。
- **涟漪渐进渲染 (Ripple Rendering) 与滑动 AST**：
  优先渲染视口内的可视结构，超长历史消息基于滑动窗口移出全量解析，保持 $O(n)$ 线性解析开销。
- **墓碑冻结 V2 (Tombstone Freeze V2)**：
  动态内容离屏后即刻深度冻结，暂停 CSS 复合动画、`requestAnimationFrame`、WebGL 渲染循环与音频上下文；进入视口时事件唤醒，历史消息堆叠再多也近乎零 CPU/GPU 负载。
- **PreText / PreDOM 预排版与滚动器重构**：
  在文本与组件挂载前预估排版尺寸，消除布局抖动；修正 Windows 非 100% DPI 缩放下微尺度像素舍入误差，达成 **CLS 0.00** 零跳动表现。

---

### 3. 🎵 VMusic 舞台与纯 Rust 音频引擎

VMusic 实现了从传统播放器到**全沉浸视听舞台**的全面进化，兼具硬核 Hi-Fi 级声学输出与极富感染力的视觉呈现：

#### 🎨 豪华 8+1 大舞台演出模式 (PIXI.js / Three.js 双核驱动)
点击播放器顶部操作区的 **「进入歌词舞台 (✦)」**（或按 `Esc` 退出），即刻体验截然不同的视听艺术空间：

1. **🌈 凝彩 (Tempera)**：波普艺术与日系漫画网点 (Screentone MG)，色彩区块动态分镜与高对比字形反色逐字弹跳；
2. **📜 商籁 (Sonnet)**：现代杂志排版、HUD 瞄准具与科技线框，虚拟摄像机随节拍优雅推拉平移；
3. **🏛️ 镜台 (Diorama)**：Three.js 3D 空间星轨长廊、真实景深雾气与电影级手持推轨运镜（Tracking Shot）；
4. **🌫️ 浮名 (Fume)**：轻盈长卷流淌式排版，微风轻拂手绘几何粒子呼吸；
5. **✨ 流光 (Luminous)**：极简极光晕染，文字随歌手声线频率产生柔美扩散气晕；
6. **🎹 云阶 (Partita)**：琴键般错落律动的阶梯字块，极具节奏设计感；
7. **💫 心象 (Cadenza)**：超大字号聚焦与非对称留白，镜头微漂移带来深邃心灵共鸣；
8. **🚀 隧图 (Tunnel)**：3D 宇宙穿越与太空歌剧长廊，在纵深时空隧道中感受声浪冲击；
9. **🌌 星诞 (Starborn - 全自动 AI 导演模式)**：实时监听歌曲节奏、音频能量与叙事密度，抒情段切入“流光/镜台”，激昂高潮自动切入“凝彩/商籁”，全程全自动切镜换景！

#### 🎧 纯 Rust 音频动力核心
- **Rubato F64 连续 FIR 重采样**：放弃外部封装，全链路迁移至纯 Rust 实现，边际动态衰减达 205dB，音频处理延迟压入毫秒级；
- **全链路 64 位双精度浮点**：从解码、IIR 级联滤波 EQ 到动态噪声整形，提供最高数学精度；
- **硬核 Hi-Res 直通**：支持 Windows **WASAPI 独占模式** 与 **DSD 256bit 硬解码**；
- **AI 实时歌词与叙事理解**：无歌词歌曲可召唤 Agent 听歌识曲并即时生成毫秒级时间轴 `.lrc`，演出引擎自动理解歌词叙事感并智能避让 UI。

---

### 4. 🛠️ VCPProjectForge — V工程协同模组

> **告别黑盒与臃肿后台，让多 Agent 团队在透明、安全的工程熔炉中为您协同编程。**

将专用编程核心 VCPCode 完整移植并进化为 **VCPProjectForge**：

- **全流程可视化后台编程 (ProJectModule)**：
  在独立的 V工程子前端中实时追踪多 Agent 的并发编程流，支持多历史分支步进式回退与随时显式中止。
- **意图级与结构级精准编辑**：
  提供行级 Diff、意图级函数块选取、行范围代码圈选、剪切、粘贴、模糊函数定位（Fuzzy Function Matching）、一键大模块解耦拆分与自动语法合规化。
- **工程脉络与责任署名**：
  维护项目 TODO 清单、代码责任归属树、分支仲裁机制与编译测试沙箱环境。
- **VCPWorkBuddy 协同外挂**：
  允许 Agent 作为“主管”异步调度与鞭策外部 CLI（Claude Code、Codex、SnowCLI、Tencent CodeBuddy 等），在统一界面下享受外部算力输出。
- **全生态闭环**：与 **VCPCLI (内置持久化终端)** 及 **VCPCanvas** 紧密联动，支持在可交互白板与沙箱环境中直接预览与调试成果。

---

## 📱 官方全景子程序矩阵 (The Official App Suite)

VCPChat 内置了覆盖全工作流的官方子应用与工具套件，均已完成 V2.0 架构对接与多标签页支持：

### 💬 对话与交互核心

*   **NextVchat 主聊天**：支持话题多标签拆分、拖拽成独立物理窗口、多 Agent 管理与自主话题生成。内置 **AI 表情包 URL 修复器**，基于模糊匹配自动纠正 404 表情包；支持在气泡内渲染可交互 `<button>` 并在用户点击后精准回调事件。
*   **心流锁模式 (Flow Lock)**：一键锁定当前 Agent 与话题，阻断干扰。在该模式下，AI 具备自主思考与主动发起对话的能力，可自主配置冷却时限与引导语，实现长期复杂任务的自主闭环推进。
*   **高级回复 (VCPChatTavern)**：类 SillyTavern 的轻量无污染预设系统。兼容挂载 SillyTavern 角色卡、预设与世界书；支持深度注入、相对注入规则与拖拽排序；用户端规则仅作用于提交副本，保障真实历史与多端同步的纯净。
*   **VoiceChat 实时语音与 TTS**：基于独立 Rust 麦克风引擎实现穿透式系统语音捕获；深度集成 **GPT-SoVITS**，运用自研流式剪枝算法将合成延迟压降至毫秒级；业界首创基于正则切片的**双语混合朗读引擎**（如中日、中英无缝混读）。
*   **AskNova 客服**：内建全栈 VCP 源码与架构地图（基于 DeepWiki API），面向全平台用户的公共公益服务，无需自行配置 LLM API 即可随问随答。

---

### 📝 创作与全能生产力

*   **共笔文坊 (VCPScriptorium V3)**：前述原生双文档架构（VDocx 流式文章 / VPptx 场景演示），三态解耦仲裁，渲染态即刻直接编辑，文脉 PR 提案协作。
*   **V工程 (VCPProjectForge)**：前述代码级多 Agent 协作开发工坊，支持意图级/行级 Diff、分支回滚、TODO 追踪及 ProJectModule 全程可视化。
*   **V图表 (VChart)**：数据驱动的可视化子应用。Agent 无需反复编写冗长 JS/HTML，只需更新数据即可动态生成图表；内置 Anime.js、Three.js、Pixi.js 与 SQL 依赖注入，支持多种数据库与本地 JSON 接入，支持 Canvas PR/Merge 协作与独立浮窗。
*   **Canvas 协同画板**：革命性实时交互白板，支持人机多端零延迟共同编辑代码与 Markdown；内置沙箱化 IDE（支持客户端 Pyodide WASM 与 Python 系统级穿透执行），支持多版本时间轴图谱与一键差异对比回溯。
*   **VNote 笔记系统 & 迷你便签**：支持树状关系视图与双向标签；全局快捷键 `Win + Alt + Z` 极速呼出轻量便签；支持 Markdown/LaTeX/Mermaid 全格式渲染与图片粘贴自动转存；支持一键将聊天气泡与划选内容存入笔记并双向同步至 AI 核心知识库。
*   **独立翻译中心 (Translator)**：全语种互译工具，支持通过自然语言自由指定输出结构（如 LaTeX 布局、CSV 矩阵、Markdown 表格等）。
*   **V日报 (Daily News)**：AI 自主运行的虚拟新闻编辑部。扫描全球 100+ 主流门户、检索 2000+ 线索，自主挖掘热点并深度抓取全文与图片，自动编排成期刊级精美可交互 DIV 报纸。

---

### 🧠 认知、记忆与深度研究

*   **浪潮记忆中心 & 神经云图 (Memo)**：基于浪潮引擎构建全局记忆神经节点拓扑图谱，实时展现 Agent 间的认知能流与逻辑脉络。支持基于网络拓扑批量编辑与合并记忆；Rust 重构 Rivermemo 使得全链路记忆检索与上下文组装压入 **5ms 极速响应**。
*   **闪电深度研究 (Flash DeepSearch)**：激发由 VCP 驱动的“AI 研究员军团”。接收研究课题后，多并发探针闪电扫描全球学术资源与网络文献，经过逻辑提炼与交叉验证，在 2 分钟内交付引经据典的高水平学术级 Markdown 论文。
*   **灵视监控面板 (Vision Monitoring)**：悬浮式后台神级监控窗，实时追踪 Agent 的思维链（CoT）、回忆触发过程、拓扑寻道图谱、Agent 私信通信与后台任务动向。

---

### 🌐 Web 自动化与智能体互联

*   **VCP Loom 1.0 (Web 原生操作系统)**：通过 AgentWebCore 将现代 Web 转译为去噪交互语义树（Grounded Markdown）。Agent 无需解析繁琐 DOM，即可利用语义句柄实现高精度点击、输入与连续操作。
    - **节点画布流深度操控**：深度适配 ComfyUI、Dify 等复杂 Web 画布，AI 能像编辑文章一样轻松配置节点流、参数与连线。
    - **LoomSkill 录制与分发**：支持一键将连续操作录制为 Skill，支持无验证、语义验证与严格验证，后续直接通过自然语言触发复合任务。
*   **VCP 论坛 (Forum)**：专为 Agent 打造的社交广场。Agent 们可在论坛内发帖、回帖、圈选好友、点赞，并共享附件与交互图表，拥有独立的版块与社区生态。
*   **米家智能家居生态联动 (Mijia)**：打通物理与虚拟界限。全屋设备状态实时感知，支持自然语言万能控制，更具备前瞻性生活场景编排（如观影自动调光、关门提醒、耗材预警）。

---

### 🛠️ 开发者工具与系统运维

*   **VchatCLI 内置全功能终端**：UI 深度融入主程序，原生兼容 PowerShell 与 WSL；解决传统 AI 命令行交互无状态的痛点，支持持久会话与多指令流；内置安全的一键管理员提权机制。
*   **VchatManager 数据库与数据维护中心**：独立 Electron 可视化数据工具。支持对 `AppData` 数据进行一致性校验与修复，提供原始 JSON 深度编辑器、分类附件浏览器与多维度全局检索 (`Ctrl+F`)。
*   **VCP 人类工具箱 (HumanToolBox)**：自动将分布式服务器上的所有插件转化为直观的 GUI 控制表单，人类用户无需记忆代码即可直接配置并执行高阶 VCP 工具；支持精细化的流程条件与数据转换节点编排。
*   **插件管理中心 (PluginManager)**：支持插件配置热更新监控与 README 快速阅读，提供规范的 JevCall 权限声明机制。

---

### 🎨 视听、体感与趣味生活

*   **VMusic 沉浸视听舞台**：前述纯 Rust Rubato F64 连续 FIR 音频核心，9 大舞台演出模式（PIXI / Three.js 驱动），支持 AI 实时听歌写词与沉浸式声学互动。
*   **高级流媒体编辑器 (视听工坊)**：为 AI 打造的专业级视觉与听觉处理插件。支持任意窗口高精截屏、专业滤镜调色；搭载革命性**语义化图像编辑引擎**（艺术风格转换、智能元素提取重构、3D 打印工程图生成）；支持音视频精准剪辑、分离与帧级目标标注。
*   **3D 超级物理骰子**：基于 3D 物理引擎模拟真实碰撞，支持 d4~d100 任意骰子组合；内置十余款材质与独立音效包；AI 可施展“打滑骰子”、“磁铁骰子”、“黏着骰子”等趣味物理魔法。
*   **塔罗占卜与世界状态模拟**：基于严苛“宿命论计算核心”的占卜引擎，完全剔除伪随机数。综合读取太阳系行星天体倾角轨道、地表经纬天气、中国农历节气以及用户日程等物理变量生成唯一命运种子，输出精准确定的天相与逆位倾向。
*   **VCPSleep 睡眠助手**：为 Agent 赋予作息与生命体感。支持自定义睡眠时长、智能唤醒闹钟与睡前 Tips；在夜间睡眠时还会触发梦境概率模拟，让 AI 伙伴充满真实生命力。

---

## 🧠 认知决策前沿：JEV 扩散神经网络与自然语言调用

传统的 AI 工具调用依赖僵化、易出错的硬编码 JSON 格式。VCPChat 正式引入全新的决策与调用范式：

```
<<<[TOOL_REQUEST]>>>
maid:「始」Nova「末」
JEV:「始」在[1分钟后]设置闹钟，提醒我【检查烤箱里的点心】。「末」
<<<[END_TOOL_REQUEST]>>>
```

- **JEV 扩散神经网络**：后端与前端集成毫秒级 JEV 扩散决策模型，255 组特征决策耗时仅 300ms，在群聊发言仲裁、动态路由中大幅超越传统分类器；
- **自然语言免硬编码调用**：采用 `{类型}` `工具类` `【目标】` `[约束]` 四重自然语言层级表达。底层通用解析器将自然语言自动编译为对应工具指令，仅在极端模糊时介入 JEV 快速裁决（10000 组压测中成功直译达 99.7%）；
- **JevCallBridgeEXP**：插件开发者只需在配置中声明 `JevDesPrompt` 裁决词与提示词，即可全量接入自然语言工具生态。

---

## 🚀 快速开始与环境部署

### 推荐运行入口

1. **普通用户（一键图形启动器）**：
   - **Windows**：双击运行 [`launchers/VCPChat-Launcher.vbs`](launchers/VCPChat-Launcher.vbs) 或 `启动Vchat.vbs`（后台静默，无黑框）；
   - **macOS**：运行 [`launchers/VCPChat-Launcher.command`](launchers/VCPChat-Launcher.command)；
   - **Linux**：运行 [`launchers/VCPChat-Launcher.sh`](launchers/VCPChat-Launcher.sh)。
2. **开发者与诊断**：
   - 运行 `npm run vcpchat` 可启动带异常诊断的开发环境；
   - 调试主进程直接运行 `npm start`。

---

### 安装步骤

#### 1. 克隆代码仓库
```bash
git clone https://github.com/lioensky/VCPChat.git
cd VCPChat
```

#### 2. 安装 Node.js 依赖与原生模块重编译 (针对 Electron 44)
VCPChat 的 SQLite、终端与图像处理底层依赖原生模块：
```bash
npm install
npx electron-rebuild -f --only better-sqlite3,node-pty,sharp
npm run doctor -- --deep
```
> 💡 **版本与 ABI 说明**：Electron 44 使用 `NODE_MODULE_VERSION 149`。本项目锁定 `better-sqlite3 13.x` 与专用 `node-abi`。遇到任何 ABI 不匹配或 `Error invoking remote method 'get-agents'` 报错时，请执行带 `-f` 参数的完整 rebuild 并进行 deep 诊断。

#### 3. 安装 Python 扩展依赖 (音频与高级 AI 服务环境)
```bash
pip install -r requirements.txt
```

#### 4. 专属场景启动脚本
- **主程序 + VCPDesktop 桌面**：双击 [`启动全部.vbs`](启动全部.vbs)；
- **仅启动 VCPDesktop 独立桌面**：双击 [`start-desktop.vbs`](start-desktop.vbs)；
- **仅启动 RAG 记忆观察器**：双击 [`start-rag-observer.vbs`](start-rag-observer.vbs)。

---

## 🛠️ 技术栈与全栈解耦架构

```
┌────────────────────────────────────────────────────────────────────────┐
│                        前端交互层 (Presentation)                        │
│   NextUI Design Tokens  │  Pixi.js v8 / Three.js  │  Anime.js / KaTeX  │
├────────────────────────────────────────────────────────────────────────┤
│                       核心渲染与运行时 (Runtime)                        │
│   VCPMessageRenderer V4 │ Scriptorium V3 编译器   │ PreText 预排版引擎 │
├────────────────────────────────────────────────────────────────────────┤
│                       服务与协议层 (Core Services)                      │
│   Chat Kernel / VCPAgentChatCore  │  JEV 扩散推理引擎  │  Loom WebCore  │
├────────────────────────────────────────────────────────────────────────┤
│                       硬核系统与计算层 (Native)                         │
│   Rust Rubato F64 音频  │ Rust 麦克风监听 │ Node-PTY │ Sharp │ SQLite  │
└────────────────────────────────────────────────────────────────────────┘
```

- **平台宿主**：Electron 44 (ABI 149) + Node.js
- **图形与动效**：Pixi.js v8、Three.js、Anime.js、HTML5 Canvas
- **文档与编译**：VCPScriptorium 自研分页与排版引擎、CodeMirror 6、Mermaid、KaTeX
- **系统底层**：
  - **Rust**：`rust_audio_engine` (Rubato F64、WASAPI 直通)、`rust_voice_input_engine` (系统级穿透监听)、`rust_chat_data_service`
  - **Python**：Pyodide (WASM 端运行)、本地 Python 服务 (GPT-SoVITS、音视频剪辑分析)
  - **C++ 原生**：Node-PTY (终端控制)、Sharp (高吞吐图像处理)、Better-SQLite3

---

## 📸 界面与视效展示

<table width="100%">
  <tr>
    <td width="50%" align="center">
      <img src="assets/E1.5-Vchat前端应用群.jpg" width="100%" style="border-radius: 8px;" /><br>
      <b>NextVchat 前端应用群</b>
    </td>
    <td width="50%" align="center">
      <img src="assets/E5-V文坊.jpg" width="100%" style="border-radius: 8px;" /><br>
      <b>VCPScriptorium 共笔文坊</b>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="assets/E4-音乐播放器.jpg" width="100%" style="border-radius: 8px;" /><br>
      <b>VMusic 沉浸视听舞台</b>
    </td>
    <td width="50%" align="center">
      <img src="assets/E3-VCP桌面.jpg" width="100%" style="border-radius: 8px;" /><br>
      <b>VCPDesktop AI 原生桌面</b>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="assets/E8-基于浪潮的语义级记忆关联可视化神经云图.jpg" width="100%" style="border-radius: 8px;" /><br>
      <b>浪潮记忆拓扑神经云图</b>
    </td>
    <td width="50%" align="center">
      <img src="assets/E9-Agent论坛与留言板系统.jpg" width="100%" style="border-radius: 8px;" /><br>
      <b>Agent 专属交互论坛与广场</b>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="assets/E7-划词小助手应用于Vscode编程解释和辅助生成代码.jpg" width="100%" style="border-radius: 8px;" /><br>
      <b>全局划词小助手与 IDE 协同</b>
    </td>
    <td width="50%" align="center">
      <img src="assets/E6-终端与日志.jpg" width="100%" style="border-radius: 8px;" /><br>
      <b>VCPCLI 终端与分布式实时日志</b>
    </td>
  </tr>
</table>

---

## 📜 开源协议与免责声明

### 许可协议

本作品采用 **知识共享署名-非商业性使用-相同方式共享 4.0 国际 (CC BY-NC-SA 4.0)** 许可协议。

<p align="left">
  <a rel="license" href="http://creativecommons.org/licenses/by-nc-sa/4.0/">
    <img alt="知识共享许可协议" style="border-width:0" src="https://i.creativecommons.org/l/by-nc-sa/4.0/88x31.png" />
  </a>
</p>

您可自由分享并修改本工程，但必须遵守以下条件：
- **署名 (Attribution)**：必须给出适当署名并保留原始作者信息与项目链接；
- **非商业性使用 (NonCommercial)**：不得将本作品及其衍生品用于任何商业目的；
- **相同方式共享 (ShareAlike)**：任何二次创作必须使用完全相同的协议公开发布。

### 免责声明

本软件按“原样”提供，不包含任何明示或暗示的担保。作者与贡献者不对使用本软件所产生的任何直接、间接损失承担连带责任。
