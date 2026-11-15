import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createMathRenderer } from '../modules/renderer/mathRenderer.js';
import { createContentProcessor } from '../modules/renderer/contentProcessor.js';

const katexSource = readFileSync(new URL('../vendor/katex.min.js', import.meta.url), 'utf8');
const autoSource = readFileSync(new URL('../vendor/auto-render.min.js', import.meta.url), 'utf8');

function fixture(text = '') {
    const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { runScripts: 'outside-only' });
    dom.window.eval(katexSource);
    dom.window.eval(autoSource);
    const root = dom.window.document.getElementById('root');
    root.textContent = text;
    return { dom, root };
}

test('formula strings match bundled auto-render, including brace groups, errors and adjacent text', () => {
    const source = String.raw`before \(x^2+\frac{1}{2}\) $$\int_0^1 x\,dx$$ \[\sqrt{a_b}\] \(\text{a \) b}\) \(\unknowncommand\) after`;
    const { dom, root } = fixture(source);
    const reference = root.cloneNode(true);
    dom.window.renderMathInElement(reference, {
        delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true },
        ],
        throwOnError: false,
    });
    const renderer = createMathRenderer();
    renderer.processSync(root);
    // renderToString uses compact style serialization and explicit MathML mtext;
    // katex.render uses DOM setters. Compare semantics and the visible layout tree.
    const projection = element => ({
        text: element.textContent,
        sources: [...element.querySelectorAll('annotation')].map(node => node.textContent),
        display: element.querySelectorAll('.katex-display').length,
        errors: [...element.querySelectorAll('.katex-error')].map(node => node.textContent),
        layout: [...element.querySelectorAll('.katex-html *')].map(node => [node.tagName, node.getAttribute('class') || '']),
        paths: [...element.querySelectorAll('svg path')].map(node => node.getAttribute('d')),
    });
    assert.deepEqual(projection(root), projection(reference));
    const once = root.innerHTML;
    renderer.processSync(root);
    assert.equal(root.innerHTML, once, 'already typeset subtrees must be opaque');
    renderer.dispose();
    dom.window.close();
});

test('cache survives fresh DOM, distinguishes display mode, and invalidates on engine replacement', () => {
    const { dom, root } = fixture(String.raw`\(x\) \(x\) $$x$$`);
    const renderer = createMathRenderer();
    renderer.processSync(root);
    assert.equal(renderer.getStats().misses, 2);
    assert.equal(renderer.getStats().hits, 1);
    root.textContent = String.raw`\(x\) $$x$$`;
    renderer.processSync(root);
    assert.equal(renderer.getStats().hits, 3);
    assert.equal(root.querySelectorAll('.katex').length, 2);
    dom.window.katex = { renderToString: () => '<span class="katex">new engine</span>' };
    root.textContent = String.raw`\(x\)`;
    renderer.processSync(root);
    assert.equal(root.textContent, 'new engine');
    assert.equal(renderer.getStats().entries, 1);
    renderer.dispose();
    assert.equal(renderer.getStats().bytes, 0);
    dom.window.close();
});

test('LRU budgets include keys and strings, oversized entries bypass cache', () => {
    const { dom, root } = fixture();
    dom.window.katex = { renderToString: source => `<span class="katex">${source}</span>` };
    const renderer = createMathRenderer({ maxBytes: 256, maxSingleBytes: 128, maxEntries: 1 });
    for (const source of ['x', 'y', 'x', 'z'.repeat(200)]) {
        root.textContent = `\\(${source}\\)`;
        renderer.processSync(root);
        assert.ok(renderer.getStats().bytes <= 256);
        assert.ok(renderer.getStats().entries <= 1);
    }
    assert.equal(renderer.getStats().evictions, 2);
    assert.equal(renderer.getStats().misses, 4);
    renderer.dispose();
    dom.window.close();
});

test('macro definitions are not cached and macro state never leaks between messages', () => {
    const { dom, root } = fixture(String.raw`\(\gdef\foo{z}\) \(\foo+1\)`);
    const renderer = createMathRenderer();
    renderer.processSync(root);
    assert.equal(root.querySelector('.katex-error'), null);
    assert.equal(renderer.getStats().entries, 0);
    root.textContent = String.raw`\(\foo+1\)`;
    renderer.processSync(root);
    assert.match(root.querySelector('.katex-html').textContent, /\\foo/, 'new message must not inherit gdef');
    renderer.dispose();
    dom.window.close();
});

test('a single text node with hundreds of formulas yields and cancellation stops later writes', async () => {
    const { dom, root } = fixture(Array.from({ length: 760 }, (_, i) => `\\(x_${i}\\)`).join(' '));
    const renderer = createMathRenderer({ maxPerSlice: 4, budgetMs: Infinity });
    let valid = true;
    let heartbeat = false;
    dom.window.setTimeout(() => { heartbeat = true; valid = false; }, 0);
    await renderer.processAsync(root, { isValid: () => valid });
    assert.equal(heartbeat, true);
    assert.equal(root.querySelectorAll('.katex').length, 4);
    assert.match(root.textContent, /\\\(x_759\\\)/);
    assert.equal(renderer.getStats().yields, 1);
    renderer.dispose();
    dom.window.close();
});

test('disposing while a slice is pending settles the task and prevents later writes', async () => {
    const { dom, root } = fixture(String.raw`\(x\) \(y\) \(z\)`);
    const renderer = createMathRenderer({ maxPerSlice: 1 });
    const running = renderer.processAsync(root);
    renderer.dispose();
    const html = root.innerHTML;
    await running;
    assert.equal(root.innerHTML, html);
    assert.equal(root.querySelectorAll('.katex').length, 1);
    assert.equal(renderer.getStats().entries, 0);
    dom.window.close();
});

test('math merges adjacent text nodes but never pairs delimiters across elements or code domains', () => {
    const { dom, root } = fixture();
    root.append('\\(', 'x', '\\)');
    const paragraph = dom.window.document.createElement('p');
    paragraph.innerHTML = String.raw`<b>\(y</b><i>\)</i><code>\(z\)</code><span class="mermaid">\(w\)</span>`;
    root.append(paragraph);
    const renderer = createMathRenderer();
    renderer.processSync(root);
    assert.equal(root.querySelectorAll('.katex').length, 1);
    assert.equal(paragraph.querySelector('code').textContent, String.raw`\(z\)`);
    assert.equal(paragraph.querySelector('.mermaid').textContent, String.raw`\(w\)`);
    renderer.dispose();
    dom.window.close();
});

test('highlight and dollar scans prune entire KaTeX subtrees while preserving strong prose', () => {
    const { dom, root } = fixture();
    root.innerHTML = '<strong>"hello" @tag</strong><button>"label"</button><span class="katex"><span>"math" @bad $x$</span></span>';
    const math = root.querySelector('.katex');
    for (let i = 0; i < 1000; i++) math.appendChild(math.firstChild.cloneNode(true));
    const original = math.innerHTML;
    const createWalker = dom.window.document.createTreeWalker.bind(dom.window.document);
    let visits = 0;
    dom.window.document.createTreeWalker = (node, show, filter, ...args) => {
        // jsdom's selector implementation also creates walkers internally.
        if (show !== (dom.window.NodeFilter.SHOW_ELEMENT | dom.window.NodeFilter.SHOW_TEXT)
            || typeof filter !== 'function') return createWalker(node, show, filter, ...args);
        return createWalker(node, show, candidate => {
            visits++;
            assert.equal(candidate.parentElement?.closest('.katex') || null, null, 'must not even visit formula descendants');
            return filter(candidate);
        }, ...args);
    };
    const processor = createContentProcessor();
    processor.highlightAllPatternsInMessage(root);
    assert.equal(root.querySelectorAll('strong .highlighted-quote').length, 1);
    assert.equal(root.querySelectorAll('strong .highlighted-tag').length, 1);
    assert.equal(root.querySelector('button').innerHTML, '"label"');
    // Exercise normalization without invoking a second independent auto-render traversal.
    delete dom.window.katex;
    delete dom.window.renderMathInElement;
    processor.processRenderedContent(root, { enableAiMessageButtons: false });
    assert.equal(math.innerHTML, original);
    assert.ok(visits < 30, `unexpected traversal volume: ${visits}`);
    processor.dispose();
    dom.window.close();
});

test('async content processing keeps safe-dollar and price rules', async () => {
    const { dom, root } = fixture('price $19.99, next $29.99. Formula $a+b$ and $x$.');
    const processor = createContentProcessor();
    await processor.processRenderedContentAsync(root, { enableAiMessageButtons: false });
    assert.equal(root.querySelectorAll('.katex').length, 2);
    assert.match(root.textContent, /price \$19.99, next \$29.99/);
    processor.dispose();
    dom.window.close();
});