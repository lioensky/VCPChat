# 旧版音乐界面（上游原版）

这个文件夹是上游 lioensky/VCPChat main（3b7ba6c7）的 `Musicmodules/` 原样拷贝，保留下来随时可以切回原版。

- 除 `music.html` 多引了一行 `legacy-bridge.js`、以及新增的 `legacy-bridge.js` 和本说明之外，其余文件和上游一字不差。
- `legacy-bridge.js`：设置面板里的「旧版界面（原版）」开关；把原版频谱写死的 63789 端口换成音频引擎实际端口。
- 主进程按设置 `musicLegacyUI` 决定打开 `Musicmodules/music.html` 还是这里的 `music.html`（见 `modules/ipc/musicHandlers.js`）。
- 不要删除或用新版替换这个文件夹；新版的改动都放在 `Musicmodules/`。

核对是否和上游一致（`UPSTREAM.sha256` 是上游 3b7ba6c7 每个文件的哈希）：

```
node --test tests/music-legacy.test.js
```
