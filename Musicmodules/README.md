# VCP Music Module

`Musicmodules` 是 VCP 桌面端音乐播放器的界面与前端控制模块。音频加载、解码、DSP、输出和频谱数据由 VCP 音频引擎提供，播放器 UI 通过既有 Electron bridge 与 WebSocket 接入这些能力。

## 沉浸式歌词舞台

标题栏中的圆形按钮用于进入或退出沉浸式歌词舞台。舞台以歌词演出为视觉中心，仅保留简约的曲目信息、封面、进度和基础播放控制。

首批舞台模式包括：

| 舞台名称 | Folia 对应模式 |
| --- | --- |
| 流光 | Luminous / Classic |
| 云阶 | Partita |
| 心象 | Mindscape / Cadenza |
| 浮名 | Fume |

舞台采用独立模块和统一生命周期协议。宿主保持一个活动模式；星诞交叉转场期间最多拥有两个子模式，新歌词演出切句时最多保留当前句和退场句两个场景。切换模式或退出舞台时清理所属渲染资源。普通播放器与沉浸舞台共享播放状态、歌词时间轴、频谱数据和动画帧时钟。

流光、云阶、心象已重建为独立管理器，共享字素时序、分层辉光、播放时间驱动的弹性运动与有界布局缓存。心象使用 Pretext 断行和词片空间构图。具体实现范围、与原作的差异和实机验收重点见 [三模式演出移植说明](music-stage/LYRIC-PERFORMANCE-PORT.md)。本轮未运行测试或进行客户端视觉验收。

主要实现位于：

- [`music-stage-runtime.js`](music-stage/music-stage-runtime.js)：歌词时间轴、逐词状态、频段聚合和资源作用域。
- [`music-stage-modes.js`](music-stage/music-stage-modes.js)：模式注册与星诞导演。
- [`luminous-manager.js`](music-stage/modes/luminous-manager.js)、[`partita-manager.js`](music-stage/modes/partita-manager.js)、[`cadenza-manager.js`](music-stage/modes/cadenza-manager.js)：三个独立歌词布局管理器。
- [`stage-lyric-layout.js`](music-stage/modes/stage-lyric-layout.js)、[`stage-lyric-performance.js`](music-stage/modes/stage-lyric-performance.js)：共享时序、显示布局与分层演出。
- [`music-stage-host.js`](music-stage/music-stage-host.js)：舞台生命周期、模式切换、参数和播放控制。
- [`music-stage.css`](music-stage/music-stage.css)、[`stage-lyric-performance.css`](music-stage/modes/stage-lyric-performance.css)：宿主及模式样式。

## UI 移植声明

`Musicmodules/music-stage` 下的沉浸式歌词舞台 UI，是对开源项目 **Folia / folia-major** 歌词视觉器设计与实现的移植、适配和改造。

- 上游项目：<https://github.com/chthollyphile/folia-major>
- 上游作者：chthollyphile 及 Folia Contributors
- 上游许可证：GNU Affero General Public License v3.0
- 本地参考源码：`开发文档/folia-major-main`
- 主要参考范围：Visualizer 共享契约，以及 Classic、Partita、Cadenza、Fume 模式
- 本项目改造：适配 VCP 原生 JavaScript 页面、现有歌词数据、VCP 播放状态与 VCP 音频频谱，并建立独立的模式生命周期和资源销毁机制

上述声明仅针对音乐模块中的歌词舞台 UI 移植部分。VCP 自研音频引擎、音频解码器、DSP、输出链路及其相关实现不属于 Folia UI 移植内容。

Folia 的完整版权与许可证文本以其上游仓库及本地参考源码中的 `LICENSE` 为准。