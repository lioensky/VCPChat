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
        system: "14px 'Segoe UI'",
        viewer: "15px 'Segoe UI'",
        widget: "14px 'Segoe UI'",
        memo: "14px 'Segoe UI'",
        rag: "14px 'JetBrains Mono', monospace",
        note: "15px 'Segoe UI'"
    };

    const LINE_HEIGHTS = {
        body: 1.6 * 15,     // 24px
        code: 1.5 * 14,     // 21px
        system: 1.5 * 14,    // 21px
        viewer: 1.6 * 15,    // 24px
        widget: 1.5 * 14,    // 21px
        memo: 1.5 * 14,      // 21px
        rag: 1.6 * 14,      // 22.4px
        note: 1.6 * 15       // 24px
    };

    // ─── 布局间距计算 ───

    const PADDINGS = {
        body: { left: 16, right: 16 },
        code: { left: 16, right: 16 },
        system: { left: 14, right: 14 },
        viewer: { left: 20, right: 20 },
        widget: { left: 12, right: 12 },
        memo: { left: 15, right: 15 },
        rag: { left: 16, right: 16 },
        note: { left: 20, right: 20 }
    };

    /**
     * 根据容器宽度和类型计算文本可用宽度
     */
    function getContentWidth(containerWidth, type) {
        const padding = PADDINGS[type] || PADDINGS.body;
        let maxWidth;

        const fullWidthTypes = ['viewer', 'widget', 'memo', 'rag', 'note'];
        if (fullWidthTypes.includes(type)) {
            // 这些模式通常占满或按比例占满可用宽度
            maxWidth = containerWidth;
        } else {
            // 聊天气泡模式（body/code/system）占 80% 宽度
            maxWidth = Math.floor(containerWidth * 0.8);
        }

        return Math.max(0, maxWidth - padding.left - padding.right);
    }

    // ─── 核心 API ───

    function estimateHeight(messageId, text, messageType, containerWidth) {
        messageType = messageType || 'body';

        const font = FONTS[messageType] || FONTS.body;
        const lineHeight = LINE_HEIGHTS[messageType] || LINE_HEIGHTS.body;
        const maxWidth = getContentWidth(containerWidth, messageType);
        const whiteSpace = (messageType === 'code' || messageType === 'rag') ? 'pre-wrap' : 'normal';

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

            // 根据 lineHeight 逆推 messageType (简单启发式)
            var messageType = 'body';
            if (lineHeight === LINE_HEIGHTS.code) messageType = 'code';
            else if (lineHeight === LINE_HEIGHTS.system) messageType = 'system';
            else if (lineHeight === LINE_HEIGHTS.viewer) messageType = 'viewer';
            else if (lineHeight === LINE_HEIGHTS.widget) messageType = 'widget';
            else if (lineHeight === LINE_HEIGHTS.memo) messageType = 'memo';
            else if (lineHeight === LINE_HEIGHTS.rag) messageType = 'rag';
            else if (lineHeight === LINE_HEIGHTS.note) messageType = 'note';

            var maxWidth = getContentWidth(newContainerWidth, messageType);
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

    function setChatFonts(bodyFontFamily, codeFontFamily) {
        const resolvedBody = bodyFontFamily && String(bodyFontFamily).trim()
            ? String(bodyFontFamily).trim()
            : "'Segoe UI'";
        const resolvedCode = codeFontFamily && String(codeFontFamily).trim()
            ? String(codeFontFamily).trim()
            : "'Consolas', monospace";

        FONTS.body = `15px ${resolvedBody}`;
        FONTS.system = `14px ${resolvedBody}`;
        FONTS.code = `14px ${resolvedCode}`;
        clearAll();
    }

    // ─── 暴露全局 API ───

    window.pretextBridge = {
        estimateHeight: estimateHeight,
        getCachedHeight: getCachedHeight,
        recalculateAll: recalculateAll,
        evict: evict,
        clearAll: clearAll,
        setChatFonts: setChatFonts,
        isReady: function() { return true; },
        getContentWidth: getContentWidth,
        FONTS: FONTS,
        LINE_HEIGHTS: LINE_HEIGHTS
    };

    console.log('[pretext-bridge] Bridge ready. API available at window.pretextBridge');

})();
