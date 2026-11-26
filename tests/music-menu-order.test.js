// 曲目右键菜单按组排序：播放 / 歌单与喜欢 / 去哪儿看 / 工具 / 移除
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const src = fs.readFileSync(path.join(__dirname, '../Musicmodules/music-menu-order.js'), 'utf8');
const item = (a) => `<div class="context-menu-item" data-action="${a}">${a}</div>`;

function setup(actions) {
    const html = `<div id="track-context-menu" class="context-menu">${actions.map((a) => (a === '-' ? '<div class="context-menu-divider"></div>' : item(a))).join('')}<i class="mf-trail"></i></div>`;
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { runScripts: 'outside-only' });
    dom.window.eval(src);
    // 页面里是等 DOMContentLoaded 再排；这里文档已经解析完，直接排一次
    dom.window.MusicMenuOrder.arrange(dom.window.document.getElementById('track-context-menu'));
    return dom.window;
}
const order = (w) => [...w.document.getElementById('track-context-menu').children].map((el) => (el.classList.contains('context-menu-divider') ? '-' : el.dataset.action || el.className));

test('items injected after add-to-queue end up in their groups with one divider between groups', () => {
    const w = setup(['play', 'play-next', 'add-to-queue', 'start-radio', 'toggle-like', 'goto-artist', 'goto-album', 'copy-title', '-', 'get-lyrics', '-', 'add-to-playlist', 'create-playlist-add', '-', 'remove-from-list']);
    assert.deepEqual(order(w), ['play', 'play-next', 'add-to-queue', '-', 'add-to-playlist', 'create-playlist-add', 'toggle-like', '-', 'start-radio', 'goto-artist', 'goto-album', '-', 'copy-title', 'get-lyrics', '-', 'remove-from-list', 'mf-trail']);
});

test('a module that adds an item later is placed too, unknown items go with the tools', async () => {
    const w = setup(['play', 'add-to-queue', '-', 'remove-from-list']);
    const menu = w.document.getElementById('track-context-menu');
    const late = w.document.createElement('div');
    late.className = 'context-menu-item';
    late.dataset.action = 'share';
    menu.appendChild(late);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(order(w), ['play', 'add-to-queue', '-', 'share', '-', 'remove-from-list', 'mf-trail']);
});

test('dividers around a hidden group collapse to one', () => {
    const w = setup(['play', 'add-to-queue', 'goto-artist', 'remove-from-list']);
    const menu = w.document.getElementById('track-context-menu');
    menu.querySelector('[data-action="goto-artist"]').style.display = 'none';
    w.MusicMenuOrder.tidyDividers(menu);
    const shown = [...menu.children].filter((el) => el.style.display !== 'none').map((el) => (el.classList.contains('context-menu-divider') ? '-' : el.dataset.action || 'trail'));
    assert.deepEqual(shown, ['play', 'add-to-queue', '-', 'remove-from-list', 'trail']);
});

test('a menu opened with the mouse gets the keyboard handler (without highlighting an item); one opened from the keyboard is left alone', async () => {
    const w = setup(['play', 'add-to-queue', '-', 'remove-from-list']);
    const menu = w.document.getElementById('track-context-menu');
    const calls = [];
    w.MusicArchiveList = { menuKeyboard: (app, opts) => { calls.push(opts); } };
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    await new Promise((r) => setTimeout(r, 0));
    menu.classList.add('visible');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].focus, false);
    menu.classList.remove('visible');
    await new Promise((r) => setTimeout(r, 0));
    menu.__kbdDetach = () => {};
    menu.classList.add('visible');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.length, 1);
});
