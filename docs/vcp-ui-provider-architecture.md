# VCPUI Provider 架构

> 状态：当前权威 UI Provider 决策<br>
> 日期：2026-08-17<br>
> 当前实现事实：[`next-ui-current-state.md`](./next-ui-current-state.md)<br>
> 施工顺序：[`next-ui-development-roadmap.md`](./next-ui-development-roadmap.md)
> 长期拆分路线：[`vcp-ui-long-term-roadmap.md`](./vcp-ui-long-term-roadmap.md)

## 1. 决策

VCPChat 不引入 React、Vue、Solid 等应用框架，也不把 Web Awesome 当作页面框架。产品保留上游业务 DOM、manager、IPC 和表单状态；VCPUI 是产品级稳定接口，原生 DOM 与 Web Awesome 都只是可替换 Provider。

```text
上游业务 DOM / manager / IPC（业务真相）
                 │
                 ▼
       VCPUI controller / pattern（产品合同）
                 │
        ┌────────┼────────┐
        ▼        ▼        ▼
   Native DOM  Web Awesome  VCP-owned DOM pattern
                 │
             Lit / Shadow DOM（第三方内部实现）
```

Web Awesome 3.11.0 内部使用 Lit 和 Shadow DOM。这不等于 VCPChat 采用 Lit 应用框架，但意味着 WA 实例拥有自己的渲染时序、Shadow DOM 和不可撤销的 custom element 注册，因此必须隔离在 Provider/adapter 后面。

## 2. 为什么不是全量 WA 或全量原生

- 全量 WA 会迫使既有表单节点、事件和 option 集合经过代理；Shadow DOM 也会放大初始化、焦点和销毁竞态。
- 全量原生能最大程度保留业务语义，但普通 Chromium Select 的视觉定制能力有限。
- 自研完整 Select/Listbox 要重新承担键盘、焦点、读屏、定位、滚动和平台差异，成本接近维护一个独立组件库。
- 因此 Provider 按控件所有权和复杂度选择，业务只依赖 VCPUI controller，不直接依赖 `<wa-*>`。

该结构与 VS Code 的 Select delegate 接近：稳定控件合同背后允许 native/custom implementation。DeepSeek Harness 和 OpenCode 虽使用框架，但同样把视觉 primitive、主题、扩展槽、业务 runtime 和生命周期分层。GOV.UK Accessible Autocomplete 与 Choices.js 则证明，增强旧 Select 时应保留原节点为业务真相，并让新增控件作为可销毁的同级 presentation，而不是伪装成原节点的内部 DOM。

## 3. 不变量

1. 上游业务节点、值、option、表单提交和业务事件仍是唯一真相。
2. Provider 在一个 controller mount 时只选择一次；WA 迟到注册不得原地替换 DOM。
3. 改 Provider 必须显式销毁并由所属 Surface 重新挂载。
4. 业务模块不得创建 `<wa-*>`、访问 WA Shadow DOM 或依赖 `--wa-*`。
5. WA 加载失败后，本 document 稳定降级为 native，不形成半 WA/半 native 的同一 Surface。
6. 增强既有节点时，destroy 必须恢复原 hidden、ARIA、tabindex、class、property 和焦点行为。
7. 不用 detached shim 或 monkey-patched `querySelector()` 伪造 Select 的 native 内部节点。
8. Observer 只能归属具体 host/controller，并在 destroy 时断开。
9. Provider 选择不能由测试专用全局状态控制；测试读取只读 decision/diagnostics。
10. 插件 Loader、动态壁纸和结构化消息业务组件不属于 VCPUI Provider 改造范围。

## 4. Select Provider 合同

`select-provider.js` 只负责纯决策，不挂载 DOM。输入在 mount 开始时形成快照：

- `ownership`: `existing | owned`
- `requested`: `auto | native | customizable-native | webawesome`
- `webAwesomeReady`: 当前 document 的确定性 Runtime 状态
- `customizableNative`: Chromium 能力检测结果

输出是冻结的 decision：`provider`、`reason`、能力快照和输入。当前 Provider：

| Provider | 使用位置 | 业务真相 | 当前状态 |
|---|---|---|---|
| `native` | 上游设置表单、WA 失败回退 | 原 `<select>` | 生产使用 |
| `webawesome-proxy` | 必须美化的既有 Next Select | 原 `<select>`；WA 是同级视图 | 生产使用，需继续减债 |
| `webawesome-owned` | Creation、组件库等 VCPUI 新建 Surface | controller | 生产使用 |
| `customizable-native` | Chromium `base-select` 候选 | 原 `<select>` | 只完成能力门，不默认启用 |

当前 `auto` 规则保持既有视觉行为：WA 已 ready 时，既有节点选择 proxy、VCPUI-owned 节点选择 owned WA；否则选择 native。Customizable Native 必须经过 macOS、Windows 真实 Electron 视觉、键盘和主题验收后，才能单独改变默认规则。

## 5. 组件选择矩阵

| 组件 | 首选实现 | 理由 |
|---|---|---|
| Button、Input、Textarea、Range、Switch | 既有稳定实现，逐项评估 native | 不为统一而同时改语义与视觉 |
| 简单既有 Select | native；验证后可选 customizable native | 最大限度保留节点身份与表单语义 |
| Next-owned 复杂 Select | Web Awesome | 需要稳定 listbox、键盘和定位能力 |
| 旧 Select 且明确要求复杂视觉 | 显式 sibling WA proxy | 原节点仍是 business truth |
| Card、List、Toolbar、SettingsSection | VCP-owned DOM pattern | 不需要第三方行为内核 |
| Dialog、Popover、Menu | 分别比较 platform API 与 WA | 必须按焦点、关闭和 overlay 所有权决策 |

## 6. 生命周期

每个 Provider controller 必须由所属 `LifecycleScope` 或 `SurfaceController` 持有。完整状态为：

```text
unmounted → decision frozen → mounting → mounted → disposing → disposed
                         └──── failure ────┘
```

- mounting 失败原子回滚；不暴露半初始化 controller。
- dispose 幂等，并等待已经开始的异步释放。
- 请求、listener、MutationObserver、弹层、WA proxy 和临时 property descriptor 都由同一 controller 释放。
- 迟到的 runtime、option 或异步结果必须检查 generation/owner 后才能提交。

## 7. 当前技术债与迁移顺序

`vcp-ui.js` 已从约 2,380 行降到约 2,200 行，Select policy 与 WA sibling proxy 分别进入 `select-provider.js` 和 `select-webawesome-proxy.js`；facade 只负责做 Provider 决策并注入共享 controller 能力。主文件仍混合其他 factory、feedback、pattern 和兼容层，后续继续按组件域拆分。当前 Select proxy 保留了对原节点 `value/selectedIndex/add/remove/focus` 的临时 property bridge，以兼容“直接赋值但不发事件”的旧调用；这比修改 `querySelector()` 更窄，但仍是待消除债务。

执行顺序：

1. 建立纯 Select decision 模块、不可变 Provider 契约和能力测试。
2. 删除 VCPUI-owned Select 的 detached native shim 与 `querySelector()` monkey patch；消费者只使用 controller contract。
3. 在真实 Electron 中覆盖普通枚举、大模型列表、动态 option/value、键盘、焦点、主题与反复 mount/destroy。
4. 逐个盘点旧 Select 写入点，改为真实 DOM operation + 事件或 controller API，再删除 property bridge。
5. 验证 Customizable Native；只有跨 macOS/Windows 达标才调整简单 Select 默认 Provider。
6. 按 Select → feedback → form controls → patterns 的顺序把实现移出 `vcp-ui.js`，该文件最终只保留 facade/registry。

不得在一次提交中同时改变 Provider、视觉 token、业务 DOM 和 vendor closure。

## 8. 验证矩阵

每个 Provider 变更至少验证：

- 原节点/Controller 的 value、options、selectedIndex、disabled、required 和 validity。
- `input`/`change` 顺序且每次用户操作只派发一次。
- label click、Tab、方向键、Enter、Escape、读屏名称和焦点恢复。
- 大 option 集合、动态增删、程序赋值、表单 reset 和节点移动。
- 明暗主题、缩放、最小窗口、Windows/macOS。
- WA load failure、mount 中止、destroy 重入和迟到结果。
- 反复 mount/destroy 后 detached DOM/options、listener、Scope 和 heap 不增长。

自动门禁继续使用 UI System、Electron UI Apps、主聊天操作序列、生命周期压力、pack check 和 diff check；视觉是否可接受不能只由 jsdom 单测代替。

## 9. 完成定义

本阶段完成不等于“所有控件改成同一种技术”。完成意味着：

- Provider 选择有唯一纯决策入口且 mount 后不可变。
- Web Awesome 是私有 implementation detail，而不是业务 DOM API。
- Select 不再依赖 detached shim/querySelector monkey patch。
- 现有上游表单、Next-owned Surface 和 WA 失败回退均有真实 Electron 证据。
- 文档、consumer gate 和实现对 Provider 边界使用同一描述。

## 10. 2026-08-17 第一阶段证据

第一阶段已完成：纯 decision 模块、独立 WA proxy Provider、不可变 mount 选择、VCPUI-owned Select shim 删除、显式 Customizable Native 能力门和自动测试均已落地。macOS Electron 41 / Chromium 146 实测支持 `base-select` 与 `::picker(select)`；普通枚举、250 项模型列表、动态 value/options、单次 input/change、固定 Native、WA proxy 销毁恢复和 Customizable Native 样式均通过。

完整 UI System 为 84/84（含 proxy 半挂载原子回滚故障注入），Electron UI Apps 为 22/22，24 步主聊天序列通过；生命周期压力在 3 次预热和 20 次测量后保持 861 listener、8 Scope、162 受管资源、5 process，detached root/icon/option 均为 0。Windows 的 Customizable Native 视觉与键盘证据仍待补，因此它继续保持显式实验 Provider，不进入 `auto`。
