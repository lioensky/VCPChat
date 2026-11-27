// 音乐窗口的「降低动态」设置：跟随系统 / 开 / 关，默认跟随系统。
// 过场、档案页等所有动画都读这一个值，不要各自再去查 prefers-reduced-motion：
//   window.MusicMotion.reduced()        → 当前是否该降低动态（布尔）
//   window.MusicMotion.preference       → 'system' | 'on' | 'off'
//   window.MusicMotion.set(pref)        → 改设置（会记住）
//   window.MusicMotion.onChange(fn)     → 结果变化时回调 fn(reduced)，返回取消函数
// 同时在 <body> 上挂 music-reduce-motion 类，样式里用它（再加上原来的 @media 也无妨，二者是同一个意思）。
// 结果变化时还会在 window 上派发 'music-motion-change' 事件，detail 是 { reduced, preference }。
(function (global) {
    'use strict';

    const KEY = 'musicReducedMotion';
    const PREFS = ['system', 'on', 'off'];
    const media = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;

    let preference = 'system';
    try {
        const saved = localStorage.getItem(KEY);
        if (PREFS.includes(saved)) preference = saved;
    } catch (e) { /* 读不到就跟随系统 */ }

    const compute = () => (preference === 'on' ? true : preference === 'off' ? false : Boolean(media?.matches));
    let reduced = compute();
    const listeners = new Set();

    const apply = () => {
        const body = document.body;
        if (body) {
            body.classList.toggle('music-reduce-motion', reduced);
            body.dataset.motionPreference = preference;
        }
    };

    const update = () => {
        const next = compute();
        const changed = next !== reduced;
        reduced = next;
        apply();
        if (!changed) return;
        for (const fn of listeners) { try { fn(reduced); } catch (e) { console.warn('[MusicMotion]', e); } }
        global.dispatchEvent(new CustomEvent('music-motion-change', { detail: { reduced, preference } }));
    };

    media?.addEventListener?.('change', update);
    global.addEventListener?.('beforeunload', () => media?.removeEventListener?.('change', update), { once: true });
    if (document.body) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });

    global.MusicMotion = {
        reduced: () => reduced,
        get preference() { return preference; },
        set(next) {
            if (!PREFS.includes(next) || next === preference) return;
            preference = next;
            try { localStorage.setItem(KEY, next); } catch (e) { /* 只是这次有效 */ }
            update();
        },
        onChange(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        PREFERENCES: Object.freeze([
            { value: 'system', label: '跟随系统' },
            { value: 'on', label: '开' },
            { value: 'off', label: '关' }
        ])
    };
})(window);
