/*
 * 档案页的第三种视图「分节网格」：封面排成整齐的方格，按首字母（或当前这一组）分节，每节一个档案式的节标题；
 * 上下滚动，节标题吸在顶上。和封面墙一样只建看得见的格子，封面用封面墙那套缩略图缓存。
 * 选中、播放、右键菜单都交还给档案页（archive-view.js 传进来的回调）。
 */
(function (global) {
    'use strict';

    const HEAD_H = 92;       // 节标题高度
    const TEXT_H = 46;       // 封面下面两行字
    const GAP_X = 22, GAP_Y = 26;
    const MIN_CELL = 132, MAX_CELL = 188;

    /*
     * opts: 和封面墙相同（items 换成 sections()），另有
     *   sections() → { key, list: [{ id, name, sub, ids }] }
     */
    const create = (opts) => {
        const Wall = global.MusicArchiveWall;
        const thumbs = Wall && Wall.createThumbs ? Wall.createThumbs(() => schedule(true)) : { get: () => '', clearQueue() {}, destroy() {} };
        const el = document.createElement('div');
        el.className = 'archive-grid';
        el.hidden = true;
        el.setAttribute('role', 'grid');
        el.setAttribute('aria-label', '分节网格');
        el.innerHTML = '<div class="ag-scroll"><div class="ag-content"></div></div><div class="ag-sticky" aria-hidden="true"><b></b><span></span><em></em><i></i></div><div class="ag-empty" hidden>这一组还没有曲目</div>';
        const scroller = el.querySelector('.ag-scroll');
        const content = el.querySelector('.ag-content');
        const sticky = el.querySelector('.ag-sticky');
        const emptyEl = el.querySelector('.ag-empty');
        // 键盘：滚动区是一个 Tab 停靠点（每格的播放/更多键不进 Tab 顺序，免得 Tab 落到看不见的按钮上），停在这里后方向键选、回车播放
        scroller.tabIndex = 0;
        scroller.setAttribute('aria-label', '网格，方向键选歌，回车播放');
        // 定位正在播放：和封面墙同一个右下角圆键（样式在 archive-wall.css 的 .aw-locate）
        const locateBtn = document.createElement('button');
        locateBtn.type = 'button';
        locateBtn.className = 'aw-locate ag-locate';
        locateBtn.title = '找到正在播放的那首';
        locateBtn.setAttribute('aria-label', '找到正在播放的那首');
        locateBtn.hidden = true;
        locateBtn.innerHTML = '<i></i>';
        el.appendChild(locateBtn);
        // 入场和封面墙用同一条弹簧曲线
        const SP = global.MusicArchiveWall && global.MusicArchiveWall._test && global.MusicArchiveWall._test.SPRING_ENTER;
        if (SP && global.CSS && CSS.supports && CSS.supports('transition-timing-function', SP.ease)) el.style.setProperty('--aw-sp-enter', SP.ease);
        opts.host.insertBefore(el, opts.before || null);
        const reduced = () => Boolean(opts.reducedMotion && opts.reducedMotion());

        const hueOf = (str) => { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
        const st = {
            on: false, key: '', secs: [], rows: [], total: 0,
            width: 0, height: 0, cols: 1, cell: 150,
            where: new Map(),            // 曲库下标 → { s, k }（第几节第几个）
            nodes: new Map(), heads: new Map(), pool: [],
            sel: -1, raf: 0, dirtyAll: true, playKey: '',
            room: { left: 0, top: 0, width: 0, height: 0 }
        };

        // ---------- 排版 ----------
        const measure = () => {
            const w = st.room.width - 8;          // 滚动条
            const cols = Math.max(2, Math.floor((w + GAP_X) / (MIN_CELL + GAP_X)));
            const cell = Math.min(MAX_CELL, Math.floor((w - (cols - 1) * GAP_X) / cols));
            st.cols = cols;
            st.cell = cell;
            st.rowH = cell + TEXT_H + GAP_Y;
            st.rows = [];
            let y = 0;
            st.secs.forEach((sec, s) => {
                if (st.secs.length > 1) { st.rows.push({ type: 'head', y, s }); y += HEAD_H; }
                const n = sec.ids.length;
                for (let k = 0; k < n; k += cols) { st.rows.push({ type: 'row', y, s, k }); y += st.rowH; }
                y += 18;
            });
            st.total = y + 24;
            content.style.height = st.total + 'px';
            const left = Math.max(0, Math.floor((w - (cols * cell + (cols - 1) * GAP_X)) / 2));
            st.left = left;
        };
        const rowAt = (y) => {
            let lo = 0, hi = st.rows.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (st.rows[mid].y <= y) lo = mid; else hi = mid - 1;
            }
            return lo;
        };

        const syncData = (force = false) => {
            const d = opts.sections() || { key: '', list: [] };
            // 按内容比：只是曲库签名变了（刚播的一首进了「最近播放」之类），各节曲目没变就不重排
            let h = 0;
            for (const sec of d.list) {
                for (const c of String(sec.name || '')) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
                for (let k = 0; k < sec.ids.length; k++) h = (Math.imul(h, 31) + sec.ids[k]) | 0;
                h = (Math.imul(h, 31) + sec.ids.length) | 0;
            }
            const sig = d.list.length + '#' + h;
            if (!force && sig === st.key) return false;
            st.key = sig;
            st.secs = d.list.filter((x) => x.ids.length);
            st.where.clear();
            st.secs.forEach((sec, s) => sec.ids.forEach((i, k) => { if (!st.where.has(i)) st.where.set(i, { s, k }); }));
            for (const n of st.nodes.values()) recycle(n);
            st.nodes.clear();
            for (const h of st.heads.values()) h.remove();
            st.heads.clear();
            thumbs.clearQueue();
            emptyEl.hidden = st.secs.length > 0;
            if (!st.secs.length && Wall && Wall.fillEmpty) Wall.fillEmpty(emptyEl, '');
            // 换一组：这一屏的格子按行列依次落下（从左上往右下一波）
            st.enterUntil = reduced() ? 0 : performance.now() + 700;
            st.revealOk = false;
            measure();
            st.sel = -2;
            syncSelection(true);
            return true;
        };

        // ---------- 格子 ----------
        const recycle = (n) => { n.el.remove(); n.idx = -1; if (st.pool.length < 120) st.pool.push(n); };
        const makeNode = () => {
            const n = st.pool.pop();
            if (n) return n;
            const t = document.createElement('div');
            t.className = 'ag-cell';
            t.setAttribute('role', 'gridcell');
            t.innerHTML = '<div class="ag-art"><img alt="" draggable="false" decoding="async"><span class="ag-blank"></span><span class="ag-no"></span><button type="button" class="ag-play" data-grid="play" tabindex="-1" title="播放" aria-label="播放"></button><button type="button" class="ag-more" data-grid="more" tabindex="-1" title="更多操作" aria-label="更多操作"></button></div><b class="ag-t"></b><span class="ag-a"></span>';
            return { el: t, img: t.querySelector('img'), blank: t.querySelector('.ag-blank'), no: t.querySelector('.ag-no'), title: t.querySelector('.ag-t'), sub: t.querySelector('.ag-a'), idx: -1, src: null, cls: '' };
        };
        const headNode = (s) => {
            const sec = st.secs[s];
            const h = document.createElement('div');
            h.className = 'ag-head' + (st.revealOk ? ' ag-reveal' : (performance.now() < (st.enterUntil || 0) ? ' ag-entering' : ''));
            // Folia 式题头：左边一个超大的节名，右上角「第几节 / 共几节」编号，底下数量和一条结构线
            h.innerHTML = '<b></b><span></span><em></em><i></i>';
            h.firstChild.textContent = sec.name;
            h.children[2].textContent = String(s + 1).padStart(2, '0') + ' / ' + String(st.secs.length).padStart(2, '0');
            h.children[1].textContent = sec.ids.length + ' 首' + (sec.sub ? ' · ' + sec.sub : '');
            return h;
        };

        const render = () => {
            st.raf = 0;
            if (!st.on || !st.rows.length) { sticky.hidden = true; locateBtn.hidden = true; return; }
            const top = scroller.scrollTop;
            const view0 = top - st.rowH, view1 = top + st.room.height + st.rowH;
            const keep = new Set(), keepHeads = new Set();
            const dpr = global.devicePixelRatio || 1;
            const play = opts.playing();
            for (let r = rowAt(Math.max(0, view0)); r < st.rows.length && st.rows[r].y < view1; r++) {
                const row = st.rows[r];
                if (row.type === 'head') {
                    keepHeads.add(row.s);
                    let h = st.heads.get(row.s);
                    if (!h) { h = headNode(row.s); st.heads.set(row.s, h); content.appendChild(h); }
                    h.style.transform = `translate3d(${st.left}px,${row.y}px,0)`;
                    h.style.width = (st.cols * st.cell + (st.cols - 1) * GAP_X) + 'px';
                    continue;
                }
                const sec = st.secs[row.s];
                for (let c = 0; c < st.cols; c++) {
                    const k = row.k + c;
                    if (k >= sec.ids.length) break;
                    const id = row.s + ':' + k;
                    keep.add(id);
                    let n = st.nodes.get(id);
                    if (!n) {
                        n = makeNode();
                        st.nodes.set(id, n);
                        n.el.dataset.id = id;
                        content.appendChild(n.el);
                        n.idx = -1;
                        n.el.classList.remove('ag-entering', 'ag-reveal', 'ag-flip');
                        const sweep = performance.now() < (st.enterUntil || 0) && performance.now() - (st.shownAt || 0) < 400 && opts.host.querySelector('.archive-layout-sweep');
                        if (sweep) {
                            // 换视图时跟着扫描线从左往右翻过来
                            const w = opts.host.clientWidth || global.innerWidth || 1600;
                            const ms = Math.min(720, 380 + w * 0.16);
                            const sx = st.room.left + st.left + c * (st.cell + GAP_X);
                            const at = global.MusicArchiveWall?.sweepTimeAt;
                            const u = Math.max(0, Math.min(1, sx / (w + 90)));
                            n.el.style.setProperty('--ag-d', Math.round((at ? at(u) : u) * ms) + 'ms');
                            n.el.classList.add('ag-flip');
                        } else if (performance.now() < (st.enterUntil || 0)) {
                            const vr = Math.max(0, (row.y - top) / st.rowH);
                            n.el.style.setProperty('--ag-d', Math.round(Math.min(360, (vr + c * 0.6) * 45)) + 'ms');
                            n.el.classList.add('ag-entering');
                        } else if (st.revealOk) {
                            n.el.style.setProperty('--ag-d', (c * 22) + 'ms');
                            n.el.classList.add('ag-reveal');
                        }
                    }
                    const x = st.left + c * (st.cell + GAP_X);
                    const pos = x + ',' + row.y + ',' + st.cell;
                    if (n.pos !== pos) {
                        n.pos = pos;
                        n.el.style.transform = `translate3d(${x}px,${row.y}px,0)`;
                        n.el.style.width = st.cell + 'px';
                    }
                    const i = sec.ids[k];
                    if (n.idx !== i) {
                        n.idx = i;
                        const t = opts.track(i);
                        const m = opts.meta(t, i);
                        n.title.textContent = m.title;
                        n.sub.textContent = m.artist || m.album || '';
                        n.blank.textContent = m.title;
                        n.code = m.code || '';
                        n.badge = null;
                        n.el.style.setProperty('--aw-h', hueOf(m.title + '|' + (m.album || '')));
                        n.el.setAttribute('aria-label', m.title + (m.artist ? '，' + m.artist : ''));
                        n.src = null;
                    }
                    const src = opts.cover(opts.track(i));
                    const url = src ? thumbs.get(src, st.cell * dpr) : '';
                    if (url !== n.src) {
                        n.src = url;
                        if (url) { n.img.src = url; n.el.classList.add('has-art'); } else { n.img.removeAttribute('src'); n.el.classList.remove('has-art'); }
                    }
                    const wait = Boolean(src && !url && thumbs.failed && !thumbs.failed(src));
                    if (wait !== n.wait) { n.wait = wait; n.el.classList.toggle('is-wait', wait); }
                    const cls = (i === st.sel ? 'is-focus ' : '') + (i === play.index ? (play.active ? 'is-playing' : 'is-current') : '');
                    if (cls !== n.cls) {
                        n.el.classList.remove('is-focus', 'is-playing', 'is-current');
                        if (cls.trim()) n.el.classList.add(...cls.trim().split(' '));
                        n.cls = cls;
                        n.el.setAttribute('aria-selected', i === st.sel ? 'true' : 'false');
                    }
                    const badge = i === play.index ? (play.active ? '正在播放' : '暂停') : n.code;
                    if (badge !== n.badge) { n.badge = badge; n.no.textContent = badge; }
                }
            }
            for (const [id, n] of st.nodes) if (!keep.has(id)) { st.nodes.delete(id); recycle(n); }
            for (const [s, h] of st.heads) if (!keepHeads.has(s)) { h.remove(); st.heads.delete(s); }
            // 吸顶节标题：最上面那一行属于哪一节（节标题自己还在视野里时不显示，免得叠两层）
            if (st.secs.length > 1) {
                const r = st.rows[rowAt(top + 2)];
                const sec = st.secs[r.s];
                const headVisible = r.type === 'head' && r.y > top - 4;
                sticky.hidden = headVisible || top < 4;
                if (!sticky.hidden && sticky.dataset.s !== String(r.s)) {
                    // 换节：节名从滚动方向那边卷进来（往下滚从下面上来，往上滚从上面下来），编号跟着换
                    const prev = Number(sticky.dataset.s);
                    sticky.dataset.s = String(r.s);
                    sticky.children[0].textContent = sec.name;
                    sticky.children[1].textContent = sec.ids.length + ' 首';
                    sticky.children[2].textContent = String(r.s + 1).padStart(2, '0') + ' / ' + String(st.secs.length).padStart(2, '0');
                    if (!reduced() && Number.isFinite(prev)) {
                        sticky.classList.remove('ag-roll-up', 'ag-roll-down');
                        void sticky.offsetWidth;
                        sticky.classList.add(r.s > prev ? 'ag-roll-up' : 'ag-roll-down');
                    }
                }
            } else sticky.hidden = true;
            st.revealOk = !reduced();
            const pr = play.index >= 0 ? rectOf(play.index) : null;
            locateBtn.hidden = !pr;
            if (pr) locateBtn.classList.toggle('is-away', pr.y + pr.h < top + 10 || pr.y > top + st.room.height - 10);
        };
        const schedule = () => { if (st.on && !st.raf) st.raf = requestAnimationFrame(render); };
        scroller.addEventListener('scroll', schedule, { passive: true });

        // ---------- 选中 ----------
        const rectOf = (i) => {
            const w = st.where.get(i);
            if (!w) return null;
            const r = st.rows.find((x) => x.type === 'row' && x.s === w.s && x.k <= w.k && w.k < x.k + st.cols);
            if (!r) return null;
            return { y: r.y, h: st.cell + TEXT_H, col: w.k - r.k };
        };
        const reveal = (i, { center = false, instant = false } = {}) => {
            const r = rectOf(i);
            if (!r) return;
            const top = scroller.scrollTop, h = st.room.height;
            const pad = 28 + (st.secs.length > 1 ? HEAD_H * 0.6 : 0);
            let to = null;
            if (center) to = r.y - (h - r.h) / 2;
            else if (r.y < top + pad) to = r.y - pad;
            else if (r.y + r.h > top + h - 20) to = r.y + r.h - h + 20;
            if (to === null) return;
            scroller.scrollTo({ top: Math.max(0, to), behavior: instant || reduced() ? 'auto' : 'smooth' });
        };
        const syncSelection = (center = false) => {
            const sel = opts.selected();
            if (sel === st.sel) return;
            st.sel = sel;
            reveal(sel, { center, instant: center });
            schedule();
        };
        const step = (key) => {
            const w = st.where.get(st.sel);
            if (!w) { const first = st.secs[0]?.ids[0]; if (first !== undefined) opts.pick(first); return true; }
            let { s, k } = w;
            const cols = st.cols;
            const sec = () => st.secs[s];
            if (key === 'ArrowLeft' || key === 'ArrowRight') {
                k += key === 'ArrowLeft' ? -1 : 1;
                if (k < 0) { if (s > 0) { s--; k = sec().ids.length - 1; } else k = 0; }
                else if (k >= sec().ids.length) { if (s < st.secs.length - 1) { s++; k = 0; } else k = sec().ids.length - 1; }
            } else if (key === 'ArrowUp' || key === 'ArrowDown') {
                const col = k % cols;
                if (key === 'ArrowDown') {
                    if (k + cols < sec().ids.length) k += cols;
                    else if (Math.floor(k / cols) < Math.floor((sec().ids.length - 1) / cols)) k = sec().ids.length - 1;
                    else if (s < st.secs.length - 1) { s++; k = Math.min(col, sec().ids.length - 1); }
                } else if (k - cols >= 0) k -= cols;
                else if (s > 0) {
                    s--;
                    const n = sec().ids.length;
                    const lastRow = Math.floor((n - 1) / cols) * cols;
                    k = Math.min(lastRow + col, n - 1);
                }
            } else if (key === 'PageDown' || key === 'PageUp') {
                scroller.scrollBy({ top: (key === 'PageDown' ? 1 : -1) * st.room.height * 0.85, behavior: reduced() ? 'auto' : 'smooth' });
                return true;
            } else return false;
            const i = st.secs[s].ids[k];
            if (i !== undefined) opts.pick(i);
            return true;
        };

        // ---------- 输入 ----------
        const cellOf = (target) => {
            const c = target && target.closest ? target.closest('.ag-cell') : null;
            if (!c || !c.dataset.id) return -1;
            const [s, k] = c.dataset.id.split(':').map(Number);
            const sec = st.secs[s];
            return sec ? sec.ids[k] : -1;
        };
        let last = { i: -1, t: 0 };
        locateBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const p = opts.playing();
            if (p.index >= 0 && st.where.has(p.index)) { opts.pick(p.index); reveal(p.index, { center: true }); }
            locateBtn.classList.remove('is-ping');
            void locateBtn.offsetWidth;
            locateBtn.classList.add('is-ping');
        });
        el.addEventListener('click', (e) => {
            const i = cellOf(e.target);
            if (i < 0) return;
            if (e.target.closest('[data-grid="play"]')) { e.stopPropagation(); opts.play(i, {}); return; }
            const more = e.target.closest('[data-grid="more"]');
            if (more) { e.stopPropagation(); opts.pick(i); const r = more.getBoundingClientRect(); opts.menu(i, r.left, r.bottom + 6, more); return; }
            const now = performance.now();
            if (last.i === i && now - last.t < 380) { opts.play(i, {}); last = { i: -1, t: 0 }; return; }
            last = { i, t: now };
            opts.pick(i);
        });
        el.addEventListener('contextmenu', (e) => {
            const i = cellOf(e.target);
            if (i < 0) return;
            e.preventDefault();
            opts.pick(i);
            opts.menu(i, e.clientX, e.clientY, null);
        });
        el.addEventListener('wheel', (e) => e.stopPropagation());

        return {
            el,
            get on() { return st.on; },
            show(on) {
                on = Boolean(on);
                if (on === st.on) return;
                st.on = on;
                el.hidden = !on;
                if (on) { st.shownAt = performance.now(); syncData(true); schedule(); }
                else {
                    cancelAnimationFrame(st.raf); st.raf = 0;
                    for (const n of st.nodes.values()) recycle(n);
                    st.nodes.clear();
                    for (const h of st.heads.values()) h.remove();
                    st.heads.clear();
                    thumbs.clearQueue();
                }
            },
            setRoom(room) {
                const r = { left: Math.round(room.left), top: Math.round(room.top), width: Math.max(0, Math.round(room.width)), height: Math.max(0, Math.round(room.height)) };
                if (['left', 'top', 'width', 'height'].every((k) => r[k] === st.room[k])) return;
                const widthChanged = r.width !== st.room.width;
                st.room = r;
                Object.assign(el.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
                if (widthChanged && st.secs.length) {
                    for (const n of st.nodes.values()) n.pos = '';
                    for (const h of st.heads.values()) h.remove();
                    st.heads.clear();
                    measure();
                    reveal(st.sel, { center: true, instant: true });
                }
                schedule();
            },
            sync() {
                if (!st.on) return;
                if (syncData()) { schedule(); return; }
                syncSelection();
                const p = opts.playing();
                const pk = p.index + ':' + p.active;
                if (pk !== st.playKey) { st.playKey = pk; schedule(); }
            },
            step,
            coverFound: () => schedule(),
            collapse: () => false,
            destroy() { st.on = false; cancelAnimationFrame(st.raf); thumbs.destroy(); el.remove(); },
            debug: () => ({ on: st.on, sections: st.secs.length, cols: st.cols, cell: st.cell, cells: st.nodes.size, total: st.total, scroll: scroller.scrollTop, sel: st.sel })
        };
    };

    global.MusicArchiveGrid = Object.freeze({ create });
})(typeof window !== 'undefined' ? window : globalThis);
