// 音乐窗口里「手碰得到的东西」共用的一套流体动作。
//
//   MusicFluid.bud(el, origin)      弹出层从触发的那一点长出来：先是一滴，拉出细颈，再鼓成整块，内容随后显现
//   MusicFluid.melt(snap, to)       关掉时反过来：整块缩回一滴流回那一点（snap 来自 MusicFluid.snapshot(el)，打开时记下）
//   MusicFluid.enabled()            降低动态、节能档时为 false（只淡入，不画液体）
//
// 外观在 music-fluid-kit.css：.mf-glass 是奶白（深色下烟灰）的厚玻璃，颜色从里面透出来，发光不投硬影，没有描边。
// 液体只在长出来的那 0.45 秒里画（一层临时 SVG，结束就拿掉），平时一帧都不画。
(function (global) {
    'use strict';
    const NS = 'http://www.w3.org/2000/svg';
    const DURATION = 460;
    const running = new WeakMap();

    const enabled = () => {
        const doc = global.document;
        if (!doc?.body) return false;
        if (doc.body.classList.contains('music-reduce-motion')) return false;
        if (doc.getElementById('music-dock-root')?.classList.contains('md-fl-low')) return false;
        return typeof global.requestAnimationFrame === 'function';
    };

    // 快速起、软着陆，末尾略微回弹一点点，像液体鼓满
    const ease = (t) => {
        const c = 1 - Math.pow(1 - t, 3);
        return c + Math.sin(Math.PI * t) * 0.06 * (1 - t);
    };
    const lerp = (a, b, t) => a + (b - a) * t;

    const pointOf = (origin) => {
        if (!origin) return null;
        if (typeof origin.getBoundingClientRect === 'function') origin = origin.getBoundingClientRect();
        if (typeof origin.width === 'number' && typeof origin.left === 'number') {
            return { x: origin.left + origin.width / 2, y: origin.top + origin.height / 2 };
        }
        if (typeof origin.x === 'number' && typeof origin.y === 'number') return { x: origin.x, y: origin.y };
        return null;
    };

    let seq = 0;
    const overlay = (doc, z) => {
        const id = `mfk${++seq}`;
        const svg = doc.createElementNS(NS, 'svg');
        svg.setAttribute('class', 'mf-goo');
        svg.setAttribute('aria-hidden', 'true');
        svg.style.zIndex = String(z);
        svg.innerHTML = `<defs><filter id="${id}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">`
            + '<feGaussianBlur in="SourceGraphic" stdDeviation="9" result="b"/>'
            + '<feColorMatrix in="b" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10" result="g"/>'
            + '<feGaussianBlur in="g" stdDeviation="1.2"/>'
            + `</filter></defs><g filter="url(#${id})"><circle/><rect/></g>`;
        doc.body.appendChild(svg);
        return { svg, drop: svg.querySelector('circle'), body: svg.querySelector('rect') };
    };

    // 弹出层 el 此时已经放好位置、可见（display 不为 none）。
    function bud(el, origin, { duration = DURATION } = {}) {
        if (!el || !el.isConnected) return Promise.resolve();
        cancel(el);
        const doc = el.ownerDocument;
        const from = pointOf(origin);
        if (!enabled() || !from) {
            el.classList.remove('mf-budding');
            return Promise.resolve();
        }
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return Promise.resolve();
        const cs = global.getComputedStyle(el);
        const radius = Math.min(rect.height / 2, parseFloat(cs.borderTopLeftRadius) || 16);
        const fill = cs.getPropertyValue('--mf-fill').trim() || cs.backgroundColor || 'rgba(128,128,128,.9)';
        // 液体要画在弹出层所在那一层上面：取它自己和外层里最大的 z-index
        let z = parseInt(cs.zIndex, 10) || 0;
        for (let node = el.parentElement; node && node !== doc.body; node = node.parentElement) {
            z = Math.max(z, parseInt(global.getComputedStyle(node).zIndex, 10) || 0);
        }
        z = z || 1000;
        const layer = overlay(doc, z);
        layer.drop.setAttribute('fill', fill);
        layer.body.setAttribute('fill', fill);
        el.classList.add('mf-budding');
        // 起点那一滴贴着触发点；整块从起点附近一个小圆角块长到目标大小
        const start = { x: from.x - 14, y: from.y - 14, w: 28, h: 28 };
        let frame = 0;
        let revealed = false;
        return new Promise((resolve) => {
            const clock = () => global.performance?.now?.() ?? Date.now();
            const t0 = clock();
            const done = () => {
                global.cancelAnimationFrame(frame);
                layer.svg.remove();
                el.classList.remove('mf-budding');
                running.delete(el);
                resolve();
            };
            running.set(el, done);
            const step = () => {
                const t = Math.min(1, (clock() - t0) / duration);
                // 横竖不同步：沿离起点远的方向先流过去，另一个方向稍晚才铺开，像倒出来的液体
                const e = ease(t);
                const lagX = Math.abs(rect.left + rect.width / 2 - from.x) < Math.abs(rect.top + rect.height / 2 - from.y);
                const eLag = ease(Math.max(0, (t - 0.1) / 0.9));
                const ex = lagX ? eLag : e, ey = lagX ? e : eLag;
                const x = lerp(start.x, rect.left, ex), y = lerp(start.y, rect.top, ey);
                const w = lerp(start.w, rect.width, ex), h = lerp(start.h, rect.height, ey);
                const b = layer.body;
                b.setAttribute('x', x.toFixed(1)); b.setAttribute('y', y.toFixed(1));
                b.setAttribute('width', Math.max(0, w).toFixed(1)); b.setAttribute('height', Math.max(0, h).toFixed(1));
                // 刚长出来时是圆滚滚的一团，鼓满时才收成面板的圆角
                const round = Math.min(w, h) / 2;
                b.setAttribute('rx', Math.min(lerp(round, radius, e * e), h / 2, w / 2).toFixed(1));
                // 起点那一滴先鼓一下再缩回去，和整块之间由滤镜自己拉出细颈
                const d = layer.drop;
                d.setAttribute('cx', from.x.toFixed(1)); d.setAttribute('cy', from.y.toFixed(1));
                d.setAttribute('r', Math.max(0, 15 * Math.sin(Math.PI * Math.min(1, t * 1.25))).toFixed(1));
                layer.svg.style.opacity = t < 0.72 ? '1' : String(Math.max(0, 1 - (t - 0.72) / 0.28));
                if (!revealed && t >= 0.55) { revealed = true; el.classList.remove('mf-budding'); }
                if (t >= 1) { done(); return; }
                frame = global.requestAnimationFrame(step);
            };
            step();
        });
    }

    // 关掉的时候反过来：整块缩回一滴，流回原来那一点再没掉。
    // 弹出层这时往往已经隐藏（量不到大小），所以传它打开时的样子：snap = MusicFluid.snapshot(el)。
    function snapshot(el) {
        if (!el || !el.isConnected) return null;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const cs = global.getComputedStyle(el);
        let z = parseInt(cs.zIndex, 10) || 0;
        for (let node = el.parentElement; node && node !== el.ownerDocument.body; node = node.parentElement) {
            z = Math.max(z, parseInt(global.getComputedStyle(node).zIndex, 10) || 0);
        }
        return {
            doc: el.ownerDocument,
            rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            radius: Math.min(rect.height / 2, parseFloat(cs.borderTopLeftRadius) || 16),
            fill: cs.getPropertyValue('--mf-fill').trim() || cs.backgroundColor || 'rgba(128,128,128,.9)',
            z: z || 1000
        };
    }
    function melt(snap, origin, { duration = 300 } = {}) {
        const to = pointOf(origin);
        if (!snap || !to || !enabled()) return Promise.resolve();
        const { rect, radius, fill } = snap;
        const layer = overlay(snap.doc, snap.z);
        layer.drop.setAttribute('fill', fill);
        layer.body.setAttribute('fill', fill);
        const end = { x: to.x - 12, y: to.y - 12, w: 24, h: 24 };
        const lagX = Math.abs(rect.left + rect.width / 2 - to.x) < Math.abs(rect.top + rect.height / 2 - to.y);
        const easeIn = (t) => t * t;
        return new Promise((resolve) => {
            const clock = () => global.performance?.now?.() ?? Date.now();
            const t0 = clock();
            let frame = 0;
            const step = () => {
                const t = Math.min(1, (clock() - t0) / duration);
                // 远的那个方向先收，近的那个方向晚一点才跟上，像被吸回去
                const e = easeIn(t);
                const eLag = easeIn(Math.max(0, (t - 0.12) / 0.88));
                const ex = lagX ? eLag : e, ey = lagX ? e : eLag;
                const x = lerp(rect.left, end.x, ex), y = lerp(rect.top, end.y, ey);
                const w = lerp(rect.width, end.w, ex), h = lerp(rect.height, end.h, ey);
                const b = layer.body;
                b.setAttribute('x', x.toFixed(1)); b.setAttribute('y', y.toFixed(1));
                b.setAttribute('width', Math.max(0, w).toFixed(1)); b.setAttribute('height', Math.max(0, h).toFixed(1));
                b.setAttribute('rx', Math.min(lerp(radius, Math.min(w, h) / 2, e), h / 2, w / 2).toFixed(1));
                const d = layer.drop;
                d.setAttribute('cx', to.x.toFixed(1)); d.setAttribute('cy', to.y.toFixed(1));
                d.setAttribute('r', Math.max(0, 13 * Math.sin(Math.PI * Math.max(0, (t - 0.35) / 0.65))).toFixed(1));
                layer.svg.style.opacity = t < 0.6 ? '1' : String(Math.max(0, 1 - (t - 0.6) / 0.4));
                if (t >= 1) { global.cancelAnimationFrame(frame); layer.svg.remove(); resolve(); return; }
                frame = global.requestAnimationFrame(step);
            };
            step();
        });
    }

    // 选中标记（分段开关里那块、页签下那条）换位置时像一滴液体流过去：
    // 前沿先到，后沿慢半拍才跟上，中途被拉长，到了再收成原来的宽度。
    // 位置是相对父元素的 left/width（像素）。第一次放、降低动态时直接落位。
    // 标记所在的那一排每次都会重画（新的元素）时，传同一个 key，就能接着上一次的位置流过去。
    const slides = new Map();
    // axis: 'x'（默认，用 left/width）或 'y'（用 top/height，比如歌词里当前那一行背后的那滴）
    function slide(el, to, { lead = 220, trail = 380, key = null, axis = 'x' } = {}) {
        if (!el || !to) return;
        const [P, S] = axis === 'y' ? ['top', 'height'] : ['left', 'width'];
        const goal = { pos: Number(to[P]), size: Number(to[S]) };
        if (!Number.isFinite(goal.pos) || !Number.isFinite(goal.size)) return;
        const id = key || el;
        const prev = slides.get(id);
        if (prev?.frame) global.cancelAnimationFrame(prev.frame);
        const place = (pos, size) => { el.style[P] = `${pos.toFixed(1)}px`; el.style[S] = `${Math.max(0, size).toFixed(1)}px`; };
        const from = prev?.at;
        const motion = Boolean(global.document?.body) && !global.document.body.classList.contains('music-reduce-motion') && typeof global.requestAnimationFrame === 'function';
        if (!from || !motion || (Math.abs(from.pos - goal.pos) < 0.5 && Math.abs(from.size - goal.size) < 0.5)) {
            place(goal.pos, goal.size);
            slides.set(id, { at: { ...goal }, frame: 0 });
            return;
        }
        el.style.transition = 'none';
        const forward = goal.pos > from.pos;
        const s0 = from.pos, e0 = from.pos + from.size;
        const s1 = goal.pos, e1 = goal.pos + goal.size;
        const clock = () => global.performance?.now?.() ?? Date.now();
        const t0 = clock();
        const out = (t) => 1 - Math.pow(1 - t, 3);
        const state = { at: { pos: s0, size: from.size }, frame: 0 };
        slides.set(id, state);
        const step = () => {
            const ms = clock() - t0;
            const a = out(Math.min(1, ms / lead));
            const b = out(Math.min(1, ms / trail));
            // 往前（右、下）走：后面那条边是前沿；往回走：前面那条边是前沿
            const start = lerp(s0, s1, forward ? b : a);
            const end = lerp(e0, e1, forward ? a : b);
            state.at = { pos: start, size: end - start };
            place(start, end - start);
            if (ms >= trail) { state.frame = 0; state.at = { ...goal }; place(goal.pos, goal.size); return; }
            state.frame = global.requestAnimationFrame(step);
        };
        step();
    }

    function cancel(el) {
        const stop = running.get(el);
        if (stop) stop();
    }

    // ───────── 弹窗：从最后一次按下的地方长出来 ─────────
    // 各处弹窗（歌词获取、WebDAV、歌单对话框……）打开时都是给遮罩层加 visible / active 类。
    // 这里统一看着这些遮罩层，打开时把里面的面板从最后一次按下指针的那一点长出来，各处代码不用改。
    let lastPress = null;
    const OVERLAYS = '.music-modal-overlay, .dialog-overlay';
    const PANEL = '.music-modal, .dialog';
    const watchDialogs = () => {
        const doc = global.document;
        if (!doc?.body || typeof global.MutationObserver !== 'function') return;
        doc.addEventListener('pointerdown', (event) => { lastPress = { x: event.clientX, y: event.clientY, at: Date.now() }; }, true);
        const isOpen = (node) => node.classList.contains('visible') || node.classList.contains('active');
        const seen = new WeakMap();
        const opened = new WeakMap();
        const check = (node) => {
            const open = isOpen(node);
            if (open && !seen.get(node)) {
                const panel = node.querySelector(PANEL);
                // 键盘打开（没有最近的按下）就从窗口底部中间、播放条的位置长出来
                const fresh = lastPress && Date.now() - lastPress.at < 1500;
                const from = fresh ? lastPress : { x: global.innerWidth / 2, y: global.innerHeight - 60 };
                if (panel) {
                    global.requestAnimationFrame?.(() => bud(panel, from, { duration: 520 }).then(() => {
                        // 记下打开后的样子和从哪里长出来，关的时候按原路流回去
                        if (node.isConnected && isOpen(node)) opened.set(node, { snap: snapshot(panel), from });
                    }));
                }
            } else if (!open && seen.get(node)) {
                const was = opened.get(node);
                opened.delete(node);
                // 关的时候流回最后一次按下的地方（点了「取消」就流回那颗按钮），没有就流回打开时那一点
                const fresh = lastPress && Date.now() - lastPress.at < 1500 ? lastPress : null;
                if (was?.snap) melt(was.snap, fresh || was.from, { duration: 320 });
            }
            seen.set(node, open);
        };
        const observer = new global.MutationObserver((records) => {
            for (const r of records) if (r.target.matches?.(OVERLAYS)) check(r.target);
        });
        for (const node of doc.querySelectorAll(OVERLAYS)) {
            seen.set(node, isOpen(node));
            observer.observe(node, { attributes: true, attributeFilter: ['class'] });
        }
    };
    // ───────── 菜单：合上时缩回一滴，流回刚点的那一项 ─────────
    // 菜单打开时由各处自己调 bud；这里只看着它什么时候合上。打开后等长完再记下样子（关得太快就不画）。
    // isOpen(node) 判断开着没有；右键菜单是 visible 类，档案排序菜单是 hidden 属性。
    const watched = new WeakSet();
    function watchPop(node, isOpen = (n) => !n.hidden) {
        if (!node || watched.has(node) || typeof global.MutationObserver !== 'function') return;
        watched.add(node);
        let open = isOpen(node);
        let snap = null;
        let timer = 0;
        const remember = () => { timer = 0; if (isOpen(node)) snap = snapshot(node); };
        if (open) timer = global.setTimeout(remember, DURATION + 40);
        new global.MutationObserver(() => {
            const now = isOpen(node);
            if (now === open) {
                // 开着的时候换了位置（又在别处右键）：等新位置长完再重新记
                if (now) { snap = null; global.clearTimeout(timer); timer = global.setTimeout(remember, DURATION + 40); }
                return;
            }
            open = now;
            if (now) {
                snap = null;
                global.clearTimeout(timer);
                timer = global.setTimeout(remember, DURATION + 40);
                return;
            }
            global.clearTimeout(timer);
            timer = 0;
            const fresh = lastPress && Date.now() - lastPress.at < 1500 ? lastPress : null;
            if (snap && fresh) melt(snap, fresh, { duration: 260 });
            snap = null;
        }).observe(node, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
    }
    const watchMenus = () => {
        for (const node of global.document.querySelectorAll('.context-menu')) {
            watchPop(node, (n) => n.classList.contains('visible') && n.style.display !== 'none');
        }
    };

    // 顶部的「音频引擎没有启动」提示：出现时从窗口顶边正中滴下来再鼓满
    const watchNotices = () => {
        const doc = global.document;
        const node = doc.getElementById('audio-engine-notice');
        if (!node || typeof global.MutationObserver !== 'function') return;
        let shown = !node.hidden;
        new global.MutationObserver(() => {
            const now = !node.hidden;
            if (now === shown) return;
            shown = now;
            if (!now) { cancel(node); return; }
            const r = node.getBoundingClientRect();
            bud(node, { x: r.left + r.width / 2, y: 0 }, { duration: 520 });
        }).observe(node, { attributes: true, attributeFilter: ['hidden'] });
    };

    // ───────── 一排文字按钮：手指底下的那一汪跟着流过去 ─────────
    // 那一汪加在这一排的最后（队列的行是由第一个子元素整体重画的，不能插在前面）。
    // 平时什么都没有；指针进到这一排时，手底下那个按钮背后凝出一汪浅玻璃，在按钮之间移动时像液体一样流过去，
    // 指针离开这一排就淡掉。只加一个装饰元素，不改按钮本身的样子。
    const TRAILS = [
        { row: '.archive-nav', item: '.archive-nav > button', key: 'archive-nav', pad: 14 },
        { row: '.music-stage-mode-switcher', item: '.music-stage-mode-switcher > .music-stage-mode-button', key: 'stage-tabs', pad: 0 },
        { row: '.archive-empty', item: '.archive-empty > button', key: 'archive-empty', axis: 'xy', pad: 12 },
        { row: '#music-dock-root .md-ql', item: '#music-dock-root .md-qi', key: 'md-queue', axis: 'y', pad: 0 },
        { row: '#modal-song-list', item: '#modal-song-list > .music-modal-song-item', key: 'pl-songs', axis: 'xy', pad: 0 },
        { row: '.webdav-file-list', item: '.webdav-file-list > .webdav-file-item', key: 'dav-files', axis: 'xy', pad: 0 },
        { row: '.webdav-server-list', item: '.webdav-server-list > .webdav-server-item', key: 'dav-servers', axis: 'xy', pad: 0 },
        { row: '.archive-lyrics-track', item: '.archive-lyrics-track > p', key: 'ar-lyrics', axis: 'xy', pad: 0 },
        { row: '#music-dock-root .md-quick-g', item: '#music-dock-root .md-quick-g > .md-slot', key: 'md-quick', pad: 0 },
        { row: '#music-dock-root .md-slots', item: '#music-dock-root .md-slots > .md-slot', key: 'md-slots', pad: 0 },
        // 子菜单嵌在「加入歌单」那一项里面，要排在主菜单前面先认
        { row: '.context-submenu', item: '.context-submenu .submenu-item', key: 'ctx-sub', axis: 'y', pad: 0 },
        { row: '.context-menu', item: '.context-menu > .context-menu-item', key: 'ctx-menu', axis: 'y', pad: 0 },
        { row: '.archive-batch-menu', item: '.archive-batch-menu > button', key: 'ar-batch', axis: 'y', pad: 0 },
        { row: '.archive-list-sort-menu', item: '.archive-list-sort-menu > button', key: 'ar-sort', axis: 'y', pad: 0 },
    ];
    const ALL_TRAIL_ROWS = TRAILS.map((t) => t.row).join(', ');
    const watchTrails = () => {
        const doc = global.document;
        const dropOf = (row) => {
            let drop = row.querySelector(':scope > .mf-trail');
            if (!drop) {
                drop = doc.createElement('i');
                drop.className = 'mf-trail';
                drop.setAttribute('aria-hidden', 'true');
                row.append(drop);
            }
            return drop;
        };
        // 按钮在这一排里的位置；排可能被整体缩放（档案页会按窗口大小缩放），所以按排自己的尺寸换算回去
        const placeIn = (row, btn, t) => {
            const rr = row.getBoundingClientRect(), br = btn.getBoundingClientRect();
            const ky = rr.height ? row.offsetHeight / rr.height : 1;
            const kx = rr.width ? row.offsetWidth / rr.width : 1;
            return {
                top: (br.top - rr.top) * ky + row.scrollTop - t.pad, height: br.height * ky + t.pad * 2,
                left: (br.left - rr.left) * kx + row.scrollLeft - t.pad, width: br.width * kx + t.pad * 2,
            };
        };
        const follow = (target) => {
            if (!target.closest(ALL_TRAIL_ROWS)) return;
            for (const t of TRAILS) {
                const btn = target.closest(t.item);
                const row = btn?.closest(t.row);
                if (!row || btn.disabled) continue;
                const drop = dropOf(row);
                const fresh = !drop.classList.contains('mf-on');
                if (fresh) slides.delete(t.key);
                const to = placeIn(row, btn, t);
                // 两列的列表（axis: 'xy'）横竖各流各的，斜着过去时像一滴被拉长再收拢
                if (fresh) { slides.delete(`${t.key}:x`); slides.delete(`${t.key}:y`); }
                if (t.axis === 'xy') {
                    slide(drop, to, { key: `${t.key}:x`, axis: 'x', lead: 160, trail: 320 });
                    slide(drop, to, { key: `${t.key}:y`, axis: 'y', lead: 160, trail: 320 });
                } else {
                    slide(drop, to, { key: t.key, axis: t.axis || 'x', lead: 160, trail: 320 });
                }
                drop.classList.add('mf-on');
                return;
            }
        };
        doc.addEventListener('pointerover', (event) => {
            if (event.target instanceof global.Element) follow(event.target);
        }, true);
        // 用键盘（Tab、方向键）在一排里移动时，那一汪也跟着焦点流过去；鼠标点出来的焦点不算
        doc.addEventListener('focusin', (event) => {
            const target = event.target;
            if (!(target instanceof global.Element)) return;
            let visible = false;
            try { visible = target.matches(':focus-visible'); } catch (_) { /* 老内核 */ }
            if (visible) follow(target);
        }, true);
        doc.addEventListener('focusout', (event) => {
            const target = event.target;
            if (!(target instanceof global.Element) || !target.closest(ALL_TRAIL_ROWS)) return;
            for (const t of TRAILS) {
                const row = target.closest(t.row);
                if (!row) continue;
                const next = event.relatedTarget;
                if (next instanceof global.Node && row.contains(next)) return;
                if (row.matches(':hover')) return;
                row.querySelector(':scope > .mf-trail')?.classList.remove('mf-on');
                return;
            }
        }, true);
        // 菜单每次重新打开（右键、点排序按钮……）：上次留下的那一汪先收掉，免得一打开就停在旧的位置
        const MENUS = ':is(.context-menu, .context-submenu, .archive-batch-menu, .archive-list-sort-menu) > .mf-trail.mf-on';
        const clearMenus = (keep) => {
            for (const drop of doc.querySelectorAll(MENUS)) if (!keep || !drop.parentElement.contains(keep)) drop.classList.remove('mf-on');
        };
        doc.addEventListener('contextmenu', () => clearMenus(null), true);
        doc.addEventListener('pointerdown', (event) => clearMenus(event.target instanceof global.Node ? event.target : null), true);
        // 在按钮之间的空隙里不算离开；指针出了整排才淡掉
        doc.addEventListener('pointerout', (event) => {
            const target = event.target;
            if (!(target instanceof global.Element) || !target.closest(ALL_TRAIL_ROWS)) return;
            for (const t of TRAILS) {
                const row = target.closest(t.row);
                if (!row) continue;
                const next = event.relatedTarget;
                const keep = t.solo ? target.closest(t.item) : row;
                if (keep && next instanceof global.Node && keep.contains(next)) return;
                row.querySelector(':scope > .mf-trail')?.classList.remove('mf-on');
                return;
            }
        }, true);
    };

    // ───────── 提示条叠在一起时：来一条、走一条，其余的像液体一样被推开、再落回去 ─────────
    // 提示条一层一层叠在底栏上方（music-toast.js）；新的一条加进来或旧的一条散掉时，其余几条原本会一下跳到新位置。
    // 这里记下每条的位置，变动后用独立的 translate 从旧位置弹回新位置，不碰提示条自己的 transform 动画。
    const watchToasts = () => {
        const doc = global.document;
        if (typeof global.MutationObserver !== 'function') return;
        const tops = new WeakMap();
        // 量屏幕上的位置：提示层是贴着底边往上长的，条在层里的 offsetTop 不变，层自己在动
        const record = (layer) => { for (const el of layer.children) tops.set(el, el.getBoundingClientRect().top); };
        const attach = (layer) => {
            if (watched.has(layer)) return;
            watched.add(layer);
            record(layer);
            new global.MutationObserver(() => {
                const motion = enabled() && typeof global.Element?.prototype?.animate === 'function';
                for (const el of layer.children) {
                    const before = tops.get(el);
                    const now = el.getBoundingClientRect().top;
                    if (motion && before != null && Math.abs(before - now) > 1) {
                        el.animate([{ translate: `0 ${before - now}px` }, { translate: '0 0' }], { duration: 460, easing: 'cubic-bezier(.34, 1.36, .5, 1)', composite: 'add' });
                    }
                    tops.set(el, now);
                }
            }).observe(layer, { childList: true });
        };
        const scan = () => { for (const layer of doc.querySelectorAll('body > .mtst-layer')) attach(layer); };
        scan();
        new global.MutationObserver(scan).observe(doc.body, { childList: true });
    };

    /* 首页目录开合（.archive-hud.list-open）：布局由档案页一次切到终态，这里用 FLIP 把这一下变成连续的移动——
     * 按下的那一刻先记住各块的位置和大小，类名换完以后量一次新位置，再用 transform 从旧位置补间回来。
     * 每帧只动 transform 和 opacity，不碰排版；整个过程只排版两次（按下前、换完后）。
     * 新出现的块（目录本身）从左边淡入滑进来；消失的块不做（已经 display:none）。 */
    // s：要跟的块；font：字号会变的（按新旧字号比 scale，不按宽度）；in：嵌在哪个也在动的块里（减掉外层的位移，免得算两遍）
    const HUD_FLIP = [
        { s: '.archive-counter', in: '.archive-bottom' },
        { s: '.archive-nav' },
        { s: '.archive-bottom' },
        { s: '.archive-list' },
        { s: '.archive-list-foot', in: '.archive-list' },
        { s: '.archive-footer', in: '.archive-bottom' }
    ];
    const watchHud = () => {
        const doc = global.document;
        if (typeof global.MutationObserver !== 'function') return;
        let tries = 0;
        const attach = () => {
            const hud = doc.querySelector('#music-archive-view .archive-hud');
            if (!hud) { if (++tries < 60) global.setTimeout(attach, 500); return; }
            // 目录开合、设置抽屉让位（首页整层变窄、可能换档）都会让这些块跳到新位置：
            // 记一个「排版档位」的指纹，变了才补过渡；窗口拖边改大小没有按键，不会触发。
            const layoutKey = () => ['list-open', 'narrow', 'mid', 'squeeze', 'tiny', 'beside-drawer']
                .map((c) => (hud.classList.contains(c) ? c : '')).join('|') + '|' + hud.style.width;
            let open = layoutKey();
            let before = null;
            const measure = () => {
                const out = new Map();
                for (const t of HUD_FLIP) {
                    const el = hud.querySelector(t.s);
                    if (!el) continue;
                    const r = el.getBoundingClientRect();
                    out.set(t.s, r.width || r.height
                        ? { el, x: r.left, y: r.top, w: r.width, h: r.height, fs: t.font ? parseFloat(global.getComputedStyle(el).fontSize) || 0 : 0 }
                        : null);
                }
                return out;
            };
            // 只在可能触发布局切换的交互前才量一次旧位置，避免普通点击、拖动、方向键选歌和打字时每次都强制全页同步重排
            const LAYOUT_TRIGGERS = '[data-act="list"], [data-act="controls"], [data-act="lyrics"], [data-act="search"], [data-md="panel"], [data-md="close"], .md-hdl, .md-slot';
            const remember = () => { if (enabled()) before = { at: Date.now(), map: measure() }; };
            const onPointerDown = (event) => {
                const target = event.target;
                if (!(target instanceof global.Element)) return;
                if (doc.body.classList.contains('music-drawer-open') || target.closest(LAYOUT_TRIGGERS)) remember();
            };
            const onKeyDown = (event) => {
                const k = event.key;
                if (k === 'Escape' || k === '/' || (!hud.classList.contains('list-open') && k && k.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)) {
                    remember();
                }
            };
            // 挂在 window 的捕获阶段：底栏在 document 上处理 Esc 时会同步收抽屉，首页随即重排，挂 document 上就晚了一步
            global.addEventListener('pointerdown', onPointerDown, true);
            global.addEventListener('keydown', onKeyDown, true);
            new global.MutationObserver(() => {
                const now = layoutKey();
                if (now === open) return;
                open = now;
                const first = before && Date.now() - before.at < 1500 ? before.map : null;
                before = null;
                if (!first || !enabled()) return;
                const last = measure();
                const ease = 'cubic-bezier(.32, .72, 0, 1)';
                const delta = new Map();
                for (const t of HUD_FLIP) {
                    const to = last.get(t.s), from = first.get(t.s);
                    if (to && from) delta.set(t.s, { dx: from.x - to.x, dy: from.y - to.y });
                }
                for (const t of HUD_FLIP) {
                    const to = last.get(t.s);
                    if (!to) continue;
                    const from = first.get(t.s);
                    if (!from) {
                        // 新出现的：从左边一点点淡入（嵌在别的块里的不单独动，跟着外层）
                        if (!t.in || !last.get(t.in) || first.get(t.in)) {
                            to.el.animate([{ opacity: 0, transform: 'translateX(-18px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: ease, composite: 'add' });
                        }
                        continue;
                    }
                    const outer = t.in ? delta.get(t.in) : null;
                    const dx = from.x - to.x - (outer?.dx || 0), dy = from.y - to.y - (outer?.dy || 0);
                    const k = t.font && from.fs && to.fs ? from.fs / to.fs : 1;
                    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(k - 1) < 0.02) continue;
                    to.el.animate([
                        { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${k})` },
                        { transformOrigin: '0 0', transform: 'none' }
                    ], { duration: 520, easing: ease, composite: 'add' }); // 叠在块自己的 transform 上（底部一排有让底栏的上移），结束时不跳
                }
            }).observe(hud, { attributes: true, attributeFilter: ['class', 'style'] });
        };
        attach();
    };

    const start = () => { watchDialogs(); watchMenus(); watchNotices(); watchTrails(); watchToasts(); watchHud(); };
    if (global.document?.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();

    // 最近 1.5 秒内按下指针的那一点；键盘打开的东西拿不到时返回 null，由调用方决定从哪里长
    const recentPress = () => (lastPress && Date.now() - lastPress.at < 1500 ? { x: lastPress.x, y: lastPress.y } : null);

    global.MusicFluid = Object.freeze({ bud, melt, snapshot, watchPop, slide, cancel, enabled, recentPress });
})(typeof window !== 'undefined' ? window : globalThis);
