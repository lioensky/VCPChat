# VCPChat Bootstrap M0 契约

本文件冻结托管启动 M0–M2 使用的最小协议。完整长期路线见 `docs/vcpchat-managed-launch-architecture.md`。

## 边界

- Bootstrap 只拥有启动诊断、启动互斥、主进程派生、ready 等待和脱敏诊断。
- M0–M2 不执行 `npm ci`、`npm install`、`electron-rebuild`、Cargo build、Git 更新或用户配置修复。
- Bootstrap 状态目录与项目 `AppData` 分离；聊天、助手、插件和设置不是启动修复目标。
- 主应用仍由现有 `main.js` 启动；`npm start` 和现有 VBS/BAT 在 M2 保持兼容。
- 插件 Loader、动态壁纸和子页面运行方式不属于 Bootstrap 生命周期。

## 状态目录

可通过 `VCPCHAT_STATE_DIR` 显式覆盖。默认值：

- Windows：`%LOCALAPPDATA%/VCPChat/bootstrap`
- macOS：`~/Library/Application Support/VCPChat/bootstrap`
- Linux：`$XDG_STATE_HOME/vcpchat/bootstrap`，未设置时使用 `~/.local/state/vcpchat/bootstrap`

目录只存放：

- `operation.lock`：启动/未来修复操作的跨进程所有权；
- `ready-<operationId>.json`：本次启动的 ready 记录；
- `diagnostics/*.json`：脱敏启动诊断。

## Operation Lock schema v1

```json
{
  "schemaVersion": 1,
  "operationId": "vcpchat-...",
  "pid": 1234,
  "parentPid": 1200,
  "kind": "managed-launch",
  "targetRevision": "optional git sha",
  "startedAt": "ISO-8601",
  "stage": "validating"
}
```

锁只有在 PID 存活且未超过最大年龄时才算 busy。损坏、死 PID 或超龄锁属于 stale；启动器记录诊断后可移除。锁释放必须校验 `operationId`，不能删除另一个进程后来取得的锁。

## Ready schema v1

```json
{
  "schemaVersion": 1,
  "operationId": "vcpchat-...",
  "pid": 5678,
  "buildId": "optional revision",
  "readyAt": "ISO-8601",
  "checks": {
    "mainWindow": "ready",
    "preload": "ready",
    "renderer": "ready"
  }
}
```

启动器只接受路径和 payload 中都与本次 `operationId` 相同、PID 与派生 Electron 进程一致、核心检查均为 `ready` 的记录。若 Electron 将请求交给已运行的主实例，则接受同一派生 PID 发布的 `mainWindow: delegated` 终态。旧 `.vcp_ready` 继续服务 NativeSplash，但不作为 Managed Launcher 的成功证据。

## Doctor report schema v1

```json
{
  "schemaVersion": 1,
  "ok": true,
  "generatedAt": "ISO-8601",
  "projectRoot": "/absolute/path",
  "platform": "darwin",
  "arch": "arm64",
  "checks": [],
  "summary": { "pass": 0, "warn": 0, "fail": 0, "skip": 0 }
}
```

每个 check 包含稳定 `id`、`status`、用户可读 `message`，失败时包含 `code`。Doctor 默认只读；`--json` 只向 stdout 输出报告，诊断文本写 stderr。

## M2 成功定义

Managed Launcher 只有在以下条件同时成立时返回成功：

1. Doctor 没有阻塞级失败；
2. 获得本次 operation lock；
3. 从项目内 Electron binary 成功派生主进程；
4. 主 renderer 完成初始化并发布本次 operation ID 的 ready record；
5. ready PID 与派生进程 PID 一致；
6. ready 等待期间进程没有提前退出。

超时、提前退出和 spawn 失败都生成诊断并返回非零退出码；它们不会自动升级为依赖重装。

## M3–M8 独立入口边界

- `npm run repair:managed` 与 `npm run bootstrap -- repair` 默认只读；只有用户显式传入 `--apply --yes` 才能修改依赖或构建产物。
- 修复、更新和恢复 UI 使用 `managed-*` operation lock；不会取得或删除旧启动脚本、NativeSplash 或主应用自己的 ready marker。
- `npm start`、`start.bat`、`start debug.bat`、所有 VBS 入口和既有桌面启动路径不调用 Bootstrap，也不被 Bootstrap 改写。
- M4 的进度帧是独立 NDJSON 协议；renderer 只能读取结构化状态，不能获得包管理器 shell 权限。
- M5 runtime closure 在打包 `afterPack` 阶段生成；M6 recovery UI 使用独立 preload/context isolation，不加载主应用插件或用户数据业务模块。
- M7 更新只操作 Bootstrap state root 下的版本目录与 `current.json`，用户聊天、助手、插件和设置目录不在更新目标内。
- M8 的 Windows、签名包和人工 soak 没有真实 runner 证据时必须显示为待验。
