// Musicmodules/music-dock/music-toast.js
// 音乐窗口共用的提示层：浮在底栏胶囊上方，档案页、经典视图、舞台里都看得见。
//
// 别的模块这样用：
//   const t = MusicToast.show({ message: '已加入队列', action: { label: '撤销', run() {} } });
//   MusicToast.show({ id: 'scan', kind: 'progress', message: '正在扫描 3 / 40', progress: 0.07 });
//   MusicToast.show({ kind: 'error', message: '加载失败', action: { label: '跳过', run: next, countdown: 5 } });
//   t.update({ message }) / t.close() / MusicToast.dismiss('scan')
//
// 规则：
// - 同一个 id 再 show 就是更新那一条，不会叠出第二条；最多同时显示 3 条，多出来的先挤掉最旧的。
// - delay：操作在这个时间内结束（先 close 了）就根本不出现，用来避免一闪而过的「加载中」。
// - 指针悬停时暂停计时（包括「跳过」的倒计时），离开后接着走。
// - action.countdown：按钮上显示秒数，数到 0 自动执行一次。
(function (global) {
    'use strict';

    const MAX_VISIBLE = 3;
    const DEFAULT_MS = { info: 4000, success: 3000, error: 7000, progress: 0 };
    const ICON_FOR = { info: 'info', success: 'check', error: 'circle-alert', progress: 'loader-circle' };
    const ICONS = global.MusicDockIcons || {};

    const iconProtoCache = new Map();
    const createIconNode = (name, size = 16) => {
        const k = `${name}:${size}`;
        let proto = iconProtoCache.get(k);
        if (proto === undefined) {
            const box = document.createElement('span');
            box.innerHTML = `<svg class="mtst-i" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"`
                + ` stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
            proto = box.firstElementChild;
            iconProtoCache.set(k, proto);
        }
        return proto ? proto.cloneNode(true) : null;
    };

    let layer = null;
    let posX = null;
    let posMax = null;
    const toasts = new Map(); // key -> entry
    const closing = new Set(); // { el, timer }
    let seq = 0;

    const applyLayerPosition = (node) => {
        if (!node) return;
        if (posX !== null) node.style.setProperty('--md-toast-x', `${posX}px`);
        if (posMax !== null) node.style.setProperty('--md-toast-max', `${posMax}px`);
    };

    const setPosition = (x, maxW) => {
        const nx = Number.isFinite(x) ? Math.round(x) : null;
        const nw = Number.isFinite(maxW) ? Math.round(maxW) : null;
        if (nx === posX && nw === posMax) return;
        posX = nx;
        posMax = nw;
        if (layer && layer.isConnected) applyLayerPosition(layer);
    };

    const ensureLayer = () => {
        if (layer && layer.isConnected) return layer;
        layer = document.createElement('div');
        layer.className = 'mtst-layer';
        layer.setAttribute('role', 'region');
        layer.setAttribute('aria-label', '提示');
        applyLayerPosition(layer);
        document.body.appendChild(layer);
        return layer;
    };

    const normalize = (opts) => (typeof opts === 'string' ? { message: opts } : { ...(opts || {}) });

    function show(input) {
        const opts = normalize(input);
        const key = opts.id != null ? String(opts.id) : `t${++seq}`;
        const existing = toasts.get(key);
        if (existing && !existing.closed) { existing.update(opts); return existing.handle; }

        const entry = {
            key,
            opts: { kind: 'info', ...opts },
            el: null,
            closed: false,
            shown: false,
            remaining: 0,
            startedAt: 0,
            timer: null,
            delayTimer: null,
            inRaf: 0,
            evapRaf: 0,
            countdown: null,
            tick: null,
            hovered: false
        };

        const kind = () => (DEFAULT_MS[entry.opts.kind] !== undefined ? entry.opts.kind : 'info');
        const lifetime = () => {
            if (entry.opts.action?.countdown) return 0; // 倒计时自己负责收尾
            if (entry.opts.duration !== undefined) return Math.max(0, Number(entry.opts.duration) || 0);
            return DEFAULT_MS[kind()];
        };

        const render = () => {
            const el = entry.el;
            const k = kind();
            const evap = el.classList.contains('mtst-evap');
            const nextClass = `mtst mtst-${k}${entry.shown ? ' mtst-in' : ''}${evap ? ' mtst-evap' : ''}`;
            if (el.className !== nextClass) el.className = nextClass;
            const nextRole = k === 'error' ? 'alert' : 'status';
            if (el.getAttribute('role') !== nextRole) el.setAttribute('role', nextRole);
            const action = entry.opts.action;
            if (action?.countdown && entry.countdown == null) entry.countdown = Math.max(1, Math.round(action.countdown));
            const count = action?.countdown && entry.countdown != null ? ` ${entry.countdown}` : '';
            const clampedProgress = k === 'progress' && Number.isFinite(entry.opts.progress)
                ? Math.max(0, Math.min(1, entry.opts.progress)) : null;
            const msgText = entry.opts.message || '';
            const icSpan = document.createElement('span');
            icSpan.className = 'mtst-ic';
            const icSvg = createIconNode(entry.opts.icon || ICON_FOR[k], 16);
            if (icSvg) icSpan.appendChild(icSvg);
            const msgEl = document.createElement('span');
            msgEl.className = 'mtst-msg';
            msgEl.textContent = msgText;
            const kids = [icSpan, msgEl];
            let actEl = null;
            if (action) {
                actEl = document.createElement('button');
                actEl.className = 'mtst-act';
                actEl.type = 'button';
                actEl.textContent = `${action.label || '好'}${count}`;
                kids.push(actEl);
            }
            if (entry.opts.closable !== false) {
                const closeBtn = document.createElement('button');
                closeBtn.className = 'mtst-x';
                closeBtn.type = 'button';
                closeBtn.setAttribute('aria-label', '关闭提示');
                const xSvg = createIconNode('x', 14);
                if (xSvg) closeBtn.appendChild(xSvg);
                kids.push(closeBtn);
            }
            let barEl = null;
            if (clampedProgress !== null) {
                const barWrap = document.createElement('span');
                barWrap.className = 'mtst-bar';
                barEl = document.createElement('span');
                barEl.style.transform = `scaleX(${clampedProgress})`;
                barWrap.appendChild(barEl);
                kids.push(barWrap);
            }
            el.replaceChildren(...kids);
            entry.msgEl = msgEl;
            entry.actEl = actEl;
            entry.barEl = barEl;
            entry.lastProgress = clampedProgress;
            entry.lastMessage = msgText;
        };

        const clearTimers = () => {
            clearTimeout(entry.timer); entry.timer = null;
            clearInterval(entry.tick); entry.tick = null;
        };

        const runAction = () => {
            const action = entry.opts.action;
            close();
            try { action?.run?.(); } catch (error) { console.warn('[MusicToast] action failed:', error); }
        };

        const arm = () => {
            clearTimers();
            if (entry.closed || !entry.shown || entry.hovered) return;
            if (entry.opts.action?.countdown) {
                entry.tick = setInterval(() => {
                    entry.countdown -= 1;
                    if (entry.countdown <= 0) { runAction(); return; }
                    if (entry.actEl) entry.actEl.textContent = `${entry.opts.action.label || '好'} ${entry.countdown}`;
                }, 1000);
                return;
            }
            if (!entry.remaining) entry.remaining = lifetime();
            if (!entry.remaining) return; // 0 = 一直留着，直到 close
            entry.startedAt = Date.now();
            entry.timer = setTimeout(close, entry.remaining);
            // 停留时间就是从实心慢慢蒸发成雾的过程（样式在 music-dock-drawer.css 的 .mtst-evap）。
            // 重播已有蒸发动画时跨帧再加类，避免同步读 offsetWidth 触发强制回流。
            const hadEvap = entry.el.classList.contains('mtst-evap');
            if (entry.evapRaf && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(entry.evapRaf); entry.evapRaf = 0; }
            entry.el.style.setProperty('--mtst-ms', `${entry.remaining}ms`);
            if (hadEvap) {
                entry.el.classList.remove('mtst-evap');
                if (typeof requestAnimationFrame === 'function') {
                    entry.evapRaf = requestAnimationFrame(() => {
                        entry.evapRaf = 0;
                        if (!entry.closed && entry.shown && !entry.hovered) entry.el?.classList.add('mtst-evap');
                    });
                } else {
                    entry.el.classList.add('mtst-evap');
                }
            } else {
                entry.el.classList.add('mtst-evap');
            }
        };

        const pause = () => {
            if (entry.timer) entry.remaining = Math.max(400, entry.remaining - (Date.now() - entry.startedAt));
            clearTimers();
            if (entry.evapRaf && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(entry.evapRaf); entry.evapRaf = 0; }
            // 悬停时重新凝固，离开后用剩下的时间再蒸发一次。
            entry.el?.classList.remove('mtst-evap');
        };

        const mount = () => {
            if (entry.closed || entry.shown) return;
            const host = ensureLayer();
            let liveCount = 0;
            for (const t of toasts.values()) { if (t.shown && !t.closed) liveCount += 1; }
            if (liveCount >= MAX_VISIBLE) {
                for (const t of toasts.values()) {
                    if (!t.shown || t.closed) continue;
                    t.close();
                    liveCount -= 1;
                    if (liveCount < MAX_VISIBLE) break;
                }
            }
            entry.el = document.createElement('div');
            entry.el.dataset.key = key;
            render();
            host.appendChild(entry.el);
            entry.shown = true;
            if (typeof requestAnimationFrame === 'function') {
                entry.inRaf = requestAnimationFrame(() => {
                    entry.inRaf = 0;
                    if (!entry.closed) entry.el?.classList.add('mtst-in');
                });
            } else {
                entry.el.classList.add('mtst-in');
            }
            entry.el.addEventListener('pointerenter', () => { entry.hovered = true; pause(); });
            entry.el.addEventListener('pointerleave', () => { entry.hovered = false; arm(); });
            entry.el.addEventListener('click', (event) => {
                if (event.target?.closest?.('.mtst-x')) close();
                else if (event.target?.closest?.('.mtst-act')) runAction();
            });
            arm();
        };

        function close(immediate = false) {
            if (entry.closed) return;
            entry.closed = true;
            clearTimers();
            clearTimeout(entry.delayTimer);
            entry.delayTimer = null;
            if (entry.inRaf && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(entry.inRaf); entry.inRaf = 0; }
            if (entry.evapRaf && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(entry.evapRaf); entry.evapRaf = 0; }
            if (toasts.get(key) === entry) toasts.delete(key);
            const el = entry.el;
            if (!el) return;
            if (immediate === true) {
                el.remove();
                return;
            }
            el.classList.remove('mtst-in');
            el.classList.add('mtst-out');
            const pending = { el, timer: null };
            pending.timer = setTimeout(() => {
                closing.delete(pending);
                el.remove();
            }, 320);
            closing.add(pending);
        }

        entry.update = (next) => {
            const patch = normalize(next);
            const prevKind = kind();
            const prevHadProgress = prevKind === 'progress' && Number.isFinite(entry.opts.progress);
            const nextKind = 'kind' in patch ? (DEFAULT_MS[patch.kind] !== undefined ? patch.kind : 'info') : prevKind;
            const nextIcon = 'icon' in patch ? patch.icon : entry.opts.icon;
            const nextClosable = 'closable' in patch ? patch.closable : entry.opts.closable;
            const structureChanged = nextKind !== prevKind || nextIcon !== entry.opts.icon || 'action' in patch || nextClosable !== entry.opts.closable;
            const timingChanged = 'duration' in patch || nextKind !== prevKind || 'action' in patch || (nextKind !== 'progress' && 'message' in patch);
            entry.opts = { ...entry.opts, ...patch };
            if (timingChanged) { entry.remaining = 0; entry.countdown = null; }
            if (!entry.shown) return;
            const nextHasProgress = kind() === 'progress' && Number.isFinite(entry.opts.progress);
            if (!structureChanged && prevHadProgress === nextHasProgress && entry.el) {
                if ('message' in patch && entry.msgEl) {
                    const nextText = entry.opts.message || '';
                    if (entry.lastMessage !== nextText) {
                        entry.lastMessage = nextText;
                        entry.msgEl.textContent = nextText;
                    }
                }
                if (nextHasProgress && 'progress' in patch && entry.barEl) {
                    const nextProgress = Math.max(0, Math.min(1, entry.opts.progress));
                    if (entry.lastProgress === null || Math.abs(nextProgress - entry.lastProgress) >= 1e-4) {
                        entry.lastProgress = nextProgress;
                        entry.barEl.style.transform = `scaleX(${nextProgress})`;
                    }
                }
                if (!entry.el.classList.contains('mtst-in')) entry.el.classList.add('mtst-in');
                if (timingChanged) arm();
                return;
            }
            render();
            entry.el.classList.add('mtst-in');
            if (timingChanged) arm();
        };
        entry.close = close;
        entry.handle = {
            id: key,
            update: (next) => { if (!entry.closed) entry.update(next); },
            close,
            get closed() { return entry.closed; }
        };

        toasts.set(key, entry);
        const delay = Math.max(0, Number(entry.opts.delay) || 0);
        if (delay) entry.delayTimer = setTimeout(mount, delay);
        else mount();
        return entry.handle;
    }

    const dismiss = (id) => toasts.get(String(id))?.close();
    const clear = () => {
        if (toasts.size) {
            const list = [...toasts.values()];
            for (let i = 0; i < list.length; i += 1) list[i].close(true);
        }
        if (closing.size) {
            for (const pending of closing) {
                clearTimeout(pending.timer);
                pending.el.remove();
            }
            closing.clear();
        }
    };
    global.addEventListener?.('beforeunload', () => {
        clear();
        iconProtoCache.clear();
    }, { once: true });

    global.MusicToast = Object.freeze({ show, dismiss, clear, setPosition });
})(window);
