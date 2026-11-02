// . 文坊's previews (文脉 change previews,
// the style preview, visual objects, SVG assets) are srcdoc iframes with sandbox="" — no scripts, so the main process
// cannot put VCP's scrollbar into them (modules/uttu/scrollbarTheme.js does that for frames that run scripts). A
// long preview then drew Chromium's default light scrollbar: a white strip beside a dark document.
// Here every srcdoc this page assigns gets a small <style> with the same bar (size and inset from the VCP tokens). This
// page cannot look into the preview to see whether it is dark or light, so the thumb is the neutral mid tone
// (--uttu-scrollbar-thumb-any), visible on both. The page's CSP allows inline styles (style-src 'unsafe-inline'), and
// srcdoc documents inherit it.
(() => {
    'use strict';
    const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc');
    if (!descriptor?.set || HTMLIFrameElement.prototype.__uttuScrollbarSrcdoc) return;

    const token = (name, fallback) => {
        const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return value || fallback;
    };
    const style = () => {
        const size = token('--uttu-scrollbar-size', '12px');
        const inset = token('--uttu-scrollbar-inset', '3px');
        const thumb = token('--uttu-scrollbar-thumb-any', 'gray');
        const hover = token('--uttu-scrollbar-thumb-any-hover', 'gray');
        return '<style data-uttu-scrollbar>'
            + 'html,*{scrollbar-width:auto!important;scrollbar-color:auto!important}'
            + `::-webkit-scrollbar{width:${size}!important;height:${size}!important}`
            + '::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent!important}'
            + `::-webkit-scrollbar-thumb{min-height:28px;min-width:28px;border:${inset} solid transparent!important;`
            + `background:${thumb} padding-box!important}`
            + `::-webkit-scrollbar-thumb:hover{background:${hover} padding-box!important}`
            + '::-webkit-scrollbar-button{display:none!important;width:0!important;height:0!important}'
            + '</style>';
    };
    // After <head ...> when there is one, else after the doctype (a <style> before it would switch on quirks mode).
    const withScrollbar = (html) => {
        const text = String(html ?? '');
        if (!text || text.includes('data-uttu-scrollbar')) return text;
        const head = text.match(/<head\b[^>]*>/i);
        if (head) return text.slice(0, head.index + head[0].length) + style() + text.slice(head.index + head[0].length);
        const doctype = text.match(/^\s*<!doctype[^>]*>/i);
        const at = doctype ? doctype[0].length : 0;
        return text.slice(0, at) + style() + text.slice(at);
    };

    Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
        ...descriptor,
        set(value) { descriptor.set.call(this, withScrollbar(value)); },
    });
    Object.defineProperty(HTMLIFrameElement.prototype, '__uttuScrollbarSrcdoc', { value: true });
})();
