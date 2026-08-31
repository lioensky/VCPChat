const STYLE_ID = 'vcp-harness-uiux-numeric-stepper-row';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-numeric-stepper-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.vcp-harness-numeric-stepper-row-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:48px}.vcp-harness-numeric-stepper-row-title{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-harness-numeric-stepper-row-description{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c)}.vcp-harness-numeric-stepper-row-control{display:inline-flex;align-items:center;gap:8px}.vcp-harness-numeric-stepper-row-stepper{position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:72px;height:36px;border-radius:18px;background:var(--dsw-alias-bg-module-platform,rgb(245,246,247));color:var(--dsw-alias-label-primary,#0f1115)}.vcp-harness-numeric-stepper-row-value{min-width:28px;text-align:center;font-size:14px;line-height:22px;font-variant-numeric:tabular-nums}.vcp-harness-numeric-stepper-row-unit{font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary,#7b818a)}.vcp-harness-numeric-stepper-row-arrows{position:absolute;right:8px;display:flex;flex-direction:column;gap:2px;opacity:0}.vcp-harness-numeric-stepper-row-stepper:hover .vcp-harness-numeric-stepper-row-arrows,.vcp-harness-numeric-stepper-row-stepper:focus-within .vcp-harness-numeric-stepper-row-arrows{opacity:1}.vcp-harness-numeric-stepper-row-arrow{display:inline-flex;align-items:center;justify-content:center;width:17px;height:12px;padding:0;border:0;border-radius:3px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 75%,transparent);color:inherit;cursor:pointer}.vcp-harness-numeric-stepper-row-arrow:disabled{opacity:.4;cursor:default}`;
    (document.head || document.documentElement).append(style);
}
const UP = 'M2.15137 8.5L2.57617 8.07617L5.30273 5.34863C5.55843 5.09294 5.78438 4.86618 5.98828 4.70215C6.20088 4.53117 6.44405 4.38244 6.75 4.33398C6.91565 4.30778 7.08435 4.30778 7.25 4.33398C7.55595 4.38244 7.79912 4.53117 8.01172 4.70215C8.21561 4.86618 8.44157 5.09294 8.69727 5.34863L11.4238 8.07617L11.8486 8.5L11 9.34863L10.5762 8.92383L7.84863 6.19727C7.57405 5.92269 7.40124 5.75152 7.25977 5.6377C7.12709 5.53096 7.07728 5.52187 7.0625 5.51953C7.02105 5.51297 6.97895 5.51297 6.9375 5.51953C6.92272 5.52187 6.87291 5.53096 6.74023 5.6377C6.59876 5.75152 6.42595 5.92268 6.15137 6.19727L3.42383 8.92383L3 9.34863L2.15137 8.5Z';
const DOWN = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z';
function icon(path) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', '9'); svg.setAttribute('height', '9'); svg.setAttribute('viewBox', '0 0 14 14'); svg.setAttribute('aria-hidden', 'true'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', path); p.setAttribute('fill', 'currentColor'); svg.append(p); return svg; }
export function mountNumericStepperRow(host, input, props, scope) {
    if (!host || !input || (input.type !== 'range' && input.type !== 'number') || !scope)
        throw new TypeError('NumericStepperRow requires a native range/number input and scope.');
    ensureStyles();
    const originalChildren = Array.from(host.childNodes);
    const row = document.createElement('div');
    row.className = 'vcp-harness-numeric-stepper-row';
    const text = document.createElement('div');
    text.className = 'vcp-harness-numeric-stepper-row-text';
    const title = document.createElement('div');
    title.className = 'vcp-harness-numeric-stepper-row-title';
    title.textContent = props.title;
    const desc = document.createElement('div');
    desc.className = 'vcp-harness-numeric-stepper-row-description';
    desc.textContent = props.description;
    text.append(title, desc);
    const control = document.createElement('div');
    control.className = 'vcp-harness-numeric-stepper-row-control';
    const stepper = document.createElement('div');
    stepper.className = 'vcp-harness-numeric-stepper-row-stepper';
    const value = document.createElement('span');
    value.className = 'vcp-harness-numeric-stepper-row-value';
    const arrows = document.createElement('span');
    arrows.className = 'vcp-harness-numeric-stepper-row-arrows';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'vcp-harness-numeric-stepper-row-arrow';
    up.setAttribute('aria-label', `增大${props.title}`);
    up.append(icon(UP));
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'vcp-harness-numeric-stepper-row-arrow';
    down.setAttribute('aria-label', `减小${props.title}`);
    down.append(icon(DOWN));
    arrows.append(up, down);
    stepper.append(value, arrows);
    const unit = document.createElement('span');
    unit.className = 'vcp-harness-numeric-stepper-row-unit';
    unit.textContent = props.unit ?? 'px';
    control.append(stepper, unit);
    row.append(text, control, input);
    host.replaceChildren(row);
    const sync = () => { const n = Number(input.value); value.textContent = input.value; up.disabled = n >= Number(input.max); down.disabled = n <= Number(input.min); };
    const change = (delta) => { const n = Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) + delta * Number(input.step || 1))); input.value = String(n); input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true })); input.dispatchEvent(new input.ownerDocument.defaultView.Event('change', { bubbles: true })); sync(); };
    // vcp-uiux-sync mirrors host-driven programmatic value writes (snapshot
    // replay) into the stepper display, matching the Select primitive contract.
    scope.listen(input, 'input', sync);
    scope.listen(input, 'change', sync);
    scope.listen(input, 'vcp-uiux-sync', sync);
    scope.listen(up, 'click', () => change(1));
    scope.listen(down, 'click', () => change(-1));
    sync();
    const dispose = scope.own(() => { row.remove(); host.replaceChildren(...originalChildren); }, 'harness-numeric-stepper-row', 'ui-primitive');
    return { root: row, dispose };
}
