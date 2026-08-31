import type { UiScope } from '../contracts.js';
import { mountButton } from './button.js';
import { mountModal, type ModalController } from './modal.js';

const STYLE_ID = 'vcp-harness-uiux-directory-browser';
const SLOW_SCAN_DELAY_MS = 300;
const PARENT_LEG_WAIT_MS = 200;

function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // Doubled selector deliberately beats the shared Modal dialog contract,
    // matching Harness DirectoryBrowser.module.css's `.dialog.dialog` seam.
    style.textContent = `.vcp-directory-browser.vcp-directory-browser{width:min(680px,100%);height:min(500px,calc(100dvh - 32px));padding:0;gap:0}.vcp-directory-browser-frame{display:flex;flex:1;min-height:0;flex-direction:column}.vcp-directory-browser-header{display:flex;flex:none;flex-direction:column;gap:8px;padding:16px 14px 8px 24px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.14))}.vcp-directory-browser-title{min-height:28px;margin:0;font-size:16px;font-weight:510;line-height:24px}.vcp-directory-browser-crumbs{display:flex;align-items:center;gap:4px;min-height:24px;margin-left:-9px;padding:0 8px;border:1px solid transparent;border-radius:8px}.vcp-directory-browser-crumbs:has(.vcp-directory-browser-path-input){border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.22))}.vcp-directory-browser-crumb{max-width:160px;padding:0;border:0;background:transparent;overflow:hidden;color:var(--dsw-alias-label-tertiary,#737780);font:500 13px/20px inherit;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.vcp-directory-browser-crumb:hover{color:var(--dsw-alias-label-primary,#0f1115)}.vcp-directory-browser-path-edit{display:flex;align-items:center;justify-content:flex-end;flex:1 0 28px;min-width:28px;height:22px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#737780);cursor:text}.vcp-directory-browser-path-edit:hover,.vcp-directory-browser-path-edit:focus-visible{color:var(--dsw-alias-label-primary,#0f1115)}.vcp-directory-browser-path-input{box-sizing:border-box;flex:1 1 0;min-width:0;height:22px;padding:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:500 13px/20px inherit}.vcp-directory-browser-content{position:relative;display:flex;flex:1;min-height:0;padding:16px 16px 16px 24px}.vcp-directory-browser-columns{display:flex;flex:1;min-width:0;gap:12px;overflow-x:auto}.vcp-directory-browser-column{display:flex;flex:1 1 0;flex-direction:column;min-width:256px;gap:2px;overflow-y:auto;padding-right:8px}.vcp-directory-browser-divider{flex:none;width:1px;background:var(--dsw-alias-border-l3,rgba(0,0,0,.14))}.vcp-directory-browser-row{display:flex;align-items:center;gap:4px;width:100%;height:28px;padding:4px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:500 13px/20px inherit;text-align:left;cursor:pointer}.vcp-directory-browser-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-directory-browser-row[aria-current=true]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.1)))}.vcp-directory-browser-row-icon{flex:none;color:var(--dsw-alias-label-secondary,#50545b)}.vcp-directory-browser-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vcp-directory-browser-status{position:absolute;right:16px;bottom:8px;padding:2px 8px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#50545b);font-size:12px;line-height:18px}.vcp-directory-browser-error{position:absolute;bottom:8px;left:24px;max-width:70%;color:var(--dsw-alias-state-error-primary,#d92d20);font-size:12px;line-height:18px}.vcp-directory-browser-footer{display:flex;flex:none;align-items:center;gap:8px;padding:12px 24px;border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.14))}.vcp-directory-browser-spacer{flex:1}.vcp-directory-browser-hidden{display:inline-flex;align-items:center;gap:4px;padding:4px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#50545b);font:inherit;font-size:12px;cursor:pointer}.vcp-directory-browser-hidden[aria-pressed=true]{color:var(--dsw-alias-label-primary,#0f1115)}.vcp-directory-browser-create-dialog.vcp-directory-browser-create-dialog{width:min(380px,100%);padding:0;gap:0}.vcp-directory-browser-create-body{display:flex;flex-direction:column;gap:12px;padding:22px 24px 20px}.vcp-directory-browser-create-title{margin:0;font-size:16px;font-weight:510;line-height:24px}.vcp-directory-browser-create-in{margin:0;font-size:14px;line-height:22px}.vcp-directory-browser-create-input{box-sizing:border-box;width:100%;height:44px;padding:7px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.22));border-radius:22px;outline:0;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:14px/22px inherit}.vcp-directory-browser-create-error{color:var(--dsw-alias-state-error-primary,#d92d20);font-size:12px;line-height:18px}.vcp-directory-browser-create-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}`;
    (document.head || document.documentElement).append(style);
}

export interface DirectoryBrowserEntry { readonly name: string; readonly path: string; readonly hidden?: boolean; }
export interface DirectoryBrowserListing { readonly path: string; readonly home?: string; readonly crumbs?: readonly DirectoryBrowserEntry[]; readonly entries: readonly DirectoryBrowserEntry[]; readonly truncated?: boolean; }
export interface DirectoryBrowserProps {
    readonly open?: boolean;
    readonly busy?: boolean;
    readonly listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryBrowserListing>;
    readonly createDirectory: (path: string, name: string) => Promise<string>;
    readonly onOpen: (path: string) => void;
    readonly onClose: () => void;
    readonly title?: string;
    readonly cancelLabel?: string;
    readonly openLabel?: string;
    readonly newFolderLabel?: string;
    readonly showHiddenLabel?: string;
}
export interface DirectoryBrowserController {
    readonly modal: ModalController;
    readonly open: boolean;
    setOpen(open: boolean): void;
    setBusy(busy: boolean): void;
    dispose(): void | Promise<void>;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Candidate-only Light-DOM Miller browser. All filesystem actions are injected
 * by its owner; it does not import Electron, invoke IPC, or retain a path.
 */
export function mountDirectoryBrowser(props: DirectoryBrowserProps, scope: UiScope): DirectoryBrowserController {
    if (!props?.listDirectory || !props.createDirectory || !props.onOpen || !props.onClose || !scope) throw new TypeError('DirectoryBrowser requires injected browse/create/open/close capabilities and scope.');
    ensureStyles();
    const browserScope = scope.child('harness-directory-browser');
    const frame = document.createElement('div'); frame.className = 'vcp-directory-browser-frame';
    const header = document.createElement('header'); header.className = 'vcp-directory-browser-header';
    const title = document.createElement('h2'); title.className = 'vcp-directory-browser-title'; title.textContent = props.title ?? 'Open folder';
    const crumbs = document.createElement('nav'); crumbs.className = 'vcp-directory-browser-crumbs'; crumbs.setAttribute('aria-label', 'Folder path');
    header.append(title, crumbs);
    const content = document.createElement('div'); content.className = 'vcp-directory-browser-content';
    const columns = document.createElement('div'); columns.className = 'vcp-directory-browser-columns'; content.append(columns);
    const status = document.createElement('div'); status.className = 'vcp-directory-browser-status'; status.setAttribute('role', 'status');
    const error = document.createElement('div'); error.className = 'vcp-directory-browser-error'; error.setAttribute('role', 'alert');
    content.append(status, error);
    const footer = document.createElement('footer'); footer.className = 'vcp-directory-browser-footer';
    const create = document.createElement('button'); create.type = 'button'; create.textContent = props.newFolderLabel ?? 'New folder';
    const hidden = document.createElement('button'); hidden.type = 'button'; hidden.className = 'vcp-directory-browser-hidden'; hidden.textContent = props.showHiddenLabel ?? 'Show hidden files'; hidden.setAttribute('aria-pressed', 'false');
    const spacer = document.createElement('span'); spacer.className = 'vcp-directory-browser-spacer';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = props.cancelLabel ?? 'Cancel';
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = props.openLabel ?? 'Open';
    footer.append(create, hidden, spacer, cancel, confirm); frame.append(header, content, footer);
    mountButton(create, { variant: 'outline', size: 'sm' }, browserScope); mountButton(cancel, { variant: 'outline', size: 'sm' }, browserScope); mountButton(confirm, { variant: 'primary', size: 'sm' }, browserScope);
    let generation = 0; let controller: AbortController | null = null; let loading = false; let slowLoading = false; let slowTimer: ReturnType<typeof setTimeout> | null = null; let previewTimer: ReturnType<typeof setTimeout> | null = null; let parent: DirectoryBrowserListing | null = null; let selected: DirectoryBrowserEntry | null = null; let child: DirectoryBrowserListing | null = null; let busy = Boolean(props.busy); let showHidden = false; let failure: string | null = null; let creating = false; let editingPath = false; let pathDraft = ''; let createOpen = false; let createName = ''; let createFailure: string | null = null; let createRequest = 0;
    const createBody = document.createElement('div'); createBody.className = 'vcp-directory-browser-create-body';
    const createTitle = document.createElement('h3'); createTitle.className = 'vcp-directory-browser-create-title'; createTitle.textContent = props.newFolderLabel ?? 'New folder';
    const createIn = document.createElement('p'); createIn.className = 'vcp-directory-browser-create-in';
    const createInput = document.createElement('input'); createInput.type = 'text'; createInput.className = 'vcp-directory-browser-create-input'; createInput.setAttribute('aria-label', 'Folder name'); createInput.placeholder = 'Untitled folder';
    const createError = document.createElement('div'); createError.className = 'vcp-directory-browser-create-error'; createError.setAttribute('role', 'alert');
    const createActions = document.createElement('div'); createActions.className = 'vcp-directory-browser-create-actions';
    const createCancel = document.createElement('button'); createCancel.type = 'button'; createCancel.textContent = props.cancelLabel ?? 'Cancel';
    const createConfirm = document.createElement('button'); createConfirm.type = 'button'; createConfirm.textContent = 'Create';
    createActions.append(createCancel, createConfirm); createBody.append(createTitle, createIn, createInput, createError, createActions);
    mountButton(createCancel, { variant: 'outline', size: 'sm' }, browserScope); mountButton(createConfirm, { variant: 'primary', size: 'sm' }, browserScope);
    const modal = mountModal({ title: props.title ?? 'Open folder', className: 'vcp-directory-browser', body: frame, headless: true, open: props.open, canClose: () => !busy && !creating && !createOpen, onClose: () => props.onClose() }, browserScope);
    const createModal = mountModal({ title: props.newFolderLabel ?? 'New folder', className: 'vcp-directory-browser-create-dialog', body: createBody, headless: true, open: false, canClose: () => !creating, onClose: () => { if (!creating) { createOpen = false; createRequest += 1; sync(); } } }, browserScope);
    const visible = (entries: readonly DirectoryBrowserEntry[], prefix = '') => {
        const needle = prefix.toLowerCase();
        const base = entries.filter(entry => showHidden || !entry.hidden);
        if (!needle) return base;
        const matches = base.filter(entry => entry.name.toLowerCase().startsWith(needle));
        return matches.length ? matches : base;
    };
    const sync = () => {
        crumbs.replaceChildren();
        const source = child ?? parent;
        const chain = source?.crumbs?.length ? source.crumbs : source ? [{ name: source.path, path: source.path }] : [];
        if (editingPath) {
            const input = document.createElement('input'); input.type = 'text'; input.className = 'vcp-directory-browser-path-input'; input.value = pathDraft; input.setAttribute('aria-label', 'Folder path'); input.disabled = busy || loading || creating || createOpen;
            browserScope.listen(input, 'input', () => { pathDraft = input.value; sync(); if (previewTimer !== null) clearTimeout(previewTimer); const draft = pathDraft; if (!draft.endsWith('/') && !draft.endsWith('\\')) return; previewTimer = setTimeout(() => { previewTimer = null; if (!modal.open || !editingPath || !draft.trim()) return; preview(draft); }, 250); });
            browserScope.listen(input, 'keydown', event => { const key = (event as KeyboardEvent).key; if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); editingPath = false; sync(); } if (key === 'Enter' && pathDraft.trim()) { event.preventDefault(); event.stopPropagation(); editingPath = false; navigate(pathDraft); } });
            crumbs.append(input); queueMicrotask(() => { if (modal.open && document.activeElement !== input) input.focus(); });
        } else {
            chain.forEach((crumb, index) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'vcp-directory-browser-crumb'; button.textContent = `${index ? '› ' : ''}${crumb.name}`; button.disabled = busy || loading || creating || createOpen; browserScope.listen(button, 'click', () => navigate(crumb.path)); crumbs.append(button); });
            const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'vcp-directory-browser-path-edit'; edit.textContent = '✎'; edit.setAttribute('aria-label', 'Edit folder path'); edit.disabled = !source || busy || loading || creating || createOpen; browserScope.listen(edit, 'click', () => { if (!source) return; editingPath = true; pathDraft = source.path.endsWith('/') || source.path.endsWith('\\') ? source.path : `${source.path}/`; sync(); }); crumbs.append(edit);
        }
        columns.replaceChildren();
        const draftPrefix = editingPath ? pathDraft.slice(Math.max(pathDraft.lastIndexOf('/'), pathDraft.lastIndexOf('\\')) + 1) : '';
        const renderColumn = (listing: DirectoryBrowserListing, current: DirectoryBrowserEntry | null, onPick: (entry: DirectoryBrowserEntry) => void, prefix = '') => { const column = document.createElement('div'); column.className = 'vcp-directory-browser-column'; visible(listing.entries, prefix).forEach(entry => { const row = document.createElement('button'); row.type = 'button'; row.className = 'vcp-directory-browser-row'; row.setAttribute('aria-current', String(current?.path === entry.path)); row.disabled = busy || loading || creating || createOpen; const icon = document.createElement('span'); icon.className = 'vcp-directory-browser-row-icon vcp-ui-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = current?.path === entry.path ? 'folder-open' : 'folder'; const name = document.createElement('span'); name.className = 'vcp-directory-browser-row-name'; name.textContent = entry.name; row.append(icon, name); browserScope.listen(row, 'click', () => onPick(entry)); column.append(row); }); columns.append(column); };
        if (parent) renderColumn(parent, selected, pick, child ? '' : draftPrefix);
        if (selected && child) { const divider = document.createElement('span'); divider.className = 'vcp-directory-browser-divider'; columns.append(divider); renderColumn(child, null, advance, draftPrefix); }
        status.textContent = slowLoading ? 'Loading…' : parent?.truncated || child?.truncated ? 'Some entries are not shown.' : '';
        status.hidden = status.textContent === '';
        error.textContent = failure ?? ''; error.hidden = failure === null;
        const inert = busy || creating || createOpen;
        hidden.setAttribute('aria-pressed', String(showHidden)); hidden.disabled = inert;
        create.disabled = !parent || loading || inert || editingPath;
        cancel.disabled = inert; confirm.disabled = !parent || loading || inert || editingPath;
        createInput.value = createName; createInput.disabled = creating; createError.textContent = createFailure ?? ''; createError.hidden = createFailure === null;
        const target = selected?.path ?? parent?.path ?? '';
        createIn.textContent = target ? `Create in ${target}` : '';
        createCancel.disabled = creating; createConfirm.disabled = creating || createName.trim() === '';
    };
    const clearSlowScan = () => { if (slowTimer !== null) clearTimeout(slowTimer); slowTimer = null; slowLoading = false; if (previewTimer !== null) clearTimeout(previewTimer); previewTimer = null; };
    const scan = async (path: string | undefined, commit: (listing: DirectoryBrowserListing) => void) => { const request = ++generation; controller?.abort(); controller = new AbortController(); clearSlowScan(); loading = true; failure = null; slowTimer = setTimeout(() => { if (request === generation && modal.open && loading) { slowTimer = null; slowLoading = true; sync(); } }, SLOW_SCAN_DELAY_MS); sync(); try { const listing = await props.listDirectory(path, controller.signal); if (request !== generation || !modal.open) return; commit(listing); } catch (reason) { if (request !== generation || !modal.open) return; failure = errorText(reason); } finally { if (request === generation && modal.open) { clearSlowScan(); loading = false; sync(); } } };
    const land = (path: string | undefined, closeEditor: boolean) => {
        const request = ++generation; controller?.abort(); controller = new AbortController(); loading = true; failure = null; sync();
        void props.listDirectory(path, controller.signal).then(target => {
            if (request !== generation || !modal.open) return;
            const parentCrumb = target.crumbs?.at(-2);
            let settled = false;
            const settleSingle = () => { if (settled || request !== generation || !modal.open) return; settled = true; parent = target; selected = null; child = null; if (closeEditor) editingPath = false; clearSlowScan(); loading = false; sync(); };
            if (!parentCrumb) { settleSingle(); return; }
            const timeout = setTimeout(settleSingle, PARENT_LEG_WAIT_MS);
            void props.listDirectory(parentCrumb.path, controller?.signal).then(parentListing => {
                if (request !== generation || !modal.open) return;
                const match = parentListing.entries.find(entry => entry.path === target.path);
                if (!match) { settleSingle(); return; }
                clearTimeout(timeout); parent = parentListing; selected = match; child = target; if (closeEditor) editingPath = false; settled = true; clearSlowScan(); loading = false; sync();
            }, () => settleSingle());
        }, reason => { if (request === generation && modal.open) { failure = errorText(reason); clearSlowScan(); loading = false; sync(); } });
    };
    const navigate = (path?: string) => { land(path, true); };
    const preview = (path: string) => { land(path, false); };
    const pick = (entry: DirectoryBrowserEntry) => { selected = entry; child = null; void scan(entry.path, listing => { child = listing; }); };
    const advance = (entry: DirectoryBrowserEntry) => { if (!child) return; parent = child; selected = null; child = null; pick(entry); };
    browserScope.listen(hidden, 'click', () => { showHidden = !showHidden; sync(); });
    browserScope.listen(cancel, 'click', () => props.onClose());
    browserScope.listen(confirm, 'click', () => { const target = selected?.path ?? parent?.path; if (target) props.onOpen(target); });
    const closeCreate = () => { if (creating) return; createOpen = false; createRequest += 1; createModal.setOpen(false); sync(); };
    const submitCreate = () => {
        if (!parent || creating || createName.trim() === '') return;
        const target = selected?.path ?? parent.path; const name = createName; const request = ++createRequest;
        creating = true; createFailure = null; sync();
        void props.createDirectory(target, name).then(created => {
            if (request !== createRequest || !modal.open || !createOpen) return;
            creating = false; createOpen = false; createModal.setOpen(false); selected = { name, path: created }; child = null; void scan(target, listing => { parent = listing; });
        }, reason => { if (request !== createRequest || !modal.open || !createOpen) return; creating = false; createFailure = errorText(reason); sync(); });
    };
    browserScope.listen(create, 'click', () => { if (!parent || creating || createOpen || editingPath) return; createOpen = true; createName = ''; createFailure = null; createModal.setOpen(true); sync(); queueMicrotask(() => { if (createModal.open) createInput.focus(); }); });
    browserScope.listen(createInput, 'input', () => { createName = createInput.value; createFailure = null; sync(); });
    browserScope.listen(createInput, 'keydown', event => { const key = (event as KeyboardEvent).key; if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCreate(); } if (key === 'Enter' && createName.trim()) { event.preventDefault(); event.stopPropagation(); submitCreate(); } });
    browserScope.listen(createCancel, 'click', closeCreate); browserScope.listen(createConfirm, 'click', submitCreate);
    const setOpen = (open: boolean) => { if (open) { modal.setOpen(true); parent = null; selected = null; child = null; failure = null; showHidden = false; editingPath = false; createOpen = false; creating = false; createRequest += 1; createModal.setOpen(false); navigate(); } else { generation += 1; clearSlowScan(); controller?.abort(); controller = null; editingPath = false; createOpen = false; creating = false; createRequest += 1; createModal.setOpen(false); modal.setOpen(false); } };
    const dispose = scope.own(async () => { generation += 1; createRequest += 1; clearSlowScan(); controller?.abort(); controller = null; createModal.setOpen(false); await browserScope.dispose('harness-directory-browser-unmounted'); }, 'harness-directory-browser', 'ui-primitive');
    if (props.open) navigate(); else sync();
    return { modal, get open() { return modal.open; }, setOpen, setBusy(value) { busy = Boolean(value); sync(); }, dispose };
}
