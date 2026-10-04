/*
 * 副屏的类型契约，只有 JSDoc，运行时什么都不导出。
 * 新增一种标签时照着 SidePaneTabType 写一个 tab-types/<kind>.js，在 sidePaneWiring.js 里登记。
 */

/**
 * 标签所属的对话（智能体 + 话题）。scopeMode 为 'topic' 的标签只在这个对话里显示。
 * @typedef {object} SidePaneParentRef
 * @property {string} [itemType] 默认 'agent'
 * @property {string} itemId
 * @property {string} topicId
 */

/**
 * 标签条上的一个标签（状态里存的是冻结后的对象）。
 * @typedef {object} SidePaneTab
 * @property {string} id 唯一；同一个 id 再次打开会回到已有标签
 * @property {string} kind 对应已登记的 SidePaneTabType.kind
 * @property {string} [title]
 * @property {string} [icon] Material Symbols 名
 * @property {boolean} [closable] 默认 true
 * @property {'global' | 'topic'} [scopeMode] 默认 'global'
 * @property {SidePaneParentRef} [parent] scopeMode 为 'topic' 时必填
 * @property {string} [searchHint] 标签总览里搜索时额外匹配的文字
 * @property {object} [payload] 给 provider 的数据；要持久化的类型必须能 JSON 往返
 * @property {boolean} [ephemeral] 临时标签：不进"最近关闭"，不持久化
 * @property {boolean} [reopenable] false 时不进"最近关闭"
 * @property {number} [openedAt]
 */

/**
 * provider 挂载后返回的句柄，方法都可选。
 * @typedef {object} SidePaneTabHandle
 * @property {() => void} [focus] 标签被激活时调用
 * @property {() => Promise<{ closed: boolean } | void> | { closed: boolean } | void} [requestClose]
 *   关标签前调用；返回 { closed: false } 可以拦下（比如有没保存的内容）
 * @property {() => Promise<void> | void} [dispose] 标签关掉或控制器销毁时调用
 */

/**
 * @typedef {object} SidePaneProvider
 * @property {(payload: object, view: HTMLElement) => Promise<SidePaneTabHandle | null> | SidePaneTabHandle | null} mountTab
 *   payload 是传给 openTab 的对象（恢复出来的标签则是存下来的 SidePaneTab）；view 是这个标签的面板容器
 */

/**
 * 新标签页 / 新增菜单里的一个入口。
 * @typedef {object} SidePaneOpenTabEntry
 * @property {string} [id] 默认用 kind
 * @property {string} [label] 默认用 SidePaneTabType.label
 * @property {string} [icon]
 * @property {number} [order] 越小越靠前
 * @property {() => unknown} open
 * @property {() => boolean} [isAvailable]
 */

/**
 * 一种标签的完整声明，交给 controller.registerTabType()。控制器只通过这些钩子认识具体的标签类型。
 * @typedef {object} SidePaneTabType
 * @property {string} kind
 * @property {string} label 标签类型名，标签条和总览里显示
 * @property {string} [icon]
 * @property {string} [searchHint]
 * @property {SidePaneProvider | null} [provider] 没有时只占位，不挂视图（比如通知）
 * @property {SidePaneOpenTabEntry | null} [entry] 有时出现在新标签页里
 * @property {(payload: object, tabs: readonly SidePaneTab[]) => SidePaneTab} [toTab]
 *   openTab(payload) 先经过它变成标签；可以返回已有标签的 id 让重复打开落到同一个标签上
 * @property {(tab: SidePaneTab) => Promise<void> | void} [onClosed] 标签关掉后调用（视图已经拆掉）
 * @property {boolean} [persist] false 时不随布局持久化
 * @property {boolean} [reopenable] false 时关掉的标签不进"最近关闭"
 */

export {};
