# VCPdesktop 开发文档 — 二期工程

> **让 VChat 的流式渲染能力，从聊天气泡溢出到 Windows 桌面。**

---

## 一、项目概述

VCPdesktop 是 VChat 的桌面渲染层扩展。二期在一期基础上新增了收藏系统、右键菜单、vcpAPI 数据代理层、内置天气挂件和迷你音乐播放条。

### 二期完成的核心能力

| 能力 | 状态 |
|------|------|
| 独立桌面画布窗口（主题壁纸、沉浸标题栏） | ✅ 一期 |
| `<<<[DESKTOP_PUSH]>>>` 流式推送语法 | ✅ 一期 |
| 逐token流式渲染到桌面（100ms节流） | ✅ 一期 |
| Shadow DOM 样式隔离 | ✅ 一期 |
| 挂件拖拽（抓手带 + **拖拽限位**） | ✅ 二期修复 |
| 挂件关闭按钮 | ✅ 一期 |
| 挂件尺寸自适应 | ✅ 一期 |
| 脚本沙箱（document代理到Shadow DOM） | ✅ 一期 |
| **右键菜单**（收藏/刷新/关闭/置顶/置底） | ✅ 二期 |
| **收藏系统**（模态窗 + 持久化 + 原生截图缩略图） | ✅ 二期 |
| **收藏侧栏**（图片缩略图预览 + 拖出到桌面） | ✅ 二期 |
| **Z-Index 层级管理**（置顶/置底） | ✅ 二期 |
| **vcpAPI 代理层**（自动认证的后端数据访问） | ✅ 二期 |
| **musicAPI 代理层**（跨窗口音乐播放器控制） | ✅ 二期 |
| **内置天气挂件**（自动加载 + 30min刷新） | ✅ 二期 |
| **迷你音乐播放条**（播放/暂停/上下首/进度/seek） | ✅ 二期 |

---

## 二、文件结构（三期模块化）

```
Desktopmodules/
├── desktop.html                    # 桌面画布页面（HTML + 模块加载编排）
├── desktop.css                     # 全部样式
├── desktop.js                      # 主入口（初始化编排，无业务逻辑）
├── README.md                       # 本文档
│
├── core/                           # 核心层 —— 基础设施
│   ├── state.js                    #   全局状态 & 常量定义
│   ├── theme.js                    #   主题同步（light/dark）
│   ├── statusIndicator.js          #   底部状态指示器
│   ├── zIndexManager.js            #   Z-Index 层级管理（置顶/置底）
│   ├── dragSystem.js               #   拖拽系统（带边界限位）
│   └── widgetManager.js            #   挂件管理核心（创建/删除/Shadow DOM/脚本沙箱）
│
├── ui/                             # UI层 —— 用户交互组件
│   ├── contextMenu.js              #   右键菜单系统
│   ├── saveModal.js                #   收藏命名模态窗
│   └── sidebar.js                  #   收藏侧栏 & 拖放到桌面
│
├── favorites/                      # 收藏层 —— 持久化 & 恢复
│   ├── favoritesManager.js         #   收藏保存/加载/删除/刷新/恢复
│   └── thumbnail.js                #   缩略图捕获（原生截图 + Canvas fallback）
│
├── api/                            # API层 —— 外部通信
│   ├── vcpProxy.js                 #   vcpAPI 代理层（凭据管理 + fetch 代理）
│   └── ipcBridge.js                #   IPC 监听桥接（主窗口流式推送分发）
│
├── builtinWidgets/                 # 内置挂件 —— 开箱即用的默认挂件
│   ├── weatherWidget.js            #   天气挂件（30min 自动刷新）
│   └── musicWidget.js              #   迷你音乐播放条
│
└── debug/                          # 调试工具
    └── debugTools.js               #   window.__desktopDebug 调试接口

modules/ipc/
├── desktopHandlers.js    # 桌面IPC模块（窗口管理、收藏持久化、截图、凭据获取）
└── musicHandlers.js      # 音乐IPC模块（新增 music-remote-command 转发）

preload.js                # 新增通道：desktop-save/load/delete/list-widget,
                          #          desktop-capture-widget, desktop-get-credentials,
                          #          music-remote-command, music-control

AppData/DesktopWidgets/   # 收藏持久化存储目录
├── {fav_id}/
│   ├── widget.html       # 挂件HTML内容
│   ├── meta.json         # 元数据（id, name, createdAt, updatedAt）
│   └── thumbnail.png     # 原生截图缩略图
```

### 模块通信机制

所有模块通过 `window.VCPDesktop` 全局命名空间进行通信，无需构建工具。

```
window.VCPDesktop = {
    state,          // 全局状态对象（widgets Map, favorites, sidebarOpen...）
    CONSTANTS,      // 常量（TITLE_BAR_HEIGHT, 尺寸限制...）
    domRefs,        // DOM 缓存引用
    initDomRefs,    // DOM 引用初始化函数
    theme,          // { init, getCurrent, set }
    status,         // { update, hide, show }
    zIndex,         // { bringToFront, sendToBack, allocate }
    drag,           // { setup }
    widget,         // { create, appendContent, replaceInWidgets, finalize, remove, clearAll, ... }
    contextMenu,    // { init, show, hide }
    saveModal,      // { init, show }
    sidebar,        // { init, toggle, render, initCanvasDrop }
    thumbnail,      // { capture, generateFallback }
    favorites,      // { performSave, loadList, spawnFromFavorite, refresh, deleteFavorite }
    vcpApi,         // { init, fetch, hasCredentials, getBaseUrl }
    ipc,            // { init }
    builtinWeather, // { spawn }
    builtinMusic,   // { spawn }
    debug,          // { init }
}
```

### 模块加载顺序（严格依赖）

```
state → theme → statusIndicator → zIndexManager → dragSystem → widgetManager
  → contextMenu → saveModal → sidebar → thumbnail → favoritesManager
  → vcpProxy → ipcBridge → weatherWidget → musicWidget → debugTools → desktop.js
```

---

## 三、二期新增架构

### 3.1 收藏系统

```
用户右键挂件 → 收藏菜单 → 弹出模态窗输入名字
    → 关闭模态窗 → 延迟350ms → Electron capturePage 截图
    → IPC: desktop-save-widget → 主进程写入 AppData/DesktopWidgets/{id}/
    → 刷新侧栏列表

侧栏预览：图片缩略图（非实时渲染，避免性能问题）
侧栏拖出：HTML5 Drag & Drop → canvas drop事件 → spawnFromFavorite()
```

### 3.2 vcpAPI 代理层

```
桌面启动 → initVcpApi()
    → IPC: desktop-get-credentials
    → 主进程读取 AppData/settings.json (vcpServerUrl)
    →              AppData/UserData/forum.config.json (username/password)
    → 返回 apiBaseUrl + auth
    → 缓存在 _vcpCredentials 中

Widget脚本中：
    vcpAPI.weather() → window.__vcpProxyFetch('/admin_api/weather')
                     → fetch(apiBaseUrl + endpoint, { Authorization: Basic auth })
                     → 返回 JSON
```

### 3.3 musicAPI + 跨窗口控制

```
桌面 Widget → musicAPI.play/pause/getState/seek/setVolume
           → window.electron.invoke('music-play/pause/get-state/seek/set-volume')
           → 主进程 musicHandlers → Rust Audio Engine HTTP API

上一首/下一首：
    桌面 Widget → musicAPI.send('music-remote-command', 'next')
              → 主进程 musicHandlers.ipcMain.on('music-remote-command')
              → musicWindow.webContents.send('music-control', 'next')
              → 音乐窗口 music.js → app.nextTrack()
```

### 3.4 拖拽限位

```
onMouseMove 中：
    newTop = Math.max(TITLE_BAR_HEIGHT, newTop)       // 不进入标题栏
    newTop = Math.min(viewH - 40, newTop)              // 不完全拖出底部
    newLeft = Math.max(-(widgetW - 40), newLeft)       // 左边至少露40px
    newLeft = Math.min(viewW - 40, newLeft)            // 右边至少露40px
```

---

## 四、Widget 沙箱 API 参考

每个 Widget 的 `<script>` 在沙箱闭包中执行，以下 API 自动可用：

### document（已代理到 Shadow DOM）
```javascript
document.querySelector(sel)      // 在 widget 内部查找
document.getElementById(id)      // 在 widget 内部查找
document.createElement(tag)      // 正常创建元素
document.body                    // 指向 widget 内容容器
```

### vcpAPI（后端数据访问，自动认证）
```javascript
vcpAPI.weather()                        // 获取天气 JSON
vcpAPI.fetch('/admin_api/任意端点')      // 通用后端 API
```

### musicAPI（音乐播放器控制）
```javascript
musicAPI.getState()                     // {is_playing, file_path, position_secs, duration_secs, volume}
musicAPI.play()                         // 播放
musicAPI.pause()                        // 暂停
musicAPI.seek(秒数)                     // 跳转
musicAPI.setVolume(0-100)               // 音量
musicAPI.send('music-remote-command', 'next')      // 下一首
musicAPI.send('music-remote-command', 'previous')  // 上一首
```

---

## 五、AI Agent 提示词模板

```
## 桌面挂件能力

你可以通过 <<<[DESKTOP_PUSH]>>> 语法将交互式 HTML 挂件推送到用户的桌面画布。

可用 API：
- vcpAPI.weather() - 获取天气数据
- vcpAPI.fetch('/admin_api/xxx') - 访问后端任意API
- musicAPI.getState() - 获取音乐播放状态
- musicAPI.play()/pause() - 控制播放
- musicAPI.send('music-remote-command', 'next'/'previous') - 切歌

示例：
<<<[DESKTOP_PUSH]>>>
<div id="widget" style="padding:16px;background:rgba(0,0,0,0.5);color:#fff;border-radius:12px;">
  加载中...
</div>
<script>
vcpAPI.weather().then(function(data) {
    document.getElementById('widget').innerHTML = '<h2>'+data.hourly[0].temp+'°C</h2>';
});
</script>
<<<[DESKTOP_PUSH_END]>>>
```

---

## 六、三期规划：全局 Widget API Provider

### 核心思想

将 `vcpAPI` / `musicAPI` 从"桌面专属"提升为**全局渲染层基础设施**。

### 实施方案

1. 新建 `modules/widgetApiProvider.js`，封装所有 API 的初始化和注入逻辑
2. 三个注入点：
   - `desktop.js` → `widgetApiProvider.inject(sandbox, 'desktop')` — 完全权限
   - `messageRenderer.js` → `widgetApiProvider.inject(sandbox, 'chat')` — 受限权限
   - `canvas.js` → `widgetApiProvider.inject(sandbox, 'canvas')` — 完全权限
3. 权限级别控制：
   - `desktop` / `canvas`：完全权限（读写后端、音乐控制）
   - `chat`：只读权限（只能读取天气等数据，不能控制播放器）

### 架构图

```
┌──────────────────────────────────────────────────────────────┐
│                    widgetApiProvider.js                       │
│                                                              │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌──────────────┐│
│  │ vcpAPI   │  │ musicAPI │  │ 凭据管理   │  │ 权限控制     ││
│  │ .weather │  │ .play    │  │ settings  │  │ desktop: full ││
│  │ .fetch   │  │ .pause   │  │ forum.cfg │  │ chat: read   ││
│  └────┬─────┘  └────┬─────┘  └────┬──────┘  │ canvas: full ││
│       │             │             │          └──────────────┘│
└───────┼─────────────┼─────────────┼──────────────────────────┘
        │             │             │
   ┌────▼────┐   ┌────▼────┐   ┌───▼───┐
   │ desktop │   │  chat   │   │canvas │
   │ .js     │   │renderer │   │ .js   │
   │ Shadow  │   │ Shadow  │   │Shadow │
   │ DOM     │   │ DOM     │   │ DOM   │
   └─────────┘   └─────────┘   └───────┘
```

### 效果

- AI 在聊天气泡中也能输出带 `vcpAPI.weather()` 的交互式天气卡片
- AI 在 Canvas 中也能创建音乐控制面板
- 统一的 API 接口，AI 不需要区分渲染目标
- 安全：聊天气泡中的脚本只有只读权限

---

## 七、后续开发扩展指南

三期模块化完成后，以下功能可以通过新增独立模块快速实现：

### 7.1 桌面布局保存/恢复

在 `favorites/` 下新增 `layoutManager.js`：
- 读取 `state.widgets` 中所有挂件的位置/尺寸/savedId
- 序列化为 JSON 布局文件
- 通过 IPC 持久化到 `AppData/DesktopLayouts/`
- 启动时可选恢复上次布局

### 7.2 布局预设

在 `ui/` 下新增 `layoutPresets.js`：
- 内置多种布局模板（工作模式、信息面板、极简模式...）
- 一键应用预设布局
- 右键菜单或侧栏增加"布局"分类

### 7.3 Widget 小商店

新建 `store/` 目录：
- `widgetStore.js` — 从服务端获取可用 widget 列表
- `widgetInstaller.js` — 下载/安装/更新 widget
- `ui/storePanel.js` — 商店 UI 面板

### 7.4 桌面图标导入

在 `builtinWidgets/` 下新增 `shortcutWidget.js`：
- 支持导入桌面快捷方式（.lnk 文件）
- 显示为图标挂件，点击打开对应程序
- 通过 IPC 调用 `shell.openPath()`

### 7.5 自定义壁纸/动态壁纸

在 `core/` 下新增 `wallpaper.js`：
- 静态壁纸：用户选择图片，写入 body 背景
- 动态壁纸：支持 CSS 动画 / Three.js 场景 / 视频壁纸
- 壁纸设置面板（`ui/wallpaperSettings.js`）
- 持久化壁纸配置到 `AppData/DesktopSettings/`

---

*VCPdesktop 三期模块化工程 · 2026-03-22 · [VCP桌面开发]*