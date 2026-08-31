import type { UiScope } from '../contracts.js';
import { mountMenu, type MenuController } from './menu.js';

const STYLE_ID = 'vcp-harness-uiux-agent-preset-seat';

function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-agent-preset-seat{display:inline-flex;align-items:center;gap:4px;max-width:min(100%,240px);min-height:28px;padding:0 8px;border:0;border-radius:16px;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}.vcp-agent-preset-seat:not(:disabled):hover,.vcp-agent-preset-seat[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-agent-preset-seat:disabled{cursor:default;color:var(--dsw-alias-label-quaternary)}.vcp-agent-preset-seat-icon{flex:none;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-agent-preset-seat-chevron{flex:none;color:var(--dsw-alias-label-caption,#adb2b8)}.vcp-agent-preset-seat-item{display:flex;flex-direction:column;gap:2px;max-width:280px}.vcp-agent-preset-seat-item-name{color:var(--dsw-alias-label-primary,#0f1115);font-size:13px;line-height:20px;text-align:left}.vcp-agent-preset-seat-item-desc{color:var(--dsw-alias-label-caption,#adb2b8);font-size:12px;line-height:16px;white-space:normal}`;
    (document.head || document.documentElement).append(style);
}

/* Glyphs mirror Harness ui-primitives/src/icons/index.tsx exactly
   (ic_ds_agent_preset_outline_16 and ic_ds_chevron_down_outline_14). */
const SEAT_ICON_PATHS = '<mask id="mask0_agent_preset_16" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16"><rect width="16" height="16" fill="white"/><circle cx="7.9995" cy="3.28319" r="1.712" fill="black"/><circle cx="3.51122" cy="11.3855" r="1.712" fill="black"/><circle cx="12.4878" cy="11.3855" r="1.712" fill="black"/></mask><path mask="url(#mask0_agent_preset_16)" d="M12.2881 11.0425C12.6002 11.3723 13.0413 11.5786 13.5312 11.5786L13.5342 11.5776C13.1476 12.3233 12.6119 12.9785 11.9639 13.5005C10.9327 14.3309 9.6199 14.8286 8.19336 14.8286C7.29864 14.8285 6.45056 14.6313 5.6875 14.2808C6.08309 14.0281 6.36707 13.6189 6.45215 13.1392C6.99022 13.3561 7.57767 13.476 8.19336 13.4761C9.30019 13.4761 10.3157 13.0915 11.1152 12.4478C11.5935 12.0626 11.9924 11.5848 12.2881 11.0425ZM4.14746 4.36475C4.25569 4.83228 4.55488 5.2247 4.95898 5.4585C4.07956 6.30639 3.53144 7.49605 3.53125 8.81396C3.53125 9.69534 3.77613 10.5202 4.20117 11.2231C3.74959 11.3817 3.38395 11.7232 3.19531 12.1597C2.5541 11.2032 2.17969 10.052 2.17969 8.81396C2.17989 7.05087 2.93868 5.4646 4.14746 4.36475ZM8.19336 2.80029C8.85717 2.80029 9.49784 2.90834 10.0967 3.10791C12.3237 3.85044 13.9725 5.86061 14.1846 8.28369C13.9832 8.20048 13.7627 8.15382 13.5312 8.15381C13.2802 8.15381 13.042 8.20907 12.8271 8.30615C12.6281 6.47264 11.3666 4.95616 9.66895 4.39014C9.2063 4.236 8.70989 4.15186 8.19336 4.15186C7.96112 4.15189 7.7329 4.16981 7.50977 4.20264C7.51947 4.12886 7.52637 4.05348 7.52637 3.97705C7.52628 3.56604 7.3811 3.18914 7.13965 2.89404C7.48183 2.83352 7.83381 2.80033 8.19336 2.80029Z" fill="currentColor"/><path d="M9.1123 3.28271C9.11205 2.66858 8.61322 2.17041 7.99902 2.17041C7.38504 2.17067 6.88697 2.66874 6.88672 3.28271C6.88672 3.89691 7.38489 4.39574 7.99902 4.396C8.61338 4.396 9.1123 3.89707 9.1123 3.28271ZM10.3115 3.28271C10.3115 4.55981 9.27612 5.59521 7.99902 5.59521C6.72214 5.59496 5.6875 4.55965 5.6875 3.28271C5.68776 2.00599 6.7223 0.971447 7.99902 0.971191C9.27596 0.971191 10.3113 2.00584 10.3115 3.28271ZM10.3115 3.28271C10.3115 4.55981 9.27612 5.59521 7.99902 5.59521C6.72214 5.59496 5.6875 4.55965 5.6875 3.28271C5.68776 2.00599 6.7223 0.971447 7.99902 0.971191C9.27596 0.971191 10.3113 2.00584 10.3115 3.28271Z" fill="currentColor"/><path d="M4.62402 11.385C4.62377 10.7709 4.12494 10.2727 3.51074 10.2727C2.89676 10.273 2.39869 10.771 2.39844 11.385C2.39844 11.9992 2.89661 12.498 3.51074 12.4983C4.1251 12.4983 4.62402 11.9994 4.62402 11.385ZM5.82324 11.385C5.82324 12.6621 4.78784 13.6975 3.51074 13.6975C2.23386 13.6973 1.19922 12.6619 1.19922 11.385C1.19947 10.1083 2.23402 9.07374 3.51074 9.07349C4.78768 9.07349 5.82299 10.1081 5.82324 11.385Z" fill="currentColor"/><path d="M13.6006 11.385C13.6003 10.7709 13.1015 10.2727 12.4873 10.2727C11.8733 10.273 11.3753 10.771 11.375 11.385C11.375 11.9992 11.8732 12.498 12.4873 12.4983C13.1017 12.4983 13.6006 11.9994 13.6006 11.385ZM14.7998 11.385C14.7998 12.6621 13.7644 13.6975 12.4873 13.6975C11.2104 13.6973 10.1758 12.6619 10.1758 11.385C10.176 10.1083 11.2106 9.07374 12.4873 9.07349C13.7642 9.07349 14.7995 10.1081 14.7998 11.385Z" fill="currentColor"/>';
const CHEVRON_ICON_PATH = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z';

export const AGENT_PRESET_SEAT_DEFAULT_HINT = 'Agent preset for the session you are about to start';
export const AGENT_PRESET_SEAT_NO_DESCRIPTION = 'No description';

/** One selectable preset, exactly the roster projection the seat consumes. */
export interface AgentPresetSeatOption {
    readonly id: string;
    readonly name?: string;
    readonly description?: string;
}

export interface AgentPresetSeatProps {
    readonly options: readonly AgentPresetSeatOption[];
    readonly selectedId?: string;
    readonly busy?: boolean;
    readonly error?: string | null;
    readonly hint?: string;
    readonly noDescriptionLabel?: string;
    readonly onSelect: (id: string) => void;
    readonly onClose?: () => void;
}

export interface AgentPresetSeatController {
    readonly root: HTMLSpanElement;
    readonly button: HTMLButtonElement;
    readonly menu: MenuController | null;
    readonly open: boolean;
    /** Display name of the staged preset, or '' when none is staged. */
    selectedLabel(): string;
    setOptions(options: readonly AgentPresetSeatOption[]): Promise<void>;
    setSelected(selectedId?: string): void;
    setBusy(busy: boolean): void;
    setError(error: string | null): void;
    setOpen(open: boolean): void;
    dispose(): void | Promise<void>;
}

/**
 * Candidate replication of the Harness hero chip: a seat button carrying the
 * staged preset over a body-portal Menu. Caller-owned open/busy/error state,
 * no durable business state.
 */
export function mountAgentPresetSeat(anchor: HTMLButtonElement, props: AgentPresetSeatProps, scope: UiScope): AgentPresetSeatController {
    if (!anchor || anchor.tagName !== 'BUTTON' || !props?.options || !props?.onSelect || !scope) {
        throw new TypeError('AgentPresetSeat requires a button anchor, options, onSelect and scope.');
    }
    ensureStyles();
    const seatScope = scope.child('harness-agent-preset-seat');
    const hint = props.hint ?? AGENT_PRESET_SEAT_DEFAULT_HINT;
    const noDescription = props.noDescriptionLabel ?? AGENT_PRESET_SEAT_NO_DESCRIPTION;

    const originalClassName = anchor.className;
    const originalType = anchor.getAttribute('type');
    const originalTitle = anchor.getAttribute('title');
    const originalDisabled = anchor.disabled;
    const originalChildren = Array.from(anchor.childNodes);

    anchor.type = 'button';
    anchor.classList.add('vcp-agent-preset-seat');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('width', '16');
    icon.setAttribute('height', '16');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('focusable', 'false');
    icon.setAttribute('aria-hidden', 'true');
    icon.classList.add('vcp-agent-preset-seat-icon');
    icon.innerHTML = SEAT_ICON_PATHS;
    const labelText = document.createTextNode('');
    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('width', '14');
    chevron.setAttribute('height', '14');
    chevron.setAttribute('viewBox', '0 0 14 14');
    chevron.setAttribute('fill', 'none');
    chevron.setAttribute('focusable', 'false');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.classList.add('vcp-agent-preset-seat-chevron');
    chevron.innerHTML = `<path d="${CHEVRON_ICON_PATH}" fill="currentColor"/>`;
    anchor.append(icon, labelText, chevron);

    let currentOptions = [...props.options];
    let selectedId = props.selectedId ?? '';
    let busy = Boolean(props.busy);
    let error = props.error ?? null;
    let menuController: MenuController | null = null;
    let rosterScope = scope.child('harness-agent-preset-seat-roster');

    const chosen = () => currentOptions.find(option => option.id === selectedId);
    const menuItems = () => currentOptions.map(option => {
        const item = document.createElement('span');
        item.className = 'vcp-agent-preset-seat-item';
        const name = document.createElement('span');
        name.className = 'vcp-agent-preset-seat-item-name';
        name.textContent = option.name ?? option.id;
        const desc = document.createElement('span');
        desc.className = 'vcp-agent-preset-seat-item-desc';
        desc.textContent = option.description ?? noDescription;
        item.append(name, desc);
        return { id: option.id, label: item };
    });
    const buildRoster = () => {
        menuController = mountMenu(anchor, {
            items: menuItems(),
            selectedId,
            align: 'start',
            portal: true,
            onSelect: id => {
                menuController?.setOpen(false);
                props.onSelect(id);
            },
            onClose: () => props.onClose?.(),
        }, rosterScope);
    };

    const sync = () => {
        anchor.disabled = busy;
        anchor.title = error ?? hint;
        labelText.textContent = chosen()?.name ?? selectedId;
        menuController?.setSelected(selectedId);
    };
    buildRoster();
    sync();

    const dispose = scope.own(async () => {
        await seatScope.dispose('harness-agent-preset-seat-unmounted');
        if (originalType === null) anchor.removeAttribute('type'); else anchor.setAttribute('type', originalType);
        if (originalTitle === null) anchor.removeAttribute('title'); else anchor.setAttribute('title', originalTitle);
        anchor.disabled = originalDisabled;
        anchor.className = originalClassName;
        anchor.replaceChildren(...originalChildren);
    }, 'harness-agent-preset-seat', 'ui-primitive');

    const controller: AgentPresetSeatController = {
        get root() { return anchor.closest('.vcp-harness-menu-root') as HTMLSpanElement ?? anchor; },
        button: anchor,
        get menu() { return menuController; },
        get open() { return menuController?.open ?? false; },
        selectedLabel() { return chosen()?.name ?? ''; },
        async setOptions(next) {
            currentOptions = [...next];
            if (selectedId && !currentOptions.some(option => option.id === selectedId)) selectedId = '';
            const nextRoster = scope.child('harness-agent-preset-seat-roster');
            await rosterScope.dispose('harness-agent-preset-seat-roster-rebuilt');
            rosterScope = nextRoster;
            menuController = null;
            buildRoster();
            sync();
        },
        setSelected(next) { selectedId = next ?? ''; sync(); },
        setBusy(next) { busy = Boolean(next); sync(); },
        setError(next) { error = next ?? null; sync(); },
        setOpen(value) { menuController?.setOpen(value); },
        dispose,
    };
    return controller;
}
