# VCP Scriptorium · 共笔文坊

Scriptorium 是 VCPChat 内置的沉浸式 DOCX 写作空间。

它不是聊天窗口的附件预览器，也不是“富文本编辑器 + DOCX 导出器”。Scriptorium 以真实 DOCX / OOXML 文档为唯一真源，优先服务论文、文学创作、长文写作和精细排版。

> A document is a place, not a file.  
> 文档不是一个文件，而是人类与协作者共同抵达的地方。

## 第一阶段原则

1. **人类执笔优先**
   - 所有核心交互首先为人类写作打磨。
   - Agent 当前没有修改、保存或执行入口。
   - 不因未来 Agent 能力牺牲人类编辑体验。

2. **真实 DOCX**
   - 使用 SuperDoc 的 OOXML 编辑内核。
   - 文档载入、分页、编辑和导出都围绕 DOCX 原始结构进行。
   - 不使用 Mammoth HTML 转换结果回写 DOCX，避免排版和结构损失。

3. **离线与本地**
   - 文档数据仅在本地 Electron 渲染进程与主进程之间流动。
   - SuperDoc 遥测显式关闭。
   - CSP 禁止编辑器连接外部网络。
   - 文件保存使用临时文件 + 原子替换，降低保存中断造成原文件损坏的风险。

4. **文档是视觉中心**
   - 中央纸页是界面的绝对主角。
   - 工具带、标题栏、状态栏和文脉主动降低视觉权重。
   - 支持一键进入“纯文模式”，隐藏所有非文档界面。

## 界面概念

### 悬浮装订台

Scriptorium 不沿用传统 Office Ribbon，也不复用 VCPChat 现有 App 布局。

界面由四个层级组成：

- **沉浸式标题栏**：品牌、文档名、保存状态、窗口控制。
- **排版工具带**：文件操作、字体、字号、字符格式、段落、表格、图片和查找。
- **纸页场**：SuperDoc 真实分页渲染与编辑表面。
- **文脉**：文档保存点与未来协作者提交的演化记录。

### 文脉与刻点

右侧“文脉”是文档演化流的 UI 与协议占位。

- **人类刻点**：用户主动命名并保存的文档状态。
- **Agent 提交**：未来 Agent 提交、等待人类审阅的修改状态。
- 两者在视觉层级上平等，通过来源色标区分。
- 第一阶段只实现人类刻点 UI；Agent 只有只读事件订阅占位，没有修改入口。
- 当前刻点列表属于窗口会话状态；持久化快照、差异比较与回溯将在后续阶段实现。

## 字体机制

Scriptorium 会请求主进程枚举当前操作系统已安装的字体：

- Windows：通过 `System.Drawing.Text.InstalledFontCollection`。
- Linux：通过 `fc-list`。
- macOS：优先使用 `fc-list`，不可用时扫描系统和用户字体目录。
- 枚举失败时提供常用字体保底列表。

字体列表只用于提供选择项，不会强行替换 DOCX 中已有字体。SuperDoc 仍负责文档字体解析、替代字体与排版测量。

## DOCX 数据流

### 打开

1. 渲染进程调用最小权限预加载 API。
2. 主进程显示仅允许 `.docx` 的文件选择器。
3. 主进程验证扩展名、文件类型和 100 MB 安全上限。
4. 主进程将二进制数据作为 `Uint8Array` 返回。
5. 渲染进程将二进制包装为 `File` 并交给 SuperDoc。

### 保存

1. 渲染进程调用 `SuperDoc.export()` 得到 DOCX `Blob`。
2. 通过预加载桥发送 `Uint8Array` 到主进程。
3. 主进程写入同目录临时文件。
4. 写入成功后原子替换目标文档。
5. 最近文档列表写入 `AppData/DocxEditor/recent.json`。

## 安全边界

专属预加载文件只暴露以下能力：

- 打开、读取、保存 DOCX。
- 查询最近文档。
- 查询系统字体。
- 获取主题和监听主题变化。
- 当前窗口控制。
- 订阅未来 Agent 保存点提案事件。

Scriptorium 不复用权限较宽的 Utility 预加载角色，也没有 Node.js 渲染进程权限。

## Agent 占位协议

当前仅保留渲染侧事件：

```text
docx:agent-checkpoint-proposed
```

建议的只读载荷：

```json
{
  "id": "agent-checkpoint-id",
  "name": "修改提案名称",
  "note": "修改摘要",
  "createdAt": 1786233600000
}
```

当前没有以下能力：

- Agent 读取当前文档内容。
- Agent 直接操作编辑器命令。
- Agent 导出或覆盖文件。
- Agent 自动接受自己的提交。
- Agent 绕过人类确认创建持久化刻点。

后续实现必须维持“提案 → 可视差异 → 人类审阅 → 接受/拒绝 → 保存”的边界。

## 文件结构

- `scriptorium.html`：产品结构与语义界面。
- `scriptorium.css`：主题自适应视觉系统。
- `scriptorium.js`：SuperDoc 生命周期、文件交互、排版命令和文脉 UI。
- `../preloads/docx.js`：最小权限 Electron 桥。
- `../modules/ipc/docxHandlers.js`：窗口、文件、最近记录与系统字体主进程实现。

## 依赖与许可证注意

Scriptorium 使用 `superdoc@1.45.0`。SuperDoc 为 AGPLv3 / 商业双许可证项目。

VCPChat 当前使用 CC BY-NC-SA 4.0。公开分发包含 SuperDoc 的构建版本前，应再次核对组合分发、源码提供和许可证兼容要求；若未来进入专有或商业分发，应获取 SuperDoc 商业许可。

## 验证

静态检查：

```bash
node --check ScriptoriumModules/scriptorium.js
node --check modules/ipc/docxHandlers.js
node --check preloads/docx.js
```

独立 Electron 冒烟测试：

```bat
set ELECTRON_RUN_AS_NODE=
npx electron tests/scriptorium-electron-smoke.js
```

测试会验证：

- 最小权限预加载存在。
- SuperDoc UMD 内核成功载入。
- 主题和系统字体数据成功到达。
- 空白 DOCX 成功创建。
- Presentation / Canvas 编辑表面成功渲染。
- 页面无遥测外联和运行时错误。
- 实际截图输出到 `AppData/DocxEditor/scriptorium-smoke.png`。