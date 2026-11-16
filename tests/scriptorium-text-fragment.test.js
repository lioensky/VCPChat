'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const codec = require('../ScriptoriumModules/scriptorium-text-fragment.js');
const dom = new JSDOM('<!doctype html><body>', { runScripts: 'outside-only' });
const { document } = dom.window;
const coreSource = fs.readFileSync(path.join(__dirname, '../ScriptoriumModules/vdoc-core.js'), 'utf8');
dom.window.eval(coreSource);
const core = dom.window.VDocCore;

// Assigning P.innerHTML uses fragment parsing, allowing browser-created DIV-in-P
// fixtures. Reload with full HTML parsing below: it would expose P splitting.
function fixture(html = '') {
    const root = document.createElement('p');
    root.innerHTML = html;
    return root;
}
function savedRoot(html) {
    const template = document.createElement('template');
    template.innerHTML = `<section><p data-vdoc-text="target">${html}</p></section>`;
    assert.equal(template.content.querySelector('section').children.length, 1, 'HTML parser must retain one P');
    return template.content.querySelector('p');
}
function assertPositions(fragment) {
    for (let offset = 0; offset <= fragment.length; offset++) {
        for (const affinity of ['upstream', 'downstream']) {
            const point = codec.logicalToDOM(fragment, { offset, affinity });
            assert.ok(point, `Missing DOM point for ${offset}/${affinity}`);
            const roundTrip = codec.domToLogical(fragment, point.node, point.offset, point.affinity);
            assert.equal(roundTrip?.offset, offset, `DOM round trip at ${offset}/${affinity}`);
            const range = document.createRange();
            assert.doesNotThrow(() => range.setStart(point.node, point.offset));
        }
    }
}

for (const [name, html, expected] of [
    ['empty', '', ''],
    ['literal explicit BR', '<br>', '\n'],
    ['terminal explicit BRs', 'a<br><br>', 'a\n\n'],
    ['inline BR', '<b>a<br>b</b>', 'a\nb'],
    ['browser DIV', 'a<div>b</div>', 'a\nb'],
    ['DIV followed by inline', '<div>a</div>b', 'a\nb'],
    ['leading empty DIV', '<div></div>b', '\nb'],
    ['trailing empty DIV', 'a<div></div>', 'a\n'],
    ['placeholder line', 'a<div><br></div><div>b</div>', 'a\n\nb'],
    ['terminal placeholder', 'a<div><br></div>', 'a\n'],
    ['two terminal placeholders', 'a<div><br></div><div><br></div>', 'a\n\n'],
    ['empty newline with placeholder', '<br><div><br></div>', '\n'],
    ['persisted caret placeholder', 'a<br><br data-vdoc-caret-placeholder="true">', 'a\n'],
    ['nonterminal marker is explicit', 'a<br data-vdoc-caret-placeholder="true">b', 'a\nb'],
    ['consecutive empty lines', '<div>a</div><div></div><div><br></div><div>b</div>', 'a\n\n\nb'],
    ['single empty browser line', '<div><br></div>', ''],
    ['multiple BR are explicit', '<div><br><br></div><div>b</div>', '\n\nb'],
    ['boundary shares explicit BR', 'a<br><div>b</div>', 'a\nb'],
    ['trailing BR shares boundary', '<div>a<br></div><div>b</div>', 'a\nb'],
    ['nested browser DIV', '<div>a<div>b</div>c</div><div>d</div>', 'a\nb\nc\nd'],
    ['entities, CJK and UTF16', '&lt;&amp;&gt;&nbsp;汉🙂👨‍👩‍👧‍👦é', '<&>\u00a0汉🙂👨‍👩‍👧‍👦é'],
]) {
    test(`semantic lines: ${name}`, () => {
        const root = fixture(html);
        const original = root.innerHTML;
        const fragment = codec.fromDOM(root);
        assert.equal(fragment.supported, true);
        assert.equal(codec.toPlainText(fragment), expected);
        assert.equal(fragment.length, expected.length);
        assert.equal(root.innerHTML, original, 'Reading must not mutate live DOM');
        assertPositions(fragment);
        const encoded = codec.encode(fragment);
        assert.notEqual(encoded, null);
        const restored = codec.fromDOM(savedRoot(encoded));
        assert.equal(codec.toPlainText(restored), expected);
        assert.equal(codec.encode(restored), encoded, 'Canonical encoding is idempotent');
        assertPositions(restored);
    });
}

test('semantic AST retains original inline tags and attributes', () => {
    const root = fixture('<strong class="accent" data-user="x&amp;&quot;" style="font-weight:900"><em lang="zh">甲🙂</em></strong><br title="break"><a href="https://example.test/?a=1&amp;b=2">尾</a>');
    const fragment = codec.fromDOM(root);
    assert.equal(fragment.children[0].type, 'Inline');
    assert.equal(fragment.children[0].tag, 'strong');
    assert.equal(fragment.children[0].children[0].tag, 'em');
    assert.equal(fragment.children[0].children[0].children[0].type, 'Text');
    assert.equal(fragment.children[1].type, 'Break');
    assert.equal(codec.encode(fragment), root.innerHTML);
    assert.equal(Object.isFrozen(fragment.children[0].children), true);
    assert.throws(() => fragment.children[0].children.push({ type: 'Text', value: 'bad' }), TypeError);
});

test('BlockLine preserves text styling using inline wrappers and direct BRs', () => {
    const root = fixture('前<div style="color:red;font-weight:700" lang="zh"><b data-user="yes">一</b></div><div style="font-style:italic">二</div>');
    const fragment = codec.fromDOM(root);
    assert.equal(fragment.children[1].type, 'BlockLine');
    const encoded = codec.encode(fragment);
    assert.equal(encoded, '前<br><span style="color:red;font-weight:700" lang="zh"><b data-user="yes">一</b></span><br><span style="font-style:italic">二</span>');
    assert.ok(!encoded.includes('<div'));
    assert.ok(!encoded.includes('display:'));
    assert.equal(codec.toPlainText(codec.fromDOM(savedRoot(encoded))), '前\n一\n二');
});

test('only an unadorned sole BR in DIV is an empty-line placeholder', () => {
    const fragment = codec.fromDOM(fixture('<div><br></div><div><br title="authored"></div>'));
    assert.equal(fragment.children[0].children[0].placeholder, true);
    assert.equal(fragment.children[1].children[0].placeholder, false);
    assert.equal(codec.toPlainText(fragment), '\n\n');
    assert.equal(codec.encode(fragment), '<br><br title="authored">');
});

test('editor attributes are stripped deliberately; author attributes remain', () => {
    const root = fixture('<b contenteditable="true" spellcheck="false" data-vdoc-editor-selected="true" class="keep" data-user="yes">a</b>');
    assert.equal(codec.encode(codec.fromDOM(root)), '<b class="keep" data-user="yes">a</b>');
    assert.equal(codec.encode(codec.fromDOM(root, { stripEditorAttributes: false })), root.innerHTML);
    assert.equal(root.firstChild.getAttribute('contenteditable'), 'true');
});

test('a generated caret marker becomes an ordinary break after normalization', () => {
    const root = fixture('a<br data-vdoc-caret-placeholder="true"><div></div>');
    const original = codec.fromDOM(root);
    assert.equal(codec.toPlainText(original), 'a\n');
    assert.equal(original.length, 2);
    const encoded = codec.encode(original);
    assert.equal(encoded, 'a<br>');
    root.innerHTML = encoded;
    const restored = codec.fromDOM(root);
    assert.equal(codec.toPlainText(restored), 'a\n');
    assert.equal(restored.length, 2);
    assert.ok(codec.logicalToDOM(restored, { offset: 2, affinity: 'downstream' }));
});

test('inline images survive text-block line normalization with resource attributes', () => {
    const root = fixture('Alpha<img src="vdoc-resource://media/abc" alt="chart"><div>Beta</div>');
    const fragment = codec.fromDOM(root);
    assert.equal(fragment.supported, true);
    assert.equal(codec.encode(fragment),
        'Alpha<img src="vdoc-resource://media/abc" alt="chart"><br>Beta');
});

for (const html of [
    '<div class="layout">a</div>', '<div id="identity">a</div>',
    '<div data-vdoc-text="other">a</div>', '<div style="display:flex">a</div>',
    '<div style="margin:10px">a</div>', '<div style="unknown-property:x">a</div>',
    '<span style="display:block">old patch</span>', '<section>a</section>',
    '<svg><text>x</text></svg>', '<!--authored-->',
]) {
    test(`unsupported input fails closed: ${html}`, () => {
        const root = fixture(html);
        const fragment = codec.fromDOM(root);
        assert.equal(fragment.supported, false);
        assert.equal(fragment.children[0].type, 'Unknown');
        assert.ok(fragment.issues.length);
        assert.equal(codec.encode(fragment), null);
        assert.equal(codec.toPlainText(fragment), null);
        assert.equal(codec.domToLogical(fragment, root, 0), null);
        assert.equal(codec.logicalToDOM(fragment, { offset: 0 }), null);
        assert.equal(root.innerHTML, html);
    });
}

test('invalid programmatic inline nesting is rejected by full P parser', () => {
    const root = fixture();
    const outer = document.createElement('a');
    const inner = document.createElement('a');
    inner.textContent = 'x';
    outer.appendChild(inner);
    root.appendChild(outer);
    assert.equal(codec.encode(codec.fromDOM(root)), null);
});

test('DOM boundary affinity distinguishes both sides of an implied newline', () => {
    const root = fixture('a<div>b</div>');
    const fragment = codec.fromDOM(root);
    assert.deepEqual(codec.domToLogical(fragment, root, 1, 'upstream'), { offset: 1, affinity: 'upstream' });
    assert.deepEqual(codec.domToLogical(fragment, root, 1, 'downstream'), { offset: 2, affinity: 'downstream' });
    const before = codec.logicalToDOM(fragment, { offset: 1, affinity: 'upstream' });
    const after = codec.logicalToDOM(fragment, { offset: 2, affinity: 'downstream' });
    assert.equal(before.node, root.firstChild);
    assert.equal(before.offset, 1);
    assert.equal(after.node, root.lastChild.firstChild);
    assert.equal(after.offset, 0);
});

test('affinity retains inline run side at a shared text offset', () => {
    const root = fixture('<b>a</b><i>b</i>');
    const fragment = codec.fromDOM(root);
    const before = codec.logicalToDOM(fragment, { offset: 1, affinity: 'upstream' });
    const after = codec.logicalToDOM(fragment, { offset: 1, affinity: 'downstream' });
    assert.equal(before.node, root.firstChild.firstChild);
    assert.equal(before.offset, 1);
    assert.equal(after.node, root.lastChild.firstChild);
    assert.equal(after.offset, 0);
});

test('native BR restores before and after the element, not inside BR', () => {
    const root = fixture('<br><br>');
    const fragment = codec.fromDOM(root);
    for (let offset = 0; offset <= 2; offset++) {
        const point = codec.logicalToDOM(fragment, { offset, affinity: 'downstream' });
        assert.equal(point.node, root);
        assert.equal(point.offset, offset);
    }
});

test('every DOM point round trips through the logical coordinate space', () => {
    const root = fixture('🙂<b>a</b><div><br></div><div><em>b<br>c</em></div>d');
    const fragment = codec.fromDOM(root);
    const walk = node => {
        const limit = node.nodeType === 3 ? node.length : node.childNodes.length;
        for (let offset = 0; offset <= limit; offset++) {
            for (const affinity of ['upstream', 'downstream']) {
                const logical = codec.domToLogical(fragment, node, offset, affinity);
                const point = codec.logicalToDOM(fragment, logical);
                assert.equal(codec.domToLogical(fragment, point.node, point.offset, point.affinity).offset, logical.offset);
            }
        }
        node.childNodes.forEach(walk);
    };
    walk(root);
});

test('invalid positions, foreign DOM and stale text are rejected', () => {
    const root = fixture('🙂x');
    const fragment = codec.fromDOM(root);
    assert.deepEqual(codec.domToLogical(fragment, root.firstChild, 1), { offset: 1, affinity: 'downstream' });
    for (const offset of [-1, 4, 0.5, NaN, Infinity]) {
        assert.equal(codec.logicalToDOM(fragment, { offset }), null);
        assert.equal(codec.domToLogical(fragment, root.firstChild, offset), null);
    }
    assert.equal(codec.logicalToDOM(fragment, { offset: 0, affinity: 'invalid' }), null);
    assert.equal(codec.domToLogical(fragment, fixture('x'), 0), null);
    root.firstChild.data = 'changed';
    assert.equal(codec.domToLogical(fragment, root.firstChild, 1), null);
    assert.equal(codec.logicalToDOM(fragment, { offset: 1 }), null);
    assert.equal(codec.encode(fragment), '🙂x', 'Snapshot encoding remains immutable');
});

test('100 save/parse cycles through current VDocCore preserve canonical fragments', () => {
    const root = fixture('<b>甲🙂</b><div style="color:red">乙</div><div><br></div><div>尾&amp;&lt;</div>');
    const expected = codec.toPlainText(codec.fromDOM(root));
    const canonical = codec.encode(codec.fromDOM(root));
    let html = canonical;
    for (let index = 0; index < 100; index++) {
        html = core.sanitizeHtml(html);
        const complete = core.formatHtml(`<section><p data-vdoc-text="target">${html}</p></section>`);
        const holder = document.createElement('template');
        holder.innerHTML = complete;
        const fragment = codec.fromDOM(holder.content.querySelector('p'));
        assert.equal(codec.toPlainText(fragment), expected);
        html = codec.encode(fragment);
        assert.equal(html, canonical);
    }
});

test('32768 UTF-16 units and 1000 empty lines retain linear positions', () => {
    const text = '甲乙🙂'.repeat(8192);
    const root = fixture();
    root.append(text);
    for (let index = 0; index < 1000; index++) root.appendChild(document.createElement('div'));
    const last = document.createElement('div');
    last.textContent = '尾';
    root.appendChild(last);
    const fragment = codec.fromDOM(root);
    assert.equal(codec.toPlainText(fragment), text + '\n'.repeat(1001) + '尾');
    const encoded = codec.encode(fragment);
    assert.equal((encoded.match(/<br>/g) || []).length, 1001);
    assertPositions(fragment);
    assert.equal(codec.encode(codec.fromDOM(savedRoot(encoded))), encoded);
});

test('seed 0x5eed: 150 mixed browser-line fixtures match independent line arrays', () => {
    let seed = 0x5eed;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let iteration = 0; iteration < 150; iteration++) {
        const root = fixture();
        const lines = [];
        const count = 1 + random() % 20;
        for (let index = 0; index < count; index++) {
            const value = ['', '汉🙂', '<&>', 'é', 'مرحبا'][random() % 5];
            lines.push(value);
            const line = document.createElement('div');
            if (value) {
                const inline = document.createElement(random() % 2 ? 'b' : 'em');
                inline.textContent = value;
                line.appendChild(inline);
            } else if (random() % 2) line.appendChild(document.createElement('br'));
            root.appendChild(line);
        }
        const fragment = codec.fromDOM(root);
        assert.equal(codec.toPlainText(fragment), lines.join('\n'), `Fixture ${iteration}`);
        assertPositions(fragment);
        const encoded = codec.encode(fragment);
        assert.equal(codec.toPlainText(codec.fromDOM(savedRoot(encoded))), lines.join('\n'));
    }
});

test('browser global export uses the same API without CommonJS', () => {
    dom.window.eval(fs.readFileSync(path.join(__dirname, '../ScriptoriumModules/scriptorium-text-fragment.js'), 'utf8'));
    assert.deepEqual(Object.keys(dom.window.ScriptoriumTextFragment), Object.keys(codec));
    const fragment = dom.window.ScriptoriumTextFragment.fromDOM(fixture('a<div>b</div>'));
    assert.equal(dom.window.ScriptoriumTextFragment.encode(fragment), 'a<br>b');
});

test.after(() => dom.window.close());
