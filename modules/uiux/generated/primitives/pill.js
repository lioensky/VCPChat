const STYLE_ID = 'vcp-harness-uiux-pill';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-pill.pill{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:0;border-radius:12px;font-family:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--vcp-color-text-muted,#737780));background:var(--dsw-alias-bg-layer-2,var(--vcp-color-surface-muted,#f3f4f6))}.vcp-harness-pill.interactive{cursor:pointer}.vcp-harness-pill.interactive:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}.vcp-harness-pill.active{color:var(--dsw-alias-label-primary,var(--vcp-color-text,#0f1115));background:var(--dsw-alias-button-ghost-active-fill,rgba(0,0,0,.08));box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border,rgba(0,0,0,.16))}`;
    (document.head || document.documentElement).append(style);
}
/** Harness Pill contract applied to a native span or button in Light DOM. */
export function mountPill(host, props = {}, scope) {
    if (!host || !scope)
        throw new TypeError('Pill requires a host and scope.');
    ensureStyles();
    const originalClass = host.getAttribute('class');
    const isButton = host.tagName.toLowerCase() === 'button';
    const originalType = isButton ? host.getAttribute('type') : null;
    const originalHandler = props.onClick;
    const interactive = props.interactive ?? Boolean(originalHandler);
    host.classList.add('vcp-harness-pill', 'pill');
    if (interactive)
        host.classList.add('interactive');
    if (props.active)
        host.classList.add('active');
    if (isButton && originalType === null)
        host.type = 'button';
    if (originalHandler)
        scope.listen(host, 'click', originalHandler);
    return scope.own(() => {
        if (originalClass === null)
            host.removeAttribute('class');
        else
            host.setAttribute('class', originalClass);
        if (isButton) {
            if (originalType === null)
                host.removeAttribute('type');
            else
                host.setAttribute('type', originalType);
        }
    }, 'harness-pill', 'ui-primitive');
}
