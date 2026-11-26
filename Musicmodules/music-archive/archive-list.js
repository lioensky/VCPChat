/*
 * 档案页左侧常驻的「档案目录」列表：顶部检索框，筛选（全部/歌手/专辑/歌单/最近），
 * 按分组的长列表，字直接浮在场景上（不做面板），首字母大字放在左侧外边距并随滚动吸附。
 * 只画看得见的那几十行（虚拟滚动），几千首也一样快。
 * 选中状态和阵列共用：列表里选哪首，阵列相机就跟到那张卡；阵列里换卡，列表滚到那一行。
 */
(function (global) {
    'use strict';

    const LETTER_H = 34;  // 首字母分组的行内小标题（字母 + 首数，上面压一条结构线）
    const EDGE_FADE = 26; // 和 archive-list.css 里 .archive-list-viewport 上下渐隐的高度一致
    const LABEL_H = 40;   // 歌手/专辑/歌单分组的小标题行
    const ROW_H = 48;     // 曲目行高（58 → 52 → 48：去掉表头后行再收一点，两行字上下各留约 6px）
    // 分组标题都在行内（档案目录表的排法），左侧外边距不再放吸附的大字母，也不画跟着它走的液态记号
    const INLINE_HEADS = true;
    const LETTER_PUSH = 78; // 下一组的字母离顶端不到这么远时，把吸附的字母往上推走（避免两个字母叠在一起）
    const OVERSCAN = 8;
    const SORTS = [['title', '标题', 'TITLE'], ['artist', '歌手', 'ARTIST'], ['duration', '时长', 'LENGTH'], ['added', '添加时间', 'ADDED']];
    const BRAND_TITLES = { all: '全部曲目', artist: '歌手', album: '专辑', playlist: '歌单', recent: '为你' };
    const KINDS = [['all', '全部', 'ALL'], ['artist', '歌手', 'ARTIST'], ['album', '专辑', 'ALBUM'], ['playlist', '歌单', 'LIST'], ['recent', '为你', 'FOR YOU']];

    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const fmtTime = (sec) => {
        const s = Number(sec);
        if (!(s > 0)) return '--:--';
        const h = Math.floor(s / 3600);
        return (h ? h + ':' + pad(Math.floor(s / 60) % 60) : pad(Math.floor(s / 60))) + ':' + pad(Math.floor(s % 60));
    };
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // 左上角标题区照原版：上面一行大号粗体是当前在看的那一栏（全部曲目 / 歌手 / …），换栏时上下滚过去；
    // 下面一行小字，原版的品牌字换成过场动画里的 VCP Music 记号。
    // 记号：（庞加莱圆盘：七条测地线隔一个点相连，里面再套一层，裁进圆周）+ 字标。
    // 几何和 music-intro.js 的 buildMark 一样，这里只出静态的 SVG。
    const brandMark = () => {
        const cx = 50, cy = 50, R = 46, w = 4.4, D = R * 1.533;
        const step = Math.PI * 2 / 7, off = -Math.PI / 2;
        const geo = (r, a, b) => {
            const h = (b - a) / 2, ar = r * Math.tan(h);
            const pt = (t) => `${(cx + r * Math.cos(t)).toFixed(2)},${(cy + r * Math.sin(t)).toFixed(2)}`;
            return `M${pt(a)}A${ar.toFixed(2)},${ar.toFixed(2)} 0 0 0 ${pt(b)}`;
        };
        let outer = '', inner = '';
        for (let k = 0; k < 7; k++) {
            outer += geo(D, off + k * step, off + (k + 2) * step);
            inner += geo(D * 0.52, off + (k + 1) * step, off + (k + 3) * step);
        }
        return '<svg class="archive-list-brand-mark" viewBox="0 0 100 100" aria-hidden="true">'
            + '<defs><clipPath id="archive-brand-clip"><circle cx="50" cy="50" r="46"/></clipPath></defs>'
            + `<g clip-path="url(#archive-brand-clip)" fill="none" stroke="currentColor"><path d="${outer}" stroke-width="${(w * 0.62).toFixed(2)}"/><path d="${inner}" stroke-width="${(w * 0.45).toFixed(2)}" opacity=".6"/></g>`
            + `<circle cx="50" cy="50" r="${R}" fill="none" stroke="currentColor" stroke-width="${w}"/><circle cx="50" cy="50" r="${(w * 1.5).toFixed(2)}" fill="currentColor"/></svg>`;
    };
    const TEMPLATE = `
        <div class="archive-list-brand">
            <h1 class="archive-list-brand-title" data-l="brandTitle"><span></span></h1>
            <div class="archive-list-brand-sub">${brandMark()}<span>MUSIC DATABASE</span></div>
        </div>
        <div class="archive-list-toolbar">
            <label class="archive-list-search">
                <span class="archive-glyph-search" aria-hidden="true"></span>
                <input type="search" data-l="input" placeholder="标题、歌手、专辑、拼音首字母" autocomplete="off" spellcheck="false" aria-label="检索曲目" aria-keyshortcuts="/">
                <button type="button" class="archive-list-clear" data-l="clear" aria-label="清除检索" title="清除检索（Esc）"><svg class="archive-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
                <div class="archive-list-recentq mf-glass" data-l="recentQ" role="listbox" aria-label="最近检索" hidden></div>
            </label>
            <div class="archive-list-import" data-l="importTools">
                <button type="button" class="archive-list-import-toggle" data-l="importToggle" aria-label="导入音乐" title="导入音乐" aria-expanded="false" aria-controls="archive-list-import-options"><span aria-hidden="true">+</span></button>
                <div class="archive-list-import-options mf-glass" data-l="importOptions" id="archive-list-import-options" role="group" aria-label="导入方式" hidden>
                    <button type="button" data-act="add-local">添加本地文件夹</button>
                    <button type="button" data-act="add-cloud">从 WebDAV 导入</button>
                </div>
            </div>
        </div>
        <div class="archive-list-kinds" role="tablist" data-l="kinds">
            ${KINDS.map(([k, zh, en]) => `<button type="button" role="tab" data-kind="${k}" title="按${zh === '全部' ? '曲名' : zh}浏览">${zh}</button>`).join('')}
            <span class="archive-list-sort">
                <button type="button" data-l="sortBtn" aria-haspopup="menu" aria-expanded="false" title="排序方式（阵列跟着重排）"><span class="archive-glyph-sort" aria-hidden="true"></span><span data-l="sortName">标题</span></button>
                <span class="archive-list-sort-menu mf-glass" role="menu" data-l="sortMenu" hidden>
                    ${SORTS.map(([k, zh, en]) => `<button type="button" role="menuitemradio" data-sort="${k}" aria-checked="false"><span>${zh}</span></button>`).join('')}
                </span>
            </span>
        </div>
        <div class="archive-list-cols" data-l="cols"><button type="button" data-col="added" title="按添加时间排">编号</button><button type="button" data-col="title" data-l="colTitle" title="按标题排（再点一次按歌手）">曲目 / TITLE</button><button type="button" data-col="duration" title="按时长排">时长 / TIME</button></div>
        <div class="archive-list-newpl" data-l="newPl" hidden><button type="button" data-pl="new">＋ 新建歌单</button></div>
        <div class="archive-list-viewport" data-l="viewport" tabindex="0" role="listbox" aria-label="曲目目录">
            <div class="archive-list-sticky" data-l="sticky" aria-hidden="true"></div>
            <div class="archive-list-spacer" data-l="spacer"></div>
            <div class="archive-list-empty" data-l="empty" role="status"></div>
        </div>
        <div class="archive-list-thumb" data-l="thumb" aria-hidden="true" hidden></div>
        <div class="archive-list-shelf" data-l="shelf" hidden></div>
        <div class="archive-list-foot" aria-live="polite">
            <b data-l="pos">000</b><i data-l="sep">/</i><span data-l="tot">首</span><em data-l="multiNote" hidden></em><button type="button" class="archive-list-smart" data-l="saveSmart" hidden title="把这条检索存成歌单：以后曲库、听歌记录变了，歌单自己跟着变">存为智能歌单</button>
        </div>`;

    /*
     * opts: {
     *   host, app, Index, getIndex(), getRecent(), columnOfGroup(g),
     *   onPick(i, ctx), onPlay(i, ctx, { stage, group }), fileNumber(track, i), isNarrow()
     *   group = { name, items } 是这一行所在的那组（歌手、专辑、最近、检索结果），点播时用它当队列；
     *   全部曲目且没有检索词时不给（按首字母分的组只是索引，队列仍是整个曲库）
     * }
     */
    /* 首字母分组（全部曲目、无检索词）：和其他分组一样做成行内小标题，字母后面跟这一组的首数 */
    const isLetter = (row) => row.type === 'head' && String(row.key || '').startsWith('letter:');
    const letterHtml = (row) => {
        const g = String(row.key).slice(7);
        const text = g === '0-9' ? '0–9' : g === '#' ? '#' : g;
        return `<span class="${text.length > 1 ? 'wide' : ''}">${esc(text)}</span>${row.n > 0 ? `<i>${row.n} 首</i>` : ''}`;
    };


    /*
     * 右键菜单的键盘操作。菜单本身是播放器的 #track-context-menu（几行 div），这里在档案页打开它之后接管按键：
     * ↑ ↓ Home End 移动，Enter / 空格执行，→ 打开「加入歌单」子菜单、← 收回，Esc / Tab 关闭并把焦点还回去。
     * 菜单关掉（visible 类没了）就自动撤掉这些处理。
     * 鼠标右键打开的菜单也会接上（music-menu-order.js 里统一接，focus: false），不然方向键会落到后面的目录上。
     * playlist: true 时直接展开「加入歌单」子菜单（顶栏「＋ 加入歌单」按钮用，和 Spotify 的「添加到歌单」一样直接给歌单列表）。
     */
    const menuKeyboard = (app, { restore = null, playlist = false, focus = true } = {}) => {
        const menu = app.contextMenu || document.getElementById('track-context-menu');
        if (!menu || !menu.classList.contains('visible')) return null;
        // 同一时间只留一份按键处理（鼠标右键接一次、键盘打开又接一次时，后来的顶掉先前的）
        if (typeof menu.__kbdDetach === 'function') menu.__kbdDetach();
        const shown = (el) => !el.hidden && el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
        const topItems = () => [...menu.querySelectorAll(':scope > .context-menu-item')].filter(shown);
        let sub = null; // 打开着的子菜单所在的那一项
        let direct = false; // 一打开就是歌单列表：Esc 直接整个关掉，← 才回到上一层
        const subItems = () => (sub ? [...sub.querySelectorAll('.submenu-item')] : []);
        const items = () => (sub ? subItems() : topItems());
        const prep = (el) => { el.setAttribute('role', 'menuitem'); el.tabIndex = -1; };
        menu.setAttribute('role', 'menu');
        topItems().forEach(prep);
        const focusAt = (k) => { const list = items(); if (list.length) list[(k + list.length) % list.length].focus({ preventScroll: true }); };
        const openSub = (item) => {
            if (!subItemsOf(item).length) return;
            sub = item;
            item.classList.add('archive-kbd-sub');
            subItems().forEach(prep);
            focusAt(0);
        };
        const subItemsOf = (item) => [...item.querySelectorAll('.submenu-item')];
        const closeSub = () => { if (!sub) return; const item = sub; sub = null; item.classList.remove('archive-kbd-sub'); item.focus({ preventScroll: true }); };
        let done = false;
        const finish = ({ focusBack = true } = {}) => {
            if (done) return;
            done = true;
            if (menu.__kbdDetach === detach) menu.__kbdDetach = null;
            document.removeEventListener('keydown', onKey, true);
            observer.disconnect();
            menu.querySelectorAll('.archive-kbd-sub').forEach((el) => el.classList.remove('archive-kbd-sub'));
            if (focusBack && restore && restore.isConnected) restore.focus({ preventScroll: true });
        };
        const detach = () => finish({ focusBack: false });
        menu.__kbdDetach = detach;
        const close = () => { menu.classList.remove('visible'); finish(); };
        const onKey = (e) => {
            if (!menu.classList.contains('visible')) { finish({ focusBack: false }); return; }
            const list = items();
            const at = list.indexOf(document.activeElement);
            switch (e.key) {
                case 'ArrowDown': focusAt(at + 1); break;
                case 'ArrowUp': focusAt(at < 0 ? -1 : at - 1); break;
                case 'Home': focusAt(0); break;
                case 'End': focusAt(-1); break;
                case 'ArrowRight': if (!sub && at >= 0 && list[at].classList.contains('has-submenu')) openSub(list[at]); break;
                case 'ArrowLeft': closeSub(); break;
                case 'Enter': case ' ': {
                    const el = list[at];
                    if (!el) break;
                    if (!sub && el.classList.contains('has-submenu')) { openSub(el); break; }
                    el.click();
                    if (menu.classList.contains('visible')) menu.classList.remove('visible');
                    finish();
                    break;
                }
                case 'Escape': if (sub && !direct) closeSub(); else close(); break;
                case 'Tab': close(); break;
                default: return;
            }
            e.preventDefault();
            e.stopPropagation();
        };
        const observer = new MutationObserver(() => { if (!menu.classList.contains('visible')) finish({ focusBack: false }); });
        observer.observe(menu, { attributes: true, attributeFilter: ['class'] });
        document.addEventListener('keydown', onKey, true);
        const plItem = playlist ? topItems().find((el) => el.classList.contains('has-submenu')) : null;
        if (plItem && subItemsOf(plItem).length) { openSub(plItem); direct = true; }
        else if (plItem) {
            // 还没有歌单：子菜单只露出「暂无歌单」，焦点落到紧跟着的「新建歌单并添加」
            plItem.classList.add('archive-kbd-sub');
            const list = topItems();
            focusAt(Math.min(list.indexOf(plItem) + 1, list.length - 1));
        } else if (focus) focusAt(0);
        // focus: false 是鼠标点开的菜单：先不高亮任何一项，按了方向键才从头（或从尾）开始
        return { close };
    };

    const create = (opts) => {
        const { host, app, Index } = opts;
        const el = document.createElement('section');
        el.className = 'archive-list';
        el.setAttribute('aria-label', '档案目录');
        el.innerHTML = TEMPLATE;
        host.appendChild(el);
        const r = {};
        el.querySelectorAll('[data-l]').forEach((n) => { r[n.dataset.l] = n; });

        /*
         * 手动调宽度（低分辨率窗口里目录占比太大）。
         * 右边缘外侧一条看不见的拖柄：悬停出一道细线，拖动改宽，松手记住；双击恢复默认（不存宽度时完全是原来的 CSS 宽度）。
         * 宽度最小 290、最大 560 且不超过整页的 45%。改宽时发一次 resize，让卡片阵列、封面墙、歌词按新宽度让位。
         */
        const WIDTH_KEY = 'musicArchiveListWidth';
        const W_MIN = 290, W_MAX = 560;
        const grip = document.createElement('div');
        grip.className = 'archive-list-grip';
        grip.tabIndex = 0;
        grip.setAttribute('role', 'separator');
        grip.setAttribute('aria-orientation', 'vertical');
        grip.setAttribute('aria-label', '调整目录宽度');
        grip.title = '拖动调整目录宽度，双击恢复默认';
        el.appendChild(grip);
        const hostWidth = () => (el.offsetParent || el.parentElement)?.clientWidth || global.innerWidth || 1280;
        const clampW = (w) => Math.round(Math.max(W_MIN, Math.min(W_MAX, hostWidth() * 0.45, w)));
        let relayoutRaf = 0;
        const relayout = () => {
            if (relayoutRaf) return;
            relayoutRaf = requestAnimationFrame(() => { relayoutRaf = 0; global.dispatchEvent(new Event('resize')); });
        };
        const applyWidth = (w, { save = false } = {}) => {
            if (w == null) {
                el.classList.remove('user-w');
                el.style.removeProperty('--list-w-user');
                if (save) { try { localStorage.removeItem(WIDTH_KEY); } catch (_) { /* 存不了就只管这次 */ } }
            } else {
                const v = clampW(w);
                el.classList.add('user-w');
                el.style.setProperty('--list-w-user', v + 'px');
                grip.setAttribute('aria-valuenow', String(v));
                if (save) { try { localStorage.setItem(WIDTH_KEY, String(v)); } catch (_) { /* 同上 */ } }
            }
            relayout();
        };
        // 目录被拖窄时，分类那一行收紧间距、去掉斜线，免得和右端的排序/搜索/添加图标挤在一起。
        const paintSlim = () => el.classList.toggle('slim', el.offsetWidth > 0 && el.offsetWidth < 340);
        if (typeof global.ResizeObserver === 'function') new global.ResizeObserver(paintSlim).observe(el);
        try {
            const saved = Number(localStorage.getItem(WIDTH_KEY));
            if (saved > 0) applyWidth(saved);
        } catch (_) { /* 读不到就用默认宽度 */ }
        grip.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const rect = el.getBoundingClientRect();
            const scale = el.offsetWidth ? rect.width / el.offsetWidth : 1; // 首页整体可能被缩放
            const startX = e.clientX, startW = el.offsetWidth;
            grip.setPointerCapture?.(e.pointerId);
            el.classList.add('resizing');
            const move = (ev) => applyWidth(startW + (ev.clientX - startX) / (scale || 1));
            const up = () => {
                grip.removeEventListener('pointermove', move);
                grip.removeEventListener('pointerup', up);
                grip.removeEventListener('pointercancel', up);
                el.classList.remove('resizing');
                applyWidth(el.offsetWidth, { save: true });
            };
            grip.addEventListener('pointermove', move);
            grip.addEventListener('pointerup', up);
            grip.addEventListener('pointercancel', up);
        });
        grip.addEventListener('dblclick', (e) => { e.stopPropagation(); applyWidth(null, { save: true }); });
        grip.addEventListener('keydown', (e) => {
            const step = e.shiftKey ? 48 : 16;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                e.stopPropagation(); // 别再被底栏当成切歌/快进
                applyWidth(el.offsetWidth + (e.key === 'ArrowRight' ? step : -step), { save: true });
            } else if (e.key === 'Home' || e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                applyWidth(null, { save: true });
            }
        });
        for (const t of ['click', 'contextmenu', 'wheel']) grip.addEventListener(t, (e) => e.stopPropagation());

        /*
         * 最近检索：检索后真的播了结果，才记下这个检索词（和 Spotify 一样，只是打字不算）。
         * 检索框聚焦且为空时在下面列出最近 8 条，点一条就重新检索，叉号删一条，「清除」全删。
         * 只是这台机器上的方便，存在 localStorage 里。
         */
        const RECENT_Q_KEY = 'musicArchiveRecentQueries';
        const RECENT_Q_MAX = 8;
        const readRecentQ = () => { try { const v = JSON.parse(localStorage.getItem(RECENT_Q_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).slice(0, RECENT_Q_MAX) : []; } catch (e) { return []; } };
        const writeRecentQ = (list) => { try { localStorage.setItem(RECENT_Q_KEY, JSON.stringify(list.slice(0, RECENT_Q_MAX))); } catch (e) { /* 存不了就算了 */ } };
        const rememberQuery = () => {
            const q = String(state?.query || '').trim();
            if (!q) return;
            writeRecentQ([q, ...readRecentQ().filter((x) => x.toLowerCase() !== q.toLowerCase())]);
        };
        const paintRecentQ = () => {
            const box = r.recentQ;
            if (!box) return;
            const list = readRecentQ();
            const show = document.activeElement === r.input && !r.input.value.trim() && list.length > 0;
            box.hidden = !show;
            if (!show) return;
            box.innerHTML = '<header><span>最近检索</span><button type="button" data-rq-clear>清除</button></header>'
                + list.map((q, n) => `<div class="rq" role="option" data-rq="${n}"><span>${esc(q)}</span><button type="button" data-rq-del="${n}" aria-label="删除这条" title="删除这条"><svg class="archive-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`).join('');
        };
        // 目录里「为你 · 每日推荐」那一节对应阵列的 daily 列，告诉阵列时换成列 id
        const columnCtx = (ctx) => (ctx === 'recent:daily' ? 'daily' : ctx);
        const play = (i, ctx, ...rest) => { rememberQuery(); return opts.onPlay(i, columnCtx(ctx), ...rest); };

        const state = {
            kind: 'all',
            query: '',
            rows: [],
            offsets: [],
            heads: [],          // 分组标题在 rows 里的下标
            count: 0,
            lastReported: '', lastCount: -1,
            selected: -1,       // 曲库下标
            selectedRow: -1,    // rows 里的下标
            rendered: new Map(),
            ord: [],
            dirty: true,
            raf: 0,
            playing: -1
        };
        try { state.kind = localStorage.getItem('musicArchiveListKind') || 'all'; } catch (e) { /* 默认全部 */ }
        if (!KINDS.some(([k]) => k === state.kind)) state.kind = 'all';

        const tracks = () => (Array.isArray(app.playlist) ? app.playlist : []);
        // 时长：扫描器给的 duration，没有就用播放过后记下的；都没有就不显示
        const durationOf = (t, i) => (Number(t && t.duration) > 0 ? Number(t.duration) : Number(opts.durationOf?.(t, i)) || 0);

        /*
         * steady：曲库只是变多了（扫描途中一批批进来）。这时不把目录拉回选中行，
         * 而是让眼前最上面那首歌留在原来的位置，上面多出来的歌不把正在看的内容顶走。
         */
        // 选中的筛选下面那一道液态的线：换筛选时像一滴流过去（共用套件里的 slide），只量文字本身，不含前面的分隔号
        const placeKindMark = () => {
            const box = el.querySelector('[data-l="kinds"]');
            const on = box?.querySelector('[data-kind].on');
            if (!box || !on || !on.firstChild || !global.MusicFluid?.slide) return;
            let mark = box.querySelector('.archive-kind-mark');
            if (!mark) {
                mark = document.createElement('i');
                mark.className = 'archive-kind-mark';
                mark.setAttribute('aria-hidden', 'true');
                box.appendChild(mark);
            }
            const range = document.createRange();
            range.selectNodeContents(on);
            const t = range.getBoundingClientRect();
            const b = box.getBoundingClientRect();
            if (!t.width || !b.width) return;
            // 档案页整体可能被缩放过：量出来的是屏幕上的尺寸，换回这一层自己的像素
            const k = box.offsetWidth / b.width || 1;
            global.MusicFluid.slide(mark, { left: (t.left - b.left) * k, width: t.width * k }, { key: 'archive-kinds' });
        };
        // 目录收起时量不到宽度；展开、窗口变宽窄、字体换好时再落一次位
        if (typeof global.ResizeObserver === 'function' && r.kinds) new global.ResizeObserver(() => placeKindMark()).observe(r.kinds);
        // 「为你」：最近播放后面接每日推荐、最常听、很久没听、还没听过（听歌记录 music-stats.js + 挑歌 music-radio.js）
        const statsSections = () => {
            const stats = app.musicStats;
            const idxOf = (list) => list.map((t) => tracks().indexOf(t)).filter((i) => i >= 0);
            // 每日推荐不依赖听歌记录（没有记录时按曲库挑），先放上
            const daily = { label: '每日推荐', key: 'recent:daily', items: app.dailyMix ? idxOf(app.dailyMix()) : [] };
            if (!stats) return [daily];
            const byPath = new Map();
            tracks().forEach((t, i) => { const k = String(t && t.path || '').replace(/\\/g, '/').toLowerCase(); if (k && !byPath.has(k)) byPath.set(k, i); });
            const idx = (paths) => paths.map((p) => byPath.get(String(p).replace(/\\/g, '/').toLowerCase())).filter((i) => i !== undefined);
            return [
                daily,
                { label: '最常听', key: 'recent:top', items: idx(stats.top(30)) },
                { label: '很久没听', key: 'recent:forgotten', items: idx(stats.forgotten({ limit: 30 })) },
                { label: '还没听过', key: 'recent:new', items: app.neverPlayed ? idxOf(app.neverPlayed()) : [] }
            ];
        };
        const rebuild = ({ steady = false } = {}) => {
            const index = opts.getIndex();
            if (!index) return;
            let anchor = null;
            if (steady && state.rows.length && state.selectedRow >= 0 && inView(state.selectedRow) && state.rows[state.selectedRow]) {
                // 选中的那行就在眼前：让它留在原处（启动时曲库一批批进来，目录不该漂到别的字母去）
                const row = state.rows[state.selectedRow];
                anchor = { i: row.i, ctx: row.ctx, dy: state.offsets[state.selectedRow] - r.viewport.scrollTop };
            } else if (steady && state.rows.length) {
                const top = r.viewport.scrollTop;
                for (let k = 0; k < state.rows.length; k++) {
                    if (state.offsets[k] < top || state.rows[k].type !== 'track') continue;
                    anchor = { i: state.rows[k].i, ctx: state.rows[k].ctx, dy: state.offsets[k] - top };
                    break;
                }
            }
            const out = Index.listRows({
                tracks: tracks(), playlists: app.customPlaylists, recent: opts.getRecent(), sections: state.kind === 'recent' ? statsSections() : [], index,
                kind: state.kind, query: state.query, columnOfGroup: opts.columnOfGroup, spec: opts.getSpec?.() || null
            });
            state.rows = out.rows;
            state.count = out.count;
            // 检索时栏名写检索词本身：下面分组头已经写着「检索结果 N 首」，栏名再写一遍是重复
            setBrand(state.query.trim() ? `「${state.query.trim()}」` : (BRAND_TITLES[state.kind] || '全部曲目'));
            state.offsets = new Array(out.rows.length + 1);
            state.ord = new Array(out.rows.length);
            state.ordWidth = Math.max(2, String(out.count || 0).length);
            el.style.setProperty('--no-digits', String(state.ordWidth));
            state.heads = [];
            let y = 0;
            let nth = 0;
            out.rows.forEach((row, k) => {
                state.offsets[k] = y;
                if (row.type === 'track') state.ord[k] = ++nth;
                if (row.type === 'head') state.heads.push(k);
                y += row.type === 'head' ? (isLetter(row) ? LETTER_H : LABEL_H) : ROW_H;
            });
            state.offsets[out.rows.length] = y;
            r.spacer.style.height = y + 'px';
            r.empty.style.display = out.count ? 'none' : 'block';
            el.classList.toggle('no-rows', !out.count);
            if (!out.count) setFoot(0, 0);   // 没有结果时 render 不会走到计数那里，别留着上一次的数
            // 告诉档案页当前检索词和结果数（左上标题跟着显示）
            const q0 = state.query.trim();
            // 有检索词、有结果时给「存为智能歌单」（多选时让给多选说明）
            r.saveSmart.hidden = !(q0 && out.count && app.createSmartPlaylist) || multi.size > 1;
            if (q0 !== state.lastReported || out.count !== state.lastCount) { state.lastReported = q0; state.lastCount = out.count; opts.onResults?.(q0, out.count, out.rows.find((row) => row.type === 'track') || null); }
            if (!out.count) {
                // 空的原因不同，说法也不同：没搜到、曲库是空的、还没有歌单、还没播过
                const q = state.query.trim();
                const [line, hint] = q ? ['没有找到「' + q + '」', 'Esc 清除检索']
                    : !tracks().length ? ['曲库里还没有歌曲', '']
                    : state.kind === 'playlist' ? [out.rows.length ? '歌单里还没有歌' : '还没有歌单', '在曲目上右键 → 加入歌单']
                    : state.kind === 'recent' ? ['还没有播放记录', '播放过的歌会排在这里']
                    : ['这里还没有曲目', ''];
                r.empty.innerHTML = `<span>${esc(line)}</span>${hint ? `<i>${esc(hint)}</i>` : ''}`;
            }
            manage.confirm = null;
            r.newPl.hidden = state.kind !== 'playlist' || Boolean(state.query.trim());
            el.querySelectorAll('[data-kind]').forEach((b) => {
                const on = b.dataset.kind === state.kind;
                b.classList.toggle('on', on);
                b.setAttribute('aria-selected', String(on));
            });
            placeKindMark();
            // 歌单、为你、检索结果有自己的顺序，不跟排序菜单走；表头按这个决定标不标排序列
            el.dataset.kind = state.query.trim() ? 'search' : state.kind;
            paintSort();
            for (const node of state.rendered.values()) node.remove();
            state.rendered.clear();
            if (multi.size) {
                // 重排后还在的才留着
                const alive = new Set(state.rows.filter((row) => row.type === 'track').map(keyOf));
                for (const key of [...multi]) if (!alive.has(key)) multi.delete(key);
                multiAnchor = -1;
                r.multiNote.hidden = multi.size < 2;
                r.multiNote.textContent = multi.size < 2 ? '' : `已选 ${multi.size} 首 · 右键或菜单键操作 · ESC 取消`;
                el.classList.toggle('has-multi', multi.size > 1);
            }
            state.selectedRow = findRow(state.selected, state.preferCtx);
            // 重排后（比如拼音表加载好、分组变了）选中行可能跑到视野外，拉回来
            if (steady) {
                const k = anchor ? findRow(anchor.i, anchor.ctx) : -1;
                if (k >= 0) r.viewport.scrollTop = Math.max(0, state.offsets[k] - anchor.dy);
            } else if (state.selectedRow >= 0 && !inView(state.selectedRow)) scrollToRow(state.selectedRow, { center: true });
            render();
        };

        /* 二分找 y 所在的行 */
        const rowAt = (y) => {
            let lo = 0, hi = state.rows.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (state.offsets[mid] <= y) lo = mid; else hi = mid - 1;
            }
            return lo;
        };

        /*
         * 检索时把命中的字标出来（字面命中才标；拼音首字母这类命中不标，免得标错位置）。
         * 检索词按空格拆开，每段各自标；大小写不分。
         */
        const markHit = (text) => {
            const words = state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
            if (!words.length) return esc(text);
            const low = String(text).toLowerCase();
            const hit = new Uint8Array(low.length);
            for (const w of words) {
                for (let at = low.indexOf(w); at !== -1; at = low.indexOf(w, at + w.length)) hit.fill(1, at, at + w.length);
            }
            let out = '';
            for (let a = 0; a < low.length;) {
                let b = a;
                while (b < low.length && hit[b] === hit[a]) b++;
                const part = esc(String(text).slice(a, b));
                out += hit[a] ? `<mark>${part}</mark>` : part;
                a = b;
            }
            return out;
        };
        /* 分组标题上「播放这一组」：歌手、专辑、歌单、检索结果都有；首字母分隔和「全部」没有 */
        const groupPlayable = (row) => row && row.type === 'head' && !isLetter(row) && state.kind !== 'all';

        // 分组总时长（专辑、歌手、歌单的头上那样「12 首 · 48 分钟」）；有的歌还没量出时长就写「约」
        const groupLength = (k) => {
            let sum = 0, known = 0, n = 0;
            for (let j = k + 1; j < state.rows.length && state.rows[j].type === 'track'; j++) {
                n++;
                const d = durationOf(tracks()[state.rows[j].i], state.rows[j].i);
                if (d > 0) { sum += d; known++; }
            }
            if (!known || known < n / 2) return '';
            const min = Math.max(1, Math.round(sum / 60));
            const text = min < 60 ? min + ' 分钟' : Math.floor(min / 60) + ' 小时' + (min % 60 ? ' ' + (min % 60) + ' 分' : '');
            return (known < n ? '约 ' : '') + text;
        };
        const rowHtml = (row, k) => {
            if (row.type === 'head') {
                if (isLetter(row)) return letterHtml(row);
                const pl = playlistOfHead(row);
                if (pl && manage.confirm === String(pl.id)) {
                    return `<span>删除「${esc(pl.name)}」？</span><button type="button" data-pl="delete-yes">删除</button><button type="button" data-pl="delete-no">取消</button>`;
                }
                const gp = groupPlayable(row) ? `<button type="button" class="gplay" data-gplay title="播放这一组（${row.n} 首）" aria-label="播放这一组"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.6v8.8L10.2 6z"/></svg>播放</button>` : '';
                const len = groupLength(k);
                // 组长导轨：长度按首数取对数，三首和三千首的组都看得出差别
                const rail = row.n > 0 ? Math.log1p(row.n) / Math.log1p(Math.max(row.n, tracks().length || 1)) : 0;
                return `<span>${esc(row.label)}</span><i title="${row.n} 首${len ? ' · ' + len : ''}">${row.n} 首${len ? `<small> · ${len}</small>` : ''}</i><b class="rail" aria-hidden="true" style="--rail:${rail.toFixed(3)}"></b>${gp}`
                    + (pl ? '<span class="acts"><button type="button" data-pl="rename" title="重命名歌单" aria-label="重命名歌单"><svg class="archive-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4"/></svg></button><button type="button" data-pl="delete" title="删除歌单" aria-label="删除歌单"><svg class="archive-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span>' : '');
            }
            const t = tracks()[row.i] || {};
            const meta = [t.artist, t.album].filter(Boolean).join(' · ') || '未知歌手';
            const title = String(t.title || '').replace(/\.(mp3|flac|wav|ogg|m4a|aac|opus|ape|wma|alac|aiff?|dsf|dff)$/i, '') || '未知标题';
            const time = durationOf(t, row.i);
            const liked = typeof app.isLiked === 'function' && app.isLiked(t);
            return `<span class="no" aria-hidden="true">${pad(state.ord?.[k] || 0, state.ordWidth || 2)}</span>`
                + '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>'
                + '<button type="button" class="go" data-go tabindex="-1" aria-label="播放"><svg viewBox="0 0 12 12" aria-hidden="true"><path class="go-play" d="M3 1.6v8.8L10.2 6z"/><path class="go-pause" d="M2.6 1.8h2.4v8.4H2.6zM7 1.8h2.4v8.4H7z"/></svg></button>'
                + `<span class="tx"><b>${markHit(title)}</b><em>${markHit(meta)}</em></span>`
                + `<span class="rt">${liked ? '<s class="lk" title="喜欢" aria-label="喜欢">♥</s>' : ''}${time > 0 ? `<i>${fmtTime(time)}</i>` : ''}</span>`;
        };

        /*
         * 多选：Ctrl（⌘）点一行加进或拿出，Shift 点选一段，Ctrl+A 全选，Esc 取消；普通单击回到单选。
         * 选中多首时右键（或菜单键）打开批量菜单：下一首播放、加入队列、加入歌单、移除。拖动其中一行就是拖这几首。
         */
        const multi = new Set();
        let multiAnchor = -1;
        const keyOf = (row) => row.i + '|' + (row.ctx || '');
        const pickedRows = () => state.rows.filter((row) => row.type === 'track' && multi.has(keyOf(row)));
        const pickedIndices = (row) => {
            if (multi.size > 1 && (!row || multi.has(keyOf(row)))) return [...new Set(pickedRows().map((x) => x.i))];
            return row ? [row.i] : [];
        };
        const paintMulti = () => {
            const n = multi.size;
            r.multiNote.hidden = n < 2;
            r.multiNote.textContent = n < 2 ? '' : `已选 ${n} 首 · 右键或菜单键操作 · ESC 取消`;
            el.classList.toggle('has-multi', n > 1);
            for (const [k, node] of state.rendered) paintRow(node, state.rows[k], k);
        };
        const clearMulti = () => { if (!multi.size) return false; multi.clear(); paintMulti(); return true; };
        const clickRow = (k, e) => {
            const row = state.rows[k];
            if (!row || row.type !== 'track') return;
            if (e.shiftKey) {
                const from = multiAnchor >= 0 && multiAnchor < state.rows.length ? multiAnchor : (state.selectedRow >= 0 ? state.selectedRow : k);
                if (!(e.ctrlKey || e.metaKey)) multi.clear();
                for (let j = Math.min(from, k); j <= Math.max(from, k); j++) if (state.rows[j].type === 'track') multi.add(keyOf(state.rows[j]));
                paintMulti();
                return;
            }
            if (e.ctrlKey || e.metaKey) {
                // 第一次按住 Ctrl 点别的行：原来单选的那一行也算在内
                if (!multi.size && state.selectedRow >= 0 && state.selectedRow !== k) multi.add(keyOf(state.rows[state.selectedRow]));
                const key = keyOf(row);
                if (multi.has(key)) multi.delete(key); else multi.add(key);
                multiAnchor = k;
                paintMulti();
                return;
            }
            multiAnchor = k;
            clearMulti();
            pickRow(k);
        };

        const fullName = (t) => {
            if (!t) return '';
            const title = String(t.title || '').replace(/\.(mp3|flac|wav|ogg|m4a|aac|opus|ape|wma|alac|aiff?|dsf|dff)$/i, '') || '未知标题';
            const meta = [t.artist, t.album].filter(Boolean).join(' · ');
            const s = app.musicStats?.get?.(t);
            let heard = '';
            if (s && s.plays > 0) {
                const days = Math.floor((Date.now() - s.last) / 86400000);
                const when = days <= 0 ? '今天' : days === 1 ? '昨天' : days < 30 ? days + ' 天前' : new Date(s.last).toLocaleDateString('zh-CN');
                heard = `听过 ${s.plays} 次 · 上次${when}`;
            }
            return [title, meta, heard].filter(Boolean).join('\n');
        };
        /* 哪些分组标题下有正在放的歌：按「正在放的那首 + 这一版目录」缓存，滚动时不重复扫 */
        let liveCache = { playing: null, rows: null, heads: new Set() };
        const playingHeads = () => {
            if (liveCache.playing === state.playing && liveCache.rows === state.rows) return liveCache.heads;
            const heads = new Set();
            if (state.playing >= 0) {
                let h = -1;
                for (let j = 0; j < state.rows.length; j++) {
                    const row = state.rows[j];
                    if (row.type === 'head') { if (!isLetter(row)) h = j; continue; }
                    if (row.i === state.playing && h >= 0) heads.add(h);
                }
            }
            liveCache = { playing: state.playing, rows: state.rows, heads };
            return heads;
        };
        const paintRow = (node, row, k) => {
            const on = k === state.selectedRow;
            node.classList.toggle('on', on);
            const current = row.type === 'track' && row.i === state.playing;
            node.classList.toggle('current', current);
            node.classList.toggle('playing', current && Boolean(app.isPlaying));
            if (row.type === 'head') {
                node.classList.toggle('stuck', k === state.stuck);
                // 正在放的歌在这一组里：组标题前亮一个小点（和 Spotify 侧栏里正在放的歌单一样）
                const live = !isLetter(row) && playingHeads().has(k);
                node.classList.toggle('has-playing', live);
                node.classList.toggle('live-on', live && Boolean(app.isPlaying));
            }
            if (row.type === 'track') {
                const failed = app.failedTracks instanceof Map ? app.failedTracks.get(tracks()[row.i]) : null;
                node.classList.toggle('bad', Boolean(failed));
                // 悬停看完整的歌名、歌手、专辑（窄目录里常被省略号截掉）
                if (failed) node.title = `上次没能播放：${failed}`; else node.title = fullName(tracks()[row.i]);
                const picked = multi.size > 0 && multi.has(keyOf(row));
                node.classList.toggle('picked', picked);
                node.setAttribute('aria-selected', String(on || picked));
            }
        };

        const render = () => {
            state.raf = 0;
            if (!el.isConnected || el.hidden) return;
            const top = r.viewport.scrollTop;
            // 滚在最上面时顶上没有东西可淡出，第一行不该被遮淡
            r.viewport.classList.toggle('at-top', top <= 1);
            const h = r.viewport.clientHeight || 600;
            // 滚到底时最后一行也不该被下沿渐隐遮淡
            r.viewport.classList.toggle('at-bottom', top + h >= r.viewport.scrollHeight - 1);
            syncThumb(top, h);
            if (!state.rows.length) { r.sticky.textContent = ''; return; }
            const first = Math.max(0, rowAt(top) - OVERSCAN);
            const last = Math.min(state.rows.length - 1, rowAt(top + h) + OVERSCAN);
            for (const [k, node] of state.rendered) {
                if (k < first || k > last) { node.remove(); state.rendered.delete(k); }
            }
            // 吸附的首字母：当前可见第一行所属的分组（只有首字母分组才吸附）
            let headK = -1;
            for (const hk of state.heads) { if (state.offsets[hk] <= top + 1) headK = hk; else break; }
            if (headK === -1 && state.heads.length) headK = state.heads[0];
            const stuckRow = state.rows[headK];
            state.stuck = stuckRow && isLetter(stuckRow) ? headK : -1;
            for (let k = first; k <= last; k++) {
                const row = state.rows[k];
                let node = state.rendered.get(k);
                if (!node) {
                    node = document.createElement('div');
                    node.className = row.type === 'track' ? 'archive-list-row' : isLetter(row) ? 'archive-list-letter' : 'archive-list-group';
                    node.dataset.k = k;
                    if (row.type === 'track') {
                        node.setAttribute('role', 'option');
                        // 下面紧跟分组标题的那一行不画底线，免得和标题的结构线叠成两道
                        if (state.rows[k + 1]?.type === 'head') node.classList.add('before-head');
                    }
                    else if (playlistOfHead(row)) node.classList.add('is-playlist');
                    node.style.transform = `translateY(${state.offsets[k]}px)`;
                    node.innerHTML = rowHtml(row, k);
                    r.spacer.appendChild(node);
                    state.rendered.set(k, node);
                }
                paintRow(node, row, k);
            }
            // 吸附字母停在顶上，下一组的字母顶上来时把它推上去
            let stickyY = null;
            if (state.stuck === -1 || INLINE_HEADS) {
                r.sticky.style.visibility = 'hidden';
            } else {
                r.sticky.style.visibility = '';
                const html = letterHtml(stuckRow);
                if (r.sticky.innerHTML !== html) r.sticky.innerHTML = html;
                const nextHead = state.heads.find((hk) => hk > headK);
                const y = Math.max(top, state.offsets[headK]);
                const push = nextHead !== undefined ? Math.min(0, state.offsets[nextHead] - y - LETTER_PUSH) : 0;
                r.sticky.style.transform = `translateY(${y + push}px)`;
                stickyY = y + push;
            }
            syncDrop(headK, top, stickyY);
            const sel = state.selectedRow;
            setFoot(sel >= 0 ? state.ord[sel] || 0 : 0, state.count);
        };
        // 标题换字：旧字往上滚走、新字从下面滚上来（降低动态时直接换）
        function setBrand(text) {
            const box = r.brandTitle;
            if (!box) return;
            const cur = box.lastElementChild;
            if (cur && cur.textContent === text && !cur.classList.contains('out')) return;
            // 打字时检索词一直在变，只换字不滚动；系统或设置里减少动效时也直接换
            const typing = cur && cur.textContent.startsWith('「') && text.startsWith('「');
            const reduce = typing || !cur || !cur.textContent || document.body.classList.contains('music-reduce-motion')
                || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
            box.querySelectorAll('.out').forEach((n) => n.remove());
            const next = document.createElement('span');
            next.textContent = text;
            if (text.startsWith('「')) next.classList.add('q'); // 全角括号左半边是空白，靠 CSS 往左挂出去，字和下面对齐
            if (reduce) { box.replaceChildren(next); return; }
            cur.classList.add('out');
            next.classList.add('in');
            box.appendChild(next);
            setTimeout(() => cur.remove(), 420);
        }
        const schedule = () => { if (!state.raf) state.raf = requestAnimationFrame(render); };
        // 底部计数：选中了一首是「012 / 120」；没选中时不放「--- / 120」这种占位，直接说「120 首」
        function setFoot(nth, count) {
            const idle = !(nth > 0);
            r.pos.textContent = pad(idle ? count : nth, 3);
            r.sep.hidden = idle;
            r.tot.textContent = idle ? '首' : pad(count, 3);
            r.pos.parentElement.classList.toggle('idle', idle);
            // 检索没有结果时标题已经写了「没有结果」，底部不再摆一个「000 首」
            r.pos.parentElement.classList.toggle('zero', !(count > 0));
        }

        /* 右边的细滚动条：看得出目录有多长、现在在哪，也可以直接拖 */
        const THUMB_PAD = [56, 30]; // 目录上下两头是渐隐的，滚动条不伸进去
        const thumbGeo = (h) => {
            const total = state.rows.length ? state.offsets[state.rows.length - 1] + ROW_H : 0;
            const track = h - THUMB_PAD[0] - THUMB_PAD[1];
            if (total <= h + 4 || track < 60) return null;
            const size = Math.max(32, track * h / total);
            return { total, track, size, range: total - h };
        };
        let thumbKey = '';
        const syncThumb = (top, h) => {
            const g = thumbGeo(h);
            const y = g ? Math.round((r.viewport.offsetTop || 0) + THUMB_PAD[0] + (g.track - g.size) * Math.min(1, top / g.range)) : -1;
            const key = g ? Math.round(g.size) + ':' + y : '';
            if (key === thumbKey) return;
            thumbKey = key;
            r.thumb.hidden = !g;
            if (g) {
                r.thumb.style.height = Math.round(g.size) + 'px';
                r.thumb.style.transform = `translateY(${y}px)`;
                // 淡轨道画在滑块的 ::before 上：从轨道顶端到底端，跟着滑块位置反向偏移
                r.thumb.style.setProperty('--thumb-top', (y - Math.round((r.viewport.offsetTop || 0) + THUMB_PAD[0])) + 'px');
                r.thumb.style.setProperty('--thumb-track', Math.round(g.track) + 'px');
            }
        };
        let thumbDrag = null;
        const onThumbMove = (e) => {
            if (!thumbDrag) return;
            const g = thumbGeo(r.viewport.clientHeight || 600);
            if (!g) return;
            r.viewport.scrollTop = thumbDrag.top + ((e.clientY - thumbDrag.y) / thumbDrag.scale) * g.range / Math.max(1, g.track - g.size);
            schedule();
        };
        const onThumbEnd = () => {
            thumbDrag = null;
            el.classList.remove('thumbing');
            document.removeEventListener('pointermove', onThumbMove);
            document.removeEventListener('pointerup', onThumbEnd);
            document.removeEventListener('pointercancel', onThumbEnd);
        };
        r.thumb.addEventListener('pointerdown', (e) => {
            if ((e.button || 0) !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const hgt = r.viewport.offsetHeight;
            thumbDrag = { y: e.clientY, top: r.viewport.scrollTop, scale: hgt ? (r.viewport.getBoundingClientRect().height / hgt) || 1 : 1 };
            el.classList.add('thumbing');
            document.addEventListener('pointermove', onThumbMove);
            document.addEventListener('pointerup', onThumbEnd);
            document.addEventListener('pointercancel', onThumbEnd);
        });

        /*
         * 字母轴上的流体小滴（有底栏的流体标记模块时）：停在当前组的首字母旁边，
         * 滚得快时拉出细颈；其他组的首字母离当前组越远越淡（data-md-dist）。
         */
        let drop = null;
        let dropAt = null;
        let lastScroll = null;
        const syncDrop = (headK, top, stickyY) => {
            if (INLINE_HEADS || typeof global.createMusicFluidMarker !== 'function') return;
            // 一下跳出一屏以外（换排序、键盘跳到很远的一首）：小滴不拖着长颈飞过去，直接落在新位置
            const far = Boolean(drop && lastScroll && Math.abs(top - lastScroll.top) > (r.viewport.clientHeight || 600));
            if (!drop) {
                drop = global.createMusicFluidMarker(r.viewport, { axis: 'y', thickness: 5, align: 'start', inset: 2 });
                if (drop) el.classList.add('has-drop');
            }
            if (!drop) return;
            const now = performance.now();
            if (far) drop.setVelocity(0);
            else if (lastScroll && now > lastScroll.t) drop.setVelocity(Math.max(-80, Math.min(80, (top - lastScroll.top) / ROW_H / ((now - lastScroll.t) / 1000))));
            lastScroll = { t: now, top };
            const at = state.heads.indexOf(headK);
            for (const [k, node] of state.rendered) {
                if (!node.classList.contains('archive-list-letter')) continue;
                const hi = state.heads.indexOf(k);
                node.dataset.mdDist = String(at < 0 || hi < 0 ? 4 : Math.min(4, Math.abs(hi - at)));
            }
            // 用内容坐标（不用元素的屏幕矩形：HUD 整体缩放过，屏幕像素和内容像素对不上）
            // 位置没变就不叫它（每叫一次它都会排一帧）
            const wide = Boolean(r.sticky.querySelector('.wide'));
            const at2 = stickyY === null ? 'off' : stickyY + (wide ? 'w' : 'n');
            if (at2 === dropAt) return;
            dropAt = at2;
            if (stickyY === null) { drop.moveTo(null); return; }
            drop.moveTo(wide ? { start: stickyY + 30, end: stickyY + 48 } : { start: stickyY + 22, end: stickyY + 56 }, { instant: far });
        };

        const findRow = (i, ctx) => {
            if (i < 0) return -1;
            let first = -1;
            for (let k = 0; k < state.rows.length; k++) {
                const row = state.rows[k];
                if (row.type !== 'track' || row.i !== i) continue;
                if (!ctx || row.ctx === ctx) return k;
                if (first === -1) first = k;
            }
            return first;
        };

        const scrollToRow = (k, { center = false } = {}) => {
            if (k < 0) return;
            const vp = r.viewport;
            const y = state.offsets[k];
            const h = vp.clientHeight || 600;
            const pad2 = LABEL_H;
            if (center) vp.scrollTop = Math.max(0, y - h / 2 + ROW_H / 2);
            else if (y < vp.scrollTop + pad2) vp.scrollTop = Math.max(0, y - pad2);
            // 底部留出渐隐那一段（26px），键盘往下走时选中行不会落在半透明的边上
            else if (y + ROW_H > vp.scrollTop + h - EDGE_FADE) vp.scrollTop = y + ROW_H - h + EDGE_FADE;
            schedule();
        };

        /* 阵列那边换了选中：列表跟着高亮并滚到那一行 */
        // 阵列切到「每日推荐」「最近播放」这两列时，目录自动切到「为你」并停在对应那一节；
        // 阵列离开这两列时，切回自动切换之前的分类（用户自己换过分类就不再自动切回）
        const ARRAY_SECTIONS = { daily: 'recent:daily', recent: 'recent' };
        let autoKind = null;
        const followArray = (ctx) => {
            if (state.query.trim()) return;
            if (ARRAY_SECTIONS[ctx] && state.kind !== 'recent') {
                const from = state.kind;
                setKind('recent', { auto: true });
                autoKind = from;
            } else if (!ARRAY_SECTIONS[ctx] && ctx && autoKind && state.kind === 'recent') {
                const back = autoKind;
                autoKind = null;
                setKind(back, { auto: true });
            }
        };
        const reveal = (i, ctx, { center = false, quiet = false } = {}) => {
            followArray(ctx);
            if (state.kind === 'recent' && ARRAY_SECTIONS[ctx]) ctx = ARRAY_SECTIONS[ctx];
            state.selected = i;
            state.preferCtx = ctx;
            const k = findRow(i, ctx);
            const moved = k !== state.selectedRow;
            state.selectedRow = k;
            if (!quiet && (moved || center) && k >= 0) scrollToRow(k, { center: center || !inView(k) });
            render(); // 当场画，避免阵列和目录高亮差一帧
        };
        const inView = (k) => {
            const vp = r.viewport;
            const y = state.offsets[k];
            return y >= vp.scrollTop && y + ROW_H <= vp.scrollTop + (vp.clientHeight || 600) - EDGE_FADE;
        };

        /* 列表里换选中（键盘/单击）：告诉阵列 */
        const pickRow = (k) => {
            const row = state.rows[k];
            if (!row || row.type !== 'track') return;
            state.selectedRow = k;
            state.selected = row.i;
            state.preferCtx = row.ctx;
            scrollToRow(k);
            opts.onPick(row.i, columnCtx(row.ctx));
            render();
        };
        const stepRow = (dir, n = 1) => {
            if (!state.rows.length) return;
            let k = state.selectedRow;
            if (k < 0) k = dir > 0 ? -1 : state.rows.length;
            let moved = 0;
            let next = k;
            for (let j = k + dir; j >= 0 && j < state.rows.length; j += dir) {
                if (state.rows[j].type === 'track') { next = j; if (++moved >= n) break; }
            }
            if (next !== k) pickRow(next);
        };
        const edgeRow = (end) => {
            for (let j = end ? state.rows.length - 1 : 0; j >= 0 && j < state.rows.length; j += end ? -1 : 1) {
                if (state.rows[j].type === 'track') { pickRow(j); return; }
            }
        };
        /*
         * 键盘移动之后：按着 Shift 就把起点到现在这一行都选上（起点是上一次不带 Shift 停下的那一行），
         * 不按 Shift 就回到单选
         */
        const afterMove = (shift, before) => {
            const k = state.selectedRow;
            if (!shift || k < 0) { multiAnchor = k; clearMulti(); return; }
            const ok = (j) => j >= 0 && j < state.rows.length && state.rows[j].type === 'track';
            const from = ok(multiAnchor) ? multiAnchor : ok(before) ? before : k;
            multiAnchor = from;
            multi.clear();
            if (from !== k) for (let j = Math.min(from, k); j <= Math.max(from, k); j++) if (state.rows[j].type === 'track') multi.add(keyOf(state.rows[j]));
            paintMulti();
        };
        const selectedRowData = () => state.rows[state.selectedRow] || null;
        /* 第 k 行所在的那一组：组名和组里的曲目（按显示顺序） */
        const groupOf = (k) => {
            if (state.kind === 'all' && !state.query.trim()) return null;
            let h = -1;
            for (const hk of state.heads) { if (hk <= k) h = hk; else break; }
            const head = state.rows[h];
            const items = [];
            for (let j = h + 1; j < state.rows.length && state.rows[j].type === 'track'; j++) items.push(state.rows[j].i);
            if (!items.length) return null;
            const kindName = (KINDS.find(([kk]) => kk === state.kind) || [])[1] || '';
            const label = head ? head.label : kindName;
            const name = state.kind === 'all' || state.kind === 'recent' || !kindName || label === kindName ? label : kindName + '：' + label;
            return { name, items };
        };

        const closeImport = () => {
            r.importOptions.hidden = true;
            r.importToggle.setAttribute('aria-expanded', 'false');
        };
        r.importToggle.addEventListener('click', () => {
            if (!r.importOptions.hidden) {
                closeImport();
                return;
            }
            r.importOptions.hidden = false;
            r.importToggle.setAttribute('aria-expanded', 'true');
            r.importOptions.querySelector('button').focus();
        });
        r.importTools.addEventListener('focusout', (e) => {
            if (!r.importTools.contains(e.relatedTarget)) closeImport();
        });
        r.importTools.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || r.importOptions.hidden) return;
            e.preventDefault();
            r.importToggle.focus();
            closeImport();
        });
        r.importOptions.addEventListener('click', (e) => {
            if (!e.target.closest('[data-act]')) return;
            r.importToggle.focus();
            closeImport();
        });

        // ---------- 输入 ----------
        let typeTimer = 0;
        r.input.addEventListener('input', () => {
            clearTimeout(typeTimer);
            typeTimer = setTimeout(() => {
                state.query = r.input.value;
                r.viewport.scrollTop = 0;
                rebuild();
                // 有检索词时第一条就是最可能的结果，直接选中，回车即可播放
                if (state.query.trim()) edgeRow(false);
            }, 30); // 570 首时一次检索约 5–15ms，去抖只为合并连续按键，不再让人等
        });
        // 有检索词时右边出现 ✕：点一下清空，焦点留在输入框里接着打字（显示 / 隐藏只靠 CSS 的 :placeholder-shown）
        r.clear?.addEventListener('mousedown', (e) => e.preventDefault());
        r.clear?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!r.input.value) return;
            r.input.value = '';
            flushQuery();
            r.input.focus();
            paintRecentQ();
        });
        r.input.addEventListener('focus', paintRecentQ);
        r.input.addEventListener('input', paintRecentQ);
        r.input.addEventListener('blur', () => { if (r.recentQ) r.recentQ.hidden = true; });
        // 在列表里按下不让检索框失焦（否则点不到）
        r.saveSmart.addEventListener('click', () => {
            const q = state.query.trim();
            if (q && app.createSmartPlaylist) app.createSmartPlaylist(q);
        });
        r.recentQ?.addEventListener('pointerdown', (e) => e.preventDefault());
        r.recentQ?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const del = e.target.closest('[data-rq-del]');
            if (e.target.closest('[data-rq-clear]')) { writeRecentQ([]); paintRecentQ(); return; }
            if (del) { const list = readRecentQ(); list.splice(Number(del.dataset.rqDel), 1); writeRecentQ(list); paintRecentQ(); return; }
            const item = e.target.closest('[data-rq]');
            const q = item && readRecentQ()[Number(item.dataset.rq)];
            if (!q) return;
            r.input.value = q;
            r.input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const flushQuery = () => {
            if (r.input.value === state.query) return;
            clearTimeout(typeTimer);
            state.query = r.input.value;
            rebuild();
            if (state.query.trim()) edgeRow(false);
        };

        const onKey = (e) => {
            const inInput = e.target === r.input;
            if (inInput) flushQuery();
            const before = state.selectedRow;
            const range = e.shiftKey && !inInput;
            // Alt+↑ / Alt+↓：在歌单里把选中的歌（或多选的几首）上移、下移一位，和拖动排序是同一件事
            if (e.altKey && !inInput && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && moveInPlaylist(e.key === 'ArrowUp' ? -1 : 1)) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            switch (e.key) {
                case 'ArrowDown': e.preventDefault(); stepRow(1); afterMove(range, before); break;
                case 'ArrowUp': e.preventDefault(); stepRow(-1); afterMove(range, before); break;
                case 'PageDown': e.preventDefault(); stepRow(1, 10); afterMove(range, before); break;
                case 'PageUp': e.preventDefault(); stepRow(-1, 10); afterMove(range, before); break;
                case 'Home': if (!inInput) { e.preventDefault(); edgeRow(false); afterMove(range, before); } break;
                case 'End': if (!inInput) { e.preventDefault(); edgeRow(true); afterMove(range, before); } break;
                case 'Enter': {
                    e.preventDefault();
                    const row = selectedRowData();
                    // Ctrl+Enter：下一首播放；Ctrl+Shift+Enter：加入队列末尾（选中的或多选的几首）
                    if ((e.ctrlKey || e.metaKey) && row && row.type === 'track') { queueBatch(pickedIndices(row), !e.shiftKey); break; }
                    if (row && row.type === 'track') play(row.i, row.ctx, { stage: e.shiftKey, group: groupOf(state.selectedRow) });
                    break;
                }
                case 'ArrowRight': {
                    if (inInput && r.input.selectionStart < r.input.value.length) return;
                    const row = selectedRowData();
                    if (row && row.type === 'track') { e.preventDefault(); play(row.i, row.ctx, { stage: true, group: groupOf(state.selectedRow) }); }
                    break;
                }
                case 'Delete': {
                    // 在歌单里按 Delete：把选中的（或多选的几首）从这个歌单移除，可以撤销。曲库本身不用这个键删
                    if (inInput) return;
                    const row = selectedRowData();
                    if (!row || row.type !== 'track') return;
                    const picked = multi.size > 1 && multi.has(keyOf(row));
                    const scope = picked ? batchScope() : scopeOf(row);
                    if (!scope || scope.type !== 'playlist') return;
                    e.preventDefault();
                    removeFromPlaylistBatch(scope, pickedIndices(row));
                    if (picked) clearMulti();
                    break;
                }
                case 'a': case 'A':
                    if (inInput || !(e.ctrlKey || e.metaKey)) return;
                    e.preventDefault();
                    multi.clear();
                    for (const row of state.rows) if (row.type === 'track') multi.add(keyOf(row));
                    paintMulti();
                    break;
                case 'Escape':
                    e.preventDefault();
                    if (!inInput && clearMulti()) break;
                    if (inInput && r.input.value) { r.input.value = ''; flushQuery(); } else { e.target.blur(); }
                    break;
                case 'ContextMenu': case 'F10': {
                    if (e.key === 'F10' && !e.shiftKey) return;
                    e.preventDefault();
                    if (multi.size > 1) {
                        // 菜单开在当前那一行旁边（那一行滚出去了就开在目录左上）
                        const node = state.rendered.get(state.selectedRow);
                        const box = (node && inView(state.selectedRow) ? node : r.viewport).getBoundingClientRect();
                        openBatchMenu(box.left + 80, box.top + (node && inView(state.selectedRow) ? box.height : 80), { keyboard: true });
                    } else openMenuForRow(state.selectedRow);
                    break;
                }
                case 'Tab': {
                    // 检索框里有字时 Tab 换分类（在别的分类里看同一个检索词）；到了最后一类（Shift+Tab 到了第一类）
                    // 就不再绕回去，焦点照常离开检索框，键盘用户不会被困住。框里没字时 Tab 就是普通的下一个控件
                    if (!inInput || !r.input.value) return;
                    const at = KINDS.findIndex(([k]) => k === state.kind);
                    const next = at + (e.shiftKey ? -1 : 1);
                    if (next < 0 || next >= KINDS.length) return;
                    e.preventDefault();
                    setKind(KINDS[next][0]);
                    break;
                }
                default: return;
            }
            e.stopPropagation();
        };
        r.input.addEventListener('keydown', onKey);
        r.viewport.addEventListener('keydown', onKey);

        r.viewport.addEventListener('scroll', schedule, { passive: true });
        r.viewport.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
        r.viewport.addEventListener('click', (e) => {
            const gplay = e.target.closest('[data-gplay]');
            if (gplay) {
                const h = Number(gplay.closest('.archive-list-group')?.dataset.k);
                const first = state.rows[h + 1];
                if (!first || first.type !== 'track') return;
                e.stopPropagation();
                clearMulti();
                pickRow(h + 1);
                play(first.i, first.ctx, { stage: false, group: groupOf(h + 1) });
                return;
            }
            const node = e.target.closest('.archive-list-row');
            if (!node) return;
            // 行首悬停出现的播放键：点它直接播这首；已经是正在放的这首就暂停 / 继续
            if (e.target.closest('[data-go]') && !(e.shiftKey || e.ctrlKey || e.metaKey)) {
                const k = Number(node.dataset.k);
                const row = state.rows[k];
                if (!row || row.type !== 'track') return;
                e.stopPropagation();
                clearMulti();
                pickRow(k);
                if (row.i === app.currentTrackIndex && (app.isPlaying || app.playIntent)) app.pauseTrack?.();
                else play(row.i, row.ctx, { resume: true, group: groupOf(k) });
                return;
            }
            clickRow(Number(node.dataset.k), e);
        });
        r.viewport.addEventListener('dblclick', (e) => {
            if (e.target.closest('[data-go]')) return; // 播放键连点两下不算双击（不然会重播）
            const node = e.target.closest('.archive-list-row');
            const row = node && state.rows[Number(node.dataset.k)];
            if (row && row.type === 'track') play(row.i, row.ctx, { stage: false, group: groupOf(Number(node.dataset.k)) });
        });
        /* 歌单分类里的行：右键菜单的「移除」只从这个歌单里移除；其他行按曲库处理 */
        const scopeOf = (row) => {
            const m = /^playlist:(.+)$/.exec(String(row.ctx || ''));
            const pl = m && (app.customPlaylists || []).find((p) => String(p.id) === m[1]);
            return pl ? { type: 'playlist', id: pl.id, name: pl.name } : null;
        };
        r.viewport.addEventListener('contextmenu', (e) => {
            // 在分组标题上右键：整组选上，打开批量菜单（和 Spotify 在专辑上右键一样，能整组下一首播放、加入队列、加入歌单）
            const headNode = e.target.closest('.archive-list-group');
            const headK = headNode ? Number(headNode.dataset.k) : -1;
            if (headNode && groupPlayable(state.rows[headK])) {
                e.preventDefault();
                multi.clear();
                let first = -1;
                for (let j = headK + 1; j < state.rows.length && state.rows[j].type === 'track'; j++) { multi.add(keyOf(state.rows[j])); if (first < 0) first = j; }
                if (first < 0) return;
                state.selectedRow = first;
                state.selected = state.rows[first].i;
                multiAnchor = first;
                paintMulti();
                render();
                if (multi.size > 1) openBatchMenu(e.clientX, e.clientY, { title: state.rows[headK].label });
                else { app.contextMenuTrackIndex = state.rows[first].i; app.contextMenuScopeHint = scopeOf(state.rows[first]); app.showContextMenu?.(e.clientX, e.clientY); }
                return;
            }
            const node = e.target.closest('.archive-list-row');
            const row = node && state.rows[Number(node.dataset.k)];
            if (!row || row.type !== 'track') return;
            e.preventDefault();
            if (multi.size > 1 && multi.has(keyOf(row))) { openBatchMenu(e.clientX, e.clientY); return; }
            clearMulti();
            pickRow(Number(node.dataset.k));
            app.contextMenuTrackIndex = row.i;
            app.contextMenuScopeHint = scopeOf(row);
            app.showContextMenu?.(e.clientX, e.clientY);
        });
        /*
         * 键盘打开右键菜单（Shift+F10、菜单键）：在选中那一行上发一次 contextmenu，走和鼠标右键完全一样的路
         * （播放器据此知道菜单是从档案页打开的），菜单出现后接管方向键，关掉后焦点回到目录
         */
        const openMenuForRow = (k) => {
            const row = state.rows[k];
            if (!row || row.type !== 'track') return;
            scrollToRow(k);
            render();
            const node = state.rendered.get(k);
            if (!node) return;
            const rect = node.getBoundingClientRect();
            const back = document.activeElement;
            node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 40, clientY: rect.top + rect.height / 2 }));
            menuKeyboard(app, { restore: back && back !== document.body ? back : r.viewport });
        };
        /*
         * ---------- 歌单管理（目录的「歌单」分类里）----------
         * 新建：分类下面的「＋ 新建歌单」就地变成输入框；重命名、删除：歌单标题右边的两个小按钮（删除要再点一次确认）；
         * 把歌拖到歌单上：拖起目录里的行时，目录下方出现各个歌单（和「新建歌单」），松手即加入。
         * 数据还是播放器的 app.customPlaylists，存盘用它的 saveCustomPlaylists；改完通知档案页重排。
         */
        const manage = { confirm: null, drag: null, dragPl: null };
        const playlists = () => (Array.isArray(app.customPlaylists) ? app.customPlaylists : []);
        const playlistOfHead = (row) => {
            if (!row || row.type !== 'head' || state.kind !== 'playlist') return null;
            const m = /^playlist:(.+)$/.exec(String(row.key || ''));
            return (m && playlists().find((p, order) => String(p && (p.id ?? order)) === m[1])) || null;
        };
        const toast = (message, action) => { try { global.MusicToast?.show?.({ message, action }); } catch (e) { /* 没有提示层就不提示 */ } };
        const commitPlaylists = () => {
            app.saveCustomPlaylists?.();
            app.refreshPreload?.();
            if (app.currentSidebarView === 'playlists') app.renderSidebarContent?.('playlists');
            if (opts.onPlaylistsChanged) opts.onPlaylistsChanged(); else rebuild();
        };
        const createPlaylist = (name, paths = []) => {
            const clean = String(name || '').trim();
            if (!clean) return null;
            const pl = { id: Date.now().toString() + (playlists().some((p) => String(p.id) === Date.now().toString()) ? '1' : ''), name: clean, tracks: [...new Set(paths)] };
            if (!Array.isArray(app.customPlaylists)) app.customPlaylists = [];
            app.customPlaylists.push(pl);
            commitPlaylists();
            return pl;
        };
        /* 把曲库下标对应的歌加进歌单（已经在里面的跳过）；返回新加了几首 */
        const addToPlaylist = (pl, indices) => {
            if (!pl) return 0;
            const add = [];
            for (const i of indices) {
                const t = tracks()[i];
                if (t && t.path && !pl.tracks.includes(t.path) && !add.includes(t.path)) add.push(t.path);
            }
            if (add.length) {
                pl.tracks.push(...add);
                commitPlaylists();
                toast(`已加入歌单「${pl.name}」：${add.length} 首`, { label: '撤销', run: () => { pl.tracks = pl.tracks.filter((p) => !add.includes(p)); commitPlaylists(); } });
            } else if (indices.length) {
                toast(`已经在歌单「${pl.name}」里了`);
            }
            return add.length;
        };
        const renamePlaylist = (pl, name) => {
            const clean = String(name || '').trim();
            if (!pl || !clean || clean === pl.name) return false;
            pl.name = clean;
            commitPlaylists();
            return true;
        };
        const deletePlaylist = (pl) => {
            if (!pl) return;
            const at = playlists().indexOf(pl);
            app.customPlaylists = playlists().filter((p) => p !== pl);
            commitPlaylists();
            toast(`已删除歌单「${pl.name}」`, { label: '撤销', run: () => {
                if (playlists().includes(pl)) return;
                const next = playlists().slice();
                next.splice(Math.min(at, next.length), 0, pl);
                app.customPlaylists = next;
                commitPlaylists();
            } });
        };
        /* 就地输入名字：回车确定，Esc 或移开取消 */
        const askName = (host, { value = '', label, done }) => {
            const before = host.innerHTML;
            host.innerHTML = `<input type="text" class="archive-list-name" maxlength="60" aria-label="${esc(label)}" placeholder="${esc(label)}">`;
            const input = host.firstChild;
            input.value = value;
            let closed = false;
            const close = (commit) => {
                if (closed) return;
                closed = true;
                const name = input.value;
                host.innerHTML = before;
                if (commit) done(name);
                // 键盘操作完焦点回目录（改名后整张目录重排，原来的按钮已经不在了）
                if (!el.contains(document.activeElement) || document.activeElement === document.body) r.viewport.focus?.();
            };
            input.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); close(true); }
                else if (e.key === 'Escape') { e.preventDefault(); close(false); }
            });
            input.addEventListener('blur', () => close(false));
            for (const type of ['click', 'dblclick', 'contextmenu']) input.addEventListener(type, (e) => e.stopPropagation());
            input.focus();
            input.select();
        };
        const repaintHead = (node) => { const k = Number(node.dataset.k); node.innerHTML = rowHtml(state.rows[k], k); };
        r.newPl.addEventListener('click', (e) => {
            if (!e.target.closest('[data-pl="new"]')) return;
            askName(r.newPl, { label: '新歌单的名字', done: (name) => {
                const pl = createPlaylist(name);
                if (pl) { const k = state.rows.findIndex((row) => playlistOfHead(row) === pl); if (k >= 0) r.viewport.scrollTop = Math.max(0, state.offsets[k] - 20); render(); }
            } });
        });
        r.viewport.addEventListener('click', (e) => {
            const b = e.target.closest('[data-pl]');
            const node = b && b.closest('.archive-list-group');
            const pl = node && playlistOfHead(state.rows[Number(node.dataset.k)]);
            if (!pl) return;
            e.stopPropagation();
            const act = b.dataset.pl;
            if (act === 'rename') {
                askName(node, { value: pl.name, label: '歌单的名字', done: (name) => { if (!renamePlaylist(pl, name)) repaintHead(node); } });
            } else if (act === 'delete') {
                manage.confirm = String(pl.id);
                repaintHead(node);
                node.querySelector('[data-pl="delete-no"]')?.focus();
            } else if (act === 'delete-no') {
                manage.confirm = null;
                repaintHead(node);
                node.querySelector('[data-pl="delete"]')?.focus();
            } else if (act === 'delete-yes') {
                manage.confirm = null;
                deletePlaylist(pl);
                r.viewport.focus?.();
            }
        });

        // ---------- 批量菜单 ----------
        let batchMenu = null;
        const closeBatchMenu = ({ focus = false } = {}) => {
            if (!batchMenu) return;
            batchMenu.remove();
            batchMenu = null;
            document.removeEventListener('pointerdown', batchOutside, true);
            if (focus) r.viewport.focus?.();
        };
        const batchOutside = (e) => { if (batchMenu && !batchMenu.contains(e.target)) closeBatchMenu(); };
        /* 选中的行都在同一个歌单里：移除就是从这个歌单移除；否则是从曲库列表移除 */
        const batchScope = () => {
            const rows = pickedRows();
            const first = rows[0] && scopeOf(rows[0]);
            return first && rows.every((row) => row.ctx === rows[0].ctx) ? first : null;
        };
        const queueBatch = (indices, next) => {
            const fn = next ? app.queuePlayNext : app.queueAdd;
            if (typeof fn !== 'function') return;
            const list = indices.map((i) => tracks()[i]).filter(Boolean);
            const before = typeof app.queueSnapshot === 'function' ? app.queueSnapshot() : (app.manualQueue || []).slice();
            // 「下一首播放」是插到队首：倒着插，听的时候才是选中的顺序
            const queued = (next ? list.slice().reverse() : list).map((t) => fn(t)).filter(Boolean);
            if (!queued.length) return;
            toast(`${next ? '下一首播放' : '已加入队列'}：${queued.length} 首`, { label: '撤销', run: () => {
                // 本来就在队列里的那几首放回原位，不跟着一起拿掉
                if (typeof app.queueRevert === 'function') { app.queueRevert(queued, before); return; }
                for (const t of queued) { if (before.includes(t)) continue; const at = (app.manualQueue || []).indexOf(t); if (at !== -1) app.queueRemove?.(at); }
            } });
        };
        const removeFromPlaylistBatch = (scope, indices) => {
            const pl = playlists().find((p) => p.id === scope.id);
            if (!pl) return;
            const paths = new Set(indices.map((i) => (tracks()[i] || {}).path));
            const before = pl.tracks.slice();
            pl.tracks = pl.tracks.filter((p) => !paths.has(p));
            const n = before.length - pl.tracks.length;
            if (!n) return;
            commitPlaylists();
            toast(`已从歌单「${pl.name}」移除 ${n} 首`, { label: '撤销', run: () => { pl.tracks = before; commitPlaylists(); } });
        };
        /*
         * 歌单里拖动排序：把拖着的几首（按目录顺序）挪到目标那首的前面或后面。
         * 歌单里存的是路径；比较时和建目录时一样，统一斜杠、不分大小写。
         */
        const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
        const reorderPlaylist = (pl, indices, targetI, after, { quiet = false } = {}) => {
            if (!pl || !Array.isArray(pl.tracks)) return false;
            const moving = new Set(indices.map((i) => normPath((tracks()[i] || {}).path)));
            const target = normPath((tracks()[targetI] || {}).path);
            if (!target || moving.has(target)) return false;
            const before = pl.tracks.slice();
            const moved = before.filter((p) => moving.has(normPath(p)));
            if (!moved.length) return false;
            const rest = before.filter((p) => !moving.has(normPath(p)));
            const at = rest.findIndex((p) => normPath(p) === target);
            if (at === -1) return false;
            rest.splice(after ? at + 1 : at, 0, ...moved);
            if (rest.every((p, n) => p === before[n])) return false;
            pl.tracks = rest;
            commitPlaylists();
            if (!quiet) toast(`已调整「${pl.name}」的顺序`, { label: '撤销', run: () => { pl.tracks = before; commitPlaylists(); } });
            return true;
        };
        const moveInPlaylist = (dir) => {
            const row = selectedRowData();
            const pl = row && row.type === 'track' ? reorderScope(row) : null;
            if (!pl) return false;
            const indices = pickedIndices(row);
            const plPaths = new Set((pl.tracks || []).map(normPath));
            if (!indices.every((i) => plPaths.has(normPath((tracks()[i] || {}).path)))) return false;
            // 目标：这一组里，选中那几首最上面一首的上一首（或最下面一首的下一首）
            const h = headOf(state.selectedRow);
            const ks = [];
            for (let j = h + 1; j < state.rows.length && state.rows[j].type === 'track'; j++) ks.push(j);
            const picked = new Set(indices);
            const inside = ks.filter((j) => picked.has(state.rows[j].i));
            if (!inside.length) return false;
            const edge = dir < 0 ? inside[0] - 1 : inside[inside.length - 1] + 1;
            const target = state.rows[edge];
            if (!target || target.type !== 'track') return false;
            const ctx = row.ctx;
            const moved = reorderPlaylist(pl, indices, target.i, dir > 0, { quiet: true });
            if (moved) {
                // 重建之后把选中跟到挪过去的那首上
                const follow = () => { const k = findRow(row.i, ctx); if (k >= 0) { state.selectedRow = k; state.selected = row.i; scrollToRow(k); render(); } };
                follow();
                Promise.resolve().then(follow);
            }
            return moved;
        };
        const headOf = (k) => { let h = -1; for (const hk of state.heads) { if (hk <= k) h = hk; else break; } return h; };
        /* 正在拖的歌都来自同一个歌单、而且没在检索时，才能在这个歌单里排序 */
        const reorderScope = (row) => {
            if (state.kind !== 'playlist' || state.query.trim() || !row) return null;
            const k = state.rows.indexOf(row);
            return k >= 0 ? playlistOfHead(state.rows[headOf(k)]) : null;
        };

        /* 从曲库列表移除（磁盘上的文件不动）。正在放的那首不移除，免得打断播放 */
        const removeFromLibraryBatch = (indices) => {
            const lib = app.playlist;
            if (!Array.isArray(lib)) return;
            const current = lib[app.currentTrackIndex];
            const victims = new Set(indices.map((i) => lib[i]).filter((t) => t && t !== current));
            if (!victims.size) { toast('正在播放的这首没有移除'); return; }
            const before = lib.slice();
            const beforeFiltered = Array.isArray(app.currentFilteredTracks) ? app.currentFilteredTracks.slice() : null;
            // 手动队列里有这些歌的话一并拿掉，记下原来排第几，撤销时放回去
            const queued = (app.manualQueue || []).map((t, at) => ({ t, at })).filter((q) => victims.has(q.t));
            for (let i = lib.length - 1; i >= 0; i--) if (victims.has(lib[i])) lib.splice(i, 1);
            if (current) app.currentTrackIndex = Math.max(0, lib.indexOf(current));
            if (Array.isArray(app.currentFilteredTracks)) app.currentFilteredTracks = app.currentFilteredTracks.filter((t) => !victims.has(t));
            for (const t of victims) { const at = (app.manualQueue || []).indexOf(t); if (at !== -1) app.queueRemove?.(at); }
            const after = () => {
                if (app.playlistViewSource && Array.isArray(app.currentFilteredTracks)) app.renderPlaylist?.(app.currentFilteredTracks); else app.renderPlaylist?.();
                (app.saveLibrary ? app.saveLibrary() : app.api?.saveMusicPlaylist?.(app.playlist));
                app.refreshPreload?.();
                if (opts.onLibraryChanged) opts.onLibraryChanged(); else rebuild();
            };
            after();
            /*
             * 撤销：只把移除的那些插回去，各自回到原来排在它前面、现在还在的最近一首后面，
             * 期间曲库里新增的歌（比如扫描还在进行）原样留着。
             */
            const putBack = (target, original) => {
                let prev = null;
                original.forEach((t) => {
                    // prev：原来排在它前面、现在还在的最近一首
                    if (!victims.has(t)) { if (target.includes(t)) prev = t; return; }
                    if (!target.includes(t) && !target.some((x) => x && x.path === t.path)) target.splice(prev ? target.indexOf(prev) + 1 : 0, 0, t);
                    if (target.includes(t)) prev = t;
                });
            };
            const skipped = indices.length - victims.size;
            toast(`已从曲库列表移除 ${victims.size} 首` + (skipped ? '（正在播放的那首留着）' : ''), { label: '撤销', run: () => {
                const now = app.playlist;
                if (!Array.isArray(now)) return;
                const playing = now[app.currentTrackIndex];
                putBack(now, before);
                if (playing) app.currentTrackIndex = Math.max(0, now.indexOf(playing));
                if (beforeFiltered && Array.isArray(app.currentFilteredTracks)) {
                    const list = app.currentFilteredTracks.slice();
                    putBack(list, beforeFiltered);
                    app.currentFilteredTracks = list;
                }
                for (const q of queued) {
                    if (typeof app.queueAdd !== 'function' || (app.manualQueue || []).includes(q.t) || !app.queueAdd(q.t)) continue;
                    const last = app.manualQueue.indexOf(q.t);
                    if (last !== -1 && last !== q.at && typeof app.queueMove === 'function') app.queueMove(last, Math.min(q.at, app.manualQueue.length - 1));
                }
                after();
            } });
        };
        const openBatchMenu = (x, y, { keyboard = false, title = '' } = {}) => {
            closeBatchMenu();
            const indices = pickedIndices(null);
            if (indices.length < 2) return;
            const scope = batchScope();
            const groupFirst = title ? state.selectedRow : -1; // 从分组标题打开时，这一组的第一行
            const item = (act, zh, en, extra = '') => `<button type="button" role="menuitem" data-batch="${act}"${extra}><span>${esc(zh)}</span>${en ? `<i>${en}</i>` : ''}</button>`;
            const menu = batchMenu = document.createElement('div');
            menu.className = 'archive-batch-menu';
            menu.setAttribute('role', 'menu');
            menu.setAttribute('aria-label', `已选 ${indices.length} 首`);
            menu.innerHTML = `<header>${title ? `${esc(title)} · ${indices.length} 首` : `已选 ${indices.length} 首`}</header>`
                + item('play', title ? '播放这一组' : '播放所选')
                + item('shuffle', '随机播放')
                + (typeof app.queuePlayNext === 'function' ? item('next', '下一首播放') : '')
                + (typeof app.queueAdd === 'function' ? item('queue', '加入队列') : '')
                + (typeof app.queuePlayNext === 'function' || typeof app.queueAdd === 'function' ? '<hr>' : '')
                + (typeof app.toggleLike === 'function' ? item('like', indices.every((i) => app.isLiked(tracks()[i])) ? '取消喜欢' : '喜欢') : '')
                // 有歌单选择器时只放一项「加入歌单…」，点开再挑（歌单多了菜单不会被撑得很长）；没有时退回逐个列出
                + (global.MusicPlaylistPicker
                    ? item('pl-pick', '加入歌单…')
                    : playlists().map((p, order) => item('pl', '加入「' + (p.name || '未命名歌单') + '」', '', ` data-id="${esc(p.id ?? order)}"`)).join('')
                        + item('pl-new', '新建歌单并加入'))
                + '<hr>'
                + item('remove', scope ? '从歌单「' + scope.name + '」移除' : '从曲库列表移除');
            document.body.appendChild(menu);
            const w = menu.offsetWidth || 240, h = menu.offsetHeight || 300;
            menu.style.left = Math.max(8, Math.min(x, (global.innerWidth || 1600) - w - 10)) + 'px';
            menu.style.top = Math.max(8, Math.min(y, (global.innerHeight || 900) - h - 10)) + 'px';
            global.MusicFluid?.bud(menu, { x, y });
            const items = () => [...menu.querySelectorAll('[data-batch]')];
            const run = (b) => {
                const act = b.dataset.batch;
                if (act === 'remove' && !scope && !b.dataset.sure) {
                    // 从曲库移除要再点一次
                    b.dataset.sure = '1';
                    b.querySelector('span').textContent = `再点一次，移除这 ${indices.length} 首`;
                    return;
                }
                const at = b.getBoundingClientRect();
                closeBatchMenu({ focus: true });
                if (act === 'pl-pick') {
                    const paths = indices.map((i) => (tracks()[i] || {}).path).filter(Boolean);
                    global.MusicPlaylistPicker.open({
                        app, paths, anchor: { x: at.left, y: at.top }, restore: r.viewport,
                        label: title ? `${title} · ${paths.length} 首` : `已选 ${paths.length} 首`,
                        onChange: () => (opts.onPlaylistsChanged ? opts.onPlaylistsChanged() : rebuild())
                    });
                    return;
                }
                if (act === 'play') {
                    // 播放所选：只放这几首，按目录里的顺序，队列名叫「所选 N 首」
                    const k = groupFirst >= 0 ? groupFirst : findRow(indices[0], null);
                    const row = state.rows[k];
                    const group = (groupFirst >= 0 && groupOf(groupFirst)) || { name: `所选 ${indices.length} 首`, items: indices.slice() };
                    clearMulti();
                    if (row) pickRow(k);
                    play(row ? row.i : indices[0], row ? row.ctx : null, { stage: false, group });
                } else if (act === 'shuffle') {
                    // 随机播放：把这几首洗一遍当作这次的队列，播放模式不动（和 Spotify 在专辑上点随机一样，只影响这一次）
                    const order = indices.slice();
                    for (let n = order.length - 1; n > 0; n--) { const m = Math.floor(Math.random() * (n + 1)); [order[n], order[m]] = [order[m], order[n]]; }
                    const base = (groupFirst >= 0 && groupOf(groupFirst)) || null;
                    const name = (base ? base.name : `所选 ${indices.length} 首`) + ' · 随机';
                    let k = -1;
                    if (groupFirst >= 0) { for (let j = groupFirst; j < state.rows.length && state.rows[j].type === 'track'; j++) if (state.rows[j].i === order[0]) { k = j; break; } }
                    if (k < 0) k = findRow(order[0], null);
                    const row = state.rows[k];
                    clearMulti();
                    if (row) pickRow(k);
                    play(order[0], row ? row.ctx : null, { stage: false, group: { name, items: order } });
                } else if (act === 'next' || act === 'queue') queueBatch(indices, act === 'next');
                else if (act === 'like') app.toggleLike(indices.map((i) => tracks()[i]).filter(Boolean));
                else if (act === 'pl') addToPlaylist(playlists().find((p, order) => String(p.id ?? order) === b.dataset.id), indices);
                else if (act === 'pl-new') {
                    const pl = createPlaylist('新歌单 ' + (playlists().length + 1), indices.map((i) => (tracks()[i] || {}).path).filter(Boolean));
                    if (pl) toast(`已新建歌单「${pl.name}」：${pl.tracks.length} 首`);
                } else if (act === 'remove') {
                    if (scope) removeFromPlaylistBatch(scope, indices); else removeFromLibraryBatch(indices);
                    clearMulti();
                }
            };
            menu.addEventListener('click', (e) => { const b = e.target.closest('[data-batch]'); if (b) run(b); });
            menu.addEventListener('contextmenu', (e) => e.preventDefault());
            menu.addEventListener('keydown', (e) => {
                const list = items();
                const at = list.indexOf(document.activeElement);
                if (e.key === 'ArrowDown') list[(at + 1) % list.length].focus();
                else if (e.key === 'ArrowUp') list[(at + list.length - 1) % list.length].focus();
                else if (e.key === 'Home') list[0].focus();
                else if (e.key === 'End') list[list.length - 1].focus();
                else if (e.key === 'Escape' || e.key === 'Tab') closeBatchMenu({ focus: true });
                else if (e.key === 'Enter' || e.key === ' ') { if (at >= 0) run(list[at]); }
                else return;
                e.preventDefault();
                e.stopPropagation();
            });
            document.addEventListener('pointerdown', batchOutside, true);
            if (keyboard) items()[0]?.focus();
        };

        // 拖到歌单上
        const dragIndices = (row) => pickedIndices(row);
        const openShelf = () => {
            const canQueue = typeof app.queuePlayNext === 'function' && typeof app.queueAdd === 'function';
            r.shelf.innerHTML = (canQueue ? '<b>放进队列</b><button type="button" data-drop-q="next">下一首播放</button><button type="button" data-drop-q="last">加入队列</button>' : '')
                + '<b>拖到歌单上</b>'
                + playlists().map((p, order) => `<button type="button" data-drop="${esc(p.id ?? order)}">${esc(p.name || '未命名歌单')}</button>`).join('')
                + '<button type="button" data-drop-new>＋ 新建歌单</button>';
            r.shelf.hidden = false;
            el.classList.add('dragging');
            openCapDrop();
        };
        const closeShelf = () => {
            manage.drag = null;
            r.shelf.hidden = true;
            el.classList.remove('dragging');
            el.querySelectorAll('.drop-over, .drop-before, .drop-after').forEach((n) => n.classList.remove('drop-over', 'drop-before', 'drop-after'));
            manage.dragPl = null;
            closeCapDrop();
        };
        /*
         * 拖着歌经过底栏胶囊：胶囊上盖一层两格的落点，左半「下一首播放」、右半「加入队列」（和 Apple Music
         * 把歌拖到顶部播放条入队一样）。落点是盖在胶囊上的独立一层，不改胶囊本身；没有底栏时什么都不做。
         */
        let capDrop = null;
        const capsule = () => document.querySelector('.md-dock .md-cap');
        const openCapDrop = () => {
            const cap = capsule();
            if (!cap || typeof app.queueAdd !== 'function' || typeof app.queuePlayNext !== 'function') return;
            const rect = cap.getBoundingClientRect();
            if (!(rect.width > 0)) return;
            capDrop = document.createElement('div');
            capDrop.className = 'archive-cap-drop mf-glass'; // 和底栏、菜单同一块玻璃
            capDrop.setAttribute('aria-hidden', 'true');
            capDrop.innerHTML = '<span data-cap-q="next">下一首播放</span><span data-cap-q="last">加入队列</span>';
            Object.assign(capDrop.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
            document.body.appendChild(capDrop);
        };
        const closeCapDrop = () => { capDrop?.remove(); capDrop = null; };
        const capHit = (x, y) => {
            if (!capDrop || !Number.isFinite(x)) return null;
            const rect = capDrop.getBoundingClientRect();
            if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
            const q = x < rect.left + rect.width / 2 ? 'next' : 'last';
            return { node: capDrop.querySelector(`[data-cap-q="${q}"]`), q };
        };
        const dropTarget = (target) => {
            const qchip = target.closest?.('[data-drop-q]');
            if (qchip) return { node: qchip, q: qchip.dataset.dropQ === 'next' ? 'next' : 'last' };
            const chip = target.closest?.('[data-drop], [data-drop-new]');
            if (chip) return { node: chip, pl: chip.hasAttribute('data-drop-new') ? 'new' : playlists().find((p, order) => String(p.id ?? order) === chip.dataset.drop) };
            const head = target.closest?.('.archive-list-group.is-playlist');
            const pl = head && playlistOfHead(state.rows[Number(head.dataset.k)]);
            return pl ? { node: head, pl } : null;
        };
        /*
         * 鼠标按住目录拖动：上下拖是滚动（松手后顺着惯性再滑一小段），横着拖起一行是把歌拎到歌单上
         * （拎的是多选里的几首或这一首；歌单架和歌单标题是落点）。触摸屏本来就能滑，不接管。
         */
        const DRAG_SLOP = 6;
        let press = null;
        let glide = 0;
        let ghost = null;
        const stopGlide = () => { if (glide) cancelAnimationFrame(glide); glide = 0; };
        const pxScale = () => { const h = r.viewport.offsetHeight; return h ? (r.viewport.getBoundingClientRect().height / h) || 1 : 1; };
        const hitOf = (e) => {
            const cap = capHit(e.clientX, e.clientY);
            if (cap) return cap;
            const under = typeof document.elementFromPoint === 'function' && Number.isFinite(e.clientX) ? document.elementFromPoint(e.clientX, e.clientY) : null;
            const node = manage.dragPl && under?.closest?.('.archive-list-row');
            if (node && r.viewport.contains(node)) {
                const k = Number(node.dataset.k);
                const row = state.rows[k];
                if (row && row.type === 'track' && playlistOfHead(state.rows[headOf(k)]) === manage.dragPl) {
                    const box = node.getBoundingClientRect();
                    const after = e.clientY > box.top + box.height / 2;
                    return { node, cls: after ? 'drop-after' : 'drop-before', reorder: { pl: manage.dragPl, i: row.i, after } };
                }
            }
            return dropTarget(under || e.target);
        };
        const paintOver = (hit) => {
            const cls = hit ? hit.cls || 'drop-over' : '';
            const clear = (n) => { for (const c of ['drop-over', 'drop-before', 'drop-after']) if (!hit || n !== hit.node || c !== cls) n.classList.remove(c); };
            el.querySelectorAll('.drop-over, .drop-before, .drop-after').forEach(clear);
            capDrop?.querySelectorAll('.drop-over').forEach(clear);
            if (hit) hit.node.classList.add(cls);
        };
        const moveGhost = (e) => { if (ghost) ghost.style.transform = `translate(${(e.clientX || 0) + 14}px, ${(e.clientY || 0) + 12}px)`; };
        const startCarry = (row, e) => {
            manage.drag = dragIndices(row);
            openShelf();
            // 在歌单分类里拖：拖的几首都在这个歌单里，就可以直接在歌单里上下挪
            const pl = reorderScope(row);
            const plPaths = pl ? new Set((pl.tracks || []).map(normPath)) : null;
            manage.dragPl = plPaths && manage.drag.every((i) => plPaths.has(normPath((tracks()[i] || {}).path))) ? pl : null;
            ghost = document.createElement('div');
            ghost.className = 'archive-drag-ghost';
            const first = tracks()[manage.drag[0]] || {};
            ghost.textContent = manage.drag.length > 1 ? `${manage.drag.length} 首` : String(first.title || '1 首').replace(/\.[a-z0-9]{2,5}$/i, '');
            document.body.appendChild(ghost);
            moveGhost(e);
        };
        const endCarry = (hit) => {
            const indices = manage.drag;
            ghost?.remove();
            ghost = null;
            closeShelf();
            if (!hit || !indices) return;
            if (hit.reorder) { reorderPlaylist(hit.reorder.pl, indices, hit.reorder.i, hit.reorder.after); return; }
            if (hit.q) { queueBatch(indices, hit.q === 'next'); return; }
            if (hit.pl === 'new') {
                const pl = createPlaylist('新歌单 ' + (playlists().length + 1), indices.map((i) => (tracks()[i] || {}).path).filter(Boolean));
                if (pl) toast(`已新建歌单「${pl.name}」：${pl.tracks.length} 首`);
            } else addToPlaylist(hit.pl, indices);
        };
        const swallowClick = () => {
            // 拖完松手不算一次点击
            const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
            r.viewport.addEventListener('click', eat, true);
            setTimeout(() => r.viewport.removeEventListener('click', eat, true), 0);
        };
        const onPressMove = (e) => {
            if (!press) return;
            const dx = e.clientX - press.x, dy = e.clientY - press.y;
            if (!press.mode) {
                if (Math.hypot(dx, dy) < DRAG_SLOP) return;
                const row = press.k >= 0 ? state.rows[press.k] : null;
                if (row && row.type === 'track' && Math.abs(dx) > Math.abs(dy) * 1.2) { press.mode = 'carry'; startCarry(row, e); }
                else { press.mode = 'scroll'; el.classList.add('grabbing'); }
            }
            if (press.mode === 'carry') { moveGhost(e); paintOver(hitOf(e)); return; }
            const before = r.viewport.scrollTop;
            r.viewport.scrollTop = press.top - dy / press.scale;
            const now = performance.now();
            if (now > press.t) press.v = press.v * 0.6 + ((r.viewport.scrollTop - before) / (now - press.t)) * 0.4;
            press.t = now;
            schedule();
        };
        const onPressEnd = (e) => {
            document.removeEventListener('pointermove', onPressMove);
            document.removeEventListener('pointerup', onPressEnd);
            document.removeEventListener('pointercancel', onPressEnd);
            const p = press;
            press = null;
            if (!p || !p.mode) return;
            el.classList.remove('grabbing');
            swallowClick();
            if (p.mode === 'carry') { endCarry(e.type === 'pointerup' ? hitOf(e) : null); return; }
            // 松手后的惯性：停了一下再松手、或者系统要求减少动效时不滑
            let v = performance.now() - p.t > 80 ? 0 : p.v;
            if (Math.abs(v) < 0.15 || (opts.reducedMotion && opts.reducedMotion())) return;
            let last = performance.now();
            const step = () => {
                const now = performance.now();
                const dt = Math.min(48, now - last);
                last = now;
                const before = r.viewport.scrollTop;
                r.viewport.scrollTop = before + v * dt;
                v *= Math.pow(0.995, dt);
                glide = Math.abs(v) > 0.03 && r.viewport.scrollTop !== before ? requestAnimationFrame(step) : 0;
                schedule();
            };
            glide = requestAnimationFrame(step);
        };
        r.viewport.addEventListener('pointerdown', (e) => {
            stopGlide();
            if ((e.button || 0) !== 0 || e.pointerType === 'touch' || e.target.closest('button, input')) return;
            const node = e.target.closest('.archive-list-row');
            press = { x: e.clientX, y: e.clientY, top: r.viewport.scrollTop, scale: pxScale(), k: node ? Number(node.dataset.k) : -1, mode: '', v: 0, t: performance.now() };
            document.addEventListener('pointermove', onPressMove);
            document.addEventListener('pointerup', onPressEnd);
            document.addEventListener('pointercancel', onPressEnd);
        });
        r.viewport.addEventListener('wheel', stopGlide, { passive: true });
        // 行不再用系统的拖放（它一动就开始拖，没法上下拖着滚）
        r.viewport.addEventListener('dragstart', (e) => e.preventDefault());
        const endPress = () => { stopGlide(); onThumbEnd(); if (press && press.mode === 'carry') endCarry(null); press = null; ghost?.remove(); ghost = null; document.removeEventListener('pointermove', onPressMove); document.removeEventListener('pointerup', onPressEnd); document.removeEventListener('pointercancel', onPressEnd); };

        el.querySelector('[data-l="kinds"]').addEventListener('click', (e) => {
            const b = e.target.closest('[data-kind]');
            if (b) setKind(b.dataset.kind);
        });

        // ---------- 排序菜单 ----------
        const sortMode = () => (opts.getSort ? opts.getSort() : 'title');
        const paintSort = () => {
            const mode = sortMode();
            const entry = SORTS.find(([k]) => k === mode) || SORTS[0];
            r.sortName.textContent = entry[1];
            r.sortBtn.title = `排序：${entry[1]}（阵列跟着重排）`;
            r.sortBtn.setAttribute('aria-label', `排序：${entry[1]}`);
            el.dataset.sort = entry[0]; // 表头跟着标出按哪一列排（CSS 用）
            r.colTitle.textContent = entry[0] === 'artist' ? '歌手 / ARTIST' : '曲目 / TITLE';
            r.cols.querySelectorAll('[data-col]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.col === entry[0] || (b.dataset.col === 'title' && entry[0] === 'artist'))));
            r.sortBtn.classList.toggle('on', mode !== 'title');
            r.sortMenu.querySelectorAll('[data-sort]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.sort === mode)));
        };
        const sortOpen = () => !r.sortMenu.hidden;
        // 排序菜单合上时缩回一滴流回点的那一项（共用套件）
        global.MusicFluid?.watchPop?.(r.sortMenu);
        const closeSort = ({ focus = false } = {}) => {
            if (!sortOpen()) return;
            r.sortMenu.hidden = true;
            r.sortBtn.setAttribute('aria-expanded', 'false');
            document.removeEventListener('pointerdown', outside, true);
            if (focus) r.sortBtn.focus();
        };
        const outside = (e) => { if (!e.target.closest || !e.target.closest('.archive-list-sort')) closeSort(); };
        const openSort = () => {
            paintSort();
            r.sortMenu.hidden = false;
            r.sortBtn.setAttribute('aria-expanded', 'true');
            global.MusicFluid?.bud(r.sortMenu, r.sortBtn);
            document.addEventListener('pointerdown', outside, true);
            (r.sortMenu.querySelector('[aria-checked="true"]') || r.sortMenu.querySelector('[data-sort]')).focus();
        };
        const chooseSort = (mode) => {
            closeSort({ focus: true });
            if (mode === sortMode()) return;
            opts.onSort?.(mode); // 阵列和目录一起按新顺序重建
        };
        r.sortBtn.addEventListener('click', (e) => { e.stopPropagation(); sortOpen() ? closeSort() : openSort(); });
        // 表头即排序：点「编号」按添加时间，「曲目」在标题和歌手之间切换，「时长」按时长（排序菜单还在，只是不占一层）
        r.cols.addEventListener('click', (e) => {
            const b = e.target.closest('[data-col]');
            if (!b) return;
            const cur = sortMode();
            const col = b.dataset.col;
            chooseSort(col === 'title' ? (cur === 'title' ? 'artist' : 'title') : col);
        });
        r.sortMenu.addEventListener('click', (e) => {
            const b = e.target.closest('[data-sort]');
            if (!b) return;
            e.stopPropagation();
            chooseSort(b.dataset.sort);
        });
        r.sortMenu.addEventListener('keydown', (e) => {
            const items = [...r.sortMenu.querySelectorAll('[data-sort]')];
            const at = items.indexOf(document.activeElement);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
            } else if (e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                items[e.key === 'Home' ? 0 : items.length - 1].focus();
            } else if (e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                closeSort({ focus: true });
            } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (at >= 0) chooseSort(items[at].dataset.sort);
            } else return;
            e.stopPropagation();
        });

        /*
         * 每个分类记住自己翻到哪里：切走再切回来，回到刚才的位置。
         * 只有离开之后选中的歌变了（在阵列里换了卡、播了别的歌），才改为跟到选中那一行。
         */
        const kindScroll = new Map();
        const setKind = (kind, { auto = false } = {}) => {
            if (!auto) autoKind = null;
            if (kind === state.kind) return;
            kindScroll.set(state.kind, { top: r.viewport.scrollTop, selected: state.selected, query: state.query });
            state.kind = kind;
            // 跟着阵列自动切的不记住，下次打开还是用户自己选的分类
            if (!auto) { try { localStorage.setItem('musicArchiveListKind', kind); } catch (e) { /* 只是记住上次 */ } }
            r.viewport.scrollTop = 0;
            rebuild();
            // 用户自己换的分类告诉档案页，阵列和左上标题跟过去（跟着阵列自动切的不回传，免得来回切）
            if (!auto) opts.onKind?.(kind);
            const k = findRow(state.selected, null);
            if (k >= 0) state.selectedRow = k;
            const back = kindScroll.get(kind);
            if (back && back.selected === state.selected && back.query === state.query) {
                r.viewport.scrollTop = Math.min(back.top, Math.max(0, r.viewport.scrollHeight - r.viewport.clientHeight));
                render();
            } else if (k >= 0) scrollToRow(k, { center: true });
        };

        /*
         * 「转到歌手 / 转到专辑」：换到那个分类、清掉检索词，把这首所在的组顶到最上面并选中它
         * （和主流播放器右键「转到歌手」一样，落点是整组，不是只有这一首）
         */
        const goToGroup = (i, kind) => {
            if (!KINDS.some(([k]) => k === kind)) return false;
            if (state.query) { clearTimeout(typeTimer); r.input.value = ''; state.query = ''; }
            if (kind !== state.kind) setKind(kind); else rebuild();
            const k = findRow(i, null);
            if (k < 0) return false;
            let h = -1;
            for (const hk of state.heads) { if (hk <= k) h = hk; else break; }
            const vp = r.viewport;
            const top = h >= 0 ? state.offsets[h] : state.offsets[k] - LABEL_H;
            // 组太长、这首在一屏以外时，以这首为准居中
            if (state.offsets[k] + ROW_H - top <= (vp.clientHeight || 600)) vp.scrollTop = Math.max(0, top);
            else scrollToRow(k, { center: true });
            pickRow(k);
            r.viewport.focus({ preventScroll: true });
            return true;
        };

        // 放不出来的歌标灰（播放器在加载失败 / 恢复时发这个事件）
        document.addEventListener('music-track-health', () => { for (const [k, node] of state.rendered) paintRow(node, state.rows[k], k); });
        // 喜欢 / 取消喜欢：行尾的小心形要重画（行内容是按需生成的，扔掉已画的行让它重建）
        // 听歌记录变了：「最近」那页的最常听 / 很久没听跟着更新（攒一下再重排，不在播放中途频繁重建）
        let statsTimer = null;
        document.addEventListener('music-stats-change', () => {
            if (state.kind !== 'recent' || statsTimer) return;
            statsTimer = setTimeout(() => { statsTimer = null; if (state.kind === 'recent') rebuild({ steady: true }); }, 800);
        });
        document.addEventListener('music-like-change', () => { for (const node of state.rendered.values()) node.remove(); state.rendered.clear(); render(); });

        const setPlaying = (i) => {
            if (i === state.playing) { schedule(); return; }
            state.playing = i;
            for (const [k, node] of state.rendered) paintRow(node, state.rows[k], k);
        };

        return {
            el,
            rebuild,
            reveal,
            setPlaying,
            setKind,
            goToGroup,
            render: schedule,
            focusSearch: () => { r.input.focus(); r.input.select(); },
            clearMulti, closeBatchMenu,
            get picked() { return pickedIndices(null); },
            endPress,
            destroyDrop: () => { drop?.destroy(); drop = null; dropAt = null; },
            /* 在档案页直接打字：聚焦检索框并带入这个字（替换掉原来的检索词） */
            typeInto: (text) => {
                r.input.focus();
                r.input.value = text;
                r.input.setSelectionRange(text.length, text.length);
                r.input.dispatchEvent(new Event('input', { bubbles: true }));
            },
            input: r.input,
            closeSort,
            get sortOpen() { return sortOpen(); },
            hasFocus: () => el.contains(document.activeElement),
            get kind() { return state.kind; },
            get query() { return state.query; },
            get count() { return state.count; },
            debug: () => ({ kind: state.kind, query: state.query, count: state.count, rows: state.rows.length, selectedRow: state.selectedRow, rendered: state.rendered.size })
        };
    };

    global.MusicArchiveList = Object.freeze({ create, KINDS, SORTS, menuKeyboard });
})(window);
