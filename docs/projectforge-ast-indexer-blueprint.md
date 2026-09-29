# ProjectForge AST 符号索引施工图

> 目标：让 Agent 在 ProjectForge 里按"符号地址"精确找函数、读函数、改函数，并能查清 VChat 前端的入口与通道链路。函数有多长由解析器给出确定区间，不再靠正则和缩进去猜。
>
> 状态基准：2026-09-29。已完成 / 进行中 / 未开始 在各节分别标明。凡是没有实测或核实过的内容，都标注为"待核实"。

---

## 0. 结论速览

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | Rust sidecar（tree-sitter，5 种语言）、协议、构建部署、基准 | ✅ 已完成 |
| P1 | 插件接入：Outline / FindSymbol / symbol 寻址读写，不可用时降级到正则 | ✅ 已完成（2026-09-29） |
| P2 | 持久化索引、notify 监听、写穿透、工作区生命周期 | ⏸ 可选，不阻塞交付 |
| P3 | JS 链路地图：模块/页面图、IPC 通道图、window 全局图，`Trace` 命令 | ✅ 已完成（2026-09-29，见 5.6；Rust 9/9、Node 25/25） |

实测基准（VCPChat 全仓，排除 node_modules / dist / target / vendor / .gitignore）：

| 项 | 数值 |
|---|---|
| 参与解析的源文件 | 1201（JS/TS/TSX/Py/Rust） |
| 总行数 | 479,323 |
| 符号数 | 约 2.76 万（按名称 `e` 模糊计数，真实值只多不少） |
| 冷扫描 | 578 ms |
| 热扫描（mtime+size 全部命中） | 77 ms |
| 空闲 / 满缓存常驻内存 | 4.1 MB / 约 65 MB |
| release 二进制 | 7.2 MB（strip + thin LTO），冷编译 15.7 s |

---

## 1. 设计原则

1. **区间以内容为准，不以索引为准。** 读写符号时，插件把刚读到的文件内容交给索引器现场解析（按 `sha256(内容)+lang` 缓存）。返回的区间和这份内容、这份 hash 严格对应，与"查询时校验"的思路一致；索引过期不会导致改错位置。
2. **只给确定的东西。** AST 提供"定义 + 完整区间"。引用和调用链只做字面量和声明层面的解析，结果都标注置信度，不把启发式结论当作类型系统的结论交给 Agent。
3. **行号契约。** 统一使用 1 起算的行号，基于"去 BOM、CRLF/CR 归一为 LF"之后的文本，和 Node 端 `normalizeEol` / `splitLines` 口径一致。不传字节偏移，避免 UTF-8 与 UTF-16 下标、中文注释造成的错位。
4. **永远可降级。** 二进制缺失、协议不匹配、崩溃、超时都不会影响施工，调用方退回现有的正则启发式（`engine.js` 的 `SCOPE_PATTERNS` / `enclosingScope` / 首尾锚定）。
5. **插件独占。** sidecar 由 ProjectForge 进程懒启动并持有；插件禁用时不会启动；stdin 关闭即退出，不会留下孤儿进程。

---

## 2. 已完成部分（P0）

### 2.1 目录与文件

```
rust_projectforge_indexer/            # Rust 源码（按仓库惯例放在根目录 rust_*）
├── Cargo.toml / Cargo.lock
├── build-runtime.js                  # release 构建 → 部署到插件 bin/
├── bench.js                          # 基准：冷扫 / 热扫 / 内存
└── src/
    ├── main.rs                       # stdio JSON-lines 协议主循环
    ├── lang.rs                       # 扩展名 / 语言名 → grammar
    ├── symbols.rs                    # 语法树遍历、符号提取（含单测）
    └── scan.rs                       # 目录扫描、mtime+size 缓存、名称打分

VCPDistributedServer/Plugin/ProjectForge/
├── indexerClient.js                  # Node 客户端（已写，未接入）
└── bin/win32-x64/projectforge_indexer.exe   # 部署产物
```

`package.json` 新增了以下脚本：`build` 末尾追加索引器构建；`build:pf-indexer`、`test:pf-indexer`、`check:pf-indexer:clippy`。

### 2.2 依赖与工具链约束

- 工具链固定 rustc 1.88（与仓库其他 Rust 服务共用，不升级）。`rust-version = "1.88"` 配合 `resolver = "3"`，让 Cargo 自动挑选兼容的传递依赖。
- `tree-sitter ~0.25`（锁定 0.25.10）。0.27 需要 rustc 1.90，因此不采用。
- grammar 精确锁定：javascript 0.25.0、typescript 0.23.2（TS/TSX，ABI 14）、python 0.25.0、rust 0.24.2（ABI 15）。**升级任一 grammar 都必须重跑 ABI 冒烟和全部单测。**
- 符号提取手写树遍历，只用 `kind()` / `child_by_field_name()` / `start_position()` 等稳定接口，避开版本间变动较大的 Query API。

### 2.3 协议（protocolVersion = 2；P3 新增 `facts` 方法，见 5.6）

- 启动后 stdout 输出一行握手：`{"type":"ready","protocolVersion":1,"languages":[...]}`
- 请求：`{"id":N,"method":"...","params":{...}}`，每行一个。
- 响应：`{"id":N,"ok":true,"result":...}` 或 `{"id":N,"ok":false,"error":{"code","message"}}`
- 日志只写 stderr。单个请求 panic 由 `catch_unwind` 兜住，重建 Parser 后返回 `PANIC`，进程继续服务。

| 方法 | 参数 | 说明 |
|---|---|---|
| `ping` | — | 健康检查，返回缓存条数 |
| `outline` | `text`、`lang?`、`path?` | 解析调用方给的文本；上限 8 MB |
| `findSymbols` | `root`、`name`、`kind?`、`glob?`、`exact?`、`limit?`（1–500）、`ignoreDirs?` | 扫描目录按名称找定义；返回 `hits/total/scanned/parsed/lines/truncated` |
| `clearCache` | — | 清空 mtime+size 缓存 |
| `facts` | `root`、`glob?`、`ignoreDirs?`、`bridgeGlobals?` | 协议 2 起。扫描 JS 族源码与 HTML 的链路事实，按 mtime+size+桥接名缓存；返回 `files/scanned/parsed/truncated` |
| `shutdown` | — | 应答后退出 |

错误码：`INVALID_JSON`、`INVALID_PARAMS`、`TOO_LARGE`、`UNSUPPORTED_LANG`、`PARSE_FAILED`、`SEARCH_FAILED`、`UNKNOWN_METHOD`、`PANIC`、`INTERNAL`。

### 2.4 符号数据模型

```jsonc
{
  "name": "revertFileChange",
  "kind": "method",              // function/method/class/object/variable/field/interface/type/enum/namespace/struct/trait/impl/module/constant/macro/union
  "qualified": "gui.revertFileChange",   // Rust 用 :: 连接，例如 Store::put_blob
  "fullStart": 2,                // 含紧邻的 JSDoc / 注释 / 装饰器 / #[attr]
  "start": 3,                    // 签名行（含 export，跳过节点内部的装饰器）
  "end": 5,
  "depth": 1,
  "parent": 0,                   // 扁平数组中父符号的下标
  "signature": "async revertFileChange() {"
}
```

提取规则要点：

- **JS/TS/TSX（同一族）**：函数/类/方法声明，`const x = () => {}`、`const x = function`、`const x = class`，对象字面量（向下探测 3 层，含方法才展开为 `object`），类字段赋值为函数，`export` / `export default`，`module.exports.x = …` / `Foo.prototype.bar = …`（限定名直接用左值），TS 的 interface / type / enum / namespace / 方法签名。`require(...)`、解构声明、`this.x = …`、函数体内的普通局部变量不记为符号；局部函数保留。
- **Python**：def / class / 装饰器（`fullStart` 吸收装饰器），类内函数记为 `method`，类字段记为 `field`，模块级赋值记为 `variable`。块尾挂进来的、缩进不深于定义本身的注释不计入结束行（`py_end_row`）。
- **Rust**：fn / struct / enum / union / trait / mod / const / static / type / macro_rules；`impl<T> Foo<T>` 和 `impl Trait for Foo` 以类型名作为限定前缀。`///` 和 `#[attr]` 计入 `fullStart`，`//!` 模块文档不吸收。
- `fullStart` 向上吸收时遇到空行即停；上一行代码的行尾注释不吸收。
- 语法错误容错：`hasError=true` 时仍尽力提取；递归深度上限 400。

### 2.5 扫描与缓存

- 使用 `ignore` crate：遵守各层 `.gitignore`、`.git/info/exclude`，不跟随符号链接。
- 忽略目录**只保留一个来源**：插件通过 `ignoreDirs` 传入 `modules/services/workspaceIndex.js` 的 `DEFAULT_IGNORED_DIRS`；Rust 内置同一份列表，只在未传入时兜底。`*.egg-info` 和含 `pyvenv.cfg` 的目录一律跳过。
- 上限：单次扫描 20,000 个文件、单文件 2 MB（超出标记 `truncated`），缓存最多 50,000 条（超出整体清空）。
- 脏文件用 rayon 并行解析，每线程一个 Parser。非 UTF-8 文件按 lossy 解码，行号不受影响，但名称可能出现替换字符。
- 名称打分：限定名全等 1000 > 名称全等 900 > 限定名后缀 800 > 前缀 500 > 包含 300 > 限定名包含 200；`exact` 时只接受前三种。

### 2.6 已验证项

- Rust 单测 6/6 通过：JS 类/对象/赋值、TS 声明与装饰器、TSX、Python 装饰器与块尾注释、Rust attr/doc/impl 路径、BOM+CRLF 与语法错误容错。clippy `-D warnings` 通过。
- 协议冒烟：READY 握手、outline、findSymbols、未知方法、shutdown 均正常。
- 真实代码交叉验证：`findSymbols commitEdit` 返回 `fullStart=603, start=607, end=714`，与 `ProjectForgeService.js` 的实际行号（JSDoc 603–606、签名 607、闭合 714）一致。

---

## 3. P1：插件接入（已完成）

### 3.0 落地记录（2026-09-29）

| 项 | 结果 |
|---|---|
| 新增文件 | `symbolResolver.js`（纯函数：地址解析 / 打分 / 消歧 / 区间 / 渲染）、`tests/project-forge-ast.test.js`（8 项）、`bin/README.md` |
| 修改文件 | `ProjectForgeService.js`（生命周期、Outline / FindSymbol、ReadCode / EditCode / MoveCode / CopyCode 符号接入）、`engine.js`（`enclosingScope(idx, line, symbols?)`，`runEditString` / `resolveBlock` 透传 `options.symbols`）、`args.js`（`symbol` / `range` 步骤字段，带 `symbol` 时推断 `op=symbol`）、`plugin-manifest.json`、`.gitignore` |
| ignoreDirs 核实 | ✅ 可直接 `require('../../../modules/services/workspaceIndex')`：该文件无副作用（仅依赖 `ignore@7.0.5`）。GUI 懒初始化本就运行在主进程；`modules/**` 在 `build.files` 内。懒加载 + try/catch，失败时不传 `ignoreDirs`，由 Rust 内置列表兜底。**不抽到 `shared/`**：`shared/` 不在 `build.files` 内，抽过去反而让 `modules/` 一侧引用不到 |
| 配置容错 | `AST_INDEX_ENABLED` 非法值按默认 true 处理并告警，不阻断 `initialize` |
| 实测细节 | `findSymbols` 的 hit 带 `path`（相对扫描根 posix）、`lang`、`score`；顶层符号不带 `parent` 字段。`FindSymbol` 对含 `.` / `::` 的名称未命中时自动换另一种分隔符重试 |
| 与设计的差异 | ① `path=a.js#X` 只在 `#` 后像标识符时才拆分，避免误伤文件名带 `#` 的路径；② EditCode 额外支持 `op=insert + after/before=symbol:X`；`before=symbol:` 插到其前置注释之前；③ 符号歧义与 target 歧义合并进同一张票据，ResolveEdit 口径一致；④ 符号步骤的 `expect` 取区间起始行原文（`fullStart` 或 `range=body` 时的签名行），而不是固定取签名行，以便 engine 的漂移校验对齐被替换区间的首行 |

### 3.1 客户端 `indexerClient.js`（已接入，已测）

- 懒启动：首次 `outline` / `findSymbols` 时才 spawn。
- 握手校验协议版本。二进制缺失、协议不匹配属于确定性失败，直接熔断；进程退出、超时按 1s→2s→…→30s 退避，退避期内直接降级，连续失败 5 次熔断，稳定运行 60 s 后重置计数。
- 请求超时：outline 15 s，findSymbols 90 s。超时后杀掉进程，下次调用时重启。
- outline 缓存：key 为 `lang + sha256(text)`，LRU 300 条。
- 失败一律返回 `null`，不抛给施工流程。
- `binaryPath` 可注入（单测用）。在 asar 包内时自动映射到 `app.asar.unpacked`。

### 3.2 生命周期接线（`ProjectForgeService.js`）

| 位置 | 改动 |
|---|---|
| `freshRuntime` | 新增 `indexer: null` |
| `initialize` | `new IndexerClient({ logger, binaryPath: options.indexerBinaryPath, disabled: config.AST_INDEX_ENABLED === false })`，**只创建对象，不启动进程** |
| `closeStore` / `cleanup` | `await runtime.indexer?.stop()` |
| `ensureRuntime`（GUI 懒初始化） | 共用同一个 indexer |
| `plugin-manifest.json` configSchema | 新增 `AST_INDEX_ENABLED`（boolean，默认 true） |

`findSymbols` 调用时传入 `ignoreDirs: [...DEFAULT_IGNORED_DIRS]`，从 `modules/services/workspaceIndex.js` 引入。**待核实**：分布式服务器进程能否直接 `require` 该文件（路径、打包进 asar 后的 files 列表）。如果不能，改为把列表抽到 `VCPDistributedServer/shared/` 下，两边共用。

### 3.3 符号地址语法

```
symbol=Store.putBlob                 # 在 path 指定的文件内查找
path=src/store.js#Store.putBlob      # 路径和符号合写
symbol=Store::put_blob               # Rust 写法；:: 与 . 等价
```

解析流程（新增 `symbolResolver.js`，纯函数 + indexer 调用）：

1. 用 `readDisk` 读文件，`decodeText` 得到归一化文本和 hash。
2. `indexer.outline(text, rel)`；返回 `null` 时报错并给出降级提示："该文件不支持 AST 或索引器不可用，请用 lines / target"。
3. 在 symbols 里按打分规则匹配：
   - 唯一最高分：直接命中。
   - 多个同分（例如重载、同名嵌套）：返回候选（行号、kind、signature、parent），复用 `describeCandidates` / 票据机制；`pick=N` 或 `line=N` 消歧。
   - 无命中：列出同文件最相似的 5 个限定名作为提示。
4. 输出 `{ startLine, endLine, fullStart, symbol, fileHash }`。

### 3.4 新命令

**Outline**：`projectId`、`path` 或 `paths`（多个），可选 `depth`（默认不限）、`kind` 过滤。
输出按缩进列出的符号树：`L603-714 function commitEdit(ctx, file, plan)`，附带 `hasError` 提示。这比 ReadCode 全文省大量 token。

**FindSymbol**：`projectId`、`name`，可选 `kind`、`glob`、`exact`、`limit`（默认 20）。
扫描范围是**工程根**；如需扩大，传 `glob` 或 `scope=workspace`（后者按所属工作区根扫描，只读）。
输出：`path · L起-止 · kind · qualified · signature`，以及统计（扫描文件数、解析文件数、行数、是否截断）。每条结果都可以直接作为 `path#qualified` 回填给 ReadCode / EditCode。

### 3.5 现有命令扩展

| 命令 | 新参数 | 区间 |
|---|---|---|
| ReadCode | `symbol=`，或 `path=a.js#X` | 默认读 `fullStart..end`；`range=body` 读 `start..end`；可加 `context=N` 前后各多读 N 行 |
| EditCode | `op=symbol` 或 `symbol=` + `content`（替换）/ `op=delete` | 替换和删除默认用 `fullStart..end`；`range=body` 时保留原注释。转成 engine 的 `replace/delete` 步骤（行号 + expect=签名行），**复用现有漂移校验与重叠检测** |
| MoveCode / CopyCode | 源块 `symbol=` | 默认 `fullStart..end`；目标位置可写 `after=symbol:Foo`（插到某符号之后） |
| EditCode 串语法 | `symbol1`、`symbol2` … | 所有符号都在同一份原始快照上解析，与行号串口径一致 |

`engine.js` 的改动原则：engine 保持纯函数、同步。符号解析在 Service 层完成，结果以普通的行号步骤加 `expect` 交给 engine；engine 不感知 AST。唯一的例外是 `enclosingScope`：新增可选参数 `symbols`，传入时按区间包含关系取最内层符号链，否则走原有正则。`findInFiles` 和歧义候选的 `scope` 显示都改为"有 outline 就用 outline"。

### 3.6 并发与一致性

- 写操作仍在 `withLock` 内完成，符号解析在锁内、基于同一次 `readDisk` 结果进行。
- 写盘前的 `assertDiskUnchanged` 保持不变：解析到写入之间如果文件被外部修改，放弃写入。
- 票据：符号歧义沿用 `TicketStore`，signature 取候选的起始行。文件变化后重新解析，候选一致才放行，与现有 target 票据逻辑一致。

### 3.7 manifest 说明（待写）

- 新增 Outline、FindSymbol 两条命令，并附示例。
- ReadCode / EditCode / MoveCode / CopyCode 的描述补充 `symbol=` 用法，说明默认区间是"含前置注释的完整块"。
- 注明支持的语言：JS/TS/TSX/Python/Rust；其他语言请用 lines / target。

### 3.8 测试（`tests/project-forge-ast.test.js`，待写）

1. **有二进制路径**：对 `gui.revertFileChange` 执行 Outline / FindSymbol / `ReadCode symbol=` / `EditCode symbol=`（替换、删除，验证 JSDoc 一并处理）/ `MoveCode symbol=` 跨文件并整批回退；同名符号返回歧义票据后用 ResolveEdit 解决；CRLF + BOM 文件编辑后换行风格保持不变。
2. **降级路径**：注入不存在的 `binaryPath`，Outline / FindSymbol 给出明确提示；原有全部测试不受影响；`enclosingScope` 回到正则结果。
3. **崩溃恢复**：用会立即退出的假二进制验证退避与熔断，确认施工命令仍然可用。
4. 如果 CI 环境没有构建产物，有二进制路径的测试 `skip` 并说明原因，不能让测试失败。

### 3.9 仓库卫生（已处理）

- ✅ `target/`：已被现有规则 `**/target/` 覆盖，无需改动。
- ✅ **新发现并修复**：现有规则 `**/Cargo.lock` 把 `rust_projectforge_indexer/Cargo.lock` 也忽略了，导致精确版本锁定和 `--locked` 在别人克隆后失效。已加入白名单 `!rust_projectforge_indexer/Cargo.lock`（与 CDS / voice 引擎一致），**该文件目前仍是未跟踪状态，需要手动 `git add`**。
- ✅ bin 提交策略：按 `chatDataService/bin/README.md` 的现行做法，只跟踪 `win32-x64/projectforge_indexer.exe` 作为 bootstrap 运行时，其他平台产物一律忽略。已补 `bin/README.md`。注意：`.gitignore` 中 VCP-CDS 段的注释写的是“全部生成”，与 README 的实际策略不一致，这是存量问题，未改动。
- ✅ **不需要打包**（维护者确认）：VChat 的主要用户是 AI，通过命令行启动源码运行，GUI 只是方便人类使用，不走 electron-builder 安装包。因此 `build.files` / `asarUnpack` 不包含 ProjectForge 也没有问题，无需改动；重建 exe 也不必顾虑发布流程。
- ℹ️ `.gitignore` 原有的“临时忽略”段（`package.json`、`modules/ipc/chatHandlers.js`、`modules/settingsManager.js` 等）已由维护者移除。这些文件现在正常跟踪，也会被索引器扫描，IPC 图不会因此缺失 handler。

### 3.10 P1 验收标准

- [x] Agent 能通过 `FindSymbol → ReadCode symbol= → EditCode symbol=` 三步完成一次函数级修改，全程不写行号（测试：`Outline / FindSymbol / ReadCode symbol=`、`EditCode symbol=`）。
- [x] 替换或删除带 JSDoc 的函数时不留下孤立注释（替换 `gui.revertFileChange`、删除 `calc` 均断言注释一并移除）。
- [x] 二进制缺失时旧路径照常可用，新命令给出降级提示，`find` 的 scope 退回正则（测试：`降级`）。崩溃退避 / 熔断、协议不匹配熔断均用假索引器验证。
- [x] `npm run test:pf-indexer`（6/6）、`check:pf-indexer:clippy`（0 warning）、`node --test tests/project-forge.test.js tests/project-forge-robustness.test.js tests/project-forge-ast.test.js`（22/22）全部通过。

---

## 4. P2：持久化与实时新鲜度（可选）

在冷扫只要 578 ms 的前提下，P2 是体验优化，不是正确性前提（正确性由 3.3 的"以内容为准"保证）。

| 项 | 设计 |
|---|---|
| 存储 | 独立 SQLite（rusqlite bundled），路径 `AppData/ProjectForge/index.db`，不与 projectforge.db 混用。表：`roots(id, abs_path, last_access)`、`files(root_id, rel, mtime_ms, size, content_hash, lang, line_count)`、`symbols(file_id, …)`。属于派生数据，损坏时直接删除重建 |
| 冷启动 | 对活跃工程根做 mtime+size 对账，不一致的标脏，后台增量解析；查询不等待后台任务，先用已有数据 |
| 监听 | notify-debouncer-full，只监听有活跃工程的根目录。收到 overflow / rescan 事件时退回全量对账；rename 视为 delete+create；`.gitignore` 或 `pyvenv.cfg` 变化时触发重扫 |
| 写穿透 | 插件写盘后调用 `update { root, rel, text }`，不等 notify 防抖 |
| 工作区生命周期 | 根目录离开写入白名单（工作区被删除或停用）后立即停止监听，保留数据；超过 TTL（如 30 天）未访问则 GC；同一路径重新添加时，按 mtime+size 校验后复用。索引以绝对路径为 key，不依赖 workspace_id |
| 待核实 | 设置页新增工作区时是否复用 workspace_id（`normalizeWorkspaceList` 在没有 id 时按路径哈希生成，但设置页实际怎么分配还没看）。这会影响**工程**（不是索引）重新绑定：id 变化时工程会退回记录的绝对路径，一旦重新回到白名单就恢复可写 |

---

## 5. P3：JS 链路地图（已完成，落地记录见 5.6）

### 5.1 前提数据（全仓统计，用正则计数，属于近似值）

| 链路 | 数量 | 字面量占比 |
|---|---|---|
| `ipcMain.handle/on/once` | 712 | 706（99%） |
| `ipcRenderer.invoke/send/…` | 266 | 249（94%） |
| `webContents.send` | 137 | 未细分 |
| `contextBridge.exposeInMainWorld` | 17 | — |
| HTML `<script src>` | 377（48 个页面） | 全部静态 |
| `require` / `import` | 1664 / 1118 | 相对路径可直接解析 |
| `window.X =` / `window.X.y()` | 358 / 986 | 按名称配对 |

**关键疑点（开工第一步）**：主进程注册了 706 个通道，渲染端直接调用的字面量只有 249 个。差额推测由 `preloads/core/define.js`、`preloads/core/registry.js`、`preloads/shared/apiFactory.js`、`preloads/api/*.js` 这套声明式桥接表生成。必须先读懂这套写法，再写专用适配器。这是 P3 唯一和 VChat 自身写法耦合的部分，也是 IPC 图能否闭环的关键。

#### 5.1.1 P3-0 结论（2026-09-29，已读源码并实测）

- **实际结构**：`preloads/shared/apiFactory.js` 不存在。体系由 `core/define.js`（`invoke / send / on / onArgs / onSignal / custom` 生成 `ApiEntry{kind, channel}`）、`core/registry.js`（扫描 `api/*.js`，校验重名与角色，**不依赖 electron**）、`core/expose.js`（按角色 `exposeInMainWorld`）组成。角色入口 `chat.js / utility.js / desktop.js` 只调用 `exposeRole(role)`。
- **官方查询口**：`preloads/README.md` 明确要求工具使用 `require('preloads/core/registry').describeApis()` 取 `{ name, domain, kind, channel, roles }`，**禁止用正则读 preload 源码**。实测 `api/*.js` 除 `core/define` 外不 require 任何模块，加载无副作用。
- **实测规模**：395 个 API / 394 个唯一通道 / 28 个领域；query 280、command 56、subscription 59。`getPathForFile` 的 `channel=null`（走 `webUtils`，非 IPC，正确排除）；`rag-overlay-approval-action` 同时被 send 与 on 使用（双向同通道，不是冲突）。
- **差额的真实来源**：渲染端调用的是**API 名**（`chatAPI.x` / `utilityAPI.x` / `desktopAPI.x` / 兼容层 `electronAPI.x`），而不是通道字面量。因此 IPC 边分两段：`renderer 调用 API 名 →(declared) 通道 →(literal) ipcMain handler`。每个页面的角色由其窗口使用的 preload 决定；兼容层 `electronAPI` 对非本角色 API 是隔离桩，调用会失败，Trace 需要把"角色不可见"标为 ⚠️。
- **独立 preload**：`chart.js / docx.js / loom.js / loom-page.js / voice-input-capture.js` 不走 `api/`，需要按 `ipcRenderer.*(字面量)` 直接提取（literal）。
- 主进程 706 个 handler 与 preload 394 个通道之间的剩余差额（独立 preload、窗口内 `webContents` 通信、或已无调用方的死 handler）留到 P3-2 用实际数据核对，**待核实**。

#### 5.1.2 适配规则（据此修订 5.3）

1. **不在 Rust 里写 preload 规则。** 声明表由 Node 端取数据（即 5.3 原备选方案，也是仓库自己推荐的方式）。
2. 取数方式：仅当被 Trace 的根目录存在 `preloads/core/registry.js` 时启用。**在子进程中** `node -e "console.log(JSON.stringify(require(<root>/preloads/core/registry).describeApis()))"` 执行，设 5 s 超时，并按 `api/*.js` 的 mtime 集合缓存结果。这样不在插件进程里执行被分析工程的代码；任何失败都退化为"无声明表"，对应的边标为 `unresolved`。
3. Rust `facts.rs` 只提取语言层面的事实：除原计划的 `requires / imports / ipcRegister / ipcCall / ipcPush / globals*` 之外，新增 `bridgeCalls`，即对 `chatAPI|utilityAPI|desktopAPI|electronAPI` 的成员访问（`名称.成员`，记录行号和所在符号）。四个全局名由 Node 端通过参数传入（默认取 `ROLE_GLOBALS` 加 `electronAPI`），不写死在 Rust 中。
4. 图装配在 Node 端完成：`bridgeCalls.member` → `describeApis` 的 `name → channel/kind/roles` → `ipcRegister.channel`。`subscription` 类 API 对接的是 `webContents.send`（`ipcPush`）一侧，而不是 `ipcMain`。

### 5.2 分层与范围

| 层 | 内容 | 难度 | 做不做 |
|---|---|---|---|
| L1 | 模块图（require/import 解析到文件）+ 页面图（HTML 按顺序加载哪些脚本） | 低 | 做 |
| L2 | IPC 通道图：main handler ↔ preload 暴露名 ↔ renderer 调用方 ↔ `webContents.send` 推送方 | 中低（难点在 preload 适配器） | 做 |
| L3 | window 全局图：注入点 ↔ 使用点，以 HTML 页面为作用域，带加载顺序 | 中 | 做 |
| L4 | 函数级调用图 | 高（回调、事件总线、动态派发无法静态解析） | 不做；需要时只按名称做启发式匹配并明确标注 |

### 5.3 实现方案

- **Rust 端新增 `facts.rs`**：对每个 JS 文件提取"事实"，与 outline 一起按 mtime+size 缓存：
  - `requires` / `imports`：说明符、行号、导入的名字；
  - `ipcRegister`：`ipcMain.handle|on|once(字面量)`，记录通道名、行号、所在符号；
  - `ipcCall`：`ipcRenderer.*(字面量)`；
  - `ipcPush`：`*.webContents.send(字面量)` / `win.webContents.send`；
  - `exposes`：`exposeInMainWorld('name', {...})`，展开对象的键；
  - `globalsDefined`：`window.X = …`、页面脚本里的顶层 `function X` / `var X`；
  - `globalsUsed`：`window.X…`；
  - `dynamic`：非字面量的通道参数，记录位置，结果标为 unresolved。
- **HTML**：Rust 里用轻量标签扫描器提取 `<script src>` 和内联脚本（不引入 HTML grammar），输出有序的脚本列表。
- **preload 适配器**：读完 5.1 的文件后确定规则，例如"声明表对象的键 → 通道名"的映射模式，产出 `declared` 置信度的边。规则写在 Rust 里并配 fixture 测试；如果写法过于动态，改为 Node 端 `require` 声明表模块取数据（需确认没有副作用）。
- **图装配**：新增 `trace` 方法，按需在工程根（或 `scope=workspace`）上汇总事实并建索引，返回和查询相关的子图。
- **置信度**：`literal`（字面量直连）、`declared`（经声明表或 expose 键）、`heuristic`（仅名称匹配）、`unresolved`（动态参数，列出位置供人工查看）。

### 5.4 Agent 接口：`Trace` 命令

```
Trace target=ipc:save-settings
  → handler: modules/ipc/settingsHandlers.js L120 (literal)
  → preload: preloads/api/settings.js 暴露为 electronAPI.saveSettings (declared)
  → callers: Promptmodules/prompt-manager.js L88 …（按页面分组）
  → pushes: 无

Trace target=global:VCPUI            # 注：messageRenderer 实为 ES module 导出，不是 window 全局
  → 定义: modules/ui-system/vcp-ui.js L2397（window.VCPUI =，main.html 加载）
  → 使用: modules/ui-helpers.js L627 …；在页面中使用点早于定义点时给出 ⚠️ 顺序告警

Trace target=page:main.html
  → 脚本加载顺序 + 每个脚本的 require/import 依赖树 + 页面内注入的全局列表

Trace target=file:modules/chatManager.js
  → 它注册 / 调用 / 推送了哪些 IPC 通道，定义 / 使用了哪些全局，被哪些页面加载
```

每条结果都带 `path:line`，可以直接回填给 ReadCode / `symbol=`。

### 5.5 P3 验收（2026-09-29 实测）

- [x] 随机抽取 20 个 IPC 通道（种子固定），49 条边（handler / 调用方 / 推送方）逐条回到源码行核对：**0 误报**。
- [x] `unresolved` 27 处（register 3 / call 13 / push 11），与 6 + 17 的量级吻合。
- [x] 全部 40 个页面的脚本顺序与独立正则逐条比对：**0 不一致**（HTML 注释中的 `<script>` 正确排除）。
- [x] 全仓 Trace 冷启动 1.67 s（含声明表子进程 + 两轮 facts 扫描），< 2 s；热查询约 120 ms。

### 5.6 P3 落地记录

| 项 | 结果 |
|---|---|
| 新增文件 | `rust_projectforge_indexer/src/facts.rs`（事实提取 + HTML 扫描，含 3 项单测）、`Plugin/ProjectForge/linkGraph.js`（声明表取数、图装配、4 类 Trace 渲染）、`tests/project-forge-trace.test.js`（3 项） |
| 修改文件 | `symbols.rs`（拆出 `parse` / `outline_from_tree`，facts 与 outline 共用一次解析）、`scan.rs`（facts 缓存，纳入 `.html`）、`main.rs`（`facts` 方法，协议 2）、`indexerClient.js`（协议 2 + `facts()`）、`ProjectForgeService.js`（`Trace` 命令）、manifest |
| 事实规模（全仓） | 1120 个 JS/HTML 文件，40 个页面；register 598 / call 120 / push 127；bridge 调用 501+（含别名）；require 1522 / import 1140；expose 15；script 387 |
| 正则 712 对 AST 598 | 差额约 112 条全部来自已删除的 `开发文档/` 示例仓库，另有 2 条是测试文件中的 mock。AST 结果无漏报 |
| 与设计的差异 | ① preload 适配器不写在 Rust，改为子进程执行 `describeApis()`（`ELECTRON_RUN_AS_NODE`，5 s 超时，按 registry/define/api 的 mtime 缓存）；② 新增**桥接别名追踪**：`const api = window.utilityAPI \|\| window.electronAPI` 共 55 处，经典脚本顶层别名按"同页"跨文件生效，主进程里同名的 `api.x` 不采纳；③ 新增**转发包装识别**：`function handle(channel, fn) { ipcMain.handle(channel, …) }`，同文件 `handle('git:status', …)` 记为 `via=wrapper`，包装函数内部透传记为 `param`，不计入动态；包装函数未被字面量调用时降级为 dynamic，不隐藏真正的 unresolved；④ 同文件常量 `CHANNELS.X`（含 `Object.freeze`）解析为 `via=const`；⑤ 顶层 function/var/let/const 只在经典 `<script>` 或内联脚本中计为全局，module 与 require 进来的文件不算；⑥ 首次 Trace 发现新别名时扩展桥接名单并重扫一次，名单按根缓存，之后一轮扫描即可命中 |
| 检查项 | 有调用无 handler、invoke 对 on-only / send 对 handle-only 的类型不匹配、同通道多个 handle、订阅无推送方、角色不可见（如 `chatAPI` 调用 utility 专属 API）、无 handler 且无调用方（疑似遗留声明）、全局使用早于定义 / 页面未加载定义 |

已知限制：

- **"声明表中不存在的 API" 67 处**：主要是插件自带 GUI（如 `PowerShellExecutor/gui/PowerShellViewer.js`、`Desktopmodules/desktop.js`）经自有 preload 暴露了通用的 `electronAPI.invoke/send`。告警属实，但这些边的通道是运行时参数，不入图。
- `globalsUsed` 只统计显式的 `window.X` / `globalThis.X`；裸标识符访问全局（`X.y()`）需要作用域分析，不做。
- 模块解析只处理相对路径（`./`、`../`）加扩展名 / `index` 补全，包名与 `electron` 不入图。
- 页面的 preload 角色不从 `BrowserWindow` 反推（窗口创建时经 `resolveAppPreload(root, role)` 传入角色，是运行时参数）；角色可见性检查以调用写法里的根全局（`chatAPI` / `utilityAPI` / `desktopAPI`）为准。

---

## 6. 风险与已知限制

| 风险 | 影响 | 对策 |
|---|---|---|
| grammar 升级导致 ABI 或节点名变化 | 符号漏提或区间偏移 | 精确锁版本；升级时必须跑单测和真实文件交叉验证 |
| 大文件或压缩代码 | 解析慢、深度截断 | 2 MB / 8 MB 上限，递归深度 400；超限时降级为正则 |
| Windows 上运行中的 exe 被锁 | 重新构建时部署失败 | 构建脚本给出提示：先停止 VCPDistributedServer / VChat |
| 同名符号（重载、多个 impl 块） | 定位歧义 | 返回候选 + 票据，绝不自动猜 |
| 非 UTF-8 源文件 | 符号名可能出现替换字符 | 行号不受影响；ProjectForge 本身也只编辑 UTF-8 |
| P3 preload 声明表加载失败 | IPC 图退化为只有字面量边 | 子进程隔离 + 5 s 超时；失败时 Trace 头部明确提示原因，不影响其他查询 |
| 协议版本升级 | 旧 exe 与新客户端握手失败 | 协议不匹配直接熔断并提示重建；exe 与 `indexerClient.js` 同步提交 |
| 忽略目录跨进程引用失败 | 两份列表再次分叉 | 懒加载 + try/catch，失败时用 Rust 内置同一份列表兜底（见 3.0） |

---

## 7. 施工顺序

1. **P1-a** 生命周期接线 + `AST_INDEX_ENABLED` 配置 + ignoreDirs 来源核实（3.2）
2. **P1-b** `symbolResolver.js` + Outline / FindSymbol（3.3–3.4）
3. **P1-c** ReadCode / EditCode / MoveCode / CopyCode 接入 `symbol=`，`enclosingScope` 优先用 AST（3.5）
4. **P1-d** manifest 说明、集成测试（两条路径 + 崩溃）、仓库卫生（3.7–3.9）
5. **P3-0** 阅读 preload 声明体系，确定适配规则（5.1）
6. **P3-1** L1 模块/页面图 → **P3-2** L2 IPC 图 → **P3-3** L3 全局图 → `Trace` 命令与验收（5.2–5.5）
7. **P2** 按实际体验需要再启动（4）

## 8. 常用命令

```bash
npm run build:pf-indexer          # release 构建并部署到插件 bin/
npm run test:pf-indexer           # Rust 单测
npm run check:pf-indexer:clippy   # clippy -D warnings
node rust_projectforge_indexer/bench.js .   # 基准：冷扫 / 热扫 / 内存
node --test tests/project-forge.test.js tests/project-forge-robustness.test.js tests/project-forge-ast.test.js tests/project-forge-trace.test.js