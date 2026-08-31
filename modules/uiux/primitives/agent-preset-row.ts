import type { UiScope } from '../contracts.js';
import { mountMenu, type MenuController } from './menu.js';

const STYLE_ID = 'vcp-harness-uiux-agent-preset-row';

function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-agent-preset-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.vcp-agent-preset-row-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:48px}.vcp-agent-preset-row-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-agent-preset-row-desc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary,#737780)}.vcp-agent-preset-selector{display:inline-flex;align-items:center;gap:12px;height:36px;padding:0 14px;border:0;border-radius:18px;background:var(--dsw-alias-bg-module-platform,rgb(245,246,247));font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#0f1115);cursor:pointer}.vcp-agent-preset-selector:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-agent-preset-selector:disabled{cursor:default}`;
    (document.head || document.documentElement).append(style);
}

/** One selectable preset; trust drives the PresetMenu label suffix. */
export interface AgentPresetRowOption {
    readonly id: string;
    readonly name?: string;
    readonly description?: string;
    readonly trust?: 'system' | 'user';
}

export interface AgentPresetRowProps {
    readonly options: readonly AgentPresetRowOption[];
    readonly currentValue?: string;
    /** Defaults mirror ui-agent-preset locales.ts en copy. */
    readonly title?: string;
    readonly descriptionLabel?: string;
    readonly loadingLabel?: string;
    readonly userTrustLabel?: string;
    readonly busy?: boolean;
    readonly writable?: boolean;
    readonly error?: string | null;
    readonly onSelect: (id: string) => void;
    readonly onClose?: () => void;
}

export interface AgentPresetRowController {
    readonly root: HTMLDivElement;
    readonly trigger: HTMLButtonElement;
    readonly menu: MenuController | null;
    readonly open: boolean;
    selectedLabel(): string;
    setOptions(options: readonly AgentPresetRowOption[]): Promise<void>;
    setCurrent(currentValue?: string): void;
    setBusy(busy: boolean): void;
    setWritable(writable: boolean): void;
    setError(error: string | null): void;
    setOpen(open: boolean): void;
    dispose(): void | Promise<void>;
}

export const AGENT_PRESET_ROW_DEFAULT_TITLE = 'Agent preset';
export const AGENT_PRESET_ROW_DEFAULT_DESCRIPTION = 'Applies to sessions you start from now on. Running sessions keep the preset they began with.';
export const AGENT_PRESET_ROW_LOADING_LABEL = 'Loading presets…';
export const AGENT_PRESET_ROW_USER_TRUST_LABEL = 'Custom';

/**
 * Candidate replication of the Harness settings preference row: title over
 * description plus the shared PresetMenu pill (36px, align-end portal,
 * `· <userTrust>` suffix for locally authored presets). Caller-owned
 * snapshot projection; no durable business state.
 */
export function mountAgentPresetRow(host: HTMLElement, props: AgentPresetRowProps, scope: UiScope): AgentPresetRowController {
    if (!host || !props?.options || !props?.onSelect || !scope) {
        throw new TypeError('AgentPresetRow requires a host, options, onSelect and scope.');
    }
    ensureStyles();
    const rowScope = scope.child('harness-agent-preset-row');
    const titleText = props.title ?? AGENT_PRESET_ROW_DEFAULT_TITLE;
    const descriptionLabel = props.descriptionLabel ?? AGENT_PRESET_ROW_DEFAULT_DESCRIPTION;
    const loadingLabel = props.loadingLabel ?? AGENT_PRESET_ROW_LOADING_LABEL;
    const userTrustLabel = props.userTrustLabel ?? AGENT_PRESET_ROW_USER_TRUST_LABEL;

    const originalChildren = Array.from(host.childNodes);
    const row = document.createElement('div');
    row.className = 'vcp-agent-preset-row';
    const rowText = document.createElement('div');
    rowText.className = 'vcp-agent-preset-row-text';
    const titleNode = document.createElement('div');
    titleNode.className = 'vcp-agent-preset-row-title';
    titleNode.textContent = titleText;
    const descNode = document.createElement('div');
    descNode.className = 'vcp-agent-preset-row-desc';
    rowText.append(titleNode, descNode);
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'vcp-agent-preset-selector';
    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('width', '14');
    chevron.setAttribute('height', '14');
    chevron.setAttribute('viewBox', '0 0 14 14');
    chevron.setAttribute('fill', 'none');
    chevron.setAttribute('focusable', 'false');
    chevron.setAttribute('aria-hidden', 'true');
    // ic_ds_chevron_down_outline_14 (ui-primitives/src/icons/index.tsx).
    chevron.innerHTML = '<path d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z" fill="currentColor"/>';
    chevron.classList.add('vcp-agent-preset-row-chevron');
    const labelText = document.createTextNode('');
    trigger.append(labelText, chevron);
    row.append(rowText, trigger);
    host.append(row);

    let currentOptions = [...props.options];
    let currentValue = props.currentValue ?? '';
    let busy = Boolean(props.busy);
    let writable = props.writable ?? true;
    let error = props.error ?? null;
    let menuController: MenuController | null = null;
    let rosterScope = scope.child('harness-agent-preset-row-roster');

    const displayOf = (option: AgentPresetRowOption) => option.name ?? option.id;
    const itemLabels = () => currentOptions.map(option => (
        option.trust === 'user' ? `${displayOf(option)} · ${userTrustLabel}` : displayOf(option)
    ));
    const buildRoster = () => {
        menuController = mountMenu(trigger, {
            items: itemLabels().map((label, index) => ({ id: currentOptions[index].id, label })),
            selectedId: currentValue,
            align: 'end',
            portal: true,
            onSelect: id => {
                menuController?.setOpen(false);
                props.onSelect(id);
            },
            onClose: () => props.onClose?.(),
        }, rosterScope);
    };

    const sync = () => {
        // Harness: the id is addressing, not a label; an empty value means the
        // roster is still loading and surfaces the loading copy instead.
        const chosen = currentOptions.find(option => option.id === currentValue);
        labelText.textContent = currentValue === '' ? loadingLabel : (chosen?.name ?? currentValue);
        descNode.textContent = error ?? descriptionLabel;
        if (error === null) descNode.removeAttribute('role'); else descNode.setAttribute('role', 'alert');
        trigger.disabled = busy || !writable || currentOptions.length === 0;
        trigger.setAttribute('aria-haspopup', 'menu');
        menuController?.setSelected(currentValue);
    };
    buildRoster();
    sync();

    rowScope.listen(trigger, 'click', () => menuController?.setOpen(!menuController.open));
    const dispose = scope.own(async () => {
        await rowScope.dispose('harness-agent-preset-row-unmounted');
        row.remove();
        host.replaceChildren(...originalChildren);
    }, 'harness-agent-preset-row', 'ui-primitive');

    const controller: AgentPresetRowController = {
        root: row,
        trigger,
        get menu() { return menuController; },
        get open() { return menuController?.open ?? false; },
        selectedLabel() {
            const chosen = currentOptions.find(option => option.id === currentValue);
            return currentValue === '' ? '' : (chosen?.name ?? currentValue);
        },
        async setOptions(next) {
            currentOptions = [...next];
            await rosterScope.dispose('harness-agent-preset-row-roster-rebuilt');
            rosterScope = scope.child('harness-agent-preset-row-roster');
            menuController = null;
            buildRoster();
            sync();
        },
        setCurrent(next) { currentValue = next ?? ''; sync(); },
        setBusy(next) { busy = Boolean(next); sync(); },
        setWritable(next) { writable = next !== false; sync(); },
        setError(next) { error = next ?? null; sync(); },
        setOpen(value) { menuController?.setOpen(value); },
        dispose,
    };
    return controller;
}
