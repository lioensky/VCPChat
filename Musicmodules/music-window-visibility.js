// Musicmodules/music-window-visibility.js
// 音乐窗口关了后台节流（backgroundThrottling: false，让定时器在窗口被挡住、最小化时照常走，
// 桌面歌词和进度才不掉队）。代价是 Electron 会让页面一直报「可见」，舞台、首页 3D 阵列这些
// 靠 document.hidden 暂停的画面在最小化时也会满帧画。
// 这里接主进程送来的「窗口最小化 / 藏起来了」，把 document.hidden / visibilityState 补回真实状态，
// 并照常发 visibilitychange，各模块不用改。定时器不受影响。
(function (global) {
    'use strict';

    const doc = global.document;
    const api = global.utilityAPI || global.electronAPI;
    if (!doc || !api || typeof api.onMusicWindowVisibility !== 'function') return;

    const proto = Object.getPrototypeOf(doc);
    const nativeHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden') || Object.getOwnPropertyDescriptor(proto, 'hidden');
    const nativeState = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState') || Object.getOwnPropertyDescriptor(proto, 'visibilityState');
    let windowHidden = false;

    const realHidden = () => windowHidden || (nativeHidden ? nativeHidden.get.call(doc) === true : false);
    try {
        Object.defineProperty(doc, 'hidden', { configurable: true, get: realHidden });
        Object.defineProperty(doc, 'visibilityState', {
            configurable: true,
            get: () => (windowHidden ? 'hidden' : (nativeState ? nativeState.get.call(doc) : 'visible'))
        });
    } catch (error) {
        console.warn('[MusicWindowVisibility] cannot patch document visibility:', error);
        return;
    }

    api.onMusicWindowVisibility((payload) => {
        const hidden = !!(payload && payload.hidden);
        if (hidden === windowHidden) return;
        windowHidden = hidden;
        doc.dispatchEvent(new Event('visibilitychange'));
    });
})(window);
