# PTYShellExecutor (VCPCLI POSIX 内核)
> Linux 桌面环境下的高性能持久化 Shell 命令执行器（全面对齐 VCPCLI 原生标准）

## 📖 简介
**PTYShellExecutor** 是 VCPChat 在 Linux/POSIX 桌面环境下的核心持久化终端插件。在 2.0.0 版本中，已全量重构对齐 VCPCLI 标准架构：
- 采用 **POSIX 命名管道（FIFO）与流式文本截断分流** 作为命令输出真源；
- 采用 **原子结构化完成回执（receipt.json）** 判定任务收尾，PTY 仅作前端显示与交互渲染；
- 会话由临时子进程全面升级为 **持久化常驻会话**，跨命令完美保留工作目录（连续 cd）与环境变量；
- 引入 **commandUnresolved 状态锁** 与超时 60s running_detached 机制，彻底杜绝并发踩踏；
- 提供 **全套交互式 TUI 控制能力** 与 **VCPChat 主窗口侧栏终端无缝深度联动（terminalTarget）**。

---

## ✨ 核心特性

- 🐚 **持久化共享会话** - 跨命令持续保留当前工作目录（cd）、环境变量（export）与会话状态，无需重复加载 shell。
- 📦 **无损日志分流与原子回执** - 通过 commandCapture 分流 stdout/stderr，保证文本、Tab、空格完整无损，并通过原子文件操作确认 receipt.json 完成状态。
- 🛡️ **未决状态锁与防踩踏** - 命令超时 60s 自动转入后台（running_detached），锁保留直至收尾回执；中断（Ctrl+C）仅投递信号不杀锁，杜绝新命令盲目插队。
- 🎮 **全套交互式 TUI 指令** - 支持启动并操纵 snow、codex、claude、vim、fzf 等：支持按键连击（SendInteractiveKey）、无损粘贴（PasteInteractiveText）与步序编排（RunInteractiveSequence）。
- 👁️ **屏幕感知（QueryVisible）** - 直接读取 Headless 终端缓冲区，AI 可只读巡视当前屏幕可见行，不干扰前台交互。
- 🔀 **视图解耦与侧栏联动** - 支持 terminalTarget: "sidebar" | "window"，侧栏终端与独立 CLI 窗口共用同一底层 PTY 进程。
- 📜 **实时轨迹追踪** - commandRunStore.js 统一维护执行历史，并实时广播至主窗口侧边栏“命令输出”抽屉。
- 🔐 **Linux 高危提权与安全审核** - 内置高危模式拦截与 AdminConfirm 图形授权确认弹窗（支持系统 pkexec 代理）。

---

## 🚀 调用支持与参数一览

| 指令名称 | 必需参数 | 可选参数 | 功能描述 |
|---|---|---|---|
| **ExecutePowerShell / execute** | `command` | `requireAdmin`, `newSession`, `terminalTarget` | 同步执行命令，支持持久目录保留与原子回执 |
| **StartInteractive** | `command` | `newSession`, `terminalTarget` | 启动交互式 TUI 程序并锁定会话 |
| **SendInteractiveKey** | `key` | `terminalTarget` | 发送原生终端按键（如 enter, up, ctrl+c*2） |
| **PasteInteractiveText** | `text` | `submit`, `terminalTarget` | 通过 Bracketed Paste 协议无损注入文本 |
| **RunInteractiveSequence** | 步骤编号 | `terminalTarget` | 编排 commandN, waitN, keyN, pasteN, queryVisibleN |
| **QueryVisible** | 无 | `maxLines` | 只读感知终端屏幕当前可见文本 |
| **InterruptPowerShell** | 无 | 无 | 发送 Ctrl+C 中断信号并进入未决等待 |
| **EndInteractive** | 无 | 无 | 解除交互模式并复位提示符 |
