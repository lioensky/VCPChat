# VCPFeishu 插件

VCPChat 飞书桥接插件——将飞书消息无缝转发给 VCPChat Agent 处理，实现 AI 对话能力的飞书集成。

## 功能特性

- ✅ **飞书 WebSocket 长连接** — 实时接收飞书消息事件
- ✅ **自动消息转发** — 收到飞书消息后自动调用 VCPChat 后端 AI 能力
- ✅ **Agent 绑定** — 支持绑定任意 VCPChat Agent（按名称或 ID）
- ✅ **流式回复** — 先发提示语再发完整回复，提升用户体验
- ✅ **自动启动** — VCPChat 启动时自动检测凭证并启动机器人
- ✅ **管理面板** — HTTP 页面查看状态和控制机器人

## 目录结构

```
VCPFeishu/
├── config.env          # 插件配置文件
├── config.env.example  # 配置示例
├── feishuBot.js        # 飞书机器人核心逻辑
├── index.js            # 插件入口（路由注册 + 工具调用）
├── package.json        # 插件依赖
├── plugin-manifest.json # 插件声明
├── setupWizard.js      # 扫码注册向导（预留）
└── node_modules/       # 插件依赖（pnpm install 后生成）
```

## 安装配置

### 1. 安装依赖

```bash
cd VCPDistributedServer/Plugin/VCPFeishu
pnpm install
```

### 2. 配置飞书应用

在 [飞书开放平台](https://open.feishu.cn) 创建自建应用，获取 `App ID` 和 `App Secret`。

**必需权限**：
- `im:message` — 消息读写
- `im:message:receive_v1` — 接收消息事件

### 3. 修改配置文件

编辑 `config.env`：

```ini
# 飞书应用凭证（必填）
FeishuAppId=cli_xxxxxxxxxxxxxxxx
FeishuAppSecret=xxxxxxxxxxxxxxxx

# 绑定的 Agent（必填）
# 支持两种方式：
#   1. agent 名称（推荐）：如 "记忆大师"
#   2. agent ID（文件夹名）：如 "_Agent_1782430448295_1782430448295"
FeishuBindAgent=记忆大师
```

## 配置项说明

| 配置项 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `FeishuAppId` | ✅ | - | 飞书应用 ID |
| `FeishuAppSecret` | ✅ | - | 飞书应用密钥 |
| `FeishuBindAgent` | ✅ | - | 绑定的 Agent 名称或 ID |
| `FeishuMaxReconnect` | ❌ | `-1` | 最大重连次数，`-1` 为无限重连 |
| `FeishuAgentTimeoutMs` | ❌ | `120000` | AI 推理超时（毫秒） |
| `FeishuStreamReply` | ❌ | `true` | 是否先发提示语 |
| `FeishuStreamHint` | ❌ | `正在思考中…` | 流式提示语 |
| `FeishuAllowedUsers` | ❌ | - | 用户白名单（open_id 逗号分隔），留空不限制 |
| `DebugMode` | ❌ | `false` | 调试模式，输出详细日志 |

## 工作原理

```
飞书用户发消息 → 飞书服务器 → WebSocket 推送 → VCPFeishu 插件
                                                         ↓
                                           读取 Agent 配置（systemPrompt, model 等）
                                                         ↓
                                           调用 VCPChat 后端 API（localhost:6005）
                                                         ↓
                                           获取 AI 回复 → 飞书 API 发送回复
```

## 管理面板

访问 `http://localhost:5974/api/plugins/feishu` 查看：
- WebSocket 连接状态
- 消息统计（接收/处理/失败数）
- 当前绑定的 Agent
- 启动/停止控制

## 注意事项

1. **插件自包含** — 所有依赖安装在插件目录内，不影响 VCPChat 根目录
2. **零核心修改** — 无需修改 VCPChat 任何核心文件，仅修改插件目录内容
3. **Agent 配置** — 绑定的 Agent 必须已在 VCPChat 中创建且配置了正确的模型
4. **网络要求** — 需要能访问飞书开放平台 API（open.feishu.cn）

## 故障排查

### 常见错误

| 错误 | 原因 | 解决 |
|------|------|------|
| `403 - This token has no access to model xxx` | 使用了后端不支持的模型 | 检查 Agent 配置的 model 是否在后端支持列表中 |
| `WebSocket 未连接` | App ID/Secret 错误或权限不足 | 检查飞书应用凭证和权限配置 |
| `未找到 Agent` | bindAgent 名称或 ID 不存在 | 检查 FeishuBindAgent 配置是否正确 |
| `ECONNREFUSED` | 后端服务未启动 | 确保 VCPToolBox 后端运行在 6005 端口 |

### 查看日志

```bash
# 控制台日志搜索
grep "VCPFeishu"
```

关键日志：
- `[VCPFeishu][Bot] WebSocket 连接已建立` — 连接成功
- `[VCPFeishu][Bot] 收到消息: from=xxx text=xxx` — 收到消息
- `[VCPFeishu][Bot] 调用 VCP: http://localhost:6005/...` — 调用后端
- `[VCPFeishu][Bot] 回复已发送` — 回复成功