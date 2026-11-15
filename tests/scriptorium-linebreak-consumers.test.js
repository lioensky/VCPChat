'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function load(window, file) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'ScriptoriumModules', file), 'utf8');
    window.eval(source);
}

test('agent text extraction preserves BR line boundaries', t => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    load(dom.window, 'scriptorium-agent-port.js');
    assert.equal(dom.window.ScriptoriumAgentPort.textFromHtml('Alpha<br>Beta'), 'Alpha\nBeta');
});

test('rendered search does not match text joined across an explicit BR', t => {
    const dom = new JSDOM('<!doctype html><body><div class="vdoc-runtime"><p data-vdoc-text="p">Alpha<br>Beta</p></div></body>', {
        runScripts: 'outside-only',
    });
    t.after(() => dom.window.close());
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    load(dom.window, 'scriptorium-find.js');
    const elements = {
        'find-panel': { hidden: false },
        'find-input': { value: 'AlphaBeta' },
        'find-status': { textContent: '', classList: { toggle() {} } },
    };
    const find = dom.window.ScriptoriumFind.createFindController({
        elements,
        surfacePort: { mode: () => 'read', activeRoot: () => dom.window.document },
    });
    assert.equal(find.refresh(), false);
    assert.equal(elements['find-status'].textContent, '无匹配');
    elements['find-input'].value = 'Beta';
    assert.equal(find.refresh(), true);
});
