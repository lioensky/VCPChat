// 文坊中的图片（主进程 modules/scriptorium/viewFiles 先核对文件是否允许打开）。
// 图片显示在文档区域的位置上，默认适合窗口；← → 切换同一文件夹中的上一张、下一张（经 openPath 打开）。
// 不提供裁剪、调色等编辑。页面的 CSP 允许 file: 图片，<img> 直接读取。
(() => {
    'use strict';
    const UI = window.ScriptoriumFileViews;
    const Types = window.ScriptoriumFileTypes;
    if (!UI?.on || !Types) return;
    const { make, button, icon, setText } = UI;
    const api = () => window.scriptoriumAPI;
    const session = () => window.ScriptoriumFileSession;
    const isImage = (file) => Types.kindOf(file) === 'image';
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const welcomeShown = () => document.getElementById('welcome-state')?.hidden === false;
    const fileUrl = (file, mtime) => `file:///${String(file).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([a-zA-Z])%3A/, '$1:')}?t=${Math.round(mtime)}`;

    const ZOOMS = [25, 50, 75, 100, 150, 200, 300, 400];
    let image = null; // { filePath, name, size, mtime, siblings, generation }
    let generation = 0;
    let zoom = 0; // 0 表示适合窗口

    const work = make('div', 'scriptorium-image-work');
    work.hidden = true;
    work.setAttribute('aria-label', '图片');
    const head = make('div', 'scriptorium-pane-head');
    const label = make('span', 'scriptorium-pane-label', '图片<small></small>');
    const place = make('span', 'scriptorium-image-place');
    const prev = button('scriptorium-file-button icon', '上一张', '‹', () => step(-1));
    const next = button('scriptorium-file-button icon', '下一张', '›', () => step(1));
    const zoomOut = button('scriptorium-file-button icon', '缩小', icon('i-minus'), () => stepZoom(-1));
    const zoomValue = button('scriptorium-file-button', '适合窗口', '适合', () => setZoom(0));
    const zoomIn = button('scriptorium-file-button icon', '放大', icon('i-plus'), () => stepZoom(1));
    head.append(label, make('span', 'grow'), prev, place, next, zoomOut, zoomValue, zoomIn);
    const scroller = make('div', 'scriptorium-image-scroll');
    const stage = make('div', 'scriptorium-image-stage');
    const picture = make('img');
    picture.alt = '';
    picture.draggable = false;
    stage.append(picture);
    scroller.append(stage);
    work.append(head, scroller);
    const workspace = document.getElementById('document-workspace');
    (workspace?.parentElement || document.body).append(work);

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
    picture.addEventListener('error', () => { if (image) UI.toast('这张图片无法显示。', 'error', 4000); });

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
        document.body.classList.add('scriptorium-image-mode');
        work.hidden = false;
        picture.src = fileUrl(result.filePath, result.mtime);
        paintInfo();
        UI.sync?.();
    }
    async function open(file) {
        if (!isImage(file)) return false;
        if (image && same(image.filePath, file)) return true;
        const result = await info(file);
        if (!result?.success) {
            UI.toast(`未能打开这张图片：${result?.error || '读取失败'}`, 'error', 5000);
            return false;
        }
        show(result);
        void api().view('watch', { file: result.filePath }).catch(() => {});
        return true;
    }
    function leave() {
        if (!image) return;
        image = null;
        document.body.classList.remove('scriptorium-image-mode');
        work.hidden = true;
        picture.removeAttribute('src');
        void api()?.view?.('watch', { file: null }).catch(() => {});
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

    const view = Object.freeze({
        claims: isImage,
        open,
        route,
        leave,
        save: async () => true, // 只查看，不修改
        reload,
        active: () => Boolean(image),
        agent: Object.freeze({
            text: () => (image ? `图片 ${image.name}，${picture.naturalWidth} × ${picture.naturalHeight}，${sizeText(image.size)}` : ''),
            surface: () => scroller,
        }),
        doc: () => (image ? Object.freeze({ kind: 'image', filePath: image.filePath, name: image.name, generation: image.generation,
            dirty: false, saving: false, revision: 0, readOnly: true }) : null),
        _state: () => ({ image: image && { ...image }, zoom, natural: [picture.naturalWidth, picture.naturalHeight], src: picture.getAttribute('src') }),
    });
    window.ScriptoriumImageView = view;
    UI.registerOverlay?.(view);
})();
