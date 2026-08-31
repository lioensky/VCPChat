const STYLE_ID = 'vcp-harness-uiux-input';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-uiux-input-wrap{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,var(--vcp-color-border,#c8ccd4));border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--vcp-color-surface,#fff))}.vcp-uiux-input-wrap:focus-within{border-color:var(--dsw-alias-brand-primary,var(--vcp-color-brand,#1677ff))}.vcp-uiux-input-wrap>.input{box-sizing:border-box!important;flex:1;min-width:0;height:22px!important;min-height:0!important;max-height:none!important;border:0!important;border-radius:0!important;outline:0;padding:0 10px!important;background:transparent;font-size:14px;line-height:22px!important;color:var(--dsw-alias-label-primary,var(--vcp-color-text,#1f2329))}.vcp-uiux-input-wrap>.icon{display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#8a8f98)}.vcp-uiux-input-wrap>.input::placeholder{color:var(--dsw-alias-label-dimmed,#a0a5ad)}`;
    (document.head || document.documentElement).append(style);
}
/** Harness Input contract: native input remains the authoritative control. */
export function mountInput(input, props = {}, scope) {
    if (!input || !scope)
        throw new TypeError('Input requires input and scope.');
    ensureStyles();
    const parent = input.parentNode;
    if (!parent)
        throw new Error('Input requires a connected parent.');
    const originalInputClass = input.classList.contains('input');
    const originalInline = {
        boxSizing: input.style.getPropertyValue('box-sizing'),
        boxSizingPriority: input.style.getPropertyPriority('box-sizing'),
        height: input.style.getPropertyValue('height'),
        heightPriority: input.style.getPropertyPriority('height'),
        minHeight: input.style.getPropertyValue('min-height'),
        minHeightPriority: input.style.getPropertyPriority('min-height'),
        maxHeight: input.style.getPropertyValue('max-height'),
        maxHeightPriority: input.style.getPropertyPriority('max-height'),
        border: input.style.getPropertyValue('border'),
        borderPriority: input.style.getPropertyPriority('border'),
        borderRadius: input.style.getPropertyValue('border-radius'),
        borderRadiusPriority: input.style.getPropertyPriority('border-radius'),
        padding: input.style.getPropertyValue('padding'),
        paddingPriority: input.style.getPropertyPriority('padding'),
        lineHeight: input.style.getPropertyValue('line-height'),
        lineHeightPriority: input.style.getPropertyPriority('line-height'),
    };
    input.style.setProperty('box-sizing', 'border-box', 'important');
    input.style.setProperty('height', '22px', 'important');
    input.style.setProperty('min-height', '0', 'important');
    input.style.setProperty('max-height', 'none', 'important');
    input.style.setProperty('border', '0', 'important');
    input.style.setProperty('border-radius', '0', 'important');
    input.style.setProperty('padding', '0 10px', 'important');
    input.style.setProperty('line-height', '22px', 'important');
    const wrap = document.createElement('span');
    wrap.className = 'vcp-uiux-input-wrap wrap';
    input.classList.add('input');
    if (props.icon) {
        const icon = document.createElement('span');
        icon.className = 'icon';
        icon.append(props.icon.cloneNode ? props.icon.cloneNode(true) : props.icon);
        wrap.append(icon);
    }
    if (props.placeholder !== undefined)
        input.placeholder = props.placeholder;
    parent.insertBefore(wrap, input);
    wrap.append(input);
    return scope.own(() => {
        if (input.parentNode === wrap)
            parent.insertBefore(input, wrap);
        wrap.remove();
        if (!originalInputClass)
            input.classList.remove('input');
        for (const [property, value, priority] of [
            ['box-sizing', originalInline.boxSizing, originalInline.boxSizingPriority],
            ['height', originalInline.height, originalInline.heightPriority],
            ['min-height', originalInline.minHeight, originalInline.minHeightPriority],
            ['max-height', originalInline.maxHeight, originalInline.maxHeightPriority],
            ['border', originalInline.border, originalInline.borderPriority],
            ['border-radius', originalInline.borderRadius, originalInline.borderRadiusPriority],
            ['padding', originalInline.padding, originalInline.paddingPriority],
            ['line-height', originalInline.lineHeight, originalInline.lineHeightPriority],
        ]) {
            if (value)
                input.style.setProperty(property, value, priority);
            else
                input.style.removeProperty(property);
        }
    }, 'harness-input', 'ui-primitive');
}
