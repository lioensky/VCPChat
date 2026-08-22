# 流式工具等待期间切换话题：保守修复记录

更新日期：2026-08-22

## 问题与边界

当同一条流在等待 VCP 工具回执时，用户切换到另一话题，再切回原话题，原 renderer Surface 可能已经清空 DOM/history projection；流事实仍在，但没有重新投影，因此消息看起来消失。该修复只覆盖同一 renderer 生命周期内的切换，不承诺 renderer 崩溃或进程重启后的未终结流恢复。

## 已落地的最小方案

- `StreamProjection` 为活动流保存 conversation identity、message model、operation、phase 和累计文本快照。
- 新增 `snapshotConversation(identity)` 与 `reconcileConversation(identity)`，切回 Surface 时重新补齐 pending message 并重绘当前累计文本。
- 快照是 renderer-transient，不写磁盘；terminal/persistence authority 不变。
- `startStreamingMessage` 仅在已有 DOM owner 时短路，允许切回后重建 DOM。
- identity 同时包含 `itemType`、`itemId`、`topicId`，不使用 topic 单字段猜测归属。

## 证据

- `tests/stream-manager-terminal-cleanup.test.js` 覆盖：工具等待、切换、清空 projection、切回、继续 chunk，验证 history 与 DOM 均恢复。
- `tests/chat-manager-selection-race.test.js` 覆盖：history 文件读取期间 terminal 完成，验证文件同步不会把刚提交的 assistant 当作删除项。
- 文件同步会保护读取开始时和读取完成时的 active stream identity，避免 terminal 在异步读期间改变 active 状态造成误删。
- 仍需运行 Chat Kernel/UI 全量、静态门禁和真实 Electron 主聊天 sequence；这些证据未完成前不能宣称 D7 或绝对零回归。

## 后续风险审查

- 不提前持久化半成品工具请求；工具 marker/parser 状态仍由现有 stream runtime 持有。
- terminal/discard/dispose 会释放快照，迟到 chunk/terminal 继续受 operation identity 保护。
- history load 与 terminal 同时发生的覆盖竞态已通过 ChatManager 回归测试并采用 active identity 保护；后续若引入更强的 revision 模型，仍应在 history owner 增加 revision guard，而不是让 transient provider 写盘。
