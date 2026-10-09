// modules/deskpet/petControls.js
// 桌宠的全局设置、全局快捷键和设置页的 IPC（主进程）。窗口本身由 modules/ipc/deskPetHandlers.js 管，
// 这里只通过 actions 回调去动它们。设置页是主窗口「全局设置 → 桌宠」分区
// （modules/settings/schema/deskpet-panel.js），只认主窗口发来的请求。
//
// 设置存在 AppData/deskpet/settings.json；每个桌宠自己的位置和大小仍在 AppData/deskpet/state.json。

'use strict';

const path = require('path');
const fs = require('fs-extra');
const prefs = require('./petPrefs');

const SAVE_DELAY_MS = 200;

function createPetControls({ electron, appDataRoot, actions }) {
    const { ipcMain, globalShortcut } = electron;
    const file = path.join(appDataRoot, 'deskpet', 'settings.json');
    let settings = prefs.normalizeSettings({});
    let loaded = false;
    let saveTimer = null;
    let writing = Promise.resolve();
    const registered = new Map(); // actionId -> accelerator（我们自己注册成功的）
    const failures = {}; // actionId -> 失败原因
    let shortcutsPaused = false;
    const listeners = new Set();

    // ---- 设置文件 ----

    async function load() {
        try {
            settings = prefs.normalizeSettings(await fs.readJson(file));
        } catch (error) {
            if (error.code !== 'ENOENT') console.warn('[DeskPet] settings unreadable, using defaults:', error.message);
            settings = prefs.normalizeSettings({});
        }
        loaded = true;
        return settings;
    }

    function flush() {
        clearTimeout(saveTimer);
        saveTimer = null;
        const snapshot = JSON.stringify(settings, null, 2);
        // 串行写：先写临时文件再改名，断电或同时两次保存都不会留下半个文件。
        writing = writing.then(async () => {
            const tmp = `${file}.tmp`;
            await fs.outputFile(tmp, snapshot);
            await fs.move(tmp, file, { overwrite: true });
        }).catch((error) => console.warn('[DeskPet] settings save failed:', error.message));
        return writing;
    }

    function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flush, SAVE_DELAY_MS);
    }

    function get() {
        return settings;
    }

    function emitChanged(changedKeys) {
        for (const fn of listeners) {
            try { fn(settings, changedKeys); } catch (error) { console.warn('[DeskPet] settings listener:', error.message); }
        }
        sendToSettings();
    }

    /** 合并修改并保存；返回整理后的设置。只认识的字段才会生效。 */
    function update(patch) {
        const next = prefs.normalizeSettings({ ...settings, ...patch, shortcuts: { ...settings.shortcuts, ...(patch?.shortcuts || {}) } });
        const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(settings[k]));
        if (!changed.length) return settings;
        settings = next;
        scheduleSave();
        if (changed.includes('shortcuts')) applyShortcuts();
        emitChanged(changed);
        return settings;
    }

    // ---- 全局快捷键 ----

    function handlerFor(actionId) {
        if (actionId === 'toggle') return () => actions.toggleAll();
        if (actionId === 'talk') return () => actions.talk();
        if (actionId === 'voice') return () => actions.voice?.();
        if (actionId === 'clickThrough') return () => update({ clickThrough: !settings.clickThrough });
        return null;
    }

    function unregisterOurs() {
        for (const accelerator of registered.values()) {
            try { globalShortcut.unregister(accelerator); } catch { /* 已经没了 */ }
        }
        registered.clear();
    }

    function applyShortcuts() {
        unregisterOurs();
        for (const key of Object.keys(failures)) delete failures[key];
        if (shortcutsPaused) return;
        for (const [actionId, accelerator] of Object.entries(settings.shortcuts)) {
            if (!accelerator) continue;
            let ok = false;
            try {
                // 已被别的程序（或 VCPChat 别处）占用时 register 返回 false
                ok = !globalShortcut.isRegistered(accelerator) && globalShortcut.register(accelerator, handlerFor(actionId));
            } catch {
                ok = false;
            }
            if (ok) registered.set(actionId, accelerator);
            else {
                failures[actionId] = '被其他程序占用了，换一个组合吧';
                console.warn(`[DeskPet] global shortcut unavailable: ${accelerator}`);
            }
        }
    }

    /** 设置页录新快捷键时先停用现有的，免得按下去直接触发。 */
    function pauseShortcuts(paused) {
        if (shortcutsPaused === !!paused) return;
        shortcutsPaused = !!paused;
        applyShortcuts();
        sendToSettings();
    }

    function setShortcut(actionId, value) {
        if (!prefs.SHORTCUT_ACTIONS[actionId]) return { success: false, error: '未知的快捷键' };
        const accelerator = prefs.normalizeAccelerator(value);
        if (accelerator === null) return { success: false, error: '至少要两个修饰键（Ctrl、Alt、Shift、Win 里任选，不能只有 Shift）加一个键，F1–F24 加一个修饰键也行' };
        if (accelerator && prefs.isReserved(accelerator)) return { success: false, error: 'VCPChat 自己在用这个组合' };
        const other = Object.entries(settings.shortcuts).find(([id, acc]) => id !== actionId && acc && acc === accelerator);
        if (other) return { success: false, error: `已经给「${prefs.SHORTCUT_ACTIONS[other[0]].label}」用了` };
        update({ shortcuts: { [actionId]: accelerator } });
        const failure = failures[actionId];
        return failure ? { success: false, error: failure, saved: true } : { success: true };
    }

    // ---- 设置页 ----

    function snapshot() {
        return {
            settings,
            failures: { ...failures },
            paused: shortcutsPaused,
            pets: actions.listPets(),
            actions: Object.fromEntries(Object.entries(prefs.SHORTCUT_ACTIONS).map(([id, a]) => [id, { label: a.label, defaultAccelerator: a.defaultAccelerator }])),
            scale: { min: prefs.SCALE_MIN, max: prefs.SCALE_MAX, step: prefs.SCALE_STEP },
            platform: process.platform,
        };
    }

    // 推给设置页；设置页出什么错都不能打断桌宠本身（开关窗口、换装都会走到这里）
    function sendToSettings() {
        try {
            actions.sendToSettings?.(snapshot());
        } catch (error) {
            console.warn('[DeskPet] settings push failed:', error.message);
        }
    }

    /** 托盘、右键菜单里的「桌宠设置…」：打开主窗口的全局设置，切到桌宠分区。 */
    function openSettings() {
        actions.openSettingsPage?.();
    }

    function fromSettings(event) {
        return actions.isSettingsSender?.(event?.sender) === true;
    }

    function registerIpc() {
        ipcMain.handle('deskpet-settings:update', (event, patch) => {
            if (!fromSettings(event) || !patch || typeof patch !== 'object') return null;
            const allowed = {};
            if (typeof patch.doNotDisturb === 'boolean') allowed.doNotDisturb = patch.doNotDisturb;
            if (typeof patch.restoreOnLaunch === 'boolean') allowed.restoreOnLaunch = patch.restoreOnLaunch;
            if (typeof patch.yieldToFullscreen === 'boolean') allowed.yieldToFullscreen = patch.yieldToFullscreen;
            if (typeof patch.clickThrough === 'boolean') allowed.clickThrough = patch.clickThrough;
            if (typeof patch.opacity === 'number') allowed.opacity = patch.opacity;
            if (typeof patch.wander === 'boolean') allowed.wander = patch.wander;
            if (typeof patch.followCursor === 'boolean') allowed.followCursor = patch.followCursor;
            if (typeof patch.hideFromCapture === 'boolean') allowed.hideFromCapture = patch.hideFromCapture;
            if (typeof patch.idleChat === 'boolean') allowed.idleChat = patch.idleChat;
            if (typeof patch.idleChatMinutes === 'number') allowed.idleChatMinutes = patch.idleChatMinutes;
            update(allowed);
            return snapshot();
        });
        ipcMain.handle('deskpet-settings:set-shortcut', (event, actionId, accelerator) => {
            if (!fromSettings(event)) return { success: false };
            const result = setShortcut(String(actionId), accelerator);
            return { ...result, snapshot: snapshot() };
        });
        ipcMain.handle('deskpet-settings:reset-shortcuts', (event) => {
            if (!fromSettings(event)) return null;
            update({ shortcuts: { ...prefs.DEFAULT_SETTINGS.shortcuts } });
            return snapshot();
        });
        ipcMain.handle('deskpet-settings:pause-shortcuts', (event, paused) => {
            if (!fromSettings(event)) return null;
            pauseShortcuts(paused);
            return snapshot();
        });
        ipcMain.handle('deskpet-settings:set-scale', async (event, agentId, scale) => {
            if (!fromSettings(event) || typeof agentId !== 'string') return null;
            await actions.setScale(agentId, Number(scale));
            return snapshot();
        });
    }

    function dispose() {
        clearTimeout(saveTimer);
        if (saveTimer !== null) flush();
        unregisterOurs();
    }

    return {
        load,
        get,
        update,
        flush,
        onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        applyShortcuts,
        setShortcut,
        failures: () => ({ ...failures }),
        openSettings,
        refreshSettings: sendToSettings,
        snapshot,
        fromSettings,
        pauseShortcuts,
        registerIpc,
        dispose,
        isLoaded: () => loaded,
    };
}

module.exports = { createPetControls };
