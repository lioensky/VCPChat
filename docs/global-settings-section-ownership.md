# Global Settings Section Ownership

本清单是 G4 模块化拆分的静态边界。它描述 presentation owner，不创建第二份 durable state。

| section key | canonical root/content | current owner | generated patterns | legacy responsibilities retained | retirement condition |
|---|---|---|---|---|---|
| `user-identity` | `#globalSettingsForm` / identity rows | `settings-bridge` typed field + ColorPair owner | Input, Field, ColorPair, Button | avatar file, color extraction, save collect | all identity projection/listeners covered by typed owner |
| `server-connection` | `#globalSettingsForm` / connection rows | generic Input + typed Settings projection | Input, Field | URL normalization and global save command | connection CSS/listener audit has no competing writer |
| `appearance-settings` | `#globalSettingsForm` / appearance rows | appearance typed projection + primitive owners | Select, Range, Toggle, Choice, Input, Button | Appearance Studio capability | all profile fields use one section controller |
| `render-settings` | `#globalSettingsForm` / render rows | typed projection + legacy chat-boundary handlers | Select, Input, Toggle, Choice | frozen chat rendering semantics | chat-boundary owner explicitly separated |
| `selection-assistant` | `#globalSettingsForm` / assistant rows | typed projection + Rust/assistant capability adapters | Select, Input, Toggle, Textarea | capability discovery and diagnostics | assistant capability errors remain unchanged |
| `voice-settings` | `#globalSettingsForm` / voice rows | Choice + generic Input + voice capability owner | Choice, Input | provider discovery/default display values | mode/credentials conditional paths have one owner |
| `advanced-features` | `#globalSettingsForm` / advanced rows | typed projection + Toggle/Range owners | Toggle, Input, Range | feature capability commands | each boolean/numeric row has one owner |
| `quick-actions` | `#globalSettingsForm` / quick-action rows | typed projection + legacy chat command handlers | Toggle, Input, Select, Textarea | middle-click/chat command behavior | presentation-only paths separated from frozen command behavior |

## Rules

1. 每个 section 只能有一个 presentation owner；`settingsManager`、IPC 和 persisted key 仍是业务权威。
2. `settings-bridge.js` 暂时继续作为入口装配器；拆分只能在 source-equivalence 门禁支持静态追踪后合入。
3. `render-settings` 与 `quick-actions` 的业务行为属于冻结聊天边界，不能因为 UI 收口而重构。
4. owner 只能持有 listener、observer、primitive 和 projection；不得新增 durable store。
5. 旧路径只有在对应 section 的真实 Electron 回归通过后才能删除。

## 当前状态

G2 身份颜色镜像已完成首个净删除（提交 `2a69fb01`）。G1 连接字段和 G3 语音字段已确认已有 generated consumer，无需重复挂载。其余 section 依次按本表推进。
