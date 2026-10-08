import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneTabStrip } from '../modules/ui-system/side-pane/side-pane-tab-strip.js';

// 拖拽排序：在标签条外松手、拖拽中途有渲染（浏览器标签加载时改标题），拖拽都要正常收尾，之后还能再拖
function setup() {
    const dom = new JSDOM('<div class="side-pane-tabs"></div><div id="outside"></div>', { pretendToBeVisual: true });
    const win = dom.window, doc = win.document;
    const tabList = doc.querySelector('.side-pane-tabs');
    let tabs = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }];
    const reorders = [];
    const strip = createSidePaneTabStrip({
        tabListElement: tabList,
        getTabs: () => tabs,
        getActiveTabId: () => 'a',
        isClosable: () => true,
        onActivate() {}, onClose() {}, onContextMenu() {},
        onReorder: (activeId, overId) => reorders.push([activeId, overId])
    });
    strip.render();
    // jsdom 没有布局：三个 100px 宽的标签并排
    const layout = () => tabList.querySelectorAll('.side-pane-tab-item').forEach((el, index) => {
        el.getBoundingClientRect = () => ({ left: index * 100, width: 100, right: index * 100 + 100, top: 0, bottom: 30, height: 30 });
    });
    tabList.getBoundingClientRect = () => ({ left: 0, right: 300, width: 300, top: 0, bottom: 30, height: 30 });
    layout();
    const item = id => tabList.querySelector(`.side-pane-tab-item[data-tab-id="${id}"]`);
    const pointer = (target, type, clientX) => target.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 10, pointerId: 1, button: 0 }));
    return { win, doc, tabList, strip, item, pointer, reorders, layout, setTabs: next => { tabs = next; },
        outside: doc.getElementById('outside'), cleanup: () => { strip.dispose?.(); win.close(); } };
}

test('releasing a dragged tab outside the strip ends the drag, and the next drag still works', () => {
    const env = setup();
    try {
        env.pointer(env.item('a').querySelector('[role="tab"]'), 'pointerdown', 50);
        // 指针很快离开标签条，移动和松手都发生在条外
        env.pointer(env.outside, 'pointermove', 280);
        env.pointer(env.outside, 'pointerup', 280);
        assert.equal(env.tabList.classList.contains('is-sorting'), false, 'the drag ended');
        assert.deepEqual(env.reorders, [['a', 'c']]);

        env.pointer(env.item('c').querySelector('[role="tab"]'), 'pointerdown', 250);
        env.pointer(env.tabList, 'pointermove', 40);
        env.pointer(env.tabList, 'pointerup', 40);
        assert.deepEqual(env.reorders, [['a', 'c'], ['c', 'a']], 'a later press starts a new drag');
    } finally { env.cleanup(); }
});

test('a press released outside the strip before it became a drag does not block later drags', () => {
    const env = setup();
    try {
        env.pointer(env.item('a').querySelector('[role="tab"]'), 'pointerdown', 50);
        env.pointer(env.outside, 'pointerup', 50);
        env.pointer(env.item('b').querySelector('[role="tab"]'), 'pointerdown', 150);
        env.pointer(env.tabList, 'pointermove', 260);
        env.pointer(env.tabList, 'pointerup', 260);
        assert.deepEqual(env.reorders, [['b', 'c']]);
    } finally { env.cleanup(); }
});

test('a render during a drag waits until the drop, so the dragged tab is not swapped out', () => {
    const env = setup();
    try {
        const dragged = env.item('a');
        env.pointer(dragged.querySelector('[role="tab"]'), 'pointerdown', 50);
        env.pointer(env.tabList, 'pointermove', 160);
        // 拖到一半，浏览器标签换了标题，还新开了一个标签
        env.setTabs([{ id: 'a', title: 'Example Domain', icon: 'public' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' }]);
        env.strip.render();
        assert.equal(env.item('a'), dragged, 'the dragged node stays in place');
        assert.equal(env.item('d'), null, 'the strip is not rebuilt mid-drag');

        env.pointer(env.outside, 'pointerup', 160);
        assert.deepEqual(env.reorders, [['a', 'b']]);
        assert.ok(env.item('d'), 'the deferred render runs after the drop');
        assert.equal(env.item('a').querySelector('.tab-title').textContent, 'Example Domain');
    } finally { env.cleanup(); }
});
