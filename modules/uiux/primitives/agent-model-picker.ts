import type { UiDisposer, UiScope } from '../contracts.js';
import { createPopupSelectController, mountPopupSelectView, type PopupSelectController } from './popup-select.js';
import { mountSemanticIcon } from './semantic-icon.js';
import { mountToast } from './toast.js';

const STYLE_ID = 'vcp-harness-uiux-agent-model-picker';
let pickerSequence = 0;
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-agent-model-picker{position:relative;min-width:0;display:inline-flex}.vcp-harness-agent-model-picker-trigger{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:220px;height:28px;padding:0 4px 0 8px;border:0;border-radius:24px;background:transparent;color:var(--dsw-alias-label-secondary,var(--vcp-color-text,#737780));font-family:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer}.vcp-harness-agent-model-picker-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-harness-agent-model-picker-trigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3,var(--vcp-color-brand,#1677ff))}.vcp-harness-agent-model-picker-trigger:disabled{color:var(--dsw-alias-label-dimmed,#a0a5ad);cursor:default}.vcp-harness-agent-model-picker-trigger-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vcp-harness-agent-model-picker-trigger-icon{flex:none;transition:transform 120ms ease}.vcp-harness-agent-model-picker-trigger[aria-expanded="true"] .vcp-harness-agent-model-picker-trigger-icon{transform:rotate(180deg)}.vcp-harness-agent-model-picker .vcp-harness-popup-select-card{right:0;left:auto;bottom:calc(100% + 8px);top:auto;width:min(240px,calc(100vw - 32px));max-width:min(240px,calc(100vw - 32px));box-sizing:border-box;max-height:min(360px,calc(100vh - 96px));border-radius:12px}.vcp-harness-agent-model-picker-cell{display:flex;align-items:center;gap:8px;width:100%;height:40px;padding:0 10px;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}.vcp-harness-agent-model-picker-cell:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-harness-agent-model-picker-cell-label{flex:1;min-width:0}.vcp-harness-agent-model-picker-cell-value{color:var(--dsw-alias-label-tertiary,#737780);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vcp-harness-agent-model-picker .vcp-harness-popup-select-row{min-height:38px;padding:6px 8px;border-radius:10px}.vcp-harness-agent-model-picker .vcp-harness-popup-select-row-disabled{color:var(--dsw-alias-label-dimmed,#a0a5ad);cursor:default}.vcp-harness-agent-model-picker .vcp-harness-popup-select-row-disabled:hover{background:transparent}.vcp-harness-agent-model-picker-directory-actions{display:flex;justify-content:flex-end;padding:2px 2px 4px}.vcp-harness-agent-model-picker-directory-actions[hidden]{display:none}.vcp-harness-agent-model-picker-directory-refresh{border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,var(--vcp-color-text,#737780));font:inherit;font-size:12px;line-height:18px;cursor:pointer}.vcp-harness-agent-model-picker-directory-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-harness-agent-model-picker-directory-refresh:disabled{cursor:default;opacity:.65}.vcp-harness-popup-select-favorite{flex:none;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#737780);font-size:16px;line-height:18px;cursor:pointer}.vcp-harness-popup-select-favorite[aria-pressed="true"]{color:var(--dsw-alias-state-warn-label,#c68610)}.vcp-harness-popup-select-favorite:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}`;
    (document.head || document.documentElement).append(style);
}

export interface AgentModelOption {
    readonly id: string;
    readonly label: string;
    readonly provider?: string;
    /** Optional presentation group (for example Hot/Favorites/All). */
    readonly group?: string;
    readonly favorite?: boolean;
    readonly active?: boolean;
    readonly disabled?: boolean;
}

export interface AgentModelEffortOption {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}

/**
 * Ephemeral model-directory operations injected by the real Settings Surface.
 * The primitive never imports chatAPI; the bridge remains the only boundary
 * that maps IPC results into presentation options.
 */
export interface AgentModelDirectoryCapability {
    refresh?(signal: AbortSignal): Promise<void>;
    toggleFavorite?(id: string, signal: AbortSignal): Promise<void>;
    subscribeUpdated?(listener: () => void): UiDisposer | void;
}

export interface AgentModelPickerProps {
    readonly label?: string;
    /** Harness ModelSelect disables the native trigger while its owner is locked. */
    readonly locked?: boolean;
    /** Reuse an existing surface trigger while keeping its identity intact. */
    readonly trigger?: HTMLButtonElement;
    readonly options: (signal: AbortSignal) => Promise<readonly AgentModelOption[]>;
    readonly directory?: AgentModelDirectoryCapability;
    /** `false` rejects the selection; Harness parity keeps the menu open and shows a Toast. */
    readonly onSelect: (option: AgentModelOption) => void | boolean | Promise<void | boolean>;
    readonly efforts?: readonly AgentModelEffortOption[];
    readonly onEffortSelect?: (option: AgentModelEffortOption) => void | Promise<void>;
    readonly selectedEffort?: string;
    readonly selectedId?: string;
    /** Keep the product extension searchable by default; disable for parity fixtures. */
    readonly searchEnabled?: boolean;
    /** Render explicit ordered groups for the production directory projection. */
    readonly grouped?: boolean;
    /** Opt into Harness provider-grouped menuitemradio DOM for equivalence fixtures. */
    readonly harnessEquivalent?: boolean;
    readonly open?: boolean;
}

export interface AgentModelPickerController {
    readonly root: HTMLSpanElement;
    readonly trigger: HTMLButtonElement;
    readonly popup: PopupSelectController;
    open(): void;
    close(): void;
    refresh(): void;
    setSelected(id: string | undefined): void;
    setPane(pane: 'root' | 'model' | 'effort'): void;
    dispose(): UiDisposer | Promise<void>;
}

/**
 * Candidate-only Agent model picker. It mirrors Harness model-selection
 * interaction while keeping model discovery and persistence injected.
 * `agentModel` remains a separate canonical native input in production.
 */
export function mountAgentModelPicker(host: HTMLElement, props: AgentModelPickerProps, scope: UiScope): AgentModelPickerController {
    if (!host || !props?.options || !props?.onSelect || !scope) throw new TypeError('AgentModelPicker requires host, options, onSelect and scope.');
    ensureStyles();
    const pickerScope = scope.child('harness-agent-model-picker');
    const root = document.createElement('span');
    root.className = 'vcp-harness-agent-model-picker';
    const trigger = props.trigger ?? document.createElement('button');
    const originalTriggerClass = trigger.getAttribute('class');
    const originalTriggerType = trigger.getAttribute('type');
    const originalTriggerDisabled = trigger.disabled;
    const originalTriggerAria = {
        haspopup: trigger.getAttribute('aria-haspopup'),
        expanded: trigger.getAttribute('aria-expanded'),
        label: trigger.getAttribute('aria-label'),
        controls: trigger.getAttribute('aria-controls'),
    };
    const originalTriggerMarkup = trigger.innerHTML;
    if (!props.trigger) trigger.type = 'button';
    trigger.classList.add('vcp-harness-agent-model-picker-trigger');
    trigger.replaceChildren();
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', props.label ?? 'Select model');
    if (props.locked === true) trigger.disabled = true;
    const triggerLabel = document.createElement('span');
    triggerLabel.className = 'vcp-harness-agent-model-picker-trigger-label';
    triggerLabel.textContent = 'Select model';
    trigger.append(triggerLabel);
    const triggerIcon = document.createElement('span');
    triggerIcon.className = 'vcp-harness-agent-model-picker-trigger-icon';
    mountSemanticIcon(triggerIcon, { name: 'chevron-down', size: 14 }, pickerScope);
    trigger.append(triggerIcon);
    if (!props.trigger) root.append(trigger);
    host.append(root);

    let selectedId = props.selectedId;
    let lastOptions: readonly AgentModelOption[] = [];
    let selectionFailure = false;
    let toastGeneration = 0;
    let activeToast: { readonly generation: number; readonly scope: UiScope } | null = null;
    const dismissActiveToast = (reason: string) => {
        toastGeneration += 1;
        const previous = activeToast;
        activeToast = null;
        if (previous) void previous.scope.dispose(reason);
    };
    const selectionErrorText = (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return `Model operation failed: ${message || 'selection was rejected'}`;
    };
    const directoryActionErrorText = (label: string, error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const action = label === 'favorite' ? 'update model favorite' : 'refresh model list';
        return `Could not ${action}: ${message || 'operation failed'}`;
    };
    const showOwnedToast = (text: string) => {
        if (!pickerScope.active) return;
        dismissActiveToast('agent-model-picker-selection-toast-replaced');
        const toastScope = pickerScope.child('harness-agent-model-picker-selection-toast');
        const generation = ++toastGeneration;
        const icon = document.createElement('span');
        mountSemanticIcon(icon, { name: 'warning', size: 16 }, toastScope);
        activeToast = { generation, scope: toastScope };
        try {
            mountToast({
                text,
                icon,
                anchor: trigger,
                onDone: () => {
                    if (activeToast?.generation !== generation) return;
                    activeToast = null;
                    void toastScope.dispose('agent-model-picker-selection-toast-expired');
                },
            }, toastScope);
        } catch (mountError) {
            if (activeToast?.generation === generation) activeToast = null;
            void toastScope.dispose('agent-model-picker-selection-toast-mount-failed');
            throw mountError;
        }
    };
    const loadOptions = async (signal: AbortSignal) => {
        const options = await props.options(signal);
        lastOptions = options;
        return options.map(option => ({
            id: option.id,
            label: option.label,
            detail: props.harnessEquivalent === true
                ? undefined
                : [option.provider, option.favorite ? 'Favorite' : undefined].filter(Boolean).join(' · ') || undefined,
            group: option.group ?? option.provider,
            favorite: option.favorite,
            active: option.active === true || option.id === selectedId,
            disabled: option.disabled === true,
        }));
    };
    let directoryActionGeneration = 0;
    let directoryBusy = false;
    let activeDirectoryAction: { readonly generation: number; readonly scope: UiScope } | null = null;
    let syncDirectoryActions = () => {};
    const cancelDirectoryAction = () => {
        directoryActionGeneration += 1;
        const previous = activeDirectoryAction;
        activeDirectoryAction = null;
        directoryBusy = false;
        syncDirectoryActions();
        if (previous) void previous.scope.dispose('agent-model-picker-directory-action-cancelled');
    };
    const runDirectoryAction = async (label: string, action: (signal: AbortSignal) => Promise<void>): Promise<boolean> => {
        const generation = ++directoryActionGeneration;
        const previous = activeDirectoryAction;
        activeDirectoryAction = null;
        directoryBusy = true;
        syncDirectoryActions();
        await previous?.scope.dispose('agent-model-picker-directory-action-replaced');
        if (!pickerScope.active || generation !== directoryActionGeneration) return false;
        const actionScope = pickerScope.child(`agent-model-picker-directory-${label}`);
        const abort = new AbortController();
        actionScope.own(() => abort.abort(), `agent-model-picker-directory-${label}-abort`, 'abort-controller');
        activeDirectoryAction = { generation, scope: actionScope };
        try {
            await action(abort.signal);
            return pickerScope.active && generation === directoryActionGeneration
                && activeDirectoryAction?.generation === generation && !abort.signal.aborted;
        } catch (error) {
            if (pickerScope.active && generation === directoryActionGeneration && !abort.signal.aborted) {
                console.warn(`[VCPUI AgentModelPicker] ${label} directory action failed:`, error);
                showOwnedToast(directoryActionErrorText(label, error));
            }
            return false;
        } finally {
            if (activeDirectoryAction?.generation === generation) {
                activeDirectoryAction = null;
                directoryBusy = false;
                syncDirectoryActions();
            }
            await actionScope.dispose(`agent-model-picker-directory-${label}-settled`);
        }
    };
    const popup = createPopupSelectController({
        options: (_context, signal) => loadOptions(signal),
        onSelect: async option => {
            const selected = lastOptions.find(candidate => candidate.id === option.id);
            if (!selected || selected.disabled) return;
            selectionFailure = false;
            try {
                const accepted = await props.onSelect(selected);
                if (accepted === false) throw new Error('selection was rejected');
                selectedId = selected.id;
                triggerLabel.textContent = selected.label;
            } catch (error) {
                selectionFailure = props.harnessEquivalent === true;
                if (props.harnessEquivalent === true) showOwnedToast(selectionErrorText(error));
                throw error;
            }
        },
        // Only Harness parity selection failures are consumed as a Toast;
        // catalog load failures still own the in-menu Retry strip.  The
        // boolean is set by the selected owner's command above, so neither
        // the DOM nor a second durable store becomes an error authority.
        onSelectError: () => selectionFailure,
    }, {
        consume: () => true,
        focusComposer: () => trigger.focus(),
    });
    let pane: 'root' | 'model' | 'effort' = 'root';
    let selectedEffort = props.selectedEffort;
    let paneCell: HTMLButtonElement | null = null;
    let cancelDeferredPlacement = () => {};
    pickerScope.own(() => cancelDeferredPlacement(), 'agent-model-picker-deferred-placement', 'animation-frame');
    const view = mountPopupSelectView(root, {
        popup,
        anchor: trigger,
        overlayAria: `${props.label ?? 'Model'} picker`,
        searchAria: 'Search models',
        searchEnabled: props.searchEnabled,
        grouped: props.harnessEquivalent === true || props.grouped === true,
        optionRole: props.harnessEquivalent === true ? 'menuitemradio' : 'option',
        onEscape: () => {
            if (pane === 'root') return false;
            pane = 'root';
            syncPane();
            // A pane transition hides the focused option tree. Move focus to
            // the now-visible root cell so the next Tab/Enter sequence starts
            // from the same native menuitem contract as Harness.
            paneCell?.focus();
            return true;
        },
        onFavoriteToggle: props.directory?.toggleFavorite ? option => {
            if (directoryBusy) return;
            const selected = lastOptions.find(candidate => candidate.id === option.id);
            if (!selected) return;
            void runDirectoryAction('favorite', signal => props.directory!.toggleFavorite!(selected.id, signal)).then(applied => {
                if (applied && popup.getSnapshot().open) popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker-favorite' } });
            });
        } : undefined,
    }, pickerScope);
    const menuId = `vcp-harness-agent-model-picker-menu-${++pickerSequence}`;
    view.card.id = menuId;
    trigger.setAttribute('aria-controls', menuId);
    paneCell = document.createElement('button');
    paneCell.type = 'button';
    paneCell.className = 'vcp-harness-agent-model-picker-cell';
    paneCell.setAttribute('role', 'menuitem');
    paneCell.innerHTML = '<span class="vcp-harness-agent-model-picker-cell-label">Model</span><span class="vcp-harness-agent-model-picker-cell-value"></span><span aria-hidden="true">›</span>';
    pickerScope.listen(paneCell, 'click', () => { pane = 'model'; syncPane(); });
    const effortCell = document.createElement('button');
    effortCell.type = 'button';
    effortCell.className = 'vcp-harness-agent-model-picker-cell';
    effortCell.setAttribute('role', 'menuitem');
    effortCell.innerHTML = '<span class="vcp-harness-agent-model-picker-cell-label">Effort</span><span class="vcp-harness-agent-model-picker-cell-value"></span><span aria-hidden="true">›</span>';
    pickerScope.listen(effortCell, 'click', () => { pane = 'effort'; syncPane(); });
    const effortList = document.createElement('div');
    effortList.className = 'vcp-harness-agent-model-picker-effort-list';
    effortList.setAttribute('role', 'group');
    const directoryActions = document.createElement('div');
    directoryActions.className = 'vcp-harness-agent-model-picker-directory-actions';
    const refreshDirectory = document.createElement('button');
    refreshDirectory.type = 'button';
    refreshDirectory.className = 'vcp-harness-agent-model-picker-directory-refresh';
    refreshDirectory.textContent = 'Refresh models';
    refreshDirectory.hidden = props.directory?.refresh === undefined;
    directoryActions.append(refreshDirectory);
    view.card.prepend(directoryActions);
    syncDirectoryActions = () => {
        const modelPane = popup.getSnapshot().open && pane === 'model';
        directoryActions.hidden = !modelPane || props.directory?.refresh === undefined;
        refreshDirectory.disabled = directoryBusy;
        refreshDirectory.textContent = directoryBusy ? 'Refreshing…' : 'Refresh models';
        view.card.dataset.directoryBusy = String(directoryBusy);
    };
    pickerScope.listen(refreshDirectory, 'click', () => {
        if (directoryBusy || props.directory?.refresh === undefined) return;
        void runDirectoryAction('refresh', signal => props.directory!.refresh!(signal)).then(applied => {
            if (applied && popup.getSnapshot().open) popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker-refresh-directory' } });
        });
    });
    view.card.prepend(effortCell, effortList);
    let effortSelectionGeneration = 0;
    const renderEfforts = () => {
        effortList.replaceChildren();
        for (const option of props.efforts ?? []) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'vcp-harness-agent-model-picker-option';
            row.setAttribute('role', 'menuitemradio');
            row.setAttribute('aria-checked', String(option.id === selectedEffort));
            const copy = document.createElement('span');
            copy.className = 'vcp-harness-agent-model-picker-option-copy';
            const label = document.createElement('span');
            label.className = 'vcp-harness-agent-model-picker-option-label';
            label.textContent = option.label;
            copy.append(label);
            if (option.description) {
                const description = document.createElement('span');
                description.className = 'vcp-harness-agent-model-picker-option-description';
                description.textContent = option.description;
                copy.append(description);
            }
            const check = document.createElement('span');
            check.setAttribute('aria-hidden', 'true');
            check.textContent = option.id === selectedEffort ? '✓' : '';
            row.append(copy, check);
            pickerScope.listen(row, 'click', async () => {
                const generation = ++effortSelectionGeneration;
                await props.onEffortSelect?.(option);
                if (!pickerScope.active || generation !== effortSelectionGeneration) return;
                selectedEffort = option.id;
                pane = 'root';
                syncPane();
            });
            effortList.append(row);
        }
    };
    view.card.prepend(paneCell);
    const invalidateEffortSelection = () => { effortSelectionGeneration += 1; };
    const placeExternalCard = () => {
        if (!props.trigger || !popup.getSnapshot().open || !view.card.getClientRects().length) return;
        const portal = document.body || document.documentElement;
        if (portal && view.card.parentElement !== portal) portal.append(view.card);
        const anchorRect = trigger.getBoundingClientRect();
        const cardRect = view.card.getBoundingClientRect();
        const margin = 8;
        // The Electron window chrome occupies the first ~40px of the
        // renderer surface at compact heights. Keep portal controls below it
        // so directory actions remain genuinely hittable, not merely inside
        // the viewport rectangle.
        const topSafeArea = 48;
        const maxLeft = Math.max(margin, window.innerWidth - cardRect.width - margin);
        const left = Math.min(maxLeft, Math.max(margin, anchorRect.right - cardRect.width));
        const above = anchorRect.top - cardRect.height - margin;
        const top = above >= margin ? above : Math.min(window.innerHeight - cardRect.height - margin, anchorRect.bottom + margin);
        view.card.style.position = 'fixed';
        view.card.style.left = `${left}px`;
        view.card.style.right = 'auto';
        view.card.style.top = `${Math.max(topSafeArea, top)}px`;
        view.card.style.bottom = 'auto';
    };
    const syncPane = () => {
        const open = popup.getSnapshot().open;
        const setVisibility = (element: HTMLElement, visible: boolean) => {
            element.hidden = !visible;
            element.style.display = visible ? '' : 'none';
        };
        paneCell.querySelector('.vcp-harness-agent-model-picker-cell-value')!.textContent = triggerLabel.textContent || 'Select model';
        setVisibility(paneCell, open && pane === 'root');
        setVisibility(effortCell, open && pane === 'root' && Boolean(props.efforts?.length));
        effortCell.querySelector('.vcp-harness-agent-model-picker-cell-value')!.textContent = selectedEffort ?? 'Provider default';
        setVisibility(effortList, open && pane === 'effort');
        setVisibility(view.search, pane === 'model' && props.searchEnabled !== false);
        const viewport = view.card.querySelector<HTMLElement>('.vcp-harness-popup-select-viewport');
        const status = view.card.querySelector<HTMLElement>('.vcp-harness-popup-select-status');
        const error = view.card.querySelector<HTMLElement>('.vcp-harness-popup-select-error');
        if (viewport) setVisibility(viewport, open && pane === 'model');
        if (status) {
            status.hidden = !(open && pane === 'model');
            status.style.display = open && pane === 'model' && status.textContent !== '' ? '' : 'none';
        }
        if (error) {
            error.hidden = !(open && pane === 'model');
            // PopupSelectView owns the error text.  DOM text can outlive a
            // successful retry, so it must never become an independent
            // visibility source here: only the controller snapshot decides
            // whether the in-menu load strip is visible.
            error.style.display = open && pane === 'model' && popup.getSnapshot().error !== null ? '' : 'none';
        }
        const filtering = popup.getSnapshot().search.trim() !== '';
        view.card.querySelectorAll<HTMLElement>('.vcp-harness-popup-select-group-title').forEach(title => {
            title.hidden = filtering;
            title.setAttribute('aria-hidden', String(filtering));
        });
        syncDirectoryActions();
        renderEfforts();
        placeExternalCard();
        // Pane content can grow from the short root menu to the directory
        // list after this synchronous pass. Re-measure on the next frame so
        // the body portal is not left under the application chrome at narrow
        // production Settings heights.
        // Electron uses two frames here because the body portal may grow
        // after the root pane switches to the directory.  JSDOM does not
        // expose a global requestAnimationFrame, so resolve it from the DOM
        // window and keep the fallback timer owned by this picker.
        cancelDeferredPlacement();
        const ownerWindow = typeof window === 'undefined' ? null : window;
        if (typeof ownerWindow?.requestAnimationFrame === 'function') {
            let firstFrame: number | null = ownerWindow.requestAnimationFrame(() => {
                firstFrame = null;
                const secondFrame = ownerWindow.requestAnimationFrame(() => {
                    if (pickerScope.active) placeExternalCard();
                });
                cancelDeferredPlacement = () => ownerWindow.cancelAnimationFrame(secondFrame);
            });
            cancelDeferredPlacement = () => {
                if (firstFrame !== null) ownerWindow.cancelAnimationFrame(firstFrame);
                firstFrame = null;
            };
        } else {
            const timer = setTimeout(() => { if (pickerScope.active) placeExternalCard(); }, 0);
            cancelDeferredPlacement = () => clearTimeout(timer);
        }
    };
    pickerScope.listen(trigger, 'click', event => {
        // Agent Settings already has a legacy listener on this canonical
        // button. Capture-phase interception keeps that behavior available
        // after disposal without proxying through a hidden control.
        event.stopImmediatePropagation();
        if (trigger.disabled) return;
        if (popup.getSnapshot().open) { invalidateEffortSelection(); popup.dismiss(); }
        else {
            invalidateEffortSelection();
            pane = 'root';
            popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker' } });
        }
    }, { capture: true });
    const syncTrigger = () => trigger.setAttribute('aria-expanded', String(popup.getSnapshot().open));
    let releaseDirectoryUpdates: UiDisposer | null = null;
    const syncDirectoryUpdates = () => {
        const shouldSubscribe = props.directory?.subscribeUpdated !== undefined && popup.getSnapshot().open;
        if (shouldSubscribe && releaseDirectoryUpdates === null) {
            const release = props.directory?.subscribeUpdated?.(() => {
                if (!pickerScope.active || !popup.getSnapshot().open) return;
                cancelDirectoryAction();
                popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker-models-updated' } });
            });
            if (release) releaseDirectoryUpdates = pickerScope.own(release, 'agent-model-picker-directory-updates', 'subscription');
        } else if (!shouldSubscribe && releaseDirectoryUpdates !== null) {
            const release = releaseDirectoryUpdates;
            releaseDirectoryUpdates = null;
            void release();
        }
    };
    const unsubscribe = popup.subscribe(() => {
        if (!popup.getSnapshot().open) {
            cancelDirectoryAction();
            // Directory-action feedback is popup-local rather than a global
            // notification queue: closing this surface also retracts it.
            dismissActiveToast('agent-model-picker-popup-closed');
        }
        syncDirectoryUpdates();
        syncTrigger();
        syncPane();
    });
    pickerScope.own(unsubscribe, 'agent-model-picker-subscription', 'ui-presentation');
    pickerScope.listen(window, 'resize', placeExternalCard);
    pickerScope.listen(document, 'scroll', placeExternalCard, { capture: true });
    if (typeof ResizeObserver !== 'undefined') {
        const cardResizeObserver = new ResizeObserver(() => {
            if (pickerScope.active) placeExternalCard();
        });
        cardResizeObserver.observe(view.card);
        pickerScope.own(() => cardResizeObserver.disconnect(), 'agent-model-picker-card-resize', 'observer');
    }
    if (props.open === true && !trigger.disabled) popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker' } });

    pickerScope.own(async () => {
        unsubscribe();
        popup.dispose();
        root.remove();
        trigger.replaceChildren();
        trigger.innerHTML = originalTriggerMarkup;
        if (originalTriggerClass === null) trigger.removeAttribute('class');
        else trigger.setAttribute('class', originalTriggerClass);
        if (originalTriggerType === null) trigger.removeAttribute('type');
        else trigger.setAttribute('type', originalTriggerType);
        trigger.disabled = originalTriggerDisabled;
        const restoreAttribute = (name: string, value: string | null) => {
            if (value === null) trigger.removeAttribute(name);
            else trigger.setAttribute(name, value);
        };
        restoreAttribute('aria-haspopup', originalTriggerAria.haspopup);
        restoreAttribute('aria-expanded', originalTriggerAria.expanded);
        restoreAttribute('aria-label', originalTriggerAria.label);
        restoreAttribute('aria-controls', originalTriggerAria.controls);
        dismissActiveToast('agent-model-picker-disposed');
        cancelDirectoryAction();
    }, 'agent-model-picker', 'ui-primitive');
    return {
        root,
        trigger,
        popup,
        open: () => {
            if (trigger.disabled) return;
            invalidateEffortSelection(); pane = 'root'; popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker' } });
        },
        // Closing from the trigger/picker surface must return focus to the
        // trigger, matching the Harness menu focus contract.
        close: () => { invalidateEffortSelection(); popup.dismiss({ focusComposer: true }); },
        refresh: () => {
            if (trigger.disabled) return;
            invalidateEffortSelection();
            if (popup.getSnapshot().open) popup.dismiss();
            pane = 'root'; popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker-refresh' } });
        },
        setSelected: id => {
            selectedId = id;
            const selected = lastOptions.find(option => option.id === id);
            if (selected) triggerLabel.textContent = selected.label;
        },
        setPane: next => { invalidateEffortSelection(); pane = next; syncPane(); },
        // Dispose the child scope itself so listeners, subscriptions, icon
        // owners and the popup binding all reach quiescence on surface swap.
        dispose: async () => { invalidateEffortSelection(); await pickerScope.dispose('agent-model-picker-disposed'); },
    };
}
