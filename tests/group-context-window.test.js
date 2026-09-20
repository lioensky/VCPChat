const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE,
    MIN_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE,
    MAX_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE,
    normalizeGroupContextWindowSettings,
    selectGroupContextHistory
} = require('../Groupmodules/groupContextWindow');

test('群聊上下文窗口默认关闭并默认保留 100 楼', () => {
    assert.deepEqual(normalizeGroupContextWindowSettings({}), {
        enableContextMessageWindow: false,
        contextMessageWindowSize: DEFAULT_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE
    });
    assert.equal(DEFAULT_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE, 100);
});

test('群聊上下文窗口对非法值回退并钳制到安全边界', () => {
    assert.equal(
        normalizeGroupContextWindowSettings({
            enableContextMessageWindow: true,
            contextMessageWindowSize: 'invalid'
        }).contextMessageWindowSize,
        DEFAULT_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE
    );
    assert.equal(
        normalizeGroupContextWindowSettings({ contextMessageWindowSize: 0 }).contextMessageWindowSize,
        MIN_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE
    );
    assert.equal(
        normalizeGroupContextWindowSettings({ contextMessageWindowSize: 999999 }).contextMessageWindowSize,
        MAX_GROUP_CONTEXT_MESSAGE_WINDOW_SIZE
    );
    assert.equal(
        normalizeGroupContextWindowSettings({ contextMessageWindowSize: '42' }).contextMessageWindowSize,
        42
    );
});

test('窗口关闭时返回完整历史', () => {
    const history = Array.from({ length: 150 }, (_, index) => ({ id: `message-${index}` }));
    const selected = selectGroupContextHistory(history, {
        enableContextMessageWindow: false,
        contextMessageWindowSize: 10
    });

    assert.equal(selected, history);
    assert.equal(selected.length, 150);
});

test('窗口开启时只保留最新 N 楼且不修改原历史', () => {
    const history = Array.from({ length: 8 }, (_, index) => ({ id: `message-${index + 1}` }));
    const originalSnapshot = structuredClone(history);

    const selected = selectGroupContextHistory(history, {
        enableContextMessageWindow: true,
        contextMessageWindowSize: 3
    });

    assert.notEqual(selected, history);
    assert.deepEqual(selected.map(message => message.id), [
        'message-6',
        'message-7',
        'message-8'
    ]);
    assert.deepEqual(history, originalSnapshot);
});

test('历史未超过窗口时无需创建副本', () => {
    const history = [{ id: 'message-1' }, { id: 'message-2' }];
    const selected = selectGroupContextHistory(history, {
        enableContextMessageWindow: true,
        contextMessageWindowSize: 100
    });

    assert.equal(selected, history);
});