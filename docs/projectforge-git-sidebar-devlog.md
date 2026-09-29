# 开发日志：ProjectForge Git 源代码管理侧栏与滑动多分页

日期：2026-09-29

## 目标

在 VChat 的 ProjectForge 施工图窗口中移植类似于 VS Code 的“源代码管理（Source Control）”与“Diff 差分对比”功能：
1. 侧栏改造为与主窗口同款的平滑滑动多分页（「工程」/「Git」）。
2. 工作区 Git 状态感知、多选批量暂存、取消暂存、安全放弃修改。
3. 提交与推送一体化（支持 Conventional Commits 与分支上游绑定）。
4. 右侧主面板深度整合 CodeMirror MergeView 双栏高亮 Diff 渲染。

## 关键架构与安全决策

- **只走原生 `execFile` 数组传参**：坚决不通过 shell 拼接命令字符串，规避命令注入风险。
- **作用域物理沙盒**：
  - 调用时仅需传递 `workspaceId`，由主进程通过 `workspaceService` 只读门面解析真实物理路径。
  - 所有操作限定在已启用的工作区根目录范围内，自动剥除子目录前缀并拦截 `../` 越界与 `.git/` 敏感路径。
- **写锁串行化**：修改索引、工作树、提交与推送按仓库级别严格串行，防止多操作冲突导致 `index.lock` 竞争。
- **未跟踪文件安全回收**：放弃未跟踪文件时调用 `shell.trashItem` 移入系统回收站，而非硬删除。
- **IPC 调用方鉴权**：在 `gitHandlers.js` 中严密校验 sender URL，仅放行 `projectforge.html` 页面调用。

## 实现清单

### 后端服务与 IPC
- `modules/services/gitService.js`：
  - 基于 `git status --porcelain=v2 -z --branch` 的机器级无损状态解析。
  - 分离 `conflicts`、`staged`、`changes`（含未跟踪 `U`）三大分组。
  - 原子提供 `getStatus`, `getDiff`, `stage`, `unstage`, `discard`, `commit`, `push` 能力。
- `modules/ipc/gitHandlers.js`：主进程 IPC 门面与窗口调用权校验。
- `main.js`：注入并初始化 `gitHandlers`。

### Preload 隔离层
- `preloads/utility.js`（catalog 与 ALLOWED_KEYS）、`preloads/shared/catalog.js`、`preloads/shared/roles.js`：四处同步登记 `gitListWorkspaces`, `gitStatus`, `gitDiff`, `gitStage`, `gitUnstage`, `gitDiscard`, `gitCommit`, `gitPush`。

### 前端 UI 与控制器
- `ProjectForgemodules/projectforge.html`：侧栏升级为 `side-track` 滑动布局；主面板补充 `git-view` 差异视图容器。
- `ProjectForgemodules/projectforge.css`：
  - 实现与主侧栏一致的下划线滑动指示条（支持主题变量自适应）。
  - MergeView 左右增删红绿配色共用。
  - 拟物化 Git 变更条目、行悬浮快捷按钮、分支与变动徽标。
- `ProjectForgemodules/projectforge-git.js`：
  - 侧栏切换平滑联动。
  - 状态 8s 轮询与窗口焦点唤醒。
  - 单选/全选/Shift范围勾选批量暂存。
  - 双栏差异对比与自动换行同步。

## 验证

- `tests/git-service.test.js`：包含状态解析、长参数切片、真实临时 Git 仓库完整往返（暂存/取消/提交/Diff/放弃）、子目录边界防御及 URL 鉴权全部 7 项测试，100% 通过。
- 代码语法：`node --check` 涉及文件全数通过。