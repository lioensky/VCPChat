import type { UiDisposer, UiScope } from '../contracts.js';

const STYLE_ID = 'vcp-harness-uiux-onboarding-surface';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style'); style.id = STYLE_ID;
    style.textContent = `.vcp-harness-onboarding-overlay{position:fixed;inset:0;z-index:1100}.vcp-harness-onboarding-mask{position:absolute;left:0;right:0;top:80px;bottom:0;background:rgba(0,0,0,.24);backdrop-filter:blur(2px)}.vcp-harness-onboarding-stage{position:absolute;z-index:1;inset:0;display:flex;justify-content:center;overflow:hidden;background:var(--dsw-alias-bg-layer-1,var(--vcp-color-surface,#fff))}`;
    (document.head || document.documentElement).append(style);
}

export interface OnboardingSurfaceProps { readonly content: Node | readonly Node[]; readonly appRoot?: HTMLElement | null; readonly open?: boolean; }
export interface OnboardingSurfaceController { readonly overlay: HTMLDivElement; readonly stage: HTMLDivElement; readonly open: boolean; setOpen(value: boolean): void; dispose(): void | Promise<void>; }
const nodes = (value: Node | readonly Node[]) => Array.isArray(value) ? Array.from(value) : [value];

/** Harness first-run takeover: body portal plus exact app-root inert ownership. */
export function mountOnboardingSurface(props: OnboardingSurfaceProps, scope: UiScope): OnboardingSurfaceController {
    if (!props?.content || !scope) throw new TypeError('OnboardingSurface requires content and scope.');
    ensureStyles();
    const overlay = document.createElement('div'); overlay.className = 'vcp-harness-onboarding-overlay'; overlay.setAttribute('role', 'presentation');
    const mask = document.createElement('div'); mask.className = 'vcp-harness-onboarding-mask'; mask.setAttribute('aria-hidden', 'true');
    const stage = document.createElement('div'); stage.className = 'vcp-harness-onboarding-stage'; overlay.append(mask, stage);
    const content = nodes(props.content); const positions = content.map(node => ({ node, parent: node.parentNode, next: node.nextSibling }));
    const appRoot = props.appRoot ?? document.getElementById('root'); const originalInert = appRoot?.inert ?? false;
    let active = false;
    const restore = () => positions.slice().reverse().forEach(({ node, parent, next }) => { if (!parent) { node.remove(); return; } if (next?.parentNode === parent) parent.insertBefore(node, next); else parent.appendChild(node); });
    const open = () => { if (active) return; active = true; if (appRoot) appRoot.inert = true; stage.append(...content); document.body.append(overlay); };
    const close = () => { if (!active) return; active = false; overlay.remove(); restore(); if (appRoot) appRoot.inert = originalInert; };
    const dispose = scope.own(() => close(), 'harness-onboarding-surface', 'ui-surface');
    const controller: OnboardingSurfaceController = { overlay, stage, get open() { return active; }, setOpen(value) { value ? open() : close(); }, dispose };
    if (props.open !== false) open();
    return controller;
}
