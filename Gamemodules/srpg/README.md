# Tavern-SRPG · VCP 战棋战术沙盘

## 上游开源来源与致谢声明 (Upstream Attribution & Notice)

本模块核心战棋引擎与编辑器 UI 移植自开源项目 **Tavern-SRPG**：

- **上游项目名称**：Tavern-SRPG
- **原作者 (Author)**：`freezer` ([@DoubleOpenFreezer](https://github.com/DoubleOpenFreezer))
- **上游 Git 仓库**：<https://github.com/DoubleOpenFreezer/Tavern-SRPG>
- **移植基线版本**：`v0.26.0`
- **VCPChat 适配与双端同源桥接**：云乌 (`@78776`) & Nova (迟明)

> **版权与使用说明**：
> `src/` 目录下的战棋核心逻辑（`engine.js`、`manual.js`、`history.js`、`context.js`、`narrator.js`、`commander.js`、`commands.js`、`designer.js`、`profiles.js` 等）及 `style.css` 均归属于原作者 **freezer (DoubleOpenFreezer)**。若上游仓库更新或追加特定开源许可证条款，本目录内对应上游源码文件均严格遵循上游作者的授权协议。

---

## VCPChat 移植架构与改动说明

原版 `Tavern-SRPG` 为 SillyTavern 浏览器端扩展插件。在移植入 `VCPChat/Gamemodules/srpg` 时，做了以下解耦与本地化适配：

1. **剥离外部宿主依赖 (`ui.js` & `index.html`)**：
   - 无需运行 SillyTavern，在独立窗口内通过轻量级兼容上下文桥接 `src/st.js`，完整保留原版全部 8 个功能标签页（**战场、资料卡、单位、兵种、地形、地图、AI 设计、设置**）。
   - 适配 VCPChat 本地离线 `vendor/fontawesome-v6/fontawesome-v6.css` 与严格 CSP 策略（`default-src 'self'`），解除原版 460px 右侧小浮窗宽度限制，支持独立窗口全屏自适应铺满。
2. **主进程双端同源状态机 (`service.cjs` & `session-store.cjs` & `preload.cjs`)**：
   - 状态持久化于 `app.getPath('userData')/TavernSRPG/sessions`（写临时文件后原子 rename）。
   - 支持人类在独立沙盘窗口点击操作（通过 `srpg:sync` 自动保存）与 Agent 在聊天中调用 `TavernSRPG` 工具（通过 `srpg:command` 结算并通过 `srpg:update` 实时广播刷新前端窗口）**毫秒级双向同源同步**。
3. **实机伴侣沙盘模式（内置《万缕千丝》凯伊线首战预设资料卡 `profile_fe_kai`）**：
   - 支持在窗口开启 **「手动修改」** 或由 Agent 调用 `Manual` 指令，无视移动限制直接同步外部战棋游戏（如 NS2 火纹实机）的单位坐标、剩余 HP、属性、地形与增援，并附带实机备注。
   - 支持 **「战斗回溯（天刻之白沙）」**（最多保留 20 个回合快照存档点，随时时光倒流并自动备份回溯前时间线）。

---

## 启动与验证

- **从游戏大厅启动**：打开 `VCPgame 游戏大厅` → 点击 **「♟ Tavern-SRPG 战棋沙盘」**（`gameId: 'srpg'`）。
- **由 Agent 遥控启动/操作**：调用 `TavernSRPG` 插件（详见 `../../VCPDistributedServer/Plugin/TavernSRPG/README.md`）。
- **自动化测试**：
  ```bash
  node --test tests/game-launcher.test.js tests/srpg-sandbox.test.js
  ```