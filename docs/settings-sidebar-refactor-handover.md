# 设置侧边栏重构 · 交接文档

> 面向全新接手团队的完整上下文。阅读时间约 20 分钟。
> 文档快照时间：2026-09-06 19:10 · 分支 `exp/settings-schema` · HEAD `05f1eff6`

---

## 0. 三句话摘要

1. 这是一个 **Electron 桌面 AI 聊天客户端**（`vcp-chat-desktop`），我们正在把它的**设置侧边栏**（助手设置 / 群聊设置）从"命令式 DOM 拼接"重构为"Schema 声明式渲染"。
2. 重构目前**只完成约 20%**，卡在最危险的"新旧杂交期"：新架构已经接管渲染，但旧代码 `settingsManager.js` 仍伸手操作 DOM，两套逻辑互相打架，导致"点不动""箭头对不齐"这类怪 bug 频发。
3. **当前仓库是干净可运行的状态**，视觉基线已完成采集，可以安全开工。**不要恢复 `stash@{0}`**（那是一个崩溃的半成品）。

---

## 1. 项目基础

| 项 | 值 |
|---|---|
| 项目名 | `vcp-chat-desktop`（VCPChat） |
| 形态 | Electron 桌面应用，入口 `main.js`，`npm start` 启动 |
| 当前分支 | `exp/settings-schema` |
| 分支关系 | 从 `main` 的 `a4305e03`（2026-08-01）分叉，**领先 main 2862 个提交，落后 0** |
| 测试框架 | Node 内置 `node --test`（无 Jest/Vitest） |
| 样式体系 | 原生 CSS + Design Token，无预处理器 |

**分支警告**：这是一个跑了一个多月的长生命周期实验分支，与 `main` 差异极大。任何"同步 main"的操作都要极度谨慎。

### 目录速览

```
modules/settings/
├── schema/                    # 声明式 schema 层（新架构）
│   ├── kernel.js              # 描述原语：section/field/select/range/...
│   ├── sidebar-surfaces.js    # ★ 侧边栏（Agent/Group）渲染器，本次重构主战场
│   ├── user-identity.js       # 全局设置各分区（已完成迁移的样板）
│   ├── server-connection.js
│   ├── appearance-settings.js
│   ├── render-settings.js
│   ├── selection-assistant.js
│   ├── voice-settings.js
│   ├── advanced-features.js
│   └── quick-actions.js
├── schema-surface.js          # 全局设置挂载入口
├── render/                    # 渲染器：field-renderer / widgets / canonical-row
├── store.js                   # 设置存储
└── value-semantics.js         # 值语义

modules/settingsManager.js     # ★ 2300+ 行旧时代管家，本次要"解除武装"的对象
Groupmodules/grouprenderer.js  # ★ 群聊侧旧渲染器，同样要审计
styles/setting/                # legacy 侧边栏样式（20 个文件，待退役）
styles/ui-system/settings-sidebar.css   # 现代样式唯一所有者（目标）
```

---

## 2. 两套设置体系（务必分清）

项目里有**两套完全不同的设置界面**，架构演进阶段不同，不要混为一谈：

| | 全局设置 | 侧边栏设置（本次重构对象） |
|---|---|---|
| 入口 | `#globalSettingsForm` | `#agentSettingsContainer` / `#groupSettingsContainer` |
| 渲染 | `schema-surface.js` + 各分区 schema | `sidebar-surfaces.js` |
| 样式 | `styles/ui-system/settings.css`（已收敛） | `styles/settings.css` → `styles/setting/*`（legacy，20 个文件） |
| 状态 | **已基本完成现代化** | **正在重构中** |

全局设置的迁移是成功样板，侧边栏要照着它的样子做。

---

## 3. 为什么要重构：四个病根

这不是"代码不优雅"的问题，是**每天都在产生线上 bug** 的结构性缺陷。

### 病根 1：双重所有权 —— 两套大脑抢同一个按钮

新架构 `sidebar-surfaces.js` 渲染出折叠标题并绑定点击；旧代码 `settingsManager.js:2258` 扫描页面后又绑了一次。用户点一下，两个监听器在**同一刷新帧内先后翻转 class**，互相抵消 —— 表现就是"怎么点都打不开，像死机一样"。

**这就是"自定义样式设置"打不开那个 bug 的真实原因。**

### 病根 2：字符串拼接 ID —— 黑盒猜谜

```js
id: `${key[0].toUpperCase()}${key.slice(1)}ToggleHeader`   // 生成 #IdentityToggleHeader
```

而 CSS 里写的是 `#identityToggleHeader`（小写 i）。**没有任何编译期报错**，浏览器静默让样式失效，箭头因此下沉 7 个像素。这类问题靠人眼 review 抓不住。

### 病根 3：CSS 四代同堂 —— 地质断层

一个展开箭头同时被 4 个年代的文件影响：

```
styles/setting/settings-agent-sections.css    (2024 拟物)  align-items: start
styles/ui-system/settings-template.css        (全局基础)   align-self: start !important
styles/ui-system/settings-sidebar.css         (现代规范)   align-items: center
styles/themes.css                             (主题覆盖)   + 负边距
```

每个文件都有自己的 `!important`。**你在一个文件修好，另一个旧文件从背后捅一刀。**

### 病根 4：测试在隔离环境跑 —— 单测全绿，一跑就挂

单元测试只加载新模块，没有旧管家在旁边捣乱，所以 PASS；真机上两个模块同页面运行，立刻死锁。**缺少集成碰撞测试是这类 bug 漏网的直接原因。**

---

## 4. 重构目标与铁律

### 目标架构

```
schema（key/类型/文案/依赖）→ 渲染器 → uiux 原语 → dsw 单层级联
```

### 两条铁律（不可妥协）

**铁律一 · 视觉零变化。** 重构后每一个像素、间距、字号、颜色、交互行为必须与重构前完全一致。这不是"尽量"，是硬性验收条件。

**铁律二 · 单一所有权。谁渲染 DOM，谁独占事件监听器。** `settingsManager.js` 必须退回纯业务层（数据读写 + 状态投影），彻底删除它内部一切 `querySelector` + `addEventListener` 的 DOM 操作。

> 这两条原则在项目里已有正式契约文件：`docs/global-settings-section-ownership.md`
> 核心条款：每个 section 只能有一个 presentation owner；`settingsManager`、IPC 和 persisted key 仍是业务权威；owner 只能持有 listener/observer/primitive/projection，不得新增 durable store。

---

## 5. 重构计划（Stage 0 → C）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **Stage 0** | 基线锁定：git 回滚点 + computed style 快照 + 截图存档 | ✅ **完成** |
| **Stage A** | JS 单一所有权：正则分区迁入 Schema → settingsManager 瘦身 → 群聊同权审计 → 集成碰撞测试 | ⬜ 未开始 |
| **Stage B** | CSS 单一来源：legacy 样式移植并退役，收敛到 `settings-sidebar.css` | ⬜ 未开始 |
| **Stage C** | 全量验证门禁：parity diff 为空集 + 截图无差异 + 全部 guard 通过 | ⬜ 未开始 |

### Stage 0 已完成的具体成果

- **回滚点**：`05f1eff6` chore: pre-refactor baseline
- **样式基线**：`screenshots/refactor-baseline/baseline.json`（1.46 MB）
  - `agent:dark` 191 元素 / `agent:light` 191 元素
  - `group:dark` 97 元素 / `group:light` 97 元素
  - 每元素记录 60+ 个 computed style 属性
- **截图基线**：10 张 PNG
  - Agent：折叠态 / 基础信息展开 / 正则展开 × 深色 + 浅色
  - Group：折叠态 / 展开态 × 深色 + 浅色
- **采集脚本**：`scripts/audit-settings-style-parity.mjs`（Electron + CDP，无外部依赖）

> 基线有效性已验证：JSON 中能查到 `regexToggleHeader`、`stripRegexListContainer` 等**运行时才插入**的节点，证明采集的是真实运行态 DOM，不是空壳页面。

---

## 6. 今日时间线（2026-09-06）

| 时间 | 事件 |
|---|---|
| 13:03 – 13:41 | 连续 6 个提交：Agent/Group 侧边栏迁入 schema surface → 样式收敛到 design token → 群聊 DOM 移入 owned slots → 运行时所有权契约更新 |
| 13:41 | `fix(settings)` 修复浅色主题侧边栏 token |
| 14:06 | `fix(ui)` 修复侧边栏行与头像图标渲染 |
| 18:13 | **提交 pre-refactor baseline**（`05f1eff6`） |
| 18:26 | 创建 parity 脚本并首次采集 —— **失败**，4 个场景全部 `surface not found` |
| 18:35 – 18:52 | Stage A1 动工，写入一半后中断，工作区留下崩溃代码 |
| 19:01 | parity 脚本修复，**基线真正建成**（1.46 MB + 10 张截图） |
| 19:06 | 工作区回滚至干净 HEAD，半成品隔离进 `stash@{0}` |

### 18:52 那次事故复盘（新人必读）

中断时留下的状态：

```
sidebar-surfaces.js:305  →  form.append(renderRegexSection(doc));
                            函数根本不存在 → ReferenceError
测试：9 通过 / 3 失败（同一报错）
```

**这是"调用已写、函数没写"的典型半成品状态。** 同时 `grouprenderer.js` 被整文件改写为 CRLF 行尾，造成 327 行假 diff 噪音。

**处理结论**：`stash@{0}`（命名 `wip-stage-a-incomplete`）内容为零价值破坏性改动，建议 `git stash drop`，**不要恢复**。

---

## 7. 当前仓库状态（交接基准）

```
HEAD:        05f1eff6 (exp/settings-schema)
工作区:      干净（仅 scripts/audit-settings-style-parity.mjs 未跟踪）
测试:        12/12 通过
基线:        有效（1.46 MB JSON + 10 张截图）
stash@{0}:   wip-stage-a-incomplete —— 待丢弃
```

**一句话**：现在是一个干净的、可运行的、有基线保护的重构起点。

---

## 8. 关键文件地图

### 必改

| 文件 | 行数 | 问题 |
|---|---|---|
| `modules/settingsManager.js` | 2370 | 34 处 `addEventListener`，DOM 触手遍布。热点：`setupStyleCollapsible()`（2249–2268）、`createStripRegexUI()`（1538+）、`setupAgentSettingsSections()` |
| `modules/settings/schema/sidebar-surfaces.js` | 368 | 新架构主渲染器，A1 要在这里补 `renderRegexSection` |
| `Groupmodules/grouprenderer.js` | — | 群聊侧同权审计对象（注意：文件原生为 CRLF/LF 混合行尾，编辑时不要整文件重写） |

### 必删（Stage B）

`styles/settings.css` 目前 import 了 20 个 legacy 文件，其中待退役的核心目标：

```
setting/settings-agent-sections.css       (44 KB)
setting/settings-group-sections.css       (51 KB)
setting/settings-agent-identity.css       (22 KB)
setting/settings-agent-prompt.css         (20 KB)
setting/settings-agent-style-collapse.css
setting/settings-schema-surface.css       (第三代伪现代层)
setting/settings-form-controls.css
setting/settings-invite.css
setting/settings-agent-params.css
setting/agent/agent-card-*.css
setting/agent/agent-prompt-editor.css
```

保留（不属侧边栏表面）：`settings-sidebar-tabs.css`、`settings-sidebar-list.css`、`settings-search.css`。

### 样式入口

`styles/ui-system/settings.css` 是**现代样式入口**，有 invariant 测试保护：

> "Do not add rules here and do not reorder the imports; the uiux-settings-css-parts invariant test enforces both."

**这个文件的 import 顺序不能动。**

---

## 9. 门禁体系（改完必跑）

```bash
# 核心回归（最快反馈）
node --test tests/settings-elements-interaction.test.mjs          # 12 项，当前全绿

# 样式 & 视觉基线
node scripts/audit-settings-style-parity.mjs --out after.json --diff screenshots/refactor-baseline/baseline.json

# UI 体系门禁
npm run check:uiux                 # 109 项原语测试 + schema 金测
npm run lint:ui-system             # stylelint: no-important / no-duplicate-selectors
npm run guard:ui-system
npm run guard:design-subtraction
npm run guard:classic-retirement
npm run guard:classic-parity
npm run guard:theme-provenance
npm run check:settings-ownership   # 所有权契约校验

# 格式
git diff --check                   # 零悬挂空白
```

**完整门禁列表**见 `package.json` 中 `guard:` / `check:` / `audit:` / `lint:` 前缀的脚本（共 24 个）。

---

## 10. 给新人的六条铁律

1. **没有有效基线，不许动 CSS。** 现在的基线就是你的保命符，每次改完必须跑 parity diff，差异必须是空集。
2. **一个落点一次提交。** 禁止攒大改。删一处 → 跑测试 + parity → 提交。
3. **绝不允许把崩溃状态留在工作区。** 上次事故就是教训。宁可 stash，不要留半成品。
4. **禁止字符串拼接 DOM ID。** 用常数字典，杜绝大小写脱靶。
5. **不要整文件重写。** `grouprenderer.js` 那 327 行假 diff 就是教训。编辑前确认行尾，用精确 Edit 而非覆盖写。
6. **`styles/themes.css` 全程不碰。**

---

## 11. 下一步（建议执行顺序）

### 第 1 步：清理（5 分钟）
```bash
git stash drop          # 丢弃零价值半成品
git status              # 确认工作区只剩未跟踪的 parity 脚本
```

### 第 2 步：Stage A1 —— 正则分区完整迁入 Schema
- 在 `sidebar-surfaces.js` 中实现 `renderRegexSection(doc)`（**含完整函数体**，上次就死在这）
- 保留既有 DOM id：`regexToggleHeader`、`regexToggleBtn`、`regexSummary`、`regexContent`、`stripRegexListContainer`
- 插入位置：tts 之后（与 `createStripRegexUI` 现行位置一致）
- 删除 `settingsManager.js` 中 `createStripRegexUI` 的 DOM 构建部分，保留 `renderRegexList()` 等业务方法
- **验收**：12 项测试全绿 + parity diff 空集

### 第 3 步：Stage A2 —— settingsManager 解除武装
按"删一处 → 验一次 → 提交一次"推进。注意 API 冻结：外部 6 个调用方（renderer.js、preset-prompt-module.js、mainChatSettingsPresentationOwner.js、server-connection.js、grouprenderer.js、settings-sidebar-slots.js）的签名必须零变化。

### 第 4 步：Stage A3 —— 群聊同权审计
确认 `grouprenderer.js` 的 controller 只做摘要投影、不绑 header 交互。

### 第 5 步：Stage A4 —— 集成碰撞测试
在**同一个 JSDOM** 里同时装载 schema surface + settingsManager，断言每次点击 `collapsed` 恰好翻转一次。这是防"单测全绿、真机死锁"的唯一手段。

### 第 6 步：Stage B —— CSS 收敛
以"当前实际胜出值"为移植基准（谁在 `!important` 战争中赢了，就把那个值原样搬到唯一所有者），逐个文件移植、逐个删除、逐个跑 parity diff。

---

## 12. 一句话给接手的人

**这是一个方向正确、但执行纪律出过问题的重构。** 计划本身没问题（单一所有权 + CSS 单一来源），问题出在"没建基线就动手"和"允许半成品留在工作区"。现在基线已经建好，只要严守"每个落点跑门禁、绝不留崩溃态"，这条路走得通。

---

## 13. 对抗性审查：找出的 7 大样式断层与 4 大隐蔽 Bug（真实基线比对）

> 审计对照基准：上游主分支基线提交 `3ca4f032`（即上游作者认可的原版未重构基线）与 16 个已删除 CSS 规则的逐行对比。

### 7 大样式断层与视觉缩水

1. **基础信息卡片封装彻底归零**：
   - *上游原版（`settings-agent-identity.css`）*：外层包裹 `.agent-identity-container` 卡片，具有 `padding: 4px 15px 0`、`border: 1px solid var(--border-color)`、`border-radius: 12px` 与 `margin: 10px 0`。
   - *重构现状*：`styles/ui-system/settings-sidebar.css` 中该选择器规则数为 0，导致头像与输入框直接悬浮在底色上，视觉产生严重裸露与割裂感。
2. **头像尺寸与圆角私自篡改（60px vs 76px）**：
   - *上游原版*：头像容器与图片固定为 `60px × 60px`，圆角严格为 `16px`，具有 `border: 1px solid rgba(0, 0, 0, 0.08)`。
   - *重构现状*：在 `sidebar-surfaces.js` 与 `settings-sidebar.css` 中被擅自篡改为 `76px × 76px`，圆角退化为通用变量，破坏了侧边栏紧凑精致比例。
3. **相机更换头像蒙层降级为常驻右下角小徽章**：
   - *上游原版*：全覆盖式 `.avatar-upload-overlay`，默认 `opacity: 0`，仅在鼠标悬停于头像时触发 `opacity: 1` 半透明遮罩（`rgba(0, 0, 0, 0.45)`），内部 SVG 带有白光投影（`drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3))`）。
   - *重构现状*：被改为常驻显示在右下角的 24px 灰色小徽章，不仅遮挡头像右下角，还丢失了交互质感。
4. **Agent 名字输入框精致标题感丢失**：
   - *上游原版*：针对 `#agentSettingsContainer .agent-name-wrapper input[type="text"]` 独立配置 `height: 36px`、`border-radius: 10px`、`font-size: 13.5px` 与 `font-weight: 600`。
   - *重构现状*：被降级为通用普通输入框，字重与卡片化包裹感彻底消失。
5. **自定义样式手风琴箭头动效与胶囊高亮退化**：
   - *上游原版（`settings-agent-style-collapse.css`）*：`.style-collapse-header::before` 提供悬停胶囊微高亮；`.style-collapse-icon::before` 采用纯 CSS 伪元素 45 度平滑旋转。
   - *重构现状*：一度被改为硬编码文本字符 `>` 与 `v`，丢失微动效。
6. **模型选择器内嵌布局与文字遮挡冲突**：
   - *上游原版*：`#openModelSelectBtn` 作为图标按钮绝对居右嵌入输入框内部，输入框具备 `padding-right: 36px` 安全区。
   - *重构现状*：一度被改为并排布局，长模型名称会顶格重叠。
7. **浅色模式输入框层次感丢失与底部动作条切边**：
   - *上游原版*：输入框底色与面板有清晰级差；底部动作条留有水平缓冲防线。
   - *重构现状*：浅色模式下输入框发灰融底；`.form-actions` 按钮左右顶格贴死滚动条产生切边。

### 4 大隐蔽 Bug 与功能缺陷

1. **双向颜色同步脱节与头像边框无实时预览**：
   原生拾色器与 HEX 文本框未建立实时联动，修改十六进制文本或重置颜色后，头像边框无法实时同步渲染。
2. **手风琴嵌套手风琴与默认全折叠压制**：
   由于初始 `restoreCollapseStates` 默认全部为 `true`，首次进入设置时基础信息被折叠隐藏，且外层基础信息折叠与内层自定义样式折叠产生父子冲突。
3. **自动化门禁“自我欺骗”与假绿漏洞**：
   测试脚本仅在未发生任何点击的静态初始态下抓取一次样式，并且主动将 `transform`、`transition`、`opacity` 从比对矩阵中剔除，导致动效全部丢失却判定 PASSED。
4. **群聊发言顺序拖拽手柄缺失手势语义**：
   `.sequential-speaker-drag-handle` 丢失 `cursor: grab` / `grabbing`，用户无法感知拖拽交互。

---

## 14. 彻底解决与验收标准（DoD）

1. **Schema 结构与尺寸还原**：Agent 与群组头像预览统一恢复为 `60px × 60px`，圆角 `16px`。
2. **CSS 卡片与动效还原**：在 `settings-sidebar.css` 完整补齐 `.agent-identity-container` 12px 圆角外壳、相机全覆盖悬停遮罩、纯 CSS 45 度旋转指示器。
3. **交互与联动**：`syncColorPair` 双向联动 Hex 与拾色器，实时驱动边框样式。
4. **门禁全绿**：`tests/settings-elements-interaction.test.mjs`（14/14 通过）、`npm run check:uiux`（146/146 通过）、`npm run lint:ui-system`（通过），零 `!important`，不碰 `styles/themes.css`。
