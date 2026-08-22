import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createDomListenerOwner } from '../modules/renderer/domListenerOwner.js';

test('notification renderer cancels late toast projection after owner disposal', async () => {
    const dom = new JSDOM(`<!doctype html><html><body>
        <div id="floating-toast-notifications-container"></div>
        <aside id="notificationsSidebar"></aside>
        <ul id="notificationsList"></ul>
    </body></html>`, { runScripts: 'outside-only' });
    dom.window.chatAPI = {};
    dom.window.eval(fs.readFileSync('modules/notificationRenderer.js', 'utf8'));
    const owner = createDomListenerOwner();
    dom.window.notificationRenderer.configureCapabilities({
        filterManager: { checkMessageFilter: () => null },
        listenerOwner: owner,
    });

    const list = dom.window.document.getElementById('notificationsList');
    dom.window.notificationRenderer.renderVCPLogNotification('late toast', null, list, {});
    const toast = dom.window.document.querySelector('.floating-toast-notification');
    assert.ok(toast);
    owner.dispose();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(toast.classList.contains('visible'), false);
    dom.window.close();
});
