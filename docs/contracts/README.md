# Chat contract evidence

本目录保存聊天内核证据契约和生成报告。契约 `id` 必须稳定；源码事实由脚本生成，人工决策只记录 owner、动态入口、退役条件和证据状态。

- `chat-contract.schema.json`：E0 证据记录的机器校验 schema。
- `chat-contracts.json`：人工维护的公共契约登记（不存在时允许为空）。
- `generated/chat-event-graph.json`：由 `build-chat-event-graph.mjs` 生成，不手工编辑。

运行 `npm run check:chat-contracts` 校验 schema、生成 graph 并检查 generated 文件没有过期。动态事件入口必须在契约的 `dynamicSites` 中登记；登记结果写入 `registeredDynamic`，未登记入口写入 `undiscovered` 并使 gate 失败，不能用无关 allowlist 隐藏。
