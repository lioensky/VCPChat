// VCP : Ctrl P 快速打开，像 VS Code 那样。
// 同一个框也是命令面板，打 > 找命令（Ctrl Shift P），打 ? 看全部快捷键。
// 列的是打开的文件夹里所有 Markdown（主进程 markdownFiles 的 all），加上最近打开过的文档（文库的、.md 都有）；
// 打几个字按名字和路径模糊匹配（字都在、顺序对就算），名字里连着的、靠前的排前面。上下键选，回车打开，Esc 或点别处收起
// （Esc 只关这个框）。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.make) return;
    const { make, escapeHtml } = UI;
    const api = () => window.scriptoriumAPI;
    const session = () => window.UTTUScriptoriumSession;

    const box = make('div', 'uttu-qo');
    box.hidden = true;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', '快速打开');
    const input = make('input', 'uttu-qo-input');
    input.type = 'search';
    input.placeholder = '按名字找文件；打 > 找命令';
    input.setAttribute('aria-label', '按名字找文件');
    const list = make('div', 'uttu-qo-list');
    list.setAttribute('role', 'listbox');
    const foot = make('p', 'uttu-qo-foot');
    box.append(input, list, foot);
    document.body.append(box);

    let items = [];
    let fileLoaded = false;
    let fileFoot = '';
    let shown = [];
    let active = 0;
    // 工作区里每个文件夹一份缓存。
    const cache = new Map();
    const keyOf = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();
    async function filesOf(root) {
        const hit = cache.get(keyOf(root));
        if (hit && Date.now() - hit.at < 30000) return hit;
        const result = await api()?.markdownFolder?.('all', { root }).catch(() => null);
        const entry = { at: Date.now(), files: result?.files || [], truncated: Boolean(result?.truncated) };
        cache.set(keyOf(root), entry);
        return entry;
    }
    async function load() {
        const roots = window.UTTUScriptoriumFolder?.roots?.() || [];
        const many = roots.length > 1;
        const lists = [];
        let truncated = false;
        for (const root of roots) {
            const entry = await filesOf(root);
            truncated = truncated || entry.truncated;
            const name = String(root).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
            lists.push(entry.files.map((file) => ({ ...file, rel: many ? `${name}/${file.rel}` : file.rel })));
        }
        const all = lists.flat();
        const recent = await Promise.resolve(api()?.listRecent?.()).catch(() => []);
        const seen = new Set();
        const merged = [];
        const add = (path, rel, tag) => {
            const key = keyOf(path);
            if (!path || seen.has(key)) return;
            seen.add(key);
            merged.push({ path, name: String(path).split(/[\\/]/).pop(), rel, tag });
        };
        // 最近打开的在工作区里时，也写工作区里的相对路径。
        const inFolder = new Map(all.map((file) => [keyOf(file.path), file.rel]));
        for (const item of Array.isArray(recent) ? recent : []) {
            const full = String(item.path || '').replace(/\\/g, '/');
            add(item.path, inFolder.get(keyOf(full)) || full, '最近');
        }
        for (const file of all) add(file.path, file.rel, '');
        fileItems = merged;
        fileLoaded = true;
        fileFoot = roots.length ? (truncated ? '文件夹很大，只列了前 5000 份。' : '') : '工作区里还没有文件夹，只列最近打开过的。左栏“文件”里打开一个。';
    }

    // Fuzzy: every typed character in order. Score: matches in the name beat the path, runs and early starts count.
    function score(item, query) {
        if (!query) return item.tag ? 2 : 1;
        const target = `${item.name}\n${item.rel}`.toLowerCase();
        let at = -1;
        let run = 0;
        let points = 0;
        for (const character of query) {
            const next = target.indexOf(character, at + 1);
            if (next < 0) return -1;
            run = next === at + 1 ? run + 1 : 0;
            points += 1 + run * 2 + (next < item.name.length ? 3 : 0);
            at = next;
        }
        if (item.name.toLowerCase().startsWith(query)) points += 10;
        return points;
    }
    // 命令面板：开头打 > 列命令（uttu-scriptorium-commands.js，带快捷键），打 ? 列全部快捷键。
    // Ctrl Shift P 打开时自己带上 >，Ctrl P 照旧是找文件。
    // 开头打 : 跳到第几行（代码和源码视图，Ctrl G 直接带上 :）。
    const modeOf = (value) => (value.startsWith('>') ? 'command' : value.startsWith('?') ? 'keys' : value.startsWith(':') ? 'line' : 'file');
    const lineItem = (raw) => {
        const editor = UI.lineEditor?.();
        if (!editor) return { name: '这个视图不能跳行', rel: '' };
        const line = Number.parseInt(raw.slice(1), 10);
        const last = editor.lineCount();
        if (!line) return { name: `打行号，一共 ${last} 行`, rel: '' };
        const target = Math.min(line, last);
        return { name: `跳到第 ${target} 行`, rel: '', run: () => UI.goToLine(target) };
    };
    let fileItems = [];
    function itemsFor(mode) {
        const commands = window.UTTUScriptoriumCommands;
        if (mode === 'command') return commands?.list?.() || [];
        if (mode === 'keys') return commands?.shortcuts?.() || [];
        if (mode === 'line') return [];
        return fileItems;
    }
    function render() {
        const raw = input.value.trim();
        const mode = modeOf(raw);
        items = mode === 'line' ? [lineItem(raw)] : itemsFor(mode);
        const query = mode === 'line' ? '' : (mode === 'file' ? raw : raw.slice(1).trim()).toLowerCase();
        box.dataset.mode = mode;
        shown = items.map((item) => ({ item, points: score(item, query) }))
            .filter((entry) => entry.points >= 0)
            .sort((a, b) => (mode === 'file' || query ? b.points - a.points || a.item.rel.localeCompare(b.item.rel, 'zh-CN', { numeric: true }) : 0))
            .slice(0, mode === 'file' ? 40 : 200)
            .map((entry) => entry.item);
        active = Math.min(active, Math.max(0, shown.length - 1));
        list.replaceChildren(...(shown.length ? shown.map((item, index) => {
            const row = make('button', 'uttu-qo-row');
            row.type = 'button';
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', String(index === active));
            // 名字后面写它在哪个目录里（文件夹根上的就不写）；命令写它属于哪一类。
            const dir = mode !== 'file' ? item.rel : item.rel.includes('/') ? item.rel.slice(0, item.rel.lastIndexOf('/')) : '';
            row.innerHTML = `<span class="nm">${escapeHtml(item.name)}</span><small>${escapeHtml(dir)}</small>${item.tag ? `<em>${escapeHtml(item.tag)}</em>` : ''}`;
            row.addEventListener('mousedown', (event) => event.preventDefault());
            row.addEventListener('click', () => choose(index));
            return row;
        }) : [make('p', 'uttu-qo-none', mode === 'file' ? '没有对得上的文件。' : '没有对得上的命令。')]));
        foot.textContent = mode === 'line' ? '回车跳过去。' : mode === 'file' ? fileFoot : mode === 'command' ? '回车执行。删掉开头的 > 回到找文件，打 ? 看全部快捷键。' : '只是一张表，点了没反应。';
        foot.hidden = !foot.textContent;
        list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }
    function choose(index = active) {
        const item = shown[index];
        if (item && !item.path && !item.run) return; // 快捷键表里的一行
        if (picking && item?.path) {
            const done = picking;
            picking = null;
            box.hidden = true;
            done(item);
            return;
        }
        close();
        if (item?.run) { try { item.run(); } catch (error) { UI.toast?.(`没做成：${error.message}`, 'error'); } return; }
        if (item) {
            window.UTTUScriptoriumTabs?.pinNext?.(item.path); // Ctrl P 打开的是有意要的：固定成标签，不进预览
            void session()?.openPath?.(item.path);
        }
    }
    function close() {
        box.hidden = true;
        if (picking) { const done = picking; picking = null; done(null); }
    }
    // 选一个文件（链接补全，uttu-scriptorium-linkpick.js）：同一个框、同一份文件列表，选好回调，不打开。
    let picking = null;
    async function pick({ placeholder = '选一个文件' } = {}) {
        if (picking) { const done = picking; picking = null; done(null); }
        return new Promise((resolve) => {
            void open().then(() => { input.placeholder = placeholder; });
            picking = resolve;
        });
    }
    async function open(prefix = '') {
        box.hidden = false;
        input.placeholder = '按名字找文件；打 > 找命令';
        input.value = prefix;
        active = 0;
        input.focus();
        if (prefix) { render(); return; }
        list.replaceChildren(make('p', 'uttu-qo-none', '正在列文件'));
        await load();
        if (!box.hidden) render();
    }

    input.addEventListener('input', () => {
        active = 0;
        // 从命令退回找文件：文件列表还没读过就读一次。
        if (modeOf(input.value) === 'file' && !fileLoaded) { void load().then(() => { if (!box.hidden) render(); }); return; }
        render();
    });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!shown.length) return;
            active = (active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
            render();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            choose();
        }
    });
    document.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'p') {
            event.preventDefault();
            event.stopPropagation();
            const prefix = event.shiftKey ? '>' : '';
            if (box.hidden || modeOf(input.value) !== modeOf(prefix)) void open(prefix); else close();
            return;
        }
        // Esc 只关这个框。
        if (event.key === 'Escape' && !box.hidden) {
            event.preventDefault();
            event.stopPropagation();
            close();
        }
    }, true);
    document.addEventListener('mousedown', (event) => {
        if (!box.hidden && !box.contains(event.target)) close();
    }, true);
    UI.openQuickOpen = () => open();
    UI.pickFile = (options) => pick(options);
    UI.openCommands = (prefix = '>') => open(prefix);
})();
