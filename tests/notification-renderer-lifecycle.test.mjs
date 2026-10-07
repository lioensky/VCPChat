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

test('opening the notifications panel takes down the floating copies of VCPLog notifications', () => {
    const dom = new JSDOM(`<!doctype html><html><body>
        <div id="floating-toast-notifications-container"><div class="floating-toast-notification info">other</div></div>
        <aside id="notificationsSidebar"></aside>
        <ul id="notificationsList"></ul>
    </body></html>`, { runScripts: 'outside-only' });
    dom.window.chatAPI = {};
    dom.window.CSS = { escape: value => String(value) };
    dom.window.eval(fs.readFileSync('modules/notificationRenderer.js', 'utf8'));
    const owner = createDomListenerOwner();
    dom.window.notificationRenderer.configureCapabilities({
        filterManager: { checkMessageFilter: () => null },
        listenerOwner: owner,
    });
    const doc = dom.window.document;
    const list = doc.getElementById('notificationsList');
    dom.window.notificationRenderer.renderVCPLogNotification({ type: 'vcp_log', data: { tool_name: 'X', status: 'success', content: 'ok' } }, null, list, {});
    dom.window.notificationRenderer.renderVCPLogNotification({ type: 'tool_approval_request', data: { requestId: 'r1', toolName: 'FileOperator', maid: 'A', args: { command: 'WriteFile' }, timestamp: 'now' } }, null, list, {});
    assert.equal(doc.querySelectorAll('.floating-toast-notification').length, 3);

    dom.window.notificationRenderer.dismissFloatingToasts();

    // the approval stays answerable in the list; toasts from other sources are not in the list, so they stay
    assert.deepEqual([...doc.querySelectorAll('.floating-toast-notification')].map(toast => toast.textContent), ['other']);
    assert.equal(list.querySelectorAll('.notification-item').length, 2);
    assert.ok(list.querySelector('.notification-item [data-tool-approval-request-id="r1"], .notification-item[data-tool-approval-request-id="r1"]'));
    owner.dispose();
    dom.window.close();
});
