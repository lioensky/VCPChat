// 标题的右键菜单。
// 左栏“篇章”里的一行、阅读面里的标题（h1–h3）右键：
//   复制到这一节的链接（“文件名.md#锚点”，锚点小写、空格变 -、去掉标点，中文照原样，和 GitHub 基本一样；粘到别的 .md 里就能跳过来）；
//   复制标题文字；把这一节交给 Agent（这一节的原文——到下一个同级或更高级的标题为止，最多 2000 字——放进对话输入框，人看过再发，
//   和选中文字的“问”同一条路 scriptoriumAPI.askAgent）。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;
    const session = () => window.UTTUScriptoriumSession;
    const plain = (text) => String(text).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').trim();
    // 和文坊自己跳锚点的写法一样（uttu-scriptorium-markdown.js scrollToAnchor）：小写、连着的空白变一个 -、去掉标点。
    const slug = (text) => plain(text).toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '');
    const nameOf = (file) => String(file || '').split(/[\\/]/).pop() || '';

    // 源码里的标题（代码块里的 # 不算），带行号和级别。
    function headings(source) {
        const list = [];
        let fence = false;
        source.split('\n').forEach((line, index) => {
            if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
            if (fence) return;
            const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
            if (match) list.push({ level: match[1].length, text: plain(match[2]), line: index });
        });
        return list;
    }
    // 这一节的原文：从这个标题到下一个同级或更高级的标题。
    function sectionText(source, heading) {
        const lines = source.split('\n');
        const all = headings(source);
        const next = all.find((item) => item.line > heading.line && item.level <= heading.level);
        return lines.slice(heading.line, next ? next.line : lines.length).join('\n').trim();
    }
    function findHeading(text) {
        const source = session()?.source?.() || '';
        const wanted = plain(text);
        const heading = headings(source).find((item) => item.text === wanted);
        return heading ? { source, heading } : null;
    }

    async function copy(text, done) {
        try {
            await navigator.clipboard.writeText(text);
        } catch (_) {
            const area = document.createElement('textarea');
            area.value = text;
            document.body.append(area);
            area.select();
            document.execCommand('copy');
            area.remove();
        }
        UI.toast(done);
    }
    function menu(text, anchor, element = null) {
        const doc = UI.doc();
        if (!doc || doc.kind === 'web-page') return false;
        const found = findHeading(text);
        const items = [{ grp: plain(text) || '标题' }, ...(element ? window.UTTUScriptoriumRefs?.headingItems(element) || [] : [])];
        if (/\.(md|markdown)$/i.test(doc.filePath || '')) {
            items.push({ label: '复制到这一节的链接', act: () => void copy(`${nameOf(doc.filePath)}#${slug(text)}`, '复制了到这一节的链接。') });
        }
        items.push({ label: '复制标题文字', act: () => void copy(plain(text), '复制了标题。') });
        if (typeof window.scriptoriumAPI?.askAgent === 'function') {
            items.push({ label: '把这一节交给 Agent', hint: '放进对话输入框', disabled: !found, act: () => {
                const body = sectionText(found.source, found.heading);
                void window.scriptoriumAPI.askAgent({
                    text: body.length > 2000 ? `${body.slice(0, 2000)}\n（后面还有，没带上）` : body,
                    docName: document.getElementById('document-title')?.textContent || nameOf(doc.filePath),
                    section: found.heading.text,
                });
            } });
        }
        UI.openMenu(items, anchor);
        return true;
    }

    document.addEventListener('contextmenu', (event) => {
        const path = event.composedPath();
        const row = path.find((node) => node?.parentElement?.classList?.contains('uttu-outline-list') && node.tagName === 'BUTTON');
        const heading = row ? null : path.find((node) => /^H[1-3]$/.test(node?.tagName || '') && node.getRootNode?.() === session()?.readRoot?.());
        const target = row || heading;
        if (!target) return;
        if (!menu(target.textContent, { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY }, heading)) return;
        event.preventDefault();
        event.stopPropagation();
    }, true);

    window.UTTUScriptoriumHeadings = Object.freeze({ slug, sectionText, headings, menu });
})();
