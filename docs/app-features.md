# 应用功能模块（Feature）

可选的大块功能放在 `modules/<目录>/`，目录里有 `feature.json`。核心只认这份清单，不 require、不 import 功能的任何文件，也不在 `package.json`、CI 里写具体功能的名字。删掉目录，或者在插件管理器「Feature 应用功能模块」里停用，下次启动它就完全不在了。现在只有一个功能：桌宠（`modules/deskpet/`）。

## feature.json

```json
{
  "manifestVersion": "1.0.0",
  "name": "Example",
  "displayName": "示例",
  "version": "1.0.0",
  "description": "插件管理器里显示的说明",
  "pluginType": "feature",
  "main": "index.js",
  "renderer": "Examplemodules/mainWindow/index.js",
  "schemes": [{ "scheme": "vcp-example", "privileges": { "standard": true } }],
  "scripts": {
    "install": ["scripts/example/setup.cjs"],
    "package": ["scripts/example/setup.cjs", "--strict"]
  },
  "tests": ["tests/example.test.mjs"],
  "defaultEnabled": true
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 字母开头，`[A-Za-z0-9_.-]`，最长 64。启停状态和日志都用它，不能和别的功能重名 |
| `main` | 是 | 主进程入口，相对功能目录，不能跑出目录。导出 `register(host)`，返回 `{ dispose() }`（可省） |
| `renderer` | 否 | 主窗口一侧的 ES module，相对项目根目录。导出 `install(context)` |
| `schemes` | 否 | 自定义协议，app ready 之前和其他功能的一起登记（Electron 只认最后一次调用） |
| `scripts` | 否 | 构建钩子：`install`（`npm install` 之后）和 `package`（`npm run pack` / `dist` 之前）。值是 node 的参数，第一项必须是项目里的 `.js` / `.cjs` / `.mjs` |
| `tests` | 否 | `npm run test:features` 要跑的测试，相对项目根目录 |
| `defaultEnabled` | 否 | 默认 `true` |

不合格的清单会在插件管理器里列出来并显示原因，但不会被加载，也不会跑它的脚本。

## 运行时

1. **app ready 之前**：`main.js` 创建加载器（`modules/appFeatures.js`），按 `<AppData>/features.json`（`{ "disabled": [name] }`）算出这次启用哪些功能，登记它们的协议，并装好 IPC。
2. **preload**：`preloads/core/registry.js` 自动收 `modules/<目录>/preloadApi.js`。主窗口的 preload 启动时同步问主进程 `app-features:inactive-folders`，停用功能的 preloadApi 不暴露，页面上也就没有这些 API。
3. **主窗口建好以后**：`registerAll(host)` 逐个 require `main` 并调用 `register(host)`。`host` 包括 `hooks`（`modules/hostHooks.js`）、`tts`、`mainWindow`、`projectRoot`、`appDataRoot`、`agentDir`、`readSettings`、`historyQueue`、`agentOps`，以及 `host.feature`（自己的 `name` 和 `dir`）。某个功能抛错只记日志，不影响核心和其他功能。
4. **主窗口页面**：`modules/renderer/appFeatures.js` 拿到这次真的加载了的功能列表，import 它们的 `renderer` 并调用 `install(context)`。
5. **退出**：按加载的相反顺序调用 `dispose()`。

启停只改状态文件，重启后生效。

## 构建和测试

`scripts/app-features.cjs` 读清单（不看启停状态，停用的功能照样构建、测试）：

```bash
node scripts/app-features.cjs install
```

```bash
node scripts/app-features.cjs package
```

```bash
npm run test:features
```

`test` 先跑功能系统本身的测试（加载器、主进程钩子、设置扩展、审批事件），再跑各功能声明的 `tests`。`node scripts/app-features.cjs test DeskPet` 只跑一个功能的测试。`package` 里任一功能失败，打包就停止。

## 边界

`tests/app-features.test.mjs` 检查核心代码和 `package.json` 的 scripts 里没有功能的名字。新功能要接入核心时，先在 `hostHooks`、设置扩展这类通用接口上加挂点，不要在核心里写针对某个功能的分支。
