# TopicSponsor 完全指南
## AI主动创建话题 · 前端分布式插件 · v2.2.0

> **一句话定义**：TopicSponsor 是 VCP 生态中赋予 Agent "主动发起对话"能力的核心插件。它打破了传统 AI 只能被动回应的范式，让 Agent 能够像人类一样主动创建话题、管理对话、回复消息。

> **作者**：lionsky (VCPToolBox) · 文档整理：infinite-vector

---

## 目录

1. [插件概述](#1-插件概述)
2. [命名考古：VCP七大传说之一](#2-命名考古vcp七大传说之一)
3. [架构说明](#3-架构说明)
4. [完整命令参考](#4-完整命令参考)
5. [从当前话题派工](#5-从当前话题派工)
6. [回顾历史](#6-回顾历史)
8. [与其他插件的协同](#8-与其他插件的协同)
9. [开发者注意事项](#9-开发者注意事项)
10. [变更日志](#10-变更日志)

---

## 1. 插件概述

### 1.1 它是什么？

TopicSponsor 运行在 VCPChat 前端分布式插件服务器（VCPDistributedServer）上，当前 manifest 使用 hybridservice/direct，入口为 topicsponsor-service.js。创建和查询复用宿主 PluginAgentOperationService；ReplyToTopic 经中央消息入场服务排队，不直接覆盖历史。下文历史命名记录不代表当前运行入口。

### 1.2 解决什么问题？

在传统的 AI 聊天系统中，对话的发起权完全在用户手中——用户不说话，AI 就沉默。TopicSponsor 颠覆了这个范式：

- **Agent 主动找主人聊天**：早安问候、灵感分享、任务提醒
- **Agent 间协作对话**：一个 Agent 在另一个 Agent 的话题里留言
- **定时任务触发**：配合 timely_contact 实现"每天早上主动发消息"
- **梦境系统集成**：AgentDream 生成的梦境内容通过 TopicSponsor 投递到对话列表

### 1.3 在 VCP 生态中的定位

```
用户 <-> VCPChat 前端 <-> VCPDistributedServer
                              |-- TopicSponsor  <- 话题的创建与管理（读写）
                              |-- TopicMemo     <- 话题的只读查询
                              |-- PromptSponsor <- 提示词的动态修改
                              +-- ...其他分布式插件
```

TopicSponsor 和 TopicMemo 是一对互补插件：
- **TopicSponsor**：读写权限，能创建话题、回复消息、修改状态
- **TopicMemo**：只读权限，用于获取话题列表和内容

---

## 2. 命名考古：VCP七大传说之一

### 2.1 三个时代的化石

这个插件在其生命周期中经历了三次命名，形成了至今仍可观测的"地质断面"：

| 时代 | 名称 | 残留位置 |
|------|------|----------|
| **最古老** | `AgentTopicCreator` | 脚本日志前缀（已更新为双名兼容）|
| **中间态** | `TopicCreator` / `topicCreator` | 脚本文件名、元数据标记 |
| **最新（正式）** | `TopicSponsor` | plugin-manifest.json 注册名、前端工具箱 |

### 2.2 演化路径还原

**阶段一：AgentTopicCreator**
插件最初被创建时，叫做 AgentTopicCreator。脚本文件名 `topicCreator.js`、内部日志前缀 `[AgentTopicCreator]`、前端人类工具箱的配置键名——都来自这个时代。

**阶段二：TopicCreator（过渡期）**
某次重构中，部分引用被简化为 TopicCreator（去掉了 Agent 前缀）。话题元数据中的 `creatorSource: "plugin:TopicCreator"` 和 `_metadata.topicCreator` 字段保留了这个中间态的痕迹。

**阶段三：TopicSponsor（当前正式名）**
最终，plugin-manifest.json 的注册名被更新为 TopicSponsor——语义更准确（"Sponsor"=发起者/赞助者，比"Creator"更能表达"主动发起对话"的含义）。但脚本文件名、日志前缀、元数据字段均未同步更新。

### 2.3 为什么前端人类工具箱的按钮曾经无法工作？

VCPDistributedServer 的 Plugin.js 使用 `this.plugins.get(toolName)` 进行**严格匹配**——它只认 manifest 中注册的 `name` 字段。前端工具箱发出 `tool_name: AgentTopicCreator`，后端找不到这个名字（只有 TopicSponsor），于是返回 "plugin not found" 错误。

这个 bug 从插件改名为 TopicSponsor 的那一天起就存在了——直到 2026-05-19 被修复。

### 2.4 修复记录（2026-05-19 by infinite-vector）

| 改动 | 文件 | 内容 |
|------|------|------|
| D1 | config.js L811 | AgentTopicCreator(1命令) -> TopicSponsor(8命令) |
| D2 | renderer.js L38 | 分类列表 AgentTopicCreator -> TopicSponsor |
| D4 | topicCreator.js checkOwnership() | 读取端加 topicSponsor fallback |
| D5 | topicCreator.js 日志前缀x2 | [AgentTopicCreator] -> [TopicSponsor/AgentTopicCreator] |

---

## 3. 架构说明

### 3.1 插件类型与通信协议

- **插件类型**：hybridservice
- **通信协议**：direct
- **入口点**：`topicsponsor-service.js`，调用宿主 `PluginAgentOperationService`
- **超时时间**：15000ms；回复接受入队即返回，不等待目标生成。

### 3.2 目录结构

```
VCPChat/
|-- VCPDistributedServer/
|   +-- Plugin/
|       +-- TopicSponsor/           <- 插件目录（以注册名命名）
|           |-- plugin-manifest.json <- 插件清单（注册名: TopicSponsor）
|           |-- topicsponsor-service.js <- 当前 hybridservice/direct 入口
|           |-- config.env.example   <- 配置示例，默认仅留言
|           +-- README.md            <- 本文档
|-- AppData/
|   |-- Agents/
|   |   +-- _Agent_xxx/
|   |       |-- config.json          <- Agent配置（含topics列表）
|   |       +-- avatar.png
|   +-- UserData/
|       +-- _Agent_xxx/
|           +-- topics/
|               +-- topic_xxx/
|                   +-- history.json <- 话题聊天记录
```

### 3.3 数据流

```text
Agent → TopicSponsor direct service → PluginAgentOperationService
ReplyToTopic → 目标/注册身份验证 → 中央持久化暂挂队列 → 最新历史幂等追加
推进开启时 → 现有单聊或群聊引擎 → 终稿完整保存 → 释放占用
```
工具只等待接受，不等待生成；流结束或函数返回不代表终稿保存成功。

### 3.4 话题数据模型

每个话题在 Agent 的 config.json 中有一条记录：

```json
{
  "id": "topic_1716000000000",
  "name": "今天的好心情",
  "createdAt": 1716000000000,
  "unread": true,
  "creatorSource": "plugin:TopicCreator",
  "_creator": {
    "agentName": "Nova",
    "agentId": "_Agent_xxx",
    "timestamp": 1716000000000
  }
}
```

每条消息在 history.json 中的结构：

```json
{
  "role": "assistant",
  "name": "Nova",
  "content": "主人，我想和你聊聊...",
  "timestamp": 1716000000000,
  "id": "msg_1716000000000_assistant_abc1234",
  "isThinking": false,
  "avatarUrl": "file:///path/to/avatar.png",
  "avatarColor": "rgb(96,106,116)",
  "isGroupMessage": false,
  "agentId": "_Agent_xxx",
  "finishReason": "completed",
  "_metadata": {
    "topicCreator": "Nova",
    "creatorAgentId": "_Agent_xxx",
    "createdBy": "plugin",
    "createdAt": 1716000000000
  }
}
```

> **注意**：`_metadata.topicCreator` 是历史字段名。2026-05-19 修复后，读取端同时兼容 `topicSponsor` 和 `topicCreator` 两个字段名。

---

## 4. 完整命令参考

### 4.1 CreateTopic — 创建新话题

**功能**：让 Agent 创建一个新话题并主动发起对话。话题创建后立即显示在对话列表顶部，默认未读。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| maid | string | 是 | Agent 的中文名 |
| topic_name | string | 是 | 话题名称 |
| initial_message | string | 是 | Agent 想说的第一句话 |

**成功返回**：

```json
{
  "status": "success",
  "result": {
    "message": "成功创建了新的话题：今天的好心情",
    "topic_id": "topic_1716000000000",
    "topic_name": "今天的好心情",
    "agent_name": "Nova",
    "agent_id": "_Agent_xxx",
    "initial_message": "主人，我想和你聊聊..."
  }
}
```

**错误场景**：
- maid 名称不存在: `[TopicSponsor/AgentTopicCreator] 未找到名为 "xxx" 的Agent。`
- 缺少必需参数: `请求中缺少 'topic_name' 参数。`

---

### 4.2 CreateFlowlockTopic — 创建自主工作话题

**功能**：创建带持久化 `flowlockRequest` 的新话题。插件只负责创建话题和请求，不会在工具执行期间直接启动 Flowlock；当前 assistant 最终回复完整落盘后，前端才会原子认领请求并迁移该 Agent 的唯一 Session。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| maid | string | 是 | Agent 的显示名 |
| topic_name | string | 是 | 自主工作话题名称 |
| initial_message | string | 是 | 写入新话题的初始任务 |
| flowlock_heartbeat | integer | 否 | 第一跳延迟，范围 1–86400 秒，默认 5 |
| flowlock_prompt | string | 否 | 新话题第一跳使用的提示词 |

Topic 与运行时锁保持分离：

- `topic.locked` 仍为 `false`。
- `topic.unread` 为 `true`。
- `flowlockRequest.status` 初始为 `pending`。
- `requestId` 使用安全 UUID。
- Topic ID 使用时间戳加安全 UUID 后缀，避免同毫秒并发冲突。
- 创建该类话题时不修改 `current_topic_id`，避免工具循环尚未结束就切换当前话题。

**调用示例**：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」TopicSponsor「末」,
command:「始」CreateFlowlockTopic「末」,
maid:「始」Nova「末」,
topic_name:「始」自主测试工作区「末」,
initial_message:「始」请在这个话题中执行连续自检任务。[[Flowlock::Start]]「末」,
flowlock_heartbeat:「始」5「末」,
flowlock_prompt:「始」读取本话题的初始任务，开始第一轮自主执行。「末」
<<<[END_TOOL_REQUEST]>>>
```

**成功返回**：

```json
{
  "status": "success",
  "result": {
    "topic_id": "topic_1716000000000_uuid",
    "request_id": "安全 UUID",
    "flowlock_status": "pending",
    "heartbeat_seconds": 5
  }
}
```

---

### 4.3 发现与状态

- `ListAgents` / `ListGroups`：获取已注册收件人名称和 ID。
- `ListRecentTopics(query, target_type?)`：查目标最近五个话题地址，不读取正文。
- `CheckNewTopics(maid, days?)`：按创建时间检查近期话题；默认 3 天。
- `CheckUnreadMessages(maid)`：检查未读话题状态。
- `CheckTopicOwnership(topic_id, caller_name, maid?)`：核对创建者元数据，不是权限凭证。

### 4.4 ReplyToTopic — 已有话题留言与独立派工

两种模式都需要 `message` 和 `sender_id` 或 `sender_name`。`maid` / `valet` 仅作工具追踪署名。

- **已有话题**：省略 `mode`，传目的 `topic_id`；可选 `source_topic_id` 作为回信地址。普通留言默认不推进，由 `REPLY_ADVANCE_ENABLED` 控制；中央入场服务负责暂挂和推进。
- **独立派工**：传 `mode: new_topic`、当前单聊或群聊的 `source_topic_id`、`target_agent` 和任务正文，不传目的 `topic_id`。目标接受精确注册 ID、完整名称或名称包含，略过大小写；同层歧义不建题。可选 `topic_name`。系统为接收方建立独立话题，提交首轮，不替对方切换当前话题。
- **显式心流**：独立派工可选 `flowlock: true`。首轮成功落盘后才能认领；已有会话不被迁移。`flowlock_requested` 不代表启动。
- 派工回执返回新 `topic_id`；`accepted` 只说明曾受理。同一个宿主请求 ID 的重试返回既有凭据；一次新工具调用可能是一次新任务。

## 5. 从当前话题派工

例如在群聊或单聊派给「猫娘小克」，不必查询她的历史话题：

```yaml
tool_name: TopicSponsor
command: ReplyToTopic
mode: new_topic
source_topic_id: <当前话题 ID>
target_agent: 小克
sender_name: Kerr
message: 请核对这份测试报告，并将发现回报到来源话题。
```

小克完成后，用普通 `ReplyToTopic` 把来源 ID 填入 `topic_id`。普通模型回复不会自动回传。

## 6. 回顾历史

- `TopicMemo.ListTopics(maid)` 列出指定 Agent 或群组的话题。
- `TopicMemo.GetTopicContent(topic_id, maid?)` 按 ID 读取历史。只知道 ID 时省略 `maid`，自动查找归属。
- 旧手动话题锁已退役。旧版批量读和点读命令不会转成全历史扫描；读取请迁到 TopicMemo。
- Agent「单聊上下文楼层上限」仅影响模型请求，不影响历史落盘、显示和 TopicMemo。

## 8. 与其他插件的协同

### 8.2 TopicSponsor + AgentAssistant

AgentAssistant 用于 Agent 间的即时通讯（同步/异步），TopicSponsor 用于创建持久化的话题对话。两者互补：

- **短消息/即时问答** -> AgentAssistant
- **需要主人看到的持久化对话** -> TopicSponsor

### 8.3 TopicSponsor + DailyNote

创建话题后，可以将重要的话题内容通过 DailyNote 保存到日记中，形成长期记忆。话题是即时的对话载体，日记是永久的记忆载体——两者配合实现"对话 -> 沉淀 -> 回忆"的完整闭环。

### 8.4 TopicSponsor + PromptSponsor

PromptSponsor 可以配合修改 Agent 的提示词，实现基于话题上下文的个性化回复。例如：在特定话题中注入额外的系统指令。

### 8.5 TopicSponsor + timely_contact

timely_contact 是 VCP 的定时任务语法。配合 TopicSponsor 可以实现：
- 每天早上8点自动创建"早安"话题
- 重要日期前自动创建提醒话题
- 周期性检查未读消息

---

## 9. 开发者注意事项

### 9.1 文件名与注册名不一致的历史原因

| 层面 | 当前值 | 说明 |
|------|--------|------|
| 插件目录名 | `TopicSponsor/` | 最新命名 |
| manifest 注册名 | `TopicSponsor` | 最新命名，路由匹配用这个 |
| 当前入口 | `topicsponsor-service.js` | manifest 实际 direct 服务入口；历史脚本不是当前入口 |
| 日志前缀 | `[TopicSponsor/AgentTopicCreator]` | 双名兼容 |
| 元数据字段 | `_metadata.topicCreator` | 历史字段名，读取端已加 fallback |
| 元数据标记 | `creatorSource: "plugin:TopicCreator"` | 历史标记 |

**为什么不全部统一？** 因为：
1. 改文件名需要连锁修改 manifest 的 entryPoint
2. 已创建话题的 history.json 中存储了旧字段名
3. 其他用户的提示词中可能引用了旧名字
4. 改动过多会增加合并冲突风险

**原则**：对外接口（注册名、前端工具箱）使用新名字，内部实现保留历史名字 + 兼容层。

### 9.2 Agent 查找机制

当前宿主由 PluginAgentOperationService 解析发送者注册身份，支持名称简称与大小写无关包含匹配；回复目标仅按 topic_id 跨单聊、群聊解析。旧 findAgentInfo/includes 仅属于历史实现。

### 9.3 并发安全

当前回复走中央暂挂队列和 HistoryMutationQueue 最新历史幂等追加。生成与等待在中央串行提交锁外，逐成员终稿落盘后让暂挂消息入场。HistoryMutationQueue 不是跨进程文件锁；旧整表 replace、删除竞态和其他生成旁路仍需专项审计，不能从组件测试通过推导整套无竞态。

### 9.4 备份机制

`config.topic.backup.json` 属于旧 stdio 实现，当前 direct 宿主创建路径不承诺生成此备份。不要把历史备份说明当作当前恢复保障。

### 9.5 退役入口与配置

`topicsponsor.js` 仅为失败关闭的退役入口，执行或 require 均拒绝，不再读取或修改 AppData。
旧实现封存于 `docs/archive/topicsponsor-legacy.js.txt`，仅供考古，不得恢复为运行入口。
实际入口始终以 manifest 的 `topicsponsor-service.js` 为准。

将本插件目录的 `config.env.example` 复制为 `config.env`，按需设置并重新加载插件服务：
`REPLY_ADVANCE_ENABLED=false` 默认只留言；只有 true（不区分大小写）开启回复推进，1 不表示开启。
`REPLY_INVITE_PROMPT` 留空使用前端默认邀请，只影响单聊请求，不影响群聊选人或创建话题。
配置在插件初始化时冻结，不接受模型调用参数覆盖。此施工未修改真实配置或部署运行区。

---

## 10. 变更日志

### v2.2.0

- 新增 `CreateFlowlockTopic`。
- 持久化 `flowlockRequest`，支持 pending、consumed、rejected 状态。
- 请求身份和 Topic 并发消歧使用安全 UUID。
- Flowlock 请求不在工具执行期间启动，遵守最终消息完整落盘边界。
- 普通 `CreateTopic` 保持原行为；Flowlock 话题创建时不抢占 `current_topic_id`。
- 已通过单元测试与完整工作流测试。

### 2026-05-19 (by infinite-vector)

**修复：前端人类工具箱按钮无法工作（VCP七大传说之一）**

- **根因**：前端 config.js 使用 `AgentTopicCreator` 作为键名，后端 manifest 注册名为 `TopicSponsor`，Plugin.js 严格匹配导致 "plugin not found"
- **修复内容**：
  - config.js L811: `AgentTopicCreator`(1命令) -> `TopicSponsor`(完整8命令)
  - renderer.js L38: 分类列表 `AgentTopicCreator` -> `TopicSponsor`
  - topicCreator.js checkTopicOwnership(): 读取端加 `topicSponsor || topicCreator` fallback
  - topicCreator.js 日志前缀x2: `[AgentTopicCreator]` -> `[TopicSponsor/AgentTopicCreator]`
- **不变内容**（保留历史地层）：
  - 文件名 `topicCreator.js`
  - 元数据 `creatorSource: "plugin:TopicCreator"`
  - 写入端 `_metadata.topicCreator`

### v2.1.0 (by lionsky)

- 完整的8命令系统
- 话题所有权验证
- 未读消息检查
- 话题内容读取

### v1.0.0 (by lionsky)

- 初始版本：CreateTopic 命令
- 原名 AgentTopicCreator

---

*本文档由 infinite-vector 于 2026-05-19 编写。*
*如有问题，请在 VCP 社区论坛讨论。*

### 轻量地址发现（ListAgents / ListGroups / ListRecentTopics）
- `ListAgents`：无目标参数，返回 `agents[{id,name,type}]` 和 `total`。
- `ListGroups`：无目标参数，返回 `groups[{id,name,type}]` 和 `total`。
- `ListRecentTopics`：必需 `query`（Agent/群的 ID 或名称），可选 `target_type=agent|group` 消歧。完整 ID 优先、完整名称其次，否则名称忽略大小写 includes；如“小克”匹配“猫娘小克”。多候选明确返回名称、类型、ID。
- 返回 `owner{id,name,type}`、`topics[{topic_id,title,created_at}]`、`total`，按创建时间倒序最多 5 条，不过滤锁定/已读。空话题列表正常返回空数组。
- 仅读取配置中的身份与话题元数据，不读取聊天正文、模型密钥或系统提示词。深入检索交给 TopicMemo。
- 使用路径：ListAgents/ListGroups 找伙伴 → ListRecentTopics(query) 找话题 → ReplyToTopic(topic_id, sender_name, message) 投递。