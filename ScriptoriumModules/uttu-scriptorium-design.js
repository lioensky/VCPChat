// 设计画布。.design 就地打开：一块能平移缩放的画布，上面摆几份网页。
// 每个画框是磁盘上的一份 HTML（webPages/design.js），在沙盒框里照常运行；文件变了那一框自己刷新，所以 Agent 直接改文件就行。这里只管摆放，摆放存回 .design。
// 看不见的框不载入，已载入的最多留 MAX_LOADED 个。双击画框用网页视图打开，改字、改色在那里（uttu-scriptorium-page-edit.js）。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;
    const { make, button, icon, setText } = UI;
    const api = () => window.scriptoriumAPI;
    const session = () => window.UTTUScriptoriumSession;
    const Types = window.UTTUScriptoriumTypes;
    const Pick = window.UTTUScriptoriumPick;
    const isDesign = (path) => Types.kindOf(path) === 'design';
    const norm = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const welcomeShown = () => document.getElementById('welcome-state')?.hidden === false;
    const FRAME_NAME = 'uttu-page-frame'; // 主进程凭这个认出网页框，往外跳时拦下（webPages/index.js guardFrames）
    const MAX_LOADED = 12;
    const POLL_MS = 2000;
    const GAP = 80;
    const MIN_SIZE = 120;
    const SIZES = [['桌面', 1440, 900], ['笔记本', 1280, 800], ['平板', 834, 1112], ['手机', 390, 844]];

    let file = null; // { filePath, name, mtime, generation, saving }
    let data = null; // 解析后的 .design
    let dirty = false;
    let loading = false;
    let generation = 0;
    let view = { x: 40, y: 40, k: 1 };
    let selected = new Set(); // data.frames 里的对象
    let history = [];
    let historyAt = 0;
    let press = null;
    let lastPressed = null; // 按住时指针捕获在画布上，双击事件的目标不是画框，所以记下按的是哪一框
    let spaceDown = false;
    let autosaveTimer = 0;
    let pollTimer = 0;
    let round = 0;
    const nodes = new Map(); // frame.file → { root, body, label, frame, url, mtime, seen, used }
    const drafts = new Map(); // 切走时没存的摆放：路径 → { text, mtime }

    // ---------- 搭结构 ----------
    const work = make('div', 'uttu-design-work');
    work.hidden = true;
    work.setAttribute('aria-label', '设计画布');
    const head = make('div', 'uttu-pane-head');
    const label = make('span', 'uttu-pane-label', '设计<small></small>');
    const conflict = make('span', 'uttu-page-conflict');
    conflict.hidden = true;
    conflict.append(make('span', '', '文件在别处改过了'),
        button('uttu-btn ghost small', '', '用文件里的', () => void reload({ discard: true })),
        button('uttu-btn ghost small', '', '用我改的', () => void save({ force: true })));
    const zoomValue = button('uttu-tb-drop plain', '', '100%', () => zoomTo(1));
    head.append(label, make('span', 'grow'), conflict, button('uttu-tb-drop plain', '', '新建画框', () => void addNew()),
        button('uttu-tb-drop plain', '', '适合窗口', () => fit()),
        button('uttu-tb', '缩小', icon('i-minus'), () => zoomTo(view.k - 0.1)), zoomValue, button('uttu-tb', '放大', icon('i-plus'), () => zoomTo(view.k + 0.1)));
    const stage = make('div', 'uttu-design-stage');
    stage.tabIndex = -1;
    const world = make('div', 'uttu-design-world');
    const empty = make('div', 'uttu-design-empty', '还没有画框。右键空白处新建，或者加入已有的网页。');
    const band = make('div', 'uttu-pick-mark region');
    band.hidden = true;
    stage.append(world, empty, band);
    work.append(head, stage);
    const workspace = document.getElementById('document-workspace');
    (workspace?.parentElement || document.body).append(work);

    // ---------- 文件内容 ----------
    function parse(text) {
        if (!String(text).trim()) return { version: 1, frames: [] }; // 刚建的空文件
        let value;
        try { value = JSON.parse(text); } catch (_) { throw new Error('这不是设计文件（内容不是 JSON）。'); }
        if (!value || !Array.isArray(value.frames)) throw new Error('这不是设计文件（没有 frames）。');
        for (const frame of value.frames) {
            frame.x = Number(frame.x) || 0;
            frame.y = Number(frame.y) || 0;
            frame.width = Number(frame.width) || 1280;
            frame.height = Number(frame.height) || 800;
        }
        value.frames = value.frames.filter((frame, index, all) => typeof frame.file === 'string' && all.findIndex((item) => item.file === frame.file) === index);
        return value;
    }
    const serialize = () => `${JSON.stringify(data, null, 2)}\n`;
    function remember() {
        history.length = historyAt + 1;
        history.push(serialize());
        historyAt = history.length - 1;
    }
    function changed() {
        remember();
        dirty = true;
        UI.sync?.();
        clearTimeout(autosaveTimer);
        if (UI.autosaveOn?.()) autosaveTimer = setTimeout(() => { if (dirty && conflict.hidden) void save(); }, 600);
    }
    function travel(step) {
        const next = historyAt + step;
        if (!file || next < 0 || next >= history.length) return;
        historyAt = next;
        data = parse(history[next]);
        selected = new Set();
        dirty = true;
        UI.sync?.();
        void refreshFrames();
        clearTimeout(autosaveTimer);
        if (UI.autosaveOn?.()) autosaveTimer = setTimeout(() => { if (dirty && conflict.hidden) void save(); }, 600);
    }

    // ---------- 画面 ----------
    function applyView() {
        world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
        stage.style.setProperty('--k', String(view.k));
        setText(zoomValue, `${Math.round(view.k * 100)}%`);
    }
    function zoomTo(value, at = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 }) {
        const k = Math.max(0.1, Math.min(2, Math.round(value * 100) / 100));
        view = { x: at.x - (at.x - view.x) * k / view.k, y: at.y - (at.y - view.y) * k / view.k, k };
        applyView();
    }
    function fit() {
        const frames = data?.frames || [];
        if (!frames.length) { view = { x: 40, y: 40, k: 1 }; applyView(); return; }
        const left = Math.min(...frames.map((frame) => frame.x));
        const top = Math.min(...frames.map((frame) => frame.y));
        const right = Math.max(...frames.map((frame) => frame.x + frame.width));
        const bottom = Math.max(...frames.map((frame) => frame.y + frame.height));
        const k = Math.max(0.1, Math.min(1, Math.min((stage.clientWidth - 80) / (right - left), (stage.clientHeight - 100) / (bottom - top))));
        view = { x: (stage.clientWidth - (right - left) * k) / 2 - left * k, y: (stage.clientHeight - (bottom - top) * k) / 2 - top * k + 10, k };
        applyView();
    }
    const framesVisible = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const node = [...nodes.values()].find((item) => item.root === entry.target);
            if (!node) continue;
            node.seen = entry.isIntersecting;
            if (node.seen) load(node);
        }
    }, { root: stage, rootMargin: '100px' });
    function makeNode(frame) {
        const root = make('div', 'uttu-design-frame');
        root.dataset.file = frame.file;
        const name = make('div', 'name');
        const body = make('div', 'body');
        root.append(name, body);
        for (const side of ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw']) {
            const handle = make('div', `handle ${side}`);
            handle.dataset.side = side;
            root.append(handle);
        }
        world.append(root);
        const node = { root, body, label: name, frame: null, url: '', mtime: 0, seen: false, used: 0, note: '' };
        framesVisible.observe(root);
        return node;
    }
    function load(node) {
        if (node.frame || !node.url) return;
        const frame = document.createElement('iframe');
        frame.className = 'uttu-design-page';
        frame.name = FRAME_NAME;
        frame.title = node.root.dataset.file;
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        round += 1;
        frame.src = `${node.url}?uttu-round=${round}`;
        node.body.replaceChildren(frame);
        node.frame = frame;
        node.used = round;
        const shown = [...nodes.values()].filter((item) => item.frame);
        if (shown.length > MAX_LOADED) {
            const spare = shown.filter((item) => !item.seen).sort((a, b) => a.used - b.used)[0];
            if (spare) { spare.frame.remove(); spare.frame = null; }
        }
    }
    function reloadNode(node) {
        node.frame?.remove();
        node.frame = null;
        if (node.seen) load(node);
    }
    function paint() {
        const frames = data?.frames || [];
        const kept = new Set(frames.map((frame) => frame.file));
        for (const [key, node] of nodes) {
            if (kept.has(key)) continue;
            framesVisible.unobserve(node.root);
            node.root.remove();
            nodes.delete(key);
        }
        for (const frame of frames) {
            if (!nodes.has(frame.file)) nodes.set(frame.file, makeNode(frame));
            const node = nodes.get(frame.file);
            Object.assign(node.root.style, { left: `${frame.x}px`, top: `${frame.y}px`, width: `${frame.width}px`, height: `${frame.height}px` });
            node.root.classList.toggle('on', selected.has(frame));
            setText(node.label, `${frame.file.split('/').pop()}　${Math.round(frame.width)} × ${Math.round(frame.height)}`);
        }
        empty.hidden = frames.length > 0;
    }
    // 问主进程每一框的地址和修改时间：新的载入，改过的刷新，找不到的说明。
    async function refreshFrames() {
        if (!file) return;
        paint();
        const target = file;
        const result = await api().page('design-frames', { file: file.filePath, list: data.frames.map((frame) => frame.file) }).catch(() => null);
        if (file !== target || !result?.success) return;
        for (const item of result.frames) {
            const node = nodes.get(item.file);
            if (!node) continue;
            const note = item.refused ? '这个路径不是这份设计范围里的网页。' : item.missing ? '找不到这个文件。' : '';
            if (note !== node.note) {
                node.note = note;
                if (note) node.body.replaceChildren(make('div', 'note', note));
            }
            if (note) {
                node.url = '';
                node.frame = null;
                continue;
            }
            const fresh = node.url !== item.url || Math.abs(node.mtime - item.mtime) > 1;
            node.url = item.url;
            node.mtime = item.mtime;
            if (fresh) reloadNode(node);
            else if (node.seen) load(node);
        }
    }
    function startPolling() {
        clearInterval(pollTimer);
        pollTimer = setInterval(() => { if (file && !press) void refreshFrames(); }, POLL_MS);
    }

    // ---------- 选中、拖动、改尺寸、框选 ----------
    const stagePoint = (event) => {
        const box = stage.getBoundingClientRect();
        return { x: event.clientX - box.left, y: event.clientY - box.top };
    };
    const frameOf = (element) => data?.frames.find((frame) => frame.file === element?.closest?.('.uttu-design-frame')?.dataset.file) || null;
    function resized(origin, side, dx, dy) {
        const next = { ...origin };
        if (side.includes('e')) next.width = Math.max(MIN_SIZE, origin.width + dx);
        if (side.includes('s')) next.height = Math.max(MIN_SIZE, origin.height + dy);
        if (side.includes('w')) { next.width = Math.max(MIN_SIZE, origin.width - dx); next.x = origin.x + origin.width - next.width; }
        if (side.includes('n')) { next.height = Math.max(MIN_SIZE, origin.height - dy); next.y = origin.y + origin.height - next.height; }
        return next;
    }
    stage.addEventListener('pointerdown', (event) => {
        if (!file || event.target.closest('.uttu-design-empty button')) return;
        stage.focus({ preventScroll: true });
        const at = stagePoint(event);
        if (event.button === 1 || (event.button === 0 && spaceDown)) {
            event.preventDefault();
            stage.setPointerCapture(event.pointerId);
            press = { kind: 'pan', at, view: { ...view } };
            stage.classList.add('panning');
            return;
        }
        if (event.button !== 0) return;
        event.preventDefault();
        stage.setPointerCapture(event.pointerId);
        const frame = frameOf(event.target);
        const adding = event.ctrlKey || event.metaKey || event.shiftKey;
        const side = event.target.closest('.handle')?.dataset.side;
        lastPressed = side ? null : frame;
        if (side && frame) {
            press = { kind: 'resize', at, frame, side, origin: { x: frame.x, y: frame.y, width: frame.width, height: frame.height }, moved: false };
            return;
        }
        if (!frame) {
            if (!adding) selected = new Set();
            press = { kind: 'band', at, before: new Set(selected), moved: false };
            paint();
            return;
        }
        const wasOn = selected.has(frame);
        if (adding) {
            if (wasOn) selected.delete(frame);
            else selected.add(frame);
        } else if (!wasOn) {
            selected = new Set([frame]);
        }
        press = { kind: 'move', at, single: !adding && wasOn && selected.size > 1 ? frame : null, origins: new Map([...selected].map((item) => [item, { x: item.x, y: item.y }])), moved: false };
        paint();
    });
    stage.addEventListener('pointermove', (event) => {
        if (!press) return;
        const at = stagePoint(event);
        const dx = (at.x - press.at.x) / view.k;
        const dy = (at.y - press.at.y) / view.k;
        if (press.kind === 'pan') {
            view = { ...press.view, x: press.view.x + at.x - press.at.x, y: press.view.y + at.y - press.at.y };
            applyView();
            return;
        }
        if (!press.moved && Math.hypot(at.x - press.at.x, at.y - press.at.y) < 4) return;
        press.moved = true;
        if (press.kind === 'move') {
            for (const [frame, origin] of press.origins) Object.assign(frame, { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) });
        } else if (press.kind === 'resize') {
            const next = resized(press.origin, press.side, dx, dy);
            Object.assign(press.frame, { x: Math.round(next.x), y: Math.round(next.y), width: Math.round(next.width), height: Math.round(next.height) });
        } else {
            const left = Math.min(at.x, press.at.x);
            const top = Math.min(at.y, press.at.y);
            const width = Math.abs(at.x - press.at.x);
            const height = Math.abs(at.y - press.at.y);
            band.hidden = false;
            Object.assign(band.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
            const scene = { x: (left - view.x) / view.k, y: (top - view.y) / view.k, width: width / view.k, height: height / view.k };
            selected = new Set([...press.before, ...data.frames.filter((frame) => frame.x < scene.x + scene.width && frame.x + frame.width > scene.x && frame.y < scene.y + scene.height && frame.y + frame.height > scene.y)]);
        }
        paint();
    });
    function release() {
        const current = press;
        press = null;
        stage.classList.remove('panning');
        band.hidden = true;
        if (!current) return;
        if (current.moved && (current.kind === 'move' || current.kind === 'resize')) changed();
        else if (current.single) selected = new Set([current.single]);
        paint();
    }
    stage.addEventListener('pointerup', release);
    stage.addEventListener('pointercancel', release);
    stage.addEventListener('dblclick', () => { if (lastPressed) void openFrame(lastPressed); });
    stage.addEventListener('wheel', (event) => {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
            zoomTo(view.k * (event.deltaY < 0 ? 1.1 : 1 / 1.1), stagePoint(event));
            return;
        }
        view = { ...view, x: view.x - (event.shiftKey ? event.deltaY : event.deltaX), y: view.y - (event.shiftKey ? 0 : event.deltaY) };
        applyView();
    }, { passive: false });

    // ---------- 画框的事 ----------
    const pathOf = (frame) => nodes.get(frame.file)?.filePath || `${file.filePath.replace(/[\\/][^\\/]*$/, '')}/${frame.file}`;
    const openFrame = (frame) => session()?.openPath?.(pathOf(frame));
    function placed(size = {}) {
        const frames = data.frames;
        const last = [...selected].at(-1) || frames.at(-1);
        return { x: frames.length ? Math.max(...frames.map((frame) => frame.x + frame.width)) + GAP : 0, y: frames.length ? Math.min(...frames.map((frame) => frame.y)) : 0,
            width: size.width || last?.width || 1280, height: size.height || last?.height || 800 };
    }
    function addFrame(relative, size) {
        const known = data.frames.find((frame) => frame.file === relative);
        if (known) {
            selected = new Set([known]);
            paint();
            return;
        }
        const frame = { file: relative, ...placed(size) };
        data.frames.push(frame);
        selected = new Set([frame]);
        changed();
        void refreshFrames();
        if (data.frames.length === 1) fit();
    }
    async function addNew(size) {
        const result = await api().page('design-frame-new', { file: file.filePath }).catch((error) => ({ success: false, error: error.message }));
        if (!result?.success) UI.toast(`没建好画框：${result?.error || ''}`, 'error', 5000);
        else addFrame(result.file, size);
    }
    async function addExisting() {
        const item = await UI.pickFile?.({ placeholder: '加入哪份网页' });
        if (!item?.path) return;
        if (!/\.html?$/i.test(item.path)) {
            UI.toast('画框只能放网页（.html）。', 'error', 4000);
            return;
        }
        addFrame(window.UTTUScriptoriumLinkPick.relativeTo(file.filePath, item.path));
    }
    async function duplicate() {
        for (const frame of [...selected]) {
            const result = await api().page('design-frame-copy', { file: file.filePath, source: frame.file }).catch((error) => ({ success: false, error: error.message }));
            if (!result?.success) UI.toast(`没复制成：${result?.error || ''}`, 'error', 5000);
            else addFrame(result.file, frame);
        }
    }
    function removeSelected() {
        if (!selected.size) return;
        data.frames = data.frames.filter((frame) => !selected.has(frame));
        selected = new Set();
        changed();
        paint();
    }
    function setSize(width, height) {
        for (const frame of selected) Object.assign(frame, { width, height });
        changed();
        paint();
    }
    function nudge(dx, dy) {
        for (const frame of selected) Object.assign(frame, { x: frame.x + dx, y: frame.y + dy });
        changed();
        paint();
    }
    function targetOf(frame) {
        const box = nodes.get(frame.file).root.getBoundingClientRect();
        const name = frame.file.split('/').pop();
        return { type: 'region', label: `画框 ${name}`, place: `设计 ${file.name} 的画框 ${frame.file}，${frame.width} × ${frame.height}`, text: '',
            locator: { type: 'region', rect: { x: frame.x, y: frame.y, width: frame.width, height: frame.height } }, capture: { x: box.x, y: box.y, width: box.width, height: box.height } };
    }
    stage.addEventListener('contextmenu', (event) => {
        if (!file) return;
        event.preventDefault();
        const frame = frameOf(event.target);
        const at = { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY };
        if (!frame) {
            UI.openMenu([{ label: '新建画框', act: () => void addNew() }, { label: '加入已有网页', act: () => void addExisting() }, { sep: true }, { label: '适合窗口', k: 'Shift 1', act: fit }], at);
            return;
        }
        if (!selected.has(frame)) {
            selected = new Set([frame]);
            paint();
        }
        UI.openMenu([
            { label: '打开', act: () => void openFrame(frame) },
            { label: '复制引用', act: () => void Pick.reference(targetOf(frame)) },
            { label: '交给 Agent', act: () => void Pick.ask(targetOf(frame)) },
            { sep: true },
            { label: '复制一份', k: 'Ctrl D', act: () => void duplicate() },
            { label: '尺寸', sub: SIZES.map(([name, width, height]) => ({ label: `${name} ${width} × ${height}`, check: selected.size === 1 && frame.width === width && frame.height === height, act: () => setSize(width, height) })) },
            { label: '在文件夹里显示', act: () => void api()?.files?.('reveal', { path: pathOf(frame) }).catch(() => {}) },
            { sep: true },
            { label: '移出画布', k: 'Delete', hint: '文件留着', act: removeSelected },
        ], at);
    });

    // ---------- 键盘 ----------
    window.addEventListener('keydown', (event) => {
        if (!file) return;
        const key = event.key.toLowerCase();
        const command = event.ctrlKey || event.metaKey;
        if (command && !event.altKey && key === 's') {
            event.preventDefault();
            event.stopImmediatePropagation();
            void save();
        } else if (command && !event.altKey && ['z', 'y'].includes(key)) { // 别落到藏在后面的文稿上
            event.preventDefault();
            event.stopImmediatePropagation();
            travel(key === 'y' || event.shiftKey ? 1 : -1);
        }
    }, true);
    stage.addEventListener('keydown', (event) => {
        const key = event.key.toLowerCase();
        const command = event.ctrlKey || event.metaKey;
        const step = event.shiftKey ? 10 : 1;
        const moves = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] };
        if (event.key === ' ') spaceDown = true;
        else if (event.key === 'Delete' || event.key === 'Backspace') removeSelected();
        else if (event.key === 'Escape') { selected = new Set(); paint(); } else if (command && key === 'a') { selected = new Set(data.frames); paint(); } else if (command && key === 'd') void duplicate();
        else if (command && (key === '=' || key === '+')) zoomTo(view.k + 0.1);
        else if (command && key === '-') zoomTo(view.k - 0.1);
        else if (command && key === '0') zoomTo(1);
        else if (event.shiftKey && event.code === 'Digit1') fit();
        else if (moves[key] && selected.size) nudge(...moves[key]);
        else return;
        event.preventDefault();
    });
    stage.addEventListener('keyup', (event) => { if (event.key === ' ') spaceDown = false; });

    // ---------- 打开、存、离开 ----------
    async function readFile(path) {
        try {
            return await api().view('read', { file: path });
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    function resetView() {
        for (const node of nodes.values()) {
            framesVisible.unobserve(node.root);
            node.root.remove();
        }
        nodes.clear();
    }
    function stash() {
        if (file && dirty) drafts.set(norm(file.filePath), { text: serialize(), mtime: file.mtime });
    }
    function leave() {
        if (!file) return;
        clearTimeout(autosaveTimer);
        clearInterval(pollTimer);
        stash();
        resetView();
        file = null;
        data = null;
        dirty = false;
        selected = new Set();
        document.body.classList.remove('uttu-design-mode');
        work.hidden = true;
        conflict.hidden = true;
        void api()?.view?.('watch', { file: null }).catch(() => {});
        UI.syncTitle?.();
        UI.sync?.();
    }
    async function open(path) {
        if (!isDesign(path)) return false;
        if (file && same(file.filePath, path)) return true;
        const result = await readFile(path);
        let parsed;
        try {
            if (!result?.success) throw new Error(result?.error || '读不到');
            parsed = parse(result.text);
        } catch (error) {
            UI.toast(`没打开这份设计：${error.message}`, 'error', 5000);
            return false;
        }
        if (file) {
            stash();
            clearTimeout(autosaveTimer);
            resetView();
        }
        loading = true;
        const draft = drafts.get(norm(result.filePath));
        drafts.delete(norm(result.filePath));
        file = { filePath: result.filePath, name: result.name, mtime: result.mtime, generation: ++generation, saving: false };
        data = draft ? parse(draft.text) : parsed;
        dirty = Boolean(draft);
        selected = new Set();
        history = [serialize()];
        historyAt = 0;
        conflict.hidden = !(draft && Math.abs(draft.mtime - result.mtime) > 1);
        document.body.classList.add('uttu-design-mode');
        work.hidden = false;
        setText(label.querySelector('small'), result.name);
        paint();
        fit();
        await refreshFrames();
        loading = false;
        startPolling();
        void api().view('watch', { file: result.filePath }).catch(() => {});
        UI.syncTitle?.();
        UI.sync?.();
        return true;
    }
    function route(path) {
        if (isDesign(path)) return open(path);
        if (!file) return null;
        const behind = session()?.current?.();
        leave();
        const stale = /\.(md|markdown)$/i.test(String(path)) && !behind?.dirty;
        if (behind && !welcomeShown() && same(behind.filePath, path) && !stale) return Promise.resolve(true);
        return null;
    }
    async function save({ force = false } = {}) {
        if (!file || !data) return false;
        if (!dirty && !force) return true;
        clearTimeout(autosaveTimer);
        const target = file;
        const text = serialize();
        target.saving = true;
        UI.sync?.();
        let result;
        try {
            result = await api().view('save', { file: target.filePath, text, mtime: target.mtime, eol: 'lf', bom: false, force });
        } catch (error) {
            result = { success: false, error: error.message };
        }
        target.saving = false;
        if (file !== target) return Boolean(result?.success);
        if (result?.conflict) {
            conflict.hidden = false;
            UI.sync?.();
            return false;
        }
        if (!result?.success) {
            UI.toast(`没存上：${result?.error || '写不进去'}`, 'error', 5000);
            UI.sync?.();
            return false;
        }
        file.mtime = result.mtime;
        dirty = serialize() !== text;
        conflict.hidden = true;
        UI.sync?.();
        return true;
    }
    async function reload({ discard = false } = {}) {
        if (!file || (dirty && !discard)) return;
        const result = await readFile(file.filePath);
        if (!file || !result?.success) return;
        try {
            data = parse(result.text);
        } catch (error) {
            UI.toast(`文件现在打不开：${error.message}`, 'error', 5000);
            return;
        }
        file.mtime = result.mtime;
        dirty = false;
        conflict.hidden = true;
        selected = new Set();
        remember();
        await refreshFrames();
        UI.sync?.();
    }
    api()?.onViewChanged?.((payload) => {
        if (!file || !same(payload?.file, file.filePath) || Math.abs(Number(payload.mtime) - file.mtime) <= 1) return;
        if (dirty) conflict.hidden = false;
        else void reload();
    });
    async function close() {
        if (!file) return;
        if (dirty && !await save()) return;
        leave();
        if (session()?.current?.() && !welcomeShown()) document.getElementById('home-btn')?.click();
    }
    async function forget(path) {
        const draft = drafts.get(norm(path));
        if (!draft) return;
        drafts.delete(norm(path));
        try {
            await api().view('save', { file: path, text: draft.text, mtime: draft.mtime, eol: 'lf', bom: false, force: true });
        } catch (error) {
            UI.toast(`${path.split(/[\\/]/).pop()} 没存上：${error.message}`, 'error', 5000);
        }
    }
    async function create() {
        try {
            const result = await api().view('design-new');
            if (!result?.success) throw new Error(result?.error || '建不出来');
            await session()?.openPath?.(result.filePath);
        } catch (error) {
            UI.toast(`没建好设计：${error.message}`, 'error', 5000);
        }
    }
    function fileItems({ openNewDialog, open: openFile }) {
        const has = Boolean(file);
        return [
            { label: '新建', k: 'Ctrl N', act: openNewDialog },
            { label: '新建白板', act: () => void window.UTTUScriptoriumBoard?.create() },
            { label: '新建设计', act: () => void create() },
            { label: '打开文件', k: 'Ctrl O', act: openFile },
            { label: '打开文件夹', act: () => window.UTTUScriptoriumFolder?.choose?.() },
            { sep: true },
            { label: '保存', k: 'Ctrl S', disabled: !has || !dirty, act: () => void save() },
            { label: '重新载入', k: 'F5', hint: dirty ? '放弃没存的修改' : '', disabled: !has, act: () => void reload({ discard: true }) },
            { label: '在文件夹里显示', disabled: !has, act: () => void api()?.files?.('reveal', { path: file?.filePath }).catch(() => {}) },
            { label: '关闭', disabled: !has, act: () => void close() },
        ];
    }
    const text = () => (file ? [`设计 ${file.name}，${data.frames.length} 个画框`, ...data.frames.map((frame) => `${frame.file}，位置 (${frame.x}, ${frame.y})，尺寸 ${frame.width}×${frame.height}`)].join('\n') : '');

    const overlay = Object.freeze({
        claims: isDesign,
        open,
        route,
        leave,
        close,
        forget,
        create,
        save: () => save(),
        reload: () => reload({ discard: true }),
        fileItems,
        active: () => Boolean(file),
        agent: Object.freeze({ text, surface: () => stage }),
        doc: () => (file && !loading ? Object.freeze({ kind: 'design', filePath: file.filePath, name: file.name, generation: file.generation, dirty, saving: file.saving }) : null),
        _state: () => ({ data, view, selected: [...selected].map((frame) => frame.file), loaded: [...nodes.values()].filter((node) => node.frame).map((node) => node.root.dataset.file), history: history.length }),
    });
    window.UTTUScriptoriumDesign = overlay;
    UI.registerOverlay?.(overlay);
    applyView();
})();
