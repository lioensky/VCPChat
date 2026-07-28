# DeepMemo VCP-CDS 迁移适配器

DeepMemo 2.0 已迁移为 `hybridservice/direct` 薄适配器。

## 运行形态

- Electron 主进程负责启动并持有 VCP-CDS Rust 常驻服务。
- VCPDistributedServer 与 Electron 位于同一 Node.js 主进程中，复用同一个 VCP-CDS facade。
- `DeepMemoService.js` 在插件发现阶段加载一次，常驻于 VCPDistributedServer 进程内。
- 每次 DeepMemo 工具调用执行一次内存函数调用和一次本地 VCP-CDS HTTP 请求；启用 Rerank 时还会并发调用配置的精排 API。
- DeepMemo 不再扫描 Agent、Topic 或 `history.json`。
- DeepMemo 不再创建临时 Tantivy/FlexSearch 索引。
- DeepMemo 不再初始化独立 Jieba 实例。
- 正常路径不再启动 `deepmemo_rust.exe`。

因此不需要额外创建一个独立 JS 子进程。JS 适配器依附于现有 VCPDistributedServer 常驻进程，数据服务和持久索引仍由 VCP-CDS 独占管理。

## 调用链

```text
聊天请求
  → vcpchatExtensions.requestContext
  → VCP 主服务器
  → execute_tool.data._vcpContext
  → VCPDistributedServer
  → DeepMemoService.processToolCall(toolArgs, trustedContext)
  → ChatDataServiceClient.searchMemories()
  → VCP-CDS /v1/search/memories
```

`toolArgs` 与可信执行上下文分开传递。模型在工具参数中伪造 `_vcpContext`、`agentId` 或 `owner.id` 时，不能覆盖传输层注入的 Agent 和 Topic。

## 兼容参数

仍支持旧参数：

```json
{
  "maid": "小克",
  "keyword": "深度回忆,系统设计",
  "window_size": 6,
  "rerank": true
}
```

`rerank` 是可选的三态调用参数：

- `rerank: true`：本次请求启用精排，但服务端仍必须配置有效的 `RerankUrl`。
- `rerank: false`：本次请求强制跳过精排。
- 省略 `rerank`：遵循环境变量 `RerankSearch`。

兼容别名：

- `key_word`
- `KeyWord`
- `windowsize`
- `windowSize`

有可信上下文时使用精确 `agentId`，否则把旧 `maid` 交给 VCP-CDS 名称解析器。名称有多个候选时由 VCP-CDS 返回歧义错误，不再静默选择第一个 Agent。

## 上下文上传

VCPChat 将白名单化的上下文放在请求体：

```json
{
  "vcpchatExtensions": {
    "schemaVersion": 1,
    "requestContext": {
      "requestId": "msg_xxx",
      "agentId": "agent-folder-uuid",
      "agentName": "小克",
      "topicId": "topic_123",
      "ownerType": "agent",
      "isGroupMessage": false
    }
  }
}
```

VCP 主服务器需要在下发 `execute_tool` 时将它复制到顶层内部字段 `_vcpContext`。该字段不能由模型工具参数生成。

## 配置

```dotenv
DeepMemoBackend=central
DeepMemoLegacyFallback=False
DeepMemoExcludeCurrentTopic=True
DeepMemoCandidateLimit=50
DeepMemoResultLimit=8
DeepMemoTimeoutMs=30000
MaxMemoTokens=60000
QueryPreset=

RerankSearch=False
RerankUrl=
RerankApi=
RerankModel=
RerankCandidateMultiplier=3
RerankMaxDocumentsPerBatch=25
RerankMaxTokensPerBatch=60000
RerankTimeoutMs=30000
```

- `DeepMemoBackend=central`：使用中央搜索，默认值。
- `DeepMemoBackend=legacy`：强制执行旧 EXE，仅用于回滚。
- `DeepMemoLegacyFallback=True`：中央搜索失败后尝试旧 EXE。
- `DeepMemoExcludeCurrentTopic=True`：有可信 Topic 上下文时排除当前 Topic。
- `MaxMemoTokens`：历史名称保留，实际表示最终输出最大字符数。
- `RerankSearch=True`：由常驻 DeepMemo JS 适配器调用 Rerank API，作为省略工具参数时的默认策略。
- 工具参数 `rerank=true|false`：覆盖本次调用的默认策略；显式 `false` 强制跳过，显式 `true` 请求启用。
- `RerankCandidateMultiplier=3`：向 VCP-CDS 请求最终数量三倍的候选窗口。
- `RerankMaxDocumentsPerBatch=25`：单批最多文档数，最大值也是 25。
- `RerankMaxTokensPerBatch=60000`：按 Unicode 字符一字符一 token 保守估算；最大允许 64000，默认预留到 60000。
- `RerankTimeoutMs=30000`：每个并发批次的请求超时。

Rerank 文档直接使用 VCP-CDS 已清理的 `contentText`，不传原始 HTML。所有候选只评分一次；各批次的 `relevance_score` 合并后执行全局排序，不使用旧版递归淘汰。任意批次失败、响应缺项或返回非法分数时，整次精排回退到 VCP-CDS/Tantivy 原排名，并继续遵守最终结果数量和字符预算。

旧 EXE 暂时保留在插件目录中，但默认配置不会启动它。

## 返回兼容

中央服务返回的 `formattedResult` 会直接作为工具结果返回：

```text
[回忆片段1]:
主人: ...
小克: ...
```

无命中时返回：

```text
[DeepMemo] 未找到与关键词“...”相关的回忆。
```

## 测试

在项目根目录运行：

```bash
node --test tests/deepmemo-central-adapter.test.js
```

测试不启动 Electron、VCP-CDS 或旧 EXE，而是注入模拟 CDS 客户端验证适配器边界。