const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function source(path) {
    return fs.readFileSync(path, 'utf8');
}

function createAuditDom() {
    const mainDocument = new JSDOM(source('main.html')).window.document;
    const template = mainDocument.getElementById('toolChangeAuditModalTemplate');

    const dom = new JSDOM(`<!doctype html>
        <html>
            <body>
                <ul id="notificationsList"></ul>
                <div id="floating-toast-notifications-container"></div>
                <aside id="notificationsSidebar" class="active"></aside>
                <div id="modal-container"></div>
                ${template.outerHTML}
            </body>
        </html>`, {
        url: 'https://vcpchat.local/main.html',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });

    const { window } = dom;
    const sentMessages = [];
    window.chatAPI = {
        sendVCPLogMessage(message) {
            sentMessages.push(message);
        }
    };
    window.CSS ||= {};
    window.CSS.escape ||= value => String(value).replace(/["\\]/g, '\\$&');
    window.eval(source('modules/ui-helpers.js'));
    window.eval(source('modules/notificationRenderer.js'));

    return { dom, window, sentMessages };
}

test('main-window tool approval exposes change audit and submits modal reason', async () => {
    const { dom, window, sentMessages } = createAuditDom();
    const longBefore = Array.from({ length: 420 }, (_, index) => `const before_${index} = ${index};`).join('\n');
    const longAfter = `${longBefore}\nconst acceptedChange = true;`;
    const request = {
        type: 'tool_approval_request',
        data: {
            requestId: 'approve-change-audit-test',
            toolName: 'FileOperator',
            maid: 'Nova',
            args: { command: 'update' },
            changePreview: {
                target: longBefore,
                replace: longAfter
            },
            timestamp: '2026-08-24T11:11:00.123+08:00'
        }
    };

    window.notificationRenderer.renderVCPLogNotification(
        request,
        JSON.stringify(request),
        window.document.getElementById('notificationsList')
    );

    const auditButton = Array.from(window.document.querySelectorAll('.notification-actions button'))
        .find(button => button.textContent === '审计');
    assert.ok(auditButton, 'changePreview should add an audit button');

    auditButton.click();

    const modal = window.document.getElementById('toolChangeAuditModal');
    assert.ok(modal.classList.contains('active'));
    assert.equal(window.document.getElementById('toolChangeAuditBefore').textContent, longBefore);
    assert.equal(window.document.getElementById('toolChangeAuditAfter').textContent, longAfter);
    assert.ok(
        window.document.querySelectorAll('.tool-change-audit-diff-line.is-add').length >= 1,
        'line diff should expose additions'
    );

    const wrapToggle = window.document.getElementById('toolChangeAuditWrapToggle');
    assert.equal(wrapToggle.getAttribute('aria-pressed'), 'false');
    wrapToggle.click();
    assert.equal(wrapToggle.getAttribute('aria-pressed'), 'true');
    assert.ok(modal.classList.contains('is-wrap-enabled'));

    window.document.getElementById('toolChangeAuditReason').value = '已核对新增代码，可以执行。';
    window.document.getElementById('approveToolChangeAudit').click();

    assert.deepEqual(sentMessages, [{
        type: 'tool_approval_response',
        data: {
            requestId: 'approve-change-audit-test',
            approved: true,
            reason: '已核对新增代码，可以执行。'
        }
    }]);
    assert.equal(modal.classList.contains('active'), false);

    dom.window.close();
});

test('ordinary tool approval does not expose change audit', () => {
    const { dom, window } = createAuditDom();
    const request = {
        type: 'tool_approval_request',
        data: {
            requestId: 'approve-without-change-preview',
            toolName: 'ReadOnlyTool',
            maid: 'Nova',
            args: { command: 'read' },
            timestamp: '2026-08-24T11:11:00.123+08:00'
        }
    };

    window.notificationRenderer.renderVCPLogNotification(
        request,
        JSON.stringify(request),
        window.document.getElementById('notificationsList')
    );

    const actionLabels = Array.from(
        window.document.querySelectorAll('.notification-actions button'),
        button => button.textContent
    );
    assert.deepEqual(actionLabels, ['允许', '拒绝']);

    dom.window.close();
});