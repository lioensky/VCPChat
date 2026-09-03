/** Minimal Light-DOM kernel: owned insertion, text updates and keyed reconciliation. */
export function createDomRenderer(scope) {
    if (!scope)
        throw new TypeError('DomRenderer requires a scope.');
    const mount = (parent, node, before = null) => {
        parent.insertBefore(node, before);
        return scope.own(() => { node.parentNode?.removeChild(node); }, 'dom-renderer-node', 'ui-renderer');
    };
    const portal = (node, container) => {
        const parent = node.parentNode;
        const before = node.nextSibling;
        container.appendChild(node);
        return scope.own(() => {
            if (parent)
                parent.insertBefore(node, before && before.parentNode === parent ? before : null);
            else
                node.remove();
        }, 'dom-renderer-portal', 'ui-renderer');
    };
    const listen = (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        return scope.own(() => target.removeEventListener(type, handler, options), 'dom-renderer-listener', 'ui-renderer');
    };
    const updateText = (node, value) => { node.data = String(value ?? ''); };
    const keyed = (parent, items, key, render) => {
        const nodes = new Map();
        const reconcile = (next) => {
            const nextKeys = new Set(next.map(key));
            next.forEach((item, index) => {
                const id = key(item);
                const node = nodes.get(id) || render(item);
                nodes.set(id, node);
                parent.insertBefore(node, parent.children[index] || null);
            });
            [...nodes].forEach(([id, node]) => { if (!nextKeys.has(id)) {
                node.remove();
                nodes.delete(id);
            } });
        };
        reconcile(items);
        const disposer = scope.own(() => { nodes.forEach(node => node.remove()); nodes.clear(); }, 'dom-renderer-keyed', 'ui-renderer');
        return Object.assign(disposer, { update: reconcile });
    };
    return Object.freeze({ mount, portal, listen, updateText, keyed });
}
