import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { mountSideChatSurface } from '../modules/renderer/sideChatSurfaceOwner.js';
import { createSideChatDraftStore } from '../modules/renderer/side-chat/draft-store.js';
import { listSideChatModels } from '../modules/renderer/sideChatWiring.js';

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
    const dom = new JSDOM('<div id="mount"></div>', { url: 'https://side-chat.test' });
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

// 侧聊发送不碰主话题未读：行为测试在 chat-manager-selection-race.test.js；没配置模型时拒绝发送见上面的测试

test('new side chats are named by the lowest free ordinal under the same parent', async () => {
    const { createSideChatWiring } = await import('../modules/renderer/sideChatWiring.js');
    const dom = new JSDOM('<!doctype html><body></body>');
    const parent = { itemType: 'agent', itemId: 'agent', topicId: 'parent' };
    const tab = (title, topicId = 'parent') => ({ id: title, kind: 'chat', title, descriptor: { parent: { ...parent, topicId } } });
    const opened = [];
    const controller = {
        getSnapshot: () => ({ parent, activeTabId: null,
            tabs: [tab('辅助对话 1'), tab('辅助对话 3'), tab('辅助对话 2', 'other-topic')] }),
        async openTab(raw) { opened.push(raw.descriptor.title); return null; },
        setVisible() {}
    };
    let children = 0;
    const chatAPI = {
        createSideChatChild: async () => ({ success: true, topicId: `child-${++children}` }),
        saveSideChatMetadata: async metadata => ({ success: true, metadata })
    };
    const wiring = createSideChatWiring({
        doc: dom.window.document, win: dom.window, chatAPI, chatRepository: null, chatManager: null, uiHelper: null,
        createRenderer: () => null,
        selectedItemRef: { get: () => ({ id: 'agent', type: 'agent', name: 'Agent', config: { model: 'm' } }) },
        topicIdRef: { get: () => 'parent' }, historyRef: { get: () => [] }, getController: () => controller
    });
    try {
        await dom.window.openSideChatWithSelection({ selectedText: '一段引用' });
        assert.deepEqual(opened, ['辅助对话 2'], 'the menu entry opens a side chat with the first free number of this topic');
    } finally {
        wiring.dispose?.();
        dom.window.close();
    }
});

test('composer autosaves go to browser storage; metadata only migrates once', async () => {
    const saved = [];
    const caps = capabilities({ saveSideChatMetadata: async (meta) => { saved.push(meta); return { success: true }; } });
    const { dom, doc, handle } = await mount(descriptor({ model: 'm' }), caps);
    const textarea = doc.querySelector('textarea');
    const drafts = createSideChatDraftStore({ getStorage: () => dom.window.localStorage });

    textarea.value = '草稿';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    handle.addReference({ id: 'r1', text: '引用原文', sourceMessageId: 'msg-1' });
    assert.equal(saved.length, 0, 'typing is debounced');
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].draft, undefined);
    assert.equal(saved[0].references, undefined);
    assert.equal(saved[0].composerStorage, 'local');
    assert.equal(drafts.read(handle.descriptor).input.draft, '草稿');
    assert.deepEqual(drafts.read(handle.descriptor).input.references, [{ id: 'r1', text: '引用原文', sourceMessageId: 'msg-1' }]);

    // 页面卸载前未到时间的改动立即写入
    handle.removeReference('r1');
    textarea.value = '';
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    assert.equal(saved.length, 1);
    assert.equal(drafts.read(handle.descriptor).input.draft, '');
    assert.deepEqual(drafts.read(handle.descriptor).input.references, []);
    await handle.dispose();
});

test('an empty model cache waits for the real refresh result instead of a fixed delay', async () => {
    let finishRefresh;
    const calls = [];
    const api = {
        getCachedModels: async () => { calls.push('cache'); return []; },
        getFavoriteModels: async () => ['b'],
        refreshModels: () => { calls.push('refresh'); return new Promise(resolve => { finishRefresh = resolve; }); }
    };
    let settled = false;
    const pending = listSideChatModels(api).then(value => { settled = true; return value; });
    // 再次打开模型菜单时共用同一次刷新
    const second = listSideChatModels(api);
    await tick();
    assert.deepEqual(calls, ['cache', 'cache', 'refresh']);
    assert.equal(settled, false, 'still waiting for the refresh');
    finishRefresh({ success: true, models: [{ id: 'a' }, 'b'] });
    const result = await pending;
    assert.deepEqual(result.ids, ['a', 'b']);
    assert.deepEqual([...result.favorites], ['b']);
    assert.deepEqual((await second).ids, ['a', 'b']);
    assert.deepEqual(calls, ['cache', 'cache', 'refresh'], 'the refresh result is used directly, no second cache read');

    // 缓存里已经有模型时不触发刷新
    const warm = await listSideChatModels({ getCachedModels: async () => ['x'], refreshModels: () => assert.fail('no refresh') });
    assert.deepEqual(warm.ids, ['x']);
});

test('a failed or hung model refresh falls back to the cache instead of failing or spinning forever', async () => {
    let cache = [];
    const failing = await listSideChatModels({
        getCachedModels: async () => cache,
        refreshModels: async () => { cache = ['late']; throw new Error('server unreachable'); }
    });
    assert.deepEqual(failing.ids, ['late']);

    const hung = await listSideChatModels({
        getCachedModels: async () => [],
        refreshModels: () => new Promise(() => {})
    }, { timeoutMs: 20 });
    assert.deepEqual(hung.ids, []);
});
