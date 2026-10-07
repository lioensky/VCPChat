import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';

function setup() {
    const dom = new JSDOM(`
        <div class="main-content"></div>
        <div class="resizer" id="resizerRight"></div>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar"><div class="side-pane-tabs"></div></header>
            <div class="side-pane-content-container"></div>
        </aside>
    `, { pretendToBeVisual: true });
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const tabList = root.querySelector('.side-pane-tabs');
    const controller = createSidePaneController({
        root,
        resizerHandle: doc.getElementById('resizerRight'),
        tabListElement: tabList,
        contentContainer: root.querySelector('.side-pane-content-container'),
        providers: {
            probe: {
                mountTab(tab, view) {
                    const input = doc.createElement('input');
                    view.append(input);
                    return { focus() { input.focus(); }, dispose() {} };
                }
            }
        }
    });
    const tab = id => tabList.querySelector(`[role="tab"][data-tab-id="${id}"]`);
    const press = (target, key) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const open = id => controller.openTab({ id, kind: 'probe', title: id, closable: true, scopeMode: 'global' });
    return { dom, doc, tabList, controller, tab, press, open };
}

test('arrow keys walk the tab strip and keep focus on the tabs', async () => {
    const { dom, doc, controller, tab, press, open } = setup();
    try {
        await open('a');
        await open('b');
        await open('c');
        tab('a').focus();
        controller.activateTab('a', { focus: false });
        tab('a').focus();
        press(tab('a'), 'ArrowRight');
        assert.equal(controller.getSnapshot().activeTabId, 'b');
        assert.equal(doc.activeElement, tab('b'), 'focus stays in the strip after the strip re-renders');
        press(doc.activeElement, 'ArrowRight');
        assert.equal(controller.getSnapshot().activeTabId, 'c');
        assert.equal(doc.activeElement, tab('c'));
        press(doc.activeElement, 'Home');
        assert.equal(doc.activeElement?.getAttribute('data-tab-id'), controller.getSnapshot().activeTabId);
    } finally {
        await controller.dispose();
        dom.window.close();
    }
});

test('Delete closes the focused tab and focus moves to the next active tab', async () => {
    const { dom, doc, controller, tab, press, open } = setup();
    try {
        await open('a');
        await open('b');
        tab('b').focus();
        press(tab('b'), 'Delete');
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(tab('b'), null);
        assert.equal(controller.getSnapshot().activeTabId, 'a');
        assert.equal(doc.activeElement, tab('a'));
    } finally {
        await controller.dispose();
        dom.window.close();
    }
});

test('the strip keeps a Tab stop while the new-tab page is showing', async () => {
    const { dom, tabList, controller, open } = setup();
    try {
        await open('a');
        controller.showLauncher();
        const stops = tabList.querySelectorAll('[role="tab"][tabindex="0"]');
        assert.equal(stops.length, 1);
    } finally {
        await controller.dispose();
        dom.window.close();
    }
});
