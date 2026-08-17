# App Surface 统一视觉层

六个业务子页面（Notes、Translator、Plugin Manager、Forum、Memo、Log）共享的纯视觉基座。
本目录只做 CSS：不改业务 DOM 结构语义、不引入 JS 运行时、不触碰 IPC 与数据流。

## 为什么不在 styles/ui-system/

`styles/ui-system/**` 被 `scripts/check-ui-system.mjs` 强制约束为 Next Shell 专属
（所有选择器必须含 `.vcp-ui-scope`），且 `docs/ui-active-surface-policy.md` 要求业务子页面
保持 upstream Classic、不消费 Next 运行时（"0 active rebuilt"）。App Surface 视觉层是
Classic 页面内部的共享样式，因此放在平级目录，避免污染 Next 设计系统边界。

## 启用方式（opt-in）

页面 `<link rel="stylesheet" href="../styles/app-surfaces/app-surfaces.css">`，
并给 `<body>` 加 `vcp-app-surface` 类。未加类的页面完全不受影响。

## Cascade layers

```
@layer vcp.tokens, vcp.surface, vcp.components, vcp.page, vcp.overrides;
```

- `vcp.tokens`：颜色桥接（复用 `styles/themes.css` 旧主题变量，明暗/18 套主题自动生效）与布局合同。
- `vcp.surface`：Shell 骨架（Header / Toolbar / Content / Footer、滚动区、焦点）。
- `vcp.components`：按钮、输入、列表、卡片、徽标、空态/加载态/错误态、Skeleton。
- `vcp.page`：页面专属样式的唯一合法层；禁止覆盖 token 与 shell 合同。
- `vcp.overrides`：例外预留，使用需在提交说明中记录原因。

注意：本层全部样式位于 cascade layer 内，页面现有的非 layered CSS 优先级更高——
这是刻意的迁移策略：共享基座先作为默认提供，各页面在自己的迁移提交里
删除冲突的本地定义并迁入 `vcp.page` 层。

## 布局合同（token 即合同）

| 合同项 | Token | 值（默认） |
|---|---|---|
| 标题栏高度 | `--vcp-app-header-height` | 48px（窄窗 44px） |
| 工具栏高度 | `--vcp-app-toolbar-height` | 44px（窄窗 40px） |
| 状态栏高度 | `--vcp-app-footer-height` | 28px |
| 页面内边距 | `--vcp-app-page-gutter` | 24px（窄窗 12px） |
| 内容最大宽度 | `--vcp-app-content-max-width` | 1080px |
| 文档型内容宽度 | `--vcp-app-content-max-width-document` | 860px |
| 列表行高 | `--vcp-app-row-height` | 36px |
| 卡片圆角 | `--vcp-app-card-radius` | 8px（工程规范上限） |
| 控件高度 | `--vcp-app-control-sm/md/lg` | 28 / 32 / 36px |
| 控件圆角 | `--vcp-app-control-radius` | 6px |
| 滚动条 | `--vcp-app-scrollbar-size` | 6px |

## 约束

- 禁 `!important`；颜色、字号、圆角、间距、控件高度只能来自 token。
- 卡片不嵌套；选中态用弱强调背景；加载态用 Skeleton 保持布局稳定。
- 页面专属文件命名 `app-surface-<page>.css`，只含该页面真正独特的内容布局。
