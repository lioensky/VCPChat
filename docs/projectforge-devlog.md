# 开发日志：ProjectForge 工程施工台

日期：2026-09-28

## 目标

做一个面向 Agent 的代码施工插件，设计以“AI 友好”为首要指标。流程是：创建工程拿到 projectId，之后所有文件施工都挂在这个 ID 上。能力包括：

- 行级编辑与串语法
- 歧义消解
- 自动代码审查
- 每次变动自动存快照，可回退
- todo 进度跟踪与验收报告
- 完整的开发脉络，包括原因（reason）和操作者（maid）

## 关键决策

- **独立插件，类型为 `hybridservice` + direct。** 进程常驻，持有单个 SQLite 连接，并在内存中维护歧义票据。没有改造 stdio 形态的 FileOperator，两者共用的逻辑抽到 `shared/fileKit`。
- **数据库直接用主依赖 `better-sqlite3`**，不新增依赖。已确认在 Node v22.18 下可以直接加载，单测不需要 Electron 环境。
- **串内行号一律以调用前的原始快照为坐标。** 所有步骤先换算成原文上的字符区间，统一检查重叠，最后一次性按升序拼接。区间重叠时直接报错，不做猜测。
- **target 多处命中时不自动选择。** 插件签发票据并返回候选，每个候选附带行号、所在函数和上下文。AI 用 `ResolveEdit` 只回传选择，不需要重发内容。票据绑定文件 hash。如果文件变了但候选位置没变，就照常放行；否则作废并返回新的候选。
- **删除工程只动数据库。** `DeleteProjects` 做软删，`RestoreProjects` 恢复，`PurgeProjects` 要求先软删并传 `confirm=true`。三者都不碰磁盘文件。删文件是另一件事，必须显式调用 `RemoveFile`。
- **`RemoveFile` 先存快照，再移到系统回收站**，与 FileOperator 的做法一致。即使回收站已经清空，也能用 `Rollback` 恢复。
- **写入白名单来自已启用的工作区**，外加可选的 `ALLOWED_DIRECTORIES`，每次调用实时计算，不需要手动配置。工程按 `workspace_id + subpath` 定位，工作区整体搬家后仍然有效。工作区停用后，工程变为只读。
- **所有写操作都必须带 reason。** 缺失时的报错会附上可以直接照抄的参数格式。批次和节点两级都记录 reason，串内可以用 `reasonN` 覆盖单步的原因。
- **maid 作为中央注入的字段持久化**，用来记录每次操作是谁做的。`args.maid` 表示调用者本人，所以按操作者过滤历史时用单独的 `byMaid` 参数，避免两者混淆。
- **输出使用标准 OpenAI content 数组**，也就是 markdown 文本加 `image_url`。代码放在按内容自适应长度的 fence 里，避免 AI 在 JSON 字符串里产生转义幻觉。多模态文件（例如脚本生成的截图）可以用 glob 批量读取。

## 功能

### 行级编辑引擎（`engine.js`，纯函数）
- op 支持 replace、insert、delete、target。缺省 op 时，根据提供的字段自动推断。
- `expect` 锚点：行号有偏差时，在 ±20 行内就近重新定位，并在结果中说明漂移了多少行。
- 自动剥除 `N | ` 行号前缀。只有所有非空行都带前缀时才剥除，避免误伤 markdown 表格。
- target 精确匹配失败时，会忽略行首尾空白再匹配一次，并把 replace 平移到实际缩进。
- `atomic` 模式（默认）：任一步失败，整串都不写。`bestEffort` 模式：跳过失败的步骤，并逐项报告。
- 找不到目标时，返回最相似的几行及相似度，让 AI 一步就能修正。
- 用轻量正则识别所在定义，支持 JS/TS/Python/Rust/Go，形如 `Store > putBlob`。

### 数据层（`store.js`）
- 表：`projects`、`todos`、`batches`、`nodes`、`blobs`、`file_state`。
- blob 按 sha256 内容寻址并 gzip 压缩，存完整快照，回退不依赖 diff。
- `file_state` 记录插件最后一次已知的文件 hash。磁盘内容与之不一致时，自动记一个 `external` 节点，这样回退不会悄悄吞掉用户手动做的修改。
- 回退本身也会生成新批次，所以 `Rollback batch=last` 连续执行两次就是重做。
- 旧库打开时自动补列（`PRAGMA table_info` 加 `ALTER TABLE`），`schema_version` 为 2。

### 自动审查（`shared/fileKit/validator.js`）
- 编辑前后各校验一次，按规则和信息做多重集差集，**只报告本次新增的问题**。
- `revertOnSyntaxError=true` 时，出现 fatal 级诊断就拒绝写入。
- 每次写入都附带紧凑的 unified diff（基于 `diff-match-patch` 的 line mode）。

### 其他
- 同一工程的写操作串行执行，防止多个 Agent 同时写入时互相交错。
- 保持文件原有的换行风格（CRLF/LF/CR）和 UTF-8 BOM。二进制文件和 UTF-16 文件拒绝按文本编辑。
- 验收报告由插件从数据库生成骨架，包括 todo 完成情况、改动文件、参与者和开发脉络。AI 只需要填写结论和遗留问题。状态流转为 active → review → accepted。

## 命令

| 类别 | 命令 |
|---|---|
| 工作区与工程 | ListWorkspaces、CreateProject、ListProjects、GetProject、UpdateTodos、SubmitReport |
| 删除 | DeleteProjects、RestoreProjects、PurgeProjects（均只动数据库） |
| 施工 | ReadCode（lines / `path:M-N` / paths / glob / find）、EditCode、ResolveEdit、CreateFile、RemoveFile、MoveFile |
| 回退与历史 | Rollback（batch / toNode + path，dryRun / force）、SearchHistory（keyword / content / byMaid / todo / op …）、GetNodeDiff |

## FileOperator 顺带修复

- `isPathAllowed` 原先用 `startsWith` 判断，`D:\VCP` 会放行 `D:\VCP2`。现在改为 `path.relative` 层级判断。
- `CodeValidator` 的 Python 校验原先用 `execSync` 拼接字符串，存在命令注入。现在改为 `execFileSync` 传参数数组，并能解析出真实行号。JS 会自动区分 module 和 commonjs。新增了 JSON 校验。校验器改为懒加载。
- `ApplyDiff` 原先重复校验，结果会重复附加，已修复。
- `writeFile` 和 `updateHistory` 补上了路径归一化。

## 改动文件

新增：
- `VCPDistributedServer/Plugin/ProjectForge/`：`ProjectForgeService.js`、`engine.js`、`store.js`、`workspace.js`、`tickets.js`、`args.js`、`plugin-manifest.json`
- `VCPDistributedServer/shared/fileKit/`：`paths.js`、`text.js`、`validator.js`、`reader.js`、`diff.js`、`output.js`、`index.js`（放在 `Plugin/` 之外，不会被当成插件扫描）
- `tests/project-forge.test.js`

修改：
- `modules/ipc/workspaceHandlers.js`：导出只读门面 `workspaceService`
- `main.js`、`VCPDistributedServer/VCPDistributedServer.js`：把 `workspaceService` 注入 direct 插件
- `VCPDistributedServer/Plugin/FileOperator/FileOperator.js`、`CodeValidator.js`

依赖：无新增。复用了 `better-sqlite3`、`diff-match-patch`、`glob`、`trash`、`eslint`、`stylelint`。

## 验证

- `tests/project-forge.test.js` 7/7 通过。覆盖以下内容：
  - 完整生命周期
  - 歧义票据
  - 回退与重做
  - 外部修改冲突
  - 回收站恢复
  - 删除工程只动数据库
  - 前缀剥除、expect 漂移、bestEffort、CRLF 保持
  - 多 maid 署名、byMaid 过滤与参与者统计
  - 旧库迁移

  测试注入了假的工作区门面和回收站，不会碰到真实的设置和系统回收站。
- 回归测试 12/12 通过：`workspace-index`、`workspace-live-reference`、`chart-controller`。
- 改动的文件均通过 `node --check`。PluginManager 能正常加载 ProjectForge。
- 用户已完成多轮单元测试，以及 3 个 Agent 协作对抗测试。

## 已知问题

- 尚未在 Electron 中端到端运行，真实的系统回收站调用没有实测。
- `package.json` 的 `build.files` 没有包含 `Plugin/ProjectForge/**` 和 `shared/**`，打包前需要补上。FileOperator 原本也不在打包列表里。
- FileOperator 是 stdio 子进程，没有接入工作区白名单。如果要接，可以读取 `AppData/settings.json` 的 `workspaces`。
- 歧义票据只存在内存里，插件重启后会丢失，AI 需要重新提交一次 EditCode。
- 在纯 Node 环境下加载插件时，`PowerShellExecutor` 会报错。原因是它缺少 Electron 依赖，与本功能无关。