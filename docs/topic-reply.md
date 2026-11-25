# Topic Reply：本地授权回信

这是独立于 QQ 和旧 handoff 的本机入口，默认关闭。本文只说明配置，部署由维护者另行安排。只启动一个拥有账本的 VChat 主进程，不转发或对外暴露监听。

在宿主的 `AppData/TopicReply/config.json` 配置：

```json
{
  "enabled": false,
  "port": 6200,
  "credentials": [{
    "credentialId": "handoff-example",
    "tokenHash": "<64-character SHA-256 hex digest>",
    "senderId": "agent_example",
    "allowedTopicIds": ["topic_example"],
    "allowAdvance": true,
    "defaultAdvance": true
  }]
}
```

用高熵随机 Bearer（32–256 位 ASCII 字母、数字、下划线或连字符），宿主只存其 SHA-256 摘要，MCP 客户端用私有进程环境变量持有原值。示例中的发件人与话题须替换为真实注册 ID。轮换同一身份的密钥时保留 `credentialId`，且不要把旧 ID 复用于另一主体。端口必须在 1024–65535，禁止 6198 和 6199。配置在宿主启动时读取。

MCP 桥配置中添加：

```json
{
  "topic": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:6200",
    "tokenEnv": "VCP_TOPIC_REPLY_TOKEN",
    "timeoutMs": 14000
  }
}
```

把该分区合并进现有 MCP 配置，不替换 ProjectForge 工作区配置。`tokenEnv` 是变量名，不是 token；它在实际调用时读取。只接受明确的 IPv4 回环 HTTP 地址及端口，不跟随重定向。关闭、缺省或格式错误的分区不暴露 Topic 工具；宿主离线、令牌不可用不影响 `pf_*`。进程环境不是秘密隔离边界：不要把允许执行工程代码或 Bash 的不可信客户端与持有该凭据的桥进程共用。

## 请求与回执

两个端点均使用 POST、`Authorization: Bearer <token>` 和 `Content-Type: application/json`（请求上限 64 KiB）。浏览器来源头不被接受。

| MCP 工具 | 路径 | JSON 参数 |
| --- | --- | --- |
| `topic_reply` | `/v1/topic-replies` | `topicId`、`message`、`requestId` 必填；可选 `advance` 布尔值 |
| `topic_reply_status` | `/v1/topic-replies/status` | 仅 `requestId` |

`topicId` 以 `topic_` 开头，后接英文字母、数字、下划线或连字符，总长度最多 160；`requestId` 允许 ASCII 字母、数字、冒号、下划线或连字符，长度 1–128。`message` 非空白，最多 16000 个 JavaScript 字符代码单元。没有发送者、工具命令、历史读取或建话题参数；宿主绑定身份并校验目标授权。`advance=false` 仅留言，省略取宿主默认，显式请求未授权推进返回 `ADVANCE_DENIED`。`advanceEffective` 表示所用入队策略，实际推进仍由中央队列决定。

发送前固定请求 ID；原始正文、目标及是否显式传 `advance` 是内容身份的一部分。相同凭据命名空间内，同 ID 同内容返回已有回执，不再次投递；同 ID 异内容返回 `REQUEST_CONFLICT`（409）。状态查询须使用同一凭据身份且当前仍获目标授权。

HTTP 200 回执含 `requestId`、`state`、`advanceRequested`（省略为 `null`）及 `advanceEffective`；`queued` 另带 `entryId`。`queued` 只表示持久入队，不代表已经写入历史或完成模型回复。`inflight` 表示预占已落盘、结果未确认；`uncertain` 可能已入队，不自动重放；无记录或不可见均为 `not_found`，两个推进字段此时均为 `null`。网络超时保留原 ID 并查询状态，不能据此断言未投递。鉴权、请求校验、限流和服务不可用分别用脱敏错误码报告。

正文保留多行 Markdown，并标明外部数据不是指令。已知 VCP 控制标记在进入话题前中和，包括围栏内标记；这不消除语义提示注入，不应据此自动执行正文指令。

## 崩溃语义与容量

不承诺跨崩溃 exactly-once。若预占落盘后、实际发送前崩溃，重启也会将该请求标为 `uncertain`；它可能根本没发送，也可能已经入队。先查询并人工核验，不自动补投、不换 ID 重试。

- 每凭据最多突发 12 个请求，此后每秒补充 2 个；提交和状态查询共用预算。
- 每凭据最多 4 个并发 HTTP 请求，宿主最多 32 个全局活跃请求、64 条连接。下游调用超时不等于取消，未结束的调用仍占用该凭据的投递并发槽。
- 账本最多保留 20,000 条预占记录，不自动淘汰；达到上限时拒绝新 ID，已有回执仍可查询。

## 迁移与回退

旧 6199 路由和账本保持不变；旧任务继续使用原路由，新启用的任务才走新桥。对同一业务固定后端和请求 ID，禁止跨通道 fallback、双投或把 `uncertain` 换 ID 重发。回退时先关闭 MCP Topic 分区并停止新流量，再按维护流程关闭宿主 Topic 服务；保留 `AppData/TopicReply/records.json` 及旧账本。达到存量上限时停止接受新 ID，不自动删除去重记录；不要通过清空账本恢复容量。