'use strict';

if (require('./helpers/electron-test-entry.cjs').runFromNode(__filename)) return;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const projectRoot = path.resolve(__dirname, '..');
const results = [];

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: {
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    const evaluate = (fn, value) => win.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(value) ?? 'undefined'})`);
    const check = async (name, run) => {
        const started = performance.now();
        try {
            const detail = await run();
            results.push({ name, passed: true, elapsedMs: Math.round(performance.now() - started), detail });
        } catch (error) {
            results.push({ name, passed: false, elapsedMs: Math.round(performance.now() - started), error: error.message });
        }
    };
    try {
        await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><body><div id="host"></div></body>'));
        for (const name of ['vdoc-core.js', 'scriptorium-document-store.js', 'scriptorium-deck-adapter.js', 'scriptorium-dom-selection.js', 'scriptorium-input-sync.js', 'scriptorium-text-fragment.js', 'scriptorium-deck-editor.js']) {
            await win.webContents.executeJavaScript(fs.readFileSync(path.join(projectRoot, 'ScriptoriumModules', name), 'utf8'));
        }
        await evaluate(() => {
            const core = window.VDocCore;
            const primitives = window.ScriptoriumDomSelection;
            window.setupDeck = ({ tag = 'p', html = 'AlphaBeta', offset = 5, end = offset, style = '', content, selector = '[data-vdoc-text="target"]' } = {}) => {
                window.f?.editor.dispose();
                window.f?.documentPort.dispose();
                let text = `<${tag} data-vdoc-text="target" style="${style}">${html}</${tag}>`;
                if (tag === 'li') text = `<ul>${text}</ul>`;
                if (tag === 'td' || tag === 'th') text = `<table><tbody><tr>${text}</tr></tbody></table>`;
                if (tag === 'figcaption') text = `<figure>${text}</figure>`;
                const documentPort = window.ScriptoriumDocumentStore.createDocumentStore({ core });
                documentPort.replaceDocument(core.createDocument({ kind: core.PROJECT_KINDS.SLIDE_DECK, slides: [
                    { source: `<section class="vdoc-slide-scene">${content || text}</section>` },
                    { source: '<section><p data-vdoc-text="other">Untouched</p></section>' },
                ] }));
                const adapter = window.ScriptoriumDeckAdapter.createDeckAdapter({ core, documentPort });
                const host = document.getElementById('host');
                const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
                root.innerHTML = adapter.parsedSlide().html;
                const editor = window.ScriptoriumDeckEditor.createDeckEditor({ core, adapter, documentPort, selectionPrimitives: primitives });
                adapter.attachEditor(editor);
                editor.bindSurface(root);
                const target = root.querySelector(selector);
                let editingHost = target;
                while (editingHost.parentElement?.isContentEditable) editingHost = editingHost.parentElement;
                editingHost.focus();
                const range = primitives.restoreOffsets(target, offset, end);
                if (!range) throw new Error('Failed to set native selection');
                const f = window.f = { core, documentPort, adapter, editor, root, target, inputs: 0, beforeinputs: [] };
                root.addEventListener('input', () => f.inputs++);
                root.addEventListener('beforeinput', e => f.beforeinputs.push(e.inputType));
            };
            window.inspectDeck = ({ replay = 5, roundTrips = 5 } = {}) => {
                const f = window.f;
                f.editor.flush();
                const source = f.adapter.currentSource();
                const revision = f.documentPort.status().revision;
                for (let i = 0; i < replay; i++) f.editor.updateSourceNodes([...f.root.querySelectorAll('[data-vdoc-text]')]);
                let model = f.documentPort.document();
                for (let i = 0; i < roundTrips; i++) model = core.parse(core.serialize(model));
                const parsed = core.splitSlideSource(model.source.slides[0].source);
                const holder = document.createElement('div'); document.body.appendChild(holder);
                holder.innerHTML = '<style>' + parsed.css + '</style>' + parsed.html;
                const savedTarget = holder.querySelector('[data-vdoc-text="target"]') || holder;
                const glyphLines = node => {
                    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                    const glyphs = [];
                    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                        for (let offset = 0; offset < text.length; offset++) {
                            if (/[\r\n]/.test(text.data[offset])) continue;
                            const range = document.createRange();
                            range.setStart(text, offset); range.setEnd(text, offset + 1);
                            const rect = range.getBoundingClientRect();
                            if (rect.width || rect.height) glyphs.push({ text: text.data[offset], y: rect.y });
                        }
                    }
                    const origin = glyphs[0]?.y || 0;
                    return glyphs.map(glyph => ({ ...glyph, y: glyph.y - origin }));
                };
                const result = {
                    liveLines: glyphLines(f.target), savedLines: glyphLines(savedTarget),
                    source, repeatedSource: f.adapter.currentSource(), savedSource: model.source.slides[0].source,
                    revision, repeatedRevision: f.documentPort.status().revision,
                    live: f.target.innerText, liveHtml: f.target.innerHTML, saved: savedTarget.innerText,
                    text: f.target.textContent, savedText: savedTarget.textContent,
                    savedHtml: savedTarget.innerHTML, inputs: f.inputs, beforeinputs: f.beforeinputs,
                };
                holder.remove();
                return result;
            };
        });
        const setup = options => evaluate(options => window.setupDeck(options), options);
        const nativeEnter = async (count = 1, shift = false) => {
            const baseline = await evaluate(() => window.f.inputs);
            for (let i = 0; i < count; i++) {
                const modifiers = shift ? ['shift'] : [];
                win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers });
                win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
                win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers });
            }
            await evaluate(({ expected }) => new Promise((resolve, reject) => {
                const deadline = Date.now() + 5000;
                const poll = () => window.f.inputs >= expected ? resolve() : Date.now() > deadline
                    ? reject(new Error(`Expected ${expected} input events, got ${window.f.inputs}`)) : setTimeout(poll, 10);
                poll();
            }), { expected: baseline + count });
        };
        const inspect = async options => {
            const result = await evaluate(options => window.inspectDeck(options), options);
            assert.equal(result.repeatedSource, result.source, 'Replaying unchanged DOM changed source');
            assert.equal(result.repeatedRevision, result.revision, 'Replaying unchanged DOM advanced revision');
            assert.equal(result.savedSource, result.source, 'Repeated save/open changed source');
            // Chromium innerText overcounts DIV/BR placeholders; compare actual glyph lines
            // whenever DOM shapes differ, rather than requiring the old block-SPAN encoding.
            if (result.saved !== result.live) {
                assert.deepEqual(result.savedLines, result.liveLines, 'Rendered save/open changed glyph lines');
            }
            return result;
        };

        for (const tag of ['p', 'h1', 'h6', 'li', 'blockquote', 'figcaption', 'td', 'th']) {
            for (const offset of [0, 5, 9]) {
                await check(`native ${tag} Enter at ${offset}`, async () => {
                    await setup({ tag, offset });
                    await nativeEnter();
                    let result = await inspect();
                    // A terminal BR has a second caret-placeholder BR. innerText counts both,
                    // so type a sentinel to measure the actual editable line, not the placeholder.
                    if (offset === 9) {
                        await win.webContents.insertText('尾');
                        result = await inspect();
                    }
                    const expected = 'AlphaBeta'.slice(0, offset) + '\n' + (offset === 9 ? '尾' : '') + 'AlphaBeta'.slice(offset);
                    assert.equal(result.live, expected);
                    return { inputEvents: result.inputs, sourceUtf16Units: result.source.length };
                });
            }
        }
        for (const item of [
            { name: 'CJK', html: '汉字换行验证', offset: 2 },
            { name: 'emoji-ZWJ', html: '👨‍👩‍👧‍👦🙂Z', offset: 11 },
            { name: 'combining', html: 'éäZ', offset: 2 },
            { name: 'bidi', html: 'مرحبا世界Z', offset: 5 },
            { name: 'entities', html: '&lt;&amp;&gt;&nbsp;Z', offset: 3 },
            { name: 'nested-inline', html: '<strong><em>Alpha</em></strong><span style="color:red">Beta</span>', offset: 3, end: 7 },
            { name: 'full-selection', html: '<b>Alpha</b><i>Beta</i>', offset: 0, end: 9 },
            { name: 'pre-wrap', html: 'AlphaBeta', offset: 5, style: 'white-space:pre-wrap' },
            { name: 'pre-line', html: 'AlphaBeta', offset: 5, style: 'white-space:pre-line' },
            { name: 'break-spaces', html: 'AlphaBeta', offset: 5, style: 'white-space:break-spaces' },
            { name: 'rtl-style', html: 'AlphaBeta', offset: 5, style: 'direction:rtl' },
            { name: 'vertical', html: 'AlphaBeta', offset: 5, style: 'writing-mode:vertical-rl' },
        ]) {
            await check(item.name, async () => {
                await setup(item);
                const original = await evaluate(() => window.f.target.textContent);
                await nativeEnter();
                await win.webContents.insertText('中🙂');
                const result = await inspect();
                const expected = original.slice(0, item.offset) + '\n中🙂' + original.slice(item.end ?? item.offset);
                assert.equal(result.live.replace(/\u00a0/g, ' '), expected.replace(/\u00a0/g, ' '));
                return { inputEvents: result.inputs };
            });
        }
        await check('64 consecutive native Enter + continued typing + 100 commits + 100 save/open', async () => {
            await setup();
            await nativeEnter(64);
            await win.webContents.insertText('Tail');
            const result = await inspect({ replay: 100, roundTrips: 100 });
            assert.equal(result.live, 'Alpha' + '\n'.repeat(64) + 'TailBeta');
            return { enterKeys: 64, commits: 100, saveOpen: 100, inputEvents: result.inputs, sourceUtf16Units: result.source.length };
        });
        await check('32768 UTF-16 units paragraph + burst 32 Enter', async () => {
            const html = '甲乙🙂'.repeat(8192);
            await setup({ html, offset: 16384 });
            await nativeEnter(32);
            const result = await inspect({ replay: 20, roundTrips: 20 });
            assert.equal(result.live, html.slice(0, 16384) + '\n'.repeat(32) + html.slice(16384));
            return { utf16Units: html.length, enterKeys: 32, sourceUtf16Units: result.source.length };
        });
        await check('native Backspace joins the inserted line', async () => {
            await setup(); await nativeEnter();
            const baseline = await evaluate(() => window.f.inputs);
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
            await evaluate(baseline => new Promise((resolve, reject) => {
                const deadline = Date.now() + 5000;
                const poll = () => window.f.inputs > baseline ? resolve()
                    : Date.now() > deadline ? reject(new Error('Backspace input did not arrive')) : setTimeout(poll, 10);
                poll();
            }), baseline);
            const result = await inspect();
            assert.equal(result.live, 'AlphaBeta');
        });
        await check('20 undo/redo cycles preserve source', async () => {
            await setup(); await nativeEnter();
            const expected = (await inspect()).source;
            for (let i = 0; i < 20; i++) {
                assert.equal(await evaluate(() => document.execCommand('undo')), true);
                assert.equal((await inspect({ replay: 1, roundTrips: 1 })).live, 'AlphaBeta');
                assert.equal(await evaluate(() => document.execCommand('redo')), true);
                assert.equal((await inspect({ replay: 1, roundTrips: 1 })).source, expected);
            }
        });
        await check('nested editable list paragraph', async () => {
            await setup({ content: '<ul><li><p data-vdoc-text="target">AlphaBeta</p></li></ul>' });
            await nativeEnter();
            const result = await inspect();
            assert.equal(result.live, 'Alpha\nBeta');
        });
        await check('40 bind/dispose cycles do not multiply Enter handlers', async () => {
            await setup();
            await evaluate(() => { for (let i = 0; i < 40; i++) window.f.editor.bindSurface(window.f.root); });
            await evaluate(() => { const f = window.f; f.target.focus(); window.ScriptoriumDomSelection.restoreOffsets(f.target, 5); });
            await nativeEnter();
            assert.equal((await inspect()).live, 'Alpha\nBeta');
        });
        await check('immediate slide switch flushes pending input to the original slide', async () => {
            await setup(); await nativeEnter();
            const result = await evaluate(() => {
                const f = window.f;
                f.adapter.selectSlide(1);
                const other = f.adapter.currentSource();
                f.editor.disposeSurface();
                f.adapter.selectSlide(0);
                return { first: f.adapter.currentSource(), other };
            });
            assert.ok(result.first.includes('Alpha<br>Beta'));
            assert.ok(result.other.includes('Untouched'));
            assert.ok(!result.other.includes('Alpha'));
        });
        await check('plain multiline insertion (native insertText)', async () => {
            await setup();
            await win.webContents.insertText('一\n二\n三');
            const result = await inspect();
            assert.equal(result.live, 'Alpha一\n二\n三Beta');
        });
        await check('rich HTML insertion preserves subsequent Enter', async () => {
            await setup();
            assert.equal(await evaluate(() => document.execCommand('insertHTML', false, '<b>One</b><br><i>Two</i>')), true);
            await nativeEnter();
            const result = await inspect();
            assert.equal(result.live, 'AlphaOne\nTwo\nBeta');
        });
        for (const payload of ['一\n\n三', '\n一\n', '一\r\n二', '<&>\n🙂']) {
            await check(`multiline text ${JSON.stringify(payload)}`, async () => {
                await setup();
                await win.webContents.insertText(payload);
                const result = await inspect({ replay: 20, roundTrips: 20 });
                const expected = 'Alpha' + payload.replace(/\r\n?/g, '\n') + 'Beta';
                // innerText overcounts an empty DIV's placeholder BR. Compare every glyph's
                // vertical position with an independent pre-wrap text reference, live and saved.
                const positions = await evaluate(expected => {
                    const f = window.f;
                    const reference = document.createElement('p');
                    reference.style.font = getComputedStyle(f.target).font;
                    reference.style.whiteSpace = 'pre-wrap';
                    reference.textContent = expected;
                    document.body.appendChild(reference);
                    const restored = document.createElement('div');
                    restored.innerHTML = f.adapter.parsedSlide().html;
                    document.body.appendChild(restored);
                    const glyphs = node => {
                        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                        const result = [];
                        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                            for (let offset = 0; offset < text.length; offset++) {
                                if (/[\r\n]/.test(text.data[offset])) continue;
                                const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1);
                                result.push({ character: text.data[offset], y: range.getBoundingClientRect().y });
                            }
                        }
                        const origin = result[0]?.y || 0;
                        return result.map(glyph => ({ ...glyph, y: glyph.y - origin }));
                    };
                    const positions = { live: glyphs(f.target), saved: glyphs(restored.querySelector('[data-vdoc-text="target"]')), expected: glyphs(reference) };
                    reference.remove(); restored.remove();
                    return positions;
                }, expected);
                assert.deepEqual(positions.live, positions.expected, 'Inserted blank lines must occupy the expected visual lines');
                assert.deepEqual(positions.saved, positions.expected, 'Saved blank lines must occupy the expected visual lines');
                assert.equal(result.source.includes('<script'), false);
            });
        }
        for (const html of ['<div>一</div><div><br></div><div>三</div>', '<div style="color:red;font-weight:700">一</div><div>二</div>']) {
            await check(`rich block paste ${html}`, async () => {
                await setup();
                await evaluate(html => document.execCommand('insertHTML', false, html), html);
                await inspect({ replay: 20, roundTrips: 20 });
                await nativeEnter();
                await win.webContents.insertText('续');
                await inspect({ replay: 20, roundTrips: 20 });
            });
        }
        for (const payload of ['A\n', 'A\n\n', '\n']) {
            await check(`terminal empty lines ${JSON.stringify(payload)}`, async () => {
                await setup({ end: 9, offset: 0 });
                await win.webContents.insertText(payload);
                const sizes = await evaluate(() => {
                    const f = window.f;
                    f.editor.flush();
                    const holder = document.createElement('div');
                    holder.innerHTML = f.adapter.parsedSlide().html;
                    document.body.appendChild(holder);
                    const restored = holder.querySelector('[data-vdoc-text="target"]');
                    const result = { live: f.target.getBoundingClientRect().height, saved: restored.getBoundingClientRect().height,
                        liveHtml: f.target.innerHTML, savedHtml: restored.innerHTML };
                    holder.remove();
                    return result;
                });
                assert.equal(sizes.saved, sizes.live, JSON.stringify(sizes));
                await inspect({ replay: 20, roundTrips: 20 });
                await evaluate(() => {
                    const f = window.f;
                    const view = f.editor.captureViewState();
                    f.editor.disposeSurface();
                    f.root.innerHTML = f.adapter.parsedSlide().html;
                    f.editor.bindSurface(f.root);
                    f.target = f.root.querySelector('[data-vdoc-text="target"]');
                    if (!f.editor.restoreViewState(view)) throw new Error('Terminal caret did not restore');
                });
                await win.webContents.insertText('Z');
                assert.equal((await inspect()).live, payload + 'Z', 'Reloaded terminal caret must type on the final line');
                return sizes;
            });
        }
        await check('1000 native Enter burst keeps every line', async () => {
            await setup();
            await nativeEnter(1000);
            const result = await inspect({ replay: 10, roundTrips: 10 });
            assert.equal(result.live, 'Alpha' + '\n'.repeat(1000) + 'Beta');
            assert.equal(result.inputs, 1000, 'One native Enter must produce exactly one editing transaction');
            return { nativeEnters: 1000, inputEvents: result.inputs };
        });
        await check('seed 0x5eed: 250 mixed native edits match an independent string model', async () => {
            let seed = 0x5eed;
            const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 8; };
            let model = 'Start🙂Z';
            await setup({ html: model, offset: 0 });
            const counts = { Enter: 0, ShiftEnter: 0, insertText: 0, Backspace: 0 };
            for (let i = 0; i < 250; i++) {
                // Keep a final sentinel so caret placeholders never enter the logical text model.
                const offsets = [0];
                for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(model.slice(0, -1))) {
                    offsets.push(offsets.at(-1) + segment.length);
                }
                const start = offsets[random() % offsets.length];
                const endOptions = offsets.filter(offset => offset >= start);
                const end = i % 3 === 0 ? endOptions[random() % endOptions.length] : start;
                await evaluate(({ start, end }) => {
                    const { target, root } = window.f;
                    const points = [];
                    let consumed = 0;
                    const walk = node => {
                        if (node.nodeType === Node.TEXT_NODE) {
                            for (let offset = 0; offset <= node.length; offset++) points[consumed + offset] ??= [node, offset];
                            consumed += node.length;
                        } else if (node.nodeName === 'BR') {
                            const index = Array.from(node.parentNode.childNodes).indexOf(node);
                            points[consumed] ??= [node.parentNode, index];
                            points[++consumed] = [node.parentNode, index + 1];
                        } else for (const child of node.childNodes) walk(child);
                    };
                    walk(target);
                    if (!points[start] || !points[end]) throw new Error('Reference offsets not found in editing DOM');
                    target.focus();
                    const range = document.createRange();
                    range.setStart(...points[start]); range.setEnd(...points[end]);
                    const selection = root.getSelection(); selection.removeAllRanges(); selection.addRange(range);
                }, { start, end });
                const action = random() % 4;
                let inserted = '';
                if (action < 2) {
                    await nativeEnter(1, action === 1);
                    counts[action ? 'ShiftEnter' : 'Enter']++;
                    inserted = '\n';
                } else if (action === 2 || start === end) {
                    inserted = ['汉字', '🙂', '&<>', 'é'][random() % 4];
                    await win.webContents.insertText(inserted);
                    counts.insertText++;
                } else {
                    const baseline = await evaluate(() => window.f.inputs);
                    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
                    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
                    await evaluate(baseline => new Promise((resolve, reject) => {
                        const deadline = Date.now() + 5000;
                        const poll = () => window.f.inputs > baseline ? resolve()
                            : Date.now() > deadline ? reject(new Error('Random Backspace input did not arrive')) : setTimeout(poll, 10);
                        poll();
                    }), baseline);
                    counts.Backspace++;
                }
                model = model.slice(0, start) + inserted + model.slice(end);
                const actual = await inspect({ replay: 1, roundTrips: 1 });
                assert.equal(actual.live, model, `seed 0x5eed operation ${i}, action ${action}, range ${start}:${end}`);
            }
            return { seed: '0x5eed', operations: 250, counts };
        });
        await check('native Chromium IME composition commits once before Enter', async () => {
            await setup();
            const originalSource = await evaluate(() => window.f.adapter.currentSource());
            win.webContents.debugger.attach('1.3');
            try {
                await win.webContents.debugger.sendCommand('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 });
                const partial = await evaluate(() => { window.f.editor.flush(); return { source: window.f.adapter.currentSource(), text: window.f.target.textContent }; });
                assert.equal(partial.text, 'Alpha你Beta');
                assert.equal(partial.source, originalSource, 'Uncommitted IME text must not enter the document');
                await win.webContents.debugger.sendCommand('Input.imeSetComposition', { text: '你好', selectionStart: 2, selectionEnd: 2 });
                await win.webContents.debugger.sendCommand('Input.insertText', { text: '你好' });
                assert.equal((await inspect()).live, 'Alpha你好Beta');
                await nativeEnter();
                assert.equal((await inspect()).live, 'Alpha你好\nBeta');
            } finally { win.webContents.debugger.detach(); }
        });
        for (const nested of [false, true]) {
            await check(`cross paragraph selection in ${nested ? 'one nested' : 'independent'} editing hosts`, async () => {
                const paragraphs = '<p data-vdoc-text="target">Alpha</p><p data-vdoc-text="second">Beta</p>';
                await setup({ content: nested ? '<blockquote>' + paragraphs + '</blockquote>' : paragraphs, offset: 2 });
                await evaluate(() => {
                    const f = window.f;
                    const range = document.createRange();
                    range.setStart(f.target.firstChild, 2);
                    range.setEnd(f.root.querySelector('[data-vdoc-text="second"]').firstChild, 2);
                    const selection = f.root.getSelection(); selection.removeAllRanges(); selection.addRange(range);
                });
                await nativeEnter();
                const result = await evaluate(() => {
                    const f = window.f;
                    f.editor.flush();
                    const source = f.adapter.currentSource();
                    const rendered = document.createElement('div'); rendered.innerHTML = f.adapter.parsedSlide().html; document.body.appendChild(rendered);
                    const saved = rendered.querySelector('.vdoc-slide-scene').innerText;
                    const live = f.root.querySelector('.vdoc-slide-scene').innerText;
                    rendered.remove();
                    f.editor.updateSourceNodes([...f.root.querySelectorAll('[data-vdoc-text]')]);
                    return { source, repeated: f.adapter.currentSource(), saved, live, inputs: f.inputs };
                });
                assert.equal(result.repeated, result.source, 'Cross-host Enter must not leave an unsynchronized edit');
                assert.equal(result.saved, result.live, 'Cross-host selection must save exactly what is visible');
                return { inputEvents: result.inputs, resultText: result.live };
            });
        }
        await check('inherited white-space pre-wrap with nested block markup', async () => {
            await setup({ content: '<blockquote style="white-space:pre-wrap"><p data-vdoc-text="target">AlphaBeta</p></blockquote>' });
            await nativeEnter();
            assert.equal((await inspect()).live, 'Alpha\nBeta');
        });
    } finally {
        win.destroy();
        const report = { environment: { platform: process.platform, electron: process.versions.electron, chromium: process.versions.chrome }, total: results.length, passed: results.filter(x => x.passed).length, failed: results.filter(x => !x.passed).length, cases: results };
        const directory = path.join(projectRoot, 'artifacts', 'vpptx-enter-stress-20261115');
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'native-results.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
    }
    assert.equal(results.filter(x => !x.passed).length, 0, results.filter(x => !x.passed).map(x => `${x.name}: ${x.error}`).join('\n'));
    app.quit();
}).catch(error => { console.error(error.stack); app.exit(1); });
