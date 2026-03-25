# PTYShellExecutor

> Linux 桌面环境下的本地 Shell 命令执行器

## 📖 简介

PTYShellExecutor 是一个为 VCPChat 设计的本地 Shell 执行插件。它使用 node-pty 创建持久化的 PTY（伪终端）会话，支持 bash/fish/zsh 等主流 Shell，能够保持环境变量和会话状态。

与 LinuxShellExecutor（SSH 远程执行）不同，本插件专注于**本地桌面环境**的命令执行场景。

## ✨ 特性

- 🐚 **多 Shell 支持** - 自动检测并优先使用 fish > zsh > bash
- 🔄 **持久化会话** - PTY 会话保持状态，支持环境变量继承
- ⚡ **同步/异步双模式** - 短命令同步执行，长任务后台托管
- 🧻 **禁用分页器** - 默认禁用常见分页器（PAGER/GIT_PAGER/SYSTEMD_PAGER/MANPAGER 等），避免命令进入 less 导致超时
- 🧹 **智能输出清理** - 自动过滤 ANSI 转义序列、Shell Integration 标记
- 🧯 **自动降级** - 当环境禁止创建 PTY 时，自动切换为 pipe 模式执行
- 🖥️ **可视化终端** - 内置 GUI 窗口，实时查看命令执行
- 🎨 **主题跟随** - 自动同步 VCPChat 的明暗主题设置
- 💾 **任务持久化** - 异步任务状态保存至磁盘，7 天自动清理

## 🚀 快速开始

### 同步执行命令

    tool_name: PTYShellExecutor
    command: ls -la

### 异步执行长任务

    tool_name: PTYShellExecutor
    action: async
    command: npm install

### 查询任务状态

    tool_name: PTYShellExecutor
    action: query
    taskId: task_xxx_yyy

### 列出所有任务

    tool_name: PTYShellExecutor
    action: list

### 取消任务

    tool_name: PTYShellExecutor
    action: cancel
    taskId: task_xxx_yyy

## 📋 参数说明

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| action | string | 否 | 操作类型：execute(默认), async, query, cancel, list |
| command | string | 条件 | 要执行的命令（execute/async 模式必需） |
| taskId | string | 条件 | 异步任务 ID（query/cancel 模式必需） |
| shell | string | 否 | 指定 Shell：fish, zsh, bash |
| newSession | boolean | 否 | 是否强制创建新的 PTY 会话 |
| cwd | string | 否 | 工作目录（execute/async 模式可用） |

## ⚙️ 配置项

编辑 config.env 文件：

    # 返回模式: delta (仅增量) 或 full (完整输出)
    SHELL_RETURN_MODE=delta

    # PTY 模式: auto(默认，失败自动降级), pty(强制使用), pipe(禁用 PTY)
    PTY_MODE=auto

    # Shell 优先级 (逗号分隔)
    SHELL_PRIORITY=fish,zsh,bash

    # 禁止执行的命令关键字 (逗号分隔)
    FORBIDDEN_COMMANDS=

    # 需要确认的命令关键字 (逗号分隔)
    AUTH_REQUIRED_COMMANDS=

    # 命令超时时间 (毫秒)
    COMMAND_TIMEOUT=60000

## 🏗️ 架构设计

    PTYShellExecutor/
    ├── PTYShellExecutor.js    # 主逻辑
    ├── plugin-manifest.json   # 插件清单
    ├── config.env             # 配置文件
    ├── gui/                   # GUI 相关
    │   ├── ShellViewer.html   # 终端界面
    │   └── preload.js         # Electron 预加载
    └── state/                 # 异步任务状态存储
        └── task_xxx.json      # 任务状态文件

### 核心模块

**AsyncTaskManager** - 异步任务管理器
- 任务生命周期管理（启动/查询/取消）
- 状态持久化与自动清理
- 输出长度限制（5MB）

**PTY Session** - 伪终端会话
- node-pty 创建持久化会话
- 支持会话复用与新建
- 自动检测可用 Shell

**Output Cleaner** - 输出清理器
- ANSI 转义序列过滤
- Shell Integration 标记清理
- Fish 警告信息过滤
- 逐字符回显模式处理

**GUI Window** - 可视化终端
- Electron BrowserWindow
- xterm.js 终端渲染
- 主题同步

## 🔒 安全机制

- **命令黑名单** - 可配置禁止执行的命令关键字
- **确认机制** - 敏感命令可配置为需要确认
- **超时保护** - 默认 60 秒超时，防止命令卡死
- **输出限制** - 异步任务输出最大 5MB，防止内存溢出

## 📝 与 LinuxShellExecutor 的区别

| 特性 | PTYShellExecutor | LinuxShellExecutor |
|------|------------------|-------------------|
| 执行位置 | 本地 | SSH 远程 |
| 会话模式 | PTY 持久会话 | 每次独立连接 |
| Shell 支持 | fish/zsh/bash | 依赖远程 Shell |
| hostId | 不需要 | 必需 |
| 异步任务 | 支持 | 支持 (isLongRunning) |
| GUI 终端 | 内置 | 无 |

## 🩺 故障排查

1. **提示“插件加载失败，请检查本地诊断报告”**
   - 查看 `reports/` 目录下最新的 `.json` 报告，重点关注 `phase` 和 `error.message`。

2. **报错 `forkpty(3) failed`**
   - 说明当前运行环境禁止创建 PTY（常见于容器/沙箱/受限 devpts 配置）。
   - 解决方案：
     - 在 `config.env` 设置 `PTY_MODE=pipe`（禁用 PTY，使用 pipe 模式执行）。
     - 或改用 `action: async` 异步模式。
     - 如需要 PTY：请在宿主/容器开启 PTY 支持（devpts/ptmx 权限、pt_chown 等）。

3. **报错 `node-pty 模块不可用`**
   - 确认宿主项目依赖中已安装 `node-pty`，且与当前 Node/Electron 版本匹配。

## 🐛 已知限制

1. **交互式程序** - 无法处理需要持续交互的程序（如显式运行 less/vim/top 等）
   - 说明：常见命令的分页器已默认禁用（如 git log/systemctl/man），但显式交互式 TUI 仍不适合走同步执行
   - 建议：需要长时间运行或交互的任务请使用 `action: async`

2. **仅限 Linux** - 依赖 Linux 环境的 Shell 和 PTY 实现

3. **Electron 依赖** - GUI 功能需要 Electron 环境

## 📜 License

MIT License

## 👥 Authors

- **Piko** - 开发与文档
- **十一** - 架构设计与代码审查
