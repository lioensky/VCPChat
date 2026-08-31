import type { UiDisposer, UiScope } from '../contracts.js';

const STYLE_ID = 'vcp-harness-uiux-connection-banner';

function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-connection-banner.banner{position:fixed;top:0;left:0;right:0;z-index:100;padding:4px 12px;text-align:center;font-family:inherit;font-size:12px;line-height:18px;background:var(--dsw-alias-state-error-primary,var(--vcp-color-danger,#d92d20));color:var(--dsw-alias-label-primary-foreground,#fff)}`;
    (document.head || document.documentElement).append(style);
}

export interface ConnectionBannerProps { readonly reconnecting: boolean; readonly label?: string; }
export interface ConnectionBannerController extends UiDisposer {
    setReconnecting(value: boolean): void;
    setLabel(value: string): void;
}

/** Harness ConnectionBanner contract; the caller owns connection state. */
export function mountConnectionBanner(host: HTMLElement, props: ConnectionBannerProps, scope: UiScope): ConnectionBannerController {
    if (!host || !scope) throw new TypeError('ConnectionBanner requires a host and scope.');
    ensureStyles();
    const originalNodes = Array.from(host.childNodes); const originalClass = host.getAttribute('class');
    let reconnecting = props.reconnecting; let label = props.label ?? '连接已断开，正在重连…'; let banner: HTMLDivElement | null = null;
    const render = () => {
        if (!reconnecting) { banner?.remove(); banner = null; return; }
        if (!banner) { banner = document.createElement('div'); banner.className = 'vcp-harness-connection-banner banner'; banner.setAttribute('role', 'status'); banner.setAttribute('aria-live', 'polite'); host.replaceChildren(banner); }
        banner.textContent = label;
    };
    render();
    const dispose = scope.own(() => { banner = null; if (originalClass === null) host.removeAttribute('class'); else host.setAttribute('class', originalClass); host.replaceChildren(...originalNodes); }, 'harness-connection-banner', 'ui-primitive');
    return Object.assign(dispose, { setReconnecting(value: boolean) { reconnecting = value; render(); }, setLabel(value: string) { label = value; render(); } });
}
