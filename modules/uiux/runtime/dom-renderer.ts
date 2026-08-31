import type { UiDisposer, UiScope } from '../contracts.js';

export interface DomRenderer {
    mount(parent: Node, node: Node, before?: Node | null): UiDisposer;
    portal(node: Node, container: Node): UiDisposer;
    listen(target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions): UiDisposer;
    updateText(node: Text, value: unknown): void;
    keyed<T>(parent: Element, items: readonly T[], key: (item: T) => string, render: (item: T) => Element): UiDisposer & { update(items: readonly T[]): void };
}

/** Minimal Light-DOM kernel: owned insertion, text updates and keyed reconciliation. */
export function createDomRenderer(scope: UiScope): DomRenderer {
    if (!scope) throw new TypeError('DomRenderer requires a scope.');
    const mount = (parent: Node, node: Node, before: Node | null = null) => {
        parent.insertBefore(node, before);
        return scope.own(() => { node.parentNode?.removeChild(node); }, 'dom-renderer-node', 'ui-renderer');
    };
    const portal = (node: Node, container: Node) => {
        const parent = node.parentNode;
        const before = node.nextSibling;
        container.appendChild(node);
        return scope.own(() => {
            if (parent) parent.insertBefore(node, before && before.parentNode === parent ? before : null);
            else (node as ChildNode).remove();
        }, 'dom-renderer-portal', 'ui-renderer');
    };
    const listen = (target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions) => {
        target.addEventListener(type, handler, options);
        return scope.own(() => target.removeEventListener(type, handler, options), 'dom-renderer-listener', 'ui-renderer');
    };
    const updateText = (node: Text, value: unknown) => { node.data = String(value ?? ''); };
    const keyed = <T>(parent: Element, items: readonly T[], key: (item: T) => string, render: (item: T) => Element) => {
        const nodes = new Map<string, Element>();
        const reconcile = (next: readonly T[]) => {
            const nextKeys = new Set(next.map(key));
            next.forEach((item, index) => {
                const id = key(item);
                const node = nodes.get(id) || render(item);
                nodes.set(id, node);
                parent.insertBefore(node, parent.children[index] || null);
            });
            [...nodes].forEach(([id, node]) => { if (!nextKeys.has(id)) { node.remove(); nodes.delete(id); } });
        };
        reconcile(items);
        const disposer = scope.own(() => { nodes.forEach(node => node.remove()); nodes.clear(); }, 'dom-renderer-keyed', 'ui-renderer');
        return Object.assign(disposer, { update: reconcile });
    };
    return Object.freeze({ mount, portal, listen, updateText, keyed });
}
