// 侧栏首页立绘用视频：换成 video 元素、看不见时暂停、减少动态时不播、坏视频退回圆头像
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createLauncherPortrait } from '../modules/ui-system/side-pane/side-pane-launcher-portrait.js';
import { isPortraitVideo, portraitMaxBytes, PORTRAIT_ACCEPT } from '../modules/ui-system/side-pane/portrait-media.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

function setup({ reducedMotion = false } = {}) {
    const dom = new JSDOM(`<!doctype html><html><body>
        <section id="sidePaneViewLauncher">
            <div class="side-pane-launcher-portrait" aria-hidden="true" hidden>
                <img class="side-pane-launcher-portrait-image" data-portrait-theme="default" alt="" draggable="false" hidden>
                <img class="side-pane-launcher-portrait-image" data-portrait-theme="light" alt="" draggable="false" hidden>
            </div>
        </section></body></html>`);
    const win = dom.window;
    win.HTMLImageElement.prototype.decode = () => Promise.resolve();
    // jsdom 不放视频：播放状态自己记
    Object.defineProperty(win.HTMLMediaElement.prototype, 'paused', { configurable: true, get() { return this._paused ?? true; } });
    win.HTMLMediaElement.prototype.play = function play() { this._paused = false; return Promise.resolve(); };
    win.HTMLMediaElement.prototype.pause = function pause() { this._paused = true; };
    win.HTMLMediaElement.prototype.load = function load() {};
    win.matchMedia = () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} });
    const view = win.document.getElementById('sidePaneViewLauncher');
    const owner = createLauncherPortrait({ view });
    const slot = () => view.querySelector('[data-portrait-theme="default"]');
    // 新建的 video 还没挂上页面，从 createElement 里拿到它再发 loadeddata / error
    const created = [];
    const createElement = win.document.createElement.bind(win.document);
    win.document.createElement = (tag, ...rest) => {
        const node = createElement(tag, ...rest);
        if (String(tag).toLowerCase() === 'video') created.push(node);
        return node;
    };
    const finish = async (event = 'loadeddata') => {
        await tick();
        created.splice(0).forEach(video => video.dispatchEvent(new win.Event(event)));
        await tick();
    };
    return { dom, win, view, owner, slot, finish };
}

test('portrait media types: videos by type or extension, larger limit for video', () => {
    assert.equal(isPortraitVideo('file:///a/portrait.webm?v=3'), true);
    assert.equal(isPortraitVideo('file:///a/portrait.MP4'), true);
    assert.equal(isPortraitVideo('file:///a/portrait.gif?v=3'), false);
    assert.equal(isPortraitVideo('blob:abc', 'video/mp4'), true);
    assert.equal(isPortraitVideo('blob:abc', 'image/apng'), false);
    assert.ok(portraitMaxBytes('video/webm') > portraitMaxBytes('image/gif'));
    assert.match(PORTRAIT_ACCEPT, /image\/gif/);
    assert.match(PORTRAIT_ACCEPT, /video\/webm/);
});

test('a video portrait plays muted and looped, and pauses when hidden or folded away', async () => {
    const t = setup();
    t.owner.render({ default: 'file:///p/portrait.webm?v=1' });
    await t.finish();
    const video = t.slot();
    assert.equal(video.tagName, 'VIDEO');
    assert.ok(video.classList.contains('side-pane-launcher-portrait-image'));
    assert.equal(video.getAttribute('src'), 'file:///p/portrait.webm?v=1');
    assert.equal(video.muted, true);
    assert.ok(video.hasAttribute('loop') && video.hasAttribute('playsinline'));
    assert.equal(t.view.dataset.launcherPortrait, 'single');
    assert.equal(video.paused, false, '看得见就播');

    // 窗口最小化
    Object.defineProperty(t.win.document, 'visibilityState', { configurable: true, value: 'hidden' });
    t.win.document.dispatchEvent(new t.win.Event('visibilitychange'));
    assert.equal(video.paused, true);
    Object.defineProperty(t.win.document, 'visibilityState', { configurable: true, value: 'visible' });
    t.win.document.dispatchEvent(new t.win.Event('visibilitychange'));
    assert.equal(video.paused, false);

    // 切到通知页时头部收起
    t.view.dataset.launcherSegment = 'notifications';
    await tick();
    assert.equal(video.paused, true);
    delete t.view.dataset.launcherSegment;
    await tick();
    assert.equal(video.paused, false);

    // 换回图片：视频停下、放掉地址，位置上换回 img
    t.owner.render({ default: 'file:///p/portrait.gif?v=2' });
    await t.finish();
    assert.equal(t.slot().tagName, 'IMG');
    assert.equal(t.slot().getAttribute('src'), 'file:///p/portrait.gif?v=2');
    assert.equal(video.paused, true);
    assert.equal(video.hasAttribute('src'), false);
    assert.equal(t.view.querySelectorAll('video').length, 0);
    t.owner.dispose();
    t.dom.window.close();
});

test('with reduced motion the video portrait stays on its first frame', async () => {
    const t = setup({ reducedMotion: true });
    t.owner.render({ default: 'file:///p/portrait.mp4?v=1' });
    await t.finish();
    assert.equal(t.slot().tagName, 'VIDEO');
    assert.equal(t.slot().paused, true);
    t.owner.dispose();
    t.dom.window.close();
});

test('a video that cannot be read falls back to the avatar', async () => {
    const t = setup();
    t.owner.render({ default: 'file:///p/portrait.png?v=1' });
    await t.finish();
    assert.equal(t.view.dataset.launcherPortrait, 'single');
    t.owner.render({ default: 'file:///p/portrait.webm?v=2' });
    await t.finish('error');
    await tick();
    assert.equal(t.view.dataset.launcherPortrait, undefined);
    assert.equal(t.view.querySelector('.side-pane-launcher-portrait').hidden, true);
    t.owner.dispose();
    t.dom.window.close();
});

test('releasing media frees what is on the page but leaves a detached img alone', async () => {
    const { releasePortraitMedia } = await import('../modules/ui-system/side-pane/portrait-media.js');
    const { window } = new JSDOM('<div id="box"><img src="a.png"><img src="b.png"></div>');
    const [onPage, removed] = window.document.querySelectorAll('img');
    removed.remove();
    releasePortraitMedia(onPage);
    // Chromium never collects an img whose src is removed after it left the page
    releasePortraitMedia(removed);
    assert.equal(onPage.hasAttribute('src'), false);
    assert.equal(removed.getAttribute('src'), 'b.png');
    const video = window.document.createElement('video');
    video.setAttribute('src', 'a.mp4');
    let reloaded = 0;
    video.pause = () => {};
    video.load = () => { reloaded += 1; };
    releasePortraitMedia(video);
    assert.equal(video.hasAttribute('src'), false, 'a detached video still stops and drops its decoder');
    assert.equal(reloaded, 1);
});
