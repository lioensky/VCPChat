const lines = (text) => text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
/** Candidate-only frozen-domain fixture. It never consumes VCP tool or chat state. */
export function mountDiffBlock(host, props, scope) {
    const original = Array.from(host.childNodes);
    const block = document.createElement('div');
    block.className = 'vcp-harness-diff-block';
    block.dataset.diff = '';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'vcp-harness-diff-copy';
    copy.textContent = 'Copy';
    const body = document.createElement('div');
    body.className = 'vcp-harness-diff-body';
    const footer = document.createElement('div');
    footer.className = 'vcp-harness-diff-footer';
    let expanded = false;
    const rows = props.diffs.flatMap((diff, index) => [{ kind: index && props.diffs[index - 1].path === diff.path ? 'gap' : 'path', text: index && props.diffs[index - 1].path === diff.path ? '...' : diff.path }, ...((diff.oldText === null ? [] : lines(diff.oldText)).map(text => ({ kind: 'del', text }))), ...lines(diff.newText).map(text => ({ kind: 'add', text }))]);
    const render = () => { body.replaceChildren(); const max = props.maxLines ?? 16; const capped = !expanded && rows.length > max; const shown = capped ? [...rows.slice(0, Math.ceil(max / 2)), { kind: 'expand', text: `... ${rows.length - max} more lines` }, ...rows.slice(rows.length - Math.floor(max / 2))] : rows; for (const row of shown) {
        const node = document.createElement(row.kind === 'expand' ? 'button' : 'div');
        node.className = `vcp-harness-diff-${row.kind}`;
        node.textContent = row.text;
        if (row.kind === 'expand') {
            node.type = 'button';
            node.setAttribute('aria-expanded', String(expanded));
            node.addEventListener('click', () => { expanded = true; render(); });
        }
        body.append(node);
    } const added = rows.filter(row => row.kind === 'add').length, removed = rows.filter(row => row.kind === 'del').length; footer.textContent = `|- +${added} -${removed} · ${new Set(props.diffs.map(x => x.path)).size} file(s)`; };
    copy.addEventListener('click', () => { void props.copy?.(rows.map(row => row.kind === 'add' ? `+ ${row.text}` : row.kind === 'del' ? `- ${row.text}` : row.text).join('\n')); copy.textContent = 'Copied'; });
    render();
    block.append(copy, body, footer);
    host.replaceChildren(block);
    const dispose = scope.own(() => host.replaceChildren(...original), 'harness-diff-block', 'ui-primitive');
    return { root: block, get expanded() { return expanded; }, setExpanded(value) { expanded = value; render(); }, dispose };
}
