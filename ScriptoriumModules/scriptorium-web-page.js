// 文坊中的网页（.html、.htm）。网页原样显示，不再导入为文稿（导入会丢失脚本和样式）：
// 预览是 sandbox="allow-scripts" 的 iframe，地址为主进程的 scriptorium-page://（modules/scriptorium/webPages，
// 只提供网页所在文件夹中的静态文件，不能联网取数据）；源码用 CodeMirror 编辑，保存回原文件。
// 可在预览、源码、双栏之间切换，打开时为预览。保存后或文件被外部修改后，预览自动刷新；
// 有未保存的修改时文件又被外部修改，在栏头询问保留哪一边。打开网页时，原来的文档留在后面保持不动。
(() => {
    'use strict';
    const UI = window.ScriptoriumFileViews;
    if (!UI?.on) return;
    const { make, button, icon, setText } = UI;
    const api = () => window.scriptoriumAPI;
    const session = () => window.ScriptoriumFileSession;
    const isPage = (file) => /\.html?$/i.test(String(file || ''));
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const welcomeShown = () => document.getElementById('welcome-state')?.hidden === false;
    const VIEWS = [['preview', '预览'], ['source', '源码'], ['split', '双栏']];

    let page = null; // { filePath, name, url, eol, bom, encoding, mtime, generation, saving, dark }
    let generation = 0;
    let clean = 0; // CodeMirror 的 changeGeneration，用于判断是否有未保存的修改
    let editor = null;
    let loading = false; // 载入内容时不计为修改
    let zoom = 100;
    let frameRound = 0;
    let mode = VIEWS.some(([key]) => key === UI.layout.pageView) ? UI.layout.pageView : 'preview';

    // ---------- 结构：栏头 + 源码 | 分隔条 | 预览 ----------
    const work = make('div', 'scriptorium-page-work');
    work.hidden = true;
    work.setAttribute('aria-label', '网页');
    const head = make('div', 'scriptorium-pane-head');
    const label = make('span', 'scriptorium-pane-label', '网页');
    const viewSwitch = make('div', 'scriptorium-seg sm');
    viewSwitch.setAttribute('role', 'group');
    viewSwitch.setAttribute('aria-label', '显示方式');
    for (const [key, text] of VIEWS) {
        const option = button('', '', text, () => setView(key));
        option.dataset.view = key;
        viewSwitch.append(option);
    }
    const conflict = make('span', 'scriptorium-file-conflict');
    conflict.hidden = true;
    conflict.append(make('span', '', '文件已在别处修改'),
        button('scriptorium-file-button', '', '使用文件中的版本', () => void reload({ discard: true })),
        button('scriptorium-file-button', '', '保留我的修改', () => void save({ force: true })));
    const blocked = make('span', 'scriptorium-file-conflict');
    blocked.hidden = true;
    const blockedText = make('span', '');
    let blockedUrl = '';
    blocked.append(blockedText,
        button('scriptorium-file-button', '', '在浏览器中打开', () => {
            const url = blockedUrl;
            blocked.hidden = true;
            if (url) void api()?.markdownOpenLink?.({ href: url, from: page?.filePath || '' }).catch(() => {});
        }),
        button('scriptorium-file-button icon', '忽略', icon('i-x'), () => { blocked.hidden = true; }));
    const reloadButton = button('scriptorium-file-button icon', '刷新预览', icon('i-reload'), () => loadFrame());
    const zoomOut = button('scriptorium-file-button icon', '缩小', icon('i-minus'), () => setZoom(zoom - 10));
    const zoomValue = button('scriptorium-file-button', '恢复 100%', '100%', () => setZoom(100));
    const zoomIn = button('scriptorium-file-button icon', '放大', icon('i-plus'), () => setZoom(zoom + 10));
    head.append(label, viewSwitch, make('span', 'grow'), conflict, blocked, reloadButton, zoomOut, zoomValue, zoomIn);

    const panes = make('div', 'scriptorium-page-panes');
    const sourceHost = make('div', 'scriptorium-pane-body scriptorium-page-source source-editor-shell');
    sourceHost.setAttribute('aria-label', '网页源码');
    const split = make('div', 'scriptorium-split');
    split.setAttribute('role', 'separator');
    split.setAttribute('aria-orientation', 'vertical');
    split.setAttribute('aria-label', '拖动调整两栏宽度，双击恢复各占一半');
    const stage = make('div', 'scriptorium-pane-body scriptorium-page-stage');
    stage.setAttribute('aria-label', '网页预览');
    panes.append(sourceHost, split, stage);
    work.append(head, panes);

    const workspace = document.getElementById('document-workspace');
    (workspace?.parentElement || document.body).append(work);
    work.style.setProperty('--scriptorium-split', `${UI.layout.split || 50}%`);

    split.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        split.setPointerCapture(event.pointerId);
        split.classList.add('drag');
        const box = panes.getBoundingClientRect();
        const move = (moveEvent) => {
            UI.layout.split = Math.round(Math.min(78, Math.max(22, (moveEvent.clientX - box.left) / box.width * 100)));
            work.style.setProperty('--scriptorium-split', `${UI.layout.split}%`);
        };
        const up = () => {
            split.classList.remove('drag');
            split.removeEventListener('pointermove', move);
            split.removeEventListener('pointerup', up);
            split.removeEventListener('pointercancel', up);
            UI.saveLayout();
        };
        split.addEventListener('pointermove', move);
        split.addEventListener('pointerup', up);
        split.addEventListener('pointercancel', up);
    });
    split.addEventListener('dblclick', () => {
        UI.layout.split = 50;
        work.style.setProperty('--scriptorium-split', '50%');
        UI.saveLayout();
    });

    function setView(next) {
        mode = next;
        work.dataset.view = next;
        viewSwitch.querySelectorAll('button').forEach((option) => option.setAttribute('aria-pressed', String(option.dataset.view === next)));
        UI.layout.pageView = next;
        UI.saveLayout();
        if (next !== 'preview') refreshEditor();
    }

    // ---------- 源码 ----------
    function ensureEditor() {
        if (editor || !window.CodeMirror) return editor;
        editor = window.CodeMirror(sourceHost, {
            value: '',
            mode: 'htmlmixed',
            theme: 'material-darker',
            lineNumbers: true,
            lineWrapping: true,
            indentUnit: 4,
            tabSize: 4,
            indentWithTabs: false,
            autoCloseBrackets: true,
            autoCloseTags: true,
            viewportMargin: 20,
        });
        editor.on('change', () => {
            if (loading || !page) return;
            UI.sync?.();
        });
        return editor;
    }
    const dirty = () => Boolean(page && editor && !editor.isClean(clean));
    function setSource(text, { keepView = false } = {}) {
        const cm = ensureEditor();
        if (!cm) return;
        const cursor = keepView ? cm.getCursor() : null;
        const scroll = keepView ? cm.getScrollInfo() : null;
        loading = true;
        cm.setValue(text);
        cm.clearHistory();
        loading = false;
        clean = cm.changeGeneration();
        if (cursor) cm.setCursor(cursor);
        if (scroll) cm.scrollTo(scroll.left, scroll.top);
    }
    // 源码栏从隐藏变为显示时刷新：第一次在下一帧，此时行号栏宽度有时仍按隐藏时计算，稍后再刷新一次。
    let refreshTimer = 0;
    const refreshNow = () => { try { editor?.refresh(); } catch (_) { /* 隐藏中 */ } };
    const refreshEditor = () => {
        requestAnimationFrame(refreshNow);
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refreshNow, 250);
    };
    if (window.ResizeObserver) new ResizeObserver(refreshEditor).observe(sourceHost);
    setView(mode); // 恢复上次的显示方式（须在 refreshEditor 定义之后）

    // ---------- 预览 ----------
    // 网页声明只用深色（<meta name="color-scheme" content="dark"> 或样式中 color-scheme: dark）时，框按深色方案绘制底色，
    // 避免网页在框内跳转时闪白。未声明的网页与浏览器一样用白底。
    function darkPage(text) {
        const source = String(text || '');
        const meta = source.match(/<meta\b[^>]*\bname\s*=\s*["']color-scheme["'][^>]*>/i);
        if (meta) return /\bcontent\s*=\s*["']\s*dark\s*["']/i.test(meta[0]);
        return /(?<![\w-])color-scheme\s*:\s*dark\s*[;}]/i.test(source);
    }

    // 每次载入都换一个新的 iframe：旧框中运行的脚本和声音一并停止；新框从空白页开始，主进程的跳转拦截不会把它当作网页自行跳转。
    // hash：从 .md 链接打开时带的锚点。
    function loadFrame(hash = '') {
        blocked.hidden = true;
        stage.replaceChildren();
        if (!page) return;
        const frame = document.createElement('iframe');
        frame.className = 'scriptorium-page-frame';
        if (page.dark) frame.dataset.scheme = 'dark';
        frame.name = 'scriptorium-page-frame'; // 主进程据此识别网页框（modules/scriptorium/webPages）
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.title = page.name;
        frameRound += 1;
        frame.src = `${page.url}?scriptorium-round=${frameRound}${hash ? `#${hash}` : ''}`;
        stage.append(frame);
        applyZoom();
    }
    // 缩放：iframe 按比例缩放，宽高反向补偿，网页的排版宽度随之变化（与浏览器缩放一致）。
    function applyZoom() {
        const frame = stage.querySelector('iframe');
        setText(zoomValue, `${zoom}%`);
        if (!frame) return;
        const scale = zoom / 100;
        frame.style.width = `${100 / scale}%`;
        frame.style.height = `${100 / scale}%`;
        frame.style.transform = scale === 1 ? '' : `scale(${scale})`;
    }
    function setZoom(value) {
        zoom = Math.max(50, Math.min(200, Math.round(value / 10) * 10));
        applyZoom();
    }

    // ---------- 打开、离开 ----------
    function leave() {
        if (!page) return;
        page = null;
        document.body.classList.remove('scriptorium-page-mode');
        work.hidden = true;
        stage.replaceChildren();
        conflict.hidden = true;
        void api()?.page?.('watch', { file: null }).catch(() => {});
        UI.sync?.();
    }

    async function open(file, { hash = '' } = {}) {
        if (!isPage(file)) return false;
        if (page && same(page.filePath, file)) {
            if (hash) loadFrame(hash);
            return true;
        }
        let result;
        try {
            result = await api().page('read', { file });
        } catch (error) {
            result = { success: false, error: error.message };
        }
        if (!result?.success) {
            UI.toast(`未能打开这个网页：${result?.error || '读取失败'}`, 'error', 5000);
            return false;
        }
        page = { filePath: result.filePath, name: result.name, url: result.url, eol: result.eol, bom: result.bom, encoding: result.encoding,
            mtime: result.mtime, generation: ++generation, saving: false, dark: darkPage(result.text) };
        conflict.hidden = true;
        document.body.classList.add('scriptorium-page-mode');
        work.hidden = false;
        setSource(result.text);
        loadFrame(hash);
        void api().page('watch', { file: result.filePath }).catch(() => {});
        UI.sync?.();
        refreshEditor();
        return true;
    }

    // 文坊的打开都经过这里（ScriptoriumFileViews.routeOverlay）：网页由本视图打开；打开别的文件时先离开网页。
    // 要打开的正是后面那份文档时直接露出，不重新读取；.md 例外，没有未保存的修改时照常重新读取，以取得外部修改。
    function route(file) {
        if (isPage(file)) return open(file);
        if (!page) return null;
        const behind = session()?.current?.();
        leave();
        const stale = /\.(md|markdown)$/i.test(String(file)) && !behind?.dirty;
        if (behind && !welcomeShown() && same(behind.filePath, file) && !stale) return Promise.resolve(true);
        return null;
    }

    // ---------- 保存、重新载入、外部修改 ----------
    async function save({ force = false } = {}) {
        if (!page || !editor) return false;
        if (!dirty() && !force) return true;
        const target = page;
        const text = editor.getValue();
        const generationAtSave = editor.changeGeneration();
        target.saving = true;
        UI.sync?.();
        let result;
        try {
            result = await api().page('save', { file: target.filePath, text, mtime: target.mtime, eol: target.eol, bom: target.bom, encoding: target.encoding, force });
        } catch (error) {
            result = { success: false, error: error.message };
        }
        target.saving = false;
        if (page !== target) return Boolean(result?.success);
        if (result?.conflict) {
            showConflict();
            UI.sync?.();
            return false;
        }
        if (!result?.success) {
            UI.toast(`未能保存：${result?.error || '写入失败'}`, 'error', 5000);
            UI.sync?.();
            return false;
        }
        page.mtime = result.mtime;
        clean = generationAtSave;
        conflict.hidden = true;
        UI.sync?.();
        loadFrame();
        return true;
    }
    async function reload({ discard = false } = {}) {
        if (!page || (dirty() && !discard)) return;
        let result;
        try {
            result = await api().page('read', { file: page.filePath });
        } catch (error) {
            result = { success: false, error: error.message };
        }
        if (!page || !result?.success) {
            if (result && !result.success) UI.toast(`未能重新读取：${result.error || ''}`, 'error', 5000);
            return;
        }
        Object.assign(page, { mtime: result.mtime, eol: result.eol, bom: result.bom, encoding: result.encoding, url: result.url, dark: darkPage(result.text) });
        conflict.hidden = true;
        setSource(result.text, { keepView: true });
        UI.sync?.();
        loadFrame();
    }
    function showConflict() {
        conflict.hidden = false;
        if (mode === 'preview') setView('split');
    }
    api()?.onPageChanged?.((payload) => {
        if (!page || !same(payload?.file, page.filePath)) return;
        if (Math.abs(Number(payload.mtime) - page.mtime) <= 1) return;
        if (dirty()) showConflict();
        else void reload();
    });
    UI.on('disk-check', () => { if (page) void api()?.page?.('check').catch(() => {}); });
    // 网页试图跳转到外部地址时被主进程拦下：刷新回网页，在栏头询问是否用浏览器打开。
    api()?.onPageBlocked?.((payload) => {
        if (!page || !payload?.url) return;
        loadFrame();
        blockedUrl = String(payload.url);
        let host = blockedUrl;
        try { host = new URL(blockedUrl).host; } catch (_) { /* 原样显示 */ }
        setText(blockedText, `网页请求打开 ${host}`);
        blocked.hidden = false;
    });

    // 打开网页时，撤销、重做不作用到后面的文稿上（保存由 scriptorium-file-views.js 统一处理）。
    window.addEventListener('keydown', (event) => {
        if (!page || !(event.ctrlKey || event.metaKey) || event.altKey) return;
        if (['z', 'y'].includes(event.key.toLowerCase()) && !sourceHost.contains(event.target)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
    sourceHost.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) event.stopPropagation();
    });

    UI.on('start', () => {
        // 原有流程换了文稿（新建、导入、从首页打开）：离开网页，露出那份文稿。
        session()?.subscribe?.((event) => {
            if (page && event?.type === 'document-replaced' && !UI.replacedByLastOpen()) setTimeout(leave, 0);
        });
    });

    const view = Object.freeze({
        claims: isPage,
        open,
        route,
        leave,
        save: () => save(),
        reload: () => reload({ discard: true }),
        active: () => Boolean(page),
        // 供 Agent 读取：网页框中排版后的文字（由主进程从框中读取，包括脚本生成的内容）、当前源码（含未保存的修改）与截图范围。
        agent: Object.freeze({
            text: async () => {
                const result = await api().page('frame-text');
                if (!result?.success) throw new Error(result?.error || '未能读取网页的文字。');
                return result.text;
            },
            source: () => editor?.getValue() ?? '',
            surface: () => (mode === 'source' ? sourceHost : stage),
        }),
        doc: () => (page ? Object.freeze({ kind: 'web-page', filePath: page.filePath, name: page.name, generation: page.generation,
            dirty: dirty(), saving: page.saving, revision: 0 }) : null),
        _state: () => ({ page: page && { ...page }, dirty: dirty(), zoom, view: mode }),
    });
    window.ScriptoriumWebPage = view;
    UI.registerOverlay(view);
})();
