// 文坊里看 Jupyter 笔记本。只读：Markdown 单元排版，代码单元带序号和输出（文字、图片、表格）。
// 右键一个单元能复制引用、交给 Agent。要改就让 Agent 改文件，或者用默认程序打开；外面改了自动重读。输出里的 HTML 过 VDocCore.sanitizeHtml。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    const Types = window.UTTUScriptoriumTypes;
    const Pick = window.UTTUScriptoriumPick;
    if (!UI?.on || !Types || !Pick) return;
    const { make, button, setText } = UI;
    const api = () => window.scriptoriumAPI;
    const session = () => window.UTTUScriptoriumSession;
    const isNotebook = (file) => Types.kindOf(file) === 'notebook';
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const welcomeShown = () => document.getElementById('welcome-state')?.hidden === false;
    const textOf = (value) => (Array.isArray(value) ? value.join('') : String(value ?? ''));
    const clean = (html) => (window.VDocCore?.sanitizeHtml ? window.VDocCore.sanitizeHtml(html) : '');
    const plainAnsi = (text) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

    let book = null; // { filePath, name, cells, generation }
    let generation = 0;

    const work = make('div', 'uttu-notebook-work');
    work.hidden = true;
    work.setAttribute('aria-label', '笔记本');
    const head = make('div', 'uttu-pane-head');
    const label = make('span', 'uttu-pane-label', '笔记本<small></small>');
    const openDefault = button('uttu-btn ghost small', '', '用默认程序打开', () => void openWithDefault());
    head.append(label, make('span', 'grow'), openDefault);
    const scroller = make('div', 'uttu-notebook-scroll');
    const paper = make('div', 'uttu-notebook-paper');
    scroller.append(paper);
    work.append(head, scroller);
    const workspace = document.getElementById('document-workspace');
    (workspace?.parentElement || document.body).append(work);

    function output(item) {
        const data = item.data || {};
        if (item.output_type === 'stream') return make('pre', `uttu-nb-out${item.name === 'stderr' ? ' err' : ''}`, UI.escapeHtml(plainAnsi(textOf(item.text))));
        if (item.output_type === 'error') return make('pre', 'uttu-nb-out err', UI.escapeHtml(plainAnsi(textOf(item.traceback).replace(/\n$/, '') || `${item.ename}: ${item.evalue}`)));
        if (data['image/png'] || data['image/jpeg']) {
            const picture = make('img');
            picture.alt = '';
            const type = data['image/png'] ? 'png' : 'jpeg';
            picture.src = `data:image/${type};base64,${textOf(data[`image/${type}`]).replace(/\s/g, '')}`;
            return picture;
        }
        if (data['text/html']) return make('div', 'uttu-nb-html', clean(textOf(data['text/html'])));
        if (data['image/svg+xml']) return make('div', 'uttu-nb-html', clean(textOf(data['image/svg+xml'])));
        return data['text/plain'] ? make('pre', 'uttu-nb-out', UI.escapeHtml(textOf(data['text/plain']))) : null;
    }
    function cellNode(cell, index) {
        const source = textOf(cell.source);
        const node = make('section', `uttu-nb-cell ${cell.cell_type === 'code' ? 'code' : 'text'}`);
        node.dataset.cell = String(index);
        if (cell.cell_type === 'markdown') {
            node.append(make('div', 'uttu-nb-md', clean(window.marked.parse(source, { gfm: true, breaks: false, async: false }))));
            return node;
        }
        if (cell.cell_type !== 'code') {
            node.append(make('pre', 'uttu-nb-raw', UI.escapeHtml(source)));
            return node;
        }
        node.append(make('span', 'uttu-nb-count', cell.execution_count ? `[${cell.execution_count}]` : '[ ]'), make('pre', 'uttu-nb-source', UI.escapeHtml(source)));
        (cell.outputs || []).forEach((item) => {
            const shown = output(item);
            if (shown) node.append(shown);
        });
        return node;
    }
    function parse(text) {
        const notebook = JSON.parse(text);
        // nbformat 3 的单元在 worksheets 里。
        const cells = notebook.cells || notebook.worksheets?.[0]?.cells;
        if (!Array.isArray(cells)) throw new Error('里面没有单元。');
        return cells.map((cell) => ({ ...cell, source: cell.source ?? cell.input }));
    }
    async function read(file) {
        try {
            const result = await api().view('read', { file });
            if (!result?.success) return result;
            return { ...result, cells: parse(result.text) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    function show(result) {
        book = { filePath: result.filePath, name: result.name, cells: result.cells, generation: ++generation };
        document.body.classList.add('uttu-notebook-mode');
        work.hidden = false;
        setText(label.querySelector('small'), `${result.cells.length} 个单元`);
        paper.replaceChildren(...result.cells.map(cellNode));
        UI.syncTitle?.();
        UI.sync?.();
    }
    async function open(file) {
        if (!isNotebook(file)) return false;
        if (book && same(book.filePath, file)) return true;
        const result = await read(file);
        if (!result?.success) {
            UI.toast(`没打开这个笔记本：${result?.error || '读不到'}`, 'error', 5000);
            return false;
        }
        await saveBehind();
        show(result);
        scroller.scrollTop = 0;
        void api().view('watch', { file: result.filePath }).catch(() => {});
        return true;
    }
    function leave() {
        if (!book) return;
        book = null;
        document.body.classList.remove('uttu-notebook-mode');
        work.hidden = true;
        paper.replaceChildren();
        void api()?.view?.('watch', { file: null }).catch(() => {});
        UI.syncTitle?.();
        UI.sync?.();
    }
    function route(file) {
        if (isNotebook(file)) return open(file);
        if (!book) return null;
        const behind = session()?.current?.();
        leave();
        const stale = /\.(md|markdown)$/i.test(String(file)) && !behind?.dirty;
        if (behind && !welcomeShown() && same(behind.filePath, file) && !stale) return Promise.resolve(true);
        return null;
    }
    async function saveBehind() {
        if (book || welcomeShown() || !UI.autosaveOn?.()) return;
        const behind = session()?.current?.();
        if (!behind?.filePath || !behind.dirty) return;
        document.getElementById('save-btn')?.click();
        const started = Date.now();
        while (Date.now() - started < 4000 && session()?.current?.()?.dirty) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    function close() {
        if (!book) return;
        leave();
        if (session()?.current?.() && !welcomeShown()) document.getElementById('home-btn')?.click();
    }
    async function reload() {
        if (!book) return;
        const top = scroller.scrollTop;
        const result = await read(book.filePath);
        if (!book || !result?.success) return;
        show(result);
        scroller.scrollTop = top;
    }
    api()?.onViewChanged?.((payload) => {
        if (book && same(payload?.file, book.filePath)) void reload();
    });
    async function openWithDefault() {
        if (!book) return;
        try {
            await api().files('open-default', { path: book.filePath });
        } catch (error) {
            UI.toast(error.message, 'error', 5000);
        }
    }

    // 右键：引用这个单元。
    paper.addEventListener('contextmenu', (event) => {
        const node = event.target.closest?.('.uttu-nb-cell');
        if (!node || !book) return;
        event.preventDefault();
        const index = Number(node.dataset.cell);
        const box = node.getBoundingClientRect();
        const area = scroller.getBoundingClientRect();
        const top = Math.max(box.top, area.top);
        Pick.menu({ type: 'element', label: `单元 ${index + 1}`, place: `第 ${index + 1} 个单元`, text: textOf(book.cells[index]?.source).replace(/\s+/g, ' ').trim().slice(0, 80),
            locator: { type: 'element', cell: index }, capture: { x: box.left, y: top, width: box.width, height: Math.min(box.bottom, area.bottom) - top } },
        { x: event.clientX, y: event.clientY }, { comment: false });
    });

    function fileItems({ openNewDialog, open: openFile }) {
        const has = Boolean(book);
        return [
            { label: '新建', k: 'Ctrl N', act: openNewDialog },
            { label: '打开文件', k: 'Ctrl O', act: openFile },
            { label: '打开文件夹', act: () => window.UTTUScriptoriumFolder?.choose?.() },
            { sep: true },
            { label: '重新载入', k: 'F5', disabled: !has, act: () => void reload() },
            { label: '用默认程序打开', disabled: !has, act: () => void openWithDefault() },
            { label: '在文件夹里显示', disabled: !has, act: () => void api()?.files?.('reveal', { path: book?.filePath }).catch(() => {}) },
            { label: '关闭', disabled: !has, act: () => close() },
        ];
    }

    const view = Object.freeze({
        find: Object.freeze({ root: () => paper }), // 左栏“查找”（uttu-scriptorium-panels.js）
        claims: isNotebook,
        open,
        route,
        leave,
        close,
        forget: () => {},
        save: async () => true, // 只看不改
        reload,
        fileItems,
        active: () => Boolean(book),
        agent: Object.freeze({
            text: () => (book ? book.cells.map((cell, index) => `# 单元 ${index + 1}（${cell.cell_type}）\n${textOf(cell.source)}`).join('\n\n') : ''),
            surface: () => scroller,
        }),
        doc: () => (book ? Object.freeze({ kind: 'notebook', filePath: book.filePath, name: book.name, generation: book.generation,
            dirty: false, saving: false, revision: 0, readOnly: true }) : null),
    });
    window.UTTUScriptoriumNotebook = view;
    UI.registerOverlay?.(view);
})();
