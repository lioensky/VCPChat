# VCPdesktop — 世界首个 AI 原生桌面

> **"言出法随"不是比喻，而是字面意义上的事实。**

---

## 什么是 VCPdesktop

VCPdesktop 是 VChat 的桌面渲染层扩展。它在 Electron 实例中创建一个独立的画布窗口，让 AI 可以将流式生成的 HTML/CSS/JS 内容实时渲染到用户的操作系统桌面上。

**这不是一个概念验证。** 截至 2026年3月，VCPdesktop 已经是一个功能完备的 AI 原生桌面系统：AI 可以实时创建交互式挂件、推送壁纸、感知桌面状态、阅读和维护挂件源码。用户说一句话，桌面上就长出一个满意的东西。

---

## 核心能力一览

| 能力 | 说明 | 状态 |
|------|------|------|
| **流式挂件创建** | AI 在聊天中流式输出 HTML，实时逐 token 渲染到桌面 | ✅ |
| **Shadow DOM 隔离** | 每个挂件运行在独立 Shadow DOM 中，CSS/JS 互不污染 | ✅ |
| **脚本沙箱** | 挂件内 `<script>` 自动注入 Shadow DOM 代理，安全执行 | ✅ |
| **施工态动画** | 流式渲染过程中挂件显示呼吸光效，完成后自动切换为正常态 | ✅ |
| **挂件拖拽** | 抓手带 + 边界限位，防止拖出可视区域 | ✅ |
| **挂件自动尺寸** | 根据内容自动调整宽高，MutationObserver 实时监听变化 | ✅ |
| **右键菜单** | 收藏 / 刷新 / 关闭 / 置顶 / 置底 | ✅ |
| **收藏系统** | 模态窗命名 + 原生截图缩略图 + 文件持久化 | ✅ |
| **收藏侧栏** | 缩略图预览 + 点击恢复 + 拖放到桌面 | ✅ |
| **Z-Index 层级管理** | 点击自动提升 + 手动置顶/置底 | ✅ |
| **Dock 应用栏** | 底部 Dock 栏 + 应用抽屉 + 拖拽排序 + 可见性管理 | ✅ |
| **Windows 快捷方式导入** | 自动扫描桌面 .lnk + 拖入导入 + 图标提取 | ✅ |
| **桌面快捷方式图标** | 从 Dock 拖拽到桌面 + 双击启动 + 自由移动 | ✅ |
| **VChat 子应用启动器** | 10 个 VChat 内部应用注册到 Dock（聊天/笔记/论坛/翻译/骰子/Canvas/音乐/RAG/记忆/主题） | ✅ |
| **图标选择器** | 从 iconset 预设库选择 PNG/SVG/GIF/HTML 富图标 | ✅ |
| **自定义壁纸** | 图片 / 视频(mp4) / HTML 动态壁纸，带透明度/模糊度/亮度调节 | ✅ |
| **壁纸渐入效果** | 切换壁纸时旧壁纸渐出 + 新壁纸渐入，HTML 壁纸加载后 1.2s 渐入 | ✅ |
| **全局设置面板** | 自动最大化 / 窗口置底 / 默认预设 / Dock 图标大小 / 壁纸配置 | ✅ |
| **窗口可见性冻结** | 桌面被遮挡时自动暂停所有动画（CSS/Web Animations/canvas/video/SVG SMIL） | ✅ |
| **布局预设** | 保存/加载桌面布局，支持默认预设自动恢复 | ✅ |
| **主题同步** | 自动跟随 VChat 深色/浅色主题切换 | ✅ |
| **独立模式** | 支持 `--desktop-only` 参数独立启动，无需主窗口 | ✅ |
| **vcpAPI 代理层** | 挂件内 `vcpAPI.fetch()` 自动认证访问 VCP 后端 | ✅ |
| **vcpAPI.post() AI 请求代理** | 挂件内 `vcpAPI.post()` 安全调用 OpenAI 兼容 API，无需暴露 URL 和 Key | ✅ |
| **musicAPI 代理层** | 挂件内 `musicAPI.play()/pause()/getState()` 跨窗口控制 HIFI 播放器 | ✅ |
| **AI 远程壁纸推送** | AI 通过 DesktopRemote 插件推送 URL/文件/HTML 壁纸 | ✅ |
| **AI 桌面感知查询** | AI 查询桌面上所有挂件 ID、收藏状态、持久化路径和图标名称 | ✅ |
| **AI 挂件源码查看** | AI 根据 widget ID 读取 HTML 源码，用于理解/修改/调试 | ✅ |

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                     VChat (Electron)                         │
│                                                              │
│  ┌──────────────────┐         ┌──────────────────────────┐  │
│  │  聊天主窗口       │   IPC   │  VCPdesktop 桌面画布窗口  │  │
│  │  (main.html)     │ ◄─────► │  (desktop.html)          │  │
│  │                  │         │                          │  │
│  │  chatManager ────┼─ push ─►│  ipcBridge → widgetMgr   │  │
│  │  streamManager   │         │  wallpaperMgr            │  │
│  │                  │         │  dock / sidebar / menu    │  │
│  └──────────────────┘         └──────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                    main.js (主进程)                    │   │
│  │  desktopHandlers · musicHandlers · canvasHandlers     │   │
│  │  handleDesktopRemoteControl (AI远程控制处理器)          │   │
│  └──────────────────────────┬───────────────────────────┘   │
│                             │                                │
│  ┌──────────────────────────▼───────────────────────────┐   │
│  │           VCPDistributedServer (分布式服务器)           │   │
│  │                                                       │   │
│  │  Plugin: DesktopRemote (SetWallpaper / QueryDesktop   │   │
│  │          / ViewWidgetSource)                          │   │
│  │  Plugin: MusicController / FileOperator / ...         │   │
│  └───────────────────────┬───────────────────────────────┘   │
│                          │ WebSocket                         │
└──────────────────────────┼───────────────────────────────────┘
                           │
                    VCP 云端主服务器
                   (vcpToolbox AI 指令解析)
```

---

## 文件结构

```
Desktopmodules/
├── desktop.html                        # 桌面画布页面（模块加载编排）
├── desktop.css                         # 汇总样式入口
├── desktop.js                          # 主入口（初始化编排）
│
├── core/                               # 核心层
│   ├── state.js                        #   全局状态 & 常量
│   ├── theme.js                        #   主题同步（light/dark）
│   ├── statusIndicator.js              #   底部状态指示器
│   ├── zIndexManager.js                #   Z-Index 层级管理
│   ├── dragSystem.js                   #   拖拽系统（边界限位）
│   ├── widgetManager.js                #   挂件核心（Shadow DOM/脚本沙箱/自动尺寸）
│   ├── wallpaperManager.js             #   壁纸系统（图片/视频/HTML + 渐入渐出）
│   └── visibilityFreezer.js            #   窗口可见性冻结
│
├── ui/                                 # UI 层
│   ├── contextMenu.js                  #   右键菜单
│   ├── saveModal.js                    #   收藏命名模态窗
│   ├── sidebar.js                      #   收藏侧栏 & 布局预设
│   ├── dock.js                         #   Dock 栏 + 应用抽屉 + 桌面图标
│   ├── globalSettings.js               #   全局设置面板（壁纸/Dock/自动化）
│   └── iconPicker.js                   #   图标选择器（PNG/SVG/GIF/HTML）
│
├── favorites/                          # 收藏层
│   ├── favoritesManager.js             #   收藏保存/加载/删除/刷新
│   └── thumbnail.js                    #   缩略图捕获
│
├── api/                                # 通信层
│   ├── vcpProxy.js                     #   vcpAPI 代理（fetch + post AI 请求代理）
│   └── ipcBridge.js                    #   IPC 桥接（流式推送 + AI远程控制）
│
├── builtinWidgets/                     # 内置挂件
│   ├── weatherWidget.js                #   天气挂件（30min 刷新）
│   ├── musicWidget.js                  #   迷你音乐播放条
│   ├── newsWidget.js                   #   今日热点新闻
│   ├── translateWidget.js              #   AI 翻译挂件（vcpAPI.post() 示范）
│   ├── appTrayWidget.js                #   应用托盘网格
│   └── vchatApps.js                    #   VChat 子应用注册表 & 启动器
│
├── css/                                # 样式模块
│   ├── base.css                        #   全局重置/壁纸层/标题栏/画布/冻结
│   ├── widgets.css                     #   挂件样式（施工态/动画/抓手/关闭按钮）
│   ├── dock.css                        #   Dock 栏 & 应用抽屉样式
│   ├── shortcuts.css                   #   桌面快捷方式图标样式
│   ├── sidebar.css                     #   收藏侧栏样式
│   ├── settings.css                    #   全局设置面板样式
│   ├── ui-components.css               #   右键菜单/模态窗样式
│   ├── icon-picker.css                 #   图标选择器样式
│   └── theme-overrides.css             #   主题覆盖层
│
└── debug/
    └── debugTools.js                   #   调试接口

VCPDistributedServer/Plugin/DesktopRemote/
├── plugin-manifest.json                # 插件描述（3个指令）
└── desktop-remote.js                   # stdin/stdout 数据管道

AppData/
├── DesktopWidgets/{fav_id}/            # 收藏持久化
│   ├── widget.html
│   ├── meta.json
│   └── thumbnail.png
├── DesktopData/
│   ├── dock.json                       # Dock 配置
│   ├── layout.json                     # 布局 + 全局设置
│   └── ai_wallpaper_*.html             # AI 生成的 HTML 壁纸文件
```

---

## AI 原生能力

VCPdesktop 最核心的创新在于：**AI 不仅能创建桌面内容，还能感知和操控整个桌面。** 这通过 VCP 分布式插件系统实现。

### 1. 流式创建挂件

AI 在聊天中使用 `<<<[DESKTOP_PUSH]>>>` 语法，VChat 将流式 token 实时推送到桌面画布：

```
<<<[DESKTOP_PUSH]>>>
<div style="padding:20px; background:rgba(0,0,0,0.6); color:#fff; border-radius:16px;">
  <h2 id="temp">加载中...</h2>
</div>
<script>
vcpAPI.weather().then(data => {
  document.getElementById('temp').textContent = data.hourly[0].temp + '°C';
});
</script>
<<<[DESKTOP_PUSH_END]>>>
```

渲染过程中挂件显示施工态动画，完成后自动切换为可交互状态。

### 2. AI 远程控制（DesktopRemote 插件）

通过 VCP 分布式同步插件 `DesktopRemote`，AI 可以：

**推送壁纸** — 支持 URL、本地文件、直接创建 HTML 动态壁纸：
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」DesktopRemote「末」,
command:「始」SetWallpaper「末」,
wallpaperSource:「始」<!DOCTYPE html>
<html><body style="margin:0;overflow:hidden;background:#000">
<canvas id="c"></canvas>
<script>/* 粒子动画 */</script>
</body></html>「末」
<<<[END_TOOL_REQUEST]>>>
```

**感知桌面状态** — 查询所有挂件和图标：
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」DesktopRemote「末」,
command:「始」QueryDesktop「末」
<<<[END_TOOL_REQUEST]>>>
```

返回 Markdown 表格报告，包含挂件 ID、收藏状态、持久化目录路径。

**查看挂件源码** — 读取指定挂件的 HTML：
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」DesktopRemote「末」,
command:「始」ViewWidgetSource「末」,
widgetId:「始」fav-xxx-123456「末」
<<<[END_TOOL_REQUEST]>>>
```

AI 拿到源码后，可以配合 `FileOperator` 插件直接编辑收藏目录中的 `widget.html` 文件来维护挂件内容。

### 3. 挂件内可用 API

每个挂件的 `<script>` 在沙箱闭包中执行，以下 API 自动注入：

```javascript
// document 已代理到 Shadow DOM
document.querySelector(sel)     // 在挂件内部查找
document.getElementById(id)     // 在挂件内部查找
document.body                   // 指向挂件内容容器

// vcpAPI — 后端数据访问（自动认证）
vcpAPI.weather()                // 获取天气 JSON
vcpAPI.fetch('/admin_api/xxx')  // 通用后端 API（Basic Auth）
vcpAPI.post(messages, options)  // OpenAI 兼容 chat completion（Bearer Token）
  // messages: [{role, content}]
  // options: {model, temperature, max_tokens, ...}
  // 返回: {success, content, usage, raw, error}

// musicAPI — 跨窗口音乐控制
musicAPI.getState()             // 播放状态
musicAPI.play() / pause()       // 播放控制
musicAPI.seek(秒数)             // 跳转
musicAPI.setVolume(0-100)       // 音量
musicAPI.send('music-remote-command', 'next')  // 切歌
```

---

## 性能优化

### 窗口可见性冻结

当桌面窗口被其他程序遮挡或最小化时，`visibilityFreezer.js` 自动暂停所有动画资源：

- **CSS 动画** — 通过 `animation-play-state: paused` 全局暂停
- **Web Animations API** — 精确暂停每个运行中的动画实例
- **Canvas/rAF** — 隐藏 canvas 元素阻止 GPU 渲染
- **Video/Audio** — 暂停媒体播放
- **SVG SMIL** — 暂停矢量动画
- **HTML 壁纸 iframe** — 发送冻结消息 + visibility:hidden
- **Dock GIF 图标** — CSS 暂停

窗口重获焦点后全部精确恢复。

### 内容观察器

每个挂件通过 `MutationObserver` 监听 Shadow DOM 内容变化，异步脚本（如天气数据加载、收藏恢复后的脚本执行）修改内容后自动触发尺寸调整，150ms 防抖。

---

## 设计哲学

### 不造新系统，让已有系统长出新能力

VCPdesktop 不重造 VChat 的流式渲染引擎、动画系统、主题系统或后端通信能力。它只是把这些能力的输出端，从聊天气泡延伸到操作系统桌面。

### AI 原生 = 感知 + 创造 + 维护

传统桌面定制工具需要用户手动配置。VCPdesktop 的 AI 原生设计意味着：
- **感知**：AI 知道桌面上有什么（QueryDesktop）
- **创造**：AI 可以实时创建交互式内容（流式推送 + SetWallpaper）
- **维护**：AI 可以阅读和修改已有内容（ViewWidgetSource + FileOperator）

这构成了一个完整的闭环：AI 不仅能生成桌面内容，还能理解它创造的东西，并持续改进。

### 言出法随

当 AI 的每一个 token 都可以直接改变用户的物理视界时——用户说"给我一个粒子效果的壁纸"，1 秒后壁纸开始渐入；说"在桌面上放一个天气卡片"，卡片从空气中逐 token 生长出来——这就是字面意义上的"言出法随"。

---

*VCPdesktop · 世界首个 AI 原生桌面 · 2026-03-22*