// Musicmodules/music-dock/music-dock-fluid.js
// 底栏播放条的流体层：一组 SVG 形状（播放条、播放键鼓包、跟手的鼓包、音量水滴、切歌分裂的水滴），
// 先模糊再按透明度阈值收边，形状之间就像液体一样相连、让位、分裂。
// 同一组形状画两份：清晰的一份是「实心」，再模糊一次的一份是「雾」。实心那份用横向渐变遮住，
// 遮罩的边界就是播放进度；暂停时实心那份整体淡掉，整条化成雾。
// 只有形状在动的时候才逐帧更新；静止时不跑循环，进度遮罩由底栏每 250ms 推一次。
(function (global) {
    'use strict';

    const NS = 'http://www.w3.org/2000/svg';
    const PAD_X = 140;      // 播放条左右各留出的余量（分裂的水滴往右飞、光晕外扩）
    const LAYER_H = 320;    // 流体层高度：播放条之上要容纳音量水滴和小环
    const RING_R = 20;      // 小环半径（外径 40）
    const HOLE_R = 34;      // 小环在播放条上挖出的凹口
    const VOL_RISE = 112;   // 音量水滴升起的高度

    function createMusicDockFluid(options) {
        const { host, bar, ring, reduced = () => false, onRingMove = null } = options || {};
        if (!host || !bar) return null;
        const doc = host.ownerDocument;
        const win = doc.defaultView || global;
        const uid = `mdf${Math.random().toString(36).slice(2, 8)}`;
        const id = (name) => `${uid}-${name}`;
        const make = (tag, attrs = {}, parent = null) => {
            const node = doc.createElementNS(NS, tag);
            for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
            if (parent) parent.appendChild(node);
            return node;
        };

        // ── 雾床：播放条后面一块羽化的背景模糊 ──
        const mist = doc.createElement('div');
        mist.className = 'md-mist';
        mist.setAttribute('aria-hidden', 'true');
        host.insertBefore(mist, host.firstChild);

        // ── SVG ──
        const svg = make('svg', { class: 'md-fluid', 'aria-hidden': 'true', focusable: 'false' });
        const defs = make('defs', {}, svg);
        const inner = make('radialGradient', { id: id('inner'), gradientUnits: 'userSpaceOnUse' }, defs);
        const in0 = make('stop', { offset: '0' }, inner);
        const in1 = make('stop', { offset: '.45' }, inner);
        const in2 = make('stop', { offset: '.9' }, inner);

        // 小环在播放条上挖出的凹口：用裁剪路径（整层的矩形减去一个圆，evenodd），不用遮罩。
        // 这块形状被三道模糊各引用一次；遮罩要逐次按亮度栅格化，每帧提交时贵得多，裁剪只是几何运算，样子一样（凹口本来就是硬边的圆）。
        const holeClip = make('clipPath', { id: id('hole'), clipPathUnits: 'userSpaceOnUse' }, defs);
        const holePath = make('path', { 'clip-rule': 'evenodd', d: '' }, holeClip);
        let holeD = '';
        const setHole = (cx, cy, r) => {
            const W = geo.layerW, H = LAYER_H;
            let d = `M0 0H${W}V${H}H0Z`;
            if (r > 0.05) d += `M${(cx - r).toFixed(1)} ${cy.toFixed(1)}a${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(2 * r).toFixed(2)} 0a${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(-2 * r).toFixed(2)} 0Z`;
            if (d !== holeD) { holeD = d; holePath.setAttribute('d', d); }
        };

        const hGrad = make('linearGradient', { id: id('h'), gradientUnits: 'userSpaceOnUse', y1: 0, y2: 0 }, defs);
        make('stop', { offset: '0', 'stop-color': '#fff' }, hGrad);
        const h1 = make('stop', { offset: '.4', 'stop-color': '#fff' }, hGrad);
        const h2 = make('stop', { offset: '.58', 'stop-color': '#fff', 'stop-opacity': '.12' }, hGrad);
        make('stop', { offset: '1', 'stop-color': '#fff', 'stop-opacity': '.05' }, hGrad);
        const rgS = make('radialGradient', { id: id('rs') }, defs);
        make('stop', { offset: '.35', 'stop-color': '#fff' }, rgS);
        make('stop', { offset: '1', 'stop-color': '#fff', 'stop-opacity': '0' }, rgS);
        const solidMask = make('mask', { id: id('solid'), maskUnits: 'userSpaceOnUse' }, defs);
        const solidR = make('rect', { x: 0, y: 0, fill: `url(#${id('h')})` }, solidMask);
        const ringSolid = make('circle', { r: 0, fill: `url(#${id('rs')})` }, solidMask);
        // 音量水滴整个是实心的：用一块边缘羽化的椭圆，不要硬边。
        const volSolid = make('ellipse', { fill: `url(#${id('rs')})`, opacity: 0 }, solidMask);
        const quickSolid = make('ellipse', { fill: `url(#${id('rs')})`, opacity: 0 }, solidMask);

        // 雾和光晕只许溢出播放条外沿 16px：用一块羽化的圆角矩形（加上音量水滴升起的那一列）把它们框住。
        const vapMask = make('mask', { id: id('vap'), maskUnits: 'userSpaceOnUse' }, defs);
        const feather = make('filter', { id: id('feather'), filterUnits: 'userSpaceOnUse', x: 0, y: 0 }, defs);
        make('feGaussianBlur', { stdDeviation: 4 }, feather);
        const vapG0 = make('g', { filter: `url(#${id('feather')})`, fill: '#fff' }, vapMask);
        const vapR = make('rect', {}, vapG0);
        const vapCol = make('rect', {}, vapG0);
        const vapSplit = make('rect', { width: 0 }, vapG0);
        const vapQuick = make('rect', { width: 0 }, vapG0); // 快捷操作胶囊分裂上去时放开那一块 // 切歌分裂的水滴往右飞时临时放开

        const filterAttrs = { filterUnits: 'userSpaceOnUse', x: 0, y: 0, 'color-interpolation-filters': 'sRGB' };
        const goo = make('filter', { id: id('goo'), ...filterAttrs }, defs);
        make('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 8, result: 'b' }, goo);
        make('feColorMatrix', { in: 'b', values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -11' }, goo);
        const vapor = make('filter', { id: id('vapor'), ...filterAttrs }, defs);
        make('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 8, result: 'b' }, vapor);
        make('feColorMatrix', { in: 'b', values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -11', result: 'g' }, vapor);
        make('feGaussianBlur', { in: 'g', stdDeviation: 11 }, vapor);
        const bloom = make('filter', { id: id('bloom'), ...filterAttrs }, defs);
        make('feGaussianBlur', { stdDeviation: 18 }, bloom);
        const filters = [goo, vapor, bloom];

        const body = make('g', { id: id('body'), 'clip-path': `url(#${id('hole')})` }, defs);
        const barR = make('rect', {}, body);
        const playC = make('circle', {}, body);
        const bumpC = make('circle', { r: 0 }, body);
        const volB = make('rect', {}, body);
        const splitC = make('circle', { r: 0 }, body);
        const quickNeck = make('rect', { width: 0 }, body);
        const quickB = make('rect', { height: 0 }, body);

        const vapG = make('g', { mask: `url(#${id('vap')})` }, svg);
        make('use', { href: `#${id('body')}`, filter: `url(#${id('bloom')})`, class: 'md-fl-bloom' }, vapG);
        const vaporG = make('g', { class: 'md-fl-vapor' }, vapG);
        make('use', { href: `#${id('body')}`, filter: `url(#${id('vapor')})`, fill: `url(#${id('inner')})` }, vaporG);
        const solidG = make('g', { mask: `url(#${id('solid')})` }, vapG);
        make('use', { href: `#${id('body')}`, filter: `url(#${id('goo')})`, fill: `url(#${id('inner')})` }, solidG);
        host.insertBefore(svg, mist.nextSibling);

        // ── 状态 ──
        // 每个量都有「当前」和「目标」，循环里按指数逼近；没有在动的量时循环停下。
        const geo = { x: 0, y: 0, w: 0, h: 0, left: 0, bottom: 0, layerW: 0, playX: 0, volX: 0, ringX: 0 };
        const s = {
            progress: 0,
            // 进度在播放条宽度里走的区间（0～1）：起点由 music-dock.js 量成曲名左缘，终点在音量键前。
            range: { a: 0.06, b: 0.94 },
            solidity: { v: 1, t: 1 },
            bump: { x: 0, r: 0, tx: 0, tr: 0 },
            vol: { v: 0, t: 0 },
            quick: { v: 0, t: 0, x: 0, y: 0, w: 0, h: 0 },
            split: { p: 1 },
            ring: { x: 0, y: 0, tx: 0, ty: 0, docked: true, placed: false },
            // 小环在播放条上的角色（默认由 music-dock.js 设成 playhead）：
            // fixed 停在条顶固定位置；playhead 当播放头，跟着进度走，暂停时沉进条里；
            // hover 平时藏起来，指针在条上时才浮出；drop 平时藏起来，切歌时从上方落进条里再化开。
            ringMode: 'fixed',
            show: { v: 1, t: 1 },
            // 播放头平时缩成一颗小珠子贴在进度线上；指针移到它身上或拖动时才放大成完整的环。
            size: { v: 0.55, t: 0.55 },
            playing: true,
            ringFocus: false,
            drop: { p: 1 },
            enabled: true,
            hidden: false,     // 窗口不可见
            suspended: false,  // 窗口失焦
            attended: false,   // 指针正停在底栏上（窗口失焦时也照常播过渡动画）
            dirty: false
        };
        let frame = 0;
        let last = 0;

        const GLOW_MS = 600;
        const glow = { cur: [null, null, null], frame: 0 };
        const parseHex = (hex) => {
            const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
            if (!m) return null;
            const n = parseInt(m[1], 16);
            return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
        };
        const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
        const setAttr = (node, name, value) => {
            const text = typeof value === 'number' ? value.toFixed(2) : String(value);
            if (node.getAttribute(name) !== text) node.setAttribute(name, text);
        };

        // 播放条在窗口里的位置变了（窗口缩放、紧凑档）就重新量。
        // 右侧抽屉打开时播放条整体往左让位（CSS 的 translate 属性，流体层同步平移）。
        // 这里量位置时扣掉当前的平移量，层自己的 left 记的是没平移时的位置。
        const dockEl = bar.closest('.md-dock');
        let cachedShift = 0;
        let shiftAt = -1e9;
        let shiftActive = false;
        const shiftX = (fresh = false) => {
            const now = (win.performance || Date).now();
            if (!fresh && now - shiftAt < 120) return cachedShift;
            const rawVar = host.style.getPropertyValue('--md-shift').trim();
            const hasVar = Boolean(rawVar) && rawVar !== '0' && rawVar !== '0px';
            const inlineT = dockEl?.style?.translate?.trim();
            const hasInline = Boolean(inlineT) && inlineT !== 'none' && inlineT !== '0' && inlineT !== '0px';
            // 抽屉未展开让位且无进行中的位移动画时，跳过昂贵的 getComputedStyle(dockEl)
            if (!hasVar && !hasInline && !shiftActive && cachedShift === 0) {
                shiftAt = now;
                return 0;
            }
            const t = dockEl ? win.getComputedStyle(dockEl).translate : '';
            const n = parseFloat(t);
            cachedShift = Number.isFinite(n) ? n : 0;
            shiftActive = hasVar || hasInline || Math.abs(cachedShift) > 0.05;
            shiftAt = now;
            return cachedShift;
        };
        const layout = () => {
            const sx = shiftX(true);
            const raw = bar.getBoundingClientRect();
            const rect = { left: raw.left - sx, right: raw.right - sx, top: raw.top, bottom: raw.bottom, width: raw.width, height: raw.height };
            const vh = win.innerHeight || doc.documentElement.clientHeight || 0;
            if (!(rect.width > 0 && rect.height > 0)) return false;
            geo.layerW = Math.round(rect.width + PAD_X * 2);
            geo.left = Math.round(rect.left - PAD_X);
            // 层的底边比播放条再低一点（最多 24px），光晕和雾在播放条下沿不被裁掉。
            const below = Math.min(24, Math.max(0, Math.round(vh - rect.bottom)));
            geo.bottom = Math.max(0, Math.round(vh - rect.bottom) - below);
            geo.w = rect.width;
            geo.h = rect.height;
            geo.x = PAD_X;
            geo.y = LAYER_H - geo.h - below;
            const playBtn = bar.querySelector('[data-md="play"]');
            const volBtn = host.querySelector('[data-md="vol"]');
            const pr = playBtn?.getBoundingClientRect();
            const vr = volBtn?.getBoundingClientRect();
            geo.playX = pr && pr.width ? pr.left - sx + pr.width / 2 - geo.left : geo.x + geo.h / 2;
            geo.volX = vr && vr.width ? vr.left - sx + vr.width / 2 - geo.left : geo.x + geo.w - geo.h / 2;
            geo.ringX = geo.x + geo.w * 0.63;
            svg.setAttribute('width', geo.layerW);
            svg.setAttribute('height', LAYER_H);
            svg.setAttribute('viewBox', `0 0 ${geo.layerW} ${LAYER_H}`);
            svg.style.left = `${geo.left}px`;
            svg.style.bottom = `${geo.bottom}px`;
            // 雾床平时左右各伸出 180px；播放条挪到目录旁边时 music-dock.js 会把它收窄（--md-mist-pad），不糊到目录上
            const padVar = parseFloat(host.style.getPropertyValue('--md-mist-pad'));
            const pad = Number.isFinite(padVar) ? Math.max(0, Math.min(180, padVar)) : 180;
            mist.style.left = `${Math.round(rect.left - pad)}px`;
            mist.style.width = `${Math.round(rect.width + pad * 2)}px`;
            mist.style.bottom = `${Math.max(0, geo.bottom - 16)}px`;
            for (const f of fitted) { setAttr(f, 'x', 0); setAttr(f, 'width', geo.layerW); }
            holeD = '';
            setAttr(solidR, 'width', geo.layerW); setAttr(solidR, 'height', LAYER_H);
            setAttr(feather, 'width', geo.layerW); setAttr(feather, 'height', LAYER_H);
            const spill = 12; // 加上 4px 羽化 ≈ 外沿 16px
            setAttr(vapR, 'x', geo.x - spill); setAttr(vapR, 'y', geo.y - spill); setAttr(vapR, 'width', geo.w + spill * 2); setAttr(vapR, 'height', geo.h + spill * 2); setAttr(vapR, 'rx', geo.h / 2 + spill);
            setAttr(hGrad, 'x1', geo.x); setAttr(hGrad, 'x2', geo.x + geo.w);
            setAttr(inner, 'cx', geo.x + geo.w * 0.78); setAttr(inner, 'cy', geo.y + geo.h + 12); setAttr(inner, 'r', Math.max(220, geo.w * 0.72));
            const r = geo.h / 2;
            setAttr(barR, 'x', geo.x); setAttr(barR, 'y', geo.y); setAttr(barR, 'width', geo.w); setAttr(barR, 'height', geo.h); setAttr(barR, 'rx', r);
            setAttr(playC, 'cx', geo.playX); setAttr(playC, 'cy', geo.y + r); setAttr(playC, 'r', r + 7);
            setAttr(vapCol, 'x', geo.volX - 24 - 12); setAttr(vapCol, 'y', geo.y - VOL_RISE - 12); setAttr(vapCol, 'width', 48 + 24); setAttr(vapCol, 'height', VOL_RISE + 24); setAttr(vapCol, 'rx', 36);
            setAttr(volSolid, 'cx', geo.volX); setAttr(volSolid, 'cy', geo.y - VOL_RISE / 2 + 6); setAttr(volSolid, 'rx', 70); setAttr(volSolid, 'ry', VOL_RISE);
            if (!s.ring.placed) placeRing(true);
            else retargetRing();
            writeProgress();
            draw(true);
            return true;
        };

        // ── 小环：停在播放条顶边（播放条凹进去让它），或者飞回右下角 ──
        // 角落点换算到层坐标：层的底边在窗口 y = vh - bottom。
        const cornerLocal = () => {
            const vw = win.innerWidth || 0;
            // 紧凑档播放条贴满宽度，右下角被它占着：小环改停在播放条右端上方。
            if (vw < 640) return { x: geo.x + geo.w - 26, y: geo.y - 34 };
            const vh = win.innerHeight || 0;
            // 和抽屉右下角凹口的圆心对齐（music-dock.js 的 NOTCH_D）。
            const cx = vw - 40;
            const cy = vh - 40;
            const layerTop = vh - geo.bottom - LAYER_H;
            return { x: cx - geo.left, y: cy - layerTop };
        };
        const progressFrac = () => s.range.a + Math.min(1, Math.max(0, s.progress)) * (s.range.b - s.range.a);
        const progressX = () => geo.x + geo.w * progressFrac();
        const dockPoint = () => {
            // 暂停或让位时沉进条里（配合 showTarget 一起淡掉），播放时骑在条的上沿。
            if (s.ringMode === 'playhead') return { x: progressX(), y: geo.y + 2 + (playheadUp() ? 0 : 14) };
            if (s.ringMode === 'drop') {
                const p = s.drop.p;
                const fall = p < 0.5 ? 1 - Math.pow(p / 0.5, 2) : 0;
                return { x: geo.ringX, y: geo.y - 2 - fall * 110 + (p > 0.5 ? (p - 0.5) * 28 : 0) };
            }
            return { x: geo.ringX, y: geo.y - 2 };
        };
        // 播放头只在真正播放（或正被拖动）时露出；快捷按钮升起时让开，不和它抢条上方那块位置。
        const playheadUp = () => s.ring.focusDrag || (s.playing && s.quick.t < 0.5);
        const sizeTarget = () => (!s.ring.docked || s.ringMode !== 'playhead' || s.ringFocus || s.ring.focusDrag ? 1 : 0.55);
        // 小环该不该露出来：面板开着时它是关闭按钮，一直露着。
        const showTarget = () => {
            if (!s.ring.docked) return 1;
            if (s.ringMode === 'playhead') return playheadUp() ? 1 : 0;
            if (s.ringMode === 'hover') return s.ringHover ? 1 : 0;
            if (s.ringMode === 'drop') return s.drop.p < 1 ? (s.drop.p < 0.62 ? 1 : 0) : 0;
            return 1;
        };
        const retargetRing = () => {
            const p = s.ring.docked ? dockPoint() : cornerLocal();
            s.ring.tx = p.x; s.ring.ty = p.y;
        };
        const placeRing = (instant) => {
            retargetRing();
            if (instant || !s.ring.placed) { s.ring.x = s.ring.tx; s.ring.y = s.ring.ty; s.ring.placed = true; }
        };

        const writeProgress = () => {
            const x = progressFrac();
            setAttr(h1, 'offset', Math.max(0, x - 0.03).toFixed(3));
            setAttr(h2, 'offset', Math.min(1, x + 0.13).toFixed(3));
        };

        const moving = () => {
            const eps = 0.01;
            return Math.abs(s.solidity.v - s.solidity.t) > eps
                || Math.abs(s.bump.x - s.bump.tx) > 0.5 || Math.abs(s.bump.r - s.bump.tr) > 0.3
                || Math.abs(s.vol.v - s.vol.t) > eps
                || Math.abs(s.quick.v - s.quick.t) > eps
                || s.split.p < 1
                || s.drop.p < 1
                || Math.abs(s.show.v - s.show.t) > 0.01
                || Math.abs(s.size.v - sizeTarget()) > 0.01
                || Math.hypot(s.ring.x - s.ring.tx, s.ring.y - s.ring.ty) > 0.5;
        };

        // 除了小环的位置以外还有没有量在动（进度小步推进时用来判断能不能直接落位）
        const moving2 = () => {
            const eps = 0.01;
            return Math.abs(s.solidity.v - s.solidity.t) > eps || Math.abs(s.bump.r - s.bump.tr) > 0.3
                || Math.abs(s.vol.v - s.vol.t) > eps || Math.abs(s.quick.v - s.quick.t) > eps
                || s.split.p < 1 || s.drop.p < 1
                || Math.abs(s.show.v - showTarget()) > 0.01 || Math.abs(s.size.v - sizeTarget()) > 0.01
                || Math.abs(s.ring.y - s.ring.ty) > 0.5;
        };
        // 三组模糊（实心、雾、光晕）每帧都要重算，算的范围就是滤镜区域。
        // 区域默认是整层（320 高），但平时只有播放条那一条看得见（雾的遮罩只放开条外 16px）。
        // 所以把区域的上沿收到「最高的那块液体」再往上留出模糊的余量，音量水滴、快捷胶囊升起时跟着放开。
        // 余量 56px ≥ 光晕模糊 3σ（18×3=54），遮罩里看得见的部分算出来和整层算的完全一样。
        // 两块遮罩（实心/雾的分界、雾的外沿）也一样：遮罩按区域逐帧算亮度，区域收小，算得就少。
        const FILTER_MARGIN = 56;
        const fitted = [...filters, solidMask, vapMask];
        const fitFilters = (topBody) => {
            const top = Math.min(topBody, geo.y - 16) - FILTER_MARGIN;
            const y = Math.max(0, Math.floor(top / 8) * 8);
            for (const f of fitted) { setAttr(f, 'y', y); setAttr(f, 'height', LAYER_H - y); }
        };
        let lastGrow = '';
        const draw = (force = false) => {
            const sol = s.solidity.v;
            setAttr(solidR, 'opacity', 0.15 + 0.85 * sol);
            setAttr(vaporG, 'opacity', 0.62 + 0.25 * (1 - sol));
            setAttr(bumpC, 'cx', s.bump.x); setAttr(bumpC, 'cy', geo.y + 6); setAttr(bumpC, 'r', Math.max(0, s.bump.r));
            // 音量键在快捷行里时，水滴从快捷行的顶上接着往上长（中间穿过快捷行，是同一团液体）。
            const volBase = s.quick.t > 0.5 && s.quick.w > 0 ? Math.min(geo.y, s.quick.y) : geo.y;
            const vy = volBase + 6 - s.vol.v * VOL_RISE;
            setAttr(vapCol, 'y', volBase - VOL_RISE - 12); setAttr(volSolid, 'cy', volBase - VOL_RISE / 2 + 6);
            setAttr(volB, 'x', geo.volX - 24); setAttr(volB, 'width', 48); setAttr(volB, 'rx', 24);
            setAttr(volB, 'y', vy); setAttr(volB, 'height', s.vol.v > 0.01 || volBase === geo.y ? Math.max(0, geo.y + geo.h - 6 - vy) : 0);
            setAttr(volSolid, 'opacity', s.vol.v);
            // 水滴里的白色音量条跟着水滴长：水滴升到七成以后才开始出现，收起时它先消失。
            const grow = Math.max(0, Math.min(1, (s.vol.v - 0.7) / 0.28));
            const growText = (grow * grow * (3 - 2 * grow)).toFixed(3);
            if (growText !== lastGrow) { lastGrow = growText; host.style.setProperty('--md-vgrow', growText); }
            if (s.split.p < 1) {
                const e = s.split.p;
                setAttr(splitC, 'cx', geo.x + geo.w - geo.h / 2 + e * 170); setAttr(splitC, 'cy', geo.y + geo.h / 2); setAttr(splitC, 'r', Math.max(0, (geo.h / 2 - 4) * (1 - e)));
                setAttr(vapSplit, 'x', geo.x + geo.w - geo.h); setAttr(vapSplit, 'y', geo.y - 12); setAttr(vapSplit, 'height', geo.h + 24); setAttr(vapSplit, 'width', geo.h + 200); setAttr(vapSplit, 'rx', geo.h / 2);
            } else { setAttr(splitC, 'r', 0); setAttr(vapSplit, 'width', 0); }
            // 快捷操作胶囊：从播放条顶边升起，和条之间拉出一道细颈。
            const q = s.quick;
            if (q.v > 0.01 && q.w > 0) {
                const top = geo.y + 4 + (q.y - geo.y - 4) * q.v;
                setAttr(quickB, 'x', q.x); setAttr(quickB, 'width', q.w); setAttr(quickB, 'y', top); setAttr(quickB, 'height', q.h); setAttr(quickB, 'rx', q.h / 2);
                const neckW = 26 * Math.min(1, q.v * 1.4) * (1 - 0.35 * q.v);
                setAttr(quickNeck, 'x', q.x + q.w / 2 - neckW / 2); setAttr(quickNeck, 'width', neckW);
                setAttr(quickNeck, 'y', top + q.h - 8); setAttr(quickNeck, 'height', Math.max(0, geo.y + 12 - (top + q.h - 8)));
                setAttr(quickSolid, 'cx', q.x + q.w / 2); setAttr(quickSolid, 'cy', q.y + q.h / 2); setAttr(quickSolid, 'rx', q.w / 2 + 50); setAttr(quickSolid, 'ry', q.h + 18); setAttr(quickSolid, 'opacity', q.v);
                setAttr(vapQuick, 'x', q.x - 12); setAttr(vapQuick, 'y', q.y - 12); setAttr(vapQuick, 'width', q.w + 24); setAttr(vapQuick, 'height', geo.y - q.y + 24); setAttr(vapQuick, 'rx', q.h / 2 + 12);
            } else {
                setAttr(quickB, 'height', 0); setAttr(quickNeck, 'width', 0); setAttr(quickSolid, 'opacity', 0); setAttr(vapQuick, 'width', 0);
            }
            fitFilters(Math.min(geo.y + 6 - Math.max(0, s.bump.r), vy, q.v > 0.01 && q.w > 0 ? geo.y + 4 + (q.y - geo.y - 4) * q.v : geo.y));
            const rx = s.ring.x;
            const ry = s.ring.y;
            const near = Math.hypot(rx - s.ring.tx, ry - s.ring.ty) < 120 && s.ring.docked;
            const sh = s.show.v;
            const sz = s.size.v;
            // 凹口跟着小环：环藏起来时凹口愈合；环落在条上方很远时也不开口。
            const touch = Math.max(0, Math.min(1, 1 - (geo.y - 2 - ry - 20) / 40));
            setHole(rx, ry, near ? HOLE_R * sh * touch * (0.45 + 0.55 * sz) : 0);
            setAttr(ringSolid, 'cx', rx); setAttr(ringSolid, 'cy', ry); setAttr(ringSolid, 'r', near ? Math.max(0, 95 * sh) : 0); // 弹簧回弹会短暂小于 0，负半径是无效属性
            if (ring) {
                const vh = win.innerHeight || 0;
                const layerTop = vh - geo.bottom - LAYER_H;
                const left = geo.left + rx - RING_R;
                const top = layerTop + ry - RING_R;
                const shText = `${sh.toFixed(3)}:${sz.toFixed(3)}`;
                if (force || ring.__mdfLeft !== left || ring.__mdfTop !== top || ring.__mdfShow !== shText) {
                    ring.__mdfLeft = left; ring.__mdfTop = top; ring.__mdfShow = shText;
                    ring.style.transform = `translate3d(${left.toFixed(1)}px, ${top.toFixed(1)}px, 0) scale(${((0.4 + 0.6 * sh) * sz).toFixed(3)})`;
                    ring.style.opacity = sh.toFixed(3);
                    ring.classList.toggle('md-hdl-bead', sz < 0.8);
                    ring.style.pointerEvents = sh > 0.5 ? '' : 'none';
                    onRingMove?.({ left, top, docked: s.ring.docked, near });
                }
            }
        };

        const step = (now) => {
            frame = 0;
            // 帧间隔上限放到 0.25 秒：页面掉到很低帧率时（3D 页面占满主线程）几帧内也能收尾，不会拖成一长串零星重画。
            const dt = Math.min(0.25, (now - last) / 1000 || 0.016);
            last = now;
            const instant = reduced();
            const k = instant ? 1 : 1 - Math.pow(0.0015, dt);
            s.solidity.v += (s.solidity.t - s.solidity.v) * (instant ? 1 : 1 - Math.pow(0.25, dt));
            s.bump.x += (s.bump.tx - s.bump.x) * k;
            s.bump.r += (s.bump.tr - s.bump.r) * k;
            s.vol.v += (s.vol.t - s.vol.v) * (instant ? 1 : 1 - Math.pow(0.004, dt));
            s.quick.v += (s.quick.t - s.quick.v) * (instant ? 1 : 1 - Math.pow(0.002, dt));
            if (s.split.p < 1) s.split.p = instant ? 1 : Math.min(1, s.split.p + dt / 0.9);
            if (s.drop.p < 1) { s.drop.p = instant ? 1 : Math.min(1, s.drop.p + dt / 1.1); retargetRing(); }
            s.show.t = showTarget();
            s.show.v += (s.show.t - s.show.v) * (instant ? 1 : 1 - Math.pow(0.004, dt));
            s.size.t = sizeTarget();
            s.size.v += (s.size.t - s.size.v) * (instant ? 1 : 1 - Math.pow(0.002, dt));
            s.ring.x += (s.ring.tx - s.ring.x) * k * 0.8;
            s.ring.y += (s.ring.ty - s.ring.y) * k * 0.8;
            if (instant || !moving()) {
                s.solidity.v = s.solidity.t; s.bump.x = s.bump.tx; s.bump.r = s.bump.tr; s.vol.v = s.vol.t; s.quick.v = s.quick.t;
                s.ring.x = s.ring.tx; s.ring.y = s.ring.ty; s.show.v = s.show.t; s.size.v = s.size.t;
            }
            draw();
            if (s.enabled && moving()) frame = win.requestAnimationFrame(step);
        };
        // 把所有量直接放到目标上，画一次，不排动画帧。
        const settle = () => {
            if (frame) { win.cancelAnimationFrame(frame); frame = 0; }
            s.solidity.v = s.solidity.t; s.bump.x = s.bump.tx; s.bump.r = s.bump.tr; s.vol.v = s.vol.t; s.quick.v = s.quick.t;
            s.split.p = 1; s.drop.p = 1;
            retargetRing();
            s.show.t = showTarget(); s.show.v = s.show.t; s.size.t = sizeTarget(); s.size.v = s.size.t;
            s.ring.x = s.ring.tx; s.ring.y = s.ring.ty;
        };
        // 省电：窗口看不见时什么都不画；失焦（还看得见）时不跑动画，状态变了直接落到位画一次。
        // 没有东西在动时本来就不排帧（见 step 结尾），这里保证的是「不该动的时候一帧也不排」。
        const kick = () => {
            if (!s.enabled || frame) return;
            // 目标没变就不排帧：外面每次状态同步都会调到这里，大多数时候其实没有东西要动。
            s.show.t = showTarget();
            if (!moving()) return;
            if (s.hidden) { s.dirty = true; return; }
            // 失焦时平时直接落位省电；但指针正在底栏上（用户在看、在碰），悬停的凝固/鼓包要照常慢慢过去，不能一下跳变。
            if (s.suspended && !s.attended) { settle(); draw(); return; }
            last = (win.performance || Date).now();
            frame = win.requestAnimationFrame(step);
        };

        const api = {
            svg,
            mist,
            layout,
            setProgress(p) {
                const next = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
                // 进度边界没走满一个像素就不动：不改遮罩、不重画滤镜。
                const span = geo.w * (s.range.b - s.range.a);
                const px = Math.abs(next - s.progress) * span;
                if (span > 0 ? px < 1 : Math.abs(next - s.progress) < 0.0005) return;
                s.progress = next;
                if (s.hidden) { s.dirty = true; return; }
                writeProgress();
                if (s.ringMode !== 'playhead' || !s.ring.docked) return;
                retargetRing();
                // 正常播放一次只挪几个像素（页面很卡时一次几十个像素）：播放头直接落位，不为它起一轮动画帧，也不让正在收尾的动画去追它
                // （页面帧率很低时，追着进度跑会让循环一直停不下来）。拖动、切歌的大跳才走动画。
                if (px < 48) {
                    s.ring.x = s.ring.tx;
                    if (!frame && !moving2()) { s.ring.y = s.ring.ty; draw(); }
                    return;
                }
                kick();
            },
            // 窗口不可见：停掉一切；回来时一次画到位。失焦：不跑动画帧。
            setHidden(on) {
                const next = Boolean(on);
                if (s.hidden === next) return;
                s.hidden = next;
                if (next) { if (frame) { win.cancelAnimationFrame(frame); frame = 0; } if (glow.frame) { win.cancelAnimationFrame(glow.frame); glow.frame = 0; glow.paintTarget?.(); } s.dirty = true; return; }
                if (s.dirty) { s.dirty = false; settle(); writeProgress(); draw(true); }
            },
            setSuspended(on) {
                const next = Boolean(on);
                if (s.suspended === next) return;
                s.suspended = next;
                if (next && frame && !s.attended) { settle(); draw(); }
                if (next && glow.frame) { win.cancelAnimationFrame(glow.frame); glow.frame = 0; glow.paintTarget?.(); }
            },
            setAttended(on) { s.attended = Boolean(on); if (on) kick(); },
            get animating() { return Boolean(frame) || Boolean(glow.frame); },
            setProgressRange(a, b) {
                const na = Math.min(0.6, Math.max(0, Number(a) || 0)); const nb = Math.min(1, Math.max(na + 0.1, Number(b) || 1));
                if (Math.abs(na - s.range.a) < 0.001 && Math.abs(nb - s.range.b) < 0.001) return;
                s.range.a = na; s.range.b = nb;
                writeProgress();
                if (s.ringMode === 'playhead' && s.ring.docked) { retargetRing(); kick(); }
            },
            // 实心程度：1 = 播放中或正被关注，0 = 暂停化雾
            setSolid(target) { s.solidity.t = target ? 1 : 0; if (s.ringMode === 'playhead') retargetRing(); kick(); },
            pointer(clientX) {
                if (clientX == null) { s.bump.tr = 0; kick(); return; }
                s.bump.tx = clientX - shiftX() - geo.left;
                if (s.bump.r < 1) s.bump.x = s.bump.tx;
                s.bump.tr = 20;
                kick();
            },
            setVolumeOpen(open) { s.vol.t = open ? 1 : 0; kick(); },
            // rect：快捷操作胶囊在窗口里的位置（getBoundingClientRect）
            setQuick(open, rect) {
                if (open && rect && rect.width > 0) {
                    const vh = win.innerHeight || 0;
                    const layerTop = vh - geo.bottom - LAYER_H;
                    s.quick.x = rect.left - shiftX() - geo.left; s.quick.y = rect.top - layerTop; s.quick.w = rect.width; s.quick.h = rect.height;
                }
                s.quick.t = open ? 1 : 0;
                if (s.ringMode === 'playhead') retargetRing();
                kick();
            },
            split() { s.split.p = 0; kick(); },
            setRingDocked(docked) {
                if (s.ring.docked === Boolean(docked)) return;
                s.ring.docked = Boolean(docked);
                retargetRing();
                kick();
            },
            // 换主题、换舞台时颜色在 0.6 秒里慢慢过去；降低动态时直接换。
            setGlow(colors) {
                const target = [0, 1, 2].map((i) => parseHex(colors?.[i]) || glow.cur[i]);
                if (glow.frame) { win.cancelAnimationFrame(glow.frame); glow.frame = 0; }
                const paint = (rgbs) => { glow.cur = rgbs; [in0, in1, in2].forEach((stop, i) => setAttr(stop, 'stop-color', toHex(rgbs[i]))); };
                glow.paintTarget = () => paint(target);
                if (reduced() || s.hidden || s.suspended || !glow.cur.every(Boolean)) { paint(target); return; }
                const from = glow.cur.slice();
                const start = win.performance?.now?.() ?? Date.now();
                const step = (now) => {
                    const t = Math.min(1, (now - start) / GLOW_MS);
                    const k = t * t * (3 - 2 * t);
                    paint(from.map((c, i) => c.map((v, j) => v + (target[i][j] - v) * k)));
                    glow.frame = t < 1 ? win.requestAnimationFrame(step) : 0;
                };
                glow.frame = win.requestAnimationFrame(step);
            },
            setEnabled(on) {
                s.enabled = Boolean(on);
                svg.style.display = on ? '' : 'none';
                mist.style.display = on ? '' : 'none';
                if (!on && frame) { win.cancelAnimationFrame(frame); frame = 0; }
                if (on) { layout(); kick(); }
            },
            get enabled() { return s.enabled; },
            get volumeOpen() { return s.vol.t === 1; },
            get ringDocked() { return s.ring.docked; },
            setRingMode(mode) {
                s.ringMode = ['playhead', 'hover', 'drop'].includes(mode) ? mode : 'fixed';
                s.drop.p = 1;
                retargetRing(); kick();
            },
            get ringMode() { return s.ringMode; },
            // 播放状态：暂停时播放头沉进条里。
            setPlaying(on) { if (s.playing === Boolean(on)) return; s.playing = Boolean(on); retargetRing(); kick(); },
            // 指针在小环上 / 正拖着它：放大成完整的环（播放头模式下平时是小珠子）。
            setRingFocus(on, dragging = false) {
                const f = Boolean(on); const d = Boolean(dragging);
                if (s.ringFocus === f && s.ring.focusDrag === d) return;
                s.ringFocus = f; s.ring.focusDrag = d; retargetRing(); kick();
            },
            setRingHover(on) { if (s.ringHover === Boolean(on)) return; s.ringHover = Boolean(on); kick(); },
            dropRing() { if (s.ringMode !== 'drop' || !s.ring.docked) return; s.drop.p = 0; retargetRing(); s.ring.y = s.ring.ty; kick(); },
            debug: () => ({ progress: s.progress, solidity: s.solidity.v, vol: s.vol.v, ring: { ...s.ring }, geo: { ...geo }, animating: Boolean(frame) }),
            destroy() {
                if (frame) win.cancelAnimationFrame(frame);
                if (glow.frame) win.cancelAnimationFrame(glow.frame);
                frame = 0;
                svg.remove();
                mist.remove();
                host.style.removeProperty('--md-vgrow');
            }
        };
        return api;
    }

    global.createMusicDockFluid = createMusicDockFluid;
})(typeof window !== 'undefined' ? window : globalThis);
