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
    // dataset.value mirrors the checked radio; vcp-uiux-sync re-derives it
    // from the group so host-driven programmatic writes (snapshot replay)
    // converge like user-driven change events.
    const sync = () => { const checked = labels.map(label => label.querySelector('input[type="radio"]')).find(input => input?.checked); if (checked)
        root.dataset.value = checked.value; };
    labels.forEach(label => {
        label.classList.add('vcp-uiux-choice-option');
        const input = label.querySelector('input[type="radio"]');
        if (input) {
            scope.listen(input, 'change', sync);
            scope.listen(input, 'vcp-uiux-sync', sync);
        }
    });
    sync();
    return scope.own(() => { root.classList.remove('vcp-uiux-choice'); delete root.dataset.value; labels.forEach(label => label.classList.remove('vcp-uiux-choice-option')); }, 'uiux-choice', 'ui-primitive');
}
