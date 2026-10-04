# 工程对抗性审查与改进记录

## 目标与完成条件

审查整个工程的架构、代码质量、测试体系、UI/UX、可维护性和 AI 可读性。必须深入研究本机 ZCode、DSH 的侧栏实现，将源码中的具体约束与我们的实际行为对照；不能把外观相似、文件变短或检查变绿当作完成。

当前状态：**进行中，尚未完成全工程审查。** 本记录随后续审查更新，候选问题和已复现问题分开记录。

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
| DSH | `packages/client/ui-sidebar-right/src/client/tab-registry.ts` 的登记契约 | 静态类型声明与运行时 body 分阶段，guide/title copy 可延迟读取。扩展覆盖 builtin 有显式排序和注销规则。keepMounted 是类型能力，并非所有内容统一常驻。其解析器全部碰撞路径仍待审查。 |
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

聚焦测试 35/35、相关 227/227、UI 121/121、七项检查通过；全量仍为 248 个测试文件通过、9 个原有失败、0 超时，失败列表与第二轮一致。新增 owner 65 行；事件图仅新增该文件清单，样式未改。实际窗口隔离临时预览的旧/新对比：旧新标签丢失、授权/dispose 各两次、主输入框丢焦；修复后新页保留、各一次、光标保留。原标签、草稿、主题不变，窗口未 reload。

设置 close 的两项基线失败已定位到 **过期测试契约**：`44fc546c` 明确撤掉关闭 barrier，改为立即隐藏、后台 flush。bridge refresh 保留连接的 canonical form；destroy/teardown 仍等待 durable barrier 并保留 error/conflict 草稿。因此不能为了旧测试变绿恢复阻塞关闭；下一步要改为验证关闭后保存与 draft owner 保活、迟到结果不改变重新打开的页面，另验证真实 coordinator 的失败/重试。

仍需核实具体 provider 是否在 dispose 中完成所有资源清理、后台旧 onClosed 的业务删除与新开资源的身份边界，以及批量关闭等后续 UI 意图。此轮不外推为所有资源 owner 都已正确。

## 验证与局限

- 修改前新增 6 个故障用例：文件旧成功/旧失败、旧行触发、筛选旧成功/旧失败、关闭重开。全部能在原实现上失败。
- 修复后相关测试 216/216；UI 测试 121/121；appearance、classic、interaction、async-state、journeys、events、ui-guard 七项检查通过。
- 全量按既有隔离命令运行：248 个测试文件通过、9 个原有失败、0 超时；逐条失败名称和计数与上轮基线一致。此次没有新增/移除测试文件，仅增强已有行为测试。
- 实际主窗口后来已有其他用户标签，未执行 reload；临时预览层使用当前工作区源码副本与真实渲染环境核验，并比较前后标签快照、草稿、主题，均保持一致。因此本轮不能声称主窗口既有控制器实例已热更新。
- 本轮没有新模块或样式文件；事件图和样式检查均无需改动且检查通过。

9 项失败不能成为永久豁免：

1. `input-enhancer-owner.test.mjs`：两项在 `inputEnhancer.js:518` 访问未装配的 document 时失败，尚未测试到目标 owner 行为。需要核实 DOM 依赖契约并改善装配。
2. 六个 `scriptorium-*-electron.test.js`：源码直接使用 Electron app/BrowserWindow，既有隔离脚本却统一用 Node；尚不能据此判断产品失败。需要正确运行入口、隔离窗口与导出产物验证。
3. `ui-helpers-settings-close.test.js`：第三轮已确认 `44fc546c` 主动切换为立即隐藏、后台保存，旧测试仍断言旧 barrier；正在更新行为测试。modalClosePromises 是遗留死状态，可清理。真实保存成功、失败、冲突、重试与 owner 销毁仍需分开验证。
4. `plugin-agent-operation-service.test.cjs`：全量中的单项失败还需诊断。一次额外沙箱诊断触发临时文件 rename EPERM、错误恢复超时，已核实并结束仅由该诊断创建的父/子测试进程；不能把这次环境失败算成产品回归或替代全量结果。

## 全范围覆盖账本与后续路径

Git 清单有 2384 个跟踪文件。按代码扩展名排除常见 vendor/assets 后得到 1457 个候选，仍含部分生成 bundle；清单只用于导航，**不证明这些文件已审查**。后续必须区分手写、生成、第三方和测试资源。

| 范围 | 当前证据 | 仍需完成 |
| --- | --- | --- |
| 参考侧栏实现细节 | 上表列出已读逻辑；DSH occurrence/资源 policy、ZCode request/workspace 边界已落到复现修复 | 继续读完整 state/planner、资源 provider、browser/terminal/subagent、布局/持久化与对应错误路径测试；记录取舍，不能只数文件 |
| 我们的侧栏架构和生命周期 | 挂载 occurrence、picker/计划筛选、跨话题 open/activate、迟到 focus、异步 requestClose/onClosed、关闭与销毁并发、不可关闭标签保护已复现修复 | 具体 provider 的业务清理、注册覆盖/注销、批量关闭与后续意图、还原与后台驻留、动态缓存容量、订阅归属 |
| 聊天和辅助对话 | 尚无本轮深入结论 | 主聊天/辅助对话所有者、流/取消/重试/编辑、草稿、会话与工作区隔离，对照 reference lease/occurrence |
| Git、ProjectForge、源码后端 | 本轮只追到 provider 读取与已有测试 | IPC/preload 契约、读写根目录约束、真实 Git 与回退竞态、并发快照、索引、错误分类、批次缓存、隐藏面板 I/O |
| 主进程、其他服务与 Rust | 清单定位到 IPC/services、chat data/audio/assistant/indexer 等模块 | 主进程资源生命周期、异常恢复与服务装配、Rust 测试与接口、插件/工具调用、升级/打包运行闭包 |
| 测试体系 | 六个有效新故障用例，现有门禁全跑；9 项基线开始定位 | 修复失效装配与运行器、核实断言覆盖、消除随意等待/源码字符串自证、区分单元/真实后端/窗口验证、检查“门禁通过”是否覆盖新分支 |
| UI/UX | 前两轮计划分栏有实际窗口证据；本轮正文错误归属修复 | 全入口、焦点、键盘、读屏、浅/深/磨砂、窄窗口、空/加载/错误/权限/断连、性能与隐藏页面行为；不能仅评估计划页 |
| 可维护性与 AI 可读性 | 此记录包含参考路径、身份约束、故障证据和未覆盖范围；picker 的误导性复制文件头已纠正 | 入口/数据/生命周期图与实际依赖一致性、其余复制文件头、重复真相、隐式全局/魔法 key、生成规则、文档过期、合理模块边界与契约 |
| 完成审计 | 未通过：上表仍有明确未覆盖范围 | 每个要求都需具体当前证据；不能用本轮修复或已有绿灯宣称全工程完成 |

下一轮继续补齐参考的资源、状态和生命周期链，核查异步关闭候选及设置 close/flush 契约，修正测试装配与运行分类。随后沿实际依赖进入聊天、IPC、服务、Rust、独立应用与发布链。检查边界要随证据扩展，不限制在新建的侧栏文件。
