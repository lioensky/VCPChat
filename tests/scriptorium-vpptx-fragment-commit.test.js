'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const MODULES = [
    'vdoc-core.js', 'scriptorium-document-store.js', 'scriptorium-deck-adapter.js',
    'scriptorium-dom-selection.js', 'scriptorium-input-sync.js',
    'scriptorium-text-fragment.js', 'scriptorium-deck-editor.js',
];

function fixture(t, source) {
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', {
        url: 'https://scriptorium.test/', runScripts: 'outside-only', pretendToBeVisual: true,
    });
    const window = dom.window;
    // Fixture identities use only ASCII letters and hyphens.
    window.CSS ??= {};
    window.CSS.escape ??= value => String(value);
    for (const file of MODULES) {
        window.eval(fs.readFileSync(path.join(__dirname, '..', 'ScriptoriumModules', file), 'utf8'));
    }
    const core = window.VDocCore;
    const store = window.ScriptoriumDocumentStore.createDocumentStore({ core });
    store.replaceDocument(core.createDocument({
        kind: core.PROJECT_KINDS.SLIDE_DECK,
        slides: [
            { id: 'slide-a', source: `<section class="vdoc-slide-scene">${source}</section>` },
            { id: 'slide-b', source: '<section class="vdoc-slide-scene"><p>Other slide</p></section>' },
        ],
    }));
    const notifications = [];
    const navigation = [];
    let captures = 0;
    const adapter = window.ScriptoriumDeckAdapter.createDeckAdapter({
        core, documentPort: store, onActiveSlideChange: event => navigation.push(event),
    });
    const editor = window.ScriptoriumDeckEditor.createDeckEditor({
        core, documentPort: store, adapter,
        selectionPrimitives: window.ScriptoriumDomSelection,
        notificationPort: { show: (...args) => notifications.push(args) },
        historyPort: { capture: () => { captures += 1; } },
    });
    adapter.attachEditor(editor);
    const root = window.document.getElementById('host');
    root.innerHTML = adapter.parsedSlide().html;
    editor.bindSurface(root);
    const input = node => node.dispatchEvent(new window.InputEvent('input', {
        bubbles: true, composed: true, inputType: 'insertText', data: null,
    }));
    const sourceDom = () => {
        const template = window.document.createElement('template');
        template.innerHTML = adapter.currentSource();
        return template.content;
    };
    const savedBlock = id => sourceDom().querySelector(`[data-vdoc-text="${id}"]`);
    const line = (node, text, attributes = {}) => {
        const div = window.document.createElement('div');
        for (const [name, value] of Object.entries(attributes)) div.setAttribute(name, value);
        div.textContent = text;
        node.appendChild(div);
        return div;
    };
    t.after(() => {
        editor.dispose();
        store.dispose();
        window.close();
    });
    return { window, core, store, adapter, editor, root, input, line, sourceDom,
        savedBlock, notifications, navigation, captures: () => captures };
}

test('production input/flush canonicalizes native P DIV lines once without touching live DOM', t => {
    const f = fixture(t, '<p data-vdoc-text="target">Alpha</p>');
    const target = f.root.querySelector('[data-vdoc-text="target"]');
    f.line(target, 'Beta');
    const liveBefore = target.innerHTML;
    const revision = f.store.status().revision;
    f.input(target);
    assert.equal(f.editor.flush(), true);
    assert.equal(target.innerHTML, liveBefore, 'Serialization must not rebuild the editing surface');
    assert.equal(f.savedBlock('target').innerHTML, 'Alpha<br>Beta');
    assert.equal(f.sourceDom().querySelectorAll('[data-vdoc-text="target"]').length, 1);
    assert.equal(f.store.status().revision, revision + 1);
    assert.equal(f.captures(), 1);
    const canonical = f.adapter.currentSource();
    for (let repeat = 0; repeat < 5; repeat += 1) {
        f.input(target);
        assert.equal(f.editor.flush(), true);
        assert.equal(f.adapter.currentSource(), canonical);
        assert.equal(f.store.status().revision, revision + 1, 'Repeated submission adds zero revisions');
    }
    assert.equal(f.editor.updateSourceNodes([target]), false);
    assert.equal(f.captures(), 1);
    assert.equal(f.core.parse(f.store.serialize()).source.slides[0].source, canonical);
    assert.equal(f.notifications.length, 0);
});

test('production commits keep inline styles and consecutive native empty lines', t => {
    const f = fixture(t, '<p data-vdoc-text="target"><strong>Alpha</strong></p>');
    const target = f.root.querySelector('[data-vdoc-text="target"]');
    const empty = f.line(target, '');
    empty.appendChild(f.window.document.createElement('br'));
    const final = f.line(target, '');
    const em = f.window.document.createElement('em');
    em.setAttribute('lang', 'zh');
    em.textContent = '尾';
    final.appendChild(em);
    f.input(target);
    assert.equal(f.editor.flush(), true);
    assert.equal(f.savedBlock('target').innerHTML, '<strong>Alpha</strong><br><br><em lang="zh">尾</em>');
    assert.equal(target.querySelectorAll('div').length, 2, 'Live native lines remain untouched');
});

test('production commit normalizes stale caret BR and preserves logical cursor end', t => {
    const f = fixture(t, '<p data-vdoc-text="target">a</p>');
    const target = f.root.querySelector('[data-vdoc-text="target"]');
    const br = f.window.document.createElement('br');
    br.setAttribute('data-vdoc-caret-placeholder', 'true');
    target.append(br, f.window.document.createElement('div'));
    f.input(target);
    assert.equal(f.editor.flush(), true);
    const saved = f.savedBlock('target');
    assert.equal(saved.innerHTML, 'a<br>');
    const codec = f.window.ScriptoriumTextFragment;
    const fragment = codec.fromDOM(saved);
    assert.equal(codec.toPlainText(fragment), 'a\n');
    assert.equal(fragment.length, 2);
    assert.ok(codec.logicalToDOM(fragment, { offset: 2, affinity: 'downstream' }));
    const reopened = f.core.parse(f.store.serialize());
    f.store.replaceDocument(reopened);
    const restored = f.savedBlock('target');
    assert.equal(codec.toPlainText(codec.fromDOM(restored)), 'a\n');
});

test('text edits keep inline resource images when browser lines are normalized', t => {
    const f = fixture(t, '<p data-vdoc-text="target">Alpha<img src="vdoc-resource://media/abc" alt="chart"></p>');
    const target = f.root.querySelector('[data-vdoc-text="target"]');
    f.line(target, 'Beta');
    f.input(target);
    assert.equal(f.editor.flush(), true);
    assert.equal(f.savedBlock('target').innerHTML,
        'Alpha<img src="vdoc-resource://media/abc" alt="chart"><br>Beta');
});

test('paste and drop use controlled insertion and keep text-block identities unique', t => {
    const f = fixture(t, '<p data-vdoc-text="target">Before</p>');
    const target = f.root.querySelector('[data-vdoc-text="target"]');
    for (const type of ['paste', 'drop']) {
        const data = new Map([['text/html', '<p>First</p><p>Second</p>'], ['text/plain', 'First\nSecond']]);
        const event = new f.window.Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', {
            value: { getData: key => data.get(key) || '' },
        });
        target.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
    }
    const source = f.sourceDom();
    const ids = [...source.querySelectorAll('[data-vdoc-text]')].map(node => node.dataset.vdocText);
    assert.equal(ids.length, 5);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(f.adapter.currentSource().includes('First'), true);
});

test('parse-stable author DIV keeps tag selectors, layout attributes and nested block identity', t => {
    const f = fixture(t, '<blockquote data-vdoc-text="quote"><div class="author-layout" style="display:grid;margin:7px"><span data-author="keep">Before</span><p data-vdoc-text="nested">Nested</p></div></blockquote>');
    const quote = f.root.querySelector('[data-vdoc-text="quote"]');
    const div = quote.querySelector('div.author-layout');
    div.querySelector('span').textContent = 'After';
    f.input(quote);
    assert.equal(f.editor.flush(), true);
    const saved = f.savedBlock('quote');
    const authorDiv = saved.querySelector(':scope > div.author-layout');
    assert.ok(authorDiv, 'Do not replace authored DIV with SPAN');
    assert.equal(authorDiv.getAttribute('style'), 'display:grid;margin:7px');
    assert.equal(authorDiv.querySelector('span[data-author="keep"]').textContent, 'After');
    assert.equal(authorDiv.querySelector('p').dataset.vdocText, 'nested');
    assert.equal(saved.querySelectorAll('br').length, 0);
    assert.equal(saved.querySelector('[contenteditable]'), null);
    const revision = f.store.status().revision;
    f.input(quote);
    assert.equal(f.editor.flush(), true);
    assert.equal(f.store.status().revision, revision);
    assert.equal(f.notifications.length, 0);
});

test('unsupported styled P DIV rejects the whole batch, preserves pending and blocks slide changes until retry', t => {
    const f = fixture(t, '<p data-vdoc-text="good">Good</p><p data-vdoc-text="bad">Bad</p>');
    const good = f.root.querySelector('[data-vdoc-text="good"]');
    const bad = f.root.querySelector('[data-vdoc-text="bad"]');
    const invalid = f.line(bad, 'Line', { class: 'author-layout', style: 'display:grid;margin:9px' });
    good.textContent = 'Good edit';
    f.input(good);
    f.input(bad);
    const before = f.adapter.currentSource();
    const revision = f.store.status().revision;
    assert.equal(f.editor.flush(), false);
    assert.equal(f.adapter.currentSource(), before, 'The preceding good block must not partially commit');
    assert.equal(f.store.status().revision, revision);
    assert.equal(f.captures(), 0);
    assert.ok(f.notifications.some(([message, tone]) => /无法无损保存/.test(message) && tone === 'error'));
    assert.equal(f.editor.flush(), false, 'Pending unsupported nodes must survive the first rejection');
    assert.equal(f.adapter.selectSlide(1), false);
    assert.equal(f.adapter.activeSlideIndex(), 0);
    assert.equal(f.adapter.addSlide(), false);
    assert.equal(f.adapter.deleteSlide(1), false);
    assert.equal(f.adapter.slides().length, 2);
    assert.equal(f.navigation.length, 0);
    assert.equal(f.adapter.currentSource(), before);
    assert.equal(f.store.status().revision, revision);
    invalid.removeAttribute('class');
    invalid.removeAttribute('style');
    // No second input event: retry must still consume the retained pending batch.
    assert.equal(f.editor.flush(), true);
    assert.equal(f.savedBlock('good').textContent, 'Good edit');
    assert.equal(f.savedBlock('bad').innerHTML, 'Bad<br>Line');
    assert.equal(f.store.status().revision, revision + 1);
    assert.equal(f.captures(), 1);
    assert.equal(f.editor.flush(), true);
    assert.equal(f.store.status().revision, revision + 1);
    assert.equal(f.adapter.selectSlide(1), true);
    assert.equal(f.adapter.activeSlideIndex(), 1);
    assert.equal(f.navigation.length, 1);
});

test('committing a text fragment leaves neighboring PRE, numeric CR and other slides stable across save/open', t => {
    const f = fixture(t, '<p data-vdoc-text="target">Start</p><pre id="pre">\n\nPRE&#13;\nEnd</pre><textarea id="textarea">\n\nAREA&#13;End</textarea><p id="cr" style="white-space:pre-wrap">A&#13;&#10;B&#13;C</p>');
    const target = f.root.querySelector('[data-vdoc-text="target"]');
    const before = f.sourceDom();
    const expected = {
        pre: '\nPRE\r\nEnd', textarea: '\nAREA\rEnd', cr: 'A\r\nB\rC',
    };
    const neighborMarkup = {};
    for (const [id, text] of Object.entries(expected)) {
        assert.equal(before.querySelector(`#${id}`).textContent, text, 'Validate the independent parser oracle');
        neighborMarkup[id] = before.querySelector(`#${id}`).outerHTML;
    }
    const otherSource = f.adapter.slides()[1].source;
    for (let cycle = 1; cycle <= 5; cycle += 1) {
        target.textContent = `Cycle ${cycle}`;
        f.line(target, '尾');
        f.input(target);
        assert.equal(f.editor.flush(), true);
        assert.equal(f.savedBlock('target').innerHTML, `Cycle ${cycle}<br>尾`);
        const savedSource = f.adapter.currentSource();
        const restored = f.core.parse(f.store.serialize());
        assert.equal(restored.source.slides[0].source, savedSource);
        assert.equal(restored.source.slides[1].source, otherSource);
        f.store.replaceDocument(restored);
        const actual = f.sourceDom();
        for (const [id, text] of Object.entries(expected)) {
            assert.equal(actual.querySelector(`#${id}`).textContent, text, `${id}, cycle ${cycle}`);
            assert.equal(actual.querySelector(`#${id}`).outerHTML, neighborMarkup[id], `${id} markup, cycle ${cycle}`);
        }
    }
});


test('failed real commit blocks save, mode changes, history and teardown; correction can be saved', async t => {
    const f = fixture(t, '<p data-vdoc-text="target">Before</p>');
    for (const file of ['scriptorium-session.js', 'scriptorium-shell.js', 'scriptorium-edit-history.js']) {
        f.window.eval(fs.readFileSync(path.join(__dirname, '..', 'ScriptoriumModules', file), 'utf8'));
    }
    let rendered = 0;
    const history = f.window.ScriptoriumEditHistory.createEditHistory({
        documentPort: f.store, core: f.core, editorPort: f.editor,
        renderPort: { renderCurrent: () => rendered++ },
    });
    t.after(() => history.dispose());
    history.capture();
    const target = f.root.querySelector('[data-vdoc-text="target"]');
    target.textContent = 'Edited'; f.input(target); f.editor.flush(); history.capture();
    assert.equal(history.status().canUndo, true);
    let packed = 0;
    let saved = 0;
    const notices = [];
    const session = f.window.ScriptoriumSession.createSessionController({
        core: f.core, documentPort: f.store, editorResolver: () => f.editor,
        historyPort: history, getAdapter: () => f.adapter,
        containerModule: { pack: async model => { packed++; return f.core.serialize(model); } },
        persistencePort: { save: async ({ bytes }) => {
            saved++; assert.match(bytes, /Edited<br>New/);
            return { success: true, filePath: 'fixture.vpptx', name: 'fixture.vpptx' };
        } },
        notificationPort: { show: (...args) => notices.push(args) },
    });
    const shell = f.window.ScriptoriumShell.createShell({
        documentPort: f.store, editorResolver: () => f.editor,
        renderPort: { setMode: () => rendered++ }, historyPort: history,
    });
    const invalid = f.line(target, 'New', { class: 'layout' });
    f.input(target);
    const oldSource = f.adapter.currentSource();
    const oldHistory = JSON.stringify(history.status());
    assert.equal(await session.save(), false);
    assert.equal(await session.createDeck(), false);
    assert.equal(packed, 0); assert.equal(saved, 0); assert.equal(notices.length, 0);
    assert.equal(shell.switchMode('html'), false);
    assert.equal(shell.surfacePort.mode(), 'edit');
    assert.equal(history.capture(), false); assert.equal(history.finalize(), false);
    assert.equal(history.execute('undo'), false);
    assert.equal(JSON.stringify(history.status()), oldHistory);
    f.adapter.attachRenderer({ renderEdit: () => { rendered++; } });
    f.adapter.renderEditSurface(f.root);
    assert.equal(rendered, 0);
    assert.equal(f.adapter.disposeSurface(), false);
    assert.equal(f.editor.disposeSurface(), false);
    assert.equal(f.editor.bindSurface(f.window.document.createElement('div')), false);
    assert.equal(target.isConnected, true);
    assert.equal(f.adapter.currentSource(), oldSource);
    invalid.removeAttribute('class');
    assert.equal(await session.save(), true);
    assert.equal(packed, 1); assert.equal(saved, 1);
    assert.ok(notices.some(([, tone]) => tone === 'success'));
    assert.equal(f.savedBlock('target').innerHTML, 'Edited<br>New');
    assert.equal(f.store.status().dirty, false);
});
