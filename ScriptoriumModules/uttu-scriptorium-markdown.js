// 从 .md 打开的文档。存回原文件在主进程 modules/uttu/markdownFiles。
// 用户说大多数时候只当阅读器用。所以 .md 打开先是阅读视图（不记进视图偏好），点“编辑”“双栏”照常切；换回工程文档时回到记下的视图。
// 相对图片按 .md 所在文件夹换成本机地址（只换显示用的 HTML，正文不动），能读到的范围是它所在的 Git 仓库，不在仓库里就是它自己的文件夹；
//     点链接：网页交给系统浏览器，文内 #锚点 跳过去，相对 .md 在文坊里打开，相对 .html 在文坊里当网页开，
//     别的文件只在资源管理器里显示。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on || !UI.setViewOverride) return;
    const session = () => window.UTTUScriptoriumSession;
    const current = () => session()?.current?.() || null;
    const isMarkdown = (doc) => /\.(md|markdown)$/i.test(String(doc?.filePath || ''));
    // 新建的笔记一打开就是编辑视图（D12，文件夹页的“新建待办”“新建备忘”调 openForWriting）。
    let writeNext = '';
    // 这份文件打开时先看哪个视图：上游开文档时问（UI.openSurface），规则和下面的 document 事件一样。
    UI.markdownView = (file) => (isMarkdown({ filePath: file }) ? (samePath(file, writeNext) ? 'edit' : 'preview') : null);
    UI.on('document', (doc) => {
        const write = Boolean(writeNext) && samePath(doc?.filePath, writeNext);
        if (write) writeNext = '';
        UI.setViewOverride(isMarkdown(doc) ? (write ? 'edit' : 'preview') : null);
    });
    function openForWriting(file) {
        if (samePath(current()?.filePath, file)) { writeNext = ''; UI.setViewOverride('edit'); return; }
        writeNext = file;
        void session()?.openPath?.(file);
    }

    // ---------- 相对图片 ----------
    // 带协议（http:、data:、file:、C: 这样的盘符也算）、以 / \ # 开头的不动。
    const absolute = (url) => /^([a-z][a-z0-9+.-]*:|[\\/#])/i.test(url);
    function resolvePath(dir, relative) {
        let rel = relative.split('#')[0].split('?')[0];
        try { rel = decodeURIComponent(rel); } catch (_) { /* 原样用 */ }
        const parts = String(dir).replace(/\\/g, '/').replace(/\/$/, '').split('/');
        for (const segment of rel.replace(/\\/g, '/').split('/')) {
            if (!segment || segment === '.') continue;
            if (segment === '..') { if (parts.length > 1) parts.pop(); continue; }
            parts.push(segment);
        }
        return parts.join('/');
    }
    const inside = (target, root) => {
        const t = target.toLowerCase();
        const r = String(root).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
        return t === r || t.startsWith(`${r}/`);
    };
    const fileUrl = (target) => `file:///${target.split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')}`;
    const MEDIA = /(<(?:img|source|video|audio)\b[^>]*?\s(?:src|poster)\s*=\s*)(["'])([^"']*)\2/gi;
    function rewrite(html, markdownFile) {
        return String(html || '').replace(MEDIA, (match, head, quote, url) => {
            const raw = url.trim().replace(/&amp;/g, '&');
            if (!raw || absolute(raw)) return match;
            const target = resolvePath(markdownFile.dir, raw);
            // 范围外的不加载，留个标记（借图片路径读不到仓库外面的文件）。
            if (!inside(target, markdownFile.root || markdownFile.dir)) return `${head}${quote}${quote} data-uttu-outside="${encodeURIComponent(raw)}"`;
            return `${head}${quote}${fileUrl(target)}${quote}`;
        });
    }
    window.UTTUScriptoriumMarkdown = Object.freeze({
        resolver(base) {
            const markdownFile = current()?.markdownFile;
            if (!markdownFile?.dir) return base;
            return { ...(base || {}), resolveHtml: (html) => rewrite(base?.resolveHtml?.(html) || String(html || ''), markdownFile) };
        },
        _rewrite: rewrite,
        convert: () => convert(), // 转成文稿工程（文件菜单也调这个）
        firstPaint: (result) => firstPaint(result), // 大文件先画第一屏（scriptorium.js persistencePort.readPath）
        openForWriting: (file) => openForWriting(file), // 打开这份并直接进编辑视图（新建的笔记）
        reloadFromDisk: () => reloadFromDisk(), // 文件菜单“重新载入”、F5
    });

    // ---------- 跟上外部改动、恢复副本 ----------
    // 主进程盯着正在看的这份（modules/uttu/markdownFiles 的 watch-file），别处改了、删了就来说一声：
    // 这边没改过就重新载入（滚动位置留着）；这边也改了就在顶上二选一，那期间先不自动保存；删了就提一句，存一下会在原处重新写出来。
    // 有没存的改动时每隔几秒把正文送去存一份恢复副本（AppData，不在原文件旁边）；打开时还有副本就问要不要恢复。
    const { make, button, escapeHtml } = UI;
    const api = () => window.scriptoriumAPI;
    const samePath = (a, b) => Boolean(a && b) && String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();
    const bar = make('div', 'uttu-md-banner');
    bar.setAttribute('role', 'status');
    bar.hidden = true;
    document.body.append(bar);
    function showBar(kind, text, actions) {
        bar.dataset.kind = kind;
        bar.replaceChildren(make('span', 'uttu-md-banner-text', escapeHtml(text)),
            ...actions.map(([label, cls, act]) => button(`uttu-btn ${cls}`, label, escapeHtml(label), act)));
        bar.hidden = false;
        UI.pauseAutosave?.(kind === 'conflict');
    }
    function hideBar() {
        bar.hidden = true;
        bar.dataset.kind = '';
        UI.pauseAutosave?.(false);
    }
    async function reload(file, { discard = false } = {}) {
        const scrolled = ['read-host', 'render-host'].map((id) => document.getElementById(id)).filter(Boolean).map((node) => [node, node.scrollTop]);
        const opening = session()?.openPath?.(file);
        // 有改动时上游先弹“保存 / 舍弃”的框（同步弹出），这里选舍弃。
        if (discard) document.getElementById('unsaved-discard-btn')?.click();
        await opening;
        // 同一份文件重新载入不算换文档：上游把工作面切回编辑面，视图却没再套，屏幕上一直是旧的阅读面
        // （源码 0.3 秒就换了，阅读视图不变）。按当前视图重新套一遍。
        UI.applyView?.();
        setTimeout(() => requestAnimationFrame(() => scrolled.forEach(([node, top]) => { node.scrollTop = top; })), 250);
    }
    // 两边都改了、选了“用磁盘上的”：丢掉之前把这边那一版存成恢复副本，
    // 重新载入后顶上马上问“换回我的 / 不要了”。
    let discardedFrom = '';
    async function checkRecovery(file) {
        const saved = await api()?.markdownFolder?.('recovery-get', { path: file }).catch(() => null);
        if (!saved?.text || !samePath(current()?.filePath, file)) return;
        const when = new Date(saved.savedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        if (samePath(discardedFrom, file)) {
            discardedFrom = '';
            showBar('recovery', '换成了磁盘上的那一版。你刚才那一版留了一份。', [
                ['换回我的', 'ghost', () => { hideBar(); session()?.replaceSource?.(saved.text, 'uttu-md-recovery'); }],
                ['不要了', 'primary', () => { hideBar(); void api()?.markdownFolder?.('recovery-drop', { path: file }); }],
            ]);
            return;
        }
        showBar('recovery', `这份文件有上次没存下来的改动（${when}）。`, [
            ['恢复', 'primary', () => { hideBar(); session()?.replaceSource?.(saved.text, 'uttu-md-recovery'); }],
            ['不要了', 'ghost', () => { hideBar(); void api()?.markdownFolder?.('recovery-drop', { path: file }); }],
        ]);
    }
    let watched = '';
    UI.on('document', (doc) => {
        if (bar.dataset.kind) hideBar();
        const file = isMarkdown(doc) ? doc.filePath : '';
        if (!samePath(file, watched)) {
            watched = file;
            void api()?.markdownFolder?.('watch-file', { path: file || null }).catch(() => {});
        }
        if (file) void checkRecovery(file);
    });
    api()?.onMarkdownEvent?.((event) => {
        if (event?.type === 'folder-changed') { window.UTTUScriptoriumFolder?.invalidate?.(event.dirs || []); return; }
        const doc = current();
        if (!doc?.filePath || !samePath(event?.path, doc.filePath)) return;
        if (event.type === 'file-deleted') {
            showBar('deleted', '磁盘上找不到这份文件了（被删了，或者挪走了）。存一下会在原处重新写出来。', [['知道了', 'ghost', hideBar]]);
            return;
        }
        if (event.type !== 'file-changed') return;
        if (!doc.dirty) {
            void reload(doc.filePath);
            UI.toast?.('别处改了这份文件，已经重新载入。');
            return;
        }
        const useDisk = async () => {
            hideBar();
            // 这边那一版先存一份（AppData 里的恢复副本），载入后可以换回来。
            await api()?.markdownFolder?.('recovery-save', { path: doc.filePath, text: session()?.source?.() || '' }).catch(() => {});
            discardedFrom = doc.filePath;
            void reload(doc.filePath, { discard: true });
        };
        const keepMine = async () => {
            await api()?.markdownFolder?.('accept-disk', { path: doc.filePath });
            hideBar();
            document.getElementById('save-btn')?.click();
        };
        // 看两边差在哪（uttu-scriptorium-diff.js）：按行比，面板下面照样二选一；关掉面板时顶上这条还在。
        const compare = async () => {
            try {
                const disk = await api().markdownFolder('disk-text', { path: doc.filePath });
                window.UTTUScriptoriumDiff?.show(disk.text, session()?.source?.() || '', [['用磁盘上的', 'ghost', useDisk], ['保留我的', 'primary', keepMine]]);
            } catch (error) {
                UI.toast?.(`比不了：${error.message}`, 'error', 5000);
            }
        };
        showBar('conflict', '磁盘上的这份文件被别处改了，你这边也有没存的改动。', [
            ['看两边差在哪', 'ghost', () => void compare()],
            ['用磁盘上的', 'ghost', () => void useDisk()],
            ['保留我的', 'primary', () => void keepMine()],
        ]);
    });
    // 切回来再核一次：窗口拿回焦点、页面重新可见时，让主进程立刻比一次磁盘上的（监视器漏掉的也补上）。
    // 网页也一样（uttu-scriptorium-page.js 的监视在 modules/uttu/webPages）。半秒内只核一次。
    let lastCheck = 0;
    function checkDisk() {
        if (Date.now() - lastCheck < 500) return;
        lastCheck = Date.now();
        const doc = UI.doc();
        if (doc?.kind === 'web-page') void api()?.page?.('check', {}).catch(() => {});
        else if (isMarkdown(doc)) void api()?.markdownFolder?.('check-file', { path: doc.filePath }).catch(() => {});
        UI.emit('disk-check');
    }
    window.addEventListener('focus', checkDisk);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkDisk(); });

    // 重新载入（文件菜单、F5）：从磁盘重新读当前这份。没改动直接读；有没存的改动先在顶上问，选了才丢。
    // .md、文稿工程、网页都行；网页交给它自己的 reload。
    function reloadFromDisk() {
        const doc = UI.doc();
        if (!doc?.filePath) return;
        const page = UI.overlay(); // 网页、PDF、表格各有自己的重新载入
        const go = (discard) => (page ? page.reload() : reload(doc.filePath, { discard }));
        if (!doc.dirty) {
            void Promise.resolve(go(false)).then(() => UI.toast?.('已从磁盘重新载入。'));
            return;
        }
        showBar('reload', '这份有没存的改动，重新载入会把它们丢掉。', [
            ['丢掉改动，重新载入', 'ghost', async () => {
                hideBar();
                // .md：丢掉的那一版也留一份，载入后可以换回来（和“用磁盘上的”一样）。
                if (!page && isMarkdown(doc)) {
                    await api()?.markdownFolder?.('recovery-save', { path: doc.filePath, text: session()?.source?.() || '' }).catch(() => {});
                    discardedFrom = doc.filePath;
                }
                void go(true);
            }],
            ['取消', 'primary', hideBar],
        ]);
    }
    window.addEventListener('keydown', (event) => {
        if (event.key !== 'F5' || event.ctrlKey || event.altKey || event.metaKey) return;
        event.preventDefault();
        event.stopPropagation();
        reloadFromDisk();
    }, true);

    UI.on('start', () => {
        let timer = 0;
        session()?.subscribe?.((event) => {
            if (event?.type !== 'document-mutated') return;
            clearTimeout(timer);
            timer = setTimeout(() => {
                const doc = current();
                if (!isMarkdown(doc) || !doc.dirty) return;
                void api()?.markdownFolder?.('recovery-save', { path: doc.filePath, text: session().source() }).catch(() => {});
            }, 3000);
        });
    });

    // ---------- 链接 ----------
    const slug = (text) => String(text || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '');
    function scrollToAnchor(anchor, id) {
        const root = anchor.getRootNode();
        let wanted = id;
        try { wanted = decodeURIComponent(id); } catch (_) { /* 原样用 */ }
        const target = root.getElementById?.(wanted) || root.querySelector?.(`[name="${CSS.escape(wanted)}"]`)
            || [...(root.querySelectorAll?.('h1, h2, h3, h4, h5, h6') || [])].find((heading) => slug(heading.textContent) === slug(wanted));
        if (target) target.scrollIntoView({ block: 'start' });
        else UI.toast?.(`文中没有“${wanted}”这一节。`);
    }
    // 链到 .html：在文坊里当网页开。openPath 对 .html 走的就是 UTTUScriptoriumPage.open（scriptorium.js uttuRoute），
    // 这里直接调它，好把 #锚点带上（接在网页地址后面）。
    function openPage({ path, hash }) {
        const page = window.UTTUScriptoriumPage;
        return page?.open ? page.open(path, { hash }) : session()?.openPath?.(path);
    }
    document.addEventListener('click', (event) => {
        const doc = current();
        if (!isMarkdown(doc) || event.button !== 0) return;
        const anchor = event.composedPath().find((node) => node?.tagName === 'A' && node.hasAttribute?.('href'));
        if (!anchor) return;
        const inRead = Boolean(event.composedPath().find((node) => node?.id === 'read-host'));
        // 编辑面里点链接是放光标；按住 Ctrl 才跟着链接走。两种情况都不让页面自己跳走。
        event.preventDefault();
        if (!inRead && !(event.ctrlKey || event.metaKey)) return;
        const href = anchor.getAttribute('href').trim();
        if (href.startsWith('#')) { scrollToAnchor(anchor, href.slice(1)); return; }
        const api = window.scriptoriumAPI;
        if (!api?.markdownOpenLink) return;
        void api.markdownOpenLink({ href, dir: doc.markdownFile?.dir || '' }).then((result) => {
            if (result?.kind === 'markdown') void session()?.openPath?.(result.path);
            else if (result?.kind === 'web-page') void openPage(result);
            else if (result?.kind === 'missing') UI.toast?.(`找不到这个文件：${result.path}`);
            else if (result?.kind === 'revealed') UI.toast?.('不是 Markdown 也不是网页，已在资源管理器里显示。');
        }).catch((error) => UI.toast?.(`打不开这个链接：${error.message}`));
    }, true);

    // ---------- 转成文稿工程 ----------
    // .md 可以直接改、存回原文件（视图切到编辑或双栏）；要用文坊的版式、插图这些，就转成一份文稿工程（.vdocx，默认存进文库），
    // 正文里引用的本机图片一起装进去（主进程 markdownFiles/toProject.js）。用的是屏幕上这一版（没存的改动也算），原来的 .md 不动。
    // 转好就打开那份工程。顶栏右边一颗“转成工程”（只在 .md 时出现），文件菜单里也有。
    let converting = false;
    async function convert() {
        const doc = current();
        if (!doc?.markdownFile || converting) return;
        converting = true;
        try {
            const result = await api()?.markdownFolder?.('convert', {
                text: session()?.source?.() || '',
                css: doc.documentCss || '',
                title: String(doc.filePath || '').split(/[\\/]/).pop() || '',
                markdownFile: doc.markdownFile,
            });
            if (!result?.success) return;
            await session()?.openPath?.(result.filePath);
            const left = result.skipped?.length ? `；${result.skipped.length} 个文件在仓库外面或找不到，没带上，正文里照原样留着` : '';
            UI.toast?.(`转成了文稿工程${result.embedded ? `，带上了 ${result.embedded} 张图片` : ''}${left}。原来的 .md 没动。`);
        } catch (error) {
            UI.toast?.(`没转成：${error.message}`);
        } finally {
            converting = false;
        }
    }
    // ---------- 大文件先画第一屏 ----------
    // 整篇排一份大 .md 要几秒（编译、阅读面整篇排版，都在主线程上）。主进程读到大文件时带上开头一段原文（result.preview，
    // markdownFiles openingOf），这里先用 marked 排出来，叠在阅读区上面：和阅读面一样的结构（.render-host > .page-stream 的影子根，
    // 里面 style 和 .vdoc-runtime），样式用上一份 .md 阅读面的（记在 localStorage，换窗口也在）。让出一帧画出来再开始整篇；
    // 阅读面换成这份文档的新内容时撤掉。还没记过样式（全新的环境）用一份简单的。
    const PAINT_CSS_KEY = 'uttu.scriptorium.mdReadCss';
    const FALLBACK_CSS = ':host { display: block; min-height: 100%; } .vdoc-runtime { box-sizing: border-box; max-width: 48rem; margin: 0 auto; '
        + 'padding: 48px 56px; color: var(--uttu-text); font: 16px/1.75 var(--uttu-font-body); } .vdoc-runtime img { max-width: 100%; } '
        + '.vdoc-runtime pre { overflow: auto; } .vdoc-runtime table { border-collapse: collapse; }';
    let paintCss = null;
    try { paintCss = localStorage.getItem(PAINT_CSS_KEY); } catch (_) { /* 没有本地存储就用简单的 */ }
    let paintSheets = [];
    let paintLayer = null;
    const dropLayer = () => { paintLayer?.remove(); paintLayer = null; };
    const readRuntime = () => document.getElementById('read-page-stream')?.shadowRoot?.querySelector('.vdoc-runtime') || null;
    function rememberReadCss() {
        const root = document.getElementById('read-page-stream')?.shadowRoot;
        const style = root?.querySelector('style');
        if (!style?.textContent || !readRuntime()?.childElementCount) return;
        paintSheets = [...root.adoptedStyleSheets];
        if (style.textContent === paintCss) return;
        paintCss = style.textContent;
        try { localStorage.setItem(PAINT_CSS_KEY, paintCss); } catch (_) { /* 只在这一次用 */ }
    }
    // 一份 .md 的阅读面排好后记下它的样式，留给下一份大文件的第一屏。
    UI.on('document', (doc) => { if (isMarkdown(doc)) setTimeout(rememberReadCss, 800); });
    function backgroundOf(node) {
        for (let current = node; current && current !== document.documentElement; current = current.parentElement) {
            const color = getComputedStyle(current).backgroundColor;
            if (color && color !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(color)) return color;
        }
        return getComputedStyle(document.body).backgroundColor;
    }
    async function firstPaint(result) {
        dropLayer();
        const preview = result?.preview;
        if (!preview?.text || typeof window.marked?.parse !== 'function') return;
        const host = [document.getElementById('read-host'), document.getElementById('render-host')].find((node) => node?.getClientRects().length);
        if (!host?.parentElement) return;
        let html;
        try {
            // 属性段和整篇一样画成小表（uttu-frontmatter.js），换下来时不跳。
            const front = window.UTTUFrontmatter?.scan?.(preview.text);
            html = (front ? window.UTTUFrontmatter.markup(front) : '')
                + window.marked.parse(front ? preview.text.slice(front.end) : preview.text, { gfm: true, breaks: true, async: false });
            if (window.VDocCore?.sanitizeHtml) html = window.VDocCore.sanitizeHtml(html);
            html = rewrite(html, { dir: preview.dir, root: preview.root });
        } catch (_) {
            return;
        }
        paintLayer = make('div', 'render-host uttu-md-firstpaint');
        paintLayer.style.background = backgroundOf(host);
        const stream = make('div', 'page-stream');
        const root = stream.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = paintCss || FALLBACK_CSS;
        root.adoptedStyleSheets = paintSheets;
        const runtime = document.createElement('div');
        runtime.className = 'vdoc-runtime vdoc-flow-runtime';
        runtime.innerHTML = html;
        root.append(style, runtime);
        paintLayer.append(stream);
        host.parentElement.append(paintLayer);
        // 阅读面每画一次都换一个新的 .vdoc-runtime：等到它是这份文档、又不是现在这个旧的，就撤掉第一屏。
        const file = result.filePath;
        const before = readRuntime();
        const layer = paintLayer;
        const started = Date.now();
        const watch = () => {
            if (paintLayer !== layer) return;
            const runtimeNow = readRuntime();
            const done = samePath(current()?.filePath, file) && runtimeNow && runtimeNow !== before && runtimeNow.childElementCount > 0;
            if (done || Date.now() - started > 20000) {
                if (done) rememberReadCss();
                dropLayer();
                return;
            }
            setTimeout(watch, 80);
        };
        setTimeout(watch, 80);
        // 让出一帧：第一屏先画到屏幕上，再做整篇的重活。
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    }

})();
