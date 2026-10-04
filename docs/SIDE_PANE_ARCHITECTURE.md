# 工作区侧栏（Workspace Side Pane）架构

## 1. 概述

侧栏是主聊天窗口右侧的一列标签页容器，用来放和当前对话并排使用的工具：通知、辅助对话、随手笔记、代码查看、Git 变更、浏览器、终端、命令输出、V工程计划等。

设计目标：

1. **状态和 DOM 分开**：标签列表、激活标签、是否展开都在一个纯函数状态模块里，可以单独测试；DOM 只是状态的投影。
2. **控制器只做组合**：标签条、概览、右键菜单、新标签页、开合动画各自是一个模块，控制器把它们接起来，并负责标签视图的挂载和卸载。
3. **标签类型可插拔**：新增一种标签只要写一个 provider 并登记一个入口，不改控制器。
4. **跟随对话**：话题级标签只在所属对话里出现，切换对话时恢复该对话上次的激活标签和展开状态。

---

## 2. 模块划分

所有文件在 `modules/ui-system/side-pane/`。

| 模块 | 职责 | 是否碰 DOM |
| :--- | :--- | :--- |
| `side-pane-state.js` | 纯状态转换：打开 / 激活 / 关闭 / 排序标签、可见性、所属对话（parent）、宽度。所有函数返回新的冻结对象 | 否 |
| `side-pane-controller.js` | 组合下面的模块；维护挂载表、辅助对话草稿缓存、最近关闭、按对话记住的激活标签与展开状态；对外暴露控制器 API | 是 |
| `side-pane-visibility.js` | 宽度比例（默认 45%，20%–65%）、开合动画、动画期间锁定内容宽度 | 是（写 `style.width`） |
| `side-pane-tab-strip.js` | 标签条渲染、悬停提示、溢出布局与边缘渐隐、拖拽排序、方向键 / 中键关闭、通知标签上的连接状态点 | 是 |
| `side-pane-tab-overview.js` | 标签页概览浮层：搜索打开中和最近关闭的标签 | 是 |
| `side-pane-tab-menu.js` | 标签右键菜单：关闭 / 关闭其他 / 全部关闭 | 是 |
| `side-pane-launcher.js` | 新标签页：入口登记表、个人资料、工具 / 应用 / 通知分段、推荐、地址栏、「+」按钮 | 是 |
| `side-pane-resizer-owner.js` | 左边缘拖拽调宽 | 是 |
| `side-pane-tab-dnd.js` / `side-pane-tab-utils.js` / `menu-position.js` | 拖拽排序、标签图标与搜索、菜单定位等工具函数 | — |
| `*SideProvider.js` | 各标签类型的 provider（见第 4 节） | 是（只在自己的视图里） |

装配在 `modules/renderer/sidePaneWiring.js`：查找 DOM、创建控制器、登记 provider 和新标签页入口、把辅助对话接到聊天会话服务。

### 依赖方向

```
sidePaneWiring
   └─ side-pane-controller
        ├─ side-pane-state            （纯函数）
        ├─ side-pane-visibility
        ├─ side-pane-resizer-owner
        ├─ side-pane-tab-strip ─ side-pane-tab-dnd / tab-utils
        ├─ side-pane-tab-overview ─ tab-utils
        ├─ side-pane-tab-menu ─ menu-position
        └─ side-pane-launcher
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
- `scopeMode: 'topic'`：只在所属对话里可见（辅助对话、计划详情）。所属对话记在 `descriptor.parent` 或 `parent`。

切换对话时宿主调用 `controller.setParent(parentRef)`。控制器先记下旧对话的激活标签和展开状态，再按新对话的记录恢复。这两张表只在内存里，重启后不保留。

---

## 4. Provider 契约

一个 provider 负责一种 `kind` 的标签：

```js
controller.registerProvider('notes', {
    async mountTab(tab, viewElement) {
        // 在 viewElement 里渲染，返回 handle
        return handle;
    }
});
```

- `tab`：普通标签是 `openTab()` 传入的对象；辅助对话是 side chat descriptor。
- `viewElement`：控制器创建的 `<section class="side-pane-view" role="tabpanel">`，provider 只能在它里面渲染。

handle 的方法都是可选的：

| 方法 | 调用时机 |
| :--- | :--- |
| `focus()` | 标签被激活或刚打开时 |
| `requestClose()` | 关闭前；返回 `{ closed: false }` 时取消关闭（比如有未保存内容且用户选择留下） |
| `dispose()` | 关闭或控制器销毁时；可以是异步的。抛错时控制器记日志并照常关闭标签 |
| `getDraft()` / `getReferences()` / `getModel()` | 辅助对话关闭前，控制器读取草稿、引用和模型留待重新打开 |
| `setDraft()` / `addReference()` / `setModel()` | 辅助对话重新挂载后，控制器写回上面这些 |

挂载规则：

- 同一个标签 id 只挂载一次。并发两次 `openTab` 同一个标签时，第二次等待第一次的挂载结果。
- 挂载期间标签被关掉或控制器被销毁时，控制器会立刻 `dispose` 刚挂好的 handle 并移除视图。
- 再次 `openTab` 已挂载的标签只会激活它，不会重新挂载。需要改标题或 payload 时用 `controller.updateTab(id, patch)`。

---

## 5. 新增一种标签

以「随手笔记」为例：

1. **写 provider**（`notesSideProvider.js`）：实现 `mountTab`，并提供一个打开函数：

   ```js
   async openNotesTab(options = {}) {
       const handle = await sidePaneController.openTab({
           id: 'side-pane-notes',
           kind: 'notes',
           title: '随手笔记',
           icon: 'edit_note',
           closable: true,
           scopeMode: 'global',
           ...options
       });
       sidePaneController.setVisible(true);
       return handle;
   }
   ```

2. **在 `sidePaneWiring.js` 登记**：

   ```js
   controller.registerProvider('notes', notesProvider);
   controller.registerOpenTabEntry({
       id: 'notes', label: '随手笔记', icon: 'edit_note', order: 20,
       open: () => notesProvider.openNotesTab()
   });
   ```

   `order` 决定在新标签页里的顺序；`isAvailable()` 返回 `false` 时入口隐藏，状态变化后调用 `controller.refreshOpenTabEntries()`。

3. **图标与搜索**：标签图标默认来自 `side-pane-tab-utils.js` 的 `getTabIconName`；概览搜索里显示的类型名和提示来自同文件的 `getTabTypeLabel` / `getTabSearchHint`，新类型需要在那里补一项。

4. **测试**：参照 `tests/side-pane-*.test.mjs`，用 JSDOM 创建控制器，注入假的 provider 验证挂载、关闭和 `requestClose` 拦截。

不要在 provider 里直接改标签条或其他标签的视图；需要切换标签、关闭自己时调用控制器 API。

---

## 6. 宽度与开合

- 宽度按**父元素内容区的比例**保存（`sidePaneWidthRatio`），窗口缩放时面板按比例跟随。拖拽结束时由像素换算成比例并写入设置。
- 展开 / 收起时宽度在 0 和目标比例之间过渡；过渡期间面板内容的宽度锁在展开宽度（`--side-pane-locked-width`），正文不会逐帧重排。
- JSDOM 或系统开启「减少动态效果」时不播动画，直接落到终态。
- 窗口缩放停下 300ms 后，如果对话区窄于 480px，面板自动收起。

---

## 7. 已知限制

1. **标签不跨重启保留**：除宽度外，打开的标签、顺序、按对话记住的激活标签都只在内存里。辅助对话例外，宿主通过 `restoreSessions` 从会话服务恢复。
2. **入口和 provider 分开登记**：一种标签要分别调用 `registerProvider` 和 `registerOpenTabEntry`，图标、类型名、搜索提示又散在 `side-pane-tab-utils.js`。后续可以合成一个标签类型定义（kind、标题、图标、入口、mountTab 一处声明）。
3. **辅助对话的草稿缓存在控制器里**：`getDraft` / `setDraft` 这一组只有辅助对话用到，严格说应该归辅助对话的 provider 自己管理。
4. **没有键盘快捷键层**：切换 / 关闭标签只能用鼠标或标签条内的方向键，还没有全局快捷键。


## 8. 样式加载顺序

`main.html` 按原连续片段加载侧栏样式：shell → tab-bar → side-chat → tab-overview → launcher → tab-overlays → notes → code-viewer → browser → terminal。标签概览、可访问性、右键菜单、浮动提问按钮和窄视口规则保留原位置，因此使用 10 个文件，避免按区域归并时改变层叠顺序；每个文件不超过 459 行。

原有 `side-pane-tabs.css`、`side-pane-plan.css`、`side-pane-tool-output.css`、`side-pane-git-extras.css` 和 `side-pane-side-chat-extras.css` 是后加载的扩展层，继续保留各自的位置。调整这些扩展层时也必须保持它们相对于其他样式的顺序。

通知中心按 status → list → cards → dock 四段加载。两套样式拆分时只切分原文件，按引用顺序拼接后与原文件逐字节一致。
