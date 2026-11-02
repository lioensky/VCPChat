// 右侧检查器的“链接”页。
// 只对 .md：上面“链出”是这份文件里的 [[双链]] 和相对 .md 链接，下面“反向链接”是打开的文件夹（没有就是所在仓库或文件夹）
// 里提到这份的文件，每份最多列五处（主进程 markdownFiles 的 links，限额照全文查找）。点一条打开那份，跳到那一处、闪一下。
// 页面打开着时，换文档、存盘后重新读；顶上一颗“重新读”。没有悬停说明，放不下的字末尾渐隐。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on || !UI.rightPage) return;
    const { make, button, icon, escapeHtml } = UI;
    const session = () => window.UTTUScriptoriumSession;
    const api = () => window.scriptoriumAPI;
    const current = () => UI.doc();
    const isMarkdown = (doc) => /\.(md|markdown)$/i.test(String(doc?.filePath || ''));
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const inside = (target, root) => Boolean(target && root) && (norm(target) === norm(root) || norm(target).startsWith(`${norm(root)}/`));
    const nameOf = (value) => String(value || '').split(/[\\/]/).pop().replace(/\.(md|markdown)$/i, '');
    const page = UI.rightPage('links');
    if (!page) return;
    const body = make('div', 'uttu-links');
    page.append(body);
    let token = 0;
    let shownFor = '';

    const visible = () => document.body.classList.contains('uttu-right-open') && UI.layout?.rtab === 'links';
    const note = (text) => make('p', 'uttu-links-note', escapeHtml(text));

    async function refresh(force = false) {
        const doc = current();
        if (!visible()) return;
        if (!isMarkdown(doc)) {
            shownFor = '';
            body.replaceChildren(note('这一页列 Markdown 文件之间的链接：这份链到哪些、哪些链到这份。打开一份 .md 再看。'));
            return;
        }
        const key = `${doc.filePath}|${doc.generation ?? ''}|${doc.revision ?? ''}`;
        if (!force && key === shownFor) return;
        shownFor = key;
        const mine = ++token;
        body.replaceChildren(note('正在读'));
        const folder = window.UTTUScriptoriumFolder?.current?.();
        let result;
        try {
            result = await api()?.markdownFolder?.('links', {
                path: doc.filePath, root: folder && inside(doc.filePath, folder) ? folder : undefined, text: session()?.source?.() || undefined,
            });
        } catch (error) {
            if (mine === token) body.replaceChildren(note(`没读成：${error.message}`));
            return;
        }
        if (mine !== token) return;
        paint(result || { outgoing: [], incoming: [] });
    }

    function head(text, count) {
        const node = make('div', 'uttu-links-h');
        node.append(make('b', '', escapeHtml(text)), make('small', '', count ? `${count}` : ''));
        return node;
    }
    function row(title, sub, onClick, { dim = false } = {}) {
        const node = button(`uttu-links-row${dim ? ' dim' : ''}`, `${title}，${sub}`,
            `<span class="nm">${escapeHtml(title)}</span>${sub ? `<small>${escapeHtml(sub)}</small>` : ''}`, onClick);
        if (dim) node.disabled = !onClick;
        return node;
    }
    function paint({ outgoing = [], incoming = [], truncated = false }) {
        const nodes = [];
        const reload = button('uttu-tb uttu-links-reload', '重新读', icon('i-reload'), () => void refresh(true));
        nodes.push(reload);
        nodes.push(head('链出', outgoing.length));
        if (!outgoing.length) nodes.push(note('这份文件里没有 [[双链]] 或指向别的 .md 的链接。'));
        for (const link of outgoing) {
            const title = nameOf(link.target) || link.target;
            const sub = `第 ${link.line} 行 · ${link.text}`;
            nodes.push(link.path && !link.missing
                ? row(title, sub, () => void openAt(link.path, null))
                : row(`${title}（还没有这份）`, sub, null, { dim: true }));
        }
        nodes.push(head('反向链接', incoming.reduce((n, file) => n + file.places.length, 0)));
        if (!incoming.length) nodes.push(note('文件夹里还没有别的文件链到这份。'));
        for (const file of incoming) {
            nodes.push(make('div', 'uttu-links-file', escapeHtml(file.rel || nameOf(file.path))));
            file.places.forEach((place, index) => {
                nodes.push(row(place.text || '（这一行是空的）', `第 ${place.line} 行`, () => void openAt(file.path, index)));
            });
        }
        if (truncated) nodes.push(note('文件夹很大，只找了一部分。'));
        body.replaceChildren(...nodes);
    }

    // 打开那份；index 不为空时跳到那份里第 index 处指向当前这份的链接（双链或相对 .md 链接），闪一下。
    async function openAt(path, index) {
        const from = current()?.filePath;
        const own = nameOf(from);
        if (norm(path) !== norm(from)) {
            void session()?.openPath?.(path);
            const started = Date.now();
            while (Date.now() - started < 8000 && !(norm(current()?.filePath) === norm(path)
                && session()?.readRoot?.()?.querySelectorAll('.vdoc-runtime > *').length)) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (index == null) return;
        const root = session()?.readRoot?.();
        const targets = [...(root?.querySelectorAll('a.uttu-wiki, a[href]') || [])].filter((link) => {
            const wiki = link.dataset?.uttuWiki;
            if (wiki) return nameOf(wiki).toLowerCase() === own.toLowerCase();
            return nameOf(decodeURIComponent(link.getAttribute('href') || '').split('#')[0]).toLowerCase() === own.toLowerCase();
        });
        const target = targets[Math.min(index, targets.length - 1)];
        if (!target) { UI.toast?.('那份文件里没找到这处链接（可能刚改过）。'); return; }
        target.scrollIntoView({ block: 'center' });
        target.classList.add('uttu-flash');
        setTimeout(() => target.classList.remove('uttu-flash'), 1300);
    }

    UI.on('right-tab', (key) => { if (key === 'links') void refresh(); });
    UI.on('document', () => { shownFor = ''; void refresh(); });
    // 存盘后（revision 变了、不再是没存的）重新读：上游没有存盘事件，隔一会儿看一眼。
    let lastSaved = '';
    setInterval(() => {
        const doc = current();
        if (!visible() || !isMarkdown(doc) || doc.dirty) return;
        const key = `${doc.filePath}|${doc.revision ?? ''}`;
        if (key !== lastSaved) {
            const first = !lastSaved;
            lastSaved = key;
            if (!first) void refresh(true);
        }
    }, 1500);

    window.UTTUScriptoriumLinks = Object.freeze({ refresh, openAt });
})();
