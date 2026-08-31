import type { UiDisposer, UiScope } from '../contracts.js';

const STYLE_ID = 'vcp-harness-uiux-menu';
const VIEWPORT_MARGIN = 12;
const POINTER_GRACE_MS = 120;

function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-menu-root{position:relative;display:inline-flex}.vcp-harness-menu-list,.vcp-harness-submenu{box-sizing:border-box;display:flex;flex-direction:column;gap:0;padding:4px;border:1px solid var(--dsw-alias-border-inverted,transparent);border-radius:12px;background:var(--dsw-specific-menu,#fff);box-shadow:var(--dsw-shadow-lv3,0 0 1px rgba(0,0,0,.2),0 0 4px rgba(0,0,0,.02),0 12px 32px rgba(0,0,0,.08));font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif}.vcp-harness-menu-list{position:absolute;top:calc(100% + 4px);left:0;z-index:100;min-width:218px;max-width:360px}.vcp-harness-menu-list.vcp-harness-menu-portal{position:fixed;top:auto;left:auto;z-index:1100}.vcp-harness-menu-list.vcp-harness-menu-side-top{top:auto;bottom:calc(100% + 4px)}.vcp-harness-menu-list.vcp-harness-menu-align-end{right:0;left:auto}.vcp-harness-menu-list.vcp-harness-menu-scrollable{max-height:calc(100vh - 24px)}.vcp-harness-menu-viewport{display:flex;flex-direction:column;min-height:0}.vcp-harness-menu-scrollable>.vcp-harness-menu-viewport{overflow-y:auto}.vcp-harness-menu-footer{display:flex;flex:none;flex-direction:column;margin-top:4px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.vcp-harness-menu-item-wrap{position:relative}.vcp-harness-menu-item{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:0;border-radius:10px;background:transparent;cursor:pointer;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#0f1115);text-align:left}.vcp-harness-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-harness-menu-item:focus-visible{outline:none}.vcp-harness-menu-item:disabled{opacity:.4;cursor:not-allowed}.vcp-harness-menu-item-icon,.vcp-harness-menu-item-check{display:inline-flex;flex:none;width:16px;height:16px;align-items:center;justify-content:center}.vcp-harness-menu-item-icon{color:var(--dsw-alias-label-tertiary,#737780)}.vcp-harness-menu-item-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vcp-harness-menu-item-check{color:var(--dsw-alias-label-primary,#0f1115)}.vcp-harness-menu-item-danger{color:var(--dsw-alias-state-error-primary,#d92d20)}.vcp-harness-menu-item-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(217,45,32,.08))}.vcp-harness-menu-label{padding:8px 10px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#737780)}.vcp-harness-menu-separator{height:1px;margin:4px 2px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.06))}.vcp-harness-submenu{position:absolute;right:auto;bottom:-4px;left:calc(100% + 10px);z-index:101;min-width:163px}.vcp-harness-submenu::before{position:absolute;top:0;bottom:0;left:-10px;width:10px;content:''}.vcp-harness-menu-dense .vcp-harness-menu-item{min-height:34px;padding-block:5px}.vcp-harness-menu-dense .vcp-harness-menu-label{padding-block:4px}.vcp-harness-menu-compact,.vcp-harness-menu-compact .vcp-harness-submenu{min-width:164px;padding:2px;border-radius:7px}.vcp-harness-menu-compact .vcp-harness-menu-item{min-height:26px;gap:6px;padding:3px 7px;border-radius:5px;font-size:12px;line-height:18px}.vcp-harness-menu-compact .vcp-harness-menu-item-icon{width:14px;height:14px}.vcp-harness-menu-compact .vcp-harness-menu-separator{margin:2px}.vcp-harness-menu-compact .vcp-harness-menu-label{padding:4px 7px;font-size:11px;line-height:16px}`;
    (document.head || document.documentElement).append(style);
}

export interface MenuItem {
    readonly id: string;
    readonly label: string | Node;
    readonly disabled?: boolean;
    readonly icon?: Node;
    readonly danger?: boolean;
    readonly submenu?: readonly MenuItem[];
}

export interface MenuSeparator { readonly type: 'separator'; readonly id: string; }
export interface MenuLabel { readonly type: 'label'; readonly id: string; readonly text: string; }
export type MenuEntry = MenuItem | MenuSeparator | MenuLabel;

export interface MenuProps {
    readonly items: readonly MenuEntry[];
    readonly footer?: readonly MenuEntry[];
    readonly selectedId?: string;
    readonly selectedIds?: readonly string[];
    readonly onSelect: (id: string) => void;
    readonly onClose?: () => void;
    readonly align?: 'start' | 'end';
    readonly side?: 'bottom' | 'top' | 'right';
    readonly portal?: boolean;
    readonly closeOnPointerLeave?: boolean;
    readonly dense?: boolean;
    readonly compact?: boolean;
    readonly open?: boolean;
}

export interface MenuController {
    readonly root: HTMLSpanElement;
    readonly list: HTMLDivElement;
    readonly open: boolean;
    setOpen(open: boolean): void;
    setSelected(selectedId?: string, selectedIds?: readonly string[]): void;
    dispose(): void | Promise<void>;
}

function isSeparator(entry: MenuEntry): entry is MenuSeparator {
    return 'type' in entry && entry.type === 'separator';
}

function isLabel(entry: MenuEntry): entry is MenuLabel {
    return 'type' in entry && entry.type === 'label';
}

function createCheck() {
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    marker.classList.add('vcp-harness-menu-item-check');
    marker.setAttribute('width', '16');
    marker.setAttribute('height', '16');
    marker.setAttribute('viewBox', '0 0 16 16');
    marker.setAttribute('fill', 'none');
    marker.setAttribute('focusable', 'false');
    marker.setAttribute('aria-hidden', 'true');
    marker.innerHTML = '<path d="M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z" fill="currentColor"/>';
    return marker;
}

/** Owner-controlled Harness Menu rendered in Light DOM. */
export function mountMenu(anchor: HTMLElement, props: MenuProps, scope: UiScope): MenuController {
    if (!anchor?.parentNode || !props?.items || !scope) throw new TypeError('Menu requires a connected anchor, items and scope.');
    ensureStyles();
    const menuScope = scope.child('harness-menu');
    const parent = anchor.parentNode;
    const originalHasPopup = anchor.getAttribute('aria-haspopup');
    const originalExpanded = anchor.getAttribute('aria-expanded');
    const root = document.createElement('span');
    root.className = 'vcp-harness-menu-root';
    const list = document.createElement('div');
    list.className = 'vcp-harness-menu-list';
    list.setAttribute('role', 'menu');
    const viewport = document.createElement('div');
    viewport.className = 'vcp-harness-menu-viewport';
    viewport.setAttribute('role', 'presentation');
    list.append(viewport);
    if (props.portal) list.classList.add('vcp-harness-menu-portal');
    if (props.align === 'end') list.classList.add('vcp-harness-menu-align-end');
    if (props.side === 'top') list.classList.add('vcp-harness-menu-side-top');
    if (props.dense) list.classList.add('vcp-harness-menu-dense');
    if (props.compact) list.classList.add('vcp-harness-menu-compact');
    if (!props.items.some(entry => !isSeparator(entry) && !isLabel(entry) && Boolean(entry.submenu?.length))) list.classList.add('vcp-harness-menu-scrollable');
    parent.insertBefore(root, anchor);
    root.append(anchor);
    anchor.setAttribute('aria-haspopup', 'menu');
    anchor.setAttribute('aria-expanded', 'false');

    let selectedId = props.selectedId;
    let selectedIds = new Set(props.selectedIds ?? []);
    let active = false;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    const selectedNodes = new Map<string, HTMLButtonElement>();
    const openSubmenus = new Map<string, HTMLDivElement>();
    const openReleases: UiDisposer[] = [];

    const isSelected = (id: string) => id === selectedId || selectedIds.has(id);
    const syncSelected = () => {
        selectedNodes.forEach((button, id) => {
            const selected = isSelected(id);
            button.classList.toggle('vcp-harness-menu-item-selected', selected);
            button.dataset.selected = String(selected);
            const check = button.querySelector('.vcp-harness-menu-item-check');
            if (selected && !check) button.append(createCheck());
            if (!selected) check?.remove();
        });
    };
    const closeSubmenus = (except?: string) => {
        openSubmenus.forEach((submenu, id) => {
            if (id !== except) {
                submenu.remove();
                openSubmenus.delete(id);
                selectedNodes.get(id)?.setAttribute('aria-expanded', 'false');
            }
        });
    };
    const renderItem = (entry: MenuItem, target: HTMLElement, nested = false) => {
        const wrap = document.createElement('div');
        wrap.className = 'vcp-harness-menu-item-wrap';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'vcp-harness-menu-item';
        button.setAttribute('role', 'menuitem');
        button.disabled = Boolean(entry.disabled);
        if (entry.danger) button.classList.add('vcp-harness-menu-item-danger');
        if (entry.icon) {
            const icon = document.createElement('span');
            icon.className = 'vcp-harness-menu-item-icon';
            icon.append(entry.icon.cloneNode ? entry.icon.cloneNode(true) : entry.icon);
            button.append(icon);
        }
        const label = document.createElement('span');
        label.className = 'vcp-harness-menu-item-label';
        if (typeof entry.label === 'string') label.textContent = entry.label;
        else label.append(entry.label.cloneNode ? entry.label.cloneNode(true) : entry.label);
        button.append(label);
        if (!nested) selectedNodes.set(entry.id, button);
        const hasSubmenu = Boolean(entry.submenu?.length);
        if (hasSubmenu) {
            button.setAttribute('aria-haspopup', 'menu');
            button.setAttribute('aria-expanded', 'false');
        }
        const openSubmenu = () => {
            if (!hasSubmenu || !entry.submenu) { closeSubmenus(); return; }
            if (openSubmenus.has(entry.id)) return;
            closeSubmenus(entry.id);
            const submenu = document.createElement('div');
            submenu.className = 'vcp-harness-submenu';
            if (props.compact) submenu.classList.add('vcp-harness-menu-compact');
            submenu.setAttribute('role', 'menu');
            entry.submenu.forEach(item => renderItem(item, submenu, true));
            wrap.append(submenu);
            openSubmenus.set(entry.id, submenu);
            button.setAttribute('aria-expanded', 'true');
        };
        menuScope.listen(button, 'focus', openSubmenu);
        menuScope.listen(wrap, 'mouseenter', openSubmenu);
        menuScope.listen(wrap, 'mouseleave', () => {
            const submenu = openSubmenus.get(entry.id);
            submenu?.remove();
            openSubmenus.delete(entry.id);
            button.setAttribute('aria-expanded', 'false');
        });
        menuScope.listen(button, 'click', event => {
            event.stopPropagation();
            if (entry.disabled) return;
            if (hasSubmenu) { openSubmenu(); return; }
            props.onSelect(entry.id);
        });
        wrap.append(button);
        target.append(wrap);
    };
    const renderEntries = (entries: readonly MenuEntry[], target: HTMLElement) => {
        entries.forEach(entry => {
            if (isSeparator(entry)) {
                const separator = document.createElement('div');
                separator.className = 'vcp-harness-menu-separator';
                separator.setAttribute('role', 'separator');
                target.append(separator);
            } else if (isLabel(entry)) {
                const label = document.createElement('div');
                label.className = 'vcp-harness-menu-label';
                label.setAttribute('role', 'presentation');
                label.textContent = entry.text;
                target.append(label);
            } else renderItem(entry, target);
        });
    };
    renderEntries(props.items, viewport);
    if (props.footer?.length) {
        const footer = document.createElement('div');
        footer.className = 'vcp-harness-menu-footer';
        footer.setAttribute('role', 'presentation');
        renderEntries(props.footer, footer);
        list.append(footer);
    }
    syncSelected();

    const cancelGrace = () => { if (closeTimer) clearTimeout(closeTimer); closeTimer = null; };
    const releaseOpenEffects = () => {
        cancelGrace();
        openReleases.splice(0).reverse().forEach(release => release());
    };
    const place = () => {
        if (!active || !props.portal) return;
        const rect = anchor.getBoundingClientRect();
        const width = list.offsetWidth;
        const height = list.offsetHeight;
        let left = props.side === 'right' ? rect.right + 4 : props.align === 'end' ? rect.right - width : rect.left;
        let top = props.side === 'right' ? rect.top : props.side === 'top' ? rect.top - height - 4 : rect.bottom + 4;
        if (width > 0) left = Math.min(Math.max(left, VIEWPORT_MARGIN), window.innerWidth - width - VIEWPORT_MARGIN);
        if (height > 0) top = Math.min(Math.max(top, VIEWPORT_MARGIN), window.innerHeight - height - VIEWPORT_MARGIN);
        list.style.left = `${left}px`;
        list.style.top = `${top}px`;
    };
    const close = (notify = false) => {
        if (!active) return;
        active = false;
        releaseOpenEffects();
        closeSubmenus();
        list.remove();
        anchor.setAttribute('aria-expanded', 'false');
        if (notify) props.onClose?.();
    };
    const open = () => {
        if (active) return;
        active = true;
        (props.portal ? document.body : root).append(list);
        anchor.setAttribute('aria-expanded', 'true');
        if (props.portal) place();
        const onPointerDown = (event: Event) => {
            const target = event.target as Node | null;
            if (target?.nodeType && !root.contains(target) && !list.contains(target)) close(true);
        };
        const onKeyDown = (event: Event) => {
            if ((event as KeyboardEvent).key === 'Escape') close(true);
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        openReleases.push(() => document.removeEventListener('pointerdown', onPointerDown));
        openReleases.push(() => document.removeEventListener('keydown', onKeyDown));
        if (props.portal) {
            window.addEventListener('scroll', place, true);
            window.addEventListener('resize', place);
            openReleases.push(() => window.removeEventListener('scroll', place, true));
            openReleases.push(() => window.removeEventListener('resize', place));
        }
    };
    if (props.closeOnPointerLeave) {
        const armGrace = () => {
            cancelGrace();
            closeTimer = setTimeout(() => close(true), POINTER_GRACE_MS);
        };
        menuScope.listen(root, 'pointerenter', cancelGrace);
        menuScope.listen(root, 'pointerleave', armGrace);
        menuScope.listen(list, 'pointerenter', cancelGrace);
        menuScope.listen(list, 'pointerleave', armGrace);
    }
    menuScope.listen(list, 'click', event => event.stopPropagation());

    const dispose = scope.own(async () => {
        close(false);
        releaseOpenEffects();
        await menuScope.dispose('harness-menu-unmounted');
        if (originalHasPopup === null) anchor.removeAttribute('aria-haspopup'); else anchor.setAttribute('aria-haspopup', originalHasPopup);
        if (originalExpanded === null) anchor.removeAttribute('aria-expanded'); else anchor.setAttribute('aria-expanded', originalExpanded);
        if (root.parentNode) root.replaceWith(anchor);
        else if (anchor.parentNode === root) root.removeChild(anchor);
        selectedNodes.clear();
        openSubmenus.clear();
    }, 'harness-menu', 'ui-primitive');
    const controller: MenuController = {
        root,
        list,
        get open() { return active; },
        setOpen(value) { if (value) open(); else close(false); },
        setSelected(nextSelectedId, nextSelectedIds = []) {
            selectedId = nextSelectedId;
            selectedIds = new Set(nextSelectedIds);
            syncSelected();
        },
        dispose,
    };
    if (props.open) open();
    return controller;
}
