import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createDomListenerOwner } from '../modules/renderer/domListenerOwner.js';

function createEnvironment(filterAction = null) {
    const dom = new JSDOM(`<!doctype html><html><body>
        <div id="floating-toast-notifications-container"></div>
        <aside id="notificationsSidebar"></aside>
        <ul id="notificationsList"></ul>
    </body></html>`, { runScripts: 'outside-only' });

    if (!dom.window.CSS) dom.window.CSS = {};
    if (!dom.window.CSS.escape) dom.window.CSS.escape = s => String(s);
    if (typeof globalThis.CSS === 'undefined') globalThis.CSS = dom.window.CSS;

    dom.window.chatAPI = {
        sendVCPLogMessage: () => true,
    };

    dom.window.eval(fs.readFileSync('modules/notificationRenderer.js', 'utf8'));
    const owner = createDomListenerOwner();
    dom.window.notificationRenderer.configureCapabilities({
        filterManager: {
            checkMessageFilter: () => (filterAction ? { action: filterAction } : null),
        },
        listenerOwner: owner,
    });

    const list = dom.window.document.getElementById('notificationsList');
    const toastContainer = dom.window.document.getElementById('floating-toast-notifications-container');

    return { dom, owner, list, toastContainer };
}

test('tool approval card displays path, reason, and truncated preview from real server data shape (args.*)', () => {
    const { dom, owner, list } = createEnvironment();

    const targetLines = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8'].join('\n');
    const replaceLines = ['new 1', 'new 2', 'new 3'].join('\n');

    // 真实服务器发送的数据形状：path, reason, target, replace 在 args 内
    const realServerApprovalRequest = {
        type: 'tool_approval_request',
        data: {
            requestId: 'req-real-shape-1',
            toolName: 'ProjectForge',
            maid: 'Nova',
            timestamp: new Date().toISOString(),
            approvalTtlMs: 300000,
            args: {
                command: 'EditCode',
                path: 'modules/notificationRenderer.js',
                reason: '修复卡片内容盲批隐患',
                target: targetLines,
                replace: replaceLines,
            },
        },
    };

    dom.window.notificationRenderer.renderVCPLogNotification(realServerApprovalRequest, null, list, {});

    const card = list.querySelector('.notification-tool-approval[data-tool-approval-request-id="req-real-shape-1"]');
    assert.ok(card, 'Approval card should be rendered in the list');

    const pathElem = card.querySelector('.notification-approval-path .notification-approval-value');
    assert.ok(pathElem, 'Path element should exist');
    assert.equal(pathElem.textContent, 'modules/notificationRenderer.js');

    const reasonElem = card.querySelector('.notification-approval-ai-reason .notification-approval-value');
    assert.ok(reasonElem, 'AI Reason element should exist');
    assert.equal(reasonElem.textContent, '修复卡片内容盲批隐患');

    const diffRows = [...card.querySelectorAll('.notification-approval-diff-line')].map(row => row.textContent);
    assert.equal(diffRows.length, 8, 'Diff preview is capped at 8 changed lines');
    assert.ok(diffRows.slice(0, 8).every(row => row.startsWith('- ') || row.startsWith('+ ')));
    assert.ok(card.querySelector('.notification-approval-preview-code').textContent.includes('… 还有 3 行改动'));

    owner.dispose();
    dom.window.close();
});

test('tool approval card highlights code deletion when replace is empty or missing', () => {
    const { dom, owner, list } = createEnvironment();

    const approvalRequest = {
        type: 'tool_approval_request',
        data: {
            requestId: 'req-delete-1',
            toolName: 'ProjectForge',
            maid: 'Nova',
            timestamp: new Date().toISOString(),
            args: {
                command: 'EditCode',
                path: 'src/deprecated.js',
                target: 'const old = 123;\n',
                replace: '',
            },
        },
    };

    dom.window.notificationRenderer.renderVCPLogNotification(approvalRequest, null, list, {});

    const card = list.querySelector('.notification-tool-approval[data-tool-approval-request-id="req-delete-1"]');
    assert.ok(card);

    const section = card.querySelector('.notification-approval-preview-section.is-deletion');
    assert.ok(section, 'Deletion must be flagged');
    assert.equal(section.querySelector('.notification-approval-preview-label').textContent, '将删除这段代码');
    assert.equal(section.querySelector('.notification-approval-preview-code').textContent, 'const old = 123;\n');

    owner.dispose();
    dom.window.close();
});

test('tool approval request deduplication ignores repeated requestId and handled requests', () => {
    const { dom, owner, list } = createEnvironment();

    const approvalRequest = {
        type: 'tool_approval_request',
        data: {
            requestId: 'req-dedup-1',
            toolName: 'FileOperator',
            maid: 'Nova',
            timestamp: new Date().toISOString(),
            args: {
                command: 'ReadFile',
            },
        },
    };

    dom.window.notificationRenderer.renderVCPLogNotification(approvalRequest, null, list, {});
    let cards = list.querySelectorAll('.notification-tool-approval[data-tool-approval-request-id="req-dedup-1"]');
    assert.equal(cards.length, 1);

    // 重复推送未处理请求（如重连重放）
    dom.window.notificationRenderer.renderVCPLogNotification(approvalRequest, null, list, {});
    cards = list.querySelectorAll('.notification-tool-approval[data-tool-approval-request-id="req-dedup-1"]');
    assert.equal(cards.length, 1, 'Should not render duplicate card');

    // 允许该请求
    const allowBtn = cards[0].querySelector('.vcp-btn-success');
    assert.ok(allowBtn);
    allowBtn.click();

    assert.equal(cards[0].dataset.notificationState, 'resolved');

    // 答复后再推送重放请求
    dom.window.notificationRenderer.renderVCPLogNotification(approvalRequest, null, list, {});
    cards = list.querySelectorAll('.notification-tool-approval[data-tool-approval-request-id="req-dedup-1"]');
    assert.equal(cards.length, 1, 'Should not add new card after request was handled');

    owner.dispose();
    dom.window.close();
});

test('tool approval request bypasses message filter and displays floating toast', () => {
    // 过滤规则配置为对所有通知返回 hide
    const { dom, owner, list, toastContainer } = createEnvironment('hide');

    const normalLog = {
        type: 'vcp_log',
        data: { tool_name: 'VSearch', status: 'success', content: 'done' },
    };
    dom.window.notificationRenderer.renderVCPLogNotification(normalLog, null, list, {});
    assert.equal(toastContainer.children.length, 0, 'Normal log should be filtered out by hide rule');

    const approvalRequest = {
        type: 'tool_approval_request',
        data: {
            requestId: 'req-toast-filter-1',
            toolName: 'PowerShellExecutor',
            maid: 'Nova',
            timestamp: new Date().toISOString(),
            args: { command: 'Get-Process' },
        },
    };
    dom.window.notificationRenderer.renderVCPLogNotification(approvalRequest, null, list, {});
    const approvalToast = toastContainer.querySelector('.floating-toast-notification');
    assert.ok(approvalToast, 'Approval request must not be hidden by notification filter');

    owner.dispose();
    dom.window.close();
});

test('tool approval card expires when TTL elapsed, closes toast and sets state to resolved', async () => {
    const { dom, owner, list, toastContainer } = createEnvironment();

    const approvalRequest = {
        type: 'tool_approval_request',
        data: {
            requestId: 'req-expire-1',
            toolName: 'FileOperator',
            maid: 'Nova',
            approvalTtlMs: 50,
            timestamp: new Date().toISOString(),
            args: { command: 'DeleteFile', path: 'temp.log' },
        },
    };

    dom.window.notificationRenderer.renderVCPLogNotification(approvalRequest, null, list, {});

    const card = list.querySelector('.notification-tool-approval[data-tool-approval-request-id="req-expire-1"]');
    assert.ok(card);
    assert.equal(card.dataset.notificationState, 'pending');

    const toast = toastContainer.querySelector('.floating-toast-notification[data-tool-approval-request-id="req-expire-1"]');
    assert.ok(toast);

    await new Promise(resolve => setTimeout(resolve, 80));

    assert.equal(card.dataset.notificationState, 'resolved', 'Card state should become resolved on expiration');
    assert.equal(card.dataset.protectedNotification, undefined, 'Protection should be cleared');
    const verdict = card.querySelector('.notification-result-verdict');
    assert.ok(verdict);
    assert.equal(verdict.textContent, '已过期');
    assert.equal(card.querySelector('.notification-actions'), null, 'Action buttons should be removed');
    assert.equal(card.querySelector('.notification-approval-reason'), null, 'Reason input should be removed');

    assert.ok(toast.classList.contains('exiting'), 'Toast should exit on expiration');

    owner.dispose();
    dom.window.close();
});

test('approving before TTL cancels expiration timer: card stays approved and never flips to expired', async () => {
    const { dom, owner, list } = createEnvironment();

    const approvalRequest = {
        type: 'tool_approval_request',
        data: {
            requestId: 'req-cancel-timer-1',
            toolName: 'FileOperator',
            maid: 'Nova',
            approvalTtlMs: 50,
            timestamp: new Date().toISOString(),
            args: { command: 'WriteFile', path: 'output.txt' },
        },
    };

    dom.window.notificationRenderer.renderVCPLogNotification(approvalRequest, null, list, {});
    const card = list.querySelector('.notification-tool-approval[data-tool-approval-request-id="req-cancel-timer-1"]');
    assert.ok(card);

    const allowBtn = card.querySelector('.vcp-btn-success');
    assert.ok(allowBtn);
    allowBtn.click();

    // 确认已成为允许状态
    const verdict = card.querySelector('.notification-result-verdict');
    assert.equal(verdict.textContent, '已允许');
    assert.equal(card.querySelectorAll('.notification-result').length, 1);

    // 等待 TTL (50ms) 过去
    await new Promise(resolve => setTimeout(resolve, 80));

    // 验证定时器取消成功，卡片仍然只有一个已允许结果，绝无第二个“已过期”
    assert.equal(card.querySelectorAll('.notification-result').length, 1);
    assert.equal(verdict.textContent, '已允许');
    assert.equal(card.dataset.notificationState, 'resolved');

    owner.dispose();
    dom.window.close();
});

test('replayed request whose timestamp already exceeded TTL renders immediately as expired without actions', () => {
    const { dom, owner, list } = createEnvironment();

    // 请求发生于 6 分钟前，超出 5 分钟 (300000ms) 的 TTL
    const sixMinutesAgo = new Date(Date.now() - 360000).toISOString();
    const expiredReplayRequest = {
        type: 'tool_approval_request',
        _vcpReplay: true,
        data: {
            requestId: 'req-already-expired-1',
            toolName: 'FileOperator',
            maid: 'Nova',
            timestamp: sixMinutesAgo,
            approvalTtlMs: 300000,
            args: { command: 'DeleteFile', path: 'old.txt' },
        },
    };

    dom.window.notificationRenderer.renderVCPLogNotification(expiredReplayRequest, null, list, {});

    const card = list.querySelector('.notification-tool-approval[data-tool-approval-request-id="req-already-expired-1"]');
    assert.ok(card, 'Card should be rendered');
    assert.equal(card.dataset.notificationState, 'resolved');
    assert.equal(card.querySelector('.notification-actions'), null, 'Should have no action buttons');
    assert.equal(card.querySelector('.notification-approval-reason'), null, 'Should have no reason input');

    const verdict = card.querySelector('.notification-result-verdict');
    assert.ok(verdict);
    assert.equal(verdict.textContent, '已过期');

    owner.dispose();
    dom.window.close();
});

test('live request with a skewed server clock still gets the full TTL', () => {
    const { dom, owner, list } = createEnvironment();

    // 服务器时钟比本机慢 10 分钟：实时请求不能因此一到就判过期
    dom.window.notificationRenderer.renderVCPLogNotification({
        type: 'tool_approval_request',
        data: {
            requestId: 'req-skewed-clock-1',
            toolName: 'ProjectForge',
            maid: 'Nova',
            timestamp: new Date(Date.now() - 600000).toISOString(),
            approvalTtlMs: 300000,
            args: { command: 'EditCode', path: 'a.js', reason: 'r', target: 'x', replace: 'y' },
        },
    }, null, list, {});

    const card = list.querySelector('.notification-tool-approval[data-tool-approval-request-id="req-skewed-clock-1"]');
    assert.equal(card.dataset.notificationState, 'pending');
    assert.ok(card.querySelector('.notification-actions'));

    owner.dispose();
    dom.window.close();
});

test('append-style edit previews only the added lines, not the identical head', () => {
    const { dom, owner, list } = createEnvironment();
    const head = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    dom.window.notificationRenderer.renderVCPLogNotification({
        type: 'tool_approval_request',
        data: {
            requestId: 'req-append-1',
            toolName: 'ProjectForge',
            maid: 'Nova',
            args: { command: 'EditCode', path: 'x.js', reason: 'append', target: head, replace: `${head}\nadded 1\nadded 2` },
        },
    }, null, list, {});
    const rows = [...list.querySelectorAll('.notification-approval-diff-line')].map(row => row.textContent);
    assert.deepEqual(rows, ['+ added 1\n', '+ added 2\n']);
    owner.dispose();
    dom.window.close();
});

test('CreateFile approval request displays "文件内容" preview truncated to 6 lines with ellipsis', () => {
    const { dom, owner, list } = createEnvironment();

    const fileContent = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8'].join('\n');
    const createFileRequest = {
        type: 'tool_approval_request',
        data: {
            requestId: 'req-create-file-1',
            toolName: 'FileOperator',
            maid: 'Nova',
            timestamp: new Date().toISOString(),
            args: {
                command: 'CreateFile',
                path: 'docs/readme.txt',
                content: fileContent,
            },
        },
    };

    dom.window.notificationRenderer.renderVCPLogNotification(createFileRequest, null, list, {});

    const card = list.querySelector('.notification-tool-approval[data-tool-approval-request-id="req-create-file-1"]');
    assert.ok(card, 'Card should be rendered');

    const labelElem = Array.from(card.querySelectorAll('.notification-approval-preview-label'))
        .find(el => el.textContent.includes('文件内容'));
    assert.ok(labelElem, 'Preview label should mention 文件内容');

    const previewSection = labelElem.closest('.notification-approval-preview-section') || labelElem.parentElement;
    const codeElem = previewSection.querySelector('.notification-approval-preview-code');
    assert.ok(codeElem, 'Preview code element should exist');

    const displayedText = codeElem.textContent;
    assert.ok(displayedText.includes('line 6'), 'Should contain line 6');
    assert.ok(displayedText.includes('…'), 'Should contain ellipsis');
    assert.ok(!displayedText.includes('line 7'), 'Should not contain line 7');

    owner.dispose();
    dom.window.close();
});

test('tool approval card displays step-by-step previews for numbered EditCode steps (target diff, delete, insert, symbol, lines)', () => {
    const { dom, owner, list } = createEnvironment();

    const numberedApprovalRequest = {
        type: 'tool_approval_request',
        data: {
            requestId: 'req-numbered-steps-1',
            toolName: 'ProjectForge',
            maid: 'Nova',
            timestamp: new Date().toISOString(),
            args: {
                command: 'EditCode',
                path: 'modules/example.js',
                reason: '多步重构与行替换',
                op1: 'target',
                target1: 'const legacy = 1;\n',
                replace1: 'const modern = 2;\n',
                op2: 'delete',
                start2: 12,
                end2: 18,
                op3: 'delete',
                symbol3: 'deprecatedFunction',
                op4: 'insert',
                after4: 25,
                content4: 'function newHelper() {}\n',
                symbol5: 'renderLayout',
                content5: 'const renderLayout = () => true;\n',
            },
        },
    };

    dom.window.notificationRenderer.renderVCPLogNotification(numberedApprovalRequest, null, list, {});

    const card = list.querySelector('.notification-tool-approval[data-tool-approval-request-id="req-numbered-steps-1"]');
    assert.ok(card, 'Card should be rendered');

    const sections = card.querySelectorAll('.notification-approval-preview-section');
    assert.equal(sections.length, 5, 'Should render 5 preview sections');

    // Step 1: target diff
    assert.equal(sections[0].querySelector('.notification-approval-preview-label').textContent, '步骤 1 · 改动');
    const diffLines1 = [...sections[0].querySelectorAll('.notification-approval-diff-line')].map(el => el.textContent.trim());
    assert.ok(diffLines1.includes('- const legacy = 1;'));
    assert.ok(diffLines1.includes('+ const modern = 2;'));

    // Step 2: op=delete line range
    assert.ok(sections[1].classList.contains('is-deletion'));
    assert.equal(sections[1].querySelector('.notification-approval-preview-label').textContent, '步骤 2 · 将删除第 12-18 行');
    assert.equal(sections[1].querySelector('.notification-approval-preview-code'), null, 'Empty delete has no empty code block');

    // Step 3: op=delete symbol
    assert.ok(sections[2].classList.contains('is-deletion'));
    assert.equal(sections[2].querySelector('.notification-approval-preview-label').textContent, '步骤 3 · 将删除符号 deprecatedFunction');

    // Step 4: op=insert after
    assert.equal(sections[3].querySelector('.notification-approval-preview-label').textContent, '步骤 4 · 在第 25 行后插入');
    assert.ok(sections[3].querySelector('.notification-approval-preview-code').textContent.includes('function newHelper()'));

    // Step 5: symbol replace
    assert.equal(sections[4].querySelector('.notification-approval-preview-label').textContent, '步骤 5 · 替换符号 renderLayout');
    assert.ok(sections[4].querySelector('.notification-approval-preview-code').textContent.includes('renderLayout = () => true'));

    owner.dispose();
    dom.window.close();
});

test('tool approval card truncates numbered steps exceeding 5 and shows "... 还有 N 步"', () => {
    const { dom, owner, list } = createEnvironment();

    const sevenStepsRequest = {
        type: 'tool_approval_request',
        data: {
            requestId: 'req-seven-steps-1',
            toolName: 'ProjectForge',
            maid: 'Nova',
            timestamp: new Date().toISOString(),
            args: {
                command: 'EditCode',
                path: 'modules/batch.js',
                reason: '批量重命名与更新',
                op1: 'delete',
                start1: 1,
                end1: 2,
                op2: 'delete',
                start2: 5,
                end2: 6,
                op3: 'insert',
                before3: 10,
                content3: '// step 3\n',
                lines4: '20-22',
                content4: 'const v4 = 4;\n',
                symbol5: 'foo',
                content5: 'const foo = 5;\n',
                symbol6: 'bar',
                content6: 'const bar = 6;\n',
                symbol7: 'baz',
                content7: 'const baz = 7;\n',
            },
        },
    };

    dom.window.notificationRenderer.renderVCPLogNotification(sevenStepsRequest, null, list, {});

    const card = list.querySelector('.notification-tool-approval[data-tool-approval-request-id="req-seven-steps-1"]');
    assert.ok(card, 'Card should be rendered');

    const sections = card.querySelectorAll('.notification-approval-preview-section');
    assert.equal(sections.length, 6, 'Should render 5 steps + 1 overflow summary');

    assert.equal(sections[0].querySelector('.notification-approval-preview-label').textContent, '步骤 1 · 将删除第 1-2 行');
    assert.equal(sections[3].querySelector('.notification-approval-preview-label').textContent, '步骤 4 · 第 20-22 行 → 新内容');
    assert.equal(sections[4].querySelector('.notification-approval-preview-label').textContent, '步骤 5 · 替换符号 foo');
    assert.equal(sections[5].querySelector('.notification-approval-preview-label').textContent, '… 还有 2 步');
    assert.equal(sections[5].querySelector('.notification-approval-preview-code'), null);

    owner.dispose();
    dom.window.close();
});

test('tool approval card formats single-step op=delete with line range properly as deletion', () => {
    const { dom, owner, list } = createEnvironment();

    const singleDeleteRequest = {
        type: 'tool_approval_request',
        data: {
            requestId: 'req-single-delete-range-1',
            toolName: 'ProjectForge',
            maid: 'Nova',
            timestamp: new Date().toISOString(),
            args: {
                command: 'EditCode',
                path: 'modules/clean.js',
                reason: '清理无用代码段',
                op: 'delete',
                start: 40,
                end: 45,
            },
        },
    };

    dom.window.notificationRenderer.renderVCPLogNotification(singleDeleteRequest, null, list, {});

    const card = list.querySelector('.notification-tool-approval[data-tool-approval-request-id="req-single-delete-range-1"]');
    assert.ok(card, 'Card should be rendered');

    const section = card.querySelector('.notification-approval-preview-section');
    assert.ok(section.classList.contains('is-deletion'), 'Should be marked as deletion');
    assert.equal(section.querySelector('.notification-approval-preview-label').textContent, '将删除第 40-45 行');

    owner.dispose();
    dom.window.close();
});

test('deletion warning names a misspelled replace field', () => {
    const { dom, owner, list } = createEnvironment();

    dom.window.notificationRenderer.renderVCPLogNotification({
        type: 'tool_approval_request',
        data: {
            requestId: 'req-typo-1',
            toolName: 'ProjectForge',
            maid: 'Nova',
            timestamp: new Date().toISOString(),
            args: {
                command: 'EditCode',
                path: 'styles/notifications.css',
                target: '.toast-manual-close {\n    opacity: 0.5;\n}\n',
                replacement: '.toast-manual-close {\n    opacity: 0.6;\n}\n',
            },
        },
    }, null, list, {});

    const section = list.querySelector('[data-tool-approval-request-id="req-typo-1"] .notification-approval-preview-section.is-deletion');
    assert.ok(section, 'A missing replace still deletes the target, so the card must say so');
    assert.equal(
        section.querySelector('.notification-approval-preview-label').textContent,
        '将删除这段代码（参数写成了 replacement，ProjectForge 只认 replace）'
    );

    owner.dispose();
    dom.window.close();
});

test('an EditCode with oldCode/newCode says up front that approving it will not run', () => {
    const { dom, owner, list } = createEnvironment();

    // 真实审批请求（群聊里 Nova 发的），以前卡片上什么改动都不显示
    dom.window.notificationRenderer.renderVCPLogNotification({
        type: 'tool_approval_request',
        data: {
            requestId: 'req-old-new',
            toolName: 'ProjectForge',
            maid: 'Nova',
            timestamp: new Date().toISOString(),
            args: {
                maid: 'Nova',
                command: 'EditCode',
                projectId: 'p2js0',
                path: 'docs/watchdog-check.md',
                filePath: 'docs/watchdog-check.md',
                oldCode: '这个文件是在审批等待超过一分钟后才批准的',
                newCode: '这个文件是在审批等待超过一分钟后才批准的\n第二轮：群聊已走完整工具结果通道',
                reason: '追加第二轮群聊完整工具结果通道检查记录',
            },
        },
    }, null, list, {});

    const labels = [...list.querySelectorAll('[data-tool-approval-request-id="req-old-new"] .notification-approval-preview-section.is-deletion .notification-approval-preview-label')].map(el => el.textContent);
    assert.deepEqual(labels, ['参数写成了 oldCode / newCode，ProjectForge 只认 target / replace，批准了也不会执行']);

    owner.dispose();
    dom.window.close();
});

test('numbered steps: misspelled replaceN and line steps without contentN are flagged as deletions', () => {
    const { dom, owner, list } = createEnvironment();

    dom.window.notificationRenderer.renderVCPLogNotification({
        type: 'tool_approval_request',
        data: {
            requestId: 'req-typo-2',
            toolName: 'ProjectForge',
            maid: 'Nova',
            timestamp: new Date().toISOString(),
            args: {
                command: 'EditCode',
                path: 'a.js',
                op1: 'target',
                target1: 'const a = 1;',
                replacement1: 'const a = 2;',
                start2: '5',
                end2: '6',
                replace2: 'const b = 3;',
                target3: 'const c = 1;',
                replace3: 'const c = 2;',
            },
        },
    }, null, list, {});

    const card = list.querySelector('[data-tool-approval-request-id="req-typo-2"]');
    const labels = [...card.querySelectorAll('.notification-approval-preview-section.is-deletion .notification-approval-preview-label')].map(el => el.textContent);
    assert.deepEqual(labels, [
        '步骤 1 · 将删除这段代码（参数写成了 replacement1，ProjectForge 只认 replace1）',
        '步骤 2 · 第 5-6 行缺少 content2，可能会被删掉',
    ]);
    assert.equal(card.querySelectorAll('.notification-approval-preview-section').length, 3);

    owner.dispose();
    dom.window.close();
});

test('Rollback / RemoveFile / PurgeProjects cards spell out what they act on', () => {
    const { dom, owner, list } = createEnvironment();
    const render = (requestId, args) => dom.window.notificationRenderer.renderVCPLogNotification({
        type: 'tool_approval_request',
        data: { requestId, toolName: 'ProjectForge', maid: 'Nova', timestamp: new Date().toISOString(), args: { command: args.command, projectId: 'pzi2e', reason: 'r', ...args } },
    }, null, list, {});
    const sectionsOf = requestId => [...list.querySelectorAll(`[data-tool-approval-request-id="${requestId}"] .notification-approval-preview-section`)]
        .map(s => [s.classList.contains('is-deletion'), s.querySelector('.notification-approval-preview-label').textContent, s.querySelector('pre')?.textContent || '']);

    render('rb-1', { command: 'Rollback', nodeId: 'n36' });
    assert.deepEqual(sectionsOf('rb-1'), [[false, '把整个工程恢复到节点 n36 时的状态', '']]);

    render('rb-2', { command: 'Rollback', Batch: 'last', force: 'true', dryRun: 'false' });
    assert.deepEqual(sectionsOf('rb-2'), [
        [false, '撤销最近一次批次', ''],
        [true, 'force=true：磁盘上不是 ProjectForge 写入的改动也会被覆盖', ''],
    ]);

    render('rb-3', { command: 'Rollback', toNode: 'n5', path: 'a.js', dryRun: 'true' });
    assert.deepEqual(sectionsOf('rb-3'), [[false, '把 a.js 恢复到节点 n5 时的状态（仅预演，不写盘）', '']]);

    render('rm-1', { command: 'RemoveFile', paths: 'a.js, b.js' });
    assert.deepEqual(sectionsOf('rm-1'), [[false, '将移到回收站（可用 Rollback 恢复）', 'a.js\nb.js']]);

    render('pg-1', { command: 'PurgeProjects', projectIds: 'p1,p2', confirm: 'true' });
    assert.deepEqual(sectionsOf('pg-1'), [[true, '永久清除工程记录和全部历史快照，之后无法回退', 'p1\np2']]);

    owner.dispose();
    dom.window.close();
});
