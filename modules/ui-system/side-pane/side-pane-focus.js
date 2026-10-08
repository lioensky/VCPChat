/*
 * 副屏焦点：只在焦点本来就在副屏里（或者随着被拆掉的视图丢到 body 上）时才挪焦点，
 * 用户在主输入框打字时副屏自己收起、关标签都不会抢走光标。
 * 副屏收起时，焦点回到打开副屏前所在的元素；那个元素已经不在了，再回到展开按钮。
 */

/**
 * @param {{ doc: Document, root: HTMLElement | null, getFallback: () => (HTMLElement | null) }} options
 */
export function createSidePaneFocus({ doc, root, getFallback }) {
    let returnTarget = null;

    function activeElement() {
        return doc?.activeElement || null;
    }

    function isInsidePane(element) {
        return !!element && !!root && root.contains(element);
    }

    function isUsable(element) {
        return !!element && element.isConnected && !isInsidePane(element)
            && !element.disabled && !element.hidden && typeof element.focus === 'function';
    }

    return Object.freeze({
        /** 副屏打开或展开前调用：记下焦点在副屏外的位置，收起时回到这里 */
        rememberOrigin() {
            const active = activeElement();
            if (active && active !== doc.body && !isInsidePane(active)) returnTarget = active;
        },

        /** 焦点在副屏里，或者已经丢了（落在 body 上）；这两种情况才该由副屏安排焦点 */
        ownsFocus() {
            const active = activeElement();
            return !active || active === doc.body || isInsidePane(active);
        },

        /** 副屏收起后把焦点送回去；焦点不归副屏管时什么都不做 */
        restoreAfterHide(ownedFocus) {
            if (!ownedFocus) return;
            const target = isUsable(returnTarget) ? returnTarget : getFallback?.();
            returnTarget = null;
            if (isUsable(target)) target.focus();
        },

        dispose() {
            returnTarget = null;
        }
    });
}
