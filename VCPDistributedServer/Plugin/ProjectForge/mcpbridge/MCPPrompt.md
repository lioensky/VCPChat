# ProjectForge 开发指令

## 调用与工程边界

- ProjectForge 是本地 MCP 工具集。直接调用 `pf_*` 工具并传入 JSON 参数，不需要外层命令封装或另传 `command`。工具名是原命令的 snake_case 加 `pf_` 前缀；参数保留原 camelCase 字段名，不转换为 snake_case。
- 工作区和操作者来自桥的本地配置；`maid` 由配置默认注入，通常无需在调用中填写。不要猜测配置中的路径或身份。
- 首先用 `pf_list_workspaces` 确认工作区，用 `pf_list_projects` / `pf_search_projects` 查找已有工程。创建工程后使用返回的真实 `projectId`，不要编造 ID。
- 文件路径以工程根为基准；`workspace` 是登记的别名或 ID，`dir` 是工作区内的工程子目录。不得绕过工程和工作区写入边界；`scope=workspace` 找到的工程外结果只读。
- 工程源码的定位、读取、创建、编辑、移动、删除及回退主用 `pf_*`，以保留快照、原因和施工历史。已知路径直接读取，按需搜索，不强制走完全部工具。
- 同一文件的多处修改优先放入一次 `pf_edit_code` 的 `edits` 数组；不要并发独立写入同一文件。工具失败先分析原因，不要自动改用其他工具绕过拒绝或禁用策略。
- 终端可用于构建、测试等工具集未覆盖的任务，但不应作为绕过 ProjectForge 文件写入的通道。本指令不表示客户端内置工具已被禁用。
- 以下签名仅为速查：`?` 表示可选，`|` 表示择一，不是调用语法；以 `tools/list` 的实际 inputSchema 为准，不自行添加未公开字段。

## 工程与进度

```text
pf_list_workspaces()
pf_create_project(name, workspace?, dir?, todos?)
pf_list_projects(workspace?, query?, includeDeleted?, limit?)
pf_search_projects(workspace, query, includeDeleted?, limit?)
pf_get_project(projectId, timeline?)
pf_update_todos(projectId, add?, done?, doing?, pending?, blocked?, remove?, seq?, title?, note?)
pf_submit_report(projectId, conclusion, issues?, status?)
```

- `pf_list_projects` 默认返回最新 10 项；`workspace=all` 可跨工作区列出。`pf_search_projects` 搜索已登记工程，不扫描磁盘；必须指定工作区，不能使用 `all`。
- `todos` / `add` 使用换行或逗号分隔内容；状态和删除字段使用序号列表，`seq` 配合 `title` / `note` 修改单项。
- `pf_get_project` 查看待办、最近批次及报告，续接工程时优先读取。
- 报告 `status=review|accepted|active`，默认 `review`；结论只报告实际完成与验证结果。

## 原生内容搜索

```text
pf_search(query, workspace?, path?, include?, isRegex?, caseSensitive?, wholeWord?, contextLines?, maxResults?)
```

- 全文内容查找优先用 `pf_search`，它直接调用隔壁 CodeSearcher 的原生 Rust 检索，无需创建工程或传 `projectId`。不替代 AST 定义查找 `pf_find_symbol`。
- `workspace` 为已启用工作区的别名或 ID，省略使用配置中的当前工作区；`path` 相对工作区根目录（**不是工程根**），默认 `.`，可以是文件或目录。返回路径相对搜索目录；回填 `pf_read_code` / 编辑时需换算为工程根相对路径。
- `isRegex=true` 默认使用 Rust regex 的逐行匹配；支持分支、字符类、量词、分组、锚点和内联标志，不支持环视、反向引用或跨行。非法正则会回落字面量并提示。代码片段查找建议明确 `isRegex=false`。
- `include` 是逗号分隔的 glob，可带排除项，例如 `*.rs,*.toml,!*.min.js`，指定后替代扩展名白名单；`caseSensitive=false`、`wholeWord=false` 默认。
- `contextLines` 默认 2、范围 0–20；`maxResults` 默认插件配置、范围 1–500。结果包含文件、行列号和合并上下文；截断时先缩小范围，不反复读取整个仓库。
- 搜索沿用 CodeSearcher 的忽略目录、扩展名和 `.env` 类文件保护。不允许绝对路径、上级跳转及工作区外访问；目标树含符号链接 / junction 时会保守拒绝，需改搜明确的真实子目录。搜索不是文件系统安全沙箱。

## 定位、读取与链路

```text
pf_read_code(projectId, path?|paths?|glob?, lines?, showLine?, find?, symbol?, range?, context?, pick?, line?)
pf_outline(projectId, path?|paths?, depth?, kind?)
pf_find_symbol(projectId, name, kind?, glob?, exact?, limit?, scope?)
pf_trace(projectId, target, scope?, glob?)
```

优先路由：全文检索用 `pf_search`，找定义用 `pf_find_symbol`，看结构用 `pf_outline`，读内容用 `pf_read_code`，查 JS 前端 / Electron 的 IPC、preload 和页面依赖用 `pf_trace`。

### 读取与查找规则

- `path=src/file.js:40-80` 按行读取；`path=src/file.js#Store.put` 或 `path` 配合 `symbol` 按符号读取。`paths` 为换行或逗号分隔的文件选择，`glob` 批量选择文件。
- `lines=head:N|tail:N|M-N|N`；默认带行号，`showLine=false` 关闭。
- `find` 是大小写敏感的字面子串匹配，不是正则，也不是编辑定位语法。查询片段首尾会去空白，但不会逐行忽略源码空白、剥除行号或解释首尾锚定的 `...`。多关键词 `a|b` 分别按字面匹配后取并集；`\|` 匹配字面竖线，`||` 始终按字面量，多行查询不拆分。返回匹配行、所在函数及上下文。
- 符号默认包含紧邻前置注释 / JSDoc / 装饰器；`range=body` 从签名行起，保留前置注释；`context` 扩展上下文。同名定义用 `pick` 或近似 `line` 消歧。
- AST 符号读取、大纲、查找和符号编辑覆盖 11 种语言：JavaScript、TypeScript、TSX、Python、Rust、C、C++、Go、Java、C#、Lua（JSX 属于 JavaScript）。其他文本使用按行读取或字面查找。资产读取可返回多模态内容或文档提取文本，实际展示取决于 MCP 客户端支持。
- `pf_outline` 返回符号层级与行范围；`pf_find_symbol` 按 AST 定位，遵守忽略规则，`exact=true` 为全等或限定名后缀匹配，`limit` 默认 20、最大 500。
- 返回的 `文件#限定名` 可直接用于读取、编辑或代码块操作；不要先猜行号再编辑。

### 链路规则

`pf_trace.target` 支持 `ipc:通道`、`api:preloadAPI`、`global:名称`、`page:页面.html`、`file:相对路径`。结果包括相应处理端 / 调用端 / 声明、加载顺序与依赖检查。它是静态链路分析，不代表 11 种语言都支持同等链路追踪；动态通道可能只计数，未找到静态边不能证明没有运行时调用。

## 编辑

```text
pf_edit_code(projectId, path, reason, 编辑字段或edits, todo?, mode?, revertOnSyntaxError?)
pf_resolve_edit(ticketId, pick)
```

单步编辑按需选择以下字段，不混用互斥定位方式：

| 意图 | 编辑字段 |
| --- | --- |
| 文本替换 | `target`, `replace` |
| 替换行 | `start`, `end`, `content` 或 `lines`, `content` |
| 插入 | `op=insert`, `after=N|end` 或 `before=N`, `content` |
| 删除行 | `op=delete`, `start`, `end` |
| 替换符号 | `path=文件#符号` 或 `symbol`, 配合 `content` |
| 删除符号 | `op=delete`, `symbol` |
| 符号前后插入 | `op=insert`, `before=symbol:名称` 或 `after=symbol:名称`, `content` |

- 多步使用 `edits` 数组，不使用 `steps`。每项填写单步编辑字段，可附单步 `reason`；`projectId`、`path`、总体 `reason` 放在外层。数组编辑时 `path` 用普通文件路径，符号定位写在各项的 `symbol` 中，不依赖外层 `文件#符号` 自动注入。MCP 调用无需旧式数字后缀字段。
- 所有步骤以编辑前快照定位，不是逐步修改后的坐标；重叠区间报错。`mode=atomic` 默认全部成功才写，`mode=bestEffort` 跳过失败步骤。
- `after=0` 插入开头；`expect` 校验原文并允许 ±20 行定位校正。
- 编辑的 `target` 可使用首行、独立一行 `...`、尾行的首尾锚定，也可粘贴 `N | 原文`；字面能匹配时优先字面匹配。空 `replace` 删除区间。这些编辑语法不适用于读取的 `find`。
- 符号编辑默认带前置注释，`range=body` 保留注释。`todo` 关联待办；`revertOnSyntaxError=true` 阻止引入语法错误，但不替代构建和测试。
- 多处匹配返回候选与 `ticketId`，不直接写入。使用 `pf_resolve_edit` 选择：`pick="2"`、`"1,3"` 或 `"all"`；多步骤用 `"2:1;5:3"`。票据有效 30 分钟，文件变化后可能返回新候选。

例如，对已读取且确认原文的同一个文件提交一次多点替换（示意 ID 必须替换为工具实际返回值）：

```json
{
  "projectId": "<实际返回的projectId>",
  "path": "src/login.js",
  "reason": "统一登录页文案",
  "edits": [
    { "target": "'登陆'", "replace": "'登录'" },
    { "target": "'用户名不能为空'", "replace": "'请输入用户名'" }
  ],
  "mode": "atomic",
  "revertOnSyntaxError": true
}
```

## 文件与代码块

```text
pf_create_file(projectId, path, content, reason, overwrite?, todo?, revertOnSyntaxError?)
pf_remove_file(projectId, path?|paths?, reason)
pf_move_file(projectId, from, to, reason)
pf_move_code(projectId, from, reason, to?, lines?|start/end?|target?|symbol?, expect?, range?, pick?, line?, after?|before?, indent?, todo?, revertOnSyntaxError?)
pf_copy_code(projectId, from, reason, to?, lines?|start/end?|target?|symbol?, expect?, range?, pick?, line?, after?|before?, indent?, todo?, revertOnSyntaxError?)
```

- 新建文件自动建立父目录；同名拒绝，`overwrite=true` 先存快照再覆盖。删除先存快照再移入回收站；移动兼作重命名，目标存在则拒绝。
- 代码块源 `from=文件:M-N` 或 `文件#符号`，也可配合单独定位字段；`to` 省略为同文件，不存在则新建。
- 目标位置使用 `after=N|end`、`before=N` 或符号锚；符号默认带前置注释，`range=body` 除外。
- `indent=auto|keep|N|+N|-N`。同文件移动无需计算偏移；跨文件变更记入同一批次。`pf_copy_code` 是代码块复制，不是整文件复制。

## 历史、回退与记录清理

```text
pf_search_history(projectId?, file?, keyword?, content?, byMaid?, todo?, op?, batch?, since?, until?, limit?)
pf_get_node_diff(projectId, node?|batch?, maxLines?)
pf_rollback(projectId, batch?|toNode?, path?, dryRun?, force?, reason?)
pf_delete_projects(projectIds)
pf_restore_projects(projectIds)
pf_purge_projects(projectIds, confirm)
```

- 历史 `op=create|edit|delete|move|rollback|external`；操作者筛选用 `byMaid`，默认署名仍由桥配置注入。
- Diff 选择 `node` 或 `batch`。回退选择 `batch` 或 `toNode`；`batch=last` 撤销最近批次，`toNode` 配合 `path` 恢复单文件。回退本身产生新批次。
- 回退先用 `dryRun=true` 预演；冲突默认拒绝，只有确认应覆盖才用 `force=true`，覆盖前仍存快照。
- `projectIds` 使用逗号或换行分隔。删除 / 恢复仅改变数据库记录，不改磁盘文件。
- `pf_purge_projects` 默认不暴露也不允许调用；仅在配置显式启用后可用，且必须 `confirm=true`。它只处理已软删工程，永久清除记录及快照，不删除磁盘文件。先取得用户明确授权，不用其他操作绕过禁用。

## 可选函数试跑

```text
pf_eval_symbol(projectId, path, args?, kwargs?, setup?, timeoutMs?, symbol?, pick?, line?, package?, features?, target?, testPick?)
```

- 默认不暴露也不允许调用；仅配置显式启用后可用。只适用于可信、可写工程，不是安全沙箱：模块加载、准备和执行都可能写盘、联网或产生其他副作用。
- `path=文件#符号`，`pick` / `line` 用于 AST 消歧。JS/CJS/ESM 调用真实可访问导出函数 / 对象方法并保留 `this`；Python 按包导入，`kwargs` 为关键字参数对象。
- `args` 为 JSON 数组，默认 `[]`；`setup` 是对应语言的异步准备函数体，返回参数数组，与 `args` 互斥。
- Rust 仅运行已有标准 `#[test]`，可用 `package` / `features` 限定构建、`target` / `testPick` 消歧；不支持 Rust `setup` 或临时 harness。零命中或 ignored 不算通过。
- `timeoutMs`：JS / Python 默认 5000，Rust 默认 100000，上限 110000。工程根 `.projectforge-eval.json` 可指定 node / python / cargo；Python 按配置 → `.venv` → PATH 选择，失败不换环境。
- `returned` 仅表示函数返回，`passed` 才表示实际测试通过；查看阶段错误、typed-v1 值、源码 hash 与有界日志。不支持 TS、局部闭包或自动构造实例；11 种语言的符号能力不等于都支持试跑。

## 长期施工与交付

1. 先读再改，优先局部 diff 和清晰函数；重构仍需保持完整、可编译的实现，不引入无关改动。
2. 用具体依赖、运行条件和验证结果替代空泛提醒。并发、异步、系统调用与状态机需考虑超时、边界和类型安全。
3. 中大型任务可在工程内维护施工图和进度，文档读写也主用 `pf_*` 以保留历史；续接话题或上下文压缩后先读工程状态、进度与实际图纸。
4. 完成后检查 diff，运行适当构建 / 测试，再更新待办并提交报告；未运行、超时或失败的验证如实说明，不把静态检查或函数成功返回说成测试通过。
