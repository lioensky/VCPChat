# ComfyUI 模块系统架构文档

## 概述

ComfyUI 模块系统是 VCPChat 应用中用于集成 ComfyUI 图像生成功能的完整前端模块化架构。该系统采用模块化设计，分离关注点，实现了状态管理、UI 管理、配置管理和 IPC 通信的解耦。

## 核心架构

### 1. 模块层级结构

```
ComfyUImodules/
├── ComfyUILoader.js          # IPC 调用封装层
├── ComfyUI_StateManager.js   # 状态管理器（单例）
├── ComfyUI_UIManager.js      # UI 管理器（单例）
├── comfyUIConfig.js          # 配置协调器（单例）
├── comfyUIHandlers.js        # 主进程 IPC 处理器
├── PathResolver.js           # 路径解析工具
├── comfyui.css              # 专用样式文件
└── README.md                # 用户使用指南
```

### 2. 架构模式

采用 **Coordinator Pattern（协调器模式）** + **Singleton Pattern（单例模式）**：

- **分层解耦**：每个模块职责单一，通过统一接口协调
- **单例管理**：核心管理器使用单例模式确保状态一致性
- **事件驱动**：基于 IPC 事件和 DOM 事件的响应式更新

## 模块详细分析

### ComfyUILoader.js
**功能**：IPC 调用封装与事件订阅统一接口
**关键特性**：
- 统一封装 `electronAPI` 和 `ipcRenderer` 调用
- 提供降级兼容处理（优先使用白名单 API）
- 暴露完整的 ComfyUI API 调用接口

```javascript
const invoke = (ch, data) => {
    // 优先通过 window.electronAPI 调用以遵循白名单
    if (window.electronAPI && typeof window.electronAPI.invoke === 'function') {
        return window.electronAPI.invoke(ch, data);
    }
    return ipcRenderer.invoke(ch, data);
};
```

**主要方法**：
- `getConfig()` / `saveConfig()` - 配置管理
- `getWorkflows()` / `readWorkflow()` / `saveWorkflow()` - 工作流管理
- `watchConfig()` / `onConfigChanged()` - 配置文件监听

### ComfyUI_StateManager.js
**功能**：集中式状态管理（单例模式）
**关键特性**：
- 管理 ComfyUI 配置状态和运行时状态
- 提供异步配置加载/保存（支持 localStorage 降级）
- 分离持久化配置和运行时数据（如可用 LoRA 列表）

```javascript
class ComfyUI_StateManager {
    constructor() {
        this.config = { /* 默认配置 */ };
        this.isConnected = false;
        this._availableLoRAs = []; // 运行时数据，不持久化
    }
}
```

**核心状态**：
- `config`：持久化配置对象
- `isConnected`：连接状态
- `_availableLoRAs`：运行时可用 LoRA 列表
- `isHandlingConfigChange`：配置变更锁定标志

### ComfyUI_UIManager.js
**功能**：UI 渲染和 DOM 操作管理（单例模式）
**关键特性**：
- DOM 元素缓存机制（`domCache`）
- 统一事件注册管理
- 模块化 UI 组件生成（表单、列表、模态等）
- 智能降级 Toast 通知

```javascript
class ComfyUI_UIManager {
    constructor() {
        this.domCache = new Map(); // DOM 缓存
    }
    
    getElement(id, useCache = true) {
        // 缓存机制减少 DOM 查询
    }
    
    createPanelContent(container, coordinator, options) {
        // 完整 UI 结构生成
    }
}
```

**核心功能**：
- `createPanelContent()`：生成完整配置面板
- `populateForm()` / `updateWorkflowList()`：数据驱动 UI 更新
- `showToast()` / `openModal()`：用户交互反馈

### comfyUIConfig.js
**功能**：协调器模式的核心控制器（单例模式）
**关键特性**：
- 协调 StateManager 和 UIManager 的交互
- 统一业务逻辑处理（连接测试、配置保存等）
- 异步数据加载和错误处理
- 网络请求管理（带超时的 fetch）

```javascript
class ComfyUIConfigManager {
    constructor() {
        this.stateManager = window.ComfyUI_StateManager;
        this.uiManager = window.ComfyUI_UIManager;
    }
    
    async createUI(container, options = {}) {
        await this.loadConfig();
        this.uiManager.createPanelContent(container, this, options);
        // ... 初始化逻辑
    }
}
```

**核心方法**：
- `createUI()` / `close()`：UI 生命周期管理
- `testConnection()`：ComfyUI 服务器连接测试
- `loadAvailableModels()`：动态模型/采样器列表加载
- `refreshWorkflows()`：工作流列表刷新

### comfyUIHandlers.js
**功能**：主进程 IPC 处理器集合
**关键特性**：
- PathResolver 集成的路径解析
- 文件系统操作（配置、工作流 CRUD）
- 配置文件变更监听
- 工作流模板转换和验证

```javascript
function initialize(mainWindow) {
    // 配置管理处理器
    ipcMain.handle('comfyui:save-config', async (event, config) => {
        const configFile = await pathResolver.getConfigFilePath();
        await fs.writeJson(configFile, config, { spaces: 2 });
    });
    
    // 工作流管理处理器
    ipcMain.handle('comfyui:get-workflows', async () => {
        const workflowsDir = await pathResolver.getWorkflowsPath();
        // ... 工作流扫描逻辑
    });
}
```

### PathResolver.js
**功能**：跨环境路径发现工具
**关键特性**：
- 多策略路径解析（环境变量 → 相对路径 → 常见位置 → 向上搜索 → 用户目录）
- 跨平台兼容性（Windows、macOS、Linux）
- 路径验证和降级处理

```javascript
class PathResolver {
    async findVCPToolBoxPath() {
        const strategies = [
            this.findByEnvironmentVariable,
            this.findByRelativePath,
            this.findByCommonLocations,
            this.findBySearchUp,
            this.findByUserDataDir
        ];
        
        for (const strategy of strategies) {
            const result = await strategy();
            if (result) return result;
        }
    }
}
```

## 数据流架构

### 1. 初始化流程
```
页面加载 → comfyUIConfig.createUI()
         ↓
StateManager.loadConfig() → 加载持久化配置
         ↓
UIManager.createPanelContent() → 生成 UI 结构
         ↓
populateForm() + 事件绑定 → 数据驱动渲染
```

### 2. 配置保存流程
```
用户操作 → updateConfigFromForm() → StateManager 状态更新
        ↓
saveConfig() → IPC 调用主进程
        ↓
comfyUIHandlers → PathResolver → 文件系统写入
```

### 3. 实时更新流程
```
配置文件变更 → fs.watch() → IPC 事件
            ↓
前端事件监听 → loadConfig() → UI 刷新
```

## 技术特点

### 1. 模块化设计优势
- **职责分离**：状态、UI、业务逻辑完全解耦
- **可测试性**：每个模块可独立测试
- **可维护性**：修改某个模块不影响其他模块
- **可扩展性**：新增功能只需扩展对应模块

### 2. 性能优化策略
- **DOM 缓存**：减少重复 DOM 查询
- **事件委托**：统一事件管理减少内存占用
- **按需加载**：延迟初始化非关键组件
- **异步处理**：避免阻塞主线程的长时间操作

### 3. 错误处理机制
- **降级处理**：localStorage 降级、兜底配置
- **网络容错**：请求超时、连接失败处理
- **用户反馈**：Toast 通知、状态指示器

### 4. 兼容性保证
- **API 白名单优先**：优先使用 `electronAPI`
- **跨平台路径**：PathResolver 多策略解析
- **版本兼容**：配置版本管理和迁移

## 依赖关系图

```
┌─────────────────┐    ┌──────────────────┐
│  Main Process   │◄───┤ comfyUIHandlers │
│   (Electron)    │    └──────────────────┘
└─────────────────┘              │
         ▲                       │
         │ IPC              ┌────▼────┐
         │                  │PathReso-│
┌─────────────────┐         │lver.js  │
│ComfyUILoader.js │         └─────────┘
│   (IPC Wrapper) │
└─────────────────┘
         ▲
         │
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│comfyUIConfig.js │◄──►│ComfyUI_StateMan- │    │ComfyUI_UIManager│
│  (Coordinator)  │    │ager.js (State)   │    │   (UI Logic)    │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         ▲                                               │
         │                                               │
         └───────────────────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   comfyui.css     │
                    │  (UI Styling)     │
                    └───────────────────┘
```

## API 接口规范

### StateManager API
```javascript
// 配置管理
getConfig() → Object
updateConfig(config) → void
set(key, value) → void
get(key) → any

// 状态管理
isConnectionActive() → boolean
setConnectionStatus(status) → void

// LoRA 管理
setAvailableLoRAs(loras) → void
getAvailableLoRAs() → Array

// 异步操作
loadConfig() → Promise<void>
saveConfig() → Promise<void>
```

### UIManager API
```javascript
// DOM 管理
getElement(id, useCache) → Element
clearDOMCache() → void

// 事件管理
register(selector, event, handler, opts) → Element
registerAll(selector, event, handler, opts) → Array

// UI 操作
showToast(message, type) → void
openModal(modalId) → void
createPanelContent(container, coordinator, options) → void

// 数据更新
populateForm(config) → void
updateWorkflowList(workflows, coordinator) → void
updateModelOptions(models, currentModel) → void
```

### Coordinator API
```javascript
// 生命周期
createUI(container, options) → Promise<void>
close() → void

// 业务操作
testConnection() → Promise<void>
saveConfig() → Promise<void>
loadAvailableModels() → Promise<void>
refreshWorkflows() → Promise<void>

// 用户交互
viewWorkflow(workflowName) → Promise<void>
applyPreset(dataset) → void
```

## 最佳实践建议

### 1. 模块扩展
- 新功能优先扩展现有模块，避免创建新的单例
- UI 组件通过 UIManager 统一管理
- 业务逻辑通过 Coordinator 统一协调

### 2. 状态管理
- 持久化状态通过 StateManager 管理
- 运行时状态与配置状态分离
- 避免直接操作 DOM，通过 UIManager 抽象

### 3. 错误处理
- 异步操作必须包含 try-catch
- 用户操作提供即时反馈（Toast、状态更新）
- 网络操作设置合理超时时间

### 4. 性能优化
- 使用 DOM 缓存减少查询开销
- 避免频繁的配置保存操作
- 大量 DOM 操作使用 DocumentFragment

这个架构提供了一个可维护、可扩展的 ComfyUI 集成方案，适合中大型项目的模块化开发需求。