// Musicmodules/music-device-sound.js
// 按输出设备记住 EQ：耳机和音箱要的曲线不一样。引擎在状态里报出实际在用的输出设备（output_device，
// 系统默认设备也报名字）；换了设备时，自动换回这台设备上次用的 EQ（开关和十段增益），没用过的设备沿用当前设置。
// 只存本机（localStorage musicDeviceSound）；命令面板里可以关掉。旧引擎不报设备名时什么都不做。
//
// 对外：app.deviceSound = { enabled, device, profiles() }；纯函数 snapshotOf / sameProfile 供测试。

(function (global) {
    'use strict';

    const KEY = 'musicDeviceSound';
    const SWITCH_KEY = 'musicDeviceSoundEnabled';
    const MAX_DEVICES = 24;

    const hasOwn = Object.prototype.hasOwnProperty;
    const snapshotOf = (bands, enabled) => {
        const b = {};
        if (bands) {
            for (const k in bands) {
                if (!hasOwn.call(bands, k)) continue;
                const n = Number(bands[k]);
                if (Number.isFinite(n)) b[k] = n;
            }
        }
        return { enabled: Boolean(enabled), bands: b };
    };
    const sameProfile = (a, b) => {
        if (!a || !b || a.enabled !== b.enabled) return false;
        const ba = a.bands || {};
        const bb = b.bands || {};
        for (const k in ba) if (hasOwn.call(ba, k) && (ba[k] || 0) !== (bb[k] || 0)) return false;
        for (const k in bb) if (hasOwn.call(bb, k) && !hasOwn.call(ba, k) && (bb[k] || 0) !== 0) return false;
        return true;
    };

    function setupMusicDeviceSound(app, { storage = (() => { try { return global.localStorage; } catch (e) { return null; } })() } = {}) {
        if (!app || app.deviceSound || typeof app.updateUIWithState !== 'function') return;
        const doc = global.document;
        let enabled = true;
        try { enabled = storage?.getItem(SWITCH_KEY) !== '0'; } catch (e) { /* 默认开 */ }
        let profiles = {};
        try {
            const v = JSON.parse(storage?.getItem(KEY) || 'null');
            if (v && v.v === 1 && v.d && typeof v.d === 'object') profiles = v.d;
        } catch (e) { profiles = {}; }
        let device = null;
        let applying = false;

        let saveTimer = null;
        let saveDirty = false;
        const flushSave = () => {
            if (saveTimer !== null) { global.clearTimeout?.(saveTimer); saveTimer = null; }
            if (!saveDirty) return;
            saveDirty = false;
            const names = Object.keys(profiles);
            if (names.length > MAX_DEVICES) {
                names.sort((a, b) => (profiles[a].at || 0) - (profiles[b].at || 0));
                for (const n of names.slice(0, names.length - MAX_DEVICES)) delete profiles[n];
            }
            try { storage?.setItem(KEY, JSON.stringify({ v: 1, d: profiles })); } catch (e) { /* 存不下就算了 */ }
        };
        const save = (immediate = false) => {
            saveDirty = true;
            if (immediate || typeof global.setTimeout !== 'function') { flushSave(); return; }
            if (saveTimer !== null) return;
            saveTimer = global.setTimeout(flushSave, 400);
        };
        const sliderCache = Object.create(null);
        const getSlider = (band) => {
            let slider = sliderCache[band];
            if (slider && slider.isConnected !== false) return slider;
            slider = doc?.getElementById?.(`eq-${band}`) || null;
            if (slider) sliderCache[band] = slider;
            return slider;
        };
        const sliderValue = (band) => {
            const slider = getSlider(band);
            const v = slider ? Number(slider.value) : Number(app.eqBands?.[band]);
            return Number.isFinite(v) ? v : 0;
        };
        const current = () => {
            const bands = {};
            const src = app.eqBands;
            if (src) {
                for (const band in src) {
                    if (hasOwn.call(src, band)) bands[band] = sliderValue(band);
                }
            }
            return { enabled: Boolean(app.eqSwitch ? app.eqSwitch.checked : app.eqEnabled), bands };
        };
        const remember = (immediate = false) => {
            if (!enabled || !device || applying) return;
            const next = current();
            if (profiles[device] && sameProfile(profiles[device], next)) return;
            next.at = Date.now();
            profiles[device] = next;
            save(immediate);
        };
        const toast = (message) => { try { global.MusicToast?.show?.({ message }); } catch (e) { /* 没有提示层 */ } };

        const apply = (profile) => {
            applying = true;
            try {
                for (const [band, gain] of Object.entries(profile.bands || {})) {
                    const slider = getSlider(band);
                    if (slider) slider.value = String(gain);
                    if (app.eqBands && band in app.eqBands) app.eqBands[band] = gain;
                }
                if (app.eqSwitch) {
                    app.eqSwitch._programmaticUpdate = true;
                    app.eqSwitch.checked = profile.enabled;
                    Promise.resolve().then(() => { app.eqSwitch._programmaticUpdate = false; });
                }
                app.updateEqSectionState?.();
                app.syncEqPresetSelect?.();
            } finally {
                applying = false;
            }
            return app.sendEqSettings?.();
        };

        const onDevice = (name) => {
            if (!name || name === device) return;
            const previous = device;
            device = name;
            if (!enabled) return;
            const saved = profiles[name];
            if (!saved) { remember(true); return; } // 第一次见到这台设备：先记下现在的设置
            if (!previous) return; // 刚打开窗口：界面上已经是保存过的设置，不去动它
            if (sameProfile(saved, current())) return;
            Promise.resolve(apply(saved)).then(() => {
                if (profiles[name]) { profiles[name].at = Date.now(); save(true); }
                else remember(true);
            }).catch(() => {});
            toast(`换到「${name}」，用这台设备上次的 EQ`);
        };

        const hooks = (global.MusicAppHooks || require('./music-app-hooks.js'));
        hooks.after(app, 'updateUIWithState', 'device-sound', (result, state) => {
            if (state && typeof state.output_device === 'string') onDevice(state.output_device);
        });
        hooks.wrap(app, 'sendEqSettings', 'device-sound', (base) => function (...args) {
            const result = base.apply(this, args);
            remember();
            return result;
        });

        global.addEventListener?.('beforeunload', flushSave, { once: true });

        app.deviceSound = {
            get enabled() { return enabled; },
            set enabled(v) {
                enabled = Boolean(v);
                try { storage?.setItem(SWITCH_KEY, enabled ? '1' : '0'); } catch (e) { /* 只是偏好 */ }
                if (enabled) remember(true);
            },
            get device() { return device; },
            profiles: () => JSON.parse(JSON.stringify(profiles)),
            flush: flushSave
        };
    }

    const exported = { setupMusicDeviceSound, snapshotOf, sameProfile };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.MusicDeviceSound = exported;
})(typeof window !== 'undefined' ? window : globalThis);
