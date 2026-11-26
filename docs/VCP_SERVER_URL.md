# VChat 全局服务器地址与路由

`AppData/settings.json` 的 `vcpServerUrl` 只表示 HTTP(S) origin，例如 `http://localhost:5890`。不保存 `/v1`、路由、query 或 hash，不支持以路径为前缀的反代挂载。不改 `vcpLogUrl`（WebSocket）、MiMo 地址、工作流自定义 AI 供应商地址。

旧配置无需重填：主设置读时归一化；下一次正常保存通过现有设置原子写入和备份落盘。仍直接读 JSON 的调用方也通过同一模块兼容旧值。旧路径及其 query 不参与新路由构造，认证继续由模块原有的独立设置提供。

## 调用点盘点

修改前，在 Git 已跟踪运行源码中查 `vcpServerUrl|/v1/chat/completions`（JS、TS、HTML、Rust，排除测试、脚本、vendor 和分布式服务），命中 **37 文件**；其中 4 个仅属独立的 MiMo 或工作流 AI 配置，其他命中还包含表单、传参、判空，并不等于网络请求数。再追 `vcpUrl` 别名发现群聊路由和群聊标题模块。

| 用途 | 运行入口 / 调用点 | 路由归属 |
| --- | --- | --- |
| 聊天生成，10 个发送点 | 单聊 IPC（普通发送、重生成、心流共用）；群聊发言两处；单聊/群聊标题各一处；上下文压缩；桌宠闲聊；桌面 Widget；翻译；工具箱 AI 助手 | `vcpChatUrl`；只有单聊 IPC 和群聊发言按工具注入开关选择 `/v1/chatvcp/completions`，其余固定普通 Chat Completions |
| 发现模型，2 处 | 主窗口、群聊 | `models` |
| 中断/控制，3 处 | 单聊、群聊、工具循环交接控制 | `interrupt` |
| 人类工具 | 音乐、工具箱、工作流执行器 | `humanTool` |
| 管理与数据接口 | 天气、论坛、日志、任务、记忆/RAG、人格资源、表情、双曲场图、VTrade、桌面管理 API | 共用 origin；按各模块既有资源路径请求（天气有命名路由） |

## 后续切换协议

路由实现位于 `modules/utils/vcpServerRoutes.js`；Node 和经典页面共用，`vcpServerRoutes.mjs` 提供 ESM 入口。此轮不切换请求或响应协议。接入 Responses 时，应把新路由与 `input` 编码、`response.*` SSE 解码、工具结果回填作为同一个协议适配器验收，不能只替换后缀。普通生成与 VCP 工具回执注入的兼容性需要分别验证。