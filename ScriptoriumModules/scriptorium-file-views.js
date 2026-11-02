// 文坊原位打开各类文件的页面公共部分，不改变原有布局。
// 网页、PDF、表格、文本、图片由各自的脚本绘制，打开时显示在文档区域原来的位置上，
// 原来的文档在后面保持不动。各视图通过 registerOverlay 登记，提供：
//   claims(路径)、open(路径, 选项)、route(其他路径)（打开别的文件前先离开自己；要打开的正是后面那份文档时返回 Promise(true)，否则 null）、
//   leave()、save(选项)、reload()、active()、doc()（kind、filePath、name、dirty、saving、generation），支持另存为的视图另设 saveAs: true。
// 标题栏的文档名和保存状态、“篇章”面板的标题，在视图打开时由这里写入，关闭后还原。
// 视图打开时，原有的保存按钮、Ctrl+S、另存为、“回到首页”作用于当前视图。
// 视图有未保存的修改时，打开别的文件、新建、导入、回到首页、关闭窗口之前，用原有的“未保存”对话框询问。
(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const session = () => window.ScriptoriumFileSession || null;

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

    const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    // 点击原有按钮：按钮的功能和禁用状态以原有实现为准。
    function forward(id) {
        const target = $(id);
        if (!target || target.disabled) return false;
        target.click();
        return true;
    }

    // 视图中用到的图标，画法与 scriptorium.html 中的内联 SVG 一致（线条样式由 scriptorium.css 的 svg 规则统一设置）。
    const ICONS = Object.freeze({
        'i-plus': '<path d="M12 5v14M5 12h14"/>',
        'i-minus': '<path d="M5 12h14"/>',
        'i-x': '<path d="M6 6l12 12M18 6 6 18"/>',
        'i-check': '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
        'i-chevron': '<path d="m6 9 6 6 6-6"/>',
        'i-undo': '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
        'i-redo': '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
        'i-reload': '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
        'i-trash': '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>',
        'i-attach': '<path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/>',
    });
    function icon(id, className = '') {
        return `<svg${className ? ` class="${className}"` : ''} viewBox="0 0 24 24" aria-hidden="true">${ICONS[id] || ''}</svg>`;
    }

    // 视图自己记住的少量布局（网页双栏的分隔位置）。
    const LAYOUT_KEY = 'scriptorium.fileViews.layout';
    const layout = (() => {
        try {
            return { split: 50, ...(JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null') || {}) };
        } catch (_) {
            return { split: 50 };
        }
    })();
    function saveLayout() {
        try {
            localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
        } catch (_) { /* 仅本次有效 */ }
    }

    // --- 菜单：共用一个浮层，挂在 body 上；点击外部或按 Esc 关闭 ---
    const menu = make('div', 'scriptorium-menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    menu.addEventListener('mousedown', (event) => event.preventDefault()); // 点击菜单项不让编辑区失去选区
    let menuState = null;

    function fillMenu(items) {
        for (const item of items) {
            if (!item) continue;
            if (item.sep) { menu.append(make('hr')); continue; }
            if (item.grp) { menu.append(make('div', 'grp', escapeHtml(item.grp))); continue; }
            if (item.empty) { menu.append(make('div', 'empty', escapeHtml(item.empty))); continue; }
            const entry = make('button');
            entry.type = 'button';
            entry.setAttribute('role', item.check === undefined ? 'menuitem' : 'menuitemcheckbox');
            if (item.check !== undefined) entry.setAttribute('aria-checked', String(Boolean(item.check)));
            entry.disabled = Boolean(item.disabled);
            entry.innerHTML = `<span>${escapeHtml(item.label)}</span>`
                + (item.k ? `<span class="k">${escapeHtml(item.k)}</span>` : '')
                + (item.hint ? `<span class="hint">${escapeHtml(item.hint)}</span>` : '');
            entry.addEventListener('click', () => {
                if (menuState) menuState.chosen = true;
                closeMenu();
                item.act?.();
            });
            menu.append(entry);
        }
    }

    function openMenu(items, anchor, options = {}) {
        if (menuState) closeMenu();
        menu.replaceChildren();
        fillMenu(items);
        menu.hidden = false;
        const box = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
        menu.style.minWidth = anchor.getBoundingClientRect ? `${Math.round(box.width)}px` : '';
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        let left = options.alignRight ? box.right - width : box.left;
        let top = box.bottom + 4;
        left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
        if (top + height > window.innerHeight - 8) top = Math.max(8, box.top - height - 4);
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
        menuState = { opener: options.opener || null, onClose: options.onClose || null, chosen: false };
        options.opener?.setAttribute('aria-expanded', 'true');
    }
    function closeMenu() {
        if (!menuState) return;
        menu.hidden = true;
        menuState.opener?.setAttribute('aria-expanded', 'false');
        const { onClose, chosen } = menuState;
        menuState = null;
        if (!chosen) onClose?.();
    }
    function toggleMenu(opener, itemsFn, options = {}) {
        if (menuState && menuState.opener === opener) {
            closeMenu();
            return;
        }
        openMenu(itemsFn(), opener, { opener, ...options });
    }

    const listeners = new Map();
    const UI = {
        $, icon, make, button, forward, setText, escapeHtml, session, layout, saveLayout,
        openMenu, closeMenu, toggleMenu,
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
                    console.error(`[Scriptorium] ${type} 处理出错：`, error);
                }
            });
        },
        doc() {
            // 打开了文件视图时就是该视图的文件，后面的文稿保持不动。
            const top = UI.overlay()?.doc?.();
            if (top) return top;
            // 回到首页时，上一份文档仍留在内存中，此时视为没有打开的文档。
            if ($('welcome-state')?.hidden === false) return null;
            try {
                return session()?.current?.() || null;
            } catch (_) {
                return null;
            }
        },
        // 与原有的 showToast 一样显示在 #toast-region 中。
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
    window.ScriptoriumFileViews = UI;

    // --- 文件视图的登记与路由 ---
    const overlays = [];
    UI.registerOverlay = (view) => { if (view && !overlays.includes(view)) overlays.push(view); };
    UI.overlay = () => overlays.find((view) => view.active?.()) || null;
    UI.overlayFor = (path) => overlays.find((view) => view.claims?.(path)) || null;
    const pathKey = (path) => String(path || '').replace(/\\/g, '/').toLowerCase();

    // --- 未保存的修改：沿用原有的 #unsaved-dialog（保存并继续、舍弃修改、留在此处） ---
    let asking = false;
    function askUnsaved(current, message) {
        const dialog = $('unsaved-dialog');
        if (!dialog || asking) return Promise.resolve('cancel');
        asking = true;
        setText($('unsaved-dialog-message'), message);
        setText($('unsaved-document-name'), current.name || '');
        dialog.hidden = false;
        const answers = { 'unsaved-cancel-btn': 'cancel', 'unsaved-discard-btn': 'discard', 'unsaved-save-btn': 'save' };
        return new Promise((resolve) => {
            const finish = (answer) => {
                dialog.hidden = true;
                dialog.removeEventListener('click', onClick, true);
                document.removeEventListener('keydown', onKey, true);
                asking = false;
                resolve(answer);
            };
            const onClick = (event) => {
                const answer = answers[event.target?.closest?.('button')?.id];
                if (!answer) return;
                event.stopImmediatePropagation();
                finish(answer);
            };
            const onKey = (event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopImmediatePropagation();
                finish('cancel');
            };
            dialog.addEventListener('click', onClick, true);
            document.addEventListener('keydown', onKey, true);
        });
    }
    // 离开当前视图之前调用：没有未保存的修改、或要打开的就是这个文件时直接通过；
    // 选择保存则保存成功后通过，选择舍弃则视图立即离开（修改不保留），选择留在此处返回 false。
    UI.settle = async (path, message = '打开另一份文件前，可以保存当前修改，或舍弃这些修改。') => {
        const top = UI.overlay();
        const current = top?.doc?.();
        if (!current?.dirty || (path && pathKey(path) === pathKey(current.filePath))) return true;
        const answer = await askUnsaved(current, message);
        if (answer === 'cancel') return false;
        if (answer === 'save') return Boolean(await top.save?.());
        top.leave?.();
        return true;
    };

    // scriptorium.js 的 openPath、打开对话框、读取路径先问这里：由某个视图负责的文件交给它打开（上面显示着其他视图时先离开）；
    // 都不负责、但上面显示着视图时，让它先离开，返回 null 由原有流程打开。留在此处时返回 false。
    let routedDocument = '';
    UI.routeOverlay = async (path) => {
        if (!await UI.settle(path)) return false;
        const owner = UI.overlayFor(path);
        const top = UI.overlay();
        if (owner) {
            if (top && top !== owner) top.leave?.();
            return owner.open(path);
        }
        routedDocument = pathKey(path);
        return top ? (top.route?.(path) ?? null) : null;
    };
    // 视图收到 document-replaced 时询问这里：文稿由别处更换（新建、导入）时视图应当让开；
    // 由 openPath 打开、读取较慢时用户可能已打开新的视图，以最后打开的为准。
    UI.replacedByLastOpen = () => Boolean(routedDocument) && pathKey(session()?.current?.()?.filePath) === routedDocument;

    // --- 标题栏、“篇章”面板标题：视图打开时写入，关闭后还原 ---
    const chrome = {
        saved: null,
        leftTools: null,
    };
    function captureChrome() {
        if (chrome.saved) return;
        const outlineTitle = document.querySelector('.outline-header h2');
        chrome.saved = {
            title: $('document-title')?.textContent ?? '',
            titleHint: $('document-title')?.title ?? '',
            state: $('save-state')?.textContent ?? '',
            outlineTitle: outlineTitle?.textContent ?? '',
            outlineCount: $('outline-count')?.textContent ?? '',
            saveDisabled: Boolean($('save-btn')?.disabled),
            saveAsDisabled: Boolean($('save-as-btn')?.disabled),
        };
    }
    function restoreChrome() {
        if (!chrome.saved) return;
        const saved = chrome.saved;
        chrome.saved = null;
        setText($('document-title'), saved.title);
        if ($('document-title')) $('document-title').title = saved.titleHint;
        setText($('save-state'), saved.state);
        setText(document.querySelector('.outline-header h2'), saved.outlineTitle);
        setText($('outline-count'), saved.outlineCount);
        if ($('save-btn')) $('save-btn').disabled = saved.saveDisabled;
        if ($('save-as-btn')) $('save-as-btn').disabled = saved.saveAsDisabled;
        chrome.leftTools?.remove();
        chrome.leftTools = null;
    }
    // PDF、表格把页面缩略图、工作表列表放在“篇章”面板中，面板标题随之改为“页面”“工作表”等。
    UI.setLeftHead = ({ title, count = '', tools = [] } = {}) => {
        if (!UI.overlay()) return;
        captureChrome();
        setText(document.querySelector('.outline-header h2'), title || '');
        setText($('outline-count'), count);
        if (!chrome.leftTools) {
            chrome.leftTools = make('span', 'scriptorium-left-tools');
            $('outline-count')?.after(chrome.leftTools);
        }
        chrome.leftTools.replaceChildren(...tools.filter(Boolean));
    };

    let lastDocKey = null;
    function syncState() {
        const top = UI.overlay();
        const current = UI.doc();
        document.body.classList.toggle('scriptorium-file-view-open', Boolean(top));
        if (top && current) {
            captureChrome();
            setText($('document-title'), current.name || '');
            if ($('document-title')) $('document-title').title = current.filePath || '';
            setText($('save-state'), current.saving ? '正在保存' : current.dirty ? '未保存' : '已保存');
            if ($('save-btn')) $('save-btn').disabled = Boolean(current.readOnly); // 从首页打开时原来的保存按钮是禁用的
            if ($('save-as-btn')) $('save-as-btn').disabled = !top.saveAs; // 另存为只有 PDF 支持
        } else {
            restoreChrome();
        }
        const key = current ? `${current.filePath || ''}|${current.kind}|${current.generation ?? ''}` : null;
        if (key !== lastDocKey) {
            lastDocKey = key;
            // 换了文件：“篇章”面板先显示为空，PDF、表格随后写入自己的标题和列表。
            if (top) UI.setLeftHead({ title: '篇章' });
            UI.emit('document', current);
        }
    }
    UI.sync = syncState;

    // --- 视图打开时，原有的保存、另存为、回到首页作用于当前视图 ---
    // 新建、打开、导入、关闭窗口会换掉或关闭文档：视图有未保存的修改时先询问，处理完再执行原来的操作。
    const LEAVING = new Set(['new-btn', 'new-deck-btn', 'open-btn', 'import-btn', 'close-btn']);
    const welcomeShown = () => $('welcome-state')?.hidden === false;
    async function goHome() {
        const top = UI.overlay();
        if (!top || !await UI.settle(null, '回到首页前，可以保存当前修改，或舍弃这些修改。')) return;
        top.leave?.();
        // 视图是从首页打开的：离开后首页已经露出；否则由原有的“回到首页”处理后面的文档。
        if (session()?.current?.() && !welcomeShown()) $('home-btn')?.click();
    }
    function routeCommand(event) {
        const top = UI.overlay();
        if (!top) return;
        const control = event.target?.closest?.('button');
        const id = control?.id;
        if (id === 'save-btn' || id === 'save-as-btn') {
            event.preventDefault();
            event.stopImmediatePropagation();
            void top.save?.({ saveAs: id === 'save-as-btn' });
        } else if (id === 'home-btn') {
            event.preventDefault();
            event.stopImmediatePropagation();
            void goHome();
        } else if (LEAVING.has(id) && top.doc?.()?.dirty) {
            event.preventDefault();
            event.stopImmediatePropagation();
            const message = id === 'close-btn' ? '关闭 Scriptorium 前，可以保存当前修改。' : undefined;
            void UI.settle(null, message).then((ok) => { if (ok) control.click(); });
        }
    }
    // Ctrl+O、Ctrl+N 同样先询问；Ctrl+F 由有查找栏的视图（PDF、表格）处理，其余视图不让它去查找后面的文档。
    function routeKey(event) {
        const top = UI.overlay();
        if (!top || !(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = event.key.toLowerCase();
        if (key === 's') {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.shiftKey && !top.saveAs) return;
            void top.save?.({ saveAs: event.shiftKey });
        } else if (key === 'f') {
            event.preventDefault();
            event.stopImmediatePropagation();
        } else if ((key === 'o' || key === 'n') && top.doc?.()?.dirty) {
            event.preventDefault();
            event.stopImmediatePropagation();
            void UI.settle().then((ok) => {
                if (ok) window.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, bubbles: true, cancelable: true }));
            });
        }
    }

    function start() {
        document.body.append(menu);
        // 网页、文本、图片等没有篇章结构，打开时“篇章”面板中显示这句（scriptorium-file-views.css）。
        $('outline-panel')?.append(make('p', 'scriptorium-file-note scriptorium-left-empty', '这类文件没有篇章结构。'));
        document.addEventListener('click', routeCommand, true);
        document.addEventListener('keydown', routeKey, true);
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && menuState) {
                closeMenu();
                event.stopPropagation();
            }
        }, true);
        document.addEventListener('pointerdown', (event) => {
            const target = event.target;
            if (menuState && !menu.contains(target) && !(menuState.opener && menuState.opener.contains(target))) closeMenu();
        }, true);
        window.addEventListener('blur', closeMenu);
        window.addEventListener('resize', () => UI.emit('resize'));
        // 窗口重新获得焦点或重新可见时，各视图立即检查文件是否被外部修改。
        window.addEventListener('focus', () => UI.emit('disk-check'));
        document.addEventListener('visibilitychange', () => { if (!document.hidden) UI.emit('disk-check'); });
        const watch = new MutationObserver(syncState);
        for (const id of ['welcome-state', 'document-workspace']) {
            if ($(id)) watch.observe($(id), { attributes: true, attributeFilter: ['hidden'] });
        }
        session()?.subscribe?.(() => setTimeout(syncState, 0));
        UI.emit('start');
        syncState();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
