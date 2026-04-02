# Pretext 文本布局引擎集成说明

## 这是什么？

本次 PR 将 [chenglou/pretext](https://github.com/chenglou/pretext) 集成到 VCPChat 的渲染管线中。Pretext 是一个纯算术的文本测量与布局引擎，使用 `Canvas.measureText()` 替代 DOM 测量来计算文本尺寸，完全绕过浏览器重排（reflow）。

## 为什么要做这个？

VCPChat 当前的渲染管线在文本高度计算上存在三个性能瓶颈：

1. **`visibilityOptimizer.js`** 在消息离开视口时调用 `offsetHeight` 来固化 `containIntrinsicSize`。每次读取 `offsetHeight` 都会触发一次同步浏览器重排——当批量处理多条消息时开销很大。

2. **`streamManager.js`** 在流式输出时每 100ms 调用一次 `scrollToBottom()`，其内部读取 `scrollHeight`（同样触发重排）。当用户在流式输出过程中上翻查看之前的消息时，会被强制拉回底部。

3. **没有高度预计算机制**——每条消息的高度完全依赖 DOM 自然撑开，这使得虚拟滚动（未来的优化方向）无法实现，因为没有办法在不渲染 DOM 的情况下预测高度。

## 改了什么？

### 新增文件

| 文件 | 说明 |
|------|------|
| `modules/renderer/pretext.bundle.js` | chenglou/pretext 的 IIFE 打包产物（84.6kb）。暴露 `window.Pretext`，提供 `prepare()`、`layout()`、`layoutWithLines()` 三个核心 API。构建命令：`npx esbuild dist/layout.js --bundle --format=iife --global-name=Pretext` |
| `modules/renderer/pretext-bridge.js` | 浏览器全局适配层。暴露 `window.pretextBridge`，提供高度预算、缓存管理和批量重算 API。内部维护三层缓存：PreparedText 对象、计算后的高度值、文本快照（用于变更检测）。 |

### 修改文件

| 文件 | 改动内容 | 改动原因 |
|------|----------|----------|
| `main.html`（约第 1627 行） | 在所有渲染模块之前添加两个 `<script>` 标签 | Pretext 及其适配层必须在任何消费方模块之前加载 |
| `modules/messageRenderer.js`（约第 1561 行） | 在 `contentDiv.innerHTML = finalHtml` 之后添加 Pretext 缓存填充 | 每条渲染完成的消息，其原始文本会被送入 `pretextBridge.estimateHeight()` 填充高度缓存。同步执行但很轻量（约 0.2ms/条）。用 try-catch 包裹，失败不影响正常渲染。 |
| `modules/renderer/visibilityOptimizer.js`（约第 314 行） | `containIntrinsicSize` 优先从 Pretext 缓存读取，缓存未命中时回退到 `offsetHeight` | 缓存命中时消除重排。完全向后兼容——如果 Pretext 未加载或缓存未命中，行为与修改前完全一致。 |
| `modules/renderer/streamManager.js` | 在 `processAndRenderSmoothChunk()` 中添加基于 heightDelta 的滚动锚定 | 流式输出时，Pretext 计算每个 chunk 带来的高度变化量（delta）。用户在底部附近 → 照常 `scrollToBottom()`。用户已上翻 → `scrollTop += delta` 保持视口位置不变，不会被拉回底部。 |

## 架构

```
页面加载
  → pretext.bundle.js    → window.Pretext 就绪
  → pretext-bridge.js    → window.pretextBridge 就绪

消息渲染（messageRenderer.js）
  → contentDiv.innerHTML = finalHtml
  → pretextBridge.estimateHeight(id, text, type, width)
  → 高度写入缓存（PreparedText + 计算高度 + 文本快照）

消息离开视口（visibilityOptimizer.js）
  → pretextBridge.getCachedHeight(id)
  → 缓存命中：直接设置 containIntrinsicSize，零重排
  → 缓存未命中：回退到 offsetHeight（原始行为）

流式输出（streamManager.js）
  → 每个 chunk 到达
  → Pretext 计算 heightDelta（旧高度 → 新高度，约 0.0002ms）
  → 在底部附近？scrollToBottom()
  → 已上翻？scrollTop += delta（视口位置不变）

窗口缩放
  → pretextBridge.recalculateAll(newWidth)
  → 所有缓存的 PreparedText 用新宽度重新布局
  → 500 条消息总计约 0.1ms（纯算术，不碰 DOM）
```

## 兼容性

- **完全向后兼容**：所有 Pretext 代码路径都有回退逻辑。如果 `window.pretextBridge` 不可用或缓存未命中，行为与原始代码完全一致。
- **Electron/Chromium 环境**：`Intl.Segmenter` 和 `OffscreenCanvas` 均可用，无需 polyfill。
- **字体配置**：适配层使用具名字体（`Segoe UI`、`Consolas`），与 VCPChat 的 CSS 声明一致，避免了 Pretext RESEARCH.md 中记录的 `system-ui` 在 Canvas/DOM 测量之间的精度差异问题。

## 性能数据

| 操作 | 耗时 | 触发时机 |
|------|------|----------|
| `prepare(text, font)` | 约 0.2ms/条 | 每条消息首次渲染时（结果缓存） |
| `layout(prepared, width, lineHeight)` | 约 0.0002ms | 每次缩放 / 滚动锚定检查 |
| `recalculateAll(newWidth)` | 500 条消息约 0.1ms | 窗口缩放时 |
| `getCachedHeight(id)` | O(1) Map 查找 | 每次可见性变化时 |

## 后续方向

- **虚拟滚动**：现在有了精确的高度预计算能力，视口外的消息可以用高度占位符替代，将 DOM 节点数量从 O(n) 降低到 O(视口大小)。这是影响最大的优化方向，但需要对消息渲染管线进行较大规模的重构。