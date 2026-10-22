const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function render(t, toolName, args) {
    const dom = new JSDOM(`<!doctype html><div id="floating-toast-notifications-container"></div>
        <aside id="notificationsSidebar"></aside><ul id="notificationsList"></ul>`,
        { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    dom.window.chatAPI = {};
    dom.window.CSS = { escape: value => String(value) };
    dom.window.eval(fs.readFileSync('modules/notificationRenderer.js', 'utf8'));
    dom.window.notificationRenderer.renderVCPLogNotification({
        type: 'tool_approval_request',
        data: { requestId: 'ps-preview', toolName, maid: 'Kerr', args, timestamp: 'now' }
    }, null, dom.window.document.getElementById('notificationsList'));
    return dom.window.document;
}

test('local PS shows ordered script arguments as safe single-line text in both cards', t => {
    const args = {
        command: 'ExecutePowerShell',
        powershell10: 'Get-Date',
        powershell2: 'Get-Location',
        powershell: 'Write-Output "<img src=x onerror=alert(1)>"\r\nGet-Process'
    };
    const before = JSON.stringify(args);
    const doc = render(t, 'PowerShellExecutor', args);
    const previews = doc.querySelectorAll('.notification-approval-script > .notification-approval-script-value');
    assert.equal(previews.length, 2);
    for (const preview of previews) {
        assert.equal(preview.textContent,
            'Write-Output "<img src=x onerror=alert(1)>" Get-Process ; Get-Location ; Get-Date');
        assert.equal(preview.children.length, 0);
        const card = preview.closest('.notification-approval-script-card');
        assert.ok(card, 'script belongs inside the metadata card');
        assert.match(card.querySelector('pre').textContent, /ExecutePowerShell/);
        assert.equal(card.parentElement.className, 'notification-content');
        assert.equal(preview.closest('.notification-approval-details'), null);
    }
    assert.equal(JSON.stringify(args), before);
});

test('server PS reads command rather than local powershell field', t => {
    const doc = render(t, 'ServerPowerShellExecutor', {
        command: 'Get-Service\nGet-Date', powershell: 'wrong field'
    });
    assert.equal(doc.querySelector('.notification-approval-script .notification-approval-script-value').textContent,
        'Get-Service Get-Date');
});

test('long PS preview is bounded and marked as truncated', t => {
    const doc = render(t, 'PowerShellExecutor', {
        command: 'ExecutePowerShell', powershell: 'x'.repeat(2000)
    });
    const value = doc.querySelector('.notification-approval-script .notification-approval-script-value').textContent;
    assert.equal(value, 'x'.repeat(240) + '…');
});

test('non-execution PS requests without scripts do not add an empty preview', t => {
    const doc = render(t, 'PowerShellExecutor', { command: 'QueryVisible' });
    assert.equal(doc.querySelector('.notification-approval-script'), null);
    assert.match(doc.querySelector('.notification-content').textContent, /QueryVisible/);
});

test('file tool retains its existing command display without a PS preview', t => {
    const doc = render(t, 'FileOperator', {
        command: 'DeleteFile', filePath: 'C:\\test.txt', powershell: 'not a PS tool'
    });
    assert.equal(doc.querySelector('.notification-approval-script'), null);
    assert.match(doc.querySelector('.notification-content').textContent, /DeleteFile/);
});

test('PS preview CSS enforces one-line ellipsis', () => {
    const css = fs.readFileSync('styles/notifications.css', 'utf8');
    assert.match(css, /\.notification-approval-script > .notification-approval-script-value\s*\{[^}]*overflow:\s*hidden;[^}]*white-space:\s*nowrap;[^}]*text-overflow:\s*ellipsis;/);
});