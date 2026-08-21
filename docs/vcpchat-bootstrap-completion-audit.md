# VCPChat Hermes-inspired Bootstrap 完成审计

审计日期：2026-08-20（macOS arm64）

## 需求与证据

| 阶段 | 要求 | 当前证据 | 结论 |
|---|---|---|---|
| H0 | 基于 Hermes 源码建立独立安装/启动/更新边界 | 本机 Hermes 源码快照；`vcpchat-hermes-inspired-launcher-roadmap.md`；对照 bootstrap installer、first-run gate、update marker 和 platform handoff | 本机研究完成；完整 Git history/commit pin 因 GitHub 限速未取得 |
| H1 | 独立一键托管入口，不改变旧入口 | `npm run vcpchat`；Doctor → repair plan → consent → repair → recheck → launch；project-scoped state；completion marker | 完成 |
| H2 | 独立 UI、阶段进度、取消、恢复、ready 后 handoff | `npm run vcpchat:ui`；Recovery preload/main/renderer；repair plan；实时 output；cancel；进程树清理；`--handoff`；双击启动入口 | 本机功能完成；与 Hermes 独立安装器仍不等价 |
| H3 | 可重复、受预算约束的环境修复闭环 | lockfile identity、repair budget、journal、fingerprint、native probe、optional Rust/vendor、AbortSignal | 完成，未改变插件 Loader、动态壁纸或用户数据格式 |
| H4 | 跨平台进程和路径边界 | `platform-process.js`；Windows taskkill/POSIX process group；三平台 bundle resolver；中文/空格/长路径模拟 | 代码契约完成；Windows/Linux 实机证据缺失 |
| H5 | staging、完整性、健康检查、回滚与安全下载 | path/symlink/hash/size/disk checks；signed canonical manifest；HTTPS same-origin；Range resume；ready health；atomic pointer；rollback | 代码闭环完成；生产公钥分发、签名安装包和真实网络故障证据缺失 |
| H6 | 操作序列、生命周期、pack 和证据 | Bootstrap 36/36；UI System；Electron UI 22/22；main-chat sequences；3+20 lifecycle stress；pack check；release evidence | 本机自动化完成；真实平台、签名、公证与长时间 soak 缺失 |

## 已证明的不变量

- 原有 `npm start`、BAT、VBS 和桌面脚本没有改动。
- 新入口不自动执行修复；修改依赖需要明确 `--repair --yes` 或 UI 确认。
- 同一 repair/update 只有一个 operation owner，取消会终止受管进程树。
- 不同项目 clone 使用隔离 state profile。
- 更新文件在切换 current 前必须通过路径、symlink、大小、SHA-256、签名（signed 模式）和 runtime closure 验证。
- 新版本未发布 ready 时 current 回滚到上一版本。
- `styles/themes.css` 始终未进入启动器提交。

## 当前无法由本机证明的发布证据

1. Windows PowerShell 5.1/7、NSIS 安装卸载、中文/空格/长路径真实运行。
2. Linux AppImage 冷启动、信号转发与更新 handoff。
3. macOS x64/arm64 签名、公证和隔离属性。
4. 生产公钥/证书的可信分发与轮换流程。
5. 真实断网、代理中断、磁盘耗尽、睡眠恢复。
6. 30–60 分钟首次安装/修复/更新人工 soak。

## 与 Hermes 的边界（对抗式结论）

本实现是 Hermes-inspired，而不是 Hermes 的等价移植。Hermes 的 Bootstrap Installer 是独立、可签名、可安装和可创建系统快捷方式的产品；当前 VCPChat Recovery UI 仍依赖源码树中的 Node/Electron 运行时，macOS `.app` 入口未签名，Windows/Linux 也尚无真实安装器快捷方式证据。阶段状态、取消、ready handoff、更新锁和回滚是架构借鉴，不应在发布说明中宣称“已经拥有 Hermes 的完整安装体验”。

这些缺口需要对应 runner、签名证书或发布基础设施。macOS 单机模拟测试不能替代它们，因此在证据到位前不得把整个 H0–H6 标记为生产发布完成。
