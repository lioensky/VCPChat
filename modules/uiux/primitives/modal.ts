import type { UiDisposer, UiScope } from '../contracts.js';

const STYLE_ID = 'vcp-harness-uiux-modal';

function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-modal-root{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px}.vcp-harness-modal-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.24));backdrop-filter:var(--dsw-mask-blur,blur(2px))}.vcp-harness-modal-dialog{position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(380px,100%);padding:0 0 24px;overflow:hidden;border:1px solid var(--dsw-alias-border-inverted,transparent);border-radius:24px;background:var(--dsw-alias-bg-layer-2,var(--vcp-color-surface,#fff));box-shadow:var(--dsw-shadow-lv3,0 0 1px rgba(0,0,0,.2),0 0 4px rgba(0,0,0,.02),0 12px 32px rgba(0,0,0,.08));font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-harness-modal-content{display:flex;flex-direction:column;width:100%}.vcp-harness-modal-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}.vcp-harness-modal-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-harness-modal-close{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary,#50545b)}.vcp-harness-modal-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-harness-modal-close>.vcp-ui-icon{width:14px;height:14px}.vcp-harness-modal-description{margin:0;padding:0 24px;font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-harness-modal-body{display:flex;flex-direction:column;min-width:0;margin-top:20px;padding:0 24px}.vcp-harness-modal-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}`;
    (document.head || document.documentElement).append(style);
}

export interface ModalProps {
    readonly title: string;
    readonly closeLabel?: string;
    readonly description?: string;
    readonly className?: string;
    readonly contentClassName?: string;
    readonly body?: Node | readonly Node[];
    readonly footer?: Node | readonly Node[];
    readonly headless?: boolean;
    readonly open?: boolean;
    /** Lets an owning composite decline mask/Escape/close-button dismissal while a child owns interaction. */
    readonly canClose?: () => boolean;
    readonly onClose?: () => void;
}

export interface ModalController {
    readonly root: HTMLDivElement;
    readonly dialog: HTMLDivElement;
    readonly open: boolean;
    setOpen(open: boolean): void;
    dispose(): void | Promise<void>;
}

function nodes(value?: Node | readonly Node[]) {
    if (!value) return [];
    return Array.isArray(value) ? Array.from(value) : [value];
}

/** Controlled Harness Modal rendered as a body portal in Light DOM. */
export function mountModal(props: ModalProps, scope: UiScope): ModalController {
    if (!props?.title || !scope) throw new TypeError('Modal requires a title and scope.');
    ensureStyles();
    const modalScope = scope.child('harness-modal');
    const root = document.createElement('div');
    root.className = 'vcp-harness-modal-root vcp-ui-scope';
    root.dataset.motion = 'enter';
    root.setAttribute('role', 'presentation');
    const mask = document.createElement('div');
    mask.className = 'vcp-harness-modal-mask';
    mask.setAttribute('aria-hidden', 'true');
    const dialog = document.createElement('div');
    dialog.className = 'vcp-harness-modal-dialog';
    if (props.className) dialog.classList.add(...props.className.split(/\s+/).filter(Boolean));
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', props.title);
    root.append(mask, dialog);

    const bodyNodes = nodes(props.body);
    const footerNodes = nodes(props.footer);
    const movableNodes = [...bodyNodes, ...footerNodes];
    const originalPositions = movableNodes.map(node => ({ node, parent: node.parentNode, next: node.nextSibling }));
    let bodyTarget: HTMLElement = dialog;
    let footerTarget: HTMLElement | null = null;
    if (props.headless) {
        bodyTarget = dialog;
    } else {
        const content = document.createElement('div');
        content.className = 'vcp-harness-modal-content';
        if (props.contentClassName) content.classList.add(...props.contentClassName.split(/\s+/).filter(Boolean));
        const header = document.createElement('div');
        header.className = 'vcp-harness-modal-header';
        const title = document.createElement('h2');
        title.className = 'vcp-harness-modal-title';
        title.textContent = props.title;
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'vcp-harness-modal-close';
        closeButton.setAttribute('aria-label', props.closeLabel ?? 'Close');
        const closeIcon = document.createElement('span');
        closeIcon.className = 'vcp-ui-icon';
        closeIcon.setAttribute('aria-hidden', 'true');
        closeIcon.textContent = 'close';
        closeButton.append(closeIcon);
        header.append(title, closeButton);
        content.append(header);
        if (props.description) {
            const description = document.createElement('p');
            description.className = 'vcp-harness-modal-description';
            description.textContent = props.description;
            content.append(description);
        }
        if (bodyNodes.length) {
            const body = document.createElement('div');
            body.className = 'vcp-harness-modal-body';
            content.append(body);
            bodyTarget = body;
        }
        dialog.append(content);
        if (footerNodes.length) {
            const footer = document.createElement('div');
            footer.className = 'vcp-harness-modal-footer';
            dialog.append(footer);
            footerTarget = footer;
        }
        modalScope.listen(closeButton, 'click', () => close(true));
    }

    let active = false;
    let escapeRelease: UiDisposer | null = null;
    const restoreNodes = () => {
        originalPositions.slice().reverse().forEach(({ node, parent, next }) => {
            if (!parent) { node.remove(); return; }
            if (next?.parentNode === parent) parent.insertBefore(node, next);
            else parent.appendChild(node);
        });
    };
    const moveNodesIntoDialog = () => {
        bodyTarget.append(...bodyNodes);
        footerTarget?.append(...footerNodes);
    };
    const releaseOpenEffects = () => {
        escapeRelease?.();
        escapeRelease = null;
    };
    const close = (notify = false) => {
        if (!active) return;
        if (notify && props.canClose && !props.canClose()) return;
        active = false;
        releaseOpenEffects();
        root.remove();
        restoreNodes();
        if (notify) props.onClose?.();
    };
    const open = () => {
        if (active) return;
        active = true;
        moveNodesIntoDialog();
        document.body.append(root);
        const icons = (globalThis as typeof globalThis & { VCPIcons?: { refresh(root?: ParentNode): void } }).VCPIcons;
        icons?.refresh(root);
        const onKeyDown = (event: Event) => {
            if ((event as KeyboardEvent).key === 'Escape') close(true);
        };
        document.addEventListener('keydown', onKeyDown);
        escapeRelease = () => document.removeEventListener('keydown', onKeyDown);
    };
    modalScope.listen(mask, 'click', () => close(true));

    const dispose = scope.own(async () => {
        close(false);
        releaseOpenEffects();
        await modalScope.dispose('harness-modal-unmounted');
        restoreNodes();
        root.remove();
    }, 'harness-modal', 'ui-primitive');
    const controller: ModalController = {
        root,
        dialog,
        get open() { return active; },
        setOpen(value) { if (value) open(); else close(false); },
        dispose,
    };
    if (props.open) open();
    return controller;
}
