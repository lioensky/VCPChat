/*
 * git.selected-workspace：Git 标签、状态面板和 V工程 Git 页共用的「当前工作区」。
 * 选择仍存在 localStorage 里（下次打开、V工程 窗口都从这里读），
 * 同一个窗口里的变化走这个 StateChannel，不再派发 window 事件。
 * 值形如 { id, origin }：origin 标出是谁改的，自己发的变化自己可以忽略。
 */
import '../state-channel.js';

export const GIT_WORKSPACE_STORAGE_KEY = 'vcp-projectforge-git-workspace';

const channels = new WeakMap(); // window → StateChannel

function storageOf(win) {
    try { return win?.localStorage || null; } catch (_e) { return null; }
}

function channelFor(win) {
    let channel = channels.get(win);
    if (!channel) {
        const { StateChannel } = globalThis.VCPStateChannels;
        let stored = null;
        try { stored = storageOf(win)?.getItem(GIT_WORKSPACE_STORAGE_KEY) || null; } catch (_e) { stored = null; }
        channel = new StateChannel('git.selected-workspace', Object.freeze({ id: stored, origin: 'storage' }));
        channels.set(win, channel);
    }
    return channel;
}

/** 当前选中的工作区 id（没有就是 null）。先读存储：V工程 窗口改过的选择这里也认 */
export function readSelectedGitWorkspace(win) {
    let stored = null;
    try { stored = storageOf(win)?.getItem(GIT_WORKSPACE_STORAGE_KEY) || null; } catch (_e) { stored = null; }
    return stored || channelFor(win).get()?.id || null;
}

/**
 * 选中一个工作区：存下来，并通知这个窗口里其它在看的界面。
 * @param {Window} win
 * @param {string} workspaceId
 * @param {{ origin?: string }} [options] origin 用来让发起者认出自己发的变化
 */
export function selectGitWorkspace(win, workspaceId, { origin = 'user' } = {}) {
    if (!win || typeof workspaceId !== 'string' || !workspaceId) return;
    try { storageOf(win)?.setItem(GIT_WORKSPACE_STORAGE_KEY, workspaceId); } catch (_e) { /* 存不了就只通知已挂载的界面 */ }
    const channel = channelFor(win);
    if (channel.get()?.id === workspaceId) return;
    channel.publish(Object.freeze({ id: workspaceId, origin }), { source: origin });
}

/**
 * 之后的选择变化。
 * @returns {() => void}
 */
export function watchSelectedGitWorkspace(win, listener) {
    if (!win || typeof listener !== 'function') return () => {};
    const off = channelFor(win).subscribe(value => listener(value || { id: null, origin: null }), { immediate: false });
    return () => { off(); };
}
