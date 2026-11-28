// Musicmodules/music-dock/music-fluid-marker.js
// 通用的「流体选中标记」：一排有当前项的东西（舞台页签、档案刻度、字母刻度），
// 当前项下面一滴实心玻璃；换当前项时这滴拉长流过去再收回，移得越快细颈拉得越长。
//
// 用法：
//   const marker = createMusicFluidMarker(container, { axis: 'x', thickness: 4, inset: 0, align: 'end' });
//   marker.moveTo(element)              // 或 marker.moveTo({ start, end })，单位是相对 container 的像素；第二个参数 { instant: true } 直接落位
//   marker.setVelocity(rowsPerSecond)   // 可选：越快细颈越长（档案页 onMotion 的 velocity 直接传进来）
//   marker.setDistances(items, active)  // 给每一项写 data-md-dist="0..4"（到当前项的距离），渐淡渐糊的样式自己写
//   marker.destroy()
//
// axis 'x'：横排，滴在 align 那一侧（'end' = 下沿，'start' = 上沿，'center' = 中间）；axis 'y'：竖排，滴在左/右侧。
// 只在动的时候跑 requestAnimationFrame；body.music-reduce-motion 时直接跳过去不拉伸。
// 颜色取 --mfm-color，没有就取底栏的 --md-fl-tint。
(function (global) {
    'use strict';

    const NS = 'http://www.w3.org/2000/svg';
    let uid = 0;

    function createMusicFluidMarker(container, options = {}) {
        if (!container) return null;
        const axis = options.axis === 'y' ? 'y' : 'x';
        const thickness = Number(options.thickness) || 4;
        const align = options.align || 'end';
        const inset = Number(options.inset) || 0;
        const win = container.ownerDocument.defaultView || global;
        const doc = container.ownerDocument;
        const id = `mfm${++uid}`;

        if (win.getComputedStyle(container).position === 'static') container.style.position = 'relative';

        const make = (tag, attrs, parent) => {
            const node = doc.createElementNS(NS, tag);
            if (attrs) {
                for (const k in attrs) {
                    if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, attrs[k]);
                }
            }
            if (parent) parent.appendChild(node);
            return node;
        };
        const svg = make('svg', { class: 'mfm', 'aria-hidden': 'true', focusable: 'false' });
        const defs = make('defs', {}, svg);
        // 滤镜区域按轴放大：沿轴方向留一点余量，垂直方向是细条，要放很多倍才装得下模糊
        const filter = make('filter', axis === 'x'
            ? { id: `${id}-goo`, x: '-20%', y: '-200%', width: '140%', height: '500%' }
            : { id: `${id}-goo`, x: '-200%', y: '-20%', width: '500%', height: '140%' }, defs);
        make('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: String(Math.max(1.5, thickness * 0.55)), result: 'b' }, filter);
        make('feColorMatrix', { in: 'b', mode: 'matrix', values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9' }, filter);
        const g = make('g', { class: 'mfm-body', filter: `url(#${id}-goo)` }, svg);
        const head = make('rect', {}, g);
        const tail = make('rect', {}, g);
        const neck = make('rect', {}, g);
        container.appendChild(svg);

        const s = { hs: 0, he: 0, ts: 0, te: 0, tgS: 0, tgE: 0, placed: false, vel: 0, frame: 0, last: 0 };
        let destroyed = false;
        const reducedMq = win.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
        // 优先尊重 MusicMotion 三态开关（允许用户手动选「关」覆盖系统减弱动态）
        const reduced = () => Boolean(typeof win.MusicMotion?.reduced === 'function'
            ? win.MusicMotion.reduced()
            : (doc.body?.classList.contains('music-reduce-motion') || reducedMq?.matches));

        // 只量容器的横截面（clientWidth/Height），不量整块内容，也不触发 getBoundingClientRect 的整页布局
        let cachedCs = 0;
        let cachedExtent = 0;
        const measureContainer = () => {
            cachedCs = Math.max(1, axis === 'x' ? container.clientHeight : container.clientWidth);
            cachedExtent = axis === 'x' ? container.scrollWidth : container.scrollHeight;
        };
        const cross = (size) => {
            if (align === 'start') return inset + thickness / 2;
            if (align === 'center') return size / 2;
            return size - inset - thickness / 2;
        };
        const headCache = Object.create(null);
        const tailCache = Object.create(null);
        const neckCache = Object.create(null);
        const setRectNum = (node, cache, name, value) => {
            const q = Math.round(value * 10);
            if (cache[name] === q) return;
            cache[name] = q;
            node.setAttribute(name, (q / 10).toFixed(1));
        };
        let origin = 0; // SVG 沿轴方向的起点（容器内容坐标），形状坐标都减去它
        const pill = (node, cache, a, b, c, t) => {
            const lo = Math.min(a, b) - origin;
            const len = Math.max(t, Math.abs(b - a));
            if (axis === 'x') {
                setRectNum(node, cache, 'x', lo);
                setRectNum(node, cache, 'y', c - t / 2);
                setRectNum(node, cache, 'width', len);
                setRectNum(node, cache, 'height', t);
            } else {
                setRectNum(node, cache, 'y', lo);
                setRectNum(node, cache, 'x', c - t / 2);
                setRectNum(node, cache, 'height', len);
                setRectNum(node, cache, 'width', t);
            }
            setRectNum(node, cache, 'rx', t / 2);
        };
        // SVG 只盖住小滴所在的那一段（加上模糊的余量），不再撑成整块内容那么大：
        // 目录有一万首时内容有几十万像素高，整张 SVG 会变成一张同样高的合成层，每次重画都很贵。
        const PAD = Math.ceil(thickness * 3 + 8);
        let lastBox = '';
        const draw = (remeasure = false) => {
            if (remeasure || !cachedCs) measureContainer();
            const cs = cachedCs;
            const c = cross(cs);
            // 末端不超出原有内容，免得在会滚动的容器（目录、页签）里多出一截滚动距离
            const extent = cachedExtent;
            origin = Math.max(0, Math.floor(Math.min(s.hs, s.ts) - PAD));
            const len = Math.max(1, Math.min(extent - origin, Math.ceil(Math.max(s.he, s.te) + PAD - origin)));
            const box = `${origin}|${len}|${cs}`;
            if (box !== lastBox) {
                lastBox = box;
                if (axis === 'x') { svg.style.left = `${origin}px`; svg.setAttribute('width', String(len)); svg.setAttribute('height', String(cs)); }
                else { svg.style.top = `${origin}px`; svg.setAttribute('height', String(len)); svg.setAttribute('width', String(cs)); }
            }
            pill(head, headCache, s.hs, s.he, c, thickness);
            pill(tail, tailCache, s.ts, s.te, c, thickness * 0.9);
            // 细颈：头尾中心之间一根细条，拉得越开越细，goo 滤镜把三段融成一滴
            const hc = (s.hs + s.he) / 2;
            const tc = (s.ts + s.te) / 2;
            const gap = Math.abs(hc - tc);
            const t = Math.max(1, thickness * Math.max(0.35, 0.8 - gap / 400));
            pill(neck, neckCache, Math.min(hc, tc), Math.max(hc, tc), c, gap > 2 ? t : 0.01);
        };
        const moving = () => Math.abs(s.hs - s.tgS) + Math.abs(s.he - s.tgE) + Math.abs(s.ts - s.tgS) + Math.abs(s.te - s.tgE) > 0.6;
        const step = (now) => {
            s.frame = 0;
            if (doc.hidden) {
                s.hs = s.ts = s.tgS; s.he = s.te = s.tgE; s.vel = 0;
                draw();
                return;
            }
            const dt = Math.min(0.25, (now - s.last) / 1000 || 0.016); // 低帧率时几帧内收尾
            s.last = now;
            // 头快尾慢；速度越大，尾巴越拖
            const kh = 1 - Math.pow(0.0004, dt);
            const lag = Math.min(0.9, Math.abs(s.vel) / 80);
            const kt = 1 - Math.pow(0.02 + lag * 0.25, dt);
            s.hs += (s.tgS - s.hs) * kh; s.he += (s.tgE - s.he) * kh;
            s.ts += (s.tgS - s.ts) * kt; s.te += (s.tgE - s.te) * kt;
            s.vel *= Math.pow(0.05, dt);
            if (!moving()) { s.hs = s.ts = s.tgS; s.he = s.te = s.tgE; }
            draw();
            if (moving()) s.frame = win.requestAnimationFrame(step);
        };
        const kick = () => {
            if (s.frame) return;
            s.last = win.performance?.now?.() ?? Date.now();
            s.frame = win.requestAnimationFrame(step);
        };

        const span = (target) => {
            if (!target) return null;
            if (typeof target.start === 'number') return [target.start, target.end];
            const box = container.getBoundingClientRect();
            const r = target.getBoundingClientRect();
            if (!r.width && !r.height) return null;
            // 容器自己会滚（舞台页签横向滚、目录竖向滚）：换成内容坐标，滴跟着内容走
            return axis === 'x'
                ? [r.left - box.left + container.scrollLeft, r.right - box.left + container.scrollLeft]
                : [r.top - box.top + container.scrollTop, r.bottom - box.top + container.scrollTop];
        };

        let hidden = false;
        return {
            // opts.instant：直接落位，不拉细颈（跳到很远的地方时用）
            moveTo(target, opts) {
                if (destroyed) return;
                const sp = span(target);
                if (!sp) {
                    if (!hidden) { hidden = true; svg.style.opacity = '0'; }
                    return;
                }
                const sameTarget = s.placed && !hidden && !s.frame
                    && Math.abs(sp[0] - s.tgS) < 0.2 && Math.abs(sp[1] - s.tgE) < 0.2;
                if (sameTarget) return;
                measureContainer();
                if (hidden) { hidden = false; svg.style.opacity = ''; }
                s.tgS = sp[0]; s.tgE = sp[1];
                if (!s.placed || doc.hidden || reduced() || opts?.instant) {
                    if (s.frame) { win.cancelAnimationFrame(s.frame); s.frame = 0; }
                    s.hs = s.ts = s.tgS; s.he = s.te = s.tgE; s.placed = true;
                    draw();
                    return;
                }
                kick();
            },
            setVelocity(v) { s.vel = Number(v) || 0; },
            setDistances(items, active) {
                if (!items) return;
                const list = typeof items.length === 'number' ? items : Array.from(items);
                const len = list.length;
                let ai = typeof active === 'number' ? active : -1;
                if (typeof active !== 'number') {
                    for (let i = 0; i < len; i += 1) {
                        if (list[i] === active) { ai = i; break; }
                    }
                }
                for (let i = 0; i < len; i += 1) {
                    const next = String(ai < 0 ? 4 : Math.min(4, Math.abs(i - ai)));
                    if (list[i].dataset.mdDist !== next) list[i].dataset.mdDist = next;
                }
            },
            relayout() { if (!destroyed) draw(true); },
            destroy() {
                destroyed = true;
                if (s.frame) { win.cancelAnimationFrame(s.frame); s.frame = 0; }
                svg.remove();
            }
        };
    }

    global.createMusicFluidMarker = createMusicFluidMarker;
})(window);
