import { mountMenu } from './menu.js';
const STYLE_ID = 'vcp-harness-uiux-language-row';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-language-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.vcp-harness-language-row-text{flex:1;min-width:0}.vcp-harness-language-row-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-harness-language-row-selector{display:inline-flex;align-items:center;gap:12px;height:36px;padding:0 14px;border:0;border-radius:18px;background:var(--dsw-alias-bg-module-platform,rgb(245,246,247));font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#0f1115);cursor:pointer}.vcp-harness-language-row-selector:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-harness-language-row-selector:disabled{cursor:default;opacity:.5}.vcp-harness-language-row-chevron{display:block;flex:none;width:14px;height:14px}`;
    (document.head || document.documentElement).append(style);
}
function makeChevron() {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.classList.add('vcp-harness-language-row-chevron');
    node.setAttribute('viewBox', '0 0 14 14');
    node.setAttribute('fill', 'none');
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('focusable', 'false');
    node.innerHTML = '<path d="M3 5L7 9L11 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
    return node;
}
/** Candidate-only Light-DOM replication of Harness locale/LanguageRow. */
export function mountLanguageRow(host, props, scope) {
    if (!host || !props?.options || !props?.onSelect || !scope)
        throw new TypeError('LanguageRow requires a host, options, onSelect and scope.');
    ensureStyles();
    const rowScope = scope.child('harness-language-row');
    const originalChildren = Array.from(host.childNodes);
    const row = document.createElement('div');
    row.className = 'vcp-harness-language-row';
    const text = document.createElement('div');
    text.className = 'vcp-harness-language-row-text';
    const title = document.createElement('div');
    title.className = 'vcp-harness-language-row-title';
    title.textContent = props.title ?? 'Language';
    text.append(title);
    if (props.description) {
        const description = document.createElement('div');
        description.className = 'vcp-harness-language-row-description';
        description.textContent = props.description;
        text.append(description);
    }
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'vcp-harness-language-row-selector';
    const label = document.createTextNode('');
    trigger.append(label, makeChevron());
    row.append(text, trigger);
    host.append(row);
    let options = [...props.options];
    let activeId = props.activeId ?? '';
    let loading = Boolean(props.loading);
    let menuScope = scope.child('harness-language-row-menu');
    let menuController;
    let optionsGeneration = 0;
    // Rebuilds are serialized so one replacement owns the menu scope at a
    // time. A newer generation cancels the publication step of older work.
    let rebuildQueue = Promise.resolve();
    const buildMenu = () => { menuController = mountMenu(trigger, { portal: true, align: 'end', items: options.map(option => ({ id: option.id, label: option.label, disabled: option.disabled })), selectedId: activeId, onSelect: id => { menuController.setOpen(false); props.onSelect(id); }, onClose: () => props.onClose?.() }, menuScope); };
    const sync = () => { const selected = options.find(option => option.id === activeId); label.textContent = loading ? 'Loading...' : (selected?.label || activeId || 'Select language'); trigger.disabled = loading || options.length === 0 || options.every(option => option.disabled); menuController.setSelected(activeId); };
    buildMenu();
    sync();
    rowScope.listen(trigger, 'click', () => menuController.setOpen(!menuController.open));
    const rebuild = (generation) => {
        const task = rebuildQueue.then(async () => {
            await menuScope.dispose('harness-language-row-menu-rebuild');
            if (!scope.active || generation !== optionsGeneration)
                return;
            menuScope = scope.child('harness-language-row-menu');
            buildMenu();
            sync();
        });
        // Keep later replacements moving after a cancelled/rejected rebuild,
        // while preserving the original task result for the caller.
        rebuildQueue = task.catch(() => undefined);
        return task;
    };
    const dispose = scope.own(async () => {
        // Invalidate every queued rebuild before waiting for quiescence. This
        // prevents a late continuation from creating a child scope after close.
        optionsGeneration += 1;
        await rowScope.dispose('harness-language-row-unmounted');
        await menuScope.dispose('harness-language-row-menu-unmounted');
        await rebuildQueue;
        row.remove();
        host.replaceChildren(...originalChildren);
    }, 'harness-language-row', 'ui-primitive');
    return {
        root: row,
        trigger,
        get menu() { return menuController; },
        get open() { return menuController.open; },
        setOptions: next => { options = [...next]; return rebuild(++optionsGeneration); },
        setActive(next) { activeId = next ?? ''; sync(); },
        setLoading(next) { loading = Boolean(next); sync(); },
        setOpen(value) { menuController.setOpen(value); },
        dispose,
    };
}
