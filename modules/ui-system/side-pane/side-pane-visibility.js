/* Side pane open / close: width ratio, the open and close animation, and the content width lock while it runs. */
'use strict';

// 宽度按父元素内容区的比例记（ZCode sidePaneLayout.ts: SIDE_PANE_DEFAULT_EXPANDED_RATIO = 0.45）
export const DEFAULT_EXPANDED_RATIO = 0.45;
export const MIN_RATIO = 0.20;
export const MAX_RATIO = 0.65;
const MIN_EXPANDED_WIDTH_PX = 240;
// transitionend 没来时的兜底，和 CSS 里的过渡时长一致
const ANIMATION_FALLBACK_MS = 240;

export function clampRatio(ratio) {
    return Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
}

export function isValidRatio(ratio) {
    return Number.isFinite(ratio) && ratio >= MIN_RATIO && ratio <= MAX_RATIO;
}

/**
 * root 是面板本身；onSync(isVisible) 在每次可见性落定或动画开始时调用，用来同步标题栏按钮。
 */
export function createSidePaneVisibility({ root, resizerHandle = null, initialRatio, onSync = () => {} }) {
    const win = root.ownerDocument?.defaultView || globalThis.window;
    let ratio = isValidRatio(initialRatio) ? initialRatio : DEFAULT_EXPANDED_RATIO;
    let animating = false;
    let animationTimer = null;
    let animationRafId = null;

    const isJSDOM = (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.includes('jsdom'))
        || (typeof win !== 'undefined' && win.name === 'nodejs');

    const formattedPercent = () => `${(ratio * 100).toFixed(1)}%`;

    // 百分比宽度相对父元素内容区，比例也必须按它算；测不到（父元素没有盒子）时返回 0，不更新比例
    function readHostContentWidth() {
        const host = root.parentElement;
        if (!host) return 0;
        const style = win?.getComputedStyle?.(host);
        const width = host.clientWidth - (parseFloat(style?.paddingLeft) || 0) - (parseFloat(style?.paddingRight) || 0);
        return width > 0 ? width : 0;
    }

    function clearPendingAnimation() {
        if (animationTimer) {
            clearTimeout(animationTimer);
            animationTimer = null;
        }
        if (animationRafId) {
            win?.cancelAnimationFrame?.(animationRafId);
            animationRafId = null;
        }
    }

    // 开合动画期间把内容宽度锁在展开宽度，避免正文随面板宽度逐帧重排（同 ZCode lockedContentWidthPx）
    function lockContentWidth(widthPx) {
        const style = win?.getComputedStyle?.(root);
        const borderPx = (parseFloat(style?.borderLeftWidth) || 0) + (parseFloat(style?.borderRightWidth) || 0);
        if (Number.isFinite(widthPx) && widthPx > borderPx) {
            root.style.setProperty('--side-pane-locked-width', `${Math.floor(widthPx - borderPx)}px`);
        }
    }

    function unlockContentWidth() {
        root.style.removeProperty('--side-pane-locked-width');
    }

    // 展开后的宽度：百分比相对父元素内容区，再按 min 240px / max 65% 夹住
    function readExpandedWidthPx() {
        const hostWidth = readHostContentWidth();
        if (!(hostWidth > 0)) return 0;
        return Math.min(hostWidth * MAX_RATIO, Math.max(MIN_EXPANDED_WIDTH_PX, hostWidth * ratio));
    }

    function applySynchronous(isVisible) {
        clearPendingAnimation();
        animating = false;
        root.classList.remove('is-animating');
        root.classList.toggle('active', isVisible);
        root.classList.toggle('collapsed', !isVisible);
        root.setAttribute('aria-hidden', String(!isVisible));

        resizerHandle?.classList.remove('is-animating', 'is-animating-closing');
        unlockContentWidth();

        root.style.width = isVisible ? formattedPercent() : '';
        root.style.opacity = '';

        onSync(isVisible);
    }

    function runTransition(finish, nextFrame) {
        const onTransitionEnd = (e) => {
            if (e.target === root && e.propertyName === 'width') done();
        };
        const done = () => {
            clearPendingAnimation();
            animating = false;
            root.removeEventListener('transitionend', onTransitionEnd);
            finish();
            unlockContentWidth();
            resizerHandle?.classList.remove('is-animating', 'is-animating-closing');
        };
        root.addEventListener('transitionend', onTransitionEnd);
        animationTimer = setTimeout(done, ANIMATION_FALLBACK_MS);
        animationRafId = win.requestAnimationFrame(() => {
            animationRafId = null;
            nextFrame();
        });
    }

    function animateOpen() {
        clearPendingAnimation();
        animating = true;

        const targetPercent = formattedPercent();
        lockContentWidth(readExpandedWidthPx());

        // 起始帧：先显示并压到 0 宽，下一帧再放开（ZCode next-frame pattern）
        root.classList.remove('collapsed');
        root.removeAttribute('aria-hidden');
        root.classList.add('is-animating', 'active');
        root.style.width = '0%';
        root.style.opacity = '0';
        resizerHandle?.classList.add('is-animating', 'is-animating-closing');
        onSync(true);

        runTransition(() => {
            root.classList.remove('is-animating');
            root.style.width = targetPercent;
            root.style.opacity = '';
        }, () => {
            root.style.width = targetPercent;
            root.style.opacity = '1';
            resizerHandle?.classList.remove('is-animating-closing');
        });
    }

    function animateClose() {
        clearPendingAnimation();
        animating = true;

        const startPercent = root.style.width || formattedPercent();
        lockContentWidth(root.getBoundingClientRect().width);
        root.classList.add('is-animating');
        root.style.width = startPercent;
        root.style.opacity = '1';
        resizerHandle?.classList.add('is-animating', 'is-animating-closing');
        onSync(false);

        runTransition(() => {
            root.classList.remove('is-animating', 'active');
            root.classList.add('collapsed');
            root.setAttribute('aria-hidden', 'true');
            root.style.width = '';
            root.style.opacity = '';
        }, () => {
            root.style.width = '0%';
            root.style.opacity = '0';
        });
    }

    return Object.freeze({
        isAnimating: () => animating,
        getRatio: () => ratio,
        readHostContentWidth,

        setRatio(next) {
            ratio = clampRatio(next);
        },

        // 按像素宽度换算比例；父元素量不出宽度时不动，返回 false
        setRatioFromWidth(widthPx) {
            const hostWidth = readHostContentWidth();
            if (!(hostWidth > 0)) return false;
            ratio = clampRatio(widthPx / hostWidth);
            return true;
        },

        writeWidth() {
            root.style.width = formattedPercent();
        },

        // 窗口缩放后面板宽度若被写成了像素值，换回百分比
        ensurePercentWidth() {
            if (!animating && !root.style.width.endsWith('%')) root.style.width = formattedPercent();
        },

        sync(isVisible, { animate = true } = {}) {
            const shouldAnimate = animate
                && !isJSDOM
                && typeof win?.requestAnimationFrame === 'function'
                && !win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

            if (!shouldAnimate) {
                applySynchronous(isVisible);
                return;
            }

            const currentlyVisible = root.classList.contains('active') && !root.classList.contains('collapsed');
            if (isVisible === currentlyVisible && !animating) {
                if (isVisible) root.style.width = formattedPercent();
                onSync(isVisible);
                return;
            }

            if (isVisible) animateOpen();
            else animateClose();
        },

        dispose() {
            clearPendingAnimation();
        }
    });
}
