const STYLE_ID = 'vcp-harness-uiux-primitives';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-select{position:relative;display:inline-flex;min-width:218px}.vcp-harness-select>.vcp-harness-select-native{position:absolute!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important}.vcp-harness-select>.vcp-harness-select-trigger{display:inline-flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,var(--vcp-color-border,#c8ccd4));border-radius:10px;background:var(--dsw-alias-bg-layer-1,var(--vcp-color-surface,#fff));color:var(--dsw-alias-label-primary,#0f1115);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;cursor:pointer}.vcp-harness-select>.vcp-harness-select-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,var(--vcp-color-focus,#4c8dff));outline-offset:2px}.vcp-harness-select>.vcp-harness-menu-list,.vcp-uiux-primitive-menu{box-sizing:border-box;z-index:1100;min-width:218px;padding:4px;background:var(--dsw-specific-menu,#fff);border:1px solid var(--dsw-alias-border-inverted,rgba(0,0,0,0));border-radius:12px;box-shadow:rgba(0,0,0,.2) 0 0 1px,rgba(0,0,0,.02) 0 0 4px,rgba(0,0,0,.08) 0 12px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif}.vcp-harness-menu-viewport{display:flex;flex-direction:column;min-height:0}.vcp-harness-menu-item-wrap{position:relative}.vcp-uiux-primitive-menu .vcp-harness-menu-item{display:flex;align-items:center;width:100%;min-height:40px;padding:8px 10px;gap:8px;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}.vcp-uiux-primitive-menu .vcp-harness-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-uiux-primitive-menu .vcp-harness-menu-item:focus-visible{outline:none}.vcp-uiux-primitive-menu .vcp-harness-menu-item:disabled{opacity:.4;cursor:not-allowed}.vcp-harness-menu-item-label{display:flex;flex:1;min-width:0;max-width:280px;flex-direction:column;gap:2px}.vcp-harness-menu-item-name{color:var(--dsw-alias-label-primary,#0f1115);font-size:13px;line-height:20px}.vcp-harness-menu-item-description{color:var(--dsw-alias-label-caption,#adb2b8);font-size:12px;line-height:16px}.vcp-harness-menu-item-check{display:inline-flex;flex:none;width:16px;height:16px;align-items:center;justify-content:center;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-harness-field-description{margin-top:4px;color:var(--dsw-alias-label-secondary,var(--vcp-color-muted,#68707d));font-size:12px;line-height:18px}.vcp-harness-field-error{margin-top:4px;color:var(--dsw-alias-label-danger,var(--vcp-color-danger,#c62828));font-size:12px;line-height:18px}`;
    style.textContent += `.vcp-harness-menu-item-content{display:flex;flex-direction:column;gap:2px}.vcp-harness-menu-group-label{padding:6px 10px 4px;color:var(--dsw-alias-label-caption,#8b919b);font-size:11px;line-height:16px;font-weight:600}`;
    (document.head || document.documentElement).append(style);
}
/**
 * Harness-compatible Select shell over an existing native select. The native
 * element remains the business/serialization source; the Light-DOM trigger
 * and menu are disposable presentation nodes.
 */
export function mountSelect(select, props = {}, scope) {
    if (!select || !scope)
        throw new TypeError('Select requires select and scope.');
    ensureStyles();
    const originalTabIndex = select.getAttribute('tabindex');
    const originalAriaHidden = select.getAttribute('aria-hidden');
    const previousActive = document.activeElement;
    const wrap = document.createElement('span');
    wrap.className = 'vcp-harness-select';
    wrap.style.width = '100%';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'vcp-harness-select-trigger';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    if (props.label)
        trigger.setAttribute('aria-label', props.label);
    const menu = document.createElement('div');
    menu.className = 'vcp-harness-menu-list vcp-uiux-primitive-menu vcp-harness-menu-scrollable';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    const viewport = document.createElement('div');
    viewport.className = 'vcp-harness-menu-viewport';
    viewport.setAttribute('role', 'presentation');
    menu.append(viewport);
    select.classList.add('vcp-harness-select-native');
    trigger.setAttribute('aria-controls', `${select.id || 'vcp-select'}-menu`);
    menu.id = `${select.id || 'vcp-select'}-menu`;
    const sync = () => {
        const selected = select.options[select.selectedIndex];
        trigger.textContent = selected?.textContent?.trim() || props.label || '选择';
        Array.from(menu.querySelectorAll('[role="menuitem"]')).forEach((item, index) => {
            const active = index === select.selectedIndex;
            item.dataset.selected = String(active);
            item.classList.toggle('vcp-harness-menu-item-selected', active);
            item.tabIndex = active ? 0 : -1;
            const check = item.querySelector('.vcp-harness-menu-item-check');
            if (active && !check) {
                const marker = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                marker.classList.add('vcp-harness-menu-item-check');
                marker.setAttribute('width', '16');
                marker.setAttribute('height', '16');
                marker.setAttribute('viewBox', '0 0 16 16');
                marker.setAttribute('fill', 'none');
                marker.setAttribute('focusable', 'false');
                marker.innerHTML = '<path d="M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z" fill="currentColor"/>';
                item.append(marker);
            }
            else if (!active && check)
                check.remove();
        });
    };
    const close = (restoreFocus = false) => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); menu.remove(); if (restoreFocus && document.contains(trigger))
        trigger.focus(); };
    const placePortal = () => {
        if (!props.portal || menu.hidden || trigger.getAttribute('aria-expanded') !== 'true')
            return;
        const anchor = trigger.getBoundingClientRect();
        const margin = 12;
        const width = menu.offsetWidth || anchor.width;
        const height = menu.offsetHeight;
        const maxLeft = Math.max(margin, window.innerWidth - width - margin);
        const maxTop = Math.max(margin, window.innerHeight - height - margin);
        menu.style.left = `${Math.min(Math.max(anchor.left, margin), maxLeft)}px`;
        menu.style.top = `${Math.min(Math.max(anchor.bottom + 4, margin), maxTop)}px`;
        menu.style.width = `${anchor.width}px`;
    };
    const open = () => {
        if (select.disabled)
            return;
        if (props.portal) {
            document.body.append(menu);
            menu.style.position = 'fixed';
        }
        else if (!menu.parentNode) {
            wrap.append(menu);
        }
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        placePortal();
    };
    const onTrigger = () => trigger.getAttribute('aria-expanded') === 'true' ? close() : open();
    const onChange = () => sync();
    const onSync = () => sync();
    let currentGroupLabel = null;
    Array.from(select.options).forEach((option, index) => {
        const group = option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement : null;
        const groupLabel = group?.label?.trim() || '';
        if (groupLabel && groupLabel !== currentGroupLabel) {
            const heading = document.createElement('div');
            heading.className = 'vcp-harness-menu-group-label';
            heading.setAttribute('role', 'presentation');
            heading.textContent = groupLabel;
            viewport.append(heading);
            currentGroupLabel = groupLabel;
        }
        else if (!groupLabel) {
            currentGroupLabel = null;
        }
        const itemWrap = document.createElement('div');
        itemWrap.className = 'vcp-harness-menu-item-wrap';
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'vcp-harness-menu-item';
        item.setAttribute('role', 'menuitem');
        item.disabled = option.disabled;
        const label = document.createElement('span');
        label.className = 'vcp-harness-menu-item-label';
        const description = option.dataset.description?.trim();
        if (description) {
            const content = document.createElement('span');
            content.className = 'vcp-harness-menu-item-content';
            const name = document.createElement('span');
            name.className = 'vcp-harness-menu-item-name';
            name.textContent = option.textContent?.trim() || '';
            const detail = document.createElement('span');
            detail.className = 'vcp-harness-menu-item-description';
            detail.textContent = description;
            content.append(name, detail);
            label.append(content);
        }
        else
            label.textContent = option.textContent?.trim() || '';
        item.append(label);
        itemWrap.append(item);
        scope.listen(item, 'click', () => { if (!option.disabled) {
            select.selectedIndex = index;
            const EventCtor = select.ownerDocument.defaultView?.Event ?? Event;
            select.dispatchEvent(new EventCtor('change', { bubbles: true }));
            close(true);
        } });
        viewport.append(itemWrap);
    });
    select.parentNode?.insertBefore(wrap, select);
    wrap.append(select, trigger, menu);
    select.tabIndex = -1;
    scope.listen(trigger, 'click', onTrigger);
    scope.listen(select, 'change', onChange);
    scope.listen(select, 'vcp-uiux-sync', onSync);
    scope.listen(window, 'scroll', placePortal, { capture: true });
    scope.listen(window, 'resize', placePortal);
    scope.listen(document, 'pointerdown', event => { if (!wrap.contains(event.target) && !menu.contains(event.target))
        close(); }, { capture: true });
    scope.listen(document, 'keydown', event => {
        const key = event.key;
        if (menu.hidden)
            return;
        if (key === 'Escape') {
            event.preventDefault();
            close(true);
            return;
        }
    });
    sync();
    menu.remove();
    return scope.own(() => {
        // Only restore focus when this primitive still owns it. `previousActive`
        // is snapshotted at mount time, so an unconditional refocus yanks the
        // caret out of whatever the user is typing into every time an option
        // list repopulates and the select is remounted.
        const activeNow = document.activeElement;
        const ownsFocus = activeNow === select || wrap.contains(activeNow) || (menu.isConnected && menu.contains(activeNow));
        close(false);
        if (originalTabIndex === null)
            select.removeAttribute('tabindex');
        else
            select.setAttribute('tabindex', originalTabIndex);
        if (originalAriaHidden === null)
            select.removeAttribute('aria-hidden');
        else
            select.setAttribute('aria-hidden', originalAriaHidden);
        select.classList.remove('vcp-harness-select-native');
        wrap.replaceWith(select);
        if (ownsFocus && previousActive && typeof previousActive.focus === 'function' && document.contains(previousActive))
            previousActive.focus();
    }, 'harness-select', 'ui-primitive');
}
