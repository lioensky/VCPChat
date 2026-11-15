import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createOffscreenDomWindow } from '../modules/renderer/offscreenDomWindow.js';

function fixture(count = 1, overrides = {}) {
    const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
    const root = dom.window.document.querySelector('main');
    const frames = new Map();
    let sequence = 0;
    dom.window.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
    dom.window.cancelAnimationFrame = id => frames.delete(id);
    root.getBoundingClientRect = () => ({ top: 0, bottom: 600 });
    const items = Array.from({ length: count }, () => {
        const item = dom.window.document.createElement('article');
        item.className = 'message-item';
        item.innerHTML = '<div class="md-content"><b>original</b></div>';
        item.top = -6000;
        item.getBoundingClientRect = () => ({ top: item.top, bottom: item.top + 500, height: 500 });
        item.firstChild.getBoundingClientRect = () => ({ height: 400 });
        root.append(item);
        return item;
    });
    const owner = createOffscreenDomWindow({
        canEvict: () => true, evict() {},
        restore: async (item, valid) => { if (valid()) item.firstChild.innerHTML = '<b>restored</b>'; },
        ...overrides,
    });
    owner.initialize(root);
    items.forEach(owner.observe);
    return { dom, root, items, owner, frames, close() { owner.destroy(); dom.window.close(); } };
}
test('bounded cold work removes real children and preserves shell/body dimensions', async () => {
    const f = fixture(8);
    try {
        await f.owner.check();
        assert.equal(f.owner.getStats().cold, 3);
        assert.equal(f.items[0].firstChild.childNodes.length, 0);
        assert.equal(f.items[0].style.height, '500px');
        assert.equal(f.items[0].firstChild.style.height, '400px');
        assert.equal(f.items[3].textContent, 'original');
    } finally { f.close(); }
});
test('warm margin restores on the same shell; middle zone does not thrash', async () => {
    const f = fixture();
    try {
        await f.owner.check();
        const item = f.items[0];
        item.top = -2500;
        await f.owner.check();
        assert.equal(f.owner.getStats().cold, 1);
        item.top = 100;
        await f.owner.check();
        await Promise.resolve();
        assert.equal(item.textContent, 'restored');
        assert.equal(item.style.height, '');
        assert.equal(f.owner.getStats().cold, 0);
    } finally { f.close(); }
});
test('unobserve revokes pending restoration before it can write stale DOM', async () => {
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const f = fixture(1, { restore: async (item, valid) => {
        await barrier;
        if (valid()) item.firstChild.textContent = 'stale';
    } });
    try {
        await f.owner.check();
        f.items[0].top = 0;
        await f.owner.check();
        f.owner.unobserve(f.items[0]);
        f.items[0].firstChild.textContent = 'edited';
        release();
        await Promise.resolve(); await Promise.resolve();
        assert.equal(f.items[0].textContent, 'edited');
        assert.equal(f.items[0].style.height, '');
    } finally { f.close(); }
});
test('failed restore retains placeholder and can retry', async () => {
    let attempts = 0;
    const f = fixture(1, { restore: async item => {
        if (++attempts === 1) throw new Error('controlled');
        item.firstChild.textContent = 'retried';
    } });
    try {
        await f.owner.check();
        f.items[0].top = 0;
        await f.owner.check();
        await Promise.resolve();
        assert.equal(f.owner.getStats().cold, 1);
        await f.owner.restoreAll();
        assert.equal(f.items[0].textContent, 'retried');
        assert.equal(f.owner.getStats().cold, 0);
    } finally { f.close(); }
});
test('protected candidates are not measured/evicted and owners cannot capture other roots', async () => {
    const f = fixture(1, { canEvict: () => false });
    try {
        await f.owner.check();
        assert.equal(f.items[0].textContent, 'original');
        const other = f.dom.window.document.createElement('article');
        f.dom.window.document.body.append(other);
        f.owner.observe(other);
        assert.equal(f.owner.getStats().tracked, 1);
    } finally { f.close(); }
});
test('stream/edit class changes release cold dimensions and destroy cancels frames', async () => {
    const f = fixture();
    try {
        await f.owner.check();
        f.items[0].classList.add('streaming');
        await Promise.resolve();
        assert.equal(f.items[0].style.height, '');
        assert.equal(f.owner.getStats().tracked, 0);
        f.owner.destroy();
        assert.equal(f.frames.size, 0);
    } finally { f.close(); }
});
test('layout invalidation restores rather than using stale tombstone height', async () => {
    const f = fixture();
    try {
        await f.owner.check();
        f.owner.invalidateLayout();
        await Promise.resolve(); await Promise.resolve();
        assert.equal(f.items[0].textContent, 'restored');
        assert.equal(f.items[0].style.height, '');
    } finally { f.close(); }
});