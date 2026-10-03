// Shared keyboard behavior for settings and independent plugin configuration pickers.
export function mountSelectKeyboardGlue(select, cleanups, scope) {
    const trigger = select.parentElement?.querySelector(':scope > .vcp-uiux-select-trigger');
    if (!trigger) return;
    const openMenuItems = () => {
        const menuId = trigger.getAttribute('aria-controls');
        const menu = menuId ? document.getElementById(menuId) : null;
        if (!menu || menu.hidden) return null;
        return [...menu.querySelectorAll('.vcp-uiux-menu-item:not(:disabled)')];
    };
    const focusSelectedItem = () => {
        const items = openMenuItems();
        if (!items?.length) return;
        const selected = items.find(item => item.dataset.selected === 'true') || items[0];
        selected.focus();
    };
    const moveFocus = (items, current, next) => {
        const count = items.length;
        if (!count) return;
        items[((next % count) + count) % count].focus();
    };
    let focusFrame = null;
    let focusFrameRelease = null;
    const requestFrame = globalThis.requestAnimationFrame || (callback => setTimeout(callback, 16));
    const cancelFrame = globalThis.cancelAnimationFrame || clearTimeout;
    const cancelFocusFrame = () => {
        if (focusFrame !== null) cancelFrame(focusFrame);
        focusFrame = null;
        const release = focusFrameRelease;
        focusFrameRelease = null;
        if (release) void release();
    };
    const scheduleFocusFrame = () => {
        cancelFocusFrame();
        let release;
        focusFrame = requestFrame(() => {
            focusFrame = null;
            focusFrameRelease = null;
            void release?.();
            if (scope.active) focusSelectedItem();
        });
        release = scope.own(() => {
            if (focusFrame !== null) cancelFrame(focusFrame);
            focusFrame = null;
        }, 'select-focus-frame', 'animation-frame');
        focusFrameRelease = release;
    };
    const onTriggerKey = event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        if (trigger.getAttribute('aria-expanded') !== 'true') {
            trigger.click();
            scheduleFocusFrame();
            return;
        }
        const items = openMenuItems();
        if (!items?.length) return;
        const current = Math.max(0, items.findIndex(item => item.dataset.selected === 'true'));
        moveFocus(items, current, event.key === 'ArrowDown' ? current + 1 : current - 1);
    };
    const onDocumentKey = event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const target = event.target;
        if (!(target instanceof Element) || !target.classList.contains('vcp-uiux-menu-item')) return;
        const items = openMenuItems();
        if (!items?.length) return;
        const current = items.indexOf(target);
        let next = current;
        if (event.key === 'ArrowDown') next = current + 1;
        else if (event.key === 'ArrowUp') next = current - 1;
        else if (event.key === 'Home') next = 0;
        else next = items.length - 1;
        event.preventDefault();
        moveFocus(items, current, next);
    };
    // Programmatic business writes elsewhere publish global-settings-updated;
    // the primitive only re-syncs on change/vcp-uiux-sync, so mirror the event.
    const onGlobalUpdate = () => select.dispatchEvent(new Event('vcp-uiux-sync'));
    trigger.addEventListener('keydown', onTriggerKey);
    document.addEventListener('keydown', onDocumentKey, true);
    window.addEventListener('global-settings-updated', onGlobalUpdate);
    cleanups.push(() => {
        cancelFocusFrame();
        trigger.removeEventListener('keydown', onTriggerKey);
        document.removeEventListener('keydown', onDocumentKey, true);
        window.removeEventListener('global-settings-updated', onGlobalUpdate);
    });
}
