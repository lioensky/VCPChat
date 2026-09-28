# 开发日志：工作区管理与真实路径实时引用

日期：2026-09-28

## 目标

把 @笔记 的"实时引用"推广到本地代码工作区。用户登记项目目录后，工作区内的文本和代码文件可以通过 @ 提及、拖拽、附件选择器或路径粘贴附加。附加时不做 hash 复制，直接映射到真实路径。发送时从磁盘重读内容，AI 拿到的是真实路径，可以直接修改文件。

## 关键决策

- **不用 SQLite。** 索引只记录"有哪些文件路径"，文件内容由实时引用在发送时重读。因此只需要处理新增、删除、重命名，内存 `Map` 就够了。几千到几万个文件只占几 MB，全量扫描在几百毫秒内完成。
- **更新策略是"监听打脏标记 + 查询时惰性修正"。**
  - 每个工作区挂一个 `fs.watch(root, { recursive: true })`，事件经 debounce 后做增量 stat。
  - 出现事件风暴（git checkout、npm install）、`.gitignore` 或 `pyvenv.cfg` 变化、新目录、监听报错时，把工作区标脏，下次查询时整树重扫。
  - 无法建立监听时，退化为 60s TTL 重扫。
- **"当前工作区"全局只有一个，不与 Agent、话题、群组绑定。** 它只决定 `@关键词` 的默认搜索范围。
- **Agent 如何感知工作区结构由 VCP 中央服务器负责**，客户端不往系统提示注入文件树。
- **持久化只走专用 IPC。** `settings.workspaces` 和 `settings.activeWorkspaceId` 只能由 `workspaces:*` 写入。`save-settings` 会剔除这两个键，防止设置页自动保存时用旧快照覆盖（与 `combinedItemOrder` 的保护方式相同）。

## 功能

### 索引与忽略规则（`modules/services/workspaceIndex.js`）
- 默认忽略 `.git`、`node_modules`、`__pycache__`、`.venv`/`venv`/`env`、`dist`/`build`/`target`、`coverage`、`.next`、`.idea`、`*.egg-info` 等目录，以及 `.pyc`、`Thumbs.db` 等文件。
- 目录内存在 `pyvenv.cfg` 即视为虚拟环境，不依赖目录名。
- 逐层读取 `.gitignore`，使用新增依赖 `ignore@7.0.5`（精确版本）。
- 不跟随符号链接，单个工作区上限 50,000 个文件，超出后截断并标记。
- 搜索排序：文件名完全匹配 > 前缀 > 包含 > 路径包含 > 子序列，同分时浅层优先，最多返回 50 条。
- `resolveFile(absPath)`：取最深的工作区根目录，得到 `{ workspaceId, alias, relPath }`。`resolveReference` 是它的逆运算，并拦截 `../` 越界。

### 实时引用（`modules/fileManager.js`）
- 工作区模式放开到文本和代码类扩展名，外加 `Dockerfile`、`Makefile`、`.gitignore` 等约定文件名。单文件上限 1MB，超限时回退为复制。
- 附件记录 `liveSource: 'workspace'` 和 `workspaceRef { workspaceId, alias, relPath }`。
- 工作区整体移动后，原路径失效时会用 `root + relPath` 重新解析（`setWorkspaceReferenceResolver`）。
- 图片、PDF、Office 等二进制文件仍走原有的复制逻辑，多模态行为不变。

### 附件入口（`modules/ipc/chatHandlers.js`）
- `handle-file-drop`、`select-files-to-send`、`handle-file-paste`（路径类型）统一先调用 `tryCreateWorkspaceLiveReference`：属于工作区的文本文件建立实时引用，其余照旧复制。
- 拖拽改用 preload 的 `webUtils.getPathForFile` 取真实路径，因为 Electron 44 已移除 `File.path`。取不到本地路径时回退为读取内容。

### @ 提及（`modules/inputEnhancer.js`）
- `@关键词`：同时搜索笔记和工作区。有多个工作区时先列出别名补全项。
- `@别名/路径片段`：限定在某个工作区内搜索。选择别名项后自动补全为 `@别名/` 并继续搜索。
- 选定了当前工作区时，`@关键词` 只搜索笔记和该工作区，`@别名/` 仍可显式跨项目。
- `@` 前必须是行首、空白或标点，不会误触邮箱。
- 结果渲染改用 `textContent`，修复了原实现把文件名作为 innerHTML 注入的问题。每条结果带来源徽标（笔记 / 别名）和相对路径。
- 过期的异步结果按序号丢弃，避免快速输入时弹窗闪回旧结果。

### 输入框工作区按钮
- 位于表情包按钮右侧，与其他工具按钮共用 `styles/ui-system/chat-input.css` 的样式，只显示图标。
- 选定工作区后按钮变为强调色并显示角标点，详情放在 title 和 aria-label 中。
- 菜单项：全部工作区 / 各工作区 / 管理工作区…。支持方向键、Esc，点击外部关闭。

### 上下文标签
单聊、群聊（两处）、重新回复三条路径统一为：

```
[附加文件: file://H:/.../inputEnhancer.js (工作区 vcpchat: modules/inputEnhancer.js，实时文件，可直接修改)]
```

笔记实时引用的标签保持不变。顺带修复了"重新回复"原先丢失实时标签的不一致。

### 全局设置"工作区管理"分区
- 新文件 `modules/settings/schema/workspace-management.js`，位于"高级功能"与"快捷操作"之间。
- 功能：系统选择器添加目录、编辑别名、启用/停用、移除（只取消登记，不删文件）、单个或全部重建索引，并显示文件数和状态。索引期间自动轮询刷新。
- 面板事件不冒泡到表单，不触发全局设置的自动保存。
- 这个分区也是后续引入 VCPCode 相关能力的入口。

## IPC / API

| 通道 | preload 方法 |
|---|---|
| `workspaces:list` | `listWorkspaces()` → `{ workspaces, activeWorkspaceId }` |
| `workspaces:search` | `searchWorkspaceFiles(query, { alias, limit })` |
| `workspaces:add` / `remove` / `update` | `addWorkspace` / `removeWorkspace` / `updateWorkspace` |
| `workspaces:rebuild` | `rebuildWorkspaceIndex(id?)` |
| `workspaces:set-active` | `setActiveWorkspace(id \| null)` |
| `workspaces:select-directory` | `selectWorkspaceDirectory()` |
| — | `getPathForFile(file)`（同步，`webUtils`） |

## 改动文件

新增：
- `modules/services/workspaceIndex.js`
- `modules/ipc/workspaceHandlers.js`
- `modules/settings/schema/workspace-management.js`
- `tests/workspace-index.test.js`
- `tests/workspace-live-reference.test.js`
- `tests/input-enhancer-workspace-mention.test.js`

修改：
- `main.js`：初始化与退出清理
- `preloads/chat.js`
- `modules/fileManager.js`
- `modules/ipc/chatHandlers.js`
- `modules/ipc/settingsHandlers.js`：剔除 workspaces / activeWorkspaceId
- `modules/utils/appSettingsManager.js`：默认值与校验
- `modules/inputEnhancer.js`
- `modules/chat/singleChatRequestOrchestrator.js`
- `Groupmodules/groupchat.js`
- `modules/renderer/messageContextMenu.js`
- `main.html`：导航、分区壳、输入框按钮
- `styles/chat.css`
- `styles/ui-system/chat-input.css`
- 分区清单登记：`modules/settings/schema-surface.js`、`modules/ui-system/settings/section-ownership.js`、`modules/ui-system/settings-bridge.js`（图标 `folder-git-2`）、`docs/global-settings-section-ownership.md`
- 守卫与基线：
  - `scripts/check-global-settings-section-ownership.mjs`
  - `scripts/audit-settings-layout.mjs`
  - `tests/settings-schema-render.test.mjs`
  - `tests/uiux-settings-bridge-modules.test.mjs`
  - `scripts/test-settings-wa-electron.mjs`、`scripts/test-electron-ui-apps-smoke.mjs`：导航数 8 → 10。旧基线 8 在本次改动前已经过期（当时已有 9 个分区）。

依赖：`ignore@7.0.5`（精确版本，纯 JS）。`trash` 仍使用自己嵌套的 `ignore@3.3.10`，`stylelint` 复用 7.0.5，互不影响。

## 验证

- 单元测试：`workspace-index`（6）、`workspace-live-reference`（5）、`input-enhancer-workspace-mention`（5）、`input-enhancer-note-keyboard`（2），以及设置 schema、金测、全局保存、settings-bridge 模块回归，合计全部通过。
- `stylelint` 检查 `chat-input.css` 通过，改动文件均通过 `node --check`。
- 用户已完成手动实测。
- Electron smoke 脚本（`test-settings-wa-electron`、`test-electron-ui-apps-smoke`）只更新了断言，本次未运行。

## 已知问题

- `scripts/check-global-settings-section-ownership.mjs` 的 id 交叉检查报 `agentModelInput (referenced by modules/settingsManager.js)` 缺失。`modules/settingsManager.js` 本次未改动（git 确认），这是改动前就存在的问题，与本功能无关，需要单独处理。
- `.gitignore` 规则变化后需要整树重扫才能生效，重扫已由 watcher 自动触发，也可以在设置页手动重建。
- 实时引用读取的是整份文件，超过 1MB 的工作区文件回退为复制附件。