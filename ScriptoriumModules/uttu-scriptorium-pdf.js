// 文坊里的 PDF。
// 主进程在 modules/uttu/pdfFiles（读、写、备份、签名的存取，知识卡在那里）；这里是页面：pdf.js（vendor/pdfjs）画页面，
// 改动先攒在页面里，点保存才交给主进程用 pdf-lib 写进去。
// - 看：一页一页往下排，滚到才画；文字层可以选中、复制；缩放、适合宽度；查找；左栏“篇章”换成页面缩略图。
// - 改：加文字、改字（盖一块和底色一样的方块再写新字，点原文的一行就带出原来的字和大小）、签名（手写或打字，存起来下次用）、
//   图片、方框、高亮、打勾打叉、日期。都是放上去的东西，可以拖、改大小、删，Ctrl Z 撤销。原文不重新排版。
// - 页面：转、删、挪（缩略图拖动）、复制、加白页、并入别的 PDF、把选中的页导出成新 PDF、拆成几份（每页一份、每 N 页一份、在选中的页前断开）。
// - 涂黑：“改字”只是盖住，原文还在文件里（能复制、能搜到）；涂黑的页存的时候整页画成图片再放回去，盖住的字真的没了。
// - 页码、水印：每页都加，页面上先看到样子。书签：PDF 自带的目录在左栏，点了跳过去。
// - 交给 Agent 重建：抽出字排成 Markdown 初稿（标题按字号猜、扫描页放整页图），
//   存成 .md 在文坊打开，对话输入框里放好一段话请 Agent 对照原 PDF 整理。
// - 表单：PDF 里有可填的栏，直接在页面上填。
// - 存：存回原文件（主进程先留一份原样在 AppData），或另存为。打开后磁盘上被别处改了就不覆盖，栏头问怎么办。
// 坐标：放上去的东西记的是“屏幕上看到的样子、缩放为 1 时”的位置（左上角起），存的时候用这一页的视口换成 PDF 自己的坐标
// （左下角起，页面转过也对），并把东西反着页面转的角度画，让它在屏幕上是正的。
// 和网页（uttu-scriptorium-page.js）一样盖在文稿上面（UI.registerOverlay），上游的文稿留在后面不动。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;
    const { make, button, icon, setText } = UI;
    const api = () => window.scriptoriumAPI;
    const session = () => window.UTTUScriptoriumSession;
    const isPdf = (file) => /\.pdf$/i.test(String(file || ''));
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const welcomeShown = () => document.getElementById('welcome-state')?.hidden === false;
    const VENDOR = new URL('../vendor/pdfjs/', location.href).href;
    // 放上去的字用的字体：和存进 PDF 的一致（拉丁字母 Helvetica，中文是主进程找到的系统字体，Windows 上是微软雅黑）。
    const FONT = 'Helvetica, Arial, "Microsoft YaHei", "PingFang SC", "WenQuanYi Zen Hei", "Noto Sans CJK SC", sans-serif';
    const LINE = 1.25; // 行高（倍数），存的时候一行一行往下排也用它
    const BASE = 0.97; // 第一行的基线离字块顶边多远（字号的倍数，Arial/Helvetica 在 1.25 行高下）
    const PAD = 2; // 改字：新字离方块左边
    const INK = { black: [0, 0, 0], blue: [0.1, 0.25, 0.65], red: [0.78, 0.1, 0.1] };
    const MARK = [1, 0.84, 0.2];
    const needsCjk = (text) => /[^\u0000-ÿ]/.test(String(text || ''));
    const css = (rgb) => `rgb(${rgb.map((v) => Math.round(v * 255)).join(' ')})`;
    const today = () => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    };

    // ---------- pdf.js：第一次用到时才载入 ----------
    let libPromise = null;
    function pdfjs() {
        if (!libPromise) {
            libPromise = import(`${VENDOR}pdf.min.mjs`).then((lib) => {
                lib.GlobalWorkerOptions.workerSrc = `${VENDOR}pdf.worker.min.mjs`;
                return lib;
            });
            libPromise.catch(() => { libPromise = null; });
        }
        return libPromise;
    }
    async function loadDocument(bytes) {
        const lib = await pdfjs();
        // pdf.js 会把字节交给后台线程（原来的那份就空了），给它一份副本。
        return lib.getDocument({
            data: bytes.slice(), cMapUrl: `${VENDOR}cmaps/`, cMapPacked: true, standardFontDataUrl: `${VENDOR}standard_fonts/`,
            iccUrl: `${VENDOR}iccs/`, wasmUrl: `${VENDOR}wasm/`, isEvalSupported: false, enableScripting: false,
        }).promise;
    }

    // ---------- 状态：一份打开的 PDF 一个对象（切到别的标签时没存的改动整份留着） ----------
    // pages：[{ id, src: 'main' | 来源 id, index, rot（最后的角度）} | { id, blank: { w, h }, rot }]
    // objects：[{ id, page（页的 id）, type, x, y, w, h, ... }]，type：text、cover（改字）、image（签名、图片）、rect、mark、check、cross
    let S = null;
    let generation = 0;
    let serial = 0;
    const uid = (prefix) => `${prefix}${Date.now().toString(36)}${(serial += 1).toString(36)}`;
    const drafts = new Map(); // 路径 → 切走时没存的那份状态
    let zoom = 1;
    let fitted = false; // 打开时自动适合宽度、之后没手动缩放过：窗口变了跟着缩放
    let tool = 'select';
    let selected = null; // 选中的东西的 id
    let editing = null; // 正在改字的东西的 id
    let pending = null; // 等着点页面放下去的：{ type, data, w, h }
    const pickedPages = new Set(); // 左栏选中的页

    const snapshot = () => ({
        pages: S.pages.map((page) => ({ ...page })),
        objects: S.objects.map((item) => ({ ...item })),
        values: { ...S.values },
        sources: { ...S.sources },
        stamps: { ...S.stamps },
    });
    function restore(snap) {
        S.pages = snap.pages.map((page) => ({ ...page }));
        S.objects = snap.objects.map((item) => ({ ...item }));
        S.values = { ...snap.values };
        S.sources = { ...snap.sources };
        S.stamps = { ...snap.stamps };
    }
    // 每次改动前记一笔，撤销就回到那一笔。stateId 和存的时候的那个比，就知道有没有没存的改动（撤销回去也算没改）。
    // 刚放上去、接着打字的字块：打完不另记一笔（撤销时连放带打一起撤）。
    let fresh = null;
    function amend(change) {
        change();
        S.stateId = uid('s');
        refresh();
    }
    function commit(change) {
        S.history.push({ snap: snapshot(), id: S.stateId });
        if (S.history.length > 200) S.history.shift();
        S.future = [];
        change();
        S.stateId = uid('s');
        refresh();
    }
    function undo() {
        if (!S?.history.length) return;
        finishEditing(false);
        S.future.push({ snap: snapshot(), id: S.stateId });
        const prev = S.history.pop();
        restore(prev.snap);
        S.stateId = prev.id;
        select(null);
        refresh();
    }
    function redo() {
        if (!S?.future.length) return;
        finishEditing(false);
        S.history.push({ snap: snapshot(), id: S.stateId });
        const next = S.future.pop();
        restore(next.snap);
        S.stateId = next.id;
        select(null);
        refresh();
    }
    const dirty = () => Boolean(S && S.stateId !== S.savedId);

    // ---------- 搭结构 ----------
    const work = make('div', 'uttu-pdf-work');
    work.hidden = true;
    work.setAttribute('aria-label', 'PDF');
    const head = make('div', 'uttu-pane-head uttu-pdf-head');
    const tools = make('div', 'uttu-seg sm uttu-pdf-tools');
    tools.setAttribute('role', 'group');
    tools.setAttribute('aria-label', '工具');
    const TOOLS = [['select', '选择'], ['text', '文字'], ['cover', '改字'], ['redact', '涂黑'], ['rect', '方框'], ['mark', '高亮'], ['pick', '批注']];
    for (const [key, label] of TOOLS) {
        const option = button('', '', label, () => setTool(key));
        option.dataset.tool = key;
        tools.append(option);
    }
    const insert = button('uttu-tb-drop', '', `插入${icon('i-chevron')}`, () => {
        UI.toggleMenu(insert, () => [
            { label: '签名', act: () => void openSignature() },
            { label: '图片', act: () => imageInput.click() },
            { label: '日期', act: () => setTool('date') },
            { sep: true },
            { label: '打勾', act: () => setTool('check') },
            { label: '打叉', act: () => setTool('cross') },
            { sep: true },
            { label: '页码', hint: S?.stamps.pageNumbers ? '加了' : '', act: () => pageNumberMenu() },
            { label: '水印', hint: S?.stamps.watermark ? '加了' : '', act: () => void askWatermark() },
        ]);
    });
    const undoButton = button('uttu-tb', '撤销', icon('i-undo'), () => undo());
    const redoButton = button('uttu-tb', '重做', icon('i-redo'), () => redo());
    const props = make('span', 'uttu-pdf-props');
    props.hidden = true;
    const hint = make('span', 'uttu-pdf-hint');
    const conflict = make('span', 'uttu-pdf-conflict');
    conflict.hidden = true;
    conflict.append(make('span', '', 'PDF 在别处改过了'),
        button('uttu-btn ghost small', '', '重新载入', () => void reload({ discard: true })),
        button('uttu-btn ghost small', '', '另存为', () => void save({ saveAs: true })));
    const findBox = make('span', 'uttu-pdf-find');
    const findInput = make('input');
    findInput.type = 'search';
    findInput.placeholder = '查找';
    findInput.setAttribute('aria-label', '在 PDF 里查找');
    const findCount = make('small');
    findBox.append(findInput, findCount);
    const pageInfo = make('span', 'uttu-pdf-pageno');
    const zoomOut = button('uttu-tb', '缩小', icon('i-minus'), () => setZoom(zoom - 0.1));
    const zoomValue = button('uttu-tb-drop plain', '', '100%', () => fitWidth());
    const zoomIn = button('uttu-tb', '放大', icon('i-plus'), () => setZoom(zoom + 0.1));
    head.append(tools, insert, make('span', 'uttu-tb-sep'), undoButton, redoButton, props, hint, make('span', 'grow'),
        conflict, findBox, pageInfo, zoomOut, zoomValue, zoomIn);
    const scroller = make('div', 'uttu-pdf-scroll');
    const pagesHost = make('div', 'uttu-pdf-pages');
    scroller.append(pagesHost);
    work.append(head, scroller);
    const workspace = document.getElementById('document-workspace');
    (workspace?.parentElement || document.body).append(work);
    const imageInput = make('input');
    imageInput.type = 'file';
    imageInput.accept = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';
    imageInput.hidden = true;
    work.append(imageInput);

    // 左栏“篇章”：页面缩略图（CSS 只在开着 PDF 时摆出）。
    const thumbs = make('div', 'uttu-pdf-thumbs');
    thumbs.setAttribute('role', 'listbox');
    thumbs.setAttribute('aria-label', '页面');
    thumbs.setAttribute('aria-multiselectable', 'true');
    document.getElementById('outline-panel')?.append(thumbs);
    // 左栏停在查找时换成这句（PDF 在页面上方查找）。
    document.getElementById('outline-panel')?.append(make('p', 'uttu-left-note uttu-left-pdf-note', '开着的是 PDF：在页面上方的查找框里找（Ctrl F）。'));
    const leftTools = {
        rotate: button('uttu-tb', '把选中的页向右转', icon('i-reload'), () => rotatePages(1)),
        remove: button('uttu-tb', '删掉选中的页', icon('i-trash'), () => removePages()),
        blank: button('uttu-tb', '在后面加一张白页', icon('i-plus'), () => addBlank()),
        merge: button('uttu-tb', '并入别的 PDF', icon('i-attach'), () => void mergeFiles()),
        marks: button('uttu-tb-drop plain', '', '书签', () => setLeftList(leftList === 'marks' ? 'pages' : 'marks')),
    };
    // 左栏的书签（PDF 自带的目录）；没有书签的 PDF 不出“书签”按钮。
    const markList = make('div', 'uttu-pdf-marks');
    document.getElementById('outline-panel')?.append(markList);
    let leftList = 'pages';
    function setLeftList(which) {
        leftList = which;
        document.body.dataset.uttuPdfLeft = which;
        leftTools.marks.setAttribute('aria-pressed', String(which === 'marks'));
        renderLeft();
    }

    // ---------- 工具 ----------
    const HINTS = {
        select: '',
        pick: '拖出要批注的一块',
        text: '点页面加一段字',
        cover: '点原文的一行改它，或者拖出一块（只是盖住，原文还在文件里；要真去掉用涂黑）',
        rect: '拖出一个方框',
        mark: '拖过要高亮的地方',
        redact: '拖出要涂黑的地方：存的时候这一页变成图片，底下的字真的没了',
        date: '点页面写上今天的日期',
        check: '点页面打一个勾',
        cross: '点页面打一个叉',
        place: '点页面放下去，Esc 不放了',
    };
    function setTool(key) {
        finishEditing(true);
        tool = key;
        if (key !== 'place') pending = null;
        if (key !== 'select') select(null);
        tools.querySelectorAll('button').forEach((option) => option.setAttribute('aria-pressed', String(option.dataset.tool === key)));
        work.dataset.tool = key;
        setText(hint, HINTS[key] || '');
    }

    // ---------- 打开、离开 ----------
    async function read(file) {
        let result;
        try {
            result = await api().pdf('read', { path: file });
        } catch (error) {
            result = { success: false, error: error.message };
        }
        return result;
    }
    // 读到的字节变成状态：pdf.js 打开、每页的大小和角度。
    async function build(result) {
        const doc = await loadDocument(result.bytes);
        const state = {
            filePath: result.filePath, name: result.name, fingerprint: result.fingerprint, mtime: result.mtime, size: result.size,
            cjk: Boolean(result.cjkFont), docs: { main: doc }, proxies: new Map(), sources: {}, pages: [], objects: [],
            fields: Array.isArray(result.fields) ? result.fields : [], values: {}, history: [], future: [],
            stateId: 's0', savedId: 's0', generation: ++generation, saving: false, scroll: null, stamps: { pageNumbers: null, watermark: null }, marks: [],
        };
        for (const field of state.fields) state.values[field.name] = field.value;
        state.original = { ...state.values };
        state.marks = await loadMarks(state).catch(() => []);
        for (let index = 0; index < doc.numPages; index += 1) {
            const proxy = await doc.getPage(index + 1);
            state.proxies.set(`main:${index}`, proxy);
            state.pages.push({ id: uid('p'), src: 'main', index, rot: proxy.rotate || 0 });
        }
        return state;
    }
    async function open(file) {
        if (!isPdf(file)) return false;
        if (S && same(S.filePath, file)) return true;
        const result = await read(file);
        if (!result?.success) {
            UI.toast(`没打开这份 PDF：${result?.error || '读不到'}`, 'error', 5000);
            return false;
        }
        await saveBehind();
        let next;
        const draft = drafts.get(norm(result.filePath));
        drafts.delete(norm(result.filePath));
        try {
            next = draft || await build(result);
        } catch (error) {
            UI.toast(passwordProblem(error) || `pdf.js 没读懂这份 PDF：${error.message}`, 'error', 6000);
            return false;
        }
        stash();
        S = next;
        enter();
        if (draft && draft.fingerprint !== result.fingerprint) showConflict();
        return true;
    }
    const passwordProblem = (error) => (error?.name === 'PasswordException' ? '这份 PDF 设了打开密码，文坊打不开；用默认程序打开。' : '');
    function enter() {
        document.body.classList.add('uttu-pdf-mode');
        work.hidden = false;
        conflict.hidden = true;
        pickedPages.clear();
        selected = null;
        editing = null;
        findInput.value = '';
        setText(findCount, '');
        texts.clear();
        thumbs.replaceChildren();
        pagesHost.replaceChildren();
        elements.clear();
        thumbElements.clear();
        setTool('select');
        if (S.zoom) zoom = S.zoom;
        else fitWidth({ quiet: true });
        refresh();
        if (S.scroll) requestAnimationFrame(() => { scroller.scrollTop = S.scroll; });
        else scroller.scrollTop = 0;
        UI.syncTitle?.();
        UI.sync?.();
        renderMarks();
        renderLeft();
    }
    // 切走：有没存的改动整份留着（切回来还在），没有就放掉 pdf.js 的文档。
    function stash() {
        if (!S) return;
        S.scroll = scroller.scrollTop;
        S.zoom = zoom;
        if (dirty()) drafts.set(norm(S.filePath), S);
        else destroy(S);
    }
    function destroy(state) {
        for (const doc of Object.values(state?.docs || {})) void doc?.destroy?.().catch(() => {});
    }
    function leave() {
        if (!S) return;
        finishEditing(true);
        stash();
        S = null;
        document.body.classList.remove('uttu-pdf-mode');
        work.hidden = true;
        pagesHost.replaceChildren();
        thumbs.replaceChildren();
        elements.clear();
        thumbElements.clear();
        UI.syncTitle?.();
        UI.sync?.();
    }
    // 和网页一样：开别的东西时先离开 PDF；要开的正是藏在后面的那份文稿，直接露出来。
    function route(file) {
        if (isPdf(file)) return open(file);
        if (!S) return null;
        const behind = session()?.current?.();
        leave();
        const stale = /\.(md|markdown)$/i.test(String(file)) && !behind?.dirty;
        if (behind && !welcomeShown() && same(behind.filePath, file) && !stale) return Promise.resolve(true);
        return null;
    }
    async function saveBehind() {
        if (S || welcomeShown() || !UI.autosaveOn?.()) return;
        const behind = session()?.current?.();
        if (!behind?.filePath || !behind.dirty) return;
        document.getElementById('save-btn')?.click();
        const started = Date.now();
        while (Date.now() - started < 4000 && session()?.current?.()?.dirty) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    async function close() {
        if (!S) return;
        if (dirty() && !await save()) return;
        leave();
        if (session()?.current?.() && !welcomeShown()) document.getElementById('home-btn')?.click();
    }
    // 关掉一个没在看的 PDF 标签：还有没存的改动就存好（和网页一样）。
    async function forget(file) {
        const draft = drafts.get(norm(file));
        if (!draft) return;
        drafts.delete(norm(file));
        try {
            const result = await api().pdf('save', { path: draft.filePath, plan: await planOf(draft), fingerprint: draft.fingerprint });
            if (!result?.success) throw new Error(result?.error || '写不进去');
        } catch (error) {
            UI.toast(`${draft.name} 没存上：${error.message}`, 'error', 6000);
        }
        destroy(draft);
    }

    // ---------- 画页面 ----------
    const elements = new Map(); // 页的 id → { root, canvas, text, fields, objs, done, task }
    const proxyOf = (state, entry) => state.proxies.get(`${entry.src}:${entry.index}`);
    // 缩放为 1 时屏幕上的宽高（转过的页宽高对调）。
    function baseSize(state, entry) {
        if (entry.blank) return entry.rot % 180 ? { w: entry.blank.h, h: entry.blank.w } : { w: entry.blank.w, h: entry.blank.h };
        const viewport = proxyOf(state, entry).getViewport({ scale: 1, rotation: entry.rot });
        return { w: viewport.width, h: viewport.height };
    }
    function pageElement(entry) {
        let el = elements.get(entry.id);
        if (el) return el;
        const root = make('div', 'uttu-pdf-page');
        root.dataset.page = entry.id;
        const canvas = make('canvas');
        const text = make('div', 'textLayer');
        const fields = make('div', 'uttu-pdf-fields');
        const objs = make('div', 'uttu-pdf-objs');
        root.append(canvas, text, fields, objs);
        el = { root, canvas, text, fields, objs, done: '', task: null };
        elements.set(entry.id, el);
        observer.observe(root);
        return el;
    }
    const visible = new Set();
    const observer = new IntersectionObserver((records) => {
        for (const record of records) {
            const id = record.target.dataset.page;
            if (record.isIntersecting) visible.add(id); else visible.delete(id);
        }
        renderVisible();
        trackPage();
    }, { root: scroller, rootMargin: '600px 0px' });
    function layout() {
        const keep = new Set(S.pages.map((entry) => entry.id));
        for (const [id, el] of elements) {
            if (!keep.has(id)) {
                observer.unobserve(el.root);
                el.task?.cancel?.();
                el.root.remove();
                elements.delete(id);
                visible.delete(id);
            }
        }
        S.pages.forEach((entry, index) => {
            const el = pageElement(entry);
            const size = baseSize(S, entry);
            el.root.style.width = `${size.w * zoom}px`;
            el.root.style.height = `${size.h * zoom}px`;
            el.root.style.setProperty('--scale-factor', String(zoom));
            el.root.classList.toggle('blank', Boolean(entry.blank));
            el.root.dataset.no = String(index + 1);
            if (pagesHost.children[index] !== el.root) pagesHost.insertBefore(el.root, pagesHost.children[index] || null);
        });
    }
    let renderTimer = 0;
    function renderVisible() {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(() => {
            if (!S) return;
            for (const entry of S.pages) if (visible.has(entry.id)) void renderPage(S, entry);
        }, 30);
    }
    async function renderPage(state, entry) {
        const el = elements.get(entry.id);
        if (!el) return;
        const key = `${zoom}|${entry.rot}|${window.devicePixelRatio || 1}`;
        if (el.done === key) return;
        el.done = key;
        el.task?.cancel?.();
        const lib = await pdfjs();
        const ratio = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        if (entry.blank) {
            const size = baseSize(state, entry);
            canvas.width = Math.floor(size.w * zoom * ratio);
            canvas.height = Math.floor(size.h * zoom * ratio);
            el.canvas.replaceWith(canvas);
            el.canvas = canvas;
            el.text.replaceChildren();
            drawFields(entry);
            return;
        }
        const proxy = proxyOf(state, entry);
        const viewport = proxy.getViewport({ scale: zoom, rotation: entry.rot });
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        const hasFields = entry.src === 'main' && state.fields.some((field) => field.widgets.some((widget) => widget.page === entry.index));
        const task = proxy.render({
            canvasContext: canvas.getContext('2d'), canvas, viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
            // 有可填的栏时表单不画在图上（上面摆着能填的框，不然字会叠两份）。
            annotationMode: hasFields ? lib.AnnotationMode.ENABLE_FORMS : lib.AnnotationMode.ENABLE,
        });
        el.task = task;
        try {
            await task.promise;
        } catch (error) {
            if (error?.name !== 'RenderingCancelledException') console.warn('[VCP 文坊] PDF 这一页没画出来：', error);
            return;
        }
        if (el.done !== key || S !== state) return;
        el.canvas.replaceWith(canvas);
        el.canvas = canvas;
        el.text.replaceChildren();
        try {
            const layer = new lib.TextLayer({ textContentSource: proxy.streamTextContent(), container: el.text, viewport });
            await layer.render();
        } catch (_) { /* 没有文字层也能看 */ }
        drawFields(entry);
        markFound(entry.id);
    }
    function invalidate() {
        for (const el of elements.values()) el.done = '';
    }

    // ---------- 放上去的东西 ----------
    function objectElement(item) {
        const el = make('div', `uttu-pdf-obj ${item.type}`);
        el.dataset.obj = item.id;
        el.style.left = `${item.x * zoom}px`;
        el.style.top = `${item.y * zoom}px`;
        el.style.width = `${item.w * zoom}px`;
        el.style.height = `${item.h * zoom}px`;
        if (item.type === 'text') {
            el.style.fontFamily = FONT;
            el.style.fontSize = `${item.size * zoom}px`;
            el.style.color = css(item.color);
            el.textContent = item.text;
        } else if (item.type === 'cover') {
            el.style.background = css(item.fill);
            const words = make('span', 'w');
            words.textContent = item.text;
            words.style.fontFamily = FONT;
            words.style.fontSize = `${item.size * zoom}px`;
            words.style.color = css(item.color);
            words.style.left = `${PAD * zoom}px`;
            words.style.top = `${coverTop(item) * zoom}px`;
            el.append(words);
        } else if (item.type === 'image') {
            const img = make('img');
            img.src = item.data;
            img.alt = '';
            img.draggable = false;
            el.append(img);
        } else if (item.type === 'rect') {
            el.style.borderColor = css(item.color);
            el.style.borderWidth = `${Math.max(1, 1.5 * zoom)}px`;
        } else if (item.type === 'mark') {
            el.style.background = css(item.color);
        } else if (item.type === 'redact') {
            el.style.background = css(INK.black);
        } else if (item.type === 'check' || item.type === 'cross') {
            const points = item.type === 'check' ? CHECK : CROSS;
            el.innerHTML = `<svg viewBox="0 0 1 1" preserveAspectRatio="none">${points.map((line) => `<polyline points="${line.map(([x, y]) => `${x},${y}`).join(' ')}"/>`).join('')}</svg>`;
            el.style.color = css(item.color);
            el.style.setProperty('--w', `${Math.max(1.2, item.h * 0.12) * zoom}px`);
        }
        if (item.id === selected) el.classList.add('on');
        if (item.id === selected) el.append(make('i', 'h'));
        return el;
    }
    const CHECK = [[[0.12, 0.55], [0.4, 0.82], [0.88, 0.18]]];
    const CROSS = [[[0.15, 0.15], [0.85, 0.85]], [[0.85, 0.15], [0.15, 0.85]]];
    const coverTop = (item) => Math.max(0, (item.h - lineCount(item.text) * item.size * LINE) / 2);
    const lineCount = (text) => Math.max(1, String(text || '').split('\n').length);
    function drawObjects(pageId) {
        const el = elements.get(pageId);
        if (!el) return;
        const keepEditing = editing && el.objs.querySelector(`[data-obj="${editing}"]`);
        if (keepEditing) return; // 正在打字：不重画，免得光标跳
        el.objs.replaceChildren(...S.objects.filter((item) => item.page === pageId).map(objectElement));
    }
    function drawAllObjects() {
        for (const entry of S.pages) drawObjects(entry.id);
    }
    const findObject = (id) => S?.objects.find((item) => item.id === id) || null;
    // 选中：只换样子（不重画，双击还认得同一个）。
    function select(id) {
        if (editing && editing !== id) finishEditing(true);
        selected = id;
        pagesHost.querySelectorAll('.uttu-pdf-obj.on').forEach((node) => {
            if (node.dataset.obj === id) return;
            node.classList.remove('on');
            node.querySelector(':scope > .h')?.remove();
        });
        const el = id && pagesHost.querySelector(`[data-obj="${id}"]`);
        if (el && !el.classList.contains('on')) {
            el.classList.add('on');
            if (editing !== id) el.append(make('i', 'h'));
        }
        renderProps();
    }

    // 选中东西时栏头多出来：字号、颜色、删除。
    function renderProps() {
        const item = findObject(selected);
        props.hidden = !item;
        hint.hidden = Boolean(item);
        if (!item) {
            props.replaceChildren();
            return;
        }
        const parts = [make('span', 'uttu-tb-sep')];
        if (item.type === 'text' || item.type === 'cover') {
            parts.push(
                button('uttu-tb', '字小一点', icon('i-minus'), () => resizeText(item.id, -1)),
                make('span', 'uttu-pdf-size', String(Math.round(item.size))),
                button('uttu-tb', '字大一点', icon('i-plus'), () => resizeText(item.id, 1)),
            );
        }
        if (item.type !== 'image') {
            const swatches = make('span', 'uttu-swatches uttu-pdf-swatches');
            const options = item.type === 'mark' ? [['高亮黄', MARK], ['浅绿', [0.55, 0.9, 0.55]], ['浅蓝', [0.6, 0.8, 1]]]
                : [['黑', INK.black], ['蓝', INK.blue], ['红', INK.red]];
            for (const [label, rgb] of options) {
                const swatch = button('', label, '', () => commit(() => { findObject(item.id).color = rgb; }));
                swatch.style.setProperty('--c', css(rgb));
                swatch.setAttribute('aria-pressed', String(String(item.color) === String(rgb)));
                swatches.append(swatch);
            }
            parts.push(swatches);
        }
        parts.push(button('uttu-tb', '删掉', icon('i-trash'), () => removeObject(item.id)));
        props.replaceChildren(...parts);
    }
    function resizeText(id, step) {
        const item = findObject(id);
        if (!item) return;
        commit(() => {
            item.size = Math.max(5, Math.min(96, Math.round(item.size) + step));
            if (item.type === 'text') measure(item);
        });
    }
    function removeObject(id) {
        if (!findObject(id)) return;
        if (editing === id) editing = null;
        commit(() => { S.objects = S.objects.filter((item) => item.id !== id); });
        select(null);
    }
    // 文字块的宽高跟着字走。
    const measurer = make('div', 'uttu-pdf-measure');
    document.body.append(measurer);
    function measure(item) {
        measurer.style.font = `${item.size}px/${LINE} ${FONT}`;
        measurer.textContent = `${item.text || ' '}${String(item.text).endsWith('\n') ? ' ' : ''}`;
        item.w = Math.max(item.size * 0.6, measurer.offsetWidth + 1);
        item.h = Math.max(item.size * LINE, measurer.offsetHeight);
    }

    // 改字：在 contenteditable 里打，离开时收下。
    function startEditing(id, { selectAll = false, isNew = false } = {}) {
        const item = findObject(id);
        if (!item || (item.type !== 'text' && item.type !== 'cover')) return;
        select(id);
        editing = id;
        fresh = isNew ? id : null;
        const el = pagesHost.querySelector(`[data-obj="${id}"]`);
        const target = item.type === 'cover' ? el?.querySelector('.w') : el;
        if (!target) return;
        el.querySelector(':scope > .h')?.remove();
        target.contentEditable = 'plaintext-only';
        el.classList.add('editing');
        target.focus();
        const range = document.createRange();
        range.selectNodeContents(target);
        if (!selectAll) range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        target.addEventListener('input', () => {
            if (item.type !== 'text') return;
            // 边打边长：宽高跟上（还没记进撤销）
            const probe = { ...item, text: target.innerText };
            measure(probe);
            el.style.width = `${probe.w * zoom}px`;
            el.style.height = `${probe.h * zoom}px`;
        });
        target.addEventListener('blur', () => setTimeout(() => { if (editing === id) finishEditing(true); }, 0), { once: true });
    }
    function finishEditing(keep) {
        if (!editing || !S) { editing = null; return; }
        const id = editing;
        editing = null;
        const item = findObject(id);
        const el = pagesHost.querySelector(`[data-obj="${id}"]`);
        const target = item?.type === 'cover' ? el?.querySelector('.w') : el;
        if (!item || !target) return;
        const text = target.innerText.replace(/\n$/, '');
        const wasFresh = fresh === id;
        fresh = null;
        if (!keep || text === item.text) {
            drawObjects(item.page);
            if (item.type === 'text' && !item.text) removeQuietly(id);
            return;
        }
        if (item.type === 'text' && !text.trim()) {
            removeObject(id);
            return;
        }
        (wasFresh ? amend : commit)(() => {
            item.text = text;
            if (item.type === 'text') measure(item);
        });
    }
    // 新建后一个字没打就走了：当作没加过（也不留撤销记录）。
    function removeQuietly(id) {
        const index = S.history.length - 1;
        S.objects = S.objects.filter((item) => item.id !== id);
        if (index >= 0 && !S.history[index].snap.objects.some((item) => item.id === id)) {
            const prev = S.history.pop();
            S.stateId = prev.id;
        }
        if (selected === id) select(null);
        refresh();
    }

    // ---------- 在页面上点、拖 ----------
    // 批注：工具选“批注”，在页面上拖出一块。位置记成 PDF 点，原点在左下；画色块时用屏幕位置。
    const Pick = window.UTTUScriptoriumPick;
    let picks = [];
    function paintPicks() {
        pagesHost.querySelectorAll('.uttu-pick-mark.saved').forEach((node) => node.remove());
        picks.filter((item) => item.state !== 'done' && item.locator?.view).forEach((item, index) => {
            const pageEl = [...pagesHost.querySelectorAll('.uttu-pdf-page')].find((node) => node.dataset.page === item.locator.pageId);
            if (!pageEl) return;
            const spot = item.locator.view;
            const mark = make('div', `uttu-pick-mark region saved${spot.y * zoom < 18 ? ' at-top' : ''}`, `<span class="uttu-pick-num">${index + 1}</span>`);
            Object.assign(mark.style, { left: `${spot.x * zoom}px`, top: `${spot.y * zoom}px`, width: `${spot.width * zoom}px`, height: `${spot.height * zoom}px` });
            pageEl.append(mark);
        });
    }
    Pick.register('pdf', { paint(list) {
        picks = list;
        paintPicks();
    } });
    function regionTarget(pageEl, entry, rect) {
        const size = baseSize(S, entry);
        const spot = { x: rect.x / zoom, y: rect.y / zoom, width: rect.width / zoom, height: rect.height / zoom };
        const number = S.pages.indexOf(entry) + 1;
        const n = (value) => Math.round(value);
        const box = pageEl.getBoundingClientRect();
        const inside = (node) => {
            const r = node.getBoundingClientRect();
            return r.left < box.left + rect.x + rect.width && r.right > box.left + rect.x && r.top < box.top + rect.y + rect.height && r.bottom > box.top + rect.y;
        };
        const text = [...pageEl.querySelectorAll('.textLayer span')].filter(inside).map((node) => node.textContent).join(' ').replace(/\s+/g, ' ').trim().slice(0, 80);
        const windowBox = Pick.windowRect(pageEl, rect);
        return { type: 'region', label: `第 ${number} 页 区域`, text,
            place: `第 ${number} 页，x ${n(spot.x)}，y ${n(size.h - spot.y - spot.height)}，宽 ${n(spot.width)}，高 ${n(spot.height)}（PDF 点，原点在左下）`,
            locator: { type: 'region', page: number, pageId: entry.id, view: spot }, capture: windowBox };
    }
    function pickRegion(pageEl, entry, rect) {
        const target = regionTarget(pageEl, entry, rect);
        const box = target.capture;
        Pick.offer(target, { left: box.x, top: box.y, bottom: box.y + box.height });
    }
    // 右键：点在文字上引用这一行，点在空白处引用这一页。
    pagesHost.addEventListener('contextmenu', (event) => {
        const pageEl = event.target.closest('.uttu-pdf-page');
        const entry = pageEl && S?.pages.find((item) => item.id === pageEl.dataset.page);
        if (!entry) return;
        event.preventDefault();
        const box = pageEl.getBoundingClientRect();
        const line = event.target.closest('.textLayer span')?.getBoundingClientRect();
        const rect = line ? { x: 0, y: line.top - box.top, width: box.width, height: line.height } : { x: 0, y: 0, width: box.width, height: box.height };
        const target = regionTarget(pageEl, entry, rect);
        const visibleTop = Math.max(0, target.capture.y);
        Pick.menu({ ...target, capture: { ...target.capture, y: visibleTop, height: Math.min(innerHeight, target.capture.y + target.capture.height) - visibleTop } }, { x: event.clientX, y: event.clientY });
    });
    function pointIn(pageEl, event) {
        const box = pageEl.getBoundingClientRect();
        return { x: (event.clientX - box.left) / zoom, y: (event.clientY - box.top) / zoom };
    }
    const clampTo = (entry, item) => {
        const size = baseSize(S, entry);
        item.x = Math.min(Math.max(0, item.x), Math.max(0, size.w - Math.min(item.w, size.w)));
        item.y = Math.min(Math.max(0, item.y), Math.max(0, size.h - Math.min(item.h, size.h)));
    };
    const entryOf = (id) => S.pages.find((entry) => entry.id === id);
    function add(item) {
        item.id = uid('o');
        commit(() => S.objects.push(item));
        select(item.id);
        return item;
    }
    pagesHost.addEventListener('pointerdown', (event) => {
        if (!S || event.button !== 0) return;
        const pageEl = event.target.closest('.uttu-pdf-page');
        if (!pageEl) return;
        if (event.target.closest('.uttu-pdf-field')) return;
        const entry = entryOf(pageEl.dataset.page);
        const objEl = event.target.closest('.uttu-pdf-obj');
        if (objEl) {
            if (objEl.classList.contains('editing') && !event.target.classList.contains('h')) return; // 在字里点：挪光标
            event.preventDefault();
            dragObject(objEl.dataset.obj, event, event.target.classList.contains('h'));
            return;
        }
        if (tool === 'pick') {
            Pick.dragRegion(pageEl, event, (rect) => pickRegion(pageEl, entry, rect));
            return;
        }
        const point = pointIn(pageEl, event);
        if (tool === 'select') {
            finishEditing(true);
            select(null);
            return;
        }
        event.preventDefault();
        if (tool === 'text' || tool === 'date') {
            const item = { page: entry.id, type: 'text', x: point.x, y: point.y - 7, text: tool === 'date' ? today() : '', size: 12, color: INK.black };
            measure(item);
            clampTo(entry, item);
            add(item);
            if (tool === 'date') setTool('select');
            else requestAnimationFrame(() => startEditing(item.id, { isNew: true }));
        } else if (tool === 'check' || tool === 'cross') {
            const item = { page: entry.id, type: tool, x: point.x - 7, y: point.y - 7, w: 14, h: 14, color: INK.black };
            clampTo(entry, item);
            add(item);
        } else if (tool === 'place' && pending) {
            const item = { page: entry.id, type: 'image', data: pending.data, x: point.x - pending.w / 2, y: point.y - pending.h / 2, w: pending.w, h: pending.h };
            clampTo(entry, item);
            add(item);
            setTool('select');
        } else if (tool === 'cover') {
            const line = lineAt(pageEl, event);
            if (line) coverLine(entry, pageEl, line);
            else dragBox(entry, pageEl, point, event, 'cover');
        } else if (tool === 'rect' || tool === 'mark' || tool === 'redact') {
            dragBox(entry, pageEl, point, event, tool);
        }
    });
    pagesHost.addEventListener('dblclick', (event) => {
        const objEl = event.target.closest('.uttu-pdf-obj');
        if (objEl) startEditing(objEl.dataset.obj);
    });
    // 拖着挪、拖右下角改大小（图片、签名按原来的比例；文字按比例改字号）。
    function dragObject(id, event, resize) {
        const item = findObject(id);
        if (!item) return;
        finishEditing(true);
        select(id);
        const el = pagesHost.querySelector(`[data-obj="${id}"]`);
        if (!el) return;
        const entry = entryOf(item.page);
        const start = { x: event.clientX, y: event.clientY, item: { ...item } };
        let moved = false;
        el.setPointerCapture(event.pointerId);
        const move = (moveEvent) => {
            const dx = (moveEvent.clientX - start.x) / zoom;
            const dy = (moveEvent.clientY - start.y) / zoom;
            if (!moved && Math.abs(dx) + Math.abs(dy) < 2 / zoom) return;
            moved = true;
            const next = { ...start.item };
            if (resize) {
                if (item.type === 'text') {
                    const ratio = Math.max(0.2, (start.item.w + dx) / start.item.w);
                    next.size = Math.max(5, Math.min(96, start.item.size * ratio));
                    measure(next);
                } else if (item.type === 'image') {
                    const w = Math.max(8, start.item.w + dx);
                    next.w = w;
                    next.h = w * start.item.h / start.item.w;
                } else {
                    next.w = Math.max(6, start.item.w + dx);
                    next.h = Math.max(6, start.item.h + dy);
                }
            } else {
                next.x = start.item.x + dx;
                next.y = start.item.y + dy;
                clampTo(entry, next);
            }
            Object.assign(el.style, { left: `${next.x * zoom}px`, top: `${next.y * zoom}px`, width: `${next.w * zoom}px`, height: `${next.h * zoom}px` });
            if (next.size !== start.item.size) el.style.fontSize = `${next.size * zoom}px`;
            el._next = next;
        };
        const up = () => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
            el.removeEventListener('pointercancel', up);
            if (!moved || !el._next) return;
            const next = el._next;
            commit(() => Object.assign(item, { x: next.x, y: next.y, w: next.w, h: next.h, size: next.size ?? item.size }));
            renderProps();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
    }
    // 拖出一块（方框、高亮、改字的方块）。点一下没拖：给一个默认大小。
    function dragBox(entry, pageEl, point, event, type) {
        const ghost = make('div', `uttu-pdf-obj ${type} ghost`);
        const el = elements.get(entry.id);
        el.objs.append(ghost);
        let box = { x: point.x, y: point.y, w: 0, h: 0 };
        const draw = () => Object.assign(ghost.style, { left: `${box.x * zoom}px`, top: `${box.y * zoom}px`, width: `${box.w * zoom}px`, height: `${box.h * zoom}px` });
        draw();
        pageEl.setPointerCapture(event.pointerId);
        const move = (moveEvent) => {
            const now = pointIn(pageEl, moveEvent);
            box = { x: Math.min(point.x, now.x), y: Math.min(point.y, now.y), w: Math.abs(now.x - point.x), h: Math.abs(now.y - point.y) };
            draw();
        };
        const up = () => {
            pageEl.removeEventListener('pointermove', move);
            pageEl.removeEventListener('pointerup', up);
            pageEl.removeEventListener('pointercancel', up);
            ghost.remove();
            if (box.w < 4 && box.h < 4) box = { x: point.x, y: point.y - 10, w: type === 'mark' ? 80 : 120, h: type === 'mark' ? 14 : 40 };
            const item = { page: entry.id, type, ...box };
            clampTo(entry, item);
            if (type === 'rect') item.color = INK.red;
            else if (type === 'redact') item.color = INK.black;
            else if (type === 'mark') item.color = MARK;
            else Object.assign(item, { text: '', size: Math.max(6, Math.min(24, Math.round(box.h / LINE * 0.8))), ...sampleColors(entry, item) });
            add(item);
            if (type === 'cover') requestAnimationFrame(() => startEditing(item.id, { isNew: true }));
        };
        pageEl.addEventListener('pointermove', move);
        pageEl.addEventListener('pointerup', up);
        pageEl.addEventListener('pointercancel', up);
    }
    // 改字：点的是原文哪一行（文字层的一段）。工具不是“选择”时文字层不接指针，按位置找。
    function lineAt(pageEl, event) {
        const spans = elements.get(pageEl.dataset.page)?.text.querySelectorAll('span:not(.markedContent)') || [];
        for (const span of spans) {
            if (!span.textContent.trim()) continue;
            const box = span.getBoundingClientRect();
            if (event.clientX >= box.left - 1 && event.clientX <= box.right + 1 && event.clientY >= box.top - 1 && event.clientY <= box.bottom + 1) return span;
        }
        return null;
    }
    function coverLine(entry, pageEl, span) {
        const page = pageEl.getBoundingClientRect();
        const box = span.getBoundingClientRect();
        const height = box.height / zoom;
        const item = {
            page: entry.id, type: 'cover', x: (box.left - page.left) / zoom - 1, y: (box.top - page.top) / zoom - height * 0.12,
            w: box.width / zoom + 3, h: height * 1.24, text: span.textContent, size: Math.max(5, Math.round(height * 0.86 * 2) / 2),
        };
        Object.assign(item, sampleColors(entry, item));
        add(item);
        requestAnimationFrame(() => startEditing(item.id, { isNew: true }));
    }
    // 方块的底色取原文这块边上最亮的颜色，字的颜色取里面最深的（黑字白纸、白字深底都能对上）。
    function sampleColors(entry, item) {
        const el = elements.get(entry.id);
        const fallback = { fill: [1, 1, 1], color: INK.black };
        if (!el?.canvas?.width) return fallback;
        try {
            const ratio = el.canvas.width / (baseSize(S, entry).w * zoom);
            const k = zoom * ratio;
            const x = Math.max(0, Math.floor(item.x * k));
            const y = Math.max(0, Math.floor(item.y * k));
            const w = Math.max(1, Math.min(el.canvas.width - x, Math.ceil(item.w * k)));
            const h = Math.max(1, Math.min(el.canvas.height - y, Math.ceil(item.h * k)));
            const data = el.canvas.getContext('2d').getImageData(x, y, w, h).data;
            const at = (px, py) => {
                const i = (py * w + px) * 4;
                return [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
            };
            const light = (rgb) => rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11;
            let fill = null;
            for (let px = 0; px < w; px += Math.max(1, Math.floor(w / 24))) {
                for (const py of [0, h - 1]) {
                    const rgb = at(px, py);
                    if (!fill || light(rgb) > light(fill)) fill = rgb;
                }
            }
            let ink = null;
            const step = Math.max(1, Math.floor(Math.sqrt(w * h / 4000)));
            for (let py = 0; py < h; py += step) {
                for (let px = 0; px < w; px += step) {
                    const rgb = at(px, py);
                    if (!ink || light(rgb) < light(ink)) ink = rgb;
                }
            }
            if (!fill) return fallback;
            const color = ink && Math.abs(light(fill) - light(ink)) > 0.25 ? ink : (light(fill) > 0.5 ? INK.black : [1, 1, 1]);
            return { fill: fill.map((v) => Math.round(v * 100) / 100), color: color.map((v) => Math.round(v * 100) / 100) };
        } catch (_) {
            return fallback;
        }
    }

    // ---------- 表单 ----------
    function drawFields(entry) {
        const el = elements.get(entry.id);
        if (!el) return;
        el.fields.replaceChildren();
        if (entry.blank || entry.src !== 'main' || !S.fields.length) return;
        // 同一页用了两次：只在第一次出现的那页上填。
        const first = S.pages.find((page) => page.src === 'main' && page.index === entry.index);
        if (first?.id !== entry.id) return;
        const viewport = proxyOf(S, entry).getViewport({ scale: zoom, rotation: entry.rot });
        for (const field of S.fields) {
            field.widgets.forEach((widget, k) => {
                if (widget.page !== entry.index) return;
                const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([widget.x, widget.y, widget.x + widget.w, widget.y + widget.h]);
                const box = { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
                let input;
                const value = S.values[field.name];
                if (field.type === 'text') {
                    input = make(box.height > 40 ? 'textarea' : 'input');
                    input.value = String(value ?? '');
                    input.style.fontSize = `${Math.min(14 * zoom, Math.max(7, box.height * 0.62))}px`;
                    input.addEventListener('change', () => setField(field.name, input.value));
                } else if (field.type === 'check') {
                    input = make('input');
                    input.type = 'checkbox';
                    input.checked = Boolean(value);
                    input.addEventListener('change', () => setField(field.name, input.checked));
                } else if (field.type === 'radio') {
                    input = make('input');
                    input.type = 'radio';
                    input.name = `uttu-pdf-${S.generation}-${field.name}`;
                    input.checked = value === field.options[k];
                    input.addEventListener('change', () => { if (input.checked) setField(field.name, field.options[k]); });
                } else if (field.type === 'choice') {
                    input = make('select');
                    input.append(make('option', '', ''));
                    for (const option of field.options) {
                        const node = make('option');
                        node.value = option;
                        node.textContent = option;
                        input.append(node);
                    }
                    input.value = String(value ?? '');
                    input.addEventListener('change', () => setField(field.name, input.value));
                }
                if (!input) return;
                input.className = `uttu-pdf-field ${field.type}`;
                input.disabled = Boolean(field.readOnly);
                input.setAttribute('aria-label', field.name);
                Object.assign(input.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
                el.fields.append(input);
            });
        }
    }
    function setField(name, value) {
        if (S.values[name] === value) return;
        commit(() => { S.values[name] = value; });
    }

    // ---------- 缩放、滚动 ----------
    function setZoom(value, { quiet = false } = {}) {
        fitted = false;
        const next = Math.max(0.25, Math.min(4, Math.round(value * 100) / 100));
        if (next === zoom && !quiet) return;
        // 缩放前后，屏幕中间看的还是同一处。
        const anchor = S && !quiet ? pageAtMiddle() : null;
        zoom = next;
        setText(zoomValue, `${Math.round(zoom * 100)}%`);
        if (!S) return;
        finishEditing(true);
        invalidate();
        refresh();
        paintPicks();
        if (anchor) {
            const el = elements.get(anchor.id);
            if (el) scroller.scrollTop = el.root.offsetTop + anchor.ratio * el.root.offsetHeight - scroller.clientHeight / 2;
        }
    }
    function fitWidth({ quiet = false } = {}) {
        if (!S) return;
        const widest = Math.max(...S.pages.map((entry) => baseSize(S, entry).w));
        const room = Math.max(200, (scroller.clientWidth || work.clientWidth || 800) - 48);
        setZoom(Math.min(quiet ? 1.5 : 4, room / widest), { quiet });
        fitted = quiet;
    }
    function pageAtMiddle() {
        const middle = scroller.scrollTop + scroller.clientHeight / 2;
        for (const entry of S.pages) {
            const el = elements.get(entry.id);
            if (el && el.root.offsetTop + el.root.offsetHeight >= middle) {
                return { id: entry.id, ratio: Math.min(1, Math.max(0, (middle - el.root.offsetTop) / el.root.offsetHeight)) };
            }
        }
        return null;
    }
    function currentPage() {
        if (!S) return null;
        const line = scroller.scrollTop + scroller.clientHeight / 3;
        let found = S.pages[0];
        for (const entry of S.pages) {
            const el = elements.get(entry.id);
            if (el && el.root.offsetTop <= line) found = entry;
        }
        return found;
    }
    function trackPage() {
        if (!S) return;
        const entry = currentPage();
        setText(pageInfo, `${S.pages.indexOf(entry) + 1} / ${S.pages.length}`);
        thumbs.querySelectorAll('.uttu-pdf-thumb').forEach((node) => node.classList.toggle('here', node.dataset.page === entry?.id));
    }
    scroller.addEventListener('scroll', () => requestAnimationFrame(trackPage), { passive: true });
    scroller.addEventListener('wheel', (event) => {
        if (!(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });
    if (window.ResizeObserver) {
        let width = 0;
        new ResizeObserver(() => {
            if (!S || Math.abs(scroller.clientWidth - width) < 2) return;
            width = scroller.clientWidth;
            if (fitted) fitWidth({ quiet: true });
            renderVisible();
        }).observe(scroller);
    }
    function scrollToPage(id) {
        const el = elements.get(id);
        if (el) scroller.scrollTop = el.root.offsetTop - 12;
    }

    // 一次改动后：排页、画放上去的东西、缩略图、栏头。
    function refresh() {
        if (!S) return;
        layout();
        drawAllObjects();
        for (const entry of S.pages) drawFields(entry);
        drawStamps();
        renderVisible();
        renderThumbs();
        undoButton.disabled = !S.history.length;
        redoButton.disabled = !S.future.length;
        renderProps();
        trackPage();
        UI.sync?.();
    }

    // ---------- 左栏：页面缩略图 ----------
    const thumbElements = new Map();
    const thumbObserver = new IntersectionObserver((records) => {
        for (const record of records) if (record.isIntersecting) void drawThumb(record.target.dataset.page);
    }, { root: document.getElementById('outline-panel'), rootMargin: '300px 0px' });
    function renderThumbs() {
        if (!S) return;
        const keep = new Set(S.pages.map((entry) => entry.id));
        for (const [id, node] of thumbElements) {
            if (!keep.has(id)) {
                thumbObserver.unobserve(node);
                node.remove();
                thumbElements.delete(id);
            }
        }
        for (const id of [...pickedPages]) if (!keep.has(id)) pickedPages.delete(id);
        S.pages.forEach((entry, index) => {
            let node = thumbElements.get(entry.id);
            if (!node) {
                node = make('div', 'uttu-pdf-thumb');
                node.dataset.page = entry.id;
                node.setAttribute('role', 'option');
                node.draggable = true;
                node.append(make('span', 'pic'), make('small'));
                thumbElements.set(entry.id, node);
                thumbObserver.observe(node);
            }
            const size = baseSize(S, entry);
            const pic = node.querySelector('.pic');
            pic.style.aspectRatio = `${size.w} / ${size.h}`;
            setText(node.querySelector('small'), String(index + 1));
            node.setAttribute('aria-selected', String(pickedPages.has(entry.id)));
            if (node.dataset.key && node.dataset.key !== `${entry.rot}`) void drawThumb(entry.id);
            if (thumbs.children[index] !== node) thumbs.insertBefore(node, thumbs.children[index] || null);
        });
        if (document.body.dataset.uttuLeft === 'outline') renderLeft();
    }
    async function drawThumb(id) {
        const state = S;
        const entry = state?.pages.find((page) => page.id === id);
        const node = thumbElements.get(id);
        if (!entry || !node || node.dataset.key === `${entry.rot}`) return;
        node.dataset.key = `${entry.rot}`;
        const pic = node.querySelector('.pic');
        if (entry.blank) {
            pic.replaceChildren();
            return;
        }
        const proxy = proxyOf(state, entry);
        const plain = proxy.getViewport({ scale: 1, rotation: entry.rot });
        const viewport = proxy.getViewport({ scale: 240 / plain.width, rotation: entry.rot });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        try {
            await proxy.render({ canvasContext: canvas.getContext('2d'), canvas, viewport }).promise;
        } catch (_) {
            node.dataset.key = '';
            return;
        }
        if (S === state) pic.replaceChildren(canvas);
    }
    thumbs.addEventListener('click', (event) => {
        const node = event.target.closest('.uttu-pdf-thumb');
        if (!node || !S) return;
        const id = node.dataset.page;
        if (event.shiftKey && pickedPages.size) {
            const ids = S.pages.map((entry) => entry.id);
            const last = ids.indexOf([...pickedPages].pop());
            const here = ids.indexOf(id);
            for (const key of ids.slice(Math.min(last, here), Math.max(last, here) + 1)) pickedPages.add(key);
        } else if (event.ctrlKey || event.metaKey) {
            if (pickedPages.has(id)) pickedPages.delete(id); else pickedPages.add(id);
        } else {
            pickedPages.clear();
            pickedPages.add(id);
            scrollToPage(id);
        }
        renderThumbs();
    });
    thumbs.addEventListener('contextmenu', (event) => {
        const node = event.target.closest('.uttu-pdf-thumb');
        if (!node || !S) return;
        event.preventDefault();
        event.stopPropagation();
        if (!pickedPages.has(node.dataset.page)) {
            pickedPages.clear();
            pickedPages.add(node.dataset.page);
            renderThumbs();
        }
        const many = pickedPages.size > 1;
        UI.openMenu([
            { label: '向右转', act: () => rotatePages(1) },
            { label: '向左转', act: () => rotatePages(-1) },
            { label: '往前挪一页', act: () => movePages(-1) },
            { label: '往后挪一页', act: () => movePages(1) },
            { sep: true },
            { label: '复制这页', disabled: many, act: () => duplicatePage() },
            { label: '在后面加白页', act: () => addBlank() },
            { label: '在后面并入别的 PDF', act: () => void mergeFiles() },
            { label: many ? `把这 ${pickedPages.size} 页导出成新 PDF` : '把这页导出成新 PDF', act: () => void exportPages() },
            { label: '拆成几份', act: () => void splitDialog() },
            { sep: true },
            { label: many ? `删掉这 ${pickedPages.size} 页` : '删掉这页', act: () => removePages() },
        ], { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY });
    }, true);
    // 拖动缩略图换顺序（选中了几页就一起挪）。
    let dragging = null;
    thumbs.addEventListener('dragstart', (event) => {
        const node = event.target.closest('.uttu-pdf-thumb');
        if (!node) return;
        if (!pickedPages.has(node.dataset.page)) {
            pickedPages.clear();
            pickedPages.add(node.dataset.page);
            renderThumbs();
        }
        dragging = [...pickedPages];
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', 'uttu-pdf-pages');
    });
    thumbs.addEventListener('dragover', (event) => {
        if (!dragging) return;
        event.preventDefault();
        const node = event.target.closest('.uttu-pdf-thumb');
        thumbs.querySelectorAll('.drop-before, .drop-after').forEach((item) => item.classList.remove('drop-before', 'drop-after'));
        if (!node) return;
        const box = node.getBoundingClientRect();
        node.classList.add(event.clientY < box.top + box.height / 2 ? 'drop-before' : 'drop-after');
    });
    thumbs.addEventListener('dragend', () => {
        dragging = null;
        thumbs.querySelectorAll('.drop-before, .drop-after').forEach((item) => item.classList.remove('drop-before', 'drop-after'));
    });
    thumbs.addEventListener('drop', (event) => {
        if (!dragging || !S) return;
        event.preventDefault();
        const node = event.target.closest('.uttu-pdf-thumb');
        const after = node?.classList.contains('drop-after');
        const moving = new Set(dragging);
        dragging = null;
        thumbs.querySelectorAll('.drop-before, .drop-after').forEach((item) => item.classList.remove('drop-before', 'drop-after'));
        if (!node || moving.has(node.dataset.page)) return;
        commit(() => {
            const rest = S.pages.filter((entry) => !moving.has(entry.id));
            const picked = S.pages.filter((entry) => moving.has(entry.id));
            const at = rest.findIndex((entry) => entry.id === node.dataset.page) + (after ? 1 : 0);
            rest.splice(at, 0, ...picked);
            S.pages = rest;
        });
    });
    function renderLeft() {
        if (!S || document.body.dataset.uttuLeft !== 'outline') return;
        leftTools.marks.hidden = !S.marks.length;
        if (leftList === 'marks' && S.marks.length) {
            UI.setLeftHead({ title: '书签', count: `${S.marks.length} 条`, tools: [leftTools.marks] });
            return;
        }
        document.body.dataset.uttuPdfLeft = 'pages';
        const count = pickedPages.size > 1 ? `选了 ${pickedPages.size} 页` : `${S.pages.length} 页`;
        UI.setLeftHead({ title: '页面', count, tools: [leftTools.rotate, leftTools.remove, leftTools.blank, leftTools.merge, leftTools.marks] });
    }
    // 书签：pdf.js 的目录摊平成一列（缩进表示层级），每条记它指向原文件的第几页。
    async function loadMarks(state) {
        let outline = null;
        try { outline = await state.docs.main.getOutline(); } catch (_) { outline = null; }
        const out = [];
        const walk = async (items, depth) => {
            for (const item of items || []) {
                if (out.length >= 2000) return;
                let index = -1;
                try {
                    const dest = typeof item.dest === 'string' ? await state.docs.main.getDestination(item.dest) : item.dest;
                    if (Array.isArray(dest) && dest[0]) index = typeof dest[0] === 'number' ? dest[0] : await state.docs.main.getPageIndex(dest[0]);
                } catch (_) { index = -1; }
                out.push({ title: String(item.title || '').trim() || '（没有名字）', depth, index });
                await walk(item.items, depth + 1);
            }
        };
        await walk(outline, 0);
        return out;
    }
    function renderMarks() {
        if (!S) return;
        markList.replaceChildren(...S.marks.map((mark) => {
            const row = button('uttu-row', '', '', () => {
                const entry = S.pages.find((page) => page.src === 'main' && page.index === mark.index);
                if (entry) scrollToPage(entry.id);
                else UI.toast('书签指的那页已经删掉了。');
            });
            row.append(make('span', 'nm', UI.escapeHtml(mark.title)));
            row.style.paddingLeft = `${8 + mark.depth * 14}px`;
            row.disabled = mark.index < 0;
            return row;
        }));
    }
    UI.on('left', ({ open: shown, key } = {}) => { if (shown && key === 'outline') setTimeout(renderLeft, 0); });

    // ---------- 页面操作 ----------
    // 没在左栏选页时，对正在看的那页做。
    const targetPages = () => {
        const ids = S.pages.filter((entry) => pickedPages.has(entry.id));
        return ids.length ? ids : [currentPage()].filter(Boolean);
    };
    function rotatePages(direction) {
        if (!S) return;
        const targets = targetPages();
        commit(() => {
            for (const entry of targets) {
                const before = baseSize(S, entry);
                entry.rot = (entry.rot + (direction > 0 ? 90 : 270)) % 360;
                // 放在这页上的东西跟着页面转（东西本身保持正着）。
                for (const item of S.objects.filter((object) => object.page === entry.id)) {
                    const cx = item.x + item.w / 2;
                    const cy = item.y + item.h / 2;
                    const [nx, ny] = direction > 0 ? [before.h - cy, cx] : [cy, before.w - cx];
                    item.x = nx - item.w / 2;
                    item.y = ny - item.h / 2;
                    clampTo(entry, item);
                }
            }
        });
    }
    function removePages() {
        if (!S) return;
        const targets = new Set(targetPages().map((entry) => entry.id));
        if (targets.size >= S.pages.length) {
            UI.toast('至少要留一页。', 'error');
            return;
        }
        commit(() => {
            S.pages = S.pages.filter((entry) => !targets.has(entry.id));
            S.objects = S.objects.filter((item) => !targets.has(item.page));
        });
        pickedPages.clear();
        renderThumbs();
    }
    function movePages(step) {
        if (!S) return;
        const targets = new Set(targetPages().map((entry) => entry.id));
        commit(() => {
            const list = [...S.pages];
            const order = step < 0 ? list.map((_, i) => i) : list.map((_, i) => list.length - 1 - i);
            for (const i of order) {
                const j = i + step;
                if (!targets.has(list[i].id) || j < 0 || j >= list.length || targets.has(list[j].id)) continue;
                [list[i], list[j]] = [list[j], list[i]];
            }
            S.pages = list;
        });
    }
    function duplicatePage() {
        const [entry] = targetPages();
        if (!entry) return;
        commit(() => {
            const copy = { ...entry, id: uid('p') };
            S.pages.splice(S.pages.indexOf(entry) + 1, 0, copy);
        });
    }
    function addBlank() {
        if (!S) return;
        const targets = targetPages();
        const last = targets[targets.length - 1] || S.pages[S.pages.length - 1];
        // 白页和它前面那页一样大（按没转过的方向）。
        const size = baseSize(S, last);
        const [w, h] = last.rot % 180 ? [size.h, size.w] : [size.w, size.h];
        commit(() => S.pages.splice(S.pages.indexOf(last) + 1, 0, { id: uid('p'), blank: { w, h }, rot: last.rot }));
    }
    async function mergeFiles() {
        if (!S) return;
        const state = S;
        let picked;
        try {
            picked = await api().pdf('pick');
        } catch (error) {
            UI.toast(`没并进来：${error.message}`, 'error', 5000);
            return;
        }
        if (!picked?.files?.length || S !== state) return;
        const added = [];
        const sources = {};
        for (const file of picked.files) {
            let doc;
            try {
                doc = await loadDocument(file.bytes);
            } catch (error) {
                UI.toast(passwordProblem(error) || `${file.name} 没读懂：${error.message}`, 'error', 5000);
                continue;
            }
            const src = uid('f');
            state.docs[src] = doc;
            sources[src] = file.path;
            for (let index = 0; index < doc.numPages; index += 1) {
                const proxy = await doc.getPage(index + 1);
                state.proxies.set(`${src}:${index}`, proxy);
                added.push({ id: uid('p'), src, index, rot: proxy.rotate || 0 });
            }
        }
        if (!added.length || S !== state) return;
        const targets = targetPages();
        const last = pickedPages.size ? targets[targets.length - 1] : S.pages[S.pages.length - 1];
        commit(() => {
            Object.assign(S.sources, sources);
            S.pages.splice(S.pages.indexOf(last) + 1, 0, ...added);
        });
        UI.toast(`并进来 ${added.length} 页，存了才写进文件。`);
    }
    async function exportPages() {
        if (!S) return;
        const targets = targetPages();
        const ids = new Set(targets.map((entry) => entry.id));
        const numbers = S.pages.map((entry, index) => (ids.has(entry.id) ? index + 1 : 0)).filter(Boolean);
        const label = numbers.length === 1 ? `第${numbers[0]}页` : `第${numbers[0]}-${numbers[numbers.length - 1]}页`;
        try {
            const result = await api().pdf('save', {
                path: S.filePath, plan: await planOf(S, ids), fingerprint: S.fingerprint, saveAs: true,
                defaultPath: S.filePath.replace(/\.pdf$/i, ` ${label}.pdf`),
            });
            if (result?.success) UI.toast(`导出好了：${result.filePath.split(/[\\/]/).pop()}`);
            else if (!result?.canceled) UI.toast(`没导出：${result?.error || '写不进去'}`, 'error', 5000);
        } catch (error) {
            UI.toast(`没导出：${error.message}`, 'error', 5000);
        }
    }

    // ---------- 签名、图片 ----------
    let signDialog = null;
    async function openSignature() {
        if (!S) return;
        if (!signDialog) signDialog = buildSignDialog();
        await signDialog.open();
    }
    function buildSignDialog() {
        const scrim = make('div', 'uttu-dlg-scrim');
        scrim.hidden = true;
        const box = make('div', 'uttu-dlg uttu-pdf-sign');
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-label', '签名');
        box.innerHTML = '<h4>签名 <span class="uttu-eyebrow">Sign</span></h4>';
        const seg = make('div', 'uttu-seg full sm');
        const panes = {};
        let mode = 'draw';
        for (const [key, label] of [['draw', '手写'], ['type', '打字'], ['saved', '用存过的']]) {
            const option = button('', '', label, () => show(key));
            option.dataset.v = key;
            seg.append(option);
            panes[key] = make('div', `uttu-pdf-sign-pane ${key}`);
        }
        // 手写：按住画，松开是一笔。
        const pad = make('canvas', 'uttu-pdf-pad');
        pad.width = 800;
        pad.height = 300;
        const padContext = pad.getContext('2d');
        let strokes = 0;
        function clearPad() {
            padContext.clearRect(0, 0, pad.width, pad.height);
            strokes = 0;
        }
        pad.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            pad.setPointerCapture(event.pointerId);
            const scale = pad.width / pad.getBoundingClientRect().width;
            const at = (pointer) => {
                const rect = pad.getBoundingClientRect();
                return [(pointer.clientX - rect.left) * scale, (pointer.clientY - rect.top) * scale];
            };
            let last = at(event);
            padContext.strokeStyle = css(ink);
            padContext.lineCap = 'round';
            padContext.lineJoin = 'round';
            const move = (moveEvent) => {
                const next = at(moveEvent);
                // 压感笔按得重线就粗一点；鼠标是固定粗细。
                padContext.lineWidth = 3.2 * scale * (moveEvent.pressure && moveEvent.pointerType === 'pen' ? 0.6 + moveEvent.pressure : 1);
                padContext.beginPath();
                padContext.moveTo(...last);
                padContext.lineTo(...next);
                padContext.stroke();
                last = next;
            };
            const up = () => {
                strokes += 1;
                pad.removeEventListener('pointermove', move);
                pad.removeEventListener('pointerup', up);
                pad.removeEventListener('pointercancel', up);
            };
            pad.addEventListener('pointermove', move);
            pad.addEventListener('pointerup', up);
            pad.addEventListener('pointercancel', up);
        });
        let ink = INK.black;
        const inks = make('div', 'uttu-swatches');
        for (const [label, rgb] of [['黑', INK.black], ['蓝', INK.blue]]) {
            const swatch = button('', label, '', () => {
                ink = rgb;
                inks.querySelectorAll('button').forEach((node) => node.setAttribute('aria-pressed', String(node === swatch)));
            });
            swatch.style.setProperty('--c', css(rgb));
            swatch.setAttribute('aria-pressed', String(rgb === ink));
            inks.append(swatch);
        }
        const padTools = make('div', 'uttu-pdf-sign-row');
        padTools.append(inks, make('span', 'grow'), button('uttu-link-btn', '', '擦掉重写', clearPad));
        panes.draw.append(pad, padTools);
        // 打字：用手写体画出来。
        const typed = make('input', 'uttu-pdf-sign-input');
        typed.placeholder = '写上名字';
        typed.setAttribute('aria-label', '名字');
        const typedPreview = make('div', 'uttu-pdf-sign-typed');
        typed.addEventListener('input', () => setText(typedPreview, typed.value));
        panes.type.append(typed, typedPreview);
        // 存过的：点一个就用；可以删。
        const list = make('div', 'uttu-pdf-sign-list');
        panes.saved.append(list);
        const keep = button('uttu-chk', '', `<span class="box">${icon('i-check')}</span><span>存起来，下次直接用</span>`, () => {
            keep.setAttribute('aria-checked', String(keep.getAttribute('aria-checked') !== 'true'));
        });
        keep.setAttribute('role', 'checkbox');
        keep.setAttribute('aria-checked', 'true');
        const acts = make('div', 'acts');
        acts.append(button('uttu-btn ghost', '', '取消', close), button('uttu-btn primary', '', '放到页面上', () => void done()));
        box.append(seg, ...Object.values(panes), keep, acts);
        scrim.append(box);
        scrim.addEventListener('pointerdown', (event) => { if (event.target === scrim) close(); });
        box.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') close();
            event.stopPropagation();
        });
        document.body.append(scrim);
        function show(key) {
            mode = key;
            seg.querySelectorAll('button').forEach((option) => option.setAttribute('aria-pressed', String(option.dataset.v === key)));
            for (const [name, pane] of Object.entries(panes)) pane.hidden = name !== key;
            keep.hidden = key === 'saved';
            if (key === 'type') typed.focus();
        }
        async function loadSaved() {
            let result;
            try {
                result = await api().pdf('signatures');
            } catch (_) {
                result = { signatures: [] };
            }
            const items = result?.signatures || [];
            list.replaceChildren(...(items.length ? items.map((item) => {
                const row = make('div', 'uttu-pdf-sign-item');
                const use = button('', '用这个签名', `<img alt="" src="${item.data}">`, () => {
                    close();
                    void placeImage(item.data);
                });
                const remove = button('uttu-tb', '删掉这个签名', icon('i-trash'), async () => {
                    await api().pdf('signature-delete', { id: item.id }).catch(() => {});
                    void loadSaved();
                });
                row.append(use, remove);
                return row;
            }) : [make('p', 'uttu-left-note', '还没有存过签名。')]));
            return items.length;
        }
        function close() {
            scrim.hidden = true;
        }
        async function done() {
            let data = '';
            if (mode === 'draw') {
                if (!strokes) { UI.toast('还没写。'); return; }
                data = trim(pad);
            } else if (mode === 'type') {
                const name = typed.value.trim();
                if (!name) { UI.toast('还没写名字。'); return; }
                data = await typedSignature(name, ink);
            } else {
                return;
            }
            if (!data) return;
            if (keep.getAttribute('aria-checked') === 'true') void api().pdf('signature-save', { data }).catch(() => {});
            close();
            await placeImage(data);
        }
        return Object.freeze({
            async open() {
                clearPad();
                typed.value = '';
                setText(typedPreview, '');
                const saved = await loadSaved();
                scrim.hidden = false;
                show(saved ? 'saved' : 'draw');
            },
        });
    }
    // 把画布上画了的部分裁出来（四周留一点）。
    function trim(canvas) {
        const { width, height } = canvas;
        const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
        let top = height;
        let left = width;
        let right = -1;
        let bottom = -1;
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                if (data[(y * width + x) * 4 + 3] > 8) {
                    if (x < left) left = x;
                    if (x > right) right = x;
                    if (y < top) top = y;
                    if (y > bottom) bottom = y;
                }
            }
        }
        if (right < 0) return '';
        const margin = 6;
        left = Math.max(0, left - margin);
        top = Math.max(0, top - margin);
        right = Math.min(width - 1, right + margin);
        bottom = Math.min(height - 1, bottom + margin);
        const out = document.createElement('canvas');
        out.width = right - left + 1;
        out.height = bottom - top + 1;
        out.getContext('2d').drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
        return out.toDataURL('image/png');
    }
    async function typedSignature(name, ink) {
        const family = `${getComputedStyle(document.body).getPropertyValue('--uttu-font-script').trim() || 'cursive'}, KaiTi, STKaiti, "Kaiti SC", serif`;
        try { await document.fonts.load(`96px ${family}`, name); } catch (_) { /* 用能用的字体 */ }
        const canvas = document.createElement('canvas');
        canvas.width = 1200;
        canvas.height = 240;
        const context = canvas.getContext('2d');
        context.font = `96px ${family}`;
        context.fillStyle = css(ink);
        context.textBaseline = 'middle';
        context.fillText(name, 24, 120, 1150);
        return trim(canvas);
    }
    // 放图：先量出原图大小，宽不超过 180（签名）或这一页的一半，然后等着点页面放。
    async function placeImage(data) {
        if (!S) return;
        const img = new Image();
        img.src = data;
        try { await img.decode(); } catch (_) { UI.toast('这张图读不出来。', 'error'); return; }
        const entry = currentPage();
        const room = baseSize(S, entry).w * 0.5;
        const w = Math.min(img.naturalWidth / 2, room, 180);
        pending = { data, w, h: w * img.naturalHeight / img.naturalWidth };
        setTool('place');
    }
    imageInput.addEventListener('change', async () => {
        const file = imageInput.files?.[0];
        imageInput.value = '';
        if (!file) return;
        const data = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => resolve('');
            reader.readAsDataURL(file);
        });
        await placeImage(await asPngOrJpeg(data));
    });
    // pdf-lib 只认 PNG、JPG：别的格式（webp、gif、svg）先在画布上画一遍变成 PNG。
    async function asPngOrJpeg(data) {
        if (/^data:image\/(png|jpe?g);/i.test(data)) return data;
        const img = new Image();
        img.src = data;
        try { await img.decode(); } catch (_) { return ''; }
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || 600;
        canvas.height = img.naturalHeight || 400;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png');
    }

    // ---------- 页码、水印（每页都加；页面上先看到样子，存的时候 edit.js 照同样的位置写） ----------
    const PAGE_FORMATS = [['{n}', '1'], ['{n} / {total}', '1 / 12'], ['第 {n} 页', '第 1 页'], ['第 {n} 页 共 {total} 页', '第 1 页 共 12 页']];
    function setStamps(next) {
        if (!S) return;
        commit(() => { S.stamps = { ...S.stamps, ...next }; });
    }
    function pageNumberMenu() {
        if (!S) return;
        const current = S.stamps.pageNumbers?.format || '';
        UI.openMenu([
            { grp: '页码（每页底下居中）' },
            ...PAGE_FORMATS.map(([format, sample]) => ({ label: sample, check: current === format, act: () => setStamps({ pageNumbers: { format, size: 10 } }) })),
            { sep: true },
            { label: '不要页码', disabled: !current, act: () => setStamps({ pageNumbers: null }) },
        ], insert);
    }
    async function askWatermark() {
        if (!S) return;
        const text = await askText({ title: '水印', label: '每页斜着写一行淡字（留空就去掉）', value: S.stamps.watermark?.text || '内部资料', ok: '加上' });
        if (text === null) return;
        setStamps({ watermark: text.trim() ? { text: text.trim().slice(0, 80), opacity: 0.18 } : null });
    }
    function drawStamps() {
        if (!S) return;
        const total = S.pages.length;
        S.pages.forEach((entry, index) => {
            const el = elements.get(entry.id);
            if (!el) return;
            el.root.querySelectorAll(':scope > .uttu-pdf-stamp').forEach((node) => node.remove());
            const size = baseSize(S, entry);
            const mark = S.stamps.watermark;
            if (mark?.text) {
                const big = mark.size || Math.min(size.w, size.h) / Math.max(4, mark.text.length * 0.9);
                const node = make('div', 'uttu-pdf-stamp wm');
                node.textContent = mark.text;
                node.style.fontSize = `${big * zoom}px`;
                node.style.fontFamily = FONT;
                node.style.opacity = String(mark.opacity ?? 0.18);
                node.style.color = css([0.5, 0.5, 0.5]); // 和 edit.js 写进去的灰一样
                el.root.append(node);
            }
            const numbers = S.stamps.pageNumbers;
            if (numbers) {
                const node = make('div', 'uttu-pdf-stamp pn');
                node.textContent = numbers.format.replace('{n}', String(index + 1)).replace('{total}', String(total));
                const fontSize = (numbers.size || 10);
                node.style.fontSize = `${fontSize * zoom}px`;
                node.style.fontFamily = FONT;
                node.style.bottom = `${(22 - fontSize * 0.22) * zoom}px`;
                node.style.color = css([0.35, 0.35, 0.35]);
                el.root.append(node);
            }
        });
    }
    // 一行字的小对话框（水印、拆分的页数用）。回 null 是取消。
    let textDialog = null;
    function askText({ title, label, value = '', ok = '好', type = 'text' }) {
        if (!textDialog) {
            const scrim = make('div', 'uttu-dlg-scrim');
            scrim.hidden = true;
            const box = make('div', 'uttu-dlg');
            box.setAttribute('role', 'dialog');
            box.setAttribute('aria-modal', 'true');
            const heading = make('h4');
            const field = make('label', 'uttu-field');
            const lab = make('span', 'lab');
            const input = make('input', 'uttu-pdf-sign-input');
            field.append(lab, input);
            const acts = make('div', 'acts');
            const cancel = button('uttu-btn ghost', '', '取消', () => finish(null));
            const confirm = button('uttu-btn primary', '', '好', () => finish(input.value));
            acts.append(cancel, confirm);
            box.append(heading, field, acts);
            scrim.append(box);
            document.body.append(scrim);
            let resolver = null;
            const finish = (result) => {
                scrim.hidden = true;
                const done = resolver;
                resolver = null;
                done?.(result);
            };
            scrim.addEventListener('pointerdown', (event) => { if (event.target === scrim) finish(null); });
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') { event.preventDefault(); finish(input.value); }
                if (event.key === 'Escape') { event.preventDefault(); finish(null); }
                event.stopPropagation();
            });
            textDialog = { scrim, heading, lab, input, confirm, box, open: (resolve) => { resolver = resolve; } };
        }
        const d = textDialog;
        setText(d.heading, title);
        d.box.setAttribute('aria-label', title);
        setText(d.lab, label);
        setText(d.confirm, ok);
        d.input.type = type;
        d.input.value = value;
        d.scrim.hidden = false;
        requestAnimationFrame(() => { d.input.focus(); d.input.select(); });
        return new Promise((resolve) => d.open(resolve));
    }

    // ---------- 拆分 ----------
    async function splitDialog() {
        if (!S) return;
        const picked = S.pages.filter((entry) => pickedPages.has(entry.id));
        const atPicked = picked.length && !(picked.length === 1 && picked[0] === S.pages[0]);
        const items = [
            { grp: `拆成几份（共 ${S.pages.length} 页，原文件不动）` },
            { label: '每页一份', act: () => void splitBy('each') },
            { label: '每几页一份', act: async () => {
                const value = await askText({ title: '拆分', label: '每几页一份', value: '2', ok: '拆', type: 'number' });
                const n = Math.floor(Number(value));
                if (value !== null && n >= 1) void splitBy('every', n);
            } },
            { label: '在选中的页前面断开', hint: atPicked ? `${picked.length} 处` : '先在左栏选页', disabled: !atPicked, act: () => void splitBy('picked') },
        ];
        UI.openMenu(items, insert);
    }
    async function splitBy(mode, n = 1) {
        if (!S) return null;
        const state = S;
        const groups = [];
        if (mode === 'each') state.pages.forEach((entry) => groups.push([entry]));
        else if (mode === 'every') for (let k = 0; k < state.pages.length; k += n) groups.push(state.pages.slice(k, k + n));
        else {
            let group = [];
            for (const entry of state.pages) {
                if (pickedPages.has(entry.id) && group.length) { groups.push(group); group = []; }
                group.push(entry);
            }
            if (group.length) groups.push(group);
        }
        if (groups.length < 2) { UI.toast('只有一份，不用拆。'); return null; }
        const stem = state.name.replace(/\.pdf$/i, '');
        const numberOf = (entry) => state.pages.indexOf(entry) + 1;
        const parts = [];
        for (const group of groups) {
            const first = numberOf(group[0]);
            const last = numberOf(group[group.length - 1]);
            parts.push({ name: `${stem} ${first === last ? `第${first}页` : `第${first}-${last}页`}.pdf`, plan: await planOf(state, new Set(group.map((entry) => entry.id))) });
        }
        let result;
        try {
            result = await api().pdf('split', { path: state.filePath, fingerprint: state.fingerprint, parts });
        } catch (error) {
            result = { success: false, error: error.message };
        }
        if (result?.success) UI.toast(`拆好了：${result.files.length} 份，在 ${result.folder.split(/[\\/]/).pop()}。`);
        else if (!result?.canceled) UI.toast(`没拆成：${result?.error || '写不进去'}`, 'error', 5000);
        return result;
    }

    // ---------- 交给 Agent 重建 ----------
    // 不做“PDF 转 Word”：把字抽出来排成 Markdown 初稿（一行行按位置拼、标题按字号猜、列表认开头的点和数字），字太少的页（扫描件）放整页图，
    // 再请 Agent 对照原 PDF 整理成像样的文档。初稿只是给 Agent 的底子，内容不增不减。
    const CJK = /[　-ヿ㐀-鿿＀-￯]/;
    async function markdownOf(state) {
        const stem = state.name.replace(/\.pdf$/i, '');
        const pages = [];
        const sizes = [];
        for (const entry of state.pages) {
            if (entry.blank) { pages.push({ entry, lines: [] }); continue; }
            const content = await proxyOf(state, entry).getTextContent();
            // 同一条基线上的字拼成一行；行和行的间距（上一行基线到这一行）用来分段。
            const lines = [];
            let line = null;
            for (const item of content.items) {
                if (typeof item.str !== 'string' || !item.str) continue;
                const size = Math.round(Math.hypot(item.transform[2], item.transform[3]) * 10) / 10 || item.height || 10;
                const y = item.transform[5];
                if (!line || Math.abs(y - line.y) > size * 0.6) {
                    if (line?.text.trim()) lines.push(line);
                    line = { text: '', size: 0, y };
                }
                line.text += item.str;
                if (item.str.trim()) { line.size = Math.max(line.size, size); sizes.push([size, item.str.length]); }
            }
            if (line?.text.trim()) lines.push(line);
            lines.forEach((item, k) => { item.gap = k ? Math.abs(lines[k - 1].y - item.y) : 0; });
            pages.push({ entry, lines });
        }
        // 正文字号：按字数最多的那个字号。
        const count = new Map();
        for (const [size, n] of sizes) count.set(size, (count.get(size) || 0) + n);
        const body = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
        const out = [`# ${stem}`, '', `> 从 \`${state.name}\` 抽出的初稿，等 Agent 对照原文整理。`];
        const images = [];
        for (const [k, page] of pages.entries()) {
            out.push('', `<!-- 第 ${k + 1} 页 -->`, '');
            const chars = page.lines.reduce((sum, item) => sum + item.text.trim().length, 0);
            if (!chars && !page.entry.blank) { // 一个字都抽不出：多半是扫描件，放整页图
                const name = `${stem}-第${k + 1}页.jpg`;
                images.push({ name, data: await rasterize(state, page.entry, []) });
                out.push(`![第 ${k + 1} 页](assets/${encodeURI(name).replace(/\(/g, '%28').replace(/\)/g, '%29')})`);
                continue;
            }
            let paragraph = '';
            const flush = () => { if (paragraph.trim()) out.push(paragraph.trim(), ''); paragraph = ''; };
            for (const item of page.lines) {
                const text = item.text.replace(/\s+/g, ' ').trim();
                const level = item.size >= body * 1.5 ? 2 : item.size >= body * 1.25 ? 3 : item.size >= body * 1.12 ? 4 : 0;
                if (level && text.length <= 80) { flush(); out.push(`${'#'.repeat(level)} ${text}`, ''); continue; }
                const bullet = /^[•·▪●◦\-–*]\s*/.exec(text);
                const numbered = /^(\d+|[一二三四五六七八九十]+)[.、)）]\s*/.test(text);
                if (bullet || numbered || item.gap > item.size * 1.7) flush();
                if (bullet) { out.push(`- ${text.slice(bullet[0].length)}`); continue; }
                if (!paragraph) paragraph = text;
                else if (paragraph.endsWith('-') && /[a-z]$/i.test(paragraph.slice(-2, -1))) paragraph = paragraph.slice(0, -1) + text;
                else paragraph += CJK.test(paragraph.slice(-1)) && CJK.test(text[0]) ? text : ` ${text}`;
            }
            flush();
        }
        return { text: `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`, images };
    }
    async function rebuildWithAgent() {
        if (!S) return null;
        const state = S;
        const draft = await markdownOf(state);
        let result;
        try {
            result = await api().pdf('draft', { defaultPath: state.filePath.replace(/\.pdf$/i, '.md'), text: draft.text, images: draft.images });
        } catch (error) {
            result = { success: false, error: error.message };
        }
        if (!result?.success) {
            if (!result?.canceled) UI.toast(`没存上初稿：${result?.error || ''}`, 'error', 5000);
            return result;
        }
        const scanned = draft.images.length;
        const ask = [
            `请对照原 PDF，把这份 Markdown 初稿重建成像样的文档，直接改这份 .md 存回去：`,
            `- 原文件：${state.filePath}`,
            `- 初稿：${result.filePath}（文坊里已经打开）`,
            `初稿是机器从 PDF 里抽的字：标题层级按字号猜的，表格、分栏、页眉页脚、页码都没处理${scanned ? `；有 ${scanned} 页抽不出字（多半是扫描件），只放了整页图（assets/ 里）` : ''}。`,
            '请：理顺标题层级，接上被分页断开的段落，去掉页眉页脚和页码，表格写成 Markdown 表格，图片留着引用；内容照原文，不增不减、不改写。',
        ].join('\n');
        await session()?.openPath?.(result.filePath);
        await window.scriptoriumAPI?.askAgent?.({ text: ask, docName: state.name, section: '重建' }).catch(() => null);
        UI.toast('初稿存好、打开了；给 Agent 的话放进了对话输入框，看一眼再发。', 'info', 5000);
        return result;
    }

    // ---------- 存 ----------
    // 换成 PDF 坐标：用这一页的视口（白页借一个视口的构造，盒子换成白页的大小）。
    async function converterOf(state, entry) {
        let viewport;
        if (entry.blank) {
            const sample = proxyOf(state, state.pages.find((page) => !page.blank) || { src: 'main', index: 0 })
                || await state.docs.main.getPage(1);
            const Viewport = sample.getViewport({ scale: 1 }).constructor;
            viewport = new Viewport({ viewBox: [0, 0, entry.blank.w, entry.blank.h], userUnit: 1, scale: 1, rotation: entry.rot, offsetX: 0, offsetY: 0, dontFlip: false });
        } else {
            viewport = proxyOf(state, entry).getViewport({ scale: 1, rotation: entry.rot });
        }
        return (x, y) => {
            const [px, py] = viewport.convertToPdfPoint(x, y);
            return { x: Math.round(px * 100) / 100, y: Math.round(py * 100) / 100 };
        };
    }
    // 没有中文字体时：中文字画成图片放进去。
    function textImage(item, text, size) {
        const scale = 4;
        const lines = String(text).split('\n');
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(item.w * scale);
        canvas.height = Math.ceil(Math.max(item.h, lines.length * size * LINE) * scale);
        const context = canvas.getContext('2d');
        context.font = `${size * scale}px ${FONT}`;
        context.fillStyle = css(item.color);
        context.textBaseline = 'alphabetic';
        lines.forEach((line, k) => context.fillText(line, 0, (BASE + k * LINE) * size * scale));
        return { data: canvas.toDataURL('image/png'), h: canvas.height / scale };
    }
    async function planOf(state, only = null) {
        const entries = only ? state.pages.filter((entry) => only.has(entry.id)) : state.pages;
        const plan = { pages: [], objects: [], sources: {}, fields: [] };
        for (const [n, entry] of entries.entries()) {
            const all = state.objects.filter((item) => item.page === entry.id);
            const redacts = all.filter((item) => item.type === 'redact');
            // 涂黑过的页：整页画成图片（涂黑的地方是黑的）换掉原页，原来的字、图都不在文件里了。这页上别的东西照常画在图上面。
            let flat = null;
            if (redacts.length) {
                const size = baseSize(state, entry);
                flat = { id: entry.id, blank: { w: size.w, h: size.h }, rot: 0 };
                plan.pages.push({ blank: flat.blank, rotate: 0, image: await rasterize(state, entry, redacts) });
            } else {
                plan.pages.push(entry.blank ? { blank: entry.blank, rotate: entry.rot } : { src: entry.src, index: entry.index, rotate: entry.rot });
                if (entry.src && entry.src !== 'main') plan.sources[entry.src] = state.sources[entry.src];
            }
            const items = all.filter((item) => item.type !== 'redact');
            if (!items.length) continue;
            const at = await converterOf(state, flat || entry);
            const rotate = flat ? 0 : entry.rot;
            const text = (item, x, top, words, size) => {
                if (!words) return;
                if (needsCjk(words) && !state.cjk) {
                    const picture = textImage({ ...item, x, y: top }, words, size);
                    plan.objects.push({ page: n, type: 'image', data: picture.data, ...at(x, top + picture.h), w: item.w, h: picture.h, rotate });
                    return;
                }
                plan.objects.push({ page: n, type: 'text', ...at(x, top + size * BASE), size, color: item.color, text: words, rotate });
            };
            for (const item of items) {
                if (item.type === 'text') {
                    text(item, item.x, item.y, item.text, item.size);
                } else if (item.type === 'cover') {
                    plan.objects.push({ page: n, type: 'rect', ...at(item.x, item.y + item.h), w: item.w, h: item.h, fill: item.fill, rotate });
                    text({ ...item, w: Math.max(1, item.w - PAD) }, item.x + PAD, item.y + coverTop(item), item.text, item.size);
                } else if (item.type === 'image') {
                    plan.objects.push({ page: n, type: 'image', data: item.data, ...at(item.x, item.y + item.h), w: item.w, h: item.h, rotate });
                } else if (item.type === 'rect') {
                    plan.objects.push({ page: n, type: 'rect', ...at(item.x, item.y + item.h), w: item.w, h: item.h, stroke: item.color, width: 1.5, rotate });
                } else if (item.type === 'mark') {
                    plan.objects.push({ page: n, type: 'rect', ...at(item.x, item.y + item.h), w: item.w, h: item.h, fill: item.color, opacity: 0.35, rotate });
                } else if (item.type === 'check' || item.type === 'cross') {
                    const width = Math.max(1.2, item.h * 0.12);
                    for (const line of item.type === 'check' ? CHECK : CROSS) {
                        for (let k = 1; k < line.length; k += 1) {
                            const a = at(item.x + line[k - 1][0] * item.w, item.y + line[k - 1][1] * item.h);
                            const b = at(item.x + line[k][0] * item.w, item.y + line[k][1] * item.h);
                            plan.objects.push({ page: n, type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: item.color, width });
                        }
                    }
                }
            }
        }
        for (const [name, value] of Object.entries(state.values)) {
            if (value !== state.original[name]) plan.fields.push({ name, value });
        }
        if (state.stamps.pageNumbers || state.stamps.watermark) plan.stamps = { ...state.stamps };
        return plan;
    }
    // 涂黑的页画成图片：2 倍（大约 144 dpi），涂黑的块画死在图上。
    async function rasterize(state, entry, redacts) {
        const scale = 2;
        const size = baseSize(state, entry);
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(size.w * scale);
        canvas.height = Math.ceil(size.h * scale);
        const context = canvas.getContext('2d');
        context.fillStyle = 'white';
        context.fillRect(0, 0, canvas.width, canvas.height);
        if (!entry.blank) {
            const proxy = proxyOf(state, entry);
            await proxy.render({ canvasContext: context, canvas, viewport: proxy.getViewport({ scale, rotation: entry.rot }) }).promise;
        }
        context.fillStyle = 'black';
        for (const item of redacts) context.fillRect(item.x * scale, item.y * scale, item.w * scale, item.h * scale);
        return canvas.toDataURL('image/jpeg', 0.92);
    }
    async function save({ saveAs = false, force = false } = {}) {
        if (!S) return false;
        finishEditing(true);
        if (!saveAs && !dirty() && !force) return true;
        const state = S;
        state.saving = true;
        UI.sync?.();
        let result;
        try {
            result = await api().pdf('save', { path: state.filePath, plan: await planOf(state), fingerprint: state.fingerprint, saveAs, force });
        } catch (error) {
            result = { success: false, error: error.message };
        }
        state.saving = false;
        if (result?.conflict) {
            if (S === state) showConflict();
            UI.sync?.();
            return false;
        }
        if (!result?.success) {
            if (!result?.canceled) UI.toast(`没存上：${result?.error || '写不进去'}`, 'error', 6000);
            UI.sync?.();
            return false;
        }
        if (saveAs) {
            // 另存为：原文件不动，接着在新文件上改（改动已经写在新文件里了）。
            state.savedId = state.stateId;
            if (S === state) {
                drafts.delete(norm(result.filePath));
                await session()?.openPath?.(result.filePath);
            }
            UI.toast(`另存好了：${result.filePath.split(/[\\/]/).pop()}`);
            return true;
        }
        UI.toast(state.saved ? '已存。' : '已存。存之前的原样在 AppData 里留了一份。');
        state.saved = true;
        if (S !== state) return true;
        // 放上去的东西已经写进文件：重新读一遍，在新的文件上接着改（撤销记录清掉）。
        await reload({ discard: true, quiet: true });
        return true;
    }
    async function reload({ discard = false, quiet = false } = {}) {
        if (!S) return;
        if (dirty() && !discard) return;
        const state = S;
        const result = await read(state.filePath);
        if (S !== state) return;
        if (!result?.success) {
            if (!quiet) UI.toast(`没重新读到：${result?.error || ''}`, 'error', 5000);
            return;
        }
        let next;
        try {
            next = await build(result);
        } catch (error) {
            UI.toast(passwordProblem(error) || `pdf.js 没读懂这份 PDF：${error.message}`, 'error', 6000);
            return;
        }
        if (S !== state) { destroy(next); return; }
        next.saved = state.saved;
        next.scroll = scroller.scrollTop;
        next.zoom = zoom;
        destroy(state);
        S = next;
        enter();
    }
    function showConflict() {
        conflict.hidden = false;
    }
    // 外面改了（Agent 改的、别的程序存的）：没改动就重新读，有改动就问。切回窗口时、开着时每 2.5 秒看一眼。
    async function checkDisk() {
        if (!S || S.saving || document.visibilityState === 'hidden') return;
        const state = S;
        let stat;
        try {
            stat = await api().pdf('stat', { path: state.filePath });
        } catch (_) {
            return;
        }
        if (S !== state || state.saving || !stat || stat.missing) return;
        if (Math.abs(stat.mtime - state.mtime) <= 1 && stat.size === state.size) return;
        if (dirty()) showConflict();
        else await reload({ quiet: true });
    }
    setInterval(() => void checkDisk(), 2500);
    UI.on('disk-check', () => void checkDisk());

    // ---------- 查找 ----------
    const texts = new Map(); // 页的 id → 这页的文字（小写）
    let found = { q: '', hits: [], at: -1 };
    async function pageText(entry) {
        if (entry.blank) return '';
        if (texts.has(entry.id)) return texts.get(entry.id);
        const content = await proxyOf(S, entry).getTextContent();
        const value = content.items.map((item) => item.str || '').join('').toLowerCase();
        texts.set(entry.id, value);
        return value;
    }
    async function runFind(step = 1) {
        if (!S) return;
        const q = findInput.value.trim().toLowerCase();
        if (!q) {
            found = { q: '', hits: [], at: -1 };
            setText(findCount, '');
            for (const entry of S.pages) markFound(entry.id);
            return;
        }
        if (q !== found.q) {
            const hits = [];
            for (const entry of S.pages) {
                const value = await pageText(entry);
                let index = value.indexOf(q);
                let k = 0;
                while (index >= 0) {
                    hits.push({ page: entry.id, k });
                    k += 1;
                    index = value.indexOf(q, index + q.length);
                }
            }
            found = { q, hits, at: -1 };
        }
        if (!found.hits.length) {
            setText(findCount, '没找到');
            for (const entry of S.pages) markFound(entry.id);
            return;
        }
        found.at = (found.at + step + found.hits.length) % found.hits.length;
        setText(findCount, `${found.at + 1} / ${found.hits.length}`);
        const hit = found.hits[found.at];
        scrollToPage(hit.page);
        for (const entry of S.pages) markFound(entry.id);
    }
    // 在文字层上标出这页里含查找词的那几段，当前这一处滚到中间。
    function markFound(pageId) {
        const el = elements.get(pageId);
        if (!el) return;
        const spans = [...el.text.querySelectorAll('span:not(.markedContent)')];
        let count = 0;
        const hit = found.hits[found.at];
        for (const span of spans) {
            const has = Boolean(found.q) && span.textContent.toLowerCase().includes(found.q);
            span.classList.toggle('uttu-pdf-hit', has);
            const here = has && hit?.page === pageId && count === hit.k;
            span.classList.toggle('here', here);
            if (here) {
                const top = el.root.offsetTop + span.offsetTop;
                scroller.scrollTop = top - scroller.clientHeight / 2;
            }
            if (has) count += 1;
        }
    }
    findInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            void runFind(event.shiftKey ? -1 : 1);
        } else if (event.key === 'Escape') {
            findInput.value = '';
            void runFind();
            findInput.blur();
        }
        event.stopPropagation();
    });
    findInput.addEventListener('input', () => { if (!findInput.value) void runFind(); });

    // ---------- 快捷键：开着 PDF 时上游的 Ctrl S / Z / Y / F 不能落到藏在后面的文稿上 ----------
    const typing = (target) => Boolean(target?.closest?.('input, textarea, select, [contenteditable="plaintext-only"], [contenteditable="true"]'));
    window.addEventListener('keydown', (event) => {
        if (!S || work.hidden) return;
        if (document.querySelector('.uttu-dlg-scrim:not([hidden])')) return;
        const key = event.key.toLowerCase();
        const mod = (event.ctrlKey || event.metaKey) && !event.altKey;
        const stop = () => { event.preventDefault(); event.stopImmediatePropagation(); };
        if (mod && key === 's') { stop(); void save({ saveAs: event.shiftKey }); return; }
        if (mod && key === 'f') { stop(); findInput.focus(); findInput.select(); return; }
        if (mod && (key === '=' || key === '+')) { stop(); setZoom(zoom + 0.1); return; }
        if (mod && key === '-') { stop(); setZoom(zoom - 0.1); return; }
        if (mod && key === '0') { stop(); fitWidth(); return; }
        if (typing(event.target)) return;
        if (mod && key === 'z') { stop(); if (event.shiftKey) redo(); else undo(); return; }
        if (mod && key === 'y') { stop(); redo(); return; }
        if (key === 'escape' && (tool !== 'select' || selected)) { stop(); setTool('select'); select(null); return; }
        if ((key === 'delete' || key === 'backspace') && selected) { stop(); removeObject(selected); return; }
        if (selected && key.startsWith('arrow')) {
            stop();
            const item = findObject(selected);
            const d = event.shiftKey ? 10 : 1;
            const [dx, dy] = { arrowleft: [-d, 0], arrowright: [d, 0], arrowup: [0, -d], arrowdown: [0, d] }[key];
            commit(() => { item.x += dx; item.y += dy; clampTo(entryOf(item.page), item); });
            return;
        }
        if (key === 'enter' && selected) { stop(); startEditing(selected); }
    }, true);
    // 在放上去的字里：Esc 打完，Enter 换行（不往上传）。
    pagesHost.addEventListener('keydown', (event) => {
        if (!editing) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            finishEditing(true);
        }
        event.stopPropagation();
    });

    // ---------- 跟着文坊走 ----------
    UI.on('start', () => {
        session()?.subscribe?.((event) => {
            if (S && event?.type === 'document-replaced' && !UI.replacedByLastOpen()) setTimeout(leave, 0);
        });
    });

    function fileItems({ openNewDialog, open: openFile, importFile }) {
        const has = Boolean(S);
        return [
            { label: '新建', k: 'Ctrl N', act: openNewDialog },
            { label: '打开文件', k: 'Ctrl O', act: openFile },
            { label: '打开文件夹', act: () => window.UTTUScriptoriumFolder?.choose?.() },
            { label: '导入', act: importFile },
            { label: '保存', k: 'Ctrl S', disabled: !has || !dirty(), act: () => void save() },
            { label: '另存为', k: 'Ctrl ⇧ S', disabled: !has, act: () => void save({ saveAs: true }) },
            { label: '重新载入', k: 'F5', hint: dirty() ? '放弃没存的修改' : '', disabled: !has,
                act: () => {
                    const shared = window.UTTUScriptoriumMarkdown?.reloadFromDisk; // 有改动先问（和 .md 同一条）
                    if (shared) shared(); else void reload({ discard: true });
                } },
            { label: '在文件夹里显示', disabled: !has, act: () => void api()?.files?.('reveal', { path: S?.filePath }).catch((error) => UI.toast(error.message, 'error')) },
            { label: '关闭', disabled: !has, act: () => void close() },
            { sep: true },
            { label: '签名', disabled: !has, act: () => void openSignature() },
            { label: '导出选中的页', disabled: !has, act: () => void exportPages() },
            { label: '拆成几份', disabled: !has, act: () => void splitDialog() },
            { label: '交给 Agent 重建成 Markdown', hint: '不用转 Word', disabled: !has, act: () => void rebuildWithAgent() },
        ];
    }

    const view = Object.freeze({
        claims: isPdf,
        open,
        route,
        leave,
        close,
        forget,
        save: () => save(),
        reload: () => reload({ discard: true }),
        fileItems,
        outline: () => renderLeft(), // 左栏“篇章”这时是页面缩略图（uttu-scriptorium-panels.js renderOutline 先问这里）
        active: () => Boolean(S),
        // 给 Agent（uttu-scriptorium-agent.js）：抽出来的文字（和“交给 Agent 重建”同一份）、截图范围。
        agent: Object.freeze({ text: async () => (await markdownOf(S)).text, surface: () => scroller }),
        doc: () => (S ? Object.freeze({ kind: 'pdf', filePath: S.filePath, name: S.name, generation: S.generation,
            dirty: dirty(), saving: S.saving, revision: 0, manualSave: true }) : null),
        // 冒烟用（scripts/smoke-scriptorium-pdf.cjs）
        _state: () => (S ? { filePath: S.filePath, pages: S.pages.map((entry) => ({ ...entry })), objects: S.objects.map((item) => ({ ...item })),
            values: { ...S.values }, dirty: dirty(), zoom, tool, selected, cjk: S.cjk, history: S.history.length } : null),
        _plan: () => (S ? planOf(S) : null),
        _do: { setTool, add: (item) => add({ ...item }), select, startEditing, finishEditing, undo, redo, rotatePages, removePages, movePages,
            addBlank, duplicatePage, setZoom, fitWidth, placeImage, exportPages, mergeFiles, splitBy, setStamps, markdownOf, rebuildWithAgent, setLeftList, pick: (ids) => { pickedPages.clear(); ids.forEach((id) => pickedPages.add(id)); renderThumbs(); },
            setField, runFind: (q) => { findInput.value = q; return runFind(); }, save: (options) => save(options), checkDisk },
    });
    window.UTTUScriptoriumPdf = view;
    UI.registerOverlay?.(view);
})();
