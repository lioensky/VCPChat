# Vgame 游戏契约运行时：代码调研与开发路线

日期：2026-10-05  
工程：p561d / Kerr  
状态：开发设计基线，尚未实现；接口与文件布局注明为建议，不代表现有 API。

## 1. 产品决策与范围

Vgame 是人类与 Agent 进行游戏性互动的平台，不是单一游戏插件。
三相架构：
1. Vgame：统一游戏大厅、渲染宿主、人类动作与文本入口。
2. 通用游戏工具插件：正式 VCP ToolCall 的遥控适配器。
3. 群聊 game 模式：会话持久化、请求组织与 Agent 调度的第二后台。

本地游戏服务是对局状态与规则裁决权威；群聊历史是对话持久化真源，二者绑定但不混成一个数组。

首个交付：华山论剑，用户 + 一个 Agent。创建 game 群聊并加入一个 Agent 后，选择游戏并显式开局。
随后：五子棋、斗地主。日式麻将、狼人杀和 Agent vs Agent 后续开发。
调试阶段不接入 JEV，不实施气泡内自然语言 game 标记执行；保留正式工具链，以获得非法动作回执与中央服务器模型续行能力。
后续 JEV 是正式工具调用的语义入口，不替代规则裁决。

斗地主第三座位方案待定：标准玩法需要三座位。不得默认为二人斗地主，亦不得把“加入两个 AI”偷渡为首个二人对局阶段范围。

## 2. 已核实的源码事实

### 2.1 BladeGame

路径：VCPDistributedServer/Plugin/BladeGame/
- plugin-manifest.json：hybridservice + direct；工具 StartGame / PlayTurn；已有 enabled 的 JEV 声明。
- blade-service.js：同时持有规则、game_state.json 文件存档、独立 BrowserWindow 和专用 IPC。
- createInitialState：双方初始生命 5，生命上限 6，能量上限 6，最多 20 回合。
- submitMove：校验招式、开局、结束、重复提交和用户能量；保存 user_input / user_ready。
- PlayTurn：等用户出招后结算；当前无效 AI action 或能量不足会自动改为 Charge，并非严格驳回。
- StartGame：直接覆盖插件目录中的唯一存档，没有 matchId、多局或群聊绑定。
- blade-electron.js：每 250ms 读取整份 game_state.json，每 2 秒读取主题；点击招式即提交，没有文本输入和群聊推进。
- 专用 preload 通过 blade-game:submit-move 等通道调用服务。

结论：现有玩法、规则和表现可迁移；不能原样复用单例存档、全量文件读取、静默改招和插件自建窗口作为通用核心。
全量文件包含 user_input；现有 GUI 与模型请求的黑盒隔离不能等同于已具备全链路能力隔离。

### 2.2 分布式执行

- VCPDistributedServer/VCPDistributedServer.js:613-620 接收 execute_tool。
- 同文件:680-686 将 requestId / _vcpContext 作为 executionContext 传入，与 toolArgs 分开。
- 同文件:859-879 以 tool_result 返回结果或传输错误。
- VCPDistributedServer/Plugin.js:183-207 对 direct hybridservice 调用 processToolCall(toolArgs, executionContext)。
- ChartController/ChartControllerService.js 的 initialize 使用注入 chartService；main.js 有服务注入接缝。

实际本地路径可以使用同进程服务注入，不必人为新增一次 IPC；跨 renderer 的访问仍通过受控 preload / IPC。
“分布式节点—插件—本地服务”是职责链，不等于每条边都跨进程。

中央服务器解析工具、向模型 POST、工具回填续行是本项目依赖的现有平台能力；本轮未读取中央服务器实现或执行端到端测试。
尚未证明 _vcpContext 包含 groupId、topicId、agentId、matchId 或 decisionId；不能把模型自报字段当可信身份。

### 2.3 群聊

- Groupmodules/groupchat.js：两个发言路径共同历史构建；selectGroupContextHistory 只截取窗口，不是按受众授权过滤。
- invitePromptContent 作为最终临时 user 消息加入请求，不显式追加进持久化历史。
- 当前只有 Agent 名称替换，没有 Vgame 观察占位符服务。
- game 未进入 CHAT_MODES / 保存模式白名单。
- appendGroupHistoryMessage 支持 HistoryMutationQueue；自动路径及 redo 等仍有直接 read/writeJson。
- modules/ipc/groupChatHandlers.js 的流输出实际发送 mainWindow 的 vcp-stream-event；旧注释 vcp-group-stream-chunk 不是当前真实通道。
- send-group-chat-message 等待完整处理结束，不是仅接受任务后立即回执。
- preloads/api/groupChat.js roles 为 chat，不能默认 utility 游戏页面拥有这些接口。
- grouprenderer.js:1322 拦截空文本且无附件；提交依赖当前选择与主输入框 DOM，不能直接模拟调用用作 Vgame 后台接口。
- handleInviteAgentToSpeak 的 groupPrompt / watcher 条件块附近缩进及花括号作用域异常（1535-1551）；施工需用测试确认语义，不能只凭缩进移动代码。

### 2.4 应用宿主

modules/services/embeddedAppSessionManager.js 已提供 WebContentsView 创建、复用、隐藏、恢复、关闭与分离。
modules/shared/embeddedAppAllowlist.js 当前未注册 Vgame。
可复用既有应用生命周期；Vgame 内部各游戏渲染器生命周期仍需新增。
本轮猜测的 next-shell/app-registry.js 不存在，不作为施工依据。

## 3. 链路与职责

用户：
游戏界面选择动作 + 可选文本
→ 本地服务校验并保存用户决策
→ 创建持久化推进任务
→ game 群聊追加公开消息
→ 临时邀请展开授权观察
→ VChat 向中央服务器提交请求
→ 中央服务器向模型 POST。

Agent：
模型输出正式 ToolCall
→ 中央服务器解析并路由
→ 本地分布式节点
→ 通用游戏插件
→ 本地游戏服务 / 规则器
→ 工具回执返回中央服务器
→ 中央服务器将结果交回模型并继续生成
→ 流式内容或非流式终稿返回 VChat。

规则事件：
状态提交成功
→ 按受众生成视图及事件
→ Vgame 渲染；公开结果同步群聊。
不得在 DOM 渲染、历史回放时重新执行动作。

## 4. 华山论剑最小推进契约

用户具体招式只保存在本地待结算状态。
有文本时发送：
    来吧，这次看你怎么接！
    [GameStatue:用户已出招]
没有文本时只发送：
    [GameStatue:用户已出招]

保留 GameStatue 拼写。通知不得包含招式、能量消耗或可推断选择的自动附加字段。
文本是用户主动交流，不能保证用户自己不透露招式；框架不得自动泄露。

主输入入口和 Vgame 输入入口均调用后台提交服务，不模拟主窗口按键或读取当前 DOM 选择。
按钮点击先选择动作，由提交按钮同时确认动作与文本；具体 UX 可讨论，但不得在动作尚未保存时发起模型请求。
标记由后台根据真实提交生成，用户手打相同文本不能改变游戏事实。

一次提交只追加一条公开消息、启动一次响应。正常阶段一局至多一个活跃决策请求。
保存失败不广播；请求失败保留已保存选择，通过原提交任务继续，不重新选择或重复落盘。
关游戏窗口不结束对局。普通文字交流是否邀请 Agent 由 game 模式明确区分，不伪造“已出招”。

## 5. 三相契约（拟新增）

共同标识：
gameTypeId、rulesVersion、matchId、groupId、topicId、seatId、decisionId、revision、submissionId。
身份来自受控窗口或可信请求绑定；参数仅用于寻址，不提供授权。

### 前端—本地服务
建议入口：
- listGames / createMatch / resumeMatch
- getObservation / subscribeMatch
- submitHumanTurn：动作 + 可选文本 + 提交 ID + 决策绑定
- getSubmissionStatus / continueSubmission

### 插件—本地服务
插件暂名 GameController，正式名称施工时确定。
建议工具：GetObservation、SubmitAction。
开局管理可扩展，但不得默认任意 Agent 能覆盖已有对局。
各游戏注册参数校验与动作解释，调试期使用严格原生字段，不强迫所有游戏用任意大 JSON 参数。
服务返回受众限定结果，插件不持有第二份状态，不直接创建每个游戏窗口。

规则拒绝建议返回业务结果：
accepted=false、code、message、decisionId、revision。
业务拒绝不同于传输异常；采用 content 文本回执或传输 error 的中央续行行为必须实测确认。
无效招式、能量不足、落点占用、出牌不足以压过上家都不得自动换招。
驳回不改变手牌、局面、阶段；允许模型在同一窗口修正。重试次数 / 时间有上限。

### 群聊—本地服务
game 模式负责公开历史与邀请调度，不自行修改规则状态。
临时邀请建议使用 {{VGameObservation}} / {{VGameDecision}}，名称尚未实现。
展开时按 match / seat / decision 获取观察，禁止先取全量状态再要求模型忽略。
人格 systemprompt 保持稳定；动态状态优先放临时邀请。
扩展 options / 服务提供器优于复制现有请求大函数。

## 6. 持久化与可靠性

建议用户数据中保存独立 games/<matchId>/ 对局存档，具体根路径由现有 appData 路径服务注入。
含规则版本、座位绑定、revision、待结算动作、已提交动作去重记录和推进任务状态。
共享聊天历史通过 HistoryMutationQueue；game 路径禁止混用旧快照整体覆盖。
本地按局串行提交；原子写入或事务保证完整存档。跨网络不宣称大事务：
用户动作已接受 → 公开消息待追加 → 请求待启动 / 活跃 / 完成 / 失败。
持久化可重试任务，以 submissionId / messageId 去重，恢复时先查询提交结果。
工具动作已提交但回执丢失后再次调用，应返回原结果，不能执行第二次；requestId 与语义 actionId 的关系需定义。
历史损坏不能像普通群聊一样静默当作新空局。
普通删除 / redo 不得回滚已生效游戏动作；需要单独规定禁用或分支处理。
状态回退不能撤销参与者已经看到的秘密。

## 7. 信息机制按游戏需求分层

华山论剑：共同已结算历史 + 私有待揭示动作；双方动作收齐前不泄露。
五子棋：公共棋盘 + 单座位行动窗口。
斗地主：共同公开历史 + 邀请内自己的手牌 + 私有工具回执。
“不要使用 ink”不是最终安全机制；需要平台或入口保证私有回包不落入共同历史，且工具记录查询遵循权限。
日式麻将：新增多人响应优先级、振听等私人规则状态，不按请求返回速度裁决。
狼人杀：新增身份策略、私有 / 队伍频道及观察历史编排，本期不实现。

私有内容不应出现在窗口全量状态、日志、标题摘要、通知或公共工具 details 中。
邀请不入群聊数组不意味着中央日志自动私密；此项需联调。
第一期默认非流式策略可用于简化调试，但流式 / 非流式均依赖中央工具续行；不建本地伪模型循环。

## 8. 建议目录与接入点

拟新增：
- Gamemodules/：大厅、宿主、公共输入与各游戏 renderer。
- modules/services/gameService.js：对局门面。
- modules/game/：注册表、存档、授权观察、动作提交、规则包。
- modules/ipc/gameHandlers.js、preloads/api/game.js。
- Groupmodules/modes/gameMode.js 或独立 gameSessionOrchestrator。
- VCPDistributedServer/Plugin/GameController/：薄工具适配器。

需修改：
main.js 服务创建与注入；群聊配置规范化与模式白名单；群聊邀请展开和写入权威；群聊设置 UI；preload 角色与 IPC 身份验证；应用启动入口和内嵌白名单。
是否独立窗口或内嵌呈现复用既有宿主规范，不由各规则插件决定。
Renderer 统一 mount / update / dispose，释放计时器、订阅、ResizeObserver、Pixi 与音频资源。

## 9. 分阶段路线

M0 契约验证：
确认可信请求字段和绑定传播；测试中央驳回续行；确认私有回包与 ink 策略；确认实际服务初始化注入。
阻塞项不通过，不宣布多局与暗牌安全已完成。

M1 华山论剑：
提取规则、修复静默换招、建立 match 存档、插件薄适配、Vgame 大厅和宿主、game 群聊、动作+文本提交及恢复。
迁移现有视觉表现，旧插件可短期兼容适配；不允许新旧服务同时写同一局。

M2 五子棋：
明确棋盘尺寸、坐标与胜负规则版本；同一核心支持落子校验、顺序邀请。
无需新增独立窗口或复制群聊请求循环。

M3 斗地主：
注册用户 + 两位 Agent 子分支，强制恰好两位有效 Agent 群友；扩展按座位及规则轮次的多 Agent 调度。实现发牌、叫牌、出牌、牌型比较、胜负及座位观察。
以真实工具回包验证手牌隔离，不仅检查前端展示。

后续：JEV 语义注册、Agent vs Agent、日式麻将、狼人杀。

## 10. 验收与测试

- 创建 game 群聊，一位 Agent，完整游戏不需切回主窗口。
- 有文本 / 空文本都能推进；真实通知只在动作接受后生成。
- 主界面与游戏入口共享后台；切话题不串局。
- 双击、网络重试、工具回执丢失不重复动作、消息或响应。
- AI 无效招式 / 气力不足：状态不变，中央回填驳回后模型成功修正。
- 模型结束但未提交动作：保留决策待完成状态，不假装成功。
- 超时 / 中止后迟到工具请求受决策绑定约束；恢复不重复结算。
- 两个仅在用户未揭示招式上不同的局，在 AI 出招前产生相同授权观察。
- 私有手牌不进入公共历史、工具详情、通知、摘要及其他座位观察。
- 两局并行不串状态；同 Agent 不因按姓名寻址串局。
- 重开窗口 / 重启恢复待决策与已提交结果；演出完成不是规则提交条件。
- 历史加载不执行工具，关闭宿主资源归零，群聊原模式不回归。
- 端到端分别覆盖流式和非流式工具续行。

## 11. 尚待确认的事项

1. 中央请求—execute_tool 链是否传播足够的可信会话和决策绑定；缺失时需扩展，不能按模型姓名猜。
2. 中央对业务驳回、传输 error、重试上限的具体行为。
3. 私有工具结果、ink、调用记录查询及日志权限。
4. 斗地主第三座位策略。
5. game 群聊成员修改、话题删除、对局退出和开新局的生命周期规则。

本轮仅调研与文档写入，无运行代码改动、无端到端可行性测试。现有华山论剑实验提供路径依据，不替代通用框架的验收。
