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
| typed A/B 快速连续编辑 | A、B 均持久化 | typed owner 回归测试通过：旧调用返回 `stale` 但 durable commit 推进 revision，后续 patch 使用新 revision；真实 DOM owner 仍需 Electron 证据 |
| typed 与 legacy 并发 | 未触碰字段不被覆盖 | 设置页 legacy、filter/chat/ui/event/middle-click/appearance 调用均转 path ops；外部插件保留兼容快照 |
| in-flight 追加 patch 后首个失败 | 失败 batch retained，后续 flush 可重试 | retained batch 代码已补；owner 时序仍需 Electron 证据 |
| 旧 operation 迟到结果 | 不改变当前 draft/status | coordinator matching-terminal test 通过 |
| cancelled/stale/conflict | 保持明确非 success 语义 | adapter 单测通过 |
| flush | 等待真实 durable completion | coordinator barrier test 通过 |
| dispose | drain 后再释放 owner/listener | coordinator + Electron-facing contract 通过；SettingsBridge destroy 仅在成功 drain 后释放 typed owner |
| lock/CAS/RMW | 双实例不互相覆盖，冲突不写盘 | 双实例测试通过 |
| 外部文件修改 | dirty draft 保留并进入 conflict | manager watcher、renderer 标记与 coordinator aggregate conflict 已接入；JSDOM contract 通过 |
| conflict UX | reload external / keep draft retry | API、操作条与 reload channel contract 通过；retry 仅在 owner 清除冲突标记后解除 coordinator conflict |
| close/reopen/reload | 无白屏、无草稿丢失 | Electron smoke 未形成可采信退出证据 |

## 已知缺口

当前不能宣称所有业务模块都已迁移到 coordinator：Prompt Manager 等外部/非设置页调用仍保留完整快照兼容入口。Global Settings coordinator 已具备独立 durable base、local draft、pending path operations、revision、failure/conflict 状态；跨进程 lock race、packaged Electron、Windows/macOS、GPU/DPI 和人工 soak 仍无证据。

## 验证命令与结果

- `node --check`：相关 JS 通过。
- `git diff --check`：通过。
- focused settings/UI tests：coordinator 12/12、Electron-facing 4/4、整体设置/UI 58/58 通过；新增 typed A/B durable-revision、retry conflict 和 reload cancellation 回归。
- `npm run check:uiux:artifacts`：通过（4 个必需生成产物）。
- `npm run check:uiux`：通过（别名指向 artifact gate）。
- `npm run test:settings-wa-electron`：通过；包含 4 个 JSDOM lifecycle contracts，以及真实 Electron CDP gate 的 8 个场景（shell/nav/search、深浅主题截图、IPC 保存、reload 恢复）。
- `node scripts/test-electron-windows-matrix.mjs`：在当前 macOS 主机生成 evidence，Windows 行明确 `skipped`（host-required），未伪造 Windows 通过。
- `VCPCHAT_MANUAL_SOAK_MINUTES=0.001 VCPCHAT_MANUAL_SOAK_INTERVAL_SECONDS=0.001 node scripts/test-electron-manual-soak.mjs`：生成 23 个无错误 checkpoint；该工具仍明确要求人工 checklist，不能把短时观察升级为完整 soak 通过。
- `node scripts/test-ui-system.mjs`：UI system contract assertions pass; the JSDOM process leaves existing requestSubmit/timer activity alive and does not produce a stable terminating exit here.
- `npm run test:ui-system`：wrapper reaches the passing UI contract stage but cannot provide a stable final exit because of the same open-handle behavior.
- `npm run test:electron-ui-apps`：已修正动态壁纸插件契约。smoke 现在以 `listEnabledFrontendPlugins()` 为准：当前 `.block` manifest 被明确审计为 disabled，并验证未注入插件 DOM；只有启用 manifest 才等待注册和控制面板。修复后测试越过原 534 行阻塞，但随后在设置页增强保存栏等待处超时（`scripts/test-electron-ui-apps-smoke.mjs:1420`），因此该门禁仍不能宣称通过，也不能替代 packaged Electron 验收。动态壁纸插件属于既有独立 UI/plugin surface，与 autosave coordinator 无关。

## 对抗性复核结论（2026-09-02）

与 DeepSeek Harness 的 `write-behind`/settings-file 原则逐项对照后，发现并修复一项真实缺陷：typed 串行写入中，较早请求的成功结果此前会因 generation 变旧而直接丢弃，导致后续 patch 使用旧 revision。现在 durable success 与调用方的 `stale` 语义分离：提交仍推进 base/revision、清理已提交 ops，只有当前调用方不再拥有发布权时才返回 `stale`；回归测试验证 A/B 两次编辑分别使用 `r1`、`r2` 且无 stranded pending。

复核还发现 renderer 不能把提交前 patch 当作 durable snapshot：主进程验证器可能钳位或规范化该值。`recordCommit()` 现优先采纳 `success.settings`，再只重放尚未提交的 path operations；typed base 同样以该 response 为准。新增回归覆盖已验证值和下一批草稿的分叉风险。

随后又完成合并前阻塞修复：原子写入改用随机独占临时文件；手动提交会取消遗留 legacy debounce，自动保存通过瞬时提交标记保持窗口语义；Toast 生命周期测试增加调度裕量。当前 Global Settings 本地完成度约 **95%**。剩余证据缺口仍是 Windows 原生 runner、packaged Electron、GPU/DPI 几何矩阵、长时人工 soak，以及 native `fs.watch` 驱动的真实 Electron 外部冲突交互。不得把 macOS 解包 Electron或短时诊断记录外推为这些平台/场景已通过。

验收结论：Global Settings 自动保存协调器已合并回 `exp/settings-schema`，在本地源码、focused tests、锁/CAS/RMW、真实 macOS Electron CDP（保存、重载、布局、搜索、主题截图）和 UI artifact gate 上完成；目标仍保持 **active**。可以开 Draft PR，但在 chat/UI 全量门禁、插件 smoke 契约、packaged Electron、Windows、GPU/DPI 和人工 soak 证据补齐前，不应标记 Ready for merge。
