/* Resizer ownership adapter for Workspace Side Pane, wrapping VCPSidebarResizer. */
'use strict';

export function createSidePaneResizerOwner({
    handle,
    paneElement,
    resizerFactory = (typeof window !== 'undefined' ? window.VCPSidebarResizer?.create : null),
    minWidth = 240,
    maxRatio = 0.65,
    minMainContentWidth = 420,
    onWidthChange = null,
    onWidthCommit = null,
    scope = null,
    documentRef = (typeof document !== 'undefined' ? document : null),
    windowRef = (typeof window !== 'undefined' ? window : null)
}) {
    if (!handle || !paneElement) {
        throw new TypeError('SidePaneResizerOwner requires a handle and paneElement');
    }
    if (typeof resizerFactory !== 'function') {
        throw new Error('VCPSidebarResizer factory is not available');
    }

    const doc = documentRef || handle.ownerDocument || globalThis.document;
    const win = windowRef || doc?.defaultView || globalThis.window;

    handle?.setAttribute?.('role', 'separator');
    handle?.setAttribute?.('tabindex', '0');
    handle?.setAttribute?.('aria-orientation', 'vertical');
    handle?.setAttribute?.('aria-label', '调节工作区侧栏宽度');
    handle?.setAttribute?.('aria-valuemin', String(minWidth));

    function getBounds() {
        const workspace = doc?.querySelector?.('.container, #nextUiMainPanel, .app-container, .main-layout, body');
        const workspaceWidth = workspace?.getBoundingClientRect?.()?.width || win?.innerWidth || 1200;
        const leftSidebar = doc?.querySelector?.('.sidebar, #sidebarLeft');
        const leftWidth = (leftSidebar && !leftSidebar.classList.contains('hidden') && leftSidebar.classList.contains('active'))
            ? (leftSidebar.getBoundingClientRect?.()?.width || 0)
            : 0;
        const maxFromRatio = Math.round(workspaceWidth * maxRatio);
        const maxFromRemainder = Math.max(minWidth, workspaceWidth - leftWidth - minMainContentWidth);
        const max = Math.max(minWidth, Math.min(maxFromRatio, maxFromRemainder));
        handle?.setAttribute?.('aria-valuemax', String(Math.round(max)));
        return {
            min: minWidth,
            max
        };
    }

    const eventNames = (typeof win?.PointerEvent === 'function')
        ? { down: 'pointerdown', move: 'pointermove', up: 'pointerup', cancel: 'pointercancel' }
        : { down: 'mousedown', move: 'mousemove', up: 'mouseup', cancel: 'mouseleave' };

    let isDisposed = false;

    const initialBounds = getBounds();
    const currentWidth = paneElement?.getBoundingClientRect ? paneElement.getBoundingClientRect().width : minWidth;
    handle?.setAttribute?.('aria-valuenow', String(Math.round(currentWidth)));

    const resizer = resizerFactory({
        handle,
        document: doc,
        eventNames,
        direction: -1, // Right sidebar: dragging left increases width
        step: 20,
        getValue: () => (paneElement?.getBoundingClientRect ? paneElement.getBoundingClientRect().width : minWidth),
        getBounds,
        applyValue: (width) => {
            if (isDisposed) return;
            const finalWidth = Math.round(width);
            if (paneElement?.style) {
                paneElement.style.width = `${finalWidth}px`;
            }
            handle?.setAttribute?.('aria-valuenow', String(finalWidth));
            onWidthChange?.(finalWidth);
        },
        onActiveChange: (active) => {
            if (isDisposed || !doc?.body) return;
            doc.body.style.cursor = active ? 'col-resize' : '';
            doc.body.style.userSelect = active ? 'none' : '';
            doc.body.classList.toggle('vcp-sidebar-resizing', active);
            if (paneElement?.style) {
                paneElement.style.transition = active ? 'none' : '';
            }
            handle?.classList?.toggle?.('active', active);
        },
        onCommit: (width) => {
            if (isDisposed) return;
            const finalWidth = Math.round(width);
            handle?.setAttribute?.('aria-valuenow', String(finalWidth));
            onWidthCommit?.(finalWidth);
        }
    });

    // 方向键由 VCPSidebarResizer 处理（每次 20px），这里只补 Home/End，避免一次按键走两遍
    const onKeydown = (e) => {
        if (isDisposed) return;
        const current = paneElement?.getBoundingClientRect ? paneElement.getBoundingClientRect().width : minWidth;
        const bounds = getBounds();
        let target = current;
        if (e.key === 'Home') {
            e.preventDefault();
            target = bounds.min;
        } else if (e.key === 'End') {
            e.preventDefault();
            target = bounds.max;
        }
        if (target !== current) {
            const finalWidth = Math.round(target);
            if (paneElement?.style) {
                paneElement.style.width = `${finalWidth}px`;
            }
            handle?.setAttribute?.('aria-valuenow', String(finalWidth));
            onWidthChange?.(finalWidth);
            onWidthCommit?.(finalWidth);
        }
    };

    handle?.addEventListener?.('keydown', onKeydown);

    const owner = Object.freeze({
        refresh() {
            if (!isDisposed) resizer?.refresh?.();
        },
        dispose() {
            if (isDisposed) return;
            isDisposed = true;
            handle?.removeEventListener?.('keydown', onKeydown);
            resizer?.dispose?.();
        }
    });

    if (scope && typeof scope.own === 'function') {
        scope.own(owner, 'side-pane-resizer-owner');
    }

    return owner;
}

const api = Object.freeze({ createSidePaneResizerOwner });

if (typeof globalThis !== 'undefined') {
    globalThis.VCPSidePaneResizerOwner = api;
}

export default api;
