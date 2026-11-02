// 文坊左侧面板：文库里的文档、目录、搜索（
// - 文库：文档目录（上游 listDocumentLibrary）摊平成一列，按改动时间排，可以搜名字、按文稿 / 演示筛。
// - 篇章：从文稿源码读标题；点一下两栏一起滚到那里；按住一节拖到别处，整节（连小标题）一起挪。演示时是上游的页面缩略图。
// - 查找：在看得见的那一面里找（源码面找源码，所见和预览找排好的字），列出每一处和它所在的小节；替换改源码。
(() => {
    'use strict';

    const UI = window.UTTUScriptoriumUI;
    const panel = document.getElementById('outline-panel');
    if (!UI || !panel) return;
    const { $, icon, make, button, escapeHtml, session } = UI;

    const pressed = (group, attribute, value) => group.querySelectorAll('button').forEach((option) => {
        option.setAttribute('aria-pressed', String(option.dataset[attribute] === value));
    });
    const samePath = (a, b) => Boolean(a && b) && String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();
    const plain = (text) => String(text).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').trim();

    // ---------- 文库 ----------
    const DECK_EXT = new Set(['vpptx', 'pptx']);
    const lib = { q: '', kind: 'all', files: null, loadedAt: 0, loading: null };
    const libEl = make('div', 'uttu-lib');
    const libKind = make('div', 'uttu-seg sm full');
    libKind.setAttribute('role', 'group');
    libKind.setAttribute('aria-label', '种类');
    // 临时：Agent 随手做的交互演示和小工具（CreateProject temporary），只在这一类里出现。
    for (const [key, label] of [['all', '全部'], ['doc', '文稿'], ['deck', '演示'], ['temp', '临时']]) {
        const option = button('', '', label, () => {
            lib.kind = key;
            renderLib();
        });
        option.dataset.k = key;
        libKind.append(option);
    }
    const libRows = make('div', 'uttu-lib-rows');
    // 文库是资源管理器里的一块（uttu-scriptorium-explorer.js），原来顶上的“文库 | 文件夹”切换去掉了，
    // 文件夹成了同一页里的“工作区”。
    libEl.append(libKind, libRows);
    const libSection = window.UTTUScriptoriumExplorer?.section('library', {
        title: '文档',
        order: 8,
        render: (body) => {
            if (libEl.parentElement !== body) body.append(libEl);
            renderLib();
            loadLib(true); // 切到文库总是重读：缓存里没有刚新建的文件
        },
    });
    if (!libSection) panel.append(libEl);

    function flatten(entries, out) {
        for (const entry of entries || []) {
            if (entry.type === 'directory') flatten(entry.children, out);
            else if (entry.type === 'file') out.push(entry);
        }
        return out;
    }
    function loadLib(force = false) {
        const api = session();
        if (!api?.listLibrary) return Promise.resolve();
        if (lib.loading) return lib.loading;
        if (!force && lib.files && Date.now() - lib.loadedAt < 5000) return Promise.resolve();
        lib.loading = Promise.resolve(api.listLibrary())
            .then((result) => {
                const files = [];
                for (const root of result?.roots || []) {
                    flatten(root.children, []).forEach((file) => files.push({ ...file, temporary: root.id === 'temporary',
                        notes: root.id === 'notes' }));
                }
                lib.files = files.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
                lib.loadedAt = Date.now();
                lib.error = '';
            })
            .catch((error) => {
                lib.error = `文库读不出来：${error?.message || error}`;
            })
            .finally(() => {
                lib.loading = null;
                renderLib();
            });
        return lib.loading;
    }
    function renderLib() {
        pressed(libKind, 'k', lib.kind);
        libSection?.setCount(lib.files ? String(lib.files.length) : '');
        if (lib.error) {
            libRows.replaceChildren(make('p', 'uttu-left-note', escapeHtml(lib.error)));
            return;
        }
        if (!lib.files) {
            libRows.replaceChildren(make('p', 'uttu-left-note', '正在读文库'));
            return;
        }
        const openPath = () => UI.doc()?.filePath;
        const currentPath = openPath();
        const list = lib.files.filter((file) => {
            const deck = DECK_EXT.has(file.extension);
            if ((lib.kind === 'temp') !== Boolean(file.temporary)) return false;
            if (lib.kind === 'doc' && deck) return false;
            return lib.kind !== 'deck' || deck;
        });
        if (!list.length) {
            libRows.replaceChildren(make('p', 'uttu-left-note', lib.files.length ? '这一类还没有。' : '还没有文档。新建一份，存下来就在这里。'));
            return;
        }
        libRows.replaceChildren(...list.slice(0, 300).map((file) => {
            const name = file.name.replace(/\.[^.]+$/, '');
            const kind = DECK_EXT.has(file.extension) ? '演示' : '文稿';
            // 行右侧不再写时间和“文稿/演示”；导入的外来格式标一下扩展名。
            const native = ['vdocx', 'vpptx'].includes(file.extension);
            const tag = native ? '' : `<small>${escapeHtml(file.extension.toUpperCase())}</small>`;
            const row = button('uttu-row', `${name}，${kind}`, `<span class="nm">${escapeHtml(name)}</span>${tag}`, () => openFile(file));
            row.dataset.path = file.path;
            row.dataset.kind = 'library';
            if (file.temporary) row.dataset.temporary = '1'; // 右键“存为正式文稿”（uttu-scriptorium-filemenu.js）
            row.setAttribute('aria-current', String(samePath(file.path, currentPath)));
            row.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                openLibMenu(file, { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY });
            });
            row.addEventListener('keydown', (event) => {
                if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                event.preventDefault();
                openLibMenu(file, row);
            });
            return row;
        }));
    }

    // ---------- 文库管理：主进程 scriptorium:library-action 只认文库目录里的文档 ----------
    const baseName = (file) => file.name.replace(/\.[^.]+$/, '');
    function openFile(file) {
        if (samePath(file.path, UI.doc()?.filePath)) return;
        void session()?.openPath?.(file.path);
        if (UI.narrow()) UI.setLeft(false);
    }
    async function libraryAct(file, action, done, extra = {}) {
        const result = await session()?.libraryAction?.({ action, path: file.path, ...extra });
        if (!result?.success) {
            UI.toast(result?.error || '没做成，文库可能已经变了，刷新一下再试。', 'error');
            return null;
        }
        if (done) UI.toast(done);
        if (action !== 'reveal') await loadLib(true);
        return result;
    }
    function openLibMenu(file, anchor) {
        const name = baseName(file);
        const open = samePath(file.path, UI.doc()?.filePath);
        const busy = open ? '正开着，先关掉' : '';
        const notes = file.notes ? '笔记在笔记里管' : '';
        UI.openMenu([
            { label: '打开', disabled: open, act: () => openFile(file) },
            { label: '改名', disabled: Boolean(notes || busy), hint: notes || busy, act: () => renameRow(file) },
            { label: '复制一份', disabled: Boolean(notes), hint: notes, act: () => libraryAct(file, 'duplicate', `复制了一份“${name}”`) },
            file.temporary ? { label: '存为正式文稿', disabled: open, hint: busy,
                act: () => libraryAct(file, 'promote', `“${name}”存进了正式的文库`) } : null,
            { label: '在文件夹里显示', act: () => libraryAct(file, 'reveal') },
            { sep: true },
            { label: '移到回收站', disabled: Boolean(notes || busy), hint: notes || busy, act: () => confirmTrash(file, anchor) },
        ], anchor);
    }
    function confirmTrash(file, anchor) {
        const name = baseName(file);
        UI.openMenu([
            { grp: `把“${name}”移到回收站？` },
            { label: '移到回收站', act: () => libraryAct(file, 'trash', `“${name}”已移到回收站，需要时可以从回收站找回`) },
            { label: '取消' },
        ], anchor);
    }
    // 改名就在那一行里：回车或点别处改好，Esc 不改。
    function renameRow(file) {
        const row = [...libRows.querySelectorAll('.uttu-row')].find((element) => element.dataset.path === file.path);
        if (!row) return;
        const name = baseName(file);
        const input = make('input', 'uttu-lib-rename');
        input.type = 'text';
        input.value = name;
        input.maxLength = 120;
        input.setAttribute('aria-label', `给“${name}”改名`);
        row.replaceWith(input);
        input.focus();
        input.select();
        let finished = false;
        const finish = async (commit) => {
            if (finished) return;
            finished = true;
            const next = input.value.trim();
            if (commit && next && next !== name) await libraryAct(file, 'rename', `改名为“${next}”`, { name: next });
            renderLib();
        };
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') { event.preventDefault(); void finish(true); }
            else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void finish(false); }
        });
        input.addEventListener('blur', () => void finish(true));
    }

    // ---------- 篇章（文稿）/ 页面（演示）----------
    const outlineEl = make('div', 'uttu-outline');
    const outlineList = make('div', 'uttu-outline-list');
    const outlineTip = make('p', 'uttu-left-note uttu-outline-tip', '按住一节拖到别处，整节一起挪。');
    outlineEl.append(outlineList, outlineTip);
    panel.append(outlineEl);
    const emptyNote = make('p', 'uttu-left-note uttu-left-empty', '没有打开的文档。');
    panel.append(emptyNote);
    const addSlide = button('uttu-tb', '加一页', icon('i-plus'), () => UI.forward('add-slide-btn'));
    const deleteSlide = button('uttu-tb', '删掉当前页', icon('i-minus'), () => UI.forward('delete-slide-btn'));

    // 上游的页面缩略图只在建好的下一帧按大小缩放一次；建的时候面板藏着（宽 0）就一直是原尺寸。这里在显示、换宽度、重建后再缩一次。
    function fitThumbs() {
        document.querySelectorAll('#slide-navigator .slide-thumbnail-host').forEach((host) => {
            const stage = host.shadowRoot?.querySelector('.slide-thumbnail-stage');
            if (!stage || !host.clientWidth || !host.clientHeight || !stage.offsetWidth || !stage.offsetHeight) return;
            const scale = Math.min(host.clientWidth / stage.offsetWidth, host.clientHeight / stage.offsetHeight);
            stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
        });
    }

    // 源码里的标题（代码块里的 # 不算）。只有一个一级标题时它是文档名，不列；有几个一级标题时按一级标题分节。
    function headingsOf(source) {
        const list = [];
        let fence = false;
        source.split('\n').forEach((line, index) => {
            if (/^\s*(```|~~~)/.test(line)) {
                fence = !fence;
                return;
            }
            if (fence) return;
            const match = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
            if (match) list.push({ level: match[1].length, text: plain(match[2]), line: index });
        });
        return list;
    }
    let outline = { all: [], shown: [], sectionLevel: 2 };
    function renderOutline() {
        if (UI.overlay()?.outline) return UI.overlay().outline(); // PDF 的篇章是页面缩略图（uttu-scriptorium-pdf.js）
        const current = UI.doc();
        const deck = current?.kind === 'slide-deck';
        if (document.body.dataset.uttuLeft === 'outline') {
            if (!current) UI.setLeftHead({ title: '目录', count: '', tools: [] });
            else if (deck) UI.setLeftHead({ title: '页面', count: ($('slide-count')?.textContent || '').trim(), tools: [addSlide, deleteSlide] });
        }
        if (!current || deck) return;
        const source = session()?.source?.() || '';
        const all = headingsOf(source);
        const firsts = all.filter((item) => item.level === 1).length;
        const sectionLevel = firsts >= 2 ? 1 : 2;
        const shown = all.filter((item) => !(firsts === 1 && item.level === 1));
        outline = { all, shown, sectionLevel };
        if (document.body.dataset.uttuLeft === 'outline') {
            const sections = shown.filter((item) => item.level === sectionLevel).length;
            UI.setLeftHead({ title: '目录', count: sections ? `${sections} 节` : '', tools: [] });
        }
        if (!shown.length) {
            outlineList.replaceChildren(make('p', 'uttu-left-note', '写了标题，这里就有目录。'));
            outlineTip.hidden = true;
            return;
        }
        let section = -1;
        outlineList.replaceChildren(...shown.map((item) => {
            const depth = Math.max(0, item.level - sectionLevel);
            const entry = button(`l${depth}`, '', escapeHtml(item.text || '（空标题）'), () => goHeading(item));
            entry.dataset.index = String(all.indexOf(item));
            if (item.level === sectionLevel) {
                section += 1;
                entry.draggable = true;
                entry.dataset.sec = String(section);
            }
            return entry;
        }));
        outlineTip.hidden = section < 1;
        trackCurrent();
    }

    // 看得见的那几面：源码面、所见编辑面、预览。
    function visibleRoots() {
        const overlayRoot = overlayFind()?.root?.(); // 笔记本
        if (overlayRoot) return [{ root: overlayRoot, host: overlayRoot.parentElement, surface: 'read' }];
        const view = UI.view();
        const kind = UI.editorKind();
        const api = session();
        const roots = [];
        const narrowView = UI.narrow() && view === 'split' ? 'edit' : view;
        if (narrowView !== 'preview' && kind === 'wysiwyg') roots.push({ root: api?.editRoot?.(), host: $('render-host'), surface: 'edit' });
        if (narrowView !== 'edit') roots.push({ root: api?.readRoot?.(), host: $('read-host'), surface: 'read' });
        return roots.filter((item) => item.root);
    }
    function renderedHeadings(root) {
        return [...root.querySelectorAll('h1, h2, h3')].filter((node) => !node.closest('[data-vdoc-island], [data-vdoc-md-marker]'));
    }
    // 源码第 n 个标题在排好的页面里是哪个：数量对得上按顺序，对不上按文字（同名的数第几个）。
    function headingNode(root, index) {
        const nodes = renderedHeadings(root);
        if (nodes.length === outline.all.length) return nodes[index] || null;
        const item = outline.all[index];
        if (!item) return null;
        const nth = outline.all.slice(0, index).filter((other) => other.text === item.text).length;
        return nodes.filter((node) => node.textContent.trim() === item.text)[nth] || null;
    }
    function goHeading(item) {
        const index = outline.all.indexOf(item);
        const editor = session()?.sourceEditor?.();
        if (UI.view() !== 'preview' && UI.editorKind() === 'source' && editor) {
            editor.setCursor({ line: item.line, ch: 0 });
            const top = editor.charCoords({ line: item.line, ch: 0 }, 'local').top;
            editor.scrollTo(null, Math.max(0, top - 40));
            editor.focus();
        }
        for (const { root } of visibleRoots()) {
            headingNode(root, index)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        markCurrent(index);
        if (UI.narrow()) UI.setLeft(false);
    }
    function markCurrent(index) {
        outlineList.querySelectorAll('button').forEach((entry) => entry.setAttribute('aria-current', String(Number(entry.dataset.index) === index)));
    }
    // 滚动时跟着标出读到哪一节：取第一面里最后一个已经滚过顶边的标题。
    let trackFrame = 0;
    function trackCurrent() {
        cancelAnimationFrame(trackFrame);
        trackFrame = requestAnimationFrame(() => {
            if (document.body.dataset.uttuLeft !== 'outline' || UI.isDeck()) return;
            const first = visibleRoots()[0];
            if (!first) return;
            const top = first.host?.getBoundingClientRect().top ?? 0;
            const nodes = renderedHeadings(first.root);
            let index = -1;
            outline.all.forEach((_, k) => {
                const node = nodes.length === outline.all.length ? nodes[k] : null;
                if (node && node.getBoundingClientRect().top - top < 90) index = k;
            });
            markCurrent(index);
        });
    }

    // 拖动整节：按分节的那一级标题切开源码（代码块里的不算），挪完写回源码，可以撤销。
    function moveSection(from, to) {
        const api = session();
        const source = api?.source?.();
        if (typeof source !== 'string') return;
        const lines = source.split('\n');
        const marker = new RegExp(`^#{${outline.sectionLevel}}\\s`);
        const starts = [];
        let fence = false;
        lines.forEach((line, index) => {
            if (/^\s*(```|~~~)/.test(line)) fence = !fence;
            else if (!fence && marker.test(line)) starts.push(index);
        });
        if (from === to || from + 1 === to || from >= starts.length) return;
        const trim = (part) => {
            const copy = [...part];
            while (copy.length && !copy[copy.length - 1].trim()) copy.pop();
            return [...copy, ''];
        };
        const head = trim(lines.slice(0, starts[0]));
        const parts = starts.map((start, k) => trim(lines.slice(start, starts[k + 1] ?? lines.length)));
        const [moved] = parts.splice(from, 1);
        parts.splice(to > from ? to - 1 : to, 0, moved);
        const next = [...head, ...parts.flat()].join('\n').replace(/\n+$/, '\n');
        if (api.replaceSource(next, 'uttu-move-section')) {
            UI.toast(`挪好了“${plain(moved[0].replace(/^#+\s+/, ''))}”。按 Ctrl Z 撤销。`);
        }
    }
    let dragFrom = null;
    const clearDrop = () => outlineList.querySelectorAll('.drop-before, .drop-after').forEach((entry) => entry.classList.remove('drop-before', 'drop-after'));
    outlineList.addEventListener('dragstart', (event) => {
        const entry = event.target.closest?.('button[data-sec]');
        if (!entry) return;
        dragFrom = Number(entry.dataset.sec);
        entry.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', entry.textContent);
    });
    outlineList.addEventListener('dragover', (event) => {
        if (dragFrom === null) return;
        const entry = event.target.closest?.('button[data-sec]');
        if (!entry) return;
        event.preventDefault();
        clearDrop();
        const box = entry.getBoundingClientRect();
        entry.classList.add(event.clientY < box.top + box.height / 2 ? 'drop-before' : 'drop-after');
    });
    outlineList.addEventListener('drop', (event) => {
        if (dragFrom === null) return;
        event.preventDefault();
        const entry = outlineList.querySelector('.drop-before, .drop-after');
        if (entry) {
            const target = Number(entry.dataset.sec) + (entry.classList.contains('drop-after') ? 1 : 0);
            moveSection(dragFrom, target);
        }
        clearDrop();
    });
    outlineList.addEventListener('dragend', () => {
        dragFrom = null;
        clearDrop();
        outlineList.querySelectorAll('.dragging').forEach((entry) => entry.classList.remove('dragging'));
    });

    // ---------- 查找 ----------
    const find = { q: '', r: '', hits: [], index: -1, marks: [] };
    // 盖在文稿上的视图给 find：editor（CodeMirror，文本、网页源码）、root（排好的字，笔记本）、
    // frame（网页框，字在框里，查找交给主进程，modules/uttu/webPages/find.js）。PDF、表格有自己的查找框；图片、白板、音视频不给。
    const overlayFind = () => UI.overlay()?.find || null;
    const currentEditor = () => overlayFind()?.editor?.() || session()?.sourceEditor?.() || null;
    const findEl = make('div', 'uttu-findp');
    const findInput = make('label', 'uttu-search', `${icon('i-search')}<input type="search" placeholder="搜索" aria-label="搜索">`);
    // 原来有三个搜索框（搜索文件名、搜索文库、查找），合成这一个，分两个范围。
    // 所有文件：工作区的文件名和内容，加文库的文件名，结果和替换在 uttu-scriptorium-folder.js。
    const findScope = make('div', 'uttu-seg sm full');
    findScope.setAttribute('role', 'group');
    findScope.setAttribute('aria-label', '搜索范围');
    for (const [key, label] of [['doc', '这份文件'], ['files', '所有文件']]) {
        const option = button('', '', label, () => { setFindScope(key); queryBox.focus(); });
        option.dataset.v = key;
        findScope.append(option);
    }
    const replaceInput = make('label', 'uttu-search', '<input type="text" placeholder="替换为" aria-label="替换为">');
    const findRow = make('div', 'uttu-find-row');
    const findCount = make('small');
    const prevButton = button('uttu-tb', '上一处', icon('i-chevron', 'up'), () => step(-1));
    const nextButton = button('uttu-tb', '下一处', icon('i-chevron'), () => step(1));
    const replaceOne = button('uttu-tb-drop plain', '', '替换', () => replace(false));
    const replaceAll = button('uttu-tb-drop plain', '', '全部替换', () => replace(true));
    findRow.append(findCount, make('span', 'grow'), prevButton, nextButton, replaceOne, replaceAll);
    const hitList = make('div', 'uttu-hits');
    findEl.append(findInput, findScope, replaceInput, findRow, hitList);
    panel.append(findEl);
    const queryBox = findInput.querySelector('input');
    const replaceBox = replaceInput.querySelector('input');
    let findTimer = 0;
    queryBox.addEventListener('input', () => {
        find.q = queryBox.value;
        clearTimeout(findTimer);
        findTimer = setTimeout(() => (find.scope === 'files' ? window.UTTUScriptoriumFolder?.searchFiles?.(find.q) : runFind()), find.scope === 'files' ? 200 : 120);
    });
    queryBox.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
        }
    });
    replaceBox.addEventListener('input', () => { find.r = replaceBox.value; });
    replaceBox.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            replace(event.ctrlKey || event.metaKey);
        }
    });

    function sourceMode() {
        if (overlayFind()?.editor?.()) return true;
        return !UI.overlay() && UI.view() !== 'preview' && UI.editorKind() !== 'wysiwyg' && Boolean(session()?.sourceEditor?.());
    }
    const hasDocScope = () => Boolean(UI.doc()) && (!UI.overlay() || Boolean(overlayFind()));
    function setFindScope(scope) {
        find.scope = scope === 'doc' && hasDocScope() ? 'doc' : 'files';
        findEl.classList.toggle('files', find.scope === 'files');
        const pane = window.UTTUScriptoriumFolder?.searchPane;
        if (pane && pane.parentElement !== findEl) findEl.append(pane);
        findScope.querySelectorAll('button').forEach((option) => {
            option.setAttribute('aria-pressed', String(option.dataset.v === find.scope));
            if (option.dataset.v === 'doc') option.disabled = !hasDocScope();
        });
        if (find.scope === 'files') { clearMarks(); window.UTTUScriptoriumFolder?.searchFiles?.(find.q); } else runFind();
    }
    // 文库里文件名对得上的（所有文件的结果里算一块）。
    UI.libraryMatches = (query) => {
        const wanted = String(query || '').trim().toLowerCase();
        if (!wanted) return [];
        return (lib.files || []).filter((file) => file.name.toLowerCase().includes(wanted)).slice(0, 50)
            .map((file) => ({ name: file.name, path: file.path, rel: `文库 / ${file.name}` }));
    };
    const canReplace = () => !UI.isDeck() && (!UI.overlay() || Boolean(overlayFind()?.editor?.()));
    // 排好的字：和上游查找一样只看 .vdoc-runtime 里的文字，跳过样式、脚本和 Markdown 记号。
    function textSegments(root) {
        const runtime = root?.querySelector('.vdoc-runtime') || (overlayFind()?.root ? root : null);
        if (!runtime) return { text: '', segments: [] };
        const walker = document.createTreeWalker(runtime, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
                return node.parentElement?.closest('style, script, noscript, [data-vdoc-object-resize-handle], [data-vdoc-md-marker]')
                    ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
            },
        });
        const segments = [];
        let text = '';
        let previous = null;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const block = node.parentElement?.closest('[data-vdoc-text], [data-vdoc-edit-key], p, li, h1, h2, h3, h4, td, th') || null;
            if (text && block !== previous) text += '\n';
            segments.push({ node, start: text.length, end: text.length + node.nodeValue.length });
            text += node.nodeValue;
            previous = block;
        }
        return { text, segments };
    }
    UI.textSegments = textSegments;
    let frameToken = 0;
    async function runFrameFind(keepIndex) {
        const token = ++frameToken;
        const found = await overlayFind()?.frame?.find(find.q, keepIndex ? Math.max(0, find.index) : 0);
        if (token !== frameToken) return;
        find.hits = (found?.items || []).map((item) => ({ ...item, type: 'frame' }));
        find.total = found?.total || 0;
        find.index = find.hits.length ? Math.max(0, found.at) : -1;
        renderFind();
    }
    const watchedEditors = new WeakSet();
    function watchEditor(editor) {
        if (watchedEditors.has(editor)) return;
        watchedEditors.add(editor);
        let timer = 0;
        editor.on('changes', () => {
            clearTimeout(timer);
            timer = setTimeout(() => { if (document.body.dataset.uttuLeft === 'find' && find.q && find.scope !== 'files' && overlayFind()?.editor?.() === editor) runFind(true); }, 300);
        });
    }
    function runFind(keepIndex = false) {
        clearMarks();
        if (overlayFind()?.frame) {
            void runFrameFind(keepIndex);
            return;
        }
        const query = find.q;
        const hits = [];
        if (query && UI.doc()) {
            const needle = query.toLocaleLowerCase();
            if (sourceMode()) {
                const editor = currentEditor();
                const lineLabels = Boolean(overlayFind()?.editor); // 代码文件没有标题，写第几行
                if (lineLabels) watchEditor(editor);
                const text = editor.getValue();
                const lower = text.toLocaleLowerCase();
                let heading = '开头';
                let lastLine = -1;
                for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + Math.max(1, needle.length))) {
                    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
                    const line = editor.posFromIndex(at).line;
                    if (line !== lastLine) {
                        for (let k = lastLine + 1; k <= line; k += 1) {
                            const match = editor.getLine(k)?.match(/^#{1,3}\s+(.+)$/);
                            if (match) heading = plain(match[1]);
                        }
                        lastLine = line;
                    }
                    const lineEnd = text.indexOf('\n', at);
                    hits.push({
                        type: 'source', from: at, to: at + query.length, heading: lineLabels ? `第 ${line + 1} 行` : heading,
                        before: text.slice(Math.max(lineStart, at - 16), at),
                        after: text.slice(at + query.length, Math.min(lineEnd < 0 ? text.length : lineEnd, at + query.length + 22)),
                    });
                }
            } else {
                const first = visibleRoots()[0];
                if (first) {
                    const { text, segments } = textSegments(first.root);
                    const lower = text.toLocaleLowerCase();
                    const headings = renderedHeadings(first.root);
                    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + Math.max(1, needle.length))) {
                        const end = at + needle.length;
                        const startSeg = segments.find((segment) => at >= segment.start && at < segment.end);
                        const endSeg = [...segments].reverse().find((segment) => end > segment.start && end <= segment.end);
                        if (!startSeg || !endSeg) continue;
                        const range = document.createRange();
                        range.setStart(startSeg.node, at - startSeg.start);
                        range.setEnd(endSeg.node, end - endSeg.start);
                        let heading = '开头';
                        for (const node of headings) {
                            if (node.compareDocumentPosition(startSeg.node) & Node.DOCUMENT_POSITION_FOLLOWING || node.contains(startSeg.node)) heading = node.textContent.trim();
                            else break;
                        }
                        const lineStart = text.lastIndexOf('\n', at - 1) + 1;
                        const lineEnd = text.indexOf('\n', end);
                        hits.push({
                            type: 'rendered', range, root: first.root, heading,
                            before: text.slice(Math.max(lineStart, at - 16), at),
                            after: text.slice(end, Math.min(lineEnd < 0 ? text.length : lineEnd, end + 22)),
                        });
                    }
                }
            }
        }
        find.hits = hits;
        find.total = hits.length;
        find.index = keepIndex ? Math.min(find.index, hits.length - 1) : (hits.length ? 0 : -1);
        renderFind();
        presentMarks();
    }
    function renderFind() {
        const deck = UI.isDeck();
        const total = find.hits.length;
        UI.setText(findCount, !find.q ? '' : total ? `${find.index + 1} / ${find.total || total}` : '没有找到');
        prevButton.disabled = nextButton.disabled = !total;
        // 替换改的是文稿源码；演示的每一页是 HTML 场景，在源码面里改。
        replaceInput.hidden = replaceOne.hidden = replaceAll.hidden = !canReplace();
        replaceOne.disabled = replaceAll.disabled = !total;
        const clean = (text) => escapeHtml(text.replace(/[#>*`~]/g, ''));
        hitList.replaceChildren(...find.hits.slice(0, 80).map((hit, k) => {
            const entry = button('uttu-hit', '', `<small>${escapeHtml(hit.heading)}</small><span>${clean(hit.before)}<mark>${escapeHtml(find.q)}</mark>${clean(hit.after)}</span>`, () => {
                find.index = k;
                renderFind();
                reveal();
            });
            entry.setAttribute('aria-current', String(k === find.index));
            return entry;
        }));
        if (total > 80) hitList.append(make('p', 'uttu-left-note', `还有 ${total - 80} 处没列出，用上一处、下一处翻。`));
    }
    function clearMarks() {
        find.marks.forEach((mark) => mark.clear?.());
        find.marks = [];
        try {
            CSS.highlights?.delete('scriptorium-find-match');
            CSS.highlights?.delete('scriptorium-find-current');
        } catch (_) { /* 不支持高亮就只选中 */ }
    }
    // 高亮用上游查找同一套名字（影子根里有它的样式）。
    function presentMarks() {
        clearMarks();
        if (!find.hits.length || find.hits[0].type === 'frame') return;
        if (find.hits[0].type === 'source') {
            const editor = currentEditor();
            if (!editor) return;
            find.marks = find.hits.slice(0, 400).map((hit, k) => editor.markText(editor.posFromIndex(hit.from), editor.posFromIndex(hit.to), {
                className: k === find.index ? 'cm-vdoc-find-current' : 'cm-vdoc-find-match',
            }));
            return;
        }
        if (!window.CSS?.highlights || typeof window.Highlight !== 'function') return;
        const current = find.hits[find.index]?.range;
        CSS.highlights.set('scriptorium-find-match', new Highlight(...find.hits.map((hit) => hit.range).filter((range) => range !== current)));
        CSS.highlights.set('scriptorium-find-current', new Highlight(...(current ? [current] : [])));
    }
    function reveal() {
        const hit = find.hits[find.index];
        if (!hit) return;
        presentMarks();
        if (hit.type === 'frame') {
            void overlayFind()?.frame?.find(find.q, find.index);
        } else if (hit.type === 'source') {
            const editor = currentEditor();
            const from = editor.posFromIndex(hit.from);
            const to = editor.posFromIndex(hit.to);
            editor.setSelection(from, to);
            editor.scrollIntoView({ from, to }, 90);
        } else {
            hit.range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        hitList.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
    }
    function step(direction) {
        if (!find.hits.length) {
            runFind();
            if (find.hits.length) reveal();
            return;
        }
        find.index = (find.index + direction + find.hits.length) % find.hits.length;
        renderFind();
        reveal();
    }
    // 替换改源码：源码面里是当前这一处；所见、预览里按顺序找源码里的同一处（排好的字和源码一一对应时准确）。
    function replaceInEditor(editor, all) {
        const hits = find.hits;
        if (!hits.length) return;
        const swap = (hit) => editor.replaceRange(find.r, editor.posFromIndex(hit.from), editor.posFromIndex(hit.to));
        if (all) editor.operation(() => [...hits].reverse().forEach(swap));
        else swap(hits[find.index]);
        UI.toast(all ? `替换了 ${hits.length} 处。按 Ctrl Z 撤销。` : '替换了一处。');
        setTimeout(() => runFind(!all), 80);
    }
    function replace(all) {
        const overlayEditor = overlayFind()?.editor?.();
        if (overlayEditor) { replaceInEditor(overlayEditor, all); return; }
        const api = session();
        const source = api?.source?.();
        const query = find.q;
        if (!query || typeof source !== 'string') return;
        const lower = source.toLocaleLowerCase();
        const needle = query.toLocaleLowerCase();
        const positions = [];
        for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + Math.max(1, needle.length))) positions.push(at);
        if (!positions.length) {
            UI.toast('源码里没有可以替换的。');
            return;
        }
        let next;
        if (all) {
            next = '';
            let last = 0;
            for (const at of positions) {
                next += source.slice(last, at) + find.r;
                last = at + query.length;
            }
            next += source.slice(last);
        } else {
            const hit = find.hits[find.index];
            const at = hit?.type === 'source' ? hit.from : positions[Math.max(0, Math.min(find.index, positions.length - 1))];
            next = source.slice(0, at) + find.r + source.slice(at + query.length);
        }
        if (!api.replaceSource(next, 'uttu-replace')) return;
        UI.toast(all ? `替换了 ${positions.length} 处。按 Ctrl Z 撤销。` : '替换了一处。');
        setTimeout(() => runFind(!all), 80);
    }
    function openFind(prefill, focusReplace = false, scope = 'doc') {
        UI.openLeft('find');
        if (prefill) {
            queryBox.value = prefill;
            find.q = prefill;
        }
        setTimeout(() => {
            setFindScope(scope);
            queryBox.focus();
            queryBox.select();
            if (find.scope !== 'doc') return;
            if (find.hits.length) reveal();
            if (focusReplace && !replaceInput.hidden) replaceBox.focus();
        }, 0);
    }
    UI.openFind = openFind;
    // 从对话里带 :行号 的路径打开（主进程 docxHandlers.openScriptorium）：等那份开好再跳。阅读视图的 Markdown 没有行，不跳。
    window.scriptoriumAPI?.onGotoLine?.(async ({ file, line } = {}) => {
        const wanted = String(file || '').replace(/\\/g, '/').toLowerCase();
        for (let tries = 0; tries < 50; tries += 1) {
            if (String(UI.doc()?.filePath || '').replace(/\\/g, '/').toLowerCase() === wanted && UI.lineEditor()) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (UI.lineEditor()) UI.goToLine(Math.min(Number(line) || 1, UI.lineEditor().lineCount()));
    });
    // Ctrl G（uttu-scriptorium-editing.js、-quickopen.js）
    UI.lineEditor = () => (sourceMode() ? currentEditor() : null);
    UI.goToLine = (line) => {
        const editor = UI.lineEditor();
        if (!editor) return;
        const position = { line: line - 1, ch: 0 };
        editor.setCursor(position);
        editor.scrollIntoView(position, 120);
        editor.focus();
    };
    // 文件夹全文查找点开一处后，在文档里跳到那里、标亮；左边留在文件夹页，不打开查找面板。
    // occurrence 是这个词在文件里的第几处（主进程按源码数，排好的页面里数目可能略有出入，超了就停在最后一处）。
    UI.revealText = (query, occurrence = 0) => {
        if (!query || !UI.doc()) return false;
        queryBox.value = query;
        find.q = query;
        if (overlayFind()?.frame) {
            find.index = Math.max(0, Number(occurrence) || 0);
            void runFrameFind(true);
            return true;
        }
        runFind();
        if (!find.hits.length) return false;
        find.index = Math.min(Math.max(0, Number(occurrence) || 0), find.hits.length - 1);
        renderFind();
        reveal();
        return true;
    };

    // ---------- 跟着状态切换 ----------
    function renderLeft() {
        const key = document.body.dataset.uttuLeft;
        if (key === 'lib') {
            // 资源管理器自己画各块（uttu-scriptorium-explorer.js）。
        } else if (key === 'find') {
            UI.setLeftHead({ title: '搜索', count: '', tools: [] });
            setFindScope(find.scope || 'doc');
        } else if (key !== 'specimen' && key !== 'tasks') { // 这两种页不由这里画
            renderOutline();
        }
    }
    let outlineTimer = 0;
    UI.on('left', ({ open, key }) => {
        if (key !== 'find') void overlayFind()?.frame?.find('', 0);
        if (!open) {
            if (key !== 'find') clearMarks();
            return;
        }
        if (key !== 'find') clearMarks();
        renderLeft();
    });
    UI.on('document', () => {
        find.hits = [];
        clearMarks();
        renderLeft();
    });
    UI.on('view', () => {
        if (document.body.dataset.uttuLeft === 'find' && document.body.classList.contains('uttu-left-open') && find.scope !== 'files') runFind(true);
    });
    UI.on('doc-event', (event) => {
        if (event.type === 'saved' || event.type === 'document-replaced') {
            lib.loadedAt = 0;
            if (document.body.dataset.uttuLeft === 'lib') loadLib(true);
        }
        if (event.type === 'document-mutated' || event.type === 'document-replaced') {
            clearTimeout(outlineTimer);
            outlineTimer = setTimeout(() => {
                if (document.body.dataset.uttuLeft === 'outline') renderOutline();
                if (document.body.dataset.uttuLeft === 'find' && find.q && find.scope !== 'files') runFind(true);
            }, 400);
        }
        if (document.body.dataset.uttuLeft === 'lib') renderLib();
    });
    // 文库目录变了（Agent 新建、别处删了改名，主进程 watch-library）、切回窗口：重读文库。
    // 文库页没开着时只记下“旧了”，下次打开再读。
    const libShown = () => document.body.dataset.uttuLeft === 'lib' && document.body.classList.contains('uttu-left-open');
    const staleLib = () => {
        lib.loadedAt = 0;
        if (libShown()) void loadLib(true);
    };
    window.scriptoriumAPI?.onMarkdownEvent?.((event) => { if (event?.type === 'dirs-changed' && event.name === 'library') staleLib(); });
    UI.on('disk-check', () => { if (Date.now() - lib.loadedAt > 3000) staleLib(); });
    void window.scriptoriumAPI?.markdownFolder?.('watch-library').catch(() => {});

    UI.on('start', () => {
        // Ctrl F：打开左侧“查找”，带上选中的字（上游的浮动查找框不再用）。
        window.addEventListener('keydown', (event) => {
            const key = event.key.toLowerCase();
            if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || (key !== 'f' && key !== 'h') || !UI.doc()) return;
            if (UI.overlay() && !overlayFind()) return; // PDF、表格有自己的查找框，白板有自己的 Ctrl F
            event.preventDefault();
            event.stopPropagation();
            const selected = (sourceMode() ? currentEditor().getSelection() : overlayFind() ? String(window.getSelection?.() || '') : session()?.sourceSelection?.()?.text || '').trim();
            openFind(selected && !selected.includes('\n') && selected.length <= 60 ? selected : '', key === 'h'); // Ctrl H：光标在“替换为”
        }, true);
        // 篇章里跟着滚动标出当前一节。
        for (const id of ['render-host', 'read-host']) $(id)?.addEventListener('scroll', trackCurrent, { passive: true });
        const navigator = $('slide-navigator');
        if (navigator) {
            new MutationObserver(() => requestAnimationFrame(fitThumbs)).observe(navigator, { childList: true });
            if (window.ResizeObserver) new ResizeObserver(() => fitThumbs()).observe(navigator);
        }
        // 演示的页数变了，面板头跟着变。
        const slideCount = $('slide-count');
        if (slideCount) new MutationObserver(() => {
            if (document.body.dataset.uttuLeft === 'outline' && UI.isDeck()) renderOutline();
        }).observe(slideCount, { childList: true, characterData: true, subtree: true });
        renderLeft();
    });
})();
