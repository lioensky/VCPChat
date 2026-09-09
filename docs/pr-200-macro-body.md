# [Draft] refactor(settings): 侧边栏设置声明式 Schema 渲染重构与设计系统收敛

## 📌 说明：当前处于 Draft 阶段（团队对抗性排查与深层找 Bug 阶段）

> **提示**：本 PR 当前为 **草稿（Draft）状态**。核心架构重构与所有自动化门禁已全量通过，目前正处于**真实多场景交互走查与对抗性深度找 Bug 阶段**，暂请勿合并。待各复杂边界用例充分收敛、验证无退化后，将转为 Ready for Review。

---

## 🎯 宏观定位与重构核心价值

本 PR 是继**“全局设置（`#globalSettingsForm`）成功完成声明式 Schema 改造”**之后，针对应用另一大核心设置体系——**侧边栏设置（助手设置 `#agentSettingsContainer` 与群聊设置 `#groupSettingsContainer`）的系统级架构现代化重构**。

本次重构从根源上清理了长期累积的历史技术包袱：
- **架构解耦**：彻底剥离旧管家（`settingsManager.js`）与历史桥接（`agent-settings-bridge.js`）的命令式 DOM 拼接，建立强类型 Schema 声明式驱动体系；
- **所有权独占**：确立并践行“单一所有权（Single Ownership）”契约，从机制上根除两套大脑抢占 DOM 造成的死锁；
- **样式收敛**：退役并删除了 `styles/setting/` 下全部 **16 个遗留样式表（共清理 9,000+ 行 legacy CSS）**，全面统一至 Design Tokens 单层样式体系；
- **净代码削减**：在大幅提升架构可维护性与扩展性的同时，实现**代码净减少 1,065 行**（-9,340 / +8,275），同时严守“视觉零退化（Visual Zero-Delta）”铁律。

---

## 🔍 重构背景：解决侧边栏历史四大结构性病根

在此前版本中，侧边栏设置由于经历多代业务迭代，累积了深层次的系统性缺陷：

1. **双重所有权冲突（Double Ownership）**：
   旧架构下 `sidebar-surfaces.js` 与 `settingsManager.js`（内部包含 30 余处 `addEventListener`）同时操作折叠手风琴与表单项。当用户触发点击时，两个监听器在**同一渲染帧内先后翻转状态 class**，导致相互抵消，高频出现“折叠卡死、点击无反应”的死锁 bug。
2. **命令式字符串拼接与脆弱的 DOM ID 契约**：
   大量采用动态模板字符串拼接 ID，极易因大小写不匹配或拼写脱靶导致样式静默失效（如 `#IdentityToggleHeader` vs `#identityToggleHeader`），排查成本极高。
3. **CSS 四代同堂与地质断层**：
   侧边栏样式四散在 16+ 个历史样式表中，多代样式的 `!important` 与负边距层层覆盖；在一个文件里修复样式，极易被另一个历史文件“暗中破坏”。
4. **测试环境与真机隔离脱节**：
   单元测试在隔离 JSDOM 环境中运行，无法发现同页面内两个控制器打架的死锁问题，容易产生“测试全绿、真机死锁”的假象。

---

## 🏛️ 三大架构改造支柱

### 支柱一：Schema 声明式渲染与单一所有权契约（Single Ownership）

- **Schema 表面化（Schema Surface）**：
  - 确立统一的侧边栏声明式渲染体系（`modules/settings/schema/sidebar-surfaces.js`）；
  - 将助手设置（身份、提示词、高级参数、正则过滤等）与群聊设置（基础信息、MiMo 导演提示词、顺序发言拖拽等）全面转化为声明式 Schema 描述与槽位挂载。
- **解除 `settingsManager.js` 的 DOM 装甲**：
  - 剥离其内部散落的全部命令式 DOM 拼接与监听逻辑，使 `settingsManager` 彻底回归纯粹的“业务状态持久化 / 数据读写 / 状态投影”核心职责；
  - 践行铁律：**“谁渲染 DOM，谁独占事件监听器”**，彻底终结两套大脑竞争导致的死锁；
  - 彻底退役 544 行历史臃肿桥接 `modules/ui-system/agent-settings-bridge.js`。
- **群聊槽位体系治理（Group Owned Slots）**：
  - 规范群聊模块的动态业务槽位（`modules/ui-system/settings/group-slots.js`），实现声明式容器与动态交互项（如发言顺序拖拽手柄、成员角色配置）的解耦与安全装配。

### 支柱二：样式系统大一统 —— 退役 16 个 Legacy 样式表，收敛至 Design Tokens

- **清偿巨额技术债务**：
  - 彻底删除 `styles/setting/` 目录下全部 16 个历史残留样式表（`settings-group-sections.css` 1449行、`settings-agent-sections.css` 1302行、`settings-agent-identity.css` 731行、`settings-agent-prompt.css` 559行等）；
  - 将侧边栏全部视觉规则统一收归现代单层样式表 `styles/ui-system/settings-sidebar.css`。
- **杜绝 `!important` 恶性竞争**：
  - 基于统一的 Design Tokens 驱动尺寸、圆角、阴影与主题色彩，消除地质断层，使样式具备可预测性。

### 支柱三：组件原语现代化与“视觉零退化”基线还原

- **轻量现代模型选择浮层（AgentModelPicker）**：
  - 引入基于 `PopupSelect` 的就地弹出选择器，替代阻断操作的旧版全屏模态框；
  - 具备多关键词不区分大小写 AND 实时筛选、热门/收藏/全部模型层级分类、行内实时星标收藏等现代化能力；
  - 保留展开面板时直观的摘要胶囊呈现。
- **像素级基线审计与视觉还原**：
  - 严守**“视觉零变化（Visual Zero-Delta）”**铁律，建立 Computed Style 样式快照与 CDP 双端对比基线；
  - 对照原版基线进行了对抗性审查与修正，确保基础信息卡片包裹、头像尺寸与 16px 圆角、全覆盖悬停相机遮罩、纯 CSS 45 度手风琴平滑旋转指示器等细节毫厘不差。

---

## 📊 变更指标一览

- **文件变动**：72 files changed
- **行数变化**：`+8,275 / -9,340`（**净减少 1,065 行**）
- **核心删除**：
  - 彻底移除了 16 个历史 legacy CSS 样式表；
  - 彻底删除了 544 行的 legacy 桥接 `agent-settings-bridge.js`；
  - 大幅瘦身 `settingsManager.js` 与 `grouprenderer.js`。

---

## 🛠️ 对抗性审查（Adversarial Audit）缺陷清零专项

在进入 Draft 阶段后，我们开展了深度的对抗性审查与缺陷清查，针对暴露的稳定性、交互与边界问题实施了彻底修复：

1. **Agent 删除链路重构（C1）**：
   - 重构 `modules/settingsManager.js` 中的 `handleDeleteCurrentItem`，提供活跃的托管 `LifecycleScope`；
   - 补全 `onAcknowledgedChange`（双向同步复选框勾选状态以动态解禁确认按钮）、`onConfirm` 与 `onCancel` 回调；
   - 在确认或取消后安全调用 `scope.dispose()` 释放弹窗与遮罩 DOM。
2. **去除测试绝对路径硬编码 & 自动化门禁接入（C2）**：
   - 清理所有交互测试与探针脚本中的本地绝对路径，全面改用 `import.meta.url` 动态推导仓库根目录；
   - 将 `tests/settings-elements-interaction.test.mjs` 与 `tests/group-settings-slots-static.test.mjs` 接入 `package.json` 的 `npm run check:uiux` 核心门禁。
3. **`invite_only` 邀请按钮显隐与样式复原（H1 & H2）**：
   - 修复 `main.html` 硬编码 `display: none` 导致的邀请按钮永不出现问题，改用 HTML 标准 `hidden` 属性；
   - 在 `modules/ui-system/settings/group-slots.js` 中纯粹通过 `.hidden` 进行逻辑切换，杜绝内联样式直接变异；
   - 在 `styles/ui-system/settings-sidebar.css` 中完整补齐邀请按钮与容器样式，遵循 Design Tokens 与 `html .vcp-ui-scope` 前缀约束。
4. **群组条件字段容器显隐覆盖问题（H3）**：
   - 在 `styles/ui-system/settings-sidebar.css` 中针对 `[data-schema-field]`、`.group-settings-field-shell` 使用 `:not([hidden])`，并显式为 `[hidden]` 与 `.hidden` 声明 `display: none`，零 `!important` 解决被 `display: flex` 穿透的问题。
5. **手风琴防双重翻转与 ID 大小写纠偏（H4）**：
   - 在手风琴 header 事件监听器中过滤子级按钮触发（`e.target.closest('button') && e.target !== header`），杜绝 Enter / Space 冒泡双翻转抵消；
   - 纠正 `contentNode` ID 拼接大小写漂移（如 `IdentityContent` -> `identityContent`）。
6. **保存链路数据完整性与异常保护（H5）**：
   - 补全 `customCss`, `cardCss`, `chatCss`, `avatarBorderColor`, `nameTextColor`, `disableCustomColors`, `useThemeColorsInChat`, `uiCollapseStates` 等全部 8 个自定义样式与状态字段的收集与持久化；
   - 表单 `submit` 改为异步并 `await` 保存流程，联动三态状态点提示保存中/完成/异常；
   - 增加了对 `electronAPI.saveAgentConfig` 返回值的错误校验与捕获，切 Agent 时定时器增加目标上下文校验，防止脏数据丢失。
7. **设置面错误边界与空安全保护（H6）**：
   - `modules/ui-system/settings-bridge.js` 增加 `try/catch` 错误边界，隔离单个分区渲染失败对全局的影响；
   - `modules/settingsManager.js` 对流式输出单选框等所有表单字段增加了空安全可选链与防御判断。
8. **模型选择器并发与按键交互优化（H7）**：
   - `modules/uiux/generated/primitives/popup-select.js` 键盘 Enter 选中逻辑排除收藏星标按钮；
   - `modules/uiux/generated/primitives/agent-model-picker.js` 引入并发执行队列，防止用户连续快速点击星标收藏时产生并发丢请求。
9. **Marker 注册表与 MountedSlots 内存释放（Medium）**：
   - `marker-registry.js` 补齐所有 schema 相关属性登记；
   - `settings-sidebar-runtime.js` 引入 Presentation Scope 销毁钩子，确保 `mountedSlots` 随生命周期自动注销，并提供 `unmountSettingsSidebarForm`。

---

## 🛡️ 质量工程与门禁守护矩阵

为确保大型重构的系统稳定性与防劣化，本次构建并全量通过了以下门禁：

- [x] **UI/UX 规范与原语测试**：`npm run check:uiux`（107/107 全部通过，包含金测与 20 项深度交互用例）
- [x] **架构所有权契约检验**：`npm run check:settings-ownership`（全分区归属校验通过，杜绝跨权操作）
- [x] **端到端与交互集成测试**：`node --test tests/settings-elements-interaction.test.mjs`（20/20 全部通过，覆盖防死锁、C1 删除、H4 冒泡、H5 保存字段及状态点）
- [x] **样式防劣化门禁**：
  - `npm run guard:ui-system`（25 CSS 文件，68 模块，760 图标校验通过）
  - `npm run guard:design-subtraction`（设计系统边界校验通过）
  - `npm run guard:classic-retirement`（遗留退役边界校验通过）
  - `npm run guard:classic-parity`（共享表面契约校验通过）
  - `npm run guard:next-delta`（跨边界审计契约与散列校验全量通过）
- [x] **代码与样式规范**：`npm run lint:ui-system`（Stylelint 零报错，零非法 `!important`）

---

## 🧪 当前阶段与后续安排

- [x] 侧边栏 Schema 声明式渲染与单一所有权架构落地
- [x] 16 个 legacy CSS 文件清退与 Design Tokens 收敛
- [x] 现代化浮层模型选择器挂载与基线视觉走查
- [x] 对抗性审查清单问题彻底清零与针对性测试覆盖（C1, C2, H1~H7, Medium）
- [ ] 保持 Draft 阶段，完成最终实机交互复核后准备正式评审。
