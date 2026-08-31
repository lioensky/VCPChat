import type { UiDisposer, UiScope } from '../contracts.js';

const STYLE_ID = 'vcp-harness-uiux-semantic-icon';

function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-icon-slot{display:inline-flex;align-items:center;justify-content:center;flex:none;width:var(--vcp-harness-icon-size,16px);height:var(--vcp-harness-icon-size,16px);color:currentColor;line-height:0}.vcp-harness-icon-slot>.vcp-ui-icon{width:100%;height:100%;color:currentColor}`;
    (document.head || document.documentElement).append(style);
}

export type HarnessSemanticIconName = 'warning' | 'close' | 'check' | 'chevron-down';

const VCP_NAMES: Readonly<Record<HarnessSemanticIconName, string>> = {
    warning: 'warning', close: 'close', check: 'check', 'chevron-down': 'chevron_down',
};

export interface SemanticIconProps {
    readonly name: HarnessSemanticIconName;
    readonly size?: 14 | 16 | 18;
}

export interface SemanticIconController {
    readonly root: HTMLSpanElement;
    readonly name: HarnessSemanticIconName;
    setName(name: HarnessSemanticIconName): void;
    setSize(size: 14 | 16 | 18): void;
    refresh(): void;
    dispose(): void | Promise<void>;
}

/** Private Candidate slot that delegates glyph rendering to the existing VCPIcons owner. */
export function mountSemanticIcon(host: HTMLElement, props: SemanticIconProps, scope: UiScope): SemanticIconController {
    if (!host || !props || !scope || !VCP_NAMES[props.name]) throw new TypeError('SemanticIcon requires a supported name, host and scope.');
    ensureStyles();
    const originalNodes = Array.from(host.childNodes);
    const originalClass = host.getAttribute('class');
    const root = document.createElement('span');
    root.className = 'vcp-harness-icon-slot';
    root.setAttribute('aria-hidden', 'true');
    let name = props.name;
    let size = props.size ?? 16;
    const createGlyph = () => {
        const glyph = document.createElement('span');
        glyph.className = 'vcp-ui-icon';
        glyph.setAttribute('aria-hidden', 'true');
        glyph.textContent = VCP_NAMES[name];
        return glyph;
    };
    const refresh = () => {
        const icons = (globalThis as typeof globalThis & { VCPIcons?: { refresh(root?: ParentNode): void; set(element: Element, name: string): Element | null } }).VCPIcons;
        icons?.refresh(root);
    };
    const render = () => {
        root.replaceChildren(createGlyph());
        root.style.setProperty('--vcp-harness-icon-size', `${size}px`);
        refresh();
    };
    host.replaceChildren(root);
    host.classList.add('vcp-harness-icon-host');
    render();
    const dispose = scope.own(() => {
        host.replaceChildren(...originalNodes);
        if (originalClass === null) host.removeAttribute('class'); else host.setAttribute('class', originalClass);
    }, 'harness-semantic-icon', 'ui-primitive');
    return {
        root,
        get name() { return name; },
        setName(value) { if (!VCP_NAMES[value]) throw new TypeError(`Unknown Harness semantic icon: ${value}`); name = value; render(); },
        setSize(value) { if (![14, 16, 18].includes(value)) throw new TypeError('SemanticIcon size must be 14, 16 or 18.'); size = value; render(); },
        refresh,
        dispose,
    };
}
