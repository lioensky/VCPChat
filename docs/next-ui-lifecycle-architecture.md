# Next UI 生命周期与可撤销注册架构

> 本文负责生命周期实现细节；当前完成度见 [`next-ui-current-state.md`](./next-ui-current-state.md)，后续施工顺序见 [`next-ui-development-roadmap.md`](./next-ui-development-roadmap.md)。

## 目标

VCPChat 主窗口会反复打开和关闭模态窗、菜单、应用标签、原生 `WebContentsView` 与设置增强层。这里的主要风险不是单个组件实现，而是副作用跨越了其界面寿命：界面已经消失，listener、timer、IPC、Observer、异步请求或注册项仍然存活。

本架构建立两个不变量：

1. 每个动态副作用必须属于一个可诊断的生命周期所有者。
2. 每个动态 Next UI 注册必须能够由同一个所有者撤销。

上游共享聊天业务 DOM 保持原生命周期。生命周期层只收敛本分支新增动态 UI 的资源，不接管上游事件系统、业务子页面或前端插件运行时。

## 参考模型

- React Effect 把 setup 和 cleanup 组成一个独立过程，并在开发模式执行额外的 setup/cleanup 周期验证对称性。
- Angular `DestroyRef` 将清理回调绑定到组件实例，并提供 destroyed 状态阻止迟到异步操作。
- VS Code 的命令、Provider 和 View 注册返回 `Disposable`，由 Extension/View 的 `DisposableStore` 统一持有。
- DeepSeek Harness 的 Cordis Fiber 逆序等待异步 disposer；Slot、Service 和事件贡献与插件 Fiber 同生共灭，HMR 在旧 Fiber 静止后再挂载新实例。

VCPChat 不引入上述框架。`LifecycleScope` 是一个无依赖、适配现有 DOM/Electron 代码的最小实现。

## 所有权树

```text
renderer page
├── next:tab-host
│   ├── next:app-grid
│   ├── next:internal-app:<id>
│   ├── next:embedded-app:<id>
│   └── next:create-item-modal
├── next:main-ui-runtime
├── next:settings-presentation
├── next:ask-nova-controller
│   └── next:ask-nova-modal:<target>
└── next:appearance-studio-controller
    ├── next:appearance-studio-surface
    └── next:appearance-studio-open
```

页面级 controller 可以保持到 renderer 退出；带有 `open`、`modal`、`app` 或 `presentation` 的动态 Scope 必须在对应表面关闭时消失。父 Scope 销毁会级联销毁仍存活的子 Scope，子 Scope 提前销毁也会从父 Scope 的资源表中撤销自己。

## `LifecycleScope` 合同

`modules/ui-system/lifecycle-scope.js` 提供：

- `own(disposer, label, type)`：持有任意函数或带 `dispose()` 的对象。
- `listen()`：持有 DOM/EventTarget listener。
- `subscribe()`：持有 IPC、Store 或事件总线返回的 unsubscribe。
- `observe()`：持有 Mutation/Resize/Intersection Observer。
- `timeout()`、`interval()`、`animationFrame()`：持有调度任务；任务自然完成后自动从诊断表撤销。
- `abortController()`：持有可取消请求。
- `track(promise)`：记录进行中的异步任务；任务完成或 Scope 销毁后撤销诊断记录。
- `guard()`、`bumpGeneration()`：阻止旧 generation 或已销毁 Scope 的迟到回调更新界面。
- `child()`：建立级联所有权。
- `dispose()`：幂等、逆序、逐项等待；也会等待已由 `release()` 启动但尚未完成的 disposer。一个 disposer 失败不会阻止剩余资源释放，最终用 `AggregateError` 汇总。

所有资源必须带稳定标签。开发与自动化可通过 `window.VCPLifecycle.diagnostics.snapshot()` 和 `summary()` 查看活动 Scope、资源类型和数量。

## 注册表兼容策略

### Next 应用

`nextUiApps.register(definition, { owner })` 保持原返回值不变。传入 owner 时，Scope 销毁会执行带实例校验的 `unregister(id, expectedApp)`；注销事件会让 Tab Host 关闭仍打开的对应应用。

### 前端插件边界

前端插件 Loader、注册协议、脚本/样式加载顺序和实例销毁语义保持上游实现，本轮生命周期收敛不接管它们。若未来需要插件卸载或热重载，应作为独立插件运行时变更设计、迁移和验证，不能借 Next Shell 重构间接改变现有插件。

## 规范主窗口与兼容模式读取

主窗口现在只有一个规范 presentation，由 `main.html` 静态声明 `data-ui-mode="next"`。旧配置中的
`classic` / `next` 值只在 settings schema 中兼容归一化；不存在运行时 mode manager、状态通道、拆卸换壳或第二套 listener。
Appearance Studio、全局设置和启动加载不再把 `uiMode` 当作可预览、可提交的运行时状态。

内嵌业务页面拥有独立产品策略。当前 allowlist 中的页面显式以 `uiMode=classic` 打开，主窗口设置
不会向现有 WebContentsView 广播 presentation 变化。若以后迁移某个业务页面，必须在页面策略中
单独启用并完成其 mount/unmount 门禁，不能重新引入“主窗口模式自动传染所有子页面”的第二权威。

## 开发规则

- 新的 Next 动态表面必须创建 Scope，不能新增模块级 disposer 数组。
- setup 与 cleanup 放在同一代码附近；注册后立即交给 Scope。
- 不使用匿名、无法移除的全局 listener。
- 不依赖 DOM 被删除来间接回收 IPC、timer 或原生 View。
- 所有 async completion 必须有 generation、identity 或 Scope guard。
- 异步 acquire 返回后必须再次确认 owner 仍为 `active`；若 owner 已进入 `disposing`，立即归还刚取得的 lease/handle，不能只检查最终 `disposed` 状态。
- Registry 只保留具有生产闭环的 `commands/apps`；新增 kind 必须与首个 producer/consumer 同时进入，并具备 register → use → dispose → absent 测试。
- 内部应用注销时，Launchpad 必须刷新，已打开的 tab 与 Surface 必须同步关闭。
- `destroy()`/`dispose()` 必须幂等。
- Classic 代码不因 Next 生命周期化而改写；共享增强器必须能恢复原 DOM 身份和状态。

## 验收门禁

单元与契约测试覆盖逆序异步释放、重复 dispose、部分清理失败、child collapse、迟到 generation、已完成 timer/task 自动撤销，以及 Next App 注册回收。

Electron 压力测试在真实 renderer 中反复执行 Ask Nova、设置、Agent 设置、内嵌应用、拖出窗口、Overlay、renderer reload/crash 与 Classic/Next 往返，同时检查：

- Heap、listener、page、process 与 renderer process 无持续增长。
- Ask Nova host、动态标签、内嵌 view 和临时 Overlay 在每轮结束时不存在于活动 DOM。
- 动态 Scope 在表面关闭后为零。
- Classic 中不存在 Tab Host、Main Runtime、Settings Presentation 或动态 Overlay/App Scope。
- 预热后活动 Scope 总数与资源总数在所有 checkpoint 完全相等。

`Memory.getDOMCounters().nodes` 仍作为趋势诊断输出，但不单独判定泄漏：Electron 当前 Chromium 的 Blink 原生 node wrapper 会在 JavaScript 已不可达后延迟回收，而实验性的 `DOM.getDetachedDomNodes` 本身还会延长其寿命。需要定位时显式开启 detached debug；正常门禁使用活动 DOM 不变量、JS heap、listener 和所有权资源共同判定，不能用单一原生计数制造假阳性。

2026-08-17 P3 最终压力验收为 3 次预热加 20 次测量；所有 checkpoint 保持 8 个活动 Scope、162 项受管资源、407 个 listener、2 个 page、5 个 Electron process 和 2 个 renderer process。活动 DOM root、VCP icon、option 的 detached 计数均为 0；JS heap 在 8.9-9.1 MiB 间稳定。reload、crash、Overlay 和 View session 均完成恢复与对账。插件 Loader 保持上游实现，不计入 Next Scope 基线。

## Next Delta Contract

`npm run guard:next-delta` 只约束本分支相对上游新增的责任，不把上游既有问题冒充为 Next 缺陷：

- 规范 Shell、设置、通知、创建入口和共享业务 host 只能存在一个 owner。
- 已退役的 Classic 主窗口 ID、隐藏控件 `.click()` 代理和运行时 `uiMode` 写入不得回归。
- Web Awesome Modal 必须满足一次性 finalize；原生关闭、Escape、light-dismiss 与程序关闭共享同一合同，持久创建提交期间禁止用户关闭。
- 子页面 presentation 权威与主窗口设置隔离。
- 聊天、消息、列表、设置、通知、插件加载等关键共享文件以带理由的 SHA-256 baseline 冻结；任何变化都必须显式更新清单并重新归因。

该门禁采用 VS Code 与 DeepSeek Harness 一类工程实践：显式 owner、能力边界、确定性状态合同、
有界资源、可重放失败。发现问题时遵循 `discover → minimize → fix → preserve trace`；不能通过
扩大 timeout、提高泄漏阈值或隐藏错误来获得绿色结果。

最终硬化新增了两类真实 Electron 证据：Web Awesome 创建模态的用户关闭、提交锁、失败恢复和
成功完成；以及空 VCP 配置下的主窗口首启。上游 Translator 的空配置阻塞式 `alert` 被明确隔离为
上游子页行为，门禁在完成主窗口首启验证后才给子页写入惰性占位配置，不修改其产品代码。

## 生命周期检查器与性能诊断

- `window.VCPLifecycleInspector.snapshot()` 返回 renderer Scope、TaskHandle、Contribution、State Channel、Shell/Overlay、最近模式事务和有界性能样本。
- `snapshotMain()` 通过受限 preload 查询主进程 embedded session 与 sender-owned task；返回值不包含聊天内容、凭据或文件数据。
- `VCPPerformance` 最多保留 100 条标量记录，并给 Next mount、模式切换、设置打开、原生 View 创建和激活附加诊断预算。
- Inspector 是只读观察面，不提供 dispose、cancel、register 或 session mutation 能力。

## 2026-08-15 对抗审查

本轮审查只归因于 Next 生命周期改造引入或覆盖的控制流，不把上游已有服务、音频、模型连接、插件运行时和业务页面问题计入。审查方法包括逐文件差异复核、逆序/并发 dispose、延迟原生 IPC、逆序完成的并发模态窗、失败 disposer，以及 Classic/Next 快速往返。

确认并修复的边界：

- Ask Nova 的两个并发 `open()` 现在由 monotonic generation 决定，最后一次用户选择不会被较早但更晚返回的覆盖层请求改写；所有多余 lease 均会归还。
- 覆盖层 lease 在原生隐藏 IPC 尚未完成时被释放，协调器会在该 IPC settle 后重新对账当前嵌入应用，避免“恢复先完成、迟到隐藏最后落地”造成白屏。
- Web Awesome 旧 generation 的 `finally` 不再清除新 generation 的 activation lock；挂载前后仍执行 generation 与 owner active 双重检查。
- 单个内部应用 disposer 抛错时，`LifecycleScope` 仍释放其他资源，Tab Host 记录错误但继续完成 Classic 切换，不让清理失败把展示模式卡在中间态。
- Appearance Studio 注入全局设置的 change/input/click listener 与绑定标记已纳入 controller Scope，销毁时能够撤销。
- VCPUI controller 的内部 listener 与 cleanup 采用失败隔离；任一清理失败不再阻止 controller identity、DOM 和其余 listener 的撤销。
- `LifecycleScope.dispose()` 会加入已经开始的手动 release，避免 Scope 先于异步清理报告 disposed；对应失败仍汇总为 `AggregateError`。
- Appearance Studio 每次打开使用唯一 Overlay owner；关闭会等待 per-open Scope 完整销毁，关闭期间的新 open 会串行排队，旧 acquire 的迟到失败不能污染新一次打开。
- State Channel 的 immediate subscriber 若抛错，会事务性撤销注册；renderer 销毁后主进程任务表立即解除 sender 强引用。
- Creation Surface 在同一 mount 事务内创建并持有控件；中途失败会原子清理并停止打开，不再继续使用半销毁控件。

新增确定性回归覆盖：并发 Ask Nova 逆序返回、Acquire 期间销毁、延迟原生 hide 后 release、失败应用 disposer，以及并发 parent/child disposal。上述测试不依赖概率碰撞。

审查后仍明确保留的边界与技术债：

- Appearance Engine、Lucide adapter 等页面级静态 singleton 仍以 renderer page 为自然生命周期；本轮不为追求形式统一而改写 Classic 可见的稳定代码。
- 原生 IPC 调用本身没有统一 AbortSignal 协议；当前通过 generation、owner active 和最终状态对账保证 UI 正确，但无法取消已经进入主进程的底层工作。
- 前端插件生命周期仍由上游 Loader 和插件自身负责；本轮不承诺插件卸载或热重载能力。
- `topTabManager.js` 已退化为兼容 facade；标签、覆盖层、启动台和创建流程由独立 Next controller 承担。
- 自动化证明覆盖路径资源归零，不等价于模型服务、GPU、系统休眠恢复和任意第三方插件组合绝对无缺陷；发布前仍需要长时间 soak 与人工操作序列。

## 非目标

- 不引入 Cordis、React 或新的 npm 依赖。
- 不把静态 DOM 全部改造成 Slot。
- 不重构 Classic 生命周期。
- 不猴补全局浏览器 API 统计资源。
- 不在本轮引入前端插件卸载或热重载协议。
- 不修改聊天、插件或用户设置的数据格式。
