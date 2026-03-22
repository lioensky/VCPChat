# VChat 官方图标包

本目录存放 VChat 桌面各子应用的官方图标。

## 图标规范

- **静态图标**：PNG 格式，推荐尺寸 128×128px 或 256×256px
- **动画图标**：GIF 格式，同名文件（如 `vchat_main.png` 对应 `vchat_main.gif`）
- 鼠标悬停时自动播放 GIF 动画，移出时恢复静态 PNG

## 需要的图标文件

| 文件名（PNG） | 文件名（GIF） | 对应应用 | 描述 |
|---------------|---------------|---------|------|
| `vchat_main.png` | `vchat_main.gif` | VChat 主界面 | 聊天气泡/对话图标 |
| `notes.png` | `notes.gif` | 用户笔记中心 | 笔记本/记事本图标 |
| `memo.png` | `memo.gif` | AI记忆中心 | 大脑/神经网络图标 |
| `forum.png` | `forum.gif` | 论坛模块 | 论坛/社区讨论图标 |
| `rag_observer.png` | `rag_observer.gif` | RAG 信息流监听 | 信号/数据流图标 |
| `dice.png` | `dice.gif` | 丢骰子 | 骰子图标 |
| `canvas.png` | `canvas.gif` | Canvas 协同 | 画板/调色板图标 |
| `translator.png` | `translator.gif` | 翻译模块 | 地球/翻译图标 |
| `music.png` | `music.gif` | 音乐播放器 | 音符/耳机图标 |
| `themes.png` | `themes.gif` | 主题商店 | 面具/主题图标 |

## 动画效果说明

- GIF 文件是**可选的**，如果没有对应的 GIF，hover 时不会有动画效果，只显示静态 PNG
- 如果 PNG 文件也缺失，会回退到 emoji 图标显示
- GIF 建议帧率 15-30fps，循环播放，文件大小建议控制在 500KB 以内