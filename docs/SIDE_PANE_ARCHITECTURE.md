# 工作区侧栏（Workspace Side Pane）架构

## 1. 概述

侧栏是主聊天窗口右侧的一列标签页容器，用来放和当前对话并排使用的工具：通知、辅助对话、随手笔记、代码查看、Git 变更、浏览器、终端、命令输出、V工程计划等。

设计目标：

1. **状态和 DOM 分开**：标签列表、激活标签、是否展开都在一个纯函数状态模块里，可以单独测试；DOM 只是状态的投影。
2. **控制器只做组合**：标签条、概览、右键菜单、新标签页、开合动画各自是一个模块，控制器把它们接起来，并负责标签视图的挂载和卸载。
3. **标签类型可插拔**：新增一种标签只要写一个 provider 并登记一个标签类型，不改控制器。控制器不认识任何具体的标签类型（包括辅助对话），只通过类型声明里的钩子和它们打交道。
4. **跟随对话**：话题级标签只在所属对话里出现，切换对话时恢复该对话上次的激活标签和展开状态。

---

## 2. 模块划分

所有文件在 `modules/ui-system/side-pane/`。

| 模块 | 职责 | 是否碰 DOM |
| :--- | :--- | :--- |
| `side-pane-state.js` | 纯状态转换：打开 / 激活 / 关闭 / 排序标签、可见性、所属对话（parent）、宽度。所有函数返回新的冻结对象 | 否 |
| `side-pane-controller.js` | 组合下面的模块；维护挂载表、最近关闭、按对话记住的激活标签与展开状态；对外暴露控制器 API | 是 |
| `side-pane-types.js` | 只有 JSDoc 类型：`SidePaneTab`、`SidePaneTabType`、`SidePaneProvider`、`SidePaneTabHandle` 等契约 | 否 |
| `side-pane-persistence.js` | 布局存档的序列化、带版本号的校验读取、防抖保存；按对话的记忆最多 50 条（LRU） | 否（只碰 storage） |
| `side-pane-focus.js` | 焦点归属：记下打开副屏前的焦点，收起时送回；焦点不在副屏里时不挪 | 是（只调 `focus()`） |
| `side-pane-shortcuts.js` | 键盘快捷键：Ctrl/Cmd+Alt+B 开合，副屏内 Ctrl+PageUp/PageDown 切标签 | 是（window keydown） |
| `side-pane-visibility.js` | 宽度比例（默认 45%，20%–65%）、开合动画、动画期间锁定内容宽度 | 是（写 `style.width`） |
| `side-pane-tab-strip.js` | 标签条渲染、悬停提示、溢出布局与边缘渐隐、拖拽排序、方向键 / 中键关闭、通知标签上的连接状态点 | 是 |
| `side-pane-tab-overview.js` | 标签页概览浮层：搜索打开中和最近关闭的标签 | 是 |
| `side-pane-tab-menu.js` | 标签右键菜单：关闭 / 关闭其他 / 全部关闭 | 是 |
| `side-pane-launcher.js` | 新标签页：个人资料、工具 / 应用 / 通知分段、推荐、地址栏、「+」按钮 | 是 |
| `side-pane-entries.js` | 入口登记、顺序、可用性与执行；由 launcher 通过回调接到展示层 | 是 |
| `side-pane-resizer-owner.js` | 左边缘拖拽调宽 | 是 |
| `side-pane-tab-dnd.js` / `side-pane-tab-utils.js` / `menu-position.js` | 拖拽排序、标签图标与搜索、菜单定位等工具函数 | — |
| `tab-types/*.js` | 每种标签的名称、图标、搜索提示、可选入口和 provider 定义 | 否（创建 provider） |
| `*SideProvider.js` | 各标签类型的 provider（见第 4 节） | 是（只在自己的视图里） |

装配在 `modules/renderer/sidePaneWiring.js`：查找 DOM、创建控制器、调用 `registerTabType` 登记标签类型，并装配下列独立 owner：`sideChatWiring`（辅助对话能力和会话）、`floatingSelectionButton`（选区按钮）、`sidePaneLauncherWiring`（助手资料与应用源）、`sidePaneWorkspaceServices`（文件改动和状态面板）、`sidePaneHostBindings`（宿主事件和跟随对话）。

### 依赖方向

```
sidePaneWiring
   └─ side-pane-controller
        ├─ side-pane-state            （纯函数）
        ├─ side-pane-persistence      （纯函数 + storage）
        ├─ side-pane-focus
        ├─ side-pane-shortcuts
        ├─ side-pane-visibility
        ├─ side-pane-resizer-owner
        ├─ side-pane-tab-strip ─ side-pane-tab-dnd / tab-utils
        ├─ side-pane-tab-overview ─ tab-utils
        ├─ side-pane-tab-menu ─ menu-position
        └─ side-pane-launcher ─ side-pane-entries
```

子模块之间不互相引用，彼此的联动（比如打开概览时收起右键菜单）都通过控制器传进去的回调完成。子模块也不读写标签状态，只通过 `getTabs()` / `getActiveTabId()` 之类的读取函数拿数据，通过 `onActivate` / `onClose` 之类的回调把操作交回控制器。

---

## 3. 数据流

```
用户操作（点标签 / 右键关闭 / 新标签页入口 / provider 调 openTab）
        │
        ▼
控制器方法（activateTab / closeTab / openTab ...）
        │  state = SidePaneState.xxx(state, ...)
        ▼
投影到 DOM：
  renderTabList()      → 标签条重新渲染（顺带刷新概览）
  syncViewPanels()     → 只显示激活标签的视图
  syncDomVisibility()  → visibility.sync(state.visible) → 开合动画 + 标题栏按钮
```

每个改状态的方法都按这个顺序收尾，DOM 不会领先或落后于状态。

### 通知标签

通知是固定的全局标签（`NOTIFICATIONS_TAB_ID`），不能关闭。新标签页里有「通知」分段时（`launcher.hostsNotifications`），通知不再占标签条上的位置，激活通知时显示的是新标签页的通知分段。VCPLog 的连接状态以小圆点的形式出现在通知标签和通知分段上。

### 跟随对话

标签有两种作用域：

- `scopeMode: 'global'`：在所有对话里都可见（笔记、浏览器、终端……）。
- `scopeMode: 'topic'`：只在所属对话里可见（辅助对话、计划详情）。所属对话记在标签的 `parent` 上。

切换对话时宿主调用 `controller.setParent(parentRef)`。控制器先记下旧对话的激活标签和展开状态，再按新对话的记录恢复。这两张表只保留最近 50 个对话，并随布局一起持久化（见第 7 节）。

### 焦点

焦点只在本来就在副屏里（或者随着被拆掉的视图丢到 `body` 上）时才由副屏安排：

- 打开标签、展开副屏前，记下焦点在副屏外的位置。
- 副屏收起（手动、关掉最后一个标签、切换对话、窄窗口自动收起）时，焦点回到记下的位置；那个元素已经不在了就回到展开按钮。
- 关掉一个标签后，焦点移到新的激活标签上；焦点在主输入框等别处时不动。

### 快捷键

| 按键 | 作用 |
| :--- | :--- |
| Ctrl+Alt+B（macOS 上 Cmd+Alt+B） | 开合副屏。展开时和点展开按钮一样：有待审批先看通知，没有标签时打开新标签页，否则回到这个对话上次的标签。AltGr 组合不触发 |
| Ctrl+PageUp / Ctrl+PageDown | 焦点在副屏里时按标签条顺序切到上一个 / 下一个标签，首尾相接 |

焦点在浏览器标签的网页里时，按键不会到主窗口。主进程在 `browserHandlers.js` 里用 `before-input-event` 截下这几个组合，经 `browser:side-pane-shortcut` 转给主窗口，由 `sidePaneWiring.js` 执行同样的动作。

---

## 4. Provider 契约

一个 provider 负责一种 `kind` 的标签，通过标签类型的 `provider` 字段登记：

```js
const provider = {
    async mountTab(tab, viewElement) {
        // 在 viewElement 里渲染，返回 handle
        return handle;
    }
};
```

- `tab`：`openTab()` 传入的对象；从存档恢复出来的标签是存下来的标签对象（`payload` 原样带回）。辅助对话类型的 provider 适配层把 `descriptor` 取出来交给辅助对话 owner。
- `viewElement`：控制器创建的 `<section class="side-pane-view" role="tabpanel">`，provider 只能在它里面渲染。

handle 的方法都是可选的：

| 方法 | 调用时机 |
| :--- | :--- |
| `focus()` | 标签被激活或刚打开时 |
| `requestClose()` | 关闭前；返回 `{ closed: false }` 时取消关闭（比如有未保存内容且用户选择留下） |
| `dispose()` | 关闭或控制器销毁时；可以是异步的。抛错时控制器记日志并照常关闭标签 |

辅助对话 handle 仍向自己的调用方提供草稿、引用和模型方法；控制器只使用上表的通用生命周期方法。输入缓存由辅助对话 provider 的 `side-chat/draft-cache.js` 持有，卸载前保存、再次挂载后恢复；拒绝关闭时不卸载。

挂载规则：

- 同一个标签 id 只挂载一次。并发两次 `openTab` 同一个标签时，第二次等待第一次的挂载结果。
- 挂载期间标签被关掉或控制器被销毁时，控制器会立刻 `dispose` 刚挂好的 handle 并移除视图。
- 再次 `openTab` 已挂载的标签只会激活它，不会重新挂载。需要改标题或 payload 时用 `controller.updateTab(id, patch)`；payload 改了也会进存档，比如浏览器把当前网址写回去，重启后打开的是最后看的页面。
- 从存档恢复的标签不在启动时挂载，第一次显示（成为激活标签且副屏展开）时才挂载。

---

## 5. 新增一种标签

1. 写 provider，实现 `mountTab`，并通过控制器 API 打开和更新标签。
2. 在 `tab-types/<kind>.js` 定义一个 `defineXxxTabType(deps)`，把该类型的展示信息、可选入口（含 `order` 和 `isAvailable`）与 provider 放在一起：

   ```js
   export function defineNotesTabType(deps) {
       const provider = createNotesSideProvider(deps);
       return Object.freeze({
           kind: 'notes', label: '随手笔记', icon: 'edit_note', searchHint: '笔记',
           entry: { id: 'notes', order: 20, open: () => provider.openNotesTab() },
           provider
       });
   }
   ```

3. 由 `sidePaneWiring` 调用 `controller.registerTabType(definition)`。一次登记完成 provider、入口和展示信息登记，返回注销函数；登记表属于当前控制器，不跨窗口共享。入口可用性变化后仍调用 `refreshOpenTabEntries()`。
4. 类型声明里还有几个可选钩子（完整定义见 `side-pane-types.js` 的 `SidePaneTabType`）：

   | 字段 | 作用 |
   | :--- | :--- |
   | `toTab(payload, tabs)` | `openTab(payload)` 先经过它变成标签。辅助对话用它校验描述符，并让同一个子话题重复打开时落到已有标签上，所以调用方写 `openTab({ kind: 'chat', descriptor })` |
   | `onClosed(tab)` | 标签关掉、视图拆掉后调用。辅助对话用它删掉子话题；抛错只记日志 |
   | `persist: false` | 不随布局持久化。辅助对话（由会话服务恢复）、终端（重启后不自动拉起 shell）、命令输出（记录只在内存里）用它 |
   | `reopenable: false` | 关掉后不进"最近关闭"。标签自己带 `ephemeral: true` 也一样 |

5. 标签可以带每个实例独有的标题、图标和搜索提示（如 diff 图标或文件路径）；缺少这些值时使用类型定义，未登记时保留原有默认值。标签条和概览都通过组合者注入的读取函数访问登记表，不需要在 `tab-utils` 加类型分支。旧的 `registerProvider` 和 `registerOpenTabEntry` 继续兼容。
6. 用 JSDOM 验证入口可用性、挂载、关闭与拦截，并验证两个控制器的登记互不影响。

provider 只能修改自己的视图，跨模块动作通过组合者注入的回调完成。

---

## 6. 宽度与开合

- 宽度按**父元素内容区的比例**保存（`sidePaneWidthRatio`），窗口缩放时面板按比例跟随。拖拽结束时由像素换算成比例并写入设置。
- 展开 / 收起时宽度在 0 和目标比例之间过渡；过渡期间面板内容的宽度锁在展开宽度（`--side-pane-locked-width`），正文不会逐帧重排。
- JSDOM 或系统开启「减少动态效果」时不播动画，直接落到终态。
- 窗口缩放停下 300ms 后，如果对话区窄于 480px，面板自动收起。

---

## 7. 布局持久化

控制器传了 `persistence: { storage, key? }` 才持久化，主窗口用 `localStorage`，键是 `vcp.sidePane.layout.v1`。存的内容：

- 允许持久化的标签（id、类型、标题、图标、作用域、所属对话、payload），最多 30 个；单个标签序列化后超过 64KB（比如很大的 diff）就不存。
- 当前标签和展开状态（当前标签没存下来时不记）。
- 每个对话的激活标签和收起状态，各最多 50 条。

读取时先看版本号，再逐项校验：坏 JSON、别的版本、不认识或不允许持久化的标签类型都直接丢掉。`sidePaneWiring` 登记完所有标签类型后调用 `controller.restoreLayout()`；在这之前控制器不会写存档，免得启动时的空布局把存档盖掉。保存做了 400ms 防抖，页面隐藏、卸载或控制器销毁时立刻写一次。

辅助对话不走这套存档：宿主切换对话时调用辅助对话 owner 的 `restoreSessions`，从会话服务恢复。


## 8. 样式加载顺序

`main.html` 按原连续片段加载侧栏样式：shell → tab-bar → side-chat → tab-overview → launcher → tab-overlays → notes → code-viewer → browser → terminal。标签概览、可访问性、右键菜单、浮动提问按钮和窄视口规则保留原位置，因此使用 10 个文件，避免按区域归并时改变层叠顺序；每个文件不超过 459 行。

原有 `side-pane-tabs.css`、`side-pane-plan.css`、`side-pane-tool-output.css`、`side-pane-git-extras.css` 和 `side-pane-side-chat-extras.css` 是后加载的扩展层，继续保留各自的位置。调整这些扩展层时也必须保持它们相对于其他样式的顺序。

通知中心按 status → list → cards → dock 四段加载。两套样式拆分时只切分原文件，按引用顺序拼接后与原文件逐字节一致。

## 9. 会话状态面板

`conversation-status-panel.js` 保留会话范围、工作区与计划加载、投影、挂载和销毁，并原样导出纯函数与对外 API。它创建带 getter / setter 的 store，把实时数据交给各模块，避免切换话题后读到旧闭包快照。

| 模块（`modules/ui-system/conversation-status-panel/`） | 职责 |
| :--- | :--- |
| `helpers.js` | 分支过滤、进程窗口、迷你指标、提交信息与格式化纯函数 |
| `dom.js` | DOM 小工具和监听器清理 |
| `floating.js` | 浮层定位、popover 与 modal 生命周期及浮层栈 |
| `git-actions.js` | 分支加载、忙碌状态、切换、新建、推送、暂存 |
| `branch-dialogs.js` | 分支浮层、新建、切换受阻和切换前提交 |
| `commit-dialog.js` / `push-dialog.js` | 提交与推送对话框 |
| `git-graph.js` | Git 图表、分页与刷新 |
| `sections.js` | Git、命令、进程分区与迷你胶囊 |

各子模块不互相 import。入口把 DOM 工具、浮层操作、Git 操作及跨对话框跳转作为依赖和回调注入，并统一调用每个 owner 的 `dispose()`。分区开合通过组合者回调更新；共享数据通过 store 访问。Apache-2.0 来源说明保留在拆出的模块中。

## 10. 辅助对话 owner

`sideChatSurfaceOwner.js` 组合独立渲染器、操作与输入提交，并提供原有 handle API。`side-chat/` 下的 `shell`、`composer-state`、`model-picker`、`references`、`message-actions`、`scrolling`、`persistence` 和 `draft-cache` 分别负责视图、状态投影、模型选择、引用卡片、回答动作、贴底、历史/输入持久化和跨卸载缓存。各模块通过组合者的 store、读取函数与回调连接，不互相引用；计时器、观察者和宿主监听由所属 owner 清理。

组合入口保留发送/取消操作的结算顺序与原 handle 方法，当前约 560 行，因此保留在一个文件内；其余新模块均低于 500 行。


## 11. Git 与代码查看器 provider

`gitSideProvider.js` 保留工作区、来源、轮询、状态读取和指定路径定位。`git/diff-model.js` 导出原有纯函数；`git/cards.js` 自己持有展开状态、diff 缓存及数量预取队列；`git/context-menu.js` 负责复制、定位和菜单监听器。入口通过实时读取函数、纯函数依赖及菜单回调连接它们，销毁时统一清理。Git 直接使用 `line-diff.js`，不再依赖代码查看器 provider。

`codeViewerSideProvider.js` 保留工具栏、模式切换及原有 API，组合 `code-viewer/picker.js`、`editor.js` 和 `diff-view.js`。文件选择器保持工作区/路径竞态保护，正文与 diff 通过回调连接；类型检测在 `helpers.js`。HTML 转义共用 `text-escape.js`，两个适配器分别保留代码查看器严格字符串输入和辅助对话原有值转换语义。原入口继续导出 `detectLanguage`、`escapeHtml` 和 `computeLineDiff`。
