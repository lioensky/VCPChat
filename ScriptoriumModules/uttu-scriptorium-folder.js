// 文坊的工作区和笔记（资源管理器里的两块，uttu-scriptorium-explorer.js）。
// 第一版是文库页顶上切过去的“文件夹”页，只能开一个；
// 改成工作区：打开的文件夹可以几个，像 VS Code 的多根工作区，
// 存在主进程（modules/uttu/scriptoriumFiles，右栏和独立窗口同一份），每个是一棵树。
// - 没有文件夹时：一句说明、“打开文件夹”、最近打开过的几个。
// - 有文件夹时：搜索（名字 | 全文，所有文件夹一起找），下面每个文件夹一棵树：只列 Markdown、网页和子文件夹，子文件夹点开才读；
//   当前这份亮一档；打开一份工作区里的文件时，它所在的那几层自动展开。展开的层记在 localStorage。
// - 笔记：AppData/Notemodules 一棵树，头下“新建待办”“新建备忘”（主进程 modules/uttu/notesInScriptorium.js），建好直接进编辑视图。
// - 顶栏文档名后面淡字写它在哪个文件夹（#uttu-where）。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI) return;
    const { make, button, icon, escapeHtml, session } = UI;
    const api = () => window.scriptoriumAPI;
    const KEY = 'uttu.scriptorium.workspace';
    const LEGACY_KEY = 'uttu.scriptorium.folder'; // 10-20 只能开一个文件夹时记的
    // mode：搜文件名还是全文。
    const state = { roots: null, expanded: new Set(), lists: new Map(), recent: null, q: '', results: null, mode: 'name' };
    let legacy = null;
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (Array.isArray(saved?.expanded)) state.expanded = new Set(saved.expanded);
        legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
    } catch (_) { /* 没记过 */ }
    const persist = () => {
        try { localStorage.setItem(KEY, JSON.stringify({ expanded: [...state.expanded] })); } catch (_) { /* 只在这次用 */ }
    };
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const inside = (target, root) => norm(target) === norm(root) || norm(target).startsWith(`${norm(root)}/`);
    const isMarkdown = (file) => /\.(md|markdown)$/i.test(String(file || ''));
    // 网页也列、也在树里亮；PDF、表格也在文坊里开。
    const listed = (file) => Boolean(window.UTTUScriptoriumTypes?.opensInPlace(file)); // 文坊能就地打开的（文件类型登记表）
    const note = (text) => make('p', 'uttu-left-note', escapeHtml(text));
    const roots = () => state.roots || [];
    // 树里列什么：默认 Markdown、网页、图片；“显示所有文件”时全列。
    const ALL_KEY = 'uttu.scriptorium.allFiles';
    let showAll = false;
    try { showAll = localStorage.getItem(ALL_KEY) === '1'; } catch (_) { /* 默认只列文档 */ }
    const document_ = (file) => listed(file);
    const isImage = (file) => /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(String(file || ''));
    const rootOf = (file) => roots().find((root) => inside(file, root.path)) || null;
    let notesPath = '';
    const isNotes = (folder) => same(folder, notesPath);

    let workspace = null;
    let notesSection = null;
    let searchToken = 0;
    let searchTimer = 0;
    let treeToken = 0;
    let treeShown = Promise.resolve();
    const el = {};

    // ---------- 工作区 ----------
    async function loadRoots() {
        try {
            const result = await api()?.files?.('workspace');
            state.roots = Array.isArray(result?.roots) ? result.roots : [];
        } catch (_) {
            state.roots = state.roots || [];
        }
        // 10-20 那一版记的那个文件夹：加进工作区一次（它在最近打开的文件夹里，主进程认）。
        if (legacy?.path && !rootOf(legacy.path)) {
            const old = legacy;
            legacy = null;
            try { localStorage.removeItem(LEGACY_KEY); } catch (_) { /* 无所谓 */ }
            if (!isNotes(old.path)) {
                try {
                    await api().files('add-root', { path: old.path });
                    (old.expanded || []).forEach((dir) => state.expanded.add(dir));
                    state.expanded.add(old.path);
                    persist();
                    return loadRoots();
                } catch (_) { /* 那个文件夹不在了 */ }
            }
        }
        legacy = null;
        watchFolders();
        return state.roots;
    }
    const watchFolders = () => void api()?.markdownFolder?.('watch-folder', { path: [...roots().filter((root) => !root.missing).map((root) => root.path), notesPath].filter(Boolean) }).catch(() => {});

    function buildWorkspace(body) {
        el.empty = make('div', 'uttu-folder-empty');
        el.open = make('div', 'uttu-folder-open');
        el.tree = make('div', 'uttu-tree');
        el.open.append(el.tree);
        body.append(el.empty, el.open);
    }

    async function renderWorkspace(body) {
        if (!el.tree) buildWorkspace(body);
        if (!state.roots) await loadRoots();
        const open = roots().length > 0;
        el.empty.hidden = open;
        el.open.hidden = !open;
        workspace.setCount(roots().length > 1 ? String(roots().length) : '');
        if (!open) { renderEmpty(); return; }
        treeShown = renderTree();
    }

    function renderEmpty() {
        if (!state.recent) {
            state.recent = [];
            api()?.markdownFolder?.('recent').then((result) => {
                state.recent = result?.folders || [];
                if (!roots().length && el.empty) renderEmpty();
            }).catch(() => {});
        }
        const recent = state.recent.filter((folder) => !isNotes(folder.path) && !rootOf(folder.path));
        el.empty.replaceChildren(
            note('打开一个文件夹，里面的 Markdown、网页都能直接打开，改了存回原文件。可以开好几个，把文件夹拖进来也行。'),
            button('uttu-btn ghost uttu-folder-choose', '打开文件夹', '打开文件夹', () => choose()),
            ...(recent.length ? [make('div', 'uttu-folder-grp', 'Recent'), ...recent.map((folder) => {
                const row = button('uttu-row uttu-folder-recent', `${folder.name}，${folder.path}`,
                    `<span class="nm">${escapeHtml(folder.name)}</span><small>${escapeHtml(folder.path)}</small>`, () => addKnown(folder.path));
                row.dataset.path = folder.path;
                row.dataset.kind = 'recent-folder';
                return row;
            })] : []));
    }

    function children(dir, root) {
        if (!state.lists.has(dir)) {
            state.lists.set(dir, api().markdownFolder('list', { dir, root, all: showAll })
                .catch((error) => ({ error: error.message, dirs: [], files: [] })));
        }
        return state.lists.get(dir);
    }

    // 一棵树：root 是这棵树的根（工作区里的一个文件夹，或者笔记），从 depth 开始缩进。
    async function walkTree(root, depth, rows, current, kind = 'file') {
        const walk = async (dir, level) => {
            const list = await children(dir, root);
            if (list.error) { rows.push(note(`读不出来：${list.error}`)); return; }
            for (const sub of list.dirs) {
                const open = state.expanded.has(sub.path);
                const row = button('uttu-tree-row dir', sub.name, `${icon('i-chevron')}<span>${escapeHtml(sub.name)}</span>`, () => toggle(sub.path));
                row.style.setProperty('--depth', level);
                row.setAttribute('aria-expanded', String(open));
                row.dataset.path = sub.path;
                row.dataset.kind = 'dir';
                row.dataset.root = root;
                row.draggable = true; // 拖到别的文件夹上就挪过去（uttu-scriptorium-filemenu.js）
                rows.push(row);
                if (open) await walk(sub.path, level + 1);
            }
            for (const file of list.files) {
                const doc = document_(file.name);
                const row = button(`uttu-tree-row file${doc ? '' : ' other'}`, file.name,
                    `${icon(isImage(file.name) ? 'i-image' : 'i-file')}<span>${escapeHtml(file.name)}</span>`, () => openFile(file.path));
                row.style.setProperty('--depth', level);
                row.setAttribute('aria-current', String(same(file.path, current)));
                row.dataset.path = file.path;
                row.dataset.kind = kind;
                row.dataset.root = root;
                row.draggable = true;
                rows.push(row);
            }
            if (list.truncated) rows.push(note('这一层东西太多，只列了前 3000 个。'));
        };
        await walk(root, depth);
    }

    async function renderTree() {
        const token = ++treeToken;
        const current = UI.doc()?.filePath;
        const rows = [];
        for (const root of roots()) {
            const open = state.expanded.has(root.path);
            const row = button('uttu-tree-row dir uttu-tree-root', root.name,
                `${icon('i-chevron')}<span>${escapeHtml(root.name)}</span>${root.missing ? '<small>找不到了</small>' : ''}`, () => toggle(root.path));
            row.setAttribute('aria-expanded', String(open && !root.missing));
            row.dataset.path = root.path;
            row.dataset.kind = 'root';
            row.dataset.root = root.path;
            row.draggable = roots().length > 1; // 拖到另一个根上换次序（uttu-scriptorium-filemenu.js）
            rows.push(row);
            if (open && !root.missing) {
                const before = rows.length;
                await walkTree(root.path, 1, rows, current);
                if (rows.length === before) rows.push(Object.assign(note('这里面没有 Markdown 或网页。'), { className: 'uttu-left-note uttu-tree-empty' }));
            }
        }
        if (token !== treeToken) return;
        el.tree.replaceChildren(...rows);
        // 换了文档：树里滚到它那一行（只在换文档后第一次，平时翻树不跳）。
        if (current && !same(current, scrolledTo)) {
            const row = el.tree.querySelector('.uttu-tree-row[aria-current="true"]');
            if (row) { row.scrollIntoView({ block: 'center' }); scrolledTo = current; }
        }
    }
    let scrolledTo = '';

    // 搜索页的“所有文件”：工作区的文件名和内容，加文库的文件名。名字对得上的在前面。
    const filesPane = make('div', 'uttu-tree uttu-find-files');
    async function runSearch() {
        const query = state.q.trim();
        const token = ++searchToken;
        if (!query) { state.results = null; filesPane.replaceChildren(); return; }
        filesPane.replaceChildren(note('正在找'));
        const many = roots().length > 1;
        const merged = { names: [...(UI.libraryMatches?.(query) || [])], files: [], truncated: false };
        for (const root of roots().filter((item) => !item.missing)) {
            const ask = (command) => api().markdownFolder(command, { root: root.path, query }).catch((error) => ({ files: [], error: error.message }));
            const [byName, byText] = await Promise.all([ask('find'), ask('grep')]);
            for (const result of [byName, byText]) {
                if (result.error) merged.error = result.error;
                if (result.truncated) merged.truncated = true;
            }
            const inRoot = (file) => ({ ...file, rel: many ? `${root.name}/${file.rel}` : file.rel });
            merged.names.push(...(byName.files || []).map(inRoot));
            merged.files.push(...(byText.files || []).map(inRoot));
        }
        if (token !== searchToken) return;
        state.results = merged;
        renderResults();
    }

    // 全文结果点开一处：打开那份（换文档时等它排好），再在文档里跳到这一处、标亮（UI.revealText，左边留在这页）。
    async function openHit(file, hit) {
        const query = state.q.trim();
        if (!same(file.path, UI.doc()?.filePath)) {
            void session()?.openPath?.(file.path);
            const started = Date.now();
            while (Date.now() - started < 8000 && !(same(file.path, UI.doc()?.filePath) && (UI.overlay() || session()?.readRoot?.()?.querySelector('.vdoc-runtime')?.childElementCount))) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!UI.revealText?.(query, hit.occurrence)) UI.toast?.('文档里没找到这一处（可能刚改过）。');
        if (UI.narrow()) UI.setLeft(false);
    }
    // 全文替换：全文结果上面一行“替换为”，点“全部替换”先问一次，再交给主进程（markdownFiles 的 replace，
    // 每份原子存回）。正开着、有没存改动的那份不动（说一声）；开着但没改动的那份，外部改动跟随会自己重新载入。
    let replaceText = '';
    function replaceBar(result) {
        const total = result.files.reduce((n, file) => n + file.total, 0);
        const bar = make('div', 'uttu-folder-replace');
        const box = make('label', 'uttu-search', `${icon('i-edit')}<input type="text" placeholder="替换为" aria-label="替换为">`);
        const input = box.querySelector('input');
        input.value = replaceText;
        input.addEventListener('input', () => { replaceText = input.value; });
        const go = button('uttu-btn ghost small', '全部替换', '全部替换', () => confirmReplace(result, total, go));
        go.disabled = !total;
        bar.append(box, go);
        return bar;
    }
    function confirmReplace(result, total, anchor) {
        const query = state.q.trim();
        UI.openMenu([
            { grp: `把 ${result.files.length} 份文件里的 ${total} 处“${query}”换成“${replaceText}”？每份直接存回原文件。` },
            { label: '全部替换', act: () => void replaceAll(result) },
            { label: '取消' },
        ], anchor);
    }
    async function replaceAll(result) {
        const query = state.q.trim();
        const doc = UI.doc();
        const busy = doc?.dirty ? doc.filePath : '';
        let files = 0;
        let places = 0;
        const skipped = [];
        for (const root of roots().filter((item) => !item.missing)) {
            const paths = result.files.map((file) => file.path).filter((file) => inside(file, root.path));
            const kept = paths.filter((file) => !same(file, busy));
            if (paths.length !== kept.length) skipped.push(`${busy.split(/[\\/]/).pop()}（正开着、有没存的改动）`);
            if (!kept.length) continue;
            try {
                const done = await api().markdownFolder('replace', { root: root.path, query, replacement: replaceText, paths: kept });
                files += done.changed.length;
                places += done.changed.reduce((n, item) => n + item.count, 0);
                for (const item of done.skipped) skipped.push(`${item.path.split(/[\\/]/).pop()}（${item.reason}）`);
            } catch (error) {
                UI.toast(`没换成：${error.message}`, 'error', 5000);
                return;
            }
        }
        UI.toast(`换了 ${files} 份文件里的 ${places} 处。${skipped.length ? `没动：${skipped.join('、')}。` : ''}`, skipped.length ? 'error' : 'info', 6000);
        runSearch();
    }
    function textRows(result) {
        const current = UI.doc()?.filePath;
        const rows = [];
        if (result.files.length) rows.push(replaceBar(result));
        for (const file of result.files) {
            const head = button('uttu-tree-row file', `${file.rel}，${file.total} 处`,
                `${icon('i-file')}<span>${escapeHtml(file.rel)}</span><small>${file.total} 处</small>`, () => openHit(file, file.hits[0] || { occurrence: 0 }));
            head.setAttribute('aria-current', String(same(file.path, current)));
            head.dataset.path = file.path;
            head.dataset.kind = 'file';
            rows.push(head);
            for (const hit of file.hits) {
                rows.push(button('uttu-tree-row uttu-hit-row', `第 ${hit.line} 行`,
                    `<small>${hit.line}</small><span>${escapeHtml(hit.before)}<mark>${escapeHtml(hit.match)}</mark>${escapeHtml(hit.after)}</span>`,
                    () => openHit(file, hit)));
            }
            if (file.total > file.hits.length) rows.push(note(`这份还有 ${file.total - file.hits.length} 处，打开后在搜索里看全。`));
        }
        return rows;
    }
    function renderResults() {
        const result = state.results;
        if (!result) return;
        if (result.error && !result.files.length && !result.names.length) { filesPane.replaceChildren(note(`没找成：${result.error}`)); return; }
        const current = UI.doc()?.filePath;
        const nameRows = result.names.map((file) => {
            const row = button('uttu-tree-row file', file.rel, `${icon('i-file')}<span>${escapeHtml(file.rel)}</span>`, () => openFile(file.path));
            row.setAttribute('aria-current', String(same(file.path, current)));
            row.dataset.path = file.path;
            row.dataset.kind = 'file';
            return row;
        });
        const rows = [...nameRows, ...textRows(result)];
        if (result.truncated) rows.push(note('文件太多，只找了一部分。换个更准的词再找。'));
        filesPane.replaceChildren(...(rows.length ? rows : [note('没有找到。')]));
    }

    function redraw() {
        workspace?.refresh();
        notesSection?.refresh();
    }
    function toggle(dir) {
        if (state.expanded.has(dir)) state.expanded.delete(dir); else state.expanded.add(dir);
        persist();
        redraw();
    }
    function collapseAll() {
        state.expanded.clear();
        persist();
        redraw();
    }
    function openFile(file) {
        // 不是文档（图片、别的文件）：交给默认程序；能运行的主进程只在资源管理器里显示。
        if (!listed(file)) {
            api()?.files?.('open-default', { path: file }).then((result) => {
                if (result?.revealed) UI.toast?.('这是能运行的文件，只在资源管理器里显示了它。');
            }, (error) => UI.toast?.(error.message, 'error', 5000));
            return;
        }
        if (!same(file, UI.doc()?.filePath)) void session()?.openPath?.(file);
        if (UI.narrow()) UI.setLeft(false);
    }
    // 加进来的文件夹：展开它，资源管理器里的工作区这一块展开，左栏切过来。
    async function added(folder, more = []) {
        state.lists.clear();
        if (isNotes(folder) || (!notesPath && /[\\/]Notemodules[\\/]?$/i.test(folder))) {
            // 打开笔记：切到“笔记”这一页。
            window.UTTUScriptoriumExplorer?.open?.('notes');
            notesSection?.refresh();
            return treeShown;
        }
        state.recent = null;
        state.q = '';
        state.results = null;
        if (el.input) el.input.value = '';
        await loadRoots();
        for (const each of [folder, ...more]) {
            const root = roots().find((item) => same(item.path, each));
            if (root) state.expanded.add(root.path);
        }
        revealCurrent();
        persist();
        paintWhere();
        window.UTTUScriptoriumExplorer?.open?.('workspace');
        redraw();
        return treeShown;
    }
    // Ctrl Shift F：工作区全文查找，带上选中的字。
    window.addEventListener('keydown', (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || !event.shiftKey || event.key.toLowerCase() !== 'f') return;
        event.preventDefault();
        event.stopPropagation();
        const selected = String(window.getSelection?.() || '').trim();
        UI.openFind(selected && !selected.includes('\n') && selected.length <= 60 ? selected : '', false, 'files');
    }, true);

    async function choose() {
        try {
            const result = await api().files('add-root');
            if (result?.path) await added(result.path, result.added || []);
        } catch (error) { UI.toast?.(`没打开：${error.message}`); }
    }
    async function addKnown(folder) {
        try {
            const result = await api().files('add-root', { path: folder });
            if (result?.path) await added(result.path);
        } catch (error) {
            UI.toast?.(`没打开：${error.message}`);
            state.recent = null;
            workspace?.refresh();
        }
    }
    async function removeRoot(folder) {
        await api()?.files?.('remove-root', { path: folder }).catch(() => null);
        state.lists.clear();
        await loadRoots();
        paintWhere();
        redraw();
    }

    // ---------- 笔记：一个固定的文件夹 ----------
    // 每次一条新的；建好后树里看得见它，打开直接写。
    async function makeNote() {
        try {
            const made = await api().markdownFolder('new-note');
            state.lists.clear();
            const opener = window.UTTUScriptoriumMarkdown?.openForWriting;
            if (opener) opener(made.path); else void session()?.openPath?.(made.path);
            notesSection?.refresh();
            if (UI.narrow()) UI.setLeft(false);
        } catch (error) { UI.toast?.(`没建成：${error.message}`); }
    }
    async function renderNotes(body) {
        if (!el.notesTree) {
            el.notesTree = make('div', 'uttu-tree');
            body.append(el.notesTree);
        }
        if (!notesPath) { el.notesTree.replaceChildren(note('笔记目录还没准备好。')); return; }
        const rows = [];
        await walkTree(notesPath, 0, rows, UI.doc()?.filePath, 'note');
        el.notesTree.replaceChildren(...(rows.length ? rows : [note('还没有笔记。')]));
    }

    // 顶栏：文档名后面淡字写它在哪个文件夹。在工作区里写“文件夹名 / 子目录”，在笔记里写“笔记 / …”，在文库里写“文库”，不露内部目录名；都不在就写它最后两层目录。
    function paintWhere() {
        const title = document.getElementById('uttu-title');
        if (!title) return;
        let where = document.getElementById('uttu-where');
        if (!where) {
            where = make('span', 'uttu-where');
            where.id = 'uttu-where';
            title.after(where);
        }
        const file = UI.doc()?.filePath;
        let text = '';
        if (listed(file)) {
            const dir = file.replace(/[\\/][^\\/]*$/, '');
            const root = rootOf(dir);
            const library = file.match(/^(.*[\\/]ScriptoriumDocument[\\/][^\\/]+)[\\/]/)?.[1];
            const base = root ? [root.path, root.name]
                : notesPath && inside(dir, notesPath) ? [notesPath, '笔记']
                    : library ? [library, '文库'] : null;
            if (base) {
                const rest = dir.slice(base[0].replace(/[\\/]$/, '').length).split(/[\\/]/).filter(Boolean);
                text = [base[1], ...rest].join(' / ');
            } else {
                text = dir.split(/[\\/]/).filter(Boolean).slice(-2).join(' / ');
            }
        }
        where.textContent = text ? `· ${text}` : '';
        where.hidden = !text;
    }

    // 开着的是工作区（或笔记）里的一份：它所在的那几层展开，树里看得见它。
    function revealCurrent() {
        const file = UI.doc()?.filePath;
        if (!listed(file)) return;
        const base = rootOf(file)?.path || (notesPath && inside(file, notesPath) ? notesPath : '');
        if (!base) return;
        const parts = file.slice(base.replace(/[\\/]$/, '').length).split(/[\\/]/).filter(Boolean).slice(0, -1);
        let dir = base.replace(/[\\/]$/, '');
        const sep = base.includes('\\') ? '\\' : '/';
        let changed = !state.expanded.has(base) && base !== notesPath;
        if (base !== notesPath) state.expanded.add(base);
        for (const part of parts) {
            dir = `${dir}${sep}${part}`;
            if (!state.expanded.has(dir)) { state.expanded.add(dir); changed = true; }
        }
        if (changed) persist();
    }

    // 工作区里有增删（主进程 watch-folder），重读变了的那几层。
    function invalidate(dirs = []) {
        let touched = false;
        for (const dir of dirs) {
            for (const key of [...state.lists.keys()]) if (same(key, dir)) { state.lists.delete(key); touched = true; }
        }
        if (state.q.trim()) runSearch();
        else if (touched) redraw();
    }

    // 拖进来的文件夹（主进程已经加进工作区）：展开它，左边切到资源管理器。
    api()?.onOpenFolderRequest?.((folder) => {
        if (typeof folder !== 'string' || !folder) return;
        return added(folder); // 列好了再让窗口显示（preloads/docx.js reportOpened）
    });

    function install() {
        const explorer = window.UTTUScriptoriumExplorer;
        if (!explorer) return;
        workspace = explorer.section('workspace', {
            title: '文件夹',
            order: 10,
            main: true,
            pageTools: () => [
                button('uttu-tb', '打开文件夹', icon('i-plus'), () => choose()),
                button('uttu-tb', '全部折叠', icon('i-collapse'), () => collapseAll()),
            ],
            render: (body) => void renderWorkspace(body),
        });
        notesSection = explorer.section('notes', { title: '笔记', page: 'notes', order: 10, main: true, render: (body) => void renderNotes(body),
            pageTools: () => [button('uttu-tb', '新建笔记', icon('i-plus'), () => void makeNote())] });
    }
    install();
    api()?.markdownFolder?.('notes').then((result) => {
        notesPath = result?.path || '';
        notesSection?.refresh();
        paintWhere();
        watchFolders();
    }).catch(() => {});
    void loadRoots().then(() => { paintWhere(); revealCurrent(); });

    UI.on('document', () => {
        paintWhere();
        revealCurrent();
        if (window.UTTUScriptoriumExplorer?.showing?.()) redraw();
        if (state.q.trim()) renderResults();
    });
    // 切回窗口时整棵树重读一次：文件夹监视在网络盘上、文件夹整个挪过时会漏。
    UI.on('disk-check', () => {
        state.lists.clear();
        if (!window.UTTUScriptoriumExplorer?.showing?.()) return;
        void loadRoots().then(redraw);
    });

    window.UTTUScriptoriumFolder = Object.freeze({
        // 当前这份所在的工作区文件夹（没有就第一个）：Ctrl P、双链、链接页在这里面找。
        current: () => rootOf(UI.doc()?.filePath)?.path || roots().find((root) => !root.missing)?.path || null,
        roots: () => roots().filter((root) => !root.missing).map((root) => root.path),
        // 冒烟和旧代码用：setFolder(路径) 加进工作区；setFolder(null) 清空工作区。
        async setFolder(folder) {
            if (folder) return addKnown(folder);
            for (const root of [...roots()]) await api()?.files?.('remove-root', { path: root.path }).catch(() => null);
            state.lists.clear();
            await loadRoots();
            paintWhere();
            redraw();
            return null;
        },
        choose,
        removeRoot,
        // 工作区的根换次序（拖动），to 是挪到的位置。
        async moveRoot(folder, to) {
            await api()?.files?.('move-root', { path: folder, to }).catch(() => null);
            await loadRoots();
            redraw();
        },
        rootIndex: (folder) => roots().findIndex((root) => same(root.path, folder)),
        collapseAll,
        invalidate,
        notesPath: () => notesPath,
        reveal: () => { revealCurrent(); redraw(); },
        // 右键“新建文件 / 新建文件夹”先展开那一层（uttu-scriptorium-filemenu.js）。
        expand: (dir) => {
            if (state.expanded.has(dir)) return Promise.resolve();
            state.expanded.add(dir);
            persist();
            redraw();
            return new Promise((resolve) => setTimeout(resolve, 0)).then(() => treeShown);
        },
        rootFor: (file) => rootOf(file)?.path || null,
        searchPane: filesPane,
        searchFiles: (query) => { state.q = String(query || ''); return runSearch(); },
        showAll: () => showAll,
        setShowAll(value) {
            showAll = Boolean(value);
            try { localStorage.setItem(ALL_KEY, showAll ? '1' : '0'); } catch (_) { /* 只在这次用 */ }
            state.lists.clear();
            redraw();
        },
    });
})();
