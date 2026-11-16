'use strict';

if (require('./helpers/electron-test-entry.cjs').runFromNode(__filename)) return;

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const projectRoot = path.resolve(__dirname, '..');

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
        },
    });
    const evaluate = (fn, value) => win.webContents.executeJavaScript(
        `(${fn.toString()})(${JSON.stringify(value) ?? 'undefined'})`
    );
    const settle = () => evaluate(() => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
    ));
    const enter = async (shift = false) => {
        const modifiers = shift ? ['shift'] : [];
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers });
        win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers });
        await settle();
    };
    const setup = async ({ tag = 'p', html = 'AlphaBeta', offset = 5, end = offset } = {}) => {
        await evaluate(({ tag, html, offset, end }) => {
            window.fixture?.editor.dispose();
            window.fixture?.documentPort.dispose();
            const core = window.VDocCore;
            const text = `<${tag} data-vdoc-text="test-text">${html}</${tag}>`;
            const content = tag === 'li' ? `<ul>${text}</ul>`
                : tag === 'td' ? `<table><tbody><tr>${text}</tr></tbody></table>` : text;
            const documentPort = window.ScriptoriumDocumentStore.createDocumentStore({ core });
            documentPort.replaceDocument(core.createDocument({
                kind: core.PROJECT_KINDS.SLIDE_DECK,
                slides: [{ source: `<section class="vdoc-slide-scene">${content}</section>` }],
            }));
            const adapter = window.ScriptoriumDeckAdapter.createDeckAdapter({ core, documentPort });
            const host = document.getElementById('host');
            const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
            root.innerHTML = adapter.parsedSlide().html;
            const editor = window.ScriptoriumDeckEditor.createDeckEditor({
                core, documentPort, adapter,
                selectionPrimitives: window.ScriptoriumDomSelection,
            });
            adapter.attachEditor(editor);
            editor.bindSurface(root);
            const target = root.querySelector('[data-vdoc-text="test-text"]');
            target.focus();
            const textNode = document.createTreeWalker(target, NodeFilter.SHOW_TEXT).nextNode();
            const range = document.createRange();
            range.setStart(textNode || target, offset);
            range.setEnd(textNode || target, end);
            const selection = root.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            window.fixture = { core, documentPort, adapter, editor, root, target };
        }, { tag, html, offset, end });
    };
    const snapshot = async () => {
        await settle();
        const result = await evaluate(() => {
            const { core, documentPort, adapter, editor, root, target } = window.fixture;
            editor.flush();
            const source = adapter.currentSource();
            const revision = documentPort.status().revision;
            // Replaying a DOM snapshot must neither append content nor advance revision.
            editor.updateSourceNodes([target]);
            const reloaded = document.createElement('div');
            document.body.appendChild(reloaded);
            reloaded.innerHTML = adapter.parsedSlide().html;
            const roundTripText = reloaded.querySelector('.vdoc-slide-scene').innerText;
            reloaded.remove();
            return {
                source,
                repeatedSource: adapter.currentSource(),
                revision,
                repeatedRevision: documentPort.status().revision,
                liveText: root.querySelector('.vdoc-slide-scene').innerText,
                liveHtml: target.innerHTML,
                logicalText: window.ScriptoriumTextFragment.toPlainText(
                    window.ScriptoriumTextFragment.fromDOM(target)
                ),
                roundTripText,
                serializedSource: core.parse(core.serialize(documentPort.document())).source.slides[0].source,
            };
        });
        assert.equal(result.repeatedSource, result.source, 'Repeated DOM commit must be idempotent');
        assert.equal(result.repeatedRevision, result.revision, 'Repeated DOM commit must not create another revision');
        assert.equal(result.roundTripText, result.liveText, 'Reloaded text must match the live editing surface');
        assert.equal(result.serializedSource, result.source, 'Save/open must preserve the slide source');
        return result;
    };

    try {
        await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
            '<!doctype html><body><div id="host"></div></body>'
        ));
        for (const file of [
            'vdoc-core.js', 'scriptorium-document-store.js', 'scriptorium-deck-adapter.js',
            'scriptorium-dom-selection.js', 'scriptorium-input-sync.js', 'scriptorium-text-fragment.js', 'scriptorium-deck-editor.js',
        ]) {
            await win.webContents.executeJavaScript(fs.readFileSync(
                path.join(projectRoot, 'ScriptoriumModules', file), 'utf8'
            ));
        }

        for (const tag of ['p', 'h1', 'li', 'td']) {
            for (const shift of [false, true]) {
                await setup({ tag });
                await enter(shift);
                const first = await snapshot();
                assert.equal(first.liveText, 'Alpha\nBeta', `${tag}: one key must insert one line break`);
                assert.ok(first.revision > 0, 'Native Enter must actually reach the source');
                assert.equal(first.liveHtml, 'Alpha<br>Beta', `${tag}: use valid inline line-break markup`);
                await win.webContents.insertText('!');
                const continued = await snapshot();
                assert.equal(continued.liveText, 'Alpha\n!Beta');
                assert.equal((continued.source.match(/Beta/g) || []).length, 1, 'Continued typing must not duplicate the second line');
            }
        }

        await setup({ offset: 9 });
        await enter();
        const terminal = await snapshot();
        assert.equal(terminal.logicalText, 'AlphaBeta\n', JSON.stringify(terminal));
        assert.equal(terminal.source.includes('data-vdoc-caret-placeholder="true"'), true);

        // Consecutive empty lines, including caret placeholders at the end of a block.
        for (const html of ['', 'Alpha']) {
            await setup({ html, offset: html.length });
            await enter();
            await enter();
            await win.webContents.insertText('Beta');
            const result = await snapshot();
            assert.equal(result.liveText, `${html}\n\nBeta`);
        }
        await setup({ offset: 0 });
        await enter();
        assert.equal((await snapshot()).liveText, '\nAlphaBeta');

        // Replacing a selection must keep the surrounding inline style and use native undo.
        await setup({ html: '<strong>AlphaBeta</strong>', offset: 2, end: 7 });
        await enter();
        const styled = await snapshot();
        assert.equal(styled.liveText, 'Al\nta');
        assert.ok(styled.liveHtml.includes('<strong>'));
        assert.equal(await evaluate(() => document.execCommand('undo')), true);
        assert.equal((await snapshot()).liveText, 'AlphaBeta');
        assert.equal(await evaluate(() => document.execCommand('redo')), true);
        assert.equal((await snapshot()).liveText, styled.liveText);

        // IME confirmation and already-consumed beforeinput must not insert another break.
        await setup();
        const ignored = await evaluate(() => {
            const { target, adapter } = window.fixture;
            const original = target.innerHTML;
            const fire = (options = {}, cancel = false) => {
                const event = new InputEvent('beforeinput', {
                    bubbles: true, composed: true, cancelable: true,
                    inputType: 'insertParagraph', ...options,
                });
                if (cancel) event.preventDefault();
                target.dispatchEvent(event);
                return event.defaultPrevented;
            };
            const composingFlag = fire({ isComposing: true });
            target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            const composingSession = fire();
            target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
            const uncancelable = fire({ cancelable: false });
            fire({}, true);
            return { original, html: target.innerHTML, composingFlag, composingSession, uncancelable, source: adapter.currentSource() };
        });
        assert.equal(ignored.html, ignored.original);
        assert.equal(ignored.composingFlag, false);
        assert.equal(ignored.composingSession, false);
        assert.equal(ignored.uncancelable, false);
        await snapshot();

        // beforeinput-only keyboards take the same path without a physical keydown.
        await evaluate(() => window.fixture.target.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true, composed: true, cancelable: true, inputType: 'insertParagraph',
        })));
        assert.equal((await snapshot()).liveText, 'Alpha\nBeta');
        console.log('[ScriptoriumVPPTXLinebreak] PASSED');
    } finally {
        win.destroy();
    }
    app.quit();
}).catch(error => {
    console.error(error.stack);
    app.exit(1);
});
