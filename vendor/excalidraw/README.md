# Excalidraw

官方包 @excalidraw/excalidraw 0.18.1、React 19.1.1，由 `scripts/build-excalidraw.mjs` 打包为一份，供文坊的白板使用。
只保留中文和英文；Mermaid 转白板单独打包为 `excalidraw-mermaid.js`，使用时才载入。
字体位于 `fonts/`，页面将 `EXCALIDRAW_ASSET_PATH` 指向此处，不从网络加载。请勿手动修改本目录的文件；升级时修改脚本中的版本号并重新打包。

打入的各个包的许可证原文见 `THIRD-PARTY-LICENSES.txt`。字体的版权声明与许可证原文见 `fonts/LICENSES.txt`（SIL OFL 1.1 或 MIT）；
官方包中的 Liberation Sans 与 Cascadia Code 不随附，用到时由 Excalidraw 从其 CDN 载入或使用系统字体。
