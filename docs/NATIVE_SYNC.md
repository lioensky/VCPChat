# NativeSync：可选桌面会话接续

本功能连接配套的 VCPToolBox NativeSync Service Plugin（上游草稿 PR [#536](https://github.com/lioensky/VCPToolBox/pull/536)），复用现有聊天模型和界面。默认关闭，不扫描、上传或迁移全部历史。

## 写入与恢复边界

- 原生保存提交完整快照后，由 HistoryMutationQueue 的观察器生成消息级 Diff 并持久保存 Outbox；网络请求在 Queue 外执行。同步捕获失败不改变原生保存成功，但会记录退化并在恢复时补捕获。
- 远端事件经 Queue.mutate 合入，不覆盖完整历史；相同消息的并发修改显式冲突，不同 ID 合并，删除保留墓碑。Owner 类型、ID、Topic 与真实物理路径绑定。
- Pending 记录历史提交前后 revision；历史及同步应用记录可靠落盘后才推进 Cursor。空权限过滤页按 nextSeq 前进，不使用全局 headSeq 跳过分页。
- 显式刷新复用 syncHistoryFromFile，并等待流式终态 saving 完成。同步话题的旧全量保存会被拒绝。
- NativeSync 所有的共享话题只允许 Queue 写入；CDS/MobileSync 保留读取及索引，共享话题消息写入、墓碑、Owner/Topic 替换与删除被拒绝。其他非共享话题保留原有行为。NativeSync 活动时拒绝启动独立 Legacy 写入者。
- 含共享话题的 Agent 及共享 Topic 不可直接删除。需先明确停止同步并重启、核对状态后再切换写入权威。

## 显式启用

1. 在现有 VCPToolBox 上启用 NativeSync；需要 Node 24+、独立数据目录和受保护 HTTPS。移动 PWA 还需配置明确 Agent/Topic 及执行模型。
2. 桌面原有后端配置使用同一 HTTPS Origin 和获准的 ToolBox Key。此接入复用现有桌面鉴权，不把移动 Cookie 或配对码用作桌面 Key；不包含额外设备凭据签发或 SSH 注册系统。
3. 选定少量已有话题，备份并检查历史。为每份原 history.json 计算原始字节 SHA-256。保持原 itemId/itemType/topicId，不重新生成 ID，不批量导入。
4. 在实际 AppData 的 `.native-sync/connection.json` 写入以下非秘密配置。示例中的域名、ID 和摘要都需要替换；Key 不写入这个文件。

```json
{
  "version": 1,
  "enabled": true,
  "historySelectionApproved": true,
  "deviceId": "desktop-a",
  "serverUrl": "https://toolbox.example.invalid",
  "credentialSource": "existing-vcp-settings",
  "publishCatalog": true,
  "topics": [{ "itemId": "agent-id", "itemType": "agent", "topicId": "topic-id" }],
  "approvedHistory": [{ "itemId": "agent-id", "itemType": "agent", "topicId": "topic-id", "rawFileSha256": "REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS" }]
}
```

首次连接会在启用同步前只读比较批准的本地快照与中央记录；摘要变化、同 ID 内容冲突、远端墓碑或未选择话题均拒绝继续。比较阶段不写原历史或中央数据库。成功接入后由 Outbox 自动提交，保留原消息身份及规范化哈希。

已有 state.json 的冷启动先本地恢复 Queue 规则及 Outbox，再在后台重试网络。首次接入仍需在线比较。未启用、没有连接文件时，不读取 Key、不创建同步状态或联网。

serverUrl 必须是无路径、无用户名/密码、无 query/hash 的 HTTPS Origin，且与桌面现有模型后端 Origin 一致；不自动转发至其他服务器，不携带 Key 跟随重定向。不包含个人域名、SSH 主机、端口映射、远端注册命令或运维启动器。

最多显式选择 8 个话题。publishCatalog 默认为 true，仅发布 Agent/Topic 名称、原 ID、更新时间及受限头像，不发布 Prompt、模型 Key、文件路径或完整 Agent 配置。服务端未启用移动目录时可设为 false。当前移动产品范围为 Agent 文本话题，群聊自动终态/错误/redo 的 Queue 修复不等于移动群聊引擎或全部群聊管理写入已获同步保证；不要将群聊话题用于此自动启用流程。

中央存储应仅包含该同步集合，或由服务端按设备 Scope 过滤；收到未配置身份时客户端失败关闭，不静默跳过或写入其他 Owner。

## 验证与支持范围

```sh
npm run test:native-sync
npm run test:chat-kernel
npm run test:mobile-sync
```

Node 定向测试的 SQLite 中心仅是测试夹具，要求 Node 24+；桌面产品代码本身不引入 SQLite 数据库或修改 Rust CDS 协议。Electron 验证使用仓库正常 Electron 依赖：

```sh
npx electron tests/electron/native-sync-main.cjs
```

默认测试目录由系统临时目录创建，显式输出根须以 native-sync- 开头。夹具使用真实 preload、原生 IPC、Queue 与正式消息渲染模块，但不代表完整 main.js 冷启动。完整应用、离线恢复及配套完整 ToolBox 宿主联调应独立记录，不能用夹具测试代替。

仅覆盖选定话题文本；附件二进制、完整 Agent/配置同步、手机群聊执行、桌面 Context Checkpoint 等价性、外部工具恰好一次副作用及全部分布式插件组合不在此范围。不重写模型调用管线，不改变消息规范化、SHA-256、Outbox 格式或 durableJson 的持久化节奏。
