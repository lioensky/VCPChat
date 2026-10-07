import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

function createController() {
    const dom = new JSDOM('<main class="main-content"></main><aside id="pane"><div id="tabs"></div><div id="content"></div></aside>');
    const doc = dom.window.document;
    const provider = {
        mountTab(_payload, view) {
            const input = doc.createElement('input');
            view.append(input);
            return { focus: () => input.focus(), dispose() {} };
        }
    };
    const ctrl = createSidePaneController({
        root: doc.getElementById('pane'),
        tabListElement: doc.getElementById('tabs'),
        contentContainer: doc.getElementById('content')
    });
    ctrl.registerTabType({ kind: 'probe', label: 'Probe', provider });
    const tab = id => ({ id, kind: 'probe', title: id, closable: true, scopeMode: 'global' });
    const button = id => [...doc.querySelectorAll('#tabs [role="tab"]')].find(el => el.dataset.tabId === id);
    const press = key => doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
    return { dom, doc, ctrl, tab, button, press };
}

test('arrow keys move the active tab and keep focus on the tab strip', async () => {
    const { doc, ctrl, tab, button, press } = createController();
    try {
        await ctrl.openTab(tab('probe:a'));
        await ctrl.openTab(tab('probe:b'));
        button('probe:b').focus();

        press('ArrowLeft');
        await settle();
        assert.equal(ctrl.getSnapshot().activeTabId, 'probe:a');
        assert.equal(doc.activeElement, button('probe:a'));

        press('ArrowRight');
        await settle();
        assert.equal(ctrl.getSnapshot().activeTabId, 'probe:b');
        assert.equal(doc.activeElement, button('probe:b'));
    } finally { await ctrl.dispose(); }
});

test('tab ids carrying Windows paths and quotes mount, focus and close', async () => {
    const { doc, ctrl, tab, button } = createController();
    const windowsId = 'code-viewer:C:\\Users\\me\\proj\\a.js';
    const quotedId = 'code-viewer:/tmp/a"b.js';
    try {
        await ctrl.openTab(tab(windowsId));
        await ctrl.openTab(tab(quotedId));
        assert.deepEqual(ctrl.getViewResidency().live.sort(), [quotedId, windowsId].sort());

        await ctrl.closeTab(quotedId);
        await settle();
        assert.equal(ctrl.getSnapshot().activeTabId, windowsId);
        assert.equal(doc.activeElement, button(windowsId), 'focus lands on the remaining file tab');
    } finally { await ctrl.dispose(); }
});
