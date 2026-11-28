// Musicmodules/music-dock/music-playlist-picker.js
// 「加入歌单」选择器：点首页顶栏「＋ 加入歌单」、或多选后的批量菜单里「加入歌单…」时弹出的一张小卡片。
// 原来这两处弹的是整张曲目右键菜单（十几项），歌单列表还藏在二级菜单里；这里只给歌单：
//   - 最近加过的歌单排最前；已经含有这首（这几首）的歌单右边打勾，部分含有是一道短横
//   - 歌单多（6 个以上）时顶上有筛选框，打字就筛；筛不到时回车直接用这个名字新建
//   - 最后一行「新建歌单」，点了就地变成输入框，回车建好并加进去
//   - 点一个歌单就加进去并收起，底部 toast 可撤销；点已经打勾的歌单是把这几首拿出来（同样可撤销）
// 卡片材质和行高跟全窗口的下拉一样（music-fluid-kit.css 的 .mf-glass，行高 28）。
//
//   MusicPlaylistPicker.open({ app, paths, anchor, label, onChange, restore })
//     paths   要加的曲目路径（一首或多首）
//     anchor  元素（从它下沿长出来）或 { x, y }
//     label   卡片小标题里显示的歌名 / 「已选 N 首」
//     onChange 歌单改过以后调用（首页用它重排目录和阵列）
//     restore 收起后焦点还给谁（默认 anchor）
(function (global) {
    'use strict';
    const doc = global.document;
    if (!doc) return;

    const RECENT_KEY = 'musicPlaylistRecent';
    const SEARCH_FROM = 6;
    const CHECK = '<svg class="mpp-mark" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="M3.2 8.6l3.1 3 6.5-7.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const PART = '<svg class="mpp-mark" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="M4 8h8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    const PLUS = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    const NOTE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M6 12.2V4.2l7-1.4v8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="4.6" cy="12.2" r="1.6" fill="currentColor"/><circle cx="11.6" cy="10.8" r="1.6" fill="currentColor"/></svg>';

    let current = null; // { menu, close }

    const readRecent = () => {
        try { const v = JSON.parse(global.localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch (_) { return []; }
    };
    const touchRecent = (id) => {
        const list = [String(id), ...readRecent().filter((x) => x !== String(id))].slice(0, 30);
        try { global.localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (_) { /* 存不了就只是不记顺序 */ }
    };

    /* 最近用过的在前（按最近顺序），其余保持歌单原来的顺序 */
    const ordered = (playlists) => {
        const recent = readRecent();
        const rank = (p) => { const k = recent.indexOf(String(p.id)); return k < 0 ? Infinity : k; };
        return playlists.map((p, i) => ({ p, i })).sort((a, b) => (rank(a.p) - rank(b.p)) || (a.i - b.i)).map((x) => x.p);
    };

    const toast = (message, action) => { try { global.MusicToast?.show?.({ id: 'playlist-add', kind: 'success', message, action }); } catch (_) { /* 没有提示层就不提示 */ } };

    function close({ focusBack = true } = {}) {
        if (!current) return;
        const c = current;
        current = null;
        c.teardown();
        const snap = global.MusicFluid?.snapshot?.(c.menu);
        c.menu.remove();
        if (snap && c.anchorEl) global.MusicFluid.melt?.(snap, c.anchorEl, { duration: 220 });
        if (c.anchorEl) c.anchorEl.setAttribute('aria-expanded', 'false');
        if (focusBack && c.restore && c.restore.isConnected) c.restore.focus({ preventScroll: true });
    }

    function open({ app, paths = [], anchor = null, label = '', onChange = null, restore = null } = {}) {
        close({ focusBack: false });
        if (!app) return null;
        const want = [...new Set(paths.filter(Boolean))];
        if (!want.length) return null;
        const anchorEl = anchor && anchor.nodeType === 1 ? anchor : null;
        const playlists = () => (Array.isArray(app.customPlaylists) ? app.customPlaylists : []);

        const commit = () => {
            app.saveCustomPlaylists?.();
            app.refreshPreload?.();
            if (app.currentSidebarView === 'playlists') app.renderSidebarContent?.('playlists');
            try { onChange?.(); } catch (e) { console.warn('[playlist-picker] onChange', e); }
            global.dispatchEvent(new CustomEvent('music-playlists-change'));
        };
        const nameOf = (pl) => pl.name || '未命名歌单';
        const countIn = (pl) => want.reduce((n, p) => n + (pl.tracks.includes(p) ? 1 : 0), 0);

        const add = (pl) => {
            if (!Array.isArray(pl.tracks)) pl.tracks = [];
            const fresh = want.filter((p) => !pl.tracks.includes(p));
            touchRecent(pl.id);
            if (!fresh.length) return;
            pl.tracks.push(...fresh);
            commit();
            toast(want.length > 1 ? `已加入「${nameOf(pl)}」：${fresh.length} 首` : `已加入「${nameOf(pl)}」`,
                { label: '撤销', run: () => { pl.tracks = pl.tracks.filter((p) => !fresh.includes(p)); commit(); } });
        };
        const takeOut = (pl) => {
            const before = pl.tracks.slice();
            pl.tracks = pl.tracks.filter((p) => !want.includes(p));
            commit();
            toast(want.length > 1 ? `已从「${nameOf(pl)}」移出 ${before.length - pl.tracks.length} 首` : `已从「${nameOf(pl)}」移出`,
                { label: '撤销', run: () => { pl.tracks = before; commit(); } });
        };
        const create = (name) => {
            const clean = String(name || '').trim();
            if (!clean) return;
            let id = Date.now().toString();
            while (playlists().some((p) => String(p.id) === id)) id += '1';
            const pl = { id, name: clean, tracks: want.slice() };
            if (Array.isArray(app.customPlaylists)) app.customPlaylists.push(pl);
            else return;
            touchRecent(id);
            commit();
            toast(`已新建歌单「${clean}」${want.length > 1 ? `：${want.length} 首` : ''}`,
                { label: '撤销', run: () => { const k = playlists().indexOf(pl); if (k >= 0) playlists().splice(k, 1); commit(); } });
        };

        const menu = doc.createElement('div');
        // custom-select-dropdown：底栏抽屉认这个类，点在里面不算「点到抽屉外面」
        menu.className = 'mpp mf-glass custom-select-dropdown';
        menu.setAttribute('role', 'dialog');
        menu.setAttribute('aria-label', '加入歌单');
        const head = doc.createElement('div');
        head.className = 'mpp-head';
        head.innerHTML = '<b>加入歌单</b><span></span>';
        head.querySelector('span').textContent = label;
        head.title = label;
        menu.append(head);

        const all = playlists();
        let search = null;
        if (all.length >= SEARCH_FROM) {
            search = doc.createElement('input');
            search.type = 'text';
            search.className = 'mpp-search';
            search.placeholder = '筛选歌单';
            search.setAttribute('aria-label', '筛选歌单');
            search.spellcheck = false;
            menu.append(search);
        }
        const listEl = doc.createElement('div');
        listEl.className = 'mpp-list';
        listEl.setAttribute('role', 'listbox');
        menu.append(listEl);
        const foot = doc.createElement('div');
        foot.className = 'mpp-foot';
        menu.append(foot);

        const row = (cls, html, title) => {
            const el = doc.createElement('div');
            el.className = 'mpp-item ' + cls;
            el.setAttribute('role', 'option');
            el.tabIndex = -1;
            el.innerHTML = html;
            if (title) el.title = title;
            el.addEventListener('pointermove', () => { if (doc.activeElement !== el && doc.activeElement !== search) el.focus({ preventScroll: true }); });
            return el;
        };
        const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

        const renderList = () => {
            const q = search ? search.value.trim().toLowerCase() : '';
            const shown = ordered(playlists()).filter((p) => !q || nameOf(p).toLowerCase().includes(q));
            listEl.innerHTML = '';
            for (const pl of shown) {
                const n = countIn(pl);
                const state = n === 0 ? 'none' : n === want.length ? 'all' : 'some';
                const el = row('mpp-pl', `${NOTE}<span class="mpp-name">${esc(nameOf(pl))}</span><i>${(pl.tracks || []).length}</i>${state === 'all' ? CHECK : state === 'some' ? PART : ''}`,
                    state === 'all' ? `已在「${nameOf(pl)}」里，点一下移出` : `加入「${nameOf(pl)}」`);
                el.dataset.state = state;
                el.setAttribute('aria-selected', state === 'all' ? 'true' : 'false');
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    close();
                    if (state === 'all') takeOut(pl); else add(pl);
                });
                listEl.append(el);
            }
            if (!shown.length) {
                const empty = doc.createElement('div');
                empty.className = 'mpp-empty';
                empty.textContent = q ? `没有叫「${search.value.trim()}」的歌单，回车新建` : '还没有歌单';
                listEl.append(empty);
            }
        };

        const renderFoot = (editing = false) => {
            foot.innerHTML = '';
            if (!editing) {
                const el = row('mpp-new', `${PLUS}<span class="mpp-name">新建歌单</span>`);
                el.addEventListener('click', (e) => { e.stopPropagation(); renderFoot(true); });
                foot.append(el);
                return;
            }
            const input = doc.createElement('input');
            input.type = 'text';
            input.className = 'mpp-search mpp-name-input';
            input.placeholder = '歌单名称，回车创建';
            input.setAttribute('aria-label', '新歌单名称');
            input.spellcheck = false;
            input.value = search && search.value.trim() ? search.value.trim() : '';
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); const v = input.value; if (!v.trim()) return; close(); create(v); }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renderFoot(false); foot.firstChild?.focus({ preventScroll: true }); }
            });
            foot.append(input);
            input.focus({ preventScroll: true });
            input.select();
        };

        renderList();
        renderFoot(false);
        doc.body.append(menu);

        // 位置：从锚点下沿（或点击处）长出来，左对齐，放不下就往上翻、往左挪
        const place = () => {
            const W = global.innerWidth || 1280, H = global.innerHeight || 800;
            const r = anchorEl ? anchorEl.getBoundingClientRect() : { left: anchor?.x || 0, right: anchor?.x || 0, top: anchor?.y || 0, bottom: anchor?.y || 0 };
            const w = menu.offsetWidth || 240;
            const below = H - r.bottom - 12, above = r.top - 12;
            const down = below >= 220 || below >= above;
            const room = Math.max(160, (down ? below : above) - 6);
            menu.style.maxHeight = `${Math.min(440, room)}px`;
            const h = menu.offsetHeight || 200;
            menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, W - w - 8)))}px`;
            menu.style.top = `${Math.round(down ? r.bottom + 6 : Math.max(8, r.top - 6 - h))}px`;
        };
        place();
        if (anchorEl) { anchorEl.setAttribute('aria-haspopup', 'dialog'); anchorEl.setAttribute('aria-expanded', 'true'); }
        global.MusicFluid?.bud?.(menu, anchorEl || anchor, { duration: 320 });

        const focusables = () => [...menu.querySelectorAll('.mpp-item')];
        if (search) {
            search.addEventListener('input', () => { renderList(); place(); });
            search.focus({ preventScroll: true });
        } else focusables()[0]?.focus({ preventScroll: true });

        const onKey = (e) => {
            if (!current || current.menu !== menu) return;
            const items = focusables();
            const at = items.indexOf(doc.activeElement);
            const go = (i) => { const t = items[Math.max(0, Math.min(items.length - 1, i))]; t?.focus({ preventScroll: true }); t?.scrollIntoView?.({ block: 'nearest' }); };
            const inInput = doc.activeElement && doc.activeElement.tagName === 'INPUT';
            switch (e.key) {
                case 'ArrowDown': go(at + 1); break;
                case 'ArrowUp': if (at <= 0 && search) search.focus({ preventScroll: true }); else go(at - 1); break;
                case 'Home': if (inInput) return; go(0); break;
                case 'End': if (inInput) return; go(items.length - 1); break;
                case 'Enter':
                    if (doc.activeElement === search) {
                        const first = listEl.querySelector('.mpp-pl');
                        if (first) first.click();
                        else if (search.value.trim()) { const v = search.value; close(); create(v); }
                    } else if (inInput) return;
                    else if (at >= 0) items[at].click();
                    break;
                case ' ': if (inInput) return; if (at >= 0) items[at].click(); break;
                case 'Escape': close(); break;
                case 'Tab': close(); return;
                default: return;
            }
            e.preventDefault();
            e.stopPropagation();
        };
        const onDown = (e) => {
            if (menu.contains(e.target)) return;
            if (anchorEl && anchorEl.contains(e.target)) { e.stopPropagation(); e.preventDefault(); close(); return; }
            close({ focusBack: false });
        };
        const onResize = () => close({ focusBack: false });
        doc.addEventListener('keydown', onKey, true);
        doc.addEventListener('pointerdown', onDown, true);
        global.addEventListener('resize', onResize);
        global.addEventListener('blur', onResize);
        menu.addEventListener('contextmenu', (e) => e.preventDefault());
        current = {
            menu, anchorEl, restore: restore || anchorEl,
            teardown: () => {
                doc.removeEventListener('keydown', onKey, true);
                doc.removeEventListener('pointerdown', onDown, true);
                global.removeEventListener('resize', onResize);
                global.removeEventListener('blur', onResize);
            }
        };
        return { menu, close };
    }

    global.MusicPlaylistPicker = Object.freeze({ open, close: () => close({ focusBack: false }), isOpen: () => !!current });
})(window);
