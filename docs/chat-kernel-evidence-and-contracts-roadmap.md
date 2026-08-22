# Chat Kernel 证据与契约自动化增强路线

更新日期：2026-08-21。本文是 D0-D7 之后的工程化增强路线，不改变当前 D0-D7 的完成判定，也不把缺失的跨 Windows、打包、GPU/DPI 和人工 soak 证据隐含地视为已完成。

## 目的与范围

本路线把 DeepSeek Harness 的六类可验证性原则应用到 VCPChat：真实 producer/consumer graph、运行关系 invariant、真实 runner 的 invalid-case 回归、source/artifact plane 分离、built-artifact smoke，以及用户可见 transcript snapshot。

目标不是把 VCPChat 改造成 Cordis，也不是重新拆 Chat Kernel。目标是让每条架构声明都有机器可执行的证据，并且让门禁在回流发生时主动变红。

范围内：Chat Kernel、renderer composition、Surface capability、preload 事件、durable chat history、Electron 入口、Next/Classic/插件协议及其测试和文档。

范围外：新的 UI 视觉设计、安装器功能、用户主题数据、`audio_engine/AppData/`、D7 所需但当前机器无法提供的外部 Windows/GPU 环境。

## 设计原则

- 事实、能力、消费者和生命周期各有唯一 owner；报告引用源码和真实运行证据，不以测试数量替代责任证据。
- producer/consumer 图由源码生成；手工登记只补充公共协议、动态入口和退役条件，不能覆盖自动发现结果。
- invariant 必须观察真实事件、持久数据或生命周期计数；服务存在、方法存在、固定纯值和测试替身不能充当运行关系。
- 每个 invalid-case gate 必须先证明规则会被故意破坏而失败，再恢复实现并保留永久回归测试。
- source plane 测试源码路径；artifact plane 通过构建产物、bin、Electron 或子进程验证发布路径；两者不能静默混用。
- 用户可见或模型可见的非平凡变化必须有可重放 snapshot，且 snapshot 通过真实组装入口生成或消费。
- 所有异步 owner 都要满足 quiescent dispose：失效 generation/abort、撤销 producer、等待 in-flight task 和持久队列，再清理 projection。

## 目标证据模型

新增统一的 `docs/contracts/` 目录（实现阶段创建），每项记录使用稳定 `id`，至少包含：

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定契约标识，跨重命名保持不变 |
| `kind` | `event`、`capability`、`facade`、`invariant`、`snapshot`、`artifact-smoke` |
| `owner` | 唯一源码 owner 和生命周期 owner |
| `producer` / `consumers` | 源码位置、运行 surface、是否 durable |
| `mode` | `emit`、`waterfall`、`serial`、`parallel` 或 `command` |
| `terminal` | terminal 类型、单 terminal 规则、迟到/丢弃规则 |
| `sourceEntry` / `artifactEntry` | 源码入口和发布/构建入口 |
| `invalidCase` | 可故意触发的非法状态及预期失败点 |
| `snapshot` | snapshot fixture、归一化规则和审阅 owner |
| `evidence` | 命令、提交、环境、产物和时间戳 |
| `retirement` | facade 或兼容路径的退役条件；永久保留则说明理由 |

报告分为机器生成部分和人工批准部分。机器部分每次从源码重建；人工部分只保存决策，不复制源码事实。

## 路线阶段

### E0：基线和证据协议冻结

建立 `docs/contracts/README.md`、JSON schema、artifact 命名规则和证据状态：`pass`、`fail`、`skipped`、`manual_required`、`not_applicable`。把当前 `chat-kernel-consumer-report.json`、UI journey matrix、async state matrix 和 D7 审计中的现有证据映射到稳定契约 id。

退出条件：schema 校验器能拒绝缺 owner、缺 producer/consumer、缺 terminal 规则或把 `skipped` 当 `pass` 的记录；当前报告可无损转换；不修改产品行为。

### E1：真实 producer/consumer graph

新增 `scripts/build-chat-event-graph.mjs`，扫描 preload producer、`CustomEvent`/IPC dispatch、stream coordinator/session、consumer registry、surface adapters 和明确订阅调用，输出 `docs/contracts/generated/chat-event-graph.json` 与 Mermaid/Markdown 投影。

图节点至少区分：durable fact、transient stream event、DOM projection、compatibility facade。边记录源码行、订阅 disposer、conversation/operation identity 和 terminal route。无法静态解析的动态事件必须进入 `undiscovered` 清单并阻止“图完整”声明，而不是被 allowlist 静默吞掉。

退出条件：

- 所有 D0-D6 关键事件都有 producer、consumer、owner 和 disposer；
- 生产者自证、测试-only consumer 和零消费者事件分别报告；
- `undiscovered` 只有有明确协议 owner 的少量条目，并逐项登记；
- 引入一个未登记 producer 或 consumer 会使 gate 失败。

### E2：统一事件 terminal schema

定义 `modules/chat/chatEventContract.js`（或等价的纯模块）及 JSON schema，描述事件名、payload 版本、mode、durability、顺序、terminal、取消、迟到结果和错误归属。`StreamSession`、`StreamCoordinator`、VCP bridge、non-streaming consumer 和 facade command 逐步迁移到同一 vocabulary。

先覆盖聊天内核事件，不要求一次性改造所有历史 DOM 事件。旧事件通过显式 adapter 声明 `legacy: true`、owner 和迁移截止条件。

退出条件：每个 stream terminal 只能通过 schema 允许的路径提交；重复 terminal、错误 generation、未知 terminal/payload 版本和 dispose 后事件在 unit 与真实 Electron runner 中均被拒绝或丢弃；只有调用方明确提供兼容 fallback 时才允许保留旧 transport 值；错误结果、取消结果和 consumer defect 的公开语义可区分。

### E3：运行关系 invariant 与 deliberate invalid runner

新增 `scripts/run-chat-contract-invariants.mjs` 和测试 fixtures，覆盖：

- 一个 operation 只能有一个 terminal；
- terminal persistence 只能由唯一 authority 提交；
- 新 conversation identity 不接收旧 operation 的 chunk；
- disposed Surface 不再产生 DOM、通知或持久化副作用；
- facade 必须冻结、不可替换，并由登记 owner 发布；
- listener/resource/detached-root 计数在重复 mount/dispose 后回到基线；
- durable history 与 projection 的成功点和失败点一致。

每条 invariant 配套一个真实 runner 的 invalid case：通过 fixture 或受控测试 seam 注入重复 terminal、错误 identity、缺 disposer、可变 facade 或错误 build import，必须在预期 gate 失败。invalid-case 不能只调用被测函数后检查返回值，必须检查外部 DOM、持久文件、事件计数、进程退出码或 artifact 内容。

退出条件：每条规则都有“故意破坏为红、恢复为绿”的记录；invalid runner 不依赖生产环境秘密，不改变用户数据；invariant 报告分别显示 `timedOut`、`signal`、`exitCode` 和断言失败。

### E4：facade owner registry 和回流门禁

把 `scripts/check-chat-kernel-consumers.mjs` 的 facade ledger 与 `docs/contracts/chat-contracts.json` 的 `kind=facade` 登记对齐为 schema-backed registry：每个 facade 记录定义者、唯一 owner、生产消费者、公共方法、冻结性、动态 smoke、退役条件和兼容版本；gate 必须验证登记 owner 与 consumer report 的源码定义一致。

新增负向测试：尝试替换冻结 facade、由非 owner 发布同名 facade、增加未登记 `window.*` 业务读取、删除最后一个真实消费者、或让 facade 持有第二份状态时，gate 必须失败。保留 facade 只能是窄命令或只读 projection；新内部功能不得直接依赖它。

退出条件：所有直接 `window.*` 发布点出现在 registry；生产消费者和测试消费者分开；provider 不能自证；零生产消费者的 facade 要么删除，要么明确标记 `retirement-blocked` 并有真实 owner 决策。

### E5：source/artifact plane 与 built smoke

定义两套明确入口：

- source plane：Node test、静态 gate、源码模块导入，统一从 `modules/`/`scripts/` 读取；
- artifact plane：构建后 Electron、CLI/bin、子进程和打包目录，只读取 `dist/`/`lib/`/安装布局中的文件。packaged smoke 拒绝把 workspace source root 当作 packaged root，并要求独立的 `resources/app/main.js`；当前仍只完成 unpacked 文件树检查，不等价于 packaged runtime 启动。

新增 `scripts/check-artifact-plane.mjs`，检查测试命令是否错误地从旧 `node_modules`、源码路径或 stale build 读取；新增最小 built smokes：

- 构建后的主聊天 composition boot；
- 构建后的 stream terminal/persistence replay；
- 构建后的 Next/Classic 页面入口；
- packaged/unpacked Electron 中的 embedded app security 和 crash/reload（当前脚本只完成 unpacked artifact 文件树/Web Awesome smoke，真实 Electron 启动与 crash/reload 仍是未闭合证据）；
- 缺失配置、错误导出、错误协议版本必须以非零退出并产生可定位诊断。

退出条件：干净 checkout 删除旧 build 后，source gate 和 artifact smoke 都能独立运行；构建产物缺失或错误导出不会被 source loader 掩盖；CI artifact smoke 保存 commit、Node/Electron 版本、入口、退出码和 stderr。

### E6：chat-visible/model-visible transcript snapshot

新增真实组装入口驱动的 snapshot harness。第一批覆盖：发送消息、流式 chunk/terminal、取消/错误、历史切换、附件、主题/设置投影、通知/desktop push、Classic 页面和插件命令协议。snapshot 分三层：

1. durable transcript：持久 history/event 记录；
2. projection transcript：DOM/ARIA/focus/notification 语义快照；
3. wire transcript：IPC/preload/plugin 命令和 terminal 次序。

当前 stream fixtures 同时锁定 `modelVisible` 和 `chatVisible` 两层，再与 durable、projection、wire transcript 对照。归一化只处理随机 id、时间和平台路径；不得删除顺序、状态、错误归属、ARIA 或资源计数。fixture 必须可在 Linux/macOS replay；Windows/Electron 特有结果单独标记平台字段。

退出条件：每个非平凡用户可见或模型可见改动在 PR 中新增/更新 snapshot；snapshot 通过真实 composition 或 Electron runner 生成；review 能看到语义 diff；录制和 replay 命令分离，CI 只 replay 不写 fixture。

### E7：统一 CI gate、报告和发布证据

把上述步骤组合为：

```text
npm run check:chat-contracts
  ├─ schema + generated graph freshness
  ├─ facade owner/consumer gate
  ├─ invalid-case runner
  ├─ source-plane tests
  ├─ artifact-plane built smokes
  ├─ transcript snapshot replay
  └─ evidence manifest validation
```

发布环境使用 `npm run check:chat-release-evidence`。该入口复用同一 manifest，但强制要求主聊天、UI Apps、packaged artifact、Windows matrix 和 manual soak 五类证据均为 `passed`；开发期 `npm run check:chat-evidence` 允许明确的 `skipped/manual_required`，两者不能混用。

CI 必须把 `fail` 与 `manual_required/skipped` 分开；任何未解释的 skipped 不能使 D7 或发布 gate 变绿。每次运行保存 machine-readable evidence manifest，并在 PR summary 显示变更契约、图差异、snapshot diff、artifact 版本和缺失平台。强制设置 `VCPCHAT_REAL_ELECTRON_STATUS=pass` 也不能覆盖已提供的 packaged artifact 失败或 Windows matrix 失败/跳过。

退出条件：干净 checkout、PR、Windows 主机和打包产物都能生成同一 schema 的证据；CI 同时上传 manifest、packaged smoke evidence 与 contracts/graph/transcript evidence bundle；Windows matrix 和 manual-soak JSON 可被 manifest 校验并保留 `fail_or_skipped`/`manual_observation_required` 语义；报告可以反查源码行、测试、artifact 和审阅决策；故意引入 producer 回流、错误 terminal 或 stale artifact 时 CI 确实失败。

## 推荐实施顺序

1. E0 schema/命名/manifest（只加文档和验证器）。
2. E1 graph 生成，先消费现有 `chat-kernel-consumer-report`，不改业务事件。
3. E4 facade registry，与现有静态门禁合并，优先防回流。
4. E2 terminal schema，先覆盖 StreamSession/Coordinator 和 VCP bridge。
5. E3 invalid runner 与 lifecycle invariant。
6. E5 artifact plane/built smoke，修复 CI 的 `npm ci`、Electron runtime 和 stale build 风险。
7. E6 transcript snapshots，优先主聊天和 stream，再扩展 UI Apps/Classic/插件。
8. E7 统一 gate 和 PR evidence summary。

顺序理由：先建立事实模型和防回流，再约束运行协议；先让 invalid case 能变红，再扩大 snapshot 和 artifact 覆盖，避免生成大量无法解释的历史 fixture。

## 证据与失败处理

- 所有产物写入 `artifacts/contracts/<run-id>/`，不提交临时日志、用户主题或音频数据。
- 超时、进程信号、非零退出、断言失败和测试基础设施故障分别记录；重试不能把产品失败改写成通过。
- 平台未提供时使用 `manual_required` 或 `skipped`，并记录原因、命令和替代证据；不得用 Linux 结果外推 Windows/GPU/DPI 结论。
- 任何新兼容桥必须登记 owner、消费者、退役条件和删除前置证据；没有这些信息就阻止合入。

## 与当前 D0-D7 的关系

E0-E4 可以在当前 PR 之后独立推进，不改变 D5/D6 已有结论。E5-E6 是提升发布信心的工程化工作，但不能替代 D7 的多环境和人工 soak。只有 E7 统一 gate、声明支持的环境证据和人工 checklist 都齐全后，才可以把“架构声明有自动化证据”作为发布级能力，而不是仅作为开发者本地工具。

## 首个增量 PR 的完成标准

首个实现切片已从 E0+E1 扩展为 E0-E7 自动化框架与门禁：schema、graph、terminal vocabulary、runtime invariant、deliberate invalid runner、artifact/source plane、built smoke、transcript snapshot、CI gate 和 machine-readable manifest 均已落地。正向 packaged filesystem smoke 已接入 gate 并写出 `kind=unpacked-packaged-artifact-filesystem-smoke` 证据，但没有 `VCPCHAT_PACKAGED_ROOT` 时只能报告 `skipped`；真实 packaged Electron 启动/crash-reload、跨平台发布矩阵、稳定的多轮 Electron 重跑、成功的 packaged native rebuild 和人工 soak 仍属于 D7 未闭合证据，不能用自动 gate 或单次成功替代它们。

## 当前施工状态

2026-08-21：E0-E7 自动化框架与门禁已实现；当前 graph 扫描 268 个生产源码文件、191 个事件节点，1 个动态事件点已通过 contract `dynamicSites` 登记，未登记动态点为 0；E2 已为 StreamSession/Coordinator 建立第一版 terminal vocabulary；E3 已有 terminal、facade registry、missing-runtime 和 packaged-root 四类真实 invalid runner；E4 已接入 schema-backed facade owner/消费者校验；E5 已加入 Electron runtime/source-entry、Rust built-artifact `--help` 和外部 unpacked packaged-root filesystem smoke；E6 已加入 modelVisible/chatVisible 与 completed/cancelled/failed/discarded durable/projection/wire transcript replay；E7 的统一 CI evidence gate、正向 packaged smoke（无输入时显式 skipped）、manifest 路径校验、release evidence gate 和 manifest invalid-case 测试已接入 `chat_kernel_ui.yml`。真实 packaged runtime、完整跨平台 artifact 归档、成功的 packaged native rebuild、更多 Electron transcript 和发布环境证据仍待后续增量补齐。

本机真实 Electron 证据在修正过时的 Web Awesome fallback 断言后，当前工作树 Windows matrix `artifacts/windows-matrix/2026-08-21T18-36-55-200Z.json` 六行全部通过，包含 60-cycle lifecycle；30 分钟 manual-soak 观察已生成 `artifacts/manual-soak/2026-08-21T18-43-55-291Z.json`，30 个采样保持 renderer errors 为空、detached roots 为 0，但 checklist 尚未由操作员填写，stderr 仍有受控 bad-port/degraded 配置提示，因此状态保持 `manual_observation_required`。临时 Electron unpacked package 构建记录在 `artifacts/packaged/2026-08-21T19-21-58-000Z.json`，因 `electron-edge-js` MSBuild exit 1 未生成产物，packaged 状态保持 `failed`。主聊天 sequence 最近一次通过 24 actions / 25 requests，且 owner focused contract 已覆盖 `aria-busy` 投影，但历史重跑仍出现 `Runtime.callFunctionOn`/残留进程树问题。因此真实 Electron 单项仍标记为 `manual_required`，不把一次成功或单机矩阵外推为跨环境稳定 PASS。manifest 默认保留未闭合项，只有显式设置 `VCPCHAT_REAL_ELECTRON_STATUS=pass` 才会报告为通过。
