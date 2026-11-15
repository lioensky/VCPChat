'use strict';

// Run: node --test tests/scriptorium-source-normalization.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');

const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'ScriptoriumModules', 'vdoc-core.js'), 'utf8');
const moduleSha256 = createHash('sha256').update(moduleSource).digest('hex');
const editorAttributes = new Set([
    'data-vdoc-text', 'data-vdoc-block', 'data-vdoc-removable',
    'data-vdoc-container', 'data-vdoc-preserve',
]);

function runtime(t) {
    const dom = new JSDOM('<!doctype html><body></body>');
    const context = vm.createContext({ window: dom.window, document: dom.window.document,
        Node: dom.window.Node, TextDecoder, TextEncoder, console });
    vm.runInContext(moduleSource, context, { filename: 'vdoc-core.js' });
    t.after(() => dom.window.close());
    return { core: dom.window.VDocCore, document: dom.window.document };
}

function fragment(document, source) {
    const template = document.createElement('template');
    template.innerHTML = source;
    return template.content;
}

function snapshot(root) {
    const visit = node => {
        if (node.nodeType === 3 || node.nodeType === 8) return [node.nodeType, node.nodeValue];
        assert.equal(node.nodeType, 1);
        const attributes = [...node.attributes].filter(attr => !editorAttributes.has(attr.name))
            .map(attr => [attr.namespaceURI, attr.name, attr.value]);
        const children = node.content || node;
        return [node.namespaceURI, node.localName, attributes, [...children.childNodes].map(visit)];
    };
    return [...root.childNodes].map(visit);
}

function assertCycles(document, core, source, expected, count = 8) {
    let current = source;
    let first;
    for (let cycle = 0; cycle < count; cycle += 1) {
        current = core.normalizeCompleteSlideSource(current);
        assert.deepEqual(snapshot(fragment(document, current)), expected, `cycle ${cycle + 1}`);
        if (first === undefined) first = current;
        else assert.equal(current, first, `source and IDs stabilize after first parse, cycle ${cycle + 1}`);
    }
    return current;
}

test('normalization preserves PRE/TEXTAREA/LISTING leading LF and entity CR across repeated parses', t => {
    const { core, document } = runtime(t);
    t.diagnostic(`vdoc-core.js sha256=${moduleSha256}`);
    for (const tag of ['pre', 'textarea', 'listing']) {
        const source = `<${tag}>\n\n\nA&#13;\nB&#13;C</${tag}>`;
        const normalized = assertCycles(document, core, source, [
            ['http://www.w3.org/1999/xhtml', tag, [], [[3, '\n\nA\r\nB\rC']]],
        ]);
        assert.equal(fragment(document, core.sanitizeHtml(normalized)).firstChild.textContent, '\n\nA\r\nB\rC');
        assert.equal(fragment(document, core.splitDocumentSource(normalized).html).firstChild.textContent, '\n\nA\r\nB\rC');
        assert.equal(fragment(document, core.splitSlideSource(normalized).html).firstChild.textContent, '\n\nA\r\nB\rC');
    }
});

test('pre-wrap block children preserve all authored text nodes and adjacent inline boundaries', t => {
    const { core, document } = runtime(t);
    const source = '  <section style="white-space:pre-wrap">  A  <div>B</div>  C\n\n  <span>D</span><span>E</span></section>\n';
    const html = 'http://www.w3.org/1999/xhtml';
    assertCycles(document, core, source, [
        [3, '  '], [html, 'section', [[null, 'style', 'white-space:pre-wrap']], [
            [3, '  A  '], [html, 'div', [], [[3, 'B']]], [3, '  C\n\n  '],
            [html, 'span', [], [[3, 'D']]], [html, 'span', [], [[3, 'E']]],
        ]], [3, '\n'],
    ]);
});

test('object geometry mutation preserves neighboring PRE leading LF and CR entities', t => {
    const { core, document } = runtime(t);
    const objectsSource = fs.readFileSync(path.join(__dirname, '..', 'ScriptoriumModules', 'scriptorium-objects.js'), 'utf8');
    const context = vm.createContext({ window: document.defaultView, document,
        Node: document.defaultView.Node, CSS: { escape: value => String(value) } });
    vm.runInContext(objectsSource, context, { filename: 'scriptorium-objects.js' });
    const source = '<pre>\n\nA&#13;B</pre><div data-vdoc-object-id="shape-1" data-vdoc-object="shape"></div>';
    const result = context.window.ScriptoriumObjects.applyMutationToSource(source, {
        type: 'geometry', objectId: 'shape-1', styles: { left: '20px' },
    }, true, core);
    assert.equal(result.changed, true);
    assert.equal(fragment(document, result.source).querySelector('pre').textContent, '\nA\rB');
    assert.equal(core.normalizeCompleteSlideSource(result.source), result.source);
});

test('raw SCRIPT/STYLE remain literal text in authored order and keep source attributes', t => {
    const { core, document } = runtime(t);
    const script = '\nconst sample = "<&amp;>&#13;";\nif (1 < 2) { window.sample = sample; }\n';
    const style = '\n.x::before { content: "<&amp;>&#13;"; }\n';
    const source = `<section><script type="application/json" data-order="a">${script}</script><div>body</div><style media="screen">${style}</style><script src="./local.js" defer></script></section>`;
    const expected = snapshot(fragment(document, source));
    const normalized = assertCycles(document, core, source, expected);
    const root = fragment(document, normalized);
    assert.equal(root.querySelector('script').textContent, script);
    assert.equal(root.querySelector('style').textContent, style);
    assert.deepEqual([...root.firstChild.children].map(node => node.localName), ['script', 'div', 'style', 'script']);
});

test('NOSCRIPT entities and PLAINTEXT bodies remain stable across complete-source cycles', t => {
    const { core, document } = runtime(t);
    for (const source of ['<noscript>&amp;</noscript>', '<plaintext>A']) {
        const expected = snapshot(fragment(document, source));
        const normalized = assertCycles(document, core, source, expected);
        assert.equal(core.normalizeCompleteSlideSource(normalized), normalized);
    }
});

test('CR entities in ordinary attributes and text are preserved without changing literal ampersands', t => {
    const { core, document } = runtime(t);
    const source = '<p title="A&#13;&#10;B&amp;#13;">A&#13;B&amp;#13;&lt;</p>';
    assertCycles(document, core, source, [
        ['http://www.w3.org/1999/xhtml', 'p', [[null, 'title', 'A\r\nB&#13;']], [[3, 'A\rB&#13;<']]],
    ]);
});

test('CR entities in SCRIPT/STYLE attributes survive while their raw bodies stay literal', t => {
    const { core, document } = runtime(t);
    for (const tag of ['script', 'style']) {
        const source = `<${tag} data-note="A&#13;B">&amp;&#13;<</${tag}>`;
        assertCycles(document, core, source, [
            ['http://www.w3.org/1999/xhtml', tag, [[null, 'data-note', 'A\rB']], [[3, '&amp;&#13;<']]],
        ]);
    }
});

test('nested HTML templates sanitize inert descendants and preserve their whitespace', t => {
    const { core, document } = runtime(t);
    const source = '<template id="outer"><pre>\n\nA&#13;B</pre><template><p onclick="bad()">safe</p><iframe src="bad"></iframe></template></template>';
    const normalized = core.normalizeCompleteSlideSource(source);
    const outer = fragment(document, normalized).querySelector('template').content;
    assert.equal(outer.querySelector('pre').textContent, '\nA\rB');
    const inner = outer.querySelector('template').content;
    assert.equal(inner.querySelector('p').getAttribute('onclick'), null);
    assert.equal(inner.querySelector('iframe'), null);
    assertCycles(document, core, normalized, snapshot(fragment(document, normalized)));
});

test('SVG and MathML retain namespaces, case-sensitive tags, attributes, and integration points', t => {
    const { core, document } = runtime(t);
    const source = '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><text>A&#13;B&amp;C</text><foreignObject><div><pre>\n\nHTML</pre></div></foreignObject></svg><math><mrow><mi>x</mi><mo>&lt;</mo><mn>2</mn></mrow><annotation-xml encoding="text/html"><p>text</p></annotation-xml></math>';
    const expected = snapshot(fragment(document, source));
    const normalized = assertCycles(document, core, source, expected);
    const root = fragment(document, normalized);
    assert.equal(root.querySelector('linearGradient').namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(root.querySelector('mi').namespaceURI, 'http://www.w3.org/1998/Math/MathML');
    assert.equal(root.querySelector('foreignObject div').namespaceURI, 'http://www.w3.org/1999/xhtml');
});

test('foreign namespace elements named template do not assume HTMLTemplateElement.content', t => {
    const { core, document } = runtime(t);
    for (const source of ['<svg><template><text>SVG text</text></template></svg>', '<math><template><mi>x</mi></template></math>']) {
        assertCycles(document, core, source, snapshot(fragment(document, source)));
    }
});

test('sanitization still removes unsafe descendants and preserves allowed local media URLs', t => {
    const { core, document } = runtime(t);
    const source = '<section onclick="bad()"><iframe></iframe><object></object><embed><base><meta http-equiv="refresh"><link rel="import" href="bad"><a href="javascript:bad()">a</a><a href="file:///x">b</a><form action="vbscript:bad()"></form><img src="file:///image.png" onerror="bad()"><video poster="file:///poster.png"></video><script src="file:///bad.js"></script></section>';
    const root = fragment(document, core.normalizeCompleteSlideSource(source));
    assert.equal(root.querySelector('iframe,object,embed,base,meta[http-equiv],link[rel="import"]'), null);
    assert.equal(root.querySelector('[onclick],[onerror]'), null);
    assert.deepEqual([...root.querySelectorAll('a')].map(node => node.getAttribute('href')), [null, null]);
    assert.equal(root.querySelector('form').getAttribute('action'), null);
    assert.equal(root.querySelector('script').getAttribute('src'), null);
    assert.equal(root.querySelector('img').getAttribute('src'), 'file:///image.png');
    assert.equal(root.querySelector('video').getAttribute('poster'), 'file:///poster.png');
});

test('stable IDs are retained, duplicate IDs are reissued once, and v2 save/open preserves source', t => {
    const { core, document } = runtime(t);
    const source = '<section data-vdoc-container="container-fixed"><p data-vdoc-text="text-fixed" data-vdoc-block="block-fixed">A</p><p data-vdoc-text="text-fixed" data-vdoc-block="block-fixed">B</p></section>';
    const normalized = core.normalizeCompleteSlideSource(source);
    const root = fragment(document, normalized);
    const paragraphs = [...root.querySelectorAll('p')];
    assert.equal(root.firstChild.getAttribute('data-vdoc-container'), 'container-fixed');
    assert.equal(paragraphs[0].getAttribute('data-vdoc-text'), 'text-fixed');
    assert.equal(paragraphs[0].getAttribute('data-vdoc-block'), 'block-fixed');
    for (const attribute of ['data-vdoc-text', 'data-vdoc-block']) {
        assert.ok(paragraphs[1].getAttribute(attribute));
        assert.notEqual(paragraphs[1].getAttribute(attribute), paragraphs[0].getAttribute(attribute));
    }
    assert.equal(core.normalizeCompleteSlideSource(normalized), normalized);
    let model = core.createDocument({ kind: core.PROJECT_KINDS.SLIDE_DECK, slides: [{ id: 'slide-fixed', source: normalized }] });
    for (let cycle = 0; cycle < 4; cycle += 1) model = core.parse(core.serialize(model));
    assert.equal(model.version, 2);
    assert.equal(model.source.format, 'html-scene');
    assert.equal(model.source.slides[0].source, normalized);
});

test('formatHtml retains its explicit beautification contract while persistence preserves whitespace', t => {
    const { core } = runtime(t);
    const source = '<section><p>A</p><p>B</p></section>';
    assert.equal(core.formatHtml(source), '<section>\n    <p>A</p>\n    <p>B</p>\n</section>');
    assert.equal(core.formatHtml(source, '  '), '<section>\n  <p>A</p>\n  <p>B</p>\n</section>');
    assert.equal(core.normalizeCompleteSlideSource(source).includes('\n'), false);
    const preWrap = '<p style="white-space: pre-wrap">  A\n  <strong>B</strong>  </p>';
    assert.equal(core.formatHtml(preWrap), preWrap);
});

test('normalization parses the supplied source once', t => {
    const { core, document } = runtime(t);
    const originalCreate = document.createElement.bind(document);
    let templateCount = 0;
    document.createElement = (name, ...rest) => {
        if (String(name).toLowerCase() === 'template') templateCount += 1;
        return originalCreate(name, ...rest);
    };
    core.normalizeCompleteSlideSource('<section><p>A&#13;B</p><pre>\n\nC</pre></section>');
    assert.equal(templateCount, 1);
});

test('DOM fragment helpers accept Element and DocumentFragment containers without mutation on serialization', t => {
    const { core, document } = runtime(t);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<p onclick="bad()">A&#13;B</p><iframe></iframe>';
    assert.equal(core.sanitizeFragment(wrapper), wrapper);
    assert.equal(wrapper.querySelector('iframe'), null);
    assert.equal(wrapper.querySelector('p').getAttribute('onclick'), null);
    const before = wrapper.innerHTML;
    const serialized = core.serializeFragment(wrapper);
    assert.equal(wrapper.innerHTML, before);
    assert.equal(fragment(document, serialized).firstChild.textContent, 'A\rB');
    const root = fragment(document, '<pre>\n\nA</pre>');
    assert.equal(core.sanitizeFragment(root), root);
    assert.equal(fragment(document, core.serializeFragment(root)).firstChild.textContent, '\nA');
});


test('sanitizer applies the shared attribute policy to Element roots', t => {
    const { core, document } = runtime(t);
    for (const [tag, attribute, value, expected] of [
        ['a', 'href', 'javascript:bad()', null],
        ['a', 'href', 'file:///document.html', null],
        ['form', 'action', 'vbscript:bad()', null],
        ['script', 'src', 'file:///script.js', null],
        ['img', 'src', 'file:///image.png', 'file:///image.png'],
        ['video', 'poster', 'file:///poster.png', 'file:///poster.png'],
    ]) {
        const root = document.createElement(tag);
        root.setAttribute(attribute, value);
        root.setAttribute('onclick', 'bad()');
        root.setAttribute('data-user', 'preserved');
        assert.equal(core.sanitizeFragment(root), root);
        assert.equal(root.getAttribute(attribute), expected, `${tag}[${attribute}]`);
        assert.equal(root.getAttribute('onclick'), null);
        assert.equal(root.getAttribute('data-user'), 'preserved');
    }
});

test('sanitizer cleans an HTMLTemplateElement root and recursively visits its content', t => {
    const { core, document } = runtime(t);
    const root = document.createElement('template');
    root.setAttribute('onclick', 'bad()');
    root.setAttribute('id', 'authored');
    root.innerHTML = '<p onclick="bad()">A&#13;B</p><iframe></iframe><template onload="bad()"><a href="javascript:bad()">safe</a><object></object></template>';
    assert.equal(core.sanitizeFragment(root), root);
    assert.equal(root.getAttribute('onclick'), null);
    assert.equal(root.id, 'authored');
    assert.equal(root.content.querySelector('p').getAttribute('onclick'), null);
    assert.equal(root.content.querySelector('p').textContent, 'A\rB');
    assert.equal(root.content.querySelector('iframe'), null);
    const nested = root.content.querySelector('template');
    assert.equal(nested.getAttribute('onload'), null);
    assert.equal(nested.content.querySelector('a').getAttribute('href'), null);
    assert.equal(nested.content.querySelector('a').textContent, 'safe');
    assert.equal(nested.content.querySelector('object'), null);
});

test('sanitizer returns null for blocked roots and removes attached roots without affecting siblings', t => {
    const { core, document } = runtime(t);
    for (const [tag, attributes] of [
        ['iframe', {}], ['object', {}], ['embed', {}], ['applet', {}], ['base', {}],
        ['meta', { 'http-equiv': 'refresh' }], ['link', { rel: 'import' }],
    ]) {
        for (const attached of [false, true]) {
            const root = document.createElement(tag);
            for (const [name, value] of Object.entries(attributes)) root.setAttribute(name, value);
            const holder = document.createDocumentFragment();
            const sibling = document.createElement('p');
            sibling.textContent = 'preserved';
            if (attached) holder.append(root);
            holder.append(sibling);
            assert.equal(core.sanitizeFragment(root), null, `${tag}, attached=${attached}`);
            assert.equal(root.parentNode, null);
            assert.deepEqual([...holder.childNodes], [sibling]);
            assert.equal(sibling.textContent, 'preserved');
        }
    }
    for (const [tag, name, value] of [['meta', 'name', 'description'], ['link', 'rel', 'stylesheet']]) {
        const root = document.createElement(tag);
        root.setAttribute(name, value);
        assert.equal(core.sanitizeFragment(root), root, `nonblocked ${tag} remains available`);
    }
});

test('foreign namespace template roots sanitize their attributes and ordinary descendants', t => {
    const { core, document } = runtime(t);
    for (const namespace of ['http://www.w3.org/2000/svg', 'http://www.w3.org/1998/Math/MathML']) {
        const root = document.createElementNS(namespace, 'template');
        root.setAttribute('onclick', 'bad()');
        const child = document.createElementNS(namespace, 'text');
        child.setAttribute('onload', 'bad()');
        child.textContent = 'preserved';
        root.append(child);
        assert.equal(core.sanitizeFragment(root), root);
        assert.equal(root.getAttribute('onclick'), null);
        assert.equal(child.getAttribute('onload'), null);
        assert.equal(root.namespaceURI, namespace);
        assert.equal(root.textContent, 'preserved');
    }
});
