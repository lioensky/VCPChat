const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../Musicmodules/music-window-visibility.js'), 'utf8');

function load() {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    let listener = null;
    window.utilityAPI = { onMusicWindowVisibility: (cb) => { listener = cb; return () => {}; } };
    window.eval(source);
    return { window, send: (payload) => listener(payload) };
}

test('minimizing the window reports the page hidden and fires visibilitychange once', () => {
    const { window, send } = load();
    const seen = [];
    window.document.addEventListener('visibilitychange', () => seen.push(window.document.hidden));
    assert.equal(window.document.hidden, false);
    send({ hidden: true });
    send({ hidden: true });
    assert.equal(window.document.hidden, true);
    assert.equal(window.document.visibilityState, 'hidden');
    send({ hidden: false });
    assert.equal(window.document.hidden, false);
    assert.equal(window.document.visibilityState, 'visible');
    assert.deepEqual(seen, [true, false]);
});

test('without the bridge in the preload the page is left alone', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    dom.window.eval(source);
    assert.equal(Object.getOwnPropertyDescriptor(dom.window.document, 'hidden'), undefined);
});
