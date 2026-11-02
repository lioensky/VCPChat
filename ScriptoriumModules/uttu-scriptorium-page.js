// 文坊里的网页。.html / .htm 不再导入成文稿（脚本、样式会丢），
// 原样显示：预览栏是 sandbox="allow-scripts" 的 iframe，地址是主进程的 uttu-page://（modules/uttu/webPages，只供这份网页
// 所在仓库里的静态网页文件，不能连网取数据）；编辑栏是这份文件的源码（CodeMirror，代码配色），存回原文件。
// 视图照常：预览 / 编辑 / 双栏，打开时是预览。存了、或者文件在外面被改了（Agent 改的），预览自己刷新；
// 有没存的修改时外面又改了，栏头问用哪份。
// 文坊一次只装一份文稿：开网页时上游的文稿留在后面不动（UI.doc() 这时回网页，kind 'web-page'），切回去不用重新读。
// 切到别的标签时没存的修改留在内存里，切回来还在；关掉标签时存好再关。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;
    const { make, button, icon, setText } = UI;
    const api = () => window.scriptoriumAPI;
    const session = () => window.UTTUScriptoriumSession;
    const isPage = (file) => /\.html?$/i.test(String(file || ''));
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const welcomeShown = () => document.getElementById('welcome-state')?.hidden === false;

    let page = null; // { filePath, name, url, eol, bom, mtime, generation, saving }
    let generation = 0;
    let clean = 0; // CodeMirror 的 changeGeneration：和它比就知道有没有没存的修改
    let editor = null;
    let loading = false; // 换内容时不算改动
    let zoom = 100;
    let frameRound = 0;
    let autosaveTimer = 0;
    const drafts = new Map(); // 切走时没存的修改：路径 → { text, mtime, eol, bom }

    // ---------- 搭结构：和文稿的两栏一样（.uttu-panes 里 .uttu-pane.ed | .uttu-split | .uttu-pane.pv），视图的样式直接套 ----------
    const work = make('div', 'uttu-panes uttu-page-work');
    work.hidden = true;
    work.setAttribute('aria-label', '网页');
    const edit = make('section', 'uttu-pane ed');
    edit.setAttribute('aria-label', '网页源码');
    const editHead = make('div', 'uttu-pane-head');
    const sourceLabel = make('span', 'uttu-pane-label', '源码<small>HTML</small>');
    const conflict = make('span', 'uttu-page-conflict');
    conflict.hidden = true;
    const conflictText = make('span', '', '文件在别处改过了');
    conflict.append(conflictText,
        button('uttu-btn ghost small', '', '用文件里的', () => void reload({ discard: true })),
        button('uttu-btn ghost small', '', '用我改的', () => void save({ force: true })));
    editHead.append(sourceLabel, make('span', 'grow'), conflict);
    const sourceHost = make('div', 'uttu-pane-body uttu-page-source');
    edit.append(editHead, sourceHost);

    const split = make('div', 'uttu-split');
    split.setAttribute('role', 'separator');
    split.setAttribute('aria-orientation', 'vertical');
    split.setAttribute('aria-label', '拖动调整两栏宽度，双击回到一半');

    const preview = make('section', 'uttu-pane pv');
    preview.setAttribute('aria-label', '网页预览');
    const previewHead = make('div', 'uttu-pane-head');
    const previewLabel = make('span', 'uttu-pane-label', '网页<small></small>');
    const blocked = make('span', 'uttu-page-blocked');
    blocked.hidden = true;
    const blockedText = make('span', '');
    let blockedUrl = '';
    blocked.append(blockedText,
        button('uttu-btn ghost small', '', '用浏览器打开', () => {
            const url = blockedUrl;
            blocked.hidden = true;
            if (url) void api()?.markdownOpenLink?.({ href: url, from: page?.filePath || '' }).catch(() => {});
        }),
        button('uttu-tb', '不打开', icon('i-x'), () => { blocked.hidden = true; }));
    const reloadButton = button('uttu-tb', '刷新网页', icon('i-reload'), () => loadFrame());
    const zoomOut = button('uttu-tb', '缩小', icon('i-minus'), () => setZoom(zoom - 10));
    const zoomValue = button('uttu-tb-drop plain', '', '100%', () => setZoom(100));
    const zoomIn = button('uttu-tb', '放大', icon('i-plus'), () => setZoom(zoom + 10));
    const Pick = window.UTTUScriptoriumPick;
    const pickTool = Pick.toolSeg('浏览', (mode) => void setPicking(mode), [['edit', '修改']]);
    previewHead.append(previewLabel, pickTool, make('span', 'grow'), blocked, reloadButton, zoomOut, zoomValue, zoomIn);
    const stage = make('div', 'uttu-pane-body uttu-page-stage');
    const frameHost = make('div', 'uttu-page-frame-host');
    const pickLayer = make('div', 'uttu-pick-layer'); // 批注模式盖在框上接住指针，网页本身收不到（uttu-scriptorium-pick.js）
    stage.append(frameHost, pickLayer);
    preview.append(previewHead, stage);
    work.append(edit, split, preview);

    const workspace = document.getElementById('document-workspace');
    (workspace?.parentElement || document.body).append(work);
    // 左栏停在目录时换成这句（CSS 只在开着网页时摆出）。
    document.getElementById('outline-panel')?.append(make('p', 'uttu-left-note uttu-left-page-note', '开着的是网页，它没有目录。'));
    work.style.setProperty('--uttu-split', `${UI.layout?.split || 50}%`);

    // 分隔条：和文稿的两栏用同一个比例（记在布局里）。
    split.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        split.setPointerCapture(event.pointerId);
        split.classList.add('drag');
        const box = work.getBoundingClientRect();
        const move = (moveEvent) => {
            UI.layout.split = Math.round(Math.min(78, Math.max(22, (moveEvent.clientX - box.left) / box.width * 100)));
            for (const node of [work, workspace]) node?.style.setProperty('--uttu-split', `${UI.layout.split}%`);
        };
        const up = () => {
            split.classList.remove('drag');
            split.removeEventListener('pointermove', move);
            split.removeEventListener('pointerup', up);
            split.removeEventListener('pointercancel', up);
            UI.saveLayout?.();
            UI.emit('resize');
        };
        split.addEventListener('pointermove', move);
        split.addEventListener('pointerup', up);
        split.addEventListener('pointercancel', up);
    });
    split.addEventListener('dblclick', () => {
        UI.layout.split = 50;
        for (const node of [work, workspace]) node?.style.setProperty('--uttu-split', '50%');
        UI.saveLayout?.();
    });

    // ---------- 源码 ----------
    function ensureEditor() {
        if (editor || !window.CodeMirror) return editor;
        editor = window.CodeMirror(sourceHost, {
            value: '',
            mode: 'htmlmixed',
            theme: 'uttu-code', // 代码配色令牌（styles/ui-system/uttu-code-scheme.css）
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
            scheduleAutosave();
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
    // 从藏着到摆出（预览切到双栏、编辑）时刷新：第一次在下一帧，它量到的行号栏位置有时还是藏着时的 0（行号压住每行开头），
    // 过一会儿再刷一次就对了。
    let refreshTimer = 0;
    const refreshNow = () => { try { editor?.refresh(); } catch (_) { /* 藏着 */ } };
    const refreshEditor = () => {
        requestAnimationFrame(refreshNow);
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refreshNow, 250);
    };
    if (window.ResizeObserver) new ResizeObserver(refreshEditor).observe(sourceHost);

    // ---------- 预览 ----------
    // 网页自己声明只用深色（<meta name="color-scheme" content="dark">，或样式里 color-scheme: dark）：框也按深色方案画底。
    // 框原来一律是白底，网页在框里跳到下一页时（讲解 01、02、03 之间切），旧页卸掉、新页画出来之前会闪一下白。
    // 没声明的网页照旧白底，和浏览器一样。
    function darkPage(text) {
        const source = String(text || '');
        const meta = source.match(/<meta\b[^>]*\bname\s*=\s*["']color-scheme["'][^>]*>/i);
        if (meta) return /\bcontent\s*=\s*["']\s*dark\s*["']/i.test(meta[0]);
        return /(?<![\w-])color-scheme\s*:\s*dark\s*[;}]/i.test(source);
    }

    // 每次换一个新的 iframe：旧的里面在跑的脚本、声音一起停；新框从空白页出发，主进程的跳转拦截不会把它当成网页自己往外跳。
    // hash：从 .md 链过来时带的 #锚点，接在地址后面，网页自己滚到那里。
    function loadFrame(hash = '') {
        blocked.hidden = true;
        frameHost.replaceChildren();
        UI.pageHost.edit?.frameChanged();
        if (!page) return;
        const frame = document.createElement('iframe');
        frame.className = 'uttu-page-frame';
        if (page.dark) frame.dataset.scheme = 'dark';
        frame.name = 'uttu-page-frame'; // 主进程凭这个认出网页框（往外跳被拦下时，modules/uttu/webPages guardFrames）
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.title = page.name;
        frameRound += 1;
        frame.addEventListener('load', () => void connectBridge());
        frame.src = `${page.url}?uttu-round=${frameRound}${hash ? `#${hash}` : ''}`;
        frameHost.append(frame);
        applyZoom();
    }
    // 缩放：iframe 按比例放大缩小，宽高反过来补，网页里排版宽度跟着变（和浏览器的缩放一样）。
    function applyZoom() {
        const frame = frameHost.querySelector('iframe');
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

    // ---------- 批注：悬停亮元素，点元素，或者拖出一块 ----------
    let picking = false;
    let hovering = false; // 批注和修改都要亮元素
    let liveGeneration = -1; // 修改模式写进编辑器时框里已经改好了：存到这一步不用刷新网页
    let marks = [];
    let hoverToken = 0;
    let askCount = 0;
    const asks = new Map();
    const frameWindow = () => frameHost.querySelector('iframe')?.contentWindow;
    const scale = () => zoom / 100;
    window.addEventListener('message', (event) => {
        if (!event.source || event.source !== frameWindow()) return;
        const key = event.data?.uttuFrameKey; // 焦点在网页里时按的快捷键（webPages/pick.js）
        if (key) {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: String(key.key), shiftKey: Boolean(key.shiftKey), ctrlKey: true, bubbles: true, cancelable: true }));
            return;
        }
        const reply = event.data?.uttuPickAnswer;
        if (reply) {
            asks.get(reply.id)?.(reply);
            asks.delete(reply.id);
        } else if (event.data?.uttuPickScroll) {
            void paintMarks();
            UI.pageHost.edit?.scrolled();
        } else if (event.data?.uttuPickEdited) {
            UI.pageHost.edit?.textDone(event.data.uttuPickEdited);
        } else if (event.data?.uttuPickContext) {
            const at = event.data.uttuPickContext;
            const k = scale();
            const box = stage.getBoundingClientRect();
            void elementTarget(at).then((found) => { if (found) Pick.menu(found.target, { x: box.left + at.x * k, y: box.top + at.y * k }); });
        }
    });
    function askFrame(kind, payload = {}) {
        return new Promise((resolve) => {
            const id = ++askCount;
            asks.set(id, resolve);
            frameWindow()?.postMessage({ uttuPick: { ...payload, kind, id } }, '*');
            setTimeout(() => { if (asks.delete(id)) resolve(null); }, 1500);
        });
    }
    // 每次载入都接上：不切到批注也能右键引用。
    async function connectBridge() {
        await api().page('pick-bridge').catch(() => null);
        if (picking || marks.length) await paintMarks();
    }
    async function setPicking(mode) {
        picking = mode === 'pick';
        hovering = mode !== 'browse';
        pickLayer.classList.toggle('on', hovering);
        clearHover();
        if (hovering) await connectBridge();
        UI.pageHost.edit?.setOn(mode === 'edit');
    }
    const markBox = (rect, className, html = '') => {
        const mark = make('div', `uttu-pick-mark ${className}`, html);
        const k = scale();
        Object.assign(mark.style, { left: `${rect.x * k}px`, top: `${rect.y * k}px`, width: `${rect.width * k}px`, height: `${rect.height * k}px` });
        return mark;
    };
    const clearHover = () => pickLayer.querySelectorAll('.hover').forEach((node) => node.remove());
    async function paintMarks() {
        const open = marks.filter((item) => item.state !== 'done' && item.locator);
        const reply = open.length ? await askFrame('rects', { selectors: open.map((item) => item.locator.selector || '') }) : null;
        pickLayer.querySelectorAll('.saved').forEach((node) => node.remove());
        open.forEach((item, index) => {
            const num = `<span class="uttu-pick-num">${index + 1}</span>`;
            const live = reply?.answer?.[index];
            if (item.locator.type === 'element' && live) pickLayer.append(markBox(live, `saved${live.y < 18 ? ' at-top' : ''}`, num));
            else if (item.locator.type === 'region' && reply) {
                const { rect } = item.locator;
                const top = rect.y - reply.scroll.y;
                pickLayer.append(markBox({ ...rect, x: rect.x - reply.scroll.x, y: top }, `saved region${top < 18 ? ' at-top' : ''}`, num));
            }
        });
    }
    Pick.register('web-page', { paint(list) {
        marks = list;
        void connectBridge();
        if (!list.length) void paintMarks();
    } });
    const point = (event) => {
        const box = pickLayer.getBoundingClientRect();
        return { x: (event.clientX - box.left) / scale(), y: (event.clientY - box.top) / scale() };
    };
    pickLayer.addEventListener('pointermove', (event) => {
        if (!hovering || event.buttons) return;
        const token = ++hoverToken;
        const at = point(event);
        requestAnimationFrame(async () => {
            if (token !== hoverToken) return;
            const reply = await askFrame('at', at);
            if (token !== hoverToken) return;
            clearHover();
            if (reply?.answer) pickLayer.append(markBox(reply.answer.rect, 'hover'));
        });
    });
    pickLayer.addEventListener('pointerleave', clearHover);
    pickLayer.addEventListener('wheel', (event) => {
        event.preventDefault();
        void askFrame('scroll', { dx: event.deltaX / scale(), dy: event.deltaY / scale() });
    }, { passive: false });
    const lineText = (source) => (!source ? '' : `${source.approx ? '约' : ''}${source.startLine === source.endLine ? `第 ${source.startLine} 行` : `第 ${source.startLine}–${source.endLine} 行`}`);
    const tagText = (item) => { const first = String(item.className || '').trim().split(/\s+/)[0]; return `<${item.tag}${first ? ` class="${first}"` : ''}>`; };
    const locate = async (picked) => (await api().page('locate', { file: page.filePath, picked }).catch(() => null))?.source || null;
    async function elementTarget(at) {
        const reply = await askFrame('at', at);
        const item = reply?.answer;
        if (!item) return null;
        const source = await locate(item);
        const k = scale();
        const rect = { x: item.rect.x * k, y: item.rect.y * k, width: item.rect.width * k, height: item.rect.height * k };
        const box = Pick.windowRect(pickLayer, rect);
        return { item, box, target: { type: 'element', label: `${item.tag}${item.className ? `.${String(item.className).trim().split(/\s+/)[0]}` : ''}${source ? ` · ${lineText(source)}` : ''}`,
            place: `${source ? lineText(source) : '脚本生成的元素，没有源码行'} ${tagText(item)}，选择器 ${item.selector}`, text: item.text,
            locator: { type: 'element', selector: item.selector, tag: item.tag, rect: item.rect, source }, capture: box } };
    }
    async function pickElement(at) {
        const found = await elementTarget(at);
        if (!found) return;
        pickLayer.append(markBox(found.item.rect, 'hover'));
        Pick.offer(found.target, { left: found.box.x, top: found.box.y, bottom: found.box.y + found.box.height });
    }
    async function pickRegion(area) {
        const k = scale();
        const rect = { x: area.x / k, y: area.y / k, width: area.width / k, height: area.height / k };
        const reply = await askFrame('in', rect);
        const items = reply?.answer || [];
        const sources = (await Promise.all(items.map(locate))).filter(Boolean);
        const source = sources.length ? { startLine: Math.min(...sources.map((s) => s.startLine)), endLine: Math.max(...sources.map((s) => s.endLine)), approx: sources.some((s) => s.approx) } : null;
        const scroll = reply?.scroll || { x: 0, y: 0 };
        const box = Pick.windowRect(pickLayer, area);
        const whole = { x: Math.round(rect.x + scroll.x), y: Math.round(rect.y + scroll.y), width: Math.round(rect.width), height: Math.round(rect.height) };
        pickLayer.append(markBox(rect, 'hover region'));
        Pick.offer({ type: 'region', label: `区域 ${whole.width} × ${whole.height}${source ? ` · ${lineText(source)}` : ''}`,
            place: `${source ? `${lineText(source)}，` : ''}页面坐标 x ${whole.x}，y ${whole.y}，宽 ${whole.width}，高 ${whole.height}`,
            text: items.map((item) => item.text).filter(Boolean).join(' ').slice(0, 80), locator: { type: 'region', rect: whole, elements: items.map((item) => item.selector), source }, capture: box },
        { left: box.x, top: box.y, bottom: box.y + box.height });
    }
    pickLayer.addEventListener('pointerdown', (event) => {
        if (!picking || event.button !== 0) return;
        clearHover();
        Pick.dragRegion(pickLayer, event, (rect) => void pickRegion(rect), (at) => void pickElement({ x: at.x / scale(), y: at.y / scale() }));
    });
    UI.on('pick-cleared', clearHover);
    // 修改模式（uttu-scriptorium-page-edit.js）用这些。
    UI.pageHost = {
        tool: pickTool, layer: pickLayer, stage, askFrame, scale, point, markBox, clearHover,
        frame: () => frameHost.querySelector('iframe'),
        editor: () => editor,
        page: () => page,
        reload: () => loadFrame(),
        markLive() { liveGeneration = editor.changeGeneration(); },
        saveNow() { if (UI.autosaveOn?.()) void save(); },
    };

    // ---------- 打开、离开 ----------
    function enter() {
        document.body.classList.add('uttu-page-mode');
        work.hidden = false;
        UI.syncTitle?.();
    }
    function stash() {
        if (!page || !dirty()) return;
        drafts.set(norm(page.filePath), { text: editor.getValue(), mtime: page.mtime, eol: page.eol, bom: page.bom, encoding: page.encoding });
    }
    function leave() {
        if (!page) return;
        clearTimeout(autosaveTimer);
        stash();
        page = null;
        document.body.classList.remove('uttu-page-mode');
        work.hidden = true;
        pickTool.setMode('browse');
        marks = [];
        pickLayer.replaceChildren();
        frameHost.replaceChildren();
        conflict.hidden = true;
        void api()?.page?.('watch', { file: null }).catch(() => {});
        UI.setViewOverride?.(null);
        UI.syncTitle?.();
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
            UI.toast(`没打开这份网页：${result?.error || '读不到'}`, 'error', 5000);
            return false;
        }
        await saveBehind();
        clearTimeout(autosaveTimer);
        stash();
        const draft = drafts.get(norm(result.filePath));
        drafts.delete(norm(result.filePath));
        page = { filePath: result.filePath, name: result.name, url: result.url, eol: result.eol, bom: result.bom, encoding: result.encoding,
            mtime: result.mtime, generation: ++generation, saving: false, dark: darkPage(result.text) };
        conflict.hidden = true;
        enter();
        setSource(result.text);
        if (draft) {
            // 切走前没存的修改：放回来，还是“有改动”。磁盘上那份在这期间又被改过，栏头问用哪份。
            loading = true;
            editor?.setValue(draft.text);
            loading = false;
            if (Math.abs(draft.mtime - result.mtime) > 1) showConflict();
        }
        loadFrame(hash);
        void api().page('watch', { file: result.filePath }).catch(() => {});
        UI.sync?.();
        refreshEditor();
        return true;
    }

    // 文坊的打开都经过这里（scriptorium.js 的 openPath）：网页自己开；开着网页时要开别的，先离开网页。
    // 要开的就是藏在后面的那份文稿：直接露出来，不重新读。只有 .md 例外：开着网页时没人盯着它的外部改动
    // （uttu-scriptorium-markdown.js 只盯正在看的），没有没存的修改就照常重新读一遍。不归这里管时回 null。
    function route(file) {
        if (isPage(file)) return open(file);
        if (!page) return null;
        const behind = session()?.current?.();
        leave();
        const stale = /\.(md|markdown)$/i.test(String(file)) && !behind?.dirty;
        if (behind && !welcomeShown() && same(behind.filePath, file) && !stale) return Promise.resolve(true);
        return null;
    }
    // 进网页前：藏到后面的文稿有没存的修改、又开着自动保存，先存（藏着时自动保存不跑）。
    async function saveBehind() {
        if (page || welcomeShown() || !UI.autosaveOn?.()) return;
        const behind = session()?.current?.();
        if (!behind?.filePath || !behind.dirty) return;
        document.getElementById('save-btn')?.click();
        const started = Date.now();
        while (Date.now() - started < 4000 && session()?.current?.()?.dirty) await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // 关掉这份网页（文件菜单“关闭”、关掉最后一个标签）：没存的先存，再回到文坊首页。
    async function close() {
        if (!page) return;
        if (dirty() && !await save()) return;
        leave();
        if (session()?.current?.() && !welcomeShown()) document.getElementById('home-btn')?.click();
    }
    // 关掉一个没在看的网页标签：它要是还有没存的修改，存好。
    async function forget(file) {
        const draft = drafts.get(norm(file));
        if (!draft) return;
        drafts.delete(norm(file));
        try {
            await api().page('save', { file, text: draft.text, mtime: draft.mtime, eol: draft.eol, bom: draft.bom, encoding: draft.encoding, force: true });
        } catch (error) {
            UI.toast(`${file.split(/[\\/]/).pop()} 没存上：${error.message}`, 'error', 5000);
        }
    }

    // ---------- 存、重新载入、外面改了 ----------
    async function save({ force = false } = {}) {
        if (!page || !editor) return false;
        if (!dirty() && !force) return true;
        clearTimeout(autosaveTimer);
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
            UI.toast(`没存上：${result?.error || '写不进去'}`, 'error', 5000);
            UI.sync?.();
            return false;
        }
        page.mtime = result.mtime;
        clean = generationAtSave;
        conflict.hidden = true;
        UI.sync?.();
        if (generationAtSave !== liveGeneration) loadFrame();
        return true;
    }
    function scheduleAutosave() {
        clearTimeout(autosaveTimer);
        if (!UI.autosaveOn?.()) return;
        autosaveTimer = setTimeout(() => { if (dirty() && conflict.hidden) void save(); }, 1500);
    }
    async function reload({ discard = false } = {}) {
        if (!page) return;
        if (dirty() && !discard) return;
        let result;
        try {
            result = await api().page('read', { file: page.filePath });
        } catch (error) {
            result = { success: false, error: error.message };
        }
        if (!page || !result?.success) {
            if (result && !result.success) UI.toast(`没重新读到：${result.error || ''}`, 'error', 5000);
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
        // 只看预览时编辑栏藏着，栏头的问话看不见：提一句。
        if (document.body.classList.contains('uttu-view-preview')) {
            UI.toast('网页在别处改过了，你这里也有没存的修改。到编辑栏选用哪份。', 'info', 6000);
        }
    }
    api()?.onPageChanged?.((payload) => {
        if (!page || !same(payload?.file, page.filePath)) return;
        if (Math.abs(Number(payload.mtime) - page.mtime) <= 1) return;
        if (dirty()) {
            showConflict();
            return;
        }
        const file = page.filePath;
        const before = editor?.getValue() ?? '';
        void reload().then(() => {
            const after = editor?.getValue() ?? '';
            void api().view('history-add', { file, before, after }).then(() => UI.emit('view-file-changed'));
        });
    });
    // 网页往外跳被拦下：框里成了错误页，刷回网页，栏头问要不要用浏览器打开。
    api()?.onPageBlocked?.((payload) => {
        if (!page || !payload?.url) return;
        loadFrame();
        blockedUrl = String(payload.url);
        let host = blockedUrl;
        try { host = new URL(blockedUrl).host; } catch (_) { /* 原样 */ }
        setText(blockedText, `网页要打开 ${host}`);
        blocked.hidden = false;
    });

    // ---------- 快捷键：开着网页时上游的 Ctrl S / Z / Y 不能落到藏在后面的文稿上 ----------
    window.addEventListener('keydown', (event) => {
        if (!page || !(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = event.key.toLowerCase();
        if (key === 's') {
            event.preventDefault();
            event.stopImmediatePropagation();
            void save();
        } else if (['z', 'y'].includes(key) && !edit.contains(event.target)) { // Ctrl F 交给左栏“查找”
            event.preventDefault();
            event.stopImmediatePropagation();
            UI.pageHost.edit?.undo(key === 'y' || event.shiftKey);
        }
    }, true);
    // 在源码里：CodeMirror 自己撤销、重做，别再往上传到上游的处理。
    edit.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && ['z', 'y', 'f'].includes(event.key.toLowerCase())) event.stopPropagation();
    });

    // ---------- 跟着文坊走 ----------
    UI.on('document', (doc) => {
        if (doc?.kind === 'web-page') UI.setViewOverride?.('preview');
    });
    UI.on('view', ({ view } = {}) => {
        if (page && view !== 'preview') refreshEditor();
    });
    UI.on('start', () => {
        // 上游换了文稿（新建、从对话框打开、首页里点最近的）：离开网页，露出那份。
        session()?.subscribe?.((event) => {
            if (page && event?.type === 'document-replaced' && !UI.replacedByLastOpen()) setTimeout(leave, 0);
        });
    });

    function fileItems({ openNewDialog, open: openFile, importFile }) {
        const has = Boolean(page);
        return [
            { label: '新建', k: 'Ctrl N', act: openNewDialog },
            { label: '打开文件', k: 'Ctrl O', act: openFile },
            { label: '打开文件夹', act: () => window.UTTUScriptoriumFolder?.choose?.() },
            { label: '导入', act: importFile },
            { label: '保存', k: 'Ctrl S', disabled: !has || !dirty(), act: () => void save() },
            { label: '重新载入', k: 'F5', hint: dirty() ? '放弃没存的修改' : '', disabled: !has,
                act: () => {
                    const shared = window.UTTUScriptoriumMarkdown?.reloadFromDisk; // 有改动先问（和 .md 同一条）
                    if (shared) shared(); else void reload({ discard: true });
                } },
            { label: '在文件夹里显示', disabled: !has, act: () => void api()?.page?.('reveal', { file: page?.filePath }).catch(() => {}) },
            { label: '关闭', disabled: !has, act: () => void close() },
            { sep: true },
            { label: '自动保存', check: Boolean(UI.autosaveOn?.()), act: () => UI.setAutosave?.(!UI.autosaveOn?.()) },
        ];
    }

    const frameFind = Object.freeze({ find: async (query, index) => (await api().page('find', { query, index }).catch(() => null)) });
    const view = Object.freeze({
        // 左栏“查找”（uttu-scriptorium-panels.js）：开着源码时找源码，只看网页时找排出来的字。
        get find() { return document.body.classList.contains('uttu-view-preview') || !editor ? { frame: frameFind } : { editor: () => editor }; },
        claims: isPage,
        open,
        route,
        leave,
        close,
        forget,
        save: () => save(),
        reload: () => reload({ discard: true }),
        fileItems,
        active: () => Boolean(page),
        // 给 Agent（uttu-scriptorium-agent.js）：网页框里排出来的字（主进程取）、当前源码（含没存的）、截图范围。
        agent: Object.freeze({
            text: async () => {
                const result = await api().page('frame-text');
                if (!result?.success) throw new Error(result?.error || '读不到网页的文字。');
                return result.text;
            },
            source: () => editor?.getValue() ?? '',
            surface: () => frameHost,
        }),
        // 给 UI.doc()：开着网页时的“当前文档”。
        doc: () => (page ? Object.freeze({ kind: 'web-page', filePath: page.filePath, name: page.name, generation: page.generation,
            dirty: dirty(), saving: page.saving, revision: 0 }) : null),
        _state: () => ({ page: page && { ...page }, dirty: dirty(), drafts: [...drafts.keys()], zoom }),
    });
    window.UTTUScriptoriumPage = view;
    UI.registerOverlay?.(view); // 盖在文稿上的视图统一登记（uttu-scriptorium.js），PDF、表格也走这里
})();
