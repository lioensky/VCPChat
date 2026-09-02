const STYLE_ID = 'vcp-uiux-uiux-choice';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-uiux-choice{display:flex;flex-wrap:wrap;gap:8px}.vcp-uiux-choice-option{display:inline-flex;align-items:center;min-height:30px;padding:0 10px;border:1px solid var(--vcp-color-border,#c8ccd4);border-radius:15px;background:transparent;color:inherit;font-size:14px;line-height:22px;cursor:pointer}.vcp-uiux-choice-option:has(input:checked){background:var(--vcp-color-surface-selected,#eef3ff);border-color:var(--vcp-color-brand,#1677ff)}.vcp-uiux-choice-option input{position:absolute;opacity:0;pointer-events:none}`;
    (document.head || document.documentElement).append(style);
}
export function mountChoice(root, scope) {
    if (!root || !scope)
        throw new TypeError('Choice requires root and scope.');
    ensureStyles();
    const labels = Array.from(root.querySelectorAll('label'))
        .filter(label => label.querySelector('input[type="radio"]'));
    root.classList.add('vcp-uiux-choice');
    labels.forEach(label => label.classList.add('vcp-uiux-choice-option'));
    // dataset.value mirrors the checked radio; vcp-uiux-sync re-derives it
    // from the group so host-driven programmatic writes (snapshot replay)
    // converge like user-driven change events.
    const sync = bindChoiceBehavior(root, labels, scope);
    return scope.own(() => { root.classList.remove('vcp-uiux-choice'); delete root.dataset.value; labels.forEach(label => label.classList.remove('vcp-uiux-choice-option')); }, 'uiux-choice', 'ui-primitive');
}

// Shared value-mirroring behavior for both mount paths. The mount path adds
// the presentation classes itself; the activation path (settings schema
// surface, M5-c pass5) finds them already emitted by the renderer and only
// binds the change/vcp-uiux-sync re-derivation.
function bindChoiceBehavior(root, labels, scope) {
    const sync = () => { const checked = labels.map(label => label.querySelector('input[type="radio"]')).find(input => input?.checked); if (checked)
        root.dataset.value = checked.value; };
    labels.forEach(label => {
        const input = label.querySelector('input[type="radio"]');
        if (input) {
            scope.listen(input, 'change', sync);
            scope.listen(input, 'vcp-uiux-sync', sync);
        }
    });
    sync();
    return sync;
}

// Activation counterpart for renderer-emitted Choice structure: the classes
// and the initial dataset.value are already in the markup, so this only
// injects the stylesheet (no other mountChoice call site remains on the
// settings surface) and binds the behavior. Dispose keeps the static
// structure; the scope owns the listeners.
export function activateChoice(root, scope) {
    if (!root || !scope)
        throw new TypeError('Choice requires root and scope.');
    if (!root.classList.contains('vcp-uiux-choice'))
        throw new TypeError('activateChoice requires renderer-emitted choice structure.');
    ensureStyles();
    const labels = Array.from(root.querySelectorAll('label'))
        .filter(label => label.querySelector('input[type="radio"]'));
    bindChoiceBehavior(root, labels, scope);
    return scope.own(() => { }, 'uiux-choice-activated', 'ui-primitive');
}
