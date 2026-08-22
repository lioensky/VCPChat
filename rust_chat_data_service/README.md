# VCP Chat Data Service（VCP-CDS）

VCP-CDS 是 VCPChat 的中央聊天数据服务。第一阶段建立旁路镜像，
第二阶段已承接 DeepMemo 搜索与 VCPMobileSync 消息同步数据面。

## 当前边界

- `history.json` 仍是桌面聊天兼容真源。
- SQLite 是完整查询镜像，也是移动消息同步的中央索引。
- Tantivy 是可删除、可重建的搜索派生物。
- DeepMemo 通过中央搜索接口工作。
- `MobileSyncUseCentralIndex=True` 时，VCPMobileSync 的 Manifest、Topic/Message Diff、
  Message Pull/Push 与消息 Tombstone 由 VCP-CDS 提供。
- 中央同步模式不打开或写入旧 `VCPMobileSync/sync_state.db`，也不启动其历史扫描和 watcher。
- 关闭 `MobileSyncUseCentralIndex` 可恢复旧同步索引链路；旧数据库文件不会自动删除。
- 普通桌面聊天保存仍先写 `history.json`，由直接通知或 `notify` 摄取。
- VCP-CDS 的 Mobile Push 属于同步数据面：它会把 Mobile wire DTO 投影为 VCPChat 原生消息后写回 `history.json`，但不会参与模型调用、提示词、渲染或普通聊天保存。
- 同步写入严格读取历史、校验来源 SHA-256、同步唯一临时文件并原子替换；检测到损坏或来源变化时失败，不覆盖现有历史。

## 构建与部署

从项目根目录执行：

```text
npm run build
```

该命令调用：

```text
rust_chat_data_service/build-runtime.js
```

脚本先执行 Cargo Release 构建，再将当前平台的原生运行时复制到 Electron SDK 目录：

```text
modules/services/chatDataService/bin/<platform>-<arch>/
```

支持的运行时目录：

```text
win32-x64
win32-arm64
darwin-x64
darwin-arm64
linux-x64
linux-arm64
```

Windows 二进制名：

```text
vcp_chat_data_service.exe
```

macOS/Linux 二进制名：

```text
vcp_chat_data_service
```

`rust_chat_data_service/target/release` 只是 Cargo 构建缓存，不再作为 Electron 的运行时路径。

`npm run build` 只原生构建当前主机。Windows、macOS 和 Linux 发布包必须在对应操作系统的构建机或 CI Runner 上执行；x64 与 arm64 也必须分别构建。

Electron 打包命令会自动先部署当前平台运行时：

```text
npm run pack
npm run dist
```

## 独立启动

```text
vcp_chat_data_service --app-data ../AppData --port 0
```

服务只允许绑定回环地址。成功启动后，stdout 只输出一次握手：

```json
{
  "type": "ready",
  "protocolVersion": 2,
  "schemaVersion": 1,
  "port": 49152,
  "instanceId": "uuid",
  "authToken": "ephemeral-token"
}
```

后续结构化日志写入 stderr。

## 数据位置

```text
AppData/
├── databases/
│   ├── chat_data.sqlite3
│   ├── chat_data.sqlite3-wal
│   ├── chat_data.sqlite3-shm
│   ├── chat_data_service.lock
│   └── chat_search_index/
├── Agents/
├── AgentGroups/
└── UserData/
```

Node 消费者不得直接打开中央 SQLite 或 Tantivy 目录。

## 身份模型

内部 Topic 身份：

```text
(owner_type, owner_id, topic_id)
```

内部消息身份：

```text
(owner_type, owner_id, topic_id, msg_id)
```

原始 `topicId` 和消息 `id` 不会被拼接、替换或写回新格式。

不同分支 Topic 复制相同消息 ID 是受支持的正常情况。

群聊消息另外保存 `speaker_agent_id`，用于区分：

- 会话 Owner：Group。
- 消息发言者：Group 中的 Agent。

## DeepMemo 旧名称兼容

身份解析位于 CDS 的 DeepMemo 请求规范化层，不位于 Tantivy 层。

解析顺序：

1. `ownerId` 精确定位。
2. Agent 显示名精确匹配。
3. 旧 `maid` 参数唯一包含匹配。
4. 多个包含候选返回 `AMBIGUOUS_IDENTITY`。

示例：

```text
maid = Nova
display_name = vcp小助手Nova
```

当且仅当该包含结果唯一时，解析为对应 Agent。Tantivy 始终接收解析后的精确 Owner ID，不执行名称猜测。

## Feature Flags

默认值位于主程序设置管理器：

```text
ChatDataServiceEnabled=True
ChatDataServiceShadowMode=True
ChatDataServiceNotifyEnabled=True
ChatDataServiceTantivyEnabled=True
MobileSyncUseCentralIndex=True
DeepMemoUseCentralSearch=False
DeepMemoLegacyFallback=True
```

关闭一期服务：

```text
ChatDataServiceEnabled=False
```

关闭后：

- 现有聊天读写不受影响。
- VCPMobileSync 继续使用旧同步数据库。
- DeepMemo 继续使用旧 EXE。
- 中央数据库保留供诊断或后续恢复。

## HTTP API

无鉴权健康检查：

```text
GET /v1/health
```

以下接口需要启动握手中的 Bearer Token：

```text
GET  /v1/status
POST /v1/reconcile
POST /v1/rebuild-search-index
POST /v1/ingest/history-path
POST /v1/search/messages
POST /v1/search/memories
POST /v1/sync/manifest
POST /v1/sync/message-manifest
POST /v1/sync/topic-diff
POST /v1/sync/message-diff
POST /v1/sync/messages/pull
POST /v1/sync/messages/push
POST /v2/sync/messages/pull
POST /v2/sync/messages/push-topic
POST /v2/sync/topic-identity
POST /v1/flush
POST /v1/shutdown
```

`/v2/sync/messages/pull` 返回逐 Topic NDJSON。每帧先通过与 Node/Mobile golden fixture 一致的 canonicalizer：消息 ID、role 和 timestamp 必须合法；桌面附件只从顶层或 `_fileManagerData.hash` 接受一致的 SHA-256，非法附件产生有界 warning 而不丢消息。`history_sources.status` 非 ready 时禁止从旧 SQLite 镜像下发。

`/v2/sync/messages/push-topic` 每次只提交一个 Topic，接受 VCPChat 原生投影消息及 `deletedMessageTombstones: [{msgId, deletedAt}]`。CDS 原子投影 `history.json`、严格摄取 SQLite，并为本地缺失消息也建立稳定墓碑；重放保留最早删除时间。调用方必须检查 HTTP 状态、Topic 身份和逐项成功值。附件缺失 hash 由 VCPMobileSync 投影层计算并返回手机端。

同步流预算为单帧 32 MiB、单 attempt 256 MiB、最多 10,000 Topic 和 100,000 Message。SQLite 阻塞读取在受控 blocking task 中执行，NDJSON Body 由 HTTP 消费节奏驱动，不在服务端预先累计完整响应。

VCPMobileSync 保留手机鉴权、WebSocket、HTTP/NDJSON 和 DTO 编排。中央模式下：

1. 启动时等待 CDS READY 并执行一次 reconcile。
2. 不初始化旧 `sync_state.db`。
3. 不扫描历史文件。
4. 不启动旧 chokidar watcher。
5. 消息下载与上传通过中央客户端转发。

`MobileSyncUseCentralIndex` 的优先级固定为：插件显式布尔值 > 主程序 Facade 布尔值 > 默认 `true`。显式 `false` 只影响重启后的新 session，不在 attempt 中途回退。CDS 启动在后台进行，失败只禁用中央同步，不阻塞普通 Chat 窗口创建。

## 协议与失败语义

- VCPMobileSync public wire 固定为 1.1；CDS Node/Rust 内部握手固定为 protocol 2。
- 1.0/1.1 不支持混跑，桌面插件、CDS runtime 与 APK 必须配对发布和回滚。
- Phase 3 decision 是严格判别联合：`{ok:true,toPull,toPush}` 或 `{ok:false,error}`。
- 缺 Topic、重复 Topic、错误字段类型、无效历史、DB/HTTP/附件错误均终止当前 attempt；不得以空集合降级成成功。
- Topic manifest 和 NDJSON 消息帧必须携带 `ownerType + ownerId + topicId` 复合身份；CDS 不接受路径模糊匹配或跨 Owner 同名 Topic 降级。
- Desktop→Mobile 不新增附件二进制下载。合法 hash 仍随消息下发，Mobile 缺少 CAS 文件时保存为 `desktop_only` 占位。

## 测试

```text
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

当前自动测试覆盖：

- DeepMemo 旧查询语法。
- Agent/Group Owner 命名空间隔离。
- 分支 Topic 复用消息 ID。
- 群聊发言 Agent 身份保留。
- `Nova` 对 `vcp小助手Nova` 的唯一包含匹配。
- 多个包含候选的歧义拒绝。
- 移动消息指纹与旧 `content + attachment hashes` 合约一致。
- 中央同步聚合哈希顺序无关。
- VCPMobileSync 中央适配器 Manifest 字段兼容。
- wire 1.1 golden canonical output、hash 与 JavaScript safe-integer 边界。
- ingest → streaming pull → canonicalizer → native push 全链路。
- 损坏 history source fail closed、Owner/Topic 歧义拒绝及稳定消息 Tombstone 重放。

Node 静态检查：

```text
node --check rust_chat_data_service/build-runtime.js
node --check modules/services/chatDataService/client.js
node --check modules/services/chatDataService/lifecycle.js
node --check modules/services/chatDataService/index.js
node --check VCPDistributedServer/Plugin/VCPMobileSync/sync/central.js
npm run test:mobile-sync
```

Electron unpacked smoke 在设置 `VCP_UNPACKED_DIR=dist/<platform>-unpacked` 时，额外检查 `app.asar` 中的分布式服务入口、Plugin loader、VCPMobileSync canonicalizer，以及 `app.asar.unpacked` 中对应平台的 CDS runtime。

## 恢复

SQLite 无法通过快速检查时：

1. 原数据库被改名隔离。
2. 创建新数据库。
3. 从 Agent/Group 配置和 `history.json` 重建。

Tantivy 无法打开或目录被删除时：

1. SQLite 保持不变。
2. 损坏索引目录被改名隔离。
3. 从 SQLite 的所有有效 Topic 全量重建。
4. 重建后更新 `indexed_revision`。
