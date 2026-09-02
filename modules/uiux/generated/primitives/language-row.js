import { mountMenu } from './menu.js';
const STYLE_ID = 'vcp-uiux-uiux-language-row';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-uiux-language-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.vcp-uiux-language-row-text{flex:1;min-width:0}.vcp-uiux-language-row-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-uiux-language-row-selector{display:inline-flex;align-items:center;gap:12px;height:36px;padding:0 14px;border:0;border-radius:18px;background:var(--dsw-alias-bg-module-platform,rgb(245,246,247));font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#0f1115);cursor:pointer}.vcp-uiux-language-row-selector:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-uiux-language-row-selector:disabled{cursor:default;opacity:.5}.vcp-uiux-language-row-chevron{display:block;flex:none;width:14px;height:14px}`;
    (document.head || document.documentElement).append(style);
}
function makeChevron() {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.classList.add('vcp-uiux-language-row-chevron');
    node.setAttribute('viewBox', '0 0 14 14');
    node.setAttribute('fill', 'none');
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('focusable', 'false');
    node.innerHTML = '<path d="M3 5L7 9L11 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
    return node;
}
// 行为运行时：M5-c pass4 起全局设置面的语言行结构由 field-renderer 静态直出
// （buildLanguageRowStructure），本函数承载 mount 与 activateLanguageRow 共用的
// 菜单/标签/重建队列行为；onFinalDispose 区分两条路径的收尾——mount 移除结构
// 并还原宿主子节点，激活路径保留直出结构。
function createLanguageRowController(row, trigger, label, props, scope, onFinalDispose) {
    const rowScope = scope.child('uiux-language-row');
    let options = [...props.options];
    let activeId = props.activeId ?? '';
    let loading = Boolean(props.loading);
    let menuScope = scope.child('uiux-language-row-menu');
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
            await menuScope.dispose('uiux-language-row-menu-rebuild');
            if (!scope.active || generation !== optionsGeneration)
                return;
            menuScope = scope.child('uiux-language-row-menu');
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
        await rowScope.dispose('uiux-language-row-unmounted');
        await menuScope.dispose('uiux-language-row-menu-unmounted');
        await rebuildQueue;
        onFinalDispose();
    }, 'uiux-language-row', 'ui-primitive');
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
/** Candidate-only Light-DOM replication of Uiux locale/LanguageRow. */
export function mountLanguageRow(host, props, scope) {
    if (!host || !props?.options || !props?.onSelect || !scope)
        throw new TypeError('LanguageRow requires a host, options, onSelect and scope.');
    ensureStyles();
    const originalChildren = Array.from(host.childNodes);
    const row = document.createElement('div');
    row.className = 'vcp-uiux-language-row';
    const text = document.createElement('div');
    text.className = 'vcp-uiux-language-row-text';
    const title = document.createElement('div');
    title.className = 'vcp-uiux-language-row-title';
    title.textContent = props.title ?? 'Language';
    text.append(title);
    if (props.description) {
        const description = document.createElement('div');
        description.className = 'vcp-uiux-language-row-description';
        description.textContent = props.description;
        text.append(description);
    }
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'vcp-uiux-language-row-selector';
    const label = document.createTextNode('');
    trigger.append(label, makeChevron());
    row.append(text, trigger);
    host.append(row);
    return createLanguageRowController(row, trigger, label, props, scope, () => {
        row.remove();
        host.replaceChildren(...originalChildren);
    });
}
// 直出结构激活：对 field-renderer 静态产出的 .vcp-uiux-language-row 只绑行为，
// 不重建结构（标题/描述/触发按钮/箭头均已在渲染期定型；标签文本节点按
// trigger 首个文本子节点原位改写）。dispose 只拆菜单与监听，直出结构保留。
export function activateLanguageRow(host, props, scope) {
    if (!host || !props?.options || !props?.onSelect || !scope)
        throw new TypeError('LanguageRow activation requires a host, options, onSelect and scope.');
    ensureStyles();
    const row = host.querySelector(':scope > .vcp-uiux-language-row');
    const trigger = row?.querySelector(':scope > .vcp-uiux-language-row-selector');
    const label = [...trigger?.childNodes ?? []].find(node => node.nodeType === 3);
    if (!row || !trigger || !label)
        throw new Error('LanguageRow activation requires the static row structure (selector button with a label text node).');
    return createLanguageRowController(row, trigger, label, props, scope, () => { });
}
