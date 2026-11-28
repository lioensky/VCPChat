# 底栏与通用控件（music-dock）

总指南见 [../AGENTS.md](../AGENTS.md)。阅读包：`npm run music:context -- dock`。

## 文件

| 文件 | 全局 | 管什么 |
| --- | --- | --- |
| `music-dock.js` | `initMusicDock(app)` | 底栏播放条、白环播放头、进度细轨、统一面板（封面 / 歌词 / 控制 / 播放列表 / 声音）、全窗口快捷键、提示层 |
| `music-dock-queue.js` | `MusicDockQueue.create(ctx)` | 面板「播放列表」页：三段表、只画看得见的行、拖动排序、存为歌单、打开前预渲染 |
| `music-dock-stage-settings.js` | `MusicDockStageSettings.create(ctx)` | 控制页里的舞台设置：把舞台控制舱的几块搬进来、专属设置排序，以及「显示」一组 |
| `music-dock-fluid.js` | `createMusicDockFluid` | 播放条的 SVG 流体层（鼓包、水滴、切歌分裂） |
| `music-dock-palette.js` | `createMusicDockPalette`、`MusicDockPaletteQuery` | Ctrl+K 命令面板：搜歌 + 命令 |
| `music-dock-icons.js` | `MusicDockIcons` | 线性图标路径（Lucide，ISC）和自绘图标 |
| `music-fluid-kit.js/.css` | `MusicFluid` | 弹出层「长出来」等通用流体动作 |
| `music-fluid-marker.js` | `createMusicFluidMarker` | 一排选项下面跟着走的流体选中标记 |
| `music-fluid-select.js` | `MusicFluidSelect` | 把原生 `<select>` 换成主程序同款选项卡片（所有下拉都用它） |
| `music-toast.js` | `MusicToast` | 全窗口提示 |
| `music-dialog.js` | `MusicDialog` | 替代原生 `confirm()` 的确认框 |
| `music-playlist-picker.js/.css` | `MusicPlaylistPicker` | 「加入歌单」选择器：首页顶栏按钮和多选批量菜单都用它（最近用过置顶、打勾已含、筛选、就地新建、可撤销） |
| `music-dock.css` → `music-dock-panel.css` → `music-dock-drawer.css` | | 底栏样式按段拆开，顺序即层叠顺序：播放条/小环 → 统一面板、命令面板、toast、快捷键表 → 右侧抽屉和之后各轮打磨（后面覆盖前面）。颜色只用 `--md-*` / `--mt-*` 变量 |

## music-dock.js 里面的分段

文件按 `// ───────── 名字 ─────────` 分段，用这些名字搜索定位，不要按行号：
读状态 → 流体层 → 进度 → 胶囊悬停与快捷行 → 定时关闭 → 喜欢 → 播放按钮、切歌、两个槽位 → 曲目信息 → 音量 → 面板 → 播放队列页 →
舞台设置 → 声音页 → 状态订阅 → 全窗口键位 → 命令面板 → 提示层 → 首次渲染。

整个底栏是一个闭包 `initMusicDock(app)`，各段共享闭包里的 `state` 和 `render*`。
「播放队列页」「舞台设置」两段已经拆成 `music-dock-queue.js`、`music-dock-stage-settings.js`：代码原样搬过去，
共用的 `state`、`el`、小工具通过 `create(ctx)` 传入，返回的函数在 music-dock.js 里按原名解构出来用。再拆别的段照这个做。
**这个文件仍在巨型文件基线里**：新面板页、新控件写成新文件（库形状 `global.MusicDockXxx`），在 `initMusicDock` 里调用。

## 约定

- 只读 app 上的状态、只调 app 上已有的播放方法（`playTrack` / `pauseTrack` / `seekTo` / `loadTrack`），不碰 `music-player.js` 的竞态处理。
- 旧的按钮和滑块（`#volume-slider` 等）留在 DOM 里，音量仍经由它发给引擎。
- 状态变化靠 MutationObserver 和少量事件得知，不每帧轮询；进度只在播放时每 250 ms 刷一次。
- 声音页把经典视图里的音效卡整块搬进来（appendChild，不重建），离开时放回原处；不要改成复制。
- 进度细轨在面板关着时是 `visibility:hidden`（播放头拖动借它量尺寸），别改成 `display:none`。

## 测试与截图

`node scripts/test-music.mjs --module dock`。底栏测试用 jsdom 按顺序 eval `music-dock-icons → palette → fluid → queue → stage-settings → dock`；拆文件时同步改 tests/music-dock.test.cjs、music-toast、music-scan-outcome、music-time-format 的加载列表。
