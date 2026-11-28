# VMusic 开发指南（给 agent 和人）

VMusic = VCPChat 的音乐窗口：Rust 音频引擎 + Electron 主进程 + 音乐窗口渲染端（首页、经典视图、底栏、歌词舞台）。
产品介绍看 [README.md](README.md)；这份文件只讲**代码在哪、改哪里、怎么验证、哪些线不能碰**。

## 开工前三步

```sh
npm run check:music                  # 结构守卫：文件归属、死文件、全局名、巨型文件棘轮、app 多处写入棘轮、舞台登记一致
npm run music:context -- <模块|文件>   # 打印阅读包：该模块的文件、导出、依赖、在 app 上定义/借用的属性、相关测试
npm run test:music                   # 全部音乐测试，和已知失败清单比对，只有「新失败」才算挂
```

`npm run music:context -- music-dock.js` 也可以直接给文件名。这三个命令要在 git 检出里跑，需要仓库里的 tests/ 和 scripts/。先读阅读包，再打开大文件；不要把 100 KB 的文件整份塞进上下文。

模块登记表是 [architecture.json](architecture.json)：每个音乐相关文件只属于一个模块，模块写明用途、文档、测试和调试脚本。
**新增文件先在登记表里给它找模块**，否则 `check:music` 不过。

## 架构总图

```
Rust 音频引擎 rust_audio_engine/（HTTP + /ws 状态推送，端口见 modules/services/audioEngineEndpoint.js）
        ▲ HTTP（musicHandlers.audioEngineApi）            ▲ WebSocket（渲染端 app.connectWebSocket，在 music-visualizer.js）
        │                                                 │
主进程 modules/ipc/musicHandlers.js ── 窗口、播放/曲库/歌单 IPC、AI 点歌转发
       ├─ musicEngineHandlers.js  引擎设置（设备、EQ、DSP、预载、IR）  ├─ musicLyricsHandlers.js  歌词读取/抓取/候选
       ├─ musicWebdavHandlers.js  WebDAV                              └─ musicM3u.js / musicDesktopLyrics.js
        ▲ ipcMain.handle / on
预加载 preloads/api/music.js（utility 角色）→ 页面上的 window.utilityAPI，在渲染端是 app.api
        ▲
渲染端 Musicmodules/music.html → music.js 建 app 对象 → 各模块 setupX(app) 往 app 上挂方法
   ├─ player   播放与引擎桥（唯一会发引擎请求的一层）
   ├─ library  曲库/歌单/队列/喜欢/统计/电台……
   ├─ lyrics   歌词显示、AI 找词、桌面歌词
   ├─ classic  经典列表视图 + 全局皮肤与色彩变量
   ├─ archive  首页（默认视图）
   ├─ dock     底栏 + 统一面板 + 命令面板 + 通用控件（toast/对话框/下拉）
   ├─ stage-*  歌词舞台：宿主 + 各模式
   └─ intro / visuals
AI 点歌：VCPDistributedServer/Plugin/MusicController → 主进程 handleMusicControl → 音乐窗口
```

旧版界面 `Musicmodules-legacy/` 是上游原样拷贝，**冻结**（见下面红线）。主进程按 settings.json 的 `musicLegacyUI` 选加载哪个页面。

## 渲染端是怎么拼起来的

- 没有打包器。`music.html` 用一串 `<script>` 按顺序加载经典脚本，**加载顺序就是依赖顺序**；新文件要插在它依赖的文件之后。
- 模块对外只有两种形状：
  1. 库：`(function (global) { … global.MusicXxx = {…}; })(window)`，纯函数/工厂，不碰 app。
  2. 功能：`setupXxx(app)`，往 app 上挂方法和状态，在 `music.js` 的 `init()` 里按顺序调用。
- `app` 是全窗口唯一的状态中心（`music.js` 里建）。**谁定义一个 app 属性，谁就是它的主人**；别的模块读它、调它的方法，不直接改它。
  `npm run music:context -- <模块>` 会列出该模块在 app 上定义的、和别人共写的、借用别人的属性。
- 跨模块通知用 `window` 上的 `music-*` 自定义事件（`music-queue-change`、`music-like-change`、`music-stats-change`、`music-queue-source-change` 等），不要再包一层别人的方法。
- 状态更新来源：引擎状态 → `app.updateUIWithState(state)`（music.js）→ 各处读 `app.isPlaying` / `app.lastKnownCurrentTime` 等。播放时间只有这一个权威来源，舞台和底栏都从它推。
- 持久化：窗口偏好放 `localStorage`，键名统一 `music` 开头（`musicStageConfig`、`musicArchiveView`、`musicPlayStats`……）；曲库/歌单/设置走主进程存盘（`get-music-playlist`、`save-custom-playlists`、`music-save-settings`）。

### 启动顺序（`music.js` → `init()`）

```
setupUtils → setupAmbientPixi → setupVisualizer → setupLyrics → setupPlayer → setupOutput → setupEffects
→ setupWebDav → setupSidebar → setupUI → setupMusicStage → setupMusicSkin → MusicArchive.init
→ 事件/IPC 监听 → setupMusicLikes → Goto → Sleep → Stats → Radio → Spectrum → DeviceSound → M3u
  → TrackFile → Folders → EqPresets → Channels → WindowTitle → QueueUndo → LyricsAi → Smart → DesktopLyrics
→ 连引擎 WebSocket → 主题 → 开场 → initMusicDock → 读曲库/恢复上次会话
```

后装的模块可能包住先装的方法（见「已知历史债」），**调整顺序前先跑 `npm run music:context` 看共写属性**。

## 改什么去哪里

| 想改的东西 | 去哪里 | 备注 |
| --- | --- | --- |
| 播放/暂停/切歌/跳转/无缝/预载 | `music-player.js` | 竞态多，改前读 tests/music-playback-races.test.js |
| 输出设备、独占、位深 | `music-output.js`、`music-device-sound.js`；主进程 `modules/ipc/musicEngineHandlers.js` | 设备以名字为准，id 只是列表下标 |
| EQ、响度、饱和、交叉馈送、卷积 | `music-effects.js`、`music-eq-presets.js`、`music-channels.js` | 引擎参数名见 rust_audio_engine/src/server |
| WebDAV | 渲染端 `music-webdav.js`，主进程 `modules/ipc/musicWebdavHandlers.js` + `modules/webdavManager.js` | 报错文案统一走 `app.webdavReason` |
| 曲库扫描、增量、监视文件夹 | `modules/musicLibraryScanner.js`、`musicScannerWorker.js`、`musicLibraryWatch.js` | 主进程，改完要重启整个 VCPChat |
| 歌单侧栏、右键菜单 | `music-sidebar.js`（菜单入口在 music.js `app.showContextMenu`） | 喜欢、转到、菜单作用范围都用 `MusicAppHooks` 挂在 `showContextMenu` 上 |
| 歌词显示/滚动/点击跳转 | `music-lyrics.js` | 读词/抓词 IPC 在 `modules/ipc/musicLyricsHandlers.js`，抓词实现在 `modules/lyrics/` |
| 首页（档案阵列、封面墙、目录表、检索） | `music-archive/` | 见 [music-archive/AGENTS.md](music-archive/AGENTS.md) |
| 底栏、面板、命令面板、toast、对话框、下拉 | `music-dock/` | 见 [music-dock/AGENTS.md](music-dock/AGENTS.md) |
| 歌词舞台（加模式、改某个舞台） | `music-stage/` | 见 [music-stage/AGENTS.md](music-stage/AGENTS.md) |
| 颜色、字号、圆角 | `music-theme/music-tokens.css`（`--mt-*` / `--md-*`） | 组件里不写死颜色 |
| 新 IPC 接口 | `preloads/api/music.js` 加一行 + `modules/ipc/musicHandlers.js` 注册 | 见 preloads/README.md |
| AI 点歌/读歌词/指定舞台 | `VCPDistributedServer/Plugin/MusicController/` + musicHandlers `handleMusicControl` | |

下拉、开关等选项控件用全局同款（`music-dock/music-fluid-select.js`），不要用原生 `<select>` 的样子。

## 验证

- `npm run test:music`：约 40 秒，应当全过。[tests/music-known-failures.json](../tests/music-known-failures.json) 现在是空的：界面改了就同步改测试，不要往清单里塞新失败。
  修好一条就从清单删一条；**不要把新回归加进清单**。
- `node scripts/test-music.mjs --module <id>`：只跑一个模块；`node scripts/test-music.mjs tests/x.test.js`：只跑一个文件。
- 渲染端测试用 jsdom `window.eval(文件内容)` 按 music.html 的顺序加载脚本；拆文件时要同步改测试里的加载列表。
- 截图/性能脚本登记在各模块的 `tools`（`music:context` 会列出），用 Playwright + stub 起页面，不需要真引擎。
- 装配或舞台外观的重构：重构前后各跑一次 `node tests/music-window-bench/surface.cjs --out=a.json`（`--root=` 可指向另一份检出），diff 两份指纹（app 上每个属性的类型、每个舞台的类、页面报错）应当相同。
- 云端没有声卡：引擎能起，但 `is_playing` 不会变 true；播放态的帧率数据不可信。

## 装到运行中的 VCPChat

1. 先比对：运行目录里的文件可能被别的工具改过，哈希和你分支的基线不同就先三方合并，不要覆盖。
2. 覆盖前备份原文件和哈希。
3. 写入用 git 里的原始字节（Windows 上常开 `core.autocrlf=true`，不要在运行目录里 checkout 或 sed）。
4. 生效：渲染端文件重开音乐窗口即可；`modules/`、`preloads/`、`main.js` 要完整重启 VCPChat；引擎要托盘退出后再换 exe。

## 红线

- `Musicmodules-legacy/` 冻结：除 `legacy-bridge.js` 外一个字节都不能改（跟进上游时整份重新拷贝并重新生成哈希）；`tests/music-legacy.test.js` 按 `UPSTREAM.sha256` 核对。
- 不在代码注释、测试名、提交信息、PR 描述里写其他参考项目的名字或舞台取材的真实地名，用中性说法。
- 带 Folia 派生代码的文件保留顶部 AGPL-3.0 归属注释。
- 不提交用户数据、模型、Cubism Core、个人机器上的路径。
- 不改界面外观和行为的重构，要能证明等价（同一组测试、拆 CSS 时拼接结果逐字节相同）。

## 守卫规则（`npm run check:music`）

| 规则 | 失败时怎么办 |
| --- | --- |
| 每个文件属于且只属于一个模块 | 在 architecture.json 给它找模块 |
| Musicmodules 下的 js/css 必须被某个页面加载 | 死代码删掉；确有他用登记到 `unloadedAllowed` 并写明谁用 |
| 全局名不重复 | 换名字 |
| 新文件不超过 64 KB；基线里的巨型文件不能再长 10% 以上 | 新功能放新文件；或先拆分。拆小以后跑 `node scripts/music-arch.mjs baseline` |
| app 属性不新增写入方 | 调主人提供的方法或发 `music-*` 事件；确需共写，在评审里更新基线 |
| 舞台模式在登记表、配置、主进程白名单、AI 点歌别名、music.html 里一致 | 按 [music-stage/AGENTS.md](music-stage/AGENTS.md) 的清单补齐 |
| 音乐测试都登记在某个模块下 | 加到对应模块的 `tests` |
| 不手写包装 app 方法（`const base = app.x; app.x = (...) => base(...)`） | 用 `MusicAppHooks.before / after / wrap` |

基线（`sizeBaseline`、`appWriterBaseline`）只在评审过的改动里更新：变小随时可以，变大要说明理由。

## 给 app 方法加前后逻辑

要在别人的 app 方法前后做事（右键菜单打开前刷新菜单项、引擎状态回写后看声道……），用 `Musicmodules/music-app-hooks.js`：

```js
MusicAppHooks.before(app, 'showContextMenu', 'likes', () => paint());
MusicAppHooks.after(app, 'updateUIWithState', 'channels', (result, state) => { /* ... */ });
const remove = MusicAppHooks.wrap(app, 'renderPlaylist', 'classic-list', (base) => (filtered) => base(sorted(filtered)));
```

- 后装的先跑，和 setup 调用顺序一致；`MusicAppHooks.list(app)` 列出每个方法被谁包过。
- `before` 的错误照常抛，`after` 的错误只警告；要改参数、等异步结果就用 `wrap`。
- 返回的 `remove()` 用于销毁时拆掉（只在自己还在最外层时生效）。
- 文件里用 `(global.MusicAppHooks || require('./music-app-hooks.js'))`，这样 node 测试直接 require 也能用；jsdom / vm 里加载脚本的测试要先加载 `music-app-hooks.js`。

## 已知历史债（按影响排序，治理中）

1. ~~方法套娃~~ 已改成 `MusicAppHooks`（见上面「给 app 方法加前后逻辑」）。原来手写包装的 18 处（13 个文件）都换了，顺序不变。
2. **共写的列表状态**：`app.currentFilteredTracks`（11 个文件写）、`app.customPlaylists`（7 个）、`app.filteredPlaylistSource`（6 个）、`app.currentTrackIndex`（5 个）。
3. **装配散落**：`connectWebSocket` 住在 `music-visualizer.js`。
4. **巨型文件**：19 个超过 64 KB（`music:context` 里标了「别再往里加」），最大的是 diorama-world.js 388 KB、tunnel-manager.js 280 KB。music-dock.js 已拆出播放列表页和舞台设置（148 → 125 KB），music-stage-host.js 已拆出边框频谱（115 → 103 KB）；拆法见 music-dock/AGENTS.md。
5. **加一个舞台要改 6 个文件**（`check:music` 会核对是否一致）。

治理进度和每批 PR 记在 PR 描述里；做完一项就把上面对应条目删掉或改写。
