'use strict';

if (require('./helpers/electron-test-entry.cjs').runFromNode(__filename)) return;

const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const projectRoot = path.resolve(__dirname, '..');

function registerMinimalIpc() {
    ipcMain.handle('get-current-theme', () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    ipcMain.handle('docx:recent-list', () => []);
    ipcMain.handle('docx:fonts-list', () => ['Arial', 'Microsoft YaHei']);
    for (const channel of [
        'docx:choose-open', 'scriptorium:choose-import', 'docx:read-path', 'docx:save',
    ]) ipcMain.handle(channel, () => ({ success: false, canceled: true }));
    ipcMain.handle('scriptorium:svg-assets-load', () => []);
    ipcMain.handle('scriptorium:svg-assets-save', (_event, packs = []) => ({
        success: true, count: packs.length, size: 0,
    }));
    ipcMain.handle('scriptorium:export-rich-document', () => ({ success: false, canceled: true }));
    ipcMain.handle('open-docx-window', () => ({ success: true }));
    for (const channel of [
        'window-lifecycle:ready', 'minimize-window', 'maximize-window',
        'unmaximize-window', 'open-dev-tools',
    ]) ipcMain.on(channel, () => {});
    ipcMain.on('close-window', () => app.quit());
}

app.whenReady().then(async () => {
    registerMinimalIpc();
    const win = new BrowserWindow({
        width: 1440, height: 900, show: false, frame: false,
        webPreferences: {
            preload: path.join(projectRoot, 'preloads', 'docx.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: false,
            backgroundThrottling: false,
        },
    });
    const deadline = setTimeout(() => {
        console.error('[ScriptoriumVPPTXHistory] exceeded 75 second deadline');
        app.exit(1);
    }, 75000);
    const evaluate = async (fn, value) => {
        const result = await win.webContents.executeJavaScript(`(async () => {
            try { return { value: await (${fn.toString()})(${JSON.stringify(value) ?? 'undefined'}) }; }
            catch (error) { return { error: error.stack || String(error) }; }
        })()`);
        if (result.error) throw new Error(result.error);
        return result.value;
    };
    const settle = () => evaluate(() => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
    ));
    const waitFor = async (fn, description) => {
        const started = Date.now();
        while (Date.now() - started < 8000) {
            if (await evaluate(fn)) return;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`Timed out waiting for ${description}`);
    };
    const key = async (keyCode, modifiers = []) => {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        if (keyCode === 'Return') {
            win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
        }
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
        await settle();
    };
    const click = async id => {
        await evaluate(id => document.getElementById(id).click(), id);
        await settle();
    };
    const place = async (start, end = start) => evaluate(({ start, end }) => {
        const root = document.getElementById('page-stream').shadowRoot;
        const target = root.querySelector(`[data-vdoc-text="${CSS.escape(window.historyTextId)}"]`);
        assertTarget(target);
        function assertTarget(node) {
            if (!node) throw new Error('History fixture text block was lost');
        }
        target.focus();
        const range = document.createRange();
        if (start === 'all') range.selectNodeContents(target);
        else {
            const point = offset => {
                const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
                let node;
                while ((node = walker.nextNode())) {
                    if (offset <= node.length) return { node, offset };
                    offset -= node.length;
                }
                return { node: target, offset: target.childNodes.length };
            };
            const a = point(start);
            const b = point(end);
            range.setStart(a.node, a.offset);
            range.setEnd(b.node, b.offset);
        }
        const selection = root.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }, { start, end });
    const snapshot = () => evaluate(() => {
        const root = document.getElementById('page-stream').shadowRoot;
        const target = root.querySelector(`[data-vdoc-text="${CSS.escape(window.historyTextId)}"]`);
        const source = window.ScriptoriumAgent.current().getSource({ sourceKind: 'html' }).source;
        const template = document.createElement('template');
        template.innerHTML = source;
        const saved = template.content.querySelector(`[data-vdoc-text="${CSS.escape(window.historyTextId)}"]`);
        const text = node => {
            if (!node) return null;
            const clone = node.cloneNode(true);
            clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
            return clone.textContent;
        };
        return {
            liveText: text(target), sourceText: text(saved), source,
            liveHtml: target?.innerHTML || null,
            liveVisualText: target?.innerText || '',
            activeTag: root.activeElement?.tagName || document.activeElement?.tagName,
            focused: Boolean(target && root.activeElement === target),
            slideIndex: window.ScriptoriumAgent.common.getDocumentInfo().activeSlideIndex,
        };
    });
    const failures = [];
    const check = (name, action) => {
        try { action(); console.log(`[ScriptoriumVPPTXHistory] PASS ${name}`); }
        catch (error) {
            failures.push({ name, message: error.message });
            console.error(`[ScriptoriumVPPTXHistory] FAIL ${name}: ${error.message}`);
        }
    };
    try {
        await win.loadFile(path.join(projectRoot, 'ScriptoriumModules', 'scriptorium.html'));
        await waitFor(() => Boolean(window.ScriptoriumAgent && document.getElementById('new-deck-btn')), 'application bootstrap');
        await click('new-deck-btn');
        await waitFor(() => Boolean(document.getElementById('page-stream').shadowRoot
            ?.querySelector('.vdoc-slide-editor-runtime [data-vdoc-text]')), 'new deck surface');
        await verifyBoundaries();
        await evaluate(() => {
            const root = document.getElementById('page-stream').shadowRoot;
            const target = root.querySelector('.vdoc-slide-editor-runtime p[data-vdoc-text]');
            if (!target) throw new Error('Default deck has no paragraph fixture');
            window.historyTextId = target.dataset.vdocText;
        });
        await place('all');
        await win.webContents.insertText('AlphaBeta');
        await settle();
        await click('html-mode-btn');
        await click('render-mode-btn');
        const baseline = await snapshot();
        assert.equal(baseline.liveText, 'AlphaBeta');
        assert.equal(baseline.sourceText, 'AlphaBeta');
        await place(5);
        await key('Return');
        assert.equal((await snapshot()).liveText, 'Alpha\nBeta', 'Native Enter must insert one break');

        for (let round = 1; round <= 5; round += 1) {
            await key('Z', ['control']);
            const undone = await snapshot();
            check(`native Ctrl+Z round ${round}`, () => {
                assert.equal(undone.liveText, 'AlphaBeta');
                assert.equal(undone.sourceText, 'AlphaBeta');
            });
            await key('Y', ['control']);
            const redone = await snapshot();
            check(`native Ctrl+Y round ${round}`, () => {
                assert.equal(redone.liveText, 'Alpha\nBeta');
                assert.equal(redone.sourceText, 'Alpha\nBeta');
            });
        }

        await win.webContents.insertText('!');
        await settle();
        const continued = await snapshot();
        check('typing immediately after app redo retains caret', () => {
            assert.equal(continued.liveText, 'Alpha\n!Beta', JSON.stringify(continued));
        });
        if (continued.liveText !== 'Alpha\n!Beta') {
            // Refocus only after recording the failed production behavior so later checks remain independent.
            await evaluate(() => {
                const root = document.getElementById('page-stream').shadowRoot;
                const target = root.querySelector(`[data-vdoc-text="${CSS.escape(window.historyTextId)}"]`);
                target.focus();
                const range = document.createRange();
                range.setStartAfter(target.querySelector('br'));
                range.collapse(true);
                root.getSelection().removeAllRanges();
                root.getSelection().addRange(range);
            });
            await win.webContents.insertText('!');
            await settle();
        }
        const beforeModes = await snapshot();
        await click('html-mode-btn');
        const sourceView = await evaluate(() => document.querySelector(
            '#source-host .source-editor-shell .CodeMirror'
        )?.CodeMirror?.getValue() || '');
        await click('render-mode-btn');
        const afterModes = await snapshot();
        check('source and render mode round trip', () => {
            assert.ok(sourceView.includes(beforeModes.liveHtml), sourceView);
            assert.equal(afterModes.liveText, beforeModes.liveText);
            assert.equal(afterModes.sourceText, beforeModes.liveText);
        });
        await click('add-slide-btn');
        const secondIndex = await evaluate(() => window.ScriptoriumAgent.common.getDocumentInfo().activeSlideIndex);
        await evaluate(() => window.ScriptoriumAgent.pptx.selectSlide({ slideIndex: 0 }));
        await settle();
        const returned = await snapshot();
        check('switch slide and return retains edited text', () => {
            assert.equal(secondIndex, 1);
            assert.equal(returned.slideIndex, 0);
            assert.equal(returned.liveText, beforeModes.liveText);
            assert.equal(returned.sourceText, beforeModes.liveText);
        });
        await place('all');
        await win.webContents.insertText('一\n二\n三');
        await settle();
        const multiline = await snapshot();
        check('native multiline insertion visual text', () => {
            assert.equal(multiline.liveVisualText, '一\n二\n三');
        });
        await key('Z', ['control']);
        const multilineUndo = await snapshot();
        check('app undo after multiline insertion', () => {
            assert.equal(multilineUndo.liveText, returned.liveText);
            assert.equal(multilineUndo.sourceText, returned.sourceText);
        });
        await key('Y', ['control']);
        await win.webContents.insertText('!');
        await settle();
        const multilineContinued = await snapshot();
        check('typing after multiline normalization and app redo', () => {
            assert.equal(multilineContinued.focused, true);
            assert.equal(multilineContinued.liveVisualText, '一\n二\n三!');
            assert.equal(multilineContinued.liveText, '一\n二\n三!');
            assert.ok(!multilineContinued.liveHtml.includes('<div'));
        });
        await click('html-mode-btn');
        await click('render-mode-btn');
        const multilineReloaded = await snapshot();
        check('multiline continuation source round trip', () => {
            assert.equal(multilineReloaded.liveVisualText, '一\n二\n三!');
            assert.equal(multilineReloaded.sourceText, '一\n二\n三!');
        });

        async function verifyBoundaries() {
        const boundaries = await evaluate(() => {
            const host = document.createElement('div');
            document.body.appendChild(host);
            const root = host.attachShadow({ mode: 'open' });
            let sourceDefinition = null;
            const adapter = {
                kind: 'deck', currentSource: () => sourceDefinition ?? root.innerHTML,
                replaceCurrentSource: (source) => { sourceDefinition = source; return true; },
            };
            const editor = window.ScriptoriumDeckEditor.createDeckEditor({
                adapter, documentPort: {}, core: window.VDocCore,
                selectionPrimitives: window.ScriptoriumDomSelection,
            });
            const cases = [
                ['before BR', 'A<br>B', 1, 'A|\nB'],
                ['after BR', 'A<br>B', 2, 'A\n|B'],
                ['between BRs', 'A<br><br>B', 2, 'A\n|\nB'],
                ['after repeated BRs', 'A<br><br>B', 3, 'A\n\n|B'],
                ['empty block', '', 0, '|'],
                ['trailing placeholder', 'A<br><br>', 2, 'A\n|\n'],
                ['styled inline', '<strong>A</strong><br><em>B</em>', 2, 'A\n|B'],
                ['nested li editing host', 'A<br>B', 2, 'A\n|B', 'li'],
                ['nested td editing host', 'A<br>B', 2, 'A\n|B', 'td'],
            ];
            const result = [];
            try {
                for (const [name, html, offset, expected, parent] of cases) {
                    const paragraph = `<p data-vdoc-text="probe">${html}</p>`;
                    const source = parent === 'li' ? `<ul><li>${paragraph}</li></ul>`
                        : parent === 'td' ? `<table><tbody><tr><td>${paragraph}</td></tr></tbody></table>`
                            : paragraph;
                    root.innerHTML = source;
                    editor.bindSurface(root);
                    const target = root.querySelector('p');
                    (parent ? target.closest(parent) : target).focus();
                    const range = document.createRange();
                    range.setStart(target, offset);
                    range.collapse(true);
                    root.getSelection().removeAllRanges();
                    root.getSelection().addRange(range);
                    const saved = editor.captureViewState();
                    root.innerHTML = source;
                    editor.bindSurface(root);
                    const restored = editor.restoreViewState(saved);
                    const focused = root.activeElement === root.querySelector(parent || 'p');
                    root.getSelection().getRangeAt(0).insertNode(document.createTextNode('|'));
                    root.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
                    result.push({ name, expected, actual: root.textContent, restored, focused });
                }
                root.innerHTML = '<p data-vdoc-text="probe">一</p>';
                sourceDefinition = root.innerHTML;
                editor.bindSurface(root);
                const target = root.querySelector('p');
                // Reproduce the P/DIV tree from native insertion without HTML parser repair.
                for (const text of ['二', '三']) {
                    const line = document.createElement('div');
                    line.textContent = text;
                    target.appendChild(line);
                }
                target.focus();
                const secondLine = target.querySelector('div');
                const range = document.createRange();
                range.setStart(secondLine.firstChild, 0);
                range.collapse(true);
                root.getSelection().removeAllRanges();
                root.getSelection().addRange(range);
                const saved = editor.captureViewState();
                editor.updateSourceNodes([target]);
                root.innerHTML = sourceDefinition;
                editor.bindSurface(root);
                const restored = editor.restoreViewState(saved);
                const focused = root.activeElement === root.querySelector('p');
                document.execCommand('insertText', false, '|');
                result.push({
                    name: 'second-line start after DIV normalization with native typing',
                    expected: '一\n|二\n三', actual: root.querySelector('p').innerText,
                    restored, focused,
                });
            } finally {
                editor.dispose();
                host.remove();
            }
            return result;
        });
        for (const result of boundaries) check(`restored caret ${result.name}`, () => {
            assert.equal(result.restored, true);
            assert.equal(result.focused, true);
            assert.equal(result.actual, result.expected);
        });
        }
        console.log('[ScriptoriumVPPTXHistory] ' + JSON.stringify({ failures, continued, afterModes, returned }));
        assert.equal(failures.length, 0, `${failures.length} app history assertions failed`);
    } finally {
        clearTimeout(deadline);
        win.destroy();
    }
    app.quit();
}).catch(error => {
    console.error(error.stack);
    app.exit(1);
});
