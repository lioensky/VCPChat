# 新版 UI 业务页面启用策略

> 状态：首个上游 PR 不启用业务子页面 Next presentation
> 更新日期：2026-08-14

新版主界面不再自动要求所有子应用使用新版 presentation。业务页面必须逐页达到可用门槛后才能进入启用清单。

## 当前启用

- 主界面新版 Shell、侧栏、顶部标签与助手页面。
- 主 Renderer 中的全局设置增强。
- 业务子页面启用清单当前为空。

## 未迁移页面

笔记、翻译、便签、日志、插件、任务、记忆、论坛、RAG 观察器、Human ToolBox 和 VchatManager 均不属于首个上游设计 PR。它们保留 `origin/main` 的经典页面，不在业务文件中保存禁用的 Next 重建、runtime bootstrap 或实验样式。

数据库、IPC、业务协议和经典页面均不改变。统一策略仍由 `modules/ui-system/ui-surface-policy.js` 保护，但 allowlist 不是保存实验实现的理由；页面只有在独立后续 PR 达到启用门槛时才加入 Next runtime。

协同 Canvas 不属于“归档重建”：其 next-UI 重建已撤销，业务文件保持 `upstream-review/main` 的上游经典实现，因此不加载新版 runtime。

## 重新启用门槛

每个页面必须单独满足：

1. 核心业务流程、错误恢复、重开和独立/内嵌模式通过。
2. 不依赖旧 DOM 的偶然加载顺序，不产生重复监听器或双状态。
3. Electron 功能 smoke、窄窗口和视觉截图在当前 commit 通过。
4. teardown 后经典页面仍可操作。
5. 将页面加入中央 allowlist，并同步结构门禁和 Electron 测试。

旧的 2026-08-02 截图仅是历史结构证据，不能作为当前产品启用依据。

## 合入门禁

在当前设计分支执行：

```powershell
npm run check:ui-system
npm run test:electron-ui-apps
```

- UI 门禁必须报告 `0 active rebuilt`，所有业务子页面与上游 Classic 一致。
- Electron UI apps 必须验证主界面、全局设置，以及笔记、翻译在内的通用 Classic 标签宿主。
- 只有主界面和全局设置使用新版 presentation；业务子页面保持 Classic。
- 便签、日志、插件、任务、记忆、论坛、RAG 观察器、VchatManager、Human ToolBox 和 Canvas 均直接使用上游经典实现，不加载设计系统 runtime。
