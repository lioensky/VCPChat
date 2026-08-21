# VCPChat 图形启动器

入口和产物的完整权威地图见 [`project-entrypoints.md`](project-entrypoints.md)；本页只描述图形启动器的用户操作。

普通用户不需要输入终端命令。构建过 Installer 后，macOS 可双击 `launchers/VCPChat-Setup.command`；也可以使用根目录的 `VCPChat 启动器.app` 或 `VCPChat 启动器.command`。Windows 双击 `VCPChat 启动器.vbs`。平台实现保存在 `launchers/`：

| 平台 | 入口 |
| --- | --- |
| macOS | `launchers/VCPChat-Setup.command`（已构建 Installer 时）或 `launchers/VCPChat-Launcher.command` |
| Windows | `launchers/VCPChat-Launcher.vbs` |
| Linux | `launchers/VCPChat-Launcher.sh` |

入口会直接打开 Hermes 风格、但使用 VCPChat 极简 Aero 视觉 token 的图形安装器，并通过 `--source-root` 传入当前源码根目录。欢迎页点击“准备 VCPChat”后，它会检查项目、依赖和运行时，必要时显示阶段化修复计划与可展开的运行详情；失败时进入独立失败页，提供重试和诊断记录入口。用户明确点击修复后才会修改环境，检查通过后再启动 VCPChat。启动成功并收到主窗口 ready 信号后，启动器会自动退出。

这些文件是推荐的源码图形入口，不替换或修改 `npm start`、`start.bat`、`启动Vchat.vbs` 和其他既有脚本。开发者使用 `npm run vcpchat` 进行诊断和受控启动；`npm run vcpchat:ui` 仅作为恢复 UI 和故障诊断入口。

源代码分发仍需要 Node.js 和 `npm install`；如果这两个运行时都不存在，双击入口会给出明确提示。当前 `.app` 是源码树中的无签名便捷入口，不代表生产安装包；正式分发仍应由签名安装器创建桌面/开始菜单快捷方式，并把 Recovery UI 作为独立启动器目标。
