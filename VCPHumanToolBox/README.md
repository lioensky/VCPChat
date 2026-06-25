# VCPHumanToolBox · 人类工具箱

> VCP 生态的可视化工具调用面板——将 AI 工具能力以表单界面的形式开放给人类用户，无需手写VCP 指令即可调用任意工具。

---

## 目录

1. [项目概述](#1-项目概述)
2. [快速启动](#2-快速启动)
3. [整体架构](#3-整体架构)
4. [目录结构](#4-目录结构)
5. [工具定义格式](#5-工具定义格式)
6. [新增工具的两条路径](#6-新增工具的两条路径)
7. [插件管理面板](#7-插件管理面板-v03)
8. [工作流编辑器](#8-工作流编辑器现状)
9. [ComfyUI 集成](#9-comfyui-集成)
10. [IPC 通道白名单](#10-ipc-通道白名单)
11. [开发指南](#11-开发指南)

---

## 1. 项目概述

VCPHumanToolBox 是一个**独立的 Electron 应用**，运行于 `VCPChat/VCPHumanToolBox/` 目录下。它不是 VCPChat 的内嵌模块，而是通过 IPC 桥接（`vcp-ht-execute-tool-proxy`）与 VCPChat 主进程通信，最终将工具调用请求代理到 VCPDistributedServer 的 `/v1/human/tool` 端点。

**核心能力**：
- 🧰 **工具网格**：以卡片形式展示所有可用工具，支持搜索、分类筛选、收藏
- 📝 **动态表单**：根据工具参数定义自动生成输入界面，支持 7 种参数类型
-🎨 **多模态结果**：结果区支持 Markdown、图片、视频渲染
- 📦 **插件管理**（v0.3 新增）：从后端动态导入插件定义，支持可视化编辑参数
- 🔀 **工作流编辑器**（部分实现）：基于 jsPlumb 的节点编排界面

**不是什么**：
- 不是 AI 对话界面（那是 VCPChat 主窗口）
- 不是插件的执行后端（执行由 VCPDistributedServer 负责）
- 不是工具的权限管理系统

---

## 2. 快速启动

### 前提条件
- VCPChat 主进程已运行（提供 IPC 桥接）
- VCPDistributedServer 已启动（执行工具调用）
- `AppData/settings.json` 中已配置 `vcpServerUrl` 和 `vcpApiKey`

### 启动方式
双击 `VCPHumanToolBox/VCHB.lnk` 快捷方式，或执行：
```bat
cd VCPHumanToolBox
start.bat
```

更常用的方式是，通过 VCPChat 主窗口的「工具箱」按钮唤起子窗口。

---

## 3. 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                      VCPHumanToolBox (Electron)                 │
│                                                                 │
│  ┌────────────────┐    IPC (contextIsolation)    ┌───────────┐  │
│  │  renderer.js   │◄────────────────────────── │  preload  │  │
│  │  (65KB, UI核心) │                             │   .js     │  │
│  └───────┬────────┘                             └─────┬─────┘  │
│          │ import│ expose  │
│  ┌───────▼────────┐                             ┌─────▼─────┐  │
│  │  config.js     │                             │  main.js  │  │
│  │  (72KB, 工具定义)│                             │(IPC注册器)│  │
│  └────────────────┘                             └─────┬─────┘  │
│  ┌────────────────┐                                │        │
│  │ tool-manager.js│                                   │ fetch│
│  │ (48KB, 插件管理)│                                   ▼        │
└──┴────────────────┴───────────────────────────────────┬────────┘
                                                        │ vcp-ht-execute-tool-proxy
                                         ┌──────────────▼─────────────────┐
                                         │      VCPChat主进程 (desktopHandlers.js)      │
                                         └──────────────┬─────────────────┘
                                                        │ POST /v1/human/tool┌──────────────▼─────────────────┐
                                         │      VCPDistributedServer       │
                                         └────────────────────────────────┘
```

### 数据流（工具执行）

```
用户点击工具卡片→ showToolDetail()#渲染工具详情页
    → buildToolForm()           # 根据 params schema 生成表单
    →用户填写参数 + 点击执行
    → executeTool()             # 收集FormData
    → electronAPI.invoke('vcp-ht-execute-tool-proxy', toolName, args)
    → main.js 拼装<<<[TOOL_REQUEST]>>> 格式请求体→ POST https://{vcpServerUrl}/v1/human/tool (Bearer Token)
    → renderResult()            # 多模态结果渲染
```

### 安全三层

| 层级 | 机制 |
|------|------|
| 进程隔离 | `contextIsolation: true` + `nodeIntegration: false` |
| 通信白名单 | preload.js 只暴露 12 个 IPC 通道 |
| 认证 | Bearer Token（来自 settings.json 的 vcpApiKey）|

---

## 4. 目录结构

```
VCPHumanToolBox/
├── main.js                    # Electron 主进程：窗口管理 + IPC 注册（13.5KB）
├── preload.js                 # 上下文桥：暴露安全 API到 renderer（3.8KB）
├── renderer.js                # UI 核心：工具网格 + 表单 + 结果渲染（67KB）
├── index.html                 # 窗口 HTML骨架（含 Tab 切换：工具/管理）
├── style.css                  # 全部样式（31KB，含 Tool Manager 样式）
├── package.json               # Electron 入口配置
├── start.bat                  # Windows 启动脚本
├── run_silent.vbs             # 无命令行窗口启动（供快捷方式使用）
├── VCHB.lnk                # 桌面快捷方式
│
├── renderer_modules/
│   ├── config.js# 工具定义库（72KB，46个出厂工具）
│   ├── tool-manager.js        # 插件管理模块（48KB，v0.3 新增）
│   └── ui/                    # UI 组件（拖拽排序等辅助组件）
│
├── WorkflowEditormodules/     # 工作流编辑器（部分实现）
│   ├── WorkflowEditor_UIManager.js
│   ├── WorkflowEditor_ExecutionEngine.js
│   ├── WorkflowEditor_NodeManager.js
│   └── WorkflowEditor_StateManager.js
│
└── ComfyUImodules/            # ComfyUI 本地生图集成
```

---

## 5. 工具定义格式

所有工具定义在 `renderer_modules/config.js` 中，`export const tools = { ... }` 对象。

### 格式 A：多命令工具

```javascript
'ZImageTurboGen': {
    displayName: 'Z-Image-Turbo 图片生成/编辑/合成',
    description: '使用 Z-Image-Turbo 生成、编辑或合成图片。',
    commands: {
        'generate': {
            description: '生成图片',
            params: [
                { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                { name: 'prompt', type: 'textarea', required: true, placeholder: '详细描述' },
                { name: 'size', type: 'select', required: false, options: ['1024x1024', '1280x720'], default: '1024x1024' }
            ]
        },
        'edit': {
            description: '编辑图片',
            params: [ /* ... */ ]
        }
    }
}
```

### 格式 B：单命令工具（直接 params）

```javascript
'GoogleSearch': {
    displayName: 'Google 搜索',
    description: '进行标准谷歌网页搜索。',
    params: [
        { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
        { name: 'query', type: 'text', required: true, placeholder: '搜索关键词' }
    ]
}
```

### 7 种参数类型（widget）

| type | 渲染结果 | 适用场景 |
|------|----------|----------|
| `text` | 单行文本框 | 短字符串、名称、ID |
| `textarea` | 多行文本框 | 长描述、提示词、代码 |
| `number` | 数字输入框 | 整数、浮点数 |
| `select` | 下拉菜单 | 枚举值，需配合 `options: []` |
| `radio` | 单选按钮组 | 少量枚举值，需配合 `options: []` |
| `checkbox` | 复选框 | 布尔值，可配合 `default: false` |
| `dragdrop_image` | 拖拽图片上传框 | 图片 URL / base64 / 本地文件 |

### 参数字段完整说明

```javascript
{
    name: 'size',           // 必需：参数名（与 VCP 工具调用字段名一致）
    type: 'select',         // 必需：见上表
    required: true,         // 可选：是否必填，默认 false
    placeholder: '描述',    // 可选：输入框占位文字
    default: '1024x1024',   // 可选：默认值
    options: ['a', 'b'],    // select/radio必需
    min: 1, max: 100,       // number 可用
    step: 0.1,              // number 可用
    description: '说明',    // 可选：额外说明文字
    dependsOn: {// 可选：条件显示
        field: 'mode',
        value: 'i2v'        // 仅当 mode=i2v 时显示此参数
    }
}
```

---

## 6. 新增工具的两条路径

### 路径 A：直接修改 config.js（推荐，适合开发者）

在 `renderer_modules/config.js` 的 `tools` 对象中按格式添加新条目。
**无需重启**（热重载）—— 但推荐重启 HumanToolBox 子窗口生效。
**优先级**：会被用户通过插件管理面板导入的同名工具覆盖（Config Overlay 机制）。

```javascript
// 在 config.js 末尾的 tools 对象中添加：
'MyNewTool': {
    displayName: '我的新工具',
    description: '描述这个工具做什么。[后端插件: MyNewTool]',
    params: [
        { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
        { name: 'input', type: 'textarea', required: true, placeholder: '输入内容' }
    ]
}
```

### 路径 B：通过插件管理面板导入（推荐，适合用户）

1. 点击顶部 **「管理」Tab**
2. 点击 **「导入插件」**，首次使用需配置后端连接（主机/端口/用户名/密码）
3. 从插件列表中勾选需要导入的插件，支持模糊搜索
4. 点击 **「导入选中」**——工具会立即出现在工具网格中
5. 如需调整参数定义，点击管理列表中的卡片进入**编辑对话框**

**Config Overlay 规则**：用户导入的工具定义优先于config.js 中的同名工具。

---

## 7. 插件管理面板（v0.3）

> 本节描述 2026-06-25 合并的新功能，核心模块为 `renderer_modules/tool-manager.js`。

### 功能概览

| 功能 | 说明 |
|------|------|
| 从后端导入 | 调用 `/admin_api/plugins`，将后端插件定义转换为本地工具定义 |
| 参数自动解析 | 从manifest description 文本自动提取参数 schema（无需 AI） |
| CRUD | 管理面板中对已导入工具进行编辑、批量删除 |
| 表单编辑器 | 可视化编辑参数名/类型/必填/占位符/选项，支持新增/删除参数 |
| Raw JSON编辑 | 直接编辑工具定义的 JSON，与表单编辑器双向同步 |
| 全局搜索 | 在管理面板和导入列表中模糊匹配工具名/描述 |

### 参数自动解析引擎（parseDescription）

当插件 manifest 的 `parameters` 字段为空时，自动从 `description` 文本提取参数。支持四种格式：

```
# 格式 A（VCPClawMail、VCPAlarm风格）
- 参数名 (类型, 必填): 描述
- mailbox/alias: 可选，子邮箱槽位 mail1/mail2/mail3/mail4

# 格式 B（TopicSponsor 风格）
1. `topic_name`: 「始」xxx「末」 (必需)

# 格式 D（AgentAssistant 风格）
参数名:「始」(必需/可选)描述内容「末」

# 格式 F（AgnesGen / DoubaoGen 风格——嵌入在<<<[TOOL_REQUEST]>>> 示例中）
<<<[TOOL_REQUEST]>>>
tool_name:「始」AgnesGen「末」,
prompt:「始」(必需) 提示词描述「末」,
size:「始」(可选) 图片尺寸「末」,
<<<[END_TOOL_REQUEST]>>>
```

**三层Fallback 策略**：
1. `parameters` 对象存在且非空 → 用`parseParams`（最可靠）
2. `parameters` 为空 → 用 `parseDescription` 从文本解析
3. 解析失败 → 只保留`maid` 参数（保证工具可用）

### 用户数据存储

导入的工具定义存储在 `settings.vcpht_userTools` 字段（随`AppData/settings.json` 持久化）。

**不新增任何 IPC 通道**，复用已有的 `vcp-ht-get-settings` / `vcp-ht-save-settings`。

### 管理模式说明

- **默认**：点击工具卡片直接打开编辑对话框
- **删除模式**：点击「删除模式」按钮进入，点击卡片选中/取消，再次点击按钮确认批量删除

### 后端连接配置

管理面板需要连接 VCPToolBox 后端的 Admin API：

| 字段 | 说明 | 默认值 |
|------|------|--------|
|主机 | VCPToolBox 所在主机 | `localhost` |
| 端口 | VCPToolBox 监听端口 | `6005` |
| 用户名 | Admin API 用户名 | 见 VCPToolBox 配置 |
| 密码 | Admin API 密码 | 见 VCPToolBox 配置 |

配置存储于 `localStorage`（`vcpht_adminConfig`），与 contextIsolation 隔离保护。

---

## 8. 工作流编辑器（现状）

>⚠️ **部分实现**：UI 框架和节点管理已完成，工具执行管线为空壳，不建议在生产中依赖。

### 已实现

-基于 jsPlumb 的可视化节点画布
- 节点类型：VCPChat插件、VCPToolBox 插件、辅助节点
- 节点状态管理（位置、配置、连接）
- 侧边栏插件面板（搜索、分类、拖拽到画布）
- 工作流保存/加载

### 空壳（或许未实现）

- `executeVCPChatPlugin()`：调用 VCPChat Agent 的逻辑为空壳
- `executeVCPToolBoxPlugin()`：调用 VCPToolBox工具的逻辑为空壳
- 节点间数据传递（输出变量注入下一节点的输入）

### 后续计划

完成执行引擎需要对接：
1. `vcp-ht-execute-tool-proxy` IPC（工具执行已有，需接入工作流上下文）
2. 变量替换引擎（`{{node_1.output}}` →实际值）
3. 错误处理与节点状态回显

---

## 9. ComfyUI 集成

HumanToolBox 对 `ComfyUIGen` 工具有专属支持：

- 点击工具卡片右上角的⚙️ 设置按钮打开 **ComfyUI 配置抽屉**
- 支持：查看/保存 ComfyUI 配置、管理工作流模板、导入/转换 ComfyUI 原生工作流

IPC 通道（见 preload.js）：
```
comfyui:get-config
comfyui:save-config
comfyui:get-workflows
comfyui:read-workflow
comfyui:save-workflow
comfyui:delete-workflow
comfyui:get-plugin-path
comfyui:import-and-convert-workflow
comfyui:validate-workflow-template
```

---

## 10. IPC 通道白名单

`preload.js` 中 `allowedChannels` 严格限制可用通道（共12 个）：

| 通道 | 用途 |
|------|------|
| `vcp-ht-execute-tool-proxy` | 核心：工具调用代理 |
| `vcp-ht-get-settings` | 读取 settings.json |
| `vcp-ht-save-settings` | 写入 settings.json（含 vcpht_userTools）|
| `vcp-ht-process-wallpaper` | 壁纸处理 |
| `comfyui:*`（7个）| ComfyUI 相关操作 |
| `window-control`（send） | 窗口最小化/关闭 |

**新增 IPC 原则**：在 `main.js` 中注册，在 `preload.js` 的 `allowedChannels` 中添加白名单，缺一不可。

---

## 11. 开发指南

### 新增工具卡片（最低成本）

只改`config.js`，零改动其他文件。

### 修改 UI 或执行逻辑

改 `renderer.js`，注意：
- `allTools = { ...tools, ...userTools }` ——工具网格从 `allTools` 读取，不要直接访问 `tools`
- `window.refreshToolGrid`——插件管理面板保存后调用此函数触发网格刷新
- `buildToolForm()` 支持 `dependsOn` 条件显示，修改时保持兼容

### 新增 IPC 通道

1. `main.js`：`ipcMain.handle('channel-name', handler)`
2. `preload.js`：`allowedChannels` 数组中添加 `'channel-name'`

### 本地测试

```bash
cd VCPHumanToolBox
# 确保 VCPChat 主进程已运行
start.bat
```

### 常见问题

**Q：导入插件后工具卡片没有更新？**  
A：检查 `renderer.js` 中 `window.refreshToolGrid` 是否已在`initializeUI` 中正确赋值。

**Q：工具执行返回 401/403？**  
A：检查 `AppData/settings.json` 中的 `vcpApiKey` 是否有效，以及 VCPDistributedServer 是否正在运行。

**Q：插件管理面板导入后参数都是空的？**  
A：该插件的 manifest description 格式不在已支持的四种格式（A/B/D/F）中。通过「编辑」→「表单编辑」手动补充参数，或联系插件作者在 manifest 中补充结构化`parameters` 字段。

**Q：搜索框无法输入？**  
A：是事件监听器重复绑定导致的已知 Bug，重启 HumanToolBox 子窗口可临时解决。根本修复见 `attachEventListeners()` 开头的 `cloneNode` 方案。

---

## 变更日志

### v0.3（2026-06-25）
- 新增：插件管理面板（`tool-manager.js`）
- 新增：`parseDescription` 四格式参数自动解析引擎
- 新增：可视化表单编辑器（参数类型/必填/占位符/选项均可编辑）
- 新增：批量删除模式、全局搜索框
- 修复：invocationCommands 数组/对象格式兼容
- 修复：导入/删除后实时刷新工具网格（无需重启）

### v0.2（2026-06-25）
- 新增：插件管理 Tab（index.html + renderer.js）
- 新增：Config Overlay 机制（user-tools优先于 config.js）
- 新增：`allTools` 动态合并，renderer.js 全面迁移

### v0.1（初始版本）
- 工具网格、动态表单、多模态结果渲染
- ComfyUI 集成、工作流编辑器框架