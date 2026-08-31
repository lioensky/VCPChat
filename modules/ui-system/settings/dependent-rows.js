// data-visible-when — declarative visibility for conditional settings rows
// (Phase 3 row flattening).  A flattened dependent row carries
// `data-visible-when="clause && clause"` where each clause is either a
// checkbox/radio control id (visible while checked) or `id=value` (visible
// while the native control holds that value).  The native controls stay the
// canonical business state; this module only projects that state onto the
// row's inline display so the row itself — not a wrapper container — owns its
// visibility.  Unknown sources fail open: a renamed control must not be able
// to silently hide its row.

export function evaluateVisibleWhen(root, expression) {
    if (!expression) return true;
    return String(expression).split('&&').every(clause => {
        const trimmed = clause.trim();
        if (!trimmed) return true;
        const valueMatch = trimmed.match(/^([A-Za-z][\w-]*)\s*=\s*(.+)$/);
        const sourceId = valueMatch ? valueMatch[1] : trimmed;
        const source = root.querySelector(`#${sourceId}`);
        if (!source) return true;
        if (valueMatch) {
            const expected = valueMatch[2].trim().replace(/^["']|["']$/g, '');
            return source.value === expected;
        }
        return source.checked !== false;
    });
}

export function syncDependentRows(root) {
    if (!root) return;
    root.querySelectorAll('[data-visible-when]').forEach(row => {
        // '' restores the row's CSS-driven display (the uiux row grid);
        // only the hidden state is forced inline.
        row.style.display = evaluateVisibleWhen(root, row.dataset.visibleWhen) ? '' : 'none';
    });
}
