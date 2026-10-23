# 内置 Codex 精灵

`keqing/` 是用户提供并要求内置的刻晴 Codex 桌宠包，形象 ID 为 `builtin:codex-keqing`。保留原始 `pet.json` 与 `spritesheet.webp`，`outfit.json` 提供应用内的中文名称和介绍。

精灵图为 v1（1536×1872），通过 Canvas2D 播放九种动画，不需要 Cubism Core。运行时直接读取应用资源，不依赖本机的 Codex 用户目录，也不会将文件写入助手目录。
