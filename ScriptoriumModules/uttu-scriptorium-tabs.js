// 文坊多标签。
//
// - 标签在顶栏左边、原来文档名的位置，不再单独占一行（开第二份时正文不再往下挪 34 像素）。
// - 单击文件是“预览”：在同一个预览标签里换，不新开；双击文件或标签、改了这份、Ctrl P 打开的、从外面拖进来的才固定成标签。
//   预览标签的名字暗一档。最多 12 个，再开就关掉最久没看的那个。
// - 后退、前进：Alt ← / Alt →（不在输入框、代码编辑器里时）和鼠标侧键，像浏览器一样回到刚才看的那份。
// 点哪个切到哪个，× 或中键关，Ctrl+Tab / Ctrl+Shift+Tab 切，Ctrl+W 关。标签和各自读到哪记在本机，下次接着用；
// 右栏里的文坊和独立窗口各记各的。
// 文坊一次只装一份文档（文档存储是单份的），所以切换 = 先存当前这份（开着自动保存时；关着时上游会问存不存）、
// 记下读到哪，再打开那份、滚回去。大文件有第一屏缓存（uttu-scriptorium-markdown.js firstPaint），切换不慢。
// 网页（.html，uttu-scriptorium-page.js）也是一个标签：切走时没存的修改它自己留着，关掉时存好再关。
// 没有悬停说明；放不下的名字末尾渐隐。标签多了先缩窄，缩到下限才横着滚（滚轮也能滚），窗口变窄时选中的标签留在看得见的地方。
// .vdocx、.vpptx 不写，和文库一样只写名字；别的扩展名留着，靠它分清同名的 .md 和 .html。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;
    const { make, button, icon } = UI;
    const session = () => window.UTTUScriptoriumSession;
    const embedded = new URLSearchParams(location.search).get('vcpEmbedded') === '1';
    const KEY = `uttu.scriptorium.tabs.${embedded ? 'pane' : 'window'}`;
    const MAX = 12;
    const SCROLLERS = ['read-host', 'render-host'];
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const nameOf = (path) => (String(path || '').split(/[\\/]/).pop() || String(path || '')).replace(/\.(vdocx|vpptx)$/i, '');

    let tabs = [];
    let active = '';
    let lastGeneration = null;
    let pendingScroll = null;
    let pinNext = ''; // 下一份打开的这一份直接固定（双击、Ctrl P、从外面拖进来）
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (Array.isArray(saved?.tabs)) {
            // 10-26 之前存的标签都是自己开的，算固定。
            tabs = saved.tabs.filter((tab) => tab && typeof tab.path === 'string' && tab.path)
                .map((tab) => ({ path: tab.path, scroll: tab.scroll || null, seen: Number(tab.seen) || 0, pinned: tab.pinned !== false }))
                .slice(0, MAX);
        }
    } catch (_) { /* 没记过 */ }
    const persist = () => {
        try { localStorage.setItem(KEY, JSON.stringify({ tabs })); } catch (_) { /* 只在这次用 */ }
    };
    const find = (path) => tabs.find((tab) => same(tab.path, path));
    const current = () => UI.doc();

    const strip = make('div', 'uttu-tabs');
    strip.setAttribute('role', 'tablist');
    strip.setAttribute('aria-label', '打开的文件');
    strip.hidden = true;
    // 顶栏左边，文档名的位置（uttu-scriptorium.js buildTopbar；有标签时文档名藏起来，见 uttu-scriptorium.css）。
    const title = document.getElementById('uttu-title');
    if (title) title.after(strip); else document.querySelector('.uttu-top-l')?.append(strip);
    const showActive = () => strip.querySelector('.uttu-tab[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (window.ResizeObserver) new ResizeObserver(showActive).observe(strip);
    strip.addEventListener('wheel', (event) => {
        if (!event.deltaY || strip.scrollWidth <= strip.clientWidth) return;
        event.preventDefault();
        strip.scrollLeft += event.deltaY;
    }, { passive: false });

    function rememberScroll() {
        const tab = find(current()?.filePath);
        if (!tab) return;
        tab.scroll = Object.fromEntries(SCROLLERS.map((id) => [id, document.getElementById(id)?.scrollTop || 0]));
        persist();
    }
    // 滚动时就记：从文件树点开别的文件不经过 switchTo，回来也要在读到的地方。
    let scrollTimer = 0;
    for (const id of SCROLLERS) {
        document.getElementById(id)?.addEventListener('scroll', () => {
            clearTimeout(scrollTimer);
            scrollTimer = setTimeout(rememberScroll, 300);
        }, { passive: true });
    }
    function restoreScroll(scroll) {
        if (!scroll) return;
        // 第一屏和整篇排好之间各滚一次，整篇排好后位置还在。
        for (const delay of [120, 600]) {
            setTimeout(() => requestAnimationFrame(() => {
                for (const id of SCROLLERS) {
                    const node = document.getElementById(id);
                    if (node && scroll[id]) node.scrollTop = scroll[id];
                }
            }), delay);
        }
    }

    // 开着自动保存时，换走之前先存当前这份；关着时交给上游问。
    async function saveFirst() {
        const doc = current();
        if (!doc?.filePath || !doc.dirty || !UI.autosaveOn?.()) return;
        if (UI.overlay()) { await UI.overlay().save?.(); return; } // 网页、PDF、表格（UI.registerOverlay）
        document.getElementById('save-btn')?.click();
        const started = Date.now();
        while (Date.now() - started < 4000 && current()?.dirty) await new Promise((resolve) => setTimeout(resolve, 100));
    }

    async function switchTo(path) {
        const doc = current();
        if (doc && same(doc.filePath, path)) return true;
        rememberScroll();
        await saveFirst();
        pendingScroll = { path, scroll: find(path)?.scroll || null };
        await session()?.openPath?.(path);
        return same(current()?.filePath, path);
    }

    function pin(path) {
        const tab = find(path);
        if (!tab || tab.pinned) return;
        tab.pinned = true;
        persist();
        paint();
    }

    const closed = []; // Ctrl Shift T 重开
    async function close(path) {
        const index = tabs.findIndex((tab) => same(tab.path, path));
        if (index < 0) return;
        closed.push(path);
        if (closed.length > 20) closed.shift();
        const page = UI.overlay(); // 网页、PDF、表格
        if (same(current()?.filePath, path)) {
            const next = tabs[index + 1] || tabs[index - 1];
            // 网页（这些视图）关掉时没存的先存（换走只是留在内存里）。
            if (page && current()?.dirty && !await page.save?.()) return;
            if (next) {
                if (!await switchTo(next.path)) return; // 没换成（上游问存不存时选了取消，或者打不开）
            } else if (page) {
                await page.close?.();
                if (current()) return;
            } else {
                await saveFirst();
                document.getElementById('home-btn')?.click();
                // 上游回首页是异步的：等它真关上（最多 3 秒），还开着才算问存不存时选了取消。原来立刻看，只剩这一个标签时总是关不掉。
                const started = Date.now();
                while (current() && Date.now() - started < 3000) await new Promise((resolve) => setTimeout(resolve, 100));
                if (current()) return;
            }
        } else if (UI.overlayFor?.(path)) {
            await UI.overlayFor(path).forget?.(path); // 没在看的网页、PDF 标签：还留着没存的修改就存好
        }
        const at = tabs.findIndex((tab) => same(tab.path, path));
        if (at >= 0) tabs.splice(at, 1);
        persist();
        paint();
    }

    // 超过上限：关掉最久没看的那个（当前这份不关）。
    function trim() {
        while (tabs.length > MAX) {
            const oldest = tabs.filter((tab) => !same(tab.path, active)).sort((a, b) => a.seen - b.seen)[0];
            if (!oldest) break;
            tabs.splice(tabs.indexOf(oldest), 1);
        }
    }

    const TAB_DRAG = 'application/x-uttu-tab';
    let dragging = '';
    function move(from, onto) {
        const at = tabs.findIndex((tab) => same(tab.path, from));
        const to = tabs.findIndex((tab) => same(tab.path, onto));
        if (at < 0 || to < 0 || at === to) return;
        const [tab] = tabs.splice(at, 1);
        tabs.splice(to, 0, tab);
        persist();
        paint();
    }
    function paint() {
        const doc = current();
        // 开着文档时总有一个标签（至少是预览的那个），文档名就是它；没开文档（首页）时顶栏照旧写“文坊”。
        const show = Boolean(doc?.filePath) && tabs.length >= 1;
        strip.hidden = !show;
        document.body.classList.toggle('uttu-has-tabs', show);
        if (!show) { strip.replaceChildren(); return; }
        const nodes = tabs.map((tab) => {
            const on = Boolean(doc) && same(doc.filePath, tab.path);
            const node = make('div', `uttu-tab${tab.pinned ? '' : ' preview'}`);
            node.setAttribute('role', 'tab');
            node.setAttribute('aria-selected', String(on));
            node.tabIndex = on ? 0 : -1;
            node.dataset.path = tab.path;
            const name = make('span', 'uttu-tab-name');
            name.textContent = nameOf(tab.path);
            const dirty = make('i', 'uttu-tab-dot');
            dirty.hidden = !(on && doc?.dirty);
            const shut = button('uttu-tab-x', `关掉 ${nameOf(tab.path)}`, icon('i-x'), (event) => {
                event.stopPropagation();
                void close(tab.path);
            });
            node.append(name, dirty, shut);
            node.addEventListener('click', () => { void switchTo(tab.path); });
            node.addEventListener('dblclick', () => pin(tab.path));
            node.addEventListener('auxclick', (event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                void close(tab.path);
            });
            node.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault(); }); // 中键不出滚动光标
            // 拖动换位置：拖到另一个标签上，放在它前面（往右拖时放在它后面）。
            node.draggable = true;
            node.addEventListener('dragstart', (event) => {
                event.dataTransfer?.setData(TAB_DRAG, tab.path);
                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
                dragging = tab.path;
            });
            node.addEventListener('dragover', (event) => {
                if (!dragging || same(dragging, tab.path)) return;
                event.preventDefault();
                strip.querySelectorAll('.uttu-tab-drop').forEach((other) => other.classList.remove('uttu-tab-drop'));
                node.classList.add('uttu-tab-drop');
            });
            node.addEventListener('drop', (event) => {
                if (!dragging) return;
                event.preventDefault();
                move(dragging, tab.path);
            });
            node.addEventListener('dragend', () => {
                dragging = '';
                strip.querySelectorAll('.uttu-tab-drop').forEach((other) => other.classList.remove('uttu-tab-drop'));
            });
            return node;
        });
        strip.replaceChildren(...nodes);
        showActive();
    }

    // ---------- 后退、前进：看过的文件按顺序记 50 份 ----------
    const trail = [];
    let at = -1;
    let walking = false;
    function remember(path) {
        if (walking || !path || same(trail[at], path)) return;
        trail.splice(at + 1);
        trail.push(path);
        if (trail.length > 50) trail.shift();
        at = trail.length - 1;
    }
    async function go(step) {
        const target = trail[at + step];
        if (!target) return false;
        walking = true;
        at += step;
        const ok = await switchTo(target).catch(() => false);
        walking = false;
        if (!ok) at -= step;
        return ok;
    }

    UI.on('document', (doc) => {
        const path = doc?.filePath || '';
        const generation = doc?.generation ?? null;
        if (path) {
            let tab = find(path);
            // 同一份文档换了路径（改名、另存为）：改这个标签，不新开一个。
            if (!tab && active && generation !== null && generation === lastGeneration && find(active)) {
                tab = find(active);
                tab.path = path;
            }
            const pinIt = same(pinNext, path);
            pinNext = '';
            if (!tab) {
                // 单击打开的：换掉预览的那个标签（原地换）；没有预览标签、或这一份要固定时，在当前标签后面新开一个。
                const preview = pinIt ? null : tabs.find((item) => !item.pinned);
                if (preview) {
                    tab = preview;
                    Object.assign(tab, { path, scroll: null });
                } else {
                    tab = { path, scroll: null, seen: Date.now(), pinned: pinIt };
                    const index = tabs.findIndex((item) => same(item.path, active));
                    tabs.splice(index >= 0 ? index + 1 : tabs.length, 0, tab);
                }
            }
            if (pinIt) tab.pinned = true;
            tab.seen = Date.now();
            active = tab.path;
            trim();
            persist();
            remember(path);
            if (pendingScroll && same(pendingScroll.path, path)) restoreScroll(pendingScroll.scroll);
            pendingScroll = null;
        } else {
            active = '';
        }
        lastGeneration = generation;
        paint();
    });

    // 当前这份有没有存的点；改了的预览标签固定下来（像 VS Code）。上游没有改动事件，隔一会儿看一眼，变了才画。
    let dirtyShown = null;
    setInterval(() => {
        const doc = current();
        const dirty = Boolean(doc?.dirty);
        if (dirty) {
            const tab = find(doc.filePath);
            if (tab && !tab.pinned) pin(tab.path);
        }
        if (dirty === dirtyShown || strip.hidden) return;
        dirtyShown = dirty;
        const dot = strip.querySelector('.uttu-tab[aria-selected="true"] .uttu-tab-dot');
        if (dot) dot.hidden = !dirty;
    }, 700);

    // 读到哪：离开窗口前也记一次。
    window.addEventListener('beforeunload', rememberScroll);

    // 资源管理器里双击文件：固定成标签（单击已经在预览标签里打开了它；打开是异步的，还没到时先记下）。
    document.addEventListener('dblclick', (event) => {
        const row = event.target?.closest?.('.outline-panel [data-path]');
        const kind = row?.dataset.kind || '';
        if (!row || /^(dir|root|recent-folder)$/.test(kind)) return;
        const path = row.dataset.path;
        if (find(path) && same(current()?.filePath, path)) pin(path);
        else pinNext = path;
    });

    const typing = (node) => Boolean(node?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], .CodeMirror'));
    document.addEventListener('keydown', (event) => {
        if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
            && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !typing(event.composedPath()[0])) {
            event.preventDefault();
            void go(event.key === 'ArrowLeft' ? -1 : 1);
            return;
        }
        if (!event.ctrlKey || event.altKey || event.metaKey) return;
        if (event.key === 'Tab' && tabs.length > 1) {
            event.preventDefault();
            const index = Math.max(0, tabs.findIndex((tab) => same(tab.path, current()?.filePath)));
            const next = tabs[(index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
            if (next) void switchTo(next.path);
        } else if ((event.key === 'w' || event.key === 'W') && !event.shiftKey && current()?.filePath && find(current().filePath)) {
            event.preventDefault();
            void close(current().filePath);
        } else if (event.shiftKey && event.key.toLowerCase() === 't') {
            event.preventDefault();
            const path = closed.pop();
            if (path) { pinNext = path; void session()?.openPath?.(path); }
        }
    }, true);
    // 鼠标侧键：后退 3、前进 4。
    document.addEventListener('mouseup', (event) => {
        if (event.button !== 3 && event.button !== 4) return;
        event.preventDefault();
        void go(event.button === 3 ? -1 : 1);
    });

    // 右键菜单：关闭其他、关闭右侧；文件改名、挪走后标签跟着换路径；
    // 文件进了回收站，它的标签直接去掉（不切换、不存）。
    async function closeMany(paths) {
        for (const path of paths) await close(path);
    }
    function retarget(from, to) {
        let changed = false;
        for (const tab of tabs) {
            if (same(tab.path, from)) { tab.path = to; changed = true; continue; }
            if (norm(tab.path).startsWith(`${norm(from)}/`)) { tab.path = `${to}${tab.path.slice(from.length)}`; changed = true; }
        }
        if (same(active, from)) active = to;
        if (changed) { persist(); paint(); }
    }
    function forget(path) {
        const before = tabs.length;
        tabs = tabs.filter((tab) => !(same(tab.path, path) || norm(tab.path).startsWith(`${norm(path)}/`)) || same(tab.path, current()?.filePath));
        if (tabs.length !== before) { persist(); paint(); }
    }
    // 会话恢复：重开文坊时，已经不在的文件的标签去掉；没有别的要打开（拖进来的、Agent 要开的）时，
    // 打开上次最后看的那份、滚回读到的地方。网页标签也一样（打开走 openPath）。
    // 主进程在窗口显示之前叫这里（docxHandlers.openScriptorium），原来窗口先显示空首页，1.2 秒后才换成上次那份。
    // 重新载入页面时没人叫，定时器兜底。
    const RESTORE_AFTER_MS = 1200;
    let requested = null; // 有人要开的那一份（preloads/docx.js 发 uttu-open-request）
    window.addEventListener('uttu-open-request', (event) => {
        const path = String(event.detail || '');
        requested = path || requested || 'folder';
        if (path) pinNext = path; // 从外面拖进来、双击 .md 打开的：固定
    });
    async function restore() {
        if (requested) return;
        if (!tabs.length) return;
        let exists = null;
        try { exists = (await window.scriptoriumAPI?.files?.('exists', { paths: tabs.map((tab) => tab.path) }))?.exists; } catch (_) { /* 问不到就都留着 */ }
        if (Array.isArray(exists)) {
            const kept = tabs.filter((_tab, index) => exists[index] !== false);
            if (kept.length !== tabs.length) { tabs = kept; persist(); paint(); }
        }
        if (current() || !tabs.length || requested) return;
        const last = [...tabs].sort((a, b) => b.seen - a.seen)[0];
        pendingScroll = { path: last.path, scroll: last.scroll || null };
        await session()?.openPath?.(last.path);
        // 恢复的这一份载入时又有人要开别的：以那一份为准（两次载入谁先完不一定）。
        if (requested && requested !== 'folder' && !same(current()?.filePath, requested)) await session()?.openPath?.(requested);
    }
    let restoring = null;
    const restoreOnce = () => (restoring ??= restore());
    window.scriptoriumAPI?.onRestoreTabs?.(restoreOnce);
    UI.on('start', () => { setTimeout(() => { void restoreOnce(); }, RESTORE_AFTER_MS); });

    window.UTTUScriptoriumTabs = Object.freeze({
        list: () => tabs.map((tab) => tab.path),
        pinned: (path) => Boolean(find(path)?.pinned),
        switchTo,
        close,
        pin,
        pinNext: (path) => { pinNext = String(path || ''); },
        back: () => go(-1),
        forward: () => go(1),
        closeOthers: (path) => closeMany(tabs.filter((tab) => !same(tab.path, path)).map((tab) => tab.path)),
        closeRight: (path) => closeMany(tabs.slice(tabs.findIndex((tab) => same(tab.path, path)) + 1).map((tab) => tab.path)),
        retarget,
        forget,
        move,
    });
    paint();
})();
