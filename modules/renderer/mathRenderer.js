const IGNORED = 'script, noscript, style, textarea, pre, code, .katex, .katex-display, .mermaid, .mermaid-placeholder';
const DELIMITERS = [
    { left: '$$', right: '$$', displayMode: true },
    { left: '\\(', right: '\\)', displayMode: false },
    { left: '\\[', right: '\\]', displayMode: true },
];

// Same closing-delimiter rules as KaTeX auto-render: escaped characters and
// brace groups cannot close an expression. Delimiters never cross elements.
function* expressions(text) {
    let cursor = 0;
    while (cursor < text.length) {
        let start = -1;
        let delimiter;
        for (const candidate of DELIMITERS) {
            const index = text.indexOf(candidate.left, cursor);
            if (index >= 0 && (start < 0 || index < start)) {
                start = index;
                delimiter = candidate;
            }
        }
        if (start < 0) return;
        let depth = 0;
        let end = start + delimiter.left.length;
        for (; end < text.length; end++) {
            if (depth <= 0 && text.startsWith(delimiter.right, end)) break;
            if (text[end] === '\\') end++;
            else if (text[end] === '{') depth++;
            else if (text[end] === '}') depth--;
        }
        if (end >= text.length) return;
        const finish = end + delimiter.right.length;
        yield { start, finish, source: text.slice(start + delimiter.left.length, end), displayMode: delimiter.displayMode };
        cursor = finish;
    }
}

function textRuns(root) {
    const document = root.ownerDocument;
    const filter = document.defaultView.NodeFilter;
    if (root.matches?.(IGNORED) || root.closest?.('.katex, .katex-display')) return [];
    const walker = document.createTreeWalker(root, filter.SHOW_ELEMENT | filter.SHOW_TEXT, node => {
        if (node.nodeType === 1) return node.matches(IGNORED) ? filter.FILTER_REJECT : filter.FILTER_SKIP;
        return filter.FILTER_ACCEPT;
    });
    const runs = [];
    let node;
    let previous;
    while ((node = walker.nextNode())) {
        if (previous?.nextSibling === node) runs[runs.length - 1].push(node);
        else runs.push([node]);
        previous = node;
    }
    return runs;
}

/** Renderer-owned, bounded inert formula strings; never retains message DOM. */
export function createMathRenderer({
    maxBytes = 12 * 1024 * 1024,
    maxEntries = 1000,
    maxSingleBytes = 256 * 1024,
    budgetMs = 6,
    maxPerSlice = 16,
    now = () => performance.now(),
} = {}) {
    const cache = new Map();
    let bytes = 0;
    let engine = null;
    let disposed = false;
    let pendingYield = null;
    let sliceStart = now();
    let sliceCount = 0;
    const stats = { hits: 0, misses: 0, evictions: 0, yields: 0 };

    function clear() {
        cache.clear();
        bytes = 0;
    }

    function render(source, displayMode, katex, macros) {
        if (engine !== katex) { clear(); engine = katex; }
        // Definitions mutate the per-message macro environment. Never cache
        // definitions, or any formula evaluated with an existing macro state.
        const cacheable = Object.keys(macros).length === 0
            && !/\\(?:gdef|def|edef|xdef|global|let|futurelet|newcommand|renewcommand|providecommand)\b/.test(source);
        const key = JSON.stringify([displayMode, source]);
        if (cacheable && cache.has(key)) {
            const entry = cache.get(key);
            cache.delete(key);
            cache.set(key, entry);
            stats.hits++;
            return entry.html;
        }
        stats.misses++;
        const html = katex.renderToString(source, { displayMode, throwOnError: false, macros, trust: false });
        const size = (key.length + html.length) * 2;
        if (cacheable && Object.keys(macros).length === 0 && size <= maxSingleBytes && size <= maxBytes) {
            cache.set(key, { html, size });
            bytes += size;
            while (bytes > maxBytes || cache.size > maxEntries) {
                const oldest = cache.keys().next().value;
                bytes -= cache.get(oldest).size;
                cache.delete(oldest);
                stats.evictions++;
            }
        }
        return html;
    }

    function* process(root, isValid) {
        const katex = root.ownerDocument.defaultView?.katex;
        if (!katex?.renderToString) {
            // Compatibility for embedders that provide only auto-render.
            if (isValid()) root.ownerDocument.defaultView?.renderMathInElement?.(root, {
                delimiters: DELIMITERS.map(({ left, right, displayMode }) => ({ left, right, display: displayMode })),
                ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
                ignoredClasses: ['katex', 'katex-display', 'mermaid', 'mermaid-placeholder'],
                throwOnError: false,
            });
            return;
        }
        const macros = {};
        for (const nodes of textRuns(root)) {
            if (!isValid()) return;
            const text = nodes.map(node => node.data).join('');
            let tail = nodes[0];
            let consumed = 0;
            let merged = false;
            for (const expression of expressions(text)) {
                if (!isValid() || !tail.parentNode || !root.contains(tail)) return;
                if (!merged) {
                    tail.data = text;
                    nodes.slice(1).forEach(node => node.remove());
                    merged = true;
                }
                const html = render(expression.source, expression.displayMode, katex, macros);
                if (!isValid()) return;
                const formula = tail.splitText(expression.start - consumed);
                tail = formula.splitText(expression.finish - expression.start);
                const wrapper = root.ownerDocument.createElement('span');
                wrapper.innerHTML = html;
                formula.replaceWith(wrapper);
                consumed = expression.finish;
                yield;
            }
        }
    }

    function yieldTask(ownerWindow) {
        if (pendingYield) return pendingYield.promise;
        stats.yields++;
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        const task = { promise, resolve, ownerWindow, id: null };
        pendingYield = task;
        task.id = ownerWindow.setTimeout(() => {
            if (pendingYield === task) pendingYield = null;
            sliceStart = now();
            sliceCount = 0;
            resolve();
        }, 0);
        return promise;
    }

    return Object.freeze({
        processSync(root) {
            if (disposed) return;
            for (const _ of process(root, () => !disposed)) { /* synchronous compatibility */ }
        },
        async processAsync(root, { isValid = () => true } = {}) {
            if (disposed || !isValid()) return;
            for (const _ of process(root, () => !disposed && isValid())) {
                sliceCount++;
                if (sliceCount >= maxPerSlice || now() - sliceStart >= budgetMs) {
                    await yieldTask(root.ownerDocument.defaultView);
                    if (disposed || !isValid()) return;
                }
            }
        },
        getStats: () => ({ ...stats, entries: cache.size, bytes }),
        clear,
        dispose() {
            disposed = true;
            clear();
            engine = null;
            if (pendingYield) {
                const task = pendingYield;
                pendingYield = null;
                task.ownerWindow.clearTimeout(task.id);
                task.resolve();
            }
        },
    });
}