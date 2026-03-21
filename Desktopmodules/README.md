# VCPdesktop 开发文档 — 一期工程

> **让 VChat 的流式渲染能力，从聊天气泡溢出到 Windows 桌面。**

---

## 一、项目概述

VCPdesktop 是 VChat 的桌面渲染层扩展。它在 VChat 的 Electron 实例中创建一个画布窗口，复用 VChat 已有的流式渲染引擎，使 Agent 的流式输出可以直接渲染到操作系统桌面上。

### 一期完成的核心能力

| 能力 | 状态 |
|------|------|
| 独立桌面画布窗口（主题壁纸、沉浸标题栏） | ✅ |
| `<<<[DESKTOP_PUSH]>>>` 流式推送语法 | ✅ |
| 逐token流式渲染到桌面（100ms节流） | ✅ |
| Shadow DOM 样式隔离 | ✅ |
| 挂件拖拽（抓手带） | ✅ |
| 挂件关闭按钮 | ✅ |
| 挂件尺寸自适应 | ✅ |
| 脚本沙箱（document代理到Shadow DOM） | ✅ |
| 主窗口转义封印（占位符显示） | ✅ |
| 前缀白名单二级验证 | ✅ |
| 150秒超时自动finalize | ✅ |
| 桌面窗口不存在时零开销短路 | ✅ |

---

## 二、文件结构

```
Desktopmodules/
├── desktop.html          # 桌面画布页面（引入themes.css获得壁纸）
├── desktop.css           # 挂件容器、抓手带、施工态、关闭按钮样式
├── desktop.js            # 画布渲染器（Shadow DOM、拖拽、IPC监听、自适应）
└── README.md             # 本文档

modules/ipc/
└── desktopHandlers.js    # 独立IPC模块（窗口生命周期、流式转发）

修改的文件：
├── main.js               # --desktop-only 模式、desktopHandlers引入
├── preload.js            # 桌面IPC通道（desktopPush等4个）
├── start-desktop.vbs     # VBS启动脚本
├── modules/
│   ├── messageRenderer.js    # 转义封印 + preprocessFullContent最先处理
│   └── renderer/
│       └── streamManager.js  # 流式推送拦截器
└── styles/
    └── messageRenderer.css   # 占位符样式
```

---

## 三、架构总览

```
┌──────────────────────────────────────────────────────────┐
│                    VChat (Electron)                       │
│                                                          │
│  ┌─────────────────────┐    ┌────────────────────────┐  │
│  │    聊天主窗口         │    │   桌面画布窗口          │  │
│  │                     │    │   (BrowserWindow)       │  │
│  │  streamManager.js   │    │                        │  │
│  │    ↓ token流         │    │   desktop.html/js      │  │
│  │  processDesktopPush │    │     ↓                   │  │
│  │  Token() 逐字符拦截  │    │   Shadow DOM 挂件      │  │
│  │    ↓                │    │   (样式隔离+脚本沙箱)   │  │
│  │  electronAPI        │    │                        │  │
│  │  .desktopPush()     │    │   autoResizeWidget()   │  │
│  └────────┬────────────┘    └──────────┬─────────────┘  │
│           │                            │                │
│           └──── IPC: desktop-push ─────┘                │
│                                                          │
│           desktopHandlers.js (转发 / 窗口管理)            │
│                                                          │
│           preload.js (通道定义)                           │
└──────────────────────────────────────────────────────────┘
```

---

## 四、启动方式

### 4.1 独立模式
```
双击 start-desktop.vbs
```
或命令行：
```bash
npx electron . --desktop-only
```
仅启动桌面画布窗口，不创建主聊天窗口。

### 4.2 主窗口附属模式
在主窗口的控制台中：
```javascript
electronAPI.openDesktopWindow()
```
或由AI输出 `<<<[DESKTOP_PUSH]>>>` 语法时自动触发。

---

## 五、触发语法

### 5.1 完整推送
```
<<<[DESKTOP_PUSH]>>>
<div style="padding:16px; background:rgba(0,0,0,0.5); color:#fff;">
  <h2>标题</h2>
  <p>内容</p>
</div>
<<<[DESKTOP_PUSH_END]>>>
```

### 5.2 流式替换（热更新）
```
<<<[DESKTOP_PUSH]>>>
target:「始」.vw-temp-now「末」,
replace:「始」<span style="font-size:52px;">22°C</span>「末」
<<<[DESKTOP_PUSH_END]>>>
```

- `target:「始」...「末」` — CSS选择器，在所有活跃挂件的Shadow DOM中查找目标元素
- `replace:「始」...「末」` — 替换内容，支持多行HTML/CSS
- 「始」「末」内可包含任意字符（包括换行、HTML标签），只要不包含「末」本身
- 替换后自动触发 `autoResizeWidget` 重新计算尺寸

### 5.3 支持的内容格式
- 裸 `<div>` + 内联CSS
- 完整 `<!DOCTYPE html>` 文档（含 `<style>` 和 `<script>`）
- `<svg>` / `<canvas>` 图形
- 带 `fetch()` 的动态数据挂件
- `target:` + `replace:` 热替换语法

### 5.4 二级前缀验证
开始标签后的内容必须以以下前缀之一开头，否则丢弃：
```
<!doctype, <div, <section, <article, <main, <header,
<nav, <aside, <canvas, <svg, target:
```

---

## 六、流式渲染流程

```
AI输出token → appendStreamChunk()
              ↓
         processDesktopPushToken() 逐字符检测
              ↓
    检测到 <<<[DESKTOP_PUSH]>>> 开始标签
              ↓
    进入active状态，累积buffer（不创建挂件）
              ↓
    buffer积累5字符 → 前缀白名单验证
              ↓ (验证通过)
    创建挂件（施工态）+ 启动setInterval(100ms)
              ↓
    每100ms推送累积buffer全量到桌面画布
    桌面 appendWidgetContent() → innerHTML覆盖 + autoResizeWidget()
              ↓
    检测到 <<<[DESKTOP_PUSH_END]>>> 结束标签
              ↓
    停止定时器 + 最终推送 + finalize + 执行脚本
              ↓
    施工态结束，挂件进入正常交互态
```

---

## 七、样式隔离

每个挂件使用 **Shadow DOM** 实现样式隔离：

```javascript
const shadowRoot = contentWrapper.attachShadow({ mode: 'open' });
```

- 挂件内的CSS不会污染宿主文档
- 宿主文档的CSS不会影响挂件内容
- 内联 `<style>` 标签自动提取到 Shadow DOM 层级

---

## 八、脚本沙箱

挂件内的 `<script>` 在 finalize 时被包装在沙箱闭包中：

```javascript
(function(_realDoc) {
    var _shadowRoot = _realDoc.querySelector('...').shadowRoot;
    var root = _shadowRoot.querySelector('.widget-inner-content');
    
    // document 被代理到 Shadow DOM
    var document = {
        querySelector: (sel) => root.querySelector(sel),
        getElementById: (id) => root.querySelector('#' + id),
        createElement: _realDoc.createElement.bind(_realDoc),
        // ...
    };
    
    // AI的脚本在这里执行
})(window.document);
```

这意味着：
- `document.querySelector('#myElement')` → 在 Shadow DOM 内查找
- `document.getElementById('xxx')` → 在 Shadow DOM 内查找
- `fetch()` → 正常工作（全局作用域）
- `document.createElement()` → 正常工作（委托给真实document）

---

## 九、主窗口转义封印

在聊天气泡中，`<<<[DESKTOP_PUSH]>>>` 块的内容被转义为占位符：

```html
<div class="vcp-desktop-push-placeholder">
  <div class="vcp-desktop-push-header">
    <span class="vcp-desktop-push-icon">🖥️</span>
    <span class="vcp-desktop-push-label">已推送到桌面画布</span>
  </div>
  <div class="vcp-desktop-push-preview">
    <pre>（转义后的前120字符预览）</pre>
  </div>
</div>
```

封印时机：`preprocessFullContent()` 的**第一步**（在所有其他HTML处理之前），确保无论是流式渲染、历史重新渲染还是切换话题，推送块内的HTML都不会泄露。

---

## 十、防御性设计

| 防御点 | 机制 |
|--------|------|
| 桌面窗口不存在 | `desktopWindowAvailable` 标志位短路，零IPC开销 |
| AI示例性输出开始标签 | 二级前缀验证 + 150秒超时自动finalize |
| 内容不合法 | 30字符内未匹配白名单前缀则丢弃 |
| style标签泄露 | `processAndInjectScopedCss` 保护推送块 |
| 重复推送 | `extractAndPushDesktopBlocks` 兜底已禁用 |
| IPC消息风暴 | 100ms节流 + 全量覆盖模式（非逐字符） |

---

## 十一、调试工具

在桌面画布窗口的 DevTools 控制台中：

```javascript
// 创建测试挂件
__desktopDebug.test()

// 手动创建挂件
__desktopDebug.createWidget('my-widget', { x: 100, y: 100, width: 300, height: 200 })

// 设置挂件内容
__desktopDebug.appendWidgetContent('my-widget', '<div style="padding:20px; color:#fff;">Hello</div>')

// 完成挂件
__desktopDebug.finalizeWidget('my-widget')

// 移除挂件
__desktopDebug.removeWidget('my-widget')

// 清除所有挂件
__desktopDebug.clearAllWidgets()

// 查看状态
__desktopDebug.getState()
```

---

## 十二、二期规划

| 功能 | 说明 |
|------|------|
| 收藏夹系统 | 挂件持久化到JSON，冷启动恢复 |
| 挂件缩放 | 拖拽角标缩放 |
| 右键菜单 | 收藏/编辑/锁定/删除 |
| 壁纸系统 | 静态图片/HTML动态壁纸 |
| 多显示器 | 每屏一个画布窗口 |
| 桌面图标映射 | 读取Win桌面快捷方式并渲染 |
| 数据刷新 | 挂件内置定时fetch机制 |
| 动画冻结 | visibilityOptimizer集成 |

---

*VCPdesktop 一期工程 · 2026-03-21 · [VCP桌面开发]*