# 研究方案 · 全局设置 schema 渲染终态（实验分支）

> 分支：`exp/settings-schema`（自 `pr/global-settings-unified-ui` f894b317 分出）。
> 性质：实验项，不受"小步可审查 PR"约束；任何中间态可停、可独立评估。
> 硬约束：**视觉零变化**（像素级走查为准）；**行为契约不变**（设置 key 与 settings.json 结构、autosave 语义、i18n 文案全部保持）。

## 一、要解决的债（现状账单，2026-09-01 实测）

| 债务 | 规模 | 性质 |
|---|---|---|
| `styles/ui-system/settings-*.css` | 3,333 行 | 级联税：选择器越写越长，改一处要和三层作用域打架 |
| `modules/ui-system/settings-bridge.js` | 991 行 | DOM 手术：挂载/拆桥/守卫/重投影 |
| `modules/ui-system/typed-field-owners.js` | 892 行 | 手写 key→控件投影表，逐字段 set/check |
| `modules/ui-system/settings/`（23 个模块） | 1,604 行 | canonical-rows、select-projection、4 个 visibility、choice/forum/identity/home/appearance 按域补丁 |
| `main.html` 全局设置模板 | ~800 行静态标记 + 100 个 `data-vcp-style` 标记 | 双源事实：HTML 是事实，JS 再"翻译"一遍 |
| `modules/global-settings-manager.js` | 440 行 | 按控件 id 逐个收集/回填 DOM |

根因（七节定调）：新视觉层是**投影在 legacy DOM 上**，不是**拥有自己的 DOM**。投影态的债是持续收的级联税；schema 态的债是一次性迁移成本。

## 二、终态架构

```
modules/settings/schema/*.js        ← 唯一事实源：每分区一个 schema
   （key / type / label / hint / default / component / visibleIf）
        ↓ 渲染
modules/settings/render/*.js       ← schema → DOM，挂 uiux 原语
   （字段渲染器 + 分区渲染器；胶囊 Select/Input/Stepper 即原语产物）
        ↓ 状态
modules/settings/store.js          ← key → patch → IPC 保存
   （接管 save-coordinator 的 autosave 语义）
        ↓ 唯一样式层
dsw 语义 CSS（单层级联）
   （settings-overrides.css 清零；类名即语义，无三层作用域对抗）
```

各债务的消灭方式：

- `main.html` 设置标记、`data-vcp-style`、`typed-field-owners` 手写投影表 → 被 schema 取代（字段一处声明，渲染/收集/回填全由此推导）。
- `canonical-rows` / `select-projection` / 按域补丁 → 渲染器直接产出正确结构，无需术后矫正。
- 4 个 visibility 模块 → schema `visibleIf` 声明式依赖，渲染器统一求值。
- `settings-overrides.css` → 渲染产物直接带语义类，级联单层。
- `global-settings-manager` 的 DOM 收集 → store 按 schema key 读写。

## 三、双轨运行（关键工程决策）

实验分支与 PR 分支（`pr/global-settings-unified-ui`）并行：

1. 实验分支用**运行时开关**（`VCPCHAT_SETTINGS_SCHEMA=1`）切换新旧 surface，新旧可实时对比——这是"视觉零变化"的验收工具，也是回退保险。
2. 定期 rebase 到 PR 分支。冲突面集中在**将被删除的文件**（main.html 设置标记、settings/ 投影模块），属"我们删了 vs 上游改了"，好解：维持删除。
3. PR 分支继续收用户反馈的 UI 修复（如本轮的卡片/堆叠系列）；这些修复在实验分支以 schema 形式重表达，不复刻补丁。

## 四、迁移顺序（由简到繁，每分区一个提交）

| 阶段 | 分区 | 原因 |
|---|---|---|
| M0 内核 | schema 内核 + 渲染器骨架 + 开关；**快捷操作**试点 | 最简、纯文本/数字/开关，本轮刚做过堆叠与卡片，视觉基准最新 |
| M1 静态分区 | 用户身份、服务器连接、消息渲染、划词助手、语音设置 | 字段类型收敛（text/url/password/select/switch），visibility 少 |
| M2 依赖分区 | 高级功能 | `visibleIf` 首个实战（advanced/render/rust visibility 合一） |
| M3 外观 | 界面与外观 | 最重：appearance-studio 联动、stepper 提交式编辑、白屏修复的等价重构 |
| M4 单层化 | 删 `main.html` 设置标记、`settings/` 投影模块下线、`settings-overrides.css` 清零 | 全部迁移完成后执行 |

每分区迁移 = 声明 schema → 渲染器出 DOM → 逻辑切 store → 删该分区 legacy 标记与对应经典 CSS → 走查。

## 五、验收标准（每分区、每里程碑）

1. **像素走查**：新旧 surface 逐分区 CDP 截图对比（同 appdata、同主题、同窗口尺寸），无可见差异。
2. **行为等价**：设置 key 与保存结果不变——改字段→autosave→重开回填一致；special 键（颜色对、外观数值、stepper 提交式）逐个过。
3. **级联健康度**：`settings-overrides.css` 行数单调下降，M4 归零。
4. **回归防线**：现有 353 个测试不回退；为 store/schema 补单测（schema 完整性、visibleIf 求值、patch 语义）。

## 六、风险与对策

- **文案/结构遗漏**：schema 从 main.html 一次性机械提取（写提取脚本生成初稿，人工核对），不靠手抄。
- **special 控件行为**：颜色对、stepper、外观数值等有隐藏交互语义，参考老分支 `backup/pre-squash-20260830` 的 `modules/ui-system/settings/*-controls.js` 对照移植（该分支只提取不复活）。
- **appearance-studio 耦合**：M3 前不动它；studio 读写的 profile key 保持，渲染层替换后 studio 只换取数来源。
- **半途停滞**：双轨开关保证任何阶段可停——旧 surface 始终可用，实验分支不影响任何在用功能。

## 七、起步动作（M0 清单）

1. `modules/settings/schema/quick-actions.js`：从 main.html `section-quick-actions` 机械提取。
2. `modules/settings/render/field-renderer.js`：type→uiux 原语映射（text/password/url→Input，textarea→多行，number→Stepper，select→胶囊 Select，switch→Switch，button→Button）。
3. `modules/settings/store.js`：接管 save-coordinator 客户端注册，patch 语义与 typed-field-owners 现状一致。
4. 开关挂载：`VCPCHAT_SETTINGS_SCHEMA=1` 时全局设置弹窗渲染 schema surface，否则走现桥。
5. 像素对比脚本（CDP 截图新旧 surface 同分区）入 `scripts/`。

## 八、M0 施工记录（已完成）

- 内核落地：`modules/settings/schema/kernel.js`（section/textarea/number/switchField/select 描述原语，`when` 依赖子句）+ `schema/quick-actions.js`（快捷操作 8 字段逐字对齐静态标记）。
- 渲染器：`modules/settings/render/field-renderer.js`，编译产物与 main.html 静态标记结构同构（行类名、`data-vcp-style`、`data-visible-when`、全部业务锚点 id/name 保留），投影管线原样工作。
- store：`modules/settings/store.js` 值访问门面（switch→checked，其余→value）+ 分区现值快照。
- 切换面：`modules/settings/schema-surface.js`；开关为 `localStorage['vcpchat-settings-schema']='1'`（渲染进程无 env，计划中的 `VCPCHAT_SETTINGS_SCHEMA` 落地为 localStorage）。挂载点在 `enhanceGlobalSettings` 进入管线之前，替换分区子节点、保持分区元素身份，`vcpSchemaRendered` 幂等标记（已登记 marker-registry）。
- 测试：`tests/settings-schema-render.test.mjs` 6 例（锚点/同构/canonical 投影/现值迁移/切换幂等/类型防错）全绿；全套 359/361，仅剩两条基线既有失败。
- 实例验证（临时 appdata + CDP）：22/22 通过——锚点齐全、依赖可见性行为（主开关/选择值/保险行）、自动保存 dirty→saved→磁盘落盘、开关关闭零干扰、重复 refresh 幂等。
- 像素对比：`scripts/compare-settings-schema-pixels.mjs` 入库；同交互序列下 schema 面与静态面分区截图差异 0.0000%。
- 已知存量怪癖（非本迁移引入，记录备查）：`middleClickQuickAction` 走 typed 通用 pairs 静默回填，不派发 `vcp-uiux-sync`，静态面 select 胶囊在纯快照恢复后标签可能滞留占位文案；M1 迁移该字段时一并收敛。

## 九、M1 施工记录（已完成：五个静态分区）

- kernel 扩展：`text/radio/range/button/card/radioGroup/inlineNumbers/custom` 描述原语；显式样式覆盖（rowStyle/controlStyle/hintStyle/labelStyle/textareaStyle/selectStyle/rowClass/rowHidden）；`walkFields` 深度遍历；分区级 `adoptNodeIds`。
- 渲染器：六类布局全量编译；卡片（toggle+chevron SVG，body id 由 card key 派生）；无 id 的 form-group 行用 `grouped: true` 表达；开关行支持提示内包裹（hintInsideWrapper）与行内附加组件（extra，划词调试面板）。
- 专属组件入 `render/widgets.js`：头像资料卡、折叠自定义样式区（颜色对+重置按钮）、划词调试面板、动画 CSS 示例块、动画预览——标记逐字对齐静态版本，由既有增强按类名/id 接管。
- store 重构为 id 键值快照（checkbox/radio→checked）：`captureSectionValues`/`restoreSectionValues`，custom 组件经 `captureKeys` 声明内部控件；schema-surface 增加 `adoptNodeIds` 整体节点迁移（划词 Agent 下拉的运行时选项、网络笔记路径容器子行），替换后原节点搬回渲染产物。
- 新 schema：user-identity / server-connection / render-settings / selection-assistant / voice-settings；quick-actions 适配 textareaStyle 显式化。
- 测试：单测 14 例全绿；全套 367/369（仍只剩 2 条基线既有失败）。
- 实例验证：33/33——六分区控件状态映射（value/checked/行可见性/hidden/选项数）schema 面 vs 静态面逐项一致；data-vcp-style 标记集与行类名集合逐分区一致；行为断言（卡片折叠、网络笔记动态行、动画预设显隐、划词依赖投影、语音单选+choice 收编、M1 字段 autosave 落盘含 URL 自动补全）全过。
- 像素对比：六分区截图像素差异 0（render-settings 有 1 字节纯白区渲染抖动，2,003,463 字节中 1 字节）。

## 十、M2 施工记录（已完成：高级功能分区）

- schema/advanced-features：五枚开关（33×4/15/35 历史样式与 title 提示保留）、净化深度依赖行（容器 id 锚点 + data-visible-when）、hr 分隔线（36）与话题总结模型复合控件（model-input-container，mountTypedTopicSummaryModelPicker 接管，内部输入经 captureKeys 快照迁移）。
- 测试 15 例全绿；全套不回退；实例探针扩到七分区：37/37（控件状态映射、style/类名集合逐项一致 + 既有行为断言）；分区像素差异 0。
