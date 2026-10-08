import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneTabStrip } from '../modules/ui-system/side-pane/side-pane-tab-strip.js';

// The tab strip used to delete and rebuild every tab, then measure layout in
// the same frame, on each render: every browser navigation (title change),
// every switch and every parent change. That interrupted the hover tooltip
// and forced a synchronous reflow. Tabs are now reused by id.

function setup(initialTabs) {
    const dom = new JSDOM('<div class="side-pane-tabs"></div>', { pretendToBeVisual: true });
    const win = dom.window;
    const doc = win.document;
    const tabList = doc.querySelector('.side-pane-tabs');
    let tabs = initialTabs;
    let active = tabs[0].id;
    let geometryReads = 0;
    for (const prop of ['clientWidth', 'scrollWidth']) {
        Object.defineProperty(tabList, prop, { configurable: true, get() { geometryReads += 1; return 400; } });
    }
    const strip = createSidePaneTabStrip({
        tabListElement: tabList,
        getTabs: () => tabs,
        getActiveTabId: () => active,
        isClosable: () => true,
        onActivate() {},
        onClose() {},
        onReorder() {},
        onContextMenu() {}
    });
    const item = id => tabList.querySelector(`.side-pane-tab-item[data-tab-id="${id}"]`);
    const order = () => [...tabList.querySelectorAll('.side-pane-tab-item')].map(el => el.dataset.tabId);
    const frame = () => new Promise(resolve => win.requestAnimationFrame(() => resolve()));
    return {
        dom, doc, strip, item, order, frame,
        setTabs: next => { tabs = next; },
        setActive: id => { active = id; },
        reads: () => geometryReads,
        resetReads: () => { geometryReads = 0; }
    };
}

test('a title change or a switch updates tabs in place instead of rebuilding the strip', async () => {
    const env = setup([{ id: 'a', title: 'A' }, { id: 'b', title: 'Loading…' }]);
    try {
        env.strip.render();
        const a = env.item('a');
        const b = env.item('b');

        env.setTabs([{ id: 'a', title: 'A' }, { id: 'b', title: 'Example Domain' }]);
        env.setActive('b');
        env.strip.render();
        assert.equal(env.item('a'), a, 'the untouched tab keeps its node');
        assert.equal(env.item('b'), b, 'the renamed tab keeps its node');
        assert.equal(b.querySelector('.tab-title').textContent, 'Example Domain');
        assert.equal(b.querySelector('.side-pane-tab-close').getAttribute('aria-label').includes('Example Domain'), true);
        assert.equal(b.querySelector('[role="tab"]').getAttribute('aria-selected'), 'true');
        assert.equal(b.querySelector('[role="tab"]').tabIndex, 0);
        assert.equal(a.querySelector('[role="tab"]').tabIndex, -1);
        assert.equal(a.querySelector('[role="tab"]').getAttribute('aria-selected'), 'false');
    } finally {
        env.strip.dispose();
        env.dom.window.close();
    }
});

test('adding, removing and reordering tabs keeps the surviving nodes in the right order', () => {
    const env = setup([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }]);
    try {
        env.strip.render();
        const b = env.item('b');
        const c = env.item('c');
        env.setTabs([{ id: 'c', title: 'C' }, { id: 'd', title: 'D' }, { id: 'b', title: 'B' }]);
        env.strip.render();
        assert.deepEqual(env.order(), ['c', 'd', 'b']);
        assert.equal(env.item('a'), null);
        assert.equal(env.item('b'), b);
        assert.equal(env.item('c'), c);
    } finally {
        env.strip.dispose();
        env.dom.window.close();
    }
});

test('render does not measure layout synchronously; it measures once on the next frame', async () => {
    const env = setup([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
    try {
        env.strip.render();
        await env.frame();
        env.resetReads();
        env.setTabs([{ id: 'a', title: 'A' }, { id: 'b', title: 'B2' }]);
        env.strip.render();
        env.strip.render();
        assert.equal(env.reads(), 0, 'no geometry read inside render');
        await env.frame();
        assert.ok(env.reads() > 0, 'layout runs on the next frame');
    } finally {
        env.strip.dispose();
        env.dom.window.close();
    }
});
