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
 * 标签打开期间的生命周期（从打开到关闭，视图休眠不影响它）。
 * @typedef {object} SidePaneTabOccurrence
 * @property {string} id 标签 id
 * @property {string} kind
 * @property {AbortSignal} signal 标签关掉时 abort；异步加载用它判断要不要继续
 * @property {{ get(): boolean, subscribe(listener: (visible: boolean) => void, options?: { immediate?: boolean }): () => boolean }} visible
 *   是否正显示给用户（面板展开、是当前标签、窗口在前台）；由控制器发布，provider 只读
 * @property {() => boolean} isVisible
 */

/**
 * 控制器挂载时传给 provider 的第三个参数。
 * scope 是这次挂载的 view scope（VCPLifecycle.LifecycleScope）：监听、Observer、定时器、IPC 订阅
 * 都通过 scope.listen / observe / interval / subscribe / own 挂上去，视图释放（关标签或休眠）时一起拆掉。
 * 轮询用 side-pane-occurrence.js 的 pollWhileVisible(scope, occurrence.visible, fn, ms)。
 * @typedef {object} SidePaneMountContext
 * @property {object} scope
 * @property {SidePaneTabOccurrence} occurrence
 */

/**
 * provider 挂载后返回的句柄，方法都可选。
 * @typedef {object} SidePaneTabHandle
 * @property {() => void} [focus] 标签被激活时调用
 * @property {() => Promise<{ closed: boolean } | void> | { closed: boolean } | void} [requestClose]
 *   关标签前调用；返回 { closed: false } 可以拦下（比如有没保存的内容）
 * @property {() => void} [suspend] 变得不可见时调用（收起面板、切到别的标签、窗口切走）
 * @property {() => void} [resume] 重新可见时调用
 * @property {() => Promise<void> | void} [dispose] 视图释放时调用，在 view scope 释放之前；
 *   资源都挂在 scope 上的 provider 可以不提供
 */

/**
 * @typedef {object} SidePaneProvider
 * @property {(payload: object, view: HTMLElement, context: SidePaneMountContext) => Promise<SidePaneTabHandle | null> | SidePaneTabHandle | null} mountTab
 *   payload 是传给 openTab 的对象（恢复出来的标签则是存下来的 SidePaneTab）；view 是这个标签的面板容器。
 *   只接两个参数的旧 provider 照常工作，资源由它自己的 dispose 收。
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
 * 一种标签的完整声明，交给 controller.registerTabType()。同 kind 替换整个声明，不继承旧入口/provider。
 * 替换或注销影响后续挂载；已挂载/正在挂载的页面保留自己的 onClosed，直到该次生命周期关闭。
 * @typedef {object} SidePaneTabType
 * @property {string} kind
 * @property {string} label 标签类型名，标签条和总览里显示
 * @property {string} [icon]
 * @property {string} [searchHint]
 * @property {SidePaneProvider | null} [provider] 没有时只占位，不挂视图（比如通知）。
 *   可以是 tab-types/lazy-provider.js 的懒加载代理，第一次挂载或第一次调用 open 函数时才加载实现
 * @property {() => Promise<SidePaneProvider> | SidePaneProvider} [load] 没给 provider 时用它懒加载
 * @property {'none' | 'detach' | 'keep'} [dormancy] 隐藏太久时怎么休眠：
 *   none（默认）释放视图、保留标签，再显示时重新挂载；detach 只摘下视图里的长连接画面（终端），会话不动；
 *   keep 不休眠（比如有没发出去的输入）
 * @property {SidePaneOpenTabEntry | null} [entry] 有时出现在新标签页里
 * @property {(payload: object, tabs: readonly SidePaneTab[]) => SidePaneTab} [toTab]
 *   openTab(payload) 先经过它变成标签；可以返回已有标签的 id 让重复打开落到同一个标签上
 * @property {(tab: SidePaneTab) => Promise<void> | void} [onClosed] 标签关掉后调用（视图已经拆掉）
 * @property {boolean} [persist] false 时不随布局持久化
 * @property {boolean} [reopenable] false 时关掉的标签不进"最近关闭"
 */

export {};
