# VChat 托管 Function Calling

关联：前端工程 `pkhsq`，后端工程 `p70xe`。本阶段先打通主聊天的 SSE、同气泡存档、重开和下一次发送。

## 不变量

- 仅改前端。消费已有 Chat Completions `choices[].delta.tool_calls`（也接受完整的 `choices[].message.tool_calls`），按调用下标拼接，保留原始 ID、函数名和参数，不执行调用，不要求私有 SSE 事件。实际服务端必须把 FC 字段传给客户端；若某个托管入口吞掉字段，前端不能从回执反推。
- 同一 assistant 气泡内按正文、FC、回执、后续正文存有序分段。流的完成标记或后续正文帧可确定当前 FC 批的提交边界。不使用正文偏移或合成 TOOL_REQUEST；旧历史无分段时走原路径。
- 回执段由匹配的 `VCP_TOOL_BATCH_END:<batchId>` 封口；有 `ROLE_DIVIDE_USER` 外壳时同时收齐对应 `END_ROLE_DIVIDE_USER`。下一段正文独立存放；直播和落盘使用同一切段规则。
- 历史发送前由 VChat 展开标准 `messages`：`assistant(tool_calls) → tool… → user(可见回执)`。无正文的 assistant 调用消息用 `content: null`。不发送 VChat 私有 FC 绑定，也不用执行记录 ID 或插件名匹配结果。
- 前端回执和旧文本工具循环完全相同：保留原样的可见摘要、角色分隔与批次外壳，不增添结果副本、不补出站结果 ID 到回执、不反查执行记录。真实 `user`（文本）与 `tool`（FC）结果只在后台同轮内存中。历史重发时，每个原始调用 ID 用 `role: tool` 闭合，文案为“原始结果保留上下文摘要”；原有可见回执仍按 `user` 边界只投影一次，不把批次摘要复制到各条 `tool` 消息。
- 未闭合的末尾 FC 可在历史中显示，但不能当作完整调用批向上游重放。

## 验收

同一 SSE：正文 A → FC(a,b) → 回执一 → 正文 B → FC(c) → 回执二 → 正文 C；直播和重开顺序一致。下一次请求抓取上游 messages，验证 a、b、c 各配一次原始 ID，回执不重复注入。旧文本工具、详情关闭、暂停后续答和硬中止分别回归。