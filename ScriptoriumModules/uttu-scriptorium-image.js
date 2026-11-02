// 文坊里看图片。
// 点文件树里的图片就在中间显示，默认适合窗口；← → 切同一文件夹的上一张、下一张，走 openPath，和标签、历史都一致。
// 不做裁剪、调色这类编辑。主进程 modules/uttu/viewFiles 先核对文件能不能开。页面 CSP 允许 file: 图片，<img> 直接读。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    const Types = window.UTTUScriptoriumTypes;
    if (!UI?.on || !Types) return;
    const { make, button, icon, setText } = UI;
    const api = () => window.scriptoriumAPI;
    const session = () => window.UTTUScriptoriumSession;
    const isImage = (file) => Types.kindOf(file) === 'image';
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const welcomeShown = () => document.getElementById('welcome-state')?.hidden === false;
    const fileUrl = (file, mtime) => `file:///${String(file).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([a-zA-Z])%3A/, '$1:')}?t=${Math.round(mtime)}`;

    const ZOOMS = [25, 50, 75, 100, 150, 200, 300, 400];
    let image = null; // { filePath, name, size, mtime, siblings, generation }
    let generation = 0;
    let zoom = 0; // 0 是适合窗口
    const Pick = window.UTTUScriptoriumPick;

    const work = make('div', 'uttu-image-work');
    work.hidden = true;
    work.setAttribute('aria-label', '图片');
    const head = make('div', 'uttu-pane-head');
    const label = make('span', 'uttu-pane-label', '图片<small></small>');
    const place = make('span', 'uttu-image-place');
    const prev = button('uttu-tb', '上一张', '‹', () => step(-1));
    const next = button('uttu-tb', '下一张', '›', () => step(1));
    const zoomOut = button('uttu-tb', '缩小', icon('i-minus'), () => stepZoom(-1));
    const zoomValue = button('uttu-tb-drop plain', '', '适合', () => setZoom(0));
    const zoomIn = button('uttu-tb', '放大', icon('i-plus'), () => stepZoom(1));
    const pickTool = Pick.toolSeg('浏览', (mode) => layer.classList.toggle('on', mode === 'pick'));
    head.append(label, pickTool, make('span', 'grow'), prev, place, next, zoomOut, zoomValue, zoomIn);
    const scroller = make('div', 'uttu-image-scroll');
    const stage = make('div', 'uttu-image-stage');
    const picture = make('img');
    picture.alt = '';
    picture.draggable = false;
    const layer = make('div', 'uttu-pick-layer');
    stage.append(picture, layer);
    scroller.append(stage);
    work.append(head, scroller);
    const workspace = document.getElementById('document-workspace');
    (workspace?.parentElement || document.body).append(work);
    document.getElementById('outline-panel')?.append(make('p', 'uttu-left-note uttu-left-view-note', '这种文件没有目录。'));

    const sizeText = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
    function paintInfo() {
        if (!image) return;
        const dims = picture.naturalWidth ? `${picture.naturalWidth} × ${picture.naturalHeight} · ` : '';
        setText(label.querySelector('small'), `${dims}${sizeText(image.size)}`);
        const count = image.siblings.length;
        const index = image.siblings.findIndex((item) => same(item, image.filePath));
        setText(place, count > 1 ? `${index + 1} / ${count}` : '');
        prev.hidden = next.hidden = place.hidden = count < 2;
    }
    // 适合窗口也按算出来的宽度画，批注的色块才能和图对齐。
    function applyZoom() {
        setText(zoomValue, zoom ? `${zoom}%` : '适合');
        scroller.classList.toggle('fit', !zoom);
        if (!picture.naturalWidth) return;
        const style = getComputedStyle(scroller);
        const spaceX = scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const spaceY = scroller.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        const scale = zoom ? zoom / 100 : Math.min(1, spaceX / picture.naturalWidth, spaceY / picture.naturalHeight);
        picture.style.width = `${Math.max(1, Math.round(picture.naturalWidth * scale))}px`;
    }
    if (window.ResizeObserver) new ResizeObserver(() => { if (image && !zoom) applyZoom(); }).observe(scroller);

    // ---------- 批注：拖出一块，位置按原图像素记 ----------
    layer.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        Pick.dragRegion(layer, event, (rect) => {
            const scale = picture.naturalWidth / picture.clientWidth;
            const part = { x: Math.round(rect.x * scale), y: Math.round(rect.y * scale), width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) };
            const size = { width: picture.naturalWidth, height: picture.naturalHeight };
            const target = { type: 'region', label: `区域 ${part.width} × ${part.height}`, text: '',
                place: `x ${part.x}，y ${part.y}，宽 ${part.width}，高 ${part.height}（原图 ${size.width} × ${size.height}）`,
                locator: { type: 'region', rect: part, size }, capture: Pick.windowRect(layer, rect) };
            const box = Pick.windowRect(layer, rect);
            Pick.offer(target, { left: box.x, top: box.y, bottom: box.y + box.height });
        });
    });
    // 右键引用整张图；要指其中一块，切到批注拖一下。
    scroller.addEventListener('contextmenu', (event) => {
        if (!image) return;
        event.preventDefault();
        const box = stage.getBoundingClientRect();
        const area = scroller.getBoundingClientRect();
        const left = Math.max(box.left, area.left);
        const top = Math.max(box.top, area.top);
        Pick.menu({ type: 'region', label: '这张图片', place: `整张图（${picture.naturalWidth} × ${picture.naturalHeight}）`, text: '',
            locator: { type: 'region', rect: { x: 0, y: 0, width: picture.naturalWidth, height: picture.naturalHeight }, size: { width: picture.naturalWidth, height: picture.naturalHeight } },
            capture: { x: left, y: top, width: Math.min(box.right, area.right) - left, height: Math.min(box.bottom, area.bottom) - top } }, { x: event.clientX, y: event.clientY });
    });
    Pick.register('image', { paint(list) {
        layer.replaceChildren(...list.filter((item) => item.state !== 'done' && item.locator?.size).map((item, index) => {
            const { rect, size } = item.locator;
            const near = rect.y / size.height * picture.clientHeight < 18;
            const mark = make('div', `uttu-pick-mark region${near ? ' at-top' : ''}`, `<span class="uttu-pick-num">${index + 1}</span>`);
            Object.assign(mark.style, { left: `${rect.x / size.width * 100}%`, top: `${rect.y / size.height * 100}%`,
                width: `${rect.width / size.width * 100}%`, height: `${rect.height / size.height * 100}%` });
            return mark;
        }));
    } });
    function setZoom(value) {
        zoom = value;
        applyZoom();
    }
    function stepZoom(direction) {
        const shown = zoom || Math.round((picture.clientWidth / (picture.naturalWidth || 1)) * 100);
        const options = direction > 0 ? ZOOMS.filter((value) => value > shown) : ZOOMS.filter((value) => value < shown).reverse();
        if (options.length) setZoom(options[0]);
    }
    picture.addEventListener('load', () => {
        paintInfo();
        applyZoom();
    });
    picture.addEventListener('error', () => { if (image) UI.toast('这张图片显示不出来。', 'error', 4000); });

    function step(direction) {
        if (!image) return;
        const list = image.siblings;
        const index = list.findIndex((item) => same(item, image.filePath));
        const target = list[(index + direction + list.length) % list.length];
        if (target && !same(target, image.filePath)) void session()?.openPath?.(target);
    }
    async function info(file) {
        try {
            return await api().view('image', { file });
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    function show(result) {
        image = { filePath: result.filePath, name: result.name, size: result.size, mtime: result.mtime, siblings: result.siblings, generation: ++generation };
        document.body.classList.add('uttu-image-mode');
        work.hidden = false;
        picture.src = fileUrl(result.filePath, result.mtime);
        paintInfo();
        UI.syncTitle?.();
        UI.sync?.();
    }
    async function open(file) {
        if (!isImage(file)) return false;
        if (image && same(image.filePath, file)) return true;
        const result = await info(file);
        if (!result?.success) {
            UI.toast(`没打开这张图片：${result?.error || '读不到'}`, 'error', 5000);
            return false;
        }
        await saveBehind();
        show(result);
        void api().view('watch', { file: result.filePath }).catch(() => {});
        return true;
    }
    function leave() {
        if (!image) return;
        image = null;
        document.body.classList.remove('uttu-image-mode');
        work.hidden = true;
        pickTool.setMode('browse');
        layer.replaceChildren();
        picture.removeAttribute('src');
        void api()?.view?.('watch', { file: null }).catch(() => {});
        UI.syncTitle?.();
        UI.sync?.();
    }
    function route(file) {
        if (isImage(file)) return open(file);
        if (!image) return null;
        const behind = session()?.current?.();
        leave();
        const stale = /\.(md|markdown)$/i.test(String(file)) && !behind?.dirty;
        if (behind && !welcomeShown() && same(behind.filePath, file) && !stale) return Promise.resolve(true);
        return null;
    }
    async function saveBehind() {
        if (image || welcomeShown() || !UI.autosaveOn?.()) return;
        const behind = session()?.current?.();
        if (!behind?.filePath || !behind.dirty) return;
        document.getElementById('save-btn')?.click();
        const started = Date.now();
        while (Date.now() - started < 4000 && session()?.current?.()?.dirty) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    function close() {
        if (!image) return;
        leave();
        if (session()?.current?.() && !welcomeShown()) document.getElementById('home-btn')?.click();
    }
    async function reload() {
        if (!image) return;
        const result = await info(image.filePath);
        if (image && result?.success) show(result);
    }
    api()?.onViewChanged?.((payload) => {
        if (image && same(payload?.file, image.filePath)) void reload();
    });

    window.addEventListener('keydown', (event) => {
        if (!image || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        if (event.target?.closest?.('input, textarea, [contenteditable="true"], .CodeMirror')) return;
        if (event.key === 'ArrowLeft') step(-1);
        else if (event.key === 'ArrowRight') step(1);
    });

    function fileItems({ openNewDialog, open: openFile }) {
        const has = Boolean(image);
        return [
            { label: '新建', k: 'Ctrl N', act: openNewDialog },
            { label: '打开文件', k: 'Ctrl O', act: openFile },
            { label: '打开文件夹', act: () => window.UTTUScriptoriumFolder?.choose?.() },
            { sep: true },
            { label: '重新载入', k: 'F5', disabled: !has, act: () => void reload() },
            { label: '用默认程序打开', disabled: !has, act: () => void api()?.files?.('open-default', { path: image?.filePath }).catch((error) => UI.toast(error.message, 'error', 5000)) },
            { label: '在文件夹里显示', disabled: !has, act: () => void api()?.files?.('reveal', { path: image?.filePath }).catch(() => {}) },
            { label: '关闭', disabled: !has, act: () => close() },
        ];
    }

    const view = Object.freeze({
        claims: isImage,
        open,
        route,
        leave,
        close,
        forget: () => {},
        save: async () => true, // 只看不改
        reload,
        fileItems,
        active: () => Boolean(image),
        agent: Object.freeze({
            text: () => (image ? `图片 ${image.name}，${picture.naturalWidth} × ${picture.naturalHeight}，${sizeText(image.size)}` : ''),
            surface: () => scroller,
        }),
        doc: () => (image ? Object.freeze({ kind: 'image', filePath: image.filePath, name: image.name, generation: image.generation,
            dirty: false, saving: false, revision: 0, readOnly: true }) : null),
        _state: () => ({ image: image && { ...image }, zoom, natural: [picture.naturalWidth, picture.naturalHeight], src: picture.getAttribute('src') }),
    });
    window.UTTUScriptoriumImage = view;
    UI.registerOverlay?.(view);
})();
