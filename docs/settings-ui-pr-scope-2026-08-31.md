# 设置界面 PR 范围审计

核对日期：2026-08-31  
基线：`origin/main`（`4b86d063`）
交付分支：`exp/settings-schema`

## 保留范围

- `modules/uiux/**` 完整组件库及其生成产物；
- 全局设置和 Agent 设置的桥接、字段适配、保存协调与生命周期；
- 设置页需要的行布局、控件样式、令牌、portal、焦点和主题适配；
- 设置页静态契约、布局审计、组件和保存回归测试；
- `package.json` 中 UIUX 类型检查、构建和产物门禁。

原生控件仍是设置业务真相。组件只负责 presentation、交互状态和可撤销的 DOM 投影，不新增持久化键、IPC 通道或第二份设置状态。

## 排除范围

本 PR 不主动重写以下上游业务或通用 presentation：

- 聊天、消息渲染、流式和输入框内部布局；
- MobileSync/CDS、TTS、语音输入及其 Electron/原生链路；
- 通用通知、聊天专用 CSS 和全量主题迁移；
- 插件 Loader、聊天协议、持久化和动态壁纸生命周期。

这些文件即使出现在历史开发差异中，也必须单独审计后再决定是否进入本 PR。与设置页面共享的入口文件采用上游业务行为，仅重新挂载设置 presentation。

## 工作树规则

2026-08-31 核对时，通用主题/聊天样式、`modules/event-listeners.js`、`modules/uiux/lab/primitive-lab.ts` 和 `styles/ui-system/settings-overrides.css` 存在未提交改动。它们可能属于并行线程；在归属明确前不得恢复、覆盖或清理。任何后续裁剪应只针对已提交差异，且先保留可回滚备份。

## 当前验证

- `npm run check:uiux`：通过；
- `npm run build:uiux`：通过；
- `npm run check:settings-ownership`：通过；
- `npm run audit:settings-layout`：通过，8 个设置分区；
- `node --test tests/uiux-primitives.test.mjs`：50/50 通过；
- `node --test tests/uiux-settings-bridge-modules.test.mjs`：35/35 通过；
- `node --test tests/global-settings-save.test.mjs`：通过。

Electron 首次打开、重开、reload、portal、Escape、保存失败重试和 Agent 设置人工证据仍需在最终交付前补齐。
