// app 方法的扩展点：别的模块要在 app.showContextMenu、app.updateUIWithState 这类方法前后加自己的事，
// 走这里，不要自己写「const base = app.x; app.x = (...) => { ...; return base(...) }」。
//
//   MusicAppHooks.before(app, 'showContextMenu', 'likes', () => paint());
//   MusicAppHooks.after(app, 'updateUIWithState', 'channels', (result, state) => { ... });
//   MusicAppHooks.wrap(app, 'renderPlaylist', 'classic-list', (base) => (filtered) => base(sorted(filtered)));
//
// 规则：
// - 后装的先跑（和原来手写包装一样）：before 的钩子按安装顺序倒序在原方法之前跑。
// - before 钩子抛错会照常往外抛（和手写一样）；after 钩子的错误只记一条警告，不影响返回值。
// - 原方法不存在时不装，返回 false（测试里的假 app 常常只有一部分方法）。
// - 装上时返回 remove()：自己还在最外层就拆掉、恢复成原来的方法；外面又被别人包过就不动（销毁时用）。
// - MusicAppHooks.list(app) 列出每个方法被谁、按什么顺序包过，排查「这个方法到底跑了什么」时先看它。
(function (global) {
    'use strict';

    const registry = new WeakMap();

    // 换上 next，记一笔，返回 remove()。
    const install = (app, name, owner, kind, base, next) => {
        app[name] = next;
        let byName = registry.get(app);
        if (!byName) { byName = new Map(); registry.set(app, byName); }
        if (!byName.has(name)) byName.set(name, []);
        const entry = { owner: String(owner || '?'), kind };
        byName.get(name).push(entry);
        return function remove() {
            if (app[name] !== next) return false;
            app[name] = base;
            const entries = byName.get(name) || [];
            const at = entries.indexOf(entry);
            if (at >= 0) entries.splice(at, 1);
            if (!entries.length) byName.delete(name);
            return true;
        };
    };

    function wrap(app, name, owner, make) {
        if (!app || typeof app[name] !== 'function' || typeof make !== 'function') return false;
        const base = app[name];
        const next = make(base);
        if (typeof next !== 'function') return false;
        return install(app, name, owner, 'wrap', base, next);
    }

    function before(app, name, owner, hook) {
        if (!app || typeof app[name] !== 'function' || typeof hook !== 'function') return false;
        const base = app[name];
        return install(app, name, owner, 'before', base, function (...args) {
            hook.apply(this, args);
            return base.apply(this, args);
        });
    }

    function after(app, name, owner, hook) {
        if (!app || typeof app[name] !== 'function' || typeof hook !== 'function') return false;
        const base = app[name];
        return install(app, name, owner, 'after', base, function (...args) {
            const result = base.apply(this, args);
            try { hook.call(this, result, ...args); } catch (error) {
                try { console.warn(`[MusicAppHooks] ${owner} after ${name}:`, error?.message || error); } catch (e) { /* 没有控制台 */ }
            }
            return result;
        });
    }

    // 安装顺序（最外层在最后）。
    function list(app) {
        const out = {};
        for (const [name, entries] of registry.get(app) || []) out[name] = entries.map(e => `${e.kind}:${e.owner}`);
        return out;
    }

    const api = { wrap, before, after, list };
    global.MusicAppHooks = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
