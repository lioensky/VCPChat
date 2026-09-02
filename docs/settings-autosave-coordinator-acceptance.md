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
| typed A/B 快速连续编辑 | A、B 均持久化 | path operation 单测通过；真实 DOM owner 待补 |
| typed 与 legacy 并发 | 未触碰字段不被覆盖 | manager 双实例 CAS 通过；legacy owner 待补 |
| in-flight 追加 patch 后首个失败 | 失败 batch retained，后续 flush 可重试 | 已补代码，owner 时序待补 |
| 旧 operation 迟到结果 | 不改变当前 draft/status | adapter 单测通过；coordinator 迟到事件待补 |
| cancelled/stale/conflict | 保持明确非 success 语义 | adapter 单测通过 |
| flush | 等待真实 durable completion | dispose/flush 时序测试待补 |
| dispose | drain 后再释放 owner/listener | 代码已修，Electron 待验证 |
| lock/CAS/RMW | 双实例不互相覆盖，冲突不写盘 | 双实例测试通过 |
| 外部文件修改 | dirty draft 保留并进入 conflict | manager watcher + renderer 标记已接入；Electron 待验证 |
| conflict UX | reload external / keep draft retry | API 与按钮已接入；交互/Electron 待验证 |
| close/reopen/reload | 无白屏、无草稿丢失 | Electron 证据缺失 |

## 已知缺口

当前仍不能宣称完整 DeepSeek Harness 对齐：coordinator 尚未成为所有直接 `chatAPI.saveSettings()` 调用的唯一 durable owner；冲突动作尚未提供 UI；typed draft/base/committed 三层状态仍未完全分离；跨进程 lock race、packaged Electron、Windows/macOS、GPU/DPI 和人工 soak 尚无证据。

## 验证命令与结果

- `node --check`：相关 JS 通过。
- `git diff --check`：通过。
- focused settings tests：当前 worktree 缺少 `fs-extra` / `jsdom`，未能完整启动。
- `npm run check:uiux`：仓库无该脚本；可用脚本为 `check:uiux:artifacts`。
- `npm run test:settings-wa-electron`：仓库无该脚本。
- `npm run test:ui-system`：被缺少 `jsdom` 阻断。

验收结论：本批完成了关键数据安全修复，但在补齐真实依赖、跨 owner race、外部冲突 UI 和 Electron 生命周期证据前，状态为 **Needs Further Work**，不可标记为 PR-ready。
