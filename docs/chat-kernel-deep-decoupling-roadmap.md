# Chat Kernel D0-D7 当前执行合同

更新日期：2026-08-21。本文只定义仍然有效的目标、边界和退出条件；阶段状态与最新测试数字只在 [`chat-kernel-vd7-final-audit.md`](./chat-kernel-vd7-final-audit.md) 维护。按时间追加的施工记录已归档到 [`archive/2026-08-chat-kernel-and-ui-roadmaps/`](./archive/2026-08-chat-kernel-and-ui-roadmaps/)。

## 最终目标

把聊天运行时稳定分为 Domain、Content Runtime 和 Surface Adapter：实时协调、持久事实与 DOM projection 各有唯一 owner；`renderer.js` 只组装主窗口依赖和生命周期；`messageRenderer.js` 只通过显式 root、render model 和 capability closure 投影；无生产消费者的 ambient facade 必须删除。

必须保持主聊天发送、流式、取消、重试、历史与话题切换、附件、主题与设置、通知、desktop push、VoiceChat、Rust Assistant、Classic 子页面和插件协议。未登记的 IPC、持久化、terminal、DOM、焦点、ARIA、监听器或资源差异默认视为回归。

## 阶段合同

| 阶段 | 退出条件 |
| --- | --- |
| D0 | 冻结 renderer、message renderer、chat manager、stream manager 的真实 producer/consumer、owner、失败入口与行为基线。 |
| D1 | StreamSession/StreamState 不依赖 DOM/Electron，明确 operation identity、chunk 顺序、单 terminal 和迟到结果规则。 |
| D2 | Stream Coordinator 唯一拥有 reader、abort、terminal arbitration 和 per-conversation persistence queue；dispose 等待真实工作停稳。 |
| D3 | 主聊天、独立 Surface 和辅助窗口拥有隔离的 stream consumer、conversation identity、projection runtime 与 terminal route。 |
| D4 | MessageRenderer 只消费显式 root、render model、realm/service capability；不得读取主窗口 selection/history ambient state。 |
| D5 | `renderer.js` 只保留 root 查询、capability/provider 构造、owner/adapter mount 和逆序 awaited dispose，不拥有聊天业务 authority。 |
| D6 | 路线指定的仓内 ambient consumers 清零；保留公共 facade 必须冻结、不可替换、有唯一 owner、真实生产消费者、动态 smoke 和退役条件。 |
| D7 | terminal/persistence authority 唯一；完整支持配置矩阵、30-60 分钟人工 soak、逐项审计全部闭合。 |

## 当前架构决策

- 注册即 owned effect。DOM listener、preload subscription、observer、timer 和异步 consumer 必须交给可撤销 owner。
- `dispose()` 必须幂等并达到 quiescence：先使 generation/abort signal 失效，再撤销 producer，最后等待 in-flight task 和 persistence queue。
- settings、selection、history 和 attachment snapshot 对消费者是借用值；读取返回 detached copy 或冻结 snapshot，写入只经显式 `set/replace/update/append` authority。
- event 传播事实变化，不替代当前 snapshot；每个 event 都必须定义 producer、consumer、顺序、terminal 和丢弃规则。
- 先迁移真实消费者，再删除 facade。静态零引用、动态入口和行为证据缺一不可。
- 保留的兼容 API 只承担窄命令或只读 projection；不得持有第二份业务状态或生命周期。

## 验证合同

每个切片至少运行 focused owner tests、`test:chat-kernel`、`test:ui-system`、consumer/Next/design/Classic 门禁和受影响的真实 Electron 入口。最终 D5/D6 还要求主聊天序列、UI Apps/辅助窗口恢复和 lifecycle stress，且 listener/resource 稳定、detached roots 为零。

D7 还要求在声明支持的 Windows 版本、安装/打包方式、GPU/DPI 组合上保存逐行证据，并完成人工 soak checklist。当前单主机自动化不能外推为 D7 完成。

## 规范来源

架构与审查优先遵循 `C:\VCP\vchat-develop\deepseek-harness\AGENTS.md`、`docs/architecture.md`、`docs/event-producer-consumer.md`、`docs/defensive-patterns.md`、`docs/testing.md` 和 `.agents/skills/dsh-code-review/SKILL.md`。这些规范定义审查方法，不替代本仓源码和真实测试证据。
