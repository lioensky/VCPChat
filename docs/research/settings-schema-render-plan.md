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

## 十一、M3 施工记录（已完成：界面与外观分区——全部八个分区收齐）

- schema/appearance-settings：工作台入口卡（appearance-studio 摘要锚点 + 打开按钮）、主页视觉开关 ×2（appearance-home-visual-setting 结构）、寄语内容（整行 label + span 标题 + maxlength）、七枚裸 select 行（密度/圆角/字体/字号/内容宽度/页面材质/列表项圆角，`#<key>Row` 宿主 + data-vcp-settings-row + hidden select，语言行/字号行 passes 原样接管）、几何滑杆 ×3（label 整行 + heading 内嵌 output + helper，appearance-ranges 挂 stepper）、场景字体预览（四卡 + 8 个字体控件，captureKeys 快照迁移）、消息呈现模式 fieldset（三张 radio 卡，captureKeys）、内容宽度单选组（rowStyle 12）、气泡依赖开关 ×2（hintInsideWrapper + visible-when）、宽屏数字组（新 numberCells 布局：行标题 + 三组 label+number + 行尾提示，双依赖子句）。
- 渲染器新增四种历史形态：switch 的 homeVisual 变体、select 的 bareRow 变体（rowClass/ariaLabel）、range 的 geometry 变体（buildRangeInput 抽取复用）、numberCells 布局；buildSwitchControl 支持 checked/ariaLabel，buildInputBase 支持 maxlength。
- 专属组件入 render/widgets.js：buildAppearanceWorkbenchCard（工作台 SVG 按钮逐字对齐）、buildFontScenarioPreviewRow（四场景卡选项表）、buildChatPresentationModeFieldset。
- canonical-rows 语义确认：裸 select 行凭 data-vcp-settings-row 进候选；label/fieldset 行跳过槽位组合；分区元素 data-settings-section-key=appearance-settings 使投影行获得 appearance-row 原语标记，与静态面一致。
- 测试 18 例全绿；全套 371/373（仅剩 2 条基线既有失败）。
- 实例探针扩到八分区：44/44——控件状态映射、style/类名集合逐分区与静态面一致；新增行为断言（外观原语收编 7 项、呈现模式/内容宽度依赖投影、工作台摘要与场景预览渲染）；探针时序教训：依赖行 radio 变更后须等防抖自动保存落盘再取静态面基线。
- 像素对比：八分区全部 0.0000%（含 2292px 高的外观分区）。

## 十二、M4 施工记录（已完成：单层化收尾，三段提交）

- **M4-a 静态标记退役（b907010c）**：main.html 八个分区清空为壳（id + data-settings-section-key），2138→1724 行；schema-surface 移除 localStorage 开关门，enhanceGlobalSettings 管线前无条件原地替换。现值回填改由 typed-field-owners 快照投影按 id 承接（含 vcp-uiux-sync 同步胶囊显示）。六个静态标记扁平化契约测试合并为分区退役契约；保存链测试改经 applySchemaSurface 渲染后驱动。全套 366/368（2 条基线既有失败）。
- **M4-b 覆盖层清零（66a26752）**：settings-overrides.css（1747 行）原文前置于 settings-template.css（保持相对级联顺序），入口移除导入。overrides 与 shell/primitives 本无同选择器重复（css-parts 跨分区测试既有约束），位移不改级联——八分区截图与合并前逐字节一致。css-parts 契约测试改写为合并部语义（横幅在前、canonicalized 声明在后、其后只允许 :is 机有声明）。
- **M4-c 投影死代码退役（18de5bbe）**：removeLegacySubsectionHeadings（无人调用）与 sectionKeyForTitle 标题回填删除；schema-surface 的 adoptNodeIds 摘引/快照回填路径随静态面一并退役（首渲染无可采集现值，持久值全由 typed 投影回填）；分区归属契约脚本改查 schema 编译产物（JS 绑定 id ∈ main.html 壳 ∪ 渲染产物，423 个 id 交叉核对）。全套 365/367，探针 31/31，重启往返截图逐字节一致。
- **验证基线变化**：M4 后不再有双面对照；验收判据改为「唯一 schema 面 + 重启往返等值 + 与 M3 静态面基线的跨会话像素对比」。跨会话对比存在亚像素字体栅格化噪声（≤0.9%，全部分布在文字行带内，内容逐字相同）；advanced-features 分区高度差为探针种子状态差异（净化开关），非回归。探针种子改用规范持久化格式（appearanceProfile/voiceNetworkSettings 嵌套；划词配置在其独立 store，settings.json 扁平键为历史遗留不参与回填）。

## 十三、M5 终态演进路线（规划：渲染器直出 canonical 结构 + store 按 schema key 读写）

### 13.0 目标与非目标

**目标**：拆掉"两跳"架构的最后余量。现状是 schema 先编译出与旧静态标记同构的"昨天的标记"（M0-M3 像素等价契约的产物），再由 17 个管线 pass 术后矫正成今天的界面；保存/回填链则与 schema 平行存在三份手写清单（schema 声明、保存链 81 处 `getElementById`、typed-field-owners 892 行投影表）。终态：渲染器直接产出 canonical 最终结构（管线退役），store 按 schema 声明推导读写（三清单合一）。

**非目标**：不动 uiux 原语库本身（Input/Switch/LanguageRow 等是终态地基）；不动设置 shell/导航/autosave 语义；不追求在本路线内 rebase 进 prb——按既有纪律定期 rebase 即可。

### 13.1 M5-a 值链路合一（先行：纯逻辑，零视觉风险）

字段描述符补齐值语义，读写链从 schema 推导：

1. **kernel 扩展**：字段声明增加 `valuePath`（settings.json 持久化路径，默认等于 key，嵌套如 `voiceNetworkSettings.providerUrl`）与 `value` 选项（`parse: 'int' | 'float'`、`clamp: [min, max]`、`fallback`、`checkedValue/uncheckedValue`）。
2. **store 扩展**：`collectSettings(form)` 遍历 SCHEMA_SECTIONS → 按描述符产出与现保存载荷**逐键同形**的对象；`applySettings(form, settings)` 对称回填（写值 + 派发 `vcp-uiux-sync`，收敛 M0 记录的胶囊滞留怪癖）。
3. **等价性金测**（本阶段核心门禁）：单测对渲染后的表单灌入随机值，断言新 `collectSettings` 与旧 `handleSaveGlobalSettings` 收集器的产出 JSON 完全一致（含嵌套 voice/appearanceProfile、parseInt/钳位、URL 补全等特例）；特例全部改写为描述符声明后从保存链删除。
4. **切换保存链**：`handleSaveGlobalSettings` 改调 `collectSettings`，保留提交锁/超时/retry 事件契约不变；人工特例（头像、论坛凭据、划词独立 store）维持现通道，仅清单化登记。
5. **回填链收敛**：typed-field-owners 的 44 条投影表改为 `applySettings` 驱动；划词/论坛/外观 profile 三个 typed 消费者保留（它们是状态服务，删除的只是手写 DOM 映射段）。

**验收**：金测等价 + 全套不回退 + 探针改值→autosave→settings.json 与旧链字节一致 + 重启往返等值。**回退**：单提交粒度，revert 即回旧链。

**施工记录（已完成：三段提交）**：

- **值链路合一（b63cbd36）**：新增 `modules/settings/value-semantics.js`——`collectSettings`（保存收集）/`applySettings`（对称回填，仅实际变化时派发 `vcp-uiux-sync`）/`collectKey`（12 步求值链：常量→读控件→absent/present→checkedValue 映射→trim→parse+roundTo/nanFallback→min/max 钳位→falsy→currentFallback→fallback→allowed→slice→upper→transform，逐条复刻旧链怪癖：`parseInt||fallback` 的 0→fallback、`checked !== false` 的 undefined→true、滑杆 NaN→92 钳当前值、`Number('')`→0→100 等）/`assignPayload`（dot-path 嵌套写入）。字段描述符补齐 `save` 声明（valuePath/value/collect:false/save:false），分区级 `collect(scope)` 钩子承接组合项（appearanceProfile 归一化、chatPresentationMode 读取、networkNotesPaths 容器收集、user-identity 三键）；自定义组件经 `saveMap` 按 captureKeys 挂接。旧保存链 130 行 payload 块逐字转录为金测冻结参照 `tests/settings-value-golden.test.mjs`：5 组随机种子全键 deepStrictEqual（含嵌套 voice/appearanceProfile、URL 补全、钳位、字体 currentFallback）+ 空表单等价 + 20 余条怪癖定点断言 + 划词/论坛/头像独立通道 `SAVE_CHANNEL_MANIFEST` 清单化。12 文件 +925/−69。
- **切换保存链（bc03faaa）**：`handleSaveGlobalSettings` 改调 `collectSettings(schemaSurfaceSections(), …)`（−133/+14），提交锁/超时/retry 事件契约、parseMultilineKeywords 划词补丁、头像/论坛通道不动。
- **回填链收敛（f46038a6）**：typed-field-owners 44 条手写投影表替换为 `applySettings` 驱动（−62/+7），写值仅在实际变化时派发 `vcp-uiux-sync`（收敛 M0 胶囊滞留怪癖）；显示默认、头像预览、可见性、划词/论坛/外观三个 typed 消费者保留。
- **验收记录**：金测 5/5 绿；全套 372/370（2 条基线既有失败）；实机探针 10/10 载荷断言落盘正确（'  '→'请继续'、'0'→5/1000、' f9 '→'F9'、123→钳位 98、嵌套 sovitsUrl trim 等），重启回填 8/8 归一等值；像素对比 6/8 分区与 M4 末基线字节一致，其余 3 分区差异 ≤0.27% 且经逐带比对确认为跨会话文字反锯齿噪声。探针 run-1 状态对比的 4 条「差异」为基线伪差：run-1 在全量保存后即重采 DOM，读到的是应用有意保留的未归一草稿（保存期间投影被 dirty/saving 守卫跳过），重启值与落盘归一值一致；rustRuleMode 'whitelist'→'none' 为划词通道既有派生语义（规则模式不入盘，重启按白名单空数组推导 none），非 M5-a 回归。D6 复查 14 个变更文件干净，已推 fork（6ff41a96..f46038a6）。

### 13.2 M5-b 渲染器直出 canonical 行（试点：快捷操作分区）

1. field-renderer 直接产出最终结构：`vcp-uiux-general-item/general-row` + row-copy 槽 + `data-setting-primitive` 挂点；旧包裹类（vcp-settings-row/form-group）不再输出。
2. `mountCanonicalSettingsRows` 加 canonicalRow 已达标记跳过；试点分区通过后该 pass 对全部分区成空转 → 删除 pass 与 `composeCanonicalRowSlots`。
3. hr 停止输出（现管线本就挂载即删，画面零变化）；行语义类映射表入文档（`vcp-settings-row-stacked` 等保留类的对应关系）。
4. 测试面翻新：schema-render/bridge-modules 中断言旧类的用例改为断言 canonical 结构。
5. **试点验收后不铺开**——先跑一个分区，确认探针/像素/CSS 三关全过再进入 13.3。

**施工记录（已完成：快捷操作分区试点通过，ae5169df）**：

- **直出落地**：新增 `modules/settings/render/canonical-row.js`——canonical 行机械层（`canonicalizeRenderedRow` 单行变换 + `composeCanonicalRowSlots` 槽位组合）与行语义类映射表（旧包裹类 vcp-settings-row/vcp-settings-control-row/form-group/settings-form-group/form-group-inline → 移除并替换为 vcp-uiux-general-item/general-row；行上其余类如 vcp-settings-row-stacked、settings-inline-number-row 原样保留；行属性 id/data-visible-when/data-vcp-style/hidden 原样保留；dataset 增补 settingPrimitive/settingsSectionKey/settingKey/canonicalRow；title+helper 收入 row-copy 槽）。`section()` 增加 `canonicalRows` 开关，quick-actions 试点声明；field-renderer 对声明分区的每行（含 card/radioGroup 嵌套行）就地 canonical 化，旧包裹类不再出现在编译产物。
- **pass 收敛**：mountCanonicalSettingsRows 退化为候选扫描 + hr 清理，单行变换改调共享 canonicalizeRenderedRow（单一载体），并按 dataset.canonicalRow 已达标记对直出行空转；pass 本体待 13.3 六个 pass 全部退役后随之删除（届时全部直出，pass 对全分区空转）。
- **hr 停止输出**：advanced-features 的 advancedDivider（`<hr>`，data-vcp-style=36）不再编译——投影 pass 本就挂载即删，画面零变化。
- **测试面翻新**：schema-render 行形态断言改查 canonical 结构（含旧包裹类零残留、映射类保留、样式标记穿越）；canonical 直出完备性 + pass 空转不变量（innerHTML 逐字节不变）；bridge-modules「函数单一载体」扫描纳入 render/canonical-row.js、appearanceOwner 断言随机械层搬家、已达标记断言补入 pass 文件。
- **验收记录**：全套 372/370（2 条基线既有失败）；实机探针 45/45（含 M5-b 专查：快捷操作直出行 ≥7 且旧包裹类零残留、row-copy 槽在位、投影 pass 照常挂载，加上 M5-a 保存链全量回归）；像素对比 8 分区对 M5-a 末基线全部 0 差异（5 分区字节一致、2 分区 0 差异字节、quick-actions 字节一致——直出与 pass 投影逐像素等值）；CSS 关由全套 css-parts/settings 契约测试覆盖。D6 复查干净，已推 fork（a3c6f05c..ae5169df）。

### 13.3 M5-c 原语直挂：逐 pass 退役（由简到繁，每 pass 一个提交）

渲染器按字段类型直接输出原语就绪结构，管线对应 pass 删除。顺序按风险升序：

| 序 | pass | 说明 |
|---|---|---|
| 1 | uiux-switches | 开关行直出 holder 结构，最简单 |
| 2 | legacy-range-pass / global-pill-steppers | 滑杆/步进器直出 |
| 3 | uiux-inputs / agent-name-fields | 输入原语包裹直出 |
| 4 | appearance-rows / global-pill-steppers 语言行 | 裸 select 直出语言行宿主 |
| 5 | select-projection | 最大的一块：分段/弹层直出，单独设计稿 |
| 6 | uiux-disclosures / form-icons | 收尾 |

每个 pass 退役的固定流程：该类型行直出 → 断言该 pass 空转的单测 → 删 pass → 八分区探针 + 像素对比 0 + 重启往返。

#### 13.3.1 施工记录：pass1 uiux-switches 退役（5f25a712 + b067060c）

- **直出语义**：field-renderer 的 buildSwitchControl 对非 toggle 投影字段静态产出 mountToggle 的终态产品（span.vcp-uiux-toggle 包裹 input + slider.style.display='none'）；fieldProjection==='toggle'（showHomeVisualBrand/showHomeVisualTagline 两键）仍保持裸 checkbox，由运行时收编挂载。Toggle CSS 由真实原语挂载方在同一同步管线 tick 注入，无样式时序差。
- **pass 退役**：settings-bridge 删除 uiux-switches 管线步；mountUiuxSwitches 保留于 bridge-shared（agent 设置面 agent-settings-bridge 仍是消费方），marker-registry 的 vcpUiuxToggleMounted owner 更新为 agent 路径。
- **测试**：新增"开关行直出 Toggle 原语 holder"单测（wrap 结构 + slider 隐藏 + toggle 投影字段不包裹）；bridge-modules 测试同步管线步清单。
- **验收**：全套 373 测试 371 过（2 例既有失败不回退）；八分区探针 45/45；重启往返等值；像素对比 7/8 分区 0 差，appearance-settings 出现 1333 字节摘要文本差。
- **竞态修复（b067060c，非 pass1 引入）**：对照实验（m5b/m5c1 双构建 × 多次运行）证明该差异是两个构建都会随机踩中的既有竞态——开模态 rAF 绑定同步 vs 回填快照 applySettings 的时序，后者写值只派发不冒泡的 vcp-uiux-sync，绑定同步若先行则摘要滞留 base 默认文案且再无事件兜底。修复：bindSettingsSummary 增加捕获态 vcp-uiux-sync 监听（同一 matches 过滤），回填写值后摘要无条件重同步。修复后连续 3 次探针 45/45 且 appearance-settings 像素 0 差。

#### 13.3.2 施工记录：pass2 stepper 投影 / legacy-range 退役（bd38cec9）

- **直出语义**：field-renderer 新增 buildStepperControl——fieldProjection==='stepper' 的四字段（minChunkBufferSize/smoothStreamIntervalMs/streamAnimationDurationMs/middleClickAdvancedDelay）在渲染期直接产出 NumericStepperRow 终态结构（text/control 胶囊、编辑器内联守卫样式、箭头 svg、单位，逐属性转录自 mount 产物），业务 input 保持行内最后子节点；三种宿主形态分别嫁接：inlineNumbers 单元格（label 不再输出）、分组 number 行（label+hint 一并不输出，与旧挂载 replaceChildren 终态一致）、range 的 slider-container（output 随直出退役）。registry 的 title/description/unit 是行文案唯一来源（与旧挂载同源）。
- **运行期只剩行为**：原语模块抽出 bindStepperBehavior（sync/normalize/change + 监听），mount 与新增 activateNumericStepperRow 共用；mountGlobalSteppers 改为激活绑定器（结构已直出，只绑行为 + vcpTypedPrimitiveMounted 标记），调用点从 global-pill-steppers 步并入 global-typed-primitives（registry 驱动的 typed 运行时家族）。browser-entry/index 同步导出 activateNumericStepperRow。
- **legacy-range-pass 直接删除**：全局设置面仅有四条 range（三条外观几何 + streamAnimationDurationMs），全部在旧排除清单内——该 pass 早已空转，无可直出对象，随 pass2 删除；canonical-rows before 边与 global-pill-steppers 的 before 边同步收缩。
- **测试**：render-settings 用例翻新为直出结构断言（编辑器/箭头/单位、业务 input 位置、output 退役）；新增"步进器行直出 + 激活"用例（激活同步呈现、箭头步进写穿业务 input 并派发 input/change、vcp-uiux-sync 镜像、越界归一化、重复激活幂等、分组行直出）；bridge-modules 管线步断言移除 legacy-range-pass 并加退役守卫。
- **验收**：全套 374 测试 372 过（2 例既有失败不回退）；八分区探针 45/45 + 重启往返等值；像素 7/8 分区 0 差（appearance 基线为 pass1 竞态修复前的旧截图，对修复后末态复测 0 差后刷新基线），voice-settings 12 字节（0.001%）为两处圆角单通道 241→242 的反锯齿噪声（M5-a 同类已判定噪声）。

#### 13.3.3 施工记录：pass3 uiux-inputs 退役 / agent-name-fields 只剩行为（04b7ff9a）

- **直出语义**：field-renderer 新增 buildInputPrimitiveWrap（导出，widgets.js 共用）——单行文本/数字输入在编译期就地产出 uiux Input 原语（mountInput）的终态产品：span.vcp-uiux-input-wrap.wrap.vcp-uiux-input-fill 包裹 + input.input 类 + 八条内联守卫样式（box-sizing/height 22px/min-height/max-height/border/border-radius/padding 0 10px/line-height，全部 important，转录自原语挂载）。嫁接面：text 行（rowAsLabel 与普通行）、plain/grouped number 行、inlineNumbers 单元格、numberCells 单元格、widgets 的用户名行与四个场景字体自定义值行。投影规则按 field-registry 裁决：raw 投影（homeVisualTagline/adminUsername/adminPassword/两个颜色对文本）保持裸结构由 typed owners 运行时收编，stepper 投影仍走 pass2 的步进器直出——实机探针证实与旧 pass 的包裹集合逐字段一致（24 个直出包裹）。
- **pass 退役**：settings-bridge 删除 uiux-inputs 管线步与 mountUiuxInputs（marker vcpUiuxInputPrimitive 随之注销，marker-registry 注释说明）；canonical-rows before 边收缩（uiux-inputs 移除）；field-registry projection 注释块更新为直出语义。Input 样式表仍由真实原语挂载方（forum/home typed mounts 等）在同一管线 tick 注入。agent-name-fields 步保留但降为纯行为绑定：Field 增强的挂载产物（vcp-ui-settings-field 类 + data-state="error" 初始校验态 + aria-invalid）由 render/widgets.js 直出（实机探针证实的稳态转录——空 required 输入在校验绑定时的挂载态），运行期只剩 invalid/input/change 的校验态重同步。
- **测试**：新增三个用例——直出结构断言（wrap 类名/input 守卫样式/data-vcp-style 留在 input/raw 不包裹/步进器不包裹）、agent-name-wrapper 直出 Field 产物（类/初始态/aria/wrap 顶替 input 位置）、直出完备性不变量（按旧 pass 的选择器扫全部八分区，排除项后断言全部已包裹 = 退役 pass 空转）；bridge-modules 单一载体清单与管线步断言同步（uiux-inputs 退役守卫 + canonical-rows before 边更新），typed-primitives 扫描清单去掉失效的 entry 切片锚点、并入 global-input-upgrades.js。
- **验收**：全套 377 测试 375 过（2 例既有失败不回退）；八分区探针 45/45（双构建各一轮，含重启往返等值）；像素 8/8 分区对 pass2 末基线（bd38cec9 独立 worktree 复现）全部字节一致——直出与运行期包裹逐像素等值。D6 复查干净。

#### 13.3.4 施工记录：pass4 语言行/字号行直出、appearance-rows 退役（3b3d817a）

- **直出语义**：schema select 增补 languageRow/fontSizeRow 元数据（行文案的唯一来源，原 adapter 文案表随退役删除），field-renderer 新增两个导出构建器：buildLanguageRowStructure——声明 languageRow 的 11 个 select（外观五个 profile 行 + 列表项圆角行 + 语音输入模式/流式内容动效/规则模式/划词助手 Agent/中键快速执行功能 + widgets 四个场景字体行）在编译期就地产出 LanguageRow 原语（mountLanguageRow）的终态产品（行容器/标题/描述/胶囊触发按钮 + 14×14 箭头 svg，逐属性转录；触发按钮首子节点是标签文本节点，编译期取默认选项标签，激活期 sync 原位改写）；buildFontSizeRowStructure——appearanceFontScale 直出 FontSizeRow 终态结构（标题/描述 + 胶囊步进器：42px 数值编辑器内联样式、9×9 上下箭头 svg、px 单位、13/16 量程与 aria），业务 select 挂进行内（与 mount 的 replaceChildren 终态一致），draft 标记随直出就地产出。裸行（select + 语言行同宿主）与分组行（select + hint + 语言行次序与旧 mount 追加位置一致）两种宿主形态分别嫁接；场景字体行由 widgets.js 复用同一构建器直出。
- **运行期只剩行为**：language-row 原语抽出 createLanguageRowController（菜单挂载/标签 sync/setOptions 重建队列/dispose，onFinalDispose 区分 mount 移除结构与激活保留结构），新增 activateLanguageRow 导出——找到直出行、按触发按钮首文本子节点接管标签、只绑行为；font-size-row 同构抽出 bindFontSizeRowBehavior 并新增 activateFontSizeRow。global-language-rows.js 改写为通用激活扫描（全表单扫 .vcp-uiux-font-size-row/.vcp-uiux-language-row，不再维护 id 文案表）：菜单/镜像（change + vcp-uiux-sync）/动态选项重建观察器统一挂接，select-projection 依赖的 vcpTypedPrimitiveMounted 标记在激活前统一打标；动态观察器从 assistantAgent 专属推广到全部语言行（非动态行的列表从不重建，观察器空挂）。appearance-controls.js（含 mountAppearanceSelects 兜底与 mountChatFontRows 等 5 个挂载方）整文件删除，appearance-rows 管线步退役；global-pill-steppers 步只剩直出结构的行为激活（mountGlobalLanguageRows + mountVoiceShortcutInput），仍声明 before select-projection。browser-entry/index 同步导出两个激活器。canonical-rows before 边收缩（appearance-rows 移除）；marker-registry vcpAppearanceDraftControl 属主注释更新（字号行标记随直出就地产出）。
- **测试**：新增三个用例——语言行/字号行直出结构断言（六个分区 11 行：行文案/触发按钮文本节点/箭头 path/字号行量程与 draft 标记/select 挂行内/hint 次序/canonical 分区容器宿主同样成立）；激活行为绑定（激活即同步 px 读数与标签、vcp-uiux-sync 镜像、菜单选择写穿业务 select 并派发 change、重复激活幂等、MutationObserver 选项重建镜像、全部直出行激活覆盖断言）；空转完备性不变量（全八分区编译产物中每个带直出行的裸 select 行都必须已激活 = 退役 pass 无可挂载对象）。bridge-modules 单一载体清单（appearance-controls → global-language-rows 激活契约）、管线步断言（appearance-rows 退役守卫 + canonical-rows before 边更新）与 typed-primitives 扫描清单（activateLanguageRow/activateFontSizeRow 进原语清单，mountSelect 随兜底退役移出）同步。
- **验收**：全套 380 测试 378 过（2 例既有失败不回退）；八分区探针 45/45 双跑（含重启往返等值，双跑状态逐字节一致）；像素 7/8 分区对 pass3 末基线（d27326e3）字节一致，voice-settings 仅 4 像素单通道 241→242（F9 输入胶囊圆角反锯齿，pass2 同类已判定噪声，双跑逐字节稳定复现、非随机竞态）。D6 复查干净。

#### 13.3.5 pass5 分段/弹层直出、select-projection 步退役（40b57f00 设计稿 + b6ae09eb 施工）

##### 13.3.5.1 前置设计稿（40b57f00）

- **勘验结论（设计前提）**：pass4 的通用激活扫描已把全部 17 个 schema select（11 个语言行宿主 + 字号行 + widgets 四个场景字体行 + 划词 Agent 动态行）在管线内统一打上 `vcpTypedPrimitiveMounted`（激活步先于 select-projection）。全八分区"编译 + 激活链"仿真核实：**0 个未打标 select**——pass5 原表的"弹层直出"对象已被 pass4 全部消费，select-projection 在 schema 面空转。因此 pass5 收缩为两件事：
  1. **分段（Choice）直出**：全 schema 恰有两个 radioGroup（voiceModeGroup、chatLayoutMode），choice-controls 的两个 id 表项与之一一对应。radioGroup 渲染直接产出 mountChoice 终态产物：内层控制行加 `vcp-uiux-choice` 类、radio 标签加 `vcp-uiux-choice-option` 类、行 `dataset.value` 取编译期 checked 值（local / normal）——sync 的语义就是"从 checked radio 重推导 dataset.value"。choice-controls.js（mountChoiceControls）整文件退役；choice 原语抽出 bindChoiceBehavior 共用，新增 activateChoice 只绑行为（change/vcp-uiux-sync 重推导 dataset.value）并调 ensureStyles——schema 面退役后无其他 mountChoice 调用点，分段样式必须由激活方同一管线 tick 注入。mountChoice 本体保留：agent 流式输出分段（agent-settings-bridge）仍是 mount 语义。
  2. **弹层（select-projection）空转退役**：settings-bridge 删除 select-projection 管线步（global-pill-steppers 的 before 边随之收缩）；select-projection.js 模块与 bridge-shared 导出保留——agent-settings-bridge 的 `selectProjection.mount(form)` 仍是真实消费方（与 pass1 保留 mountUiuxSwitches 同理），settings-bridge 收尾的 `selectProjection.teardown()` 一并保留（共享单例的清扫语义不变）。
- **删 observer 的事件链安全论证**：select-projection 的 observer/sync 桥在 schema 面的三个职责均已冗余——① applySettings（M5-a 值链）写值时自行派发 vcp-uiux-sync，语言行镜像直接监听该事件；② restoreSectionValues 仅在分区重渲染时迁移现值，先于管线激活（激活读现值）；③ global-settings-updated 的发布方（global-settings-manager/appearance-studio）只广播设置快照、不直写 schema select。选项重建（assistantAgent）由 pass4 推广的语言行 MutationObserver 接管。
- **空转不变量（单测门禁）**：全八分区编译产物经激活链后，每个 select 必须已打 `vcpTypedPrimitiveMounted`（= select-projection 无可投影对象），每个 `vcp-uiux-choice` 行必须已激活（= choice-controls 无可挂载对象）。
- **验收**：沿用固定流程——+3 单测；八分区探针 45/45 + 重启往返；像素对 pass4 末基线（c5d834a4）预期 0 差（直出 = 运行期挂载逐属性等值）。

##### 13.3.5.2 施工记录（b6ae09eb）

- **直出语义**：field-renderer 的 radioGroup 分支（全 schema 恰两处：语音工作模式、内容宽度）在编译期就地产出 Choice 原语（mountChoice）的终态产物——内层控制行加 `vcp-uiux-choice` 类、radio 标签加 `vcp-uiux-choice-option` 类、行 `dataset.value` 取编译期 checked 值（local / normal）；choice-controls.js（mountChoiceControls 的两个 id 表项）整文件删除。choice 原语抽出 bindChoiceBehavior 共用（dataset.value 从 checked radio 重推导），新增 activateChoice 导出——直出结构上只绑 change/vcp-uiux-sync 行为并注入分段样式表（schema 面退役后无其他 mountChoice 调用点，样式必须由激活方同一管线 tick 注入）；mountChoice 本体保留给 agent 流式输出分段。弹层侧按勘验结论零直出对象：select-projection 管线步删除，模块与 bridge-shared 导出保留（agent-settings-bridge 仍是真实消费方），settings-bridge 收尾的 selectProjection.teardown() 保留（共享单例清扫语义不变）；global-pill-steppers 的 before 边随之收缩。
- **运行期只剩行为**：global-input-upgrades.js 新增 mountGlobalChoices——按 `.vcp-uiux-choice` 结构通用扫描（不再维护 id 表），activateChoice + vcpTypedPrimitiveMounted 标记，并入 global-typed-primitives 步。marker-registry：vcpSelectRebuilding 属主注记 schema 面退役（agent 面保留）；Choice 的 dataset.value 值镜像登记为 persistent（schema 面初值随直出就地产出并有意跨 teardown 存续，agent 面 mount 语义仍在 dispose 时删除）。
- **测试**：新增三个用例——分段直出结构（两个单选组的行类/选项类/dataset.value 初值）；激活行为绑定（change 与 vcp-uiux-sync 双路重推导、重复激活幂等）；空转完备性不变量（全八分区经与管线同序的激活链后，每个 select 必须已打标 = select-projection 无可投影对象，每个分段行必须已激活 = choice-controls 无可挂载对象）。bridge-modules 清单同步：管线步断言去掉 select-projection 并加退役守卫、Choice 批测试改断直出 + mountGlobalChoices、原语清单 mountChoice→activateChoice、choice-controls.js 删除守卫；选择投影模块级契约测试保留（agent 面消费方）。
- **验收**：全套 383 测试 381 过（2 例既有失败不回退）；八分区探针 45/45 双跑（含重启往返等值）；像素 run1 对 pass4 末基线（c5d834a4）10/10 字节一致，run2 仅 voice-settings 4 像素单通道 242→241（F9 输入胶囊圆角反锯齿，与 pass4 判定的同 4 像素集双向翻转，run1 全等证明非系统性差异，维持噪声判定）。D6 复查干净。

### 13.4 M5-d 收尾

advanced-visibility/rust-visibility 薄包装并入渲染器统一的依赖求值（visibleIf 已声明，事件路径与投影路径最终同一求值器）；marker-registry 清单复核；§十三回填施工记录；评估 rebase 回 prb 的冲突面（预期集中在被删 pass 文件，"我们删了 vs 上游改了"，维持删除）。

### 13.5 总门禁与施工纪律

沿用既有纪律：每阶段独立提交、中文 conventional commit、D6 红线、绝不 `git add -A`；全套测试不回退；每阶段八分区实机探针 + 像素对比 + 重启往返；像素基线随每阶段滚动更新（对比对象 = 上一阶段末截图）。M5-a 完成前不动渲染侧，M5-b 试点验收前不铺开 13.3。
