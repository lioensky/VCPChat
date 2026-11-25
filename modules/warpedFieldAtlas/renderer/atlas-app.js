import { metricChart, sliceViewport } from './metric-slice.mjs';
// 双曲场图的界面。mountAtlas(container, source) 把整个界面挂进 container；
// source.get(route) 取数据（Chat 里经主进程转到后端插件，命令行预览时直接请求本机服务）。
// 两个视图：全景（半径取实际数值，角度按近邻排布）和查询（横轴夹角、纵轴半径，等距离线取自精确距离）。
// 交互：滚轮缩放、拖动平移、点选节点；说明和详情都在右侧栏，不做悬停提示。

const TAU = Math.PI * 2;
const FLAG_ENTRY = 1;
const FLAG_DIRECTION = 2;
const FLAG_SHELL = 4;
const KIND_NAME = { tag: 'Tag 场', chunk: 'Chunk 场' };
const PLATE = { tag: 'PLATE I', chunk: 'PLATE II', query: 'PLATE III' };
const NOTE = {
    panorama: '半径取自训练快照；沿圆周按近邻排布，角度差不代表距离。',
    query: '横轴是与查询方向的夹角，纵轴是节点半径；同一条虚线上的点到查询等距。',
};
const FOCUS_SHARE = 0.7;      // 展开的话题团占整圈的比例
const MOTION_MS = 220;        // 展开、收起时节点移动的时长
const MINI = 172;             // 缩略图的边长
const NEAR = 10;              // 指针离节点多近算点中（像素）
const REASON = { insufficient_neighbors: '近邻不足，没有算出残差。' };

function el(doc, tag, className = '', text = null) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

const fixed = (value, digits) => (value == null || Number.isNaN(value) ? '—' : Number(value).toFixed(digits));

/**
 * 展开一个话题团时角度怎么变，返回“排布给的角度 → 画出来的角度”。
 * 这一团拉宽到占整圈的 FOCUS_SHARE，其余的按同一个比例压窄；正上方的接缝不动，环上的先后次序不变。
 * group 是 { start, end }（弧度），count 是节点总数；group 为空时原样返回。
 */
export function focusMap(group, count) {
    if (!group) return a => a;
    const pad = Math.PI / Math.max(1, count);       // 半个节点的间距：只有一个节点的团也有宽度
    const from = Math.max(0, group.start - pad);
    const to = Math.min(TAU, group.end + pad);
    const span = to - from;
    const wide = Math.max(span, TAU * FOCUS_SHARE);
    if (wide >= TAU - 1e-6) return a => a;
    const inside = wide / span;
    const outside = (TAU - wide) / (TAU - span);
    return a => (a <= from ? a * outside : a <= to ? from * outside + (a - from) * inside : from * outside + wide + (a - to) * outside);
}

export function mountAtlas(container, source, options = {}) {
    const doc = container.ownerDocument;
    const win = doc.defaultView;
    const root = el(doc, 'div', 'wa-root');
    // 开在自己的无边框窗口里时，页头兼作拖动窗口的地方。
    if (options.ownWindow) root.dataset.window = 'true';
    container.replaceChildren(root);

    // ---------- 骨架 ----------
    const head = el(doc, 'header', 'wa-head');
    const title = el(doc, 'div', 'wa-title');
    title.append(el(doc, 'span', 'wa-title-main', '双曲场图'), el(doc, 'span', 'wa-title-sub', 'WARPED FIELD ATLAS'));
    const kindSeg = el(doc, 'div', 'wa-seg');
    const viewSeg = el(doc, 'div', 'wa-seg');
    const search = el(doc, 'div', 'wa-search');
    const searchInput = el(doc, 'input');
    searchInput.type = 'text';
    searchInput.placeholder = '按名称查找';
    searchInput.spellcheck = false;
    const searchList = el(doc, 'div', 'wa-search-list');
    searchList.hidden = true;
    search.append(searchInput, searchList);
    const reset = el(doc, 'button', 'wa-reset', '复位');
    reset.type = 'button';
    head.append(title, kindSeg, viewSeg, reset, search);
    if (options.windowControls) head.append(options.windowControls);
    const body = el(doc, 'div', 'wa-body');
    const stage = el(doc, 'div', 'wa-stage');
    const canvas = el(doc, 'canvas');
    // 缩略图：全景图放大到看不全整圈时出现在左上角，框出当前看到的范围，在上面拖动就移动画面。
    const mini = el(doc, 'canvas', 'wa-mini');
    mini.hidden = true;
    const plate = el(doc, 'div', 'wa-plate');
    const plateMark = el(doc, 'div', 'wa-plate-mark');
    const plateNote = el(doc, 'div', 'wa-plate-note');
    plate.append(plateMark, plateNote);
    const message = el(doc, 'div', 'wa-message');
    message.hidden = true;
    // measure only the drawing stage; its caption belongs below the canvas.
    const plotColumn = el(doc, 'div', 'wa-plot-column');
    stage.append(canvas, mini, message);
    plotColumn.append(stage, plate);
    const side = el(doc, 'aside', 'wa-side');
    body.append(plotColumn, side);
    root.append(head, body);

    const style = win.getComputedStyle(root);
    const token = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    const readColors = () => ({
        ink: token('--wa-ink-0', '#14110e'), line: token('--wa-line', '#3b342b'), lineSoft: token('--wa-line-soft', '#2f2a23'),
        text: token('--wa-text', '#ece3d3'), text2: token('--wa-text-2', '#b4a893'), text3: token('--wa-text-3', '#7d7262'),
        terra: token('--wa-terra', '#c35f2c'), terraHi: token('--wa-terra-hi', '#db7a43'), mark: token('--wa-mark', '#dea06c'),
        umber: token('--wa-umber', '#9b795d'),
    });
    let color = readColors();
    const fontBody = token('--wa-font', '"MiSans", "Noto Sans SC", "Microsoft YaHei", sans-serif');
    const fontLetter = token('--wa-font-letter', '"PT Serif", Georgia, serif');
    const font = (px, weight = 400, family = fontBody) => `${weight} ${px}px ${family}`;

    // ---------- 状态 ----------
    const state = {
        kind: 'tag', view: 'panorama',
        fields: {},           // kind -> /field 的结果
        available: {},        // kind -> /status 里的条目
        selected: null,       // { kind, index, id, outside }
        detail: null,         // 当前选中节点的详情
        lines: 'river',       // 选中 Tag 时画哪种连线：river | navigation | none
        marks: { entry: true, direction: true, shell: false },
        query: {},            // kind -> 整理过的查询结果
        k: 10,
        camera: {},           // kind -> 全景图的镜头 { scale, x, y }
        window: {},           // kind -> 查询视图的夹角范围 [from, to]
        focus: {},            // kind -> 展开的话题团序号，没有展开就是 null
        nearby: null,         // 上一次点下去的地方附近的节点 { kind, indices, total }，多于一个时右侧栏列出来让人挑
    };
    const still = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    let disposed = false;
    let frame = 0;
    let size = { width: 0, height: 0, ratio: 1 };
    // 这一帧画出来的节点（点选和指针高亮用）。节点上到十万个时每帧新建十万个对象太慢，所以用三条定长数组。
    let hitIndex = new Int32Array(0);
    let hitX = new Float32Array(0);
    let hitY = new Float32Array(0);
    let hitCount = 0;
    function resetHits(capacity) {
        if (hitIndex.length < capacity) {
            hitIndex = new Int32Array(capacity);
            hitX = new Float32Array(capacity);
            hitY = new Float32Array(capacity);
        }
        hitCount = 0;
    }
    function addHit(index, x, y) {
        hitIndex[hitCount] = index;
        hitX[hitCount] = x;
        hitY[hitCount] = y;
        hitCount += 1;
    }
    let requestToken = 0;

    const field = () => state.fields[state.kind];
    const query = () => state.query[state.kind];

    function showMessage(text) {
        message.textContent = text || '';
        message.hidden = !text;
    }

    function segment(host, items, current, pick) {
        host.replaceChildren(...items.map(([value, label, disabled]) => {
            const button = el(doc, 'button', '', label);
            button.type = 'button';
            button.setAttribute('aria-pressed', String(value === current));
            if (disabled) button.disabled = true;
            button.addEventListener('click', () => pick(value));
            return button;
        }));
    }

    function renderHead() {
        segment(kindSeg, [['tag', 'Tag 场'], ['chunk', 'Chunk 场']], state.kind, value => switchKind(value));
        segment(viewSeg, [['panorama', '全景'], ['query', '查询']], state.view, value => switchView(value));
        plateMark.textContent = state.view === 'query' ? PLATE.query : PLATE[state.kind];
        const focused = state.view === 'panorama' && field() ? field().groups[state.focus[state.kind]] : null;
        plateNote.textContent = focused
            ? '展开只改变各团占用的圆弧，节点半径不变。'
            : state.view === 'query' && query()?.metricMode
                ? '查询的黎曼保角截面：横向为真实夹角，纵向依快照度规展开。虚线是到查询的等距线；屏幕上两点的直线距离不是它们的测地距离。'
                : NOTE[state.view];
    }

    // ---------- 取数 ----------
    async function loadField(kind) {
        if (state.fields[kind]) return state.fields[kind];
        showMessage('正在读取');
        const data = await source.get(`/field/${kind}`);
        data.maxQuantile = 1;
        data.bins = [0, 0, 0, 0, 0, 0];
        data.radius.forEach(r => { data.bins[Math.min(5, Math.max(0, Math.floor((r - 0.35) / 0.05 + 1e-9)))]++; });
        data.entries = data.flags.reduce((n, f) => n + (f & FLAG_ENTRY ? 1 : 0), 0);
        data.directions = data.flags.reduce((n, f) => n + (f & FLAG_DIRECTION ? 1 : 0), 0);
        data.shells = data.flags.reduce((n, f) => n + (f & FLAG_SHELL ? 1 : 0), 0);
        // shown 是现在画出来的角度：平时等于排布给的角度，展开话题团时不同。arcs 是各话题团的弧在图上的起止角。
        data.shown = Float32Array.from(data.angle);
        data.arcs = data.groups.map(g => [g.start, g.end]);
        // 每个节点在图上的位置（半径 × 方向）算好存着，画的时候不再逐个算三角函数。
        data.wx = new Float32Array(data.count);
        data.wy = new Float32Array(data.count);
        place(data);
        // 标名称时里圈优先：先按半径排好，画的时候顺着取。
        data.byRadius = Uint32Array.from({ length: data.count }, (_, i) => i).sort((a, b) => data.radius[a] - data.radius[b]);
        data.labelWidth = new Float32Array(data.count);
        state.fields[kind] = data;
        showMessage('');
        return data;
    }

    // ---------- 展开话题团 ----------
    function place(f) {
        for (let i = 0; i < f.count; i++) {
            f.wx[i] = f.radius[i] * Math.sin(f.shown[i]);
            f.wy[i] = -f.radius[i] * Math.cos(f.shown[i]);
        }
        f.version = (f.version || 0) + 1;
    }

    /** group 为 null 是收起。镜头回到整圈，节点在 MOTION_MS 里移到新位置。 */
    function setFocus(group) {
        const f = field();
        if (!f) return;
        const kind = state.kind;
        const next = group == null || !f.groups[group] ? null : group;
        if ((state.focus[kind] ?? null) === next) return;
        state.focus[kind] = next;
        const map = focusMap(next == null ? null : f.groups[next], f.count);
        const cam = camera();
        f.motion = {
            from: f.shown, to: Float32Array.from(f.angle, a => map(a)), buffer: new Float32Array(f.count),
            arcsFrom: f.arcs, arcsTo: f.groups.map(g => [map(g.start), map(g.end)]),
            camFrom: { scale: cam.scale, x: cam.x, y: cam.y }, camTo: fitCamera(),
            start: still ? -1e9 : win.performance.now(),
        };
        hoverGroup = null;
        renderHead();
        renderSide();
        schedule();
    }
    const toggleFocus = group => setFocus(state.focus[state.kind] === group ? null : group);

    function stepMotion(f) {
        const m = f.motion;
        if (!m) return;
        const t = Math.min(1, (win.performance.now() - m.start) / MOTION_MS);
        const ease = 1 - (1 - t) ** 3;
        if (t >= 1) {
            f.shown = m.to;
            f.arcs = m.arcsTo;
            f.motion = null;
            if (m.camTo) state.camera[state.kind] = m.camTo;
        } else {
            const out = m.buffer;
            for (let i = 0; i < f.count; i++) out[i] = m.from[i] + (m.to[i] - m.from[i]) * ease;
            f.shown = out;
            f.arcs = m.arcsFrom.map((arc, g) => [arc[0] + (m.arcsTo[g][0] - arc[0]) * ease, arc[1] + (m.arcsTo[g][1] - arc[1]) * ease]);
            if (m.camTo) {
                const cam = camera();
                cam.scale = m.camFrom.scale * (m.camTo.scale / m.camFrom.scale) ** ease;
                cam.x = m.camFrom.x + (m.camTo.x - m.camFrom.x) * ease;
                cam.y = m.camFrom.y + (m.camTo.y - m.camFrom.y) * ease;
            }
            schedule();
        }
        place(f);
    }
    /** 人动了镜头：展开动画里那一段回到整圈的镜头移动就此作罢，节点照旧移完。 */
    function ownCamera() {
        const f = field();
        if (f?.motion) f.motion.camTo = null;
        const cam = camera();
        cam.touched = true;
        return cam;
    }

    async function start() {
        renderHead();
        try {
            const status = await source.get('/status');
            state.available = status.fields || {};
            state.messages = status.messages?.available === true;
            if (!state.available.tag?.available && state.available.chunk?.available) state.kind = 'chunk';
            if (!state.available[state.kind]?.available) {
                showMessage(state.available[state.kind]?.reason || '这个知识库还没有双曲场文件。');
                renderSide();
                return;
            }
            await loadField(state.kind);
            renderHead();
            renderSide();
            schedule();
        } catch (error) {
            showMessage(error.message);
        }
    }

    async function switchKind(kind, keepSelection = false) {
        if (kind === state.kind && state.fields[kind]) return;
        if (state.available[kind] && !state.available[kind].available) {
            state.kind = kind;
            if (!keepSelection) { state.selected = null; state.detail = null; state.nearby = null; }
            renderHead();
            renderSide();
            showMessage(state.available[kind].reason);
            schedule();
            return;
        }
        state.kind = kind;
        if (!keepSelection) { state.selected = null; state.detail = null; state.nearby = null; }
        renderHead();
        try {
            await loadField(kind);
        } catch (error) {
            showMessage(error.message);
        }
        renderSide();
        schedule();
    }

    function switchView(view) {
        state.view = view;
        renderHead();
        if (view === 'query' && !query() && state.selected && state.selected.kind === state.kind && !state.selected.outside) {
            runQuery(state.selected.id);
            return;
        }
        renderSide();
        schedule();
    }

    /** nearby：这次是在图上点出来的，点的地方附近还有哪些节点；keepNearby：从那张候选表里挑的，表留着。 */
    async function select(kind, target, { center = false, nearby = null, keepNearby = false } = {}) {
        const mine = ++requestToken;
        if (kind !== state.kind) await switchKind(kind, true);
        if (!keepNearby) state.nearby = nearby;
        state.selected = { kind, index: target.index ?? null, id: target.id, outside: target.index == null };
        state.detail = null;
        if (center && target.index != null && state.view === 'panorama') reveal(target.index, center === 'always');
        renderSide();
        schedule();
        try {
            const detail = await source.get(`/field/${kind}/node/${target.id}`);
            if (mine !== requestToken || disposed) return;
            state.detail = detail;
        } catch (error) {
            if (mine !== requestToken) return;
            state.detail = { failed: error.message };
        }
        renderSide();
        schedule();
    }

    function clearSelection() {
        requestToken++;
        state.selected = null;
        state.detail = null;
        state.nearby = null;
        renderSide();
        schedule();
    }

    /** target：节点编号，或 { message: 对话消息的 hash }。 */
    async function runQuery(target) {
        const kind = state.kind;
        const route = target && typeof target === 'object'
            ? `/field/${kind}/query?message=${encodeURIComponent(target.message)}`
            : `/field/${kind}/query?node=${encodeURIComponent(target)}`;
        showMessage('正在计算');
        try {
            const result = await source.get(route);
            if (disposed) return;
            state.query[kind] = prepareQuery(result);
            state.window[kind] = null;
            state.view = 'query';
            showMessage('');
        } catch (error) {
            showMessage(error.message);
        }
        renderHead();
        renderSide();
        schedule();
    }

    /** 排名在这里算：双曲距离从小到大、夹角从小到大（等于余弦从大到小）。 */
    function prepareQuery(result) {
        const count = result.theta.length;
        const usable = [];
        for (let i = 0; i < count; i++) if (i !== result.query.index && result.distance[i] != null) usable.push(i);
        const byDistance = usable.slice().sort((a, b) => result.distance[a] - result.distance[b] || a - b);
        const byCosine = usable.slice().sort((a, b) => result.theta[a] - result.theta[b] || a - b);
        const distanceRank = new Int32Array(count);
        const cosineRank = new Int32Array(count);
        byDistance.forEach((i, r) => { distanceRank[i] = r + 1; });
        byCosine.forEach((i, r) => { cosineRank[i] = r + 1; });
        return {
            ...result, byDistance, byCosine, distanceRank, cosineRank,
            thetaMin: result.theta[byCosine[0]], thetaMax: result.theta[byCosine[byCosine.length - 1]],
        };
    }

    // ---------- 全景图的镜头 ----------
    function fitCamera() {
        const f = field();
        const outer = f ? f.radiusRange[1] : 0.65;
        const scale = Math.max(40, Math.min((size.width - 300) / (2 * (outer + 0.05)), (size.height - 110) / (2 * (outer + 0.06))));
        return { scale, x: size.width / 2, y: size.height / 2 - 8, base: scale };
    }
    function camera() {
        if (!state.camera[state.kind]) state.camera[state.kind] = fitCamera();
        return state.camera[state.kind];
    }
    const world = (radius, angle) => [radius * Math.sin(angle), -radius * Math.cos(angle)];
    function centerOn(index) {
        const f = field();
        const cam = ownCamera();
        cam.x = size.width / 2 - f.wx[index] * cam.scale;
        cam.y = size.height / 2 - f.wy[index] * cam.scale;
    }

    /** 跳到一个节点：已经在画面里就不动镜头，不在才把它移到中间。 */
    function reveal(index, always = false) {
        const f = field();
        if (!f) return;
        const cam = camera();
        const x = cam.x + f.wx[index] * cam.scale;
        const y = cam.y + f.wy[index] * cam.scale;
        if (always || x < 60 || y < 40 || x > size.width - 60 || y > size.height - 60) centerOn(index);
    }
    function zoomAt(x, y, factor) {
        const cam = ownCamera();
        const next = Math.max(cam.base * 0.6, Math.min(cam.base * 40, cam.scale * factor));
        const ratio = next / cam.scale;
        cam.x = x - (x - cam.x) * ratio;
        cam.y = y - (y - cam.y) * ratio;
        cam.scale = next;
    }

    // ---------- 查询视图的窗口 ----------
    function plotBox() {
        return { left: 66, right: size.width - 26, top: 46, bottom: size.height - 108 };
    }
    function currentSlice() {
        const f = field();
        if (!query()?.metricMode || !f) return null;
        if (f.chart === undefined) f.chart = metricChart(f.geometry, f.radiusRange);
        if (!f.chart) return null;
        const [from, to] = queryWindow();
        return sliceViewport(f.chart, from, to, plotBox());
    }
    function queryWindow() {
        const q = query();
        if (!state.window[state.kind]) {
            const last = q.byDistance[Math.min(q.byDistance.length - 1, 59)];
            state.window[state.kind] = [Math.max(0, Math.floor(q.thetaMin - 1.5)), Math.min(180, Math.ceil(q.theta[last] + 2))];
        }
        return state.window[state.kind];
    }

    // ---------- 画 ----------
    function schedule() {
        if (frame || disposed) return;
        frame = win.requestAnimationFrame(() => { frame = 0; draw(); });
    }

    function resize() {
        const rect = stage.getBoundingClientRect();
        const ratio = win.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        if (width === size.width && height === size.height && ratio === size.ratio) return;
        const first = !size.width;
        const previous = size;
        size = { width, height, ratio };
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        if (!first) {
            // 尺寸变了：没动过镜头的重新适配，动过的保持中心。
            for (const kind of Object.keys(state.camera)) {
                const cam = state.camera[kind];
                if (!cam) continue;
                if (!cam.touched) { state.camera[kind] = null; continue; }
                cam.x += (width - previous.width) / 2;
                cam.y += (height - previous.height) / 2;
            }
        }
        schedule();
    }

    // 已经占住的地方：名称，以及要让开的节点。一个像素一格记在一张表里，十万个节点也只是往表里写数，不用两两比。
    let taken = new Uint8Array(0);
    function labeler(ctx) {
        const columns = size.width;
        const lines = size.height;
        if (taken.length !== columns * lines) taken = new Uint8Array(columns * lines);
        else taken.fill(0);
        // 四舍五入到整格：两个挨着但不相交的框不会被算成相撞。这两个函数每帧要被叫上十万次，所以不建临时对象。
        const block = (x0, y0, x1, y1) => {
            const left = Math.max(0, Math.round(x0));
            const right = Math.min(columns, Math.round(x1));
            const bottom = Math.min(lines, Math.round(y1));
            if (right <= left) return;
            for (let y = Math.max(0, Math.round(y0)); y < bottom; y++) {
                const row = y * columns;
                for (let x = left; x < right; x++) taken[row + x] = 1;
            }
        };
        const free = (x0, y0, x1, y1) => {
            const left = Math.max(0, Math.round(x0));
            const right = Math.min(columns, Math.round(x1));
            const bottom = Math.min(lines, Math.round(y1));
            for (let y = Math.max(0, Math.round(y0)); y < bottom; y++) {
                const row = y * columns;
                for (let x = left; x < right; x++) if (taken[row + x]) return false;
            }
            return true;
        };
        return {
            reserve(x, y, radius) { block(x - radius, y - radius, x + radius, y + radius); },
            block,
            /**
             * 先试点的右边，放不下试左边；都放不下就不标，返回 null；标上了返回名称占的框 [左, 上, 右, 下]。
             * force 时一定标在右边。width 是已经量过的字宽，给了就不再量。
             */
            place(text, x, y, { fill = color.text2, fontSpec = font(11.5), gap = 7, force = false, maxWidth = 220, align = null, width = 0 } = {}) {
                ctx.font = fontSpec;
                let shown = text;
                if (!width) width = ctx.measureText(shown).width;
                while (width > maxWidth && shown.length > 2) { shown = shown.slice(0, -1); width = ctx.measureText(shown).width; }
                const tries = align === 'left' ? [x + gap] : align === 'right' ? [x - gap - width] : [x + gap, x - gap - width];
                for (const left of tries) {
                    if (!force && (left < 4 || left + width > size.width - 4 || !free(left - 2, y - 8, left + width + 2, y + 8))) continue;
                    block(left - 2, y - 8, left + width + 2, y + 8);
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.lineJoin = 'round';
                    ctx.lineWidth = 3;
                    ctx.strokeStyle = color.ink;
                    ctx.strokeText(shown, left, y);
                    ctx.fillStyle = fill;
                    ctx.fillText(shown, left, y);
                    return [left - 2, y - 8, left + width + 2, y + 8];
                }
                return null;
            },
        };
    }
    // 悬停名称是图内的临时标注，不占普通名称名额，不改变选择或侧栏。
    function drawHoverName(ctx, label, text, x, y, bounds) {
        if (!text) return;
        const left = bounds.left + 4, right = bounds.right - 4;
        const style = font(12.5, 600);
        ctx.font = style;
        const width = Math.min(ctx.measureText(text).width, 280, Math.max(1, right - left));
        const start = x + 12 + width <= right ? x + 12 : x - 12 - width;
        const top = Math.max(bounds.top + 9, Math.min(bounds.bottom - 9, y));
        label.place(text, Math.max(left, Math.min(right - width, start)), top, {
            align: 'left', gap: 0, force: true, maxWidth: width, fontSpec: style, fill: color.text,
        });
    }
    /** 节点名称按默认字号画出来有多宽：量一次记住，字体换了（网页字体到货）再重量。 */
    function labelWidth(ctx, f, i) {
        if (!f.labelWidth[i]) {
            ctx.font = font(11.5);
            f.labelWidth[i] = ctx.measureText(f.labels[i]).width || 0.01;
        }
        return f.labelWidth[i];
    }

    function diamond(ctx, x, y, r) {
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
    }
    function dot(ctx, x, y, r) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
    }

    function draw() {
        if (disposed || !size.width) return;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(size.ratio, 0, 0, size.ratio, 0, 0);
        ctx.clearRect(0, 0, size.width, size.height);
        const f = field();
        resetHits(f ? f.count : 0);
        groupBoxes = [];
        if (!f || state.view !== 'panorama') mini.hidden = true;
        if (!f) return;
        stepMotion(f);
        if (state.view === 'query') {
            if (query()) drawQuery(ctx, f, query());
            else showMessage(state.available[state.kind]?.available === false ? state.available[state.kind].reason : (state.messages ? '在全景图里点选一个节点再按“以此为查询”，或者在右边选一条对话消息。' : '先在全景图里点选一个节点，再按“以此为查询”。'));
        } else {
            drawPanorama(ctx, f);
        }
    }

    /** 选中节点要画的连线：[{ index, weight }]，weight 归一到 0–1；导航图的线不分粗细。 */
    function activeLinks(f) {
        const d = state.detail;
        if (!d || d.failed || !state.selected || state.selected.kind !== state.kind || !d.inField) return [];
        if (state.kind === 'tag' && state.lines === 'river' && d.river) {
            const merged = new Map();
            for (const row of [...d.river.incoming, ...d.river.outgoing]) {
                if (row.index == null) continue;
                merged.set(row.index, Math.max(merged.get(row.index) || 0, row.weight));
            }
            const top = Math.max(1e-9, ...merged.values());
            return [...merged].map(([index, weight]) => ({ index, weight: weight / top }));
        }
        if (state.lines === 'none' && state.kind === 'tag') return [];
        if (state.kind === 'chunk' || state.lines === 'navigation') return d.navigation.filter(i => i < f.count).map(index => ({ index, weight: 0 }));
        return [];
    }

    function drawRiverEdge(ctx, x0, y0, x1, y1, width) {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const length = Math.hypot(dx, dy);
        if (length === 0) return;

        const half = width / 2;
        const tip = half * 0.55;
        const taper = Math.min(48, length * 0.22);
        const third = taper / 3;
        const far = length - taper;
        const ux = dx / length;
        const uy = dy / length;

        ctx.save();
        ctx.transform(ux, uy, -uy, ux, x0, y0);
        ctx.fillStyle = color.mark;
        ctx.beginPath();
        ctx.moveTo(0, tip);
        // 控制点在轴向三等分、在端部与主体处水平相接，宽度按 smoothstep 过渡。
        ctx.bezierCurveTo(third, tip, taper - third, half, taper, half);
        ctx.lineTo(far, half);
        ctx.bezierCurveTo(far + third, half, length - third, tip, length, tip);
        ctx.lineTo(length, -tip);
        ctx.bezierCurveTo(length - third, -tip, far + third, -half, far, -half);
        ctx.lineTo(taper, -half);
        ctx.bezierCurveTo(taper - third, -half, third, -tip, 0, -tip);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    function drawPanorama(ctx, f) {
        const cam = camera();
        const [inner, outer] = f.radiusRange;
        const sx = (wx) => cam.x + wx * cam.scale;
        const sy = (wy) => cam.y + wy * cam.scale;
        const zoom = cam.scale / cam.base;

        // 刻度圈：里外边界实线，中间每 0.1 一圈点线。
        ctx.lineWidth = 1;
        for (let r = inner; r <= outer + 1e-6; r += 0.05) {
            const edge = Math.abs(r - inner) < 1e-6 || Math.abs(r - outer) < 1e-6;
            ctx.strokeStyle = edge ? color.line : color.lineSoft;
            ctx.setLineDash(edge ? [] : [1, 5]);
            dot(ctx, cam.x, cam.y, r * cam.scale);
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.strokeStyle = color.line;
        dot(ctx, cam.x, cam.y, (outer + 0.012) * cam.scale);
        ctx.stroke();

        // 半径标尺：立在正上方的接缝处。
        ctx.strokeStyle = color.umber;
        ctx.fillStyle = color.umber;
        ctx.font = font(10.5);
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.beginPath();
        ctx.moveTo(cam.x, sy(-inner));
        ctx.lineTo(cam.x, sy(-outer));
        ctx.stroke();
        for (let r = inner, step = 0; r <= outer + 1e-6; r += 0.05, step++) {
            const y = sy(-r);
            ctx.beginPath();
            ctx.moveTo(cam.x - (step % 2 ? 2 : 4), y);
            ctx.lineTo(cam.x + (step % 2 ? 2 : 4), y);
            ctx.stroke();
            if (step % 2 === 0 && cam.scale * 0.1 > 26) ctx.fillText(r.toFixed(2), cam.x + 7, y);
        }

        // 圆心的题名。
        if (inner * cam.scale > 96) {
            ctx.textAlign = 'center';
            ctx.fillStyle = color.umber;
            ctx.font = font(11, 400, fontLetter);
            ctx.fillText(state.kind === 'tag' ? 'T A G   F I E L D' : 'C H U N K   F I E L D', cam.x, cam.y - 24);
            ctx.fillStyle = color.text;
            ctx.font = font(17, 600);
            ctx.fillText(state.kind === 'tag' ? '双曲 Tag 场' : '双曲 Chunk 场', cam.x, cam.y);
            ctx.fillStyle = color.text3;
            ctx.font = font(12);
            ctx.fillText(`${f.count} 个节点 · ${f.groups.length} 个话题团`, cam.x, cam.y + 24);
        }

        const links = activeLinks(f);
        const linked = new Map(links.map(link => [link.index, link.weight]));
        const picked = state.selected && state.selected.kind === state.kind ? state.selected.index : null;
        const dimOthers = picked != null && links.length > 0;
        const focused = state.focus[state.kind] ?? null;
        const label = labeler(ctx);
        // 整圈看不全时左上角有缩略图：名称不往它下面放。
        const ring = outer * cam.scale;
        const showMini = cam.x - ring < 0 || cam.y - ring < 0 || cam.x + ring > size.width || cam.y + ring > size.height;
        if (showMini) label.block(0, 0, 14 + MINI + 6, 14 + MINI + 6);
        // 左下角的图版说明也不让名称压上去。


        // 话题团的弧和名称。展开的那一团用陶土色，指针指着的那一团提亮：两种都表示点下去会展开或收起。
        f.groups.forEach((group, index) => {
            const [from, to] = f.arcs[index];
            const r = (outer + 0.03) * cam.scale;
            ctx.strokeStyle = index === focused ? color.terra : index === hoverGroup ? color.text : color.text3;
            ctx.lineWidth = index === focused ? 2 : index === hoverGroup ? 1.6 : 1;
            ctx.beginPath();
            ctx.arc(cam.x, cam.y, r, from - Math.PI / 2, to - Math.PI / 2);
            ctx.stroke();
            ctx.lineWidth = 1;
            for (const a of [from, to]) {
                const [x0, y0] = world(outer + 0.022, a);
                const [x1, y1] = world(outer + 0.038, a);
                ctx.beginPath();
                ctx.moveTo(sx(x0), sy(y0));
                ctx.lineTo(sx(x1), sy(y1));
                ctx.stroke();
            }
        });
        const groupLabels = f.groups.map((group, index) => {
            const middle = (f.arcs[index][0] + f.arcs[index][1]) / 2;
            const [wx, wy] = world(outer + 0.052, middle);
            return { group, index, x: sx(wx), y: sy(wy), right: Math.sin(middle) >= 0 };
        }).sort((a, b) => (b.index === focused) - (a.index === focused) || b.group.count - a.group.count);

        // 连线画在点的下面。
        if (picked != null && links.length) {
            const river = state.kind === 'tag' && state.lines === 'river';
            const x0 = sx(f.wx[picked]);
            const y0 = sy(f.wy[picked]);
            for (const link of links) {
                const x1 = sx(f.wx[link.index]);
                const y1 = sy(f.wy[link.index]);
                if (river) {
                    // keep every edge visible while giving weaker co-occurrences less contrast.
                    const alpha = 0.13 + 0.72 * link.weight ** 1.35;
                    ctx.globalAlpha = relationPreview == null ? alpha : link.index === relationPreview ? 1 : alpha * 0.45;
                    drawRiverEdge(ctx, x0, y0, x1, y1, 0.6 + 2 * link.weight);
                } else {
                    ctx.strokeStyle = color.text2;
                    ctx.globalAlpha = 0.4;
                    ctx.lineWidth = 0.7;
                    ctx.beginPath();
                    ctx.moveTo(x0, y0);
                    ctx.lineTo(x1, y1);
                    ctx.stroke();
                }
            }
            ctx.globalAlpha = 1;
        }

        // 节点。Tag 按入度分位分三档大小，像星图里的星等。放大时点和标记一起长大，相互的比例不变。
        const grow = Math.min(1.9, Math.max(1, Math.sqrt(zoom)));
        // 节点很多时（一万二以上）整圈看会糊成一片：点画小一些、淡一些，放大后恢复原样。
        const crowd = Math.sqrt(12000 / Math.max(12000, f.count));
        const thin = Math.min(1, Math.max(0.5, crowd) * Math.max(1, zoom));
        const fade = Math.min(1, Math.max(0.4, crowd) * Math.max(1, zoom));
        const radiusOf = i => {
            const q = f.quantile ? f.quantile[i] : 0.5;
            return (q >= 0.9 ? 2.3 : q >= 0.6 ? 1.7 : 1.25) * grow * thin;
        };
        // 要标名称的时候，先把每个节点占的位置记下，名称只放在空处，不盖住别的点。
        const labelling = zoom >= 1.7 || links.length > 0 || focused != null;
        const marked = [];            // 画面里带入口、地标记号的节点
        // 三档大小各攒一批坐标，一批只上一次色：十万个点也只有几次填充。展开了话题团时，别的团另攒三批，画淡一些。
        const tiers = [[], [], [], [], [], []];
        const tierRadius = [2.3 * grow * thin, 1.7 * grow * thin, 1.25 * grow * thin];
        const plain = linked.size === 0 && picked == null;
        for (let i = 0; i < f.count; i++) {
            const x = cam.x + f.wx[i] * cam.scale;
            const y = cam.y + f.wy[i] * cam.scale;
            if (x < -12 || y < -12 || x > size.width + 12 || y > size.height + 12) continue;
            if (f.flags[i]) marked.push(i);
            addHit(i, x, y);
            const q = f.quantile ? f.quantile[i] : 0.5;
            const tier = q >= 0.9 ? 0 : q >= 0.6 ? 1 : 2;
            const special = !plain && (i === picked || linked.has(i));
            // 选中了节点、别的点已经压暗时，只让选中的和连着的点占位置：连着的点名称照旧全标，压在暗掉的点上没有关系。
            if (labelling && (!dimOthers || special)) label.reserve(x, y, tierRadius[tier] + 1.5);
            if (special) continue;
            tiers[tier + (focused != null && f.group[i] !== focused ? 3 : 0)].push(x, y);
        }
        const tierStyle = [[2.3, color.text, 1], [1.7, color.text2, 0.85], [1.25, color.text2, 0.62]];
        tiers.forEach((points, batch) => {
            if (!points.length) return;
            const tier = batch % 3;
            const [base, fill, alpha] = tierStyle[tier];
            const r = base * grow * thin;
            ctx.globalAlpha = dimOthers ? 0.28 : alpha * (tier ? fade : Math.max(fade, 0.8)) * (batch >= 3 ? 0.5 : 1);
            ctx.fillStyle = fill;
            ctx.beginPath();
            if (r < 1.2 || (points.length > 60000 && r < 2)) {
                // 小到一个像素上下时画成方块，比画圆快得多，也看不出差别；一批有几万个点时，稍大一些的也这样画。
                for (let k = 0; k < points.length; k += 2) ctx.rect(points[k] - r, points[k + 1] - r, r * 2, r * 2);
            } else {
                for (let k = 0; k < points.length; k += 2) {
                    ctx.moveTo(points[k] + r, points[k + 1]);
                    ctx.arc(points[k], points[k + 1], r, 0, TAU);
                }
            }
            ctx.fill();
        });
        ctx.globalAlpha = 1;

        // 入口、地标：画在点的上面，大小跟着点走，线下垫一道墨色，放大以后也不会被点盖住。
        const stroke = (width, style) => { ctx.lineWidth = width; ctx.strokeStyle = style; ctx.stroke(); };
        for (const i of marked) {
            const flags = f.flags[i];
            const x = sx(f.wx[i]);
            const y = sy(f.wy[i]);
            const r = radiusOf(i);
            // 选中节点后，无关的点压暗了，它们的记号也一起压暗；选中的和连着的点保持原样。
            ctx.globalAlpha = dimOthers && i !== picked && !linked.has(i) ? 0.28 : 1;
            if (state.marks.shell && flags & FLAG_SHELL) {
                const half = r + 2.2 * grow;
                ctx.beginPath();
                ctx.rect(x - half, y - half, half * 2, half * 2);
                stroke(1, color.text3);
            }
            if (state.marks.direction && flags & FLAG_DIRECTION) {
                const arm = r + 3.8 * grow;
                ctx.beginPath();
                ctx.moveTo(x - arm, y);
                ctx.lineTo(x + arm, y);
                ctx.moveTo(x, y - arm);
                ctx.lineTo(x, y + arm);
                stroke(1.2 * grow + 2.4, color.ink);
                stroke(1.2 * grow, color.umber);
                ctx.fillStyle = color.text;
                dot(ctx, x, y, Math.min(r, 1.5 * grow));
                ctx.fill();
            }
            if (state.marks.entry && flags & FLAG_ENTRY) {
                diamond(ctx, x, y, r + 4.4 * grow);
                stroke(1.3 * grow + 2.4, color.ink);
                stroke(1.3 * grow, color.text);
            }
        }
        ctx.globalAlpha = 1;

        // 连着的节点、选中的节点。
        for (const [i] of linked) {
            if (i === picked) continue;
            ctx.fillStyle = state.kind === 'tag' && state.lines === 'river' ? color.mark : color.text;
            dot(ctx, sx(f.wx[i]), sy(f.wy[i]), 3);
            ctx.fill();
        }
        // 上一次点下去的地方附近的几个节点（右侧栏里列着）：各套一个细圈，看得出列的是哪几个。
        if (state.nearby && state.nearby.kind === state.kind) {
            ctx.strokeStyle = color.text2;
            ctx.lineWidth = 1;
            for (const i of state.nearby.indices) {
                if (i === picked || i >= f.count) continue;
                dot(ctx, sx(f.wx[i]), sy(f.wy[i]), radiusOf(i) + 3.5);
                ctx.stroke();
            }
        }
        if (picked != null) {
            const x = sx(f.wx[picked]);
            const y = sy(f.wy[picked]);
            ctx.fillStyle = color.terra;
            dot(ctx, x, y, 5);
            ctx.fill();
            ctx.strokeStyle = color.terraHi;
            ctx.lineWidth = 1;
            dot(ctx, x, y, 9.5);
            ctx.stroke();
            label.reserve(x, y, 10);
            if (hover !== picked) label.place(f.labels[picked], x, y, { fill: color.text, fontSpec: font(12.5, 600), gap: 14, force: true, maxWidth: 280 });
        }
        // 指针下面的节点：亮起来并套一圈，表示现在点下去选中的是它。
        if (hover != null && hover !== picked && hover < f.count) {
            const x = sx(f.wx[hover]);
            const y = sy(f.wy[hover]);
            const r = radiusOf(hover);
            const flags = f.flags[hover];
            // 有记号的节点，圈套在记号外面。
            const reach = state.marks.entry && flags & FLAG_ENTRY ? r + 4.4 * grow + 4
                : state.marks.direction && flags & FLAG_DIRECTION ? r + 3.8 * grow + 3 : r + 5;
            ctx.fillStyle = color.text;
            dot(ctx, x, y, r + 0.8);
            ctx.fill();
            ctx.strokeStyle = color.text;
            ctx.lineWidth = 1.2;
            dot(ctx, x, y, reach);
            ctx.stroke();
        }

        // 名称：话题团 → 连着的节点 → 放大或展开以后按里圈优先。
        for (const item of groupLabels) {
            const text = item.group.label || '';
            if (!text) continue;
            const lit = item.index === focused || item.index === hoverGroup;
            const box = label.place(text, item.x, item.y, {
                fill: item.index === focused ? color.terraHi : color.text, fontSpec: font(12, lit ? 600 : 400), gap: 0,
                align: item.right ? 'left' : 'right', maxWidth: item.index === focused ? 280 : 150, force: item.index === focused,
            });
            if (box) groupBoxes.push({ box, index: item.index });
        }
        if (links.length) {
            const ordered = links.slice().sort((a, b) => b.weight - a.weight || f.radius[a.index] - f.radius[b.index]);
            for (const link of ordered.slice(0, 40)) {
                if (link.index === hover) continue;
                label.place(f.labels[link.index], sx(f.wx[link.index]), sy(f.wy[link.index]), { fill: color.text });
            }
        }
        if ((zoom >= 1.7 || focused != null) && !dimOthers) {
            // 没放大、只是展开了话题团时，只标展开的那一团。放不下的名称试到一定数目就停，节点再多也不会拖慢。
            const budget = Math.min(140, Math.round(18 * Math.max(zoom, focused != null ? 2.4 : 0)));
            let placed = 0;
            let tried = 0;
            for (const i of f.byRadius) {
                if (placed >= budget || tried >= budget * 8) break;
                if (i === hover) continue;
                if (zoom < 1.7 && f.group[i] !== focused) continue;
                const x = sx(f.wx[i]);
                const y = sy(f.wy[i]);
                if (x < 0 || y < 0 || x > size.width || y > size.height) continue;
                tried++;
                if (label.place(f.labels[i], x, y, { width: labelWidth(ctx, f, i) })) placed++;
            }
        }
        if (hover != null && hover < f.count) {
            drawHoverName(ctx, label, f.labels[hover], sx(f.wx[hover]), sy(f.wy[hover]),
                { left: 0, right: size.width, top: 0, bottom: size.height });
        }
        if (relationPreview != null && picked != null && linked.has(relationPreview)) {
            const x = sx(f.wx[relationPreview]), y = sy(f.wy[relationPreview]);
            ctx.strokeStyle = color.mark;
            ctx.lineWidth = 1.5;
            dot(ctx, x, y, 7);
            ctx.stroke();
            drawHoverName(ctx, label, f.labels[relationPreview], x, y,
                { left: 0, right: size.width, top: 0, bottom: size.height });
        }
        drawMini(f, cam, showMini, picked, focused);
    }

    // ---------- 缩略图 ----------
    let miniBase = null;      // 整圈的底图（刻度圈和节点）：排布没变就不重画
    const miniScale = f => (MINI / 2 - 9) / (f.radiusRange[1] + 0.035);
    function miniBaseOf(f, ratio) {
        if (miniBase && miniBase.field === f && miniBase.version === f.version && miniBase.ratio === ratio) return miniBase.canvas;
        const base = miniBase?.canvas || doc.createElement('canvas');
        base.width = base.height = Math.round(MINI * ratio);
        const ctx = base.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, MINI, MINI);
        const middle = MINI / 2;
        const scale = miniScale(f);
        ctx.strokeStyle = color.line;
        ctx.lineWidth = 1;
        for (const r of f.radiusRange) {
            dot(ctx, middle, middle, r * scale);
            ctx.stroke();
        }
        // 节点太多时隔几个画一个：缩略图只要看得出哪里密、哪里疏。
        const stride = Math.max(1, Math.ceil(f.count / 16000));
        ctx.fillStyle = color.text2;
        ctx.globalAlpha = Math.min(0.85, Math.max(0.3, Math.sqrt(3000 / (f.count / stride))));
        ctx.beginPath();
        for (let i = 0; i < f.count; i += stride) ctx.rect(middle + f.wx[i] * scale - 0.6, middle + f.wy[i] * scale - 0.6, 1.2, 1.2);
        ctx.fill();
        miniBase = { canvas: base, field: f, version: f.version, ratio };
        return base;
    }
    /** 主画面现在看到的范围，换到缩略图的坐标里：[左, 上, 右, 下]。 */
    function miniView(f, cam) {
        const middle = MINI / 2;
        const scale = miniScale(f) / cam.scale;
        return [middle - cam.x * scale, middle - cam.y * scale, middle + (size.width - cam.x) * scale, middle + (size.height - cam.y) * scale];
    }
    function drawMini(f, cam, show, picked, focused) {
        mini.hidden = !show;
        if (!show) return;
        const ratio = size.ratio;
        const pixels = Math.round(MINI * ratio);
        if (mini.width !== pixels) { mini.width = pixels; mini.height = pixels; }
        const ctx = mini.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, MINI, MINI);
        ctx.drawImage(miniBaseOf(f, ratio), 0, 0, MINI, MINI);
        const middle = MINI / 2;
        const scale = miniScale(f);
        if (focused != null) {
            ctx.strokeStyle = color.terra;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(middle, middle, (f.radiusRange[1] + 0.03) * scale, f.arcs[focused][0] - Math.PI / 2, f.arcs[focused][1] - Math.PI / 2);
            ctx.stroke();
        }
        if (picked != null) {
            ctx.fillStyle = color.terra;
            dot(ctx, middle + f.wx[picked] * scale, middle + f.wy[picked] * scale, 2.6);
            ctx.fill();
        }
        // 当前看到的范围。放得很大时框会小到看不见，所以至少画 7 像素见方。
        let [left, top, right, bottom] = miniView(f, cam);
        if (right - left < 7) { const c = (left + right) / 2; left = c - 3.5; right = c + 3.5; }
        if (bottom - top < 7) { const c = (top + bottom) / 2; top = c - 3.5; bottom = c + 3.5; }
        left = Math.max(1, left);
        top = Math.max(1, top);
        right = Math.min(MINI - 1, right);
        bottom = Math.min(MINI - 1, bottom);
        ctx.fillStyle = color.terraHi;
        ctx.globalAlpha = 0.14;
        ctx.fillRect(left, top, right - left, bottom - top);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color.terraHi;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(left, top, right - left, bottom - top);
    }
    let miniDrag = null;
    function miniPoint(event) {
        const rect = mini.getBoundingClientRect();
        return [event.clientX - rect.left, event.clientY - rect.top];
    }
    /** 把主画面的中心移到缩略图上的这一点。 */
    function miniMoveTo(mx, my) {
        const f = field();
        if (!f) return;
        const cam = ownCamera();
        const scale = miniScale(f);
        cam.x = size.width / 2 - (mx - MINI / 2) / scale * cam.scale;
        cam.y = size.height / 2 - (my - MINI / 2) / scale * cam.scale;
        schedule();
    }
    function onMiniDown(event) {
        const f = field();
        if (event.button !== 0 || !f) return;
        const [mx, my] = miniPoint(event);
        const [left, top, right, bottom] = miniView(f, camera());
        // 按在框里：拖着框走，框不跳；按在框外：框的中心直接到这一点。
        const inside = mx >= left - 4 && mx <= right + 4 && my >= top - 4 && my <= bottom + 4;
        miniDrag = inside ? { dx: mx - (left + right) / 2, dy: my - (top + bottom) / 2 } : { dx: 0, dy: 0 };
        miniMoveTo(mx - miniDrag.dx, my - miniDrag.dy);
        mini.setPointerCapture(event.pointerId);
    }
    function onMiniMove(event) {
        if (!miniDrag) return;
        const [mx, my] = miniPoint(event);
        miniMoveTo(mx - miniDrag.dx, my - miniDrag.dy);
    }
    function onMiniUp(event) {
        miniDrag = null;
        if (mini.hasPointerCapture(event.pointerId)) mini.releasePointerCapture(event.pointerId);
    }
    function onMiniWheel(event) {
        if (!field()) return;
        event.preventDefault();
        zoomAt(size.width / 2, size.height / 2, Math.exp(-event.deltaY * 0.0016));
        schedule();
    }

    function tickStep(span) {
        if (span <= 8) return 1;
        if (span <= 20) return 2;
        if (span <= 50) return 5;
        if (span <= 100) return 10;
        return 30;
    }

    function drawQuery(ctx, f, q) {
        const slice = currentSlice();
        const box = slice || plotBox();
        const [from, to] = queryWindow();
        const [inner, outer] = f.radiusRange;
        const X = slice?.X || (theta => box.left + (theta - from) / (to - from) * (box.right - box.left));
        const Y = slice?.Y || (radius => box.bottom - (radius - (inner - 0.02)) / (outer - inner + 0.04) * (box.bottom - box.top));
        const chosen = state.selected && state.selected.kind === state.kind ? state.selected.index : null;
        const picked = chosen === q.query.index ? null : chosen;

        // 图框和刻度。
        ctx.lineWidth = 1;
        ctx.strokeStyle = color.line;
        ctx.strokeRect(box.left + 0.5, box.top + 0.5, box.right - box.left, box.bottom - box.top);
        ctx.font = font(11);
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        for (let r = inner, step = 0; r <= outer + 1e-6; r += 0.05, step++) {
            const y = Math.round(Y(r)) + 0.5;
            ctx.strokeStyle = color.lineSoft;
            ctx.setLineDash([1, 5]);
            ctx.beginPath();
            ctx.moveTo(box.left, y);
            ctx.lineTo(box.right, y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.strokeStyle = color.line;
            ctx.beginPath();
            ctx.moveTo(box.left - (step % 2 ? 3 : 6), y);
            ctx.lineTo(box.left, y);
            ctx.stroke();
            if (step % 2 === 0) { ctx.fillStyle = color.text3; ctx.fillText(r.toFixed(2), box.left - 10, y); }
        }
        const step = tickStep(to - from);
        ctx.textAlign = 'center';
        for (let t = Math.ceil(from / step) * step; t <= to + 1e-6; t += step) {
            const x = Math.round(X(t)) + 0.5;
            ctx.strokeStyle = color.line;
            ctx.beginPath();
            ctx.moveTo(x, box.bottom);
            ctx.lineTo(x, box.bottom + 6);
            ctx.moveTo(x, box.top);
            ctx.lineTo(x, box.top - 5);
            ctx.stroke();
            ctx.fillStyle = color.text3;
            ctx.fillText(`${t}°`, x, box.bottom + 16);
            ctx.fillText(Math.cos(t * Math.PI / 180).toFixed(2), x, box.top - 14);
        }
        ctx.fillStyle = color.umber;
        ctx.font = font(11.5);
        ctx.textAlign = 'right';
        ctx.fillText('与查询方向的夹角', box.right, box.bottom + 34);
        ctx.fillText('余弦', box.right, box.top - 30);
        ctx.textAlign = 'left';
        ctx.fillText('越靠左越近', box.left, box.bottom + 34);
        // 纵轴名称竖排：字一个个从上往下写。附注用竖排的直角引号括起来，引号是两道折线，自己画，不靠字体。
        {
            const x = 21;
            const step = 14.5;
            const corner = 5;
            const name = [...'节点半径'];
            const note = [...'下为里圈'];
            let y = (box.top + box.bottom) / 2 - (name.length * step + 9 + corner + 3 + note.length * step + 3 + corner) / 2;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.strokeStyle = color.umber;
            ctx.lineWidth = 1;
            for (const character of name) { ctx.fillText(character, x, y + step / 2); y += step; }
            y += 9;
            ctx.beginPath();
            ctx.moveTo(x - 5, y + 0.5);
            ctx.lineTo(x + 6.5, y + 0.5);
            ctx.lineTo(x + 6.5, y + corner + 0.5);
            ctx.stroke();
            y += corner + 3;
            for (const character of note) { ctx.fillText(character, x, y + step / 2); y += step; }
            y += 3;
            ctx.beginPath();
            ctx.moveTo(x - 6.5, y);
            ctx.lineTo(x - 6.5, y + corner + 0.5);
            ctx.lineTo(x + 5, y + corner + 0.5);
            ctx.stroke();
        }

        ctx.save();
        ctx.beginPath();
        ctx.rect(box.left + 1, box.top + 1, box.right - box.left - 1, box.bottom - box.top - 1);
        ctx.clip();

        // 等距离线：当前 K 的那条画实一点。
        const label = labeler(ctx);
        const tags = [];
        for (const contour of q.contours) {
            if (contour.points.length < 2) continue;
            const main = contour.rank === state.k;
            ctx.strokeStyle = color.mark;
            ctx.globalAlpha = main ? 0.95 : 0.5;
            ctx.lineWidth = main ? 1.4 : 1;
            ctx.setLineDash(main ? [7, 4] : [3, 5]);
            ctx.beginPath();
            contour.points.forEach(([radius, theta], n) => { if (n) ctx.lineTo(X(theta), Y(radius)); else ctx.moveTo(X(theta), Y(radius)); });
            ctx.stroke();
            const topPoint = contour.points[contour.points.length - 1];
            tags.push({ x: X(topPoint[1]), y: Y(topPoint[0]) + 12, text: `第 ${contour.rank} 近`, main });
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        // 节点：先画远处的云，再画前 40，再画前 K。
        const k = state.k;
        const margin = 8;
        const inside = [];
        for (const i of q.byDistance) {
            const x = X(q.theta[i]);
            if (x < box.left - margin || x > box.right + margin) continue;
            inside.push(i);
        }
        for (const i of inside) {
            const rank = q.distanceRank[i];
            if (rank <= 40 || q.cosineRank[i] <= k) continue;
            ctx.fillStyle = color.text3;
            ctx.globalAlpha = 0.75;
            dot(ctx, X(q.theta[i]), Y(f.radius[i]), 1.5);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        for (const i of inside) {
            const x = X(q.theta[i]);
            const y = Y(f.radius[i]);
            const rank = q.distanceRank[i];
            const cosine = q.cosineRank[i];
            addHit(i, x, y);
            label.reserve(x, y, rank <= k || cosine <= k ? 6.5 : rank <= 40 ? 4 : 2.5);
            if (rank > 40 && cosine > k) continue;
            if (rank <= k) {
                ctx.fillStyle = cosine > k ? color.terraHi : color.terra;
                if (cosine > k) diamond(ctx, x, y, 6.5); else dot(ctx, x, y, 4.6);
                ctx.fill();
            } else if (cosine <= k) {
                ctx.strokeStyle = color.umber;
                ctx.lineWidth = 1.5;
                dot(ctx, x, y, 4.6);
                ctx.stroke();
            } else {
                ctx.fillStyle = color.text2;
                dot(ctx, x, y, 2.6);
                ctx.fill();
            }
        }
        if (picked != null && q.distance[picked] != null) {
            const x = X(q.theta[picked]);
            const y = Y(f.radius[picked]);
            ctx.strokeStyle = color.text;
            ctx.globalAlpha = 0.35;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, box.top);
            ctx.lineTo(x, box.bottom);
            ctx.moveTo(box.left, y);
            ctx.lineTo(box.right, y);
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = color.text;
            dot(ctx, x, y, 9);
            ctx.stroke();
            label.reserve(x, y, 10);
        }
        // 上一次点下去的地方附近的几个节点（右侧栏里列着）：各套一个细圈。
        if (state.nearby && state.nearby.kind === state.kind) {
            ctx.strokeStyle = color.text2;
            ctx.lineWidth = 1;
            for (const i of state.nearby.indices) {
                if (i === picked || q.distance[i] == null) continue;
                dot(ctx, X(q.theta[i]), Y(f.radius[i]), 7);
                ctx.stroke();
            }
        }
        // 指针下面的节点：亮起来并套一圈。
        if (hover != null && hover !== picked && hover !== q.query.index && q.distance[hover] != null) {
            const x = X(q.theta[hover]);
            const y = Y(f.radius[hover]);
            const small = q.distanceRank[hover] > 40 && q.cosineRank[hover] > k;
            if (small) {
                ctx.fillStyle = color.text;
                dot(ctx, x, y, 2.6);
                ctx.fill();
            }
            ctx.strokeStyle = color.text;
            ctx.lineWidth = 1.2;
            dot(ctx, x, y, small ? 6.5 : 8.5);
            ctx.stroke();
        }
        for (const tag of tags) {
            label.place(tag.text, tag.x, tag.y, { fill: tag.main ? color.mark : color.umber, fontSpec: font(11.5), gap: 5 });
        }
        if (picked != null && q.distance[picked] != null) {
            if (picked !== hover) label.place(f.labels[picked], X(q.theta[picked]), Y(f.radius[picked]), { fill: color.text, fontSpec: font(12.5, 600), gap: 13, maxWidth: 260 });
        }
        for (const i of q.byDistance.slice(0, k)) {
            if (i === picked || i === hover) continue;
            label.place(f.labels[i], X(q.theta[i]), Y(f.radius[i]), { fill: color.text, fontSpec: font(11.5), gap: 9 });
        }
        for (const i of q.byCosine.slice(0, k)) {
            if (q.distanceRank[i] <= k || i === picked || i === hover) continue;
            label.place(f.labels[i], X(q.theta[i]), Y(f.radius[i]), { fill: color.text2, fontSpec: font(11.5), gap: 9 });
        }
        if (hover != null && q.distance[hover] != null) {
            drawHoverName(ctx, label, f.labels[hover], X(q.theta[hover]), Y(f.radius[hover]), box);
        }
        ctx.restore();
    }

    // ---------- 指针 ----------
    let drag = null;
    let hover = null;         // 指针下面的节点（下标），没有就是 null
    let hoverGroup = null;    // 指针指着的话题团（弧或名称），没有就是 null
    let groupBoxes = [];      // 这一帧画出来的话题团名称各占的框
    function setHover(index, group = null) {
        if (index === hover && group === hoverGroup) return;
        hover = index;
        hoverGroup = group;
        schedule();
    }
    function nearest(x, y, limit = NEAR) {
        let best = null;
        let bestDistance = limit * limit;
        for (let k = 0; k < hitCount; k++) {
            const d = (hitX[k] - x) ** 2 + (hitY[k] - y) ** 2;
            // equal-distance hits must agree with the first click candidate.
            if (d < bestDistance || (d === bestDistance && (best == null || hitIndex[k] < hitIndex[best]))) {
                best = k;
                bestDistance = d;
            }
        }
        return best == null ? null : { index: hitIndex[best], x: hitX[best], y: hitY[best] };
    }
    /** 这一点附近的全部节点，由近到远。 */
    function around(x, y, limit = NEAR) {
        const found = [];
        for (let k = 0; k < hitCount; k++) {
            const d = (hitX[k] - x) ** 2 + (hitY[k] - y) ** 2;
            if (d <= limit * limit) found.push([d, hitIndex[k]]);
        }
        return found.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(item => item[1]);
    }
    /** 全景图上这一点指着哪个话题团：它的名称，或者它在环外的那段弧。 */
    function groupAt(x, y) {
        const f = field();
        if (!f || state.view !== 'panorama') return null;
        for (const item of groupBoxes) {
            if (x >= item.box[0] && x <= item.box[2] && y >= item.box[1] && y <= item.box[3]) return item.index;
        }
        const cam = camera();
        const distance = Math.hypot(x - cam.x, y - cam.y);
        const arc = (f.radiusRange[1] + 0.03) * cam.scale;
        if (Math.abs(distance - arc) > 7) return null;
        let angle = Math.atan2(x - cam.x, cam.y - y);
        if (angle < 0) angle += TAU;
        const slack = 4 / arc;
        const index = f.arcs.findIndex(([from, to]) => angle >= from - slack && angle <= to + slack);
        return index < 0 ? null : index;
    }
    function point(event) {
        const rect = canvas.getBoundingClientRect();
        return [event.clientX - rect.left, event.clientY - rect.top];
    }
    function onDown(event) {
        if (event.button !== 0 || !field()) return;
        const [x, y] = point(event);
        drag = { x, y, moved: false, lastX: x, lastY: y };
        canvas.setPointerCapture(event.pointerId);
    }
    function onMove(event) {
        const [x, y] = point(event);
        if (!drag) {
            const node = nearest(x, y);
            setHover(node ? node.index : null, node ? null : groupAt(x, y));
            return;
        }
        if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) < 4) return;
        drag.moved = true;
        hover = null;
        hoverGroup = null;
        if (state.view === 'query' && query()) {
            const box = currentSlice() || plotBox();
            const w = queryWindow();
            const shift = -(x - drag.lastX) / (box.right - box.left) * (w[1] - w[0]);
            const clamped = Math.max(-w[0], Math.min(180 - w[1], shift));
            state.window[state.kind] = [w[0] + clamped, w[1] + clamped];
        } else if (state.view === 'panorama') {
            const cam = ownCamera();
            cam.x += x - drag.lastX;
            cam.y += y - drag.lastY;
        }
        drag.lastX = x;
        drag.lastY = y;
        schedule();
    }
    function onUp(event) {
        if (!drag) return;
        const wasDrag = drag.moved;
        drag = null;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        if (wasDrag) return;
        const [x, y] = point(event);
        const f = field();
        const close = f ? around(x, y) : [];
        if (close.length) {
            // 这一处不止一个节点：选中最近的，其余的列在右侧栏里，不用反复瞄准。
            const nearby = close.length > 1 ? { kind: state.kind, indices: close.slice(0, 12), total: close.length } : null;
            select(state.kind, { index: close[0], id: f.ids[close[0]] }, { nearby });
            return;
        }
        const group = groupAt(x, y);
        if (group != null) toggleFocus(group);
        else if (state.selected) clearSelection();
    }
    function onWheel(event) {
        if (!field()) return;
        event.preventDefault();
        const [x, y] = point(event);
        const factor = Math.exp(-event.deltaY * 0.0016);
        if (state.view === 'query' && query()) {
            const box = currentSlice() || plotBox();
            const w = queryWindow();
            const span = Math.max(2, Math.min(180, (w[1] - w[0]) / factor));
            const anchor = w[0] + (x - box.left) / (box.right - box.left) * (w[1] - w[0]);
            let from = anchor - (anchor - w[0]) * span / (w[1] - w[0]);
            from = Math.max(0, Math.min(180 - span, from));
            state.window[state.kind] = [from, from + span];
        } else if (state.view === 'panorama') {
            zoomAt(x, y, factor);
        }
        schedule();
    }
    /** 复位：查询视图回到默认的夹角范围；全景图回到整圈，展开的话题团收起。 */
    function onReset() {
        if (state.view === 'query') { state.window[state.kind] = null; schedule(); return; }
        const f = field();
        if (f && state.focus[state.kind] != null) { setFocus(null); return; }
        if (f?.motion) f.motion.camTo = null;
        state.camera[state.kind] = null;
        schedule();
    }

    // ---------- 查找 ----------
    let matches = [];
    function renderSearch() {
        const text = searchInput.value.trim().toLowerCase();
        const f = field();
        if (!text || !f) { searchList.hidden = true; matches = []; return; }
        const found = [];
        const push = (item, label) => {
            const at = label.toLowerCase().indexOf(text);
            if (at >= 0) found.push({ ...item, label, at });
        };
        f.labels.forEach((label, index) => push({ index, id: f.ids[index] }, label));
        f.outside.forEach(row => push({ index: null, id: row.id }, row.name));
        found.sort((a, b) => (a.index == null) - (b.index == null) || a.at - b.at || a.label.length - b.label.length);
        matches = found.slice(0, 14);
        searchList.replaceChildren(...matches.map(item => {
            const button = el(doc, 'button');
            button.type = 'button';
            button.append(el(doc, 'span', 'wa-fade', item.label));
            if (item.index == null) button.append(el(doc, 'span', 'wa-search-note', '未进场'));
            button.addEventListener('click', () => pickMatch(item));
            return button;
        }));
        if (!matches.length) searchList.replaceChildren(el(doc, 'div', 'wa-search-note', '没有找到'));
        if (!matches.length) searchList.firstChild.style.padding = '8px 10px';
        searchList.hidden = false;
    }
    function pickMatch(item) {
        searchList.hidden = true;
        searchInput.value = '';
        if (state.view === 'panorama' && item.index != null) {
            const cam = camera();
            if (cam.scale < cam.base * 2.4) cam.scale = cam.base * 2.4;
        }
        select(state.kind, item, { center: 'always' });
    }

    // ---------- 右侧栏 ----------
    function section(caption) {
        const box = el(doc, 'section');
        if (caption) box.append(el(doc, 'div', 'wa-cap', caption));
        return box;
    }
    function rows(pairs) {
        const list = el(doc, 'dl', 'wa-rows');
        for (const [name, value] of pairs) {
            if (value == null) continue;
            list.append(el(doc, 'dt', '', name), el(doc, 'dd', '', value));
        }
        return list;
    }
    function button(text, onClick, primary = false) {
        const b = el(doc, 'button', primary ? 'wa-btn wa-btn-primary' : 'wa-btn', text);
        b.type = 'button';
        b.addEventListener('click', onClick);
        return b;
    }
    // keep relation previews local to the sidebar; never select or fetch on hover.
    let relationPreview = null;
    function setRelationPreview(index) {
        if (index === relationPreview) return;
        relationPreview = index;
        schedule();
    }
    function relationList(items, render, jump) {
        const list = nodeList(items, (row, item) => {
            render(row, item);
            if (item.index != null) row.dataset.relationIndex = String(item.index);
        }, jump);
        list.classList.add('wa-relations');
        // keep evidence for the two directions distinct, even when their canvas edge is shared.
        const evidence = el(doc, 'div', 'wa-note');
        const hint = '指向关系可看贡献来源。';
        evidence.textContent = hint;
        const byRow = new Map(items.map((item, i) => [list.children[i].firstElementChild, item]));
        const indexOfRow = target => {
            const item = byRow.get(target?.closest?.('button, .wa-static'));
            evidence.textContent = !item ? hint : item.sources?.length
                ? '贡献来源：' + item.sources.map(file => `${file.diary} / ${file.name}`).join('；')
                : '没有可核对的文件贡献记录。';
            return item?.index ?? null;
        };
        list.addEventListener('pointerover', event => setRelationPreview(indexOfRow(event.target)));
        list.addEventListener('pointerleave', () => setRelationPreview(indexOfRow(doc.activeElement)));
        list.addEventListener('focusin', event => setRelationPreview(indexOfRow(event.target)));
        list.addEventListener('focusout', event => setRelationPreview(indexOfRow(event.relatedTarget)));
        const group = el(doc, 'div', 'wa-relation-group');
        group.append(list, evidence);
        return group;
    }
    function nodeList(items, render, onPick) {
        const list = el(doc, 'ul', 'wa-list');
        for (const item of items) {
            const li = el(doc, 'li');
            const canPick = onPick && item.index != null;
            const row = el(doc, canPick ? 'button' : 'div', canPick ? '' : 'wa-static');
            if (canPick) { row.type = 'button'; row.addEventListener('click', () => onPick(item)); }
            render(row, item);
            li.append(row);
            list.append(li);
        }
        return list;
    }
    const glyph = {
        entry: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 2 14 8 8 14 2 8Z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
        direction: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 8H14M8 2V14" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
        shell: '<svg width="16" height="16" viewBox="0 0 16 16"><rect x="4.5" y="4.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    };

    function renderOverview(f) {
        const info = section(KIND_NAME[state.kind]);
        info.append(rows([
            ['节点', String(f.count)],
            ['话题团', String(f.groups.length)],
            state.kind === 'tag' && f.snapshot.activeTags != null ? ['未进场的 Tag', String(f.outside.length)] : [null, null],
            ['每个节点的导航边', String(f.snapshot.degree)],
        ]));
        const shells = section('各圈节点数');
        const bars = el(doc, 'div', 'wa-bars');
        const top = Math.max(1, ...f.bins);
        f.bins.forEach((count, n) => {
            const from = 0.35 + n * 0.05;
            const bar = el(doc, 'span', 'wa-bar');
            const fill = el(doc, 'i');
            fill.style.width = `${Math.round(count / top * 100)}%`;
            bar.append(fill);
            bars.append(el(doc, 'span', '', `${from.toFixed(2)}–${(from + 0.05).toFixed(2)}`), bar, el(doc, 'span', '', String(count)));
        });
        shells.append(bars);
        const marks = section('标记');
        for (const [key, name, count] of [['entry', '入口', f.entries], ['direction', '方向地标', f.directions], ['shell', '分圈地标', f.shells]]) {
            const toggle = el(doc, 'button', 'wa-toggle');
            toggle.type = 'button';
            toggle.setAttribute('aria-pressed', String(state.marks[key]));
            toggle.innerHTML = glyph[key];
            toggle.append(el(doc, 'span', '', name), el(doc, 'span', 'wa-num', String(count)));
            toggle.addEventListener('click', () => { state.marks[key] = !state.marks[key]; renderSide(); schedule(); });
            marks.append(toggle);
        }
        if (state.kind === 'tag') marks.append(el(doc, 'div', 'wa-note', '点的大小分三档，入度分位越高越大。'));
        // 话题团：点一个就展开，再点一次收起。节点很密、分不清也点不中时用。
        const groups = section('话题团');
        groups.append(el(doc, 'div', 'wa-note', '点团名或外弧展开，再点一次收起。'));
        const focused = state.focus[state.kind] ?? null;
        const order = f.groups.map((group, index) => ({ group, index })).sort((a, b) => b.group.count - a.group.count);
        const shown = order.slice(0, 24);
        if (focused != null && !shown.some(item => item.index === focused)) shown.push({ group: f.groups[focused], index: focused });
        const groupList = el(doc, 'ul', 'wa-list');
        for (const item of shown) {
            const li = el(doc, 'li');
            const row = el(doc, 'button');
            row.type = 'button';
            row.setAttribute('aria-pressed', String(item.index === focused));
            row.append(el(doc, 'span', 'wa-fade', item.group.label || '未命名'), el(doc, 'span', 'wa-num', String(item.group.count)));
            row.addEventListener('click', () => toggleFocus(item.index));
            li.append(row);
            groupList.append(li);
        }
        groups.append(groupList);
        if (order.length > shown.length) groups.append(el(doc, 'div', 'wa-more', `只列出节点最多的 ${shown.length} 个，共 ${order.length} 个。`));
        const origin = section('数据');
        const check = f.distanceCheck;
        origin.append(rows([
            ['快照', f.snapshot.current ? '当前一代' : '不是当前生效的一代'],
            ['向量维数', String(f.snapshot.dimension)],
            ['距离函数自检', check && check.ok ? `${check.identical} 个格点逐位相同` : '未通过，查询视图停用'],
        ]));
        side.replaceChildren(info, shells, marks, groups, origin);
    }

    /** 上一次点下去的地方不止一个节点时的候选表；没有就返回空数组，方便直接展开进 replaceChildren。 */
    function candidates(f) {
        const near = state.nearby;
        if (!near || near.kind !== state.kind) return [];
        const picked = state.selected && state.selected.kind === state.kind ? state.selected.index : null;
        const box = section(`点的这一处有 ${near.total} 个节点`);
        const list = el(doc, 'ul', 'wa-list');
        for (const index of near.indices) {
            const li = el(doc, 'li');
            const row = el(doc, 'button');
            row.type = 'button';
            row.setAttribute('aria-pressed', String(index === picked));
            row.append(el(doc, 'span', 'wa-fade', f.labels[index]), el(doc, 'span', 'wa-num', fixed(f.radius[index], 3)));
            row.addEventListener('click', () => select(state.kind, { index, id: f.ids[index] }, { keepNearby: true }));
            li.append(row);
            list.append(li);
        }
        box.append(list);
        if (near.total > near.indices.length) box.append(el(doc, 'div', 'wa-more', `只列出离得最近的 ${near.indices.length} 个。放大，或展开所在的话题团，再点会更准。`));
        return [box];
    }
    /** 选中节点后的那个按钮：展开它所在的话题团，或者收起。只在全景图里有。 */
    function focusButton(group) {
        if (state.view !== 'panorama' || group == null) return [];
        const open = state.focus[state.kind] === group;
        return [button(open ? '收起话题团' : '展开所在话题团', () => toggleFocus(group))];
    }

    function renderTag(d, f) {
        const headBox = section('TAG');
        headBox.append(el(doc, 'div', 'wa-name', d.name));
        if (!d.inField) {
            headBox.append(el(doc, 'div', 'wa-sub', '未进入双曲场'));
            headBox.append(el(doc, 'div', 'wa-note', REASON[d.reason] || '没有残差记录，或不在 River 网络的节点表里。'));
            side.replaceChildren(headBox, ...candidates(f), fragments(d));
            return;
        }
        const group = f.groups[d.group];
        headBox.append(rows([
            ['半径', fixed(d.radius, 4)],
            ['入度分位', fixed(d.quantile, 3)],
            ['残差比', fixed(d.residual, 3)],
            ['话题团', group ? `${group.label}（${group.count}）` : null],
            d.flags & FLAG_ENTRY ? ['角色', '入口'] : d.flags & FLAG_DIRECTION ? ['角色', '方向地标'] : [null, null],
        ]));
        const actions = el(doc, 'div', 'wa-actions');
        actions.append(button('以此为查询', () => runQuery(d.id), true), ...focusButton(d.group));
        if (state.view === 'query') actions.append(button('回到全景', () => { state.view = 'panorama'; centerOn(d.index); renderHead(); renderSide(); schedule(); }));
        headBox.append(actions);

        const lines = section('连线');
        const seg = el(doc, 'div', 'wa-seg');
        segment(seg, [['river', '共现'], ['navigation', '导航'], ['none', '不画']], state.lines, value => { state.lines = value; renderSide(); schedule(); });
        lines.append(seg);
        const jump = item => select('tag', { index: item.index, id: item.id }, { center: false });
        if (state.lines === 'river') {
            if (!d.river) {
                lines.append(el(doc, 'div', 'wa-note', '这个 Tag 不在 River 网络里。'));
            } else {
                lines.append(el(doc, 'div', 'wa-note', '越粗亮，表示相对当前节点的其他连线越强；线长不表示强弱。'));
                const render = (row, item) => {
                    row.append(el(doc, 'span', 'wa-fade', item.name));
                    if (item.wormhole) row.append(el(doc, 'span', 'wa-num wa-dim', '虫洞'));
                    if (item.index == null) row.append(el(doc, 'span', 'wa-num wa-dim', '未进场'));
                    row.append(el(doc, 'span', 'wa-num', fixed(item.weight, 3)));
                };
                lines.append(el(doc, 'div', 'wa-more', `指向它的 ${d.river.incoming.length} 条`), relationList(d.river.incoming, render, jump));
                lines.append(el(doc, 'div', 'wa-more', `它指向的 ${d.river.outgoing.length} 条`), relationList(d.river.outgoing, render, jump));
            }
        } else if (state.lines === 'navigation') {
            const items = d.navigation.map(index => ({ index, id: f.ids[index], name: f.labels[index] }));
            lines.append(el(doc, 'div', 'wa-more', `检索时从它能走到的 ${items.length} 个`));
            lines.append(nodeList(items, (row, item) => {
                row.append(el(doc, 'span', 'wa-fade', item.name), el(doc, 'span', 'wa-num', fixed(f.radius[item.index], 3)));
            }, jump));
        }
        side.replaceChildren(headBox, ...candidates(f), lines, fragments(d));
    }

    function fragments(d) {
        const box = section(`带此 Tag 的日记片段（${d.chunks.total}）`);
        if (!d.chunks.rows.length) { box.append(el(doc, 'div', 'wa-note', '没有。')); return box; }
        box.append(nodeList(d.chunks.rows, (row, item) => {
            row.classList.add('wa-stack');
            row.append(el(doc, 'span', '', `${item.diary} · ${String(item.path || '').split(/[\\/]/).pop()}`), el(doc, 'span', 'wa-excerpt', item.text));
        }, item => select('chunk', { index: item.index, id: item.id }, { center: true })));
        if (d.chunks.total > d.chunks.rows.length) box.append(el(doc, 'div', 'wa-more', `只列出最近的 ${d.chunks.rows.length} 条。`));
        return box;
    }

    function renderChunk(d, f) {
        const headBox = section('日记片段');
        headBox.append(el(doc, 'div', 'wa-name', `${d.diary} · ${String(d.path || '').split(/[\\/]/).pop()}`));
        if (!d.inField) {
            headBox.append(el(doc, 'div', 'wa-sub', '未进入双曲场'));
        } else {
            const group = f.groups[d.group];
            headBox.append(rows([['半径', fixed(d.radius, 4)], ['话题团', group ? `${group.label}（${group.count}）` : null]]));
            const actions = el(doc, 'div', 'wa-actions');
            actions.append(button('以此为查询', () => runQuery(d.id), true), ...focusButton(d.group));
            if (state.view === 'query') actions.append(button('回到全景', () => { state.view = 'panorama'; centerOn(d.index); renderHead(); renderSide(); schedule(); }));
            headBox.append(actions);
        }
        const text = section('正文');
        text.append(el(doc, 'div', 'wa-text', d.text));
        const tags = section(`它的 Tag（${d.tags.length}）`);
        tags.append(nodeList(d.tags, (row, item) => {
            row.append(el(doc, 'span', 'wa-fade', item.name));
            if (item.index == null) row.append(el(doc, 'span', 'wa-num wa-dim', '未进场'));
        }, item => select('tag', { index: item.index, id: item.id }, { center: true })));
        side.replaceChildren(headBox, ...candidates(f), text, tags);
    }

    function drawInset(target, f, q) {
        const ratio = win.devicePixelRatio || 1;
        const width = target.clientWidth || 300;
        const height = 150;
        target.width = Math.round(width * ratio);
        target.height = Math.round(height * ratio);
        const ctx = target.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        const cx = width / 2;
        const cy = height - 22;
        const scale = Math.min((width - 60) / 2, height - 40) / f.radiusRange[1];
        const [inner, outer] = f.radiusRange;
        const [from, to] = queryWindow();
        const wedge = (a0, a1, fill) => {
            ctx.beginPath();
            ctx.arc(cx, cy, outer * scale, -a1 * Math.PI / 180, -a0 * Math.PI / 180);
            ctx.arc(cx, cy, inner * scale, -a0 * Math.PI / 180, -a1 * Math.PI / 180, true);
            ctx.closePath();
            ctx.fillStyle = fill;
            ctx.fill();
        };
        ctx.globalAlpha = 0.16;
        wedge(q.thetaMin, q.thetaMax, color.text2);
        ctx.globalAlpha = 0.9;
        wedge(from, to, color.terra);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color.line;
        ctx.lineWidth = 1;
        for (const r of [inner, outer]) {
            ctx.beginPath();
            ctx.arc(cx, cy, r * scale, Math.PI, 0);
            ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(cx - outer * scale, cy);
        ctx.lineTo(cx - inner * scale, cy);
        ctx.moveTo(cx + inner * scale, cy);
        ctx.lineTo(cx + outer * scale, cy);
        ctx.stroke();
        ctx.fillStyle = color.text;
        diamond(ctx, cx + q.query.radius * scale, cy, 4.5);
        ctx.fill();
        ctx.font = font(11);
        ctx.fillStyle = color.text3;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText('0°', cx + outer * scale + 6, cy);
        ctx.textAlign = 'right';
        ctx.fillText('180°', cx - outer * scale - 6, cy);
        ctx.textAlign = 'center';
        ctx.fillText('查询', cx + q.query.radius * scale, cy + 13);
    }

    function renderQuerySide(f, q) {
        const picked = state.selected && state.selected.kind === state.kind ? state.selected.index : null;
        const fromMessage = q.query.message != null;
        const projection = section('投影');
        const choices = el(doc, 'div', 'wa-seg');
        const supported = f.geometry && f.distanceCheck?.ok;
        segment(choices, [['plot', '坐标图'], ['metric', '黎曼切片', !supported]],
            q.metricMode ? 'metric' : 'plot', mode => {
                if (mode === 'metric' && f.chart === undefined) f.chart = metricChart(f.geometry, f.radiusRange);
                q.metricMode = mode === 'metric' && Boolean(f.chart);
                renderHead(); renderSide(); schedule();
            });
        projection.append(choices);
        if (!supported) projection.append(el(doc, 'div', 'wa-note', '此快照缺少受支持的度规或距离自检未通过。'));
        const headBox = section(fromMessage ? '查询 · 对话消息' : '查询');
        headBox.append(el(doc, 'div', fromMessage ? 'wa-text' : 'wa-name', q.query.label));
        const radiusNote = q.query.radiusFrom === 'default' ? '（取常见值）' : q.query.radiusFrom === 'rule' ? '（按片段的规则算出）' : '';
        headBox.append(rows([['查询半径', `${fixed(q.query.radius, 4)}${radiusNote}`], ['全场夹角范围', `${fixed(q.thetaMin, 1)}°–${fixed(q.thetaMax, 1)}°`]]));
        // 节点很多的库：后端先用压缩向量粗算全场，只对最近的一批精算。哪些名次是精确的，在这里说清楚。
        if (q.exact && q.exact.all === false) {
            headBox.append(el(doc, 'div', 'wa-note', `这个场的节点较多：全场的夹角先用压缩向量粗算，最近的 ${q.exact.refined} 个再用原始向量精算。`
                + `按距离的前 ${q.exact.distanceRank} 名、按余弦的前 ${q.exact.cosineRank} 名与全部精算的结果一致；更靠后的节点位置有约万分之几的偏差。`));
        }
        const actions = el(doc, 'div', 'wa-actions');
        if (picked != null && picked !== q.query.index) actions.append(button('以选中的节点为查询', () => runQuery(f.ids[picked]), true));
        actions.append(button('回到全景', () => { state.view = 'panorama'; renderHead(); renderSide(); schedule(); }));
        headBox.append(actions);

        const where = section('这一段在半圆上的位置');
        const inset = el(doc, 'canvas', 'wa-inset');
        where.append(inset);

        const near = section('最近的');
        const seg = el(doc, 'div', 'wa-seg');
        segment(seg, [5, 10, 20, 40].map(n => [n, `${n} 条`]), state.k, value => { state.k = value; renderSide(); schedule(); });
        near.append(seg);
        const legend = el(doc, 'div', 'wa-legend');
        legend.innerHTML = `<span><svg width="12" height="12"><circle cx="6" cy="6" r="4.6" fill="var(--wa-terra)"/></svg>两种排法都在前 ${state.k}</span>`
            + `<span><svg width="14" height="14"><path d="M7 .5 13.5 7 7 13.5 .5 7Z" fill="var(--wa-terra-hi)"/></svg>因半径被提前</span>`
            + `<span><svg width="12" height="12"><circle cx="6" cy="6" r="4.4" fill="none" stroke="var(--wa-umber)" stroke-width="1.5"/></svg>因半径被挤出</span>`;
        near.append(legend);
        const table = el(doc, 'table', 'wa-table');
        table.innerHTML = '<colgroup><col class="wa-c-rank"><col><col class="wa-c-num"><col class="wa-c-num"><col class="wa-c-num"><col class="wa-c-move"></colgroup>'
            + '<thead><tr><th>#</th><th>名称</th><th>距离</th><th>余弦</th><th>半径</th><th>余弦名次</th></tr></thead>';
        const bodyRows = el(doc, 'tbody');
        const addRow = (i, rankText) => {
            const tr = el(doc, 'tr');
            tr.dataset.index = String(i);
            if (i === picked) tr.dataset.picked = 'true';
            const move = q.cosineRank[i] - q.distanceRank[i];
            const moveCell = el(doc, 'td', move > 0 ? 'wa-up' : move < 0 ? 'wa-down' : 'wa-dim',
                move > 0 ? `${q.cosineRank[i]} ↑${move}` : move < 0 ? `${q.cosineRank[i]} ↓${-move}` : String(q.cosineRank[i]));
            tr.append(el(doc, 'td', 'wa-dim', rankText), el(doc, 'td', '', f.labels[i]), el(doc, 'td', '', fixed(q.distance[i], 3)),
                el(doc, 'td', '', fixed(Math.cos(q.theta[i] * Math.PI / 180), 3)), el(doc, 'td', '', fixed(f.radius[i], 3)), moveCell);
            tr.addEventListener('click', () => select(state.kind, { index: i, id: f.ids[i] }));
            bodyRows.append(tr);
        };
        q.byDistance.slice(0, state.k).forEach((i, n) => addRow(i, String(n + 1)));
        table.append(bodyRows);
        near.append(table);

        const pushed = q.byCosine.slice(0, state.k).filter(i => q.distanceRank[i] > state.k);
        const out = section(`只按余弦会进前 ${state.k}、按双曲距离被挤出的（${pushed.length}）`);
        if (pushed.length) {
            const table2 = el(doc, 'table', 'wa-table');
            table2.innerHTML = table.querySelector('colgroup').outerHTML;
            const body2 = el(doc, 'tbody');
            table2.append(body2);
            const keep = bodyRows;
            pushed.forEach(i => {
                addRow(i, String(q.distanceRank[i]));
                body2.append(keep.lastChild);
            });
            out.append(table2);
        } else {
            out.append(el(doc, 'div', 'wa-note', '没有，两种排法的前几名相同。'));
        }
        side.replaceChildren(headBox, projection, where, near, out, ...(state.messages ? [messagePicker()] : []));
        drawInset(inset, f, q);
    }

    // 对话消息的挑选框：建一次一直用，重画右侧栏时输入的字和光标不丢。
    let picker = null;
    function messagePicker() {
        if (picker) return picker;
        const box = section('换一条对话消息来查');
        const input = el(doc, 'input', 'wa-input');
        input.type = 'text';
        input.placeholder = '查找对话消息';
        input.spellcheck = false;
        const note = el(doc, 'div', 'wa-note');
        const list = el(doc, 'ul', 'wa-list');
        box.append(input, note, list);
        const two = value => String(value).padStart(2, '0');
        const stamp = at => { const d = new Date(at); return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };
        let timer = 0;
        let token = 0;
        const load = async () => {
            const mine = ++token;
            try {
                const text = input.value.trim();
                const data = await source.get(text ? `/messages?q=${encodeURIComponent(text)}` : '/messages');
                if (mine !== token || disposed) return;
                note.textContent = data.rows.length ? '' : '没有找到';
                list.replaceChildren(...data.rows.map(row => {
                    const li = el(doc, 'li');
                    const item = el(doc, 'button', 'wa-stack');
                    item.type = 'button';
                    item.append(el(doc, 'span', 'wa-num wa-dim', stamp(row.at)), el(doc, 'span', 'wa-excerpt', row.text));
                    item.addEventListener('click', () => runQuery({ message: row.hash }));
                    li.append(item);
                    return li;
                }));
            } catch (error) {
                if (mine !== token) return;
                note.textContent = error.message;
                list.replaceChildren();
            }
        };
        input.addEventListener('input', () => { win.clearTimeout(timer); timer = win.setTimeout(load, 250); });
        load();
        picker = box;
        return box;
    }

    function renderSide() {
        setRelationPreview(null);
        const f = field();
        if (!f) { side.replaceChildren(); return; }
        if (state.view === 'query' && query()) { renderQuerySide(f, query()); return; }
        if (state.view === 'query' && (!state.selected || state.selected.kind !== state.kind)) {
            const hint = section('查询');
            hint.append(el(doc, 'div', 'wa-note', state.messages
                ? '在全景图里点选一个节点再按“以此为查询”，或者在下面选一条对话消息。'
                : '先在全景图里点选一个节点，再按“以此为查询”。'));
            side.replaceChildren(hint, ...(state.messages ? [messagePicker()] : []));
            return;
        }
        if (!state.selected || state.selected.kind !== state.kind) { renderOverview(f); return; }
        const d = state.detail;
        if (!d) { side.replaceChildren(el(doc, 'div', 'wa-note', '正在读取'), ...candidates(f)); return; }
        if (d.failed) { side.replaceChildren(el(doc, 'div', 'wa-note', d.failed), ...candidates(f)); return; }
        if (d.kind === 'tag') renderTag(d, f); else renderChunk(d, f);
    }

    // ---------- 接线 ----------
    // 图上的字是画上去的：网页字体按字分块加载，每到一块就重画一次，不然先画出来的还是后备字体。
    const onFontsLoaded = () => {
        // 字体换了，量过的名称宽度作废。
        for (const f of Object.values(state.fields)) f.labelWidth.fill(0);
        schedule();
    };
    doc.fonts?.addEventListener?.('loadingdone', onFontsLoaded);
    const observer = new win.ResizeObserver(resize);
    observer.observe(stage);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', () => { drag = null; });
    canvas.addEventListener('pointerleave', () => setHover(null));
    canvas.addEventListener('wheel', onWheel, { passive: false });
    mini.addEventListener('pointerdown', onMiniDown);
    mini.addEventListener('pointermove', onMiniMove);
    mini.addEventListener('pointerup', onMiniUp);
    mini.addEventListener('pointercancel', () => { miniDrag = null; });
    mini.addEventListener('wheel', onMiniWheel, { passive: false });
    reset.addEventListener('click', onReset);
    searchInput.addEventListener('input', renderSearch);
    searchInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && matches.length) { event.preventDefault(); pickMatch(matches[0]); }
        if (event.key === 'Escape') { event.stopPropagation(); searchList.hidden = true; searchInput.blur(); }
    });
    const onDocumentDown = event => { if (!search.contains(event.target)) searchList.hidden = true; };
    doc.addEventListener('pointerdown', onDocumentDown);
    resize();
    start();

    return {
        refreshTheme() {
            if (disposed) return;
            color = readColors();
            miniBase = null;
            const inset = side.querySelector('.wa-inset');
            if (inset && field() && query()) drawInset(inset, field(), query());
            schedule();
        },
        dispose() {
            disposed = true;
            if (frame) win.cancelAnimationFrame(frame);
            observer.disconnect();
            doc.fonts?.removeEventListener?.('loadingdone', onFontsLoaded);
            doc.removeEventListener('pointerdown', onDocumentDown);
            root.remove();
        },
        /** 冒烟脚本用：不等下一帧，立刻重画；正在移动的节点直接到位。 */
        flush: () => {
            if (frame) { win.cancelAnimationFrame(frame); frame = 0; }
            if (field()?.motion) field().motion.start = -1e9;
            draw();
        },
        /** 自动核对和冒烟脚本读这个。 */
        inspect: () => ({ kind: state.kind, view: state.view, selected: state.selected, nodesOnScreen: hitCount, k: state.k, hover, hoverGroup,
            sample: hitCount ? { index: hitIndex[hitCount >> 1], x: hitX[hitCount >> 1], y: hitY[hitCount >> 1] } : null,
            focus: state.focus[state.kind] ?? null, mini: !mini.hidden, nearby: state.nearby ? state.nearby.total : 0,
            groupLabels: groupBoxes.map(item => ({ index: item.index, x: (item.box[0] + item.box[2]) / 2, y: (item.box[1] + item.box[3]) / 2 })),
            camera: state.view === 'panorama' && field() ? { ...camera() } : null,
            query: query() ? { id: query().query.id, top: query().byDistance.slice(0, state.k).map(i => field().ids[i]) } : null }),
        /** 冒烟脚本用：节点现在画在画面上的哪里。 */
        positionOf: index => { const f = field(); const cam = camera(); return f ? { x: cam.x + f.wx[index] * cam.scale, y: cam.y + f.wy[index] * cam.scale } : null; },
        focus: setFocus,
        select: (kind, id) => {
            const f = state.fields[kind];
            const index = f ? f.ids.indexOf(id) : -1;
            return select(kind, { index: index < 0 ? null : index, id }, { center: true });
        },
        runQuery,
    };
}
