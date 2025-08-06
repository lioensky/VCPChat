# ComfyUI IPC 通道实现文档

## 概述

本文档描述了 VCPHumanToolBox 与 ComfyUI 后端之间的 IPC（进程间通信）通道实现。该系统支持配置管理、工作流操作和实时文件变更监听。

## IPC 通道架构

### 1. 通道前缀
所有 ComfyUI 相关的 IPC 通道都使用 `comfyui:` 前缀，以区分其他模块的通信。

### 2. 主要组件

#### 2.1 主进程端 (Main Process)
- **文件**: `VCPChat/modules/ipc/comfyui-ipc.js`
- **功能**: 处理所有 `comfyui:*` 请求，包括文件操作和路径解析
- **依赖**:
  - `PathResolver`: 路径解析工具
  - 使用 Node.js 内置的 `fs.promises` 进行文件操作

#### 2.2 Preload 脚本
- **文件**: `VCPChat/VCPHumanToolBox/preload.js`
- **功能**: 安全地暴露 IPC 接口到渲染进程
- **特点**:
  - 使用 `contextBridge` 暴露 `comfyuiAPI` 和 `electronAPI`
  - 限制只允许特定的 IPC 通道
  - 保持与现有代码的兼容性

#### 2.3 渲染进程端 (Renderer Process)
- **文件**: `VCPChat/VCPHumanToolBox/renderer.js`
- **功能**: 提供 `window.electronAPI` 接口供前端调用
- **特点**: 项目同时支持 `nodeIntegration: true` 和 preload.js

#### 2.4 配置协调器
- **文件**: `VCPChat/VCPHumanToolBox/ComfyUImodules/comfyUIConfig.js`
- **功能**: 协调各模块状态，管理配置和工作流

## IPC 通道列表

### 1. 配置管理

#### `comfyui:get-config`
获取 ComfyUI 配置文件内容
```javascript
// 请求
await window.electronAPI.invoke('comfyui:get-config')

// 响应
{
  success: true,
  data: { /* 配置对象 */ }
}
// 或错误
{
  success: false,
  error: "错误信息"
}
```

#### `comfyui:save-config`
保存配置到文件
```javascript
// 请求
await window.electronAPI.invoke('comfyui:save-config', configData)

// 响应
{
  success: true,
  data: { /* 保存的配置 */ }
}
```

### 2. 工作流管理

#### `comfyui:get-workflows`
获取所有工作流列表
```javascript
// 请求
await window.electronAPI.invoke('comfyui:get-workflows')

// 响应
{
  success: true,
  workflows: ["workflow1.json", "workflow2.json"]
}
```

#### `comfyui:get-workflow`
获取指定工作流内容
```javascript
// 请求
await window.electronAPI.invoke('comfyui:get-workflow', 'workflow1.json')

// 响应
{
  success: true,
  data: { /* 工作流内容 */ }
}
```

#### `comfyui:save-workflow`
保存工作流文件
```javascript
// 请求
await window.electronAPI.invoke('comfyui:save-workflow', {
  filename: 'new-workflow.json',
  data: { /* 工作流数据 */ }
})

// 响应
{
  success: true,
  data: { /* 保存的工作流 */ }
}
```

#### `comfyui:delete-workflow`
删除工作流文件
```javascript
// 请求
await window.electronAPI.invoke('comfyui:delete-workflow', 'workflow1.json')

// 响应
{
  success: true
}
```

### 3. 路径查询

#### `comfyui:get-plugin-path`
获取 ComfyUI 插件路径
```javascript
// 请求
await window.electronAPI.invoke('comfyui:get-plugin-path')

// 响应
{
  success: true,
  path: "D:\\workspace\\VCPChat\\VCPToolBox\\Plugin\\ComfyUIGen"
}
```

## 事件通道（预留）

当前版本已移除文件监听功能，以下事件通道接口已预留但未实现：

### `comfyui:config-changed`
配置文件变更事件（未实现）
```javascript
// 预留接口，当前不会触发
window.electronAPI.on('comfyui:config-changed', (data) => {
  console.log('配置已更新:', data);
});
```

### `comfyui:workflows-changed`
工作流目录变更事件（未实现）
```javascript
// 预留接口，当前不会触发
window.electronAPI.on('comfyui:workflows-changed', (workflows) => {
  console.log('工作流列表已更新:', workflows);
});
```

注：如需实现文件监听功能，可以考虑使用轮询或其他不依赖 chokidar 的方案。

## 错误处理

所有 IPC 调用都遵循统一的错误格式：

```javascript
{
  success: false,
  error: "错误描述信息"
}
```

常见错误类型：
- 文件不存在
- 权限不足
- JSON 解析错误
- 路径解析失败

## 使用示例

### 1. 初始化配置
```javascript
async function initializeConfig() {
  try {
    const result = await window.electronAPI.invoke('comfyui:get-config');
    if (result.success) {
      // 使用配置数据
      updateUIWithConfig(result.data);
    } else {
      console.error('加载配置失败:', result.error);
    }
  } catch (error) {
    console.error('IPC 调用失败:', error);
  }
}
```

### 2. 使用 Preload API
```javascript
// 使用专用的 comfyuiAPI
const config = await window.comfyuiAPI.getConfig();
const workflows = await window.comfyuiAPI.getWorkflows();

// 或使用通用的 electronAPI
const config = await window.electronAPI.invoke('comfyui:get-config');
```

### 3. 工作流操作
```javascript
// 获取工作流列表
const workflows = await window.electronAPI.invoke('comfyui:get-workflows');

// 加载特定工作流
const workflow = await window.electronAPI.invoke('comfyui:get-workflow', 'my-workflow.json');

// 保存新工作流
await window.electronAPI.invoke('comfyui:save-workflow', {
  filename: 'new-workflow.json',
  data: workflowData
});
```

## 安全考虑

1. **路径验证**: 所有文件操作都限制在 ComfyUI 插件目录内
2. **输入验证**: 文件名和数据都经过验证，防止路径遍历攻击
3. **错误隔离**: 错误信息不会暴露系统路径或敏感信息

## 性能优化

1. **无文件监听**: 移除了 chokidar 依赖，减少了系统资源占用
2. **缓存机制**: 配置数据在内存中缓存，减少文件读取
3. **异步操作**: 所有 IPC 调用都是异步的，不会阻塞 UI
4. **按需加载**: 只在需要时读取配置和工作流文件

## 后续扩展

1. **批量操作**: 支持批量导入/导出工作流
2. **版本控制**: 工作流版本管理和回滚
3. **文件监听**: 可选的文件变更监听（使用轮询或其他轻量级方案）
4. **性能监控**: IPC 调用的性能统计和优化

## 依赖说明
  - `fs-extra`: 用于文件操作（在主进程中）
  - `sharp`: 用于图像处理
  - `marked`: 用于 Markdown 渲染