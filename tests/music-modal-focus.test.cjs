// 弹窗的焦点管理：关着的弹窗设 inert（不进 Tab 顺序），开着的才能点。
// WebDAV 的两个弹窗用 active 类打开，以前只认 visible，WebDAV 弹窗一开就是 inert：看得见，点什么都没反应，连关闭钮都点不了。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function setup() {
    const html = fs.readFileSync('Musicmodules/music.html', 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    window.Element.prototype.getClientRects = function () { return [{}]; };
    window.eval(fs.readFileSync('Musicmodules/music-modal-focus.js', 'utf8'));
    return { dom, window, doc: window.document };
}
const tick = (w) => new Promise((r) => w.setTimeout(r, 0));

for (const [id, cls] of [['webdav-modal', 'active'], ['webdav-server-dialog', 'active'], ['playlist-edit-modal', 'visible'], ['lyrics-fetch-modal', 'visible'], ['playlist-dialog', 'visible']]) {
    test(`#${id} opened with .${cls} can be used, and goes inert again when closed`, async () => {
        const { dom, window, doc } = setup();
        await tick(window);
        const o = doc.getElementById(id);
        assert.equal(o.inert, true, 'closed: out of the tab order');
        o.classList.add(cls);
        await tick(window);
        assert.equal(o.inert, false, 'open: clickable and focusable');
        assert.ok(o.contains(doc.activeElement), 'focus moves into the dialog');
        o.classList.remove(cls);
        await tick(window);
        assert.equal(o.inert, true);
        dom.window.close();
    });
}

test('Esc closes the top dialog through its own close or cancel button', async () => {
    const { dom, window, doc } = setup();
    await tick(window);
    const list = doc.getElementById('webdav-modal');
    const add = doc.getElementById('webdav-server-dialog');
    const clicks = [];
    doc.getElementById('webdav-modal-close').addEventListener('click', () => { clicks.push('list'); list.classList.remove('active'); });
    doc.getElementById('webdav-dialog-cancel').addEventListener('click', () => { clicks.push('add'); add.classList.remove('active'); });
    list.classList.add('active');
    add.classList.add('active');
    await tick(window);
    const esc = () => doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    esc();
    assert.deepEqual(clicks, ['add'], 'only the dialog on top closes');
    await tick(window);
    esc();
    assert.deepEqual(clicks, ['add', 'list']);
    const composing = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true });
    list.classList.add('active'); await tick(window);
    doc.activeElement.dispatchEvent(composing);
    assert.deepEqual(clicks, ['add', 'list'], 'Esc for the input method does not close');
    dom.window.close();
});

test('closing the playlist editor re-renders the list, and focus still lands on that playlist\'s edit button', async () => {
    const { dom, window, doc } = setup();
    await tick(window);
    const view = doc.getElementById('sidebar-category-view');
    const render = () => { view.innerHTML = ['a', 'b', 'c'].map((n) => `<div class="category-item"><button class="edit-btn">${n}</button></div>`).join(''); };
    render();
    const modal = doc.getElementById('playlist-edit-modal');
    view.querySelectorAll('.edit-btn')[1].focus();
    modal.classList.add('visible');
    await tick(window);
    assert.ok(modal.contains(doc.activeElement));
    modal.classList.remove('visible');
    render(); // music.js 关弹窗时会重画侧栏歌单列表
    await tick(window);
    assert.equal(doc.activeElement, view.querySelectorAll('.edit-btn')[1], 'focus returns to the rebuilt button for the same playlist');
    dom.window.close();
});
