import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createStatusPanelFloating } from '../modules/ui-system/conversation-status-panel/floating.js';

// 点进侧栏浏览器的 webview（或别的窗口）时主页面收不到 mousedown，只会失焦
test('status panel popovers close when the window loses focus, hover popovers are left alone', () => {
    const dom = new JSDOM('<button id="anchor"></button><div id="portal"></div>', { pretendToBeVisual: true });
    const win = dom.window;
    const doc = win.document;
    const floating = createStatusPanelFloating({ button: doc.getElementById('anchor'), doc, h: () => null, icon: () => null, portal: doc.getElementById('portal'), win });
    const anchor = doc.getElementById('anchor');
    let closed = 0;
    floating.openPopover(doc.createElement('div'), anchor, { onClose: () => { closed += 1; } });
    floating.openPopover(doc.createElement('div'), anchor, { hover: true });
    assert.equal(floating.popovers.length, 2);

    win.dispatchEvent(new win.Event('blur'));
    assert.equal(floating.popovers.length, 1, 'the click popover closed');
    assert.equal(floating.popovers[0].cleanup, null, 'the hover popover stays');
    assert.equal(closed, 1);

    win.dispatchEvent(new win.Event('blur'));
    assert.equal(closed, 1, 'the blur listener was removed with the popover');
    floating.dispose();
    win.close();
});
