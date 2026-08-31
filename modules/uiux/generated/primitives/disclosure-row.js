const STYLE_ID = 'vcp-harness-uiux-disclosure-row';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-disclosure-root{display:flex;flex-direction:column;width:100%;min-width:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif}.vcp-harness-disclosure-row{position:relative;overflow:hidden;display:flex;align-items:center;height:24px;min-width:0}.vcp-harness-disclosure-row[data-expandable]{cursor:pointer}.vcp-harness-disclosure-leading{position:relative;flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;margin-right:6px;padding:0;border:0;background:none;color:var(--dsw-alias-label-tertiary,#737780)}button.vcp-harness-disclosure-leading{cursor:pointer}.vcp-harness-disclosure-icon-idle{display:inline-flex;opacity:1;transition:opacity 100ms ease}.vcp-harness-disclosure-chevron-hover{position:absolute;inset:0;margin:auto;opacity:0;transition:opacity 100ms ease}.vcp-harness-disclosure-row:hover .vcp-harness-disclosure-icon-idle{opacity:0}.vcp-harness-disclosure-row:hover .vcp-harness-disclosure-chevron-hover{opacity:1}.vcp-harness-disclosure-title{flex:none;font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary,#50545b)}.vcp-harness-disclosure-chevron,.vcp-harness-disclosure-chevron-hover{width:14px;height:14px}`;
    (document.head || document.documentElement).append(style);
}
function nodes(value) {
    if (!value)
        return [];
    return Array.isArray(value) ? Array.from(value) : [value];
}
function addClasses(element, value) {
    if (value)
        element.classList.add(...value.split(/\s+/).filter(Boolean));
}
function chevron(extraClass, hover = false) {
    const icon = document.createElement('span');
    icon.className = `vcp-ui-icon ${hover ? 'vcp-harness-disclosure-chevron-hover' : 'vcp-harness-disclosure-chevron'}`;
    addClasses(icon, extraClass);
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'chevron_down';
    return icon;
}
/** Controlled Harness DisclosureRow with reversible Light-DOM ownership. */
export function mountDisclosureRow(host, props, scope) {
    if (!host || !props?.icon || typeof props.title !== 'string' || !props.onToggle || !scope)
        throw new TypeError('DisclosureRow requires a host, icon, title, onToggle and scope.');
    ensureStyles();
    const disclosureScope = scope.child('harness-disclosure-row');
    const originalNodes = Array.from(host.childNodes);
    const icon = props.icon;
    const collapsedNodes = nodes(props.collapsedContent);
    const childNodes = nodes(props.children);
    const movableNodes = [icon, ...collapsedNodes, ...childNodes];
    const originalPositions = movableNodes.map(node => ({ node, parent: node.parentNode, next: node.nextSibling }));
    const parked = document.createDocumentFragment();
    const root = document.createElement('div');
    root.className = 'vcp-harness-disclosure-root';
    addClasses(root, props.className);
    const row = document.createElement('div');
    row.className = 'vcp-harness-disclosure-row';
    addClasses(row, props.rowClassName);
    row.dataset.disclosureRow = '';
    const title = document.createElement('span');
    title.className = 'vcp-harness-disclosure-title';
    addClasses(title, props.titleClassName);
    title.textContent = props.title;
    root.append(row);
    host.replaceChildren(root);
    let open = Boolean(props.open);
    let expandable = Boolean(props.expandable);
    let leading = document.createElement('span');
    const rowExpands = () => expandable && Boolean(props.expandOnRowClick);
    const requestToggle = () => { if (expandable)
        props.onToggle(); };
    const renderLeading = () => {
        leading.remove();
        const interactiveLeading = expandable && !rowExpands();
        leading = document.createElement(interactiveLeading ? 'button' : 'span');
        leading.className = 'vcp-harness-disclosure-leading';
        addClasses(leading, props.leadingClassName);
        if (leading.tagName === 'BUTTON') {
            leading.type = 'button';
            leading.setAttribute('aria-expanded', String(open));
        }
        if (open) {
            leading.append(chevron(props.chevronClassName));
        }
        else if (props.previewChevron ?? expandable) {
            const idle = document.createElement('span');
            idle.className = 'vcp-harness-disclosure-icon-idle';
            idle.append(icon);
            leading.append(idle, chevron(props.chevronClassName, true));
        }
        else {
            leading.append(icon);
        }
        row.prepend(leading);
        const icons = globalThis.VCPIcons;
        icons?.refresh(leading);
    };
    const render = () => {
        if (open)
            root.dataset.open = 'true';
        else
            delete root.dataset.open;
        const expands = rowExpands();
        if (expands) {
            row.dataset.expandable = 'true';
            row.setAttribute('role', 'button');
            row.tabIndex = 0;
            row.setAttribute('aria-expanded', String(open));
        }
        else {
            delete row.dataset.expandable;
            row.removeAttribute('role');
            row.removeAttribute('tabindex');
            row.removeAttribute('aria-expanded');
        }
        renderLeading();
        if (!title.parentNode)
            row.append(title);
        if (props.keepContentWhenOpen || !open)
            row.append(...collapsedNodes);
        else
            collapsedNodes.forEach(node => parked.append(node));
        if (open)
            root.append(...childNodes);
        else
            childNodes.forEach(node => parked.append(node));
    };
    disclosureScope.listen(row, 'click', event => {
        if (!rowExpands() || event.target?.parentNode === leading)
            return;
        requestToggle();
    });
    disclosureScope.listen(row, 'keydown', event => {
        if (!rowExpands())
            return;
        const key = event.key;
        if (key !== 'Enter' && key !== ' ')
            return;
        event.preventDefault();
        requestToggle();
    });
    disclosureScope.listen(row, 'click', event => {
        if (event.target === leading || leading.contains(event.target)) {
            event.stopPropagation();
            if (leading.tagName === 'BUTTON')
                requestToggle();
        }
    }, { capture: true });
    render();
    const restoreNodes = () => {
        originalPositions.slice().reverse().forEach(({ node, parent, next }) => {
            if (!parent) {
                node.remove();
                return;
            }
            if (next?.parentNode === parent)
                parent.insertBefore(node, next);
            else
                parent.append(node);
        });
    };
    // `scope.child()` already registers this owner with its parent.  Keep the
    // primitive teardown inside that child instead of also registering an
    // equivalent parent disposer; one DisclosureRow must contribute one
    // lifecycle branch, not two synonymous parent records.
    disclosureScope.own(async () => {
        restoreNodes();
        host.replaceChildren(...originalNodes);
    }, 'harness-disclosure-row', 'ui-primitive');
    const dispose = () => disclosureScope.dispose('harness-disclosure-row-unmounted');
    return {
        root,
        row,
        get leading() { return leading; },
        get open() { return open; },
        get expandable() { return expandable; },
        setOpen(value) { open = value; render(); },
        setExpandable(value) { expandable = value; render(); },
        setTitle(value) { title.textContent = value; },
        dispose,
    };
}
/**
 * Adopt an existing Light-DOM disclosure header without replacing its child
 * nodes.  This is intentionally not a general DOM renderer: callers keep the
 * business DOM and supply the canonical open state through setOpen().
 */
export function mountDisclosureRowController(host, props, scope) {
    if (!host || !props?.content || !props?.onToggle || !scope) {
        throw new TypeError('DisclosureRowController requires a host, content, onToggle and scope.');
    }
    ensureStyles();
    const disclosureScope = scope.child('harness-disclosure-row-controller');
    const trackedAttributes = ['class', 'role', 'tabindex', 'aria-controls', 'aria-expanded'];
    const originals = new Map(trackedAttributes.map(name => [name, host.getAttribute(name)]));
    const toggle = props.toggle || null;
    const toggleControls = toggle?.getAttribute('aria-controls') ?? null;
    const toggleExpanded = toggle?.getAttribute('aria-expanded') ?? null;
    let open = Boolean(props.open);
    let expandable = Boolean(props.expandable);
    if (!props.content.id)
        props.content.id = `${host.id || 'disclosure'}-content`;
    host.classList.add('vcp-harness-disclosure-row');
    addClasses(host, props.className);
    host.dataset.disclosureRow = '';
    const render = () => {
        if (expandable) {
            host.dataset.expandable = 'true';
            // Existing production DOM keeps a native toggle button.  It is
            // the sole semantic/keyboard command owner; assigning role=button
            // to its ancestor would create invalid nested button semantics.
            if (toggle) {
                host.removeAttribute('role');
                host.removeAttribute('tabindex');
                host.removeAttribute('aria-controls');
                host.removeAttribute('aria-expanded');
                toggle.setAttribute('aria-controls', props.content.id);
                toggle.setAttribute('aria-expanded', String(open));
            }
            else {
                host.setAttribute('role', 'button');
                host.tabIndex = 0;
                host.setAttribute('aria-controls', props.content.id);
                host.setAttribute('aria-expanded', String(open));
            }
        }
        else {
            delete host.dataset.expandable;
            host.removeAttribute('role');
            host.removeAttribute('tabindex');
            host.removeAttribute('aria-controls');
            host.removeAttribute('aria-expanded');
            toggle?.removeAttribute('aria-controls');
            toggle?.removeAttribute('aria-expanded');
        }
    };
    const requestToggle = () => { if (expandable)
        props.onToggle(); };
    disclosureScope.listen(host, 'click', event => {
        if (!expandable)
            return;
        event.preventDefault();
        requestToggle();
    });
    disclosureScope.listen(host, 'keydown', event => {
        if (!expandable || toggle)
            return;
        const key = event.key;
        if (key !== 'Enter' && key !== ' ')
            return;
        event.preventDefault();
        requestToggle();
    });
    if (toggle)
        disclosureScope.listen(toggle, 'keydown', event => {
            if (!expandable)
                return;
            const key = event.key;
            if (key !== 'Enter' && key !== ' ')
                return;
            event.preventDefault();
            requestToggle();
        });
    render();
    // The parent owns `disclosureScope` through child(), so placing this
    // reversible DOM cleanup on the child avoids a duplicate parent record
    // while retaining explicit, quiescent controller disposal.
    disclosureScope.own(async () => {
        delete host.dataset.disclosureRow;
        delete host.dataset.expandable;
        trackedAttributes.forEach(name => {
            const value = originals.get(name);
            if (value === null || value === undefined)
                host.removeAttribute(name);
            else
                host.setAttribute(name, value);
        });
        if (toggle) {
            if (toggleControls === null)
                toggle.removeAttribute('aria-controls');
            else
                toggle.setAttribute('aria-controls', toggleControls);
            if (toggleExpanded === null)
                toggle.removeAttribute('aria-expanded');
            else
                toggle.setAttribute('aria-expanded', toggleExpanded);
        }
    }, 'harness-disclosure-row-controller', 'ui-primitive');
    const dispose = () => disclosureScope.dispose('harness-disclosure-row-controller-unmounted');
    return {
        host,
        get open() { return open; },
        get expandable() { return expandable; },
        setOpen(value) { open = Boolean(value); render(); },
        setExpandable(value) { expandable = Boolean(value); render(); },
        dispose,
    };
}
