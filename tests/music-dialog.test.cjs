// 音乐窗口里不再弹系统原生的确认框 / 提示框，统一用 MusicDialog.confirm。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function setup() {
    const dom = new JSDOM('<!doctype html><body><button id="opener">x</button></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    window.requestAnimationFrame = (fn) => { fn(); return 1; };
    window.eval(read('Musicmodules/music-dock/music-dialog.js'));
    return { window, doc: window.document };
}

const key = (window, k, opts = {}) => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));

test('confirm shows title, message and a red confirm button for destructive actions', async () => {
    const { window, doc } = setup();
    const pending = window.MusicDialog.confirm({ title: '删除歌单「夜」？', message: '里面的歌还在。', confirmText: '删除', danger: true });
    const overlay = doc.querySelector('.dialog-overlay.music-dialog');
    assert.ok(overlay.classList.contains('visible'));
    assert.equal(overlay.querySelector('h3').textContent, '删除歌单「夜」？');
    assert.equal(overlay.querySelector('.music-dialog-msg').textContent, '里面的歌还在。');
    const ok = overlay.querySelector('.dialog-btn.confirm');
    assert.ok(ok.classList.contains('danger'));
    assert.equal(ok.textContent, '删除');
    assert.equal(doc.activeElement, ok);
    ok.click();
    assert.equal(await pending, true);
    assert.ok(!overlay.classList.contains('visible'));
});

test('Esc cancels and does not reach other shortcuts; focus returns to the opener', async () => {
    const { window, doc } = setup();
    const opener = doc.getElementById('opener');
    opener.focus();
    let leaked = 0;
    doc.addEventListener('keydown', () => { leaked++; });
    const pending = window.MusicDialog.confirm({ title: 't' });
    key(window, ' ');
    key(window, 'Escape');
    assert.equal(await pending, false);
    assert.equal(leaked, 0, 'space and Esc stay inside the dialog');
    assert.equal(doc.activeElement, opener);
});

test('Enter confirms unless the cancel button has focus; Tab stays between the two buttons', async () => {
    const { window, doc } = setup();
    let pending = window.MusicDialog.confirm({ title: 'a' });
    key(window, 'Enter');
    assert.equal(await pending, true);
    pending = window.MusicDialog.confirm({ title: 'b' });
    const overlay = [...doc.querySelectorAll('.music-dialog')].pop();
    key(window, 'Tab');
    assert.equal(doc.activeElement, overlay.querySelector('.dialog-btn.cancel'));
    key(window, 'Tab');
    assert.equal(doc.activeElement, overlay.querySelector('.dialog-btn.confirm'));
    key(window, 'Tab');
    key(window, 'Enter');
    assert.equal(await pending, false);
});

test('Enter and Escape during IME composition do not dismiss the dialog', async () => {
    const { window, doc } = setup();
    let settled = false;
    const pending = window.MusicDialog.confirm({ title: '确认' }).then((res) => { settled = true; return res; });
    key(window, 'Enter', { isComposing: true });
    key(window, 'Escape', { isComposing: true });
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'IME composition Enter/Escape must be ignored');
    assert.ok(doc.querySelector('.dialog-overlay.music-dialog').classList.contains('visible'));
    key(window, 'Enter', { isComposing: false });
    assert.equal(await pending, true);
});

test('dismissing MusicDialog before the opening rAF prevents stale visible class and focus hijack', async () => {
    const dom = new JSDOM('<!doctype html><body><button id="opener">x</button></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    const doc = window.document;
    const rafs = [];
    window.requestAnimationFrame = (fn) => { rafs.push(fn); return rafs.length; };
    window.eval(read('Musicmodules/music-dock/music-dialog.js'));
    const opener = doc.getElementById('opener');
    opener.focus();
    const pending = window.MusicDialog.confirm({ title: 't' });
    const overlay = doc.querySelector('.dialog-overlay.music-dialog');
    overlay.querySelector('.dialog-btn.cancel').click();
    assert.equal(await pending, false);
    assert.equal(rafs.length, 1);
    rafs[0]();
    assert.equal(overlay.classList.contains('visible'), false, 'stale rAF must not re-add .visible');
    assert.equal(doc.activeElement, opener, 'stale rAF must not hijack focus back to closed dialog');
    dom.window.close();
});

test('no native confirm()/alert() is called directly in the music window', () => {
    const files = ['Musicmodules/music.js', 'Musicmodules/music-sidebar.js', 'Musicmodules/music-webdav.js'];
    for (const f of files) {
        const src = read(f);
        assert.doesNotMatch(src, /(^|[^.\w])alert\(/m, `${f} uses alert()`);
        for (const m of src.matchAll(/(^|[^.\w])confirm\(/gm)) {
            const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
            assert.match(line, /MusicDialog/, `${f}: confirm() only as a fallback when MusicDialog is missing`);
        }
    }
    assert.match(read('Musicmodules/music.html'), /music-dock\/music-dialog\.js/);
});

test('navigation keys stay trapped inside MusicDialog and Left/Right switch between confirm and cancel buttons', async () => {
    const { window, doc } = setup();
    let leaked = 0;
    doc.addEventListener('keydown', () => { leaked += 1; });
    const pending = window.MusicDialog.confirm({ title: '确认操作' });
    const overlay = doc.querySelector('.dialog-overlay.music-dialog');
    const confirmBtn = overlay.querySelector('.dialog-btn.confirm');
    const cancelBtn = overlay.querySelector('.dialog-btn.cancel');
    assert.equal(doc.activeElement, confirmBtn);

    key(window, 'ArrowDown');
    key(window, 'ArrowUp');
    key(window, 'Home');
    key(window, 'End');
    key(window, 'PageDown');
    assert.equal(leaked, 0, 'navigation keys do not leak to archive/stage behind dialog');

    key(window, 'ArrowLeft');
    assert.equal(doc.activeElement, cancelBtn, 'ArrowLeft toggles focus to cancel');
    key(window, 'ArrowRight');
    assert.equal(doc.activeElement, confirmBtn, 'ArrowRight toggles focus back to confirm');
    key(window, 'Escape');
    assert.equal(await pending, false);
    assert.equal(leaked, 0);
});

test('Batch 53: beforeunload resolves open MusicDialog as false and removes global keydown listener', async () => {
    const { window, doc } = setup();
    let leaked = 0;
    doc.addEventListener('keydown', () => { leaked += 1; });
    const pending = window.MusicDialog.confirm({ title: '卸载测试' });
    window.dispatchEvent(new window.Event('beforeunload'));
    assert.equal(await pending, false, 'beforeunload resolves pending confirm promise as false');
    key(window, ' ');
    assert.equal(leaked, 1, 'keydown listener is detached after beforeunload');
});

test('Batch 57: stacked MusicDialog confirms route Escape only to the topmost dialog', async () => {
    const { window } = setup();
    let firstDone = false;
    const p1 = window.MusicDialog.confirm({ title: '第一层' }).then((v) => { firstDone = true; return v; });
    const p2 = window.MusicDialog.confirm({ title: '第二层' });

    key(window, 'Escape');
    assert.equal(await p2, false, 'Escape dismisses the topmost dialog');
    await new Promise((r) => setImmediate(r));
    assert.equal(firstDone, false, 'underlying dialog remains open after topmost is dismissed');

    key(window, 'Enter');
    assert.equal(await p1, true, 'subsequent Enter confirms the now-topmost underlying dialog');
});

test('Batch 70: dismissed MusicDialog sets data-closing=1 and beforeunload clears its pending exit removal timer', async () => {
    const { window, doc } = setup();
    const pending = window.MusicDialog.confirm({ title: '退出清理' });
    const overlay = doc.querySelector('.dialog-overlay.music-dialog');
    assert.equal(overlay.dataset.closing, undefined);
    overlay.querySelector('.dialog-btn.cancel').click();
    assert.equal(await pending, false);
    assert.equal(overlay.dataset.closing, '1', 'fading MusicDialog marks data-closing=1 immediately');
    assert.equal(overlay.isConnected, true, 'overlay stays connected briefly for exit animation');
    window.dispatchEvent(new window.Event('beforeunload'));
    assert.equal(overlay.isConnected, false, 'beforeunload removes fading overlay immediately');
});

test('Batch 98: MusicDialog restores focus before class removal and avoids body.focus() reflow when opened from body', async () => {
    const { window, doc } = setup();
    const opener = doc.getElementById('opener');
    opener.focus();
    const order = [];
    const origFocus = opener.focus.bind(opener);
    opener.focus = (opts) => { order.push('focus'); return origFocus(opts); };

    const p1 = window.MusicDialog.confirm({ title: '先归还焦点' });
    const overlay1 = doc.querySelector('.dialog-overlay.music-dialog');
    const origRemove = overlay1.classList.remove.bind(overlay1.classList);
    overlay1.classList.remove = (...args) => {
        if (args.includes('visible')) order.push('hide');
        return origRemove(...args);
    };
    overlay1.querySelector('.dialog-btn.cancel').click();
    assert.equal(await p1, false);
    assert.deepEqual(order, ['focus', 'hide'], 'opener.focus runs before removing .visible class');

    // Opening while activeElement is document.body must not call body.focus() on close
    opener.blur();
    assert.equal(doc.activeElement, doc.body);
    let bodyFocusCalls = 0;
    const origBodyFocus = doc.body.focus.bind(doc.body);
    doc.body.focus = (opts) => { bodyFocusCalls += 1; return origBodyFocus(opts); };
    const p2 = window.MusicDialog.confirm({ title: '无焦点来源' });
    const overlay2 = [...doc.querySelectorAll('.dialog-overlay.music-dialog')].pop();
    overlay2.querySelector('.dialog-btn.confirm').click();
    assert.equal(await p2, true);
    assert.equal(bodyFocusCalls, 0, 'closing dialog opened from body blurs active control without calling body.focus()');
    window.dispatchEvent(new window.Event('beforeunload'));
});
