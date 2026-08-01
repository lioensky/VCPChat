# LoomController

VCP Loom Agent 控制器，为 Agent 提供 LoomAPP 的创建、查询、打开、关闭、源码读取和配置编辑能力。

> 当前版本：1.0.0  
> 插件类型：hybridservice  
> 通信协议：direct  
> VCP 工具名：LoomController

## 1. 版本记录

### 1.0.0 — 初始版本

LoomController 1.0.0 是 Agent 与 VCP Loom 之间的第一版完整业务适配器。

初始版本包含：

- 查询全部已注册 LoomAPP。
- 感知当前打开的 LoomAPP。
- 创建完整 LoomAPP。
- 打开或聚焦 LoomAPP。
- 关闭 LoomAPP。
- 查询 LoomAPP 配置清单与注入源码。
- 查询当前运行页面的 DOM HTML 源码。
- 查询当前页面已渲染成功的文本内容。
- 编辑 LoomAPP 配置、CSS 和 JavaScript。
- 对运行中的应用热应用配置与注入变更。
- 使用 AI 友好的 `content` 数组返回结果。
- 在 `details` 中提供结构化业务数据。

## 2. 插件结构

```text
LoomController/
├─ plugin-manifest.json
├─ LoomControllerService.js
└─ README.md
```

文件用途：

- `plugin-manifest.json`
  - 注册 LoomController 工具。
  - 定义 direct 混合服务通信方式。
  - 分别注册多个 Agent 命令。
  - `description` 提供给 AI。
  - `example` 提供给前端。

- `LoomControllerService.js`
  - 解析 Agent 参数。
  - 分发不同业务命令。
  - 调用 Electron 主进程持有的 Loom 管理器。
  - 格式化 AI 友好结果。

- `README.md`
  - 记录版本、架构、使用方式和后续计划。

## 3. 工作原理

调用链：

```text
Agent
  ↓
VCP 后端服务器
  ↓ execute_tool
VCPDistributedServer
  ↓ hybridservice / direct
LoomControllerService
  ↓ services.loomManager
VCPLoomManager
  ↓
LoomAPP BrowserWindow / WebContentsView / 磁盘源码
```

LoomController 不启动额外子进程，也不通过本地 HTTP 中转。

插件通过 direct 服务容器取得 Electron 主进程已经初始化的 Loom 管理器，并直接调用明确的业务方法。

Agent 权限审批和工具授权由 VCP 后端服务器统一处理。LoomController 只负责业务参数校验、命令分发、LoomAPP 操作和结果返回。

## 4. 基本调用格式

所有操作都使用同一个工具名：

```text
LoomController
```

通过 `command` 参数选择具体操作：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」LoomController「末」,
command:「始」ListApps「末」
<<<[END_TOOL_REQUEST]>>>
```

插件也兼容使用 `action` 或 `commandIdentifier` 传递命令，但推荐统一使用 `command`。

应用 ID 推荐使用 `appId`，同时兼容：

- `app_id`
- `id`

## 5. 命令说明

当前 1.0.0 版本提供 9 个命令：

| 命令 | 用途 | 是否要求应用已打开 |
|------|------|--------------------|
| `ListApps` | 查询全部已注册 LoomAPP | 否 |
| `ListOpenApps` | 感知当前打开的 LoomAPP | 否 |
| `CreateApp` | 创建完整 LoomAPP | 否 |
| `OpenApp` | 打开或聚焦 LoomAPP | 否 |
| `CloseApp` | 关闭 LoomAPP | 否 |
| `GetAppSources` | 查询配置、CSS 和 JavaScript | 否 |
| `GetRuntimeSource` | 查询当前运行时 DOM HTML | 是 |
| `GetRenderedText` | 查询已渲染成功文本 | 是 |
| `EditAppSources` | 编辑配置、CSS 和 JavaScript | 否 |

## 6. ListApps

查询当前设备中已注册的全部 LoomAPP。

### 参数

- `command`：固定为 `ListApps`。

### 示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」LoomController「末」,
command:「始」ListApps「末」
<<<[END_TOOL_REQUEST]>>>
```

### 返回内容

- 应用 ID。
- 应用名称。
- 启动 URL。
- 启用状态。
- 当前运行状态。
- 完整结构化应用列表。

## 7. ListOpenApps

感知当前已经打开的 LoomAPP。

### 参数

- `command`：固定为 `ListOpenApps`。

### 示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」LoomController「末」,
command:「始」ListOpenApps「末」
<<<[END_TOOL_REQUEST]>>>
```

### 返回内容

每个运行实例包含：

- `appId`
- `name`
- 当前 `url`
- `running`
- `loading`
- 最近 `error`
- `pageTitle`
- `lastSuccessfulRenderAt`
- 当前应用清单

## 8. CreateApp

一次性提交配置清单、CSS 和 JavaScript，创建完整 LoomAPP。

### 参数

- `command`：固定为 `CreateApp`。
- `manifest`：JSON 对象或 JSON 字符串，必需。
- `css`：完整 `inject.css` 内容，可选。
- `js`：完整 `inject.js` 内容，可选。

也兼容：

- 使用 `config` 代替 `manifest`。
- 使用 `injectCss` 代替 `css`。
- 使用 `injectJs` 代替 `js`。

### 最小示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」LoomController「末」,
command:「始」CreateApp「末」,
manifest:「始」{"id":"example-app","name":"示例应用","startUrl":"https://example.com/"}「末」
<<<[END_TOOL_REQUEST]>>>
```

### 完整示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」LoomController「末」,
command:「始」CreateApp「末」,
manifest:「始」{"id":"example-app","name":"示例应用","description":"Agent 创建的 LoomAPP","startUrl":"https://example.com/","enabled":true,"exposeInAppDrawer":true,"exposeManagerInAppDrawer":true,"emoji":"🕸️","window":{"width":420,"height":780,"minWidth":320,"minHeight":480,"maxWidth":null,"maxHeight":null,"resizable":true},"viewport":{"width":390,"height":700,"autoResize":true},"request":{"profile":"mobile","userAgent":"","headers":{"X-VCP-Loom":"example-app"}},"navigation":{"allowPopups":false,"openExternalOriginsInBrowser":false}}「末」,
css:「始」body { font-family: sans-serif; }「末」,
js:「始」console.log('Loom injection loaded');「末」
<<<[END_TOOL_REQUEST]>>>
```

### 配置限制

- 应用 ID 必须为 2-64 位。
- ID 仅允许小写字母、数字、短横线和下划线。
- ID 必须以字母或数字开头。
- 启动 URL 仅支持 HTTP 和 HTTPS。
- 请求头不能覆写 `Cookie` 和 `Host`。
- 单个 CSS 或 JavaScript 文件不能超过 Loom 管理器规定的体积限制。
- 已存在的应用 ID 不能重复创建。

## 9. OpenApp

打开指定 LoomAPP。

若应用已经打开，将恢复、显示并聚焦现有单例窗口。

### 参数

- `command`：固定为 `OpenApp`。
- `appId`：必需。

### 示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」LoomController「末」,
command:「始」OpenApp「末」,
appId:「始」example-app「末」
<<<[END_TOOL_REQUEST]>>>
```

应用必须存在且处于启用状态。

## 10. CloseApp

关闭指定 LoomAPP 的当前运行窗口。

### 参数

- `command`：固定为 `CloseApp`。
- `appId`：必需。

### 示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」LoomController「末」,
command:「始」CloseApp「末」,
appId:「始」example-app「末」
<<<[END_TOOL_REQUEST]>>>
```

该操作不会：

- 删除 LoomAPP。
- 删除配置和注入脚本。
- 清理 Cookie。
- 清理登录会话。
- 清理 LocalStorage 或 IndexedDB。

## 11. GetAppSources

查询 LoomAPP 保存于磁盘的完整业务源码。

### 参数

- `command`：固定为 `GetAppSources`。
- `appId`：必需。

### 示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」LoomController「末」,
command:「始」GetAppSources「末」,
appId:「始」example-app「末」
<<<[END_TOOL_REQUEST]>>>
```

### 返回内容

- 标准化后的 `loom.json`。
- 完整 `inject.css`。
- 完整 `inject.js`。
- 当前运行状态。

该命令不要求 LoomAPP 已经打开。

## 12. GetRuntimeSource

查询已打开 LoomAPP 当前页面的运行时 HTML。

### 参数

- `command`：固定为 `GetRuntimeSource`。
- `appId`：必需。

### 示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」LoomController「末」,
command:「始」GetRuntimeSource「末」,
appId:「始」example-app「末」
<<<[END_TOOL_REQUEST]>>>
```

### 源码语义

运行时源码来自：

```javascript
document.documentElement.outerHTML
```

因此它是当前 DOM 的序列化结果，包括：

- 页面脚本执行后的 DOM。
- SPA 当前页面状态。
- 动态加载的元素。
- Loom 注入脚本造成的 DOM 变化。

它不是网络服务器最初响应的原始 HTML。

运行时源码过大时会被截断，并返回：

- `originalByteLength`
- `truncated`
- `capturedAt`

当前返回上限为 4 MB。

## 13. GetRenderedText

查询已打开 LoomAPP 当前页面的已渲染文本。

### 参数

- `command`：固定为 `GetRenderedText`。
- `appId`：必需。
- `refresh`：可选，默认 `true`。

### 示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」LoomController「末」,
command:「始」GetRenderedText「末」,
appId:「始」example-app「末」,
refresh:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

### 文本语义

文本来自：

```javascript
document.body.innerText
```

- `refresh: true`
  - 立即读取当前页面文本。
  - 更新最近成功渲染快照。

- `refresh: false`
  - 返回最近一次成功渲染快照。
  - 如果尚无快照，则执行首次读取。

页面加载完成后，Loom 会先应用 CSS 和 JavaScript 注入，再自动保存成功渲染文本快照。

当前文本返回上限为 500,000 UTF-8 字节。

## 14. EditAppSources

编辑指定 LoomAPP 的配置、CSS 和 JavaScript。

### 参数

- `command`：固定为 `EditAppSources`。
- `appId`：必需。
- `manifest`：可选。
- `css`：可选。
- `js`：可选。

`manifest`、`css` 和 `js` 至少提交一项。

### 示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」LoomController「末」,
command:「始」EditAppSources「末」,
appId:「始」example-app「末」,
manifest:「始」{"name":"示例应用 Pro","viewport":{"width":430,"height":760,"autoResize":false}}「末」,
css:「始」body { overflow-x: hidden; }「末」,
js:「始」document.documentElement.dataset.loomReady = 'true';「末」
<<<[END_TOOL_REQUEST]>>>
```

### 更新规则

- 未提交的部分保持原值。
- `manifest` 支持部分更新。
- 以下嵌套字段会与当前值合并：
  - `window`
  - `viewport`
  - `request`
  - `navigation`
  - `injection`
- `css` 一旦提交，视为完整 `inject.css` 新内容。
- `js` 一旦提交，视为完整 `inject.js` 新内容。
- 传空字符串可以清空相应注入文件。

### 运行时热更新

如果应用正在运行，将立即：

- 更新窗口标题。
- 更新窗口尺寸限制。
- 更新窗口是否允许调整尺寸。
- 更新页面视口。
- 移除旧 CSS 并插入新 CSS。
- 执行新的 JavaScript 注入脚本。
- 更新成功渲染文本快照。

部分页面启动参数、请求头或目标网站缓存可能需要刷新或重新打开应用后才能完整生效。

## 15. 返回格式

LoomController 使用 AI 友好的 content 数组：

```json
{
  "content": [
    {
      "type": "text",
      "text": "命令执行结果"
    }
  ],
  "details": {
    "command": "ListApps",
    "count": 1,
    "apps": []
  }
}
```

字段说明：

- `content`
  - 提供给 AI 阅读。
  - 可包含自然语言、Markdown、源码和页面文本。

- `details`
  - 提供结构化业务数据。
  - 便于前端或后续工具稳定读取。
  - 不需要从自然语言文本中重新提取字段。

## 16. 当前版本边界

LoomController 1.0.0 专注于 LoomAPP 生命周期、源码和运行时感知。

当前版本不包含：

- 模拟鼠标点击。
- 根据选择器点击元素。
- 输入文本。
- 键盘按键。
- 页面滚动。
- 元素选择。
- 表单提交。
- 等待元素出现。
- 等待页面状态。
- 截图和元素截图。
- 连续自动化脚本。
- 操作重试、取消和回放。

## 17. 后续计划：Agent 模拟操作

后续版本会加入 Agent 对 LoomAPP 的模拟操作能力，使 Agent 不仅能读取和编辑应用，还能在受控 LoomAPP 页面中完成连续交互。

计划能力包括：

### 17.1 元素感知

- 查询当前页面可交互元素。
- 根据 CSS 选择器定位元素。
- 根据文本内容定位元素。
- 获取元素边界、状态和值。
- 判断元素是否可见、可点击或被禁用。

### 17.2 点击操作

- 模拟单击。
- 模拟双击。
- 模拟右键。
- 点击指定选择器。
- 点击指定文本。
- 点击指定页面坐标。

### 17.3 输入与键盘

- 聚焦输入框。
- 输入或替换文本。
- 清空输入框。
- 发送 Enter、Escape、Tab 和方向键。
- 模拟组合快捷键。
- 触发输入、变化和提交事件。

### 17.4 页面滚动

- 按距离滚动。
- 滚动到页面顶部或底部。
- 滚动到指定元素。
- 在可滚动容器中滚动。
- 等待懒加载内容出现。

### 17.5 等待与状态判断

- 等待元素出现或消失。
- 等待文本出现。
- 等待 URL 变化。
- 等待加载结束。
- 等待 JavaScript 条件成立。
- 设置操作超时。
- 在失败时按策略重试。

### 17.6 连续操作脚本

- 创建多步骤 LoomAPP 操作脚本。
- 保存和调用操作脚本。
- 在步骤间传递元素或文本结果。
- 支持中断和取消。
- 记录每一步的执行结果。
- 在失败时返回具体步骤和页面状态。

### 17.7 页面状态与审计

- 操作前后页面快照。
- 页面截图。
- 元素截图。
- 操作时间线。
- 操作参数和结果记录。
- 失败现场保留。
- 敏感操作与 VCP 后端权限审批联动。

后续模拟操作功能仍将保持 Loom 的隔离原则：Agent 只能通过明确的业务命令操作指定 LoomAPP，不会获得任意 Electron 主进程代码执行能力，也不会把 VChat preload 或 Node.js 权限暴露给远程网页。

## 18. 开发与测试

插件业务测试位于：

```text
tests/loom-controller.test.js
```

运行测试：

```bash
node tests/loom-controller.test.js
```

语法检查：

```bash
node --check VCPDistributedServer/Plugin/LoomController/LoomControllerService.js
```

清单检查：

```bash
node -e "const manifest=require('./VCPDistributedServer/Plugin/LoomController/plugin-manifest.json'); console.log(manifest.capabilities.invocationCommands.map(item => item.command));"
```

当前 1.0.0 版本应注册以下命令：

```text
ListApps
ListOpenApps
CreateApp
OpenApp
CloseApp
GetAppSources
GetRuntimeSource
GetRenderedText
EditAppSources