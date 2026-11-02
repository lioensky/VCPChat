'use strict';
// 网页里查找。网页框是 sandbox，文坊页面碰不到里面的字，主进程把这段放进框里跑（和批注的 ./pick.js 一样）。
// 按字面找、不分大小写，跨标签的字不算一处。高亮用 CSS Custom Highlight，不改动网页的 DOM；样式走 adoptedStyleSheets，网页的 CSP 管不到。
// 回 { total, at, items }：总数、当前第几处、每处的上下文（最多 HIT_LIMIT 处）。query 为空时清掉高亮。
const HIT_LIMIT = 500;

function script(query, index) {
    return `(() => {
    const query = ${JSON.stringify(String(query || ''))}.toLocaleLowerCase();
    const index = ${Math.max(0, Number(index) || 0)};
    if (!window.__uttuFindSheet) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync('::highlight(uttu-find) { background: #ffe08a; color: #1b1712; } ::highlight(uttu-find-now) { background: #f0a040; color: #1b1712; }');
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        window.__uttuFindSheet = sheet;
    }
    CSS.highlights.delete('uttu-find');
    CSS.highlights.delete('uttu-find-now');
    if (!query || !document.body) return { total: 0, at: -1, items: [] };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.parentElement?.closest('style, script, noscript, template') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const heads = [...document.querySelectorAll('h1, h2, h3')];
    const ranges = [];
    const items = [];
    let headAt = -1;
    let total = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const lower = node.nodeValue.toLocaleLowerCase();
        for (let at = lower.indexOf(query); at >= 0; at = lower.indexOf(query, at + query.length)) {
            total += 1;
            if (ranges.length >= ${HIT_LIMIT}) continue;
            const range = new Range();
            range.setStart(node, at);
            range.setEnd(node, at + query.length);
            ranges.push(range);
            while (headAt + 1 < heads.length && (heads[headAt + 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING || heads[headAt + 1].contains(node))) headAt += 1;
            items.push({ heading: heads[headAt]?.textContent.trim().slice(0, 40) || '开头', before: node.nodeValue.slice(Math.max(0, at - 16), at), after: node.nodeValue.slice(at + query.length, at + query.length + 22) });
        }
    }
    if (!ranges.length) return { total: 0, at: -1, items: [] };
    const at = Math.min(index, ranges.length - 1);
    const current = ranges[at];
    CSS.highlights.set('uttu-find', new Highlight(...ranges.filter((range) => range !== current)));
    CSS.highlights.set('uttu-find-now', new Highlight(current));
    current.startContainer.parentElement?.scrollIntoView({ block: 'center' });
    return { total, at, items };
})()`;
}

module.exports = { script, HIT_LIMIT };
