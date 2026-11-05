// 文坊中的白板（.excalidraw）。文件在原位置打开，使用官方格式，保存回原文件。
// 画布为官方 Excalidraw（vendor/excalidraw，由 scripts/build-excalidraw.mjs 打包），打开白板时才载入，离开时卸载。
// 文件被外部修改时自动刷新，两边都修改过时在栏头询问保留哪一边。画布明暗跟随文坊的主题。
// 人和 Agent 编辑同一份场景。Agent 通过 read、update（ScriptoriumCollaborator 的 GetBoard、UpdateBoard）按元素 id 读取和增改，
// 修改须带 expectedRevision，与当前修订不一致时拒绝，不整板替换；修改进入官方的撤销栈，可用 Ctrl+Z 撤销，由用户保存。
(() => {
    'use strict';
    const UI = window.ScriptoriumFileViews;
    const Types = window.ScriptoriumFileTypes;
    if (!UI?.on || !Types) return;
    const { make, button } = UI;
    const Model = window.ScriptoriumBoardModel;
    const api = () => window.scriptoriumAPI;
    const session = () => window.ScriptoriumFileSession;
    const isBoard = (file) => Types.kindOf(file) === 'board';
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const welcomeShown = () => document.getElementById('welcome-state')?.hidden === false;
    const nextFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const themeOf = () => (document.body.classList.contains('light-theme') ? 'light' : 'dark');

    const LIST_DEFAULT = 200;
    const LIST_MOST = 1000;
    const SNAPSHOTS = 24; // sinceRevision 可回看的修订数
    const PICTURE_EDGE = 1600;
    const PATCHABLE = new Set(['x', 'y', 'width', 'height', 'angle', 'strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle',
        'roughness', 'opacity', 'fontSize', 'fontFamily', 'textAlign', 'verticalAlign', 'link', 'locked', 'groupIds', 'points']);

    let X = null; // 打包后的 Excalidraw
    let scene = null; // Excalidraw 的 API
    let unmount = null;
    let file = null; // { filePath, name, mtime, generation, saving, saved }
    let generation = 0;
    let dirty = false;
    let loading = false;
    let settleTimer = 0;
    let vendor = null;
    let libraryTimer = 0;
    let snapshots = []; // [{ stamp, versions: Map(元素 id → version) }]

    const work = make('div', 'scriptorium-board-work');
    work.hidden = true;
    work.setAttribute('aria-label', '白板');
    const head = make('div', 'scriptorium-pane-head');
    const label = make('span', 'scriptorium-pane-label', '白板');
    const conflict = make('span', 'scriptorium-file-conflict');
    conflict.hidden = true;
    conflict.append(make('span', '', '文件已在别处修改'),
        button('scriptorium-file-button', '', '使用文件中的版本', () => void reload({ discard: true })),
        button('scriptorium-file-button', '', '保留我的修改', () => void save({ force: true })));
    head.append(label, make('span', 'grow'), conflict);
    const stage = make('div', 'scriptorium-board-stage');
    const host = make('div', 'scriptorium-board-host');
    stage.append(host);
    const htmlLayer = window.ScriptoriumBoardHtml.create({ stage, model: Model, onEdit: (id) => void editHtmlDialog(id) });
    head.append(button('scriptorium-file-button', '保存白板', '保存', () => void save()),
        button('scriptorium-file-button', '返回文坊首页', '首页', () => UI.forward('home-btn')),
        button('scriptorium-file-button', '添加 HTML 节点', '+ HTML', () => void editHtmlDialog(null)),
        button('scriptorium-file-button', '白板另存为', '另存为', () => void save({ saveAs: true })));
    work.append(head, stage);
    const lineage = window.ScriptoriumBoardLineage.create({
        parent: work,
        snapshot: () => sceneData(),
        revision: () => stamp(),
        changed: () => { if (file && scene) settle(); },
        apply: update,
        save: () => save(),
        restore: async (data) => { applyToScene(data); await nextFrames(); settle(); },
        error: (error) => UI.toast(error.message, 'error', 5000),
    });
    head.append(button('scriptorium-file-button', '白板文脉与审批设置', '文脉', () => lineage.toggle()),
        button('scriptorium-file-button', '重命名白板', '重命名', () => void renameDialog()),
        button('scriptorium-file-button', '打开所在文件夹', '定位文件', () => {
            if (file) void api().view('board-reveal', { file: file.filePath }).catch((error) => UI.toast(error.message, 'error'));
        }));
    const workspace = document.getElementById('document-workspace');
    (workspace?.parentElement || document.body).append(work);

    function loadVendor() {
        if (vendor) return vendor;
        window.EXCALIDRAW_ASSET_PATH = new URL('../vendor/excalidraw/', location.href).href; // 字体从本地加载，不访问官方 CDN
        vendor = new Promise((resolve, reject) => {
            const style = document.createElement('link');
            style.rel = 'stylesheet';
            style.href = '../vendor/excalidraw/excalidraw.css';
            document.head.append(style);
            const tag = document.createElement('script');
            tag.src = '../vendor/excalidraw/excalidraw.js';
            tag.onload = () => resolve(window.ScriptoriumExcalidraw);
            tag.onerror = () => {
                vendor = null;
                reject(new Error('白板组件未能载入。'));
            };
            document.head.append(tag);
        });
        return vendor;
    }

    // ---------- 场景 ----------
    const live = () => X.getNonDeletedElements(scene.getSceneElementsIncludingDeleted());
    const stamp = () => `${X.hashElementsVersion(live())}-${scene.getAppState().viewBackgroundColor}`;
    const sceneData = () => JSON.parse(X.serializeAsJSON(scene.getSceneElementsIncludingDeleted(), scene.getAppState(), scene.getFiles(), 'local'));
    const serialize = () => JSON.stringify({ ...sceneData(), vcpBoard: lineage.serialize() }, null, 2);
    function parse(text) {
        if (!String(text).trim()) return { elements: [], appState: {}, files: {} };
        const data = JSON.parse(text);
        if (data?.type !== 'excalidraw' || !Array.isArray(data.elements)) throw new Error('该文件不是 Excalidraw 白板。');
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
        const value = remember();
        const was = dirty;
        dirty = value !== file.saved || lineage.revision() !== file.savedMeta;
        label.textContent = `${file.name} · ${file.saving ? '正在保存' : dirty ? '未保存' : '已保存'}`;
        if (dirty !== was) UI.sync?.();
    }
    // 拖动时 onChange 持续触发，停下后才计为一次修改。
    function changed() {
        if (scene) htmlLayer.sync(live(), scene.getAppState());
        clearTimeout(settleTimer);
        settleTimer = setTimeout(settle, 120);
    }
    // 画布明暗跟随文坊的主题。
    new MutationObserver(() => { if (scene) scene.updateScene({ appState: { theme: themeOf() } }); })
        .observe(document.body, { attributes: true, attributeFilter: ['class'] });

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
        await new Promise((resolve) => {
            unmount = X.mount(host, {
                excalidrawAPI: (value) => { scene = value; resolve(); },
                initialData: { elements: restored.elements, appState: { ...restored.appState, theme: themeOf(), collaborators: new Map() }, files: restored.files, libraryItems, scrollToContent: true },
                langCode: 'zh-CN',
                aiEnabled: false,
                autoFocus: true,
                handleKeyboardGlobally: false, // 快捷键只在画布中生效，不影响文坊其他位置
                UIOptions: { canvasActions: { changeViewBackgroundColor: true, clearCanvas: true, export: false, loadScene: false, saveAsImage: false, saveToActiveFile: false, toggleTheme: false } },
                onChange: changed,
                onLibraryChange: libraryChanged,
                onLinkOpen: openLink,
            });
        });
        // 官方的初始载入是异步的，载入完成才算打开，否则紧接着的 Agent 修改会被覆盖。隐藏的窗口没有动画帧，用定时器等待。
        for (let tries = 0; scene?.getAppState().isLoading && tries < 500; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        // 打开时显示全貌：内容超出窗口时缩小，不放大。
        if (restored.elements.length) scene?.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1, animate: false });
    }
    function unmountCanvas() {
        htmlLayer.clear();
        unmount?.();
        unmount = null;
        scene = null;
    }
    // 官方的恢复过程可能修正部分字段，以恢复后的状态作为“未修改”的基准。
    function baseline() {
        snapshots = [];
        file.saved = remember();
        file.savedMeta = lineage.revision();
        dirty = false;
        label.textContent = `${file.name} · 已保存`;
    }

    function leave() {
        if (!file) return;
        clearTimeout(settleTimer);
        unmountCanvas();
        file = null;
        lineage.load(null);
        dirty = false;
        snapshots = [];
        document.body.classList.remove('scriptorium-board-mode');
        work.hidden = true;
        conflict.hidden = true;
        void api()?.view?.('watch', { file: null }).catch(() => {});
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
            if (!result?.success) throw new Error(result?.error || '读取失败');
            data = parse(result.text);
            X = await loadVendor();
        } catch (error) {
            UI.toast(`未能打开这个白板：${error.message}`, 'error', 5000);
            return false;
        }
        if (file) {
            clearTimeout(settleTimer);
            unmountCanvas();
        }
        file = { filePath: result.filePath, name: result.name, mtime: result.mtime, generation: ++generation, saving: false, saved: '' };
        conflict.hidden = true;
        document.body.classList.add('scriptorium-board-mode');
        work.hidden = false;
        loading = true;
        lineage.load(data.vcpBoard);
        UI.sync?.();
        await mount(data);
        loading = false;
        baseline();
        void api().view('watch', { file: result.filePath }).catch(() => {});
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

    async function save({ force = false, saveAs = false } = {}) {
        if (!file || !scene) return false;
        settle();
        if (!dirty && !force && !saveAs) return true;
        if (file.saving) return false;
        const target = file;
        const savedStamp = stamp();
        const savedMeta = lineage.revision();
        const text = serialize();
        target.saving = true;
        UI.sync?.();
        let result;
        try {
            result = await api().view(saveAs ? 'board-save-as' : 'save', { file: target.filePath, text, mtime: target.mtime, eol: 'lf', bom: false, force });
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
            if (!result?.canceled) UI.toast(`未能保存：${result?.error || '写入失败'}`, 'error', 5000);
            UI.sync?.();
            return false;
        }
        if (result.filePath && !same(file.filePath, result.filePath)) {
            file.filePath = result.filePath;
            file.name = result.name;
            file.generation = ++generation;
            await api().view('watch', { file: file.filePath });
            if (file !== target) return true;
        }
        file.mtime = result.mtime;
        file.saved = savedStamp;
        file.savedMeta = savedMeta;
        conflict.hidden = true;
        dirty = stamp() !== savedStamp || lineage.revision() !== savedMeta;
        label.textContent = `${file.name} · ${dirty ? '未保存' : '已保存'}`;
        UI.sync?.();
        return true;
    }
    function applyToScene(data) {
        const restored = X.restore(data, null, null, { repairBindings: true });
        const known = scene.getFiles();
        const added = Object.values(restored.files || {}).filter((item) => !known[item.id]);
        if (added.length) scene.addFiles(added);
        scene.updateScene({ elements: restored.elements, appState: { viewBackgroundColor: restored.appState.viewBackgroundColor }, captureUpdate: X.CaptureUpdateAction.NEVER });
    }
    async function reload({ discard = false } = {}) {
        if (!file || !scene) return;
        settle();
        if (dirty && !discard) return;
        const result = await readFile(file.filePath);
        if (!file || !result?.success) {
            if (result && !result.success) UI.toast(`未能重新读取：${result.error || ''}`, 'error', 5000);
            return;
        }
        let data;
        try {
            data = parse(result.text);
        } catch (error) {
            UI.toast(`文件当前无法打开：${error.message}`, 'error', 5000);
            return;
        }
        file.mtime = result.mtime;
        conflict.hidden = true;
        lineage.load(data.vcpBoard);
        applyToScene(data);
        await nextFrames();
        file.saved = remember();
        file.savedMeta = lineage.revision();
        dirty = false;
        UI.sync?.();
    }
    api()?.onViewChanged?.((payload) => {
        if (!file || !scene || !same(payload?.file, file.filePath) || Math.abs(Number(payload.mtime) - file.mtime) <= 1) return;
        settle();
        if (dirty) conflict.hidden = false;
        else void reload();
    });
    UI.on('disk-check', () => { if (file) void api()?.view?.('check').catch(() => {}); });

    // ---------- 供 Agent 读取 ----------
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
        if (element.customData?.scriptoriumBy === 'agent') out.by = 'agent';
        if (element.customData?.vcpHtml) {
            out.type = 'html';
            out.title = element.customData.vcpHtml.title;
            out.sourceLength = element.customData.vcpHtml.source.length;
        }
        return out;
    }
    const labelsOf = (all) => new Map(all.filter((element) => element.containerId).map((element) => [element.containerId, element.originalText ?? element.text]));
    const asRegion = (region) => (region && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(Number(region[key])))
        ? { x: Number(region.x), y: Number(region.y), width: Number(region.width), height: Number(region.height) } : null);
    function read(payload = {}) {
        settle();
        const all = live();
        const top = all.filter((element) => !element.containerId); // 容器中的文字作为容器的 label
        let list = top;
        let removed;
        if (payload.sinceRevision) {
            const base = snapshots.find((item) => item.stamp === String(payload.sinceRevision));
            if (!base) throw new Error(`修订 ${payload.sinceRevision} 已不在记录中（只保留最近 ${SNAPSHOTS} 次）。请不带 sinceRevision 重新读取。`);
            const touchedIds = new Set(all.filter((element) => base.versions.get(element.id) !== element.version).map((element) => element.containerId || element.id));
            const present = new Set(all.map((element) => element.id));
            list = list.filter((element) => touchedIds.has(element.id));
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
        return { revision: stamp(), background: scene.getAppState().viewBackgroundColor, total: top.length, matched: list.length, truncated: list.length > limit,
            elements: list.slice(0, limit).map((element) => compact(element, labels)), ...(removed ? { removed } : {}) };
    }
    function text() {
        if (!scene) return '';
        const all = live();
        const words = all.filter((element) => element.type === 'text').map((element) => element.originalText ?? element.text);
        return [`白板 ${file?.name || ''}，共 ${all.filter((element) => !element.containerId).length} 个元素`, ...words].join('\n');
    }

    // ---------- 卡片的文字与尺寸 ----------
    // 带 label 的矩形、椭圆、菱形视为卡片：文字按宽度折行并尽量使各行等长；未写宽度时按文字确定，同一批中字号相同的卡片等宽；
    // 未写高度时框高随文字。写明的尺寸照用。位置可写 below、right，相对另一张卡片放置，无需计算坐标。
    const CARD_PAD = { x: 20, y: 14 };
    const CARD_LINES = 3; // 按文字确定宽度时，尽量不超过的行数
    const CARD_GAP = 100; // below、right 默认的间距，可容纳箭头上的文字
    const CJK = '\\u2e80-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef\\u3000-\\u303f';
    const TOKENS = new RegExp(`[${CJK}]|[^\\s${CJK}]+|\\s+`, 'g');
    const NO_LINE_START = /^[，。、；：！？）》」』】,.;:!?)%]/;
    const ruler = document.createElement('canvas').getContext('2d');
    function widthOf(value, size) {
        ruler.font = `${size}px Excalifont, Xiaolai, sans-serif`;
        return ruler.measureText(value).width;
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
    // 行数不变，取最窄的宽度，使各行长度接近。
    function evenLines(value, size, width) {
        return String(value).split('\n').flatMap((line) => {
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
    function naturalWidth(value, size) {
        for (let width = size * 8; width < size * 24; width += size) {
            if (evenLines(value, size, innerWidth(width)).length <= CARD_LINES) return width;
        }
        return size * 24;
    }
    function fitCard(item, width) {
        const size = Number(item.label.fontSize) || 20;
        const lines = String(item.label.text).split('\n').flatMap((line) => wrapAt(line, size, innerWidth(width)));
        return { ...item, width, height: item.height === undefined ? cardHeight(lines, size) : Number(item.height), label: { ...item.label, text: lines.join('\n') } };
    }
    function fitCards(add, byId) {
        const isCard = (item) => ['rectangle', 'ellipse', 'diamond'].includes(item?.type) && item.label?.text !== undefined;
        const shared = new Map();
        for (const item of add.filter((card) => isCard(card) && card.width === undefined)) {
            const size = Number(item.label.fontSize) || 20;
            shared.set(size, Math.max(shared.get(size) || 0, naturalWidth(item.label.text, size)));
        }
        const placed = new Map();
        return add.map((item) => {
            const width = item?.width === undefined ? shared.get(Number(item?.label?.fontSize) || 20) : Number(item.width);
            const { below, right, gap, ...fitted } = isCard(item) ? fitCard(item, width) : item || {};
            const anchor = placed.get(String(below ?? right)) || byId.get(String(below ?? right));
            const space = Number(gap) || CARD_GAP;
            if (anchor && below !== undefined) Object.assign(fitted, { x: fitted.x ?? anchor.x + (anchor.width - fitted.width) / 2, y: fitted.y ?? anchor.y + anchor.height + space });
            else if (anchor) Object.assign(fitted, { x: fitted.x ?? anchor.x + anchor.width + space, y: fitted.y ?? anchor.y + (anchor.height - fitted.height) / 2 });
            if (fitted.id !== undefined) placed.set(String(fitted.id), fitted);
            return fitted;
        });
    }

    // ---------- 供 Agent 修改 ----------
    const touched = (element, patch) => ({ ...element, ...patch, version: element.version + 1, versionNonce: Math.floor(Math.random() * 2147483647), updated: Date.now() });
    const listOf = (value, name) => {
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value)) throw new Error(`${name} 必须是数组。`);
        return value;
    };
    // 新箭头连接到白板上已有的元素：官方转换只识别同一批中的 id，因此将被连接的元素一并交给转换计算绑定，
    // 转换后丢弃这些替身，只把绑定记录到真实元素上。
    function convert(asked, byId) {
        const routed = new Set(); // 两端都连接元素且未写坐标的箭头：先放置，待框的尺寸确定后由 followArrows 连接到框边
        const htmlById = new Map();
        const add = asked.map((item) => {
            if (item?.type === 'html') {
                const id = String(item.id || `html-${crypto.randomUUID()}`);
                const node = Model.htmlNode(item);
                htmlById.set(id, node);
                return { type: 'rectangle', id, x: item.x ?? 0, y: item.y ?? 0,
                    width: node.width, height: node.height, backgroundColor: '#ffffff', fillStyle: 'solid',
                    strokeColor: item.strokeColor || '#7c8fa3', roughness: 0 };
            }
            if (!['arrow', 'line'].includes(item?.type) || item.points) return item;
            if (item.start?.id && item.end?.id && item.x === undefined && item.y === undefined) {
                const id = item.id ? String(item.id) : `arrow-${crypto.randomUUID().slice(0, 8)}`;
                routed.add(id);
                return { ...item, id, x: 0, y: 0, points: [[0, 0], [1, 1]] };
            }
            // 官方将箭头的 width: 0 视为未填写并换成默认的 100，竖直、水平的箭头会因此歪斜；写成 points 则按实际计算。
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
        return { created: out.filter((element) => !referred.has(element.id)).map((element) =>
            htmlById.has(element.id) ? { ...element, customData: { ...element.customData, vcpHtml: htmlById.get(element.id) } } : element), bound, routed };
    }
    // 框移动后，连接的箭头随之移动（官方的跟随逻辑不在公开接口中）。两点直箭头按两端框的中心重新连接到框边，留 6 像素；折线不变。
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
    // 两点直箭头是否穿过这个框（线段裁剪）。
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
    // 回执列出本次修改涉及的重叠：两个框相互压住，或箭头穿过有文字的卡片。完整包含在无文字框（分区底框）中的不计。
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
    // 回执列出本次新增、尚未与其他元素建立关系的卡片：连有箭头、位于分区内或已编组的视为已建立关系。
    function looseCards(newIds) {
        const all = live();
        const labelled = labelsOf(all);
        const joined = new Set(all.flatMap((element) => [element.startBinding?.elementId, element.endBinding?.elementId]));
        const zones = all.filter((element) => !element.containerId && !labelled.has(element.id) && ['rectangle', 'ellipse', 'diamond'].includes(element.type));
        return all.filter((element) => newIds.has(element.id) && labelled.has(element.id) && !['arrow', 'line'].includes(element.type) && !joined.has(element.id)
            && !element.groupIds?.length && !zones.some((zone) => zone.id !== element.id && within(element, zone))).map((element) => element.id);
    }
    async function update(payload = {}) {
        if (!scene) throw new Error('白板尚未打开。');
        const editingFile = file;
        const editingScene = scene;
        settle();
        const current = stamp();
        if (String(payload.expectedRevision ?? '') !== current) {
            throw new Error(`白板已变化，当前修订为 ${current}，本次未修改。请用 GetBoard 带 sinceRevision 查看变化，再带新的 expectedRevision 重新提交。`);
        }
        const add = listOf(payload.add, 'add');
        const patches = listOf(payload.update, 'update');
        const removals = listOf(payload.delete, 'delete').map(String);
        const background = payload.background ? String(payload.background) : '';
        if (background && !CSS.supports('color', background)) throw new Error(`background 不是有效的颜色：${background}。`);
        if (!add.length && !patches.length && !removals.length && !background) throw new Error('add、update、delete、background 至少需要一项。');
        const all = scene.getSceneElementsIncludingDeleted();
        const byId = new Map(all.filter((element) => !element.isDeleted).map((element) => [element.id, element]));
        const wasEmpty = !byId.size;
        const missing = [...patches.map((item) => String(item?.id)), ...removals].filter((id) => !byId.has(id));
        if (missing.length) throw new Error(`白板上没有这些元素：${missing.join('、')}。`);
        const taken = add.map((item) => item?.id).filter((id) => id && byId.has(String(id)));
        if (taken.length) throw new Error(`这些 id 已被使用：${taken.join('、')}。`);
        const batch = new Set(add.map((item) => String(item?.id)));
        const absent = add.flatMap((item) => [item?.start?.id, item?.end?.id, item?.below, item?.right]).filter((id) => id && !byId.has(String(id)) && !batch.has(String(id)));
        if (absent.length) throw new Error(`连接或相对放置的元素不存在：${absent.join('、')}。`);

        // 官方按手写字体测量文字来折行；字体未载入时按备用字体测量，载入后文字变宽会顶到框边。
        const words = JSON.stringify([add, patches]).slice(0, 20000);
        await Promise.all(['Excalifont', 'Xiaolai'].map((family) => document.fonts.load(`20px "${family}"`, words).catch(() => null)));
        if (file !== editingFile || scene !== editingScene) throw new Error('白板已切换，本次未修改。');
        if (stamp() !== current) throw new Error('白板刚刚发生变化，本次未修改。请用 GetBoard 重新读取后再提交。');
        const { created, bound, routed } = convert(fitCards(add, byId), byId);
        const gone = new Set(removals);
        for (const element of all) if (element.containerId && gone.has(element.containerId)) gone.add(element.id);
        const patchOf = new Map(patches.map((item) => [String(item.id), item]));
        const extra = [];
        const next = all.map((element) => {
            if (gone.has(element.id)) return touched(element, { isDeleted: true });
            const patch = {};
            const asked = patchOf.get(element.id);
            if (asked && element.customData?.vcpHtml && (asked.source !== undefined || asked.title !== undefined || asked.replacements !== undefined)) {
                const old = element.customData.vcpHtml;
                if (asked.source !== undefined && asked.replacements !== undefined) throw new Error('source 与 replacements 不能同时提供。');
                patch.customData = { ...element.customData, vcpHtml: { ...old,
                    title: asked.title === undefined ? old.title : String(asked.title).slice(0, 160),
                    source: asked.replacements !== undefined ? Model.patchSource(old.source, asked.replacements)
                        : asked.source === undefined ? old.source : Model.source(asked.source) } };
            }
            for (const [key, value] of Object.entries(asked || {})) if (PATCHABLE.has(key)) patch[key] = value;
            if (asked?.text !== undefined && element.type === 'text') Object.assign(patch, { text: String(asked.text), originalText: String(asked.text) });
            const owner = element.containerId ? patchOf.get(element.containerId) : null;
            const box = owner ? byId.get(element.containerId) : null;
            if (owner && box.type !== 'arrow') {
                // 框移动或改变尺寸时，框中的文字随之移动（官方的跟随逻辑不在公开接口中）。
                const offset = (key, size) => Number(owner[key] ?? box[key]) - box[key] + (Number(owner[size] ?? box[size]) - box[size]) / 2;
                Object.assign(patch, { x: element.x + offset('x', 'width'), y: element.y + offset('y', 'height') });
            }
            if (owner?.fontSize !== undefined) patch.fontSize = Number(owner.fontSize);
            if (owner?.label !== undefined) {
                const value = box.type === 'arrow' ? String(owner.label) : evenLines(owner.label, Number(owner.fontSize ?? element.fontSize), innerWidth(Number(owner.width ?? box.width))).join('\n');
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
        // 新增的元素在 customData（官方格式留给扩展使用的字段）中记下由 Agent 创建，GetBoard 回执中显示为 by: agent。
        const elements = followArrows(fixed, moved, routed).map((element) => (newIds.has(element.id)
            ? { ...element, customData: { ...element.customData, scriptoriumBy: 'agent' } } : element));
        scene.updateScene({ elements, ...(background ? { appState: { viewBackgroundColor: background } } : {}), captureUpdate: X.CaptureUpdateAction.IMMEDIATELY });
        // 空白板第一次写入内容时，与打开时一样显示全貌。
        if (wasEmpty && live().length) scene.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1, animate: false });
        await nextFrames();
        settle();
        return { revision: stamp(), added: created.filter((element) => !element.containerId).map((element) => element.id),
            updated: [...patchOf.keys()], deleted: removals, saved: false, crowded: crowdedPairs(changedIds), loose: looseCards(newIds) };
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
    // 白板将内容导出为图片，不截取窗口，也不改变用户眼前的画面。空白板返回 null，按窗口截图。
    function picture(payload = {}) {
        const all = live();
        if (all.some((element) => element.customData?.vcpHtml)) {
            if (payload.ids?.length || payload.region) throw new Error('含 HTML 的白板目前只支持实际视口截图，请不带 ids 或 region。');
            return null;
        }
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
        if (!chosen.length) throw new Error('指定范围内没有元素。');
        return pictureOf(chosen);
    }

    function getNodeSource(payload = {}) {
        const node = live().find((element) => element.id === String(payload.id))?.customData?.vcpHtml;
        if (!node) throw new Error('找不到这个 HTML 节点。');
        const lines = node.source.split('\n');
        const startLine = Math.max(1, Math.trunc(Number(payload.startLine) || 1));
        const endLine = Math.min(lines.length, Math.trunc(Number(payload.endLine) || lines.length), startLine + 1999);
        return { id: payload.id, revision: stamp(), title: node.title, sourceKind: 'html',
            startLine, endLine, totalLines: lines.length, source: lines.slice(startLine - 1, endLine).join('\n') };
    }
    async function editHtmlDialog(id) {
        if (!scene) return;
        const baseRevision = stamp();
        const original = id ? live().find((element) => element.id === id)?.customData?.vcpHtml?.source
            : '<div style="padding:24px;font:20px sans-serif">HTML 动画节点</div>';
        if (typeof original !== 'string') throw new Error('HTML 节点已经被删除。');
        const scrim = make('div', 'scriptorium-dlg-scrim');
        const dialog = make('div', 'scriptorium-dlg scriptorium-board-source-dialog');
        const title = make('h4');
        title.textContent = id ? '编辑 HTML 节点' : '新 HTML 节点';
        const input = document.createElement('textarea');
        input.value = original;
        input.setAttribute('aria-label', 'HTML 节点源码');
        const acts = make('div', 'acts');
        acts.append(button('scriptorium-file-button', '', '取消', () => scrim.remove()),
            button('scriptorium-file-button primary', '', '应用', () => {
                void update({ expectedRevision: baseRevision,
                    ...(id ? { update: [{ id, source: input.value }] } : { add: [{ id: `html-${crypto.randomUUID()}`, type: 'html', source: input.value }] })
                }).then(() => scrim.remove()).catch((error) => UI.toast(error.message, 'error', 5000));
            }));
        dialog.append(title, input, acts);
        scrim.append(dialog);
        document.body.append(scrim);
        input.focus();
    }

    // ---------- 键盘与新建 ----------
    // 打开白板时，撤销、重做不作用到后面的文稿上（保存由 scriptorium-file-views.js 统一处理）。
    window.addEventListener('keydown', (event) => {
        if (!file || !(event.ctrlKey || event.metaKey) || event.altKey) return;
        if (['z', 'y'].includes(event.key.toLowerCase()) && !work.contains(event.target)) {
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

    const creationJobs = new Map();
    function createArtifact(payload = {}) {
        const key = String(payload.requestId || '');
        if (key && creationJobs.has(key)) return creationJobs.get(key);
        const task = buildBoardArtifact(payload);
        if (key) {
            creationJobs.set(key, task);
            task.catch(() => { if (creationJobs.get(key) === task) creationJobs.delete(key); });
            if (creationJobs.size > 128) creationJobs.delete(creationJobs.keys().next().value);
        }
        return task;
    }
    async function buildBoardArtifact(payload = {}) {
        X = await loadVendor();
        const asked = listOf(payload.elements ?? payload.add, 'elements');
        await Promise.all(['Excalifont', 'Xiaolai'].map((family) => document.fonts.load(`20px "${family}"`).catch(() => null)));
        const { created, routed } = convert(fitCards(asked, new Map()), new Map());
        const fixed = X.restoreElements(created, null, { refreshDimensions: true, repairBindings: true });
        const elements = followArrows(fixed, new Set(), routed).map((element) => ({
            ...element, customData: { ...element.customData, scriptoriumBy: 'agent' },
        }));
        const initial = { type: 'excalidraw', version: 2, source: 'vcp-scriptorium',
            elements, appState: { viewBackgroundColor: payload.background || '#ffffff' }, files: {} };
        const result = await api().view('board-new', { name: payload.name || payload.title, scene: initial });
        if (!result?.success) throw new Error(result?.error || '创建失败');
        let opened = false;
        if (payload.openAfterCreate !== false) opened = Boolean(await session()?.openPath?.(result.filePath));
        return { ...result, saved: true, opened, elementCount: created.filter((element) => !element.containerId).length };
    }
    async function agentSave(payload = {}) {
        if (String(payload.expectedRevision ?? '') !== stamp()) throw new Error('白板修订已变化，请重新读取。');
        const saved = await save();
        return { success: saved, saved, revision: stamp(), filePath: file?.filePath };
    }
    async function renameDialog() {
        if (!file || file.saving) return;
        const target = file;
        const scrim = make('div', 'scriptorium-dlg-scrim');
        const form = make('form', 'scriptorium-dlg');
        const title = make('h4');
        title.textContent = '重命名白板';
        const input = document.createElement('input');
        input.value = file.name.replace(/\.excalidraw$/i, '');
        input.required = true;
        input.setAttribute('aria-label', '新白板名称');
        const submit = button('scriptorium-file-button primary', '', '重命名', null);
        submit.type = 'submit';
        form.append(title, input, button('scriptorium-file-button', '', '取消', () => scrim.remove()), submit);
        scrim.append(form);
        document.body.append(scrim);
        input.focus();
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (submit.disabled || target !== file || file.saving) return;
            submit.disabled = true;
            target.saving = true;
            try {
                const result = await api().view('board-rename', { file: target.filePath, mtime: target.mtime, name: input.value });
                if (!result.success) throw new Error(result.error);
                if (file === target) {
                    file.filePath = result.filePath;
                    file.name = result.name;
                    file.mtime = result.mtime ?? file.mtime;
                    file.generation = ++generation;
                    await api().view('watch', { file: file.filePath });
                }
                scrim.remove();
            } catch (error) { UI.toast(error.message, 'error', 5000); }
            finally { target.saving = false; submit.disabled = false; UI.sync(); }
        });
    }
    async function create() {
        const scrim = make('div', 'scriptorium-dlg-scrim');
        const form = make('form', 'scriptorium-dlg');
        const title = make('h4');
        title.textContent = '新白板';
        const field = make('label', 'scriptorium-field');
        const caption = make('span', 'lab');
        caption.textContent = '白板名称';
        const input = document.createElement('input');
        input.value = '未命名白板';
        input.required = true;
        input.maxLength = 120;
        input.setAttribute('aria-label', '白板名称');
        field.append(caption, input);
        const actions = make('div', 'acts');
        const submit = button('scriptorium-file-button primary', '', '创建', null);
        submit.type = 'submit';
        actions.append(button('scriptorium-file-button', '', '取消', () => scrim.remove()), submit);
        form.append(title, field, actions);
        scrim.append(form);
        document.body.append(scrim);
        input.focus();
        input.select();
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (submit.disabled) return;
            submit.disabled = true;
            try {
                await createArtifact({ name: input.value });
                scrim.remove();
            } catch (error) {
                UI.toast(`未能新建白板：${error.message}`, 'error', 5000);
            } finally { submit.disabled = false; }
        });
    }
    // “开始”菜单中的“新白板”：与“新文档”“新演示”一样，点击后收起菜单。
    document.getElementById('new-board-btn')?.addEventListener('click', () => {
        document.getElementById('start-menu')?.classList.remove('open');
        const dropdown = document.getElementById('start-menu-dropdown');
        if (dropdown) dropdown.hidden = true;
        document.getElementById('start-menu-btn')?.setAttribute('aria-expanded', 'false');
        void create();
    });

    const view = Object.freeze({
        claims: isBoard,
        createArtifact,
        open,
        route,
        leave,
        create,
        saveAs: true,
        save,
        reload: () => reload({ discard: true }),
        active: () => Boolean(file),
        agent: Object.freeze({ text, surface: () => stage, picture, board: Object.freeze({ read, update: (payload) => lineage.submit(payload), getNodeSource, save: agentSave, history: () => lineage.history() }) }),
        // 画布载入完成才算打开。
        doc: () => (file && !loading ? Object.freeze({ kind: 'board', filePath: file.filePath, name: file.name, generation: file.generation,
            dirty, saving: file.saving, revision: snapshots.at(-1)?.stamp || 0 }) : null),
        _state: () => ({ file: file && { ...file }, dirty, snapshots: snapshots.length, mounted: Boolean(scene), elements: scene ? live().length : 0 }),
    });
    window.ScriptoriumBoardView = view;
    UI.registerOverlay(view);
})();
