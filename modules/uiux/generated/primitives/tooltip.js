const STYLE_ID = 'vcp-harness-uiux-tooltip';
const EDGE_MARGIN = 12;
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-tooltip-bubble{position:fixed;z-index:100;width:max-content;max-width:50vw;padding:3px 7px;border-radius:8px;background:var(--dsw-alias-tooltip-bg,#2c2c2e);color:var(--dsw-static-neutral-bluish-00,#fff);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;pointer-events:none;animation:vcp-harness-tooltip-in var(--vcp-motion-duration-standard,150ms) var(--vcp-motion-ease-standard,ease-in-out)}.vcp-harness-tooltip-bubble[data-side=right]{transform:translateY(-50%)}.vcp-harness-tooltip-bubble[data-side=bottom]{transform:translateX(-50%)}.vcp-harness-tooltip-bubble[data-side=top]{transform:translate(-50%,-100%)}@keyframes vcp-harness-tooltip-in{from{opacity:0}}@media(prefers-reduced-motion:reduce){.vcp-harness-tooltip-bubble{animation:none}}`;
    (document.head || document.documentElement).append(style);
}
/** Harness Tooltip attaches to the existing anchor without adding a wrapper. */
export function mountTooltip(anchor, props, scope) {
    if (!anchor?.parentNode || !props?.label || !scope)
        throw new TypeError('Tooltip requires a connected anchor, label and scope.');
    ensureStyles();
    const tooltipScope = scope.child('harness-tooltip');
    const requestedSide = props.side ?? 'right';
    const delayMs = Math.max(0, props.delayMs ?? 0);
    const triggers = { hover: false, focus: false };
    let disabled = Boolean(props.disabled);
    let bubble = null;
    let showTimer = null;
    let resizeRelease = null;
    let scrollRelease = null;
    const cancelShow = () => {
        if (showTimer === null)
            return;
        clearTimeout(showTimer);
        showTimer = null;
    };
    const releaseResize = () => {
        resizeRelease?.();
        resizeRelease = null;
    };
    const releaseScroll = () => {
        scrollRelease?.();
        scrollRelease = null;
    };
    const hide = () => {
        cancelShow();
        releaseResize();
        releaseScroll();
        bubble?.remove();
        bubble = null;
    };
    const place = () => {
        if (!bubble)
            return;
        const rect = anchor.getBoundingClientRect();
        let placement = requestedSide;
        const baseX = requestedSide === 'right' ? rect.right + 10 : rect.left + rect.width / 2;
        bubble.dataset.side = placement;
        bubble.style.left = `${baseX}px`;
        bubble.style.top = `${requestedSide === 'right' ? rect.top + rect.height / 2 : requestedSide === 'top' ? rect.top - 8 : rect.bottom + 8}px`;
        let measured = bubble.getBoundingClientRect();
        let dx = 0;
        const hasSize = measured.width > 0 || measured.height > 0;
        if (hasSize && measured.right > window.innerWidth - EDGE_MARGIN)
            dx = window.innerWidth - EDGE_MARGIN - measured.right;
        if (hasSize && measured.left + dx < EDGE_MARGIN)
            dx = EDGE_MARGIN - measured.left;
        bubble.style.left = `${baseX + dx}px`;
        if (requestedSide !== 'right') {
            const fitsBelow = rect.bottom + 8 + measured.height <= window.innerHeight - EDGE_MARGIN;
            const fitsAbove = rect.top - 8 - measured.height >= EDGE_MARGIN;
            if (placement === 'bottom' && !fitsBelow && fitsAbove)
                placement = 'top';
            if (placement === 'top' && !fitsAbove && fitsBelow)
                placement = 'bottom';
            bubble.dataset.side = placement;
            bubble.style.top = `${placement === 'top' ? rect.top - 8 : rect.bottom + 8}px`;
            measured = bubble.getBoundingClientRect();
            void measured;
        }
    };
    const show = () => {
        if (disabled || bubble)
            return;
        const portal = document.body || document.documentElement;
        if (!portal)
            return;
        bubble = document.createElement('span');
        bubble.className = 'vcp-harness-tooltip-bubble';
        bubble.dataset.motion = 'enter';
        bubble.setAttribute('role', 'tooltip');
        bubble.textContent = typeof props.label === 'function' ? props.label() : props.label;
        if (props.maxWidth !== undefined)
            bubble.style.maxWidth = `${props.maxWidth}px`;
        portal.append(bubble);
        place();
        const onResize = () => place();
        window.addEventListener('resize', onResize);
        resizeRelease = () => window.removeEventListener('resize', onResize);
        const onScroll = () => place();
        document.addEventListener('scroll', onScroll, true);
        scrollRelease = () => document.removeEventListener('scroll', onScroll, true);
    };
    const showAfterDelay = () => {
        cancelShow();
        if (delayMs === 0) {
            show();
            return;
        }
        showTimer = setTimeout(() => { showTimer = null; show(); }, delayMs);
    };
    const enter = () => {
        triggers.hover = true;
        showAfterDelay();
    };
    const leave = () => {
        triggers.hover = false;
        hide();
    };
    tooltipScope.listen(anchor, 'mouseenter', enter);
    tooltipScope.listen(anchor, 'mouseleave', leave);
    // The Electron evidence runner dispatches PointerEvent directly; Chromium
    // does not synthesize mouseenter from that programmatic event.
    tooltipScope.listen(anchor, 'pointerenter', enter);
    tooltipScope.listen(anchor, 'pointerleave', leave);
    tooltipScope.listen(anchor, 'focus', () => {
        triggers.focus = true;
        cancelShow();
        show();
    });
    // Electron can deliver focusin without a subsequent focus event when a
    // native control is enhanced during the same task. Keep the owner state
    // deterministic across both DOM focus paths.
    tooltipScope.listen(anchor, 'focusin', () => {
        triggers.focus = true;
        cancelShow();
        show();
    });
    tooltipScope.listen(anchor, 'blur', () => {
        triggers.focus = false;
        if (!triggers.hover && !triggers.focus)
            hide();
    });
    tooltipScope.listen(anchor, 'focusout', () => {
        triggers.focus = false;
        if (!triggers.hover && !triggers.focus)
            hide();
    });
    const dispose = scope.own(async () => {
        disabled = true;
        triggers.hover = false;
        triggers.focus = false;
        hide();
        await tooltipScope.dispose('harness-tooltip-unmounted');
    }, 'harness-tooltip', 'ui-primitive');
    return {
        anchor,
        get bubble() { return bubble; },
        get open() { return bubble !== null; },
        get disabled() { return disabled; },
        setDisabled(value) {
            disabled = value;
            if (disabled) {
                triggers.hover = false;
                triggers.focus = false;
                hide();
            }
        },
        dispose,
    };
}
