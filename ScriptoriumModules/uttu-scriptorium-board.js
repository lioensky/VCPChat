// 文坊里的白板。.excalidraw 文件就地打开：官方格式，文件在原处，磁盘是真相。
// 画布是官方 Excalidraw（vendor/excalidraw，scripts/build-excalidraw.mjs 打包），打开白板时才载入，离开时卸掉，没有常驻开销。
// 和文本一样盖在文稿上面：自动保存、外面改了自己刷新、两边都改了在栏头问用哪份，切走时没存的修改留在内存里。
// 人和 Agent 改的是同一份场景。Agent 走下面的 read、update（命令 GetBoard、UpdateBoard）：按元素 id 增改，带 expectedRevision，对不上就拒绝，
// 不整板替换；改完进官方的撤销栈，用户 Ctrl Z 能退。read 能按 id、区域或“某修订以来的变化”取，不用每次读整板。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    const Types = window.UTTUScriptoriumTypes;
    if (!UI?.on || !Types) return;
    const { make, button, setText } = UI;
    const api = () => window.scriptoriumAPI;
    const session = () => window.UTTUScriptoriumSession;
    const isBoard = (file) => Types.kindOf(file) === 'board';
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const welcomeShown = () => document.getElementById('welcome-state')?.hidden === false;
    const nextFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const Pick = window.UTTUScriptoriumPick;

    const LIST_DEFAULT = 200;
    const LIST_MOST = 1000;
    const SNAPSHOTS = 24; // sinceRevision 能回看的修订数
    const PICTURE_EDGE = 1600;
    const LOOKS_KEY = 'uttu.scriptorium.board.looks';
    const BACKGROUNDS = Object.freeze([['白色', '#ffffff'], ['米色', '#fbf6ec'], ['浅灰', '#f1f1ef']]);
    // 右键菜单第一层留下的，其余收进“层级”“更多”（官方的 data-testid）。
    const MENU_FIRST = Object.freeze(['cut', 'copy', 'paste', 'duplicateSelection', 'group', 'ungroup', 'selectAll']);
    const MENU_LAYER = Object.freeze(['bringForward', 'sendBackward', 'bringToFront', 'sendToBack']);
    const MENU_LAST = Object.freeze(['deleteSelectedElements']);
    const PATCHABLE = new Set(['x', 'y', 'width', 'height', 'angle', 'strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle',
        'roughness', 'opacity', 'fontSize', 'fontFamily', 'textAlign', 'verticalAlign', 'link', 'locked', 'groupIds', 'points']);

    let X = null; // 打包好的 Excalidraw
    let scene = null; // 它的 API
    let unmount = null;
    let file = null; // { filePath, name, mtime, generation, saving, saved }
    let generation = 0;
    let dirty = false;
    let loading = false;
    let autosaveTimer = 0;
    let settleTimer = 0;
    let vendor = null;
    let plainCanvas = false; // 画布是原色还是深色，见 applyLook
    let lookWatcher = null;
    let libraryTimer = 0;
    let snapshots = []; // [{ stamp, versions: Map(元素 id → version) }]
    const drafts = new Map();

    const work = make('div', 'uttu-board-work');
    work.hidden = true;
    work.setAttribute('aria-label', '白板');
    const head = make('div', 'uttu-pane-head');
    const label = make('span', 'uttu-pane-label', '白板<small></small>');
    const conflict = make('span', 'uttu-page-conflict');
    conflict.hidden = true;
    conflict.append(make('span', '', '文件在别处改过了'),
        button('uttu-btn ghost small', '', '用文件里的', () => void reload({ discard: true })),
        button('uttu-btn ghost small', '', '用我改的', () => void save({ force: true })));
    // 选中元素时栏头出现这两个：画布上的右键是官方的菜单，这里不去动它。
    const selectionTools = make('span', 'uttu-board-selection');
    selectionTools.hidden = true;
    selectionTools.append(button('uttu-tb-drop plain', '', '复制引用', () => { const target = selectionTarget(); if (target) void Pick.reference(target); }));
    const turnButton = button('uttu-tb-drop plain', '', '交给 Agent', () => void startTurn());
    turnButton.hidden = true;
    // 背景。取色框不能 hidden：系统取色窗要按它的位置摆。
    const colorInput = make('input', 'uttu-board-color');
    colorInput.type = 'color';
    colorInput.tabIndex = -1;
    colorInput.setAttribute('aria-hidden', 'true');
    colorInput.addEventListener('change', () => setBackground(colorInput.value));
    // 隐藏工具：官方的禅模式（Alt Z），再把顶上的工具栏也收起来。字母键、右键照常。记在这台机器上，各块白板一样。
    const CLEAN_KEY = 'uttu.scriptorium.board.clean';
    const cleanSaved = () => { try { return localStorage.getItem(CLEAN_KEY) === '1'; } catch (_) { return false; } };
    const toggleClean = () => scene?.updateScene({ appState: { zenModeEnabled: !scene.getAppState().zenModeEnabled } });
    const cleanButton = button('uttu-tb-drop plain', '', '隐藏工具', toggleClean);
    function paintClean(on) {
        stage.classList.toggle('uttu-board-clean', on);
        setText(cleanButton, on ? '显示工具' : '隐藏工具');
        try { localStorage.setItem(CLEAN_KEY, on ? '1' : '0'); } catch (_) { /* 只在这次用 */ }
    }
    head.append(label, selectionTools, make('span', 'grow'), conflict, cleanButton, turnButton);
    const stage = make('div', 'uttu-board-stage');
    const host = make('div', 'uttu-board-host');
    stage.append(host);
    work.append(head, stage, colorInput);
    const workspace = document.getElementById('document-workspace');
    (workspace?.parentElement || document.body).append(work);

    function loadVendor() {
        if (vendor) return vendor;
        window.EXCALIDRAW_ASSET_PATH = new URL('../vendor/excalidraw/', location.href).href; // 字体走本地，不走官方 CDN
        vendor = new Promise((resolve, reject) => {
            const style = document.createElement('link');
            style.rel = 'stylesheet';
            style.href = '../vendor/excalidraw/excalidraw.css';
            document.head.append(style);
            const tag = document.createElement('script');
            tag.src = '../vendor/excalidraw/excalidraw.js';
            tag.onload = () => resolve(window.UTTUExcalidraw);
            tag.onerror = () => {
                vendor = null;
                reject(new Error('白板组件没有载入。'));
            };
            document.head.append(tag);
        });
        return vendor;
    }

    // ---------- 场景 ----------
    const live = () => X.getNonDeletedElements(scene.getSceneElementsIncludingDeleted());
    const stamp = () => `${X.hashElementsVersion(live())}-${scene.getAppState().viewBackgroundColor}`;
    const serialize = () => X.serializeAsJSON(scene.getSceneElementsIncludingDeleted(), scene.getAppState(), scene.getFiles(), 'local');
    function parse(text) {
        if (!String(text).trim()) return { elements: [], appState: {}, files: {} }; // 文件树里新建的空文件
        const data = JSON.parse(text);
        if (data?.type !== 'excalidraw' || !Array.isArray(data.elements)) throw new Error('这不是 Excalidraw 文件。');
        return data;
    }
    function remember() {
        const value = stamp();
        if (snapshots.at(-1)?.stamp === value) return value;
        snapshots.push({ stamp: value, versions: new Map(live().map((element) => [element.id, element.version])) });
        if (snapshots.length > SNAPSHOTS) snapshots.shift();
        return value;
    }
    function settle() {
        clearTimeout(settleTimer);
        if (!file || !scene || loading) return;
        const last = snapshots.at(-1)?.stamp;
        const value = remember();
        const was = dirty;
        dirty = value !== file.saved;
        if (dirty !== was) UI.sync?.();
        // 真改了才重新计时；读一下、动一下鼠标都会走到这里，不能把保存一直往后推。
        if (dirty && (value !== last || !autosaveTimer)) scheduleAutosave();
    }
    // 拖动时 onChange 一直来，停下来才算一次改动。
    function changed() {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(settle, 120);
    }

    // 工具条永远是 VCP 的深色，画布单独选。
    // 官方把两件事绑在 theme 上：dark 时画布整个反色，深色界面也来自容器上的 theme--dark。所以“原色”这样做：theme 用 light，官方的渲染就不反色，
    // 图片也不会被反两次；容器上补回 theme--dark 让界面还是深色，--theme-filter 关掉（uttu-scriptorium-views.css）。
    // 深色和原色记在本机，按文件记；原色时的颜色是 viewBackgroundColor，存在文件里，官方也认。没选过时白底显示成深色，别的底色是有人选的，照原色显示。
    function readLooks() {
        try { return JSON.parse(localStorage.getItem(LOOKS_KEY) || '{}') || {}; } catch (_) { return {}; }
    }
    function lookFor(path, background) {
        return readLooks()[norm(path)] || (/^#f{3}(f{3})?$/i.test(String(background || '#ffffff')) ? 'dark' : 'plain');
    }
    function keepDarkChrome() {
        const box = host.querySelector('.excalidraw-container');
        if (plainCanvas && box && !box.classList.contains('theme--dark')) box.classList.add('theme--dark');
    }
    function applyLook(look) {
        plainCanvas = look === 'plain';
        stage.classList.toggle('uttu-board-plain', plainCanvas);
        scene?.updateScene({ appState: { theme: plainCanvas ? 'light' : 'dark' } });
        keepDarkChrome();
    }
    function chooseLook(look) {
        if (!file) return;
        try { localStorage.setItem(LOOKS_KEY, JSON.stringify({ ...readLooks(), [norm(file.filePath)]: look })); } catch (_) { /* 只在这次用 */ }
        applyLook(look);
    }
    function setBackground(color) {
        if (!scene) return;
        scene.updateScene({ appState: { viewBackgroundColor: color }, captureUpdate: X.CaptureUpdateAction.IMMEDIATELY });
        chooseLook('plain');
    }
    function backgroundItems() {
        const current = String(scene?.getAppState().viewBackgroundColor || '').toLowerCase();
        return [
            { label: '深色', check: !plainCanvas, act: () => { closeNativeMenu(); chooseLook('dark'); } },
            ...BACKGROUNDS.map(([name, color]) => ({ label: name, check: plainCanvas && current === color, act: () => { closeNativeMenu(); setBackground(color); } })),
            { label: '其他颜色', check: plainCanvas && !BACKGROUNDS.some(([, color]) => color === current), act: () => { closeNativeMenu(); pickColor(); } },
        ];
    }
    function pickColor() {
        const current = String(scene?.getAppState().viewBackgroundColor || '#ffffff');
        colorInput.value = /^#[0-9a-f]{6}$/i.test(current) ? current : '#ffffff';
        colorInput.style.left = `${lastPoint.x}px`;
        colorInput.style.top = `${lastPoint.y}px`;
        colorInput.click();
    }
    function fitToWindow() {
        scene?.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1, animate: false });
    }

    // 右键菜单。官方的菜单还在，只是藏起来（它知道这时候该有哪些项），这里照着它列一份文坊的菜单，点了转给它。
    // ---------- 轮到 Agent----------
    // 人写在板上，点一下，Agent 读这一轮新写的内容，把回答、连线、排版写回板上。没有提问框，问和答都在文件里。
    // 谁写的记在元素的 customData 里（官方格式留给扩展用的字段）：uttuBy 是 Agent 建的，uttuAgentAt 是 Agent 最后一次动它的时间。
    // 比最后一次 Agent 动手更晚改过的元素，就是人这一轮写的。这个时间存在文件里，换机器、重开都对。
    const AGENT_KEY = 'uttu.scriptorium.board.agent';
    const TURN_POLL_MS = 2000;
    const TURN_LIST = 40;
    const SHAPE_NAMES = Object.freeze({ rectangle: '矩形', ellipse: '椭圆', diamond: '菱形', text: '文字', arrow: '箭头', line: '线', freedraw: '手写', image: '图片', frame: '画框' });
    let agentReady = false;
    let agentList = [];
    let turn = null;
    function savedAgent() {
        try { return localStorage.getItem(AGENT_KEY) || ''; } catch (_) { return ''; }
    }
    const turnAgent = () => (agentList.includes(savedAgent()) ? savedAgent() : agentList[0] || '');
    async function checkAgent() {
        const state = await api().boardTurn?.('available').catch(() => null);
        agentReady = Boolean(state?.available);
        turnButton.hidden = !agentReady;
        if (agentReady) agentList = (await api().boardTurn('agents').catch(() => null))?.agents || [];
        if (!agentList.length) { agentReady = false; turnButton.hidden = true; }
    }
    function paintTurn() {
        turnButton.disabled = Boolean(turn);
        setText(turnButton, turn ? `${turn.agent} 正在看板` : '交给 Agent');
    }
    function describeElement(element, labels) {
        const words = labels.get(element.id) ?? (element.type === 'text' ? element.originalText ?? element.text : '');
        const ends = [element.startBinding?.elementId, element.endBinding?.elementId].filter(Boolean).join(' → ');
        return `- ${element.id} ${SHAPE_NAMES[element.type] || element.type}${words ? `「${String(words).replace(/\s+/g, ' ').slice(0, 300)}」` : ''}`
            + `，位置 (${Math.round(element.x)}, ${Math.round(element.y)})，尺寸 ${Math.round(element.width)}×${Math.round(element.height)}${ends ? `，连着 ${ends}` : ''}`;
    }
    function turnBrief() {
        const all = live();
        const labels = labelsOf(all);
        const since = Math.max(0, ...all.map((element) => element.customData?.uttuAgentAt || 0));
        const fresh = new Set(all.filter((element) => element.updated > since + 1000).map((element) => element.containerId || element.id));
        const top = all.filter((element) => !element.containerId);
        const written = top.filter((element) => fresh.has(element.id));
        const chosen = scene.getAppState().selectedElementIds || {};
        const pointed = top.filter((element) => chosen[element.id]);
        if (!written.length && !pointed.length) return null;
        const list = (items) => items.slice(0, TURN_LIST).map((element) => describeElement(element, labels)).concat(items.length > TURN_LIST ? [`还有 ${items.length - TURN_LIST} 个，用 GetBoard 取`] : []);
        return [`白板 ${file.filePath} 在文坊里开着，修订 ${stamp()}，共 ${top.length} 个元素。轮到你了。`,
            ...(written.length ? ['人这一轮写的或动过的：', ...list(written)] : []),
            ...(pointed.length ? ['人选中的：', ...list(pointed)] : []),
            ...(manualFit() ? ['这块板是手动排版：卡片尺寸、字号、换行都由你写，工具不动。'] : []),
            '按 ScriptoriumCollaborator 里 UpdateBoard 说的做，都写在板上。完成后用一两句话说做了什么。'].join('\n');
    }
    async function startTurn() {
        if (!scene || !file || turn) return;
        if (!agentReady) {
            const target = selectionTarget();
            if (target) void Pick.ask(target);
            return;
        }
        settle();
        const prompt = turnBrief();
        if (!prompt) {
            UI.toast('板上没有新写的内容。写点什么，或者选中要它看的地方。');
            return;
        }
        const agent = turnAgent();
        turn = { agent, id: '' };
        paintTurn();
        const started = await api().boardTurn('start', { agent, prompt }).catch((error) => ({ success: false, error: error.message }));
        if (!started?.success) {
            turn = null;
            paintTurn();
            UI.toast(`${agent} 没有接下：${started?.error || '后端没有回应'}`, 'error', 6000);
            return;
        }
        turn.id = started.id;
        setTimeout(pollTurn, TURN_POLL_MS);
    }
    async function pollTurn() {
        if (!turn) return;
        const state = await api().boardTurn('status', { id: turn.id }).catch(() => null);
        if (state?.running || !state) { setTimeout(pollTurn, TURN_POLL_MS); return; }
        const { agent } = turn;
        turn = null;
        paintTurn();
        if (state.success === false) UI.toast(`没问到 ${agent} 的进度：${state.error || ''}`, 'error', 6000);
        else if (state.ok === false) UI.toast(`${agent} 没做完。${state.report || ''}`.trim().slice(0, 120), 'error', 6000);
        else UI.toast(`${agent} 写完了。`); // 回答都在板上，这里不复述
    }
    UI.on('start', () => void checkAgent());
    window.addEventListener('keydown', (event) => {
        if (!file || !scene || !(event.ctrlKey || event.metaKey) || event.key !== 'Enter' || !work.contains(event.target)) return;
        if (scene.getAppState().editingTextElement) return; // 正在写字时 Ctrl Enter 是写完
        event.preventDefault();
        event.stopPropagation();
        void startTurn();
    }, true);

    // Ctrl 点选和 Shift 一样加选。官方的 Ctrl 点是钻进编组选单个，双击编组也能进去。
    // 官方按下、抬起都看 shiftKey，框选时移动也看，所以这几个事件换成按着 Shift 的。拖元素时不换：Shift 拖是锁方向。
    let addingPointer = null;
    function asShift(event) {
        event.stopImmediatePropagation();
        event.target.dispatchEvent(new PointerEvent(event.type, { bubbles: true, cancelable: true, composed: true, view: window, pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: event.isPrimary,
            button: event.button, buttons: event.buttons, clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY, width: event.width, height: event.height, pressure: event.pressure, shiftKey: true }));
    }
    stage.addEventListener('pointerdown', (event) => {
        if (!event.isTrusted || !scene || event.button !== 0 || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
        if (!event.target.matches?.('canvas.interactive') || scene.getAppState().activeTool.type !== 'selection') return;
        addingPointer = event.pointerId;
        asShift(event);
    }, true);
    window.addEventListener('pointermove', (event) => {
        if (event.isTrusted && event.pointerId === addingPointer && scene?.getAppState().selectionElement) asShift(event);
    }, true);
    window.addEventListener('pointerup', (event) => {
        if (!event.isTrusted || event.pointerId !== addingPointer) return;
        addingPointer = null;
        asShift(event);
    }, true);

    // 右键哪里出哪份：元素上是元素的事；空白处是画布的事，背景在这里。
    let menuPoint = null;
    let lastPoint = { x: 0, y: 0 };
    const closeNativeMenu = () => scene?.updateScene({ appState: { contextMenu: null } });
    const ours = (act) => () => { closeNativeMenu(); act(); };
    const turnItem = () => (agentReady ? { label: '交给 Agent', k: 'Ctrl Enter', act: ours(() => void startTurn()) } : null);
    function mirrorMenu() {
        const native = host.querySelector('.context-menu');
        if (!native || !menuPoint) return;
        const entries = new Map([...native.querySelectorAll(':scope > li[data-testid]')].map((row) => {
            const action = row.querySelector('button');
            const shortcut = row.querySelector('.context-menu-item__shortcut')?.textContent.trim().replace(/\+/g, ' ') || '';
            const name = row.dataset.testid === 'duplicateSelection' ? '复制一份' : row.querySelector('.context-menu-item__label')?.textContent.trim(); // 官方的“复制”和“拷贝”挨着，分不清
            const item = { label: name || '', k: shortcut, act: () => action.click() };
            if (action.classList.contains('checkmark')) item.check = true;
            return [row.dataset.testid, item];
        }));
        const take = (ids) => ids.map((id) => { const item = entries.get(id); entries.delete(id); return item; }).filter(Boolean);
        const at = { left: menuPoint.x, right: menuPoint.x, top: menuPoint.y, bottom: menuPoint.y };
        lastPoint = menuPoint;
        if (entries.has('gridMode')) { // 只有空白处的菜单有这一项
            menuPoint = null;
            const basics = take(['paste', 'selectAll']);
            const canvas = take(['gridMode', 'objectsSnapMode']);
            take(['zenMode']);
            const others = [...entries.values()];
            const turn = turnItem();
            UI.openMenu([
                ...(turn ? [turn, { sep: true }] : []),
                ...basics,
                { sep: true },
                { label: '背景', sub: backgroundItems() },
                ...canvas,
                { label: '适合窗口', act: ours(fitToWindow) },
                { label: '卡片排版', sub: fitItems() },
                { label: scene.getAppState().zenModeEnabled ? '显示工具' : '隐藏工具', k: 'Alt Z', act: ours(toggleClean) },
                ...(others.length ? [{ sep: true }, { label: '更多', sub: others }] : []),
            ], at, { onClose: closeNativeMenu });
            return;
        }
        const first = take(MENU_FIRST);
        const layer = take(MENU_LAYER);
        const last = take(MENU_LAST);
        const rest = [...entries.values()];
        const target = selectionTarget();
        UI.openMenu([
            ...(target ? [{ label: '复制引用', act: ours(() => void Pick.reference(target)) },
                turnItem() || { label: '交给 Agent', act: ours(() => void Pick.ask(target)) }, { sep: true }] : []),
            ...first,
            ...(cardsChosen().length ? [{ label: '大小', sub: sizeItems(ours) }] : []),
            ...(layer.length ? [{ sep: true }, { label: '层级', sub: layer }] : []),
            ...(rest.length ? [{ label: '更多', sub: rest }] : []),
            ...(last.length ? [{ sep: true }, ...last] : []),
        ], at, { onClose: closeNativeMenu });
        menuPoint = null;
    }
    stage.addEventListener('contextmenu', (event) => {
        menuPoint = { x: event.clientX, y: event.clientY };
        setTimeout(mirrorMenu, 0);
    });
    async function loadLibrary() {
        const result = await api().view('board-library-read').catch(() => null);
        return Array.isArray(result?.items) ? result.items : [];
    }
    function libraryChanged(items) {
        clearTimeout(libraryTimer);
        libraryTimer = setTimeout(() => void api().view('board-library-write', { items }).catch(() => {}), 300);
    }
    function openLink(element, event) {
        event.preventDefault();
        void api().markdownOpenLink({ href: element.link, from: file?.filePath }).catch((error) => UI.toast(error.message, 'error', 4000));
    }
    async function mount(data) {
        const restored = X.restore(data, null, null, { repairBindings: true });
        const libraryItems = await loadLibrary();
        const look = lookFor(file.filePath, restored.appState.viewBackgroundColor);
        plainCanvas = look === 'plain';
        stage.classList.toggle('uttu-board-plain', plainCanvas);
        const clean = cleanSaved();
        paintClean(clean);
        await new Promise((resolve) => {
            unmount = X.mount(host, {
                excalidrawAPI: (value) => { scene = value; resolve(); },
                initialData: { elements: restored.elements, appState: { ...restored.appState, theme: plainCanvas ? 'light' : 'dark', zenModeEnabled: clean, collaborators: new Map() }, files: restored.files, libraryItems, scrollToContent: true },
                langCode: 'zh-CN',
                aiEnabled: false,
                autoFocus: true,
                handleKeyboardGlobally: false, // 键盘只在画布里算，不抢文坊别处的快捷键
                UIOptions: { canvasActions: { changeViewBackgroundColor: false, clearCanvas: true, export: false, loadScene: false, saveAsImage: false, saveToActiveFile: false, toggleTheme: false } }, // 背景在栏头
                onChange: (_elements, appState) => {
                    selectionTools.hidden = !Object.keys(appState.selectedElementIds || {}).length;
                    if (Boolean(appState.zenModeEnabled) !== stage.classList.contains('uttu-board-clean')) paintClean(Boolean(appState.zenModeEnabled));
                    changed();
                },
                onLibraryChange: libraryChanged,
                onLinkOpen: openLink,
            });
        });
        keepDarkChrome();
        lookWatcher?.disconnect();
        const container = host.querySelector('.excalidraw-container');
        if (container) { lookWatcher = new MutationObserver(keepDarkChrome); lookWatcher.observe(container, { attributes: true, attributeFilter: ['class'] }); }
        // 官方的初始载入是异步的，载完才算开好，否则 Agent 紧接着的修改会被它盖掉。用定时器等：藏着的窗口没有动画帧。
        for (let tries = 0; scene?.getAppState().isLoading && tries < 500; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        // 打开时看得到全貌：内容比窗口大就缩小，小的不放大。
        if (restored.elements.length) scene?.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1, animate: false });
    }
    function unmountCanvas() {
        lookWatcher?.disconnect();
        lookWatcher = null;
        unmount?.();
        unmount = null;
        scene = null;
    }
    // 官方的恢复过程可能修一些字段，以恢复之后的样子为“没改动”的基准。
    function baseline() {
        snapshots = [];
        file.saved = remember();
        dirty = false;
    }

    function stash() {
        if (!file || !scene || !dirty) return;
        drafts.set(norm(file.filePath), { text: serialize(), mtime: file.mtime });
    }
    function leave() {
        if (!file) return;
        settle();
        clearTimeout(autosaveTimer);
        clearTimeout(settleTimer);
        stash();
        unmountCanvas();
        file = null;
        dirty = false;
        snapshots = [];
        document.body.classList.remove('uttu-board-mode');
        work.hidden = true;
        conflict.hidden = true;
        void api()?.view?.('watch', { file: null }).catch(() => {});
        UI.syncTitle?.();
        UI.sync?.();
    }
    async function readFile(path) {
        try {
            return await api().view('read', { file: path });
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    async function open(path) {
        if (!isBoard(path)) return false;
        if (file && same(file.filePath, path)) return true;
        const result = await readFile(path);
        let data = null;
        try {
            if (!result?.success) throw new Error(result?.error || '读不到');
            data = parse(result.text);
            X = await loadVendor();
        } catch (error) {
            UI.toast(`没打开这块白板：${error.message}`, 'error', 5000);
            return false;
        }
        await saveBehind();
        if (file) {
            settle();
            stash();
            clearTimeout(autosaveTimer);
            unmountCanvas();
        }
        const draft = drafts.get(norm(result.filePath));
        drafts.delete(norm(result.filePath));
        file = { filePath: result.filePath, name: result.name, mtime: result.mtime, generation: ++generation, saving: false, saved: '' };
        conflict.hidden = true;
        document.body.classList.add('uttu-board-mode');
        work.hidden = false;
        loading = true;
        await mount(draft ? parse(draft.text) : data);
        loading = false;
        baseline();
        if (draft) {
            file.saved = '';
            dirty = true;
            if (Math.abs(draft.mtime - result.mtime) > 1) conflict.hidden = false;
        }
        void api().view('watch', { file: result.filePath }).catch(() => {});
        UI.syncTitle?.();
        UI.sync?.();
        return true;
    }
    function route(path) {
        if (isBoard(path)) return open(path);
        if (!file) return null;
        const behind = session()?.current?.();
        leave();
        const stale = /\.(md|markdown)$/i.test(String(path)) && !behind?.dirty;
        if (behind && !welcomeShown() && same(behind.filePath, path) && !stale) return Promise.resolve(true);
        return null;
    }
    async function saveBehind() {
        if (file || welcomeShown() || !UI.autosaveOn?.()) return;
        const behind = session()?.current?.();
        if (!behind?.filePath || !behind.dirty) return;
        document.getElementById('save-btn')?.click();
        const started = Date.now();
        while (Date.now() - started < 4000 && session()?.current?.()?.dirty) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    async function close() {
        if (!file) return;
        settle();
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

    async function save({ force = false } = {}) {
        if (!file || !scene) return false;
        settle();
        if (!dirty && !force) return true;
        clearTimeout(autosaveTimer);
        autosaveTimer = 0;
        const target = file;
        const savedStamp = stamp();
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
        file.saved = savedStamp;
        conflict.hidden = true;
        dirty = stamp() !== savedStamp;
        UI.sync?.();
        return true;
    }
    function scheduleAutosave() {
        clearTimeout(autosaveTimer);
        autosaveTimer = 0;
        if (!UI.autosaveOn?.()) return;
        autosaveTimer = setTimeout(() => {
            autosaveTimer = 0;
            if (dirty && conflict.hidden) void save();
        }, 1500);
    }
    function applyToScene(data) {
        const restored = X.restore(data, null, null, { repairBindings: true });
        const known = scene.getFiles();
        const added = Object.values(restored.files || {}).filter((item) => !known[item.id]);
        if (added.length) scene.addFiles(added);
        scene.updateScene({ elements: restored.elements, appState: { viewBackgroundColor: restored.appState.viewBackgroundColor }, captureUpdate: X.CaptureUpdateAction.NEVER });
        applyLook(lookFor(file.filePath, restored.appState.viewBackgroundColor));
    }
    async function reload({ discard = false } = {}) {
        if (!file || !scene) return;
        settle();
        if (dirty && !discard) return;
        const result = await readFile(file.filePath);
        if (!file || !result?.success) {
            if (result && !result.success) UI.toast(`没重新读到：${result.error || ''}`, 'error', 5000);
            return;
        }
        let data;
        try {
            data = parse(result.text);
        } catch (error) {
            UI.toast(`文件现在打不开：${error.message}`, 'error', 5000);
            return;
        }
        file.mtime = result.mtime;
        conflict.hidden = true;
        applyToScene(data);
        await nextFrames();
        file.saved = remember();
        dirty = false;
        UI.sync?.();
    }
    api()?.onViewChanged?.((payload) => {
        if (!file || !scene || !same(payload?.file, file.filePath) || Math.abs(Number(payload.mtime) - file.mtime) <= 1) return;
        settle();
        if (dirty) {
            conflict.hidden = false;
            return;
        }
        const path = file.filePath;
        const before = serialize();
        void reload().then(() => {
            if (!scene) return;
            void api().view('history-add', { file: path, before, after: serialize() }).then(() => UI.emit('view-file-changed'));
        });
    });

    // ---------- 给 Agent 读 ----------
    const rounded = (value) => Math.round(value * 100) / 100;
    function boundsOf(element) {
        if (!Array.isArray(element.points) || !element.points.length) return { x: element.x, y: element.y, width: element.width, height: element.height };
        const xs = element.points.map((point) => element.x + point[0]);
        const ys = element.points.map((point) => element.y + point[1]);
        const left = Math.min(...xs);
        const top = Math.min(...ys);
        return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
    }
    const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    function compact(element, labels) {
        const out = { id: element.id, type: element.type, x: rounded(element.x), y: rounded(element.y), width: rounded(element.width), height: rounded(element.height) };
        if (element.type === 'text') out.text = element.originalText ?? element.text;
        if (labels.has(element.id)) out.label = labels.get(element.id);
        if (element.strokeColor) out.strokeColor = element.strokeColor;
        if (element.backgroundColor && element.backgroundColor !== 'transparent') out.backgroundColor = element.backgroundColor;
        if (element.angle) out.angle = rounded(element.angle);
        if (element.startBinding) out.start = element.startBinding.elementId;
        if (element.endBinding) out.end = element.endBinding.elementId;
        if (Array.isArray(element.points)) out.points = element.points.map(([x, y]) => [rounded(x), rounded(y)]);
        if (element.groupIds?.length) out.groupIds = element.groupIds;
        if (element.link) out.link = element.link;
        if (element.locked) out.locked = true;
        if (element.customData?.uttuBy === 'agent') out.by = 'agent';
        return out;
    }
    const labelsOf = (all) => new Map(all.filter((element) => element.containerId).map((element) => [element.containerId, element.originalText ?? element.text]));
    const asRegion = (region) => (region && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(Number(region[key])))
        ? { x: Number(region.x), y: Number(region.y), width: Number(region.width), height: Number(region.height) } : null);
    function read(payload = {}) {
        settle();
        const all = live();
        const top = all.filter((element) => !element.containerId); // 框里的字算框的 label
        let list = top;
        let removed;
        if (payload.sinceRevision) {
            const base = snapshots.find((item) => item.stamp === String(payload.sinceRevision));
            if (!base) throw new Error(`修订 ${payload.sinceRevision} 已经不在记录里（只留最近 ${SNAPSHOTS} 次）。不带 sinceRevision 重读。`);
            const touched = new Set(all.filter((element) => base.versions.get(element.id) !== element.version).map((element) => element.containerId || element.id));
            const present = new Set(all.map((element) => element.id));
            list = list.filter((element) => touched.has(element.id));
            removed = [...base.versions.keys()].filter((id) => !present.has(id));
        }
        if (Array.isArray(payload.ids)) {
            const wanted = new Set(payload.ids.map(String));
            list = list.filter((element) => wanted.has(element.id));
        }
        const region = asRegion(payload.region);
        if (region) list = list.filter((element) => overlaps(boundsOf(element), region));
        const limit = Math.min(LIST_MOST, Math.max(1, Number(payload.limit) || LIST_DEFAULT));
        const labels = labelsOf(all);
        return { revision: stamp(), layout: manualFit() ? 'manual' : 'auto', background: scene.getAppState().viewBackgroundColor, total: top.length, matched: list.length, truncated: list.length > limit,
            elements: list.slice(0, limit).map((element) => compact(element, labels)), ...(removed ? { removed } : {}) };
    }
    function text() {
        if (!scene) return '';
        const all = live();
        const words = all.filter((element) => element.type === 'text').map((element) => element.originalText ?? element.text);
        return [`白板 ${file?.name || ''}，${all.filter((element) => !element.containerId).length} 个元素`, ...words].join('\n');
    }

    // ---------- 卡片的字和框 ----------
    // 自动排版（默认）：折行排齐，最后一行不会只剩一两个字；没写尺寸的按字定，同一批同字号的等宽，没写高度的框高跟着字。写明的尺寸照办。
    // 手动排版：工具不动字和框，每块白板自己选（右键空白处）。位置都可以写 below、right，相对另一张卡片摆，不用算坐标。
    const FIT_KEY = 'uttu.scriptorium.board.fit';
    const readFits = () => { try { return JSON.parse(localStorage.getItem(FIT_KEY) || '{}') || {}; } catch (_) { return {}; } };
    const manualFit = () => readFits()[norm(file.filePath)] === 'manual';
    function chooseFit(mode) {
        try { localStorage.setItem(FIT_KEY, JSON.stringify({ ...readFits(), [norm(file.filePath)]: mode })); } catch (_) { /* 只在这次用 */ }
    }
    const fitItems = () => [
        { label: '自动排版', check: !manualFit(), act: () => chooseFit('auto') },
        { label: '手动排版', check: manualFit(), act: () => chooseFit('manual') },
    ];
    const CARD_PAD = { x: 20, y: 14 };
    const CARD_LINES = 3; // 按字定宽时，尽量不超过这么多行
    const CARD_GAP = 100; // below、right 默认留的间距，放得下箭头上的字
    const CJK = '\\u2e80-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef\\u3000-\\u303f';
    const TOKENS = new RegExp(`[${CJK}]|[^\\s${CJK}]+|\\s+`, 'g');
    const NO_LINE_START = /^[，。、；：！？）》」』】,.;:!?)%]/;
    const ruler = document.createElement('canvas').getContext('2d');
    function widthOf(text, size) {
        ruler.font = `${size}px Excalifont, Xiaolai, sans-serif`;
        return ruler.measureText(text).width;
    }
    function wrapAt(line, size, width) {
        const lines = [];
        let current = '';
        for (const token of line.match(TOKENS) || []) {
            if (current && widthOf(current + token, size) > width && !NO_LINE_START.test(token)) {
                lines.push(current.trimEnd());
                current = token.trimStart();
            } else {
                current += token;
            }
        }
        if (current) lines.push(current.trimEnd());
        return lines.length ? lines : [''];
    }
    // 行数不变，找最窄的宽度：各行就差不多长了。
    function evenLines(text, size, width) {
        return String(text).split('\n').flatMap((line) => {
            const lines = wrapAt(line, size, width);
            if (lines.length < 2) return lines;
            let low = widthOf(line, size) / lines.length;
            let high = width;
            let best = lines;
            for (let step = 0; step < 8; step += 1) {
                const middle = (low + high) / 2;
                const tried = wrapAt(line, size, middle);
                if (tried.length <= lines.length) { best = tried; high = middle; } else low = middle;
            }
            return best;
        });
    }
    const cardHeight = (lines, size) => Math.round(lines.length * size * 1.25 + CARD_PAD.y * 2);
    const innerWidth = (width) => width - CARD_PAD.x * 2;
    function naturalWidth(text, size) {
        for (let width = size * 8; width < size * 24; width += size) {
            if (evenLines(text, size, innerWidth(width)).length <= CARD_LINES) return width;
        }
        return size * 24;
    }
    function fitCard(item, width, manual) {
        if (manual) return { ...item, width: width ?? 240, height: item.height ?? 120 };
        const size = Number(item.label.fontSize) || 20;
        const lines = evenLines(item.label.text, size, innerWidth(width));
        return { ...item, width, height: item.height === undefined ? cardHeight(lines, size) : Number(item.height), label: { ...item.label, text: lines.join('\n') } };
    }
    function fitCards(add, byId) {
        const manual = manualFit();
        const isCard = (item) => ['rectangle', 'ellipse', 'diamond'].includes(item?.type) && item.label?.text !== undefined;
        const shared = new Map();
        if (!manual) {
            for (const item of add.filter((card) => isCard(card) && card.width === undefined)) {
                const size = Number(item.label.fontSize) || 20;
                shared.set(size, Math.max(shared.get(size) || 0, naturalWidth(item.label.text, size)));
            }
        }
        const placed = new Map();
        return add.map((item) => {
            const width = item?.width === undefined ? shared.get(Number(item?.label?.fontSize) || 20) : Number(item.width);
            const { below, right, gap, ...fitted } = isCard(item) ? fitCard(item, width, manual) : item || {};
            const anchor = placed.get(String(below ?? right)) || byId.get(String(below ?? right));
            const space = Number(gap) || CARD_GAP;
            if (anchor && below !== undefined) Object.assign(fitted, { x: fitted.x ?? anchor.x + (anchor.width - fitted.width) / 2, y: fitted.y ?? anchor.y + anchor.height + space });
            else if (anchor) Object.assign(fitted, { x: fitted.x ?? anchor.x + anchor.width + space, y: fitted.y ?? anchor.y + (anchor.height - fitted.height) / 2 });
            if (fitted.id !== undefined) placed.set(String(fitted.id), fitted);
            return fitted;
        });
    }
    // 选中的卡片一起改大小：框改好，字重新折行、回到中间，连着的箭头接到新的框边。
    const cardsChosen = () => {
        if (!scene) return [];
        const chosen = scene.getAppState().selectedElementIds || {};
        return live().filter((element) => chosen[element.id] && !element.containerId && ['rectangle', 'ellipse', 'diamond'].includes(element.type));
    };
    function resizeCards(plan) {
        const changes = new Map(cardsChosen().map((card) => [card.id, plan(card)]));
        const next = scene.getSceneElementsIncludingDeleted().map((element) => {
            const change = changes.get(element.id) || changes.get(element.containerId);
            if (!change) return element;
            if (changes.has(element.id)) return touched(element, { width: change.width, height: change.height });
            return change.text === undefined ? element : touched(element, { text: change.text, originalText: change.text });
        });
        const fixed = X.restoreElements(next, null, { refreshDimensions: true, repairBindings: true });
        const boxes = new Map(fixed.map((element) => [element.id, element]));
        const centred = fixed.map((element) => {
            if (!changes.has(element.containerId)) return element;
            const box = boxes.get(element.containerId);
            return touched(element, { x: box.x + (box.width - element.width) / 2, y: box.y + (box.height - element.height) / 2 });
        });
        scene.updateScene({ elements: followArrows(centred, new Set(changes.keys())), captureUpdate: X.CaptureUpdateAction.IMMEDIATELY });
    }
    function sameSize(both, wide, tall) {
        const cards = cardsChosen();
        const width = Math.max(...cards.map((card) => card.width));
        const height = Math.max(...cards.map((card) => card.height));
        resizeCards((card) => ({ width: both || wide ? width : card.width, height: both || tall ? height : card.height }));
    }
    function fitToWords() {
        const labels = new Map(live().filter((element) => element.containerId).map((element) => [element.containerId, element]));
        resizeCards((card) => {
            const label = labels.get(card.id);
            if (!label) return { width: card.width, height: card.height };
            const words = label.originalText ?? label.text;
            const width = naturalWidth(words.replace(/\n/g, ''), label.fontSize);
            const lines = evenLines(words.replace(/\n/g, ''), label.fontSize, innerWidth(width));
            return { width, height: cardHeight(lines, label.fontSize), text: lines.join('\n') };
        });
    }
    const sizeItems = (act) => {
        const many = cardsChosen().length > 1;
        return [
            ...(many ? [{ label: '大小相同', act: act(() => sameSize(true)) }, { label: '宽度相同', act: act(() => sameSize(false, true)) }, { label: '高度相同', act: act(() => sameSize(false, false, true)) }] : []),
            { label: '按字调整', act: act(fitToWords) },
        ];
    };

    // ---------- 给 Agent 改 ----------
    const touched = (element, patch) => ({ ...element, ...patch, version: element.version + 1, versionNonce: Math.floor(Math.random() * 2147483647), updated: Date.now() });
    const listOf = (value, name) => {
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value)) throw new Error(`${name} 必须是数组。`);
        return value;
    };
    // 新箭头连到板上已有的元素：官方转换只认同一批里的 id，所以把被连的元素也一起交进去算好绑定，转换完丢掉替身，只把绑定记到真元素上。
    function convert(asked, byId) {
        const routed = new Set(); // 两端都连元素、没写坐标的箭头：先放下，等框的尺寸定了由 followArrows 接到框边
        const add = asked.map((item) => {
            if (!['arrow', 'line'].includes(item?.type) || item.points) return item;
            if (item.start?.id && item.end?.id && item.x === undefined && item.y === undefined) {
                const id = item.id ? String(item.id) : `arrow-${crypto.randomUUID().slice(0, 8)}`;
                routed.add(id);
                return { ...item, id, x: 0, y: 0, points: [[0, 0], [1, 1]] };
            }
            // 官方把箭头的 width: 0 当成没填，换成默认的 100，竖直、水平的箭头就歪了。写成 points 就照实算。
            return item.width !== undefined || item.height !== undefined ? { ...item, points: [[0, 0], [Number(item.width) || 0, Number(item.height) || 0]] } : item;
        });
        const referred = new Set();
        for (const item of add) for (const end of [item?.start, item?.end]) if (end?.id && byId.has(String(end.id))) referred.add(String(end.id));
        const standIns = [...referred].map((id) => {
            const { type, x, y, width, height } = byId.get(id);
            return type === 'text' ? { type, id, x, y, text: byId.get(id).text } : { type, id, x, y, width, height };
        });
        const out = X.convertToExcalidrawElements([...standIns, ...add], { regenerateIds: false });
        const bound = new Map(out.filter((element) => referred.has(element.id)).map((element) => [element.id, element.boundElements || []]));
        return { created: out.filter((element) => !referred.has(element.id)), bound, routed };
    }
    // 挪了框，连着的箭头跟过去：官方的跟随逻辑不在公开接口里。两点的直箭头按两端框的中心重连到框边，留 6 像素；折线不动。
    function edgeToward(box, point) {
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;
        const dx = point.x - centerX;
        const dy = point.y - centerY;
        const scale = Math.min(dx ? (box.width / 2 + 6) / Math.abs(dx) : Infinity, dy ? (box.height / 2 + 6) / Math.abs(dy) : Infinity);
        return Number.isFinite(scale) ? { x: centerX + dx * scale, y: centerY + dy * scale } : { x: centerX, y: centerY };
    }
    function followArrows(elements, moved, routed = new Set()) {
        if (!moved.size && !routed.size) return elements;
        const byId = new Map(elements.map((element) => [element.id, element]));
        const middle = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
        const labels = new Map();
        const next = elements.map((element) => {
            if (element.type !== 'arrow' || element.isDeleted || element.points?.length !== 2) return element;
            const from = byId.get(element.startBinding?.elementId);
            const to = byId.get(element.endBinding?.elementId);
            if (!moved.has(from?.id) && !moved.has(to?.id) && !routed.has(element.id)) return element;
            const startFree = { x: element.x + element.points[0][0], y: element.y + element.points[0][1] };
            const endFree = { x: element.x + element.points[1][0], y: element.y + element.points[1][1] };
            const start = from ? edgeToward(from, to ? middle(to) : endFree) : startFree;
            const end = to ? edgeToward(to, from ? middle(from) : startFree) : endFree;
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            labels.set(element.id, { x: start.x + dx / 2, y: start.y + dy / 2 });
            return touched(element, { x: start.x, y: start.y, width: Math.abs(dx), height: Math.abs(dy), points: [[0, 0], [dx, dy]] });
        });
        return next.map((element) => (labels.has(element.containerId)
            ? touched(element, { x: labels.get(element.containerId).x - element.width / 2, y: labels.get(element.containerId).y - element.height / 2 }) : element));
    }
    const within = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
    // 回执里告诉 Agent 这次动过的元素压住了谁。整个包在空框里的不算（分区的底框），有字的卡片里压着东西算。
    // 两点的直箭头穿过这个框没有（线段裁剪）。
    function runsThrough(arrow, box) {
        const [dx, dy] = arrow.points.at(-1);
        let from = 0;
        let to = 1;
        for (const [p, q] of [[-dx, arrow.x - box.x], [dx, box.x + box.width - arrow.x], [-dy, arrow.y - box.y], [dy, box.y + box.height - arrow.y]]) {
            if (!p) {
                if (q < 0) return false;
            } else if (p < 0) {
                from = Math.max(from, q / p);
            } else {
                to = Math.min(to, q / p);
            }
        }
        return from < to;
    }
    function crowdedPairs(changedIds) {
        const all = live();
        const labelled = labelsOf(all);
        const boxes = all.filter((element) => !element.containerId && !['arrow', 'line', 'freedraw', 'frame'].includes(element.type));
        const pairs = [];
        const inside = (a, b) => !labelled.has(b.id) && within(a, b);
        for (let i = 0; i < boxes.length && pairs.length < 10; i += 1) {
            for (let k = i + 1; k < boxes.length && pairs.length < 10; k += 1) {
                const a = boxes[i];
                const b = boxes[k];
                if (!changedIds.has(a.id) && !changedIds.has(b.id)) continue;
                if (overlaps(a, b) && !inside(a, b) && !inside(b, a)) pairs.push([a.id, b.id]);
            }
        }
        for (const arrow of all.filter((element) => element.type === 'arrow' && element.points?.length === 2)) {
            const ends = [arrow.startBinding?.elementId, arrow.endBinding?.elementId];
            for (const box of boxes.filter((item) => labelled.has(item.id) && !ends.includes(item.id))) {
                if (pairs.length < 10 && [arrow.id, box.id, ...ends].some((id) => changedIds.has(id)) && runsThrough(arrow, box)) pairs.push([arrow.id, box.id]);
            }
        }
        return pairs;
    }
    // 回执里告诉 Agent 这次新写的卡片哪些还没和别的连上。连着箭头、放在分区里、编了组都算连上。
    function looseCards(newIds) {
        const all = live();
        const labelled = labelsOf(all);
        const joined = new Set(all.flatMap((element) => [element.startBinding?.elementId, element.endBinding?.elementId]));
        const zones = all.filter((element) => !element.containerId && !labelled.has(element.id) && ['rectangle', 'ellipse', 'diamond'].includes(element.type));
        return all.filter((element) => newIds.has(element.id) && labelled.has(element.id) && !['arrow', 'line'].includes(element.type) && !joined.has(element.id)
            && !element.groupIds?.length && !zones.some((zone) => zone.id !== element.id && within(element, zone))).map((element) => element.id);
    }
    async function update(payload = {}) {
        if (!scene) throw new Error('白板还没有打开。');
        settle();
        const current = stamp();
        if (String(payload.expectedRevision ?? '') !== current) {
            throw new Error(`白板已经变了，当前修订是 ${current}，这次没有改。用 GetBoard 带 sinceRevision 看变了什么，再带新的 expectedRevision 重交。`);
        }
        const add = listOf(payload.add, 'add');
        const patches = listOf(payload.update, 'update');
        const removals = listOf(payload.delete, 'delete').map(String);
        const background = payload.background ? String(payload.background) : '';
        if (background && !CSS.supports('color', background)) throw new Error(`background 不是颜色：${background}。`);
        if (!add.length && !patches.length && !removals.length && !background) throw new Error('add、update、delete、background 至少要有一项。');
        const all = scene.getSceneElementsIncludingDeleted();
        const byId = new Map(all.filter((element) => !element.isDeleted).map((element) => [element.id, element]));
        const missing = [...patches.map((item) => String(item?.id)), ...removals].filter((id) => !byId.has(id));
        if (missing.length) throw new Error(`白板上没有这些元素：${missing.join('、')}。`);
        const taken = add.map((item) => item?.id).filter((id) => id && byId.has(String(id)));
        if (taken.length) throw new Error(`这些 id 已经用过了：${taken.join('、')}。`);
        const batch = new Set(add.map((item) => String(item?.id)));
        const absent = add.flatMap((item) => [item?.start?.id, item?.end?.id, item?.below, item?.right]).filter((id) => id && !byId.has(String(id)) && !batch.has(String(id)));
        if (absent.length) throw new Error(`连到或靠着的元素不存在：${absent.join('、')}。`);

        // 官方按手写字体量字来折行；字体没载入时按备用字体量，载入后字变宽，会顶到框边。
        const words = JSON.stringify([add, patches]).slice(0, 20000);
        await Promise.all(['Excalifont', 'Xiaolai'].map((family) => document.fonts.load(`20px "${family}"`, words).catch(() => null)));
        if (stamp() !== current) throw new Error('白板刚刚变了，这次没有改。用 GetBoard 重读后再交。');
        const before = serialize();
        const { created, bound, routed } = convert(fitCards(add, byId), byId);
        const gone = new Set(removals);
        for (const element of all) if (element.containerId && gone.has(element.containerId)) gone.add(element.id);
        const patchOf = new Map(patches.map((item) => [String(item.id), item]));
        const extra = [];
        const next = all.map((element) => {
            if (gone.has(element.id)) return touched(element, { isDeleted: true });
            const patch = {};
            const asked = patchOf.get(element.id);
            for (const [key, value] of Object.entries(asked || {})) if (PATCHABLE.has(key)) patch[key] = value;
            if (asked?.text !== undefined && element.type === 'text') Object.assign(patch, { text: String(asked.text), originalText: String(asked.text) });
            const owner = element.containerId ? patchOf.get(element.containerId) : null;
            const box = owner ? byId.get(element.containerId) : null;
            if (owner && box.type !== 'arrow') {
                // 框挪了、换了大小，框里的字跟着走（官方的跟随不在公开接口里）。
                const offset = (key, size) => Number(owner[key] ?? box[key]) - box[key] + (Number(owner[size] ?? box[size]) - box[size]) / 2;
                Object.assign(patch, { x: element.x + offset('x', 'width'), y: element.y + offset('y', 'height') });
            }
            if (owner?.fontSize !== undefined) patch.fontSize = Number(owner.fontSize);
            if (owner?.label !== undefined) {
                const value = box.type === 'arrow' || manualFit() ? String(owner.label) : evenLines(owner.label, Number(owner.fontSize ?? element.fontSize), innerWidth(Number(owner.width ?? box.width))).join('\n');
                Object.assign(patch, { text: value, originalText: value });
            }
            if (asked?.label !== undefined && !element.boundElements?.some((item) => item.type === 'text')) {
                const { type, x, y, width, height } = element;
                const made = X.convertToExcalidrawElements([{ type, id: element.id, x, y, width, height, label: { text: String(asked.label) } }], { regenerateIds: false });
                extra.push(...made.filter((item) => item.id !== element.id));
                patch.boundElements = made.find((item) => item.id === element.id).boundElements;
            }
            if (bound.has(element.id)) patch.boundElements = [...(patch.boundElements || element.boundElements || []), ...bound.get(element.id).filter((item) => item.type !== 'text')];
            if (element.boundElements?.some((item) => gone.has(item.id))) patch.boundElements = (patch.boundElements || element.boundElements).filter((item) => !gone.has(item.id));
            if (gone.has(element.startBinding?.elementId)) patch.startBinding = null;
            if (gone.has(element.endBinding?.elementId)) patch.endBinding = null;
            return Object.keys(patch).length ? touched(element, patch) : element;
        });
        const fixed = X.restoreElements([...next, ...created, ...extra], null, { refreshDimensions: true, repairBindings: true });
        const moved = new Set(patches.filter((item) => ['x', 'y', 'width', 'height'].some((key) => key in item)).map((item) => String(item.id)));
        const newIds = new Set([...created, ...extra].map((element) => element.id));
        const changedIds = new Set([...newIds, ...patchOf.keys(), ...fixed.filter((element) => element.containerId && patchOf.has(element.containerId)).map((element) => element.id)]);
        const elements = followArrows(fixed, moved, routed).map((element) => (changedIds.has(element.id) || (moved.size && element.type === 'arrow')
            ? { ...element, customData: { ...element.customData, ...(newIds.has(element.id) ? { uttuBy: 'agent' } : {}), uttuAgentAt: Date.now() } } : element));
        scene.updateScene({ elements, ...(background ? { appState: { viewBackgroundColor: background } } : {}), captureUpdate: X.CaptureUpdateAction.IMMEDIATELY });
        if (background) applyLook(lookFor(file.filePath, background));
        await nextFrames();
        settle();
        const saved = await save();
        const after = serialize();
        void api().view('history-add', { file: file.filePath, before, after }).then(() => UI.emit('view-file-changed'));
        return { revision: stamp(), added: created.filter((element) => !element.containerId).map((element) => element.id),
            updated: [...patchOf.keys()], deleted: removals, saved, crowded: crowdedPairs(changedIds), loose: looseCards(newIds) };
    }

    async function pictureOf(elements) {
        const blob = await X.exportToBlob({ elements, files: scene.getFiles(), mimeType: 'image/png', exportPadding: 24, maxWidthOrHeight: PICTURE_EDGE,
            appState: { ...scene.getAppState(), exportBackground: true, exportWithDarkMode: false } });
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }
    // 空白板回 null，照常截窗口。
    function picture(payload = {}) {
        const all = live();
        if (!all.length) return null;
        let chosen = all;
        if (Array.isArray(payload.ids) && payload.ids.length) {
            const wanted = new Set(payload.ids.map(String));
            chosen = all.filter((element) => wanted.has(element.id) || wanted.has(element.containerId));
        } else if (asRegion(payload.region)) {
            const region = asRegion(payload.region);
            const inside = new Set(all.filter((element) => overlaps(boundsOf(element), region)).map((element) => element.id));
            chosen = all.filter((element) => inside.has(element.id) || inside.has(element.containerId));
        }
        if (!chosen.length) throw new Error('这个范围里没有元素。');
        return pictureOf(chosen);
    }

    // ---------- 复制引用：位置按场景坐标记，选中的元素 id 一起记下。----------
    function toScreen(x, y) {
        const point = X.sceneCoordsToViewportCoords({ sceneX: x, sceneY: y }, scene.getAppState());
        const box = stage.getBoundingClientRect();
        return { x: point.x - box.left, y: point.y - box.top };
    }
    function describe(chosen, box) {
        const words = chosen.map((element) => element.originalText ?? element.text).filter(Boolean);
        const ids = [...new Set(chosen.map((element) => element.containerId || element.id))]; // 框里的字归到框上，和 GetBoard 给的 id 一致
        const area = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
        const place = `场景坐标 x ${area.x}，y ${area.y}，宽 ${area.width}，高 ${area.height}${ids.length ? `，元素 ${ids.slice(0, 12).join('、')}` : ''}`;
        return { type: 'region', label: ids.length ? `${ids.length} 个元素` : '空白区域', place, text: words.join(' ').replace(/\s+/g, ' ').trim().slice(0, 80),
            locator: { type: 'region', rect: area, elements: ids } };
    }
    function selectionTarget() {
        if (!scene) return null;
        const ids = scene.getAppState().selectedElementIds || {};
        const all = live();
        const chosen = all.filter((element) => ids[element.id] || ids[element.containerId]);
        if (!chosen.length) return null;
        const boxes = chosen.map(boundsOf);
        const left = Math.min(...boxes.map((box) => box.x));
        const top = Math.min(...boxes.map((box) => box.y));
        const box = { x: left, y: top, width: Math.max(...boxes.map((item) => item.x + item.width)) - left, height: Math.max(...boxes.map((item) => item.y + item.height)) - top };
        const from = toScreen(box.x, box.y);
        const to = toScreen(box.x + box.width, box.y + box.height);
        const shown = { x: Math.max(0, from.x), y: Math.max(0, from.y), width: Math.min(stage.clientWidth, to.x) - Math.max(0, from.x), height: Math.min(stage.clientHeight, to.y) - Math.max(0, from.y) };
        return { ...describe(chosen, box), capture: Pick.windowRect(stage, shown) };
    }

    // ---------- 键盘和菜单 ----------
    // 开着白板时上游的 Ctrl S / Z / Y 不能落到藏在后面的文稿上。
    window.addEventListener('keydown', (event) => {
        if (!file || !(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = event.key.toLowerCase();
        if (key === 's') {
            event.preventDefault();
            event.stopImmediatePropagation();
            void save();
        } else if (['z', 'y'].includes(key) && !work.contains(event.target)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
    work.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) event.stopPropagation();
    });
    UI.on('start', () => {
        session()?.subscribe?.((event) => {
            if (file && event?.type === 'document-replaced' && !UI.replacedByLastOpen()) setTimeout(leave, 0);
        });
    });

    async function create() {
        try {
            const result = await api().view('board-new');
            if (!result?.success) throw new Error(result?.error || '建不出来');
            await session()?.openPath?.(result.filePath);
        } catch (error) {
            UI.toast(`没建好白板：${error.message}`, 'error', 5000);
        }
    }
    async function exportPng() {
        if (!file || !live().length) return;
        try {
            const picturePng = await pictureOf(live());
            const result = await api().view('board-png', { file: file.filePath, base64: picturePng.split(',')[1] });
            if (!result?.success) throw new Error(result?.error || '写不进去');
            UI.toast(`图片存在 ${result.filePath.split(/[\\/]/).pop()}`);
        } catch (error) {
            UI.toast(`没导出：${error.message}`, 'error', 5000);
        }
    }
    function fileItems({ openNewDialog, open: openFile }) {
        const has = Boolean(file);
        return [
            { label: '新建', k: 'Ctrl N', act: openNewDialog },
            { label: '新建白板', act: () => void create() },
            { label: '新建设计', act: () => void window.UTTUScriptoriumDesign?.create() },
            { label: '打开文件', k: 'Ctrl O', act: openFile },
            { label: '打开文件夹', act: () => window.UTTUScriptoriumFolder?.choose?.() },
            { sep: true },
            { label: '保存', k: 'Ctrl S', disabled: !has || !dirty, act: () => void save() },
            { label: '导出 PNG', disabled: !has || !scene || !live().length, act: () => void exportPng() },
            { label: '重新载入', k: 'F5', hint: dirty ? '放弃没存的修改' : '', disabled: !has, act: () => void reload({ discard: true }) },
            { label: '在文件夹里显示', disabled: !has, act: () => void api()?.files?.('reveal', { path: file?.filePath }).catch(() => {}) },
            { label: '关闭', disabled: !has, act: () => void close() },
        ];
    }

    const view = Object.freeze({
        claims: isBoard,
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
        agent: Object.freeze({ text, surface: () => stage, picture, board: Object.freeze({ read, update }) }),
        turnAgents: () => ({ list: agentList, current: turnAgent, set: (name) => { try { localStorage.setItem(AGENT_KEY, name); } catch (_) { /* 只在这次用 */ } } }),
        // 画布载完才算打开：OpenDocument 等的就是这里。
        doc: () => (file && !loading ? Object.freeze({ kind: 'board', filePath: file.filePath, name: file.name, generation: file.generation,
            dirty, saving: file.saving, revision: snapshots.at(-1)?.stamp || 0 }) : null),
        _state: () => ({ file: file && { ...file }, dirty, snapshots: snapshots.length, mounted: Boolean(scene), elements: scene ? live().length : 0, scene }),
    });
    window.UTTUScriptoriumBoard = view;
    UI.registerOverlay?.(view);
})();
