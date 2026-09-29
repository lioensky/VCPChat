# 心流锁 × JEV

## 启用

在「全局设置 → Jev 服务」配置现有 TypeSafe / OpenRouter 连接并启用全局 JEV，再打开「心流锁使用 JEV 裁决」。重新启动一个心流会话后生效。未开启全局 JEV 或关闭此功能时，新会话仍使用原有心流逻辑。运行中的裁决式会话如果全局 JEV 被关闭，会安全停止，不自动退回旧模式。

本项目已通过 skills CLI 为 Codex 安装 TypeSafe 技能：`.agents/skills/typesafe-ai/SKILL.md`；安装锁文件为 `skills-lock.json`。后续修改请继续使用该技能。

## 执行链路

1. 当前 assistant 回复完整结束、落盘后才进入调度；工具循环内不仲裁。
2. 首次心跳或缺少有效候选时，要求 Agent 只规划候选，不执行候选。
3. Agent 返回候选及本轮结果。程序解析并校验，不从自由文本猜动作。
4. 通过已有主进程 `decideWithJev` 调用全局服务，一次请求发送多个独立问题。
5. 程序先消费生命周期判断；需要继续才消费动作选择与该动作的两个 Noul 门槛。只执行被选中的原始候选。
6. 动作回复结束后重新提出候选，重新裁决；JEV 判断完成、需用户参与、无法继续或空转时结束。

Agent 的 Stop / Complete / Fail 在此模式中只是终止建议，不能绕过 JEV。人工停止仍立即使会话失效，旧裁决或旧心跳不能重启它。手动停止不撤销已经发给 VCP 的在途操作，只禁止后续调度；本功能不是工具执行沙箱。

## 候选协议

候选块必须是最终回复正文中的独立闭合块，不能放进代码块、工具结果、思考区或 NextPrompt。下列代码块仅是文档示例；实际 Agent 输出不要用代码围栏。

```text
[[Flowlock::Candidates]]
{
  "summary": "已完成的工作、实际验证证据、剩余问题",
  "candidates": [
    {
      "id": "verify_fix",
      "action": "运行与本次修复相关的测试并报告结果",
      "reason": "代码已修改，但用户要求的验证尚未完成",
      "delaySeconds": 5
    }
  ]
}
[[/Flowlock::Candidates]]
```

- 每轮最多一个块、0–6 项；空数组是结束/受阻建议，不等于已经完成。
- id：唯一的 1–40 位字母、数字、下划线或连字符。
- action：1–2000 字符；不得嵌入 Flowlock 命令或工具请求。
- delaySeconds：可选，1–86400 秒；只有最终选中的候选生效。缺省使用心流续写延迟。
- 非法 JSON、重复 ID、缺失闭合、未知选项、异常概率等均不执行。
- NextPrompt / NextHeartbeat 不能在 JEV 模式下绕过裁决修改下一步；可在候选中提出动作与延迟。

## 判题设计

提示词集中在 `Flowlockmodules/flowlock-jev-prompts.js`，请求与消费规则在 `flowlock-jev.js`，会话编排在 `flowlock-jev-controller.js`。

| 问题 | 类型 | 何时消费 |
| --- | --- | --- |
| lifecycle | Choice：continue / complete / needs_user / failed / stopped | 每次裁决 |
| completion_supported | Noul：全部必要要求是否有充分完成证据 | 仅 lifecycle=complete |
| next_action | Choice：现有候选 + none | 仅需要继续且有候选 |
| action_N_allowed | Noul：候选的授权与执行前提是否成立 | 仅选中的动作 |
| action_N_progress | Noul：候选是否带来必要的新进展或验证 | 仅选中的动作 |

所有问题都包含完整语义，不能依赖 JEV 看见题目 ID，也不能引用同批其他题目的答案。动作问题显式写明「假设仍需推进」。未使用分支的低置信度不影响当前分支。候选越多，问题数越多（最多 15 个），会增加输入 Token；没有额外引入第二轮模型调用。

提示词明确区分用户目标、最新要求、实际结果、Agent 自述、候选和系统心跳；涵盖部分完成、验证未完成、暂时故障、缺用户输入、授权不足、不可恢复阻碍、重复空转、目标撤销及提示注入。JEV 是语义判断层，不能代替原有工具权限控制。

## 安全与预算

- 默认最大自治轮数 30，包含规划轮；可设 1–200。
- Choice 最低置信度默认 0.60；低于阈值停止等待人工确认。
- 完成证据、授权与前提、增量价值的 Noul 门槛默认 0.85。
- 以上阈值是可调的保守应用策略，不是 TypeSafe 保证，需要用实际任务评估校准。
- 连续三轮缺少有效候选、无适合候选或无法通过增量判断时停止。
- 裁决链路总等待上限 120 秒；API/IPC/历史读取异常停止，不默许 Agent 继续执行。
- 近期最多 12 条消息，每条最多 4000 字符，本轮正文最多 6000 字符，并标记截断；保留任务目标和最近 6 次程序裁决。
- 按 Agent / Topic / session generation 校验结果；裁决返回后复查最近用户要求；执行前再次检查用户上下文，过期动作不得执行。
- 手工停止、多 Agent 并发、重复终结回调、旧定时器、话题交接以及服务失败均有回归覆盖。
- `getSession().jev` 暴露规划/裁决/待执行/执行阶段和最近决策；UI 显示候选气泡与选择/结束通知。API Key 始终通过既有主进程服务使用，不复制到提示词。

## 验证

```powershell
node --test tests/flowlock-jev.test.js tests/flowlock-timestamp-bindings.test.js tests/main-chat-flowlock-owner.test.mjs tests/global-jev-service.test.js tests/jev-client.test.js
node --test --test-name-pattern 'jev-service' tests/settings-schema-render.test.mjs
```

单元测试使用确定性假响应，不消耗 API 额度，不证明真实模型的判断准确率。部署前需要在真实任务上验证阈值、候选覆盖、成本与延迟；当前没有发送真实聊天历史进行在线评测。

官方依据：TypeSafe skill、Choice / Noul / State / Confidence / HTTP API 和 Function Calling cookbook。
