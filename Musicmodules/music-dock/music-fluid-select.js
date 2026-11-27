// Musicmodules/music-dock/music-fluid-select.js
// 音乐窗口里所有原生 <select> 换成和主程序设置页同一种选项控件：一个按钮显示当前值，点开是一张选项卡片，
// 当前项右边打勾。卡片用流体玻璃的材质（music-fluid-kit.css 的 .mf-glass），从按钮长出来（MusicFluid.bud）。
// 原 <select> 留在原处继续当数据源：值、change 事件、程序里直接赋值都照旧，别的代码不需要知道有这一层。
// 选项少的舞台设置已经换成分段按钮（music-skin.js 的 music-skin-segmented-source），这里跳过它们。
(function (global) {
    'use strict';
    const doc = global.document;
    if (!doc) return;

    const DRESSED = new WeakMap(); // select -> { trigger, sync }
    const SELECT_OBSERVERS = new Set();
    let openState = null;          // { select, menu, trigger, items, restore }
    let uid = 0;

    const CHEVRON = '<svg class="mfs-chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const CHECK = '<svg class="mfs-check" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="M3.2 8.6l3.1 3 6.5-7.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const skip = (select) => select.multiple
        || select.size > 1
        || select.classList.contains('music-skin-segmented-source')
        || select.dataset.segmented
        || select.closest('[data-mf-native]');

    const labelOf = (select) => {
        const option = select.options[select.selectedIndex];
        return option ? option.textContent.trim() : '';
    };

    // 原下拉框被藏起来（行内 display:none、hidden、被禁用）时按钮跟着一样
    const mirror = (select, trigger) => {
        const hidden = select.hidden || select.style.display === 'none';
        trigger.hidden = hidden;
        trigger.disabled = select.disabled;
        trigger.title = select.title || '';
        // 原来写在行内的宽度（比如 60px 的紧凑档）只当最小宽度用，字放得下就行
        const w = select.style.width;
        trigger.style.minWidth = w && w !== 'auto' ? w : '';
    };

    function dress(select) {
        if (DRESSED.has(select) || skip(select)) return;
        const trigger = doc.createElement('button');
        trigger.type = 'button';
        trigger.className = 'mfs-trigger';
        for (const cls of select.classList) if (/select$/.test(cls)) trigger.classList.add(`mfs-from-${cls}`);
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        const label = select.getAttribute('aria-label')
            || (select.id && doc.querySelector(`label[for="${CSS.escape(select.id)}"]`)?.textContent.trim())
            || select.title || '';
        if (label) trigger.setAttribute('aria-label', label);
        const text = doc.createElement('span');
        text.className = 'mfs-text';
        trigger.append(text);
        trigger.insertAdjacentHTML('beforeend', CHEVRON);

        const sync = () => {
            const now = labelOf(select);
            if (text.textContent !== now) text.textContent = now;
            mirror(select, trigger);
            if (label) trigger.setAttribute('aria-label', `${label}：${now}`);
            if (openState?.select === select) paintSelected();
        };

        // 程序里直接给 value / selectedIndex 赋值不会发 change，在这个下拉框自己身上接一下
        for (const key of ['value', 'selectedIndex']) {
            const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, key);
            if (!proto?.set) continue;
            Object.defineProperty(select, key, {
                configurable: true,
                get() { return proto.get.call(this); },
                set(v) { proto.set.call(this, v); sync(); }
            });
        }
        select.addEventListener('change', sync);
        select.addEventListener('input', sync);
        const obs = new MutationObserver(sync);
        obs.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'hidden', 'disabled', 'title'] });
        SELECT_OBSERVERS.add(obs);

        trigger.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (openState?.select === select) close(true);
            else open(select);
        });
        trigger.addEventListener('keydown', (event) => {
            if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
                event.preventDefault();
                if (openState?.select !== select) open(select);
            }
        });

        select.classList.add('mfs-native');
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');
        select.after(trigger);
        DRESSED.set(select, { trigger, sync });
        sync();
    }

    function paintSelected() {
        if (!openState) return;
        const { select, items } = openState;
        items.forEach((item, index) => {
            const on = index === select.selectedIndex;
            item.setAttribute('aria-selected', String(on));
            item.classList.toggle('mfs-on', on);
        });
    }

    function place(menu, trigger) {
        const r = trigger.getBoundingClientRect();
        const vw = global.innerWidth, vh = global.innerHeight, m = 10;
        const below = vh - r.bottom - m, above = r.top - m;
        const maxH = Math.max(160, Math.min(360, Math.max(below, above) - 6));
        menu.style.minWidth = `${Math.max(r.width, 120)}px`;
        menu.style.maxHeight = `${maxH}px`;
        const w = menu.offsetWidth, h = Math.min(menu.offsetHeight, maxH);
        let left = Math.min(Math.max(m, r.right - w), vw - w - m);
        if (r.left + w <= vw - m && r.left >= m) left = r.left;
        let top = below >= h || below >= above ? r.bottom + 6 : r.top - 6 - h;
        top = Math.max(m, Math.min(top, vh - h - m));
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
    }

    function open(select) {
        close(false);
        const entry = DRESSED.get(select);
        if (!entry || select.disabled) return;
        const { trigger } = entry;
        const menu = doc.createElement('div');
        // custom-select-dropdown：底栏抽屉认这个类，点在里面不算「点到抽屉外面」
        menu.className = 'mfs-menu mf-glass custom-select-dropdown';
        menu.id = `mfs-menu-${++uid}`;
        menu.setAttribute('role', 'listbox');
        if (trigger.getAttribute('aria-label')) menu.setAttribute('aria-label', trigger.getAttribute('aria-label'));
        const items = [];
        const frag = doc.createDocumentFragment();
        let group = null;
        Array.from(select.options).forEach((option, index) => {
            const skipRender = option.hidden && option.disabled && !option.selected;
            const ogEl = option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement : null;
            const og = (!skipRender && ogEl && !ogEl.hidden) ? ogEl.label : '';
            if (og && og !== group) {
                const head = doc.createElement('div');
                head.className = 'mfs-group';
                head.textContent = og;
                frag.append(head);
                group = og;
            } else if (!skipRender && !og) {
                group = null;
            }
            const item = doc.createElement('div');
            item.className = 'mfs-item';
            item.setAttribute('role', 'option');
            item.tabIndex = -1;
            if (option.disabled) item.setAttribute('aria-disabled', 'true');
            const span = doc.createElement('span');
            span.textContent = option.textContent.trim();
            item.append(span);
            item.insertAdjacentHTML('beforeend', CHECK);
            item.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                choose(index);
            });
            item.addEventListener('pointermove', () => { if (!option.disabled && doc.activeElement !== item) item.focus({ preventScroll: true }); });
            items.push(item);
            // 只用来显示当前状态的项（隐藏且不能选，比如 EQ 的「自定义」）：不是当前值时不进菜单
            if (skipRender) return;
            frag.append(item);
        });
        menu.append(frag);
        doc.body.append(menu);
        trigger.setAttribute('aria-expanded', 'true');
        trigger.setAttribute('aria-controls', menu.id);
        trigger.classList.add('mfs-open');
        openState = { select, menu, trigger, items };
        paintSelected();
        place(menu, trigger);
        const current = items[select.selectedIndex] || items.find((i) => i.getAttribute('aria-disabled') !== 'true');
        if (current) {
            menu.scrollTop = Math.max(0, current.offsetTop - menu.clientHeight / 2 + current.offsetHeight / 2);
            current.focus({ preventScroll: true });
        }
        global.MusicFluid?.bud?.(menu, trigger, { duration: 360 });
    }

    function choose(index) {
        if (!openState) return;
        const { select } = openState;
        const option = select.options[index];
        if (!option || option.disabled) return;
        close(true);
        if (select.selectedIndex === index) return;
        select.selectedIndex = index;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function close(restoreFocus) {
        if (!openState) return;
        const { menu, trigger } = openState;
        openState = null;
        trigger.setAttribute('aria-expanded', 'false');
        trigger.removeAttribute('aria-controls');
        trigger.classList.remove('mfs-open');
        const snap = global.MusicFluid?.enabled?.() ? global.MusicFluid.snapshot?.(menu) : null;
        menu.remove();
        if (snap) global.MusicFluid.melt(snap, trigger, { duration: 240 });
        if (restoreFocus && doc.contains(trigger)) trigger.focus({ preventScroll: true });
    }

    // 键盘：上下移动、Home/End、回车或空格选中、Esc 收起、Tab 收起；直接打字跳到开头对得上的那项
    let typed = '', typedAt = 0;
    const onDocKeyDown = (event) => {
        if (!openState) return;
        const { items, menu } = openState;
        const live = items.filter((i) => i.getAttribute('aria-disabled') !== 'true');
        const at = live.indexOf(doc.activeElement);
        const go = (i) => { const t = live[Math.max(0, Math.min(live.length - 1, i))]; t?.focus({ preventScroll: true }); t?.scrollIntoView({ block: 'nearest' }); };
        switch (event.key) {
            case 'ArrowDown': go(at + 1); break;
            case 'ArrowUp': go(at < 0 ? live.length - 1 : at - 1); break;
            case 'Home': go(0); break;
            case 'End': go(live.length - 1); break;
            case 'PageDown': go(at + 8); break;
            case 'PageUp': go(at - 8); break;
            case 'Enter': case ' ':
                if (menu.contains(doc.activeElement)) choose(items.indexOf(doc.activeElement));
                break;
            case 'Escape': if (event.isComposing) return; close(true); break;
            case 'Tab': close(true); return;
            default:
                if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                    const now = Date.now();
                    typed = now - typedAt > 700 ? event.key.toLowerCase() : typed + event.key.toLowerCase();
                    typedAt = now;
                    const hit = live.find((i) => i.textContent.trim().toLowerCase().startsWith(typed));
                    if (hit) go(live.indexOf(hit));
                    break;
                }
                return;
        }
        event.preventDefault();
        event.stopPropagation();
    };
    const onDocPointerDown = (event) => {
        if (!openState) return;
        if (openState.menu.contains(event.target) || openState.trigger.contains(event.target)) return;
        const lbl = event.target?.closest?.('label[for]');
        if (lbl && openState.select.id && lbl.getAttribute('for') === openState.select.id) return;
        close(false);
    };
    // 点关联的 <label for="..."> 时转到自定义按钮，避免点到隐藏的原生 <select> 毫无反应
    const onDocClick = (event) => {
        const lbl = event.target?.closest?.('label[for]');
        if (!lbl) return;
        const forId = lbl.getAttribute('for');
        if (!forId) return;
        const target = doc.getElementById(forId);
        const entry = target && DRESSED.get(target);
        if (!entry || target.disabled || entry.trigger.contains(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        entry.trigger.focus({ preventScroll: true });
        if (openState?.select === target) close(true);
        else open(target);
    };
    const reflow = () => { if (openState) close(false); };
    const onDocScroll = (event) => {
        if (openState && !openState.menu.contains(event.target)) close(false);
    };
    doc.addEventListener('keydown', onDocKeyDown, true);
    doc.addEventListener('pointerdown', onDocPointerDown, true);
    doc.addEventListener('click', onDocClick);
    global.addEventListener('resize', reflow);
    doc.addEventListener('scroll', onDocScroll, true);

    // 页面里已有的和以后插进来的下拉框都换掉（舞台切模式会重建一批）。
    // 跳过叶节点和不可能包含 <select> 的标签，避免列表滚动、搜索敲字、歌词渲染时整棵子树跑 querySelectorAll。
    const LEAF_TAGS = new Set(['IMG', 'SVG', 'CANVAS', 'PATH', 'I', 'BR', 'HR', 'INPUT', 'BUTTON', 'OPTION', 'OPTGROUP', 'A', 'AUDIO', 'VIDEO', 'STYLE', 'SCRIPT', 'LINK']);
    const scan = (root) => {
        if (root.nodeType !== 1 || !root.isConnected) return;
        const tag = root.tagName;
        if (tag === 'SELECT') { dress(root); return; }
        if (!root.firstElementChild || LEAF_TAGS.has(tag)) return;
        if (root.classList?.contains('mfs-menu')) return;
        const selects = root.getElementsByTagName?.('select');
        if (!selects || !selects.length) return;
        for (let i = 0; i < selects.length; i += 1) dress(selects[i]);
    };
    let pending = null;
    const flush = () => { const list = pending; pending = null; list.forEach(scan); };
    const start = () => {
        scan(doc.body);
        const bodyObs = new MutationObserver((records) => {
            for (const r of records) for (const n of r.addedNodes) {
                if (n.nodeType !== 1) continue;
                const tag = n.tagName;
                if (tag !== 'SELECT' && (!n.firstElementChild || LEAF_TAGS.has(tag))) continue;
                if (n.classList?.contains('mfs-trigger') || n.classList?.contains('mfs-menu')) continue;
                if (!pending) { pending = new Set(); queueMicrotask(flush); }
                pending.add(n);
            }
        });
        bodyObs.observe(doc.body, { childList: true, subtree: true });
        global.addEventListener?.('beforeunload', () => {
            close(false);
            bodyObs.disconnect();
            for (const obs of SELECT_OBSERVERS) obs.disconnect();
            SELECT_OBSERVERS.clear();
            doc.removeEventListener('keydown', onDocKeyDown, true);
            doc.removeEventListener('pointerdown', onDocPointerDown, true);
            doc.removeEventListener('click', onDocClick);
            global.removeEventListener('resize', reflow);
            doc.removeEventListener('scroll', onDocScroll, true);
        }, { once: true });
    };
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
    else start();

    global.MusicFluidSelect = Object.freeze({ dress, close: () => close(false) });
})(typeof window !== 'undefined' ? window : globalThis);
