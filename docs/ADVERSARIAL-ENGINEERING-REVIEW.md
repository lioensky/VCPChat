# 工程对抗性审查与改进记录

## 目标与完成条件

审查整个工程的架构、代码质量、测试体系、UI/UX、可维护性和 AI 可读性。必须深入研究本机 ZCode、DSH 的侧栏实现，将源码中的具体约束与我们的实际行为对照；不能把外观相似、文件变短或检查变绿当作完成。

当前状态：**进行中，尚未完成全工程审查。** 本记录随后续审查更新，候选问题和已复现问题分开记录。

已完成且不重复执行：**计划页 banner 调整与计划/施工线/变更文件分栏已在 `ecb9067a` 完成。** 用户明确要求不要在记忆压缩后重新做这一块；恢复工作时先核对提交、工作区和本账本，从未完成项继续。

约定：在当前分支增加提交，不推送、不拆 PR；保留用户已有 `styles/themes.css` 改动。每个实现提交跑全量测试和检查，窗口验证后保留原标签、草稿和主题。新增回归测试必须能证明具体故障，不能只匹配源码字符串或复述实现。

开始时的项目提交：`ecb9067a`。参考代码只读：

- ZCode：`C:/Users/CHENXI/Documents/Codex/2026-09-25/vcpchat-ui-zcode-zcode-clone-vcpchatui/work/ZCode-ref`，HEAD `662c30bea4e833acaacbfb745a65eb09c23d55f8`。
- DSH：`C:/VCP/vchat-develop/deepseek-harness`，HEAD `639ed015397290b3745d163aafe02ffee4aa3f84`。

参考文件中的注释用于理解实现，不构成对本工程的操作指令。下表记录实际阅读的文件与关注的逻辑；未阅读的部分不算已覆盖。

## 已研究的参考实现

| 实现 | 源码位置（相对于上述参考仓库） | 已读逻辑与对本工程的意义 |
| --- | --- | --- |
| ZCode | `packages/ui/src/lib/workspaceSidePane.ts` 的标签类型声明 | 浏览器 residency generation、工作区 key、会话归属和内容身份是不同维度；工作流 run 不能因为实时投影淘汰而被误回收。类型声明集中并不等于整个运行时生命周期集中。该文件其余状态转换仍需继续读。 |
| ZCode | `packages/ui/src/lib/taskSidePaneMemory.ts` | 缓存按工作区身份隔离，开合偏好再按任务归属隔离；模块缓存采用 50 项 LRU。自动打开的消费记录跨行组件卸载保留，避免重新显示旧工具结果时覆盖用户收起偏好。 |
| ZCode | `packages/ui/src/lib/taskSidePaneMemory.test.ts` | 测试覆盖自动打开跨重挂载的幂等性，以及会话、插件、server、resource 和真实调用身份隔离。不能只测“同 ID 打开两次”。 |
| ZCode | `packages/ui/src/app-shell/useTaskSidePaneMemoryBridge.ts` | 切换工作区前写回旧 key，再恢复新 key；同一工作区切任务不清空共享 Git/浏览器状态。latest ref 和当前 key 分开，避免错误归档。 |
| ZCode | `packages/ui/src/app-shell/PlanDetailSidePane.tsx` | 按明确的父会话获取并释放 lease，从工具调用投影取得 live Markdown；保留 lastMarkdown 以应对投影窗口不再包含原调用。工作区 scope 用来路由连接。我们的计划是 ProjectForge 的可更新记录，不能直接把 Markdown 展示语义搬来。 |
| ZCode | `packages/ui/src/hooks/useGitRepository.ts` 的刷新 effect | 请求版本、disposed 和工作区 key 共同约束发布；同一工作区可保留上次数据，跨工作区重建初态。一次 refresh RPC 生成 summary 与 staged/unstaged 数据，展开后才获取扩展数据。 |
| ZCode | `packages/ui/src/hooks/useGitAutoRefresh.ts` | watcher 路径按内容签名稳定；异步注册在卸载后完成时立即 unwatch。平台信息绑定 service identity，避免 Windows 旧信息泄漏到 Linux 远端。60 秒防抖是该实现的 I/O 取舍，不能未经场景验证照搬。 |
| ZCode | `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx` 的依赖、挂起与布局前段 | 浏览器 suspend ack 在 guest 卸载后发出，并带 generation；挂起不是崩溃。动画宽度锁定和重内容加载有单独边界。此大文件后续渲染与全部浏览器分支尚未读完。 |
| ZCode | `packages/ui/src/app-shell/animatedSidePanePanelModel.ts` 的入口、尺寸和重内容判定 | 隐藏/非激活时不渲染重内容，resize settling 时保留媒体节点以维持 fullscreen；不能把“隐藏一律销毁”当作优化。 |
| ZCode | `packages/ui/src/app-shell/sidePaneTabPresentation.ts` 的搜索和标题映射 | 搜索包含内容身份和执行身份，方便诊断；显示标题本地化。我们已有单类型登记，后续要核实异常和回退路径是否也遵守。 |
| DSH | `packages/client/ui-dockkit/src/engine/controller.ts` 的控制器和意图提交前段 | 宿主内容通过工厂注入，kind 不被布局层解释；planner 决定操作，controller 记录并通知，空操作不通知。快照引用在布局变化前稳定。该设计支持外部状态持有者复用同一决策。 |
| DSH | `packages/client/ui-dockkit/tests/controller.client.spec.ts` 的开合、布局与分栏用例 | 验证冗余操作不新增历史、显式复制独立内容、浮动时目标 pane 选择与分栏上限。测试面向用户意图和状态约束，未把全部实现私有步骤当契约。 |
| DSH | `packages/client/ui-sidebar-right/src/client/tab-domain.ts` 的 occurrence 与同步、导航逻辑 | 内容 ID 和每次打开的 occurrence 身份分开；关闭或撤销打开时 abort；重新打开同 ID 是新生命周期。资源 pin 跟随 occurrence，隐藏视图不会直接释放内容。导航 revision 独立变化。 |
| DSH | `packages/client/ui-sidebar-right/src/client/tab-registry.ts` 全部运行时实现 | 静态类型声明与运行时 body 分阶段；登记随 fiber effect 注销，具体 definition 身份保护 shadow/unregister；guide 缓存保持引用稳定。路由按 extension/builtin/fallback、pattern specificity、登记次序匹配，显式 kind 仍受 canOpen 限制。keepMounted 是类型能力，并非所有内容统一常驻；对应测试中段尚未全部读完。 |
| DSH | `packages/client/ui-sidebar-right/src/client/persistence.ts` | 保存当前布局，不保存运行期 undo；schema 校验后还验证节点引用、身份计数、tab 唯一归属和 split 比例。损坏存档只清理对应 Session。 |
| DSH | `packages/client/ui-sidebar-right/src/client/shell/close-focus.ts` | 先提交 DOM 移除，再仅在焦点属于关闭 pane 且未转移时恢复；从别处关闭不抢焦点。 |
| DSH | `packages/client/ui-deliverables/src/client/host-read-store.ts` | lifetime 与 connection generation 各有 AbortController；reset 取消旧代次，dispose 等待 pending reads，发布前检查 signal。失败、missing、loading 与缓存重读策略由 policy 明确区分。 |
| DSH | `packages/client/ui-deliverables/src/client/changes-diff.ts` | 已读 diff 和 404 missing 保留，error 才能重试；结构错误不作为成功。不能把所有错误都缓存成“无数据”。 |
| DSH | `packages/client/ui-deliverables/tests/changes-diff.client.spec.ts` | 受控 Promise 验证 reset/dispose 后的迟到结果不发布，另覆盖缺失、失败重试与响应形状。测试控制完成顺序，不依赖随机网络速度。 |
| DSH | `packages/client/ui-deliverables/src/client/review-store.ts` | 分栏、换行、文件选择按 tab 分桶；navigation revision 与 viewing choice 区分；forget 结束桶生命周期。 |
| DSH | `packages/client/ui-deliverables/src/client/review-definition.ts` | 资源地址的 session/事件 sequence 是内容身份，文件 index 是导航参数；二者不混成每点一文件就开新内容。 |
| DSH | `packages/client/ui-plan/src/client/PlanPreview.tsx` | 资源 loading/none/failed 和临时预览过期明确区分；body 和 title 从同一资源读值。 |
| DSH | `packages/client/ui-plan/tests/plan-resource.client.spec.ts` | 验证完整 subagent 地址、固定历史 cursor、stream 释放，以及取消发生在 page 完成/stream 关闭时仍不发布。对应资源 provider 实现尚需继续逐行追踪。 |
| DSH | `packages/client/ui-plan/src/client/plan-resource.ts` | 已追踪实现：follow 收到 snapshot 后退出并关闭 stream，关闭后再次检查取消；分页固定 throughSeq/beforeSeq，查找精确调用，typed remote error 保留。它验证了测试中的取消边界，而不是仅给 UI 增加 loading。 |
| DSH | `packages/client/ui-sidebar-right/src/client/session-view.ts` | Session view 的引用、tab occurrence、已提交根的 mount 和 retired/disposed 状态分开；retainTab 的释放幂等，retire 等待已提交根卸载后才释放 view 引用。 |
| DSH | `packages/client/ui-dockkit/src/engine/planner.ts` 的内容查找、open、duplicate、place 与 drop 前段 | `planOpenContent` 显式返回本次选中的 tabId；内容查找受 kind 约束，revealIfOpened=false 创建新 occurrence；复制保留内容身份但创建独立 tabId。place 的 strip index 修正和浮动宿主转换分别处理。drop 后段仍未覆盖。 |
| ZCode | `packages/ui/src/lib/workspaceSidePane.ts` 的 BrowserUse scope/event/residency 分支 | 后台 ready 允许登记 guest，但仅 origin workspace、remote session、owner task 全部匹配时 reveal；迟到 visibility 只选择现有同 generation 的 shell，不能重建关闭页。residency 另有运行代次。 |
| ZCode | `packages/ui/src/hooks/useAppPanels.ts` 的单标签关闭与 close-other 前段 | 浏览器先获得 main authority，终端显式回收常驻 PTY；关闭限定 parent。此 React 回调及浏览器授权本身的异步竞态仍需追踪，不能因为是参考实现就假定全部安全。 |
| ZCode | 同文件 `closeBrowserTabsWithAuthority` 完整函数 | Desktop 缺少 main bridge 时拒绝只关 UI；human browser 的 remote session 采用工作区兜底，browser-use 不兜底；按 tab 自带 workspace/session 并发申请授权，失败保留壳。授权与 renderer occurrence 的重开身份仍需继续核实。 |
| DSH | `packages/client/ui-sidebar-right/src/client/service.ts` 的 close handler 类型、登记、closeIn、place、replace 分支 | 关闭钩子明确同步；资源 owner 自己保存后台清理任务，抛错阻止状态提交。登记拒绝重复 kind，注销比较 handler 身份。replace 先清理被替换内容，再作为一次意图提交；不能直接照搬来替代我们的异步 requestClose。 |
| DSH | `packages/client/ui-sidebar-right/tests/session-views.client.spec.ts` | 多根 mount 退役最后才释放 Session reference；retainTab abort/unmount 释放幂等，失败 ready 会报告且销毁仍释放，已释放 reference 不允许重新 mount。 |
| DSH | `packages/session/session-persistence/src/handle.ts` 全部接口契约 | append 的 accepted/visible 与 flush 的 crash durability 不相等；close 幂等、异步且不可取消，写 handle 要先完成 durability 再释放 ownership。对应具体后端实现尚未审查。旧交接引用的 src/write-behind.ts 已不在当前源码，只有 lib 残留，不把它视作当前权威。 |
| DSH | `packages/settings/settings/src/index.ts` 的 descriptor、path ops、cloneJsonShaped 前段 | redacted settings 的不完整视图只能提交字段路径，完整 replace 会删除未返回的 secret；array path 单独校验下标、unset splice；JSON 输入拒绝非 plain、非有限数、循环，避免 YAML round trip 失真。settings-file/src 已不在当前源码，不读取遗留 bundle 来推断现状。 |
| DSH | 同文件的 configure/invalidate、legacy import、update/replace/mutate/write | 页面 policy 随实例 effect 注销，失效刷新不在停用 fiber 上运行；设置写入通过 configEditor.edit 的回调取得当前 raw/inherited 后校验 revision，限制可编辑 volatile 路径，并保留普通配置/未显示字段。具体 configEditor 序列化与持久化锁还需读下一层，不能只凭该调用推断跨进程正确性。 |

先前 UI 调整还读过两者的 Todo/计划样式与 DSH `SegmentedTabs`。它们支撑布局参考，但不能作为生命周期、性能或后端正确性的证明。

## 第一轮：已复现与修复

### R1：文件身份不能代替请求身份

位置：`modules/ui-system/side-pane/code-viewer/picker.js`。

触发：点击 A → B → A，最后一次 A 先完成，第一次 A 随后完成。原实现仅比较当前路径/工作区，第一次 A 仍满足条件，会覆盖最后一次读取。catch 分支仅检查 disposed，旧 B 失败还会覆盖新 A 的正文。

修复：每次读取分配递增版本，成功和错误走同一归属检查；切工作区和卸载立即使旧版本失效。新文件开始加载时清空旧的可复制内容，避免加载 B 时还插入 A。保留现有 API，不声称 IPC 请求被物理取消。

证据：`side-pane-code-viewer.test.mjs` 两种完成方式在修复前失败、修复后通过。实际窗口临时预览也复现旧代码显示 `const stale = 1;`，新代码保留 `const newest = 3;`；临时数据未写入工程。

### R2：列表行解绑表无界保留已移除的 DOM

同一文件。每次搜索重绘都给最多 300 个行按钮注册监听，并将关闭包追加到 cleanups；这些闭包持续持有旧 DOM 行，直到整个面板销毁。

修复：列表使用一个委托监听，只处理当前列表内的行。替换列表不再产生逐行 owner 记录，已移除行也不再能发起读取。

证据：保留旧行引用、搜索替换后点击该行，原实现仍发起 API 读取；修复后没有调用。点击新行的内部文件名仍正确读取，卸载后的控件保持现有验证。

### R3：防抖间隙仍允许旧历史筛选发布

位置：`modules/ui-system/side-pane/planDetailSideProvider.js`。

触发：已有请求等待，输入新的关键词，但新的 300ms 防抖请求尚未启动；旧请求成功或失败后，页面用新的条件显示旧结果/旧错误。原 filterSeq 只在请求开始递增。

修复：输入意图发生时立即递增版本并清除旧结果/错误，保持输入焦点与光标，防抖继续限制后端调用。清除筛选走 runSearch，使待发 timer 与在途结果一起失效。

证据：两种受控完成顺序在修复前失败；修复后旧节点/错误都不显示，输入焦点保留，新条件的结果正确显示。

### R4：同 ID 重开误继承已关闭的挂载

位置：`modules/ui-system/side-pane/side-pane-controller.js`。

触发：provider 挂载未完成时关闭标签，再用同 ID 和新 payload 打开。原 pending 表按 ID 复用 Promise，旧挂载完成后只看到“这个 ID 还在”，因此装到新的标签生命周期上。

修复：pending 表持有独立挂载 occurrence；关闭立即取消其发布资格并移除旧 view。重开创建新 occurrence，迟到旧 handle 独立 dispose。旧 Promise 完成只能清理自己的表项，不能删除新挂载。控制器销毁同样取消 pending occurrence。现有同一次生命周期的并发打开仍只挂载一次。

证据：修复前重开只挂载 1 次，受控回归失败；修复后新旧 handle、DOM 和 dispose 分离。旧结果先于新挂载完成时，再并发打开仍复用新挂载，最终只有一个新 view。

## 第二轮：话题归属与迟到聚焦

### R5：后台打开返回前台 handle

`side-pane-controller.js` 的 openTab 使用 `state.activeTabId` 作为挂载目标。然而纯状态模块按话题归属决定是否激活：在 A 话题打开 B 的标签时，活动 ID 仍为 A。于是控制器没有挂载 B，直接返回 A 的 handle；如果前台没有挂载，错误的 provider 还可能装到前台 ID 上。

修复：挂载 ID 从本次 toTab 解析结果取得，按状态模块的字符串 ID 规范使用。保留 raw payload 给类型自己的 provider 适配器，不把辅助对话 descriptor 契约误改成通用 tab。后台标签获得独立 handle、隐藏 view，切到其话题后复用；不影响前台内容或聚焦。

### R6：隐藏话题的激活会把当前正文变空

状态 activateTab 只检查全量标签是否存在；控制器还把该 ID 写入当前话题激活记忆，并聚焦其 handle。旧实现可以从 A 话题直接激活隐藏的 B 页，DOM 投影又按话题隐藏 B，因此出现没有活动正文的状态。

修复：状态转换和控制器入口均检查当前话题可见性；无效激活不改快照、话题记忆或焦点。launcher 和常驻通知继续按原规则使用。纯状态的既有话题用例增加直接激活的身份断言，控制器用例验证背景 handle 不会被激活。

### R7：异步打开完成后抢走后续焦点

旧 finishOpen 无条件调用 handle.focus。受控挂载期间切到通知、收起侧栏、切话题，或者聚焦主输入框，迟到完成仍会调用旧页面 focus。

修复：完成时核对目标活动 ID、可见话题、展开状态及当前挂载 entry，焦点仍是打开时的元素（或该元素已被移除而落到 body）才聚焦。已有正常打开聚焦和同 occurrence 并发挂载测试继续通过；API 仍向后台调用者返回自身 handle。

证据：新增 5 个行为用例在旧实现全部失败；修复后 32 项控制器、状态、焦点、持久化测试通过。实际主窗口中的隔离临时 iframe 运行旧/新源码：旧返回 a、外话题激活变 b、主输入框丢焦；新返回 b、活动标签保留 a、输入框保持焦点。截图仅证明这些临时资源与焦点流程，不冒充业务页面的视觉设计评审。主窗口未 reload；原标签、草稿、主题保持一致，临时框架已移除。

本轮全量 248 个测试文件通过、9 个已知失败、0 超时，逐条失败与第一轮一致；相关 221/221、UI 121/121，七项检查通过。没有新增模块或样式，事件图检查通过，无需改变生成结果。

## 第三轮：关闭授权与回收

新增 6 个受控行为用例在旧实现失败，确认下列故障，并使用独立工厂 `createSidePaneTabCloseOwner` 修复；它不 import 其他子模块，状态/DOM 提交通过控制器回调。

- **R8 重复关闭重复授权/清理**：旧控制器没有关闭操作归属，两次调用会分别 requestClose、dispose、onClosed；一份拒绝还可能与另一份允许交错。现在同 occurrence 共享 Promise，拒绝后释放操作以便再次关闭。
- **R9 旧 onClosed 移除新标签**：旧控制器在等待 onClosed 之后才按 ID 移除状态，同 ID 重开会被旧提交删除。现在授权成功后先同步移除状态/view，再等待旧 dispose/onClosed；旧完成只能清理自己的操作表项。
- **R10 销毁与授权重叠重复 dispose**：旧 close 在 controller.dispose 之后继续 dispose 并执行业务 onClosed。现在授权返回后核实控制器及 mounted entry；未提交的关闭不做业务删除。所有已挂载 entry 的 dispose 用 WeakMap 共用一次；销毁等待已提交关闭的清理。
- **R11 等待期间转移焦点仍被抢回**：旧 ownedFocus 在授权前取得。现在在同步提交关闭时读取当前位置，移到主输入框后不聚焦标签条；onClosed 完成不再重做当前 UI 提交。
- **R12 不可关闭标签仍被清理**：旧入口只保护通知标签，其他 closable=false 仍会被 dispose/onClosed，而纯状态又拒绝移除，留下没有视图的标签。现在保护发生在授权与资源操作之前。

聚焦测试 35/35、相关 227/227、UI 121/121、七项检查通过；全量仍为 248 个测试文件通过、9 个原有失败、0 超时，失败列表与第二轮一致。新增 owner 66 行；事件图仅新增该文件清单，样式未改。实际窗口隔离临时预览的旧/新对比：旧新标签丢失、授权/dispose 各两次、主输入框丢焦；修复后新页保留、各一次、光标保留。原标签、草稿、主题不变，窗口未 reload。

设置 close 的两项基线失败已定位到 **过期测试契约**：`44fc546c` 明确撤掉关闭 barrier，改为立即隐藏、后台 flush。bridge refresh 保留连接的 canonical form；destroy/teardown 仍等待 durable barrier 并保留 error/conflict 草稿。因此不能为了旧测试变绿恢复阻塞关闭；下一步要改为验证关闭后保存与 draft owner 保活、迟到结果不改变重新打开的页面，另验证真实 coordinator 的失败/重试。

仍需核实具体 provider 是否在 dispose 中完成所有资源清理、后台旧 onClosed 的业务删除与新开资源的身份边界，以及批量关闭等后续 UI 意图。此轮不外推为所有资源 owner 都已正确。

## 第四轮：纠正设置关闭测试契约

这轮没有恢复阻塞关闭，也没有修改保存协议。删除 ui-helpers 的遗留 modalClosePromises（从 `44fc546c` 起再无写入），补充隐藏与 owner teardown 的职责注释；更新设置交接/验收记录，避免当前代码、文档与测试各说一套。

`ui-helpers-settings-close.test.js` 的旧两项 barrier 测试改为四个当前交互用例：立即隐藏且重复关闭只触发一次后台 flush；旧 error/conflict/rejection 完成不关闭新一代已重开的表单、不丢新输入，rejection 被记录而非未处理。用 `eaa6a8fd` 的旧阻塞实现重跑，这四项全部失败，证明不是对两种相反契约都能通过的弱断言。

`settings-close-stress.test.mjs` 原有 30/50 次同构循环和固定 20/40ms 等待改为两个受控真实 coordinator 组件场景：隐藏表单接收失败 terminal 后保留 durable base、draft、pending ops，随后成功写入结果推进 revision 并清空 pending；隐藏时真正 dispose 要等待 terminal result 后才释放 coordinator/结果通道。移除无关的 globalThis DOM 覆盖，并在 finally 关闭 JSDOM。

6/6 设置关闭用例通过；全量 **249 个测试文件通过、8 个失败、0 超时**，唯一失败清单变化是原 ui-helpers 过期测试修复，其余逐条相同。相关 227/227、UI 121/121、七项检查和 UIUX 四项生成产物检查通过。第一次 event gate 检出行号变化，重新生成后只有 ui-helpers 的位置证据更新，复验通过；不是忽略失败。原有 CRLF 保留，diff 检查使用 cr-at-eol 并保留其他空白检查。

实际窗口隔离临时 iframe 加载当前 helper 与真实 coordinator、仅使用受控内存 transport：立即关闭返回 true，form/owner 仍连接；重开编辑 Newer 后旧保存失败，窗口仍打开、draft=Newer、durable=Initial、status=error。没有写入用户设置，原窗口状态保持一致。该验证和组件测试 **不证明完整 SettingsBridge/typed/legacy owner 或 IPC 文件持久化端到端都已正确**；这些层仍需沿调用链检查，不能扩大证据范围。

## 第五轮：输入生命周期与插件目标身份

继续整体审查；已完成的计划侧栏分栏（`ecb9067a`）没有重新修改。先核实当前 HEAD 与工作区，保留用户原有 `styles/themes.css` 改动。

本轮深入读取 DSH 的 `ui-attachment/src/client/index.ts`、`ComposerAttachments.tsx`、`drop-events.ts` 以及 plugin/drop/composer 测试：展示插件只登记槽位，附件接收回调由 conversation owner 提供；document/window 拖拽监听由每次 effect 安装并返回精确 cleanup，disabled 时禁止转交文件，非文件拖拽保持原生行为。plugin 测试验证 fiber 注销后四个槽位消失；composer 测试覆盖目录识别、嵌套拖拽、退出窗口、blocked drop、移除与重试，而不是只数事件监听器。

ZCode 的 `v4/composer/useComposerAttachments.ts` 已读接口与 scope 构造、上传执行、runtime 失效/重建、附件入队和全局白板引用门控分支（未读完整大 hook）：scope 含 workspace identity 与 scopeId，上传还按具体 controller 身份检查进度、成功与失败；更换 runtime 时撤销旧 controller，等待新 session 后才重排队。全局 add-to-chat 只由聚焦 composer 消费且匹配 workspace，effect 返回对应取消订阅。`mentions/providers/fileMentionProvider.ts` 与 `activePromptInputToken.ts` 完整读取：结果按 service/workspace/connection/query/limit 校验，effect cleanup 使旧读取失效；光标移动仍在同一未改 token 内时保持候选查询。这里的启示是输入资源归实例、异步结果归 scope 和 occurrence；这些参考逻辑不直接证明我们的实现正确。

### R13：实例退役必须释放自己的订阅

`inputEnhancer.js` 原先仅把 preload 文件订阅交给可选 renderer listener owner，实例自己的 dispose 不释放；初始化替换实例时旧订阅一直保留到整个 renderer 销毁。DOM 监听交给外部 owner 后同样没有局部清理。修复为实例和 renderer 都能清理对应资源：DOM remove 对同一 handler 幂等，preload unsubscribe 使用一次释放包装，避免两个 owner 重复调用底层取消函数。没有把同步 DOM owner 的 dispose 擅自解释为等待全部异步工作；生产 renderer 仍显式调用 input enhancer 的 dispose。

### R14：重复销毁必须等待同一个在途工作屏障

旧实现第一次 dispose 标记 inactive 并等待任务，第二次直接返回，可能让第二个 teardown 调用者在文件处理结束前继续释放后续资源。现在保存并复用 disposal Promise；标记 inactive 与资源撤销仍立即发生，迟到结果不投影到附件/预览。主窗口的 renderer 组合和 preload `on()` 实现已核实，后者返回精确 removeListener 函数。

原 `input-enhancer-owner.test.mjs` 缺少 document，且第二项依赖第一项的全局 window/import 状态，因此不能证明上述生命周期。改为每项独立 JSDOM realm、真实 DOM、明确进入 IPC 与完成的受控 Promise，并在 teardown 关闭窗口。测试验证真实拖拽在 owner dispose 后不再生效、所有 dispose 调用者均等待、单实例释放订阅、重初始化只保留一个订阅、旧回调不投影、与 renderer 同时退役只取消一次。没有依赖固定睡眠或替换 globalThis。

### R15：同级名称歧义不能按目录枚举顺序选写入目标

`pluginAgentOperationService.findAgent()` 在 `62b936a7` 引入 ID > 精确全名 > 前缀 > 双向包含的优先级；旧测试把“唯一精确名 + 一个前缀名”当成歧义，确实已过期。但改动同时删掉了同级多候选的拒绝逻辑，两个精确名或两个同级模糊名会取目录枚举的首项。修复只拒绝最高匹配层级的多个候选，提示使用 Agent ID；唯一精确名优先与显式 ID 规则保留。

通过真正的 `CreateTopic` 命令验证精确/前缀/包含三种同级歧义在任何写入前拒绝、双方配置未变；另验证唯一精确名成功写入正确目标，以及同名情况下显式 ID 仍能写入指定目标。没有将合法的新匹配规则回退为旧的全包含拒绝。

修复前受控测试 **8 通过 / 5 失败**：三种歧义均缺少预期拒绝，两个输入生命周期场景分别提前结束或未释放旧订阅。修复后输入、笔记键盘、工作区提及、插件服务 **20/20**；相关 **227/227**、UI **121/121**；全量 **251 个测试文件通过、6 个失败、0 超时**。减少的两个失败文件就是输入 owner 与插件服务；剩余六项全部是 Scriptorium Electron 入口被 Node 运行的问题，仍待正确运行器验证。事件检查首次准确检出陈旧行号，生成后只更新输入工作区事件的位置，复验通过。

实际工作区窗口的隔离 iframe 对比旧/新源码：重复 dispose 等待 false→true，单实例/重初始化取消订阅 0→1，保留订阅 3→1，迟到附件与预览均为 0。仅使用受控内存 API；截图后移除 iframe，原标签、草稿与主题快照一致，未 reload 主窗口。此验证不覆盖主进程文件持久化、话题切换中的附件归属或生产 composer 的所有入口；这些仍需沿调用链审查。

本轮还扩大运行完整 `npm run check:ui-system`，不能继续用七项局部门禁代替它。聚合命令在第一项 `guard:design-subtraction` 停止；随后把其余 30 项逐项运行，27 项通过、3 项失败：`guard:next-delta` 读取已不存在的 `preloads/shared/catalog.js`；stylelint 指出 chat-input 与 side-pane-shell 各一个重复选择器；appearance-engine 的全局壁纸 sidebar backdrop-filter 字符串契约不匹配。相关脚本和 CSS 在本轮未改动，这些是新增发现的审查待办，不宣称产品行为已经有回归或门禁已经通过。

design boundary 默认以 HEAD 与 origin/main 的 merge-base（`3bb5266b`）审查整条分支。375 个报告路径中，374 个在本轮开始的 HEAD 已与基准不同（按 `core.quotepath=false` 核对中文路径）；剩余一个是本轮增强的插件服务测试，处于这份历史“设计减法 PR”白名单之外。当前用户要求审查整个工程，该测试改动符合任务，但并不满足旧 PR 文件范围合同。没有扩张白名单、偷偷改基准或绕过失败。后续应区分一般工程质量检查与某个历史 PR 的范围检查，并核实缺失目录、重复规则的层叠语义与壁纸实际行为后修正适用契约。

## 第六轮：真实 Electron 运行与失败信号

本轮未修改计划页或生产编辑器。六个 Scriptorium 入口此前被统一用 Node 运行，失败发生在加载 Electron app/BrowserWindow，不能当成六个产品回归，也不能永久豁免。首先使用隔离 Electron profile 实跑旧入口：CDN、本地导出、网络字体和 VPPTX 四项通过；Markdown 输入与标题边界两项失败，均无超时。

新增 `tests/helpers/electron-test-entry.cjs` 与 bootstrap：普通 `node --test` 注册一个真实集成用例，再启动仓库安装的 Electron；每次使用新建的 userData/session/logs 目录、隐藏 BrowserWindow，等待真实退出状态。截止或取消时只终止自己启动的进程树；结束后核对路径并删除自己的临时 profile。直接在未隔离的 Electron 入口运行会被拒绝。辅助文件不增加测试文件数量，没有绕过网络字体请求或用本地 stub 冒充通过。

### R16：断言失败被提前退出吞掉

旧 CDN 入口在 finally 调用 app.quit，catch 再设置不受支持的 app.exitCode；导出和网络字体也先 quit 再到失败处理。实际内核的受控失败探针表明，同一断言失败走旧退出路径返回 **0**，把 quit 移出 finally、成功/失败显式 app.exit(0/1) 后返回 **1**。修复后的父运行器检查真实退出码；失败输出随断言提供，不能再以普通进程成功结束判定测试通过。

### 两项过期编辑契约

Markdown 测试只派发 synthetic beforeinput 并要求 preventDefault，但生产在 `51d519c4` 已改为由浏览器执行普通文字 DOM 编辑，再在 input 中同步文档。synthetic beforeinput 自身不会执行该默认编辑。改用仅本测试窗口可调用的 preload/IPC 与 Chromium webContents.insertText，验证中文、emoji、ASCII 的真实输入、占位行替换、正文同步、焦点与光标。24 次相同循环收敛为三种有区别的输入；等待以源码条件和有界截止为准。原有受控 IME 用例保留，但不声称覆盖物理输入法的全部平台行为。

标题边界测试仍期待 U+200B；当前 compiler 与局部编辑路径在 `70827d40` 已采用可见占位符 ↵。只更新该过期断言，保留边界编辑器、二次 Enter、DOM 几何和选区存活验证，没有为旧断言改变生产语义。

六个真实 Electron 入口 **6/6**，全量 **257 个测试文件通过、0 失败、0 超时**；相关 **227/227**、UI **121/121**，七项常用检查通过。截图来自本轮创建的隐藏真实 Scriptorium 窗口：原生文字和边界 fixture 能渲染；这不证明所有远程媒体成功加载、全部生产 IPC/保存路径或全面视觉评审。原主窗口未 reload，临时窗口与 profile 已清理。

扩展 UI 检查仍不全绿：聚合命令被历史 design boundary 拒绝，其余 30 项逐条运行 **27 通过、3 失败**，仍是缺失的 legacy preload catalog、两个重复 CSS 选择器、appearance-engine 全局壁纸断言。本轮未修改这些脚本或 CSS，也未扩张旧 PR 白名单。全量 Node 测试通过不等于这些工程检查通过，更不等于全工程审查完成。

参考研究继续读完 DSH tab-registry 的运行时登记、guide 缓存、路由匹配与扩展/builtin 覆盖：登记与 fiber effect 绑定，注销比较具体 definition 身份；优先级分层后按 pattern specificity 与登记次序匹配，显式 kind 仍需 canOpen 许可。对应测试已读唯一性、shadow/unregister、显式 kind veto、fiber 注销与缓存稳定分支（中段尚未全部读完）。我们的 registerTabType 覆盖时可选 provider/launcher entry 是否留存旧登记仍是候选问题，尚未复现，不能写成已修复；不引入参考实现的扩展优先级机制来扩大产品范围。

## 第七轮：登记替换与清理归属

继续深入对照 DSH `tab-registry.ts`，补齐此前遗漏的测试中段：标题随语言即时读取、纯页面无需 patterns、guide 携带当前 provider id、同 band 重复登记拒绝、扩展退役后恢复 builtin、fiber 卸载释放 kind。读完 `tab-domain.ts` 的 occurrence/commands/actions：每次记录生命周期有独立 AbortController，layout commit 后按 session 同步 pin/abort，commands 的注销比较具体对象身份；旧 occurrence 不因同 ID 恢复而重新使用。参考资源动作自身的全部迟到调用路径仍未验证，不把它当作正确性保证。

ZCode 进一步读了 `workspaceSidePane.ts` 的 parent 可见性、活动 fallback、单标签和 visible/all/other 关闭转换，以及 `useAppPanels.ts` 的授权后批量关闭和 reopen。纯状态不负责释放 PTY/browser，runtime 显式回收；关闭后的 browser 重开使用新 UUID 并清掉 residency 字段。授权前取得的资源列表和授权后取得的当前状态仍是不同快照，不能仅凭这些代码推断异步重开一定安全。

### R17：省略字段仍继承旧登记

本工程已有测试明确允许同 kind 替换，所以保留该契约，没有照搬 DSH 的 band/插件覆盖机制。旧 registerTabType 只在新 entry/provider 存在时写入，省略时旧入口和旧 provider 继续生效；entry.id 改变时还同时留下两个入口。

提取无子模块依赖的 `createSidePaneTabRegistry`，由组合者提供 registerEntry/render 回调。成功替换释放旧登记持有的入口和 provider，再登记新声明；不合法 entry 验证失败保留旧声明。旧注销函数以登记身份核对，不移除新登记或独立替换的 provider。新工厂 51 行，控制器整体减少代码；已有运行器和静态类型 API 保留。

### R18：旧页面清理误用新类型钩子

旧 close 通过 kind 查询当前 definition.onClosed。页面用旧 provider 挂载后替换类型，会调用新业务删除回调；注销类型后则完全丢失原回调。现在挂载开始就捕获 onClosed，并由 pending/mounted occurrence 保留，替换仅影响后续挂载，旧页面在自己的生命周期关闭时使用原回调；普通 controller.dispose 仍不触发业务删除。

五项新行为验证在旧代码 **33 通过 / 5 失败**；修复后控制器、登记、持久化 **44/44**，相关 **232/232**、UI **121/121**，全量 **257 个测试文件通过、0 失败、0 超时**。七项常用检查通过：首次 events 正确报陈旧清单，生成后只新增 registry 文件清单一行，再检查通过。没有 CSS 改动，因此样式白名单无需调整。扩展检查仍是历史 design boundary 加三项既有失败，其他 27 项通过，没有改变旧 PR 白名单。

实际工作区窗口临时 iframe 的旧/新源码对比：旧入口/旧 provider 调用 **1/1 → 0/0**；旧页面关闭从 `new:old` 纠正到 `old:old`，注销后新页面仍执行 `new:new`，待挂载旧页面执行 `pending-old`。截图后清理 iframe，主窗口原标签、草稿、主题快照一致，未 reload。这个验证使用真实控制器与 DOM、受控 provider，不覆盖生产 provider 的全部文件/进程清理。

另已用受控实际控制器复现下一项待修复缺陷：closeAllTabs 等待 A 授权时，另行关闭并以同 ID 重开 B；批量循环随后按旧 ID 把 `B:new` 销毁。探针结果已记录，**此缺陷尚未修复**。需要让批量意图绑定原始生命周期，并验证 metadata 更新/迟到挂载不会被误当成重开，以及关闭后激活不会覆盖后续用户意图。

## 第八轮：批量关闭、后续意图与资源语义

继续处理第七轮已复现的批量关闭问题，没有重新修改已完成的计划页。DSH occurrence 测试进一步验证同 ID undo 恢复产生新 signal、pin 每次生命周期仅一次、其他 session 同步不 abort 当前资源、未提交 occurrence 读取会抛错而不是创建状态。我们的标签声明/handle 会在标题更新或延迟挂载时改变，不能简单以这两个对象的引用作为整次页面生命周期。

### R19：批量意图必须绑定原始页面生命周期

closeAll/closeOther 旧循环只保存 ID，再逐个等待授权；A 等待时 B 关闭并同 ID 重开，循环会销毁 B:new。close owner 现在捕获独立 token，状态关闭提交时才释放；标题更新、pending→mounted、恢复页首次挂载保留 token，关闭后同 ID 重开取得新 token。调用下一次授权前和授权返回后都核对原 token；重叠操作仍共享原关闭 Promise，不再次授权或 dispose。

### R20：旧完成不能覆盖后续导航或外部焦点

旧 closeOther 最后无条件 activateTab。现在记录导航意图版本：打开/激活、显示通知/新标签页、收起、真正换 parent 和新的关闭意图会撤销旧批次的最终激活资格；重复同步相同 parent 不算新意图。保留页也核对原 token。焦点跟踪仅接受本批次同步 DOM 关闭产生的明确交接，外部输入框焦点不会被跟着改写；共享授权的多个批次各自观察交接，只有最新意图最终聚焦一次。普通/veto 场景仍选择保留页，没有用一律取消聚焦来让断言通过。

### R21：授权返回后还要核对可关闭性

已有标签可通过 openTab 更新声明而继续使用同一 handle；等待期间改为 closable=false 时，旧实现仍拆视图/资源，但纯状态拒绝移除，留下没有正文的标签。现在提交前重新核对 closable。updateTab 仍只修改标题/payload，没有扩大其 API。

新增独立批量测试文件，15 个场景涵盖 all/other 重开、metadata、pending/lazy 挂载、六类后续导航/可见性意图、外部焦点、普通关闭/veto、等待中不可关闭和重叠批次。旧源码 **4 通过 / 11 失败**，最终控制器/批量/登记/持久化 **59/59**、相关 **247/247**、UI **121/121**；最终全量 **258 个测试文件通过、0 失败、0 超时**。多出的一个文件组织独立批量契约，不用增加重复循环充计数。七项常用检查通过；事件图与样式白名单没有需要变更的内容。

实际窗口的隔离 iframe 对照：B:new、后续选择、主输入框、改为不可关闭的页面均从丢失变为保留；重叠批次完成聚焦 **2→1**。截图后临时 iframe 已清理，主窗口原标签、草稿与主题快照一致，未 reload。验证用真实控制器/DOM 与受控授权，不据此宣称生产 PTY、webview 或所有后台资源都已正确释放。

验证期间工作区有并行更新：`e934a9cf` 浏览器工具栏、`05bdfaa5` Git 标题栏，以及后续未提交的 lucide/browser 样式改动。首次 UI guard 曾读到过渡中的 browser 字面颜色，保留该失败日志；完成该提交后的实际源码与最终七项检查通过。最终实现补齐共享焦点交接后重新跑全量，保留外部改动，不将它们归入本提交。扩展检查的历史 design boundary、缺失 legacy preload catalog、两处重复 CSS 选择器及 wallpaper 断言仍未解决；其余 27 项通过，全量测试不能替代这些检查。

### 深入参考资源回收链与下一步

ZCode 从 renderer bridge/preload 追到 `desktopBrowserViewIpc.ts` 的关闭入口，再读 `BrowserGuestManager.closeTabFromRenderer`、`requireRendererOwnedTab`、`closeTabDurably` 和核心关闭回收：windowId 来自 IPC sender；存活 tab 校验 window/workspace/session，close 特意不沿用 attach 的 remote-session 校验；缺失/已关闭 tab 幂等补 tombstone，阻止迟到恢复；先 await 恢复存档删除，失败保留逻辑 tab 供重试，再回收 guest、waiter、下载、活动记录和 residency。通知 helper 携带 owner scope 路由后台工作区。尚未完整审查其 recovery store、全部 guest/CDP 路径及错误测试，不把这几段读完写成整个 BrowserGuestManager 已覆盖。

我们的资源所有权不同：已沿 terminal provider 的 attach/dispose、typed preload 到 terminalHandlers create/kill 分支确认 `terminal:kill` 只 detach renderer 所属 view ID，不结束共享 PTY。已有真实 executor 的多视图测试验证相同 PID、不同 view 归属和关闭一页后继续输出；不能仅凭函数名改成物理杀进程，也不能把 ZCode 的 per-tab PTY 策略直接搬来。terminal provider 的全部初始化/失败/重试与 executor 后端仍待继续核实。

下一项候选是 browser provider 的 `mounted.delete(tab.id)` 和最后页面取消订阅：旧挂载 handle 退役时可能清掉同 ID 的新登记，影响空白页复用与 popup 订阅。已读该入口、挂载与 dispose 分支，**尚未用真实 provider 复现**，不列作已修复缺陷。随后继续资源 provider、主进程/IPC、聊天/设置生产链及全范围账本，修正四项扩展检查的当前契约。

## 第九轮：浏览器登记归属与图标检查的真实启动

没有重新修改已经完成的计划页。本轮沿真实 browser provider、控制器和主进程浏览器处理器核实资源归属，并继续深入阅读两套本地侧栏参考的 browser 生命周期与恢复存档。

### R22：旧 browser handle 清理新页面的登记与订阅

真实 provider 的 async mountTab 在返回 Promise 前已同步写入 mounted。立即关闭 pending 标签并同 ID 重开，新挂载先覆盖该登记，旧挂载的迟到 dispose 随后按 ID 删除新登记，还把新页面使用的 popup 订阅注销。后果是下一次打开浏览器不能复用新空白页、存活页面失去 popup 处理。修复以具体 entry 身份核对删除，dispose 幂等；仍清理自己的监听器、旧 DOM 与 webview。普通两页场景保持共享订阅，最后一页关闭才注销。

### R23：入口绕过控制器的迟到焦点检查

openBrowserTab 等待 openTab 后无条件 setVisible(true) 和 handle.focus，覆盖控制器此前加入的迟到保护。新建和复用空白页两条分支都会重新展开用户刚收起的面板、从主输入框夺走焦点。现在直接返回控制器的打开 Promise，控制器统一负责展开、当前标签与焦点交接；没有添加第二套导航版本机制。

已有 browser-address 测试增强五个行为场景：真实取消挂载/同 ID 重开、重复旧 dispose、不同 ID 最后一页注销，以及新建/复用时的后续收起与输入框焦点。旧实现 **6 通过 / 4 失败**；修复后 **10/10**。实际窗口的隔离 iframe 使用真实控制器和 provider、受控 popup API：订阅保留、空白页复用、重复清理安全、后续收起和外部焦点五项 **false→true**。截图后 iframe 清理，原窗口标签/草稿/主题保持，未 reload。该 fixture 不加载网页，不能据此宣称 Chromium guest 实际退出、真实 popup IPC、下载与权限路径全部验证完成。

### R24：图标迁移后，检查仍断言 HTML 手写 SVG

并行提交 `c0d50e2c` 已把手画图标路由到 Lucide；classic-parity 与 UI-system 测试仍要求 main.html 源码直接含 SVG，因此失败。没有放宽成“存在图标名称即通过”。新增 34 行共享检查，按 main.html 的真实脚本顺序加载安装的 Lucide bundle 与 adapter，在 classic/next 模式分别等待 DOMContentLoaded，检查四个共享按钮实际产出 SVG 图形、有可访问名称且图标为装饰性；不加载 Next 组件运行时。缺失 bundle、未知图标、无名称按钮六个受控反例都被拒绝，两种模式的当前启动通过；实际窗口隔离 iframe 中四个按钮在两种模式均渲染，截图后状态一致且未 reload。该验证不覆盖完整页面视觉与所有动态按钮。其余 CSS 隔离、设置模板和组件断言保留。

### 参考实现的细节与取舍

本地侧栏参考的 BrowserController 与对应完整 controller 测试进一步区分 occurrence AbortSignal、物理 presentation mount 和 Session persistence writer：旧 signal 的 abort listener 在替换前注销，物理旧 mount 的 cleanup 比较 host 身份，rebind 只改变后续 checkpoint 写入；隐藏页面保留生命周期。ElectronWebViewImpl 全文与 electron-lifecycle 测试已读：独立 attachment/guest signal，迟到 workspace 解析不 acquire；acquire 迟到则 release 自己取得的 lease；dispose 共享 Promise 并等待初始化和已登记 release；loadURL Promise 的错误需同时匹配 element、lifetime、revision，ERR_ABORTED 不当作当前加载失败。ElectronWebviewPresentation 和主进程 browser-guests 全文也已读，后者按 owner + opaque lease 校验、workspace 分区共享储存、关闭等待 guest destroyed，宿主导航/崩溃/销毁释放所属 lease。参考 tests 使用受控 bridge/guest，未在该参考仓库运行，不把代码阅读等同真实后端验证。

ZCode 的 BrowserTabRecoveryStore 全文已读：mutationQueue 串行化、whenIdle 持久化屏障、临时文件 rename、损坏文件隔离、scope 过滤、pageState 数量/字节/历史上限与深复制。单条超限快照先过滤，避免挤掉正常旧记录。但 mutate 先修改缓存，再 await 文件写入，写失败不会自动回滚缓存；“文件原子 rename”不能直接推出内存事务成功。其输入逐记录校验、错误测试、完整 guest/CDP 协议和跨 scope 恢复仍待核实。我们的 provider 没有它的 durable tab store，不为这次登记修复引入该系统。

### 本轮验证与剩余范围

控制器/批量/持久化/browser/主进程浏览器测试 **56/56**，相关侧栏 **247/247**，UI **121/121**，全量 **258 个测试文件通过、0 失败、0 超时**；七项常用检查通过。最初沙箱运行出现临时 realpath/junction/Git 写权限 EPERM，保留诊断并终止自己启动的进程树，正常权限下重新验证通过；不把权限错误计为产品回归。最终全量通过后未继续改变生产代码。无 CSS 或新生产模块，事件图/样式白名单无需更改且检查通过。

扩展 UI 工程命令仍被历史 design boundary 阻止，389 个报告路径均在本轮 HEAD 已有差异；其余 30 项 **27 通过 / 3 失败**，仍有 legacy preload catalog、重复 CSS 选择器、wallpaper 断言三类失败。没有修改旧 PR 白名单，也没有豁免这些检查。并行 terminal 工具栏与 Lucide 更新保留，用户 themes.css 不提交。全量测试通过不等于全工程审查完成。

下一步继续核实 browser 的失败重试/guest 释放及真实 IPC，接着完成 terminal 初始化、失败、重试、视图与共享 PTY 的真实后端归属；聊天、设置、主进程、Rust 和打包范围仍按覆盖账本推进。browser reload 当前先清除 lastFailure 再读取 validatedURL，是下一候选，尚未用真实失败页面复现，不列为已修复。

## 验证与局限

- 修改前新增 6 个故障用例：文件旧成功/旧失败、旧行触发、筛选旧成功/旧失败、关闭重开。全部能在原实现上失败。
- 修复后相关测试 216/216；UI 测试 121/121；appearance、classic、interaction、async-state、journeys、events、ui-guard 七项检查通过。
- 全量按既有隔离命令运行：248 个测试文件通过、9 个原有失败、0 超时；逐条失败名称和计数与上轮基线一致。此次没有新增/移除测试文件，仅增强已有行为测试。
- 实际主窗口后来已有其他用户标签，未执行 reload；临时预览层使用当前工作区源码副本与真实渲染环境核验，并比较前后标签快照、草稿、主题，均保持一致。因此本轮不能声称主窗口既有控制器实例已热更新。
- 本轮没有新模块或样式文件；事件图和样式检查均无需改动且检查通过。

开始时 9 项失败不能成为永久豁免；第四、第五轮解决三个失败文件，第六轮按真实 Electron 环境处理剩余六项，当前全量无失败。以下保留原问题与证据边界：

1. `input-enhancer-owner.test.mjs`：第五轮已修正 DOM 装配并修复实例订阅释放、重复销毁屏障；当前三个受控场景通过。话题切换与完整文件 IPC 未据此宣称完成。
2. 六个 `scriptorium-*-electron.test.js`：第六轮已使用隔离真实 Electron 运行，修正两项过期编辑断言和退出码误报；六项均通过。字体仍是外网集成，最小 IPC fixture 不覆盖全部生产处理器。
3. `ui-helpers-settings-close.test.js`：第四轮已解决过期契约，删除遗留死状态；当前交互测试及 coordinator 组件证据通过。完整生产 owner、SettingsBridge、IPC 与发布环境的保存行为仍未据此宣称完成。
4. `plugin-agent-operation-service.test.cjs`：第五轮确认一个过期歧义断言与真实同级目标选择缺陷；已修复并通过 10 个服务测试。之前沙箱诊断的临时文件 rename EPERM 不能计为产品缺陷；本轮隔离实际文件写入没有该错误。

## 全范围覆盖账本与后续路径

审查开始时的清单记录了 2384 个跟踪文件。按代码扩展名排除常见 vendor/assets 后得到 1457 个候选，仍含部分生成 bundle；清单只用于导航，**不证明这些文件已审查**。后续必须区分手写、生成、第三方和测试资源，并随工作区更新刷新清单。

| 范围 | 当前证据 | 仍需完成 |
| --- | --- | --- |
| 参考侧栏实现细节 | 上表列出已读逻辑；DSH occurrence/资源 policy、ZCode request/workspace 边界已落到复现修复 | 继续读完整 state/planner、资源 provider、browser/terminal/subagent、布局/持久化与对应错误路径测试；记录取舍，不能只数文件 |
| 我们的侧栏架构和生命周期 | 挂载 occurrence、picker/计划筛选、话题归属、迟到 focus、异步关闭/销毁、声明替换、旧页面清理、批量原始生命周期与后续意图已复现修复 | browser 同 ID 内部登记/订阅与入口迟到焦点已验证修复；具体 provider 的业务清理、还原与后台驻留、动态缓存容量、订阅归属 |
| 聊天和辅助对话 | 尚无本轮深入结论 | 主聊天/辅助对话所有者、流/取消/重试/编辑、草稿、会话与工作区隔离，对照 reference lease/occurrence |
| Git、ProjectForge、源码后端 | 本轮只追到 provider 读取与已有测试 | IPC/preload 契约、读写根目录约束、真实 Git 与回退竞态、并发快照、索引、错误分类、批次缓存、隐藏面板 I/O |
| 主进程、其他服务与 Rust | 清单定位到 IPC/services、chat data/audio/assistant/indexer 等模块 | 主进程资源生命周期、异常恢复与服务装配、Rust 测试与接口、插件/工具调用、升级/打包运行闭包 |
| 测试体系 | 生命周期/批量/同级名称回归在旧源码失败；过期装配已修正；六个入口真实 Electron；图标检查执行真实启动；最新第十轮全量 260/0 | 核实其余断言和生产 IPC/持久化覆盖、继续消除随意等待/源码字符串自证、区分单元/真实后端/窗口验证、检查门禁新分支覆盖 |
| UI/UX | 前两轮计划分栏有实际窗口证据；本轮正文错误归属修复 | 全入口、焦点、键盘、读屏、浅/深/磨砂、窄窗口、空/加载/错误/权限/断连、性能与隐藏页面行为；不能仅评估计划页 |
| 可维护性与 AI 可读性 | 此记录包含参考路径、身份约束、故障证据和未覆盖范围；picker 的误导性复制文件头已纠正 | 入口/数据/生命周期图与实际依赖一致性、其余复制文件头、重复真相、隐式全局/魔法 key、生成规则、文档过期、合理模块边界与契约 |
| 完成审计 | 未通过：上表仍有明确未覆盖范围 | 每个要求都需具体当前证据；不能用本轮修复或已有绿灯宣称全工程完成 |

下一轮继续补齐参考的资源、状态和生命周期链，沿具体 provider 的 cleanup 与设置生产 owner/IPC 路径验证，核实注册覆盖/注销以及剩余四项扩展检查的适用契约。随后沿实际依赖进入聊天、服务、Rust、独立应用与发布链。检查边界要随证据扩展，不限制在新建的侧栏文件。

## 第十轮：终端请求与清理、浏览器错误页重试

计划页维持已完成状态。本轮沿终端 view → typed preload → terminalHandlers → 共享 PowerShellExecutor PTY 追踪，并深入比较 DSH 的 Client/Host 分层及 ZCode 的常驻终端分支。没有把参考源码中的说明当成操作指令。

### R25：终端创建 RPC 拒绝后，资源失去清理入口

terminalCreate 的传输拒绝原先直接使 mountTab 拒绝。控制器移除标签后无法取得 handle，已经创建的 xterm、主题/尺寸 observer、三个输出订阅失去 dispose 入口；用户也无法在原视图重试。现在 create/restart 的拒绝进入当前视图错误状态，输出错误原因并保留 handle，重试成功后由正常关闭路径注销订阅、销毁 xterm、释放自己的 view ID。

### R26：连续重试创建重复 view，连续重启重复中止共享 PTY

原先两个点击分别发出 terminalCreate 或 terminalRestart。前者重复占用受限 view 配额并发起 IPC 分配；已有 generation 会注销较旧的成功结果，不能把这条路径误报为必然泄漏。后者属于真正重置 AI、终端窗口和侧栏共同使用的进程。现在以每个 mounted view 的一个 connectionOperation 合并正在进行的 create/restart；操作结束或拒绝后清除，允许用户明确重试。重启确认在合并检查之后，重复点击也不会重复确认。保留 generation/disposed 检查：关闭之后迟到的 create 成功只注销其返回的 view，不结束共享 PTY。

### R27：旧 handle 重复清理和入口迟到抢焦点

terminal handle.dispose 增加同一生命周期的幂等保护，三个 unsubscribe 和 xterm.dispose 只执行一次。openTerminalTab 直接返回控制器 openTab，避免其 await 后另一次 setVisible/focus 覆盖用户后续收起面板、继续在主输入框打字的意图。这是终端自己的入口修复，未重新实现已修复的 browser 入口。

新增 terminal-lifecycle 文件使用真实 provider、真实控制器和受控 IPC Promise，七个不同的生命周期场景在旧源码上 **1 通过 / 6 失败**，修复后 **7/7**。主题测试不再吞掉 mount 异常，以 MutationObserver 的微任务结算代替固定 20ms 猜测，并在 finally 释放 handle、关闭 JSDOM。现有四项主题测试通过。

实际主窗口临时 iframe 对比六项：RPC 拒绝后可重试、创建去重、重启去重、重复清理一次、后续收起保留、主输入焦点保留，全部 **false→true**。采用受控 API 和替代终端输入元素，不据此宣称真实 xterm 的 IME/复制粘贴/ANSI 或共享进程故障全部验证完毕。截图后 iframe 移除，窗口标签/草稿/主题保留，没有 reload。

### R28：浏览器错误面板出现时，重试可能尚无可用 guest

最初的真实 Electron 两种失败重试均恢复成功，不能仅凭死分支就下结论。随后全量测试捕获更早的时序：首个 did-fail-load 先于 dom-ready，错误面板可点击但 canUseGuest 为 false，pendingUrl 又为空，reload 直接返回；服务器只有首次失败请求，10 秒后仍为错误文档。另一个受控路径确认：hideNotice 清空 lastFailure 后，validatedURL 分支永远不执行，guest 保留上一成功地址时会刷新错误目标。

修复在清除错误状态前交给 navigate(lastFailure.validatedURL)。guest 已就绪时加载该失败地址，未就绪时由现有 pendingUrl 排队，在 dom-ready 后加载。保留普通刷新和 crash 重建路径，没有再造一套 guest 状态机。

已有 browser-address 文件增加两种事件顺序，旧源码 **10 通过 / 2 失败**，修复后 **12/12**。真实 Electron 集成测试使用本机临时 HTTP 服务，覆盖首次失败及成功页后导航失败：立即点击错误页重试，必须产生同一失败路径的新请求、提交唯一的新响应标题、隐藏 notice；dispose 后等待主进程真实 guest 的 destroyed，两个 guest 均退出。单项入口遵循已有隔离 profile 和异常退出协议，成功不会仅取决于 Electron 启动退出码。隐藏窗口使用软件 compositor；硬件截图的 UnknownVizError 日志保留，不混成产品重试失败。集成截图仅是最小宿主 fixture，不作为实际产品视觉一致性的证据。

主窗口另一个不启动 guest 的事件 fixture 验证“未就绪重试排队”“已就绪使用失败目标” **false→true**，截图后恢复原窗口。最初一次完整测试 **259 文件通过 / 1 文件失败**（上述真实 browser 早期重试），最终修复后重新完整运行，结果见下文；失败运行原样保留。

### 本轮深入研究的参考细节与取舍

| 参考源码 | 已核实的具体设计 | 对本工程的判断 |
| --- | --- | --- |
| DSH `packages/api/terminal-controller/src/client/model.ts`、`client/index.ts` | model 的创建/关闭 Promise 合并；停止后不再分配；attachment 和 carrier generation 防迟到错误覆盖；输入/resize 串行并按 UTF-8 限额；快照/输出序号验证；render ACK 与 xterm 回调相接。service 按 Session + occurrence 找 view，contentId 保存 Host identity；关闭意图先持久化再移除 binding/view，后台清理失败可重试，不能删除重开后的 view。 | 采用请求合并与明确生命周期归属。全局共享 PTY 与 DSH 的 Session terminal 不同，不能按 tab 直接复制 remote.close。我们的输出背压、屏幕恢复和输入归属仍需独立核实。 |
| DSH `client/retention.ts`、`client/bindings.ts`、`client/close-requests.ts` | window hold 的物理流 ACK 先于输出 follow；释放拒绝未就绪 waiters 并等待 stream.dispose。每个 terminal 的 cleanup 单独 storage key，减少跨窗口覆盖；storage 失败有内存降级，不能等同持久化一定成功。 | 不把 DOM unmount、窗口断连和进程终止混为一事。我们的本地 IPC view 不需要凭空加入远程 hold/storage 协议，但 sender 销毁/导航后清理必须验证。 |
| DSH `packages/client/ui-sidebar-terminal/src/client/terminal.tsx`、`LazyTerminalBody.tsx`、`TerminalCleanup.tsx`、`TerminalRecovery.tsx` | xterm 在 body 真正挂载后 lazy 加载；screen 的 write 回调 ACK render revision，只有 visible + writable 才抢尺寸/焦点，只读视图跟随 Host 尺寸。后台清理错误显示在独立 root overlay 的 role=alert 并调用 model.retryClose，不复活原标签。恢复按钮只拥有错误与尝试状态，effect 退出后不写回本地状态。 | UI 展示错误和调用命令，资源/重试决策由 owner 持有。没有为了本轮错误处理另建常驻通知机制；后续应核实我们所有入口的错误提示、焦点和可访问性。 |
| DSH Host `src/index.ts`、`src/terminal.ts`、`src/retention.ts`、`src/stream.ts`（本轮完整读完） | pending allocation 计入容量并按 caller ID 去重；closedIds 在异步清理前封闭 identity；分配后构造失败保留 allocation cleanup，失败清理能重试；owner dispose 等待 pending 和进程清理并聚合错误。headless xterm + serialize 保存有界屏幕，统一队列排序 output/resize/snapshot；最新 follower 独占输入，旧 follower 退出核对具体身份。UTF-8 流式解码；每 follower 按编码 frame 字节限制，溢出明确失败而非静默丢字。close 等待 terminate 和最终输出 drainage 再结束 followers。retention 只在无人持有且连续确认 idle 达到阈值时回收，unknown/busy 保守保留，epoch 使迟到观察无效，cleanup 与活动观察各自不重叠。 | 资源归属、错误恢复、容量与背压均有明确 owner。不能用“页面不可见”推断没有任务，也不能认为一次 kill 调用返回就证明整个进程树结束。尚未深入完成 DSH subprocess provider 的进程范围终止、部署配置与其他 provider 的进程清理测试。 |
| ZCode `packages/ui/src/terminal/sidePaneTerminalSessionRegistry.ts`（完整）和 `TerminalSession.tsx` persistentKey 分支 | registry 的 hostEl/xterm/PTY 和订阅常驻，detachDom 只搬入 stash；release 删除登记并调用 disposer。未完成 create 的 placeholder 在失败/卸载时释放，create reject 比较具体 entry，迟到成功仅清理自己得到的 ID。data、exit、onData 和 Windows composition fallback 属于 registry；resize/theme observer 属于每次 mount。profileTheme 保存到 entry，避免重挂丢主题。Ctrl+V 明确取消原生 paste 后手工粘贴一次；HTTP/OSC8 链接拒绝其他 scheme。 | 同样区分常驻资源和当前 DOM 的订阅。我们的 xterm 随 view 关闭而释放，PTY 属于全局 executor；不能迁移成每 tab 创建 PTY。其普通非 persistent 分支、IME helpers 和对应测试仍未完整读完。 |
| ZCode `packages/services/src/terminal/terminalService.ts` 的 lazy import、CWD 与 create/write/resize/dispose/disposeAll 分支 | node-pty import 失败清缓存允许重试；启动目录在传入目录、HOME、home、根目录中找可用值；每 create 分配独立 ID/PTY，exit 注销 emitter/记录，显式 dispose kill 该 PTY，应用退出 disposeAll 逐项清理。 | 与我们的 shared PTY 模型不同。源码读到 cleanupTerminal，不能据此宣称其 kill 失败、子进程树和跨平台行为都已实测。 |

DSH shells.ts 及对应 controller 测试也已读完：默认 shell 来自目标 execution provider；只有 provider 没声明默认值时才采用保守平台兜底，已声明但无法解析不会静默换 shell。可选候选只跳过明确的 executable-not-found，传输错误和取消继续抛出；按 executable 名忽略大小写/扩展名去重。恢复已有 terminal 不要求重新发现当前默认 shell，进程存在时保留原配置；新建缺失 shell 则明确失败。参考中的真实 bash/TERM/尺寸/补全测试在 Windows 被 skip，本轮没有运行它。

DSH 的 controller、retention、stream、terminal 行为测试本轮读完，包括独立窗口 hold、迟到活动观察、双阶段 dispose barrier、终止失败重试、UTF-8 分片、独占输入转交、序号/字节容量、退出前输出 drainage。model/recovery 测试已深入读多个区段，尚未逐项完成覆盖核对；UI cleanup/recovery 测试已读完，验证只重试选中的失败 identity、旧 Session 的迟到成功/失败不覆盖当前提示；只读参考测试，未在参考仓运行。借鉴的是可控时序和实际结果验证，不是把参考测试数量搬过来。

我们的主进程 `terminalHandlers` 已读 create/所有权、sender 导航销毁、write/resize/kill/restart/cd、command-run 与 disposeAll。`terminal:kill` 实际只 detach 当前 sender 的 view，`restart` 才重置 PTY。PowerShellExecutor 已读 replay/mirror、真实 spawn/startup handshake、旧 onExit 身份核对和 cleanup；仍未完整核实命令中断、启动失败/资源 barrier、全部交互工具路径。已有 terminal-handlers 测试执行真实 node-pty/PowerShell，验证共享 PID、迟到 replay、不同 sender 拒绝访问、关闭 view 不杀 shell、shell 退出重启及 AI command-run；不能把 FakeSender 当成真实 Electron IPC 集成。

### 验证与剩余范围

修复后全量 **260 个测试文件通过，0 失败、0 超时**；在并行聊天改动提交并同步事件图后，提交前再次全量运行仍为 **260/0**。三次运行分别保存：最初 259/1 的真实故障、修复后 260/0、当前提交基线 260/0。

七项常规 guard 全部通过，UI **121/121**，最终侧栏相关 **255/255**，浏览器/终端本轮聚焦 **24/24**。扩展检查另有 **27/30** 通过；历史 design boundary 报告 390 个路径，均在当时 HEAD 已有差异，另三类仍是缺失 `preloads/shared/catalog.js`、chat-input/side-pane-shell 重复 CSS 选择器、appearance-engine wallpaper 源码断言。未放宽白名单或豁免这些检查。没有新增生产模块或 CSS。本轮七项检查运行时事件图通过；随后并行任务提交 `5b39d738` 的聊天修改，事件图只因 chatManager 的两处行号变成过期，已生成并审查这两处定位更新，检查恢复通过。该新基线另行补跑提交前全量及检查，前两次运行日志保留。

覆盖账本继续有效，全工程目标仍未完成。下一步补齐具体 provider 的其余错误路径、主进程关闭和真实 guest/PTY 契约，核实上述扩展检查与现行生产实现；继续参考布局/state/planner 及聊天、Git/源码/服务、Rust 和发布链审查。不能用这轮终端和 browser 修复宣称整个工程已完成。
