# VCPChat 设置自动保存交接

## 1. 项目背景

VCPChat 是一个 Electron 桌面端 AI 聊天客户端。本次工作聚焦 Global Settings 设置页的自动保存：设置页同时存在 legacy 表单、typed 字段、forum 等多个 owner，保存请求还要经过 renderer、preload/IPC、主进程 `AppSettingsManager`，最终写入用户的 `settings.json`。

原实现把多个 owner 的 dirty/status 和完整快照分散维护，容易出现快速编辑丢字段、不同 owner 互相覆盖、关闭时异步写入未完成、失败后草稿丢失、外部修改被静默覆盖等问题。本分支参考 DeepSeek Harness 的 write-behind/settings-file 设计，收口为一个设置页保存协调器，同时保持现有用户设置文件格式兼容。

## 2. 当前代码状态

- 分支：`feat/settings-autosave-coordinator`
- 当前提交：`8c2ab22c`
- 基线分支：`exp/settings-schema`
- 独立 worktree：`/Users/asahi/Documents/Codex/vcpchat-settings-autosave-coordinator`
- 原工作树未作为本次施工目标，不应直接修改。

主要入口：

- 协调器：`modules/ui-system/settings/save-coordinator.js`
- typed owner：`modules/ui-system/typed-field-owners.js`
- legacy autosave：`modules/ui-system/settings/autosave.js`
- renderer bridge：`modules/ui-system/settings-bridge.js`
- 主进程 IPC：`modules/ipc/settingsHandlers.js`
- 主进程持久化：`modules/utils/appSettingsManager.js`
- Global Settings manager：`modules/global-settings-manager.js`
- Electron 验收脚本：`scripts/test-settings-wa-electron.mjs`

## 3. 现在的保存模型

`SettingsSaveCoordinator` 是 Global Settings 的单一保存 owner，维护 durable base、local draft、path-level pending operations、revision、operation identity、失败重试和 conflict 状态。typed 字段提交 `set/unset` 路径操作，不再用旧的完整快照重建设置。

主进程在独占锁内重新读取文件，执行 expected-revision CAS 和 read-modify-write，通过临时文件校验后原子替换。返回值区分 `success`、`failed`、`cancelled`、`stale` 和 `conflict`，旧 operation 的迟到结果不能污染当前 draft/status。`flush()` 和 `dispose()` 都是 durable barrier；关闭设置页只有在 barrier 成功后才释放 owner。

外部文件变化或 revision 不一致会保留本地草稿并暂停自动提交。界面提供“重新加载外部设置”和“保留草稿并重试”；无重叠 patch 可以在新 base 上重放，重叠字段保持冲突。

这与 DeepSeek Harness 的关键对照点一致：immutable draft、path mutation、serialized queue、revision/CAS、锁内 RMW、atomic persistence、explicit flush barrier、failure retention 和 watcher reconciliation。没有引入 Cordis/React，也没有重写聊天业务、插件 Loader、Rust 或头像独立协议。

## 4. 已完成和已验证

本地 focused settings/UI 测试、锁/CAS/RMW 测试、UI artifact gate 通过；`test:settings-wa-electron` 的 JSDOM contract 和真实 macOS Electron CDP 场景也通过，覆盖设置壳、分类切换、搜索、主题截图、真实 IPC 保存和 reload 恢复。当前记录为 **Global Settings 本地功能基本完成，约 92%**。

重点已覆盖：快速 typed 编辑、跨 owner 字段保留、失败批次留存、迟到结果隔离、明确 stale/cancelled/conflict 语义、flush/dispose 等待、聚合 dirty/status、锁竞争、CAS 冲突、外部修改和冲突操作条。

## 5. 尚未闭合的证据

这不是“所有发布环境均已验收”：

- packaged Electron 安装包的完整 close/reopen/reload/timeout/conflict 流程还缺可采信证据；
- Windows 原生 runner、macOS packaged 证据、GPU/DPI 多档几何验证未完成；
- 长时间人工 soak 尚未完成，现有短时观察不能替代它；
- native `fs.watch` 驱动的真实 Electron 外部冲突交互仍需补证据；
- `npm run test:ui-system` 的断言通过，但 JSDOM 既有 open handles 使包装命令不能稳定退出；
- Prompt Manager 等非 Global Settings 调用仍使用兼容的完整快照入口，尚未全部迁移到 coordinator。

不要把解包 Electron、短时 soak 或当前 macOS 结果外推为跨平台发布通过。启动时出现的 Rust/VCP-CDS/node-pty 缺失等环境噪音也需与设置功能证据分开记录。

## 6. 建议接手顺序

1. 先读本文件、`docs/settings-autosave-coordinator-development-plan.md` 和 `docs/settings-autosave-coordinator-acceptance.md`。
2. 再沿 `save-coordinator.js` -> `settings-bridge.js` -> `settingsHandlers.js` -> `appSettingsManager.js` 阅读一次完整保存链路。
3. 对照 DeepSeek Harness：`packages/session/session-persistence/src/write-behind.ts`、`packages/settings/settings/src/index.ts`、`packages/settings/settings-file/src/index.ts`。
4. 运行 `npm run check:uiux`、`npm run test:settings-wa-electron`，再按验收记录补 packaged/cross-platform 证据。
5. 重点继续审查 owner 生命周期、外部 watcher 回声抑制、失败后重试调度，以及所有 `chatAPI.saveSettings()` 调用的边界。

## 7. 交接结论

当前分支已经解决了 Global Settings 自动保存的主要并发和持久化缺陷，适合继续做 adversarial review 和发布证据补齐；不应宣称整个 VCPChat 设置体系或所有平台已经完成。任何后续修改都应保持现有 `settings.json` 用户字段结构兼容，并优先通过 coordinator/operation-aware 协议扩展，而不是重新引入 owner 间隐式共享状态。
