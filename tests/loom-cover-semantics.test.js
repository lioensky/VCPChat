'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createWebAgentPageRuntime } = require('../modules/loom/webcore/web-agent-page-runtime-core');

function fixture(html) {
    const dom = new JSDOM(html, { url: 'https://books.example/', pretendToBeVisual: true });
    const { window } = dom;
    window.HTMLElement.prototype.getBoundingClientRect = () => ({
        x: 10, y: 10, left: 10, top: 10, right: 90, bottom: 70, width: 80, height: 60
    });
    const runtime = createWebAgentPageRuntime({ window, document: window.document, Node: window.Node });
    return { dom, window, runtime };
}

test('小尺寸图片链接通过alt命名，URL与原始可点击句柄绑定', () => {
    const { dom, runtime } = fixture('<a href="/book/1"><img alt="象之首" src="/covers/1.jpg"></a>');
    try {
        const snapshot = runtime.snapshot();
        const entry = snapshot.elements.find(item => item.label === '象之首');
        assert(entry);
        assert.equal(entry.media[0].url, 'https://books.example/covers/1.jpg');
        assert.equal(runtime.resolveTarget(entry.snapshotHandleId).element.tagName, 'A');
        assert.match(snapshot.markdown, /封面 title="象之首" url="https:\/\/books.example\/covers\/1.jpg"/);
        assert.equal(snapshot.images.length, 0, '不绕过正文图片筛选');
    } finally { dom.window.close(); }
});

test('组件title穿透open shadow，内部同目标链接不重复注册，跨快照保持绑定', () => {
    const { dom, window, runtime } = fixture('<a href="/book/2"><z-cover title="索拉里斯星"></z-cover></a>');
    try {
        const shadow = window.document.querySelector('z-cover').attachShadow({ mode: 'open' });
        shadow.innerHTML = '<div><a href="/book/2"><img src="/covers/2.jpg"></a></div>';
        for (let i = 0; i < 2; i++) {
            const snapshot = runtime.snapshot();
            assert.equal(snapshot.elements.length, 1);
            assert.equal(snapshot.elements[0].label, '索拉里斯星');
            assert.deepEqual(snapshot.elements[0].media[0], {
                title: '索拉里斯星', alt: '', url: 'https://books.example/covers/2.jpg'
            });
            assert.equal(runtime.resolveTarget(snapshot.elements[0].snapshotHandleId).element,
                window.document.querySelector('a'));
        }
    } finally { dom.window.close(); }
});

test('超过16本仍全部命名，显式操作名优先，禁止执行协议URL', () => {
    const html = Array.from({ length: 20 }, (_, i) =>
        `<a href="/book/${i}"><img title="书${i}" src="/${i}.jpg"></a>`).join('') +
        '<a href="/help" aria-label="帮助"><img title="图标" src="javascript:alert(1)"></a>';
    const { dom, runtime } = fixture(html);
    try {
        const snapshot = runtime.snapshot();
        assert.equal(snapshot.elements.length, 21);
        assert.equal(snapshot.elements[19].label, '书19');
        assert.equal(snapshot.elements[20].label, '帮助');
        assert.equal(snapshot.elements[20].media[0].url, '');
        assert(!snapshot.markdown.includes('javascript:'));
    } finally { dom.window.close(); }
});

test('双层Shadow零尺寸外链不吞可见封面，覆盖链接绑定兄弟图片，隐藏模板不注册', () => {
    const { dom, window, runtime } = fixture('<x-grid></x-grid>');
    try {
        const grid = window.document.querySelector('x-grid').attachShadow({ mode: 'open' });
        grid.innerHTML = '<div><a class="zero" href="/book/42"><x-cover title="Project Hail Mary"></x-cover></a></div>' +
            '<div style="display:none"><a href="/hidden"><img alt="隐藏模板" src="/hidden.jpg"></a></div>';
        const cover = grid.querySelector('x-cover');
        cover.style.cursor = 'pointer';
        const shadow = cover.attachShadow({ mode: 'open' });
        shadow.innerHTML = '<div style="cursor:pointer" title="Project Hail Mary">' +
            '<div style="opacity:0">占位书名</div><img src="/42.jpg">' +
            '<a href="/book/42"></a></div>';
        grid.querySelector('.zero').getBoundingClientRect = () => ({
            x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0
        });
        for (let i = 0; i < 2; i++) {
            const snapshot = runtime.snapshot();
            const entry = snapshot.elements.find(item => item.label === 'Project Hail Mary');
            assert(entry, '可见书籍必须进入快照');
            assert.equal(snapshot.elements.length, 1, '零尺寸外链与隐藏模板不应注册');
            assert.equal(entry.media[0].url, 'https://books.example/42.jpg');
            assert.equal(runtime.resolveTarget(entry.snapshotHandleId).element, shadow.querySelector('a'));
        }
    } finally { dom.window.close(); }
});

test('多目的地Shadow组件禁止给覆盖链接借用整组件图片', () => {
    const { dom, window, runtime } = fixture('<x-cover title="整块书架"></x-cover>');
    try {
        const shadow = window.document.querySelector('x-cover').attachShadow({ mode: 'open' });
        shadow.innerHTML = '<img src="/wrong.jpg"><a href="/one"></a><a href="/two"></a>';
        const snapshot = runtime.snapshot();
        assert.equal(snapshot.elements.length, 2);
        assert(snapshot.elements.every(item => item.media.length === 0));
        assert(!snapshot.elements.some(item => item.label === '整块书架'));
    } finally { dom.window.close(); }
});

test('遮挡检查穿透双层Shadow命中目标，但不放行真实覆盖物', async () => {
    const { dom, window, runtime } = fixture('<x-grid></x-grid><div id="overlay"></div>');
    try {
        window.HTMLElement.prototype.scrollIntoView = function () {};
        const grid = window.document.querySelector('x-grid');
        const gridRoot = grid.attachShadow({ mode: 'open' });
        gridRoot.innerHTML = '<x-cover title="Project Hail Mary"></x-cover>';
        const cover = gridRoot.querySelector('x-cover');
        const coverRoot = cover.attachShadow({ mode: 'open' });
        coverRoot.innerHTML = '<img src="/42.jpg"><a href="/book/42"></a><div class="blocker"></div>';
        const link = coverRoot.querySelector('a');
        window.document.elementFromPoint = () => grid;
        gridRoot.elementFromPoint = () => cover;
        coverRoot.elementFromPoint = () => link;
        const snapshot = runtime.snapshot();
        const entry = snapshot.elements.find(item => item.label === 'Project Hail Mary');
        assert(entry);
        const params = { target: entry.snapshotHandleId, targetAction: 'click', strict: true };
        const prepared = await runtime.execute('page_prepare_action', params, { strict: true });
        assert.equal(prepared.code, 'ACTION_PREPARED');
        coverRoot.elementFromPoint = () => coverRoot.querySelector('.blocker');
        await assert.rejects(runtime.execute('page_prepare_action', params, { strict: true }),
            { code: 'ELEMENT_OCCLUDED' });
        window.document.elementFromPoint = () => window.document.querySelector('#overlay');
        await assert.rejects(runtime.execute('page_prepare_action', params, { strict: true }),
            { code: 'ELEMENT_OCCLUDED' });
    } finally { dom.window.close(); }
});