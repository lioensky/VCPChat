# VCP Chat Data Service（VCP-CDS）

VCP-CDS 是 VCPChat 第一阶段的中央聊天数据旁路服务。

## 第一阶段边界

- `history.json` 仍是兼容真源。
- SQLite 是完整查询镜像。
- Tantivy 是可删除、可重建的搜索派生物。
- VCP-CDS 不接管现有聊天写入。
- VCPMobileSync 继续使用现有数据库和协议。
- DeepMemo 继续使用旧可执行文件；中央搜索仅作为内部能力就绪。
- VCP-CDS 启动或运行失败不得阻断现有聊天功能。

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
  "protocolVersion": 1,
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
MobileSyncUseCentralIndex=False
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
POST /v1/flush
POST /v1/shutdown
```

## 测试

```text
cargo test
```

当前自动测试覆盖：

- DeepMemo 旧查询语法。
- Agent/Group Owner 命名空间隔离。
- 分支 Topic 复用消息 ID。
- 群聊发言 Agent 身份保留。
- `Nova` 对 `vcp小助手Nova` 的唯一包含匹配。
- 多个包含候选的歧义拒绝。

Node 静态检查：

```text
node --check rust_chat_data_service/build-runtime.js
node --check modules/services/chatDataService/client.js
node --check modules/services/chatDataService/lifecycle.js
node --check modules/services/chatDataService/index.js
```

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