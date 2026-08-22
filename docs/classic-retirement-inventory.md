# Classic 退场拓扑清单

本清单是 `classic-retirement-architecture.md` 的可执行基线与完工记录。R0–R5 已按本清单完成；后续改动仍必须先归类，禁止把 C 类共享业务误当作 UI 迁移对象。

## A：真实模式分叉

| 区域 | 当前分叉 | R1–R4 收敛目标 |
|---|---|---|
| 窗口控制 | Classic 与 Next 各自订阅最大化 IPC | 共享 `VCPWindowState`，按钮仅投影状态 |
| 顶栏与快捷入口 | Classic title bar、Next topbar | 保留 Next 唯一入口，命令不依赖 DOM |
| 侧栏手势 | Classic 右键/长按与 Next 独立按钮 | R3 冻结唯一手势契约 |
| 通知入口 | 按钮在不同 host 间移动，Next 有菜单 | 共享命令；通知 renderer 拥有列表 DOM |
| Topic 装饰 | Next 动态添加选择/管理控件 | 常驻且 mount/dispose 幂等 |
| 设置增强 | Next 对同一上游表单做增强 | 常驻增强，保存/回滚仍由共享 manager 负责 |

## B：Next 独有 Surface

- Next topbar 与 Launchpad
- AppTabHost 与内嵌应用宿主
- Ask Nova 模态窗
- Appearance Studio
- 空会话 VCPChat/Nova 视觉
- VCPUI 与 Web Awesome/native fallback

这些 Surface 不创建 Classic 对应物。R2 只验证常驻生命周期、失败回滚和资源归还。

## C：共享业务核心

- `#chatMessages`、`messageRenderer`、`chatManager`、`streamManager`
- `#messageInput` 以及发送、附件、表情、新话题按钮
- 助手/群组/话题列表及其 manager
- 通知列表与通知侧栏
- 全局、助手、群组设置表单及保存协议
- 插件 loader、插件数据与动态壁纸协议

这些对象必须保持单一 DOM identity 和上游业务语义。退场只允许解除外围 mode CSS，不得复制、包装或重写业务路径。

## 机械门禁

`npm run guard:classic-retirement` 检查共享 DOM identity、流式业务无模式依赖、命令无 Next DOM 所有权、Next 不点击隐藏 Classic 控件，以及业务 renderer 不依赖 `nextUi*`。

R4/R5 已完成唯一布局切换和存量门控清理；该门禁现在持续禁止新的 Classic runtime 分支及共享业务对 presentation ID 的反向依赖。
