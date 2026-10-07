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
    windowRef = (typeof window !== 'undefined' ? window : null),
    // 键盘调宽时按住方向键每秒几十次，宽度当场生效，写设置等停手后再写一次（同 ZCode resizable.tsx 走防抖的 onLayoutChange）
    keyboardCommitDelayMs = 400
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
    let dragStyles = null;
    let keyboardCommit = null; // { timer, width }

    function flushKeyboardCommit() {
        if (!keyboardCommit) return;
        const { timer, width } = keyboardCommit;
        keyboardCommit = null;
        win?.clearTimeout?.(timer);
        onWidthCommit?.(width);
    }

    function commitWidth(width, fromKeyboard) {
        if (!fromKeyboard) {
            if (keyboardCommit) { win?.clearTimeout?.(keyboardCommit.timer); keyboardCommit = null; }
            onWidthCommit?.(width);
            return;
        }
        onWidthChange?.(width);
        if (keyboardCommit) win?.clearTimeout?.(keyboardCommit.timer);
        keyboardCommit = { width, timer: win?.setTimeout?.(flushKeyboardCommit, keyboardCommitDelayMs) };
        if (!keyboardCommit.timer) flushKeyboardCommit();
    }

    function restoreDragStyles() {
        if (!dragStyles) return;
        const previous = dragStyles;
        dragStyles = null;
        for (const [style, property, value, priority] of previous.declarations) {
            if (value) style.setProperty(property, value, priority);
            else style.removeProperty(property);
        }
        previous.body.classList.toggle('vcp-sidebar-resizing', previous.bodyResizing);
        handle.classList.toggle('active', previous.handleActive);
    }

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
            if (!active) {
                restoreDragStyles();
                return;
            }
            dragStyles = {
                body: doc.body,
                declarations: [[doc.body.style, 'cursor'], [doc.body.style, 'user-select'], [paneElement.style, 'transition']]
                    .map(([style, property]) => [style, property, style.getPropertyValue(property), style.getPropertyPriority(property)]),
                bodyResizing: doc.body.classList.contains('vcp-sidebar-resizing'),
                handleActive: handle.classList.contains('active')
            };
            doc.body.style.cursor = 'col-resize';
            doc.body.style.userSelect = 'none';
            doc.body.classList.add('vcp-sidebar-resizing');
            if (paneElement?.style) {
                paneElement.style.transition = 'none';
            }
            handle.classList.add('active');
        },
        onCommit: (width, event) => {
            if (isDisposed) return;
            const finalWidth = Math.round(width);
            handle?.setAttribute?.('aria-valuenow', String(finalWidth));
            commitWidth(finalWidth, event?.type === 'keydown');
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
            commitWidth(finalWidth, true);
        }
    };
    // 焦点离开分隔条时把没写的宽度写掉
    const onBlur = () => flushKeyboardCommit();

    handle?.addEventListener?.('keydown', onKeydown);
    handle?.addEventListener?.('blur', onBlur);

    const owner = Object.freeze({
        cancel() {
            if (isDisposed) return;
            try {
                resizer?.cancel?.();
            } finally {
                restoreDragStyles();
            }
        },
        refresh() {
            if (!isDisposed) resizer?.refresh?.();
        },
        dispose() {
            if (isDisposed) return;
            flushKeyboardCommit();
            isDisposed = true;
            handle?.removeEventListener?.('keydown', onKeydown);
            handle?.removeEventListener?.('blur', onBlur);
            try {
                resizer?.dispose?.();
            } finally {
                restoreDragStyles();
            }
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
