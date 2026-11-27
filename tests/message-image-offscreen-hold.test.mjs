// 离屏回收（modules/renderer/offscreenDomWindow.js）的 hold：导出图片前恢复被回收的消息并锁住，放开后照常回收。
// 起因：消息离视口远了正文会被清空，导出预览把这样的消息画成只有时间戳的空白图（2026-11-27 隔离测试 Chat 实测）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createOffscreenDomWindow } from '../modules/renderer/offscreenDomWindow.js';

function fixture() {
    const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
    const root = dom.window.document.querySelector('main');
    dom.window.requestAnimationFrame = () => 0;
    dom.window.cancelAnimationFrame = () => {};
    root.getBoundingClientRect = () => ({ top: 0, bottom: 600 });
    const item = dom.window.document.createElement('article');
    item.className = 'message-item';
    item.innerHTML = '<div class="md-content"><b>original</b></div>';
    item.getBoundingClientRect = () => ({ top: -6000, bottom: -5500, height: 500 });
    item.firstChild.getBoundingClientRect = () => ({ height: 400 });
    root.append(item);
    const restores = [];
    const owner = createOffscreenDomWindow({
        canEvict: () => true, evict() {},
        restore: async (target, valid) => {
            restores.push(target);
            if (valid()) target.firstChild.innerHTML = '<b>restored</b>';
        },
    });
    owner.initialize(root);
    owner.observe(item);
    return { item, owner, restores, close() { owner.destroy(); dom.window.close(); } };
}

test('hold 立即恢复被回收的消息，持有期间不再回收', async () => {
    const f = fixture();
    try {
        await f.owner.check();
        assert.equal(f.item.dataset.vcpDomEvicted, 'true');
        assert.equal(f.item.textContent, '');
        const release = await f.owner.hold([f.item]);
        assert.equal(f.restores.length, 1);
        assert.equal(f.item.dataset.vcpDomEvicted, undefined);
        assert.equal(f.item.textContent, 'restored');
        assert.equal(f.item.style.height, '');
        await f.owner.check();
        assert.equal(f.item.dataset.vcpDomEvicted, undefined, '持有中的消息虽然离视口很远也不回收');
        release();
        release(); // 重复放开无副作用
        await f.owner.check();
        assert.equal(f.item.dataset.vcpDomEvicted, 'true', '放开后照常回收');
    } finally { f.close(); }
});

test('两处同时持有时，放开一处仍保持', async () => {
    const f = fixture();
    try {
        const first = await f.owner.hold([f.item]);
        const second = await f.owner.hold([f.item]);
        first();
        await f.owner.check();
        assert.equal(f.item.dataset.vcpDomEvicted, undefined);
        second();
        await f.owner.check();
        assert.equal(f.item.dataset.vcpDomEvicted, 'true');
    } finally { f.close(); }
});
