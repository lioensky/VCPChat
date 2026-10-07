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

test('closed toasts and fired timers leave nothing behind in the window-lifetime owner', async t => {
    const dom = new JSDOM(`<!doctype html><html><body>
        <div id="floating-toast-notifications-container"></div>
        <aside id="notificationsSidebar"></aside>
        <ul id="notificationsList"></ul>
    </body></html>`, { runScripts: 'outside-only' });
    dom.window.chatAPI = {};
    dom.window.eval(fs.readFileSync('modules/notificationRenderer.js', 'utf8'));
    const owner = createDomListenerOwner();
    // 失败时也要停掉 30s 的定期清理，否则测试进程挂住
    t.after(() => { owner.dispose(); dom.window.close(); });
    // 50ms 后自动收起，走 closeToastNotification 的强制移除分支（jsdom 不跑 transition）
    dom.window.notificationRenderer.configureCapabilities({
        filterManager: { checkMessageFilter: () => ({ action: 'show', duration: 0.05 }) },
        listenerOwner: owner,
    });
    const doc = dom.window.document;
    const list = doc.getElementById('notificationsList');
    dom.window.notificationRenderer.renderVCPLogNotification({ type: 'vcp_log', data: { tool_name: 'X', status: 'success', content: 'warm up' } }, null, list, {});
    await new Promise(resolve => setTimeout(resolve, 700));
    const baseline = owner.size();

    for (let i = 0; i < 20; i++) {
        dom.window.notificationRenderer.renderVCPLogNotification({ type: 'vcp_log', data: { tool_name: 'X', status: 'success', content: 'n' + i } }, null, list, {});
    }
    assert.equal(doc.querySelectorAll('.floating-toast-notification').length, 20);
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(doc.querySelectorAll('.floating-toast-notification').length, 0);
    assert.equal(owner.size(), baseline);

    // 通知面板打开时被收走、被点掉的浮卡也一样
    for (let i = 0; i < 10; i++) {
        dom.window.notificationRenderer.renderVCPLogNotification({ type: 'vcp_log', data: { tool_name: 'X', status: 'success', content: 'm' + i } }, null, list, {});
    }
    doc.querySelector('.floating-toast-notification').onclick();
    dom.window.notificationRenderer.dismissFloatingToasts();
    assert.equal(doc.querySelectorAll('.floating-toast-notification').length, 0);
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(owner.size(), baseline);
});
