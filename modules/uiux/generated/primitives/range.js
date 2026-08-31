const STYLE_ID = 'vcp-uiux-uiux-range';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // The wrapper is the presentation owner.  It keeps the legacy
    // `.slider-container` row flexible without retaining an Agent-id-specific
    // width rule, so the canonical native range can move independently.
    style.textContent = `.vcp-uiux-range{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;flex:1 1 auto;min-width:0}.vcp-uiux-range input[type=range]{width:100%;height:20px;margin:0;accent-color:var(--vcp-color-brand,#1677ff);cursor:pointer}.vcp-uiux-range input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:var(--vcp-color-border,#d0d7de)}.vcp-uiux-range input[type=range]::-webkit-slider-thumb{width:16px;height:16px;margin-top:-6px;border:2px solid var(--vcp-color-brand,#1677ff);border-radius:50%;background:var(--vcp-color-surface,#fff);box-shadow:none;appearance:none}.vcp-uiux-range input[type=range]::-moz-range-track{height:4px;border-radius:999px;background:var(--vcp-color-border,#d0d7de)}.vcp-uiux-range input[type=range]::-moz-range-thumb{width:12px;height:12px;border:2px solid var(--vcp-color-brand,#1677ff);border-radius:50%;background:var(--vcp-color-surface,#fff);box-shadow:none}.vcp-uiux-range output{min-width:3.5em;color:var(--vcp-color-muted,#68707d);font-size:12px;line-height:18px;text-align:right}`;
    (document.head || document.documentElement).append(style);
}
/** Uiux range contract over a native range and optional output. */
export function mountRange(input, props = {}, scope) {
    if (!input || input.type !== 'range' || !scope)
        throw new TypeError('Range requires native range input and scope.');
    ensureStyles();
    const parent = input.parentNode;
    if (!parent)
        throw new Error('Range requires a connected parent.');
    const inputNextSibling = input.nextSibling;
    const outputParent = props.output?.parentNode ?? null;
    const outputNextSibling = props.output?.nextSibling ?? null;
    const wrap = document.createElement('span');
    wrap.className = 'vcp-uiux-range';
    const output = props.output ?? null;
    const sync = () => { if (output)
        output.textContent = props.format ? props.format(input.value) : `${input.value}px`; };
    parent.insertBefore(wrap, input);
    wrap.append(input);
    if (output)
        wrap.append(output);
    // vcp-uiux-sync mirrors host-driven programmatic value writes (snapshot
    // replay, Agent populate) into the output display, matching the Select
    // primitive contract.
    scope.listen(input, 'input', sync);
    scope.listen(input, 'change', sync);
    scope.listen(input, 'vcp-uiux-sync', sync);
    sync();
    return scope.own(() => {
        if (input.parentNode === wrap) {
            if (inputNextSibling && inputNextSibling.parentNode === parent)
                parent.insertBefore(input, inputNextSibling);
            else
                parent.append(input);
        }
        if (output?.parentNode === wrap) {
            if (outputNextSibling && outputNextSibling.parentNode === outputParent)
                outputParent?.insertBefore(output, outputNextSibling);
            else if (outputParent)
                outputParent.append(output);
        }
        wrap.remove();
    }, 'uiux-range', 'ui-primitive');
}
