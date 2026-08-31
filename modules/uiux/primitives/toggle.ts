import type { UiDisposer, UiScope } from '../contracts.js';

const STYLE_ID = 'vcp-harness-uiux-toggle';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style'); style.id = STYLE_ID;
    style.textContent = `.vcp-uiux-toggle{position:relative;display:inline-flex;align-items:center;width:36px;height:20px}.vcp-uiux-toggle input{position:absolute;inset:0;z-index:1;margin:0;opacity:0;cursor:pointer}.vcp-uiux-toggle::before{content:"";width:36px;height:20px;border-radius:10px;background:var(--vcp-color-border,#c8ccd4);transition:background 120ms ease}.vcp-uiux-toggle::after{content:"";position:absolute;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgb(0 0 0/.2);transition:transform 120ms ease}.vcp-uiux-toggle:has(input:checked)::before{background:var(--vcp-color-brand,#1677ff)}.vcp-uiux-toggle:has(input:checked)::after{transform:translateX(16px)}.vcp-uiux-toggle:focus-within{outline:2px solid var(--vcp-color-focus,#4c8dff);outline-offset:2px}`;
    (document.head || document.documentElement).append(style);
}

export function mountToggle(input: HTMLInputElement, scope: UiScope): UiDisposer {
    if (!input || input.type !== 'checkbox' || !scope) throw new TypeError('Toggle requires checkbox input and scope.');
    ensureStyles();
    const parent = input.parentNode; if (!parent) throw new Error('Toggle requires a connected parent.');
    const wrap = document.createElement('span'); wrap.className = 'vcp-uiux-toggle';
    const legacySlider = input.parentElement?.querySelector('.slider') as HTMLElement | null;
    const previousDisplay = legacySlider?.style.display ?? '';
    if (legacySlider) legacySlider.style.display = 'none';
    parent.insertBefore(wrap, input); wrap.append(input);
    return scope.own(() => { if (input.parentNode === wrap) parent.insertBefore(input, wrap); if (legacySlider) legacySlider.style.display = previousDisplay; wrap.remove(); }, 'harness-toggle', 'ui-primitive');
}
