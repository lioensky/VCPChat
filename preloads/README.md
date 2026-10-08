# preloads

渲染进程通过这里拿到主进程能力。一个领域一个文件，打开 `api/xxx.js` 就能看到这个领域的全部 IPC。

## 目录

```
preloads/
  chat.js / utility.js / desktop.js   角色入口，各几行：exposeRole(角色)
  api/*.js                            领域文件：API 名 → IPC 通道 → 可见角色
  behaviors/*.js                      非 IPC 的 DOM 行为（内嵌外观、置顶按钮）
  core/define.js                      invoke / send / on 等声明函数
  core/registry.js                    扫描 api/，校验重名与角色；不依赖 electron
  core/expose.js                      按角色暴露到页面
  chart.js / docx.js / loom.js / loom-page.js / voice-input-capture.js
                                      独立窗口的专用 preload，不走 api/
```

## 页面上的全局对象

| 角色 | 用于 | 全局对象 |
|------|------|----------|
| chat | 主聊天、划词助手、语音聊天 | `chatAPI` |
| utility | 笔记、音乐、画布、主题、翻译、骰子、RAG、论坛、施工图等子窗口 | `utilityAPI` |
| desktop | VCP 桌面 | `desktopAPI` |

三个角色都另外暴露 `electronPath` 和 `electronAPI`。`electronAPI` 是兼容层：本角色可见的 API 是真实函数，其余是隔离桩，调用时打印 `权限已隔离: 名称`。

## 新增一个 API

在对应领域文件的 `api` 里加一行，不需要改其他文件：

```js
// preloads/api/music.js
musicSetSpeed: invoke('music-set-speed', 'speed'),
```

- 请求-响应用 `invoke`，单向命令用 `send`，事件用 `on` / `onArgs` / `onSignal`
- 参数名只起文档作用，同时决定按位置转发几个参数
- 需要默认值或重组参数时传映射函数：`invoke('workspaces:add', (dirPath, alias = '') => [dirPath, alias])`
- 可见角色和文件默认 `roles` 不同时，链式加 `.roles('chat', 'utility')`
- 需要加工返回值时用 `.mapResult(result => ...)`
- 以上都不够时用 `custom(kind, channel, ctx => fn)`，例子见 `api/window.js` 的 `closeWindow`

主进程侧照常在 `modules/ipc/*Handlers.js` 注册 `ipcMain.handle` / `ipcMain.on`。领域文件头部的 `handlers` 字段写明对应的主进程文件。

## 新增一个领域

在 `api/` 下新建文件，格式照抄任意现有文件。registry 会自动扫描加载，不需要登记。

## 约束

- 使用角色 preload 的窗口必须设置 `sandbox: false`。Electron 默认开启沙箱，沙箱内 preload 不能 require 本地文件，页面上的 `chatAPI` 等会全部缺失。`contextIsolation: true` 与 `nodeIntegration: false` 保持不变，页面脚本仍然碰不到 Node。`tests/preload-registry.test.js` 会检查这一点，新增窗口后要同步更新该测试的文件清单。
- API 名全局唯一，重名会在 preload 加载时直接抛错。
- 测试或工具需要查询 API 时用 `require('preloads/core/registry').describeApis()`，得到 `{ name, domain, kind, channel, roles }` 列表，不要用正则读 preload 源码。

## 验证专用窗口

`npm run test:dedicated-preload` 启动独立 Electron 进程与临时数据，验证 chart/docx/loom 的页面 API、真实 IPC 传参、事件载荷和同 callback 两次订阅各自解绑。窗口隐藏，完成后销毁，不连接现有应用；日志与结果留在输出的临时证据目录。主进程采用受控 handler，这项测试不证明生产业务处理已通过。