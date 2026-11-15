# ProjectForge Rust 工程服务化施工图

工程：pm82m；2026-11-15；负责人 Kerr。
状态：2026-11-15 已在独立 worktree 续接，原生编辑/票据、元数据、文件操作和异步门面主干已贯通；外部全兼容与发布态验收仍未完成。当前事实以文末“续接：单一权威与 release 交付链”节为准，暂停封存及前文记录仅作历史。
来源：prqp0 的只读调查；逐行高亮假设已暂停，不作为本工程性能结论。

## 用户已确权
Rust 工程服务统一持有工程 SQLite 的全部读写连接；JS 不直连、不持有跨语言数据库租约。保留 ProjectForge 外部工具契约、历史与完整快照。分阶段落地，禁止未经验证的大爆炸替换。
## 范围纠偏与最终边界（2026-11-15 00:44）
用户再次明确：走完最初全部目标，允许移除JS对应编辑操作层，走Rust原生实现。
本话题开头已有“目标与共识”1–9项，均为验收约束，不能缩减为数据库迁移：
1. 独立Rust索引器升级为工程服务；JS只留工具协议/IPC/界面；核心编辑单一权威写入者。
2. 性能预算用于更强候选定位、结构约束、候选验证与局部影响检查。
3. 精确→容错/token→结构候选分级；歧义返回证据，不按相似度自动提交。
4. 同快照hash/revision规划与提交核验；冲突协调、多文件恢复、超时状态查询和幂等。
5. 复用spawn通信，协议有版本/id/边界；不往JS反复搬全AST或工程，不强制WS。
6. Node生态校验隔离承接；AST成功不冒充lint/类型/行为证明。
7. 快路径与按需升级、hash+分析器版本缓存、有界并发/超时/取消/预算。
8. 保留外部契约、历史与快照；迁移/部署/回退明确，不双真源。
9. 总方向已授权，常规细节自主推进；产品语义/数据兼容/不可逆决策才询问。
此前回答称1–9不可见不准确：开头续接摘要已保留以上九项。prqp0无施工记录，不能从那里找出另一份未见原文。

后续以完整操作纵向迁移为主，原下文阶段表仅保留为首段历史规划，执行顺序以本节为准：
A. Rust原生文本索引与编辑规划（UTF8字节边界、原快照坐标、行/target/插入/重叠/atomic/bestEffort），然后符号、首尾锚定、候选票据及安全容错。
B. Rust原生快照与路径授权、编码保留、diff、校验协调、持久提交/恢复；贯通EditCode端到端。
C. CreateFile/RemoveFile/MoveFile/MoveCode/CopyCode/Rollback/GUI回退复用原生计划和提交内核。
D. 工程查询/元数据/读取/Trace/Eval等能力按职责收拢；JS收薄为参数/展示与生态桥。
E. 逐项端到端验收后移除engine.js、tickets.js及ProjectForgeService.js对应编辑实现与调用，不长期保留双编辑引擎。
F. 全回归/基准/release/生产库副本演练/部署接管与回退验收。
A阶段纯函数内核测试不等于B端到端完成；任何过渡RPC规划接口仅用于测试，不作为“JS拿结果自行落盘”的最终生产契约。

## 核心不变量
- Rust 数据面拥有数据库生命周期、schema、迁移、事务及查询；JS 只保留协议适配、IPC、展示状态。
- 单一存储所有者不等于单连接：写入统一协调，读分析采用有界资源；不让索引扫描阻塞提交。
- 不提供任意 SQL RPC；提供按业务设计的查询与变更，分页/批量/按需展开，避免 N+1。
- 解析、候选定位、编辑计划绑定同一内容 hash/revision；提交前重核磁盘版本。
- 模糊搜索积极，提交保守；唯一候选不是正确意图的证明。有歧义返回证据。
- 字符串、Python 缩进、JS 换行语义不可盲目归一化。
- SQLite 事务不等于多文件原子写入：须有持久意图日志、提交状态和启动恢复协议。
- mutation 超时不等于失败；持久 operation ID + 请求摘要去重并支持状态查询，不因超时重提。
- 不将现有 indexer 的静默 null 降级及超时杀进程策略用于权威写入。
- lint/类型/行为测试与 AST 语法各司其职；Node 校验可隔离进程承接。
- 缓存键包含内容 hash 与分析器版本；队列、帧、响应、并发、缓存均有预算。

## 已核对的真实实现
- ProjectForgeService.js 通过 store() 懒创建 JS ProjectStore；GUI IPC 引入同一服务模块（需继续核对完整运行生命周期）。
- store.js：better-sqlite3 单连接、WAL、foreign_keys ON、synchronous NORMAL、schema version 2。
- blobs 为原始字节 sha256 + gzip；现有 gzipSync/gunzipSync 在宿主线程执行。
- projects/todos/batches/nodes/blobs/file_state 必须完整保留；NULL 文件状态与未见过文件需区分。
- indexerClient.js：spawn + stdio JSONL、协议3、id关联、启动握手、故障熔断；请求超时会杀子进程。
- Rust main.rs：stdin 读取线程 + 无界 channel；分析主循环串行派发，扫描内部使用 Rayon；当前无数据库。
- main.rs 的 lines() 无传输帧预算，文本8MiB检查发生在JSON解析后。需先补有界读取及有界队列。
- 初始 git status --short 为空。当前源码区与 H:/MCP/VCPChat 运行区不同。

## 阶段与验收
1. 调查与基础设施：完整调用清单、测试基线、持久图纸；有界协议基础并保持现有协议3兼容。
   验收：Rust测试与协议集成测试；明确不得用于mutation的旧客户端语义。
2. 存储兼容内核：在现有 Rust crate 中分离工程服务执行路径，与 AST 分析队列隔离；Rust接管 schema2、gzip快照及读写业务API。
   验收：仅临时/复制fixture库，逐项对比旧store结果；旧库补列、损坏快照、未知schema、事务回滚。
3. JS切换：全部读取改为异步业务调用，闭包transaction改为Rust侧明确原子命令；移除生产JS数据库连接。
   验收：GUI/工具统一入口，生产代码零裸SQL读取；原有工具回归与历史导出。
4. 提交协调：hash绑定计划、操作幂等、持久日志、多文件恢复与冲突资源协调。
   验收：崩溃窗口注入、响应丢失重试、外部文件漂移、多文件部分落盘恢复。
5. 计算下沉：精确快路径、容错/token/结构候选分级、局部影响与独立校验。
   验收：多语言边界与歧义保守性；缓存一致性、取消与资源压力。
6. 交付：全回归、基准、编译、部署与启动恢复实测。
   验收：可重现证据，不承诺未经测量的倍数；区分源码完成与运行生效。

## 接管、迁移与回退
- 调查阶段不打开生产库做Rust实验，不热替换正在运行的数据库所有者。
- 数据兼容阶段优先保持既有schema和blob格式；新增结构必须有版本与兼容性测试。
- 切换时停止旧入口并关闭旧连接，执行一致性备份/核验，再由Rust启动；接管失败应显式报错，不静默回退到JS双主。
- 部署前记录二进制版本、协议能力、数据库版本、恢复检查结果。迁移后若涉及新语义，回退必须使用兼容版本或停机恢复备份，不丢弃新增历史。
- 最终服务不得依靠进程内singleton假设排除第二个宿主；需要明确数据库服务实例发现/独占启动策略。具体机制待生命周期调查后确定。

## 性能与正确性证据
待采样：精确编辑/大文件diff/历史分页/快照读取/目录索引时提交延迟、主线程阻塞、进程内存。
输出截断不算计算预算；read查询不得长期占用SQLite快照导致WAL无限增长。

## 进度
- [x] 新工程与用户主权决策落盘。
- [x] 核对store、indexerClient及Rust入口，确认旧通信不可直接承接mutation。
- [x] 服务存储调用调查与核心测试基线：ProjectForgeService.js 有56行store/事务/生命周期相关命中；生产裸db连接集中在store.js；部分测试直接访问runtime.store.db，须迁移测试fixture。
- [x] 第一阶段有界传输与服务基础实现测试。
- [~] 第二阶段已实现存储内核与主要读取接口，尚未补齐全部元数据mutation/聚合读取/大结果计算预算，不标完成。
- [ ] 第三至六阶段未实施；生产服务继续使用旧JS存储，不存在已部署Rust接管。
- [ ] 后续阶段按实际证据更新本文件，不以勾选代替验证。

## 首段已落地文件与协议
- `rust_projectforge_indexer/src/transport.rs`：解析前64MiB UTF8 JSONL帧上限、响应先有界序列化后输出；超限输入终止会话，不解析余下后缀。
- 默认索引模式仍为协议3，队列容量2，握手增加能力/预算字段。队列容量不是总内存上限：还包括读取中一帧、执行中一帧、响应及分析对象。
- 同一二进制显式参数 `--storage-service --db ABSOLUTE_PATH` 启动独立进程，专用存储协议1；无参数仍是索引器。无需WS，不新增另一套二进制构建链。
- `storage.rs` / `storage_schema.sql`：保留旧schema2；事务补列；新增`service_schema_version=1`及`service_operations`。未知版本拒绝启动，不自动降级。
- 服务模式使用SQLite synchronous FULL；先取得进程生命周期文件锁再打开DB。此锁仅防第二个遵守协议的Rust实例，不约束旧JS，更不是跨语言租约；正式切换必须关闭旧JS连接。路径硬链接/符号链接别名仍需正式接管前排除。
- `service.rs`：初始化完成后才READY；业务查询、createProject、recordBatch、operation.status。握手明确filesystemCommit=false。
- `serviceClient.js`：无自动重试/null降级/超时杀进程；mutation超时或断链返回OUTCOME_UNKNOWN+operationId；请求在await前冻结；冷启动准入32请求、聚合帧字节64MiB及stdin背压。
- recordBatch仅保证快照/批次/节点/file_state/operation结果的单个数据库事务，不代表磁盘多文件提交。相同operationId同内容回放结果，异内容拒绝，结果可跨服务重启查询。
- 快照兼容sha256原始字节+gzip；读取核验长度与hash，解压32MiB预算；批次快照总32MiB、节点200。当前完整base64 RPC是兼容内核路径，后续编辑提交应由Rust持有字节，避免大文本反复跨界。

## 已执行验证
- 初始：34项现有JS核心回归通过；Rust原有61项加传输4项共65项通过。
- 当前：`cargo test --manifest-path rust_projectforge_indexer/Cargo.toml --locked`：69 passed / 0 failed。
- `cargo build --manifest-path rust_projectforge_indexer/Cargo.toml --locked`：debug二进制成功；未执行release构建与运行部署。
- 新增 `tests/project-forge-service.test.js`：5 passed / 0 skipped，强制使用当前debug二进制；涵盖冷启动准入、非法信封、mutation超时不杀进程、不重提、参数冻结、真实跨语言旧库快照履历兼容、16组业务查询对照、空快照、重复提交、独占启动、默认索引协议3兼容。
- 统一入口 `npm run test:pf-service`：Rust测试→debug构建→新服务集成与6份旧回归；runner设置PF_SERVICE_REQUIRE_BINARY=1，禁止缺二进制时集成skip。加入第5项前的统一运行结果为69 Rust+38 JS全部通过；第5项加入后新服务套件单独5/5通过。
- `git diff --check`通过；Cargo.lock只有LF/CRLF提示。
- Clippy未通过验收：本机1.89工具链未安装cargo-clippy。旧`examples/geo_probe.rs`有has_paren未读warning，未修改无关文件。
- 测试仅使用临时fixture库。没有Rust实验接入生产库，没有复制二进制到运行区，没有重启运行客户端。

## 下一施工段：明确入口与缺口
1. 补齐Rust元数据mutation：updateProject、批量todo动作、softDelete/restore/purge；都用业务事务和operationId，不恢复JS事务闭包。
2. 补齐GUI聚合视图（避免listProjects N+1）与分页/导出大结果预算。当前部分legacy全量读取在构造Value之后才遇到传输预算，不能称为完整计算预算。
3. 增加RustProjectStore异步适配；逐个迁移projectOf/todoOf/recordExternalDrift/rollbackPlan/blobText及GUI方法的同步调用链。严禁仅用async包住旧better-sqlite3。
4. GUI `exportReport`目前同步取返回值，IPC export-report处理器必须加await并新增异步回归；wrap()其他入口本已支持Promise。
5. 将CreateFile/EditCode/MoveCode/RemoveFile/MoveCode块/回退的闭包transaction换成明确原子命令；不能在JS跨RPC持有BEGIN。
6. 持久文件提交日志、hash绑定、幂等filesystem提交与崩溃恢复完成前，不把recordBatch冒充完整提交。
7. 生命周期initialize当前同步关闭store、异步stop旧indexer；统一服务接管需异步ready/closing闸门并与GUI/插件复用实例对齐，禁止并发新旧所有者。
8. 最终移除生产JS ProjectStore连接及裸SQL依赖后，才进行备份/接管/运行交付。测试中旧读取器重开仅用于兼容探针，不能作为正式回退策略。新版operation状态与未来恢复日志不得被旧JS忽略后继续写入。

## 原生编辑规划施工进度（范围纠偏后）
已新增并串联：
- `edit.rs`：Rust纯函数规划；原快照UTF8字节区间，行替换/删除/插入、精确target及显式pick、原生符号替换/删除、重叠保护、atomic/bestEffort、输入/候选/计划/输出预算。
- `text_snapshot.rs`：有界真实磁盘读取、原字节sha256、严格UTF8、UTF8 BOM和多数换行风格保留；无变化保留混合换行原字节。规划产物携带expected_hash/after_hash和编码后字节，不保留第二份输出文本。
- `symbol_address.rs`：原生Symbol地址匹配、限定名与同名候选、注释/body区间核验。近似行号等距保持歧义，不沿用旧JS首候选猜测；此差异需外部契约验收记录。
- `project_path.rs`：规划时工程内路径检查、父目录穿越/ADS/设备名拒绝、链接和别名拒绝。尚不是句柄级无竞态沙箱；尚未完成工作区动态策略同步或提交时授权重核。
- `edit_pipeline.rs`：串联可信允许根、真实文件读取、按需AST、符号选择、编辑计划和编码；精确编辑不强制解析AST。破损AST符号写入暂拒绝，属于需验收的保守行为差异。
- 以上仍为服务内部规划代码，未接生产RPC；没有把patch字节发给JS自行写入。JS生产操作层暂未删除。

最新验证：`cargo test --manifest-path rust_projectforge_indexer/Cargo.toml --locked` 86 passed / 0 failed；`git diff --check`通过。
新增测试曾遇到两项问题并修复：
1. 快照测试from_value被推断成不定长切片，显式Vec<Step>后通过。
2. 破损AST快路径测试target=f同时命中function关键字与函数名，原生歧义拒绝属正确行为；改为唯一片段并保留重复命中拒绝断言后通过。

未完成：持久提交/崩溃恢复/文件与履历协调、Node校验桥、diff、票据、expect漂移/首尾锚定/行号前缀等完整旧契约、token与结构候选、其余操作及JS删除、服务生命周期和生产切换。86项单测不代表完整EditCode端到端验收。
下一步：核对已有Windows原子替换/同步落盘组件，设计并实现持久意图日志和单文件EditCode提交恢复，随后扩展多文件操作。不得把SQLite事务或普通rename称作跨文件原子提交；恢复遇第三种hash必须冲突保留。

## 原生单文件提交恢复内核进度
截至本段：`cargo test --manifest-path rust_projectforge_indexer/Cargo.toml --locked` 100 passed / 0 failed；`git diff --check`通过。均为临时fixture，不是生产验收。
- `file_replace.rs`：同目录create_new暂存、sync_all、路径和原hash复核、Windows MoveFileExW替换、写后核验；非法UTF8/二进制输出在写前拒绝，失败清理不删除目标。外部写入在hash复核到替换之间仍可竞态；ACL/xattr/硬链接和Windows句柄级验收未完成。
- `commit_journal.rs`：持久意图与前后gzip快照同事务保存；prepared/conflict状态占用规范路径资源，跨工程不能并发占用。operation.status可见prepared/conflict；普通元数据mutation不得复用文件操作ID。
- 意图准备前校验输出与diff预算；无变化不生成意图。完成事务从持久快照计算增删行数，并原子写batch/node/file_state/service_operations及committed状态。
- `line_diff.rs`：共同前后缀+有界精确LCS计数；字节/行数/cell/比较字节预算，超限明确拒绝，不近似伪报。尚无完整统一diff渲染；复杂大型修改暂会超预算，需后续算法及契约验收。
- `commit_coordinator.rs`：内部resume按operation ID重新加载权威意图，不信任内存路径/hash；当前工程未删除且路径授权通过才操作。当前hash=before应用持久after快照，hash=after只补记账，第三种内容/缺失/授权失败标conflict而不覆盖。SQL完成失败保持prepared，供再次检查恢复。
- 已测：重启前后落盘窗口、SQL节点插入故障后整个履历事务回滚、幂等完成、内存意图被改仍使用持久路径、工程删除后不动文件、第三种内容不覆盖、超diff预算不落意图不改文件。
- `edit.rs`已增加行替换/删除和插入expect漂移、锚点/符号引用累计预算、补丁数量与重叠比较预算。当前锚点按原样空白比较、等距拒绝，区别于旧JS trim/优先首选行为，必须纳入语义兼容验收。

仍未接生产RPC/自动启动恢复，未迁移或移除JS操作层；没有Node校验、完整旧参数与回执、todo/步骤reason等完整履历语义、票据、首尾锚定、安全容错、其余文件操作、多文件恢复与动态工作区同步。新意图表当前开发版本尚用service_schema_version=1；正式兼容升级前须确立版本迁移及旧服务拒绝策略，不能让旧JS对新恢复库继续写。
下一段：核对现有validator诊断契约，建立Rust主导的隔离Node校验桥；校验结果绑定同一before/after hash，失败/超时不能冒充校验通过；恢复所需校验决策及版本必须随意图持久化，才能开放完整提交入口。

## 01:27 接续校准：校验凭据与恢复已组合，RPC尚未开放
本节覆盖上文“尚无Node校验/service schema仍为1”等过期进度；上文保留为施工历史，不作为当前验收清单。
- n1656：校验后路径/授权根/hash复核已落盘并通过回归。allowed_roots仍为调用时切片，尚非服务动态策略刷新；提交时必须使用当前可信配置重核，不宣称文件系统CAS。
- n1657–n1663：真实Worker Review绑定相对路径与前后分析文本hash；Receipt额外绑定原始字节hash（编码/BOM/换行）、校验器版本与reject_new_syntax策略。凭据与快照/意图同事务落库。
- 服务schema升级到2；可从1事务补validation_receipt列。旧意图不补造凭据；恢复遇缺失/损坏/路径错配凭据标conflict并保留文件与快照。旧开发版Rust拒绝schema2；旧JS不识别服务版本，仍必须停旧连接后才能正式接管。
- commit_coordinator在磁盘应用前核验持久凭据；finish_intent在履历入账前再核验。无凭据prepare_intent只存在于cfg(test)，合成review仅用于存储/恢复单测夹具。
- 已验证n1663工作树：105项Rust passed、1项环境测试ignored后由runner显式执行并passed、42项JS passed；debug构建与git diff --check通过。真实Node测试已覆盖规划→校验→Receipt→持久意图→关闭/重开DB→恢复应用→单一历史节点，不只是合成fixture。
- n1664新增schema1真实表形状迁移反例：保留前后快照与意图、凭据NULL、禁止自动恢复写盘；新增测试本节落笔时待执行回执。
- 生产状态未变：service.rs仍filesystemCommit=false；无原生编辑RPC，无自动启动恢复；JS生产入口/编辑引擎/数据库连接未切除；运行区未修改，生产库未用于Rust实验。
下一主轴：可信启动配置与有界请求契约→EditCode服务内编排→operationId/request_hash重放与恢复→真实跨进程验收。完整履历todo/步骤reason/summary、旧参数和票据兼容、多文件操作、Python进程树、动态工作区策略、资源预算及最终接管仍待完成。不得把内部组合测试标为外部EditCode契约完成。

## 原生编辑RPC首轮贯通（n1666–n1673）
- 新增edit_service.rs：从DB获取工程根，原生规划/真实隔离校验/二次复核/凭据落库/提交恢复均在Rust完成；不向JS返回计划字节用于写盘。持久状态先于规划查询；已提交原请求返回原结果，同ID不同请求拒绝，prepared恢复原意图而不重新规划。
- service_config.rs：显式--config绝对路径启动配置，有界64KiB读取、版本/允许根数量/路径类型/校验超时检查；配置失败先于DB打开。无配置维持纯存储模式并拒绝edit.execute。当前配置是启动快照，动态撤权尚未实现。
- service.rs已接edit.execute；配置启用时握手nativeEditV1与filesystemCommit=true。这是内部版本RPC能力，不代表完整旧EditCode契约或生产接管。
- serviceClient.js支持configPath，并把edit.execute纳入mutation超时OUTCOME_UNKNOWN语义。
- n1673统一验收：106 Rust passed + 1 ignored环境测试显式执行passed；43 JS passed/0 skipped（含真实RPC提交、关闭重启后重放、不同摘要拒绝、语法拒绝、路径穿越/请求注入配置拒绝、未配置拒绝）；debug构建、node --check serviceClient.js及git diff --check通过。编辑工具的File ignored提示不算lint通过。
- n1664 schema1迁移反例已单独与全回归通过。
- 尚缺：无变化的持久结果（目前明确拒绝，不伪造幂等成功）、拒绝结果生命周期、步骤级回执/完整履历、todo关联、旧参数适配/歧义票据/容错候选、自动启动恢复、动态工作区策略与并发查询资源调度。服务当前串行执行编辑，会阻塞同进程后续查询；不宣称已达到最终性能/队列设计。
- JS生产ProjectForgeService/store/engine/tickets仍未切换删除；运行区与生产库未触碰。

## 外部契约补齐进度（n1675–n1691）
本节覆盖前文相应“尚缺”项，未提及项仍待施工。
- 无变化编辑现在持久保存service_operations结果，status=unchanged，不创建文件意图/batch/node；跨重启及磁盘外部变化后重放返回原结果，不重新规划或写盘。当前仍先执行校验，尚未优化为旧JS的无变化免校验快路径。
- service_schema_version=3：事务补commit_context列。上下文保存节点步骤原因、摘要、原生outcome；与校验凭据/前后快照一起进入持久意图，恢复与最终入账前拒绝缺失/损坏上下文，不补造旧履历。
- Step.reason有单项2000字节与累计64KiB预算。批次保存整体reason，节点只保存已应用步骤原因；摘要目前仅“X 步”，尚缺操作名与完整区间展示。
- 提交结果持久保留applied步骤编号、skipped错误及review，重放返回相同结果；bestEffort真实RPC已验证失败步骤不进入节点原因，atomic同请求拒绝且不写盘。
- todo_refs.rs原生解析字符串/数组与旧分隔符，正安全整数、数量/字节预算和保序去重。edit.execute接受todo及todoId别名（均为工程内序号，不是数据库ID），只读解析为持久(id,seq)绑定；准备意图/恢复写盘前/最终事务都复核工程归属与身份。
- todo语义有意收紧：仅成功文件履历最终事务将pending转doing并记录updated_by；规划失败/语法拒绝/无变化不更新todo，区别旧JS规划前就更新状态。此行为差异需最终契约验收明确记录。节点关联第一个输入序号；其余关联保留于上下文。
- 已测todo删除重建身份不冒领、最终SQL故障回滚node与todo状态且保留prepared意图，重试恢复后统一完成；真实RPC验证多todo顺序、无副作用拒绝和幂等。
- 最新n1691统一回归：110 Rust passed + 1 ignored环境测试显式执行passed；45 JS passed、0 skipped、0 failed；debug构建及git diff --check通过。生产编译剩pending_intents未使用warning，存量geo_probe warning；Clippy仍未安装未验收。
- 下一步补原快照到新文本区间回执、操作名摘要与结构化上下文核验。applied当前只有编号，不宣称完整旧EditCode回执已兼容。旧参数适配/票据/锚定省略/token结构候选/Python/自动恢复/动态授权/元数据与其余操作/生产JS切除和部署仍未完成。

## 区间回执与持久证据核验（n1693–n1699）
- Outcome追加placements，保留applied步骤编号。每个补丁在原快照应用时记录操作名、原/新半开UTF8字节区间与行号；删除输出行号为null。字节坐标属于去BOM的LF分析快照，不是磁盘原始字节坐标；不通过重新搜索最终文本推断区间。
- 正常提交及unchanged结果保留placements，提交上下文随意图持久化，重启重放使用原回执；摘要补齐已应用操作名。
- CommitContext准备与恢复核验：applied正整数唯一、skipped结构及归属、无未决歧义、changed与快照相符、区间有界/有序/UTF8边界/行号正确、每个已应用步骤有证据、区间外前后文本一致。此为快照一致性验证，不重新规划，也不是针对恶意数据库篡改的密码学认证。
- 新增Unicode、多行偏移、同点插入、删除空输出，以及合法JSON下越界/错行/缺区间/重复步骤/错误归属/错误changed反例。
- 最新n1699统一验收：112 Rust passed；1 ignored环境测试显式执行passed；45 JS passed/0 skipped/0 failed；debug构建与git diff --check通过。生产状态未变。
- 后续回到旧输入兼容主线：行号前缀剥除、首尾省略锚定与歧义票据；并仍欠动态授权、拒绝结果生命周期、自动恢复、Python、其他操作及元数据收拢、JS生产切除、部署验收。当前内部RPC不等于完整外部EditCode已完成。
## 暂停封存（2026-11-15，工程 pm82m）

用户安排：今日另有4个工程推进，本工程暂缓。本轮只读脉络、更新图纸、执行现有回归、Git分支封存，不继续业务施工。
- 封存分支：`wip/projectforge-rust-service-pm82m-20261115`；起点为本地 `main` 的 `0a5adec0`。以Git实际推送回执为准；本文件不预写尚未产生的提交hash。
- 本轮检查的30个Git改动文件均属于本工程（服务客户端、校验桥、Rust模块、测试、依赖与本文档）；检查时均已暂存，无未暂存差分。
- 未改运行区 `H:\MCP\VCPChat`，未部署二进制、未将Rust实验接入生产库、未切除生产JS存储/编辑入口。源码构建产物不是运行部署。

### 当前真实实现与最后断点
内部服务已具备有界RPC、兼容存储与历史、hash绑定原生单文件编辑、隔离Node校验凭据、持久意图/幂等重放/冲突保留、todo绑定与区间证据核验；这不是完整外部工具契约或最终服务化完成。
最后施工为 n1697–n1703：
1. ReadCode展示行号前缀采取全有或全无剥除，保留代码缩进，仅清洗输入一次，不清洗原快照。
2. `elision.rs`提供保留缩进的首尾整行省略候选，支持独立省略行 `...` / `…` / `⋮`，有比较/字节/候选配对预算。
3. `edit.rs`先尝试字面target，失败后才进入省略候选；即使只有一个省略候选也要求显式pick；整块替换保留尾换行，重叠多选拒绝，不隐式重缩进。
4. 目前尚无完整外部歧义票据闭环；省略候选单测通过不等于旧JS首尾锚定行为已完全兼容。须明确记录更保守的行为差异，而非为兼容恢复猜测写盘。

### 本轮封存验证（实际执行）
执行 `npm run test:pf-service`，退出码0：
- Rust默认测试：116 passed / 0 failed / 1 ignored。
- ignored真实Node环境用例由runner显式执行：1 passed / 0 failed。
- debug构建通过；JS新服务及旧回归45 passed / 0 failed / 0 skipped。
- `git diff HEAD --check`通过（追加本节后提交前再检查）。
- 已知warning：`examples/geo_probe.rs::has_paren`未读；`commit_journal.rs::pending_intents`未使用。未在封存任务顺手修复。
- 本轮未执行release、Clippy、全仓库全部测试、Electron实机或生产接管验收；既有Clippy缺工具记录不能算通过。

### 恢复施工入口与未完成项
恢复时先切换/检出封存分支，复读本文末节及工程pm82m履历，再核对实际源码与Git状态；不要直接在main重复实现已有内核。
1. 续接旧参数兼容与歧义票据：首尾省略的真实跨进程/外部契约用例、hash绑定票据与显式选择；再按需推进token/结构候选及局部影响验证。
2. 尚缺拒绝结果生命周期、自动启动恢复、动态工作区授权、Python进程树控制、完整diff与大结果计算预算、并发查询资源调度。当前服务串行编辑会阻塞后续查询，不宣称最终性能已达标。
3. 元数据mutation/聚合查询、其余文件和代码块操作、多文件提交恢复、Rollback及GUI回退尚未统一迁移。
4. 全部存储读写与事务边界迁往Rust、生命周期ready/closing闸门、旧JS存储/编辑/票据实现退出、生产副本迁移/独占接管与回退演练尚待完成。
5. 当前开发服务schema为3；旧JS不识别新恢复语义。必须停旧连接后接管，严禁让新旧所有者双写。
6. 接管前还要处理路径别名/句柄级竞态边界与Windows文件属性验收；现有hash复核不是文件系统CAS。

本次暂停不标记工程已完成，不提交accepted验收；保留未完成todo供后续续接。

## 2026-11-15 续接：拒绝重放与启动恢复

在独立分支 `feat/pf-rust-service-continue` 上续接；未切换主工作树，未接生产库或替换运行区二进制。
- `edit.execute` 的 planningRejected / syntaxRejected 复用 service_operations 保存结果与请求摘要；同 ID 同请求返回原结果，异请求拒绝。operation.status 返回对应拒绝状态；旧 committed / unchanged 查询行为保持。参数、路径和运行时异常仍按原错误通道返回，本次不扩展成统一错误生命周期框架。
- service.run 在 ready 前只扫描 prepared 意图，使用可信启动 roots 调既有 resume；不重新规划、不重做校验。已有 conflict 不自动重试；恢复失败则本次启动失败，已完成的意图不回滚。无配置且有 prepared 时拒绝启动并保留原意图。
- 沿用原有服务集成用例覆盖拒绝的重启重放、异请求拒绝，以及由真实提交凭据还原 prepared 窗口后的启动恢复；未新增测试套件。
- 集中验证：原入口 116 Rust passed，1 项 ignored 真实 Node 用例显式执行 passed，45 JS passed / 0 skipped。删除恢复后的冗余查询后重新 debug 构建成功，定向跨进程原生编辑用例 1 passed / 0 skipped（包含启动恢复）。
- 本机验证使用已安装 MSVC 的 vcvars64，进程局部设置 CARGO_PROFILE_DEV_DEBUG=0、CARGO_BUILD_JOBS=4，并使用仓库内临时目录；未改全局工具链、权限或 Cargo 配置。D8050 的完整机制未确认，不作为源码缺陷结论。
- 未执行 release、Clippy、全仓库/Electron 或生产迁移验收。原有 pending_intents 和 geo_probe 未使用项 warning 未顺手整治。

以上为首段续接历史，不再作为当前未完成清单。

## 2026-11-15 续接：单一权威与 release 交付链

工作树：`C:\Users\szou5\Desktop\code\work\vcpchat-pf-service`；分支 `feat/pf-rust-service-continue`；续接工程 `ptyfc`。用户再次要求快速推进主线、不做防御性框架、不堆测试、最后清理本次不必要临时痕迹；子代理不能验收关单。

### A–E 最终落点
- 原生 EditCode 已覆盖旧行号/target/插入/符号地址、首尾省略以及 exact → elision → token → structure 四级候选。歧义票据持久绑定原快照，ResolveEdit 只在同一快照完成显式选择（`source_hash` 仅在票据/服务内部闭环校验，不强迫外层调用者传 `expectedHash`）；JS 不接收待写盘字节。
- 工程元数据与查询、Create/Remove/Move/MoveCode/CopyCode、整批 Rollback、GUI 单文件回退均接入同一个 Rust 服务。schema5 同事务迁移单/多文件日志（含清理旧持久冲突挂锁索引与触发器）；SHA256+gzip 原字节快照及 prepared/applied/conflict/committed 状态由单一服务持久协调。
- 服务保持单写权威并提供有界只读连接池、队列/并发预算与可查询统计；GUI 热态只读请求不再被慢校验串行阻塞。原生 diff 提供有界统计、统一 diff 和明确截断元数据，不把大快照搬回 JS 重算。
- 工具与 GUI 共用异步服务生命周期；可信 roots 变化在请求之间关闭旧所有者后重启。CreateProject 的目录创建、Python 校验进程树和启动前恢复都归 Rust 权威入口。
- 旧 `store.js`、`engine.js`、`tickets.js` 已在迁移测试 fixture 后从源码树物理删除；生产门面只保留参数、展示、Electron/Node 生态桥。changed 通知由单一工具分发入口产生。
- 多文件协调是持久恢复日志，不承诺 OS 级跨文件原子写；hash 复核不是文件系统 CAS。遇第三方内容漂移、应用失败或启动恢复冲突时保留 `before` 审计快照、多文件按逆序补偿回滚本次已写部分（不覆盖第三方字节）、立即释放全部资源锁并直接报错返回，不设需要人工/Agent 解锁的持久挂起态。

### F 最终交付与证据（2026-11-15 22:29）
- 最终统一 runner：Rust `145 passed / 0 failed / 1 ignored`；默认 ignored 的真实 Node validator 另行显式执行 `1 passed`（合计 `146 passed / 0 failed / 0 skipped`）；8 份 Node/SQLite 服务套件 `49 passed / 0 failed / 0 skipped`。
- 在原有业务链之外保留真实 SQLite 回归，覆盖 schema4→5/旧库迁移原子性、外键完整性、WAL 快照隔离与唯一写者、单文件意图事务回滚/幂等/冲突即时释放锁、三文件日志部分落盘恢复、补偿回滚与第三方字节保留、持久票据事务/外键/唯一解析操作约束。测试均使用磁盘临时库并核对重开状态，不用 mock 冒充数据库。
- `node rust_projectforge_indexer/build-runtime.js` 已从当前源码完成 Windows x64 release 并更新本隔离工作树随包程序；随包与 `target/release` SHA256 同为 `41aaf69d5815d9625fb9daada3c16c4043d5245f3b56ef4b349cbdcd448bf6db`。未修改主工作树、运行区或生产库。
- [打包配置](<../package.json>) 已包含 ProjectForge 插件、共享 fileKit 与 GUI，并将插件及共享模块映射到 `app.asar.unpacked`。最终真实最小 asar + Electron BrowserWindow 冒烟 27/27 全绿：原生服务与校验 worker 从 unpacked 运行，GUI/utility preload/IPC 从 asar 加载，25 份外链脚本、6 份样式无资源或控制台错误，合法 JSON 提交、非法 JSON fatal 拒写且保留原字节。
- `git diff --check` 通过；当前只保留既有 unused 警告，没有为风格顺手扩大业务改动。

### 本分支明确未覆盖
1. 未执行完整 NSIS/签名/自动更新安装包实机流程；真实 asar 运行边界已验收，但不能冒充完整安装器验收。
2. Unix 进程组、Windows 文件属性/路径别名及真实文件系统 CAS 边界未做跨平台实机；当前实现不承诺 CAS 或跨文件原子性。
3. 未以生产数据库副本执行接管与回退演练，未部署或加载生产运行区。本分支仅准备提交到 `wip/projectforge-rust-service-pm82m-20261115` 的 PR；生产操作需另行授权。
4. Clippy 与全仓库无关模块测试未执行；ProjectForge 自身 Rust、Node/SQLite、validator、release 与真实 asar 门禁已经完成。