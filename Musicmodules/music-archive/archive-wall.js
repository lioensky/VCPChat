/*
 * 档案页的第二种视图「封面墙」：把当前这一组曲目的封面平铺成一面可以四处拖动的墙。
 *
 * 版式：墙由 12×8 格的「块」拼成，每块放 12 张大小不一的封面（块的切法是开机时用固定种子切出来的几种，
 * 再按块坐标翻转，墙面看不出周期）。一组歌放完一遍以后接着从头放，墙向四个方向都没有尽头。
 * 点一张封面：它在自己那一块里长成 6×6 的大卡（带曲名和播放按钮），同一块里的其他封面重新切分让出地方，
 * 块的外轮廓不变，所以别的块都不动。双击直接播放。
 * 只建视野里的封面（最多 MAX_TILES 个），拖动、滚轮只改整层的位移；封面图先在后台缩小再显示。
 *
 * 这一层只管画和输入；选中、播放、队列都交还给档案页（archive-view.js 传进来的回调）。
 */
(function (global) {
    'use strict';

    const BW = 12, BH = 8, SLOTS = 12;
    const HERO = 6;                // 展开后的大卡是 6×6 格
    const MAX_TILES = 420;
    const TILT = 56;               // 「平放」：桌面往后倒的角度
    const TILT_EYE = 0.62;         // 视野中心落在屏幕高度的哪里（偏下，前景大、远处多看一些）
    const MIN_SIDE = 2;

    // ---------- 块的切法 ----------
    const rng = (seed) => () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const aspectOk = (r, maxAspect) => Math.max(r.w, r.h) <= maxAspect * Math.min(r.w, r.h);
    /* 把矩形 r 沿长边一刀刀切成 k 块；每块边长至少 MIN_SIDE 格、长宽比不超过 maxAspect。切不出来返回 null */
    const partition = (r, k, rand, maxAspect = 2, tries = 14) => {
        if (k === 1) return r.w >= MIN_SIDE && r.h >= MIN_SIDE && aspectOk(r, maxAspect) ? [r] : null;
        if (r.w * r.h < k * MIN_SIDE * MIN_SIDE) return null;
        for (let n = 0; n < tries; n++) {
            const alongX = r.w === r.h ? rand() < 0.5 : (r.w > r.h) !== (rand() < 0.22);
            const len = alongX ? r.w : r.h;
            const other = alongX ? r.h : r.w;
            // 偶尔只切下一张（做出一张大卡），其余时候大致对半
            const k1 = rand() < 0.3 ? 1 : Math.max(1, Math.min(k - 1, Math.round(k / 2 + (rand() - 0.5) * 2)));
            const k2 = k - k1;
            let cut = Math.round(len * k1 / k + (rand() - 0.5) * 2);
            const need1 = Math.max(MIN_SIDE, Math.ceil(k1 * MIN_SIDE * MIN_SIDE / other));
            const need2 = Math.max(MIN_SIDE, Math.ceil(k2 * MIN_SIDE * MIN_SIDE / other));
            cut = Math.max(need1, Math.min(len - need2, cut));
            if (cut < need1 || len - cut < need2) continue;
            const a = alongX ? { x: r.x, y: r.y, w: cut, h: r.h } : { x: r.x, y: r.y, w: r.w, h: cut };
            const b = alongX ? { x: r.x + cut, y: r.y, w: r.w - cut, h: r.h } : { x: r.x, y: r.y + cut, w: r.w, h: r.h - cut };
            const pa = partition(a, k1, rand, maxAspect, 6);
            if (!pa) continue;
            const pb = partition(b, k2, rand, maxAspect, 6);
            if (!pb) continue;
            return pa.concat(pb);
        }
        return null;
    };
    const readingOrder = (a, b) => (a.y - b.y) || (a.x - b.x);
    /* 开机时切出几种块：每种恰好 12 张、有一张够大的主卡、大小有起伏 */
    const TEMPLATES = (() => {
        const out = [];
        for (let seed = 1; out.length < 6 && seed < 4000; seed++) {
            const p = partition({ x: 0, y: 0, w: BW, h: BH }, SLOTS, rng(seed * 7919));
            if (!p) continue;
            const areas = p.map((r) => r.w * r.h).sort((a, b) => b - a);
            if (areas[0] < 16 || areas[0] > 30 || areas[1] > 16) continue;  // 一张主卡，不要两张一样大的
            if (new Set(areas).size < 4) continue;                         // 太整齐的不要
            out.push(p.sort(readingOrder));
        }
        return out;
    })();
    const flipX = (r) => ({ x: BW - r.x - r.w, y: r.y, w: r.w, h: r.h });
    const flipY = (r) => ({ x: r.x, y: BH - r.y - r.h, w: r.w, h: r.h });
    // 翻转后保持下标不变：同一张卡在四个朝向里还是第几张
    const ORIENTED = TEMPLATES.flatMap((t) => [t, t.map(flipX), t.map(flipY), t.map((r) => flipX(flipY(r)))]);
    const hash2 = (a, b) => {
        let v = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
        v = Math.imul(v ^ (v >>> 15), 0x85ebca77);
        return (v ^ (v >>> 13)) >>> 0;
    };
    const orientationOf = (bc, br) => {
        const n = TEMPLATES.length;
        const t = (((bc + br * 2) % n) + n) % n;    // 相邻两块永远不用同一种切法
        return t * 4 + (hash2(bc, br) % 4);
    };

    /*
     * 展开：被点的那张长成 6×6，放在离它原来位置最近的地方（横向按 2 格对齐，纵向贴上或贴下）；
     * 块里剩下的 L 形空地切成两三条，按面积分给其余 11 张，再按离原位置最近的顺序一一对上。
     */
    const reflowCache = new Map();
    const centerOf = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const reflowFor = (orient, slot) => {
        const key = orient * SLOTS + slot;
        if (reflowCache.has(key)) return reflowCache.get(key);
        const tpl = ORIENTED[orient];
        const s = tpl[slot];
        const c = centerOf(s);
        const hx = Math.max(0, Math.min(BW - HERO, Math.round((c.x - HERO / 2) / 2) * 2));
        const hy = c.y < BH / 2 ? 0 : BH - HERO;
        const hero = { x: hx, y: hy, w: HERO, h: HERO };
        const rects = [];
        if (hx > 0) rects.push({ x: 0, y: 0, w: hx, h: BH });
        if (hx + HERO < BW) rects.push({ x: hx + HERO, y: 0, w: BW - hx - HERO, h: BH });
        if (hy > 0) rects.push({ x: hx, y: 0, w: HERO, h: hy });
        if (hy + HERO < BH) rects.push({ x: hx, y: hy + HERO, w: HERO, h: BH - hy - HERO });
        const rest = SLOTS - 1;
        const cap = (r) => Math.floor(r.w / MIN_SIDE) * Math.floor(r.h / MIN_SIDE);
        const floor = (r) => Math.max(1, Math.ceil(Math.max(r.w, r.h) / (2 * Math.min(r.w, r.h))));
        const total = rects.reduce((a, r) => a + r.w * r.h, 0);
        const counts = rects.map((r) => Math.max(floor(r), Math.min(cap(r), Math.round(rest * r.w * r.h / total))));
        // 凑到正好 11 张：多了从能少的里减，少了往还放得下的里加（先动面积大的）
        const order = rects.map((r, i) => i).sort((a, b) => rects[b].w * rects[b].h - rects[a].w * rects[a].h);
        let sum = counts.reduce((a, b) => a + b, 0);
        for (let guard = 0; sum !== rest && guard < 40; guard++) {
            for (const i of order) {
                if (sum > rest && counts[i] > floor(rects[i])) { counts[i]--; sum--; break; }
                if (sum < rest && counts[i] < cap(rects[i])) { counts[i]++; sum++; break; }
            }
        }
        let pieces = [];
        for (let i = 0; i < rects.length; i++) {
            let p = null;
            for (let seed = 1; !p && seed < 60; seed++) p = partition(rects[i], counts[i], rng(key * 131 + seed), seed < 30 ? 2 : 3);
            if (!p) { pieces = null; break; }
            pieces.push(...p);
        }
        if (!pieces || pieces.length !== rest) { reflowCache.set(key, null); return null; }
        // 其余 11 张：两两距离从近到远贪心配对，每张尽量落在原来附近
        const others = tpl.map((r, i) => i).filter((i) => i !== slot);
        const pairs = [];
        others.forEach((i) => pieces.forEach((p, j) => {
            const a = centerOf(tpl[i]), b = centerOf(p);
            pairs.push([(a.x - b.x) ** 2 + (a.y - b.y) ** 2, i, j]);
        }));
        pairs.sort((a, b) => a[0] - b[0]);
        const out = new Array(SLOTS);
        const usedPiece = new Set();
        out[slot] = hero;
        for (const [, i, j] of pairs) {
            if (out[i] || usedPiece.has(j)) continue;
            out[i] = pieces[j];
            usedPiece.add(j);
        }
        reflowCache.set(key, out);
        return out;
    };

    // ---------- 墙的几何（世界坐标，单位像素） ----------
    const FIELD_ASPECT = 2.2;      // 一遍放完的那一片宽一点，左右和上下重复得差不多快
    /*
     * 曲库按标题、专辑排好以后，同一张专辑的歌挨在一起，墙上就会一片片同一张封面。
     * 所以墙上的座位按一个固定步长跳着放（步长和曲目数互质，约 0.38 倍），一遍里每首还是正好出现一次。
     */
    const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
    const strideFor = (n) => {
        if (n < 5) return 1;
        let s = Math.max(2, Math.round(n * 0.382));
        while (gcd(s, n) !== 1) s++;
        return s;
    };
    const geometryFor = (n, pitch) => {
        const blocks = Math.max(1, Math.ceil(Math.max(1, n) / SLOTS));
        const perRow = blocks <= 1 ? 1 : Math.max(1, Math.round(Math.sqrt(FIELD_ASPECT * blocks * BH / BW)));
        const rows = Math.ceil(blocks / perRow);
        n = Math.max(1, n);
        const stride = strideFor(n);
        const seat = new Int32Array(n);      // 第几首 → 一遍里的第几个座位
        for (let k = 0; k < n; k++) seat[(k * stride) % n] = k;
        return { n, pitch, perRow, rows, stride, seat, slots: perRow * rows * SLOTS, blockW: BW * pitch, blockH: BH * pitch, cellW: perRow * BW * pitch, cellH: rows * BH * pitch };
    };
    const mod = (a, m) => ((a % m) + m) % m;
    /* 块坐标（可以是负数）和块里第几张 → 这张封面 */
    const instanceAt = (g, bc, br, slot, gap) => {
        const rx = Math.floor(bc / g.perRow), ry = Math.floor(br / g.rows);
        const lc = bc - rx * g.perRow, lr = br - ry * g.rows;
        const orient = orientationOf(lc, lr);
        const r = ORIENTED[orient][slot];
        const cellSlot = (lr * g.perRow + lc) * SLOTS + slot;
        return {
            id: bc + ':' + br + ':' + slot,
            bc, br, slot, orient,
            item: ((cellSlot % g.n) * g.stride) % g.n,
            x: bc * g.blockW + r.x * g.pitch, y: br * g.blockH + r.y * g.pitch,
            w: r.w * g.pitch - gap, h: r.h * g.pitch - gap,
            cols: r.w
        };
    };
    /* 第 item 首在离 point 最近的那一份里的位置 */
    const nearestOf = (g, item, point, gap) => {
        let best = null, bestD = Infinity;
        for (let cs = g.seat[item]; cs < g.slots; cs += g.n) {
            const block = Math.floor(cs / SLOTS), slot = cs % SLOTS;
            const lc = block % g.perRow, lr = Math.floor(block / g.perRow);
            const base = instanceAt(g, lc, lr, slot, gap);
            const rx = Math.round((point.x - base.x - base.w / 2) / g.cellW);
            const ry = Math.round((point.y - base.y - base.h / 2) / g.cellH);
            const inst = instanceAt(g, rx * g.perRow + lc, ry * g.rows + lr, slot, gap);
            const d = (inst.x + inst.w / 2 - point.x) ** 2 + (inst.y + inst.h / 2 - point.y) ** 2;
            if (d < bestD) { bestD = d; best = inst; }
        }
        return best;
    };

    // ---------- 空状态 ----------
    /* 这一组没有歌时：一块虚线勾出的空墙（大中小几格，像还没挂上海报的展板）+ 大字题头、编号行、一句去哪儿找 */
    const EMPTY_GHOST = '<i class="ae-a"></i><i class="ae-b"></i><i class="ae-c"></i><i class="ae-d"></i><i class="ae-e"></i><i class="ae-f"></i>';
    const fillEmpty = (box, name) => {
        if (!box.querySelector('.ae-t')) box.innerHTML = '<div class="ae-ghost" aria-hidden="true">' + EMPTY_GHOST + '</div><b class="ae-t">这一组还没有曲目</b><span class="ae-n"></span><em class="ae-h">从左边的目录换一组看看，或者把歌加进这一组</em>';
        box.querySelector('.ae-n').textContent = '00 首' + (name ? ' · ' + name : '');
    };

    // ---------- 封面缩略图 ----------
    /* 原图常有一两千像素：按显示尺寸分三档缩小后存成 blob，最多留 360 张；同时最多解 4 张 */
    const createThumbs = (onReady) => {
        const cache = new Map();       // key → { url, state }
        const queue = [];
        let busy = 0;
        const LIMIT = 360;
        const bucket = (px) => (px <= 200 ? 192 : px <= 420 ? 384 : 768);
        const evict = () => {
            while (cache.size > LIMIT) {
                const [k, v] = cache.entries().next().value;
                cache.delete(k);
                if (v.url && v.url.startsWith('blob:')) URL.revokeObjectURL(v.url);
            }
        };
        const pump = () => {
            while (busy < 4 && queue.length) {
                const job = queue.pop();      // 后进先出：刚出现在视野里的先解
                const entry = cache.get(job.key);
                if (!entry || entry.state !== 'queued') continue;
                busy++;
                entry.state = 'loading';
                const img = new Image();
                img.decoding = 'async';
                const done = (url) => {
                    busy--;
                    entry.state = url ? 'ok' : 'fail';
                    entry.url = url || '';
                    onReady(job.src);   // 失败也回调一次：让还在等封面的格子停掉加载微光
                    pump();
                };
                img.onload = () => {
                    const w = img.naturalWidth, h = img.naturalHeight;
                    const k = Math.min(1, job.size / Math.max(1, Math.min(w, h)));
                    if (k >= 0.9 || typeof global.createImageBitmap !== 'function') { done(job.src); return; }
                    const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
                    global.createImageBitmap(img, { resizeWidth: cw, resizeHeight: ch, resizeQuality: 'high' }).then((bmp) => {
                        const c = document.createElement('canvas');
                        c.width = cw; c.height = ch;
                        c.getContext('2d').drawImage(bmp, 0, 0);
                        bmp.close?.();
                        c.toBlob((blob) => done(blob ? URL.createObjectURL(blob) : job.src), 'image/jpeg', 0.86);
                    }).catch(() => done(job.src));
                };
                img.onerror = () => done('');
                img.src = job.src;
            }
        };
        return {
            /* 有了就给地址；没有就排队，好了回调 onReady(src) */
            get(src, px) {
                if (!src) return '';
                const size = bucket(px);
                // 已经有更大一档的就直接用
                for (const s of [size, 384, 768]) {
                    if (s < size) continue;
                    const e = cache.get(src + '|' + s);
                    if (e && e.state === 'ok') { cache.delete(src + '|' + s); cache.set(src + '|' + s, e); return e.url; }
                }
                const key = src + '|' + size;
                const e = cache.get(key);
                if (e && e.state === 'fail') return '';
                if (!e) {
                    cache.set(key, { state: 'queued', url: '' });
                    queue.push({ key, src, size });
                    evict();
                    pump();
                } else if (e.state === 'queued') {
                    queue.push({ key, src, size });
                    pump();
                }
                // 小一档的先顶着
                for (const s of [384, 192]) {
                    if (s >= size) continue;
                    const lower = cache.get(src + '|' + s);
                    if (lower && lower.state === 'ok') return lower.url;
                }
                return '';
            },
            failed(src) { return [192, 384, 768].some((s) => cache.get(src + '|' + s)?.state === 'fail'); },
            clearQueue() { queue.length = 0; for (const v of cache.values()) if (v.state === 'queued') v.state = 'idle'; for (const [k, v] of cache) if (v.state === 'idle') cache.delete(k); },
            destroy() { for (const v of cache.values()) if (v.url && v.url.startsWith('blob:')) URL.revokeObjectURL(v.url); cache.clear(); queue.length = 0; },
            get size() { return cache.size; }
        };
    };

    /*
     * 弹簧曲线：按刚度/阻尼把一次 0→1 的弹簧过程算出来，写成 CSS linear() 缓动（Chromium 113+ 支持）。
     * 入场用偏软、会轻轻回弹一下的；让位用几乎不回弹的。不支持 linear() 时退回普通曲线。
     */
    const springEase = (stiffness, damping) => {
        let x = 0, v = 0, t = 0;
        const dt = 1 / 240, pts = [0];
        let settled = 0;
        while (t < 2) {
            const a = stiffness * (1 - x) - damping * v;
            v += a * dt; x += v * dt; t += dt;
            if (Math.round(t * 240) % 8 === 0) pts.push(+x.toFixed(4));
            if (Math.abs(1 - x) < 0.002 && Math.abs(v) < 0.02) { if (++settled > 12) break; } else settled = 0;
        }
        pts.push(1);
        return { ease: 'linear(' + pts.join(',') + ')', ms: Math.round(t * 1000) };
    };
    /* 扫描过场用的 cubic-bezier(.5, 0, .2, 1)：给出扫描线走到 u（0~1）那一刻占总时长的比例 */
    const sweepTimeAt = (u) => {
        const bx = (t) => 3 * (1 - t) * (1 - t) * t * 0.5 + 3 * (1 - t) * t * t * 0.2 + t * t * t;
        const by = (t) => 3 * (1 - t) * t * t + t * t * t;
        let lo = 0, hi = 1;
        for (let k = 0; k < 24; k++) { const m = (lo + hi) / 2; if (by(m) < u) lo = m; else hi = m; }
        return bx((lo + hi) / 2);
    };
    const SPRING_ENTER = springEase(360, 24);
    const SPRING_FLOW = springEase(300, 34);
    const hueOf = (str) => { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /*
     * opts:
     *   host            挂在哪个元素里（档案页根节点），插在 before 前面
     *   items()         → { key, ids: number[], name }：当前这一组，ids 是曲库下标
     *   track(i)        → 曲目对象
     *   cover(t)        → 封面地址（可能为空）
     *   selected()      → 当前选中的曲库下标
     *   playing()       → { index, active }
     *   meta(t, i)      → { title, artist, album, code, duration }
     *   pick(i)         选中（不播放）
     *   play(i, {stage}) 播放
     *   menu(i, x, y)   右键菜单
     *   reducedMotion()
     */
    const create = (opts) => {
        const el = document.createElement('div');
        const tilt = Boolean(opts.tilt);
        el.className = 'archive-wall' + (tilt ? ' aw-table' : '');
        el.setAttribute('role', 'grid');
        el.setAttribute('aria-label', '封面墙');
        el.hidden = true;
        el.innerHTML = '<div class="aw-world"></div><div class="aw-empty" hidden></div>';
        if (tilt) el.setAttribute('aria-label', '平放');
        // 键盘：整面墙是一个 Tab 停靠点（格子本身不进 Tab 顺序），停在这里后方向键选、回车播放、Esc 收起
        el.tabIndex = 0;
        el.setAttribute('aria-roledescription', tilt ? '平放封面' : '封面墙');
        el.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight Enter Escape');
        if (global.CSS && CSS.supports && CSS.supports('transition-timing-function', SPRING_ENTER.ease)) {
            el.style.setProperty('--aw-sp-enter', SPRING_ENTER.ease);
            el.style.setProperty('--aw-sp-enter-ms', SPRING_ENTER.ms + 'ms');
            el.style.setProperty('--aw-sp-flow', SPRING_FLOW.ease);
            el.style.setProperty('--aw-sp-flow-ms', SPRING_FLOW.ms + 'ms');
        }
        const world = el.firstChild;
        const emptyEl = el.lastChild;
        // 定位正在播放：右下角圆键。这一组里有正在播放的歌时出现，那张不在视野里时亮起来；点了飞过去
        const locateBtn = document.createElement('button');
        locateBtn.type = 'button';
        locateBtn.className = 'aw-locate';
        locateBtn.dataset.wall = 'locate';
        locateBtn.title = '找到正在播放的那首';
        locateBtn.setAttribute('aria-label', '找到正在播放的那首');
        locateBtn.hidden = true;
        locateBtn.innerHTML = '<i></i>';
        el.appendChild(locateBtn);
        opts.host.insertBefore(el, opts.before || null);
        const reduced = () => Boolean(opts.reducedMotion && opts.reducedMotion());

        const st = {
            on: false,
            key: '', ids: [], g: null, gap: 10,
            cam: { x: 0, y: 0 }, aim: null, vel: { x: 0, y: 0 },
            room: { left: 0, top: 0, width: 0, height: 0 },
            focus: null,                // 选中的那一张（具体哪一份）
            expanded: null,             // 展开的那一张
            expandedRects: new Map(),
            nodes: new Map(), pool: [],
            laidAt: null, dirty: true,
            raf: 0, last: 0,
            selIndex: -1, playKey: '',
            enterUntil: 0,
            drag: null,
            wheelAim: null
        };
        const thumbs = createThumbs(() => { st.coverDirty = true; schedule(); });

        // ---------- 尺寸 ----------
        const pitchFor = (h) => (tilt ? Math.max(40, Math.min(96, Math.round(h * 0.72 / BH))) : Math.max(38, Math.min(104, Math.round(h * 0.8 / BH))));
        const maxTiles = tilt ? 640 : MAX_TILES;
        const setRoom = (room) => {
            const r = { left: Math.round(room.left), top: Math.round(room.top), width: Math.max(0, Math.round(room.width)), height: Math.max(0, Math.round(room.height)) };
            const same = ['left', 'top', 'width', 'height'].every((k) => r[k] === st.room[k]);
            if (same) return;
            const oldCenter = viewCenter();
            st.room = r;
            el.style.left = r.left + 'px';
            el.style.top = r.top + 'px';
            el.style.width = r.width + 'px';
            el.style.height = r.height + 'px';
            const pitch = pitchFor(r.height);
            if (!st.g || st.g.pitch !== pitch) {
                const focusItem = st.focus ? st.focus.item : -1;
                const expandedItem = st.expanded ? st.expanded.item : -1;
                st.gap = Math.max(6, Math.round(pitch * 0.11));
                rebuildGeometry(pitch);
                if (focusItem >= 0) st.focus = nearestOf(st.g, focusItem, oldCenter.x ? scalePoint(oldCenter) : { x: 0, y: 0 }, st.gap);
                if (expandedItem >= 0 && st.focus) setExpanded(st.focus, { animate: false });
                if (st.focus) centerOn(st.focus, { instant: true });
            } else {
                // 视口变了大小：保持原来看着的中心
                st.cam.x = oldCenter.x - r.width / 2;
                st.cam.y = oldCenter.y - r.height / 2;
            }
            st.dirty = true;
            schedule();
        };
        let lastPitch = 0;
        const scalePoint = (p) => (lastPitch && st.g ? { x: p.x * st.g.pitch / lastPitch, y: p.y * st.g.pitch / lastPitch } : p);
        const rebuildGeometry = (pitch) => {
            lastPitch = st.g ? st.g.pitch : pitch;
            st.g = geometryFor(st.ids.length, pitch);
            st.expandedRects.clear();
            st.expanded = null;
            st.dirty = true;
        };
        const viewCenter = () => ({ x: st.cam.x + st.room.width / 2, y: st.cam.y + st.room.height / 2 });

        // ---------- 数据 ----------
        /* 换了一组（目录里换了分类、换了歌单）：整面墙重排，镜头落到选中的那首 */
        const syncItems = ({ force = false } = {}) => {
            const it = opts.items() || { key: '', ids: [] };
            const ids = it.ids || [];
            // 按内容比：曲库签名变了（比如刚播的一首进了「最近播放」）但这一组的曲目和顺序没变，就不重排
            let h = ids.length | 0;
            for (let k = 0; k < ids.length; k++) h = (Math.imul(h, 31) + ids[k]) | 0;
            const sig = (it.name || '') + '#' + ids.length + '#' + h;
            if (!force && sig === st.key) { st.ids = ids; return false; }
            const firstShow = !st.key;
            if (!firstShow && !force) leave();
            st.key = sig;
            st.ids = ids;
            st.name = it.name || '';
            rebuildGeometry(st.g ? st.g.pitch : pitchFor(st.room.height || 800));
            for (const node of st.nodes.values()) recycle(node);
            st.nodes.clear();
            thumbs.clearQueue();
            emptyEl.hidden = ids.length > 0;
            if (!ids.length) fillEmpty(emptyEl, st.name);
            st.focus = null;
            st.selIndex = -1;
            st.revealOk = false;
            syncSelection({ center: true, instant: true });
            if (!st.focus) { st.cam.x = -st.room.width / 2 + st.g.blockW / 2; st.cam.y = -st.room.height / 2 + st.g.blockH / 2; }
            enter(firstShow ? 0 : 1);
            return true;
        };
        /* 档案页刚开始换视图的扫描过场：在的话入场改成跟着扫描线翻过来 */
        let sweepCache = null;
        const sweepAt = () => {
            const now = performance.now();
            if (sweepCache && now - sweepCache.t < 50) return sweepCache.v;
            const on = opts.host.querySelector('.archive-layout-sweep');
            const w = opts.host.clientWidth || global.innerWidth || 1600;
            sweepCache = { t: now, v: on && now - (st.shownAt || 0) < 400 ? { w, ms: Math.round(Math.min(720, 380 + w * 0.16)) } : null };
            return sweepCache.v;
        };
        const enter = () => {
            if (reduced()) return;
            st.enterUntil = performance.now() + 340 + (SPRING_ENTER.ms || 600);
        };
        /*
         * 换一组之前，旧的那面墙先整体抬起、缩小、淡出（同样从左上往右下一波），
         * 拿一层快照盖在上面跑，底下立刻换成新的一组接着落下来。
         */
        const leave = () => {
            if (reduced() || !st.nodes.size || !st.on) return;
            const ghost = world.cloneNode(true);
            ghost.classList.add('aw-ghost');
            ghost.classList.remove('aw-reflow');
            ghost.querySelectorAll('.aw-panel').forEach((p) => p.remove());
            const W = st.room.width || 1, H = st.room.height || 1;
            for (const t of ghost.children) {
                const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(t.style.transform || '');
                const u = m ? Math.max(0, Math.min(1, ((+m[1] - st.cam.x) / W + (+m[2] - st.cam.y) / H) / 2)) : 0;
                t.classList.remove('aw-entering', 'aw-reveal');
                t.classList.add('aw-leaving');
                t.firstChild.style.animationDelay = Math.round(u * 160) + 'ms';
            }
            el.insertBefore(ghost, world.nextSibling);
            setTimeout(() => ghost.remove(), 520);
        };

        // ---------- 选中、展开 ----------
        const instancesOfFocusBlock = () => st.focus;
        const syncSelection = ({ center = false, instant = false } = {}) => {
            const sel = opts.selected();
            if (sel === st.selIndex && st.focus) return;
            st.selIndex = sel;
            const pos = st.ids.indexOf(sel);
            if (pos < 0 || !st.g) { st.focus = null; setExpanded(null); st.dirty = true; schedule(); return; }
            if (st.focus && st.focus.item === pos) return;
            const keepExpanded = Boolean(st.expanded);
            st.focus = nearestOf(st.g, pos, viewCenter(), st.gap);
            if (keepExpanded || st.wantExpand) setExpanded(st.focus);
            st.wantExpand = false;
            const r = rectOf(st.focus);
            const outside = r.x < st.cam.x + 20 || r.y < st.cam.y + 20 || r.x + r.w > st.cam.x + st.room.width - 20 || r.y + r.h > st.cam.y + st.room.height - 20;
            if (center || outside || st.expanded) centerOn(st.expanded || st.focus, { instant });
            st.dirty = true;
            schedule();
        };
        const rectOf = (inst) => st.expandedRects.get(inst.id) || inst;
        const setExpanded = (inst, { animate = true } = {}) => {
            const prev = st.expanded;
            st.expandedRects.clear();
            st.expanded = null;
            if (inst) {
                const flow = reflowFor(inst.orient, inst.slot);
                if (flow) {
                    for (let s = 0; s < SLOTS; s++) {
                        const r = flow[s];
                        const id = inst.bc + ':' + inst.br + ':' + s;
                        st.expandedRects.set(id, { x: inst.bc * st.g.blockW + r.x * st.g.pitch, y: inst.br * st.g.blockH + r.y * st.g.pitch, w: r.w * st.g.pitch - st.gap, h: r.h * st.g.pitch - st.gap, cols: r.w });
                    }
                    st.expanded = inst;
                }
            }
            if ((prev ? prev.id : '') !== (st.expanded ? st.expanded.id : '')) {
                if (animate && !reduced()) {
                    world.classList.add('aw-reflow');
                    clearTimeout(st.reflowTimer);
                    st.reflowTimer = setTimeout(() => world.classList.remove('aw-reflow'), Math.max(560, SPRING_FLOW.ms + 40));
                }
                st.dirty = true;
                schedule();
            }
        };
        const centerOn = (inst, { instant = false } = {}) => {
            if (!inst) return;
            const r = rectOf(inst);
            const target = { x: r.x + r.w / 2 - st.room.width / 2, y: r.y + r.h / 2 - st.room.height / 2 };
            st.vel.x = st.vel.y = 0;
            st.wheelAim = null;
            if (instant || reduced()) { st.cam.x = target.x; st.cam.y = target.y; st.aim = null; st.aimVel = null; st.dirty = true; }
            else { if (!st.aim) st.aimVel = null; st.aim = target; }
            schedule();
        };
        const focusInstance = (inst, { expand = false, center = false } = {}) => {
            st.focus = inst;
            st.selIndex = st.ids[inst.item];
            if (expand) setExpanded(inst);
            else if (st.expanded && st.expanded.id !== inst.id) setExpanded(null);
            opts.pick(st.ids[inst.item]);
            if (center || expand) centerOn(st.expanded || inst);
            st.dirty = true;
            schedule();
        };

        /* 方向键：在附近九块里找这个方向上最近的一张（偏离方向的距离算两倍） */
        const step = (key) => {
            if (!st.g || !st.ids.length) return false;
            const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
            if (!dir) return false;
            let from = st.focus;
            if (!from) {
                const c = viewCenter();
                const bc = Math.floor(c.x / st.g.blockW), br = Math.floor(c.y / st.g.blockH);
                from = instanceAt(st.g, bc, br, 0, st.gap);
                focusInstance(from, { center: true });
                return true;
            }
            const fr = rectOf(from);
            const fc = { x: fr.x + fr.w / 2, y: fr.y + fr.h / 2 };
            let best = null, bestScore = Infinity;
            for (let br = from.br - 1; br <= from.br + 1; br++) {
                for (let bc = from.bc - 1; bc <= from.bc + 1; bc++) {
                    for (let s = 0; s < SLOTS; s++) {
                        const inst = instanceAt(st.g, bc, br, s, st.gap);
                        if (inst.id === from.id) continue;
                        const r = rectOf(inst);
                        // 用相邻边算：往右走看对方左边是不是在我右边的右侧
                        const along = dir[0] ? (dir[0] > 0 ? r.x - (fr.x + fr.w) : fr.x - (r.x + r.w)) : (dir[1] > 0 ? r.y - (fr.y + fr.h) : fr.y - (r.y + r.h));
                        if (along < -st.gap) continue;
                        const across = dir[0] ? Math.abs(r.y + r.h / 2 - fc.y) : Math.abs(r.x + r.w / 2 - fc.x);
                        const score = Math.max(0, along) + across * 2;
                        if (score < bestScore) { bestScore = score; best = inst; }
                    }
                }
            }
            if (!best) return false;
            const wasExpanded = Boolean(st.expanded);
            focusInstance(best, { expand: wasExpanded });
            const r = rectOf(st.expanded || best);
            const pad = 28;
            if (r.x < st.cam.x + pad || r.y < st.cam.y + pad || r.x + r.w > st.cam.x + st.room.width - pad || r.y + r.h > st.cam.y + st.room.height - pad) centerOn(st.expanded || best);
            return true;
        };

        // ---------- 画 ----------
        const recycle = (node) => {
            node.el.remove();
            node.item = -2;
            if (st.pool.length < 80) st.pool.push(node);
        };
        const makeNode = () => {
            const node = st.pool.pop();
            if (node) return node;
            const t = document.createElement('div');
            t.className = 'aw-tile';
            t.setAttribute('role', 'gridcell');
            t.innerHTML = '<div class="aw-in"><div class="aw-art"><img alt="" draggable="false" decoding="async"><span class="aw-blank"></span></div><i class="aw-shade"></i><span class="aw-no"></span><div class="aw-cap"><b></b><span></span></div>'
                + '<button type="button" class="aw-q" data-wall="quick" tabindex="-1" aria-label="播放"></button><button type="button" class="aw-qm" data-wall="quickmenu" tabindex="-1" aria-label="更多操作"></button></div>';
            const inner = t.firstChild;
            return {
                el: t, inner, img: inner.querySelector('img'), blank: inner.querySelector('.aw-blank'),
                no: inner.querySelector('.aw-no'), title: inner.querySelector('.aw-cap b'), sub: inner.querySelector('.aw-cap span'),
                item: -2, x: NaN, y: NaN, w: NaN, h: NaN, src: null, cls: '', code: '', badge: null
            };
        };
        const panel = document.createElement('div');
        panel.className = 'aw-panel';
        panel.innerHTML = '<div class="aw-lyric" hidden><div class="aw-lyric-roll"></div></div><div class="aw-panel-head"><span class="aw-panel-no"></span><span class="aw-panel-dur"></span></div><b class="aw-panel-title"></b><span class="aw-panel-sub"></span>'
            + '<div class="aw-seek" data-wall="seek" role="slider" tabindex="0" aria-label="播放进度" hidden><span class="aw-seek-t">0:00</span><div class="aw-seek-bar"><i></i></div><span class="aw-seek-d">0:00</span></div>'
            + '<div class="aw-panel-acts"><button type="button" data-wall="prev" class="aw-round aw-prev" title="上一首" aria-label="上一首" hidden><i></i></button><button type="button" data-wall="play" class="aw-primary"><i></i><span>播放</span></button><button type="button" data-wall="next" class="aw-round aw-next" title="下一首" aria-label="下一首" hidden><i></i></button><button type="button" data-wall="stage">进入舞台</button><button type="button" data-wall="menu">更多…</button></div>';
        const fillPanel = (i) => {
            const t = opts.track(i);
            const m = opts.meta(t, i);
            panel.querySelector('.aw-panel-no').textContent = m.code || '';
            panel.querySelector('.aw-panel-dur').textContent = m.duration || '';
            panel.querySelector('.aw-panel-title').textContent = m.title;
            panel.querySelector('.aw-panel-sub').textContent = [m.artist, m.album].filter(Boolean).join(' · ');
            const p = opts.playing();
            const isNow = p.index === i && p.active;
            const btn = panel.querySelector('[data-wall="play"]');
            const isCur = p.index === i;
            const canTransport = isCur && typeof opts.transport === 'function';
            // 展开的是当前这首：主键变成暂停/继续，两边出现上一首、下一首（和 Folia 大卡上的播放控制一样）
            btn.lastChild.textContent = isNow ? (canTransport ? '暂停' : '正在播放') : (isCur ? '继续播放' : '播放');
            btn.classList.toggle('is-now', isNow);
            btn.disabled = isNow && !canTransport;
            panel.querySelector('.aw-prev').hidden = !canTransport;
            panel.querySelector('.aw-next').hidden = !canTransport;
            panel.dataset.item = String(i);
            syncSeek();
        };

        // ---------- 大卡进度条：只在展开的是当前这首时出现 ----------
        const seekEl = panel.querySelector('.aw-seek');
        const seekFill = seekEl.querySelector('.aw-seek-bar i');
        const fmt = (sec) => { sec = Math.max(0, Math.floor(sec || 0)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
        let seekTimer = 0, seekDrag = null;
        const seekIsLive = () => {
            if (!opts.progress || !panel.parentNode || !st.expanded) return false;
            return opts.playing().index === Number(panel.dataset.item);
        };
        /*
         * 卡里的歌词：展开的是正在播放的那首、而且有带时间的词时，大卡上半部分滚三四行，
         * 当前这行亮、前后几行淡；换行时整卷往上推一行。
         */
        const lyricEl = panel.querySelector('.aw-lyric');
        const lyricRoll = lyricEl.firstChild;
        let lyricSrc = null, lyricAt = -2;
        const paintLyric = (t) => {
            const lines = opts.lyrics ? opts.lyrics() : [];
            const timed = lines.length > 1 && lines.some((l) => Number(l.time) > 0);
            if (!timed) { lyricEl.hidden = true; lyricSrc = null; lyricAt = -2; return; }
            if (lines !== lyricSrc) {
                lyricSrc = lines;
                lyricAt = -2;
                lyricRoll.innerHTML = lines.map((l) => '<p>' + esc(l.original || l.fullText || l.text || '') + (l.translation ? '<small>' + esc(l.translation) + '</small>' : '') + '</p>').join('');
            }
            lyricEl.hidden = false;
            let at = -1;
            for (let k = 0; k < lines.length; k++) { if ((Number(lines[k].time) || 0) <= t + 0.15) at = k; else break; }
            if (at === lyricAt) return;
            const prev = lyricRoll.children[lyricAt];
            if (prev) prev.classList.remove('is-now');
            lyricAt = at;
            const cur = lyricRoll.children[Math.max(0, at)];
            if (cur && at >= 0) cur.classList.add('is-now');
            const before = cur && cur.previousElementSibling;
            const y = cur ? Math.max(0, cur.offsetTop - (before ? before.offsetHeight : 0)) : 0;
            lyricRoll.style.transform = 'translateY(' + (-y) + 'px)';
        };
        const paintSeek = () => {
            if (!seekIsLive()) { seekEl.hidden = true; lyricEl.hidden = true; clearInterval(seekTimer); seekTimer = 0; return; }
            const p = opts.progress();
            const t = seekDrag ? seekDrag.t : p.t;
            seekEl.hidden = !(p.d > 0);
            seekFill.style.transform = 'scaleX(' + (p.d ? Math.min(1, t / p.d) : 0).toFixed(4) + ')';
            seekEl.firstChild.textContent = fmt(t);
            seekEl.lastChild.textContent = fmt(p.d);
            seekEl.setAttribute('aria-valuemin', '0');
            seekEl.setAttribute('aria-valuemax', String(Math.round(p.d)));
            seekEl.setAttribute('aria-valuenow', String(Math.round(t)));
            seekEl.setAttribute('aria-valuetext', fmt(t) + ' / ' + fmt(p.d));
            if (st.expanded && st.expanded.w >= 0) paintLyric(t);
        };
        const syncSeek = () => {
            paintSeek();
            if (seekIsLive() && !seekTimer) seekTimer = setInterval(paintSeek, 250);
        };
        const seekAt = (clientX) => {
            const r = seekEl.querySelector('.aw-seek-bar').getBoundingClientRect();
            const d = opts.progress().d;
            return Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))) * d;
        };
        seekEl.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            seekEl.setPointerCapture?.(e.pointerId);
            seekDrag = { id: e.pointerId, t: seekAt(e.clientX) };
            seekEl.classList.add('is-drag');
            paintSeek();
        });
        seekEl.addEventListener('pointermove', (e) => { if (seekDrag && seekDrag.id === e.pointerId) { seekDrag.t = seekAt(e.clientX); paintSeek(); } });
        const seekEnd = (e) => {
            if (!seekDrag || seekDrag.id !== e.pointerId) return;
            const t = seekDrag.t;
            seekDrag = null;
            seekEl.classList.remove('is-drag');
            if (e.type === 'pointerup' && opts.seek) opts.seek(t);
            setTimeout(paintSeek, 60);
        };
        seekEl.addEventListener('pointerup', seekEnd);
        seekEl.addEventListener('pointercancel', seekEnd);
        seekEl.addEventListener('click', (e) => e.stopPropagation());
        // 键盘：焦点在进度条上时左右键快退/快进 5 秒（Shift 15 秒），Home/End 到头尾；不让墙拿去换选中
        seekEl.addEventListener('keydown', (e) => {
            if (!opts.seek || !opts.progress || e.altKey || e.ctrlKey || e.metaKey) return;
            const p = opts.progress();
            if (!(p.d > 0)) return;
            const step = e.shiftKey ? 15 : 5;
            let t = null;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') t = p.t - step;
            else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') t = p.t + step;
            else if (e.key === 'Home') t = 0;
            else if (e.key === 'End') t = p.d - 1;
            if (t === null) return;
            e.preventDefault();
            e.stopPropagation();
            opts.seek(Math.max(0, Math.min(p.d - 0.5, t)));
            paintSeek();
        });

        const fillContent = (node, idx, px) => {
            const i = st.ids[idx];
            const t = opts.track(i);
            const changed = node.item !== idx;
            if (changed) {
                node.item = idx;
                const m = opts.meta(t, i);
                node.title.textContent = m.title;
                node.sub.textContent = m.artist || '';
                node.code = m.code || '';
                node.badge = null;
                node.blank.textContent = m.title;
                node.el.style.setProperty('--aw-h', hueOf(m.title + '|' + (m.album || '')));
                node.el.setAttribute('aria-label', m.title + (m.artist ? '，' + m.artist : ''));
                node.src = null;
            }
            const src = opts.cover(t);
            const url = src ? thumbs.get(src, px) : '';
            if (url !== node.src) {
                node.src = url;
                if (url) {
                    node.img.src = url;
                    node.el.classList.add('has-art');
                } else {
                    node.img.removeAttribute('src');
                    node.el.classList.remove('has-art');
                }
            }
            // 有封面但还没解出来：底色上扫过一道微光，曲名先不露，免得先闪字再换图
            const wait = Boolean(src && !url && !thumbs.failed(src));
            if (wait !== node.wait) { node.wait = wait; node.el.classList.toggle('is-wait', wait); }
        };

        /* 焦点在大卡/定位键上时，大卡收起或那一格被回收，按钮离开文档，焦点会掉回 body：拉回墙本身，方向键接着能用 */
        const layout = () => {
            const a = document.activeElement;
            const had = Boolean(a && a !== el && el.contains(a));
            layoutTiles();
            if (had && st.on && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
        };
        /*
         * 平放：屏幕上一点 (xs, ys) 对应桌面上哪一点。和 CSS 一致：perspective 1500px、透视原点 (50%, 8%)，
         * 桌面 = translate(W/2, H·TILT_EYE) rotateX(TILT) translate(-cam)。反解出相对 cam 的 (u, v)。
         */
        const TILT_D = 1500, TILT_OY = 0.08;
        const tiltBounds = (W, H) => {
            const c = Math.cos(TILT * Math.PI / 180), sn = Math.sin(TILT * Math.PI / 180);
            const oy = H * TILT_OY;
            const at = (xs, ys) => {
                const a = ys - oy;
                const v = TILT_D * (a - (H * TILT_EYE - oy)) / (TILT_D * c + a * sn);
                const k = TILT_D / (TILT_D - v * sn);
                return { u: W / 2 + (xs - W / 2) / k, v: H / 2 + v };   // 相对 cam（视口左上对应的桌面点）
            };
            const pts = [at(0, 0), at(W, 0), at(0, H), at(W, H)];
            const us = pts.map((p) => p.u), vs = pts.map((p) => p.v);
            return { u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) };
        };
        const layoutTiles = () => {
            st.dirty = false;
            if (!st.g || !st.ids.length || !st.room.width) {
                locateBtn.hidden = true;
                for (const node of st.nodes.values()) recycle(node);
                st.nodes.clear();
                return;
            }
            const g = st.g;
            const over = g.pitch * 3;
            let vx0 = st.cam.x - over, vy0 = st.cam.y - over, vx1 = st.cam.x + st.room.width + over, vy1 = st.cam.y + st.room.height + over;
            if (tilt) {
                // 倒下去的桌面：把视口四个角按透视反投到桌面上，得到真正看得见的那块梯形的外接框，再留一格余量。
                // 以前按经验框了 2.8×3 个视口那么大，屏幕外的格子是看得见的三四倍，大幅滚动时全在白白合成。
                const b = tiltBounds(st.room.width, st.room.height);
                const m = g.pitch * 1.25;
                vx0 = st.cam.x + b.u0 - m; vx1 = st.cam.x + b.u1 + m;
                vy0 = st.cam.y + b.v0 - m; vy1 = st.cam.y + b.v1 + m;
            }
            const c0 = Math.floor(vx0 / g.blockW), c1 = Math.floor(vx1 / g.blockW);
            const r0 = Math.floor(vy0 / g.blockH), r1 = Math.floor(vy1 / g.blockH);
            const keep = new Set();
            const dpr = global.devicePixelRatio || 1;
            const now = performance.now();
            const entering = now < st.enterUntil;
            const sel = st.focus ? st.focus.id : '';
            const exp = st.expanded ? st.expanded.id : '';
            const play = opts.playing();
            const playPos = play.index >= 0 ? st.ids.indexOf(play.index) : -1;
            let count = 0;
            for (let br = r0; br <= r1 && count < maxTiles; br++) {
                for (let bc = c0; bc <= c1 && count < maxTiles; bc++) {
                    for (let s = 0; s < SLOTS; s++) {
                        const inst = instanceAt(g, bc, br, s, st.gap);
                        const r = st.expandedRects.get(inst.id) || inst;
                        if (r.x + r.w < vx0 || r.x > vx1 || r.y + r.h < vy0 || r.y > vy1) continue;
                        count++;
                        keep.add(inst.id);
                        let node = st.nodes.get(inst.id);
                        const fresh = !node;
                        if (fresh) {
                            node = makeNode();
                            st.nodes.set(inst.id, node);
                            node.x = node.y = node.w = node.h = NaN;
                            node.el.dataset.id = inst.id;
                            world.appendChild(node.el);
                            node.el.classList.remove('aw-entering', 'aw-reveal', 'aw-flip');
                            const sweep = entering && sweepAt();
                            if (sweep) {
                                // 换视图时：扫描线从左往右扫过，扫到哪张，哪张就从侧面翻过来
                                const sx = st.room.left + (r.x - st.cam.x) * (tilt ? 0.8 : 1) + (tilt ? st.room.width * 0.1 : 0);
                                node.inner.style.animationDelay = Math.round(sweepTimeAt(Math.max(0, Math.min(1, sx / (sweep.w + 90)))) * sweep.ms) + 'ms';
                                node.el.classList.add('aw-flip');
                            } else if (entering) {
                                // 一波从视野左上角沿对角线往右下走：越靠右下越晚落下
                                const W = st.room.width || 1, H = st.room.height || 1;
                                const u = Math.max(0, Math.min(1, ((r.x - st.cam.x) / W + (r.y - st.cam.y) / H) / 2));
                                node.inner.style.animationDelay = Math.round(u * 340) + 'ms';
                                node.el.classList.add('aw-entering');
                            } else if (st.revealOk) {
                                // 拖动时新露出来的：原地淡入、轻轻放大，不会一下子整张冒出来
                                node.inner.style.animationDelay = '';
                                node.el.classList.add('aw-reveal');
                            }
                        }
                        if (r.x !== node.x || r.y !== node.y) { node.el.style.transform = `translate(${r.x}px,${r.y}px)`; node.x = r.x; node.y = r.y; }
                        if (r.w !== node.w || r.h !== node.h) { node.el.style.width = r.w + 'px'; node.el.style.height = r.h + 'px'; node.w = r.w; node.h = r.h;
                            // 悬停放大：每条边往外长同样的距离（缝宽的六成），大小卡看起来抬得一样多
                            node.el.style.setProperty('--hx', (1 + 1.2 * st.gap / r.w).toFixed(4));
                            node.el.style.setProperty('--hy', (1 + 1.2 * st.gap / r.h).toFixed(4));
                            node.el.style.setProperty('--tw', Math.round(r.w) + 'px'); }
                        fillContent(node, inst.item, Math.max(r.w, r.h) * dpr);
                        const size = r.cols >= 4 ? 'aw-l' : r.cols >= 3 ? 'aw-m' : 'aw-s';
                        const cls = size + (inst.id === sel ? ' is-focus' : '') + (inst.id === exp ? ' is-open' : '') + (inst.item === playPos ? (play.active ? ' is-playing' : ' is-current') : '');
                        if (cls !== node.cls) {
                            node.el.classList.remove('aw-l', 'aw-m', 'aw-s', 'is-focus', 'is-open', 'is-playing', 'is-current');
                            node.el.classList.add(...cls.split(' '));
                            node.cls = cls;
                            node.el.setAttribute('aria-selected', inst.id === sel ? 'true' : 'false');
                        }
                        const isPlay = inst.item === playPos;
                        const badge = isPlay ? (play.active ? '正在播放' : '暂停') + (node.code ? ' · ' + node.code : '') : node.code;
                        if (badge !== node.badge) { node.badge = badge; node.no.textContent = badge; }
                        if (inst.id === exp) {
                            if (panel.parentNode !== node.inner) node.inner.appendChild(panel);
                            fillPanel(st.ids[inst.item]);
                        }
                    }
                }
            }
            for (const [id, node] of st.nodes) {
                if (!keep.has(id)) { st.nodes.delete(id); recycle(node); }
            }
            if (!exp && panel.parentNode) { panel.remove(); paintSeek(); }
            // 定位键：正在播放的那首离这里最近的一份在不在视野里
            if (playPos < 0) locateBtn.hidden = true;
            else {
                locateBtn.hidden = false;
                const pi = nearestOf(g, playPos, viewCenter(), st.gap);
                const pr = rectOf(pi);
                const inView = pr.x + pr.w > st.cam.x && pr.x < st.cam.x + st.room.width && pr.y + pr.h > st.cam.y && pr.y < st.cam.y + st.room.height;
                locateBtn.classList.toggle('is-away', !inView);
            }
            world.classList.toggle('aw-has-open', Boolean(exp));
            st.laidAt = { x: st.cam.x, y: st.cam.y };
            st.revealOk = !reduced();
        };

        const applyCamera = () => {
            if (tilt) {
                // 视野中心（cam + 半个视口）放到屏幕 (50%, TILT_EYE) 处，整块桌面绕那里往后倒
                const cx = st.cam.x + st.room.width / 2, cy = st.cam.y + st.room.height / 2;
                world.style.transform = `translate3d(${st.room.width / 2}px,${Math.round(st.room.height * TILT_EYE)}px,0) rotateX(${TILT}deg) translate3d(${-Math.round(cx * 2) / 2}px,${-Math.round(cy * 2) / 2}px,0)`;
            } else world.style.transform = `translate3d(${-Math.round(st.cam.x * 2) / 2}px,${-Math.round(st.cam.y * 2) / 2}px,0)`;
            const g = st.g;
            if (!st.laidAt || !g || Math.abs(st.cam.x - st.laidAt.x) > g.pitch * 1.5 || Math.abs(st.cam.y - st.laidAt.y) > g.pitch * 1.5) st.dirty = true;
        };

        /* 镜头在动（滚轮、拖动、惯性、飞过去）时挂 aw-moving：格子不接悬停（不然光标底下一张张立起又放下）、
           平放的景深模糊先关掉；停下 180ms 后恢复，免得滚轮一格一格时来回闪 */
        let movingOff = 0;
        const setMoving = (on) => {
            if (on) {
                if (movingOff) { clearTimeout(movingOff); movingOff = 0; }
                if (!el.classList.contains('aw-moving')) el.classList.add('aw-moving');
            } else if (!movingOff && el.classList.contains('aw-moving')) {
                movingOff = setTimeout(() => { movingOff = 0; el.classList.remove('aw-moving'); }, 180);
            }
        };
        const tick = (now) => {
            st.raf = 0;
            if (!st.on) return;
            const dt = Math.min(0.05, st.last ? (now - st.last) / 1000 : 1 / 60);
            st.last = now;
            let moving = false;
            if (st.aim) {
                // 镜头用和卡片让位同一组弹簧参数（300/34）走过去，展开时卡和镜头一起到位
                const av = st.aimVel || (st.aimVel = { x: 0, y: 0 });
                for (const ax of ['x', 'y']) {
                    const acc = 300 * (st.aim[ax] - st.cam[ax]) - 34 * av[ax];
                    av[ax] += acc * dt;
                    st.cam[ax] += av[ax] * dt;
                }
                if (Math.abs(st.aim.x - st.cam.x) < 0.5 && Math.abs(st.aim.y - st.cam.y) < 0.5 && Math.hypot(av.x, av.y) < 20) { st.cam.x = st.aim.x; st.cam.y = st.aim.y; st.aim = null; av.x = av.y = 0; }
                else moving = true;
            } else if (st.wheelAim) {
                const k = 1 - Math.exp(-dt / 0.085);
                st.cam.x += (st.wheelAim.x - st.cam.x) * k;
                st.cam.y += (st.wheelAim.y - st.cam.y) * k;
                if (Math.abs(st.wheelAim.x - st.cam.x) < 0.5 && Math.abs(st.wheelAim.y - st.cam.y) < 0.5) { st.cam.x = st.wheelAim.x; st.cam.y = st.wheelAim.y; st.wheelAim = null; }
                else moving = true;
            } else if (!st.drag && (Math.abs(st.vel.x) > 4 || Math.abs(st.vel.y) > 4)) {
                st.cam.x -= st.vel.x * dt;
                st.cam.y -= st.vel.y * dt;
                const k = Math.exp(-dt / 0.3);
                st.vel.x *= k; st.vel.y *= k;
                moving = true;
            } else if (!st.drag) { st.vel.x = st.vel.y = 0; }
            applyCamera();
            setMoving(moving || Boolean(st.drag && st.drag.moved));
            if (st.dirty || st.coverDirty) { st.coverDirty = false; layout(); }
            if (moving || st.drag || performance.now() < st.enterUntil) { st.last = now; st.raf = requestAnimationFrame(tick); }
            else st.last = 0;
        };
        const schedule = () => { if (st.on && !st.raf) st.raf = requestAnimationFrame(tick); };

        // ---------- 输入 ----------
        const tileOf = (target) => {
            const t = target && target.closest ? target.closest('.aw-tile') : null;
            if (!t || !t.dataset.id) return null;
            const [bc, br, slot] = t.dataset.id.split(':').map(Number);
            return instanceAt(st.g, bc, br, slot, st.gap);
        };
        // 平放时屏幕上挪一像素，桌面上要走得更远（纵向按倒下的角度放大）
        const panK = tilt ? { x: 1.15, y: 1 / Math.cos(TILT * Math.PI / 180) } : { x: 1, y: 1 };
        let lastClick = { id: '', t: 0 };
        el.addEventListener('pointerdown', (e) => {
            wake();
            if (e.button !== 0 || e.target.closest('button')) return;
            st.aim = null; st.wheelAim = null; st.aimVel = null;
            st.vel.x = st.vel.y = 0;
            st.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false, samples: [[performance.now(), e.clientX, e.clientY]] };
        });
        el.addEventListener('pointermove', (e) => {
            const d = st.drag;
            if (!d || d.id !== e.pointerId) return;
            if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
            if (!d.moved) { d.moved = true; el.setPointerCapture?.(e.pointerId); el.classList.add('is-grabbing'); }
            st.cam.x -= (e.clientX - d.x) * panK.x;
            st.cam.y -= (e.clientY - d.y) * panK.y;
            d.x = e.clientX; d.y = e.clientY;
            const now = performance.now();
            d.samples.push([now, e.clientX, e.clientY]);
            while (d.samples.length > 2 && now - d.samples[0][0] > 90) d.samples.shift();
            schedule();
        });
        const endDrag = (e) => {
            const d = st.drag;
            if (!d || d.id !== e.pointerId) return;
            st.drag = null;
            el.classList.remove('is-grabbing');
            if (!d.moved) return;
            const now = performance.now();
            const s = d.samples;
            const a = s[0], b = s[s.length - 1];
            const span = (b[0] - a[0]) / 1000;
            if (span > 0.008 && now - b[0] < 80 && !reduced()) {
                const vx = (b[1] - a[1]) / span, vy = (b[2] - a[2]) / span;
                const sp = Math.hypot(vx, vy);
                const lim = sp > 4000 ? 4000 / sp : 1;
                if (sp > 40) { st.vel.x = vx * lim * panK.x; st.vel.y = vy * lim * panK.y; }
            }
            d.wasDrag = true;
            st.justDragged = now;
            schedule();
        };
        el.addEventListener('pointerup', endDrag);
        el.addEventListener('pointercancel', endDrag);
        el.addEventListener('click', (e) => {
            if (st.justDragged && performance.now() - st.justDragged < 60) return;
            const btn = e.target.closest('[data-wall]');
            if (btn) {
                e.stopPropagation();
                if (btn.dataset.wall === 'locate') {
                    const p = opts.playing();
                    const pos = p.index >= 0 ? st.ids.indexOf(p.index) : -1;
                    if (pos >= 0) {
                        const inst = nearestOf(st.g, pos, viewCenter(), st.gap);
                        if (st.expanded && st.expanded.id !== inst.id) setExpanded(null);
                        focusInstance(inst, { center: true });
                    }
                    locateBtn.classList.remove('is-ping');
                    void locateBtn.offsetWidth;
                    locateBtn.classList.add('is-ping');
                    return;
                }
                if (btn.dataset.wall === 'quickmenu') {
                    const q = tileOf(btn);
                    if (q) { if (!st.focus || st.focus.id !== q.id) focusInstance(q); const r = btn.getBoundingClientRect(); opts.menu(st.ids[q.item], r.left, r.bottom + 6, btn); }
                    return;
                }
                if (btn.dataset.wall === 'quick') {
                    const q = tileOf(btn);
                    if (q) { if (!st.focus || st.focus.id !== q.id) focusInstance(q); opts.play(st.ids[q.item], {}); }
                    return;
                }
                const i = st.expanded ? st.ids[st.expanded.item] : -1;
                if (i < 0) return;
                const p = opts.playing();
                const cur = p.index === i && typeof opts.transport === 'function';
                if (btn.dataset.wall === 'prev' || btn.dataset.wall === 'next') { st.followExpand = true; opts.transport(btn.dataset.wall); }
                else if (btn.dataset.wall === 'play') { if (cur) opts.transport('toggle'); else opts.play(i, {}); }
                else if (btn.dataset.wall === 'stage') opts.play(i, { stage: true });
                else if (btn.dataset.wall === 'menu') { const r = btn.getBoundingClientRect(); opts.menu(i, r.left, r.bottom + 6, btn); }
                schedule();
                return;
            }
            const inst = tileOf(e.target);
            const now = performance.now();
            if (!inst) { if (st.expanded) setExpanded(null); return; }
            const dbl = lastClick.id === inst.id && now - lastClick.t < 380;
            lastClick = { id: inst.id, t: now };
            if (dbl) { opts.play(st.ids[inst.item], {}); return; }
            if (st.expanded && st.expanded.id === inst.id) return;
            focusInstance(inst, { expand: true });
        });
        el.addEventListener('contextmenu', (e) => {
            const inst = tileOf(e.target);
            if (!inst) return;
            e.preventDefault();
            if (!st.focus || st.focus.id !== inst.id) focusInstance(inst);
            opts.menu(st.ids[inst.item], e.clientX, e.clientY, null);
        });
        let wheelGesture = { t: -1e9, kind: '' };
        el.addEventListener('wheel', (e) => {
            if (!st.g) return;
            e.preventDefault();
            wake();
            st.aim = null;
            st.vel.x = st.vel.y = 0;
            let dx = e.deltaX, dy = e.deltaY;
            if (e.deltaMode === 1) { dx *= 16; dy *= 16; } else if (e.deltaMode === 2) { dx *= st.room.width; dy *= st.room.height; }
            if (e.shiftKey && !dx) { dx = dy; dy = 0; }
            dx *= panK.x; dy *= panK.y;
            // 鼠标滚轮一格（单轴、步子大）平滑走过去；触控板的小增量直接跟手
            const same = e.timeStamp - wheelGesture.t < 120;
            wheelGesture.t = e.timeStamp;
            const padLike = (dx && dy) || Math.max(Math.abs(dx), Math.abs(dy)) < 50;
            if (!same) wheelGesture.kind = padLike ? 'pad' : 'wheel';
            else if (padLike) wheelGesture.kind = 'pad';
            if (wheelGesture.kind === 'pad' || reduced()) {
                st.wheelAim = null;
                st.cam.x += dx; st.cam.y += dy;
            } else {
                const base = st.wheelAim || { x: st.cam.x, y: st.cam.y };
                st.wheelAim = { x: base.x + dx * 1.4, y: base.y + dy * 1.4 };
            }
            schedule();
        }, { passive: false });

        /*
         * 熄灯：正在放歌、没有展开的卡、这面墙半分钟没人碰时，除了正在播放的那几张，其余慢慢暗下去；
         * 鼠标一动、滚轮、按键就亮回来。
         */
        const DIM_AFTER = 30000;
        let dimTimer = 0;
        const wake = () => {
            st.touchedAt = performance.now();
            if (el.classList.contains('aw-dim')) el.classList.remove('aw-dim');
        };
        const checkDim = () => {
            const p = opts.playing();
            const want = st.on && p.active && p.index >= 0 && !st.expanded && !reduced() && performance.now() - (st.touchedAt || 0) > DIM_AFTER && st.ids.includes(p.index);
            el.classList.toggle('aw-dim', want);
        };
        el.addEventListener('pointermove', () => { if (el.classList.contains('aw-dim') || performance.now() - (st.touchedAt || 0) > 1000) wake(); }, { passive: true });
        global.addEventListener('keydown', () => { if (st.on) wake(); }, true);

        // ---------- 对外 ----------
        const api = {
            el,
            show(on) {
                on = Boolean(on);
                if (on === st.on) return;
                st.on = on;
                el.hidden = !on;
                if (on) {
                    st.touchedAt = performance.now();
                    st.shownAt = performance.now();
                    clearInterval(dimTimer);
                    dimTimer = setInterval(checkDim, 2000);
                    syncItems({ force: true });
                    st.dirty = true;
                    schedule();
                } else {
                    clearInterval(dimTimer);
                    el.classList.remove('aw-dim');
                    cancelAnimationFrame(st.raf);
                    st.raf = 0;
                    setExpanded(null, { animate: false });
                    for (const node of st.nodes.values()) recycle(node);
                    st.nodes.clear();
                    thumbs.clearQueue();
                }
            },
            get on() { return st.on; },
            setRoom,
            /* 档案页每次换选中、换列、播放状态变了都调一下；没变的部分不动 */
            sync({ expand = false } = {}) {
                if (!st.on) return;
                if (syncItems()) { if (expand) { st.wantExpand = true; st.selIndex = -2; syncSelection({ center: true, instant: true }); } return; }
                if (expand && (!st.expanded || st.ids[st.expanded.item] !== opts.selected())) { st.wantExpand = true; st.selIndex = -2; }
                syncSelection();
                const p = opts.playing();
                const pk = p.index + ':' + p.active;
                if (pk !== st.playKey) {
                    const prevIndex = st.playIndex;
                    st.playKey = pk;
                    st.playIndex = p.index;
                    st.dirty = true;
                    // 大卡展开着的是刚才在放的那首、现在换到下一首了：大卡跟着换到新的这首
                    if (st.expanded && prevIndex !== undefined && prevIndex !== p.index && p.index >= 0 && (st.followExpand || st.ids[st.expanded.item] === prevIndex)) {
                        const pos = st.ids.indexOf(p.index);
                        if (pos >= 0 && st.g) focusInstance(nearestOf(st.g, pos, viewCenter(), st.gap), { expand: true });
                    }
                    st.followExpand = false;
                    // 换歌了：用户这几秒没在摆弄墙的话，镜头自己滑到正在播放的那张（不改选中、不展开）
                    if (p.active && prevIndex !== undefined && prevIndex !== p.index && performance.now() - (st.touchedAt || 0) > 6000) {
                        const pos = st.ids.indexOf(p.index);
                        if (pos >= 0 && st.g && !st.expanded) {
                            const inst = nearestOf(st.g, pos, viewCenter(), st.gap);
                            const r = rectOf(inst);
                            const pad = Math.min(st.room.width, st.room.height) * 0.18;
                            if (r.x < st.cam.x + pad || r.y < st.cam.y + pad || r.x + r.w > st.cam.x + st.room.width - pad || r.y + r.h > st.cam.y + st.room.height - pad) centerOn(inst);
                        }
                    }
                    schedule();
                }
            },
            coverFound() { st.coverDirty = true; schedule(); },
            step,
            collapse() { if (!st.expanded) return false; setExpanded(null); return true; },
            get expanded() { return Boolean(st.expanded); },
            refresh() { st.dirty = true; schedule(); },
            destroy() {
                st.on = false;
                cancelAnimationFrame(st.raf);
                clearTimeout(st.reflowTimer);
                clearInterval(seekTimer);
                clearInterval(dimTimer);
                thumbs.destroy();
                el.remove();
            },
            debug: () => ({ on: st.on, items: st.ids.length, tiles: st.nodes.size, cam: { ...st.cam }, pitch: st.g?.pitch, focus: st.focus?.id || null, expanded: st.expanded?.id || null, thumbs: thumbs.size, templates: TEMPLATES.length })
        };
        return api;
    };

    global.MusicArchiveWall = Object.freeze({ create, createThumbs, fillEmpty, sweepTimeAt, _test: { DIM_AFTER: 30000, SPRING_ENTER, SPRING_FLOW, TEMPLATES, ORIENTED, reflowFor, partition, geometryFor, instanceAt, nearestOf } });
})(typeof window !== 'undefined' ? window : globalThis);
