# DeepSeek Harness 插件化 UI 与社区皮肤机制研究

> 研究日期：2026-08-19
> 研究对象：本地 `C:\VCP\vchat-develop\deepseek-harness`、Harness Client UI 包、官方插件开发规范，以及公开可见的主题/外观/Galgame 皮肤插件仓库。
> 研究目的：解释 Harness 的“极端组件化”到底是什么，社区插件如何增强原 UI，并判断哪些机制适合 VCPChat。
> 当前项目事实：[`next-ui-current-state.md`](./next-ui-current-state.md)。

## 一、结论先行

DeepSeek Harness 的 UI 确实高度组件化，但它的核心不是“把所有 HTML 都换成 React 组件”，而是把 UI 能力拆成可组合、可定位、可撤销的 Client 插件：

```text
Host Plugin（可没有运行时逻辑）
        ↓ 组合/授权
Client Plugin
  ├── 订阅一个明确 Slot
  ├── 使用 Theme Service 的语义 token
  ├── 只渲染自己的局部组件
  ├── 通过 Host Call/标准 props 取得所需数据
  └── 由 Cordis effect 自动撤销
```

它不鼓励插件直接接管 `document.body`、全局 `window` 或硬编码产品 DOM selector。正式扩展应该进入 Slot、Theme Service 或 Package 自己的局部样式；只有皮肤层为了实现整套视觉状态，才会在明确范围内观察稳定的产品 DOM，并把所有写入和 Observer 收回。

社区插件大致分为三类：

1. **Token/Slot 原生扩展**：例如外观插件通过 `ctx.theme.overrideTokens()`、`settings.general.item` 和本地持久化增加主题设置，卸载后恢复默认。
2. **局部皮肤叠加**：例如 Afterglow 只增加自己的角色立绘、HUD、名牌和 CSS，并通过真实 DOM 状态判断对话/执行/错误，不伪造进度。
3. **工作区/Agent 辅助项目**：例如 Galgame 工具把角色卡、RAG、图片生成和人格切换接成工作流，不一定直接替换 Harness 主 UI。

对 VCPChat 的启示是：应把 VCPUI 继续发展为“稳定的 UI 扩展平台”，但要同时提供主题 token、Surface Slot、状态选择器、owner scope 和卸载合同。VCPChat 当前已经有 `VCPUI`、`LifecycleScope`、`apps/commands Registry` 和嵌入式 App；缺的是一套面向第三方皮肤的正式扩展面。不能让插件只能靠 `styles.css + querySelector + MutationObserver` 猜测主窗口结构。

## 二、Harness 的 UI 架构到底是什么

### 2.1 Web 入口极薄，实际 UI 在 Client 包

本地 Harness 的 `apps/web/src/main.ts` 只负责找到 `#root` 并启动 `AppWebEntry`。Loader、模块表、AppRoot、插件组合和客户端 UI 不在入口文件里展开。

实际 UI 分布在 `packages/client/ui-*`：

- `ui-conversation`：聊天、消息、输入、队列、分支、工具状态；
- `ui-sidebar`、`ui-layout`：布局和侧栏；
- `ui-settings-*`：设置领域和具体设置区；
- `ui-theme`：主题 token、启动主题和外观设置；
- `ui-slots`：插槽声明、查询和注册；
- `ui-tool`、`ui-plan`、`ui-goal`、`ui-subagent`：业务能力对应的局部 UI；
- `web-react`：Client React 运行时桥接。

这是一种“按能力和领域拆包”的组件化，而不是按视觉原子拆成几百个无业务归属的组件。一个 `ui-conversation` 包可以内部包含多个 React component、store、状态机和 CSS；外部只依赖它公开的 Slot、props、事件和服务。

### 2.2 Slot 是扩展点，不是任意 DOM 注入

插件开发规范要求先查询 Slot 树，再注册最窄的入口：

```text
settings.general.item
sidebar.footer.action
conversation.chat.turnTail
tool.view.cordis
shell.overlay
```

Slot 会声明自己的目的、拓扑、注册协议（single/list/keyed/chain）、props 和当前 occupant。插件注册 disposer，停止或更新时自动移除。

这带来三个重要性质：

1. 插件不需要猜测“某个按钮现在在 DOM 哪个位置”；
2. 多个插件可以在同一个区域并存、排序或按 key 替换；
3. 产品主 UI 改布局时，只要 Slot 合同稳定，插件不必跟着改 selector。

Slot 不是“允许插件重写整个页面”的通行证。规范明确提醒：不要默认注册 root/sidebar/conversation 等大 Slot，因为替换一个顶层 occupant 可能连同其 descendant Slots 一起删除。

### 2.3 Theme Service 与局部样式分工

Harness 把主题分成两层：

- **全局主题**：先查询 Theme token，再通过 `theme.overrideTokens()` 覆盖语义变量，并保存 disposer；
- **插件局部组件**：使用 `styles.insert(css)` 或 CSS Module，颜色优先引用主题变量，不改全局产品 DOM。

主题服务只改变 token，不创建 UI；Slot 只创建 UI，不替代主题系统。这是一个很重要的分工，避免“一个皮肤插件既创建巨大 DOM，又重写所有主题变量，又接管业务行为”。

公开的 `dsh-ui-appearance` 是一个典型例子：

- 通过 `settings.general.item` 注册“个性化外观”设置行；
- 颜色角色通过 `ctx.theme.overrideTokens()` 覆盖语义 token；
- 壁纸使用自己拥有的 fixed layer，位于 `#root` 之下；
- 模糊应用在壁纸 layer，而不是 `#root` 的 `backdrop-filter`，避免改变 fixed tooltip、toast 和菜单的 containing block；
- 设置存入插件自己的 `localStorage` 命名空间，并在加载时 schema 校验和钳制；
- 插件卸载时撤销 token、style、背景图层和视频 URL。

这个设计比“把一张背景图塞到 body，再给所有元素加半透明”稳定得多，因为它明确了层级、性能和撤销责任。

### 2.4 Host/Client 双半部

Harness 插件通常有 Host 半部和 Client 半部：

- Host 负责插件组合、权限、生命周期和必要的 Host Service；
- Client 负责浏览器 UI、Slot、主题和局部状态。

很多纯主题插件的 Host `apply()` 是空的，这是有意的：它只需要被组合树加载，真正的主题/设置逻辑在 Client。这样可以避免为了声明一个 UI 设置而把浏览器代码、React 或主题依赖带到 Node Host。

这对 VCPChat 的启示不是照搬 Host/Client 包，而是区分：

- Electron main/preload 能力；
- renderer Surface；
- 纯视觉插件；
- 需要 IPC/文件/网络的插件。

不需要 IPC 的皮肤不应该为了改几个 token 进入 main process，也不应取得不必要的权限。

## 三、社区换肤和 Galgame 插件如何增强原 UI

### 3.1 纯主题包：生成 token，而不是逐条写组件 CSS

`nevertoday/dsh-theme-plugin` 的做法很有代表性：49 个传统色锚点 × light/dark = 98 个主题，每个主题完整生成 token 词汇，包含文本、背景、边框、按钮、气泡和 Shiki 语法高亮，并用 3136 条对比度断言验证 WCAG AA。

它还把用户难以理解的“颜色参数”转成工作情绪筛选（晨起、心流、禅定、攻坚、爆肝、夜航、收工），主题选择器自己也使用同一套 token 预览。这里的关键不是主题数量，而是：

- 主题由数据生成，不手工维护 98 份 CSS；
- 主题完整覆盖 token vocabulary，缺一项就失败；
- 对比度、色相分离、最饱和区域和派生关系都有可计算的不变式；
- light/dark 是同一主题数据的两个投影，不是两套随意 CSS。

VCPChat 当前的纸墨与机芯、Aero 等主题仍有“源主题文件 + 运行时生成 `styles/themes.css` + 组件特例”的多层真源风险；Harness 主题包说明我们应把主题变成可生成、可审计、可回滚的 token 数据，而不是通过 `!important` 修补视觉。

### 3.2 外观插件：设置 Slot + token 覆盖 + 独立背景层

`dsh-ui-appearance` 提供调色器、壁纸/视频、透明度、模糊、遮罩、预设、导入/导出和跨标签同步。它不是修改核心 UI，而是：

```text
settings.general.item
        ↓
localStorage schema
        ↓
token override + owned background layer
        ↓
局部 CSS 使用 token
```

它特别值得 VCPChat 借鉴的技术细节：

- 背景图层 `pointer-events: none`，不阻断产品交互；
- 图层 `inset: -48px` 给 blur 留出边缘空间，避免透明 bleed；
- 不对 `#root` 使用 `backdrop-filter`，防止固定定位菜单/Toast 被重新锚定；
- 视频对象 URL 有明确 revoke，旧视频被替换时删除 IndexedDB 记录；
- 异步视频加载有 key 对账，旧请求完成后不能把已删除视频重新挂回 DOM；
- localStorage 失败时保留当前会话状态，但不假装持久化成功。

这比 VCPChat 当前一些主题规则直接叠加 `backdrop-filter`、阴影和透明层更容易控制，也能解释最近聊天滚动、气泡光晕和主题重新应用问题。

### 3.3 Galgame 皮肤：观察真实 DOM，增加自己的 presentation layer

`xemaya/dsh-afterglow` 是一种不同的设计：它不是改造 Harness 内部组件，而是在原 UI 上增加自己的角色 stage、名牌、战斗 HUD 和状态装饰。

它的核心方法：

1. 创建完全属于皮肤的节点，并加 `data-skin-owner="afterglow"`；
2. 用 `MutationObserver` 观察少量稳定的产品事实：
   - `[data-question-key]` / `[data-plan-review-key]` / `[data-approval-key]`：真实选择态；
   - `[data-state='running']` 或 `[role='status']`：真实执行态；
   - 工具行变为 `[data-state='error']`：真实错误态；
3. 把这些事实映射成 `dialogue / battle / choice / alert / clear` 皮肤状态；
4. 用双图片交叉淡入切换立绘，避免替换正在显示的图片造成闪烁；
5. 所有新增节点、body 属性、背景样式、favicon、title、Observer 和 timer 都由一个 effect disposer 回收；
6. 皮肤装饰节点统一 `aria-hidden="true"`，不把纯装饰伪装成业务信息；
7. `prefers-reduced-motion` 下关闭动画；
8. 不制造假的百分比或假的“执行进度”，所有状态来自产品真实 DOM。

这类皮肤的优点是自由度极高：可以把普通聊天变成 Galgame 对白，把执行状态变成 Boss 战 HUD，把审批变成路线选择，把 Agent 变成有表情的角色。但它的代价也很明显：

- 依赖宿主 DOM selector；
- 宿主改名/改结构会导致皮肤失效；
- MutationObserver 可能带来性能成本；
- 皮肤状态和业务状态之间容易产生误判；
- 如果没有 disposer，换肤/热重载会重复添加节点和监听器；
- 如果插件重写产品 DOM，容易和主 UI 的焦点、ARIA、主题和测试发生冲突。

Afterglow 的可取之处不是“所有皮肤都应该观察 DOM”，而是它把这种做法限制在**明确的 presentation-only 层**，并且只观察稳定、可解释的状态属性。

### 3.4 Galgame 工作流项目：不一定是 UI 皮肤

`deepseek-harness-galgame` 这类项目更接近“工作区 + Agent workflow”：角色卡、设定库 RAG、人格切换、图片生成和本地绘画后端组成一条创作流水线。它可以让对话呈现 Galgame 体验，但主要改变的是 Agent 的人格、资料和工具工作流，不一定直接替换主聊天 UI。

这提醒我们区分三种产品变化：

| 类型 | 改变什么 | 适合的扩展面 |
|---|---|---|
| Theme | 颜色、字体、背景、材质、密度 | Theme token / appearance settings |
| Skin | 额外角色层、HUD、名牌、状态装饰 | presentation Slot / owned overlay |
| Workflow | 角色卡、RAG、图片生成、工具和人格 | Agent/Tool/Workspace capability |

把 Workflow 误做成 CSS 皮肤，会导致 UI 承担业务状态；把 Skin 误做成聊天业务改造，则会破坏上游语义。VCPChat 应该为三者保留不同边界。

## 四、这是否真的是“极端组件化”

### 4.1 极端之处

Harness 把以下内容都做成独立 Client package 或可查询扩展面：

- 聊天输入、消息行、工具行、审批、计划、目标、队列、侧栏、设置、主题；
- 每个页面扩展通过 Slot 注册；
- 每个插件的服务、timer、style、theme override 和注册都要求 disposer；
- 主题和 UI 通过 token/Slot 传递，而不是跨插件查找 DOM；
- 测试按具体 UI package、真实浏览器入口和 snapshot 场景拆分。

### 4.2 它并不极端到“每个元素都是插件”

一个 UI package 内部仍然可以拥有组合组件、store、状态机和局部 CSS。拆分的依据是：

- 是否有独立 owner；
- 是否有独立生命周期；
- 是否有独立生产消费者；
- 是否需要独立测试/发布；
- 是否需要被插件扩展。

如果一个按钮只被一个页面使用，它不一定要成为公共插件；如果一个设置区需要第三方扩展，就应该有 Slot；如果只是统一颜色，就应该是 token，而不是新的组件 API。

这正好对应 DeepSeek Harness simplification 规范：没有消费者的公共面、Registry kind、runtime 或测试 facade 应删除，而不是因为“组件化看起来先进”就保留。

## 五、对 VCPChat 的直接启示

### 5.1 建立三层可扩展 UI 合同

VCPChat 可以在现有 VCPUI 之上增加三个明确层次：

```text
VCPUI Foundation
  ├── Theme tokens：颜色、材质、密度、焦点、motion
  ├── Stable components：Button/Input/Select/Modal/Toast...
  └── App Shell：Tab、Launchpad、Overlay、内嵌 View

VCPUI Surface Slots
  ├── settings.general.item
  ├── chat.composer.leading / trailing
  ├── chat.message.meta / turnTail
  ├── sidebar.footer.action
  ├── app.overlay
  └── account.menu.item

Presentation Skin API
  ├── state selectors（只读真实产品事实）
  ├── owned DOM/overlay
  ├── scoped style sheet
  ├── theme override（可选）
  └── disposer / reduced-motion / accessibility contract
```

第一层是当前 VCPUI；第二层是未来第三方扩展的正式入口；第三层允许 Galgame/角色皮肤存在，但不能直接修改聊天业务状态或替换整个主窗口。

### 5.2 先提供 Slot，不要先允许任意 DOM 注入

最有价值的首批 Slot 应该是“小而高频”的局部入口：

- 主聊天输入框前后区域；
- 消息尾部操作区或真实 turn tail；
- 侧栏底部工具入口；
- Account Menu 的附加项；
- Launchpad/App 页面工具栏；
- 全局 overlay 的装饰层；
- 设置页明确的 `general.item` 或独立 section。

暂不开放：

- 替换整个聊天根节点；
- 替换主 Sidebar/主 Tab Host；
- 直接改消息业务 HTML；
- 直接注册 preload/IPC 任意方法；
- 读取所有 manager 私有状态。

### 5.3 为皮肤提供稳定的只读状态事实

Afterglow 依赖 DOM selector 是因为它没有更好的公开状态面。VCPChat 可以提供更稳定的只读状态属性或事件：

```text
data-vcp-chat-state="idle|streaming|error|waiting"
data-vcp-active-surface="chat|settings|app"
data-vcp-dialog-state="open|closing|closed"
data-vcp-tool-state="running|success|error|stopped"
data-vcp-theme="..."
```

皮肤只能读取这些状态，不能写入它们。状态由 ChatManager、OverlayCoordinator、AppTabHost 和 Theme engine 负责发布。这样皮肤不会依赖 `.some-old-class-name`，也不会自己猜测“是不是在运行”。

### 5.4 皮肤的生命周期合同

一个 VCPChat 皮肤正式启用前至少必须提供：

- `mount()` / `dispose()`；
- 自己的 root 标识和所有节点 owner；
- 自己的 style sheet 和 token override disposer；
- Observer、timer、Promise 和 object URL 清理；
- theme/light-dark 变化同步；
- `prefers-reduced-motion`；
- 装饰节点 `aria-hidden`，交互节点拥有完整 ARIA；
- 不覆盖业务焦点、不劫持 Escape、不伪造进度；
- renderer reload/crash 后可重新挂载或安全失效。

### 5.5 主题系统应借鉴生成式 token

对 VCPChat 来说，最现实的改进不是立刻支持 98 个主题，而是：

1. 定义完整且稳定的 semantic token vocabulary；
2. 主题源数据生成 light/dark token；
3. 自动检查对比度、focus ring、disabled、selection、代码高亮、气泡和滚动条；
4. 禁止主题源与实际加载产物漂移；
5. 允许插件只覆盖明确的 token namespace；
6. 卸载插件后 token 完整恢复。

### 5.6 背景/毛玻璃要采用独立 Layer，而不是污染 root

`dsh-ui-appearance` 对 VCPChat 的直接启发：

- 壁纸用独立 fixed layer，`pointer-events: none`；
- blur 应用在壁纸 layer，而不是根容器；
- 避免 `backdrop-filter` 改变 fixed 菜单、Toast、Tooltip 的 containing block；
- 透明度和遮罩成为 token/变量，不要每个组件自己调 alpha；
- 视频/图片异步资源拥有 object URL、缓存和失败回退；
- 主题切换要用 key/token 对账，旧异步结果不能重新插回 DOM。

这可以直接降低 VCPChat 近期出现的启动错误首帧、气泡光晕、快速滚动半黑和主题重新应用后才恢复的问题。

## 六、哪些社区做法不能直接照搬

| 做法 | 看起来很灵活 | 真实风险 | VCPChat 处理 |
|---|---|---|---|
| 全局 CSS 覆盖所有 `.message-item` | 快速换皮 | 主题/上游改版时冲突，`!important` 失控 | 只允许 token 和 scoped Surface CSS |
| MutationObserver 观察整棵 body | 任何状态都能感知 | 性能、重复挂载、误判和 selector 脆弱 | 只观察稳定状态根或正式事件 |
| 替换主聊天 DOM | 视觉自由度最高 | 复制业务状态、破坏插件和消息语义 | 只做 presentation Slot/装饰层 |
| 皮肤自建一套 loading/progress | 视觉更像游戏 | 假进度、业务终态不一致 | 只映射真实 running/error/approval 状态 |
| 主题直接写 body/root backdrop-filter | 简单 | fixed overlay、Toast、菜单定位改变 | 独立 background layer |
| 把主题设置写进核心 settings | 看似统一 | 第三方设置 schema/权限耦合 | 插件 namespace + schema 校验 + disposer |
| 将 Galgame 角色卡和 UI 混为一体 | 体验连贯 | 业务人格、UI 状态和资源生命周期耦合 | Workflow、Skin、Theme 分层 |

## 七、建议的 VCPChat 落地路线

### B0：扩展面事实审计

- 列出当前 VCPUI、apps/commands Registry、settings bridge、Theme engine、Overlay、AppTabHost 的可扩展入口；
- 标记哪些是生产合同、哪些仅是内部实现、哪些是用户自定义的潜在需求；
- 搜索现有插件是否直接依赖私有 DOM、`!important` 或全局 CSS；
- 退出条件：没有未定义 owner 的“默认扩展入口”。

### B1：Theme Token 与资源撤销合同

- 收口主题源/产物，定义 token namespace 和插件 override owner；
- 提供背景 layer、图片/视频、模糊、遮罩、字体和 icon 的统一资源撤销；
- 退出条件：主题/外观插件可以安装、实时应用、重载、卸载并恢复默认，且没有 detached style/layer/object URL。

### B2：首批 Surface Slots

- 先开放聊天 composer、message tail、sidebar footer、Account Menu item、settings general item、app toolbar/overlay；
- 每个 Slot 明确 single/list/keyed/chain 协议、排序、props、owner、dispose 和权限；
- 不开放任意 DOM selector 和全局 root replacement；
- 退出条件：至少一个真实第三方式插件能注册、使用、卸载，产品原 UI 与其他插件不受影响。

### B3：Presentation Skin API

- 定义只读状态属性/事件；
- 提供 scoped skin root、装饰 overlay、theme token override、reduced-motion 和 dispose 合同；
- 建立一个最小“状态皮肤”示例，只展示真实 streaming/error/approval 状态，不伪造进度；
- 退出条件：皮肤可在聊天、设置和内嵌 App 之间切换，renderer reload/crash 后不重复挂载，所有装饰节点可归属和清理。

### B4：Galgame/角色化体验试验

- 以独立可卸载皮肤验证角色立绘、名牌、对话纸、状态 HUD、审批选择等表现；
- 角色卡、RAG、图片生成和人格切换仍属于 Workflow/Agent 插件，不塞进 Skin API；
- 交互元素必须使用真实 Slot 和业务事件，装饰元素 `aria-hidden`；
- 退出条件：主题、皮肤、无皮肤三种状态可逆，键盘、Escape、焦点和业务消息语义不退化。

### B5：市场/分发与安全边界

- 插件 manifest 声明 Host/Client 权限、Slot、token namespace、资源大小和版本；
- 安装/更新/卸载有明确状态和失败回滚；
- 禁止第三方皮肤任意读取敏感聊天内容、调用未声明 IPC 或注入外部网络资源；
- 退出条件：恶意/损坏/旧版本插件不会破坏主 UI，卸载能恢复所有产品资源。

## 八、最终判断

DeepSeek Harness 的“极端组件化”值得借鉴的是**扩展点和所有权的精确化**，不是无条件拆分或 React 化。它允许社区把同一套聊天产品变成传统色主题、毛玻璃外观、Galgame 对话或战术 HUD，是因为核心 UI 已经把“数据/状态、Slot、Theme、局部组件、Host 权限、生命周期”分开。

VCPChat 现在已经完成了内部架构收口，但还没有把这套能力正式开放给皮肤生态。最稳妥的下一步是先做 B0–B2：收口主题 token，提供少量高价值 Surface Slot，建立安装/卸载和 disposer 合同；之后再做 B3–B4 的 Galgame/角色化试验。不要先允许任意 CSS/DOM 注入，否则会把当前正在解决的两套 UI、主题漂移、焦点误关和资源泄漏重新引回来。

## 参考证据

- 本地 Harness：`C:\VCP\vchat-develop\deepseek-harness\apps\web\src\main.ts`、`packages/client/ui-*`、`apps/cli/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md`。
- 主题插件：[`nevertoday/dsh-theme-plugin`](https://github.com/nevertoday/dsh-theme-plugin)。
- 外观插件：[`TQSY114514/dsh-ui-appearance`](https://github.com/TQSY114514/dsh-ui-appearance)。
- Galgame/工作流项目：[`FynnReinhardt/deepseek-harness-galgame`](https://github.com/FynnReinhardt/deepseek-harness-galgame)。
- Presentation skin：[`xemaya/dsh-afterglow`](https://github.com/xemaya/dsh-afterglow)。
