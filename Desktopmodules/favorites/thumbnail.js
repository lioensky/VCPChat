/**
 * VCPdesktop - 缩略图捕获模块
 * 负责：widget 截图、fallback 文本预览缩略图生成
 */

'use strict';

(function () {

    /**
     * 捕获 widget 缩略图
     * 优先使用 Electron 的 capturePage 原生截图，失败时降级为文本预览
     * @param {object} widgetData
     * @returns {Promise<string>} data URL
     */
    async function captureWidgetThumbnail(widgetData) {
        const widget = widgetData.element;
        if (!widget) throw new Error('No widget element');

        // 使用 Electron 的 webContents.capturePage() 原生截图
        if (window.electronAPI?.desktopCaptureWidget) {
            const rect = widget.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const captureRect = {
                x: Math.round(rect.x * dpr),
                y: Math.round(rect.y * dpr),
                width: Math.round(rect.width * dpr),
                height: Math.round(rect.height * dpr),
            };

            console.log(`[Desktop] Capturing widget at rect:`, captureRect, `dpr: ${dpr}`);
            const result = await window.electronAPI.desktopCaptureWidget(captureRect);
            if (result?.success && result.thumbnail) {
                return result.thumbnail;
            } else {
                console.warn('[Desktop] capturePage failed:', result?.error);
            }
        }

        // Fallback: 简单的文本预览缩略图
        return generateFallbackThumbnail(widgetData);
    }

    /**
     * Fallback 缩略图：使用 Canvas 生成文本预览
     * @param {object} widgetData
     * @returns {string} data URL
     */
    function generateFallbackThumbnail(widgetData) {
        const widget = widgetData.element;
        const widgetRect = widget.getBoundingClientRect();
        const w = Math.round(widgetRect.width);
        const h = Math.round(widgetRect.height);

        const MAX_THUMB = 300;
        const scale = Math.min(MAX_THUMB / w, MAX_THUMB / h, 1);
        const thumbW = Math.round(w * scale);
        const thumbH = Math.round(h * scale);

        const canvasEl = document.createElement('canvas');
        canvasEl.width = thumbW;
        canvasEl.height = thumbH;
        const ctx = canvasEl.getContext('2d');

        const gradient = ctx.createLinearGradient(0, 0, thumbW, thumbH);
        gradient.addColorStop(0, 'rgba(40, 40, 60, 0.9)');
        gradient.addColorStop(1, 'rgba(20, 20, 40, 0.9)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.roundRect(0, 0, thumbW, thumbH, 8);
        ctx.fill();

        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.font = `${Math.max(10, thumbH * 0.08)}px sans-serif`;
        const textContent = (widgetData.contentContainer.textContent || '').trim().substring(0, 100);
        const lines = wrapText(ctx, textContent, thumbW - 16);
        let textY = 16;
        for (let i = 0; i < Math.min(lines.length, 6); i++) {
            ctx.fillText(lines[i], 8, textY);
            textY += Math.max(12, thumbH * 0.12);
        }

        return canvasEl.toDataURL('image/png', 0.8);
    }

    /**
     * 文本换行辅助函数
     * @param {CanvasRenderingContext2D} ctx
     * @param {string} text
     * @param {number} maxWidth
     * @returns {string[]}
     */
    function wrapText(ctx, text, maxWidth) {
        const words = text.split('');
        const lines = [];
        let line = '';

        for (const char of words) {
            const testLine = line + char;
            const metrics = ctx.measureText(testLine);
            if (metrics.width > maxWidth && line) {
                lines.push(line);
                line = char;
            } else {
                line = testLine;
            }
        }
        if (line) lines.push(line);
        return lines;
    }

    // ============================================================
    // 导出
    // ============================================================
    window.VCPDesktop = window.VCPDesktop || {};
    window.VCPDesktop.thumbnail = {
        capture: captureWidgetThumbnail,
        generateFallback: generateFallbackThumbnail,
    };

})();