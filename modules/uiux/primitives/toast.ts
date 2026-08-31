import type { UiDisposer, UiScope } from '../contracts.js';

const STYLE_ID = 'vcp-harness-uiux-toast';
export const TOAST_HOLD_MS = 3000;
export const TOAST_FADE_MS = 1000;

function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-toast{position:fixed;top:120px;left:50%;z-index:1100;pointer-events:none;display:flex;align-items:center;gap:10px;max-width:min(560px,calc(100vw - 48px));padding:12px 16px;border-radius:14px;background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-label-primary-inverted);font-family:var(--dsw-font-family);font-size:14px;line-height:22px;box-shadow:var(--dsw-shadow-lv3);transform:translateX(-50%);animation:vcp-harness-toast-in var(--vcp-motion-duration-standard,160ms) var(--vcp-motion-ease-emphasized,ease-out),vcp-harness-toast-fade var(--vcp-motion-toast-fade,1000ms) var(--vcp-motion-ease-standard,ease) var(--vcp-motion-toast-hold,3000ms) forwards}.vcp-harness-toast-icon{display:grid;place-items:center;flex:none;color:var(--dsw-alias-state-warn-label)}.vcp-harness-toast-text{min-width:0}@keyframes vcp-harness-toast-in{from{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%,0)}}@keyframes vcp-harness-toast-fade{to{opacity:0}}@media(prefers-reduced-motion:reduce){.vcp-harness-toast{animation:vcp-harness-toast-fade var(--vcp-motion-toast-fade,1000ms) var(--vcp-motion-ease-standard,ease) var(--vcp-motion-toast-hold,3000ms) forwards}}`;
    (document.head || document.documentElement).append(style);
}

export interface ToastProps {
    readonly text: string;
    readonly icon?: Node;
    readonly anchor?: HTMLElement | null;
    readonly onDone: () => void;
}

export interface ToastController {
    readonly root: HTMLDivElement;
    readonly active: boolean;
    dispose(): void | Promise<void>;
}

/** One owner-controlled Harness transient banner rendered through a body portal. */
export function mountToast(props: ToastProps, scope: UiScope): ToastController {
    if (!props?.text || !props.onDone || !scope) throw new TypeError('Toast requires text, onDone and scope.');
    ensureStyles();
    const toastScope = scope.child('harness-toast');
    const root = document.createElement('div');
    root.className = 'vcp-harness-toast';
    root.dataset.motion = 'enter';
    root.setAttribute('role', 'alert');
    if (props.icon) {
        const icon = document.createElement('span');
        icon.className = 'vcp-harness-toast-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.append(props.icon);
        root.append(icon);
    }
    const text = document.createElement('span');
    text.className = 'vcp-harness-toast-text';
    text.textContent = props.text;
    root.append(text);
    document.body.append(root);
    const icons = (globalThis as typeof globalThis & { VCPIcons?: { refresh(root?: ParentNode): void } }).VCPIcons;
    try { icons?.refresh(root); } catch (error) { root.remove(); void toastScope.dispose('harness-toast-mount-failed'); throw error; }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        timer = null;
        if (!active || !toastScope.active) return;
        props.onDone();
    }, TOAST_HOLD_MS + TOAST_FADE_MS);
    const place = () => {
        if (!active || !props.anchor) return;
        const rect = props.anchor.getBoundingClientRect();
        root.style.left = `${rect.left + rect.width / 2}px`;
    };
    let resizeRelease: UiDisposer | null = null;
    if (props.anchor) {
        place();
        resizeRelease = scope.listen(window, 'resize', place);
    }
    const dispose = scope.own(async () => {
        if (!active) return;
        active = false;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        resizeRelease?.();
        resizeRelease = null;
        root.remove();
        await toastScope.dispose('harness-toast-unmounted');
    }, 'harness-toast', 'ui-primitive');
    return { root, get active() { return active; }, dispose };
}
