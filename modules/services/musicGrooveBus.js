'use strict';

// 音乐窗口唯一连接的频谱分发点。可选桌宠订阅；没有订阅者时不发送高频 IPC。
const listeners = new Set();
let snapshot = { playing: false, trackKey: '', data: [] };
let lastPublish = -Infinity;
function publish(payload, now = Date.now()) {
    if (!payload || typeof payload !== 'object') return false;
    const playing = payload.playing === true;
    if (playing && now - lastPublish < 40) return false;
    const data = payload.data;
    if (playing && (!Array.isArray(data) || !data.length || data.length > 2048)) return false;
    if (playing && !data.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) return false;
    snapshot = {
        playing,
        trackKey: typeof payload.trackKey === 'string' ? payload.trackKey.slice(0, 4096) : '',
        data: playing ? data.slice() : [],
    };
    lastPublish = now;
    for (const listener of listeners) {
        try { listener(snapshot); } catch (error) { console.warn('[MusicGroove] subscriber:', error.message); }
    }
    return true;
}
function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
module.exports = { publish, subscribe };