/* Side pane "+" menu: the registered open-tab entries, then the apps. */
'use strict';
import { createSidePaneEntries } from './side-pane-entries.js';
import { placeMenuAt } from './menu-position.js';

/**
 * 「+」只负责开新标签：点了在按钮下面弹一个小菜单，上面是登记的入口（浏览器、终端、Git 变更……），
 * 下面是应用。只登记了一个入口又没有应用时，「+」直接打开它，不弹菜单。
 *   onShow()           菜单打开前调用，用来收起别的浮层
 *   onEntriesChanged() 入口变化后标签条要重新排（「+」按钮可能出现或消失）
 */
export function createSidePaneAddMenu({ addButton = null, menu = null, onShow = () => {}, onEntriesChanged = () => {} }) {
    const doc = (menu || addButton)?.ownerDocument || globalThis.document;
    const win = doc?.defaultView || globalThis.window;
    const cleanups = [];
    let disposed = false;
    let appsProvider = null;
    let apps = new Map();

    const find = selector => menu?.querySelector?.(selector) || null;
    const toolsGroup = find('[data-add-menu-group="tools"]');
    const appsGroup = find('[data-add-menu-group="apps"]');
    const appsHeading = find('.side-pane-add-menu-heading');
    const separator = find('.side-pane-add-menu-separator');

    const isOpen = () => Boolean(menu && !menu.hidden);

    function hide() {
        if (!menu || menu.hidden) return;
        menu.hidden = true;
        addButton?.setAttribute('aria-expanded', 'false');
    }

    // 只有一个入口、没有应用时「+」直接打开它，按钮名字也换成那个入口
    function directEntry(entries = entriesOwner.availableEntries()) {
        return entries.length === 1 && !appsProvider ? entries[0] : null;
    }

    function syncButton(entries = entriesOwner.availableEntries()) {
        if (!addButton) return;
        addButton.hidden = entries.length === 0 && !appsProvider;
        const direct = directEntry(entries);
        const label = direct ? direct.label : '新标签页';
        addButton.title = label;
        addButton.setAttribute('aria-label', label);
        if (direct || !menu) {
            addButton.removeAttribute('aria-haspopup');
            addButton.removeAttribute('aria-expanded');
        } else {
            addButton.setAttribute('aria-haspopup', 'menu');
            addButton.setAttribute('aria-expanded', String(isOpen()));
        }
    }

    const entriesOwner = createSidePaneEntries({
        doc,
        list: toolsGroup,
        hideMenus: hide,
        onEntriesChanged: (entries) => {
            syncButton(entries);
            onEntriesChanged();
        }
    });

    function readApps() {
        try {
            return appsProvider?.() || [];
        } catch (error) {
            console.warn('[SidePaneAddMenu] Failed to read apps:', error);
            return [];
        }
    }

    function createAppRow(app) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'side-pane-menu-item';
        btn.setAttribute('role', 'menuitem');
        btn.setAttribute('data-add-menu-app', app.id);
        if (app.title) btn.title = app.title;
        const iconEl = doc.createElement('span');
        iconEl.className = 'side-pane-add-menu-app-icon';
        iconEl.setAttribute('aria-hidden', 'true');
        if (app.iconSvg) {
            iconEl.innerHTML = app.iconSvg;
        } else {
            const fallback = doc.createElement('span');
            fallback.className = 'vcp-ui-icon';
            fallback.textContent = 'app-window';
            iconEl.appendChild(fallback);
        }
        const labelEl = doc.createElement('span');
        labelEl.className = 'side-pane-menu-item-label';
        labelEl.textContent = app.label || app.id;
        btn.append(iconEl, labelEl);
        return btn;
    }

    // 应用列表每次打开菜单时现取
    function renderApps() {
        apps = new Map();
        const rows = readApps().filter(app => app?.id && !apps.has(app.id)).map(app => {
            apps.set(app.id, app);
            return createAppRow(app);
        });
        appsGroup?.replaceChildren(...rows);
        const hasApps = rows.length > 0;
        if (appsGroup) appsGroup.hidden = !hasApps;
        if (appsHeading) appsHeading.hidden = !hasApps;
        if (separator) separator.hidden = !hasApps || entriesOwner.availableEntries().length === 0;
    }

    function show() {
        if (!menu || !addButton) return;
        onShow();
        renderApps();
        menu.hidden = false;
        addButton.setAttribute('aria-expanded', 'true');
        // 贴着「+」的下沿，右边和按钮对齐；碰到窗口边缘时往回收
        const rect = addButton.getBoundingClientRect();
        placeMenuAt(menu, rect.right - (menu.offsetWidth || 224), rect.bottom + 4, win, 8);
        menu.querySelector('[role="menuitem"]')?.focus?.();
    }

    async function runApp(appId) {
        const app = apps.get(appId);
        hide();
        if (!app || disposed) return;
        try {
            await app.open();
        } catch (error) {
            console.error(`[SidePaneAddMenu] Failed to open app "${appId}":`, error);
        }
    }

    if (addButton) {
        const onAddClick = (e) => {
            e.stopPropagation();
            const entries = entriesOwner.availableEntries();
            const direct = directEntry(entries);
            if (direct) {
                entriesOwner.runEntry(direct.id);
                return;
            }
            if (isOpen()) hide();
            else if (entries.length > 0 || appsProvider) show();
        };
        addButton.addEventListener('click', onAddClick);
        cleanups.push(() => addButton.removeEventListener('click', onAddClick));
    }

    if (menu) {
        const onMenuClick = (e) => {
            const entryBtn = e.target.closest('[data-open-tab-entry]');
            if (entryBtn) {
                entriesOwner.runEntry(entryBtn.getAttribute('data-open-tab-entry'));
                return;
            }
            const appBtn = e.target.closest('[data-add-menu-app]');
            if (appBtn) runApp(appBtn.getAttribute('data-add-menu-app'));
        };
        menu.addEventListener('click', onMenuClick);
        cleanups.push(() => menu.removeEventListener('click', onMenuClick));

        // 菜单内上下键移动焦点
        const onMenuKeydown = (e) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
            const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
            if (!items.length) return;
            e.preventDefault();
            const current = items.indexOf(doc.activeElement);
            let next = 0;
            if (e.key === 'End') next = items.length - 1;
            else if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
            else if (e.key === 'ArrowUp') next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
            items[next].focus();
        };
        menu.addEventListener('keydown', onMenuKeydown);
        cleanups.push(() => menu.removeEventListener('keydown', onMenuKeydown));

        // 点外面或按 Esc 收起，Esc 时焦点回到「+」
        const onDocPointerDown = (e) => {
            if (isOpen() && !menu.contains(e.target) && !addButton?.contains(e.target)) hide();
        };
        const onDocKeydown = (e) => {
            if (e.key !== 'Escape' || !isOpen()) return;
            e.preventDefault();
            hide();
            addButton?.focus?.();
        };
        doc.addEventListener('pointerdown', onDocPointerDown, true);
        doc.addEventListener('keydown', onDocKeydown);
        cleanups.push(() => {
            doc.removeEventListener('pointerdown', onDocPointerDown, true);
            doc.removeEventListener('keydown', onDocKeydown);
        });
    }

    return Object.freeze({
        isOpen,
        hide,
        show,
        availableEntries: entriesOwner.availableEntries,
        directEntry: () => directEntry(),
        registerEntry: entriesOwner.registerEntry,
        renderEntries: entriesOwner.renderEntries,
        runEntry: entriesOwner.runEntry,

        setAppsProvider(provider) {
            appsProvider = typeof provider === 'function' ? provider : null;
            if (isOpen()) renderApps();
            syncButton();
            onEntriesChanged();
        },

        dispose() {
            disposed = true;
            hide();
            entriesOwner.dispose();
            cleanups.forEach(cleanup => cleanup());
            cleanups.length = 0;
        }
    });
}
