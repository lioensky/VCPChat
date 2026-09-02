# 设置页自动保存协调器验收记录

## 目标

验证 Global Settings 的自动保存在连续编辑、跨 owner 并发、关闭、失败重试、外部修改和 renderer 重载场景下，不丢草稿、不静默覆盖，并且只有 durable completion 才能报告 `success`。

## 已施工合同

- coordinator 统一聚合 `conflict > error > saving > dirty > saved > idle`。
- close 路径先 drain 保存，再释放 typed/legacy owner；结果监听器在 drain 完成前保持有效。
- legacy、typed field、typed forum flush 均返回 Promise；失败批次保留在 pending。
- typed settings 使用 path operations（`set` / `unset`），主进程在锁内 fresh read、CAS、read-modify-write，并保留原子临时文件替换。
- `load-settings` 返回非用户字段 `__vcpSettingsRevision`，renderer 将其作为 durable base revision。
- stale/cancelled 结果不再映射为成功或普通错误。

## 验收矩阵

| 场景 | 期望 | 证据状态 |
|---|---|---|
| typed A/B 快速连续编辑 | A、B 均持久化 | path operation 与 serialized queue 通过；真实 DOM owner 仍需 Electron 证据 |
| typed 与 legacy 并发 | 未触碰字段不被覆盖 | manager 双实例 CAS 通过；legacy full-snapshot 兼容调用仍有迁移缺口 |
| in-flight 追加 patch 后首个失败 | 失败 batch retained，后续 flush 可重试 | retained batch 代码已补；owner 时序仍需 Electron 证据 |
| 旧 operation 迟到结果 | 不改变当前 draft/status | adapter 单测通过；coordinator 迟到事件待补 |
| cancelled/stale/conflict | 保持明确非 success 语义 | adapter 单测通过 |
| flush | 等待真实 durable completion | dispose/flush 时序测试待补 |
| dispose | drain 后再释放 owner/listener | 代码已修，Electron 待验证 |
| lock/CAS/RMW | 双实例不互相覆盖，冲突不写盘 | 双实例测试通过 |
| 外部文件修改 | dirty draft 保留并进入 conflict | manager watcher + renderer 标记已接入；Electron 待验证 |
| conflict UX | reload external / keep draft retry | API 与按钮已接入；交互/Electron 待验证 |
| close/reopen/reload | 无白屏、无草稿丢失 | Electron smoke 未形成可采信退出证据 |

## 已知缺口

当前仍不能宣称完整 DeepSeek Harness 对齐：coordinator 尚未成为所有直接 `chatAPI.saveSettings()` 调用的唯一 durable owner；冲突动作尚未提供 UI；typed draft/base/committed 三层状态仍未完全分离；跨进程 lock race、packaged Electron、Windows/macOS、GPU/DPI 和人工 soak 尚无证据。

## 验证命令与结果

- `node --check`：相关 JS 通过。
- `git diff --check`：通过。
- focused settings/UI tests：47/47 通过（临时复用现有 worktree 的依赖目录，未写入目标分支）。
- `npm run check:uiux:artifacts`：通过（4 个必需生成产物）。
- `npm run check:uiux`：仓库无该脚本；可用脚本为 `check:uiux:artifacts`。
- `npm run test:settings-wa-electron`：仓库无该脚本。
- `npm run test:ui-system`：在既有 global input primitive fixture 断言失败，非本批 autosave 合同断言。
- `npm run test:electron-ui-apps`：启动后未在本机已有 Electron 实例环境中形成可采信的退出结果，不能替代 packaged Electron 验收。

验收结论：本批已完成 coordinator、path mutation、fresh CAS、双实例锁、外部 watcher 和冲突动作入口；由于仍有 legacy 兼容调用迁移、真实 DOM owner 时序、UI System 基线失败和 packaged/cross-platform Electron 证据缺口，状态为 **Needs Further Work**，不可标记为 PR-ready。
