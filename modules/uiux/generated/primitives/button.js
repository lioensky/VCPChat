const STYLE_ID = 'vcp-harness-uiux-button';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-button.button{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:0;border-radius:18px;cursor:pointer;font-family:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,var(--vcp-color-text,#0f1115));background:transparent;padding:0 14px}.vcp-harness-button.button:disabled{cursor:not-allowed;opacity:.4}.vcp-harness-button.button:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--vcp-color-focus,#4c8dff));outline-offset:2px}.vcp-harness-button.md{height:36px}.vcp-harness-button.sm{height:28px;padding:0 10px;border-radius:14px;font-size:12px;line-height:18px}.vcp-harness-button.primary{background:var(--dsw-alias-button-primary-fill,var(--vcp-color-brand,#1677ff));color:var(--dsw-alias-label-primary-foreground,#fff)}.vcp-harness-button.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--vcp-color-brand-hover,#1267d6))}.vcp-harness-button.ghost:hover:not(:disabled),.vcp-harness-button.outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}.vcp-harness-button.ghost:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.1))}.vcp-harness-button.outline{border:1px solid var(--dsw-alias-border-l2,var(--vcp-color-border,#d7d9de));background:transparent}.vcp-harness-button.toolbar{background:var(--dsw-alias-button-tool-bar-fill,var(--vcp-color-surface-muted,#f3f4f6))}.vcp-harness-button.toolbar:hover:not(:disabled){background:var(--dsw-alias-button-tool-bar-hover,var(--vcp-color-surface-hover,#e8eaf0))}.vcp-harness-button>.icon{display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center}`;
    (document.head || document.documentElement).append(style);
}
/** Harness Button contract applied to a native button in Light DOM. */
export function mountButton(button, props = {}, scope) {
    if (!button || !scope)
        throw new TypeError('Button requires a native button and scope.');
    ensureStyles();
    const originalClass = button.getAttribute('class');
    const originalType = button.getAttribute('type');
    const originalDisabled = button.disabled;
    const originalDisplay = button.style.getPropertyValue('display');
    const originalDisplayPriority = button.style.getPropertyPriority('display');
    const originalInline = Object.fromEntries(['gap', 'height', 'padding', 'border-radius', 'font-size', 'line-height']
        .map(property => [property, [button.style.getPropertyValue(property), button.style.getPropertyPriority(property)]]));
    const variant = props.variant ?? 'ghost';
    const size = props.size ?? 'md';
    if (originalType === null)
        button.type = 'button';
    button.classList.add('vcp-harness-button', 'button', variant, size);
    // Legacy Settings selectors can outrank the shared class rule. Preserve
    // the Harness geometry with an owner-bound inline declaration and restore
    // the exact previous declaration during disposal.
    button.style.setProperty('display', 'inline-flex', 'important');
    button.style.setProperty('gap', '4px', 'important');
    button.style.setProperty('height', size === 'sm' ? '28px' : '36px', 'important');
    button.style.setProperty('padding', size === 'sm' ? '0 10px' : '0 14px', 'important');
    button.style.setProperty('border-radius', size === 'sm' ? '14px' : '18px', 'important');
    button.style.setProperty('font-size', size === 'sm' ? '12px' : '14px', 'important');
    button.style.setProperty('line-height', size === 'sm' ? '18px' : '22px', 'important');
    if (props.disabled !== undefined)
        button.disabled = props.disabled;
    let icon = null;
    if (props.icon) {
        icon = document.createElement('span');
        icon.className = 'icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.append(props.icon.cloneNode ? props.icon.cloneNode(true) : props.icon);
        button.prepend(icon);
    }
    return scope.own(() => {
        icon?.remove();
        if (originalDisplay)
            button.style.setProperty('display', originalDisplay, originalDisplayPriority);
        else
            button.style.removeProperty('display');
        for (const [property, [value, priority]] of Object.entries(originalInline)) {
            if (value)
                button.style.setProperty(property, value, priority);
            else
                button.style.removeProperty(property);
        }
        button.disabled = originalDisabled;
        if (originalType === null)
            button.removeAttribute('type');
        else
            button.setAttribute('type', originalType);
        if (originalClass === null)
            button.removeAttribute('class');
        else
            button.setAttribute('class', originalClass);
    }, 'harness-button', 'ui-primitive');
}
