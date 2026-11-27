// 经典列表的分列：只在列表显示时做，而且只做视口附近的行。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-classic-list.js'), 'utf8');
const ROW = 36;

function setup({ count = 500, archive = false, layout = true } = {}) {
    const dom = new JSDOM('<!doctype html><body><ul id="playlist"></ul></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    const doc = window.document;
    const list = doc.getElementById('playlist');
    if (archive) doc.body.classList.add('music-archive-on');
    let frames = [];
    window.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    const flush = async () => {
        await new Promise((resolve) => setImmediate(resolve)); // MutationObserver
        const batch = frames; frames = [];
        batch.forEach((fn) => fn(0));
    };
    if (layout) {
        // jsdom 不排版：给一个 360 高的视口，每行 36
        Object.defineProperty(list, 'clientHeight', { get: () => 360 });
        Object.defineProperty(window.HTMLElement.prototype, 'offsetTop', {
            get() { return this.parentNode === list ? Array.prototype.indexOf.call(list.children, this) * ROW : 0; }
        });
    }
    const playlist = Array.from({ length: count }, (_, i) => ({ title: `歌 ${i}`, artist: `人 ${i}`, duration: 60 + i }));
    const app = {
        playlist,
        playlistEl: list,
        renderPlaylist(filtered) {
            list.replaceChildren(...(filtered || playlist).map((t) => {
                const li = doc.createElement('li');
                li.dataset.index = String(playlist.indexOf(t));
                li.textContent = t.title;
                return li;
            }));
        }
    };
    window.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-app-hooks.js'), 'utf8'));
    window.eval(source);
    window.setupMusicClassicList(app);
    app.renderPlaylist();
    const done = () => list.querySelectorAll('li[data-cols="1"]').length;
    return { window, doc, list, app, flush, done, close: () => window.close() };
}

test('显示时只拆视口附近的行，滚动后补上新露出来的', async () => {
    const t = setup();
    assert.equal(t.done(), 40, '10 行可见 + 下方 30 行');
    assert.equal(t.list.children[0].querySelector('.cl-artist').textContent, '人 0');
    assert.equal(t.list.children[0].querySelector('.cl-duration').textContent, '1:00');
    assert.equal(t.list.children[100].dataset.cols, undefined);
    t.list.scrollTop = 200 * ROW;
    t.list.dispatchEvent(new t.window.Event('scroll'));
    await t.flush();
    assert.equal(t.list.children[205].dataset.cols, '1');
    assert.equal(t.list.children[170].dataset.cols, '1');
    assert.equal(t.list.children[400].dataset.cols, undefined);
    t.close();
});

test('在档案页时一行都不拆，切到经典视图才做', async () => {
    const t = setup({ archive: true });
    assert.equal(t.done(), 0);
    t.doc.body.classList.remove('music-archive-on');
    await t.flush();
    assert.equal(t.done(), 40);
    t.close();
});

test('切到专辑分页（列表被隐藏）时不拆，切回来补上', async () => {
    const t = setup();
    t.list.style.display = 'none';
    t.app.renderPlaylist();
    assert.equal(t.done(), 0);
    t.list.style.display = '';
    await t.flush();
    assert.equal(t.done(), 40);
    t.close();
});

test('量不到行高时整列处理', () => {
    const t = setup({ count: 50, layout: false });
    assert.equal(t.done(), 50);
    t.close();
});

test('排序后重建的行同样只拆视口附近', async () => {
    const t = setup();
    t.doc.querySelector('.music-list-sort.is-title').click();
    assert.equal(t.done(), 40);
    assert.ok(t.list.children[0].querySelector('.cl-title'));
    t.close();
});

test('档案页激活时推迟排序，切回经典视图后再应用当前排序', async () => {
    const t = setup({ count: 5 });
    ['Zebra', 'Alpha', 'Delta', 'Charlie', 'Bravo'].forEach((name, idx) => { t.app.playlist[idx].title = name; });
    t.doc.querySelector('.music-list-sort.is-title').click();
    assert.equal(t.list.children[0].dataset.index, '1', 'visible classic list sorts immediately');
    t.doc.body.classList.add('music-archive-on');
    t.app.renderPlaylist();
    assert.equal(t.list.children[0].dataset.index, '0', 'hidden classic list skips sort work while archive is active');
    t.doc.body.classList.remove('music-archive-on');
    await t.flush();
    assert.equal(t.list.children[0].dataset.index, '1', 'deferred sort runs once classic view becomes visible');
    t.close();
});
