// 文坊编辑栏的工具条、选区浮条、插入菜单和空行打 /。
// 工具条和浮条的格式按钮带上游的 data-command：在上游初始化之前建好，由上游格式控制器绑定点击、同步按下和可用状态。
// 段落类型、链接、插入走文稿源码（Markdown 混合源码），经 UTTUScriptoriumSession 改。
(() => {
    'use strict';

    const UI = window.UTTUScriptoriumUI;
    if (!UI) return;
    const { $, icon, make, button, escapeHtml, session } = UI;

    // 插入菜单：空行打 / 和“插入”按钮共用一份。
    const INSERTS = [
        { id: 'h2', gl: 'H2', name: '标题', hint: '##', md: '## 新的一节' },
        { id: 'h3', gl: 'H3', name: '小标题', hint: '###', md: '### 小标题' },
        { id: 'list', icon: 'i-list', name: '列表', hint: '-', md: '- 要点' },
        { id: 'number', icon: 'i-list-num', name: '编号', hint: '1.', md: '1. 第一步' },
        { id: 'quote', gl: '“', name: '引述', hint: '>', md: '> 引述' },
        { id: 'table', icon: 'i-table', name: '表格', hint: '3 × 3', md: '| 列一 | 列二 | 列三 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n| 内容 | 内容 | 内容 |' },
        // .md 里插的图存到旁边的 assets/、插相对链接（uttu-scriptorium-assets.js）；工程照旧走上游。
        { id: 'image', icon: 'i-image', name: '图片', hint: '本地或链接', act: () => window.UTTUScriptoriumAssets?.choose?.() || UI.forward('insert-media-btn') },
        // 链到工作区里的另一份文件，插相对链接（uttu-scriptorium-linkpick.js）。
        { id: 'filelink', icon: 'i-link', name: '链接到文件', hint: '工作区里的', act: (replaceBefore) => window.UTTUScriptoriumLinkPick?.insertLink?.(replaceBefore) },
        { id: 'code', icon: 'i-code', name: '代码', hint: '```', md: '```js\n// 代码\n```' },
        { id: 'mermaid', icon: 'i-diagram', name: 'Mermaid 图', hint: '流程、时序、饼图', md: '```mermaid\nflowchart LR\n  A[开始] --> B[处理] --> C[结束]\n```' },
        // 数据图表块：data 以外是图形，data 一行一条；图 ID 不能重复。
        { id: 'chart', icon: 'i-chart', name: '数据图表', hint: '只改数据就更新', md: () => [
            '```chart chart-' + Date.now().toString(36),
            '{',
            '  "type": "bar",',
            '  "title": "新图表",',
            '  "x": "name",',
            '  "series": [{ "key": "value", "name": "数值" }],',
            '  "data": [',
            '    { "name": "一", "value": 30 },',
            '    { "name": "二", "value": 50 },',
            '    { "name": "三", "value": 40 }',
            '  ]',
            '}',
            '```',
        ].join('\n') },
        { id: 'math', gl: 'Σ', name: '公式', hint: 'LaTeX', md: '$$\na^2 + b^2 = c^2\n$$' },
        { id: 'island', icon: 'i-island', name: '交互岛', hint: '脚本、动画', md: () => '<div data-vdoc-island="island-' + Date.now().toString(36) + '">\n  <p>在这里写交互内容</p>\n</div>' },
        { id: 'svg', gl: 'SVG', name: '图形', hint: 'SVG 资产库', act: () => UI.forward('svg-asset-picker-btn') },
    ];
    // 上游连续文稿没有显式分页符，菜单里不放“分页”。
    const insertItems = () => INSERTS;
    const markdownOf = (item) => (typeof item.md === 'function' ? item.md() : item.md);

    // --- 工具条（建在编辑栏头里）---
    const tools = UI.paneTools();
    const sep = () => make('span', 'uttu-tb-sep');
    function cmd(command, label, html, className = 'uttu-tb') {
        const element = button(className, label, html);
        element.dataset.command = command;
        return element;
    }
    function group(optional, ...children) {
        const wrap = make('span', optional ? 'tgrp opt' : 'tgrp');
        wrap.append(...children);
        return wrap;
    }

    const blockButton = button('uttu-tb-drop', '段落', `<span>正文</span>${icon('i-chevron')}`, () => UI.toggleMenu(blockButton, blockItems));
    blockButton.setAttribute('aria-expanded', 'false');
    const linkButton = () => button('uttu-tb', '链接', icon('i-link'), () => openLink());
    const insertButton = (label = '插入') => {
        const element = button('uttu-tb-drop', label, `${icon('i-plus', 'lead')}<span>${label}</span>`);
        element.setAttribute('aria-expanded', 'false');
        element.addEventListener('click', () => UI.toggleMenu(element, menuInsertItems, { mode: 'insert', glyphs: true }));
        return element;
    };
    const moreButton = button('uttu-tb more', '更多格式', icon('i-more'), () => UI.toggleMenu(moreButton, () => [
        { label: '撤销', k: 'Ctrl Z', act: () => session()?.format?.('undo') },
        { label: '重做', k: 'Ctrl Y', act: () => session()?.format?.('redo') },
        { sep: true },
        { label: '下划线', k: 'Ctrl U', act: () => session()?.format?.('underline') },
        { label: '删除线', act: () => session()?.format?.('strikethrough') },
        { label: '编号', act: () => session()?.format?.('numbered-list') },
        { label: '链接', k: 'Ctrl K', act: () => openLink() },
    ], { alignRight: true }));
    moreButton.setAttribute('aria-expanded', 'false');

    const wysiwygBar = make('div', 'uttu-tbar');
    wysiwygBar.dataset.for = 'wysiwyg';
    wysiwygBar.append(
        group(true, cmd('undo', '撤销', icon('i-undo')), cmd('redo', '重做', icon('i-redo')), sep()),
        blockButton, sep(),
        cmd('bold', '粗体', 'B', 'uttu-tb g b'),
        cmd('italic', '斜体', 'I', 'uttu-tb g i'),
        group(true, cmd('underline', '下划线', 'U', 'uttu-tb g u'), cmd('strikethrough', '删除线', 'S', 'uttu-tb g s')),
        sep(),
        cmd('bullet-list', '列表', icon('i-list')),
        group(true, cmd('numbered-list', '编号', icon('i-list-num')), linkButton()),
        sep(),
        insertButton(),
        moreButton,
    );

    const wrapToggle = button('uttu-tb-drop plain', '', '自动换行', () => {
        const box = $('source-wrap-toggle');
        if (box) box.click();
        syncWrap();
    });
    function syncWrap() {
        wrapToggle.setAttribute('aria-pressed', String($('source-wrap-toggle')?.checked !== false));
    }
    // 栏窄时这几个收进 ⋯（uttu-scriptorium.css 的容器查询），和所见工具条的“更多格式”一样。
    const collapsible = (...children) => {
        const wrap = make('span', 'tgrp opt-s');
        wrap.append(...children);
        return wrap;
    };
    const moreMenu = (label, items) => {
        const element = button('uttu-tb more', label, icon('i-more'), () => UI.toggleMenu(element, items, { alignRight: true }));
        element.setAttribute('aria-expanded', 'false');
        return element;
    };
    const sourceBar = make('div', 'uttu-tbar');
    sourceBar.dataset.for = 'source';
    sourceBar.append(
        collapsible(button('uttu-tb-drop plain', '', '格式化', () => UI.forward('format-source-btn')), wrapToggle),
        insertButton(),
        make('span', 'grow'),
        make('span', 'note-s', 'Markdown'),
        moreMenu('更多', () => [
            { label: '格式化', act: () => UI.forward('format-source-btn') },
            { label: $('source-wrap-toggle')?.checked === false ? '打开自动换行' : '关掉自动换行', act: () => wrapToggle.click() },
        ]),
    );

    const cssLabel = make('span', 'note-s');
    const cssBar = make('div', 'uttu-tbar');
    cssBar.dataset.for = 'css';
    cssBar.append(cssLabel, make('span', 'grow'),
        collapsible(button('uttu-tb-drop plain', '', '恢复内置样式', () => UI.emit('reset-css'))),
        moreMenu('更多', () => [{ label: '恢复内置样式', act: () => UI.emit('reset-css') }]));
    UI.setCssLabel = (text) => UI.setText(cssLabel, text);
    tools?.append(wysiwygBar, sourceBar, cssBar);

    function syncBars() {
        const kind = UI.editorKind();
        wysiwygBar.hidden = kind !== 'wysiwyg';
        sourceBar.hidden = kind !== 'source';
        cssBar.hidden = kind !== 'css';
        // 演示的每一页是 HTML 场景，没有 Markdown 段落类型和插入。
        const deck = UI.isDeck();
        blockButton.hidden = deck;
        wysiwygBar.querySelectorAll('.uttu-tb-drop:not([data-command])').forEach((element) => {
            if (element !== blockButton) element.hidden = deck;
        });
        syncWrap();
    }

    // --- 段落类型：改光标所在那一行的 Markdown 前缀 ---
    const BLOCK_TYPES = [
        ['p', '正文', ''],
        ['h1', '大标题', '# '],
        ['h2', '标题', '## '],
        ['h3', '小标题', '### '],
        ['quote', '引述', '> '],
    ];
    function caretLine() {
        // 光标不在编辑面里时上游给的插入点是文末，不能当成“当前这一行”。
        if (!rootSelection()) return null;
        const api = session();
        const source = api?.source?.();
        const offset = Number(api?.insertionOffset?.());
        if (source === null || source === undefined || !Number.isFinite(offset)) return null;
        const start = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const endAt = source.indexOf('\n', offset);
        const end = endAt < 0 ? source.length : endAt;
        return { source, start, end, text: source.slice(start, end) };
    }
    function blockTypeOf(text) {
        const heading = text.match(/^(#{1,6})\s/);
        if (heading) return heading[1].length === 1 ? 'h1' : heading[1].length === 2 ? 'h2' : 'h3';
        if (/^>\s?/.test(text)) return 'quote';
        if (/^\s*[-*+]\s/.test(text)) return 'list';
        if (/^\s*\d+\.\s/.test(text)) return 'number';
        return 'p';
    }
    const BLOCK_NAMES = { p: '正文', h1: '大标题', h2: '标题', h3: '小标题', quote: '引述', list: '列表', number: '编号' };
    function blockItems() {
        const line = caretLine();
        const current = line ? blockTypeOf(line.text) : 'p';
        return BLOCK_TYPES.map(([id, label, prefix]) => ({
            label,
            check: id === current,
            disabled: !line,
            act: () => setBlockType(prefix),
        }));
    }
    function setBlockType(prefix) {
        const line = caretLine();
        if (!line) return;
        const bare = line.text.replace(/^(#{1,6}\s+|>\s?)/, '');
        const next = `${line.source.slice(0, line.start)}${prefix}${bare}${line.source.slice(line.end)}`;
        session()?.replaceSource?.(next, 'uttu-block-type');
    }
    function blockLabel() {
        const line = caretLine();
        return BLOCK_NAMES[line ? blockTypeOf(line.text) : 'p'] || '正文';
    }
    function syncBlockLabel() {
        if (blockButton.hidden) return;
        UI.setText(blockButton.querySelector('span'), blockLabel());
    }
    // 检查器“格式”页的段落下拉也用这一份。
    UI.blockItems = blockItems;
    UI.blockLabel = blockLabel;

    // --- 插入 ---
    function insert(item, replaceBefore) {
        if (item.act) {
            item.act(replaceBefore); // 空行打的“/查询词”交给它一起换掉（链接到文件）
            return;
        }
        if (UI.editorKind() === 'source') {
            const editor = session()?.sourceEditor?.();
            if (!editor) return;
            editor.replaceSelection(`\n\n${markdownOf(item)}\n\n`);
            editor.focus();
            return;
        }
        session()?.insertMarkdown?.(markdownOf(item), replaceBefore ? { replaceBefore } : {});
    }
    function menuInsertItems() {
        return insertItems().map((item) => ({ label: item.name, gl: item.gl, icon: item.icon, hint: item.hint, act: () => insert(item) }));
    }

    // --- 编辑面里的选区和光标（编辑面在 #page-stream 的影子根里）---
    function editRoot() {
        return session()?.editRoot?.() || $('page-stream')?.shadowRoot || null;
    }
    // 预览时从阅读面取选区。
    const reading = () => UI.view() === 'preview';
    function rootSelection() {
        const root = reading() ? session()?.readRoot?.() : editRoot();
        if (!root || (reading() ? !$('read-host')?.getClientRects().length : $('render-host')?.hidden)) return null;
        const selection = root.getSelection?.() || document.getSelection();
        if (!selection || !selection.rangeCount) return null;
        const range = selection.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer)) return null;
        return { root, selection, range };
    }
    function blockOf(node) {
        const element = node?.nodeType === 1 ? node : node?.parentElement;
        return element?.closest?.('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th') || null;
    }
    function sectionOf(root, range) {
        let section = '';
        for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
            const before = heading.contains(range.startContainer)
                || (heading.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING);
            if (!before) break;
            section = heading.textContent.trim();
        }
        return section;
    }

    // --- 选区浮条：粗斜下删、链接、批注、问 ---
    const bubble = make('div', 'uttu-bubble uttu-ctl');
    bubble.hidden = true;
    const bubbleTools = make('div', 'uttu-tbar');
    const askButton = button('uttu-tb-drop plain', '', '问', () => ask());
    const commentButton = button('uttu-tb-drop plain', '', '批注', () => comment());
    bubbleTools.append(
        cmd('bold', '粗体', 'B', 'uttu-tb g b'),
        cmd('italic', '斜体', 'I', 'uttu-tb g i'),
        cmd('underline', '下划线', 'U', 'uttu-tb g u'),
        cmd('strikethrough', '删除线', 'S', 'uttu-tb g s'),
        linkButton(),
        sep(),
        commentButton,
        askButton,
    );
    // 链接：浮条换成一个地址输入框，回车确定，Esc 放弃。.md 还能选文件，填相对路径。
    const linkForm = make('form', 'uttu-link-form');
    linkForm.hidden = true;
    linkForm.innerHTML = '<label class="uttu-search"><input type="url" placeholder="链接地址" aria-label="链接地址"></label>';
    const linkFile = button('uttu-tb-drop plain', '', '选文件', () => pickLinkFile());
    linkForm.append(linkFile, button('uttu-tb-drop plain', '', '确定', () => linkForm.requestSubmit()));
    bubble.append(bubbleTools, linkForm);
    document.body.append(bubble);
    // 按钮按下时不能让编辑面的选区丢掉（输入框除外）。
    bubble.addEventListener('mousedown', (event) => {
        if (!event.target.closest('input')) event.preventDefault();
    });

    let pending = null;
    let linkSource = null;
    function placeBubble() {
        if (!linkForm.hidden) return;
        const current = rootSelection();
        const text = current && !current.selection.isCollapsed ? current.selection.toString().trim() : '';
        if (!text || (!reading() && UI.editorKind() !== 'wysiwyg') || UI.menuState()?.mode === 'slash') {
            bubble.hidden = true;
            pending = null;
            return;
        }
        pending = { ...current, text };
        // 阅读面不能改字：浮条上只留“批注”“问”。
        for (const tool of bubbleTools.children) {
            if (tool !== commentButton && tool !== askButton) tool.hidden = reading();
        }
        const rect = current.range.getBoundingClientRect();
        if (!rect.width && !rect.height) {
            bubble.hidden = true;
            return;
        }
        const wasHidden = bubble.hidden;
        bubble.hidden = false;
        bubble.classList.toggle('still', !wasHidden);
        const width = bubble.offsetWidth;
        const height = bubble.offsetHeight;
        let top = rect.top - height - 8;
        if (top < 52) top = rect.bottom + 8;
        bubble.style.left = `${Math.round(Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8)))}px`;
        bubble.style.top = `${Math.round(top)}px`;
        askButton.hidden = typeof window.scriptoriumAPI?.askAgent !== 'function';
    }
    function ask() {
        const current = pending;
        bubble.hidden = true;
        if (!current) return;
        void window.scriptoriumAPI?.askAgent?.({
            text: current.text,
            docName: $('document-title')?.textContent || '',
            section: sectionOf(current.root, current.range),
        }).then((result) => { if (result?.copied) UI.toast('复制好了，贴给任何 AI 都行。'); });
    }
    function comment() {
        const current = pending;
        bubble.hidden = true;
        if (!current) return;
        UI.emit('comment-create', {
            quote: current.text,
            section: sectionOf(current.root, current.range),
            range: current.range,
        });
    }
    function openLink() {
        const api = session();
        const selection = api?.sourceSelection?.();
        if (!selection || selection.end <= selection.start) {
            UI.toast?.('先选中要加链接的文字。');
            return;
        }
        linkSource = selection;
        bubbleTools.hidden = true;
        linkForm.hidden = false;
        if (bubble.hidden) placeBubbleAt(rootSelection()?.range);
        linkFile.hidden = !window.UTTUScriptoriumLinkPick?.isMarkdown?.(UI.doc());
        const input = linkForm.querySelector('input');
        input.value = '';
        setTimeout(() => input.focus(), 0);
    }
    async function pickLinkFile() {
        const range = linkSource;
        const url = await window.UTTUScriptoriumLinkPick?.pickUrl?.();
        if (!url) {
            if (!linkForm.hidden) linkForm.querySelector('input').focus();
            return;
        }
        closeLink();
        applyLink(range, url);
    }
    function applyLink(range, url) {
        const api = session();
        const source = api?.source?.();
        if (!url || !range || typeof source !== 'string') return;
        const text = source.slice(range.start, range.end);
        api.replaceSource(`${source.slice(0, range.start)}[${text}](${url})${source.slice(range.end)}`, 'uttu-link');
    }
    function placeBubbleAt(range) {
        const rect = range?.getBoundingClientRect?.();
        if (!rect) return;
        bubble.hidden = false;
        bubble.style.left = `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - bubble.offsetWidth - 8)))}px`;
        bubble.style.top = `${Math.round(Math.max(52, rect.top - bubble.offsetHeight - 8))}px`;
    }
    function closeLink() {
        linkForm.hidden = true;
        bubbleTools.hidden = false;
        bubble.hidden = true;
        linkSource = null;
    }
    linkForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const url = linkForm.querySelector('input').value.trim();
        const range = linkSource;
        closeLink();
        applyLink(range, url);
    });
    linkForm.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeLink();
        }
    });

    // --- 空行打 /：段落里只有“/查询词”时弹出插入菜单；回车选中，Esc 收起 ---
    function checkSlash() {
        if (UI.editorKind() !== 'wysiwyg' || UI.isDeck()) return;
        const current = rootSelection();
        const slashOpen = UI.menuState()?.mode === 'slash';
        if (!current || !current.selection.isCollapsed) {
            if (slashOpen) UI.closeMenu();
            return;
        }
        const block = blockOf(current.selection.anchorNode);
        const text = (block?.textContent || '').replace(/​/g, '');
        if (!block || !/^\/[^\s/]{0,12}$/.test(text)) {
            if (slashOpen) UI.closeMenu();
            return;
        }
        const query = text.slice(1).toLowerCase();
        const items = insertItems().filter((item) => !query || item.name.toLowerCase().includes(query)
            || item.id.includes(query) || (item.hint || '').toLowerCase().includes(query));
        let rect = current.range.getBoundingClientRect();
        if (!rect.width && !rect.height) rect = block.getBoundingClientRect();
        UI.openMenu(items.length
            ? [{ grp: query ? `Insert · ${query}` : 'Insert' }, ...items.map((item) => ({
                label: item.name, gl: item.gl, icon: item.icon, hint: item.hint, act: () => insert(item, text),
            }))]
            : [{ empty: '没有对得上的块，按 Esc 收起' }], rect, { mode: 'slash', glyphs: true });
    }

    UI.on('view', syncBars);
    UI.on('document', () => {
        syncBars();
        syncBlockLabel();
    });
    UI.on('start', () => {
        syncBars();
        let frame = 0;
        document.addEventListener('selectionchange', () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                placeBubble();
                syncBlockLabel();
                UI.emit('caret');
            });
        });
        document.addEventListener('scroll', () => {
            if (!bubble.hidden && linkForm.hidden) placeBubble();
        }, true);
        // 编辑面在影子根里，input 事件冒到文档时目标是宿主元素。
        document.addEventListener('input', (event) => {
            if (event.composedPath?.()[0] && editRoot()?.contains(event.composedPath()[0])) checkSlash();
        }, true);
        document.addEventListener('keydown', (event) => {
            const state = UI.menuState();
            if (state && (state.mode === 'slash' || state.mode === 'insert')) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    event.stopPropagation();
                    UI.moveMenuActive(event.key === 'ArrowDown' ? 1 : -1);
                    return;
                }
                if (event.key === 'Enter') {
                    const active = UI.menuElement.querySelector('button.on');
                    if (active) {
                        event.preventDefault();
                        event.stopPropagation();
                        active.click();
                        return;
                    }
                }
            }
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && UI.editorKind() === 'wysiwyg' && rootSelection()) {
                event.preventDefault();
                openLink();
            }
        }, true);
        document.addEventListener('pointerdown', (event) => {
            if (!linkForm.hidden && !bubble.contains(event.target)) closeLink();
        }, true);
    });
})();
