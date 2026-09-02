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

### 13.4 M5-d 收尾

advanced-visibility/rust-visibility 薄包装并入渲染器统一的依赖求值（visibleIf 已声明，事件路径与投影路径最终同一求值器）；marker-registry 清单复核；§十三回填施工记录；评估 rebase 回 prb 的冲突面（预期集中在被删 pass 文件，"我们删了 vs 上游改了"，维持删除）。

### 13.5 总门禁与施工纪律

沿用既有纪律：每阶段独立提交、中文 conventional commit、D6 红线、绝不 `git add -A`；全套测试不回退；每阶段八分区实机探针 + 像素对比 + 重启往返；像素基线随每阶段滚动更新（对比对象 = 上一阶段末截图）。M5-a 完成前不动渲染侧，M5-b 试点验收前不铺开 13.3。
