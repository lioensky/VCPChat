# VMusic

VMusic 是 VCPChat 内置的桌面音乐播放器。它不是浏览器音频控件的简单封装，而是由 **VCP 自研 Rust 音频引擎**、**原创桌面播放器 GUI** 与 **实时歌词演出系统** 共同组成的一套完整音乐播放体验。

## 核心架构

VMusic 分为彼此解耦、通过明确协议协作的三层：

1. **VCP Rust 音频引擎**：负责音频加载、解码、DSP、重采样、输出、远程音频读取和播放状态。
2. **VMusic 播放器与交互层**：负责曲库、播放列表、WebDAV 管理、歌词、设置、播放控制以及桌面窗口交互。
3. **VMusic 歌词舞台**：消费统一的播放时钟、结构化歌词、主题和频谱快照，实时完成排版、分镜、动画、镜头与场景调度。

播放器前端通过 Electron bridge 和 WebSocket 与音频服务连接。播放状态只有一个权威来源；普通播放器与沉浸舞台不会各自维护一套独立的歌曲时间。

## 自研 Rubato f64 一体化音频引擎

VMusic 当前使用 VCP 自研的纯 Rust 一体化音频服务。整条播放链路以 `f64` 双精度样本为内部基础，并将过去分散的能力统一到同一运行时中：

- 本地文件与 HTTP(S) / WebDAV 远程音频加载；
- 音频解码与流式播放；
- 统一 DSP、卷积、动态响度、True-Peak Limiter 与 Noise Shaper；
- 基于 Rubato 4.0 的高质量重采样；
- 常见比例 FFT 重采样、专用 2× 半带 FIR 与特殊比例 Sinc 路由；
- Windows WASAPI 输出及独占模式；
- 播放进度、延迟、尾部、`finish` / `reset` 等完整流式语义；
- 面向实时线程的预分配与无动态分配处理约束；
- 频谱及音频特征数据输出，供播放器可视化和歌词舞台使用。

这里的 Rubato 是重采样基础库；围绕它构建的流式适配、路由策略、DSP 管线、状态管理、WASAPI 输出、WebDAV 播放及服务协议均属于 VCP 音频引擎工程的一部分。

音频引擎源码位于 [`rust_audio_engine`](../rust_audio_engine/)，播放器侧接入主要位于 [`music-player.js`](music-player.js)、[`music-output.js`](music-output.js) 与 [`music-webdav.js`](music-webdav.js)。

## 播放器 GUI 与交互引擎

VMusic 的主界面、状态组织、控制逻辑和桌面交互由 VCP 自主设计与实现，主要包括：

- 本地曲库、播放列表、搜索、排序与播放队列；
- WebDAV 服务器管理、目录浏览、扫描、导入和远程播放；
- 输出设备、WASAPI 独占、均衡器、DSP 与升频设置；
- 封面、进度、频谱、歌词和播放状态的统一呈现；
- 普通歌词的逐字高亮、弹性阻尼滚动、点击跳转和手动滚动接管；
- Electron 窗口环境下的播放控制、状态同步和资源生命周期管理。

主界面不是 Folia 的移植。播放器的 GUI 架构、页面组织、交互逻辑、状态接入和视觉实现均为 VMusic 自有实现。

主要前端入口为 [`music.html`](music.html)、[`music.js`](music.js) 和 [`music.css`](music.css)；各领域逻辑拆分在同目录的 `music-*` 模块中。

## 鲁棒歌词获取

VMusic 优先读取本地缓存；未命中时由后端执行多来源搜索、候选评分和逐级降级。当前歌词链路可聚合网易云音乐、QQ 音乐、酷狗音乐与 AMLL TTML Database 等来源，并支持：

- 普通 LRC；
- 逐字 YRC / KRC；
- TTML 高精度歌词；
- 原文、翻译和罗马音；
- 歌曲名、歌手、专辑与时长辅助匹配；
- 结构化歌词缓存；
- 网络失败或高精度歌词缺失时的渐进降级；
- 旧版文本歌词与结构化 `LyricData` 的兼容。

这套歌词获取链路的鲁棒性设计借鉴了 Folia 后端在多来源匹配和高精度歌词优先策略上的经验，并结合 VCP 的 IPC、缓存结构、数据格式与播放器需求重新实现。前端解析与呈现位于 [`music-lyrics.js`](music-lyrics.js)，聚合后端位于 [`lyricFetcherUnified.js`](../modules/lyrics/lyricFetcherUnified.js)。

## 沉浸式歌词舞台

标题栏中的舞台按钮可在普通播放器与沉浸式演出之间切换。舞台不是一组静态歌词皮肤，而是一套由 VCP 自主实现的 **演出调度、实时渲染与交互引擎**。

舞台宿主持续接收播放时间、逐字进度、歌词上下文、主题色和音频频段，并据此组织：

- 基于播放绝对时间的确定性动画；
- 逐字、逐词和逐句演出状态；
- 歌词语义布局与视觉层级；
- 场景生成、镜头移动和转场；
- DOM、Canvas、Pixi.js 与 Three.js 多渲染路径；
- 音频响应式背景、装饰和后处理；
- 节能、标准、极致三档质量策略；
- 模式参数持久化、暂停、恢复、缩放与销毁；
- 快速切歌、拖动进度和异步初始化时的代际保护；
- 有界缓存以及 Canvas、WebGL、监听器和动画资源回收。

舞台当前包含八种演出模式：

| 模式 | 演出方向 | 渲染特征 |
| --- | --- | --- |
| **凝彩 Tempera** | 实时图形歌词 MV | 色块分镜、网点、文字反色、逐字动势与 Pixi.js 后处理 |
| **商籁 Sonnet** | 编辑排版与节目包装 | 现代诗稿、HUD、标尺、几何装饰与镜头编排 |
| **镜台 Diorama** | 三维歌词空间 | Three.js 文字场景、空间路径、点云、景深与电影化运镜 |
| **浮名 Fume** | 连续文字世界 | 长卷文章构图、跨栏排版、逐字追焦与镜头飞行 |
| **流光 Luminous** | 辉光与呼吸 | 逐字光晕、弹性浮动、旋转和矢量伴奏 |
| **云阶 Partita** | 阶梯式节奏排版 | 语义分块、错落字阶、引导线与节奏脉冲 |
| **心象 Cadenza** | 空间化词片构图 | Pretext 断行、英雄词强调、非对称布局与镜头漂移 |
| **星诞 Starborn** | 自动演出导演 | 根据歌词密度、标点、段落边界和音频特征选择子舞台并转场 |

凝彩、商籁、镜台以及舞台中的大量矢量伴奏、场景装饰、参数系统、质量策略和交互动画包含 VCP 自有的原创视觉与工程设计。后续演进也不以复刻某个既有视觉器为目标，而是围绕歌曲、文字和实时音频继续建立 VMusic 自己的演出语言。

## 舞台运行时与资源边界

歌词舞台使用统一生命周期协议。宿主通常只保留一个活动模式；星诞转场时最多短暂持有当前与退场两个子模式。歌词切句也只保留受控数量的当前场景和退场场景。

模式不能直接控制播放后端。播放、暂停、切歌、音量和进度始终由播放器负责；舞台只消费状态快照并发出演出意图。所有模式均由宿主帧时钟驱动，不应私自创建无法追踪的永久帧循环。

核心实现包括：

- [`music-stage-runtime.js`](music-stage/music-stage-runtime.js)：歌词时间轴、逐字状态、频段聚合、主题快照和资源作用域；
- [`music-stage-host.js`](music-stage/music-stage-host.js)：舞台生命周期、帧分发、模式切换、设置和播放交互；
- [`music-stage-modes.js`](music-stage/music-stage-modes.js)：模式注册表与星诞自动导演；
- [`music-stage-config.js`](music-stage/music-stage-config.js)：八种模式的元数据、参数归一化和持久化；
- [`music-stage-advanced-modes.js`](music-stage/music-stage-advanced-modes.js)：高级渲染模式注册；
- [`modes`](music-stage/modes/)：各模式管理器、共享歌词演出、Pixi 特效与原创装饰；
- [`music-stage.css`](music-stage/music-stage.css) 与 [`stage-lyric-performance.css`](music-stage/modes/stage-lyric-performance.css)：宿主及歌词演出样式。

## Folia 灵感、适配与许可证说明

Folia / folia-major 为 VMusic 歌词舞台的早期探索提供了重要灵感。VMusic 借鉴了它将歌词视为“舞台演出”而非普通滚动字幕的交互理念，也参考了其部分模式的视觉语言、字素时序、语义布局、镜头追焦和光学处理思路。

需要明确区分以下边界：

- **VMusic 自有实现**：音频引擎、播放器主 GUI、舞台宿主、模式注册与调度、星诞导演、播放状态接入、配置系统、资源生命周期、质量策略，以及大量新增场景、装饰、动画与交互设计。
- **受 Folia 启发后原创实现的部分**：整体舞台交互风格、多种新演出组合和围绕 VCP 数据管线重新设计的视觉行为。
- **包含 Folia 代码适配或明确派生实现的部分**：Classic / Partita / Cadenza / Fume 相关歌词布局与演出组件，以及部分 Sonnet 光学、镜头和字素时序能力。相关源码文件保留了上游归属与 AGPL-3.0 注释。
- **歌词后端借鉴**：多来源搜索、高精度歌词优先和降级策略借鉴 Folia 后端的鲁棒性经验，VCP 侧按自身服务架构重新实现。

上游信息：

- 项目：<https://github.com/chthollyphile/folia-major>
- 作者：chthollyphile 及 Folia Contributors
- 许可证：GNU Affero General Public License v3.0
- 本地参考源码：`开发文档/folia-major-main`

Folia 的版权和许可证文本以其上游仓库及本地参考源码中的 `LICENSE` 为准。上述归属不涵盖 VCP 自研 Rust 音频引擎、播放器主界面和其他明确标注为 VCP 原创的实现。