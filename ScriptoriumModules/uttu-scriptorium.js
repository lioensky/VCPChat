// 文坊的 扩展层（第二版布局
// “文坊（第二稿）”）。上游编辑器、文档模型、Agent 端口不动，这里把上游的部件搬进新布局并换皮：
// - 顶栏一行：左上角“文件”菜单、文档名、保存状态；中间 编辑 / 双栏 / 预览；右边专注、右侧面板开关（独立窗口时再加窗口按钮）。
// - 最左活动栏：文库、目录、搜索在最上面，设置在最下面；点一下打开左侧面板对应的一页，再点一下收起。
// - 中间两栏：编辑栏（所见 = 上游连续编辑面，源码 / CSS = 上游源码面）和预览栏（上游阅读面）。
// - 右侧检查器：格式、文档、批注、文脉（uttu-scriptorium-inspector.js）；左侧三页的内容在 uttu-scriptorium-panels.js；
//   工具条、选区浮条、/ 插入在 uttu-scriptorium-edit.js。
// 结构在脚本加载时（上游初始化之前）就搭好：带 data-command 的按钮由上游格式控制器绑定和同步状态，上游元素的 id 全保留。
(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const SPRITE = '../assets/uttu/icons/uttu-icons.svg';
    const NARROW = 760;
    const LAYOUT_KEY = 'uttu.scriptorium.layout';
    const icon = (id, className = '') => `<svg${className ? ` class="${className}"` : ''} viewBox="0 0 24 24" aria-hidden="true"><use href="${SPRITE}#${id}"></use></svg>`;
    const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const session = () => window.UTTUScriptoriumSession || null;


    function make(tag, className, html) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (html !== undefined) element.innerHTML = html;
        return element;
    }

    function setText(element, text) {
        if (element && element.textContent !== text) element.textContent = text;
    }

    function button(className, label, html, onClick) {
        const element = make('button', className, html);
        element.type = 'button';
        if (label) element.setAttribute('aria-label', label);
        if (onClick) element.addEventListener('click', onClick);
        return element;
    }

    // 转发到上游按钮：上游按钮还在（藏着），功能、禁用状态都以它为准。
    function forward(id) {
        const target = $(id);
        if (!target || target.disabled) return false;
        target.click();
        return true;
    }

    // --- 布局记忆：视图、两栏各自的编辑方式、左右面板 ---
    const layout = (() => {
        const defaults = { view: 'edit', editor: { edit: 'wysiwyg', split: 'source' }, left: 'outline', right: false, rtab: 'doc', split: 50 };
        try {
            const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
            const merged = saved ? { ...defaults, ...saved, editor: { ...defaults.editor, ...(saved.editor || {}) } } : defaults;
            if (merged.left === 'tasks') merged.left = 'lib'; // 待办页 去掉
            // 双栏只放源码（双栏里放“所见”和预览是同一张纸两份），老布局里记的“双栏 + 所见”换成源码。
            if (merged.editor.split === 'wysiwyg') merged.editor.split = 'source';
            return merged;
        } catch (_) {
            return defaults;
        }
    })();
    function saveLayout() {
        try {
            localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
        } catch (_) { /* 只在这次有效 */ }
    }

    // --- 菜单：一个共用的浮层，挂在 body 上；点外面、Esc 关掉 ---
    const menu = make('div', 'uttu-menu uttu-floating-menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    // 点菜单项不能让编辑面的选区丢掉（格式、插入都按选区来）。
    menu.addEventListener('mousedown', (event) => event.preventDefault());
    let menuState = null;
    // 项目写 sub: [...]，鼠标移上去或点一下，右边再出一列。
    const submenu = make('div', 'uttu-menu uttu-floating-menu');
    submenu.setAttribute('role', 'menu');
    submenu.hidden = true;
    submenu.addEventListener('mousedown', (event) => event.preventDefault());
    // 鼠标斜着走向二级菜单时会路过别的项：等一小会儿再换，和系统菜单一样。
    const SUBMENU_DELAY_MS = 120;
    let submenuTimer = 0;
    const laterSubmenu = (action) => { clearTimeout(submenuTimer); submenuTimer = setTimeout(action, SUBMENU_DELAY_MS); };
    submenu.addEventListener('mouseenter', () => clearTimeout(submenuTimer));
    function openSubmenu(entry, items) {
        clearTimeout(submenuTimer);
        submenu.replaceChildren();
        fillMenu(submenu, items);
        submenu.hidden = false;
        const box = entry.getBoundingClientRect();
        const width = submenu.offsetWidth;
        const height = submenu.offsetHeight;
        const left = box.right + 2 + width > window.innerWidth - 8 ? box.left - width - 2 : box.right + 2;
        submenu.style.left = `${Math.round(Math.max(8, left))}px`;
        submenu.style.top = `${Math.round(Math.max(8, Math.min(box.top - 5, window.innerHeight - height - 8)))}px`;
    }

    function fillMenu(target, items, options = {}) {
        for (const item of items) {
            if (!item) continue;
            if (item.sep) { target.append(make('hr')); continue; }
            if (item.grp) { target.append(make('div', 'grp', escapeHtml(item.grp))); continue; }
            if (item.empty) { target.append(make('div', 'empty', escapeHtml(item.empty))); continue; }
            const entry = make('button');
            entry.type = 'button';
            entry.setAttribute('role', item.check === undefined ? 'menuitem' : 'menuitemcheckbox');
            if (item.check !== undefined) entry.setAttribute('aria-checked', String(Boolean(item.check)));
            entry.disabled = Boolean(item.disabled);
            if (item.again) entry.classList.add('again'); // 搜索时不重复列（字体的“最近用过”）
            // 选中项亮一档（uttu-controls.css），不留勾选列。
            const lead = item.gl ? `<span class="gl">${escapeHtml(item.gl)}</span>`
                : item.icon && options.glyphs ? `<span class="gl">${icon(item.icon)}</span>` : '';
            entry.innerHTML = `${lead}<span>${escapeHtml(item.label)}</span>`
                + (item.k ? `<span class="k">${escapeHtml(item.k)}</span>` : '')
                + (item.hint ? `<span class="hint">${escapeHtml(item.hint)}</span>` : '')
                + (item.sub ? '<span class="k">›</span>' : '');
            if (target === menu) entry.addEventListener('mouseenter', () => laterSubmenu(() => { if (item.sub) openSubmenu(entry, item.sub); else submenu.hidden = true; }));
            entry.addEventListener('click', () => {
                if (item.sub) { openSubmenu(entry, item.sub); return; }
                if (menuState) menuState.chosen = true;
                closeMenu();
                item.act?.();
            });
            target.append(entry);
        }
    }

    function openMenu(items, anchor, options = {}) {
        const again = Boolean(menuState) && menuState.mode === 'slash' && options.mode === 'slash';
        if (menuState && !again) closeMenu();
        menu.replaceChildren();
        submenu.replaceChildren();
        submenu.hidden = true;
        menu.classList.remove('searching');
        if (options.search) menu.append(searchBox(options.search));
        fillMenu(menu, items, options);
        menu.classList.toggle('still', again);
        menu.hidden = false;
        const box = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
        // 至少和打开它的按钮一样宽，别的按内容。
        menu.style.minWidth = anchor.getBoundingClientRect ? `${Math.round(box.width)}px` : '';
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        let left = options.alignRight ? box.right - width : box.left;
        let top = box.bottom + 4;
        left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
        if (top + height > window.innerHeight - 8) top = Math.max(8, box.top - height - 4);
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
        menuState = { opener: options.opener || null, mode: options.mode || 'menu', onClose: options.onClose || null, chosen: false };
        options.opener?.setAttribute('aria-expanded', 'true');
        if (options.search) setTimeout(() => menu.querySelector('.uttu-menu-search')?.focus(), 0);
        if (options.mode === 'slash' || options.mode === 'insert') menu.querySelector('button:not(:disabled)')?.classList.add('on');
    }
    // 长列表顶上的搜索框（字体 300 多项）：留下名字含有这些字的项，回车选第一个。
    function searchBox(placeholder) {
        const input = make('input', 'uttu-menu-search');
        input.placeholder = placeholder;
        input.setAttribute('aria-label', placeholder);
        input.addEventListener('mousedown', (event) => event.stopPropagation());
        input.addEventListener('input', () => {
            const wanted = input.value.trim().toLowerCase();
            menu.classList.toggle('searching', Boolean(wanted));
            for (const entry of menu.querySelectorAll('button')) entry.hidden = Boolean(wanted) && !entry.textContent.toLowerCase().includes(wanted);
        });
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            menu.querySelector('button:not([hidden]):not(.again)')?.click();
        });
        return input;
    }
    function closeMenu() {
        if (!menuState) return;
        menu.hidden = true;
        clearTimeout(submenuTimer);
        submenu.hidden = true;
        menuState.opener?.setAttribute('aria-expanded', 'false');
        const { onClose, chosen } = menuState;
        menuState = null;
        if (!chosen) onClose?.(); // 没选就关掉了
    }
    function toggleMenu(opener, itemsFn, options = {}) {
        if (menuState && menuState.opener === opener) {
            closeMenu();
            return;
        }
        openMenu(itemsFn(), opener, { opener, ...options });
    }
    function moveMenuActive(step) {
        const entries = [...menu.querySelectorAll('button:not(:disabled)')];
        if (!entries.length) return;
        const index = entries.findIndex((entry) => entry.classList.contains('on'));
        entries.forEach((entry) => entry.classList.remove('on'));
        const next = entries[(index + step + entries.length) % entries.length];
        next.classList.add('on');
        next.scrollIntoView({ block: 'nearest' });
    }

    // --- 公共接口：其他 VCP 脚本（面板、检查器、编辑工具）挂在这里 ---
    const listeners = new Map();
    const UI = {
        $, icon, make, button, forward, setText, escapeHtml, session, layout, saveLayout,
        openMenu, closeMenu, toggleMenu, moveMenuActive,
        menuState: () => menuState,
        menuElement: menu,
        on(type, listener) {
            const bucket = listeners.get(type) || new Set();
            bucket.add(listener);
            listeners.set(type, bucket);
            return () => bucket.delete(listener);
        },
        emit(type, detail) {
            [...(listeners.get(type) || [])].forEach((listener) => {
                try {
                    listener(detail);
                } catch (error) {
                    console.error(`[VCP 文坊] ${type} 处理出错：`, error);
                }
            });
        },
        doc() {
            // 开着盖在文稿上的视图（网页 .html、PDF、表格，统一登记，见下面 registerOverlay）时就是它，
            // 上游的文档藏在后面不动。
            const top = UI.overlay()?.doc?.();
            if (top) return top;
            // 关掉回到空状态（上游首页）时上一份文档还留在内存里，这时当作没有打开的文档。
            if ($('welcome-state')?.hidden === false) return null;
            try {
                return session()?.current?.() || null;
            } catch (_) {
                return null;
            }
        },
        isDeck() {
            return UI.doc()?.kind === 'slide-deck';
        },
        // 连续（长页）还是分纸张：continuous 是长页。
        paged() {
            const current = UI.doc();
            if (!current) return false;
            return current.kind === 'slide-deck' || current.paginationMode !== 'continuous';
        },
        narrow: () => document.body.classList.contains('uttu-narrow'),
        // 和上游 showToast 一样落在 #toast-region（上游的通知端口不对外）。
        toast(message, type = 'info', duration = 2600) {
            const region = $('toast-region');
            if (!region || !message) return;
            const toast = make('div', `toast ${type}`);
            toast.textContent = message;
            region.append(toast);
            setTimeout(() => {
                toast.style.opacity = '0';
                setTimeout(() => toast.remove(), 180);
            }, duration);
        },
    };
    window.UTTUScriptoriumUI = UI;

    // --- 盖在文稿上的视图：网页（uttu-scriptorium-page.js）、PDF（-pdf.js）、表格（-table.js）。它们不是上游的文稿，
    // 打开时把上游的文档藏在后面不动。原来只有网页一种，十来处地方直接问 UTTUScriptoriumPage；现在都问这里。
    // 每个视图给：claims(路径)、open(路径, 选项)、route(别的路径)（开别的东西时先离开自己，要开的正是后面那份时回 Promise(true)，否则 null）、
    // leave()、close()、save()、reload()、fileItems(上下文)、forget(路径)、active()、doc()（kind、filePath、name、dirty、saving、generation）。
    const overlays = [];
    UI.registerOverlay = (view) => { if (view && !overlays.includes(view)) overlays.push(view); };
    UI.overlay = () => overlays.find((view) => view.active?.()) || null;
    UI.overlayFor = (path) => overlays.find((view) => view.claims?.(path)) || null;
    // scriptorium.js 的 openPath 先问这里：归某个视图管的交给它开（上面盖着别的视图就先离开）；都不归、上面盖着视图时让它先离开。
    let routedDocument = '';
    let refused = null; // 刚才打不开的那份和原因：Agent 的 OpenDocument 不用等到超时
    const pathKey = (path) => String(path || '').replace(/\\/g, '/').toLowerCase();
    UI.refused = (path) => (refused?.key === pathKey(path) ? refused.why : '');
    UI.noteOpen = (path, opening) => Promise.resolve(opening).then((opened) => {
        refused = opened === false ? { key: pathKey(path), why: $('toast-region')?.lastElementChild?.textContent || '文坊没打开这个文件。' } : null;
        return opened;
    });
    UI.routeOverlay = (path) => {
        const owner = UI.overlayFor(path);
        const top = UI.overlay();
        if (owner) {
            if (top && top !== owner) top.leave?.();
            return owner.open(path);
        }
        routedDocument = pathKey(path);
        return top ? (top.route?.(path) ?? null) : null;
    };
    // 视图收到 document-replaced 时问这里。文稿是别处换的（新建、导入），视图要让开；是前面 openPath 开的、读得慢，这时人已经开了新视图，最后开的算数。
    UI.replacedByLastOpen = () => Boolean(routedDocument) && pathKey(session()?.current?.()?.filePath) === routedDocument;

    // --- 顶栏 ---
    const top = {};
    function buildTopbar() {
        const bar = document.querySelector('.scriptorium-titlebar');
        if (!bar) return;
        bar.classList.add('uttu-topbar');
        const left = make('div', 'uttu-top-l');
        // “文件”两个字换成菜单图标（三横、最下面一横短）。
        top.file = button('uttu-tb uttu-file-btn', '文件菜单', icon('i-menu'), () => toggleMenu(top.file, fileItems));
        top.file.setAttribute('aria-haspopup', 'menu');
        top.file.setAttribute('aria-expanded', 'false');
        top.title = make('span', 'uttu-title-edit');
        top.title.id = 'uttu-title';
        top.saved = button('uttu-saved', '', '', () => {
            if (!top.saved.classList.contains('can')) return;
            if (UI.overlay()) void UI.overlay().save?.();
            else forward('save-btn');
        });
        top.agent = button('uttu-agent', '', '', () => UI.emit('agent-status-click'));
        top.agent.hidden = true;
        // Agent 在读、在改（uttu-scriptorium-inspector.js 按 Agent 请求设置）。
        UI.setAgent = (text, { busy = false } = {}) => {
            top.agent.hidden = !text;
            top.agent.classList.toggle('busy', busy);
            top.agent.innerHTML = text ? `${busy ? '<span class="uttu-dots uttu-wait" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}<span>${escapeHtml(text)}</span>` : '';
        };
        left.append(top.file, top.title, top.saved, top.agent);

        const center = make('div', 'uttu-top-c');
        top.view = make('div', 'uttu-seg uttu-view-seg');
        top.view.setAttribute('role', 'group');
        top.view.setAttribute('aria-label', '视图');
        // 三个互斥的视图，原来是“编辑 / 双栏 / 预览”乘编辑栏里“所见 / 源码 / CSS”。
        for (const [value, label] of [['read', '阅读'], ['edit', '编辑'], ['source', '源码']]) {
            const option = button('', '', label, () => setMode(value));
            option.dataset.v = value;
            top.view.append(option);
        }
        center.append(top.view);

        const right = make('div', 'uttu-top-r');
        top.focus = button('uttu-tb', '专注模式', icon('i-focus'), () => forward('focus-mode-btn'));
        // 上游那颗在不能专注时藏起，这颗跟着，不留点了没反应的按钮。
        const focusSource = $('focus-mode-btn');
        if (focusSource) {
            top.focus.hidden = focusSource.hidden;
            new MutationObserver(() => { top.focus.hidden = focusSource.hidden; }).observe(focusSource, { attributes: true, attributeFilter: ['hidden'] });
        }
        top.inspector = button('uttu-tb uttu-insp-btn', '格式、文档、批注与文脉', icon('i-panel-right'), () => setRight(!layout.right));
        right.append(top.focus, top.inspector);
        // 独立窗口时窗口按钮留在最右（停在主窗口右栏时 CSS 藏起）。
        const divider = bar.querySelector('.titlebar-divider');
        if (divider) right.append(divider);
        for (const id of ['minimize-btn', 'maximize-btn', 'close-btn']) {
            if ($(id)) right.append($(id));
        }
        bar.append(left, center, right);
        // 上游的标题、保存状态在藏起来的 document-identity 里；文档名照它显示。
        const source = $('document-title');
        if (source) {
            const sync = () => {
                // 文库里的文稿、演示都带扩展名，顶栏只写名字。开着网页时写网页的文件名。
                const page = UI.overlay()?.doc?.();
                const name = page ? page.name : source.textContent.trim().replace(/\.(vdocx|vpptx)$/i, '');
                top.title.textContent = name || '文坊';
                top.title.classList.toggle('muted', !name);
            };
            new MutationObserver(sync).observe(source, { childList: true, characterData: true, subtree: true });
            sync();
            UI.syncTitle = sync;
        }
    }

    function fileItems() {
        const current = UI.doc();
        // 网页有自己的一份（保存、重新载入、在文件夹里显示），新建、打开照常（uttu-scriptorium-page.js）。
        const overlay = UI.overlay();
        if (overlay?.fileItems) {
            return overlay.fileItems({ openNewDialog, open: () => forward('open-btn'), importFile: () => forward('import-btn') });
        }
        const has = Boolean(current);
        return [
            { label: '新建', k: 'Ctrl N', act: openNewDialog },
            { label: '新建白板', act: () => void window.UTTUScriptoriumBoard?.create() }, // uttu-scriptorium-board.js
            { label: '新建设计', act: () => void window.UTTUScriptoriumDesign?.create() }, // uttu-scriptorium-design.js
            { label: '打开文件', k: 'Ctrl O', act: () => forward('open-btn') },
            { label: '打开文件夹', act: () => window.UTTUScriptoriumFolder?.choose?.() }, // 加进工作区
            { sep: true },
            { label: '另存为', k: 'Ctrl ⇧ S', disabled: !has || $('save-as-btn')?.disabled, act: () => forward('save-as-btn') },
            // 三个导出项收成一个，点开选格式；导入挨着它。
            { label: '导出', disabled: !has, act: () => toggleMenu(top.file, exportItems) },
            { label: '导入为文稿', act: () => forward('import-btn') },
            // 从磁盘重新读（uttu-scriptorium-markdown.js，有改动先问）
            { label: '重新载入', k: 'F5', disabled: !current?.filePath, act: () => window.UTTUScriptoriumMarkdown?.reloadFromDisk?.() },
            // 从 .md 打开的，转成文稿工程（uttu-scriptorium-markdown.js，图片一起装进去）
            ...(current?.markdownFile ? [{ label: '转成文稿工程', act: () => window.UTTUScriptoriumMarkdown?.convert?.() }] : []),
            // .md 按分隔线一页一页放（uttu-scriptorium-show.js）
            ...(current?.markdownFile && window.UTTUScriptoriumShow ? [{ label: '放映', hint: '按 --- 分页', act: () => window.UTTUScriptoriumShow.play() }] : []),
            { label: '关闭', disabled: !has, act: () => forward('home-btn') },
        ];
    }
    function exportItems() {
        const paged = Boolean(UI.doc()) && UI.paged();
        const noPage = UI.doc() && !paged ? '长页没有分页' : '';
        return [
            { label: '网页（连续）', disabled: $('export-flow-html-btn')?.disabled || UI.isDeck(), act: () => forward('export-flow-html-btn') },
            { label: '网页（分页）', disabled: !paged || $('export-paged-html-btn')?.disabled, hint: noPage, act: () => forward('export-paged-html-btn') },
            { label: 'PDF', disabled: !paged || $('export-pdf-btn')?.disabled, hint: noPage, act: () => forward('export-pdf-btn') },
        ];
    }

    // --- 保存状态：已保存 · 字数；有改动；关掉自动保存时是“保存”按钮 ---
    function renderSaved() {
        const current = UI.doc();
        if (!current) {
            setText(top.saved, '');
            return;
        }
        const words = UI.overlay() ? '' : ($('word-count')?.textContent || '').trim(); // 网页、PDF 没有字数
        const manual = current.dirty && (current.manualSave || !autosaveOn()); // PDF 不自动保存（manualSave，uttu-scriptorium-pdf.js）
        top.saved.classList.toggle('dirty', current.dirty && !current.saving);
        top.saved.classList.toggle('can', manual);
        setText(top.saved, current.readOnly ? '只读' : current.saving ? '正在保存'
            : manual ? '没保存，点这里保存'
                : current.dirty ? '有改动'
                    : UI.narrow() || !words ? '已保存' : `已保存 · ${words}`);
    }

    // --- 活动栏 ---
    const rail = {};
    function buildRail(stage) {
        rail.element = make('nav', 'uttu-arail');
        rail.element.setAttribute('aria-label', '文坊导航');
        // 一个图标一页（uttu-scriptorium-explorer.js）。分隔线上面是文件从哪来，下面是当前这份文件。
        // 文库、目录、搜索固定在最上面，以后加的都排在分隔线下面，挤不到这三个。文件和文库合成一页。
        for (const item of [['lib', '文库', 'i-folder'], ['outline', '目录', 'i-outline'], ['find', '搜索', 'i-search'], null,
            ['notes', '笔记', 'i-edit']]) {
            if (!item) {
                rail.element.append(make('span', 'sep'));
                continue;
            }
            const [key, label, glyph] = item;
            const entry = button('uttu-tb', label, icon(glyph), () => toggleLeft(key));
            entry.dataset.left = key;
            rail.element.append(entry);
        }
        rail.element.append(make('span', 'grow'));
        rail.element.append(button('uttu-tb', '设置', icon('i-settings'), () => window.UTTUScriptoriumSettings?.open())); // 文坊的设置都在这里
        stage.prepend(rail.element);
    }

    // --- 左右面板的宽度：贴着内侧边界拖动改宽，记进布局。
    // 窄窗口（停在右栏）里面板盖在内容上，也能拖，最宽到离右边 80 像素。 ---
    const PANEL_WIDTH = { left: { key: 'leftWidth', css: '--uttu-l-open', def: 240 }, right: { key: 'rightWidth', css: '--uttu-r-open', def: 288 } };
    function applyPanelWidth(side) {
        const spec = PANEL_WIDTH[side];
        const width = Number(layout[spec.key]);
        if (Number.isFinite(width)) document.body.style.setProperty(spec.css, `${Math.round(width)}px`);
        else document.body.style.removeProperty(spec.css);
    }
    function addPanelResizer(panel, side) {
        const spec = PANEL_WIDTH[side];
        const handle = make('div', `uttu-panel-resize ${side}`);
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-orientation', 'vertical');
        handle.setAttribute('aria-label', side === 'left' ? '调整左侧面板宽度' : '调整右侧面板宽度');
        let start = null;
        handle.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            handle.setPointerCapture(event.pointerId);
            start = { x: event.clientX, width: panel.getBoundingClientRect().width };
            document.body.classList.add('uttu-panel-resizing');
        });
        // 浏览器已按帧合并指针移动，这里直接改宽度。
        handle.addEventListener('pointermove', (event) => {
            if (!start) return;
            const stage = panel.parentElement?.getBoundingClientRect().width || window.innerWidth;
            const delta = (event.clientX - start.x) * (side === 'left' ? 1 : -1);
            const widest = UI.narrow() ? stage - 80 : Math.min(560, stage - 420);
            layout[spec.key] = Math.min(Math.max(180, start.width + delta), Math.max(180, widest));
            applyPanelWidth(side);
        });
        const finish = () => {
            if (!start) return;
            start = null;
            document.body.classList.remove('uttu-panel-resizing');
            saveLayout();
            requestAnimationFrame(() => UI.emit('resize'));
        };
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
        // 双击回到默认宽度。
        handle.addEventListener('dblclick', () => {
            delete layout[spec.key];
            applyPanelWidth(side);
            saveLayout();
            requestAnimationFrame(() => UI.emit('resize'));
        });
        panel.append(handle);
        applyPanelWidth(side);
    }

    // --- 左侧面板（上游 #outline-panel）：一行面板头，下面按活动栏切换文库 / 篇章 / 查找 ---
    const left = {};
    function buildLeft() {
        const panel = $('outline-panel');
        if (!panel) return;
        left.panel = panel;
        addPanelResizer(panel, 'left');
        left.head = make('div', 'uttu-phead uttu-left-head');
        left.title = make('b');
        left.count = make('small');
        left.tools = make('span', 'uttu-left-tools');
        left.head.append(left.title, left.count, make('span', 'grow'), left.tools);
        panel.prepend(left.head);
    }
    const LEFT_TITLES = { lib: '文库', notes: '笔记', outline: '目录', find: '搜索' };
    function toggleLeft(key) {
        const open = document.body.classList.contains('uttu-left-open');
        if (open && layout.left === key) setLeft(false);
        else setLeft(true, key);
    }
    function setLeft(open, key = layout.left) {
        if (key) layout.left = key === 'library' ? 'lib' : key; // 'library' 是合并之前的页名，存着的布局里可能还有
        if (open && UI.narrow()) setRight(false);
        document.body.classList.toggle('uttu-left-open', Boolean(open));
        document.body.dataset.uttuLeft = layout.left;
        if (left.title) left.title.textContent = LEFT_TITLES[layout.left] || '';
        if (!UI.narrow()) layout.leftOpen = Boolean(open);
        saveLayout();
        rail.element?.querySelectorAll('[data-left]').forEach((entry) => {
            entry.setAttribute('aria-pressed', String(Boolean(open) && entry.dataset.left === layout.left));
        });
        UI.emit('left', { open: Boolean(open), key: layout.left });
        requestAnimationFrame(() => UI.emit('resize'));
    }
    UI.setLeft = setLeft;
    UI.openLeft = (key) => setLeft(true, key);
    UI.setLeftHead = ({ title, count = '', tools = [] } = {}) => {
        if (title !== undefined) left.title.textContent = title;
        left.count.textContent = count;
        left.tools.replaceChildren(...tools);
    };

    // --- 右侧检查器：四页的外壳，内容由 uttu-scriptorium-inspector.js 填 ---
    const right = {};
    function buildRight(stage) {
        right.element = make('aside', 'uttu-insp');
        right.element.setAttribute('aria-label', '检查器');
        const head = make('div', 'uttu-insp-head');
        right.tabs = make('div', 'uttu-seg full');
        right.tabs.setAttribute('role', 'group');
        right.tabs.setAttribute('aria-label', '检查器');
        right.pages = {};
        // 加“链接”页（.md 的链出和反向链接，uttu-scriptorium-links.js）。
        // “文档”并进“格式”（样式、版式放在下半），五个标签太挤。
        for (const [key, label] of [['format', '格式'], ['comments', '批注'], ['lineage', '文脉'], ['links', '链接']]) {
            const tab = button('', '', `${label}<small></small>`, () => setRightTab(key));
            tab.dataset.t = key;
            right.tabs.append(tab);
            const page = make('div', 'uttu-insp-page');
            page.dataset.t = key;
            page.hidden = true;
            right.pages[key] = page;
        }
        head.append(right.tabs);
        right.element.append(head, ...Object.values(right.pages));
        // 文脉页就是上游的文脉面板（刻点、待审、自动允许都在里面）。
        const lineage = $('lineage-panel');
        if (lineage) right.pages.lineage.append(lineage);
        stage.append(right.element);
        addPanelResizer(right.element, 'right');
    }
    function setRight(open) {
        layout.right = Boolean(open);
        if (open && UI.narrow()) setLeft(false);
        document.body.classList.toggle('uttu-right-open', layout.right);
        top.inspector?.setAttribute('aria-pressed', String(layout.right));
        saveLayout();
        if (open) setRightTab(layout.rtab);
        requestAnimationFrame(() => UI.emit('resize'));
    }
    function setRightTab(wanted) {
        const key = wanted === 'doc' ? 'format' : wanted;
        layout.rtab = key;
        saveLayout();
        right.tabs.querySelectorAll('button').forEach((tab) => tab.setAttribute('aria-pressed', String(tab.dataset.t === key)));
        Object.entries(right.pages).forEach(([name, page]) => { page.hidden = name !== key; });
        UI.emit('right-tab', key);
    }
    UI.setRight = setRight;
    UI.setRightTab = setRightTab;
    UI.openRight = (key) => {
        if (key) layout.rtab = key === 'doc' ? 'format' : key;
        setRight(true);
    };
    UI.rightPage = (key) => right.pages[key === 'doc' ? 'format' : key];
    UI.setRightBadge = (key, text) => {
        const tab = right.tabs.querySelector(`[data-t="${key}"] small`);
        if (tab) tab.textContent = text || '';
    };

    // --- 中间两栏：编辑栏（所见 / 源码 / CSS）| 分隔条 | 预览栏 ---
    const panes = {};
    function buildPanes() {
        const workspace = $('document-workspace');
        if (!workspace) return;
        workspace.classList.add('uttu-panes');
        const edit = make('section', 'uttu-pane ed');
        edit.setAttribute('aria-label', '编辑');
        panes.editHead = make('div', 'uttu-pane-head');
        panes.editorSeg = make('div', 'uttu-seg sm');
        panes.editorSeg.setAttribute('role', 'group');
        panes.editorSeg.setAttribute('aria-label', '编辑方式');
        for (const [value, label] of [['wysiwyg', '所见'], ['source', '源码'], ['css', 'CSS']]) {
            const option = button('', '', label, () => setEditor(value));
            option.dataset.e = value;
            panes.editorSeg.append(option);
        }
        panes.editorSeg.hidden = true; // 所见 / 源码由顶栏的“编辑”“源码”定；CSS 从检查器“文档”页进
        // 语言跟着文件走，不手选；文稿工程有两份源码，只在源码视图里分“正文 / 样式”。
        panes.sourceSeg = make('div', 'uttu-seg sm uttu-source-seg');
        panes.sourceSeg.setAttribute('role', 'group');
        panes.sourceSeg.setAttribute('aria-label', '源码');
        for (const [value, label] of [['source', '正文'], ['css', '样式']]) {
            const option = button('', '', label, () => setEditor(value));
            option.dataset.e = value;
            panes.sourceSeg.append(option);
        }
        panes.sourceSeg.hidden = true;
        panes.tools = make('div', 'uttu-pane-tools');
        panes.editHead.append(panes.editorSeg, panes.sourceSeg, panes.tools);
        panes.editBody = make('div', 'uttu-pane-body');
        for (const id of ['render-host', 'source-host', 'source-right-host']) {
            if ($(id)) panes.editBody.append($(id));
        }
        edit.append(panes.editHead, panes.editBody);

        panes.split = make('div', 'uttu-split');
        panes.split.setAttribute('role', 'separator');
        panes.split.setAttribute('aria-orientation', 'vertical');
        panes.split.setAttribute('aria-label', '拖动调整两栏宽度，双击回到一半');

        const preview = make('section', 'uttu-pane pv');
        preview.setAttribute('aria-label', '预览');
        panes.previewHead = make('div', 'uttu-pane-head');
        panes.previewInfo = make('span', 'uttu-pane-label', '预览<small></small>');
        panes.present = button('uttu-tb-drop plain', '', '放映', () => UI.emit('present'));
        panes.present.hidden = true;
        panes.zoomOut = button('uttu-tb', '缩小', icon('i-minus'), () => stepPreviewZoom(-10));
        panes.zoomValue = button('uttu-tb-drop plain', '', '100%', () => setPreviewZoom(previewZoom === 'fit' ? 100 : 'fit'));
        panes.zoomIn = button('uttu-tb', '放大', icon('i-plus'), () => stepPreviewZoom(10));
        panes.previewHead.append(panes.previewInfo, make('span', 'grow'), panes.present, panes.zoomOut, panes.zoomValue, panes.zoomIn);
        panes.previewBody = make('div', 'uttu-pane-body');
        if ($('read-host')) panes.previewBody.append($('read-host'));
        preview.append(panes.previewHead, panes.previewBody);
        workspace.append(edit, panes.split, preview);
        panes.edit = edit;
        panes.preview = preview;
        workspace.style.setProperty('--uttu-split', `${layout.split}%`);

        panes.split.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            panes.split.setPointerCapture(event.pointerId);
            panes.split.classList.add('drag');
            const box = workspace.getBoundingClientRect();
            const move = (moveEvent) => {
                layout.split = Math.round(Math.min(78, Math.max(22, (moveEvent.clientX - box.left) / box.width * 100)));
                workspace.style.setProperty('--uttu-split', `${layout.split}%`);
            };
            const up = () => {
                panes.split.classList.remove('drag');
                panes.split.removeEventListener('pointermove', move);
                panes.split.removeEventListener('pointerup', up);
                panes.split.removeEventListener('pointercancel', up);
                saveLayout();
                UI.emit('resize');
            };
            panes.split.addEventListener('pointermove', move);
            panes.split.addEventListener('pointerup', up);
            panes.split.addEventListener('pointercancel', up);
        });
        panes.split.addEventListener('dblclick', () => {
            layout.split = 50;
            workspace.style.setProperty('--uttu-split', '50%');
            saveLayout();
        });
    }
    UI.paneTools = () => panes.tools;
    UI.previewHead = () => panes.previewHead;

    // 预览缩放：只管预览栏（阅读面），默认“适合宽度”。上游的缩放给分页的每一页加 transform，版面宽度不变，
    // 栏比纸窄时会横着溢出；这里在阅读面画完以后给整个阅读面容器套 CSS zoom（连版面一起缩），分页已经排好，不受影响。
    let previewZoom = 'fit';
    let previewScale = 1;
    function applyPreviewZoom() {
        if (show.on) {
            fitShow();
            return;
        }
        // 原来只找分页的版面，长页文档和 .md 是连续版面，找不到就直接退出，
        // 点放大缩小没反应。连续版面也套 CSS zoom；“适合宽度”对它就是 100%（它本来就随栏宽排）。
        const runtime = session()?.readRoot?.()?.querySelector('.vdoc-paged-runtime, .vdoc-flow-runtime');
        if (!runtime) return;
        runtime.style.zoom = '';
        const page = runtime.querySelector('.vdoc-page');
        let scale = 1;
        if (previewZoom === 'fit') {
            const width = page?.getBoundingClientRect().width || 0;
            const room = (panes.previewBody?.clientWidth || 0) - 40;
            if (width > 0 && room > 0) scale = Math.min(1, room / width);
        } else {
            scale = previewZoom / 100;
        }
        previewScale = scale;
        if (Math.abs(scale - 1) > 0.001) runtime.style.zoom = String(Number(scale.toFixed(3)));
        setText(panes.zoomValue, previewZoom === 'fit' ? (page ? '适合宽度' : '100%') : `${previewZoom}%`);
    }
    function setPreviewZoom(value) {
        previewZoom = value === 'fit' ? 'fit' : Math.max(50, Math.min(200, Math.round(value / 10) * 10));
        applyPreviewZoom();
    }
    function stepPreviewZoom(step) {
        const base = previewZoom === 'fit' ? Math.round(previewScale * 10) * 10 : previewZoom;
        setPreviewZoom(base + step);
    }
    UI.applyPreviewZoom = applyPreviewZoom;

    // 所见编辑面和预览是同一张纸：上游连续编辑面的字色跟界面主题（暗色界面就是浅字），边距按整个窗口宽算。
    // 这里给编辑面的影子根补一张样式表：字色、纸色用文档自己的 --vdoc-ink / --vdoc-paper（和阅读面的纸一样），边距按栏宽算。
    const paperSheet = (() => {
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(`:host { --primary-text: var(--vdoc-ink, #1d2421); }
.vdoc-flow-runtime {
    width: 100%;
    max-width: 920px;
    min-height: 100%;
    padding: 44px clamp(20px, 7%, 72px) 140px;
    color: var(--vdoc-ink, #1d2421);
    caret-color: currentColor;
}
.vdoc-flow-runtime pre { max-width: 100%; overflow-x: auto; }`);
            return sheet;
        } catch (_) {
            return null;
        }
    })();
    const paintedRoots = new WeakSet();
    function paintPaper() {
        const root = session()?.editRoot?.();
        const host = $('render-host');
        if (!root || !host) return;
        if (paperSheet && 'adoptedStyleSheets' in root && !root.adoptedStyleSheets.includes(paperSheet)) {
            root.adoptedStyleSheets = [...root.adoptedStyleSheets, paperSheet];
        }
        // 上游重画编辑面（换一页、换文档）时换掉影子根里的内容：跟着再量一次。
        if (!paintedRoots.has(root)) {
            paintedRoots.add(root);
            new MutationObserver(() => requestAnimationFrame(paintPaper)).observe(root, { childList: true });
        }
        const runtime = root.querySelector('.vdoc-flow-runtime');
        // 演示的编辑面是一页一页的场景，有自己的底色。
        const paper = runtime ? getComputedStyle(runtime).getPropertyValue('--vdoc-paper').trim() || '#fffdf8' : '';
        if (host.style.backgroundColor !== paper) host.style.backgroundColor = paper;
        // 演示的一页按原尺寸画（16:9 的场景），栏比它窄时整页缩到栏宽。
        const slide = root.querySelector('.vdoc-slide-editor-runtime');
        if (slide) {
            slide.style.zoom = '';
            const width = slide.getBoundingClientRect().width;
            const room = host.clientWidth - 48;
            const scale = width > room && room > 0 ? room / width : 1;
            if (scale < 1) slide.style.zoom = String(Number(scale.toFixed(3)));
        }
    }
    UI.on('resize', () => requestAnimationFrame(paintPaper));
    UI.paintPaper = paintPaper;
    // 源码面是 CodeMirror：挪了位置、换了大小要刷新，不然行号栏宽度算错、盖住正文。
    function refreshSource() {
        const run = () => {
            try {
                session()?.sourceEditor?.()?.refresh?.();
            } catch (_) { /* 没开源码面 */ }
        };
        // 源码可能稍后才载入（换文档、切工作面），过一会儿再刷两次。
        requestAnimationFrame(run);
        setTimeout(run, 180);
        setTimeout(run, 700);
    }
    UI.on('resize', () => {
        refreshSource();
        applyPreviewZoom();
    });

    // --- 视图：编辑 / 双栏 / 预览；编辑栏里 所见 / 源码 / CSS ---
    const SURFACE_OF = { wysiwyg: 'edit', source: 'source-html', css: 'source-css' };
    const slot = () => (layout.view === 'split' ? 'split' : 'edit');
    const editorKind = () => layout.editor[slot()] || 'wysiwyg';
    UI.editorKind = editorKind;
    // 临时视图：只管当前这份文档、不记下来（从 .md 打开时先看阅读视图，uttu-scriptorium-markdown.js）；点视图按钮就作废。
    let viewOverride = null;
    UI.view = () => viewOverride || layout.view;

    function effectiveView() {
        const view = viewOverride || layout.view;
        return UI.narrow() && view === 'split' ? 'edit' : view;
    }
    function setView(view) {
        viewOverride = null;
        layout.view = view;
        saveLayout();
        applyView();
    }
    UI.setViewOverride = (view) => {
        viewOverride = view || null;
        applyView();
    };
    function setEditor(kind) {
        layout.editor[slot()] = kind;
        saveLayout();
        applyView();
    }
    UI.setView = setView;
    UI.setEditor = setEditor;
    // --- 三个视图：阅读 = 预览；编辑 = 一栏所见即所得；源码 = 左源码右预览（窄的时候只有源码）。
    // 盖在原来的 view × editor 上，setView / setEditor 照旧能用（冒烟、检查器的“编辑这份文档的 CSS”）；CSS 算在源码里。
    function modeOf() {
        const view = viewOverride || layout.view;
        if (view === 'preview') return 'read';
        if (view === 'split') return 'source';
        return editorKind() === 'wysiwyg' ? 'edit' : 'source';
    }
    function setMode(mode) {
        viewOverride = null;
        if (mode === 'read') {
            layout.view = 'preview';
        } else if (mode === 'edit') {
            layout.view = 'edit';
            layout.editor.edit = 'wysiwyg';
        } else {
            layout.view = UI.narrow() ? 'edit' : 'split';
            if (layout.editor[slot()] === 'wysiwyg') layout.editor[slot()] = 'source';
        }
        saveLayout();
        applyView();
    }
    UI.mode = modeOf;
    UI.setMode = setMode;
    // 打开文档时上游问这里要进哪个工作面（scriptorium-session.js activateDocument）。
    UI.openSurface = (file) => {
        const view = UI.markdownView?.(file) || effectiveView();
        return view === 'preview' ? 'read' : SURFACE_OF[editorKind()];
    };
    // 同一份文件重新载入后，上游把工作面切回编辑面，但文档没换、syncState 不会再套视图：载完调这个（uttu-scriptorium-markdown.js reload）。
    UI.applyView = () => applyView();

    let previewTimer = 0;
    function applyView() {
        const view = effectiveView();
        document.body.classList.toggle('uttu-view-edit', view === 'edit');
        document.body.classList.toggle('uttu-view-split', view === 'split');
        document.body.classList.toggle('uttu-view-preview', view === 'preview');
        const kind = editorKind();
        const mode = modeOf();
        top.view?.querySelectorAll('button').forEach((option) => option.setAttribute('aria-pressed', String(option.dataset.v === mode)));
        const project = UI.doc() && !UI.overlay() && !UI.doc().markdownFile;
        if (panes.sourceSeg) {
            panes.sourceSeg.hidden = !project || kind === 'wysiwyg' || view === 'preview';
            panes.sourceSeg.querySelector('[data-e="source"]').textContent = UI.isDeck() ? '页面' : '正文';
            panes.sourceSeg.querySelectorAll('button').forEach((option) => option.setAttribute('aria-pressed', String(option.dataset.e === kind)));
        }
        panes.editorSeg?.querySelectorAll('button').forEach((option) => option.setAttribute('aria-pressed', String(option.dataset.e === kind)));
        document.body.dataset.uttuEditor = kind;
        const api = session();
        if (!api || !UI.doc()) return;
        const wanted = view === 'preview' ? 'read' : SURFACE_OF[kind];
        // 文档刚替换、渲染适配器还没装好时上游会抛错：下一轮状态同步再切。
        try {
            if (api.surface() !== wanted) api.switchSurface(wanted);
        } catch (error) {
            setTimeout(syncState, 120);
            return;
        }
        if (view === 'split') {
            showPreviewHost();
            schedulePreview(true);
        }
        if (view === 'preview') setTimeout(applyPreviewZoom, 60);
        if (kind !== 'wysiwyg') refreshSource();
        else requestAnimationFrame(paintPaper);
        UI.emit('view', { view, kind });
    }
    UI.applyView = applyView;

    // 双栏时上游切工作面会把阅读面藏起来：在这里摆回来。
    function showPreviewHost() {
        const host = $('read-host');
        if (host && host.hidden) host.hidden = false;
    }
    function schedulePreview(now = false) {
        if (effectiveView() !== 'split') return;
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
            showPreviewHost();
            try {
                session()?.renderPreview?.();
            } catch (error) {
                console.error('[VCP 文坊] 预览没画出来：', error);
            }
            applyPreviewZoom();
            // 分页可能下一帧才排完，再套一次。
            setTimeout(applyPreviewZoom, 120);
            UI.emit('preview-rendered');
        }, now ? 0 : 450);
    }
    UI.schedulePreview = schedulePreview;

    // --- 双栏一起滚：编辑栏滚到哪一节，预览栏跟到同一节的同一位置（按标题对齐，标题之间按比例）---
    const HEADINGS = 'h1, h2, h3';
    const renderedHeadings = (root) => [...root.querySelectorAll(HEADINGS)].filter((node) => !node.closest('[data-vdoc-island]'));
    function sourceHeadingLines(editor) {
        const lines = [];
        let fence = false;
        editor.eachLine((handle) => {
            const text = handle.text;
            if (/^\s*(```|~~~)/.test(text)) fence = !fence;
            else if (!fence && /^#{1,3}\s/.test(text)) lines.push(editor.getLineNumber(handle));
        });
        return lines;
    }
    let syncFrame = 0;
    function syncPreviewScroll() {
        cancelAnimationFrame(syncFrame);
        syncFrame = requestAnimationFrame(() => {
            if (effectiveView() !== 'split' || show.on) return;
            const api = session();
            const read = api?.readRoot?.();
            const readHost = $('read-host');
            if (!read || !readHost || readHost.hidden) return;
            const targets = renderedHeadings(read);
            const kind = editorKind();
            let index = -1;
            let fraction = 0;
            let ratio = 0;
            if (kind === 'wysiwyg') {
                const host = $('render-host');
                const root = api.editRoot?.();
                if (!host || !root) return;
                const top = host.getBoundingClientRect().top + 8;
                const marks = renderedHeadings(root).map((node) => node.getBoundingClientRect().top);
                marks.forEach((value, k) => { if (value <= top) index = k; });
                if (index >= 0) {
                    const next = marks[index + 1] ?? (marks[index] + host.scrollHeight);
                    fraction = Math.max(0, Math.min(1, (top - marks[index]) / Math.max(1, next - marks[index])));
                }
                ratio = host.scrollTop / Math.max(1, host.scrollHeight - host.clientHeight);
            } else if (kind === 'source') {
                const editor = api.sourceEditor?.();
                if (!editor) return;
                const info = editor.getScrollInfo();
                // 顶边正好压在两行之间时算下一行（差几像素就会落到上一节的末尾）。
                const line = editor.lineAtHeight(info.top + 4, 'local');
                const lines = sourceHeadingLines(editor);
                lines.forEach((value, k) => { if (value <= line) index = k; });
                if (index >= 0) {
                    const next = lines[index + 1] ?? editor.lineCount();
                    fraction = Math.max(0, Math.min(1, (line - lines[index]) / Math.max(1, next - lines[index])));
                }
                ratio = info.top / Math.max(1, info.height - info.clientHeight);
            } else {
                return;
            }
            const base = readHost.getBoundingClientRect().top - readHost.scrollTop;
            const at = (node) => node.getBoundingClientRect().top - base;
            let target;
            if (index >= 0 && targets[index]) {
                const start = at(targets[index]);
                const end = targets[index + 1] ? at(targets[index + 1]) : readHost.scrollHeight;
                target = start + fraction * (end - start) - 8;
            } else {
                target = ratio * (readHost.scrollHeight - readHost.clientHeight);
            }
            readHost.scrollTop = Math.max(0, target);
        });
    }
    // 一大步跳过去时 CodeMirror 还没量过新露出来的行，行高是估的；停下 160ms 后再对一次。
    let settleTimer = 0;
    function onEditorScroll() {
        syncPreviewScroll();
        clearTimeout(settleTimer);
        settleTimer = setTimeout(syncPreviewScroll, 160);
    }
    let syncedEditor = null;
    function bindScrollSync() {
        $('render-host')?.addEventListener('scroll', onEditorScroll, { passive: true });
        const editor = session()?.sourceEditor?.();
        if (editor && editor !== syncedEditor) {
            syncedEditor = editor;
            editor.on('scroll', onEditorScroll);
        }
    }
    UI.syncPreviewScroll = syncPreviewScroll;
    UI.on('view', bindScrollSync);
    UI.on('preview-rendered', syncPreviewScroll);

    function renderPreviewInfo() {
        const current = UI.doc();
        const small = panes.previewInfo?.querySelector('small');
        if (!small) return;
        if (!current) {
            setText(small, '');
            return;
        }
        if (current.kind === 'slide-deck') {
            const pages = $('slide-count')?.textContent?.trim();
            setText(small, pages ? `${pages} · 16:9` : '16:9');
        } else {
            setText(small, current.paginationMode === 'continuous' ? '长页' : 'A4 分页');
        }
        // .md 也能放映（按分隔线分页，uttu-scriptorium-show.js）
        const presentable = current.kind === 'slide-deck' || Boolean(current.markdownFile && window.UTTUScriptoriumShow);
        if (panes.present.hidden !== !presentable) panes.present.hidden = !presentable;
    }

    // --- 没打开文档时：上游首页改成空状态（新建、打开文件、最近）---
    function buildEmpty() {
        const welcome = $('welcome-state');
        if (!welcome) return;
        welcome.classList.add('uttu-empty-state');
        const head = make('div', 'uttu-empty-head', '<h4>没有打开的文档</h4>');
        const actions = make('div', 'uttu-empty-acts');
        actions.append(
            button('uttu-btn primary', '新建', `${icon('i-plus')}新建`, openNewDialog),
            button('uttu-btn ghost', '打开文件', '打开文件', () => forward('open-btn')),
            // 打开文件夹（加进工作区，左栏资源管理器）
            button('uttu-btn ghost', '打开文件夹', '打开文件夹', () => window.UTTUScriptoriumFolder?.choose?.()),
        );
        head.append(actions);
        welcome.prepend(head);
        const recent = $('recent-documents');
        if (recent) recent.before(make('div', 'uttu-empty-group', '最近打开'));
    }

    // --- 新建：版式、样式、起步（uttu-doc-themes.js），选好再创建 ---
    let dialog = null;
    function openNewDialog() {
        closeMenu();
        const themes = window.UTTUDocThemes;
        if (!themes || !session() || !window.VDocCore) {
            forward('new-btn');
            return;
        }
        if (!dialog) dialog = buildNewDialog(themes);
        dialog.open();
    }
    function buildNewDialog(themes) {
        const state = { layout: 'long', theme: 'uttu-ink', template: 'explain' };
        const scrim = make('div', 'uttu-dlg-scrim');
        scrim.hidden = true;
        const box = make('div', 'uttu-dlg');
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-label', '新建');
        box.innerHTML = '<h4>新建 <span class="uttu-eyebrow">New</span></h4>';
        function field(label, content) {
            const wrap = make('div', 'uttu-field', `<span class="lab">${label}</span>`);
            wrap.append(content);
            box.append(wrap);
            return wrap;
        }
        const layoutSeg = make('div', 'uttu-seg full');
        for (const item of themes.LAYOUTS) {
            const option = button('', '', escapeHtml(item.id === 'page' ? 'A4 文稿' : item.name), () => { state.layout = item.id; render(); });
            option.dataset.v = item.id;
            layoutSeg.append(option);
        }
        field('版式', layoutSeg);
        const tiles = make('div', 'uttu-tiles');
        for (const item of themes.THEMES) {
            const tile = button('uttu-tile', '', `<span class="pv" style="background:${item.swatch.paper};color:${item.swatch.ink}"><i></i><i></i><i></i></span><span>${escapeHtml(item.name)}</span>`, () => { state.theme = item.id; render(); });
            tile.dataset.v = item.id;
            tiles.append(tile);
        }
        const themeField = field('样式', tiles);
        const starterSeg = make('div', 'uttu-seg full sm');
        for (const item of themes.TEMPLATES) {
            const option = button('', '', escapeHtml(item.name), () => {
                state.template = item.id;
                if (item.layout) state.layout = item.layout;
                if (item.theme) state.theme = item.theme;
                render();
            });
            option.dataset.v = item.id;
            starterSeg.append(option);
        }
        const starterField = field('起步', starterSeg);
        const acts = make('div', 'acts');
        acts.append(
            button('uttu-btn ghost', '', '取消', close),
            button('uttu-btn primary', '', '创建', create),
        );
        box.append(acts);
        scrim.append(box);
        scrim.addEventListener('pointerdown', (event) => { if (event.target === scrim) close(); });
        document.body.append(scrim);

        function render() {
            layoutSeg.querySelectorAll('button').forEach((option) => option.setAttribute('aria-pressed', String(option.dataset.v === state.layout)));
            tiles.querySelectorAll('button').forEach((tile) => tile.setAttribute('aria-pressed', String(tile.dataset.v === state.theme)));
            starterSeg.querySelectorAll('button').forEach((option) => option.setAttribute('aria-pressed', String(option.dataset.v === state.template)));
            // 演示有自己的场景，不用文档样式和起步模板。
            themeField.hidden = state.layout === 'deck';
            starterField.hidden = state.layout === 'deck';
        }
        function close() {
            scrim.hidden = true;
        }
        // 新建的文档一开始就落在文库目录里（不重名），建好立刻存一次，之后自动保存。
        async function create() {
            close();
            const deck = state.layout === 'deck';
            const options = deck
                ? { kind: window.VDocCore.PROJECT_KINDS.SLIDE_DECK, title: '未命名演示' }
                : themes.documentOptions(state);
            const filePath = await window.scriptoriumAPI?.newDocumentPath?.({ title: options.title, kind: deck ? 'pptx' : 'docx' })
                .catch(() => null);
            const metadata = filePath ? { filePath, name: filePath.split(/[\\/]/).pop() } : {};
            await session().create(window.VDocCore.createDocument(options), metadata);
            if (filePath) forward('save-btn');
        }
        return Object.freeze({
            open() {
                render();
                scrim.hidden = false;
            },
            close,
            isOpen: () => !scrim.hidden,
        });
    }
    UI.openNewDialog = openNewDialog;
    UI.fileItems = () => fileItems(); // 命令面板把文件菜单里的事也列进去（uttu-scriptorium-commands.js）

    // --- 自动保存：有文件路径的文档改动停下 2.5 秒就存一次（文件菜单里可以关）---
    const AUTOSAVE_KEY = 'uttu.scriptorium.autosave';
    const AUTOSAVE_IDLE_MS = 2500;
    function autosaveOn() {
        try {
            return localStorage.getItem(AUTOSAVE_KEY) !== 'off';
        } catch (_) {
            return true;
        }
    }
    function setAutosave(on) {
        try {
            localStorage.setItem(AUTOSAVE_KEY, on ? 'on' : 'off');
        } catch (_) { /* 只在这次有效 */ }
        renderSaved();
    }
    let autosavePaused = false;
    UI.pauseAutosave = (on) => { autosavePaused = Boolean(on); };
    UI.autosaveOn = () => autosaveOn();
    UI.setAutosave = (on) => setAutosave(on); // 网页的文件菜单也有这一项（uttu-scriptorium-page.js）
    function installAutosave() {
        let lastRevision = null;
        let changedAt = 0;
        let composing = false;
        document.addEventListener('compositionstart', () => { composing = true; }, true);
        document.addEventListener('compositionend', () => { composing = false; changedAt = Date.now(); }, true);
        setInterval(() => {
            const current = UI.doc();
            // .md 被别处改了、正等用户选用哪一边时先不存（uttu-scriptorium-markdown.js 的 UI.pauseAutosave）。
            if (!current || !current.filePath || !current.dirty || current.saving || !autosaveOn() || autosavePaused) {
                lastRevision = current?.revision ?? null;
                return;
            }
            if (current.revision !== lastRevision) {
                lastRevision = current.revision;
                changedAt = Date.now();
                return;
            }
            // 输入法正在组字时不存，免得打断候选词。
            if (composing || Date.now() - changedAt < AUTOSAVE_IDLE_MS) return;
            quietUntil = Date.now() + 4000;
            forward('save-btn');
        }, 700);
        // 自动保存不弹“已保存”（顶栏已经写着）；手动保存、存失败照常提示。
        let quietUntil = 0;
        const region = $('toast-region');
        if (region) {
            new MutationObserver((records) => {
                if (Date.now() > quietUntil) return;
                for (const record of records) {
                    record.addedNodes.forEach((node) => {
                        if (node.nodeType === 1 && !node.classList.contains('error') && /^已保存/.test(node.textContent.trim())) node.remove();
                    });
                }
            }).observe(region, { childList: true });
        }
    }

    // --- 界面不留悬停提示：title 挪成 aria-label（只限外壳，文档内容不动）---
    const CHROME = '.scriptorium-titlebar, .uttu-arail, .outline-panel, .uttu-insp, .uttu-pane-head, .welcome-state, .focus-mode-dock, .uttu-menu, .uttu-bubble, .selection-format-bar';
    function moveTitle(element) {
        if (!element.closest(CHROME)) return;
        const title = element.getAttribute('title');
        if (title === null) return;
        if (title && !element.hasAttribute('aria-label')) element.setAttribute('aria-label', title);
        element.removeAttribute('title');
    }
    function stripTitles() {
        document.querySelectorAll('[title]').forEach(moveTitle);
        new MutationObserver((records) => {
            for (const record of records) {
                if (record.type === 'attributes') moveTitle(record.target);
                else record.addedNodes.forEach((node) => {
                    if (node.nodeType !== 1) return;
                    if (node.hasAttribute('title')) moveTitle(node);
                    node.querySelectorAll?.('[title]').forEach(moveTitle);
                });
            }
        }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
    }

    // 对话里点“看改动”：打开文脉，按修改摘要找到那一条并打开它的对比；找不到就打开最新一条。
    function showChange(summary, retry = true) {
        UI.openRight('lineage');
        const items = [...document.querySelectorAll('#lineage-flow .checkpoint-item')];
        if (!items.length && retry) {
            setTimeout(() => showChange(summary, false), 600);
            return;
        }
        const item = (summary && items.find((node) => node.textContent.includes(summary))) || items[0];
        item?.click();
    }
    UI.showChange = showChange;

    // --- 放映（演示）：预览栏全屏，一次一页；←→、空格、点一下翻页，Esc 退出 ---
    const show = { on: false, index: 0, before: null };
    function showPages() {
        return [...(session()?.readRoot?.()?.querySelectorAll('.vdoc-page') || [])];
    }
    function fitShow() {
        const runtime = session()?.readRoot?.()?.querySelector('.vdoc-paged-runtime');
        const pages = showPages();
        if (!runtime || !pages.length) return;
        runtime.style.zoom = '';
        pages.forEach((page, k) => { page.style.display = k === show.index ? '' : 'none'; });
        const box = pages[show.index].getBoundingClientRect();
        const room = panes.previewBody.getBoundingClientRect();
        if (!box.width || !box.height) return;
        const scale = Math.min(room.width / box.width, room.height / box.height) * 0.98;
        runtime.style.zoom = String(Number(scale.toFixed(3)));
        // 竖着居中：整条阅读流往下挪到这一页在正中。
        const stream = $('read-page-stream');
        if (stream) {
            stream.style.transform = '';
            const placed = pages[show.index].getBoundingClientRect();
            stream.style.transform = `translateY(${Math.round(room.top + (room.height - placed.height) / 2 - placed.top)}px)`;
        }
    }
    function goShow(index) {
        const pages = showPages();
        if (!pages.length) return;
        show.index = Math.max(0, Math.min(pages.length - 1, index));
        fitShow();
    }
    async function startShow() {
        if (!UI.isDeck() || show.on) return;
        show.on = true;
        show.before = layout.view;
        show.index = 0;
        layout.view = 'preview';
        applyView();
        document.body.classList.add('uttu-presenting');
        try {
            await panes.preview.requestFullscreen();
        } catch (_) { /* 不能全屏就在窗口里放 */ }
        setTimeout(() => goShow(0), 150);
    }
    function endShow() {
        if (!show.on) return;
        show.on = false;
        document.body.classList.remove('uttu-presenting');
        showPages().forEach((page) => { page.style.display = ''; });
        if ($('read-page-stream')) $('read-page-stream').style.transform = '';
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        layout.view = show.before || 'split';
        applyView();
        setTimeout(applyPreviewZoom, 120);
    }
    UI.on('present', () => (UI.doc()?.markdownFile && window.UTTUScriptoriumShow ? window.UTTUScriptoriumShow.play() : startShow()));

    // --- 跟着状态走：有没有文档、窄不窄、是文稿还是演示 ---
    let lastDocKey = null;
    function syncState() {
        const body = document.body;
        const current = UI.doc();
        const empty = !current;
        body.classList.toggle('uttu-empty', empty);
        // 首页没有文档，目录是空的：左栏回到文库。搜索还能找所有文件，留着。
        if (empty && layout.left === 'outline') setLeft(body.classList.contains('uttu-left-open'), 'lib');
        body.classList.toggle('uttu-kind-deck', current?.kind === 'slide-deck');
        const narrow = window.innerWidth <= NARROW;
        if (narrow !== body.classList.contains('uttu-narrow')) {
            body.classList.toggle('uttu-narrow', narrow);
            // 窄的时候两侧面板盖在内容上，默认收着；变宽时按记下的摆回来。
            if (narrow) {
                body.classList.remove('uttu-left-open', 'uttu-right-open');
                rail.element?.querySelectorAll('[data-left]').forEach((entry) => entry.setAttribute('aria-pressed', 'false'));
                top.inspector?.setAttribute('aria-pressed', 'false');
            } else {
                setLeft(layout.leftOpen !== false, layout.left);
                setRight(layout.right);
            }
            applyView();
        }
        // 同一份文件重新打开也算换文档（generation 加一）。上游重新打开时把工作面切回编辑面，只认路径的话视图不再套，
        // 界面还是“预览”、阅读面却没了（外部改动不刷新、大文件第一屏没地方放，都是这个）。
        const key = current ? `${current.filePath || ''}|${current.kind}|${current.generation ?? ''}` : null;
        if (key !== lastDocKey) {
            lastDocKey = key;
            if (current) applyView();
            refreshSource();
            UI.emit('document', current);
        }
        renderSaved();
        renderPreviewInfo();
        window.UTTUScriptoriumSession?.syncFocus?.();
    }
    UI.sync = syncState;

    // --- 搭结构（上游初始化之前）---
    const stage = document.querySelector('.scriptorium-stage');
    document.body.classList.add('uttu-v2');
    document.body.classList.remove('outline-collapsed', 'lineage-collapsed');
    buildTopbar();
    if (stage) {
        buildRail(stage);
        buildLeft();
        buildRight(stage);
    }
    buildPanes();
    buildEmpty();
    document.body.append(menu, submenu);
    UI.emit('build');

    function start() {
        // 上游的篇章、文脉开关在顶栏里藏着；它们只切 body 的类，这里一直不用。
        document.body.classList.remove('outline-collapsed', 'lineage-collapsed');
        const narrow = window.innerWidth <= NARROW;
        document.body.classList.toggle('uttu-narrow', narrow);
        setLeft(!narrow && layout.leftOpen !== false, layout.left);
        setRight(!narrow && layout.right);
        installAutosave();
        stripTitles();
        window.scriptoriumAPI?.onShowChange?.((payload) => showChange(String(payload?.summary || '')));
        // 文档改了：双栏时重画预览；状态、字数跟着刷新。
        const api = session();
        // 上游在派发事件的当下还在换文档（适配器可能没装好），放到下一轮再处理。
        api?.subscribe?.((event) => {
            setTimeout(() => {
                if (event.type === 'document-mutated' || event.type === 'document-replaced') schedulePreview(event.type === 'document-replaced');
                UI.emit('doc-event', event);
                syncState();
                paintPaper();
            }, 0);
        });
        // 源码面从藏着到摆出、或者换了大小（拖分隔条、开合面板），CodeMirror 都要刷新一次。
        const sourceHost = $('source-host');
        if (sourceHost && window.ResizeObserver) new ResizeObserver(refreshSource).observe(sourceHost);
        // 预览栏换了大小，“适合宽度”跟着重算。
        if (panes.previewBody && window.ResizeObserver) new ResizeObserver(() => applyPreviewZoom()).observe(panes.previewBody);
        // 双栏时上游切换工作面会把阅读面藏起来，摆回来。
        const readHost = $('read-host');
        if (readHost) {
            new MutationObserver(() => {
                if (effectiveView() === 'split' && readHost.hidden && UI.doc()) showPreviewHost();
            }).observe(readHost, { attributes: true, attributeFilter: ['hidden'] });
        }
        // 只看上游自己的状态元素；不能看整个 document-workspace 的子树，栏头文字就在里面，会自己触发自己。
        const watch = new MutationObserver(syncState);
        for (const id of ['welcome-state', 'document-workspace']) {
            if ($(id)) watch.observe($(id), { attributes: true, attributeFilter: ['hidden'] });
        }
        for (const id of ['word-count', 'save-state', 'slide-count']) {
            if ($(id)) watch.observe($(id), { childList: true, characterData: true, subtree: true });
        }
        window.addEventListener('resize', () => {
            syncState();
            UI.emit('resize');
        });
        // 点外面关菜单；窄的时候点正文收起盖在上面的面板。
        document.addEventListener('pointerdown', (event) => {
            const target = event.target;
            if (menuState && !menu.contains(target) && !submenu.contains(target) && !(menuState.opener && menuState.opener.contains(target))) closeMenu();
            if (UI.narrow() && !menu.contains(target)) {
                if (document.body.classList.contains('uttu-left-open') && !left.panel?.contains(target) && !rail.element?.contains(target)) setLeft(false);
                if (document.body.classList.contains('uttu-right-open') && !right.element?.contains(target) && !top.inspector?.contains(target)) setRight(false);
            }
        }, true);
        document.addEventListener('keydown', (event) => {
            if (show.on) {
                const steps = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ' ': 1, Enter: 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1, Backspace: -1 };
                if (event.key === 'Escape') endShow();
                else if (event.key === 'Home') goShow(0);
                else if (event.key === 'End') goShow(showPages().length - 1);
                else if (steps[event.key]) goShow(show.index + steps[event.key]);
                else return;
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            // Ctrl E：阅读和编辑之间切。网页、PDF、表格盖在上面时不管。
            if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'e' && UI.doc() && !UI.overlay()) {
                event.preventDefault();
                event.stopPropagation();
                setMode(modeOf() === 'read' ? 'edit' : 'read');
                return;
            }
            // Ctrl N 打开“新建”面板（上游直接建一张 A4 白纸）。
            if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
                event.preventDefault();
                event.stopPropagation();
                openNewDialog();
                return;
            }
            if (event.key === 'Escape') {
                if (menuState) {
                    closeMenu();
                    event.stopPropagation();
                    return;
                }
                if (dialog?.isOpen()) dialog.close();
            }
        }, true);
        window.addEventListener('blur', closeMenu);
        panes.previewBody?.addEventListener('click', () => {
            if (show.on) goShow(show.index + 1 < showPages().length ? show.index + 1 : show.index);
        });
        document.addEventListener('fullscreenchange', () => {
            if (show.on && !document.fullscreenElement) endShow();
            else if (show.on) setTimeout(fitShow, 60);
        });
        UI.emit('start');
        syncState();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
