# Excalidraw

官方包 @excalidraw/excalidraw 0.18.1，React 19.1.1，由 `scripts/build-excalidraw.mjs` 打成一份。只留中文和英文；
Mermaid 转白板单独打成 `excalidraw-mermaid.js`，用到时才载入。
字体在 `fonts/`，页面设 `EXCALIDRAW_ASSET_PATH` 指到这里，不走网络。不要手改这里的文件，要升级改脚本里的版本号重新打包。

打进去的各个包的许可证原文在 `THIRD-PARTY-LICENSES.txt`。字体的许可在各自字体文件的元数据里，都是开源字体（SIL OFL 或 MIT）。
