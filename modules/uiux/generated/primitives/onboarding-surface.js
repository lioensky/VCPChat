const STYLE_ID = 'vcp-uiux-uiux-onboarding-surface';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-uiux-onboarding-overlay{position:fixed;inset:0;z-index:1100}.vcp-uiux-onboarding-mask{position:absolute;left:0;right:0;top:80px;bottom:0;background:rgba(0,0,0,.24);backdrop-filter:blur(2px)}.vcp-uiux-onboarding-stage{position:absolute;z-index:1;inset:0;display:flex;justify-content:center;overflow:hidden;background:var(--dsw-alias-bg-layer-1,var(--vcp-color-surface,#fff))}`;
    (document.head || document.documentElement).append(style);
}
const nodes = (value) => Array.isArray(value) ? Array.from(value) : [value];
/** Uiux first-run takeover: body portal plus exact app-root inert ownership. */
export function mountOnboardingSurface(props, scope) {
    if (!props?.content || !scope)
        throw new TypeError('OnboardingSurface requires content and scope.');
    ensureStyles();
    const overlay = document.createElement('div');
    overlay.className = 'vcp-uiux-onboarding-overlay';
    overlay.setAttribute('role', 'presentation');
    const mask = document.createElement('div');
    mask.className = 'vcp-uiux-onboarding-mask';
    mask.setAttribute('aria-hidden', 'true');
    const stage = document.createElement('div');
    stage.className = 'vcp-uiux-onboarding-stage';
    overlay.append(mask, stage);
    const content = nodes(props.content);
    const positions = content.map(node => ({ node, parent: node.parentNode, next: node.nextSibling }));
    const appRoot = props.appRoot ?? document.getElementById('root');
    const originalInert = appRoot?.inert ?? false;
    let active = false;
    const restore = () => positions.slice().reverse().forEach(({ node, parent, next }) => { if (!parent) {
        node.remove();
        return;
    } if (next?.parentNode === parent)
        parent.insertBefore(node, next);
    else
        parent.appendChild(node); });
    const open = () => { if (active)
        return; active = true; if (appRoot)
        appRoot.inert = true; stage.append(...content); document.body.append(overlay); };
    const close = () => { if (!active)
        return; active = false; overlay.remove(); restore(); if (appRoot)
        appRoot.inert = originalInert; };
    const dispose = scope.own(() => close(), 'uiux-onboarding-surface', 'ui-surface');
    const controller = { overlay, stage, get open() { return active; }, setOpen(value) { value ? open() : close(); }, dispose };
    if (props.open !== false)
        open();
    return controller;
}
