import type { UiDisposer, UiScope } from '../contracts.js';

const STYLE_ID = 'vcp-harness-uiux-hover-card';
const POINTER_GRACE_MS = 200;

function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-hover-card-root{position:relative;display:block}.vcp-harness-hover-card{--dsw-hovercard-bg:#2c2c2e;position:fixed;z-index:100;box-sizing:border-box;width:244px;padding:12px 16px;border-radius:12px;background:var(--dsw-hovercard-bg);box-shadow:var(--dsw-shadow-lv3,0 0 1px rgba(0,0,0,.2),0 0 4px rgba(0,0,0,.02),0 12px 32px rgba(0,0,0,.08));font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif;color:#fff}.vcp-harness-hover-card-copyable{cursor:pointer}.vcp-harness-hover-card-copyable:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2678ff);outline-offset:2px}.vcp-harness-hover-card-feedback{display:flex;align-items:center;justify-content:center}.vcp-harness-hover-card-copied{color:#fff;font-size:14px;line-height:20px;text-align:center}.vcp-harness-hover-card-status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}`;
    (document.head || document.documentElement).append(style);
}

export interface HoverCardProps {
    readonly content: Node | readonly Node[];
    readonly openDelayMs?: number;
    readonly disabled?: boolean;
    readonly copyText?: string;
    readonly copyLabel?: string;
    readonly copiedLabel?: string;
}

export interface HoverCardController {
    readonly root: HTMLSpanElement;
    readonly card: HTMLDivElement | null;
    readonly open: boolean;
    readonly disabled: boolean;
    setDisabled(disabled: boolean): void;
    dispose(): void | Promise<void>;
}

function nodes(value: Node | readonly Node[]) {
    return Array.isArray(value) ? Array.from(value) : [value];
}

async function writeClipboard(text: string): Promise<boolean> {
    if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
    }
    const exec = typeof document.execCommand === 'function' ? document.execCommand.bind(document) : undefined;
    if (!exec) return false;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.append(textarea);
    textarea.select();
    try { return exec('copy'); } catch { return false; } finally { textarea.remove(); }
}

/** Delayed, reachable Harness preview card rendered through a body portal. */
export function mountHoverCard(anchor: HTMLElement, props: HoverCardProps, scope: UiScope): HoverCardController {
    if (!anchor?.parentNode || !props?.content || !scope) throw new TypeError('HoverCard requires a connected anchor, content and scope.');
    ensureStyles();
    const hoverScope = scope.child('harness-hover-card');
    const parent = anchor.parentNode;
    const next = anchor.nextSibling;
    const root = document.createElement('span');
    root.className = 'vcp-harness-hover-card-root';
    parent.insertBefore(root, anchor);
    root.append(anchor);
    const contentNodes = nodes(props.content);
    const originalPositions = contentNodes.map(node => ({ node, parent: node.parentNode, next: node.nextSibling }));
    const parked = document.createDocumentFragment();
    const openDelayMs = Math.max(0, props.openDelayMs ?? 500);
    const copyLabel = props.copyLabel ?? '复制';
    const copiedLabel = props.copiedLabel ?? '复制成功';
    let disabled = Boolean(props.disabled);
    let card: HTMLDivElement | null = null;
    let status: HTMLSpanElement | null = null;
    let openTimer: ReturnType<typeof setTimeout> | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let copyTimer: ReturnType<typeof setTimeout> | null = null;
    let copyEpoch = 0;
    let copying = false;
    let copied = false;
    let copyHeight: number | null = null;
    const openReleases: UiDisposer[] = [];

    const restoreContent = () => {
        originalPositions.slice().reverse().forEach(({ node, parent: owner, next: sibling }) => {
            if (!owner) { node.remove(); return; }
            if (sibling?.parentNode === owner) owner.insertBefore(node, sibling);
            else owner.append(node);
        });
    };
    const cancelOpen = () => { if (openTimer !== null) clearTimeout(openTimer); openTimer = null; };
    const cancelClose = () => { if (closeTimer !== null) clearTimeout(closeTimer); closeTimer = null; };
    const releaseOpenEffects = () => openReleases.splice(0).reverse().forEach(release => release());
    const clearCopied = (restoreIntoCard = true) => {
        if (copyTimer !== null) clearTimeout(copyTimer);
        copyTimer = null;
        copied = false;
        copyHeight = null;
        card?.classList.remove('vcp-harness-hover-card-feedback');
        if (card) card.style.minHeight = '';
        card?.querySelector('.vcp-harness-hover-card-copied')?.remove();
        if (restoreIntoCard && card) card.append(...contentNodes);
        status && (status.textContent = '');
    };
    const place = () => {
        if (!card) return;
        const rect = root.getBoundingClientRect();
        const height = card.offsetHeight;
        const top = rect.top + height > window.innerHeight - 8 ? window.innerHeight - height - 8 : rect.top;
        card.style.left = `${rect.right + 8}px`;
        card.style.top = `${top}px`;
    };
    const close = () => {
        copyEpoch += 1;
        cancelOpen();
        cancelClose();
        releaseOpenEffects();
        clearCopied(false);
        card?.remove();
        card = null;
        status?.remove();
        status = null;
        restoreContent();
    };
    const armClose = () => {
        cancelClose();
        if (!card) return;
        closeTimer = setTimeout(() => { closeTimer = null; close(); }, POINTER_GRACE_MS);
    };
    const activateCopy = async () => {
        if (props.copyText === undefined || copied || copying || !card) return;
        copying = true;
        const epoch = copyEpoch;
        const accepted = await hoverScope.track(writeClipboard(props.copyText), 'hover-card-copy');
        copying = false;
        if (!accepted || !hoverScope.active || epoch !== copyEpoch || !card) return;
        copyHeight = card.offsetHeight || null;
        contentNodes.forEach(node => parked.append(node));
        const feedback = document.createElement('span');
        feedback.className = 'vcp-harness-hover-card-copied';
        feedback.setAttribute('aria-hidden', 'true');
        feedback.textContent = copiedLabel;
        card.append(feedback);
        card.classList.add('vcp-harness-hover-card-feedback');
        if (copyHeight !== null) card.style.minHeight = `${copyHeight}px`;
        copied = true;
        if (status) status.textContent = copiedLabel;
        copyTimer = setTimeout(() => clearCopied(true), 1000);
    };
    const open = () => {
        if (disabled || card) return;
        card = document.createElement('div');
        card.className = 'vcp-harness-hover-card';
        card.append(...contentNodes);
        if (props.copyText !== undefined) {
            card.classList.add('vcp-harness-hover-card-copyable');
            card.setAttribute('role', 'button');
            card.tabIndex = 0;
            card.setAttribute('aria-label', `${copyLabel}: ${props.copyText}`);
            status = document.createElement('span');
            status.className = 'vcp-harness-hover-card-status';
            status.setAttribute('role', 'status');
            root.append(status);
        }
        document.body.append(card);
        place();
        const onScroll = () => place();
        const onResize = () => place();
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
        openReleases.push(() => window.removeEventListener('scroll', onScroll, true));
        openReleases.push(() => window.removeEventListener('resize', onResize));
        const cardEnter = () => cancelClose();
        const cardLeave = () => armClose();
        const cardClick = () => {
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed) {
                for (let index = 0; index < selection.rangeCount; index += 1) {
                    if (selection.getRangeAt(index).intersectsNode(card!)) return;
                }
            }
            void activateCopy();
        };
        const cardKeyDown = (event: Event) => {
            const key = (event as KeyboardEvent).key;
            if (key !== 'Enter' && key !== ' ') return;
            event.preventDefault();
            void activateCopy();
        };
        card.addEventListener('pointerenter', cardEnter);
        card.addEventListener('pointerleave', cardLeave);
        if (props.copyText !== undefined) {
            card.addEventListener('click', cardClick);
            card.addEventListener('keydown', cardKeyDown);
        }
        openReleases.push(() => card?.removeEventListener('pointerenter', cardEnter));
        openReleases.push(() => card?.removeEventListener('pointerleave', cardLeave));
        openReleases.push(() => card?.removeEventListener('click', cardClick));
        openReleases.push(() => card?.removeEventListener('keydown', cardKeyDown));
        place();
    };
    const scheduleOpen = () => {
        if (disabled || card) return;
        cancelOpen();
        openTimer = setTimeout(() => { openTimer = null; open(); }, openDelayMs);
    };

    hoverScope.listen(root, 'pointerenter', () => { cancelClose(); scheduleOpen(); });
    hoverScope.listen(root, 'pointerleave', () => { cancelOpen(); armClose(); });
    hoverScope.listen(root, 'pointerdown', () => { cancelOpen(); cancelClose(); close(); }, { capture: true });

    const dispose = scope.own(async () => {
        disabled = true;
        close();
        if (copyTimer !== null) clearTimeout(copyTimer);
        await hoverScope.dispose('harness-hover-card-unmounted');
        if (next?.parentNode === parent) parent.insertBefore(anchor, next);
        else parent.append(anchor);
        root.remove();
        restoreContent();
    }, 'harness-hover-card', 'ui-primitive');
    return {
        root,
        get card() { return card; },
        get open() { return card !== null; },
        get disabled() { return disabled; },
        setDisabled(value) { disabled = value; if (disabled) close(); },
        dispose,
    };
}
