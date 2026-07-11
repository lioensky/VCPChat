# Flowlock（心流锁）

## 1. 概述

Flowlock 是 VCPChat 的 Agent 自主循环模块。

它的核心规则是：

> 当前回复完整结束并落盘后，才解析控制协议并安排下一次心跳。

Flowlock 不把自主循环绑定在工具调用循环中。工具请求可以在一轮回复内正常执行，只有最终 assistant 消息完成后，Flowlock 状态机才会迁移。这使消息、工具和自主心跳之间具有清晰的状态边界。

当前版本已经完成多 Agent、后台续写、消息级控制协议和状态气泡的全量重构。

---

## 2. 当前能力

### 2.1 每个 Agent 一个活动 Session

运行状态使用以下逻辑模型：

```text
agentId -> FlowlockSession
```

约束如下：

- 同一个 Agent 同时最多存在一个活动 Session。
- 一个 Session 只绑定该 Agent 的一个 Topic。
- 不同 Agent 可以同时持有各自的 Session。
- 用户切换到其他 Agent 或 Topic，不会停止后台 Session。
- 重新进入已锁定 Agent 时，界面优先恢复其锁定 Topic。
- 同一 Agent 再次启动时，旧 Session 会先失效，再建立新 Session。

这里的“一个 Agent 一个 Session”是 Flowlock 的运行时约束，不等同于 Topic 数据中的 `locked` 字段。

### 2.2 回复结束后触发

正常心跳链路：

```text
AI 最终回复完成
  -> streamManager 完整落盘
  -> 返回最终原文和可信 context
  -> Flowlock 解析控制协议
  -> 更新 Session
  -> 安排下一次心跳
  -> 到时执行指定 Agent / Topic 的后台续写
```

Flowlock 不会因为流式输出中暂时出现半截标记而执行命令。

### 2.3 后台续写

心跳续写不依赖当前界面正在显示哪个 Agent 或 Topic。

每次心跳会：

1. 使用 Session 保存的 `agentId` 和 `topicId`。
2. 从文件系统重新读取目标 Topic 历史。
3. 获取目标 Agent 配置。
4. 构造该 Topic 的 VCP 上下文。
5. 创建并初始化新的 assistant 流式消息。
6. 将结果写回正确的 Topic。
7. 在回复结束后重新进入统一完成入口。

因此，用户可以在某个 Agent 运行 Flowlock 时浏览其他会话。

### 2.4 自定义下一跳

Agent 可以在最终回复中指定：

- 是否进入或退出 Flowlock。
- 下一次心跳的延迟。
- 下一轮使用的临时提示词。
- 任务完成或失败状态。

`NextPrompt` 和 `NextHeartbeat` 都是一次性设置：触发下一轮时会被消费，后续轮次恢复 Session 默认值，除非 Agent 再次设置。

### 2.5 可视状态

当前 UI 包含：

- Agent 侧栏头像的活动状态环。
- 心跳触发时的脉冲动画。
- 消息中的 Flowlock 控制气泡。
- Start、Stop、Complete、Fail、NextHeartbeat 和 NextPrompt 的独立状态展示。

控制气泡只负责展示，真正的状态迁移只发生在最终消息完成入口。

---

## 3. 模块结构

```text
Flowlockmodules/
├── flowlock-protocol.js      # 安全解析控制协议并生成渲染气泡
├── flowlock.js               # 多 Agent Session 状态机
├── flowlock-integration.js   # 初始化、交互和后台续写集成
├── flowlock.css              # 状态环、心跳和控制气泡样式
└── README.md                 # 本文档
```

相关外部模块：

```text
modules/renderer/streamManager.js
  负责流式消息累积、最终落盘和返回完整消息结果

modules/messageRenderer.js
  将 Flowlock 渲染转换接入完整内容管线

modules/renderer/contentPipeline.js
  在工具结果、工具请求和代码块受保护时转换 Flowlock 控制块

renderer.js
  接收流结束事件，并将最终消息交给 Flowlock 状态机

modules/chatManager.js
  管理 Topic 切换限制和锁定 Topic 恢复
```

---

## 4. 内嵌控制协议

控制命令必须出现在 assistant 的最终回复中。

### 4.1 Start

启动当前回复所属 Agent 和 Topic 的 Flowlock：

```text
[[Flowlock::Start]]
```

示例：

```text
我将进入自主执行状态。

[[Flowlock::Start]]
```

### 4.2 Stop

主动停止当前 Agent 的 Flowlock：

```text
[[Flowlock::Stop]]
```

### 4.3 Complete

声明持续任务已经完成，并停止 Flowlock：

```text
[[Flowlock::Complete]]
```

### 4.4 Fail

无原因失败：

```text
[[Flowlock::Fail]]
```

带原因失败：

```text
[[Flowlock::Fail]]
无法取得继续任务所需的数据。
[[/Flowlock::Fail]]
```

失败命令会停止 Session，并保存失败原因。

### 4.5 NextHeartbeat

设置下一次心跳延迟，单位为秒：

```text
[[Flowlock::NextHeartbeat::5]]
```

延迟会被限制在安全范围内。当前默认范围为 1 至 86400 秒。

### 4.6 NextPrompt

设置下一轮临时提示词。

跨行格式：

```text
[[Flowlock::NextPrompt]]
请检查上一轮结果，继续执行下一阶段。
[[/Flowlock::NextPrompt]]
```

同行格式：

```text
[[Flowlock::NextPrompt]]请检查上一轮结果，继续执行下一阶段。[[/Flowlock::NextPrompt]]
```

两种格式均受支持。

### 4.7 组合示例

```text
第一阶段已经完成，下一跳将进行结果自检。

[[Flowlock::Start]]
[[Flowlock::NextHeartbeat::5]]
[[Flowlock::NextPrompt]]确认自己处于 Flowlock 心跳中，检查第一阶段结果；若测试通过，输出简短状态并主动 Stop。[[/Flowlock::NextPrompt]]
```

下一轮可以输出：

```text
第二跳自检通过，当前处于 Flowlock 心跳续写中。

[[Flowlock::Stop]]
```

---

## 5. 命令优先级与语义

同一条最终消息中出现多个命令时，终止命令优先级为：

```text
Fail > Complete > Stop
```

行为规则：

- 存在任意终止命令时，不会因同一消息中的 Start 再次启动。
- 多个 NextHeartbeat 以最后一个有效值为准。
- 多个 NextPrompt 以最后一个有效块为准。
- Start 在没有终止命令时请求进入或维持活动 Session。
- 普通活动 Session 的回复即使没有再次输出 Start，也会按默认延迟继续下一轮。
- Stop、Complete 和 Fail 会取消待执行定时器，并增加 Session generation，使旧回调无法复活。

---

## 6. 安全解析与渲染

### 6.1 仅解析可信区域

协议解析器在扫描前会屏蔽以下区域：

- VCP 工具请求。
- VCP 工具结果。
- 工具调用摘要。
- Desktop Push。
- VCP 元思考链。
- `<think>` 和 `<thinking>` 块。
- Markdown 代码围栏。
- 行内代码。

因此，代码示例或工具结果中的 Flowlock 字样不会被误执行。

### 6.2 历史渲染不执行命令

消息渲染会将控制协议转换为状态气泡，但不会启动或停止 Session。

这是重要的幂等约束：

```text
渲染历史消息 != 重放控制命令
```

否则每次打开历史记录都可能重新入锁、出锁或安排心跳。

### 6.3 原始消息与显示内容分离

Flowlock 状态机解析完整落盘的原始 assistant 文本。

前端正则、Markdown 转换和状态气泡只影响显示，不应成为运行状态的数据源。

---

## 7. Session 生命周期

Session 主要保存：

```text
agentId
topicId
status
generation
activeMessageId
pendingTimer
round
retryCount
defaultDelaySeconds
nextDelaySeconds
defaultPrompt
nextPrompt
startedAt
lastTriggeredAt
lastCompletedAt
nextHeartbeatAt
lastError
completionReason
```

### 7.1 启动

启动时：

1. 校验 Agent 和 Topic。
2. 停止该 Agent 的旧 Session。
3. 创建新 Session。
4. 更新侧栏状态。
5. 根据参数决定是否立即安排第一轮。

### 7.2 触发

心跳到达时：

1. 校验 Session 仍处于 active。
2. 校验 generation 未变化。
3. 生成本轮唯一消息 ID。
4. 设置 `activeMessageId`。
5. 消费一次性的 NextPrompt 和 NextHeartbeat。
6. 按绑定的 Agent 和 Topic 执行续写。

### 7.3 完成

回复完成后：

1. 使用消息 context 定位 Agent 和 Topic。
2. 校验消息属于当前 Session。
3. 清除 `activeMessageId`。
4. 解析最终原文。
5. 处理终止、心跳和提示词命令。
6. 若未终止，则安排下一轮。

### 7.4 错误重试

默认最多重试三次：

```text
续写失败
  -> retryCount + 1
  -> 未达到上限：按默认延迟重试
  -> 达到上限：停止 Session
```

---

## 8. 用户操作

### 8.1 右键聊天标题

右键顶部聊天标题：

- 未锁定：启动当前 Agent / Topic，但不立即续写。
- 已锁定：停止当前 Agent 的 Session。

### 8.2 中键聊天标题

中键顶部聊天标题：

- 未锁定：启动并立即安排第一次续写。
- 已锁定：停止当前 Agent 的 Session。

### 8.3 快捷键

Windows/Linux：

```text
Ctrl + G
```

macOS：

```text
Command + G
```

用于启动并立即续写，或停止当前 Agent 的 Session。

### 8.4 Topic 切换

当前 Agent 存在活动 Session 时：

- 不能切换到该 Agent 的其他 Topic。
- 不能为该 Agent 新建 Topic。
- 不能创建并切换到分支 Topic。
- 可以切换到其他 Agent。
- 再次进入该 Agent 时优先加载 Session 绑定的 Topic。

---

## 9. 插件兼容入口

VCP 插件仍可通过前端 Flowlock 命令通道执行：

```text
start
stop
promptee
prompter
clear
remove
edit
get
status
```

这些是兼容接口。当前自主循环的运行状态真源始终是前端 `FlowlockManager` 的 Session Map。

内嵌协议适合 Agent 在最终回复中声明下一步状态；插件命令适合外部系统或人工工具直接控制。

---

## 10. 二期设计：TopicSponsor 创建带 Flowlock 请求的话题

### 10.1 目标场景

Agent 在当前对话中调用 TopicSponsor，创建一个新的自主工作话题，并在当前回复结束后把自己的唯一 Flowlock Session 交接到新话题。

典型场景：

```text
Agent 在当前话题发现需要长期执行的新任务
  -> 调用 TopicSponsor 创建带 Flowlock 请求的新话题
  -> 新话题写入初始任务
  -> 当前回复继续完成工具循环
  -> 当前最终回复结束
  -> 前端原子认领新话题的 Flowlock 请求
  -> Agent 的唯一 Session 迁移到新话题
  -> 按指定心跳开始第一轮自主执行
```

### 10.2 为什么不让 AI 回显 Topic ID

不采用以下协议：

```text
[[Flowlock::StartTopic::topic_时间戳]]
```

原因：

- Topic ID 的真实来源是插件文件操作，不应由模型文本充当真相。
- 基于时间戳的 ID 可能在并发创建时发生冲突或歧义。
- 模型可能复制错误、截断或伪造 ID。
- 工具结果与最终回复之间存在时序和并发窗口。
- Flowlock 应消费可信结构化状态，而不是解析模型回显的资源标识。

### 10.3 新命令建议

建议 TopicSponsor 二期新增独立命令：

```text
CreateFlowlockTopic
```

而不是给普通 CreateTopic 增加一个容易误触发的布尔开关。

建议调用格式：

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

### 10.4 持久化请求模型

TopicSponsor 在插件内部生成真实 Topic ID，并写入结构化请求：

```json
{
  "id": "topic_internal_id",
  "name": "自主测试工作区",
  "locked": false,
  "unread": true,
  "flowlockRequest": {
    "requestId": "不可预测的 UUID",
    "requestedByAgentId": "_Agent_xxx",
    "createdAt": 0,
    "heartbeatSeconds": 5,
    "prompt": "读取本话题的初始任务，开始第一轮自主执行。",
    "status": "pending"
  }
}
```

要求：

- `requestId` 使用安全 UUID，不使用 Topic 时间戳充当请求身份。
- `requestedByAgentId` 必须与 Topic 所属 Agent 一致。
- `status` 至少支持 `pending`、`consumed`、`rejected`。
- 初始消息可以包含 Start 标记用于可视审计。
- 历史消息中的 Start 不负责真正启动 Session。

### 10.5 不复用 Topic 的 locked 字段

TopicSponsor 当前的 `locked` 是持久化 Topic 可操作性属性。

Flowlock 是前端运行时自主循环锁。

二者必须分离：

```text
topic.locked       -> Topic 的读写/归档语义
flowlockRequest    -> 请求建立运行时 Session
FlowlockSession    -> 已生效的前端自主循环状态
```

创建“带 Flowlock 请求的话题”时，Topic 仍可保持：

```json
{
  "locked": false,
  "unread": true
}
```

### 10.6 原子认领

建议由主进程提供原子接口：

```text
claimPendingFlowlockTopic(agentId, constraints)
```

接口负责：

1. 读取 Agent 配置。
2. 查找符合约束的 pending 请求。
3. 验证 Topic 存在且属于该 Agent。
4. 验证请求未被消费。
5. 多个候选时拒绝自动选择。
6. 原子地将请求改为 consumed。
7. 返回可信的 Topic ID、心跳和提示词。

前端不应直接扫描文件后自行选择“最新 Topic”。

### 10.7 一个 Agent 一个 Topic Session

认领成功后，由 FlowlockManager 执行原子交接：

```text
没有旧 Session
  -> 创建绑定新 Topic 的 Session

已有相同 Topic Session
  -> 保持 Session，更新下一跳设置

已有不同 Topic Session 且当前空闲
  -> 取消旧定时器
  -> generation + 1
  -> 交接到新 Topic
  -> 安排首次心跳

已有不同 Topic Session 且正在生成
  -> 不并行创建第二个 Session
  -> 记录待交接请求，或拒绝并保留旧 Session
```

二期默认建议：

- Session 空闲时允许交接。
- Session 正在生成时延迟到当前回复结束后交接。
- 多个 pending 请求时拒绝隐式选择并记录冲突。
- 任何失败都不能破坏已有活动 Session。

### 10.8 触发时机

带锁话题请求仍遵守当前架构边界：

> 工具执行完成不立即入锁；当前 assistant 最终回复结束后才认领并迁移。

这样可以避免：

- 工具循环尚未结束就启动另一轮生成。
- 同一 Agent 同时存在两个自主请求。
- 新话题心跳与旧话题最终回复并发写历史。
- 当前回复后续工具调用覆盖或改变创建结果。

### 10.9 幂等与恢复

二期实现必须满足：

- 相同 `requestId` 最多消费一次。
- 历史消息重新渲染不会重新认领。
- 页面重载后 pending 请求可以被明确恢复或拒绝。
- consumed 请求不能因旧结束事件再次启动。
- 认领成功但 Session 创建失败时，需要明确的补偿策略。
- Topic 删除后，对应 pending 请求必须失效。
- Agent 删除或配置损坏时，不得建立孤儿 Session。

### 10.10 二期验收场景

至少覆盖：

1. 无活动 Session 时创建带锁话题并成功入锁。
2. 已锁当前 Topic 时创建新话题并原子交接。
3. 当前 Session 正在生成时创建新话题。
4. 同一 Agent 并发创建两个带锁话题。
5. 不同 Agent 同时创建带锁话题。
6. Topic 创建成功但当前最终回复失败。
7. pending 请求重复消费。
8. 页面重载后恢复。
9. 目标 Topic 被删除。
10. 初始消息中的 Start 只渲染、不重放。
11. 心跳提示词和延迟正确传入新 Topic 第一跳。
12. 新 Topic 第一跳输出 Stop 后正确出锁。

---

## 11. 开发原则

Flowlock 后续迭代应保持：

1. 最终消息原文是控制协议的数据源。
2. 消息 context 是 Agent 和 Topic 身份的数据源。
3. 工具结果不是运行时 Session 的直接状态源。
4. 历史渲染永远不重放控制命令。
5. 一个 Agent 同时最多一个活动 Session。
6. Topic 持久化锁与 Flowlock 运行时锁分离。
7. 后台执行不依赖当前 UI。
8. 所有定时器都必须受 generation 防复活保护。
9. 所有跨 Topic 交接都必须可验证、幂等且可审计。
10. 不使用模型回显的资源 ID 作为可信真相。

---

## 12. 当前状态

### 已实现

- 多 Agent 并发 Session。
- 单 Agent 单 Topic Session。
- 后台指定上下文续写。
- 最终回复结束后触发。
- Start、Stop、Complete 和 Fail。
- NextHeartbeat。
- 同行与跨行 NextPrompt。
- 控制协议安全屏蔽。
- 控制状态气泡。
- 错误重试与自动停止。
- Topic 切换约束。
- 最终完整消息透传。

### 二期规划

- TopicSponsor `CreateFlowlockTopic`。
- 持久化 `flowlockRequest`。
- 安全 UUID 请求身份。
- 主进程原子认领接口。
- Session 跨 Topic 原子交接。
- pending 请求冲突处理。
- 页面重载恢复与补偿机制。