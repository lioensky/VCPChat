# VCPChat Installer 商业发布就绪矩阵

> 状态：进行中
> 最后更新：2026-08-21
> 原则：只有真实产物、真实平台、真实启动序列才能把对应条目标记为完成。

## 当前结论

Installer 已达到 macOS 源码优先垂直切片：全新 clean fork、无 `node_modules`、真实 `npm ci`、Electron native rebuild、deep Doctor、ready handoff。它尚未达到商业发布完成，因为签名、公证、Windows/Linux 实机和完整故障矩阵仍缺证据。

## 功能与证据

| 要求 | 当前证据 | 状态 |
|---|---|---|
| Hermes MIT 归属 | `LICENSE-HERMES`、`THIRD_PARTY_NOTICES.md` | 已完成 |
| 独立 native Installer | Tauri 2 release Mach-O、`.app`、`.dmg` | macOS 已完成 |
| 全新 fork 依赖安装 | 无 `node_modules` fork 经 Installer 增长到约 1.1 GB | macOS 已完成 |
| Electron 版本闭合 | lockfile Electron 41.10.4，项目 binary 可定位 | macOS 已完成 |
| native ABI 闭合 | 捕获 ABI 147/145 错误；修正 rebuild 后 deep Doctor `native-abi: pass` | macOS 已完成 |
| 原生模块损坏恢复 | 移走 `better_sqlite3.node` 后 deep Doctor fail；修复 manifest 后真实 rebuild，Doctor 恢复 pass | macOS 已完成 |
| 主程序 ready | 无既存实例冷启动输出完整 `process-started` → `renderer-ready`、`Published managed bootstrap ready` 与 `VCPChat 已启动` | macOS 已完成 |
| Computer Use 主窗口 | clean fork 的 VCPChat 主窗口已真实打开，URL 指向该 fork `main.html`；Installer 退出码 0 且退出，Electron 与 VCP-CDS 保持运行 | macOS 已完成 |
| dirty 源码保护 | 用户可查看修改、命名 stash 后更新，或跳过更新启动现有版本；stash 记录精确 OID | 事务与隔离 Git 测试完成，真实 Tauri UI 复测待完成 |
| 依赖缺失恢复 | clean fork 实际执行 `npm ci` | macOS 已完成 |
| 重试不重复修复 | deep Doctor `12/0/0` 时跳过修复；Installer 生成的 Rust runtime 被 Git dirty 检查排除 | macOS UI 回归完成 |
| operation lock | 单 owner、live lock 拒绝、stale PID 恢复 | Rust 测试完成 |
| staging/current/rollback | Rust 原子 pointer 与 Node update-manager 序列测试 | 已实现，尚未连接正式 UI 更新入口 |
| 源码更新状态 | Welcome 页只读显示 branch/upstream/ahead/behind；明确确认后才 fetch，并仅接受 fast-forward | 已实现 |
| dirty 更新回滚 | 更新成功后按 OID apply/drop；冲突保留 stash 并清理 unmerged tree；Doctor 失败回到原 HEAD 后恢复 tracked/untracked | 隔离 bare remote/clone 3 路测试完成 |
| 签名更新 manifest | Ed25519/HTTPS/闭包测试 | 测试完成，发布密钥未配置 |
| macOS 签名与公证 | 当前仅本地/adhoc build | 未完成 |
| Windows 安装/启动/更新 | 配置和边界测试，不是 Windows 实机 | 未完成 |
| Linux 安装/启动/更新 | 配置和边界测试，不是 Linux 实机 | 未完成 |
| CI 跨平台 bundle 矩阵 | `.github/workflows/vcpchat-installer.yml` 覆盖 macOS/Windows/Linux 产物构建与 artifact 上传 | 已配置，尚待 CI 实跑 |
| 上游 Windows 启动器兼容 | `VCP_STARTUP:` 进度帧已接入；最终成功仍由 operation-scoped ready record 决定 | 协议完成，Windows 实机待验证 |
| Tauri 取消与日志 | repair/Doctor/handoff 共用单一 child owner；按钮取消与窗口关闭均终止进程树并等待 child quiescence；stdout/stderr 写入 Installer 日志 | 本机代码与测试完成，长任务关闭故障 UI 待复测 |
| 无源码安装 | 未接线时明确失败，不再以 development manifest 产生假成功 | 安全边界完成，真实 payload 安装待实现 |
| clean fork ABI 自愈 | 无 `node_modules` → 961 packages → ABI 147/145 fail → targeted rebuild → Doctor native-abi pass | macOS 已完成 |
| VCP-CDS runtime 自愈 | `--include-rust` 构建并部署 darwin-arm64 runtime；最终 Doctor `pass 11 / warn 0 / fail 0` | macOS 已完成 |
| ready 后进程交接 | launcher 在 operation-scoped ready 后 `unref` Electron；Installer 退出且主程序继续运行 | macOS 已完成 |
| Rust audio runtime 自愈 | 修复 Cargo target 依赖边界；构建 `audio_engine/bin/darwin-arm64/audio_server`，启动日志出现 `RUST_AUDIO_ENGINE_READY` | macOS 已完成 |
| 最终环境 Doctor | Electron ABI、VCP-CDS、audio runtime、vendor closure、filesystem、lock 均通过 | `pass 12 / warn 0 / fail 0` |
| 可复现构建输入 | Installer 独立 npm `package-lock.json` 与 Tauri `Cargo.lock` 纳入源码；CI 将 matrix bundles 直接传给 Tauri CLI | 已完成，跨平台 CI 实跑待证据 |

## 商业发布阻断项

1. Developer ID、hardened runtime、entitlements、公证和 stapling 的真实证据。
2. Windows x64/arm64 runner：NSIS/MSI、WebView2、代码签名、native ABI、ready、更新回滚。
3. Linux x64/arm64 runner：AppImage、桌面入口、native ABI、信号/取消和 ready。
4. 运行中应用必须阻止更新；dirty 更新 UI 已要求用户明确选择，但仍需真实 Tauri 冲突/取消 UI 证据。
5. 断网、代理中断、磁盘不足、损坏 lockfile、损坏 native module、取消、强退、stale lock、ready timeout 的真实故障矩阵。
6. 发布密钥托管、更新公钥轮换、证书过期、日志脱敏、SBOM 和第三方许可证随包分发。
7. 上游 Windows 启动器内嵌字体在许可证和商业分发授权确认前不得进入正式安装包。

## 发布声明规则

- macOS 证据不能外推到 Windows/Linux。
- 单元测试不能替代签名、公证和真实安装。
- `npm ci` 成功不能替代 Electron ABI probe。
- Electron 进程存在不能替代 operation-scoped ready record。
- UI 显示“准备完成”前，deep Doctor 必须为零 blocking failure。
