// 「添加到歌单」子菜单：窗口窄到左右两边都放不下时（最小宽度 420），不能伸出窗口外，
// 收窄到空间大的那一边放得下，长歌单名用省略号、完整名字放在 title 里。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function setup({ width, menu }) {
    const dom = new JSDOM(`<!doctype html><body><div id="menu" class="context-menu"><div class="context-menu-item has-submenu">添加到歌单<div class="context-submenu" id="sub"></div></div></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
    window.eval(fs.readFileSync('Musicmodules/music-sidebar.js', 'utf8'));
    const doc = window.document;
    const menuEl = doc.getElementById('menu');
    const sub = doc.getElementById('sub');
    menuEl.getBoundingClientRect = () => ({ ...menu, width: menu.right - menu.left, height: menu.bottom - menu.top });
    // 子菜单的自然宽度：被 max-width 收窄后就是 max-width
    Object.defineProperty(sub, 'offsetWidth', { get: () => (sub.style.maxWidth ? parseFloat(sub.style.maxWidth) : 231) });
    const app = { contextMenu: menuEl, playlistSubmenu: sub, customPlaylists: [{ id: 'p', name: '一个很长很长很长很长的歌单名字', tracks: [] }] };
    window.setupSidebar(app);
    return { dom, app, sub, menuEl };
}
const frame = (w) => new Promise((r) => w.requestAnimationFrame(() => r()));

test('in a 420px window the submenu opens on the roomier side and is narrowed to fit', async () => {
    const { dom, app, sub, menuEl } = setup({ width: 420, menu: { left: 192, right: 404, top: 133, bottom: 577 } });
    app.showContextMenu(415, 595);
    await frame(dom.window);
    assert.ok(menuEl.classList.contains('sub-left'), 'more room on the left');
    const max = parseFloat(sub.style.maxWidth);
    assert.ok(max > 0 && max <= 192 - 4, `narrowed to the room on the left, got ${sub.style.maxWidth || 'none'}`);
    assert.equal(sub.querySelector('.submenu-item').title, '一个很长很长很长很长的歌单名字');
    dom.window.close();
});

test('with room to spare the submenu keeps its own width and opens to the right', async () => {
    const { dom, app, sub, menuEl } = setup({ width: 1280, menu: { left: 300, right: 512, top: 100, bottom: 540 } });
    app.showContextMenu(300, 100);
    await frame(dom.window);
    assert.equal(menuEl.classList.contains('sub-left'), false);
    assert.equal(sub.style.maxWidth, '');
    dom.window.close();
});

test('the stylesheet ellipsizes playlist names in the submenu', () => {
    const css = fs.readFileSync('Musicmodules/music.css', 'utf8');
    assert.match(css, /\.context-submenu \.submenu-item\s*\{[^}]*text-overflow:\s*ellipsis/);
});
