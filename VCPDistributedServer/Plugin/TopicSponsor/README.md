# TopicSponsor 完全指南
## AI主动创建话题 · 前端分布式插件 · v2.1.0

> **一句话定义**：TopicSponsor 是 VCP 生态中赋予 Agent "主动发起对话"能力的核心插件。它打破了传统 AI 只能被动回应的范式，让 Agent 能够像人类一样主动创建话题、管理对话、回复消息。

> **作者**：lionsky (VCPToolBox) · 文档整理：infinite-vector

---

## 目录

1. [插件概述](#1-插件概述)
2. [命名考古：VCP七大传说之一](#2-命名考古vcp七大传说之一)
3. [架构说明](#3-架构说明)
4. [完整命令参考（8个命令）](#4-完整命令参考)
5. [使用场景分类](#5-使用场景分类)
6. [完整调用示例](#6-完整调用示例)
7. [踩坑指南](#7-踩坑指南)
8. [与其他插件的协同](#8-与其他插件的协同)
9. [开发者注意事项](#9-开发者注意事项)
10. [变更日志](#10-变更日志)

---

## 1. 插件概述

### 1.1 它是什么？

TopicSponsor 是一个运行在 VCPChat 前端分布式插件服务器（VCPDistributedServer）上的同步插件。它直接操作 VCPChat 的 AppData 目录结构——读写 Agent 的 config.json 和话题的 history.json——来实现话题的创建、查询和管理。

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

- **插件类型**：synchronous（同步）
- **通信协议**：stdio（标准输入/输出）
- **入口点**：`node topicCreator.js`（注意：文件名保留历史命名，不影响功能）
- **超时时间**：15000ms（15秒）

### 3.2 目录结构

```
VCPChat/
|-- VCPDistributedServer/
|   +-- Plugin/
|       +-- TopicSponsor/           <- 插件目录（以注册名命名）
|           |-- plugin-manifest.json <- 插件清单（注册名: TopicSponsor）
|           |-- topicCreator.js      <- 执行脚本（历史文件名）
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

```
Agent调用 TopicSponsor
  -> VCPDistributedServer 匹配 manifest name="TopicSponsor"
  -> 启动 node topicCreator.js
  -> 通过 stdin 接收 JSON 参数
  -> 读写 AppData/Agents/config.json 和 UserData/topics/history.json
  -> 通过 stdout 返回 JSON 结果
```

### 3.4 话题数据模型

每个话题在 Agent 的 config.json 中有一条记录：

```json
{
  "id": "topic_1716000000000",
  "name": "今天的好心情",
  "createdAt": 1716000000000,
  "locked": false,
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

**功能**：让 Agent 创建一个新话题并主动发起对话。话题创建后立即显示在对话列表顶部，默认未锁定、未读状态。

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

### 4.2 ReadUnlockedTopics — 读取未锁定话题

**功能**：读取指定 Agent 所有未锁定的话题及其完整消息历史。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| maid | string | 是 | Agent 的中文名 |
| include_read | boolean | 否 | 默认 false，只返回未读话题；设为 true 则包含已读 |

**典型用途**：Agent 检查是否有主人的新回复需要处理。

---

### 4.3 CheckNewTopics — 检查新增话题

**功能**：查询指定 Agent 最近 N 天是否有新增的未锁定话题。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| maid | string | 是 | Agent 的中文名 |
| days | integer | 否 | 默认 3 天 |

**典型用途**：定时任务中检查"最近有没有新话题需要关注"。

---

### 4.4 CheckUnreadMessages — 检查未读消息

**功能**：查询指定 Agent 是否有被标记为未读的话题。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| maid | string | 是 | Agent 的中文名 |

**典型用途**：Agent 上线时的第一件事——检查有没有未读消息。

---

### 4.5 ReplyToTopic — 回复话题

**功能**：在指定 Agent 的话题中添加回复消息。只能回复未锁定或标记为未读的话题。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| maid | string | 是 | 目标 Agent 的中文名 |
| topic_id | string | 是 | 话题 ID（如 topic_1716000000000） |
| message | string | 是 | 回复内容 |
| sender_name | string | 是 | 发送者名称 |

**重要限制**：如果话题已锁定（locked: true）且未标记为未读（unread: false），则无法回复。

---

### 4.6 CheckTopicOwnership — 验证话题所有权

**功能**：检查话题是否为指定调用者创建的，用于多 Agent 协作场景下的权限控制。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| maid | string | 是 | 目标 Agent 的中文名 |
| topic_id | string | 是 | 话题 ID |
| caller_name | string | 是 | 调用者名称 |

**向后兼容**：读取端同时检查 `_metadata.topicSponsor` 和 `_metadata.topicCreator`（2026-05-19 修复）。

---

### 4.7 ListUnlockedTopics — 列出未锁定话题

**功能**：列出指定 Agent 所有处于 unlocked 状态的话题的基本信息（不含完整消息历史）。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| maid | string | 是 | Agent 的中文名 |

**与 ReadUnlockedTopics 的区别**：ListUnlockedTopics 只返回话题元数据（ID、名称、消息数），不返回完整消息历史——更轻量，适合概览。

---

### 4.8 ReadTopicContent — 读取话题完整内容

**功能**：读取指定话题 ID 的完整会话内容，包括所有消息历史。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| maid | string | 是 | Agent 的中文名 |
| topic_id | string | 是 | 话题 ID |

**典型用途**：在 ListUnlockedTopics 获取话题列表后，选择感兴趣的话题深入阅读。

---

## 5. 使用场景分类

### 5.1 场景一：Agent 主动找主人聊天

这是 TopicSponsor 最核心的使用场景——赋予 Agent 主动性。

**流程**：
1. Agent 通过 timely_contact 或自主判断，决定要找主人聊天
2. 调用 CreateTopic 创建新话题
3. 话题出现在主人的对话列表顶部，带未读标记
4. 主人点击进入话题，看到 Agent 的第一句话
5. 正常对话开始

### 5.2 场景二：Agent 间协作对话

**流程**：
1. Agent A 调用 CreateTopic 在自己名下创建话题
2. Agent B 通过 AgentAssistant 得知话题 ID
3. Agent B 通过 ReplyToTopic 在 Agent A 的话题里留言
4. Agent A 通过 CheckUnreadMessages 发现新消息
5. Agent A 通过 ReadTopicContent 读取完整对话

### 5.3 场景三：定时任务与日程提醒

**流程**：
1. 通过 timely_contact 设置定时触发
2. 到时间后 Agent 自动调用 CreateTopic
3. 主人收到提醒话题

**示例**：每天早上8点发早安、考试前一天发提醒、生日祝福

### 5.4 场景四：梦境系统集成

**流程**：
1. AgentDream 生成梦境内容
2. 通过 TopicSponsor 创建"梦境分享"话题
3. 主人醒来后看到 Agent 分享的梦

### 5.5 场景五：话题管理与清理

**流程**：
1. ListUnlockedTopics 查看所有未锁定话题
2. CheckTopicOwnership 确认哪些是自己创建的
3. 配合前端操作进行话题锁定/归档

---

## 6. 完整调用示例

> **注意**：以下示例使用简化的伪代码格式展示参数。实际调用时请使用完整的 VCP 工具调用语法（tool_name + command + 各参数字段）。

### 6.1 创建新话题

```
tool_name: TopicSponsor
command: CreateTopic
maid: Nova
topic_name: 关于今天的代码审计
initial_message: 主人，我今天发现了一个有趣的命名漂移问题，想和你聊聊。
```

### 6.2 检查未读消息并读取

```
# 第一步：检查未读
tool_name: TopicSponsor
command: CheckUnreadMessages
maid: Nova

# 第二步：如果有未读，读取内容
tool_name: TopicSponsor
command: ReadTopicContent
maid: Nova
topic_id: topic_1716000000000
```

### 6.3 在其他 Agent 的话题中回复

```
tool_name: TopicSponsor
command: ReplyToTopic
maid: Nova
topic_id: topic_1716000000000
message: 关于你提到的那个架构问题，我有一些想法...
sender_name: AgentB
```

### 6.4 定时任务：每天早安

```
# 配合 timely_contact 使用
tool_name: TopicSponsor
command: CreateTopic
maid: Nova
topic_name: 早安 2026-05-19
initial_message: 主人，早上好。今天多云转小雨，记得带伞。
timely_contact: 2026-05-20-08:00
```

### 6.5 话题概览 + 深入阅读

```
# 第一步：列出所有未锁定话题（轻量）
tool_name: TopicSponsor
command: ListUnlockedTopics
maid: Nova

# 第二步：选择感兴趣的话题深入阅读
tool_name: TopicSponsor
command: ReadTopicContent
maid: Nova
topic_id: topic_1716000000000
```

### 6.6 验证话题所有权

```
tool_name: TopicSponsor
command: CheckTopicOwnership
maid: Nova
topic_id: topic_1716000000000
caller_name: Nova
```

---

## 7. 踩坑指南

### 7.1 命名不一致（已修复）

**问题**：前端人类工具箱使用 `AgentTopicCreator`，后端注册名是 `TopicSponsor`，导致工具箱按钮无法工作。

**修复**：2026-05-19，前端工具箱已更新为 `TopicSponsor`。

**如果你仍在使用旧版**：直接在聊天中写 `tool_name: TopicSponsor` 即可，不需要经过前端工具箱 UI。

### 7.2 maid 参数必须使用中文名

插件通过遍历 `AppData/Agents/` 目录下的 config.json，用 `config.name.includes(maidName)` 进行模糊匹配。所以：

- 正确: `maid: Nova`（中文名/显示名）
- 错误: `maid: _Agent_1771589477517`（Agent UUID，不能匹配）

请确保使用 Agent 的 config.json 中 `name` 字段包含的名称。

### 7.3 话题锁定状态矩阵

| locked | unread | 可读 | 可回复 | 说明 |
|--------|--------|------|--------|------|
| false | true | 是 | 是 | 正常未读状态 |
| false | false | 是 | 是 | 已读状态 |
| true | true | 是 | 是 | 锁定但有新消息 |
| true | false | 是 | **否** | **只读，不能回复** |

### 7.4 topic_id 格式

话题 ID 格式为 `topic_` + 13位时间戳，如 `topic_1716000000000`。**不要手动拼造**——通过 ListUnlockedTopics 或 CheckNewTopics 获取。

### 7.5 话题创建后会切换当前话题

CreateTopic 会将新话题设为 Agent 的 `current_topic_id`。这意味着如果用户正在和 Agent 聊天，当前话题会被切换到新创建的话题。在设计自动化流程时需要注意这一点。

### 7.6 日志前缀的历史说明

如果你在日志中看到 `[TopicSponsor/AgentTopicCreator]`，这是正常的——双名前缀是为了兼容历史命名，方便开发者在搜索日志时无论用哪个名字都能找到。

如果你看到的是纯 `[AgentTopicCreator]`（没有 TopicSponsor 前缀），说明你运行的是 2026-05-19 修复之前的版本。

---

## 8. 与其他插件的协同

### 8.1 TopicSponsor + TopicMemo

| 功能 | TopicSponsor | TopicMemo |
|------|-------------|-----------|
| 创建话题 | 是 | 否 |
| 回复话题 | 是 | 否 |
| 读取话题列表 | 是 (ListUnlockedTopics) | 是 (ListTopics) |
| 读取话题内容 | 是 (ReadTopicContent) | 是 |
| 修改话题状态 | 是 | 否 |

**最佳实践**：只读操作用 TopicMemo（更轻量），需要写入时用 TopicSponsor。

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
| 脚本文件名 | `topicCreator.js` | 历史命名，manifest entryPoint 引用它 |
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

`findAgentInfo()` 函数通过遍历 `AppData/Agents/` 目录，读取每个 Agent 的 config.json，用 `config.name.includes(maidName)` 进行模糊匹配。这意味着：

- 如果两个 Agent 的 name 字段有包含关系（如"Nova"和"Nova2"），搜索"Nova"可能匹配到错误的 Agent
- 建议使用完整的、唯一的 Agent 中文名

### 9.3 并发安全

TopicSponsor 直接读写 config.json 和 history.json，没有文件锁机制。如果两个 Agent 同时操作同一个 config.json，可能出现竞态条件。在高并发场景下需要注意。

### 9.4 备份机制

CreateTopic 在修改 config.json 之前会自动创建 `config.topic.backup.json` 备份。如果操作失败，可以从备份恢复。

---

## 10. 变更日志

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