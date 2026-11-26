# 首页 / 档案页（music-archive）

总指南见 [../AGENTS.md](../AGENTS.md)。阅读包：`npm run music:context -- archive`。

## 分层（加载顺序即依赖顺序）

| 文件 | 全局 | 管什么 |
| --- | --- | --- |
| `archive-model.js` | `MusicArchiveModel` | 数据层：曲库和歌单整理成「列」（全部 / 自建歌单 / 专辑），纯函数 |
| `archive-scene.js` | `MusicArchiveScene` | Three.js 3D 档案卡阵列（实例化网格，只画视野内 9×32），帧率按档位和静止降频 |
| `archive-index.js` | `MusicArchiveIndex` | 检索索引：标题/歌手/专辑、拼音全拼与首字母、假名互通、首字母分组 |
| `archive-list.js` | `MusicArchiveList` | 左侧档案目录表：检索框、筛选、分组长列表、拖动排序、右键 |
| `archive-lyrics.js` | `MusicArchiveLyrics` | 右侧滚动歌词 |
| `archive-wall.js/.css` | `MusicArchiveWall` | 第二种视图「封面墙」 |
| `archive-grid.js` | `MusicArchiveGrid` | 分节网格视图 |
| `archive-view.js` | `MusicArchive` | 主视图：把上面拼起来，顶栏、布局切换（阵列 / 封面墙 / 平放 / 网格 / 经典列表）、键盘、和播放器对接 |
| `archive.css` → `archive-list.css` → `archive-lyrics.css` → `archive-tuning.css` | | 首页样式按段拆开，顺序即层叠顺序：主视图/HUD → 目录表 → 右侧歌词 → 后续各轮打磨（会覆盖前面的同名规则，改样式先在这里搜） |

## 约定

- 只通过 app 上已有的函数和字段和播放器打交道（`playlist`、`customPlaylists`、`currentTrackIndex`、`isPlaying`、`loadTrack`、`playTrack`、`pauseTrack`、`renderPlaylist`、`showContextMenu`、`stageHost`）。
- 首页偏好存 `localStorage`：`musicArchiveView`、`musicArchiveLayout`、`musicArchiveSort`、`musicArchiveListWidth` 等。
- 左目录、右设置抽屉开合时，其他区块让位、改长短，不被盖住（bento 布局）。
- 面板歌词页始终完整显示歌词。

## 测试与截图

`node scripts/test-music.mjs --module archive`。`tests/music-archive-view.test.cjs` 按现在的首页写（没有左上大标题、「播放这一组」「接着听」和取出详情；回车只播放，Shift+回车进舞台；歌词面板只由「歌词」按钮开合）。要测和 3D 场景打交道的部分，用文件里的 `withFakeScene`。
截图：`node tests/music-archive/shots.cjs`（Playwright + harness.html，不需要真引擎）。
