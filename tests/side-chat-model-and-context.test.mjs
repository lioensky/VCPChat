import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

import { mountSideChatSurface } from '../modules/renderer/sideChatSurfaceOwner.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

const descriptor = (extra = {}) => ({
    id: 's1',
    title: '侧聊',
    parent: { itemType: 'agent', itemId: 'agent', topicId: 'parent', name: 'Agent' },
    child: { itemType: 'agent', itemId: 'agent', topicId: 'child' },
    contextMode: 'references-only',
    ...extra
});

function capabilities(overrides = {}) {
    const sent = [];
    return {
        sent,
        repository: { getHistory: async () => [], saveHistory: async () => ({ success: true }) },
        createRenderer({ conversation }) {
            return {
                renderer: { renderHistory: async () => {} },
                conversation: {
                    selectedItemRef: { get: () => conversation.selectedItem },
                    topicIdRef: { get: () => conversation.topicId },
                    historyRef: { get: () => [], set() {} },
                    replaceHistory() {}
                },
                dispose: async () => {}
            };
        },
        manager: {
            sendMessage: async (request) => {
                sent.push({ contextHistory: request.conversation.getContextHistory(), model: request.conversation.selectedItemRef.get().model });
                return { terminal: { event: { type: 'completed' } } };
            }
        },
        ...overrides
    };
}

async function mount(desc, caps) {
    const dom = new JSDOM('<div id="mount"></div>');
    const doc = dom.window.document;
    const handle = await mountSideChatSurface(doc.getElementById('mount'), { descriptor: desc, chatCapabilities: caps });
    await tick();
    return { dom, doc, handle };
}

const submit = async (doc, text) => {
    doc.querySelector('textarea').value = text;
    doc.querySelector('form').requestSubmit();
    await tick();
    await tick();
};

test('model picker lists the real model catalog instead of a built-in fake list', async () => {
    const caps = capabilities({
        listModels: async () => ({ ids: ['real-a', 'real-b', 'fav-c'], favorites: new Set(['fav-c']) })
    });
    const { doc, handle } = await mount(descriptor({ model: 'real-a' }), caps);

    assert.equal(doc.querySelector('.side-chat-model-name').textContent, 'real-a');
    doc.querySelector('.side-chat-model-picker-btn').click();
    await tick();

    const items = [...doc.querySelectorAll('.side-chat-model-item')].map(el => el.dataset.model);
    assert.deepEqual(items.sort(), ['fav-c', 'real-a', 'real-b']);
    assert.ok(!items.includes('gpt-4o'));

    doc.querySelector('.side-chat-model-item[data-model="real-b"]').click();
    assert.equal(handle.getModel(), 'real-b');
    await handle.dispose();
});

test('without any configured model the side chat does not invent one and refuses to send', async () => {
    const caps = capabilities();
    const { doc, handle } = await mount(descriptor(), caps);

    assert.equal(handle.getModel(), '');
    assert.equal(doc.querySelector('.side-chat-send-btn').disabled, true);
    await submit(doc, 'hello');
    assert.equal(caps.sent.length, 0);
    assert.match(doc.querySelector('.side-chat-status-text').textContent, /选择模型/);
    await handle.dispose();
});

test('model search filters the catalog', async () => {
    const caps = capabilities({
        listModels: async () => ({ ids: ['alpha-1', 'beta-2'], favorites: new Set() })
    });
    const { doc, handle } = await mount(descriptor({ model: 'alpha-1' }), caps);
    doc.querySelector('.side-chat-model-picker-btn').click();
    await tick();
    const search = doc.querySelector('.side-chat-model-search');
    search.value = 'beta';
    search.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
    assert.deepEqual([...doc.querySelectorAll('.side-chat-model-item')].map(el => el.dataset.model), ['beta-2']);
    await handle.dispose();
});

test('an unused parent-snapshot side chat re-captures the parent right before its first message', async () => {
    let calls = 0;
    const caps = capabilities({
        refreshParentSnapshot: async () => {
            calls++;
            return { ok: true, snapshotId: 'snap-2', messages: [{ role: 'user', content: '后来才出现的主聊消息' }] };
        }
    });
    const { doc, handle } = await mount(descriptor({ contextMode: 'parent-snapshot', parentSnapshot: [], model: 'm' }), caps);

    await submit(doc, 'q');

    assert.equal(calls, 1);
    assert.equal(caps.sent.length, 1);
    assert.deepEqual(caps.sent[0].contextHistory.map(m => m.content), ['后来才出现的主聊消息']);
    assert.equal(handle.descriptor.snapshotId, 'snap-2');
    await handle.dispose();
});

test('references-only mode never sends parent history and never refreshes the snapshot', async () => {
    let calls = 0;
    const caps = capabilities({ refreshParentSnapshot: async () => { calls++; return { ok: true, messages: [{ role: 'user', content: 'x' }] }; } });
    const { doc, handle } = await mount(descriptor({ model: 'm' }), caps);
    await submit(doc, 'q');
    assert.equal(calls, 0);
    assert.deepEqual(caps.sent[0].contextHistory, []);
    await handle.dispose();
});

test('a side conversation send does not touch the main topic unread state or item list', () => {
    const source = fs.readFileSync(new URL('../modules/chatManager.js', import.meta.url), 'utf8');
    assert.match(source, /const isSideConversation = !!request\?\.conversation;\s+if \(!isSideConversation\) try \{\s+const readResult = await electronAPI\.setTopicUnread\(/);
    assert.match(source, /if \(isSideConversation\) \{[^}]*\} else if \(itemListManager && typeof itemListManager\.refreshUnreadCounts/);
});

test('no hard-coded fallback model remains in the side chat stack', () => {
    for (const file of ['../modules/renderer/sideChatSurfaceOwner.js', '../modules/chat/sideChatSessionService.js']) {
        assert.ok(!/gpt-4o/.test(fs.readFileSync(new URL(file, import.meta.url), 'utf8')), `${file} must not hard-code gpt-4o`);
    }
});

test('new side chats are named by the lowest free ordinal under the same parent', () => {
    const source = fs.readFileSync(new URL('../modules/renderer/sideChatWiring.js', import.meta.url), 'utf8');
    assert.ok(source.includes(String.raw`/^辅助对话 (\d+)$/`));
    assert.ok(source.includes('`辅助对话 ${ordinal}`'));
});

test('draft and references are written to the side chat metadata so a reload can restore them', async () => {
    const saved = [];
    const caps = capabilities({ saveSideChatMetadata: async (meta) => { saved.push(meta); return { success: true }; } });
    const { dom, doc, handle } = await mount(descriptor({ model: 'm' }), caps);
    const textarea = doc.querySelector('textarea');

    textarea.value = '草稿';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    handle.addReference({ id: 'r1', text: '引用原文', sourceMessageId: 'msg-1' });
    assert.equal(saved.length, 0, 'typing is debounced');
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].draft, '草稿');
    assert.deepEqual(saved[0].references, [{ id: 'r1', text: '引用原文', sourceMessageId: 'msg-1' }]);

    // 页面卸载前未到时间的改动立即写入
    handle.removeReference('r1');
    textarea.value = '';
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    assert.equal(saved.length, 2);
    assert.equal(saved[1].draft, '');
    assert.deepEqual(saved[1].references, []);
    await handle.dispose();
});
