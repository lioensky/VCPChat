/*
 * 副屏键盘快捷键：
 *   Ctrl/Cmd+Alt+B          展开或收起副屏，展开时和点展开按钮一样选标签
 *   Ctrl+PageUp / PageDown  焦点在副屏里时切到上一个 / 下一个标签
 */

const isMac = win => /Mac|iPhone|iPad/.test(win?.navigator?.platform || '');

/** 主修饰键：macOS 上是 Cmd，其他平台是 Ctrl；另一个不能同时按着 */
function hasPrimaryModifier(event, mac) {
    return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function matchesToggleSidePane(event, { mac = false } = {}) {
    if (!event || event.repeat || event.isComposing || event.shiftKey) return false;
    // 有的键盘布局里 Ctrl+Alt 就是 AltGr，AltGr+B 是在打字
    if (event.getModifierState?.('AltGraph')) return false;
    return hasPrimaryModifier(event, mac) && event.altKey && event.code === 'KeyB';
}

export function matchesCycleTab(event) {
    if (!event || event.isComposing || event.altKey || event.shiftKey || event.metaKey || !event.ctrlKey) return 0;
    if (event.key === 'PageDown') return 1;
    if (event.key === 'PageUp') return -1;
    return 0;
}

/**
 * root 是副屏面板；onToggle() 展开或收起；onCycleTab(delta) 切标签。返回 { dispose }。
 */
export function createSidePaneShortcuts({ win, root, onToggle, onCycleTab }) {
    const doc = root?.ownerDocument || win?.document;
    if (!win || !doc) return Object.freeze({ dispose() {} });
    const mac = isMac(win);

    const onKeyDown = event => {
        if (event.defaultPrevented) return;
        if (matchesToggleSidePane(event, { mac })) {
            event.preventDefault();
            onToggle?.();
            return;
        }
        const delta = matchesCycleTab(event);
        if (delta && root?.contains(doc.activeElement)) {
            event.preventDefault();
            onCycleTab?.(delta);
        }
    };

    win.addEventListener('keydown', onKeyDown, true);
    return Object.freeze({
        dispose() {
            win.removeEventListener('keydown', onKeyDown, true);
        }
    });
}
