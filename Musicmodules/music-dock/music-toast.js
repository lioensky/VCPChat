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

    const icon = (name, size = 16) => (
        `<svg class="mtst-i" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"`
        + ` stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`
    );

    let layer = null;
    const toasts = new Map(); // key -> entry
    let seq = 0;

    const ensureLayer = () => {
        if (layer && layer.isConnected) return layer;
        layer = document.createElement('div');
        layer.className = 'mtst-layer';
        layer.setAttribute('role', 'region');
        layer.setAttribute('aria-label', '提示');
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
            el.className = `mtst mtst-${k}${entry.shown ? ' mtst-in' : ''}${evap ? ' mtst-evap' : ''}`;
            el.setAttribute('role', k === 'error' ? 'alert' : 'status');
            const action = entry.opts.action;
            if (action?.countdown && entry.countdown == null) entry.countdown = Math.max(1, Math.round(action.countdown));
            const count = action?.countdown && entry.countdown != null ? ` ${entry.countdown}` : '';
            const progress = k === 'progress' && Number.isFinite(entry.opts.progress)
                ? `<span class="mtst-bar"><span style="transform:scaleX(${Math.max(0, Math.min(1, entry.opts.progress))})"></span></span>` : '';
            el.innerHTML = `<span class="mtst-ic">${icon(entry.opts.icon || ICON_FOR[k], 16)}</span>`
                + `<span class="mtst-msg"></span>`
                + (action ? `<button class="mtst-act" type="button"></button>` : '')
                + (entry.opts.closable === false ? '' : `<button class="mtst-x" type="button" aria-label="关闭提示">${icon('x', 14)}</button>`)
                + progress;
            el.querySelector('.mtst-msg').textContent = entry.opts.message || '';
            if (action) el.querySelector('.mtst-act').textContent = `${action.label || '好'}${count}`;
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
                    const btn = entry.el.querySelector('.mtst-act');
                    if (btn) btn.textContent = `${entry.opts.action.label || '好'} ${entry.countdown}`;
                }, 1000);
                return;
            }
            if (!entry.remaining) entry.remaining = lifetime();
            if (!entry.remaining) return; // 0 = 一直留着，直到 close
            entry.startedAt = Date.now();
            entry.timer = setTimeout(close, entry.remaining);
            // 停留时间就是从实心慢慢蒸发成雾的过程（样式在 music-dock-drawer.css 的 .mtst-evap）。
            // 仅在重播已有蒸发动画时触发回流，新建提示条首次挂载直接加类即可。
            const hadEvap = entry.el.classList.contains('mtst-evap');
            entry.el.style.setProperty('--mtst-ms', `${entry.remaining}ms`);
            if (hadEvap) {
                entry.el.classList.remove('mtst-evap');
                void entry.el.offsetWidth;
            }
            entry.el.classList.add('mtst-evap');
        };

        const pause = () => {
            if (entry.timer) entry.remaining = Math.max(400, entry.remaining - (Date.now() - entry.startedAt));
            clearTimers();
            // 悬停时重新凝固，离开后用剩下的时间再蒸发一次。
            entry.el?.classList.remove('mtst-evap');
        };

        const mount = () => {
            if (entry.closed || entry.shown) return;
            const host = ensureLayer();
            const live = [...toasts.values()].filter((t) => t.shown && !t.closed);
            while (live.length >= MAX_VISIBLE) live.shift().close();
            entry.el = document.createElement('div');
            entry.el.dataset.key = key;
            render();
            host.appendChild(entry.el);
            entry.shown = true;
            requestAnimationFrame(() => { if (!entry.closed) entry.el?.classList.add('mtst-in'); });
            entry.el.addEventListener('pointerenter', () => { entry.hovered = true; pause(); });
            entry.el.addEventListener('pointerleave', () => { entry.hovered = false; arm(); });
            entry.el.addEventListener('click', (event) => {
                if (event.target.closest('.mtst-x')) close();
                else if (event.target.closest('.mtst-act')) runAction();
            });
            arm();
        };

        function close() {
            if (entry.closed) return;
            entry.closed = true;
            clearTimers();
            clearTimeout(entry.delayTimer);
            if (toasts.get(key) === entry) toasts.delete(key);
            const el = entry.el;
            if (!el) return;
            el.classList.remove('mtst-in');
            el.classList.add('mtst-out');
            setTimeout(() => el.remove(), 320);
        }

        entry.update = (next) => {
            const patch = normalize(next);
            const prevKind = kind();
            const prevHadProgress = prevKind === 'progress' && Number.isFinite(entry.opts.progress);
            const structureChanged = 'kind' in patch || 'icon' in patch || 'action' in patch || 'closable' in patch;
            const timingChanged = 'duration' in patch || 'kind' in patch || 'action' in patch;
            entry.opts = { ...entry.opts, ...patch };
            if (timingChanged) { entry.remaining = 0; entry.countdown = null; }
            if (!entry.shown) return;
            const nextHasProgress = kind() === 'progress' && Number.isFinite(entry.opts.progress);
            if (!structureChanged && prevHadProgress === nextHasProgress && entry.el) {
                if ('message' in patch) {
                    const msgEl = entry.el.querySelector('.mtst-msg');
                    if (msgEl) msgEl.textContent = entry.opts.message || '';
                }
                if (nextHasProgress && 'progress' in patch) {
                    const barEl = entry.el.querySelector('.mtst-bar > span');
                    if (barEl) barEl.style.transform = `scaleX(${Math.max(0, Math.min(1, entry.opts.progress))})`;
                }
                entry.el.classList.add('mtst-in');
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
    const clear = () => [...toasts.values()].forEach((t) => t.close());

    global.MusicToast = Object.freeze({ show, dismiss, clear });
})(window);
