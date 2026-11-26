# ProjectForge MCP Bridge

## 范围与当前状态

这是直接调用插件服务的本地 stdio MCP 桥，入口、工具 Schema、配置校验和测试均位于当前目录。已通过 SDK 客户端与真实原生服务的集成测试；Zed 图形界面的连接与提示词加载仍需在客户端验证。需要 Node.js 22 或更高版本。

桥通过本地 stdio 提供 MCP，直接加载上一级 `ProjectForgeService.js`，复用工程管理、原生索引、文件编辑、快照和历史能力。它不经过 VCP 后端、不要求启动 VCPDistributedServer 或 GUI，也不使用 VCP 工具调用封装。桥只负责协议、配置、工具名 / 参数适配、能力开关和结果转换，不复制一套业务实现。另提供 `pf_search`，直接经隔壁 `CodeSearcher.js` 启动平台对应的 Rust 搜索二进制，同样不经过 VCP 后端。保留手动创建工程的流程，不新增自动工程或 `--workspace-root` 模式。另支持可选开启的 `TopicSponsor` / `TopicMemo` 话题工具（`enableTopic=true`），经 VCPToolBox 的 `POST /v1/human/tool` 转发至在线 VChat 实例；未开启时桥仍保持完全离线。

```text
Zed / 其他 MCP 客户端
  → node mcpbridge/server.cjs --config /absolute/path/config.json
  ├─ ProjectForgeService.js → 原生 projectforge_indexer 服务 + 桥独立数据库（默认离线）
  └─ topic.cjs → POST /v1/human/tool → VChat TopicSponsor / TopicMemo（仅 enableTopic=true）
```

stdio 的 stdout 仅用于 MCP 协议消息；日志写 stderr，避免污染协议流。

## 依赖、安装与测试

桥不是可随意复制到其他目录的独立发行包：它依赖宿主 VCPChat 仓库的模块、`node_modules` 和匹配当前源码 / 平台的原生索引器。需先按宿主仓库说明安装依赖；构建索引器还需要 Rust / Cargo 及对应平台编译工具链。

在 **VCPChat 仓库根目录**执行：

```sh
# 编译当前操作系统和架构的原生索引器 / 服务
npm run build:pf-indexer

# 桥使用自己的 package.json，直接依赖 @modelcontextprotocol/sdk 和 ajv
npm --prefix VCPDistributedServer/Plugin/ProjectForge/mcpbridge install

# 运行桥的测试
npm --prefix VCPDistributedServer/Plugin/ProjectForge/mcpbridge test
```

仅安装桥依赖不能代替安装宿主依赖。原生二进制缺失、平台不符或服务 schema 不匹配时应修复 / 重建，不能假定数据库与编辑服务仍可工作。Windows 重建前先停止占用该二进制的进程。

## 本地 JSON 配置

将配置保存为本地 `config.json`，通过 `--config` 指定；使用严格 JSON（双引号、无注释）。以下为给定工作区的可用配置示例，迁移机器时修改这些路径，不要把机器路径写入开发提示词：

```json
{
  "workspaces": [
    {
      "id": "vcpchat",
      "alias": "vcpchat",
      "path": "H:/VCP/VCPMain/VCPChat",
      "enabled": true
    }
  ],
  "activeWorkspaceId": "vcpchat",
  "dbPath": "H:/VCP/VCPMain/VCPChat/AppData/ProjectForge/mcp-projectforge.db",
  "maid": "Kerr",
  "enableEval": false,
  "enablePurge": false,
  "enableBash": false,
  "enableTopic": false,
  "vcpUrl": "http://127.0.0.1:6005"
}
```

配置约定：

| 字段 | 用途 |
| --- | --- |
| `workspaces` | 本地登记的工作区列表，包含稳定 `id`、`alias`、绝对 `path` 和 `enabled`；已启用根目录构成写入边界 |
| `activeWorkspaceId` | 默认工作区 ID，指向列表中的已启用工作区；创建工程也可显式传 `workspace` |
| `maid` | 默认操作者署名，桥在调用 ProjectForge 服务时注入；无需模型重复传入 |
| `dbPath` | 可选绝对路径；省略时使用宿主仓库 `AppData/ProjectForge/mcp-projectforge.db`，**不得回退为 GUI 数据库** |
| `binaryPath` | 可选原生服务二进制绝对路径；省略时使用宿主的平台默认路径 `ProjectForge/bin/<platform>-<arch>/projectforge_indexer[.exe]` |
| `enableEval` | 默认 `false`；显式设为 `true` 才暴露并允许 `pf_eval_symbol` |
| `enablePurge` | 默认 `false`；显式设为 `true` 才暴露并允许 `pf_purge_projects`，调用仍须 `confirm=true` |
| `enableBash` | 默认 `false`；在桥的本地配置设为 `true` 后重启 MCP，再由客户端刷新工具列表 |
| `enableTopic` | 默认 `false`；显式设为 `true` 才暴露并允许 `ts_*` / `tm_*` 话题工具 |
| `vcpUrl` | 可选 HTTP(S) 服务根地址，默认 `http://127.0.0.1:6005`（不含路径、查询参数或凭据） |
| `vcpKey` | 可选 VCP API Key；`enableTopic=true` 时必需，也可省略该字段改由环境变量 `VCP_API_KEY` 提供 |
| `vcpAppDataPath` | 可选 VChat `AppData` 绝对目录；省略且使用默认本机 `vcpUrl` 时自动探测宿主 `AppData` 供 `TopicMemo` 本地只读直连 |
| `topicReadMode` | 可选 `auto`（默认）、`local` 或 `http`，控制 `tm_*` 优先走本地只读直连还是远程 HTTP |

桥从 JSON 构造只读工作区门面并注入 `ProjectForgeService`，将 `dbPath` 和 `binaryPath` 映射到服务初始化选项，不从 GUI 读取工作区或依赖后端配置。这里的配置字段不等于额外工具参数。

### 数据与安全边界

- **桥与 GUI 必须使用不同数据库**，避免多个原生服务进程同时持有同一数据库引发冲突。不要把 `dbPath` 指向 GUI 的 `projectforge.db`。多个独立桥实例也应各用独立数据库，而非同时共享默认文件。
- 独立数据库意味着工程 ID、待办、票据、快照与历史独立，不自动同步到 GUI。即使数据库不同，对同一源码文件的并发写入仍可能冲突，应避免 GUI 与多个 Agent 同时施工。
- Eval、Purge、Bash 与 Topic（`ts_*` / `tm_*`）默认均从 `tools/list` 隐藏，`tools/call` 也拒绝；调用参数不能授权。话题工具参数统一使用 `ESCAPE` 边界包裹并拒绝控制字符与保留转义分隔符，防止请求体注入。
- Eval 和 Bash 都不是安全沙箱，只对可信工程和 Agent 开启。Bash 以 MCP 进程的系统用户权限执行，工程工作目录不是文件系统或网络边界，写盘不生成 Forge 快照。Purge 会永久删除已软删工程的记录及快照，不能回退。

## 启动

在仓库根目录，使用已准备好的配置启动：

```sh
node VCPDistributedServer/Plugin/ProjectForge/mcpbridge/server.cjs --config H:/VCP/VCPMain/VCPChat/VCPDistributedServer/Plugin/ProjectForge/mcpbridge/config.json
```

客户端通常负责拉起并维护 stdio 进程，无需另行运行常驻后端。建议在客户端参数中使用入口与配置文件的绝对路径，不依赖客户端当前工作目录。

## Zed 配置

依据 [Zed 官方 MCP 文档](https://zed.dev/docs/ai/mcp)（2026-11-16 核对），在 Zed settings 中使用现代 `context_servers` 配置：`command` 是可执行文件名 / 路径字符串，`args`、`env` 与其同级。**没有额外的 `command.path` 或服务器级 `path` 字段**；需要固定 Node 路径时，直接将 `command` 改为本机 `node.exe` 的绝对路径。

```json
{
  "context_servers": {
    "projectforge": {
      "command": "node",
      "args": [
        "H:/VCP/VCPMain/VCPChat/VCPDistributedServer/Plugin/ProjectForge/mcpbridge/server.cjs",
        "--config",
        "H:/VCP/VCPMain/VCPChat/VCPDistributedServer/Plugin/ProjectForge/mcpbridge/config.json"
      ],
      "env": {}
    }
  }
}
```

`command="node"` 要求 Zed 的进程环境能找到 Node；若找不到，填入实际安装的 Node 可执行文件绝对路径。`env` 可以为空，工作区、数据库和署名统一来自 `--config` 指向的 JSON，不需要额外环境变量。

在 **Settings → AI → MCP Servers** 查看 `projectforge` 状态和启动错误。Zed 当前官方文档明确支持 Tools 和 Prompts；不要假定它一定提供 Resources 的直接浏览入口。支持资源读取的其他客户端可使用下文 URI。

### Agent 工具策略

连接 MCP 不会自动禁用或替换 Zed 内置文件工具。请将以下规则加入实际使用的 Agent 指令，并在新对话加载开发 prompt：

> 本工程源码定位、读取与写入主用 ProjectForge 的 `pf_*` 工具。先查询工作区和已有工程，复用真实 projectId。写入必须记录 reason，同文件多点修改用 pf_edit_code.edits，不并发独立写入同一文件。工具拒绝或能力未启用时先解释原因，不绕过限制。终端用于构建和测试，不用于替代源码写入。开始施工前加载 projectforge_development 并遵循其中契约。

若用户需要更严格的工具隔离，可自行在 Zed 工具选择 / 自定义 Agent profile 中关闭冲突的内置读写工具，并保留所需 MCP 工具；这是客户端配置，不是桥或提示词能够自动完成的操作。不要为了使用桥而全局自动批准所有工具。

## MCP 接口契约

### Tools

每个原命令对应一个工具：名称为 `pf_` + snake_case，参数保留原 camelCase。桥内部映射回原命令，调用方不传 `command`。完整字段以 `tools/list` 的 inputSchema 为准；开发用法见 [`MCPPrompt.md`](./MCPPrompt.md)。

| 类别 | 工具 |
| --- | --- |
| 工程与进度 | `pf_list_workspaces`, `pf_create_project`, `pf_list_projects`, `pf_search_projects`, `pf_get_project`, `pf_update_todos`, `pf_submit_report` |
| 读取与定位 | `pf_read_code`, `pf_outline`, `pf_find_symbol`, `pf_trace`, `pf_query` |
| 原生内容搜索 | `pf_search`（CodeSearcher，无需 `projectId`） |
| 编辑与文件 | `pf_edit_code`, `pf_resolve_edit`, `pf_create_file`, `pf_remove_file`, `pf_move_file`, `pf_move_code`, `pf_copy_code` |
| 历史与回退 | `pf_search_history`, `pf_get_node_diff`, `pf_rollback` |
| 工程记录 | `pf_delete_projects`, `pf_restore_projects` |
| 默认关闭 | `pf_eval_symbol`（`enableEval`），`pf_purge_projects`（`enablePurge`），`pf_bash`（`enableBash`），`ts_*` / `tm_*`（`enableTopic`） |

例如 `CreateProject → pf_create_project`，`GetNodeDiff → pf_get_node_diff`；字段仍写 `projectId`、`showLine`、`revertOnSyntaxError`、`byMaid`，而非下划线形式。

`pf_edit_code` 支持单步原字段和多步 `edits` 数组，**不是 `steps`**。桥将数组适配到现有服务的编辑契约，保留同一原始快照定位、重叠拒绝、atomic / bestEffort 和歧义票据语义，不循环执行多个独立写入来模拟批处理。默认 `maid` 在进入服务前注入。

### Query 与 Bash

- `pf_query` 默认可用。传工程 ID 和可异步执行的 JS 函数体，使用 `q` 组合读取、搜索、符号和链路查询；超时默认 10 秒，上限 30 秒。查询结果在 `structuredContent.value`，沿用服务的输出截断规则。
- `pf_bash` 只接受可写工程。传工程 ID 和脚本，可选工程内的 `workdir`（默认工程根）、`timeoutMs`（默认 30000，上限 110000）与 `maxBytes`（默认 65536，桥限制为 1048576）。Windows 需要可发现的 Git Bash；也可在 MCP 客户端的进程环境将 `PF_BASH` 指向 Bash 的绝对路径。
- Bash 返回独立的 stdout、stderr、退出码与超时／截断信息；非零退出、超时、启动失败等结果标记为 MCP 错误，仍保留进程结果（如果已返回）。失败不代表没有副作用，不要盲目重试。
### CodeSearcher 原生搜索

`pf_search` 输入：`query` 必填，`workspace`、`path`、`include`、`isRegex`、`caseSensitive`、`wholeWord`、`contextLines`、`maxResults` 可选。字段保持 MCP camelCase，桥负责转换成插件的 snake_case 参数。

- 默认搜索配置中的当前工作区，`path` 相对**工作区根**而非工程根；不传 `path` 则搜 `.`。保留显式工作区登记、手工工程创建和编辑所需的 `projectId`。
- 复用相邻 `CodeSearcher` 的平台二进制选择，并按 manifest 默认值 → `CodeSearcher/config.env` 加载搜索配置。二进制缺失时明确返回错误，不静默降级为 grep。
- 内容搜索默认 Rust 正则；精确代码片段请指定 `isRegex=false`。`include` 覆盖扩展名白名单，`.env` 类保护与忽略目录沿用原生插件。
- `contextLines` 为 0–20，`maxResults` 为 1–500；每次搜索总截止时间 60 秒、stdout 上限 8 MB、stderr 上限 64 KB、最多 4 个并发搜索。
- 只允许已启用工作区内的相对路径。桥预检目标树并保守拒绝符号链接 / junction（真实忽略目录不深入）；超过 100000 个条目须缩小搜索范围。此预检有额外遍历成本，也无法消除恶意并发替换路径的竞态，不应视为操作系统沙箱。
- 返回路径相对搜索起点；后续调用 ProjectForge 读写前需换算成工程根相对路径。AST 定义和符号定位仍使用 `pf_find_symbol` / `pf_outline`，不把普通内容匹配当成语义索引。

### TopicSponsor 与 TopicMemo 可选话题工具

仅当 `enableTopic=true` 且配置了 `vcpKey`（或环境变量 `VCP_API_KEY`）时启用，参数同样采用 MCP camelCase。本机同仓部署下 `tm_*` 优先直接只读访问本地 `AppData`（毫秒级无子进程开销，远端 URL 自动回退 HTTP），`ts_*` 通过 `POST <vcpUrl>/v1/human/tool` 转发并返回可读 Markdown 报告与 `structuredContent`：

- **TopicSponsor（`ts_*`）**：`ts_list_agents`、`ts_list_groups`、`ts_list_recent_topics`、`ts_check_new_topics`、`ts_check_unread_messages`、`ts_check_topic_ownership`、`ts_create_topic`、`ts_create_flowlock_topic`、`ts_reply_to_topic`。
- **TopicMemo（`tm_*` 四阶渐进阅读）**：`tm_list_topics`（关键词过滤、未读筛选与分页）、`tm_outline_topic`（轻量楼层序号与首行摘要）、`tm_search_topic`（单话题内字面/正则定位楼层）、`tm_get_topic_content`（长话题自动尾窗截断，支持 `tail`、`startSeq`–`endSeq`、`maxCharsPerTurn`、`includeTools`，完整保护 Markdown 代码缩进与泛型尖括号）。
- `ts_reply_to_topic` 区分已有话题留言（传 `topicId`，省略 `mode`）与跨话题新建派工（传 `mode="new_topic"`、`sourceTopicId`、`targetAgent`，可选 `flowlock`，不传 `topicId`）；发言者 `senderId` 或 `senderName` 须匹配已注册 Agent。
- 支持可选 `riverLast`（抽取源话题最近 N 轮干净对话）与 `contextItems`（附加结构化代码切片、日志或工具回执），由桥自动编码为前端原生折叠引用卡 `[VCP_TOPIC_RIVER_V2]`。插件业务错误（HTTP 500 `plugin_error`）统一映射为 MCP `isError: true`。

### Instructions、Prompts 与 Resources

三层内容用途不同，全文只有一个来源：`MCPPrompt.md`。

| MCP 接口 | 约定 |
| --- | --- |
| 初始化响应 `instructions` | 短规则：源码读写主用 `pf_*`；先查工作区 / 工程；保持 camelCase 参数；多点编辑用 `edits`；默认署名来自配置；遵守能力开关；提示加载完整开发 prompt |
| `prompts/list` | 提供名为 `projectforge_development` 的无必需参数 prompt |
| `prompts/get` | `name="projectforge_development"`，以文本消息返回 `MCPPrompt.md` 全文，不摘要、不另维护副本 |
| `resources/list` | 提供 URI `projectforge://instructions`，MIME 类型 `text/markdown` |
| `resources/read` | `uri="projectforge://instructions"`，返回同一份 `MCPPrompt.md` 全文 |

短 `instructions` 不重复完整参数说明；全文 prompt / resource 不硬编码本机绝对路径。不同客户端可能不会自动把 prompt、resource 或初始化 instructions 放进 Agent 上下文，需在客户端实际加载 / 验证；提供资源并不代表 Zed 一定会自动读取它。

## 验收与已知边界

- 安装桥依赖、编译原生服务后，能以 `node …/server.cjs --config …/config.json` 完成 stdio MCP 初始化，无 VCP 后端或 GUI 进程依赖。
- `tools/list` 覆盖以上命令且字段一致；默认隐藏 Eval / Purge / Bash，直接调用也拒绝；开启后仍执行原服务校验。
- 临时工作区与独立数据库中验证工程创建、读取、多步 `edits`、diff、回退和默认署名；不使用真实工程进行破坏性冒烟测试。
- 测试单步 / 多步参数校验、原快照坐标、重叠拒绝和歧义票据，确保不是多次独立写入。
- 验证 prompt 与 resource 文本均等于 `MCPPrompt.md` 全文；初始化仅给短规则；stdout 无日志。
- 运行 `npm --prefix VCPDistributedServer/Plugin/ProjectForge/mcpbridge test`，再在 Zed 检查工具发现与开发 prompt 加载。

桥返回插件的可读文本和原生 MCP 图片 / 音频，不把重复源码和快照整体塞入模型上下文。Query 结果和 Eval / Bash 的执行证据另通过 `structuredContent` 保留。视频不能作为 MCP 内联视频返回，桥会明确提示使用外部查看器；不会获取外部媒体 URL。

服务关闭会取消活动的 Query / Bash，并等待服务清理；已发生的 Bash 写入不会被撤销。桥不进行盲目写重试。客户端强杀进程仍可能导致结果未知，应检查工程历史和磁盘内容后再决定下一步。

现有插件的 MoveCode / CopyCode 在某些歧义结果中未渲染完整候选；桥不猜测候选。遇到这种结果，应使用 Outline / ReadCode 明确范围后重新调用。EditCode 的歧义票据链路不受此限制。
