# JEV 智能群聊施工图

## 1. 目标

在现有群聊基础设施上增加由 JEV 神经裁判驱动的自治群聊：

- JEV 根据当前话题、最近历史和成员触发风格输出 Choice 概率分布。
- 本地引擎执行权重阈值过滤、降序排列和 Top-K 截断。
- 选中的成员严格串行发言。
- 一批成员发言完成后重新裁决，直到 JEV 智能结束、达到安全上限或用户停止队列。
- 用户可以在队列运行期间插话，也可以手动把指定成员插入队列。

旧有顺序发言、自然随机和邀请发言模式继续保留。

---

## 2. 核心模块

| 模块 | 职责 |
|---|---|
| `Groupmodules/groupchat.js` | 群聊主引擎、历史读写、Agent 请求执行、模式分流、统一中止入口 |
| `Groupmodules/modes/jevDecisionMode.js` | 构造 JEV 请求、解析概率、执行阈值和 Top-K 截断 |
| `Groupmodules/jevGroupSessionOrchestrator.js` | 每群组话题的 JEV 状态机、自治循环、插话、插队和优雅停止 |
| `Groupmodules/groupContextWindow.js` | 群成员模型的最近楼层窗口 |
| `modules/services/globalJevService.js` | 从全局设置读取 JEV 配置并调用客户端 |
| `modules/services/jevClient.js` | TypeSafe/OpenRouter 请求、超时、代理和重试 |
| `modules/services/historyMutationQueue.js` | 同一话题历史的串行原子变更 |
| `modules/ipc/groupChatHandlers.js` | 群聊 IPC 与主进程依赖注入 |
| `Groupmodules/grouprenderer.js` | 群设置保存、发起/继续/插队和中止提示 |
| `modules/settings/schema/sidebar-surfaces.js` | 群组设置 Schema |
| `modules/ui-system/settings/group-slots.js` | 成员风格编辑器和群聊控制按钮 |

---

## 3. 运行链路

```text
用户发言 / 发起群聊 / 继续群聊 / 手动插队
                    │
                    ▼
        每话题 JEV Session Orchestrator
                    │
          读取最新完整群聊历史
                    │
                    ▼
             JEV Decision Mode
                    │
       Choice 概率 + Continue Noul
                    │
                    ▼
      阈值过滤 → 权重排序 → Top-K
                    │
                    ▼
       K 名 Agent 严格串行完成回复
                    │
                    ├── 用户插话：原子写入历史
                    ├── @成员：提升为下一位
                    └── 当前批结束：重新裁决
```

---

## 4. JEV 裁决协议

### 4.1 输入

JEV state 包含：

- 群组 ID、名称和群组提示词。
- 最近群聊消息。
- 成员 ID、名称和独立触发风格。
- 成员最近发言情况和本次自治运行发言次数。
- 启动原因、自治轮数、最近用户消息及手动队列状态。

### 4.2 问题

一次请求并行提交：

1. `speaker_routing`
   - 类型：Choice。
   - 选项：每名成员及 `end_conversation`。
   - 成员使用 `agent_0`、`agent_1` 等不透明键，避免重名和特殊字符。

2. `continue_discussion`
   - 类型：Noul。
   - 判断继续自治讨论是否自然且有价值。

### 4.3 本地截断

按以下顺序处理：

1. 继续概率低于 `continueThreshold` 时结束。
2. 结束选项达到 `stopThreshold` 且权重最高时结束。
3. 过滤低于 `speakerThreshold` 的成员。
4. 按概率降序排列。
5. 截取前 `maxSpeakersPerRound` 名。
6. 没有成员通过阈值时结束。
7. “继续群聊”可强制以最高概率成员保底一次。

JEV 只负责语义判断；阈值、排序、K 上限和安全轮数由本地确定性代码执行。

---

## 5. 会话状态机

```text
idle
 ├── 用户发言──────────────► arbitrating
 ├── 继续群聊──────────────► arbitrating
 ├── 发起群聊──────────────► speaking（随机首位）
 └── 手动成员──────────────► speaking

arbitrating
 ├── 有效 Top-K ───────────► speaking
 ├── 智能结束──────────────► idle
 ├── 历史版本变化──────────► 丢弃旧结果并重新裁决
 └── 用户停止队列──────────► idle

speaking
 ├── 当前 Agent 完成且仍有队列 ► speaking
 ├── 当前批完成────────────► arbitrating
 └── 用户停止队列──────────► 当前 Agent 完成后 idle
```

同一群组话题只允许一个 JEV 自治运行实例。

---

## 6. 人类插话语义

### 普通插话

- 消息立即通过历史变更队列原子追加。
- 不打断当前正在输出的 Agent。
- 不清空当前 Top-K 剩余队列。
- 后续 Agent 启动前读取最新历史，因此能看到插话。
- 当前批结束后使用包含插话的最新历史重新裁决。
- 连续多次插话只更新历史版本，不创建多个自治任务。

### `@成员`

- 当前 Agent 继续完成。
- 被点名成员提升为下一位。
- 如果该成员已经在剩余队列中，只调整顺序，不重复入队。

### 裁决期间插话

- 已发出的旧裁决允许返回。
- 返回后比较 `historyRevision`。
- 如果版本已变化，则丢弃旧结果并重新裁决。

---

## 7. 队列停止语义

“中止群聊队列”现统一为所有群聊模式的优雅停止：

- 停止尚未开始的成员。
- 停止后续 JEV 裁决。
- 不打断当前已经开始的流式回复。
- 当前回复继续生成并正常落盘。
- 顺序发言、自然随机、邀请发言和 JEV 模式使用相同语义。

如果需要立即终止当前消息，使用该消息右键菜单中的“中止回复”。该入口仍会取消本地请求并尝试调用远程中断接口。

---

## 8. 两种上下文窗口

系统存在两个用途不同的历史窗口。

### 8.1 群成员模型楼层窗口

配置：

```json
{
  "enableContextMessageWindow": false,
  "contextMessageWindowSize": 100
}
```

规则：

- 默认关闭。
- 默认值 100。
- 有效范围 1–10000。
- 一楼等于一条历史消息，包括用户消息和 Agent 消息。
- 开启后，每次 Agent 发言只接收最新 N 楼。
- 适用于全部群聊模式，包括 JEV 模式中的 Agent 发言。
- 不修改磁盘历史。
- 不影响聊天瀑布流。
- 不影响话题标题总结。
- 不修改原历史数组。

### 8.2 JEV 裁判历史窗口

配置：

```json
{
  "modeSettings": {
    "jev": {
      "historyWindow": 12
    }
  }
}
```

规则：

- 可在群组的 JEV 智能群聊设置中配置。
- 默认值 12。
- 一楼等于一条历史消息，包括用户消息和 Agent 消息。
- 只限制发送给 JEV 裁判的最近消息数。
- 有效范围 1–200。
- 不限制群成员模型上下文。
- 与楼层控制器独立。
- 减小窗口通常可以减少每次裁决的输入 Token 和调用费用，但窗口过小可能削弱上下文判断。

建议：

- 群成员需要长记忆时，提高楼层窗口。
- JEV 只需判断当前发言权时，保持默认值 12 或按需调小 `historyWindow`。
- 话题需要依赖更早信息进行发言权判断时，适当调大 `historyWindow`。
- 不要把两者合并成同一字段。

---

## 9. 群组配置

JEV 权威配置位于：

```json
{
  "mode": "jev",
  "modeSettings": {
    "jev": {
      "navigatorPrompt": "导航员提示词",
      "speakerThreshold": 0.16,
      "continueThreshold": 0.45,
      "stopThreshold": 0.55,
      "maxSpeakersPerRound": 3,
      "maxAutonomousRounds": 12,
      "historyWindow": 12,
      "continueDebounceMs": 800,
      "fallbackPolicy": "stop",
      "memberStyles": {
        "agent-id": "该成员适合在什么话题和情境下发言"
      }
    }
  }
}
```

安全边界：

| 字段 | 范围 |
|---|---:|
| `speakerThreshold` | 0–1 |
| `continueThreshold` | 0–1 |
| `stopThreshold` | 0–1 |
| `maxSpeakersPerRound` | 1–32 |
| `maxAutonomousRounds` | 1–100 |
| `historyWindow` | 1–200 |
| `continueDebounceMs` | 0–10000 |
| `contextMessageWindowSize` | 1–10000 |

---

## 10. IPC

| 通道 | 用途 |
|---|---|
| `send-group-chat-message` | 用户发言；JEV 模式下启动或更新当前自治会话 |
| `start-jev-group-chat` | 无用户消息时随机成员开场 |
| `continue-jev-group-chat` | 从 idle 强制执行一次继续裁决 |
| `enqueue-jev-group-agent` | 手动插入成员 |
| `get-jev-group-chat-state` | 查询当前运行状态 |
| `interrupt-group-chat-queue` | 优雅停止后续队列，不中止当前流 |
| `interrupt-group-request` | 立即中止指定当前回复 |

控制事件复用 `vcp-stream-event`：

- `group_queue_state`
- `group_queue_updated`
- `group_queue_stopped`
- `jev_arbitration_started`
- `jev_arbitration_result`

这些事件由非流式消费者接收，不进入消息流投影。

---

## 11. 历史一致性

JEV 路径禁止持有旧历史快照后整体覆盖文件。

用户消息、Agent 终稿、错误消息和中断后的部分消息均应通过 `HistoryMutationQueue.mutate()`：

1. 在同一话题队列中串行。
2. 操作开始时重新读取最新磁盘历史。
3. 按消息 ID 幂等追加。
4. 原子替换历史文件。

这保证 Agent 输出期间的人类插话不会被旧内存快照覆盖。

---

## 12. 测试入口

核心测试：

```text
tests/group-jev-decision-mode.test.js
tests/group-jev-session-orchestrator.test.js
tests/group-jev-integration-contract.test.js
tests/group-chat-queue-interrupt.test.js
tests/group-context-window.test.js
tests/group-sequential-mode.test.js
tests/global-jev-service.test.js
```

建议回归命令：

```bash
node --test \
  tests/group-jev-decision-mode.test.js \
  tests/group-jev-session-orchestrator.test.js \
  tests/group-jev-integration-contract.test.js \
  tests/group-chat-queue-interrupt.test.js \
  tests/group-context-window.test.js \
  tests/group-sequential-mode.test.js \
  tests/global-jev-service.test.js
```

人工群聊重点观察：

1. JEV 概率排序与实际 K 队列是否一致。
2. 用户插话后，后续成员是否能引用新消息。
3. `@成员` 是否只提升一次。
4. 连续自治是否在智能结束或安全轮数处停止。
5. 停止队列后当前流是否完整结束，后续成员是否不再启动。
6. 楼层窗口开启后，成员是否只收到最近 N 楼。
7. 楼层窗口是否不影响磁盘历史、UI 显示和标题总结。
8. 后台话题运行时是否不会把事件投影到当前其他话题。

---

## 13. 后续扩展边界

可继续增加：

- 队列与裁决概率可视化。
- 裁决调用成本和延迟统计。
- 每话题覆盖群级 JEV 配置。
- 成员冷却轮数和重复发言惩罚。
- “清空剩余队列并立即重裁决”的强插话操作。

不得破坏：

- 每话题单一运行所有权。
- 历史原子写入。
- 当前流与后续队列的独立中止语义。
- 群成员楼层窗口与 JEV 裁判窗口的职责分离。