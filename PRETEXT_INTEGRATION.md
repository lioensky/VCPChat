# Pretext Text Layout Engine Integration

## What is this?

This PR integrates [chenglou/pretext](https://github.com/chenglou/pretext) — a pure-arithmetic text measurement and layout engine — into VCPChat's rendering pipeline. Pretext uses `Canvas.measureText()` instead of DOM measurement to calculate text dimensions, completely bypassing browser reflow.

## Why?

VCPChat's current rendering pipeline has three performance bottlenecks related to text height calculation:

1. **`visibilityOptimizer.js`** calls `offsetHeight` to freeze `containIntrinsicSize` when messages leave the viewport. Each `offsetHeight` read triggers a synchronous browser reflow — expensive when processing many messages at once.

2. **`streamManager.js`** uses `scrollToBottom()` during streaming output, which reads `scrollHeight` (another reflow trigger) every 100ms. When users scroll up to review earlier messages during streaming, they get forcefully pulled back to the bottom.

3. **No height pre-computation exists** — every message's height is determined by the DOM naturally expanding, making virtual scrolling (future optimization) impossible without a way to predict heights without rendering.

## What changed?

### New files

| File | Description |
|------|-------------|
| `modules/renderer/pretext.bundle.js` | IIFE build of chenglou/pretext (84.6kb). Exposes `window.Pretext` with `prepare()`, `layout()`, and `layoutWithLines()` APIs. Built with: `npx esbuild dist/layout.js --bundle --format=iife --global-name=Pretext` |
| `modules/renderer/pretext-bridge.js` | Browser global adapter layer. Exposes `window.pretextBridge` with height estimation, caching, and batch recalculation APIs. Manages three cache layers: `PreparedText` objects, computed heights, and text snapshots for change detection. |

### Modified files

| File | Change | Why |
|------|--------|-----|
| `main.html` (line ~1627) | Added two `<script>` tags before all renderer modules | Pretext and its bridge must load before any module that consumes them |
| `modules/messageRenderer.js` (line ~1561) | Added Pretext cache population after `contentDiv.innerHTML = finalHtml` | Each rendered message's raw text is fed to `pretextBridge.estimateHeight()` to populate the height cache. Runs synchronously but is lightweight (~0.2ms per message). Wrapped in try-catch — failure does not affect normal rendering. |
| `modules/renderer/visibilityOptimizer.js` (line ~314) | `containIntrinsicSize` now reads from Pretext cache first, falls back to `offsetHeight` | Eliminates reflow when cached height is available. Fully backward-compatible — if Pretext is not loaded or cache misses, behavior is identical to before. |
| `modules/renderer/streamManager.js` | Added heightDelta-based scroll anchoring in `processAndRenderSmoothChunk()` | During streaming, Pretext calculates the height change (delta) for each chunk. If user is near bottom → `scrollToBottom()` as before. If user has scrolled up → `scrollTop += delta` to maintain their viewport position without pulling them back. |

## Architecture

```
Page Load
  → pretext.bundle.js    → window.Pretext ready
  → pretext-bridge.js    → window.pretextBridge ready

Message Render (messageRenderer.js)
  → contentDiv.innerHTML = finalHtml
  → pretextBridge.estimateHeight(id, text, type, width)
  → Height cached (PreparedText + computed height + text snapshot)

Message Leaves Viewport (visibilityOptimizer.js)
  → pretextBridge.getCachedHeight(id)
  → Cache hit: set containIntrinsicSize without reflow
  → Cache miss: fallback to offsetHeight (original behavior)

Streaming Output (streamManager.js)
  → Each chunk arrives
  → Pretext calculates heightDelta (old height → new height, ~0.0002ms)
  → Near bottom? scrollToBottom()
  → Scrolled up? scrollTop += delta (viewport stays put)

Window Resize
  → pretextBridge.recalculateAll(newWidth)
  → All cached PreparedText re-laid out with new width
  → 500 messages ≈ 0.1ms total (pure arithmetic, no DOM)
```

## Compatibility

- **Fully backward-compatible**: All Pretext code paths have fallbacks. If `window.pretextBridge` is unavailable or cache misses, behavior is identical to the original code.
- **Electron/Chromium**: `Intl.Segmenter` and `OffscreenCanvas` are both available. No polyfills needed.
- **Font configuration**: Bridge uses explicit font names (`Segoe UI`, `Consolas`) matching VCPChat's CSS declarations, avoiding the `system-ui` Canvas/DOM measurement discrepancy documented in Pretext's RESEARCH.md.

## Performance characteristics

| Operation | Cost | When |
|-----------|------|------|
| `prepare(text, font)` | ~0.2ms per message | Once per message (cached) |
| `layout(prepared, width, lineHeight)` | ~0.0002ms | Every resize / scroll anchor check |
| `recalculateAll(newWidth)` | ~0.1ms for 500 messages | Window resize |
| `getCachedHeight(id)` | O(1) Map lookup | Every visibility change |

## Future work

- **Virtual scrolling**: With accurate height pre-computation now available, messages outside the viewport can be replaced with height placeholders, reducing DOM node count from O(n) to O(viewport). This is the highest-impact optimization but requires significant refactoring of the message rendering pipeline.