// Musicmodules/music-queue-undo.js
// 「清空队列」可以撤销：以前一点就没了，排了半天的待播列表找不回来。清空后弹提示，点「撤销」原样放回；
// 清空之后又加进去的歌留着、排在后面；这期间被移出曲库的歌不再放回。只有一首时不弹（随手清掉的）。
//
// 对外：纯函数 restoredQueue(before, now, library) 供测试。

(function (global) {
    'use strict';

    const restoredQueue = (before, now, library) => {
        const alive = new Set(library || []);
        const out = (before || []).filter((t) => alive.has(t));
        const seen = new Set(out);
        for (const t of now || []) if (!seen.has(t)) { seen.add(t); out.push(t); }
        return out;
    };

    function setupMusicQueueUndo(app) {
        if (!app || app.queueClearUndoable || typeof app.queueClear !== 'function') return;
        (global.MusicAppHooks || require('./music-app-hooks.js')).wrap(app, 'queueClear', 'queue-undo', (original) => function (...args) {
            const before = Array.isArray(app.manualQueue) ? app.manualQueue.slice() : [];
            const result = original.apply(this, args);
            if (before.length < 2) return result;
            try {
                global.MusicToast?.show?.({
                    id: 'queue',
                    kind: 'success',
                    message: `已清空待播队列（${before.length} 首）`,
                    duration: 6000,
                    action: {
                        label: '撤销',
                        run: () => {
                            app.manualQueue = restoredQueue(before, app.manualQueue, app.playlist);
                            try { global.document?.dispatchEvent(new CustomEvent('music-queue-change')); } catch (e) { /* 没有 DOM */ }
                            app.refreshPreload?.();
                        }
                    }
                });
            } catch (e) { /* 没有提示层 */ }
            return result;
        });
        app.queueClearUndoable = true;
    }

    const exported = { setupMusicQueueUndo, restoredQueue };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.MusicQueueUndo = exported;
})(typeof window !== 'undefined' ? window : globalThis);
