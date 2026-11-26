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

    const snapshotOf = (bands, enabled) => {
        const b = {};
        for (const [k, v] of Object.entries(bands || {})) {
            const n = Number(v);
            if (Number.isFinite(n)) b[k] = n;
        }
        return { enabled: Boolean(enabled), bands: b };
    };
    const sameProfile = (a, b) => {
        if (!a || !b || a.enabled !== b.enabled) return false;
        const keys = new Set([...Object.keys(a.bands || {}), ...Object.keys(b.bands || {})]);
        for (const k of keys) if ((a.bands[k] || 0) !== (b.bands[k] || 0)) return false;
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

        const save = () => {
            const names = Object.keys(profiles);
            if (names.length > MAX_DEVICES) {
                names.sort((a, b) => (profiles[a].at || 0) - (profiles[b].at || 0));
                for (const n of names.slice(0, names.length - MAX_DEVICES)) delete profiles[n];
            }
            try { storage?.setItem(KEY, JSON.stringify({ v: 1, d: profiles })); } catch (e) { /* 存不下就算了 */ }
        };
        const sliderValue = (band) => {
            const slider = doc?.getElementById?.(`eq-${band}`);
            const v = slider ? Number(slider.value) : Number(app.eqBands?.[band]);
            return Number.isFinite(v) ? v : 0;
        };
        const current = () => {
            const bands = {};
            for (const band of Object.keys(app.eqBands || {})) bands[band] = sliderValue(band);
            return snapshotOf(bands, app.eqSwitch ? app.eqSwitch.checked : app.eqEnabled);
        };
        const remember = () => {
            if (!enabled || !device || applying) return;
            profiles[device] = { ...current(), at: Date.now() };
            save();
        };
        const toast = (message) => { try { global.MusicToast?.show?.({ message }); } catch (e) { /* 没有提示层 */ } };

        const apply = (profile) => {
            applying = true;
            try {
                for (const [band, gain] of Object.entries(profile.bands || {})) {
                    const slider = doc?.getElementById?.(`eq-${band}`);
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
            if (!saved) { remember(); return; } // 第一次见到这台设备：先记下现在的设置
            if (!previous) return; // 刚打开窗口：界面上已经是保存过的设置，不去动它
            if (sameProfile(saved, current())) return;
            Promise.resolve(apply(saved)).then(() => remember());
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

        app.deviceSound = {
            get enabled() { return enabled; },
            set enabled(v) {
                enabled = Boolean(v);
                try { storage?.setItem(SWITCH_KEY, enabled ? '1' : '0'); } catch (e) { /* 只是偏好 */ }
                if (enabled) remember();
            },
            get device() { return device; },
            profiles: () => JSON.parse(JSON.stringify(profiles))
        };
    }

    const exported = { setupMusicDeviceSound, snapshotOf, sameProfile };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.MusicDeviceSound = exported;
})(typeof window !== 'undefined' ? window : globalThis);
