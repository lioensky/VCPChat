/**
 * modules/ui-system/side-pane/terminalTheme.js
 * 侧栏终端的 xterm 配色：底色 / 前景 / 光标跟随当前主题变量，16 色 ANSI 调色板按明暗两套给出，
 * 避免 xterm 默认调色板（为深色底设计）在浅色主题里出现看不清的黄色 / 白色。
 *
 * 调色板取自 ZCode `packages/ui/src/styles.css` 的 `--color-terminal-*`（浅色 / 深色），
 * 颜色规范化的思路来自 `terminal/terminalTheme.ts`（zai-org/ZCode，Apache-2.0）：
 * xterm 不认 `var()` / `color-mix()` / 新语法 `rgb(r g b / a)`，所以颜色先交给 CSS 计算，再经 canvas 规范成 `rgba(r, g, b, a)`。
 */

'use strict';

export const LIGHT_PALETTE = Object.freeze({
    black: '#5c5c5c', red: '#e03131', green: '#1e8a3e', yellow: '#e07b00',
    blue: '#0b7fff', magenta: '#9e77ed', cyan: '#0aa7a7', white: '#adadad',
    brightBlack: '#888888', brightRed: '#e03131', brightGreen: '#1e8a3e', brightYellow: '#e07b00',
    brightBlue: '#0066dd', brightMagenta: '#9e77ed', brightCyan: '#0aa7a7', brightWhite: '#0d0d0d'
});

export const DARK_PALETTE = Object.freeze({
    black: '#262626', red: '#dc2626', green: '#16a34a', yellow: '#ca8a04',
    blue: '#0284c7', magenta: '#c026d3', cyan: '#0891b2', white: '#e5e5e5',
    brightBlack: '#737373', brightRed: '#dc2626', brightGreen: '#16a34a', brightYellow: '#ca8a04',
    brightBlue: '#0284c7', brightMagenta: '#c026d3', brightCyan: '#0891b2', brightWhite: '#fafafa'
});

export function isLightTheme(doc) {
    const body = doc?.body;
    return body?.getAttribute('data-vcp-theme') === 'light' || Boolean(body?.classList?.contains('light-theme'));
}

/** 把浏览器算好的颜色（rgb() / color() / oklab() 等）经 canvas 规范成 xterm 能读的 rgba()；没有 canvas（测试环境）时原样返回。 */
export function normalizeCssColor(doc, raw, fallback) {
    if (!raw) return fallback;
    try {
        const canvas = doc.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext?.('2d', { willReadFrequently: true });
        if (!ctx) return raw;
        ctx.globalCompositeOperation = 'copy';
        ctx.fillStyle = '#000';
        ctx.fillStyle = raw;
        ctx.fillRect(0, 0, 1, 1);
        const [r = 0, g = 0, b = 0, a = 255] = ctx.getImageData(0, 0, 1, 1).data;
        return `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
    } catch (_error) {
        return fallback;
    }
}

// 外框没有底色时用的兜底色
export const LIGHT_FALLBACK_BG = '#fafafa';
export const DARK_FALLBACK_BG = '#14161a';

const isTransparent = (value) => !value || value === 'transparent' || /^rgba\([^)]*,\s*0\)$/.test(value);

export function buildTerminalTheme(doc, element) {
    const light = isLightTheme(doc);
    // 底色和前景由 CSS（.side-terminal-screen 的 background / color）决定，这里只读浏览器算好的结果，
    // 保证 xterm 画布和外框同色，主题切换时也跟着变。
    const computed = element ? doc.defaultView.getComputedStyle(element) : null;
    const background = isTransparent(computed?.backgroundColor) ? (light ? LIGHT_FALLBACK_BG : DARK_FALLBACK_BG) : normalizeCssColor(doc, computed.backgroundColor, light ? LIGHT_FALLBACK_BG : DARK_FALLBACK_BG);
    const foreground = computed?.color ? normalizeCssColor(doc, computed.color, light ? '#1f2937' : '#d4d4d8') : (light ? '#1f2937' : '#d4d4d8');
    return {
        ...(light ? LIGHT_PALETTE : DARK_PALETTE),
        background,
        foreground,
        cursor: foreground,
        cursorAccent: background,
        selectionBackground: light ? 'rgba(11, 127, 255, 0.22)' : 'rgba(2, 132, 199, 0.32)',
        selectionInactiveBackground: light ? 'rgba(13, 13, 13, 0.1)' : 'rgba(115, 115, 115, 0.22)'
    };
}
