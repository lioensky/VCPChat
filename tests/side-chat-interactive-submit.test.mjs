// 消息里的交互按钮（renderer 的 handleSendMessage）不能绕过辅助对话的忙碌闸门，也不能吞掉输入框里的草稿
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountSideChatSurface } from '../modules/renderer/sideChatSurfaceOwner.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

async function fixture() {
    const dom = new JSDOM('<div id="mount"></div>');
    const doc = dom.window.document;
    let history = [];
    let sendFromMessage = null;
    let release = null;
    const sends = [];
    const toasts = [];
    const handle = await mountSideChatSurface(doc.getElementById('mount'), {
        descriptor: {
            id: 'side', title: '侧聊', model: 'model', contextMode: 'references-only',
            parent: { itemId: 'agent', topicId: 'parent' }, child: { itemId: 'agent', topicId: 'child' }
        },
        chatCapabilities: {
            repository: { getHistory: async () => history, saveHistory: async () => ({ success: true }) },
            uiHelper: { showToastNotification: (message, type) => toasts.push({ message, type }) },
            manager: {
                async sendMessage(request) {
                    sends.push(request);
                    request.onOperation?.({ cancel: async () => true });
                    await new Promise(resolve => { release = resolve; });
                    return { terminal: { event: { type: 'completed' } } };
                }
            },
            createRenderer({ conversation, handleSendMessage }) {
                sendFromMessage = handleSendMessage;
                return {
                    renderer: { renderHistory: async () => {} },
                    conversation: {
                        selectedItemRef: { get: () => conversation.selectedItem },
                        topicIdRef: { get: () => conversation.topicId },
                        historyRef: { get: () => history, set: next => { history = next; } },
                        replaceHistory: next => { history = next; }
                    },
                    dispose: async () => {}
                };
            }
        }
    });
    await settle();
    const textarea = doc.querySelector('.side-chat-textarea');
    const stopBtn = doc.querySelector('.side-chat-stop-btn');
    return {
        dom, handle, textarea, stopBtn, sends, toasts,
        clickMessageButton: text => sendFromMessage(text),
        typeAndSend(text) { textarea.value = text; doc.querySelector('form').requestSubmit(); },
        finish: () => release?.(),
        async cleanup() { release?.(); await handle.dispose(); dom.window.close(); }
    };
}

test('a message button clicked while a reply streams does not start a second send', async () => {
    const f = await fixture();
    try {
        f.typeAndSend('first question');
        await settle();
        assert.equal(f.sends.length, 1);
        assert.equal(f.stopBtn.hidden, false);

        f.clickMessageButton('option A');
        await settle();
        assert.equal(f.sends.length, 1, 'no second send while the first one streams');
        assert.equal(f.stopBtn.hidden, false, 'the running reply can still be stopped');
        assert.ok(f.toasts.some(t => t.type === 'warning'));
    } finally { await f.cleanup(); }
});

test('a message button does not overwrite or send a typed draft', async () => {
    const f = await fixture();
    try {
        f.textarea.value = 'half-written thought';
        f.clickMessageButton('option A');
        await settle();
        assert.equal(f.sends.length, 0);
        assert.equal(f.textarea.value, 'half-written thought');

        f.textarea.value = '';
        f.clickMessageButton('option A');
        await settle();
        assert.equal(f.sends.length, 1);
    } finally { await f.cleanup(); }
});

test('a failed send puts the draft back even when the same words were sent successfully before', async () => {
    const dom = new JSDOM('<div id="mount"></div>');
    const doc = dom.window.document;
    let history = [
        { id: 'u-old', role: 'user', content: '继续' },
        { id: 'a-old', role: 'assistant', content: '好的' }
    ];
    const handle = await mountSideChatSurface(doc.getElementById('mount'), {
        descriptor: {
            id: 'side', title: '侧聊', model: 'model', contextMode: 'references-only',
            parent: { itemId: 'agent', topicId: 'parent' }, child: { itemId: 'agent', topicId: 'child' }
        },
        chatCapabilities: {
            repository: { getHistory: async () => history, saveHistory: async () => ({ success: true }) },
            uiHelper: { showToastNotification() {} },
            // 传输失败：这一轮的用户消息已经按 id 撤回，历史里只剩以前那条同样的「继续」
            manager: { async sendMessage() { return { terminal: { event: { type: 'failed', outcome: { transport: { error: 'network down' } } } } }; } },
            createRenderer({ conversation }) {
                return {
                    renderer: { renderHistory: async () => {} },
                    conversation: {
                        selectedItemRef: { get: () => conversation.selectedItem },
                        topicIdRef: { get: () => conversation.topicId },
                        historyRef: { get: () => history, set: next => { history = next; } },
                        replaceHistory: next => { history = next; }
                    },
                    dispose: async () => {}
                };
            }
        }
    });
    try {
        await settle();
        const textarea = doc.querySelector('.side-chat-textarea');
        textarea.value = '继续';
        doc.querySelector('form').requestSubmit();
        await settle();
        await settle();
        assert.equal(textarea.value, '继续', 'the draft that failed to send is back in the composer');
    } finally {
        await handle.dispose();
        dom.window.close();
    }
});
