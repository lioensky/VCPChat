// Musicmodules/music-channels.js
// 声道：左右平衡、左右互换、合并为单声道（一边耳机坏了、单耳听、老录音左右分得太开时用）。
// 引擎在状态里报 channels（新引擎才有）；没报就当不支持，命令面板里不出现。
// 设置存在本机（localStorage musicChannels）；引擎重启后状态里的值和存的不一样，就把存的再发一次。
//
// 对外：app.channels = { supported, get(), set(patch), open() }；纯函数 normalize / describe 供测试。

(function (global) {
    'use strict';

    const KEY = 'musicChannels';
    const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
    const normalize = (v) => {
        const b = Number(v && v.balance);
        return {
            balance: Number.isFinite(b) ? Math.max(-1, Math.min(1, Math.round(b * 100) / 100)) : 0,
            swap: Boolean(v && v.swap),
            mono: Boolean(v && v.mono)
        };
    };
    const same = (a, b) => a.balance === b.balance && a.swap === b.swap && a.mono === b.mono;
    const isDefault = (v) => v.balance === 0 && !v.swap && !v.mono;
    // 给命令面板和对话框标题用的一句话
    const describe = (v) => {
        const parts = [];
        if (v.mono) parts.push('单声道');
        if (v.swap) parts.push('左右互换');
        if (v.balance < 0) parts.push(`偏左 ${Math.round(-v.balance * 100)}%`);
        if (v.balance > 0) parts.push(`偏右 ${Math.round(v.balance * 100)}%`);
        return parts.length ? parts.join('、') : '正常立体声';
    };

    function setupMusicChannels(app, { storage = (() => { try { return global.localStorage; } catch (e) { return null; } })() } = {}) {
        if (!app || app.channels || typeof app.updateUIWithState !== 'function') return;
        const doc = global.document;
        let wanted = normalize(null);
        try { wanted = normalize(JSON.parse(storage?.getItem(KEY) || 'null')); } catch (e) { /* 默认 */ }
        let engine = null;      // 引擎最近报的
        let sending = false;
        let lastPush = 0;
        let overlay = null;

        // 拖滑块时一秒几十次：同一时间只发一个请求，发的过程中又变了就等它回来再补发最后的值（不会乱序、不堆积）
        let inflight = null;
        let again = false;
        let failures = 0;       // 引擎连续不认（比如半新不旧的引擎），重发几次就别再拉锯了
        const send = () => {
            if (typeof app.api?.setMusicChannels !== 'function') return Promise.resolve(null);
            if (inflight) { again = true; return inflight; }
            sending = true;
            inflight = (async () => {
                let res = null;
                try {
                    do {
                        again = false;
                        try { res = await app.api.setMusicChannels({ ...wanted }); } catch (e) { res = null; }
                        if (res && res.channels) engine = normalize(res.channels);
                    } while (again);
                } finally {
                    sending = false;
                    inflight = null;
                }
                failures = res && res.channels && same(engine, wanted) ? 0 : failures + 1;
                return res;
            })();
            return inflight;
        };

        (global.MusicAppHooks || require('./music-app-hooks.js')).after(app, 'updateUIWithState', 'channels', (result, state) => {
            if (state && state.channels && typeof state.channels === 'object') {
                engine = normalize(state.channels);
                // 引擎重启过（回到默认）：把存的设置再发过去；隔 5 秒以上才重发，免得来回拉锯
                if (!same(engine, wanted) && !sending && failures < 3 && Date.now() - lastPush > 5000) { lastPush = Date.now(); send(); }
            }
        });

        const set = (patch) => {
            const next = normalize({ ...wanted, ...patch });
            if (same(next, wanted) && engine !== null && same(engine, wanted)) return Promise.resolve(null);
            wanted = next;
            failures = 0;
            try { storage?.setItem(KEY, JSON.stringify(wanted)); } catch (e) { /* 只是偏好 */ }
            lastPush = Date.now();
            syncDialog();
            return send();
        };

        // ── 对话框 ──
        const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
        let refs = null;
        const syncDialog = () => {
            if (!overlay || !refs) return;
            const sliderVal = String(Math.round(wanted.balance * 100));
            if (refs.slider.value !== sliderVal) refs.slider.value = sliderVal;
            const valText = wanted.balance === 0 ? '居中' : wanted.balance < 0 ? `偏左 ${Math.round(-wanted.balance * 100)}%` : `偏右 ${Math.round(wanted.balance * 100)}%`;
            if (refs.value.textContent !== valText) refs.value.textContent = valText;
            const swapStr = String(wanted.swap);
            if (refs.swap.getAttribute('aria-pressed') !== swapStr) refs.swap.setAttribute('aria-pressed', swapStr);
            const monoStr = String(wanted.mono);
            if (refs.mono.getAttribute('aria-pressed') !== monoStr) refs.mono.setAttribute('aria-pressed', monoStr);
            refs.reset.disabled = isDefault(wanted);
            const desc = describe(wanted);
            if (refs.summary.textContent !== desc) refs.summary.textContent = desc;
        };
        let previousFocus = null;
        let openRaf = 0;
        let closeTimer = 0;
        let closingOverlay = null;
        const flushClosing = () => {
            if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0; }
            if (closingOverlay) { const prev = closingOverlay; closingOverlay = null; prev.remove(); }
        };
        const close = (immediate = false) => {
            const isImmediate = immediate === true;
            if (!overlay) {
                if (isImmediate) flushClosing();
                return;
            }
            if (openRaf && typeof global.cancelAnimationFrame === 'function') { global.cancelAnimationFrame(openRaf); openRaf = 0; }
            flushClosing();
            const o = overlay;
            overlay = null;
            refs = null;
            global.removeEventListener('keydown', onKey, true);
            o.dataset.closing = '1';
            o.classList.remove('visible');
            if (isImmediate) o.remove();
            else {
                closingOverlay = o;
                closeTimer = setTimeout(() => { closeTimer = 0; if (closingOverlay === o) closingOverlay = null; o.remove(); }, 320);
            }
            const back = previousFocus;
            previousFocus = null;
            if (!isImmediate && back && back.isConnected && typeof back.focus === 'function') { try { back.focus({ preventScroll: true }); } catch (e) { /* 还不回去就算了 */ } }
        };
        const onKey = (e) => {
            if (doc.querySelector('.dialog-overlay.music-dialog:not([data-closing])')) return;
            if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); close(); return; }
            if (e.key === 'Tab' && overlay) {
                const focusables = [...overlay.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])')];
                if (focusables.length) {
                    const first = focusables[0], last = focusables[focusables.length - 1];
                    const active = doc.activeElement;
                    if (e.shiftKey ? (active === first || !overlay.contains(active)) : (active === last || !overlay.contains(active))) {
                        e.preventDefault();
                        (e.shiftKey ? last : first).focus({ preventScroll: true });
                    }
                }
                return;
            }
            if (NAV_KEYS.has(e.key)) { e.stopPropagation(); return; }
            if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) e.stopPropagation();
        };
        const open = () => {
            if (!doc || overlay) return;
            flushClosing();
            previousFocus = doc.activeElement;
            overlay = el('div', 'dialog-overlay music-stats-dialog');
            const dialog = el('div', 'dialog glass-panel mstats minfo mchan');
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-labelledby', 'mchan-title');
            const head = el('header', 'mstats-head');
            const h = el('h3', '', '声道');
            h.id = 'mchan-title';
            head.appendChild(h);
            const summary = el('span', 'mchan-summary');
            head.appendChild(summary);
            const x = el('button', 'mstats-close', '×');
            x.type = 'button';
            x.setAttribute('aria-label', '关闭');
            x.addEventListener('click', () => close());
            head.appendChild(x);
            dialog.appendChild(head);

            const bal = el('div', 'mchan-balance');
            const top = el('div', 'mchan-row');
            top.appendChild(el('span', 'mchan-label', '左右平衡'));
            const value = el('span', 'mchan-value');
            top.appendChild(value);
            bal.appendChild(top);
            const slider = el('input', 'mchan-slider');
            slider.type = 'range';
            slider.min = '-100';
            slider.max = '100';
            slider.step = '5';
            slider.setAttribute('aria-label', '左右平衡');
            slider.addEventListener('input', () => set({ balance: Number(slider.value) / 100 }));
            slider.addEventListener('dblclick', () => set({ balance: 0 })); // 双击回到居中
            bal.appendChild(slider);
            const ends = el('div', 'mchan-ends');
            ['左', '双击居中', '右'].forEach((t) => ends.appendChild(el('span', '', t)));
            bal.appendChild(ends);
            dialog.appendChild(bal);

            const toggles = el('div', 'mchan-toggles');
            const toggle = (label, hint, key) => {
                const b = el('button', 'mchan-toggle');
                b.type = 'button';
                b.appendChild(el('b', '', label));
                b.appendChild(el('span', '', hint));
                b.addEventListener('click', () => set({ [key]: !wanted[key] }));
                toggles.appendChild(b);
                return b;
            };
            const swap = toggle('左右互换', '左右耳机戴反、音箱接反时', 'swap');
            const mono = toggle('合并为单声道', '只戴一只耳机、老录音左右分得太开时', 'mono');
            dialog.appendChild(toggles);

            const actions = el('div', 'minfo-actions');
            const reset = el('button', 'minfo-btn', '恢复正常立体声');
            reset.type = 'button';
            reset.addEventListener('click', () => set({ balance: 0, swap: false, mono: false }));
            actions.appendChild(reset);
            dialog.appendChild(actions);

            refs = { slider, value, swap, mono, reset, summary };
            overlay.appendChild(dialog);
            overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
            doc.body.appendChild(overlay);
            global.addEventListener('keydown', onKey, true);
            syncDialog();
            const opening = overlay;
            openRaf = global.requestAnimationFrame?.(() => { openRaf = 0; if (overlay === opening) opening.classList.add('visible'); }) || 0;
            try { x.focus({ preventScroll: true }); } catch (e) { /* 没关系 */ }
        };

        global.addEventListener?.('beforeunload', () => close(true), { once: true });

        app.channels = {
            get supported() { return engine !== null; },
            get: () => ({ ...wanted }),
            set,
            open,
            describe: () => describe(wanted)
        };
    }

    const exported = { setupMusicChannels, normalize, describe };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.MusicChannels = exported;
})(typeof window !== 'undefined' ? window : globalThis);
