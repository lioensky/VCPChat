import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainChatSendOwner } from '../modules/renderer/mainChatSendOwner.js';

const ref = value => ({ get: () => value, set: next => (value = next) });
const button = () => {
    const classes = new Set();
    return {
        innerHTML: '<span>send</span>', dataset: {}, title: '', attributes: {},
        classList: { toggle(name, active) { active ? classes.add(name) : classes.delete(name); }, contains: name => classes.has(name) },
        setAttribute(name, value) { this.attributes[name] = value; },
    };
};

function harness({ history = [], item = { id: 'agent-a', type: 'agent' }, element = null } = {}) {
    const sendButton = button();
    const historyRef = ref(history);
    const calls = [];
    const owner = createMainChatSendOwner({
        button: sendButton,
        messagesRoot: { querySelector: () => element },
        historyRef,
        selectedItemRef: ref(item),
        topicIdRef: ref('topic-a'),
        streamProjection: {
            getActiveStreamingMessageId: () => null,
            getActiveStreamingContext: () => null,
            discardStreamingMessage: id => calls.push(['discard', id]),
        },
        chatAPI: { interruptGroupRequest: async id => (calls.push(['group-interrupt', id]), { success: true }) },
        interruptHandler: { interrupt: async id => (calls.push(['agent-interrupt', id]), { success: true }) },
        getAdapter: () => ({ cancelStream: async (id, reason) => (calls.push(['cancel', id, reason]), null) }),
        getChatManager: () => ({ handleSendMessage: async () => calls.push(['send']) }),
        messageRenderer: { removeMessageById: (id, persist) => calls.push(['remove', id, persist]) },
        notify: (message, type) => calls.push(['notify', message, type]),
    });
    return { owner, sendButton, historyRef, calls };
}

test('send owner preserves send projection and dispatch', async () => {
    const { owner, sendButton, calls } = harness();
    assert.equal(owner.update(), true);
    assert.equal(sendButton.dataset.mode, 'send');
    assert.equal(sendButton.innerHTML, '<span>send</span>');
    assert.equal(sendButton.attributes['aria-label'], '发送消息');
    await owner.handleAction();
    assert.deepEqual(calls, [['send']]);
});

test('send owner projects interrupt mode and dispatches the matching agent request', async () => {
    const message = { id: 'message-a', role: 'assistant', isThinking: true };
    const element = { isConnected: true, classList: { contains: () => false } };
    const { owner, sendButton, calls } = harness({ history: [message], element });
    owner.update();
    assert.equal(sendButton.dataset.mode, 'interrupt');
    assert.equal(sendButton.classList.contains('interrupt-mode'), true);
    assert.equal(sendButton.title, '中止回复');
    assert.equal(sendButton.attributes['aria-label'], '中止回复');
    await owner.handleAction();
    assert.deepEqual(calls, [
        ['agent-interrupt', 'message-a'],
        ['notify', '已发送中止信号。', 'success'],
    ]);
});

test('send owner preserves failed-interrupt local cleanup', async () => {
    const message = { id: 'message-g', role: 'assistant', isThinking: true, isGroupMessage: true };
    const element = { isConnected: true, classList: { contains: () => true } };
    const { historyRef, calls } = harness({ history: [message], item: { id: 'group-a', type: 'group' }, element });
    // Replace the successful group producer with the same observable failure path used by production.
    const localOwner = createMainChatSendOwner({
        button: button(), messagesRoot: { querySelector: () => element }, historyRef,
        selectedItemRef: ref({ id: 'group-a', type: 'group' }), topicIdRef: ref('topic-a'),
        streamProjection: { discardStreamingMessage: id => calls.push(['discard', id]) },
        chatAPI: { interruptGroupRequest: async () => ({ success: false, error: 'offline' }) },
        interruptHandler: {}, getAdapter: () => ({ cancelStream: async (id, reason) => (calls.push(['cancel', id, reason]), null) }),
        getChatManager: () => null,
        messageRenderer: { removeMessageById: (id, persist) => calls.push(['remove', id, persist]) },
        notify: (messageText, type) => calls.push(['notify', messageText, type]),
    });
    await localOwner.interrupt();
    assert.deepEqual(historyRef.get(), []);
    assert.deepEqual(calls, [
        ['cancel', 'message-g', 'offline'],
        ['discard', 'message-g'],
        ['remove', 'message-g', false],
        ['notify', '中止失败：offline，已在本地停止。', 'error'],
    ]);
});

test('send owner suppresses late interrupt completion after dispose', async () => {
    let resolveInterrupt;
    const calls = [];
    const message = { id: 'message-a', role: 'assistant', isThinking: true };
    const element = { isConnected: true, classList: { contains: () => false } };
    const owner = createMainChatSendOwner({
        button: button(), messagesRoot: { querySelector: () => element }, historyRef: ref([message]),
        selectedItemRef: ref({ id: 'agent-a', type: 'agent' }), topicIdRef: ref('topic-a'), streamProjection: {}, chatAPI: {},
        interruptHandler: { interrupt: () => new Promise(resolve => { resolveInterrupt = resolve; }) },
        getAdapter: () => ({ cancelStream: () => calls.push('cancel') }), getChatManager: () => null,
        messageRenderer: {}, notify: () => calls.push('notify'),
    });
    const pending = owner.interrupt();
    owner.dispose();
    owner.dispose();
    resolveInterrupt({ success: true });
    assert.equal(await pending, false);
    assert.deepEqual(calls, []);
    assert.equal(await owner.handleAction(), false);
});
