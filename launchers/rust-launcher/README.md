# VCP 原生 Rust 一键启动器 (Native Rust Launcher)

专为 Windows 桌面环境设计的原生轻量启动器（替代早期容易黑框闪退的 `.bat` 启动脚本）。

## 核心特性
- **纯原生无黑框**：基于 Rust `#[windows_subsystem = "windows"]` 实现，启动过程零 CMD 控制台黑框闪烁；
- **体积超轻量**：仅约 350KB，无外部运行时依赖；
- **智能守护拉起**：自动检测后端与管理面板端口状态（6005 / 6006），未运行时自动静默唤醒后端进程；在后端就绪后拉起 VCPChat Electron 桌面端并自我退出；
- **防重复拉起**：检测到已有实例在运行时，避免多开冲突。

## 编译指南
在当前目录下执行 Cargo 编译即可：
```bash
cargo build --release
```
编译产物位于 `target/release/vcp-launcher.exe`（可重命名为 `启动VCP.exe` 并放置于桌面）。
