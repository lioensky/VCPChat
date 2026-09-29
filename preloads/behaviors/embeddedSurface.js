'use strict';

/**
 * 内嵌应用外观契约（仅 utility 角色）。
 *
 * 页面以 ?vcpEmbedded=1 打开时，说明它作为标签页嵌在主窗口的 WebContentsView 里：
 *   - 给 <html>/<body> 打上 data-vcp-embedded-app="true"，页面 CSS 可据此调整布局
 *   - 隐藏页面自带的最小化/最大化/关闭按钮，窗口控制交给主窗口
 * 关闭行为的改写在 api/window.js 的 closeWindow 里。
 */

function installEmbeddedSurface(ctx) {
    if (!ctx.isEmbeddedSurface) return;

    const mount = () => {
        // preload 执行时 <html> 可能还不存在；在 DOMContentLoaded 之前访问 documentElement
        // 出错会中断整个 preload，导致 contextBridge API 都没有暴露。
        document.documentElement?.setAttribute('data-vcp-embedded-app', 'true');
        document.body?.setAttribute('data-vcp-embedded-app', 'true');
        if (document.getElementById('vcpEmbeddedSurfaceStyle')) return;
        const style = document.createElement('style');
        style.id = 'vcpEmbeddedSurfaceStyle';
        style.textContent = `
            html[data-vcp-embedded-app="true"] :is(
                #minimize-btn, #maximize-btn, #close-btn,
                #minimize-theme-btn, #maximize-theme-btn, #close-theme-btn,
                #minimize-translator-btn, #maximize-translator-btn, #close-translator-btn
            ) { display: none; }
        `;
        (document.head || document.documentElement).append(style);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
        mount();
    }
}

module.exports = { installEmbeddedSurface };