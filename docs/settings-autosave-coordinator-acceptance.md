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
| typed 与 legacy 并发 | 未触碰字段不被覆盖 | 设置页 legacy、filter/chat/ui/event/middle-click/appearance 调用均转 path ops；外部插件保留兼容快照 |
| in-flight 追加 patch 后首个失败 | 失败 batch retained，后续 flush 可重试 | retained batch 代码已补；owner 时序仍需 Electron 证据 |
| 旧 operation 迟到结果 | 不改变当前 draft/status | coordinator matching-terminal test 通过 |
| cancelled/stale/conflict | 保持明确非 success 语义 | adapter 单测通过 |
| flush | 等待真实 durable completion | coordinator barrier test 通过 |
| dispose | drain 后再释放 owner/listener | coordinator + Electron-facing contract 通过 |
| lock/CAS/RMW | 双实例不互相覆盖，冲突不写盘 | 双实例测试通过 |
| 外部文件修改 | dirty draft 保留并进入 conflict | manager watcher、renderer 标记与 dirty guard 已接入；JSDOM contract 通过 |
| conflict UX | reload external / keep draft retry | API、操作条与 reload channel contract 通过 |
| close/reopen/reload | 无白屏、无草稿丢失 | Electron smoke 未形成可采信退出证据 |

## 已知缺口

当前不能宣称所有业务模块都已迁移到 coordinator：Prompt Manager 等外部/非设置页调用仍保留完整快照兼容入口。Global Settings coordinator 已具备独立 durable base、local draft、pending path operations、revision、failure/conflict 状态；跨进程 lock race、packaged Electron、Windows/macOS、GPU/DPI 和人工 soak 仍无证据。

## 验证命令与结果

- `node --check`：相关 JS 通过。
- `git diff --check`：通过。
- focused settings/UI tests：当前组合 15/15 + 33/33 通过；coordinator 新增 durable-state/release tests 通过。
- `npm run check:uiux:artifacts`：通过（4 个必需生成产物）。
- `npm run test:settings-wa-electron`：通过（2 个 settings lifecycle contracts；使用 JSDOM，不等同于 packaged Electron）。
- `npm run check:uiux`：仓库无该脚本；可用脚本为 `check:uiux:artifacts`。
- `npm run test:settings-wa-electron`：仓库无该脚本。
- `npm run test:ui-system`：在既有 global input primitive fixture 断言失败，非本批 autosave 合同断言。
- `npm run test:electron-ui-apps`：启动后未在本机已有 Electron 实例环境中形成可采信的退出结果，不能替代 packaged Electron 验收。

验收结论：Global Settings 自动保存协调器施工完成，核心 focused tests 与 Electron-facing contracts 通过，状态为 **Functionally complete locally**。PR 发布前仍需补 packaged Electron、跨平台、GPU/DPI 与人工 soak 证据；这些是环境验收缺口，不是本地实现已证明的行为。
