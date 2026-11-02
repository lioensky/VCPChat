// 文坊左栏的文件类页面。
// 一个活动栏图标一页，一页一张主列表：文库（最近打开、文档、文件夹）、笔记（标签、笔记）。文件和文库合成一页，管理文件就一个地方。
// 原来七块摞在“文件”一页里，从底下往上展开，大的文件树还会挤别的块（10-23 照 VS Code 做的布局）。
// 现在矮的块在上面、主列表（main）在最下面占满：点开时块头不动，内容往下展开，主列表自己滚。
// 各块的内容由各自的脚本经 section() 登记、自己画。行上带 data-path / data-kind，右键菜单按它们出。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    const panel = document.getElementById('outline-panel');
    if (!UI?.on || !panel) return;
    const { make, button, icon, escapeHtml, session } = UI;
    const api = () => window.scriptoriumAPI;
    const KEY = 'uttu.scriptorium.explorer.v2'; // 换了分页，旧的折叠记录不沿用
    const PAGES = Object.freeze({ lib: '文库', notes: '笔记' });
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { saved = {}; }
    const collapsed = new Set(Array.isArray(saved.collapsed) ? saved.collapsed : []);
    // 见过哪些块：新加的块第一次出现时按它自己的 collapsed 默认值，之后按用户点的。
    const known = new Set(Array.isArray(saved.known) ? saved.known : []);
    const persist = () => {
        try { localStorage.setItem(KEY, JSON.stringify({ collapsed: [...collapsed], known: [...known] })); } catch (_) { /* 只在这次用 */ }
    };

    const roots = new Map(Object.keys(PAGES).map((page) => {
        const root = make('div', 'uttu-explorer');
        root.dataset.page = page;
        panel.append(root);
        return [page, root];
    }));
    const sections = new Map();
    const openPage = () => (document.body.classList.contains('uttu-left-open') ? document.body.dataset.uttuLeft : '');
    const showing = (page) => (page ? openPage() === page : Object.hasOwn(PAGES, openPage()));
    const onPage = (page) => [...sections.values()].filter((entry) => entry.page === page);

    // 登记一块。page 哪一页；order 小的在上面；main 这一页的主列表，占满剩下的高度；solo 这一页只有它，不要块头，数量写在面板头上；
    // render(body) 在这一块展开、这一页开着时调；tools() 块头右边的按钮；pageTools() 面板头右边的按钮。
    function section(key, spec) {
        if (!known.has(key)) {
            known.add(key);
            if (spec.collapsed) collapsed.add(key);
            persist();
        }
        const page = spec.page || 'lib';
        const element = make('section', `uttu-xsec${spec.main ? ' main' : ''}`);
        element.dataset.key = key;
        const head = make('div', 'uttu-xsec-head');
        const toggle = button('uttu-xsec-toggle', spec.title, `${icon('i-chevron')}<b>${escapeHtml(spec.title)}</b><small></small>`, () => setOpen(key, collapsed.has(key)));
        const tools = make('span', 'uttu-xsec-tools');
        head.append(toggle, tools);
        const body = make('div', 'uttu-xsec-body');
        if (spec.solo) element.append(body);
        else element.append(head, body);
        const entry = { key, page, spec, element, toggle, tools, body, count: toggle.querySelector('small') };
        sections.set(key, entry);
        const order = onPage(page).sort((a, b) => (a.spec.order || 0) - (b.spec.order || 0));
        roots.get(page).replaceChildren(...order.map((item) => item.element));
        paint(entry);
        if (showing(page)) draw(entry);
        return Object.freeze({
            body,
            refresh: () => draw(entry),
            setCount: (text) => {
                entry.count.textContent = text || '';
                if (spec.solo && showing(page)) paintHead(page);
            },
            open: () => setOpen(key, true),
        });
    }
    function isClosed(entry) {
        return !entry.spec.solo && collapsed.has(entry.key);
    }
    function paint(entry) {
        const open = !isClosed(entry);
        entry.toggle.setAttribute('aria-expanded', String(open));
        entry.body.hidden = !open;
        entry.tools.replaceChildren(...(open || entry.spec.toolsWhenClosed ? (entry.spec.tools?.() || []) : []));
    }
    function draw(entry) {
        paint(entry);
        if (isClosed(entry) || !showing(entry.page)) return;
        try { entry.spec.render?.(entry.body); } catch (error) { console.error('[VCP 文坊] 左栏出错：', error); }
    }
    function setOpen(key, open) {
        const entry = sections.get(key);
        if (!entry) return;
        if (open) collapsed.delete(key); else collapsed.add(key);
        persist();
        draw(entry);
    }
    function drawAll() {
        for (const entry of sections.values()) draw(entry);
    }
    function paintHead(page) {
        const entries = onPage(page);
        const solo = entries.find((entry) => entry.spec.solo);
        UI.setLeftHead({ title: PAGES[page], count: solo?.count.textContent || '', tools: entries.flatMap((entry) => entry.spec.pageTools?.() || []) });
    }
    function syncPage({ key } = {}) {
        for (const [page, root] of roots) root.classList.toggle('on', page === key);
    }
    UI.on('left', ({ open, key } = {}) => {
        syncPage({ key });
        if (!open || !PAGES[key]) return;
        paintHead(key);
        for (const entry of onPage(key)) draw(entry);
    });
    syncPage({ key: document.body.dataset.uttuLeft });

    // 打开某一块：切到它那一页，再展开它。
    function open(key) {
        const entry = sections.get(key);
        if (!entry) return;
        UI.setLeft(true, entry.page);
        setOpen(key, true);
    }

    // ---------- 最近打开：拖进来的、对话里点开的、Agent 打开的、文件夹里点开的都在这里，跨重启保留（上游 recent.json，最多 30 份） ----------
    const norm = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    let recent = null;
    let recentLoading = null;
    const recentSection = section('recent', {
        title: '最近打开',
        order: 5,
        collapsed: true,
        tools: () => (recent?.length ? [button('uttu-tb uttu-xsec-text', '清空最近打开', '清空', () => void clearRecent())] : []),
        render: (body) => renderRecent(body),
    });
    function loadRecent() {
        if (recentLoading) return recentLoading;
        recentLoading = Promise.resolve(api()?.files?.('recent-files'))
            .then((result) => { recent = Array.isArray(result?.files) ? result.files : []; })
            .catch(() => { recent = recent || []; })
            .finally(() => { recentLoading = null; });
        return recentLoading;
    }
    function dirLabel(file) {
        const parts = String(file).split(/[\\/]/).filter(Boolean);
        return parts.slice(-3, -1).join(' / ');
    }
    async function renderRecent(body) {
        if (!recent) {
            body.replaceChildren(make('p', 'uttu-left-note', '正在读'));
            await loadRecent();
        }
        recentSection.setCount(recent.length ? String(recent.length) : '');
        paint(sections.get('recent'));
        const current = UI.doc()?.filePath;
        if (!recent.length) {
            body.replaceChildren(make('p', 'uttu-left-note', '还没有。'));
            return;
        }
        body.replaceChildren(...recent.map((item) => {
            const row = button('uttu-row uttu-recent-row', `${item.name}，${dirLabel(item.path)}`,
                `<span class="nm">${escapeHtml(item.name)}</span><small>${escapeHtml(dirLabel(item.path))}</small>`,
                () => { if (!same(item.path, UI.doc()?.filePath)) void session()?.openPath?.(item.path); if (UI.narrow()) UI.setLeft(false); });
            row.dataset.path = item.path;
            row.dataset.kind = 'recent';
            row.setAttribute('aria-current', String(same(item.path, current)));
            return row;
        }));
    }
    async function clearRecent() {
        await api()?.files?.('clear-recent').catch(() => null);
        recent = [];
        recentSection.refresh();
    }
    // 打开一份之后最近打开会变（主进程读的时候记下）：稍等一下再读。
    let recentTimer = 0;
    function staleRecent() {
        recent = null;
        clearTimeout(recentTimer);
        recentTimer = setTimeout(() => { if (showing('lib')) recentSection.refresh(); }, 300);
    }
    UI.on('document', staleRecent);
    UI.on('disk-check', staleRecent);

    window.UTTUScriptoriumExplorer = Object.freeze({
        section,
        showing,
        open,
        refreshRecent: staleRecent,
        drawAll,
    });
})();
