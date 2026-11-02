# TavernSRPG 战棋沙盘遥控器

## 上游来源声明

本插件驱动的战棋引擎与沙盘界面移植自 **freezer** ([@DoubleOpenFreezer](https://github.com/DoubleOpenFreezer)) 开发的开源项目 **[Tavern-SRPG](https://github.com/DoubleOpenFreezer/Tavern-SRPG)** (`v0.26.0`)，详见 `../../../Gamemodules/srpg/README.md`。

## 架构类型

- `pluginType`: `hybridservice` (`protocol: "direct"`)
- 直接同进程引用 `Gamemodules/srpg/service.cjs`，与 VCPgame 游戏大厅中的 **「Tavern-SRPG 战棋沙盘」** 独立窗口共享同一个 `SessionStore` 实例。
- Agent 执行任何战棋指令后，已打开的沙盘窗口会通过 `srpg:update` 实时自动刷新；用户在窗口中的手动修改也会实时写回同一存档。

## 核心命令 (`tool_name: "TavernSRPG"`)

- `GetState`：读取当前完整战场态势（ASCII 地图网格、地形图例、全员 HP/属性/韧性/冷却、最近敌我距离、天刻回溯存档点）。
- `OpenWindow`：打开或聚焦独立战棋沙盘窗口。
- `StartBattle`：恢复当前战役，或传入 `overwrite=true`、`mapId`/`mapName`、`profileId` 开启新战役。
- `Move`：`unit`（如 `P1` 或 `凯伊`）、`x`、`y`（1-based 坐标）。
- `Attack`：`unit`、`target`（如 `E1`），可选先移动到 `x`、`y`，可选 `reaction`（`counter`/`defend`/`none`）。
- `Skill`：`unit`、`skill`（技能名或 ID），`target` 或 `tx`、`ty`（1-based 目标格坐标），可选先移动到 `x`、`y`。
- `Wait`：`unit`，可选 `x`、`y`。
- `EndTurn`：结束我方阶段，自动结算敌方/友军行动并记录新回合回溯存档点。
- `Manual`：无视移动与规则限制直接修改沙盘（`type='move'|'stat'|'spawn'|'remove'|'restore'|'terrain'|'fog'|'defeatEnemies'`），支持 `note` 附加实机战况备注。
- `BatchCommands`：批量执行多行战场指令（`damage / heal / status / unstatus / move / retreat / spawn / terrain / end`）。
- `Rewind`：回溯至指定存档点（`checkpointId='cp1'|'latest'|'start'`）。
- `ImportDesign`：导入 JSON 格式的新地图/单位/兵种/地形设计。
- 支持 `command1`、`command2`... 连续编号串行批处理（最多 32 步）。