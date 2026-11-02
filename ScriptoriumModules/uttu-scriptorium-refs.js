// 文稿、Markdown、演示里的组件引用。用户：上面放文坊下面放 Chat，右键某个元素就能引用，或者在组件上直接交给 Agent。
// 右键段落、标题、列表、表格、代码、图片、图表、Mermaid、公式、交互岛，出“复制引用 / 交给 Agent”。图表这类组件鼠标放上去时角上也有这两个按钮。
// 位置写章节、源码行和组件名：组件按自己的 id 或第几个找回源码，文字按开头一段在源码里找，找不到就只写章节。
// 网页、PDF、表格、文本、图片、白板各在自己的视图里接（uttu-scriptorium-pick.js 的 menu、reference、ask）。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    const Pick = window.UTTUScriptoriumPick;
    if (!UI?.on || !Pick) return;
    const { make, button } = UI;
    const session = () => window.UTTUScriptoriumSession;
    const COMPONENT = '[data-vdoc-island], [data-vdoc-chart], [data-vdoc-mermaid], [data-vdoc-math], [data-vdoc-object-id], table, pre, figure, img, svg';
    const TEXT = 'h1, h2, h3, h4, h5, h6, p, li, blockquote';
    const squeeze = (value) => String(value || '').replace(/\s+/g, ' ').trim();

    const roots = () => [session()?.readRoot?.(), session()?.editRoot?.()].filter(Boolean);
    function hitIn(path) {
        const root = roots().find((item) => path.includes(item));
        if (!root) return null;
        const inside = path.slice(0, path.indexOf(root)).filter((node) => node instanceof Element);
        const component = [...inside].reverse().find((node) => node.matches(COMPONENT));
        return { root, element: component || inside.find((node) => node.matches(TEXT)) || null, component: Boolean(component) };
    }
    function nameOf(element) {
        const data = element.dataset || {};
        if (element.matches('[data-vdoc-frontmatter]')) return '属性表';
        if (data.vdocChart !== undefined) return `图表 ${data.vdocIsland || ''}`.trim(); // 图表的 ID 写在岛属性上
        if (data.vdocIsland !== undefined) return `交互岛 ${data.vdocIsland}`.trim();
        if (data.vdocMermaid !== undefined) return 'Mermaid 图';
        if (data.vdocMath !== undefined) return '公式';
        if (data.vdocObjectId !== undefined) return '对象';
        const tag = element.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) return '标题';
        return { table: '表格', pre: '代码', figure: '图片', img: '图片', svg: '图形', p: '段落', li: '列表项', blockquote: '引文' }[tag] || '内容';
    }
    function sectionOf(root, element) {
        const heads = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')];
        const before = heads.filter((head) => head === element || (head.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
        const last = before.at(-1);
        return last && last !== element ? squeeze(last.textContent).slice(0, 40) : '';
    }
    function pageOf(root, element) {
        const scene = element.closest('.vdoc-slide-scene, [data-vdoc-slide]');
        if (!scene) return 0;
        return [...root.querySelectorAll('.vdoc-slide-scene, [data-vdoc-slide]')].indexOf(scene) + 1;
    }
    const lineAt = (source, index) => source.slice(0, index).split('\n').length;
    function span(source, needle, close = '') {
        const at = needle ? source.indexOf(needle) : -1;
        if (at < 0) return null;
        const stop = close ? source.indexOf(close, at + needle.length) : -1;
        const end = stop >= 0 ? stop + close.length : at + needle.length;
        return { start: lineAt(source, at), end: lineAt(source, end) };
    }
    function nthFence(source, opening, index) {
        let at = -1;
        for (let step = 0; step <= index; step += 1) {
            at = source.indexOf(opening, at + 1);
            if (at < 0) return null;
        }
        const stop = source.indexOf('\n```', at + opening.length);
        return { start: lineAt(source, at), end: lineAt(source, stop >= 0 ? stop + 4 : at) };
    }
    // 文字里的 Markdown 记号（加粗、链接）在源码里断开了，从长到短试几段。
    function textSpan(source, text) {
        const plain = squeeze(text);
        for (const size of [40, 20, 10, 6]) {
            const piece = plain.slice(0, size);
            if (piece.length < Math.min(size, 4)) continue;
            const found = span(source, piece);
            if (found) return found;
        }
        return null;
    }
    function linesOf(root, element) {
        const source = session()?.source?.() || '';
        if (!source) return null;
        const data = element.dataset || {};
        if (data.vdocChart !== undefined) return data.vdocIsland ? span(source, `\`\`\`chart ${data.vdocIsland}`, '\n```') : null;
        if (data.vdocIsland) return span(source, `data-vdoc-island="${data.vdocIsland}"`, '</div>');
        if (data.vdocMermaid !== undefined) return nthFence(source, '```mermaid', [...root.querySelectorAll('[data-vdoc-mermaid]')].indexOf(element));
        if (element.matches('pre')) return textSpan(source, element.textContent.split('\n')[0]);
        if (element.matches('img')) return span(source, (element.getAttribute('src') || '').split('/').pop());
        if (element.matches('table')) {
            // 表头那一格常常只有两三个字，按“| 表头”找；Markdown 表格多一行分隔线。
            const found = span(source, `| ${squeeze(element.querySelector('th, td')?.textContent)}`) || textSpan(source, element.querySelector('th, td')?.textContent);
            return found && { start: found.start, end: found.start + element.rows.length };
        }
        return textSpan(source, element.textContent);
    }
    function windowBox(element) {
        const box = element.getBoundingClientRect();
        const left = Math.max(0, box.left);
        const top = Math.max(0, box.top);
        return { x: left, y: top, width: Math.max(1, Math.min(innerWidth, box.right) - left), height: Math.max(1, Math.min(innerHeight, box.bottom) - top) };
    }
    function targetOf(root, element, picked = '') {
        const name = nameOf(element);
        const section = sectionOf(root, element);
        const page = pageOf(root, element);
        const lines = linesOf(root, element);
        const place = [page && `第 ${page} 页`, section && `「${section}」`, lines && (lines.start === lines.end ? `第 ${lines.start} 行` : `第 ${lines.start}–${lines.end} 行`), picked ? '选中的文字' : name].filter(Boolean).join('，');
        return { type: 'element', label: picked ? '选中的文字' : name, place, text: squeeze(picked || element.alt || element.textContent).slice(0, 80), capture: windowBox(element),
            locator: { type: 'element', tag: element.tagName.toLowerCase(), section, source: lines ? { startLine: lines.start, endLine: lines.end, approx: true } : null } };
    }
    const selected = (root) => {
        const selection = root.getSelection?.() || document.getSelection();
        return selection && !selection.isCollapsed ? selection.toString().trim() : '';
    };

    // ---------- 右键 ----------
    let lastTarget = null;
    document.addEventListener('contextmenu', (event) => {
        if (event.defaultPrevented) return; // 标题的右键菜单已经接了（uttu-scriptorium-headings.js），它自己带这两项
        const hit = hitIn(event.composedPath());
        if (!hit?.element) return;
        const editing = hit.root === session()?.editRoot?.();
        const picked = hit.component ? '' : selected(hit.root); // 组件按整体引用：右键点到图里的字时浏览器会顺手选中那个字
        lastTarget = targetOf(hit.root, hit.element, picked);
        // 所见面有选区、对象、交互岛时上游有自己的菜单，这两项加在里面（下面的 decorate）。
        if (editing && (picked || hit.element.closest('[data-vdoc-object-id], [data-vdoc-island]'))) return;
        event.preventDefault();
        event.stopPropagation();
        Pick.menu(lastTarget, { x: event.clientX, y: event.clientY }, { comment: false });
    }, true);
    function decorate(id) {
        const list = document.getElementById(id);
        if (!list) return;
        for (const [label, act] of [['复制引用', Pick.reference], ['交给 Agent', Pick.ask]]) {
            const item = make('button');
            item.type = 'button';
            item.setAttribute('role', 'menuitem');
            item.textContent = label;
            item.addEventListener('click', () => {
                list.hidden = true;
                if (lastTarget) void act(lastTarget);
            });
            list.append(item);
        }
    }
    ['text-context-menu', 'object-context-menu', 'island-context-menu'].forEach(decorate);
    // 标题的右键菜单也带上（uttu-scriptorium-headings.js）。
    function headingItems(element) {
        const root = element.getRootNode();
        return [
            { label: '复制引用', act: () => void Pick.reference(targetOf(root, element)) },
            { label: '交给 Agent', act: () => void Pick.ask(targetOf(root, element)) },
        ];
    }

    // ---------- 组件角上的按钮 ----------
    const bar = make('div', 'uttu-ref-bar uttu-ctl');
    bar.hidden = true;
    const tools = make('div', 'uttu-tbar');
    let shown = null; // { root, element }
    tools.append(button('uttu-tb-drop plain', '', '引用', () => { if (shown) void Pick.reference(targetOf(shown.root, shown.element)); }),
        button('uttu-tb-drop plain', '', '交给 Agent', () => { if (shown) void Pick.ask(targetOf(shown.root, shown.element)); }));
    bar.append(tools);
    document.body.append(bar);
    function hideBar() {
        bar.hidden = true;
        shown = null;
    }
    function place(element) {
        const box = element.getBoundingClientRect();
        bar.hidden = false;
        const top = box.top - bar.offsetHeight - 2 >= 88 ? box.top - bar.offsetHeight - 2 : box.top + 4;
        bar.style.left = `${Math.max(8, Math.min(box.right, innerWidth - 8) - bar.offsetWidth)}px`;
        bar.style.top = `${Math.round(top)}px`;
    }
    let frame = 0;
    document.addEventListener('pointermove', (event) => {
        if (frame || event.buttons) return;
        const path = event.composedPath();
        frame = requestAnimationFrame(() => {
            frame = 0;
            if (path.includes(bar)) return;
            const hit = hitIn(path);
            if (!hit?.component || hit.element.matches('table[data-vdoc-frontmatter], table[data-vdoc-frontmatter] *')) {
                hideBar();
                return;
            }
            if (shown?.element === hit.element) return;
            shown = hit;
            place(hit.element);
        });
    }, { capture: true, passive: true });
    window.addEventListener('scroll', hideBar, { capture: true, passive: true });
    window.addEventListener('blur', hideBar);
    UI.on('document', hideBar);

    window.UTTUScriptoriumRefs = Object.freeze({ headingItems, targetOf });
})();
