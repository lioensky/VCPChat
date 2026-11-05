'use strict';
((root, factory) => {
    const value = factory();
    if (typeof module === 'object' && module.exports) module.exports = value;
    if (root) root.ScriptoriumBoardModel = value;
})(typeof window === 'undefined' ? null : window, () => {
    const MAX_SOURCE = 512 * 1024;
    function source(value) {
        if (typeof value !== 'string') throw new Error('HTML 节点 source 必须是字符串。');
        if (new TextEncoder().encode(value).length > MAX_SOURCE) throw new Error('HTML 节点源码超过 512 KB。');
        return value;
    }
    function htmlNode(value = {}) {
        const width = Number(value.width ?? 480);
        const height = Number(value.height ?? 320);
        if (![width, height].every((v) => Number.isFinite(v) && v >= 80 && v <= 4096)) {
            throw new Error('HTML 节点宽高必须在 80 至 4096 之间。');
        }
        return {
            version: 1,
            title: String(value.title || 'HTML 动画').slice(0, 160),
            source: source(value.source ?? ''),
            width,
            height,
        };
    }
    // 所有替换基于原始快照；零命中、多命中或重叠一律拒绝，失败不产生部分修改。
    function patchSource(original, replacements) {
        source(original);
        if (!Array.isArray(replacements) || !replacements.length) throw new Error('replacements 必须是非空数组。');
        const edits = replacements.map((item) => {
            if (typeof item?.target !== 'string' || !item.target) throw new Error('target 不能为空。');
            if (typeof item.replace !== 'string') throw new Error('replace 必须是字符串。');
            const start = original.indexOf(item.target);
            if (start < 0) throw new Error('节点源码中找不到 target。');
            if (original.indexOf(item.target, start + 1) >= 0) throw new Error('target 不唯一，请提供更多上下文。');
            return { start, end: start + item.target.length, replace: item.replace };
        }).sort((a, b) => a.start - b.start);
        for (let i = 1; i < edits.length; i += 1) {
            if (edits[i].start < edits[i - 1].end) throw new Error('源码替换区间重叠。');
        }
        let result = original;
        for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.replace + result.slice(edit.end);
        return source(result);
    }
    function attribute(value) {
        return String(value).replace(/[&"<]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;' }[c]));
    }
    // iframe 必须同时使用 sandbox="allow-scripts"，严禁 allow-same-origin。
    // 经 scriptorium-page 独立协议响应运行；Blob/srcdoc 会继承宿主 CSP，不用于执行节点脚本。
    // CSP 禁止联网、子框架、表单及任意文件资源。
    function sandboxDocument(value) {
        const text = source(value);
        const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
        return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${attribute(csp)}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;width:100%;height:100%;min-height:100%;overflow:hidden;background:transparent}*{box-sizing:border-box}</style></head><body>${text}</body></html>`;
    }
    function sceneSnapshot(scene) {
        const { vcpBoard, ...base } = scene;
        return JSON.parse(JSON.stringify(base));
    }
    return Object.freeze({ MAX_SOURCE, source, htmlNode, patchSource, sandboxDocument, sceneSnapshot });
});