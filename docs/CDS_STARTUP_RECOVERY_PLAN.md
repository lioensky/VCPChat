# CDS 恢复启动修复
## 现场
2026-11-12：CDS STARTUP_TIMEOUT，进程无监听端口。只读 SQLite 打开9ms；clean_shutdown=0、filesystem_dirty=1、schema_version=3；quick_check诊断约68996ms后响应取消，未获得完整检查结果，不能判数据库损坏。运行EXE与源码一致性未核验。
## 不变量
- 数据库检查及迁移完成、监听且health成功后才ready；不修改生产数据库/WAL或伪造clean_shutdown。
- 初始启动30秒；收到合法database_open启动阶段后进入独立恢复预算（默认180秒）；阶段帧不刷新绝对恢复截止时间。
- stdout进度帧必须显式通过子进程环境变量VCP_CDS_STARTUP_PROGRESS=1请求，旧调用方维持仅ready协议；新启动器+旧EXE仍保留普通启动预算。
- 恢复预算耗尽为本会话不可自动重试，避免反复杀进程重做检查；普通启动失败保留现有重试。
- 启动阶段及耗时可观测；进度不含令牌。ready握手后禁止并发重复health。
## 实施
Rust增加环境变量opt-in startup_progress NDJSON，数据库检查开始/结束与watcher阶段可观察。阶段帧只含type/protocolVersion/stage，不含令牌。
JS解析并验证进度，分离启动/恢复超时，退出清理定时器及状态。
添加模拟子进程协议回归；Rust测试/格式检查，release构建与临时AppData冒烟。生产运行区部署需确认替换窗口。
## 边界
180秒是有界恢复预算而非保证快检完成；真实IO卡顿原因未证明。导入content非字符串另案。数据库open异常全量隔离策略不在本次改动中。

## 验证结果（2026-11-12 10:46）
- JS生命周期/降级回归12/12通过，包含恢复超过普通期限、重复进度不续命、恢复超时熔断、旧ready兼容、重复/迟到health及停止竞态。子进程边界使用夹具。
- Rust cargo test --locked：67/67通过；release EXE已生成，时间10:46:02，大小15491072 bytes。
- node scripts/verify-cds-startup.cjs：真实release EXE在临时空AppData验证opt-in所有阶段、health、优雅退出；opt-out仅一条ready、health与优雅退出，均通过。notify/tantivy均关闭，未验证真实watcher或大库恢复。
- git diff --check通过；cargo fmt检查因工具链1.89.0缺少rustfmt未执行，不计通过。
- 尚未部署运行区、未重启客户端、未修改生产数据库/WAL、未Git提交。
- 待确认部署窗口，同时替换运行区lifecycle.js及release EXE；生产约826MiB镜像恢复启动尚未复验。
- QueryVisible为终端视口，曾重复显示旧编译输出；不得以该屏幕判定构建仍在运行。后续实际执行成功、产物时间及真实EXE冒烟已确认构建产物可用。