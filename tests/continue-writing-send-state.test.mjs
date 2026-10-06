import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('continue writing renders its thinking message before refreshing the send control', () => {
    const source = fs.readFileSync('modules/event-listeners.js', 'utf8');
    const start = source.indexOf('async function handleContinueWriting');
    const end = source.indexOf('// 导出到window对象供Flowlock使用', start);
    const implementation = source.slice(start, end);

    assert.ok(start >= 0 && end > start, 'handleContinueWriting implementation must remain discoverable');

    const pushIndex = implementation.indexOf('currentChatHistory.push(thinkingMessage);');
    const renderIndex = implementation.indexOf('await messageRenderer?.renderMessage(thinkingMessage, false);');
    const refreshIndex = implementation.indexOf('notifySendStateChanged?.();');

    assert.ok(pushIndex >= 0, 'thinking message must enter current history');
    assert.ok(renderIndex > pushIndex, 'thinking message must render after entering history');
    assert.ok(refreshIndex > renderIndex, 'send state must refresh after the thinking element reaches the DOM');
});

test('main renderer injects the send owner state projection into continue-writing handlers', () => {
    const source = fs.readFileSync('renderer.js', 'utf8');
    const setupStart = source.indexOf('setupEventListeners({');
    const setupEnd = source.indexOf('});', setupStart);
    const setup = source.slice(setupStart, setupEnd);

    assert.match(setup, /notifySendStateChanged:\s*mainChatSendOwner\.update/);
});