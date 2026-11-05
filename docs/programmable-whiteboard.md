# 可编程白板与 Agent 协作

## 存储和文件入口

白板继续使用 `.excalidraw`，位于 `<appDataRoot>/ScriptoriumDocument/VDOCX/Boards`。
首页增加“用户白板”分类；原路径不迁移，用户文档分类不重复列出 Boards。
新建提供名称；保存写回原文件；另存为通过原生对话框复制并切换当前路径。
重命名拒绝覆盖同名文件；定位文件打开系统文件管理器。
白板普通保存和读取均限制 40 MB，包括内嵌文脉。

## Agent 协议

- `CreateBoard`: `maid`，`name/title`，`elements` JSON 数组，`background?`，`requestId?`，`openAfterCreate?`（默认 true）。
  新文件直接落盘；打开失败或被用户取消不表示文件创建失败，以 saved/opened 分别判断。
  创建幂等缓存是有界会话缓存，不是跨进程幂等存储。
- `GetBoard`: 元素摘要及 revision，保持现有 ids/region/sinceRevision/limit。
- `GetBoardNodeSource`: id，startLine/endLine 可选，最多 2000 行，返回 HTML 真源及 revision。
- `UpdateBoard`: maid，summary，expectedRevision，requestId，add/update/delete/background。
  默认提交到白板文脉并自动批准，默认保存；`save=false` 只应用不保存。
  人类关闭自动允许时立即返回 pending，通过 GetBoardHistory 查询后续状态。
  冲突返回 success=false/status=conflict，画布不修改。
- `SaveBoard`: expectedRevision，显式保存。
- `GetBoardHistory`: 查询状态、署名和回执，不展开快照和提案源码。

HTML 新节点示例：

```json
{
  "id": "demo",
  "type": "html",
  "title": "原理演示",
  "x": 0,
  "y": 0,
  "width": 480,
  "height": 320,
  "source": "<div>演示</div><style>/* CSS 动画 */</style><script>/* 内联 JS */</script>"
}
```

局部编辑：

```json
{
  "id": "demo",
  "replacements": [
    { "target": "唯一的原文", "replace": "新内容" }
  ]
}
```

所有替换基于同一原始源码，target 不唯一、零命中和重叠均拒绝。
source 整体替换与 replacements 互斥。单节点源码上限 512 KB。

## 渲染与隔离

普通矩形元素的 `customData.vcpHtml` 保存源码和节点元数据。
iframe 投影跟随画布移动、缩放和旋转；不把动态 DOM 序列化回文件。
使用 `scriptorium-page://board-<random-token>/index.html` 和响应 CSP。
iframe sandbox 仅 allow-scripts，不允许 allow-same-origin，不暴露宿主 API。
禁止网络、外部脚本、子框架、表单和任意文件资源；支持内联 JS/CSS、data 图片。
旧 Blob/srcdoc 方案因继承宿主 CSP 导致内联脚本被拒绝，已由 Electron 测试验证并替换。
删除、切换节点或关闭窗口时释放页面令牌和 iframe。

默认鼠标事件交还画布；按钮进入交互后交给 iframe。
焦点在 iframe 内时宿主 Esc 不保证可见，使用节点“退出交互”按钮退出。
当前不承诺恶意脚本的 CPU/内存强隔离或运行状态的自动持久化。

## 文脉

独立白板文脉嵌入场景顶层 `vcpBoard.records`。
默认自动允许，仅人类 UI 可修改本地审批设置；不改变 VDOCX/VPPTX 策略。
提案串行执行，校验基础修订；首次修改前保留基线。
手动刻点和回溯可用；回溯先备份当前状态，再创建恢复记录，不删除历史。
快照仅含场景，不递归嵌套文脉。HTML 恢复源码，不恢复 JS 闭包和动画现场。
重新打开时取消磁盘恢复的 pending 提案，防止打开外部文件即自动执行旧提案。
当前历史是完整场景快照，长期大量编辑可能触及 40 MB 保存限额，尚未做增量压缩。

## 视觉与窗口边界

纯图形白板继续导出内容图片，支持 ids/region。
含 HTML 时 GetVisualContext 使用真实视口截图，ids/region 明确拒绝，避免导出遗漏 HTML 的空框。
尚未实现 HTML 整板离屏合成、HTML 静态预览导出和第三方 Excalidraw 里的完整扩展呈现。

白板界面隐藏文稿工具、篇章与文稿文脉，使用自己的保存/首页/HTML/文件/文脉入口。
这是共用文坊内核的精简模式，不是独立轻量 HTML 页面，也未减少文坊初始脚本加载量。
独立窗口、多窗口 Agent 目标路由、受控本地动画依赖属于后续工作。

## 验证

`node --test tests/scriptorium-board-model.test.js tests/scriptorium-library.test.js tests/scriptorium-collaborator.test.js`

`node --test tests/scriptorium-board-electron.test.js tests/scriptorium-file-views-electron.test.js tests/scriptorium-vpptx-electron.test.js`

Electron 白板用例覆盖普通元素、冲突、Ctrl+S、命名、HTML 脚本执行、宿主隔离、
精确源码编辑、自动保存、人工审批、保存重开、首页分类、重命名与文脉回溯。
另存为原生对话框与精简模式的人类视觉体验仍需要人工验收。