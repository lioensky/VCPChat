// Musicmodules/music-dock/music-dock-drawer-width.js
// 右侧设置抽屉的宽度：左边缘有一条拖柄，拖动改宽，松手记住（localStorage musicDockDrawerWidth），双击恢复默认。
// 默认宽度按窗口宽度取（窗口小抽屉也窄一点，340..400），可调范围 320..520，且不超过窗口的 45%。
// 改宽时调 onChange（底栏重排播放条、首页让位都由它触发），抽屉本身用 CSS 变量 --md-drawer-w。
(function (global) {
    'use strict';

    const KEY = 'musicDockDrawerWidth';
    const MIN = 320;
    const MAX = 520;
    const MAX_SHARE = 0.45;

    // 默认：1820 宽以上 400，越窄越收，最窄 340
    const defaultWidth = (vw) => Math.round(Math.max(340, Math.min(400, vw * 0.22)));
    const clampWidth = (w, vw) => Math.round(Math.max(MIN, Math.min(MAX, vw > 0 ? vw * MAX_SHARE : MAX, w)));

    function create({ pnl, onChange, listen, win = global } = {}) {
        let user = null;
        try {
            const raw = Number(win.localStorage?.getItem(KEY));
            if (Number.isFinite(raw) && raw > 0) user = raw;
        } catch (_) { /* 读不到就用默认 */ }

        const vw = () => win.innerWidth || 0;
        const width = () => (user == null ? defaultWidth(vw()) : clampWidth(user, vw()));
        let applied = '';
        const apply = () => {
            if (!pnl) return;
            const v = `${width()}px`;
            if (v === applied) return;
            applied = v;
            pnl.style.setProperty('--md-drawer-w', v);
            grip?.setAttribute('aria-valuenow', String(width()));
        };

        let grip = null;
        if (pnl) {
            grip = pnl.ownerDocument.createElement('div');
            grip.className = 'md-drw-grip';
            grip.tabIndex = 0;
            grip.setAttribute('role', 'separator');
            grip.setAttribute('aria-orientation', 'vertical');
            grip.setAttribute('aria-label', '调整设置抽屉宽度');
            grip.setAttribute('aria-valuemin', String(MIN));
            grip.setAttribute('aria-valuemax', String(MAX));
            grip.title = '拖动调整宽度，双击恢复默认';
            pnl.insertBefore(grip, pnl.firstChild);
        }
        const save = () => {
            try {
                if (user == null) win.localStorage?.removeItem(KEY);
                else win.localStorage?.setItem(KEY, String(width()));
            } catch (_) { /* 存不了就只管这次 */ }
        };
        const set = (w, { persist = false } = {}) => {
            user = w == null ? null : clampWidth(w, vw());
            apply();
            onChange?.();
            if (persist) save();
        };

        if (grip && listen) {
            let drag = null;
            listen(grip, 'pointerdown', (event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                drag = { id: event.pointerId, x: event.clientX, w: width() };
                grip.setPointerCapture?.(event.pointerId);
                pnl.classList.add('md-drw-resizing');
            });
            listen(grip, 'pointermove', (event) => {
                if (!drag || event.pointerId !== drag.id) return;
                // 抽屉贴右边：往左拖变宽
                set(drag.w + (drag.x - event.clientX));
            });
            const end = (event) => {
                if (!drag || event.pointerId !== drag.id) return;
                drag = null;
                pnl.classList.remove('md-drw-resizing');
                save();
            };
            listen(grip, 'pointerup', end);
            listen(grip, 'pointercancel', end);
            listen(grip, 'dblclick', (event) => { event.stopPropagation(); set(null, { persist: true }); });
            listen(grip, 'keydown', (event) => {
                const step = event.shiftKey ? 40 : 16;
                if (event.key === 'ArrowLeft') set(width() + step, { persist: true });
                else if (event.key === 'ArrowRight') set(width() - step, { persist: true });
                else if (event.key === 'Home') set(null, { persist: true });
                else return;
                event.preventDefault();
                event.stopPropagation();
            });
        }
        apply();
        return {
            get width() { return width(); },
            // 窗口变了：默认宽度和上限跟着变
            refresh: apply,
            set: (w) => set(w, { persist: true }),
            reset: () => set(null, { persist: true }),
            destroy: () => { grip?.remove(); pnl?.style.removeProperty('--md-drawer-w'); }
        };
    }

    global.MusicDockDrawerWidth = Object.freeze({ create, MIN, MAX, defaultWidth });
})(typeof window !== 'undefined' ? window : globalThis);
