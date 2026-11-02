'use strict';
// 网页批注。
// BRIDGE：网页载入后主进程注入网页框的脚本，问“这个位置是哪个元素”，右键时告诉文坊页面。不写进网页文件；批注模式的点击、悬停由文坊页面盖在框上的一层接住，网页本身收不到。
// locate：元素反查源码行。只靠“第几个子元素”不行：脚本往前面插一个元素，后面全错位（实测）。
// 所以用 parse5 的位置信息，按标签、id、class、文字比对；脚本生成的元素找不到，回 null；完全相同的元素取路径最近的，标 approx。
// 修改模式：BRIDGE 还能按路径改样式、在框里改字。文件由文坊页面写，这里只动框里的。
const fs = require('fs');

const BRIDGE = `(() => {
    if (window.__uttuPickBridge) return true;
    window.__uttuPickBridge = true;
    // 焦点在网页里时文坊的快捷键到不了文坊页面，传出去。
    const OURS = new Set(['f', 'h', 'p', 'w', 't', 'tab']);
    window.addEventListener('keydown', (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || !OURS.has(event.key.toLowerCase())) return;
        event.preventDefault();
        window.parent.postMessage({ uttuFrameKey: { key: event.key, shiftKey: event.shiftKey } }, '*');
    }, true);
    const pathOf = (el) => {
        const steps = [];
        for (let node = el; node && node.parentElement; node = node.parentElement) steps.unshift([...node.parentElement.children].indexOf(node));
        return steps;
    };
    const selectorOf = (el) => {
        const parts = [];
        for (let node = el; node && node.nodeType === 1 && node !== document.body && parts.length < 5; node = node.parentElement) {
            if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
            const same = [...(node.parentElement?.children || [])].filter((item) => item.tagName === node.tagName);
            const cls = typeof node.className === 'string' && node.className.trim() ? '.' + CSS.escape(node.className.trim().split(/\\s+/)[0]) : '';
            parts.unshift(node.tagName.toLowerCase() + cls + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : ''));
        }
        return parts.join(' > ');
    };
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const squeeze = (text) => String(text || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    const NO_TEXT = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr|iframe|canvas|video|audio|svg|select|textarea|script|style)$/;
    const describe = (el) => {
        const css = getComputedStyle(el);
        return { tag: el.tagName.toLowerCase(), id: el.id || '', className: typeof el.className === 'string' ? el.className : '',
            selector: selectorOf(el), path: pathOf(el), rect: box(el), text: squeeze(el.innerText || el.textContent), raw: squeeze(el.textContent),
            look: { color: css.color, background: css.backgroundColor, size: css.fontSize, translate: css.translate }, canText: !NO_TEXT.test(el.tagName.toLowerCase()) };
    };
    const byPath = (path) => {
        let node = document.documentElement;
        for (const index of path || []) node = node?.children[index];
        return node || null;
    };
    // 在框里改字：回车或点开算改好，Esc 算了，Shift 回车换行。
    let writing = null;
    const finish = (keep) => {
        if (!writing) return;
        const { el, before, editable } = writing;
        writing = null;
        if (editable === null) el.removeAttribute('contenteditable');
        else el.setAttribute('contenteditable', editable);
        if (!keep) el.innerHTML = before;
        window.getSelection()?.removeAllRanges();
        window.parent.postMessage({ uttuPickEdited: { html: keep && el.innerHTML !== before ? el.innerHTML : null } }, '*');
    };
    window.addEventListener('keydown', (event) => {
        if (!writing) return;
        event.stopPropagation();
        if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) {
            event.preventDefault();
            finish(event.key === 'Enter');
        }
    }, true);
    window.addEventListener('blur', () => finish(true));
    document.addEventListener('click', (event) => { if (writing) event.preventDefault(); }, true);
    const write = (el) => {
        writing = { el, before: el.innerHTML, editable: el.getAttribute('contenteditable') };
        el.setAttribute('contenteditable', 'plaintext-only');
        el.addEventListener('blur', () => finish(true), { once: true });
        window.focus();
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
    };
    const answer = (ask) => {
        if (ask.kind === 'at') {
            const el = document.elementFromPoint(ask.x, ask.y);
            return el && el !== document.documentElement && el !== document.body ? describe(el) : null;
        }
        if (ask.kind === 'in') {
            const hit = [...document.body.querySelectorAll('*')].filter((el) => {
                if (el.children.length && el.innerText?.trim() !== el.textContent?.trim()) return false;
                const r = el.getBoundingClientRect();
                return r.width && r.height && r.x < ask.x + ask.width && r.x + r.width > ask.x && r.y < ask.y + ask.height && r.y + r.height > ask.y;
            }).filter((el) => !el.children.length || !el.querySelector('*:not(br, b, i, em, strong, span)'));
            return hit.slice(0, 6).map(describe);
        }
        if (ask.kind === 'scroll') { window.scrollBy(ask.dx || 0, ask.dy || 0); return true; }
        if (ask.kind === 'describe' || ask.kind === 'parent' || ask.kind === 'style' || ask.kind === 'write') {
            const el = byPath(ask.path);
            if (!el) return null;
            if (ask.kind === 'write') return write(el);
            if (ask.kind === 'style') for (const [name, value] of Object.entries(ask.props || {})) { if (value) el.style.setProperty(name, value); else el.style.removeProperty(name); }
            if (ask.kind === 'parent') return el.parentElement && el.parentElement !== document.documentElement && el.parentElement !== document.body ? describe(el.parentElement) : null;
            return describe(el);
        }
        if (ask.kind === 'scrollTo') { window.scrollTo(ask.x || 0, ask.y || 0); return true; }
        if (ask.kind === 'rects') {
            return ask.selectors.map((selector) => {
                try { const el = document.querySelector(selector); return el ? box(el) : null; } catch (_) { return null; }
            });
        }
        return null;
    };
    window.addEventListener('message', (event) => {
        const ask = event.data?.uttuPick;
        if (!ask || event.source !== window.parent) return;
        window.parent.postMessage({ uttuPickAnswer: { id: ask.id, answer: answer(ask), scroll: { x: window.scrollX, y: window.scrollY } } }, '*');
    });
    window.addEventListener('scroll', () => window.parent.postMessage({ uttuPickScroll: { x: window.scrollX, y: window.scrollY } }, '*'), { passive: true, capture: true });
    // 右键一个元素：告诉文坊页面，它弹“复制引用 / 交给 Agent”。
    document.addEventListener('contextmenu', (event) => {
        const el = event.target;
        if (!(el instanceof Element) || el === document.documentElement || el === document.body) return;
        event.preventDefault();
        window.parent.postMessage({ uttuPickContext: { x: event.clientX, y: event.clientY } }, '*');
    }, true);
    return true;
})()`;

const textOf = (node) => (node.childNodes || []).map((child) => (child.nodeName === '#text' ? child.value : textOf(child))).join('');
const attr = (node, name) => node.attrs.find((item) => item.name === name)?.value || '';
function elementsOf(node, list = [], trail = []) {
    (node.childNodes || []).filter((child) => child.tagName).forEach((child, index) => {
        const next = [...trail, index];
        list.push({ node: child, trail: next });
        elementsOf(child, list, next);
    });
    return list;
}
const distance = (a, b) => {
    let same = 0;
    while (same < a.length && same < b.length && a[same] === b[same]) same += 1;
    return a.length + b.length - 2 * same;
};
const squeeze = (text) => text.trim().replace(/\s+/g, ' ').slice(0, 60);

// exact：只有一个对得上，或者路径和页面里的完全一样。
function find(text, picked) {
    const tree = require('parse5').parse(text, { sourceCodeLocationInfo: true });
    const same = elementsOf(tree).filter((item) => item.node.sourceCodeLocation && item.node.tagName === picked.tag
        && attr(item.node, 'id') === (picked.id || '') && attr(item.node, 'class').trim() === String(picked.className || '').trim());
    // 有 id 的就是它；别的再比文字，文字改过（脚本填的）也算没找到。raw 是没按显示算的文字：藏着的字、<br> 两边不会多算。
    const wanted = [picked.text, picked.raw].filter((item) => item !== undefined).map((item) => squeeze(String(item)));
    const pool = picked.id ? same : same.filter((item) => wanted.includes(squeeze(textOf(item.node))));
    if (!pool.length) return null;
    const path = [0, ...(picked.path || [])]; // 解析树从 <html> 那一层算起，网页里的路径从它下面算起
    const best = pool.reduce((a, b) => (distance(a.trail, path) <= distance(b.trail, path) ? a : b));
    return { node: best.node, approx: pool.length > 1, exact: pool.length === 1 || distance(best.trail, path) === 0 };
}

async function locate(file, picked) {
    const { text } = require('../textEncoding').decodeText(await fs.promises.readFile(file));
    const hit = find(text, picked);
    if (!hit) return null;
    const where = hit.node.sourceCodeLocation;
    return { startLine: where.startLine, endLine: where.endLine, approx: hit.approx };
}

module.exports = { BRIDGE, find, locate };
