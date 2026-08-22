# VChat UI 参考研究：Cherry Studio 与 DeepSeek Harness

> 研究目的：把两个参考项目转化为 VChat 可执行的设计与工程原则，而不是复制其技术栈或页面。
> 
> Cherry Studio：`CherryHQ/cherry-studio`，本轮参考 HEAD `64ebe2336cb0472dd5d3ada79c56309342937c70`。
> 
> DeepSeek Harness：本机源码 `/Users/asahi/Documents/Codex/deepseek-harness`，重点参考 `docs/architecture.zh.md`、`docs/development.zh.md`、`docs/testing.zh.md`、`docs/web-styling.zh.md`、`docs/agent-lifecycle.zh.md`。

## 1. 结论先行

两个项目要分别借鉴：

| 参考 | 借鉴重点 | 不照搬 |
|---|---|---|
| Cherry Studio | 内容优先、克制中性、语义色、surface 层级、共享组件、页面自有组合、主题无分支 | React/Tailwind、具体品牌颜色、页面一比一复制 |
| DeepSeek Harness | 能力 seam、producer/consumer、显式 owner、可逆副作用、真实入口测试、证据和文档生成 | Cordis 全量引入、插件树替换 VChat 现有架构、把所有 UI 都改成事件系统 |

对 VChat 的综合方向是：

> 用 Cherry Studio 的“安静、内容优先、语义化视觉”统一页面体验，用 DeepSeek Harness 的“显式边界、可组合、可回滚、可证明”统一开发方式。

## 2. Cherry Studio：视觉与页面构成启发

Cherry 的 `DESIGN.md` 将全产品方向概括为 content-first AI workspace。对 VChat 最有价值的原则如下。

### 2.1 中性优先，颜色表达意义

应用 chrome 以中性表面为主，颜色只表达操作、选中、成功、警告、错误和数据类别。VChat 当前部分页面仍有各自的玻璃、金色、渐变和装饰性高光，后续应逐步收敛为：

- 页面和工作区使用中性背景；
- card、popover、sidebar 通过 surface 层级区分；
- accent 只用于主要行动和选中态；
- error、warning、success 使用语义色；
- 不用页面局部颜色代替 token。

这不意味着页面失去个性。Notes 可以偏文档、Translator 可以偏工具、Plugin Manager 可以偏状态，但个性来自布局和信息层级，而不是重新发明调色板。

### 2.2 内容先于装饰

Cherry 明确反对为了“看起来丰富”而堆叠渐变、阴影、玻璃和装饰容器。对 VChat 的直接启发：

- 先解决标题、辅助信息、主要操作和内容阅读顺序；
- 先用留白、排版、surface 和 hairline border 建立层级；
- 阴影只用于浮层和交互反馈，不作为普通静态卡片默认效果；
- 避免嵌套卡片和多层边框制造噪音。

### 2.3 页面拥有组合，系统拥有语义

Cherry 的全局设计文档只定义跨产品稳定的原则；组件精确高度、padding、radius、动画和可访问行为归组件；页面列宽、工具栏排列和内容流归 feature page。

这比“所有页面套同一个模板”更适合 VChat：

- 共享 App Header、Toolbar、Status、Button、Input、Card、EmptyState 的语义合同；
- Notes 自己决定编辑器/预览布局；
- Translator 自己决定源文/结果布局；
- Forum/Memo/Log 自己决定内容密度；
- 只有被多个独立页面证明后，才把局部模式提升为共享组件。

### 2.4 主题无页面分支

Cherry 的功能页面不写 `light`/`dark` 两套局部规则，而是使用语义 token。VChat 应将现有 `styles/themes.css` 主题变量桥接为 App Surface token，页面 CSS 不直接判断主题、不写裸色。

### 2.5 交互优先级和焦点

Cherry 的交互规则强调：

- 主要、次要、低强调和危险操作有清晰层级；
- icon-only 控件必须有可访问名称，含义不明显时有 tooltip；
- focus-visible 必须可感知，但不应额外画出脱离控件边界的第二个框；
- loading、disabled、invalid、selected、open 状态不能只靠颜色表达；
- 动效解释状态或空间变化，并尊重 reduced motion。

这将成为六页视觉验收的重要标准，而不仅是 CSS 美化标准。

### 2.6 对 Notes/Translator 的具体启发

Cherry 源码显示它把 Notes 和 Translate 作为真正的产品页面，而不是通用空壳：页面有独立的 Header、编辑/输入面板、结果/预览面板、语言/历史/设置等组合，同时复用统一 UI primitives。

VChat 的对应策略：

- Notes：优先阅读/编辑连续性，侧栏是导航，不应夺取文档注意力；
- Translator：源文、目标文、语言栏和历史是一个清晰的工作流，不做 hero 装饰；
- 两页都要将“没有内容、正在处理、处理失败、可继续操作”作为一等状态。

## 3. DeepSeek Harness：工程哲学启发

### 3.1 从“改文件”转向“设计 seam”

Harness 的核心不是某个组件，而是可替换的能力 seam：Service Definition、Provider 和 Consumer 三者同时存在。一个 API 没有真实 producer/consumer，就不应提前变成公共抽象。

对 VChat 的映射：

- `App Surface` 是视觉 seam：共享 token/shell 是 definition，页面层是 consumer，页面门禁是 evidence；
- VCPUI Provider 是控件 seam：Native、Web Awesome 和 VCP-owned pattern 是 provider，业务节点仍是真相；
- 页面状态是 presentation seam：业务 manager 生产事实，页面 controller 投影状态，CSS/DOM 消费投影。

今后新增公共 UI API 时必须回答：谁生产、谁消费、谁释放、如何证明没有消费者时不会留下死抽象。

### 3.2 显式 owner 和可逆副作用

Harness 的插件/事件注册在所属插件卸载时撤销；生命周期文档要求副作用有明确范围。VChat 不引入 Cordis，但应把同一哲学应用于页面：

- 每个 Surface 指定 mount owner 和 dispose owner；
- listener、Observer、timer、IPC task、Overlay、View、临时 DOM 都归 owner；
- close、replace、reload、renderer destroy 后迟到结果失去提交权；
- mount 中途失败要原子回滚，而不是留下半套控件；
- dispose 必须达到 quiescence，不能只发出取消请求。

### 3.3 持久事实和实时投影分离

Harness 把会话日志作为可回放的持久事实，把 agent 事件作为实时协调状态。VChat 不需要复制 SessionEvent，但应采用同一个区分：

- manager/IPC/数据文件是业务事实的来源；
- 页面状态是事实的投影，不得变成第二业务真相；
- loading、saving、error、selected 等瞬态只存在于页面 owner；
- 重新打开页面时从业务事实重新投影，而不是依赖上一次 DOM 残留。

### 3.4 真实入口和真实实现测试

Harness 测试策略强调真实 Loader、真实组合和真实构建入口；mock 只用于昂贵或不确定的外部边界。对应 VChat：

- 页面 CSS 可以有静态门禁，但最终视觉要走真实 Electron 页面；
- Provider 测试要覆盖真实业务 Select/表单，而不是只测假节点；
- 页面门禁要从真实 HTML 入口检查 opt-in、主题、几何和溢出；
- 失败路径、重复打开、关闭后迟到结果和 reload 要成为永久回归，而不是手工记忆。

### 3.5 证据优先于自我报告

Harness 要求从外部重新读取结果、回放 snapshot、验证持久化和真实进程，而不是只检查 agent 自己说“成功”。VChat 应把“看起来完成”拆成可观察证据：

- git diff 和页面边界证明改动范围；
- 静态门禁证明 token/layer/opt-in 合同；
- Electron smoke 证明真实入口和几何；
- operation sequence 证明操作顺序、失败和恢复；
- lifecycle stress 证明资源无持续增长；
- macOS/Windows/packaged/人工 soak 分别证明各自声明。

### 3.6 文档是工程的一部分

Harness 的架构、事件生产/消费、测试策略和样式职责都有明确文档来源，且生成文档和源码保持配对。VChat 也应保持：

- 总规范只写跨页面稳定原则；
- 当前状态文档只写已验证事实；
- 路线文档只写下一步和退出条件；
- 页面合同贴近页面；
- 测试数字带日期、平台、HEAD 和缺失证据；
- 不把历史方案当成当前拓扑。

## 4. 综合后的 VChat 设计原则

### P1：内容优先

页面的主内容、阅读顺序和主要操作先于装饰性容器。任何渐变、玻璃、阴影和色彩都必须说明它在表达什么结构或状态。

### P2：语义 token 优先

功能页面只使用语义 token，不使用裸色、私有主题分支或“看起来像 token”的临时变量。

### P3：共享行为优先

已有共享模式优先复用；只有多个真实页面需要并且行为合同稳定时才抽象。文档描述原则，组件源码拥有精确尺寸和交互行为。

### P4：页面组合自由

统一不等于千篇一律。共享的是语义、状态、可访问性和质量，不是强制每页相同的栏数、卡片或最大宽度。

### P5：事实和投影分离

业务 manager/IPC/数据是事实；页面 controller/DOM/CSS 是可销毁投影；不以 UI 方便为理由创造第二业务状态。

### P6：所有副作用有 owner

能注册的东西必须能撤销；能异步完成的东西必须有 generation/owner 检查；能失败的 mount 必须能回滚。

### P7：真实入口才算交付

静态检查、单测、真实 Electron、跨平台和人工证据分别回答不同问题，不能用其中一种替代全部。

## 5. 对当前路线的调整

现有 [工程规范](./vchat-ui-engineering-charter.md) 和 [路线图](./vchat-ui-development-roadmap.md) 继续有效，但后续实现应增加三项要求：

1. 每个页面视觉提交都说明自己采用了哪些 Cherry 原则，避免只增加装饰；
2. 每个共享抽象都记录 producer/consumer/owner 和删除条件，采用 Harness seam 思维；
3. 页面验收必须包含真实入口、状态矩阵和外部证据，不能只看 CSS diff。

## 6. 参考路径

### Cherry Studio

- `DESIGN.md`：全产品视觉方向、token 选择、surface、焦点、响应式和文档归属；
- `packages/ui/docs/design-token-system.md`：token namespace、语义映射和迁移规则；
- `packages/ui/src/styles/tokens/`：颜色、间距、圆角和 typography 的源码；
- `src/renderer/pages/notes/`：Notes 页面组合和编辑器/侧栏职责；
- `src/renderer/pages/translate/`：Translator 页面、语言栏、输入/输出面板和历史职责；
- `packages/ui/src/components/`：共享 primitive/composite 的实现和测试。

### DeepSeek Harness

- `docs/architecture.zh.md`：插件树、能力 seam、事件域、事实日志与实时状态；
- `docs/development.zh.md`：项目布局、构建入口、worktree 和门禁组织；
- `docs/testing.zh.md`：分层测试、真实入口、快照、e2e 和外部世界验证；
- `docs/web-styling.zh.md`：主题 owner、组件 CSS 职责、语义 token 和响应式规则；
- `docs/agent-lifecycle.zh.md`：持久事实、实时状态和可回放生命周期时序。
