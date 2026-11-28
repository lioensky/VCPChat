# 歌词舞台（music-stage）

总指南见 [../AGENTS.md](../AGENTS.md)。阅读包：`npm run music:context -- stage-host`、`npm run music:context -- <模式文件名>`。

## 分层

```
music-stage-runtime.js   MusicStageRuntime   每帧的播放快照 createFrame(app, now)、歌词归一化、频段、DisposableScope
music-stage-config.js    MusicStageConfig    模式元数据 MODE_META、默认值、归一化、localStorage 'musicStageConfig'（带 VERSION/ADDED_IN 迁移）
modes/stage-mode-utils.js MusicStageModeUtils makeModeBase、帧率上限、像素预算、种子随机等模式共用工具
modes/*-manager.js       MusicStage<Name>Manager  每个模式一个工厂 { create(container, services) }
music-stage-advanced-modes.js                进阶模式登记（id、中文名、manager）
music-stage-modes.js     MusicStageModes     核心三模式 + 进阶登记合成注册表；星诞（starborn）自动导演
music-stage-host.js      setupMusicStage     舞台开关、唯一帧时钟、模式创建/销毁/软切换、设置抽屉、顶栏控件
music-stage-edge.js      MusicStageEdge      窗口外圈的边框频谱（四条细画布），宿主每帧 edge.draw(frame)
music-stage*.css                             宿主样式：music-stage.css（骨架、顶栏、切换器、歌词基础）、-core-modes（流光/云阶/心象/浮名/星诞）、
                                             -settings（响应式、浅色主题、设置抽屉）、-pixi-3d（凝彩/商籁/镜台）
modes/<id>.css                               各模式自己的样式（tunnel、inkdraft、fogpane、lumiere、hanabi、clockwork、orbit、signal、groupchat、impression）
```

依赖只能往下：模式不能引用 host，host 只通过注册表创建模式。

## 模式契约

`create(container, services)` 返回 `makeModeBase(id, label, container, services)` 得到的对象，再覆盖需要的方法：

| 方法 | 谁调用 | 要求 |
| --- | --- | --- |
| `updateFrame(frame)` | 宿主帧时钟（标准档 ≤60 fps，3D 模式自己限帧，极致档不限） | 只根据 `frame` 画；不要自己开永久 `requestAnimationFrame` 循环 |
| `resize()` / `updateTheme()` / `updateTrack()` / `updateLyrics()` / `updateConfig(next)` | 宿主 | 可选 |
| `suspend()` / `resume()` / `activate()` | 宿主 | 窗口隐藏、舞台关掉时停画 |
| `destroy()` | 宿主 | 释放 canvas、WebGL、监听器、定时器。用 `mode.scope.add/listen/timeout` 登记的会自动释放 |

`services` 里有 `app`（只读播放状态）、`config`、`generation`、`isCurrentGeneration(gen)`：异步加载（纹理、字体）回来时先查代际，切歌/切模式后的晚到结果直接丢掉。

`frame` 的字段见 `music-stage-runtime.js` 的 `createFrame`：`playbackTime`、`isPlaying`、`lines` / `activeLine` / `currentLineIndex` / `lineProgress` / `nextLines`、`audio`（bass/vocal/treble/power）、`viewport`、`track`。

红线：模式**不能**控制播放（播放、暂停、切歌、音量、进度都归播放器）；只读 `services.app`，不写。

## 新增一个舞台（当前要改的地方）

`npm run check:music` 会核对第 3–6 项是否一致，漏了会直接报出来。

1. `modes/<id>-manager.js`：导出 `global.MusicStage<Name>Manager = { create }`。超过 64 KB 就拆成 `<id>-*.js`。
2. `music.html`：在 `music-stage-advanced-modes.js` 之前加 `<script src="music-stage/modes/<id>-manager.js">`。
3. `music-stage-advanced-modes.js`：`managers` 和 `definitions` 各加一行。
4. `music-stage-config.js`：`MODE_META` 加元数据，`DEFAULTS.enabledModes` 加 id，`DEFAULTS.modes.<id>` 写默认参数，`VERSION` 加 1 并在 `ADDED_IN` 记 `<id>: 新版本号`（老用户的启用列表会自动补上）。
5. `modules/ipc/musicHandlers.js` 的 `supportedStageModes` 加 id。
6. `VCPDistributedServer/Plugin/MusicController/music-controller.js` 的 `stageModeAliases` 加英文 id 和中文名，报错文案里的列表和 `plugin-manifest.json` 的说明同步。
7. 画面自己铺满、是 3D 场景或浅色主题下仍是夜色：在 `music-stage-advanced-modes.js` 那一行写 `traits: { opaque / scene3d / night }`（宿主、开场都从 `MusicStageModes.traits(id)` 读，不要另写名单）。
8. 样式：新建 `modes/<id>.css`，首行注释 `/* 中文名（id）：一句话说明 */`，选择器以 `.music-stage-mode-<id>` 开头；在 music.html 里 `modes/impression.css` 之后、`stage-lyric-performance.css` 之前加 `<link>`。
   舞台样式的 `<link>` 顺序就是层叠顺序，不要调换。
9. 测试：至少一条创建→若干帧→销毁不泄漏的用例（参考 tests/music-stage-lifecycle.test.js）。

## 质量与性能

- 三档 `energy-saving` / `standard` / `ultimate`，宿主按档位和 `updateDegradeNote` 降级；3D 模式画布受像素预算限制（`stage-mode-utils.js`）。
- 先评估效果和代价，不照搬吃性能的做法；静止时降帧、窗口隐藏时不画。
- 调试脚本：`tests/music-stage-bench/`（bench、leak、transitions、handover-abuse、截图）。

## 模式一览

| id | 名字 | 主要文件 |
| --- | --- | --- |
| luminous / partita / cadenza | 流光 / 云阶 / 心象 | `*-manager.js` + `stage-lyric-*.js`（含 Folia 派生，保留 AGPL 注释） |
| tempera / sonnet | 凝彩 / 商籁 | `*-manager.js` + `*-pixi-core.js` + `stage-pixi-effects.js` |
| diorama | 镜台 | `diorama-{director,camera,world,lyrics,optics,events,manager}.js`；方向见 DIORAMA-DIRECTION.md |
| fume | 浮名 | `fume-manager.js` |
| tunnel | 隧图 | `tunnel-manager.js` |
| kowloon | 町景（暂停开发） | `kowloon-*.js` |
| inkdraft | 墨痕 | `inkdraft-manager.js`（分镜、排字、着色器）+ `inkdraft-figures.js`（线稿）+ `inkdraft-pixi.js`（PixiJS 渲染器：三遍怎么画） |
| fogpane / lumiere / hanabi / clockwork / orbit / signal / groupchat / impression | 雾笺 / 绘光 / 花火 / 时计 / 回环 / 信号 / 群唱 / 印象 | 各自 `*-manager.js` |
| starborn | 星诞 | `music-stage-modes.js`，在流光/云阶/心象/浮名/凝彩/商籁之间自动切换 |
