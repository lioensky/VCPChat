/**
 * pretext-bridge.js
 * VChat × Pretext 集成适配层（浏览器全局模块版本）
 * 
 * 依赖：window.Pretext（由 pretext.bundle.js 提供）
 * 暴露：window.pretextBridge
 */

(function() {
    'use strict';

    // ─── Pretext 引用 ───

    const Pretext = window.Pretext;
    if (!Pretext || !Pretext.prepare || !Pretext.layout) {
        console.warn('[pretext-bridge] window.Pretext not found. Bridge disabled.');
        window.pretextBridge = { isReady: () => false };
        return;
    }

    console.log('[pretext-bridge] Pretext detected. Bridge initializing...');

    // ─── 缓存层 ───

    /** @type {Map<string, object>} messageId → PreparedText */
    const preparedCache = new Map();

    /** @type {Map<string, {height: number, maxWidth: number, lineHeight: number}>} */
    const heightCache = new Map();

    /** @type {Map<string, string>} messageId → 上次 prepare 的原始文本 */
    const textSnapshot = new Map();

    // ─── 字体常量（VChat 实际使用的字体） ───

    const FONTS = {
        body: "15px 'Segoe UI'",
        code: "14px 'Consolas'",
        system: "14px 'Segoe UI'"
    };

    const LINE_HEIGHTS = {
        body: 1.6 * 15,     // 24px
        code: 1.5 * 14,     // 21px
        system: 1.5 * 14    // 21px
    };

    // ─── 气泡宽度计算 ───

    const BUBBLE_PADDING = {
        body: { left: 16, right: 16 },
        code: { left: 16, right: 16 },
        system: { left: 14, right: 14 }
    };

    function getBubbleTextWidth(containerWidth, messageType) {
        const padding = BUBBLE_PADDING[messageType] || BUBBLE_PADDING.body;
        const bubbleMaxWidth = Math.floor(containerWidth * 0.8);
        return bubbleMaxWidth - padding.left - padding.right;
    }

    // ─── 核心 API ───

    function estimateHeight(messageId, text, messageType, containerWidth) {
        messageType = messageType || 'body';

        const font = FONTS[messageType] || FONTS.body;
        const lineHeight = LINE_HEIGHTS[messageType] || LINE_HEIGHTS.body;
        const maxWidth = getBubbleTextWidth(containerWidth, messageType);
        const whiteSpace = messageType === 'code' ? 'pre-wrap' : 'normal';

        // 缓存命中检查
        const cached = heightCache.get(messageId);
        const prevText = textSnapshot.get(messageId);
        if (cached && cached.maxWidth === maxWidth && cached.lineHeight === lineHeight && prevText === text) {
            return cached.height;
        }

        // prepare + layout
        var prepared = Pretext.prepare(text, font, { whiteSpace: whiteSpace });
        preparedCache.set(messageId, prepared);
        textSnapshot.set(messageId, text);

        var result = Pretext.layout(prepared, maxWidth, lineHeight);
        heightCache.set(messageId, { height: result.height, maxWidth: maxWidth, lineHeight: lineHeight });

        return result.height;
    }

    function getCachedHeight(messageId) {
        var cached = heightCache.get(messageId);
        return cached ? cached.height : null;
    }

    function recalculateAll(newContainerWidth) {
        var updates = new Map();

        preparedCache.forEach(function(prepared, messageId) {
            var prev = heightCache.get(messageId);
            var lineHeight = prev ? prev.lineHeight : LINE_HEIGHTS.body;

            var messageType = 'body';
            if (lineHeight === LINE_HEIGHTS.code) messageType = 'code';
            else if (lineHeight === LINE_HEIGHTS.system) messageType = 'system';

            var maxWidth = getBubbleTextWidth(newContainerWidth, messageType);
            var result = Pretext.layout(prepared, maxWidth, lineHeight);

            heightCache.set(messageId, { height: result.height, maxWidth: maxWidth, lineHeight: lineHeight });
            updates.set(messageId, result.height);
        });

        return updates;
    }

    function evict(messageId) {
        preparedCache.delete(messageId);
        heightCache.delete(messageId);
        textSnapshot.delete(messageId);
    }

    function clearAll() {
        preparedCache.clear();
        heightCache.clear();
        textSnapshot.clear();
    }

    // ─── 暴露全局 API ───

    window.pretextBridge = {
        estimateHeight: estimateHeight,
        getCachedHeight: getCachedHeight,
        recalculateAll: recalculateAll,
        evict: evict,
        clearAll: clearAll,
        isReady: function() { return true; },
        getBubbleTextWidth: getBubbleTextWidth,
        FONTS: FONTS,
        LINE_HEIGHTS: LINE_HEIGHTS
    };

    console.log('[pretext-bridge] Bridge ready. API available at window.pretextBridge');

})();