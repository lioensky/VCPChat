const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

// 主窗口的工具审批：待批的广播 vcp:tool-approval-pending（桌宠据此也问一声），别处点的允许/拒绝按主窗口卡片的流程应答，
// 答完广播 vcp:tool-approval-settled。
function createDom() {
    const dom = new JSDOM(`<!doctype html><html><body>
        <ul id="notificationsList"></ul>
        <div id="floating-toast-notifications-container"></div>
        <aside id="notificationsSidebar" class="active"></aside>
        <div id="modal-container"></div>
    </body></html>`, { url: 'https://vcpchat.local/main.html', runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    const calls = { sent: [], offers: [], settled: [] };
    window.chatAPI = { sendVCPLogMessage: (message) => calls.sent.push(message) };
    window.addEventListener('vcp:tool-approval-pending', (event) => calls.offers.push(event.detail));
    window.addEventListener('vcp:tool-approval-settled', (event) => calls.settled.push(event.detail.requestId));
    window.CSS ||= {};
    window.CSS.escape ||= (value) => String(value).replace(/["\\]/g, '\\$&');
    window.eval(fs.readFileSync('modules/ui-helpers.js', 'utf8'));
    window.eval(fs.readFileSync('modules/notificationRenderer.js', 'utf8'));
    const render = (data) => window.notificationRenderer.renderVCPLogNotification(
        { type: 'tool_approval_request', data }, null, window.document.getElementById('notificationsList'));
    return { dom, window, calls, render };
}

test('a pending approval is announced and can be answered from elsewhere', (t) => {
    const { dom, window, calls, render } = createDom();
    t.after(() => dom.window.close());
    render({ requestId: 'p1', toolName: 'PowerShellExecutor', maid: 'Nova', args: { command: 'Get-ChildItem' }, approvalTtlMs: 60000 });
    assert.deepEqual(JSON.parse(JSON.stringify(calls.offers)), [{
        requestId: 'p1', toolName: 'PowerShellExecutor', maid: 'Nova', command: 'Get-ChildItem', expiresInMs: 60000,
    }]);
    // 理由框里写了字：桌宠上点允许也一起带上
    window.document.querySelector('.notification-approval-reason-input').value = '可以';
    assert.equal(window.notificationRenderer.answerToolApproval('p1', true), true);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.sent)), [{ type: 'tool_approval_response', data: { requestId: 'p1', approved: true, reason: '可以' } }]);
    assert.deepEqual(calls.settled, ['p1']);
    // 已经答过：再点不再发
    assert.equal(window.notificationRenderer.answerToolApproval('p1', false), false);
    assert.equal(calls.sent.length, 1);
});

test('answering in the main window announces that the approval is settled', (t) => {
    const { dom, window, calls, render } = createDom();
    t.after(() => dom.window.close());
    render({ requestId: 'p2', toolName: 'X', maid: 'Nova', args: { a: 1 } });
    assert.equal(calls.offers[0].command, '{"a":1}');
    assert.equal(calls.offers[0].expiresInMs, null);
    [...window.document.querySelectorAll('.notification-actions button')].find((b) => b.textContent === '拒绝').click();
    assert.equal(calls.sent[0].data.approved, false);
    assert.deepEqual(calls.settled, ['p2']);
});

test('auto-approved requests are never announced as pending', (t) => {
    const { dom, window, calls, render } = createDom();
    t.after(() => dom.window.close());
    window.filterManager = { checkToolAutoApproval: () => ({ action: 'approve', rule: { name: 'r' } }) };
    render({ requestId: 'p3', toolName: 'X', maid: 'Nova', args: {} });
    assert.deepEqual(calls.offers, []);
    assert.equal(calls.sent[0].data.approved, true);
});
