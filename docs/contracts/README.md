# Chat contract evidence

本目录保存聊天内核证据契约和生成报告。契约 `id` 必须稳定；源码事实由脚本生成，人工决策只记录 owner、动态入口、退役条件和证据状态。

- `chat-contract.schema.json`：E0 证据记录的机器校验 schema。
- `chat-contracts.json`：人工维护的公共契约登记（不存在时允许为空）。
- `generated/chat-event-graph.json`：由 `build-chat-event-graph.mjs` 生成，不手工编辑。

运行 `npm run check:chat-contracts` 校验 schema、生成 graph 并检查 generated 文件没有过期。动态事件入口必须在契约的 `dynamicSites` 中登记；登记结果写入 `registeredDynamic`，未登记入口写入 `undiscovered` 并使 gate 失败，不能用无关 allowlist 隐藏。

生成器通过 Babel 语法树识别实际调用，忽略注释、正则和字符串里的示例代码；`win.CustomEvent`、常量别名与词法遮蔽均按源码处理。只有不可变的局部字符串可以静态解析。导入值、参数、可变绑定和运行时表达式保持未解析，不会套用外层同名常量。显式 CustomEvent、DOM/EventEmitter 监听、IPC 与 preload 通道声明保留所有静态名称，不再用聊天关键词过滤 get-agents、git:status 等有效通道。preload 的 onArgs、onSignal 与 custom 声明也按实际 channel 参数处理，null 表示无 IPC 通道。preload 订阅名称来自现行纯 Node 注册表，普通 `onChange` 回调不会凭名称被认作订阅。

这是一份源码入口清单，不是运行时消息传递证明。`custom-event-create` 表示构造事件对象；`preload-channel-definition` 表示声明通道，两者不保证执行或送达。DOM/EventEmitter 监听记为 consumer，IPC send/invoke 记为 producer。泛用 `emit`/`dispatch` 只记录静态领域名称，payload 调用不会被当作 IPC；任意自定义包装器、跨模块别名和字符串内注入的脚本仍需单独审查。`--check` 只校验生成文件是否新鲜，不等于契约 gate 或覆盖完整。

语法树扫描会暴露旧正则没有列出的动态 listener/channel 包装入口。`undiscovered` 是待核实的源码入口，不能直接解读成相同数量的运行时故障，也不能为消除报警批量标记 pass。先查包装器的调用者、身份和销毁约定，再登记有具体理由与证据状态的契约；解析失败直接报文件路径，不输出看似完整的局部图。

现有未声明 kind 的 `dynamicSites` 保持原来的 CustomEvent 构造入口语义，不会因此豁免同一行新增的监听或 IPC 操作。其他入口需显式声明 kind；登记绑定文件、行号和操作种类，源码移动后需要重新审查。
