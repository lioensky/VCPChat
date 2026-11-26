/*
 * 曲目右键菜单的顺序和分组。
 *
 * 菜单里的项是几个模块各自插进去的（喜欢、电台、转到歌手 / 专辑、复制歌名），都插在「加入队列」后面，
 * 结果是「添加到歌单」沉到最底下，中间八项连成一片没有分隔。这里按 Apple Music 的习惯排：
 * 先是播放怎么放，再是收进歌单 / 喜欢，然后是去哪儿看，最后是复制、获取歌词这类工具，危险的移除单独放最后。
 * 有新的项插进来（或者某个模块晚加载）会自动再排一次；不认识的项放在工具组末尾。
 */
(function (global) {
    'use strict';
    const document = global.document;
    if (!document) return;

    const GROUPS = [
        ['archive-pick'],
        ['play', 'play-next', 'add-to-queue'],
        ['add-to-playlist', 'create-playlist-add', 'toggle-like'],
        ['start-radio', 'goto-artist', 'goto-album'],
        ['copy-title', 'get-lyrics', '*'],
        ['remove-from-list'],
    ];

    const KNOWN = new Set(GROUPS.flat());

    function arrange(menu) {
        const items = [...menu.children].filter((el) => el.classList.contains('context-menu-item'));
        const byAction = new Map(items.map((el) => [el.dataset.action, el]));
        const others = items.filter((el) => !KNOWN.has(el.dataset.action));
        const wanted = [];
        for (const group of GROUPS) {
            const els = group.flatMap((a) => (a === '*' ? others : byAction.has(a) ? [byAction.get(a)] : []));
            if (!els.length) continue;
            if (wanted.length) wanted.push('divider');
            wanted.push(...els);
        }
        // 已经是这个顺序就什么都不动（避免和观察器互相触发）
        const now = [...menu.children].filter((el) => el.classList.contains('context-menu-item') || el.classList.contains('context-menu-divider'));
        const same = now.length === wanted.length && now.every((el, i) => (wanted[i] === 'divider' ? el.classList.contains('context-menu-divider') : el === wanted[i]));
        if (same) return;
        const dividers = now.filter((el) => el.classList.contains('context-menu-divider'));
        const frag = document.createDocumentFragment();
        for (const w of wanted) {
            if (w === 'divider') {
                const d = dividers.shift() || document.createElement('div');
                d.className = 'context-menu-divider';
                frag.appendChild(d);
            } else frag.appendChild(w);
        }
        dividers.forEach((d) => d.remove());
        // 菜单里别的东西（比如流体层）留在原地，菜单项排在它们前面
        menu.insertBefore(frag, menu.firstChild);
    }

    // 有的项按场景藏起来（比如不在歌单里就没有「移除」），藏掉以后别留下连着的两道分隔线
    function tidyDividers(menu) {
        const shown = (el) => el.style.display !== 'none' && !el.hidden;
        let seenItem = false;
        let pending = null;
        for (const el of menu.children) {
            if (el.classList.contains('context-menu-divider')) {
                el.style.display = 'none';
                if (seenItem) pending = el;
            } else if (el.classList.contains('context-menu-item') && shown(el)) {
                if (pending) { pending.style.display = ''; pending = null; }
                seenItem = true;
            }
        }
    }

    // 鼠标右键点开的菜单也要接住方向键 / 回车 / Esc：不接的话按键会落到后面的目录上（换了选中的歌，甚至直接开始播放）。
    // 键盘打开的那几处自己已经接好了（menu.__kbdDetach 有值），这里只补没接的。
    function attachKeyboard(menu) {
        if (typeof menu.__kbdDetach === 'function') return;
        const active = document.activeElement;
        global.MusicArchiveList?.menuKeyboard?.({ contextMenu: menu }, { restore: active && active !== document.body ? active : null, focus: false });
    }

    function start() {
        const menu = document.getElementById('track-context-menu');
        if (!menu) return;
        arrange(menu);
        tidyDividers(menu);
        new MutationObserver(() => arrange(menu)).observe(menu, { childList: true });
        let wasVisible = menu.classList.contains('visible');
        new MutationObserver(() => {
            const visible = menu.classList.contains('visible');
            if (visible) tidyDividers(menu);
            if (visible && !wasVisible) attachKeyboard(menu);
            wasVisible = visible;
        }).observe(menu, { attributes: true, attributeFilter: ['class'] });
    }

    global.MusicMenuOrder = { arrange, tidyDividers, GROUPS };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})(typeof window !== 'undefined' ? window : globalThis);
