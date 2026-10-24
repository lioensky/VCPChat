# 内置 Codex 精灵

用户提供并要求内置的两个 Codex 桌宠包，任何助手都能在「换装」里直接选，不用导入：

- `keqing/`：刻晴，形象 ID `builtin:codex-keqing`
- `rana/`：乐奈，形象 ID `builtin:codex-rana`

保留原始 `pet.json` 与 `spritesheet.webp`（兼容 Codex 的 `pet.json` 格式），`outfit.json` 提供应用内的中文名称和介绍。

精灵图为 v1（1536×1872），通过 Canvas2D 播放九种动画，不需要 Cubism Core。运行时直接读取应用资源，不依赖本机的 Codex 用户目录，也不会将文件写入助手目录。
