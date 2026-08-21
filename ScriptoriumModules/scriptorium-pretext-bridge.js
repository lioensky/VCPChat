'use strict';

(() => {
    const engine = window.Pretext;
    const preparedCache = new Map();
    const heightCache = new Map();

    function isReady() {
        return Boolean(engine?.prepare && engine?.layout);
    }

    function pixelLineHeight(computed) {
        const parsed = Number.parseFloat(computed.lineHeight);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
        const fontSize = Number.parseFloat(computed.fontSize) || 16;
        return fontSize * 1.5;
    }

    function fontShorthand(computed) {
        const style = computed.fontStyle || 'normal';
        const weight = computed.fontWeight || '400';
        const size = computed.fontSize || '16px';
        const family = computed.fontFamily || '"Microsoft YaHei", sans-serif';
        return `${style} ${weight} ${size} ${family}`;
    }

    function complexityOf(node) {
        if (!node) return { confidence: 0, requiresDomMeasurement: true, reason: 'missing-node' };
        if (node.matches('table, ul, ol, pre, figure')
            || node.querySelector('table, img, svg, canvas, video, audio, iframe, [data-vdoc-math]')) {
            return { confidence: 0, requiresDomMeasurement: true, reason: 'complex-content' };
        }

        const styledDescendants = [...node.querySelectorAll('span, strong, em, a, code')];
        if (styledDescendants.length > 12) {
            return { confidence: .35, requiresDomMeasurement: true, reason: 'mixed-inline-style' };
        }

        const computed = getComputedStyle(node);
        if (computed.position === 'absolute'
            || computed.display === 'grid'
            || computed.display === 'flex'
            || computed.cssFloat !== 'none'
            || computed.transform !== 'none') {
            return { confidence: .25, requiresDomMeasurement: true, reason: 'complex-layout' };
        }

        return {
            confidence: styledDescendants.length ? .72 : .94,
            requiresDomMeasurement: false,
            reason: styledDescendants.length ? 'inline-style-estimate' : 'plain-text',
        };
    }

    function numericEdges(computed) {
        const values = [
            computed.paddingTop,
            computed.paddingBottom,
            computed.borderTopWidth,
            computed.borderBottomWidth,
            computed.marginTop,
            computed.marginBottom,
        ].map((value) => Number.parseFloat(value) || 0);
        return values.reduce((sum, value) => sum + value, 0);
    }

    function estimateBlock(node, width = null) {
        const complexity = complexityOf(node);
        if (!isReady() || !node) {
            return {
                height: null,
                textHeight: null,
                confidence: 0,
                requiresDomMeasurement: true,
                reason: isReady() ? 'missing-node' : 'pretext-unavailable',
            };
        }

        const computed = getComputedStyle(node);
        const availableWidth = Math.max(
            1,
            Number(width)
                || node.clientWidth
                || node.parentElement?.clientWidth
                || 1
        );
        const horizontalInsets = [
            computed.paddingLeft,
            computed.paddingRight,
            computed.borderLeftWidth,
            computed.borderRightWidth,
        ].reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
        const textWidth = Math.max(1, availableWidth - horizontalInsets);
        const text = node.textContent || '';
        const font = fontShorthand(computed);
        const lineHeight = pixelLineHeight(computed);
        const whiteSpace = computed.whiteSpace === 'pre-wrap' ? 'pre-wrap' : 'normal';
        const id = node.dataset.vdocText || node.id || '';
        const signature = [
            id,
            text,
            font,
            lineHeight,
            textWidth,
            whiteSpace,
            computed.letterSpacing,
        ].join('\u001f');

        const cachedHeight = heightCache.get(signature);
        if (cachedHeight) return { ...cachedHeight, ...complexity };

        let prepared = preparedCache.get(signature);
        if (!prepared) {
            prepared = engine.prepare(text, font, { whiteSpace });
            preparedCache.set(signature, prepared);
        }

        const result = engine.layout(prepared, textWidth, lineHeight);
        const textHeight = Math.max(lineHeight, result.height || 0);
        const estimate = {
            height: textHeight + numericEdges(computed),
            textHeight,
            lineCount: Math.max(1, result.lineCount || 0),
        };
        heightCache.set(signature, estimate);
        return { ...estimate, ...complexity };
    }

    function evictNode(nodeId) {
        const prefix = `${nodeId}\u001f`;
        for (const key of preparedCache.keys()) {
            if (key.startsWith(prefix)) preparedCache.delete(key);
        }
        for (const key of heightCache.keys()) {
            if (key.startsWith(prefix)) heightCache.delete(key);
        }
    }

    function clear() {
        preparedCache.clear();
        heightCache.clear();
    }

    window.ScriptoriumPretext = Object.freeze({
        isReady,
        estimateBlock,
        complexityOf,
        evictNode,
        clear,
    });
})();