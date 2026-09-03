const STYLE_ID = 'vcp-uiux-uiux-font-size-row';
const SCALE_TO_PX = Object.freeze({ small: 13, normal: 14, large: 16 });
const SCALE_ORDER = Object.freeze(['small', 'normal', 'large']);
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-uiux-font-size-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.vcp-uiux-font-size-row-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:48px}.vcp-uiux-font-size-row-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-uiux-font-size-row-description{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c)}.vcp-uiux-font-size-row-control{display:inline-flex;align-items:center;gap:8px}.vcp-uiux-font-size-row-stepper{position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:72px;height:36px;border:0;border-radius:18px;background:var(--dsw-alias-bg-module-platform,rgb(245,246,247));color:var(--dsw-alias-label-primary,#0f1115)}.vcp-uiux-font-size-row-value{min-width:24px;text-align:center;font-size:14px;line-height:22px;font-variant-numeric:tabular-nums}.vcp-uiux-font-size-row-unit{font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary,#7b818a)}.vcp-uiux-font-size-row-arrows{position:absolute;right:8px;display:flex;flex-direction:column;gap:2px;opacity:0}.vcp-uiux-font-size-row-stepper:hover .vcp-uiux-font-size-row-arrows,.vcp-uiux-font-size-row-stepper:focus-within .vcp-uiux-font-size-row-arrows{opacity:1}.vcp-uiux-font-size-row-arrow{display:inline-flex;align-items:center;justify-content:center;width:17px;height:12px;padding:0;border:0;border-radius:3px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 75%,transparent);color:inherit;cursor:pointer}.vcp-uiux-font-size-row-arrow:disabled{opacity:.4;cursor:default}`;
    (document.head || document.documentElement).append(style);
}
const CHEVRON_UP_PATH = 'M2.15137 8.5L2.57617 8.07617L5.30273 5.34863C5.55843 5.09294 5.78438 4.86618 5.98828 4.70215C6.20088 4.53117 6.44405 4.38244 6.75 4.33398C6.91565 4.30778 7.08435 4.30778 7.25 4.33398C7.55595 4.38244 7.79912 4.53117 8.01172 4.70215C8.21561 4.86618 8.44157 5.09294 8.69727 5.34863L11.4238 8.07617L11.8486 8.5L11 9.34863L10.5762 8.92383L7.84863 6.19727C7.57405 5.92269 7.40124 5.75152 7.25977 5.6377C7.12709 5.53096 7.07728 5.52187 7.0625 5.51953C7.02105 5.51297 6.97895 5.51297 6.9375 5.51953C6.92272 5.52187 6.87291 5.53096 6.74023 5.6377C6.59876 5.75152 6.42595 5.92268 6.15137 6.19727L3.42383 8.92383L3 9.34863L2.15137 8.5Z';
const CHEVRON_DOWN_PATH = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z';
function makeChevron(path) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '9');
    svg.setAttribute('height', '9');
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    node.setAttribute('d', path);
    node.setAttribute('fill', 'currentColor');
    svg.append(node);
    return svg;
}
// 行为绑定：M5-c pass4 起全局设置面的字号行结构由 field-renderer 静态直出
// （buildFontSizeRowStructure），本函数只给直出结构绑事件（px 读数同步 /
// 编辑器归一化 / 箭头步进），mount 与 activateFontSizeRow 共用同一份行为实现。
function bindFontSizeRowBehavior(select, value, up, down, scope) {
    const sync = () => { const px = SCALE_TO_PX[select.value] ?? 14; value.value = String(px); up.disabled = px >= 16; down.disabled = px <= 13; };
    const applyEditorValue = () => {
        const px = Math.max(13, Math.min(16, Number(value.value) || 14));
        const nearest = SCALE_ORDER.reduce((best, candidate) => Math.abs(SCALE_TO_PX[candidate] - px) < Math.abs(SCALE_TO_PX[best] - px) ? candidate : best, 'normal');
        value.value = String(SCALE_TO_PX[nearest]);
        if (select.value !== nearest) {
            select.value = nearest;
            select.dispatchEvent(new select.ownerDocument.defaultView.Event('change', { bubbles: true }));
        }
        sync();
    };
    const change = (delta) => {
        const current = Math.max(0, SCALE_ORDER.indexOf(select.value));
        const next = SCALE_ORDER[Math.max(0, Math.min(SCALE_ORDER.length - 1, current + delta))];
        if (next === select.value)
            return;
        select.value = next;
        select.dispatchEvent(new select.ownerDocument.defaultView.Event('change', { bubbles: true }));
        sync();
    };
    // vcp-uiux-sync mirrors host-driven programmatic value writes (snapshot
    // replay) into the px readout, matching the Select primitive contract.
    scope.listen(select, 'change', sync);
    scope.listen(select, 'vcp-uiux-sync', sync);
    scope.listen(value, 'change', applyEditorValue);
    scope.listen(value, 'blur', applyEditorValue);
    scope.listen(up, 'click', () => change(1));
    scope.listen(down, 'click', () => change(-1));
    sync();
    return sync;
}

// 直出结构激活：对 field-renderer 静态产出的 .vcp-uiux-font-size-row 只绑行为，
// 不重建结构（结构、内联样式、aria、draft 标记均已在渲染期定型）。
export function activateFontSizeRow(row, select, scope) {
    if (!row || !select || !row.classList?.contains('vcp-uiux-font-size-row') || !scope)
        throw new TypeError('FontSizeRow activation requires a static font-size row, its business select and scope.');
    ensureStyles();
    const value = row.querySelector('.vcp-uiux-font-size-row-value');
    const arrows = row.querySelectorAll('.vcp-uiux-font-size-row-arrow');
    const up = arrows[0];
    const down = arrows[1];
    if (!value || !up || !down)
        throw new Error('FontSizeRow activation requires the static editor and arrow buttons.');
    bindFontSizeRowBehavior(select, value, up, down, scope);
}

/** Uiux FontSizeRow presentation over the existing canonical select. */
export function mountFontSizeRow(host, select, scope) {
    if (!host || !select || !scope)
        throw new TypeError('FontSizeRow requires host, select and scope.');
    ensureStyles();
    const originalChildren = Array.from(host.childNodes);
    const row = document.createElement('div');
    row.className = 'vcp-uiux-font-size-row';
    const text = document.createElement('div');
    text.className = 'vcp-uiux-font-size-row-text';
    const title = document.createElement('div');
    title.className = 'vcp-uiux-font-size-row-title';
    title.textContent = '字号';
    const description = document.createElement('div');
    description.className = 'vcp-uiux-font-size-row-description';
    description.textContent = '调整界面文字大小';
    text.append(title, description);
    const control = document.createElement('div');
    control.className = 'vcp-uiux-font-size-row-control';
    const stepper = document.createElement('div');
    stepper.className = 'vcp-uiux-font-size-row-stepper';
    stepper.tabIndex = -1;
    const value = document.createElement('input');
    value.type = 'number';
    value.className = 'vcp-uiux-font-size-row-value vcp-uiux-numeric-stepper-row-input';
    value.style.cssText = 'width:42px;min-width:42px;height:24px;padding:0;border:0;outline:0;background:transparent;color:inherit;text-align:center;font:inherit;appearance:textfield;-webkit-appearance:none;';
    value.min = '13';
    value.max = '16';
    value.step = '1';
    value.setAttribute('aria-label', '字号（13、14 或 16px）');
    value.dataset.vcpAppearanceDraftControl = 'true';
    const unit = document.createElement('span');
    unit.className = 'vcp-uiux-font-size-row-unit';
    unit.textContent = 'px';
    const arrows = document.createElement('span');
    arrows.className = 'vcp-uiux-font-size-row-arrows';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'vcp-uiux-font-size-row-arrow';
    up.setAttribute('aria-label', '增大字号');
    up.append(makeChevron(CHEVRON_UP_PATH));
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'vcp-uiux-font-size-row-arrow';
    down.setAttribute('aria-label', '减小字号');
    down.append(makeChevron(CHEVRON_DOWN_PATH));
    arrows.append(up, down);
    stepper.append(value, arrows);
    control.append(stepper, unit);
    // Keep the native select connected as the sole business node. The hidden
    // control remains in the presentation root so Settings projection and
    // autosave can continue to query and update it during the row lifetime.
    row.append(text, control, select);
    host.replaceChildren(row);
    select.dataset.vcpAppearanceDraftControl = 'true';
    const sync = bindFontSizeRowBehavior(select, value, up, down, scope);
    const dispose = scope.own(() => {
        row.remove();
        host.replaceChildren(...originalChildren);
        delete value.dataset.vcpAppearanceDraftControl;
        delete select.dataset.vcpAppearanceDraftControl;
    }, 'uiux-font-size-row', 'ui-primitive');
    return { root: row, setValue(next) { select.value = next; sync(); }, dispose };
}
