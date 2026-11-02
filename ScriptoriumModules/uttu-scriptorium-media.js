// 文坊里放音频和视频。和图片一样点文件树就在中间放，← → 不抢，切同一文件夹的用栏头的按钮。
// 浏览器解不了的编码（比如 mkv 里的 HEVC）写一句，给“用默认程序打开”。只看不改。主进程 modules/uttu/viewFiles 先核对文件能不能开。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    const Types = window.UTTUScriptoriumTypes;
    if (!UI?.on || !Types) return;
    const { make, button, setText } = UI;
    const api = () => window.scriptoriumAPI;
    const session = () => window.UTTUScriptoriumSession;
    const isMedia = (file) => Types.kindOf(file) === 'media';
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const welcomeShown = () => document.getElementById('welcome-state')?.hidden === false;
    const fileUrl = (file, mtime) => `file:///${String(file).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([a-zA-Z])%3A/, '$1:')}?t=${Math.round(mtime)}`;
    const sizeText = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

    let item = null; // { filePath, name, size, mtime, siblings, generation }
    let generation = 0;

    const work = make('div', 'uttu-media-work');
    work.hidden = true;
    work.setAttribute('aria-label', '音视频');
    const head = make('div', 'uttu-pane-head');
    const label = make('span', 'uttu-pane-label', '音视频<small></small>');
    const place = make('span', 'uttu-image-place');
    const prev = button('uttu-tb', '上一个', '‹', () => step(-1));
    const next = button('uttu-tb', '下一个', '›', () => step(1));
    const openDefault = button('uttu-btn ghost small', '', '用默认程序打开', () => void openWithDefault());
    head.append(label, make('span', 'grow'), prev, place, next, openDefault);
    const stage = make('div', 'uttu-media-stage');
    const player = make('video');
    player.controls = true;
    player.preload = 'metadata';
    const failed = make('p', 'uttu-left-note uttu-media-failed');
    failed.hidden = true;
    stage.append(player, failed);
    work.append(head, stage);
    const workspace = document.getElementById('document-workspace');
    (workspace?.parentElement || document.body).append(work);

    function paintInfo() {
        if (!item) return;
        const time = Number.isFinite(player.duration) ? `${Math.floor(player.duration / 60)}:${String(Math.floor(player.duration % 60)).padStart(2, '0')}` : '';
        const size = player.videoWidth ? `${player.videoWidth} × ${player.videoHeight}` : '';
        setText(label.querySelector('small'), [size, time, sizeText(item.size)].filter(Boolean).join(' · '));
        const count = item.siblings.length;
        setText(place, count > 1 ? `${item.siblings.findIndex((other) => same(other, item.filePath)) + 1} / ${count}` : '');
        prev.hidden = next.hidden = place.hidden = count < 2;
    }
    player.addEventListener('loadedmetadata', () => {
        work.classList.toggle('audio', !player.videoWidth);
        paintInfo();
    });
    player.addEventListener('error', () => {
        if (!item) return;
        failed.hidden = false;
        player.hidden = true;
        setText(failed, '这个文件的编码放不了。用栏头的“用默认程序打开”。');
    });
    function step(direction) {
        if (!item) return;
        const list = item.siblings;
        const index = list.findIndex((other) => same(other, item.filePath));
        const target = list[(index + direction + list.length) % list.length];
        if (target && !same(target, item.filePath)) void session()?.openPath?.(target);
    }
    async function info(file) {
        try {
            return await api().view('media', { file });
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    function stop() {
        player.pause();
        player.removeAttribute('src');
        player.load();
    }
    function show(result) {
        item = { filePath: result.filePath, name: result.name, size: result.size, mtime: result.mtime, siblings: result.siblings, generation: ++generation };
        document.body.classList.add('uttu-media-mode');
        work.hidden = false;
        failed.hidden = true;
        player.hidden = false;
        player.src = fileUrl(result.filePath, result.mtime);
        paintInfo();
        UI.syncTitle?.();
        UI.sync?.();
    }
    async function open(file) {
        if (!isMedia(file)) return false;
        if (item && same(item.filePath, file)) return true;
        const result = await info(file);
        if (!result?.success) {
            UI.toast(`没打开这个文件：${result?.error || '读不到'}`, 'error', 5000);
            return false;
        }
        await saveBehind();
        show(result);
        return true;
    }
    function leave() {
        if (!item) return;
        item = null;
        document.body.classList.remove('uttu-media-mode');
        work.hidden = true;
        stop();
        UI.syncTitle?.();
        UI.sync?.();
    }
    function route(file) {
        if (isMedia(file)) return open(file);
        if (!item) return null;
        const behind = session()?.current?.();
        leave();
        const stale = /\.(md|markdown)$/i.test(String(file)) && !behind?.dirty;
        if (behind && !welcomeShown() && same(behind.filePath, file) && !stale) return Promise.resolve(true);
        return null;
    }
    async function saveBehind() {
        if (item || welcomeShown() || !UI.autosaveOn?.()) return;
        const behind = session()?.current?.();
        if (!behind?.filePath || !behind.dirty) return;
        document.getElementById('save-btn')?.click();
        const started = Date.now();
        while (Date.now() - started < 4000 && session()?.current?.()?.dirty) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    function close() {
        if (!item) return;
        leave();
        if (session()?.current?.() && !welcomeShown()) document.getElementById('home-btn')?.click();
    }
    async function reload() {
        if (!item) return;
        const result = await info(item.filePath);
        if (item && result?.success) show(result);
    }
    async function openWithDefault() {
        if (!item) return;
        try {
            await api().files('open-default', { path: item.filePath });
        } catch (error) {
            UI.toast(error.message, 'error', 5000);
        }
    }

    function fileItems({ openNewDialog, open: openFile }) {
        const has = Boolean(item);
        return [
            { label: '新建', k: 'Ctrl N', act: openNewDialog },
            { label: '打开文件', k: 'Ctrl O', act: openFile },
            { label: '打开文件夹', act: () => window.UTTUScriptoriumFolder?.choose?.() },
            { sep: true },
            { label: '重新载入', k: 'F5', disabled: !has, act: () => void reload() },
            { label: '用默认程序打开', disabled: !has, act: () => void openWithDefault() },
            { label: '在文件夹里显示', disabled: !has, act: () => void api()?.files?.('reveal', { path: item?.filePath }).catch(() => {}) },
            { label: '关闭', disabled: !has, act: () => close() },
        ];
    }

    const view = Object.freeze({
        claims: isMedia,
        open,
        route,
        leave,
        close,
        forget: () => {},
        save: async () => true, // 只看不改
        reload,
        fileItems,
        active: () => Boolean(item),
        agent: Object.freeze({
            text: () => (item ? `音视频 ${item.name}，${Number.isFinite(player.duration) ? `${Math.round(player.duration)} 秒，` : ''}${sizeText(item.size)}` : ''),
            surface: () => stage,
        }),
        doc: () => (item ? Object.freeze({ kind: 'media', filePath: item.filePath, name: item.name, generation: item.generation,
            dirty: false, saving: false, revision: 0, readOnly: true }) : null),
        _state: () => ({ item: item && { ...item }, failed: !failed.hidden, src: player.getAttribute('src') }),
    });
    window.UTTUScriptoriumMedia = view;
    UI.registerOverlay?.(view);
})();
