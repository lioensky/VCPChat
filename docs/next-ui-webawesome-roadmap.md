# Next UI 与 Web Awesome 低侵入建设路线

> 状态：历史建设方案。当前 Web Awesome 已固定为 VCPUI 背后的离线可替换内核；真实完成度和后续减法分别见 [`next-ui-current-state.md`](./next-ui-current-state.md) 与 [`next-ui-development-roadmap.md`](./next-ui-development-roadmap.md)。

## 目标

本文记录建设期采用的并行 presentation 策略。该迁移阶段已经结束，当前主窗口只有一套规范 presentation；保护上游业务 DOM、事件、IPC 和聊天数据流的边界继续有效。

Web Awesome 只作为新版界面的基础交互与无障碍内核。业务代码通过 `VCPUI` 使用它，不直接创建 `<wa-*>`、读取 `--wa-*` 或依赖第三方事件。Classic 不因 Next UI 的存在而加载、挂载或增强 Web Awesome 控件。

```text
上游领域逻辑与稳定业务接口
        ├── Classic presentation（上游基线）
        └── Next presentation（独立生命周期）
                    └── VCPUI（项目 API）
                              └── Web Awesome（可替换内核）
```

## 不变量

1. Classic DOM 是兼容基线，不为迁就 Web Awesome 改写结构或事件语义。
2. Next UI 必须挂在明确的 Next root 或 Next surface 内，并能完整 mount/unmount。
3. Next presentation 通过稳定 command、store、IPC 或状态订阅调用业务，不通过 `.click()` 驱动隐藏的 Classic 控件。
4. Web Awesome 只能由 `modules/ui-system/webawesome-adapter.js` 加载；业务模块和通用业务样式不得出现 WA 标签或 Token。
5. 同一次 surface mount 只能选择一个控件内核：Web Awesome 全部就绪后使用 WA；加载失败或挂载已过期时整次使用 native fallback，不允许加载时半途升级。
6. `customElements` 注册在 document 生命周期内不可逆。所谓 teardown 只销毁实例、监听、Observer、主题 owner 和异步意图，不宣称注销组件定义。
7. 所有异步 mount 都携带 generation。Classic → Next → Classic 后，旧 Promise 即使完成也不得修改 DOM。
8. Observer 只能观察所属 surface；禁止为发现设置弹窗或动态控件长期观察整个 document。
9. Web Awesome vendor 固定版本、只读、可重复生成。任何裁剪必须由脚本根据静态 import/CSS URL 依赖闭包完成。

## 当前风险

### P0：加载结果不是原子的

当前 adapter 使用 `Promise.all()` 动态导入多个组件。一个导入失败时，已经执行的模块可能完成 `customElements.define()`，无法回滚。因此“失败后所有标签仍未定义”的旧注释并不成立。

处置：增加 document 级 Runtime 状态机。VCPUI 只在 Runtime 明确进入 `ready` 后采用 WA；`failed` 为本次 document 的终态，已经注册但未获准使用的标签保持不可见实现细节。

### P0：模式切换与异步加载交错

加载期间连续切换 Classic/Next，旧任务可能晚到并重新挂载主题、Observer 或增强控件。

处置：每个 surface 使用 generation token，并在 await 后同时验证 generation、mode 和 host 连接状态。

### P1：上游 DOM 增强范围过大

`VCPUI.enhance()` 和 native proxy 是迁移期兼容机制，不应成为 Next UI 的默认架构。尤其是 Select proxy、Shadow DOM 查询和 native shim 会增加 value、事件与 disabled 状态不同步的可能。

处置：新建 Next surface 使用 `VCPUI.create()`；旧表单只在不能立即抽出稳定设置接口时局部 enhance，且必须有显式 host、销毁测试和 Classic 原样恢复测试。

### P1：全局观察器

观察 document 子树、`class`、`hidden` 和 `aria-hidden` 会被聊天流、弹窗与布局更新频繁唤醒，并让挂载时机依赖无关 DOM 变化。

处置：使用 `modal-visibility-changed`、`ui-mode-changed`、标签 mount/unmount 等显式事件。确需处理动态表单时，只观察表单 host 的 `childList`。

### P2：离线资源过宽

当前 vendored Web Awesome 3.11.0 约 11 MB，除运行组件外还包含 React/SSR/类型声明、技能文档、编辑器元数据和完整翻译。动态 import 避免了全部进入内存，但仓库与安装包仍承担完整体积。

处置：生命周期稳定后再实现可重复的依赖闭包生成，避免同时改变运行语义与资源集合。

## 定制边界

Web Awesome 不做源码 fork。VCPChat 的定制只允许位于：

- `VCPUI` 的组件、属性和事件翻译；
- `webawesome-adapter.js` 的加载、状态、scope 和 teardown；
- `webawesome-adapter.css` 的 VCP Token 与获准 Shadow Parts；
- surface manifest 的组件白名单；
- 中文 locale、键盘、焦点与 reduced-motion 契约。

Token 适配需要覆盖颜色、字体、字号、控件高度、密度、间距、圆角、阴影、层级、动画、focus、disabled、invalid 及深浅主题。自定义 CSS 不得移除组件的 ARIA、焦点环或键盘语义。

## Vendor 精简策略

当前获准核心集合为：

```text
button, card, input, textarea, select, option, checkbox, switch,
tab, tab-panel, tab-group, dialog, tooltip
```

后续生成器以实际 surface manifest 为根，递归解析：

1. 组件入口的静态 JS import；
2. 共享 `chunks/**`；
3. CSS `@import` 和 `url(...)`；
4. 运行所需语言包与图标资源；
5. package metadata、版本和许可证。

React/Svelte/Vue 类型、SSR、技能文档、编辑器元数据、未使用组件和无关翻译可在闭包确认后排除。不得仅凭目录名称手工删除共享 chunk。生成器必须可重复运行，输出 manifest 与文件 hash，并由打包门禁验证所有 import 和资源存在。

## 分阶段实施

### R1：Runtime 收敛

- 单一状态机：`idle → loading → ready | failed`；
- 固定且去重的加载 Promise；
- Runtime 状态和失败原因可观测；
- generation 阻止过期 mount；
- teardown 不再伪装成 custom-elements 卸载。

验收：慢加载、部分失败、重复调用、Next → Classic → Next 均有自动测试。

### R2：Surface 生命周期

- 主窗口删除 document 级激活 Observer；
- 设置、笔记和翻译使用显式 mount/unmount；
- Observer 限定到实际动态 host；
- 一次 mount 内不混用 WA/native 内核。

验收：反复切换不增加监听、Observer、主题 owner 或 WA 实例。

### R3：Classic 隔离

- 盘点并减少 `.click()` 代理和旧 DOM 变形；
- 新界面改用 command/store；
- 全局设置逐步从旧表单增强过渡到独立 Next presentation；
- Classic 截图、DOM 和交互回归成为合并门禁。

### R4：视觉与无障碍定制

- 补齐完整 Token 映射；
- 固定 `zh-CN` locale；
- 验证键盘、焦点、错误、disabled 和 reduced-motion；
- Shadow Parts 覆盖保持最小且集中。

### R5：离线闭包

- 从 surface manifests 生成 vendor 文件树；
- 输出版本、许可证、文件 hash 和组件清单；
- 验证 ASAR 内资源与无网络启动；
- 将组件对照页限制为开发能力，生产包不为其扩大依赖集合。

当前实施结果（2026-08-07）：`@awesome.me/webawesome` 以精确版本 `3.11.0` 固定为 devDependency；`webawesome-runtime-manifest.js` 是浏览器 adapter 与生成器共享的唯一组件清单。生成闭包包含 101 个源文件，内容约 0.46 MiB（文件系统占用约 744 KiB），取代了约 11 MiB、1148 个文件的全量 vendor。`vcp-runtime-manifest.json` 记录版本、locale、组件和逐文件 SHA-256；`vendor:webawesome:check` 验证它可由锁定依赖精确重建，`pack:check` 验证文件 hash、相对 import、CSS URL 和无额外文件。macOS arm64 的 Electron ASAR 已实际生成并解包验证，只包含精简闭包，不包含旧 vendor 树。

## 合并门禁

每一阶段必须同时满足：

- `npm run guard:design-subtraction`；
- `npm run check:ui-system`；
- Web Awesome Runtime 竞态测试；
- Classic 未加载 WA、未生成 WA 控件；
- Electron 主窗口、Notes、Translator 与 Classic 回退冒烟；
- `npm run pack:check`；
- 工作树中不存在业务模块直接使用 WA 的新增引用。

优化必须作为独立、可回滚提交进行。Runtime、surface 生命周期、视觉定制和 vendor 裁剪不能混在同一个提交里。
