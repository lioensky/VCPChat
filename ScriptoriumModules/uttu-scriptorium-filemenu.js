// 文坊的文件右键菜单。用户：右键菜单太弱，基本操作不该离开文坊。
// 资源管理器里的每一行（工作区的树、最近打开、文库、笔记、样张）、标签、顶栏的文件名，用同一份菜单，按对象增减：
//   打开；在资源管理器中显示、用 VS Code 打开（文件、所在文件夹）、在终端打开、用默认程序打开（能运行的文件只显示不运行）；
//   复制路径、复制相对路径、复制文件名；重命名（F2，就在那一行里改）、复制一份、收进文库；新建文件、新建文件夹（文件夹上）；
//   移到回收站（Delete，再确认一次）；工作区的根：移出工作区；全部折叠；标签：关闭、关闭其他、关闭右侧。
// 事情都在主进程做（modules/uttu/scriptoriumFiles，只认工作区、文库、笔记、最近打开里的路径）。正开着的文件改了名、挪了位置：
// 先存（有改动时），改完在新路径重新打开、标签跟着换；进了回收站：先关掉它。树里的文件、文件夹可以拖到别的文件夹上挪过去。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;
    const { make, session } = UI;
    const api = () => window.scriptoriumAPI;
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const within = (file, dir) => same(file, dir) || norm(file).startsWith(`${norm(dir)}/`);
    const nameOf = (file) => String(file || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(file || '');
    const dirOf = (file) => String(file || '').replace(/[\\/][^\\/]*$/, '');
    const RUNNABLE = /\.(bat|cmd|exe|com|ps1|psm1|psd1|lnk|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|hta|cpl|msc|jar|reg|url|appref-ms|sh|py|pyw|application|gadget)$/i;
    const IMPORTABLE = /\.(docx|pptx|rtf)$/i; // 导入成文稿；能就地打开的看文件类型登记表
    const OPENABLE = { test: (file) => Boolean(window.UTTUScriptoriumTypes?.opensInPlace(file)) || IMPORTABLE.test(file) };
    const folder = () => window.UTTUScriptoriumFolder;
    const tabsApi = () => window.UTTUScriptoriumTabs;

    async function run(command, payload, done) {
        try {
            const result = await api().files(command, payload);
            if (done) UI.toast(typeof done === 'function' ? done(result) : done);
            return result;
        } catch (error) {
            UI.toast(error.message, 'error', 5000);
            return null;
        }
    }

    // 正开着的这份（或者它在要动的文件夹里）：先存。
    async function saveIfInside(target) {
        const doc = UI.doc();
        if (!doc?.filePath || !doc.dirty || !within(doc.filePath, target)) return true;
        if (UI.overlay()) return Boolean(await UI.overlay().save?.());
        document.getElementById('save-btn')?.click();
        const started = Date.now();
        while (Date.now() - started < 4000 && UI.doc()?.dirty) await new Promise((resolve) => setTimeout(resolve, 100));
        if (UI.doc()?.dirty) { UI.toast('这份还有没存上的改动，先存好再改名或挪动。', 'error', 5000); return false; }
        return true;
    }
    // 改名、挪动之后：标签换路径；正开着的在新路径重新打开；树重读那两层。
    async function moved(from, to) {
        tabsApi()?.retarget?.(from, to);
        const doc = UI.doc();
        if (doc?.filePath && within(doc.filePath, from)) {
            const next = `${to}${doc.filePath.slice(from.length)}`;
            await session()?.openPath?.(next);
        }
        refresh([dirOf(from), dirOf(to), from]);
    }
    function refresh(dirs) {
        folder()?.invalidate?.(dirs);
        window.UTTUScriptoriumExplorer?.refreshRecent?.();
    }

    // ---------- 就在那一行里输入（改名、新建） ----------
    function labelOf(row) {
        if (!row) return null;
        if (row.id === 'uttu-title') return row;
        return row.querySelector('.uttu-tab-name, .nm, span:not(.slot):not(.gl)') || null;
    }
    function inlineInput(row, initial, { select = initial.replace(/\.[^.]*$/, '').length } = {}) {
        return new Promise((resolve) => {
            const label = labelOf(row);
            if (!label) { resolve(null); return; }
            const input = make('input', 'uttu-lib-rename uttu-inline-name');
            input.type = 'text';
            input.value = initial;
            input.setAttribute('aria-label', '名字');
            label.hidden = true;
            label.after(input);
            row.classList.add('uttu-renaming');
            input.focus();
            input.setSelectionRange(0, Math.max(0, Math.min(select, initial.length)));
            let finished = false;
            const finish = (value) => {
                if (finished) return;
                finished = true;
                input.remove();
                label.hidden = false;
                row.classList.remove('uttu-renaming');
                resolve(value);
            };
            // 行本身是按钮：输入框里的点击、空格、回车不能当成点了这一行。
            for (const type of ['click', 'mousedown', 'keyup']) input.addEventListener(type, (event) => event.stopPropagation());
            input.addEventListener('keydown', (event) => {
                event.stopPropagation();
                if (event.key === 'Enter') { event.preventDefault(); finish(input.value.trim()); }
                else if (event.key === 'Escape') { event.preventDefault(); finish(null); }
            });
            input.addEventListener('blur', () => finish(input.value.trim()));
        });
    }

    async function rename(target) {
        const name = await inlineInput(target.el, nameOf(target.path));
        if (!name || name === nameOf(target.path)) return;
        if (!(await saveIfInside(target.path))) return;
        const result = await run('rename', { path: target.path, name });
        if (result?.path && result.from) await moved(result.from, result.path);
    }
    // 新建：先展开那一层，在它下面插一行输入框。
    async function create(dir, kind, anchor) {
        await folder()?.expand?.(dir);
        let row = null;
        const host = anchor?.closest?.('.uttu-tree') || document.querySelector('.uttu-explorer .uttu-tree');
        for (let tries = 0; tries < 20 && !row; tries += 1) {
            const dirRow = [...document.querySelectorAll('.uttu-explorer .uttu-tree-row')].find((node) => same(node.dataset.path, dir));
            if (dirRow || !host) {
                row = make('div', 'uttu-tree-row file uttu-tree-new');
                row.style.setProperty('--depth', String(Number(dirRow?.style.getPropertyValue('--depth') || 0) + 1));
                row.innerHTML = '<span></span>';
                if (dirRow) dirRow.after(row); else (host || document.body).prepend(row);
            } else {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        }
        const name = await inlineInput(row, { folder: '新文件夹', board: '未命名.excalidraw', design: '未命名.design' }[kind] || '未命名.md');
        row.remove();
        if (!name) return;
        const result = await run(kind === 'folder' ? 'new-folder' : 'new-file', { dir, name });
        if (!result?.path) return;
        refresh([dir]);
        if (kind !== 'folder' && OPENABLE.test(result.path)) {
            const opener = /\.(md|markdown)$/i.test(result.path) ? window.UTTUScriptoriumMarkdown?.openForWriting : null;
            if (opener) opener(result.path); else void session()?.openPath?.(result.path);
        }
    }
    function confirmTrash(target, anchor) {
        const name = nameOf(target.path);
        const open = UI.doc()?.filePath && within(UI.doc().filePath, target.path);
        UI.openMenu([
            { grp: `把“${name}”移到回收站？${open ? '它正开着，会先关掉。' : ''}` },
            { label: '移到回收站', act: () => void trash(target) },
            { label: '取消' },
        ], anchor);
    }
    async function trash(target) {
        const doc = UI.doc();
        if (doc?.filePath && within(doc.filePath, target.path)) {
            const tabs = tabsApi();
            if (tabs?.close) await tabs.close(doc.filePath); else document.getElementById('home-btn')?.click();
            if (UI.doc()?.filePath && within(UI.doc().filePath, target.path)) return; // 没关成（问存不存时选了取消）
        }
        const result = await run('trash', { path: target.path }, `“${nameOf(target.path)}”移到回收站了，需要时可以从回收站找回。`);
        if (!result) return;
        tabsApi()?.forget?.(target.path);
        refresh([dirOf(target.path)]);
        if (target.kind === 'library') window.UTTUScriptoriumExplorer?.drawAll?.();
    }

    // ---------- 菜单 ----------
    function itemsFor(target, anchor) {
        const { path, kind } = target;
        const isDir = kind === 'dir' || kind === 'root' || kind === 'recent-folder';
        const open = Boolean(UI.doc()?.filePath) && same(UI.doc().filePath, path);
        const items = [];
        if (!isDir) {
            items.push({ label: '打开', disabled: open || !OPENABLE.test(path), hint: OPENABLE.test(path) ? '' : '文坊打不开这种文件',
                act: () => void session()?.openPath?.(path) });
            // 双栏，右边只读地摆这一份（uttu-scriptorium-side.js；也可以按住 Alt 点）。
            const side = window.UTTUScriptoriumSide;
            if (side && !UI.narrow?.()) {
                items.push({ label: '在右边打开', k: 'Alt 点', disabled: open || !side.canShow(path),
                    hint: side.canShow(path) ? '' : '只摆 Markdown、纯文本和网页', act: () => void side.open(path) });
            }
        }
        if (kind === 'tab') {
            const list = tabsApi()?.list?.() || [];
            const at = list.findIndex((item) => same(item, path));
            items.push(
                { label: '关闭', k: 'Ctrl W', act: () => void tabsApi()?.close?.(path) },
                { label: '关闭其他', disabled: list.length < 2, act: () => void tabsApi()?.closeOthers?.(path) },
                { label: '关闭右侧', disabled: at < 0 || at >= list.length - 1, act: () => void tabsApi()?.closeRight?.(path) });
        }
        if (isDir && kind !== 'recent-folder') {
            items.push({ sep: true },
                { label: '新建文件', act: () => void create(path, 'file', anchor) },
                { label: '新建白板', act: () => void create(path, 'board', anchor) },
                { label: '新建设计', act: () => void create(path, 'design', anchor) },
                { label: '新建文件夹', act: () => void create(path, 'folder', anchor) });
        }
        items.push({ sep: true },
            { label: '在资源管理器中显示', act: () => void run('reveal', { path }) },
            { label: '用 VS Code 打开', act: () => void run('open-vscode', { path }) });
        if (!isDir) items.push({ label: '用 VS Code 打开所在文件夹', act: () => void run('open-vscode', { path, folder: true }) });
        items.push({ label: '在终端打开', hint: isDir ? '' : '所在文件夹', act: () => void run('open-terminal', { path }) });
        if (!isDir) {
            const danger = RUNNABLE.test(path);
            items.push({ label: '用默认程序打开', hint: danger ? '能运行的文件，只在资源管理器里显示' : '',
                act: () => void run('open-default', { path }) });
        }
        items.push({ sep: true },
            { label: '复制路径', act: () => void run('copy-path', { path, kind: 'full' }, '复制了路径。') },
            { label: '复制相对路径', act: () => void run('copy-path', { path, kind: 'relative' }, (result) => `复制了：${result.text}`) },
            { label: '复制文件名', act: () => void run('copy-path', { path, kind: 'name' }, '复制了文件名。') });
        if (kind === 'root') {
            items.push({ sep: true },
                { label: '移出工作区', hint: '文件夹本身不动', act: () => void folder()?.removeRoot?.(path) },
                { label: '全部折叠', act: () => folder()?.collapseAll?.() },
                { label: '显示所有文件', check: Boolean(folder()?.showAll?.()), act: () => folder()?.setShowAll?.(!folder()?.showAll?.()) });
            return items;
        }
        if (kind === 'recent-folder') return items;
        items.push({ sep: true });
        if (target.el) items.push({ label: '重命名', k: 'F2', act: () => void rename(target) });
        items.push({ label: '复制一份', act: () => void run('duplicate', { path }, (result) => `复制了一份：${nameOf(result.path)}`).then((result) => result && refresh([dirOf(path)])) });
        if (!isDir && kind !== 'library' && !/\.(vdocx|vpptx)$/i.test(path)) { // 工程本来就在文库里
            items.push({ label: '收进文库', hint: '复制一份进文库，原文件不动',
                act: () => void run('collect', { path }, (result) => `收进文库了：${nameOf(result.path)}`).then(() => window.UTTUScriptoriumExplorer?.drawAll?.()) });
        }
        if (kind === 'library' && target.el?.dataset.temporary === '1') {
            items.push({ label: '存为正式文稿', disabled: open, hint: open ? '正开着，先关掉' : '', act: () => void promote(path) });
        }
        if (kind === 'recent') items.push({ label: '从最近打开里去掉', act: () => void run('forget-recent', { path }).then(() => refresh([])) });
        items.push({ sep: true }, { label: '移到回收站', k: 'Delete', act: () => confirmTrash(target, anchor) });
        if (kind === 'dir') items.push({ sep: true }, { label: '全部折叠', act: () => folder()?.collapseAll?.() });
        return items;
    }
    async function promote(path) {
        const result = await session()?.libraryAction?.({ action: 'promote', path });
        if (!result?.success) UI.toast(result?.error || '没做成。', 'error');
        else window.UTTUScriptoriumExplorer?.drawAll?.();
    }

    function targetOf(node) {
        if (!node?.closest) return null;
        const title = node.closest('#uttu-title');
        if (title) {
            const doc = UI.doc();
            return doc?.filePath ? { path: doc.filePath, kind: 'title', el: title } : null;
        }
        const tab = node.closest('.uttu-tab');
        if (tab?.dataset.path) return { path: tab.dataset.path, kind: 'tab', el: tab };
        const row = node.closest('[data-path][data-kind]');
        if (row && row.closest('.uttu-explorer')) return { path: row.dataset.path, kind: row.dataset.kind, el: row };
        return null;
    }
    function open(target, anchor) {
        const items = itemsFor(target, anchor).filter(Boolean);
        while (items[0]?.sep) items.shift();
        UI.openMenu(items.filter((item, index) => !(item.sep && items[index + 1]?.sep)), anchor);
    }

    document.addEventListener('contextmenu', (event) => {
        const target = targetOf(event.target);
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        open(target, { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY });
    }, true);
    // 键盘：菜单键或 Shift+F10 出菜单；F2 改名；Delete 移到回收站（只在资源管理器的行、标签上，不在正文里）。
    document.addEventListener('keydown', (event) => {
        if (event.target?.closest?.('input, textarea, [contenteditable="true"], .CodeMirror')) return;
        const target = targetOf(event.target);
        if (!target) return;
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            event.stopPropagation();
            open(target, target.el);
        } else if (event.key === 'F2' && !['root', 'recent-folder'].includes(target.kind)) {
            event.preventDefault();
            void rename(target);
        } else if (event.key === 'Delete' && !['root', 'recent-folder', 'tab', 'title'].includes(target.kind)) {
            event.preventDefault();
            confirmTrash(target, target.el);
        }
    }, true);

    // ---------- 拖动挪位置：树里的文件、文件夹拖到另一个文件夹（或工作区的根）上 ----------
    // 自己的拖动类型，不带 Files：preloads/docx.js 只接从资源管理器拖进来的文件，不会把它当成“打开”。
    const DRAG = 'application/x-uttu-path';
    let dragFrom = '';
    let dragRoot = false;
    let dropRow = null;
    const setDrop = (row) => {
        if (dropRow === row) return;
        dropRow?.classList.remove('uttu-drop-into');
        dropRow = row;
        dropRow?.classList.add('uttu-drop-into');
    };
    document.addEventListener('dragstart', (event) => {
        const target = targetOf(event.target);
        if (!target || !['file', 'dir', 'note', 'root'].includes(target.kind) || !event.dataTransfer) return;
        dragRoot = target.kind === 'root';
        dragFrom = target.path;
        event.dataTransfer.setData(DRAG, target.path);
        event.dataTransfer.effectAllowed = 'move';
    });
    const dropTarget = (event) => {
        if (!dragFrom || !Array.from(event.dataTransfer?.types || []).includes(DRAG)) return null;
        const target = targetOf(event.target);
        // 拖的是工作区的根：只能放到另一个根上（换次序），不挪文件夹本身。
        if (dragRoot) return target?.kind === 'root' && !same(target.path, dragFrom) ? target : null;
        if (!target || !['dir', 'root'].includes(target.kind)) return null;
        // 挪进自己、自己里面、或者本来就在的那一层：不接。
        if (within(target.path, dragFrom) || same(dirOf(dragFrom), target.path)) return null;
        return target;
    };
    document.addEventListener('dragover', (event) => {
        const target = dropTarget(event);
        setDrop(target?.el || null);
        if (!target) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    });
    document.addEventListener('dragleave', (event) => { if (dropRow && !dropRow.contains(event.relatedTarget)) setDrop(null); });
    document.addEventListener('dragend', () => { dragFrom = ''; dragRoot = false; setDrop(null); });
    document.addEventListener('drop', (event) => {
        const target = dropTarget(event);
        setDrop(null);
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        const from = dragFrom;
        dragFrom = '';
        if (dragRoot) {
            dragRoot = false;
            void folder()?.moveRoot?.(from, folder()?.rootIndex?.(target.path) ?? 0);
            return;
        }
        void (async () => {
            if (!(await saveIfInside(from))) return;
            const result = await run('move', { path: from, to: target.path });
            if (result?.path && result.from) await moved(result.from, result.path);
        })();
    });

    window.UTTUScriptoriumFileMenu = Object.freeze({ open, itemsFor, targetOf, rename, create });
})();
