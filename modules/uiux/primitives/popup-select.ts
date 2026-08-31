import type { UiScope } from '../contracts.js';
import { mountRiskConfirmation } from './risk-confirmation.js';
import { mountSemanticIcon } from './semantic-icon.js';

const STYLE_ID = 'vcp-harness-uiux-popup-select';

/**
 * ModelSelect renders its selected marker as a 16px inline SVG, not through
 * the generic icon host. Keep this exact light-DOM shape limited to the
 * grouped menuitemradio parity contract; ordinary VCP PopupSelect rows still
 * use the shared semantic icon primitive.
 *
 * Source: packages/client/ui-model-selection/src/client/ModelSelect.tsx
 * (`IconCheckOutline16` inside `.check`).
 */
function mountHarnessModelSelectCheck(host: HTMLElement) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z');
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
    host.append(svg);
}

function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-popup-select-card{position:absolute;bottom:calc(100% + 4px);left:0;z-index:100;display:flex;flex-direction:column;padding:4px;min-width:min(220px,100%);max-width:100%;max-height:320px;overflow:hidden;border:1px solid var(--dsw-alias-border-inverted,transparent);border-radius:12px;background:var(--dsw-specific-menu,#fff);box-shadow:var(--dsw-shadow-lv3,0 0 1px rgba(0,0,0,.2),0 0 4px rgba(0,0,0,.02),0 12px 32px rgba(0,0,0,.08));outline:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif}.vcp-harness-popup-select-viewport{display:flex;flex-direction:column;min-height:0;overflow-y:auto}.vcp-harness-popup-select-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:0;border-radius:8px;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary,#0f1115);background:transparent;text-align:left}.vcp-harness-popup-select-row-active{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-harness-popup-select-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vcp-harness-popup-select-detail{font-size:12px;color:var(--dsw-alias-label-tertiary,#737780);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vcp-harness-popup-select-check{display:inline-flex;flex:none;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-harness-popup-select-group{display:flex;flex-direction:column}.vcp-harness-popup-select-group-title{padding:5px 8px 3px;color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;line-height:18px;font-weight:500}.vcp-harness-popup-select-option{display:flex;align-items:center;gap:8px;width:100%;min-height:38px;padding:6px 8px;border:0;border-radius:10px;outline:none;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}.vcp-harness-popup-select-option:hover:not(:disabled),.vcp-harness-popup-select-option:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-harness-popup-select-option-copy{display:flex;flex:1;min-width:0;flex-direction:column;gap:0}.vcp-harness-popup-select-option-label{overflow:hidden;color:inherit;font-size:14px;font-weight:500;line-height:20px;text-overflow:ellipsis;white-space:nowrap}.vcp-harness-popup-select-option-detail{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#737780);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vcp-harness-popup-select-option-check{display:inline-flex;flex:0 0 18px;align-items:center;justify-content:center;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-harness-popup-select-option:disabled{color:var(--dsw-alias-label-dimmed,#a0a5ad);cursor:default}.vcp-harness-popup-select-status{padding:8px 10px;font-size:13px;color:var(--dsw-alias-label-tertiary,#737780)}.vcp-harness-popup-select-search{margin:2px 2px 4px;padding:6px 8px;border:1px solid var(--dsw-alias-border-inverted,transparent);border-radius:8px;background:transparent;font-size:13px;color:var(--dsw-alias-label-primary,#0f1115);outline:none}.vcp-harness-popup-select-error{display:flex;align-items:center;gap:8px;padding:6px 8px;font-size:12px;color:var(--dsw-alias-state-error-primary,#d92d20)}.vcp-harness-popup-select-error-text{flex:1;overflow:hidden;text-overflow:ellipsis}.vcp-harness-popup-select-retry{padding:2px 8px;border:1px solid var(--dsw-alias-border-inverted,transparent);border-radius:6px;background:transparent;font-size:12px;color:var(--dsw-alias-label-primary,#0f1115);cursor:pointer}`;
    // Keep grouped parity geometry aligned with Harness and prevent a
    // horizontal scrollbar from consuming an extra 8px of menu height.
    style.textContent += '.vcp-harness-popup-select-viewport{overflow-x:hidden}.vcp-harness-popup-select-group+.vcp-harness-popup-select-group{margin-top:4px}.vcp-harness-popup-select-option-label{font-size:14px;line-height:20px;font-weight:500}.vcp-harness-popup-select-option-check{display:grid;place-items:center;flex:0 0 18px}.vcp-harness-popup-select-card[data-harness-equivalent="true"] .vcp-harness-popup-select-group-title{color:#81858c}.vcp-harness-popup-select-action-row{position:relative;display:flex;align-items:center;width:100%}.vcp-harness-popup-select-action-row .vcp-harness-popup-select-option{padding-right:52px}.vcp-harness-popup-select-action-row .vcp-harness-popup-select-favorite{position:absolute;right:30px;top:50%;transform:translateY(-50%)}';
    (document.head || document.documentElement).append(style);
}

/** Copy for an option that must be acknowledged before onSelect can run. */
export interface PopupSelectConfirmation {
    readonly title: string;
    readonly description: string;
    readonly acknowledgeLabel: string;
    readonly cancelLabel: string;
    readonly confirmLabel: string;
}

/** One option row of a popupSelect shell. */
export interface PopupSelectOption {
    readonly id: string;
    readonly label: string;
    readonly detail?: string;
    readonly active?: boolean;
    readonly disabled?: boolean;
    readonly group?: string;
    /** Optional row-level favorite state. Its action is injected by the owning surface. */
    readonly favorite?: boolean;
    readonly confirmation?: PopupSelectConfirmation;
}

/** Command token segment snapshotted at shell-open time (popup.ts contract). */
export type PopupTokenSegment =
    | { readonly via: 'menu'; readonly span: unknown }
    | { readonly via: 'enter'; readonly token: string };

/** Headless shell state; closed renders null (view detaches the card). */
export interface PopupSelectSnapshot {
    readonly open: boolean;
    readonly command: string | null;
    readonly status: 'pending' | 'ready' | 'failed';
    readonly options: readonly PopupSelectOption[];
    readonly search: string;
    readonly active: number;
    readonly submitting: boolean;
    readonly confirming: PopupSelectOption | null;
    readonly acknowledged: boolean;
    readonly error: string | null;
}

export interface PopupSelectSpec {
    /** Load the option rows once per open (retry reuses the same signal). */
    readonly options: (context: unknown, signal: AbortSignal) => Promise<readonly PopupSelectOption[]>;
    /** Settle the picked option against the open-time context. */
    readonly onSelect: (option: PopupSelectOption, context: unknown) => void | Promise<void>;
    /**
     * An owner may consume a rejected selection outside the menu (for
     * example, ModelSelect's transient Toast).  Returning true keeps the
     * shell ready/open without converting a selection failure into the
     * catalog-load Retry strip.
     */
    readonly onSelectError?: (error: unknown, option: PopupSelectOption, context: unknown) => boolean;
}

/** Injected session-wiring callbacks (token consumption + composer focus). */
export interface PopupSelectDeps {
    /** Consume the open-time token segment after a successful onSelect; false is benign. */
    readonly consume: (segment: PopupTokenSegment) => boolean;
    /** Return focus to the composer (successful settle and Escape paths). */
    readonly focusComposer: () => void;
}

const POPUP_CLOSED: PopupSelectSnapshot = {
    open: false, command: null, status: 'pending', options: [], search: '', active: 0,
    submitting: false, confirming: null, acknowledged: false, error: null,
};

/**
 * Filter option rows case-insensitively over label and detail (blank search keeps every row).
 * Replicates ui-commands/src/client/popup.ts filterOptions.
 */
export function filterOptions(options: readonly PopupSelectOption[], search: string): readonly PopupSelectOption[] {
    const query = search.trim().toLowerCase();
    if (query === '') return options;
    return options.filter(option => option.label.toLowerCase().includes(query)
        || (option.detail?.toLowerCase().includes(query) ?? false));
}

export interface PopupSelectController {
    getSnapshot(): PopupSelectSnapshot;
    subscribe(listener: () => void): () => void;
    open(command: string, context: unknown, segment: PopupTokenSegment): void;
    retry(): void;
    setSearch(search: string): void;
    move(direction: 1 | -1): void;
    highlight(index: number): void;
    select(index: number): Promise<void>;
    acknowledge(acknowledged: boolean): void;
    cancelConfirmation(): void;
    confirm(): Promise<void>;
    dismiss(options?: { readonly focusComposer?: boolean }): void;
    dispose(): void;
}

interface OpenBinding {
    readonly command: string;
    readonly context: unknown;
    readonly segment: PopupTokenSegment;
    readonly abort: AbortController;
}

/**
 * Headless popupSelect controller replicating ui-commands PopupSelectController:
 * one options load per open, local filtering, single-flight settlement, risk
 * gate before onSelect, late settlements lose write rights through binding
 * identity (dismiss/dispose/reopen swap the binding and abort the fetch).
 */
export function createPopupSelectController(spec: PopupSelectSpec, deps: PopupSelectDeps): PopupSelectController {
    if (!spec?.options || !spec?.onSelect || !deps?.consume || !deps?.focusComposer) {
        throw new TypeError('PopupSelect requires options/onSelect spec and consume/focusComposer deps.');
    }
    const listeners = new Set<() => void>();
    let snapshot: PopupSelectSnapshot = POPUP_CLOSED;
    let binding: OpenBinding | null = null;

    const emit = () => listeners.forEach(listener => listener());
    const set = (next: Partial<PopupSelectSnapshot>) => {
        snapshot = { ...snapshot, ...next };
        emit();
    };
    const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

    const runLoad = (current: OpenBinding) => {
        spec.options(current.context, current.abort.signal).then(
            options => {
                if (binding !== current) return;
                set({ status: 'ready', options, active: 0, error: null });
            },
            (error: unknown) => {
                if (binding !== current) return;
                this_void_guard(error);
                set({ status: 'failed', options: [], active: 0, error: errorText(error) });
            },
        );
    };
    // The controller never throws from a failed fetch — mirror the source's
    // console.error line verbatim shape without pulling logging config in.
    const this_void_guard = (error: unknown) => { void error; };

    const settle = async (current: OpenBinding, option: PopupSelectOption) => {
        const s = snapshot;
        if (binding !== current || !s.open || s.submitting) return;
        set({ submitting: true, confirming: null, acknowledged: false, error: null });
        try {
            await spec.onSelect(option, current.context);
        } catch (error) {
            if (binding !== current) return;
            const handled = spec.onSelectError?.(error, option, current.context) === true;
            set({ submitting: false, error: handled ? null : errorText(error) });
            return;
        }
        if (binding !== current) return;
        deps.consume(current.segment);
        current.abort.abort();
        binding = null;
        snapshot = POPUP_CLOSED;
        emit();
        deps.focusComposer();
    };

    return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        open(command, context, segment) {
            binding?.abort.abort();
            const current: OpenBinding = {
                command, context, segment, abort: new AbortController(),
            };
            binding = current;
            snapshot = { ...POPUP_CLOSED, open: true, command };
            emit();
            runLoad(current);
        },
        retry() {
            const s = snapshot;
            if (binding === null || !s.open || s.status !== 'failed') return;
            set({ status: 'pending', error: null });
            runLoad(binding);
        },
        setSearch(search) {
            const s = snapshot;
            if (!s.open || s.submitting || s.confirming !== null || search === s.search) return;
            set({ search, active: 0 });
        },
        move(direction) {
            const s = snapshot;
            if (!s.open || s.status !== 'ready' || s.submitting || s.confirming !== null) return;
            const rows = filterOptions(s.options, s.search);
            if (rows.length === 0) return;
            for (let offset = 1; offset <= rows.length; offset += 1) {
                const active = (s.active + direction * offset + rows.length) % rows.length;
                if (rows[active]?.disabled !== true) { set({ active }); return; }
            }
        },
        highlight(index) {
            const s = snapshot;
            if (!s.open || s.status !== 'ready' || s.submitting || s.confirming !== null) return;
            if (index < 0 || index >= filterOptions(s.options, s.search).length || index === s.active) return;
            set({ active: index });
        },
        async select(index) {
            const s = snapshot;
            if (binding === null || !s.open || s.status !== 'ready' || s.submitting || s.confirming !== null) return;
            const option = filterOptions(s.options, s.search)[index];
            if (option === undefined) return;
            if (option.disabled === true) return;
            if (option.confirmation !== undefined) {
                set({ confirming: option, acknowledged: false, error: null });
                return;
            }
            await settle(binding, option);
        },
        acknowledge(acknowledged) {
            const s = snapshot;
            if (!s.open || s.submitting || s.confirming === null || s.acknowledged === acknowledged) return;
            set({ acknowledged });
        },
        cancelConfirmation() {
            const s = snapshot;
            if (!s.open || s.submitting || s.confirming === null) return;
            set({ confirming: null, acknowledged: false });
        },
        async confirm() {
            const s = snapshot;
            if (binding === null || !s.open || s.submitting || s.confirming === null || !s.acknowledged) return;
            await settle(binding, s.confirming);
        },
        dismiss(options) {
            if (binding === null) return;
            binding.abort.abort();
            binding = null;
            snapshot = POPUP_CLOSED;
            emit();
            if (options?.focusComposer === true) deps.focusComposer();
        },
        dispose() {
            binding?.abort.abort();
            binding = null;
            snapshot = POPUP_CLOSED;
            emit();
        },
    };
}

export interface PopupSelectViewProps {
    readonly popup: PopupSelectController;
    /** Optional trigger/anchor that is part of the owning surface. */
    readonly anchor?: HTMLElement;
    /* Locale seat defaults mirror ui-commands/src/client/locales.ts en. */
    readonly searchPlaceholder?: string;
    readonly searchAria?: string;
    /** Render the filter control; false is used by ModelSelect-equivalent menus. */
    readonly searchEnabled?: boolean;
    /** Render provider groups and Harness menuitemradio buttons when enabled. */
    readonly grouped?: boolean;
    readonly optionRole?: 'option' | 'menuitemradio';
    readonly retryLabel?: string;
    readonly statusLoading?: string;
    readonly statusApplying?: string;
    readonly statusEmpty?: string;
    /** '{command}' substitutes the open command name. */
    readonly overlayAria?: string;
    readonly listboxAria?: string;
    /** Return true when the owner consumed Escape without dismissing. */
    readonly onEscape?: () => boolean;
    /** Optional row action; used by the Agent model directory's favorite mutation. */
    readonly onFavoriteToggle?: (option: PopupSelectOption) => void;
}

export interface PopupSelectViewController {
    readonly card: HTMLDivElement;
    readonly search: HTMLInputElement;
    sync(): void;
    dispose(): void | Promise<void>;
}

/**
 * Candidate replication of ui-commands PopupSelectView: an absolutely
 * positioned card (the host is the conversation.input.overlay anchor strip),
 * holding focus in its search input while open. Caller owns placement.
 */
export function mountPopupSelectView(host: HTMLElement, props: PopupSelectViewProps, scope: UiScope): PopupSelectViewController {
    if (!host || !props?.popup || !scope) throw new TypeError('PopupSelectView requires a host, popup controller and scope.');
    ensureStyles();
    const popup = props.popup;
    const viewScope = scope.child('harness-popup-select-view');
    const labels = {
        searchPlaceholder: props.searchPlaceholder ?? 'Search…',
        searchAria: props.searchAria ?? 'Filter options',
        retry: props.retryLabel ?? 'Retry',
        loading: props.statusLoading ?? 'Loading options…',
        applying: props.statusApplying ?? 'Applying…',
        empty: props.statusEmpty ?? 'No options',
        overlayAria: props.overlayAria ?? '/{command} options',
        listboxAria: props.listboxAria ?? '/{command} matches',
    };
    const searchEnabled = props.searchEnabled !== false;
    const grouped = props.grouped === true;
    const optionRole = props.optionRole ?? 'option';
    const template = (pattern: string, command: string) => pattern.replace('{command}', String(command));

    const card = document.createElement('div');
    card.className = 'vcp-harness-popup-select-card';
    if (grouped) {
        card.style.boxSizing = 'content-box';
        card.dataset.harnessEquivalent = 'true';
    }
    card.setAttribute('role', 'menu');
    card.tabIndex = -1;
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'vcp-harness-popup-select-search';
    search.placeholder = labels.searchPlaceholder;
    search.setAttribute('aria-label', labels.searchAria);
    search.hidden = !searchEnabled;
    const error = document.createElement('div');
    error.className = 'vcp-harness-popup-select-error';
    error.setAttribute('role', 'alert');
    const errorTextSpan = document.createElement('span');
    errorTextSpan.className = 'vcp-harness-popup-select-error-text';
    const retryButton = document.createElement('button');
    retryButton.type = 'button';
    retryButton.className = 'vcp-harness-popup-select-retry';
    retryButton.textContent = labels.retry;
    error.append(errorTextSpan, retryButton);
    const status = document.createElement('div');
    status.className = 'vcp-harness-popup-select-status';
    const listbox = document.createElement('div');
    if (optionRole === 'option') listbox.setAttribute('role', 'listbox');
    listbox.className = 'vcp-harness-popup-select-viewport';
    card.append(search, error, status, listbox);
    card.remove(); // Closed renders null until the first open snapshot lands.

    let lastOpen = false;
    let riskScope: UiScope | null = null;
    let rowsScope: UiScope | null = null;
    let focusActiveOption = false;

    const moveAndFocus = (direction: 1 | -1) => {
        const before = popup.getSnapshot().active;
        focusActiveOption = optionRole === 'menuitemradio';
        popup.move(direction);
        if (popup.getSnapshot().active === before) focusActiveOption = false;
    };

    viewScope.listen(card, 'keydown', event => {
        const s = popup.getSnapshot();
        switch ((event as KeyboardEvent).key) {
            case 'ArrowDown': event.preventDefault(); moveAndFocus(1); return;
            case 'ArrowUp': event.preventDefault(); moveAndFocus(-1); return;
            case 'Enter': {
                // The ModelPicker root owns real native menuitem buttons
                // (Model / Effort) inside this generic card.  Let their
                // browser activation reach the owner click listener instead
                // of treating Enter as an option-row selection.  Actual
                // PopupSelect options are never `role=menuitem`, so their
                // select/submit contract remains owned here.
                const target = event.target as HTMLButtonElement | null;
                if (target?.tagName === 'BUTTON'
                    && target.getAttribute('role') === 'menuitem'
                    && !target.disabled) return;
                event.preventDefault();
                void popup.select(s.active);
                return;
            }
            case 'Escape':
                event.preventDefault();
                if (props.onEscape?.() === true) return;
                popup.dismiss({ focusComposer: true });
                return;
            default: return; // ArrowLeft/Right fall through: native caret movement.
        }
    });
    viewScope.listen(search, 'input', () => popup.setSearch((search as HTMLInputElement).value));
    viewScope.listen(retryButton, 'click', () => popup.retry());
    viewScope.listen(document, 'pointerdown', event => {
        const s = popup.getSnapshot();
        if (!s.open || s.confirming !== null) return;
        const target = event.target as Node | null;
        if (!(target instanceof Node)) return;
        if (card.contains(target) || props.anchor?.contains(target)) return;
        popup.dismiss();
    }, { capture: true });

    const renderRows = (s: PopupSelectSnapshot) => {
        const previousRowsScope = rowsScope;
        const nextRowsScope = viewScope.child('harness-popup-select-rows');
        rowsScope = nextRowsScope;
        void previousRowsScope?.dispose('harness-popup-select-rows-rebuilt');
        listbox.replaceChildren();
        if (s.status !== 'ready') return;
        if (optionRole === 'option') listbox.setAttribute('aria-label', template(labels.listboxAria, s.command ?? ''));
        else listbox.removeAttribute('aria-label');
        const rows = filterOptions(s.options, s.search);
        const renderOption = (option: PopupSelectOption, index: number) => {
            const row = document.createElement(optionRole === 'menuitemradio' ? 'button' : 'div');
            row.dataset.optionId = option.id;
            const disabled = option.disabled === true || s.submitting;
            if (row.tagName === 'BUTTON') {
                const button = row as HTMLButtonElement;
                button.type = 'button';
                button.disabled = disabled;
            }
            row.setAttribute('role', optionRole);
            row.setAttribute('aria-disabled', String(disabled));
            if (optionRole === 'menuitemradio') row.setAttribute('aria-checked', String(option.active === true));
            else row.setAttribute('aria-selected', String(index === s.active));
            row.className = optionRole === 'menuitemradio'
                ? 'vcp-harness-popup-select-option'
                : (index === s.active
                    ? 'vcp-harness-popup-select-row vcp-harness-popup-select-row-active'
                    : 'vcp-harness-popup-select-row');
            if (disabled) row.classList.add(optionRole === 'menuitemradio' ? 'vcp-harness-popup-select-option-disabled' : 'vcp-harness-popup-select-row-disabled');
            const copy = document.createElement('span');
            copy.className = optionRole === 'menuitemradio' ? 'vcp-harness-popup-select-option-copy' : 'vcp-harness-popup-select-label';
            const labelNode = document.createElement('span');
            labelNode.className = optionRole === 'menuitemradio' ? 'vcp-harness-popup-select-option-label' : '';
            labelNode.textContent = option.label;
            copy.append(labelNode);
            if (option.detail !== undefined) {
                const detail = document.createElement('span');
                detail.className = optionRole === 'menuitemradio' ? 'vcp-harness-popup-select-option-detail' : 'vcp-harness-popup-select-detail';
                detail.textContent = option.detail;
                copy.append(detail);
            }
            row.append(copy);
            // Harness ModelSelect keeps the trailing `.check` slot on every
            // menuitemradio. The selected row fills it with IconCheckOutline16;
            // unselected rows retain the same 18px flex reservation.
            if (option.active === true || (grouped && optionRole === 'menuitemradio')) {
                const check = document.createElement('span');
                check.className = optionRole === 'menuitemradio' ? 'vcp-harness-popup-select-option-check' : 'vcp-harness-popup-select-check';
                check.setAttribute('aria-hidden', 'true');
                if (option.active === true && grouped && optionRole === 'menuitemradio') {
                    mountHarnessModelSelectCheck(check);
                } else if (option.active === true) {
                    mountSemanticIcon(check, { name: 'check', size: 16 }, nextRowsScope.child('harness-popup-select-check'));
                }
                row.append(check);
            }
            if (props.onFavoriteToggle !== undefined && option.favorite !== undefined) {
                const favorite = document.createElement('button');
                favorite.type = 'button';
                favorite.className = 'vcp-harness-popup-select-favorite';
                favorite.dataset.optionAction = 'favorite';
                favorite.setAttribute('aria-label', option.favorite ? `Remove ${option.label} from favorites` : `Add ${option.label} to favorites`);
                favorite.setAttribute('aria-pressed', String(option.favorite));
                favorite.textContent = option.favorite ? '★' : '☆';
                favorite.disabled = disabled;
                nextRowsScope.listen(favorite, 'click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!disabled) props.onFavoriteToggle?.(option);
                });
                // A favorite is an injected VCP extension, not part of the
                // Harness row contract. Keep it adjacent to the native model
                // button rather than nesting a <button> in a <button>, which
                // is invalid HTML and breaks keyboard/AT semantics.
                const actionRow = document.createElement('div');
                actionRow.className = 'vcp-harness-popup-select-action-row';
                nextRowsScope.listen(row, 'click', () => { if (!disabled) void popup.select(index); });
                nextRowsScope.listen(row, 'mouseenter', () => { if (!disabled) popup.highlight(index); });
                actionRow.append(row, favorite);
                return actionRow;
            }
            nextRowsScope.listen(row, 'click', () => { if (!disabled) void popup.select(index); });
            nextRowsScope.listen(row, 'mouseenter', () => { if (!disabled) popup.highlight(index); });
            return row;
        };
        if (grouped) {
            const groups = new Map();
            rows.forEach((option, index) => {
                const key = option.group ?? '';
                let group = groups.get(key);
                if (!group) {
                    group = document.createElement('section');
                    group.className = 'vcp-harness-popup-select-group';
                    group.setAttribute('role', 'group');
                    if (key) {
                        const title = document.createElement('div');
                        title.className = 'vcp-harness-popup-select-group-title';
                        title.textContent = key;
                        title.id = `vcp-harness-popup-select-group-title-${groups.size}`;
                        group.setAttribute('aria-labelledby', title.id);
                        group.append(title);
                    }
                    groups.set(key, group);
                    listbox.append(group);
                }
                group.append(renderOption(option, index));
            });
        } else rows.forEach((option, index) => listbox.append(renderOption(option, index)));
        // Focus ownership sits with the search input, so scrolling the virtual
        // highlight into view is explicit here (source useEffect on `active`).
        listbox.querySelector('[aria-selected="true"], [aria-checked="true"]')?.scrollIntoView?.({ block: 'nearest' });
        if (focusActiveOption) {
            focusActiveOption = false;
            const row = listbox.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[s.active];
            if (row?.tagName === 'BUTTON' && !(row as HTMLButtonElement).disabled) row.focus({ preventScroll: true });
        }
    };

    const sync = () => {
        const s = popup.getSnapshot();
        if (!s.open && lastOpen) {
            card.remove(); // Dismiss renders null; the anchor stays mounted.
            void rowsScope?.dispose('harness-popup-select-rows-closed');
            rowsScope = null;
            listbox.replaceChildren();
        }
        if (!s.open) { lastOpen = false; return; }
        if (!lastOpen) {
            host.append(card);
            lastOpen = true;
        }
        card.setAttribute('aria-label', template(labels.overlayAria, s.command ?? ''));
        if (s.status === 'pending' || s.submitting) card.setAttribute('aria-busy', 'true');
        else card.removeAttribute('aria-busy');
        search.value = s.search;
        search.hidden = !searchEnabled;
        search.readOnly = s.submitting;
        // The gated shell hides the picker card and shows only the risk modal.
        card.style.display = s.confirming === null ? '' : 'none';
        if (s.error !== null) {
            error.style.display = '';
            errorTextSpan.textContent = s.error;
            retryButton.style.display = s.status === 'failed' ? '' : 'none';
        } else {
            error.style.display = 'none';
        }
        status.style.display = '';
        status.textContent = s.submitting ? labels.applying
            : s.status === 'pending' ? labels.loading
            : s.status === 'ready' && filterOptions(s.options, s.search).length === 0 ? labels.empty
            : '';
        status.style.display = status.textContent === '' ? 'none' : '';
        renderRows(s);
        if (s.confirming === null && searchEnabled) search.focus({ preventScroll: true });
    };
    let renderConfirmingId: string | null = null;
    let riskController: ReturnType<typeof mountRiskConfirmation> | null = null;
    const syncRisk = () => {
        const s = popup.getSnapshot();
        const confirmingId = s.confirming?.id ?? null;
        if (confirmingId === renderConfirmingId) {
            riskController?.setAcknowledged(s.acknowledged);
            return;
        }
        renderConfirmingId = confirmingId;
        void riskController?.dispose();
        riskController = null;
        void riskScope?.dispose('popup-risk-swapped');
        riskScope = null;
        if (s.confirming === null) return;
        const confirmation = s.confirming.confirmation;
        if (confirmation === undefined) return;
        riskScope = scope.child('harness-popup-select-risk');
        riskController = mountRiskConfirmation({
            title: confirmation.title,
            description: confirmation.description,
            acknowledgeLabel: confirmation.acknowledgeLabel,
            cancelLabel: confirmation.cancelLabel,
            confirmLabel: confirmation.confirmLabel,
            acknowledged: s.acknowledged,
            open: true,
            onAcknowledgedChange: value => popup.acknowledge(value),
            onCancel: () => popup.cancelConfirmation(),
            onConfirm: () => { void popup.confirm(); },
        }, riskScope);
    };

    const unsubscribe = popup.subscribe(() => {
        sync();
        syncRisk();
    });

    const dispose = viewScope.own(async () => {
        unsubscribe();
        await riskScope?.dispose('harness-popup-select-risk-unmounted');
        await rowsScope?.dispose('harness-popup-select-rows-unmounted');
        popup.dispose();
        card.remove();
    }, 'harness-popup-select-view', 'ui-primitive');

    sync();
    syncRisk();

    return {
        card, search, sync: () => { sync(); syncRisk(); }, dispose,
    };
}
