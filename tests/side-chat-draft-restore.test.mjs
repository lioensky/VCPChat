import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import trustedSenderFixture from './helpers/trusted-main-sender.cjs';
import { initialize } from '../modules/ipc/sideChatHandlers.js';
import { createSideChatWiring } from '../modules/renderer/sideChatWiring.js';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { defineChatTabType } from '../modules/ui-system/side-pane/tab-types/chat.js';
import { createSideChatDescriptor } from '../modules/chat/sideChatSessionService.js';
import { createSideChatDraftStore, sideChatDraftKey } from '../modules/renderer/side-chat/draft-store.js';

async function fixture(t, legacyInput = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-side-draft-restore-'));
    const trusted = trustedSenderFixture.createTrustedMainSender(), handlers = new Map();
    initialize({ USER_DATA_DIR: directory, mainWindow: trusted.mainWindow,
        ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) } });
    const call = (channel, ...args) => handlers.get(channel)(trusted.event, ...args);
    const child = await call('side-chat:create-child', 'agent');
    const descriptor = { ...createSideChatDescriptor({ parent: { itemId: 'agent', topicId: 'parent' }, childTopicId: child.topicId }), ...legacyInput };
    assert.equal((await call('side-chat:save-metadata', descriptor)).success, true);
    const childDir = path.join(directory, 'agent', 'topics', child.topicId);
    const dom = new JSDOM('<aside id="pane"><div id="tabs"></div><div id="content"></div></aside>', { url: 'https://side-chat.test' });
    const doc = dom.window.document, drafts = createSideChatDraftStore({ getStorage: () => dom.window.localStorage });
    const deletions = [], sessions = [], metadataWrites = [];
    const chatAPI = {
        listSideChatMetadata: (...args) => call('side-chat:list-metadata', ...args),
        saveSideChatMetadata: (...args) => {
            const promise = call('side-chat:save-metadata', ...args);
            metadataWrites.push(promise);
            return promise;
        },
        async deleteSideChatChild(...args) { deletions.push(args); return call('side-chat:delete-child', ...args); },
        getChatHistory: async (_agent, topic) => JSON.parse(await fs.readFile(path.join(directory, 'agent', 'topics', topic, 'history.json'), 'utf8'))
    };
    function mountController({ dormancy = null } = {}) {
        let controller;
        const wiring = createSideChatWiring({ doc, win: dom.window, chatAPI,
            chatRepository: { getHistory: (agent, _type, topic) => chatAPI.getChatHistory(agent, topic), saveHistory: async () => ({ success: true }) },
            chatManager: { sendMessage() { throw new Error('No generation during restoration'); } }, uiHelper: {},
            selectedItemRef: { get: () => ({ id: 'agent', type: 'agent', config: { model: 'default-model' } }) },
            topicIdRef: { get: () => 'parent' }, historyRef: { get: () => [] }, getController: () => controller,
            createRenderer({ conversation }) {
                let history = [];
                return { renderer: { renderHistory: async () => {} }, dispose: async () => {},
                    conversation: { selectedItemRef: { get: () => conversation.selectedItem }, topicIdRef: { get: () => conversation.topicId },
                        historyRef: { get: () => history, set: value => { history = value; } }, replaceHistory: value => { history = value; } } };
            }
        });
        controller = createSidePaneController({ root: doc.getElementById('pane'), tabListElement: doc.getElementById('tabs'),
            contentContainer: doc.getElementById('content'), dormancy,
            tabTypes: [defineChatTabType({ provider: wiring.provider, onClosed: wiring.onTabClosed })] });
        controller.setParent(descriptor.parent);
        const session = { controller, wiring };
        sessions.push(session);
        return session;
    }
    t.after(async () => {
        for (const session of sessions) { await session.controller.dispose(); session.wiring.dispose(); }
        await Promise.all(metadataWrites);
        dom.window.close();
        assert.ok(directory.startsWith(os.tmpdir() + path.sep));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { dom, doc, drafts, descriptor, childDir, deletions, mountController,
        settleMetadata: () => Promise.all(metadataWrites),
        metadata: async () => JSON.parse(await fs.readFile(path.join(childDir, 'sidechat-metadata.json'), 'utf8')) };
}

test('empty-history side chats restore browser drafts, references and models through the real controller, then explicit close clears storage', async t => {
    const f = await fixture(t, { composerStorage: 'local' });
    f.drafts.save(f.descriptor, { draft: 'my unsent question', model: 'chosen-model', references: [{ id: 'ref', text: 'selected text' }] });
    const { controller, wiring } = f.mountController();
    await wiring.restoreSessions('agent', 'parent');
    assert.equal(f.deletions.length, 0);
    const tab = controller.getSnapshot().tabs.find(item => item.kind === 'chat');
    assert.ok(tab);
    const handle = controller.getTabHandle(tab.id);
    assert.equal(handle.getDraft(), 'my unsent question');
    assert.equal(handle.getModel(), 'chosen-model');
    assert.equal(handle.getReferences()[0].text, 'selected text');
    await controller.closeTab(tab.id);
    assert.equal(f.drafts.read(f.descriptor).input, null);
    await assert.rejects(fs.stat(f.childDir), { code: 'ENOENT' });
});

test('legacy file input survives descriptor normalization and migrates only after the browser save; clearing it never revives old input', async t => {
    const f = await fixture(t, { draft: 'legacy draft', references: [{ id: 'legacy-ref', text: 'legacy selection' }], model: 'legacy-model' });
    let session = f.mountController();
    await session.wiring.restoreSessions('agent', 'parent');
    const tab = session.controller.getSnapshot().tabs.find(item => item.kind === 'chat');
    const handle = session.controller.getTabHandle(tab.id);
    assert.equal(handle.getDraft(), 'legacy draft');
    assert.equal(handle.getReferences().length, 1);
    assert.equal(handle.getModel(), 'legacy-model');
    handle.setDraft('new draft');
    f.dom.window.dispatchEvent(new f.dom.window.Event('blur'));
    await f.settleMetadata();
    await session.controller.dispose(); session.wiring.dispose();
    assert.equal(f.drafts.read(f.descriptor).input.draft, 'new draft');
    assert.equal((await f.metadata()).composerStorage, 'local');
    assert.equal((await f.metadata()).draft, undefined);
    session = f.mountController(); await session.wiring.restoreSessions('agent', 'parent');
    const restoredTab = session.controller.getSnapshot().tabs.find(item => item.kind === 'chat');
    const restored = session.controller.getTabHandle(restoredTab.id);
    assert.equal(restored.getDraft(), 'new draft');
    restored.setDraft(''); restored.removeReference('legacy-ref');
    f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'));
    assert.equal(f.drafts.read(f.descriptor).input.draft, '');
    assert.deepEqual(f.drafts.read(f.descriptor).input.references, []);
});

test('unreadable browser drafts cannot authorize automatic deletion of an empty-history child', async t => {
    const f = await fixture(t, { composerStorage: 'local' });
    f.dom.window.localStorage.setItem(sideChatDraftKey(f.descriptor), '{invalid JSON');
    const { controller, wiring } = f.mountController();
    await wiring.restoreSessions('agent', 'parent');
    assert.equal(f.deletions.length, 0);
    assert.ok(controller.getSnapshot().tabs.some(item => item.kind === 'chat'));
    assert.ok((await fs.stat(f.childDir)).isDirectory());
});

test('automatic empty-child cleanup also removes its empty browser draft without reviving legacy file input', async t => {
    const f = await fixture(t, { draft: 'old file input that the user cleared' });
    f.drafts.save(f.descriptor, { draft: '', references: [], model: 'chosen-model' });
    const { controller, wiring } = f.mountController();
    await wiring.restoreSessions('agent', 'parent');
    assert.equal(controller.getSnapshot().tabs.some(item => item.kind === 'chat'), false);
    await assert.rejects(fs.stat(f.childDir), { code: 'ENOENT' });
    assert.equal(f.drafts.read(f.descriptor).input, null);
    assert.equal(f.deletions.length, 1);
});

test('a side chat put to sleep behind another tab keeps its draft, and a reference asked while it remounts lands in it', async t => {
    const f = await fixture(t, { composerStorage: 'local' });
    f.drafts.save(f.descriptor, { draft: 'half typed', references: [{ id: 'ref-1', text: 'first selection' }] });
    const { controller, wiring } = f.mountController({ dormancy: { hiddenMs: 30 } });
    controller.registerTabType({ kind: 'note', label: 'Note', provider: { mountTab: () => ({ dispose() {} }) } });
    await wiring.restoreSessions('agent', 'parent');
    const tab = controller.getSnapshot().tabs.find(item => item.kind === 'chat');
    controller.activateTab(tab.id);
    controller.setVisible(true);
    await new Promise(r => setTimeout(r, 20));
    controller.getTabHandle(tab.id).setDraft('half typed, then more');
    await controller.openTab({ id: 'note:1', kind: 'note', title: 'Note', closable: true, scopeMode: 'global' });
    await new Promise(r => setTimeout(r, 120));
    assert.equal(controller.getTabHandle(tab.id), null, 'the hidden side chat view went to sleep');
    assert.deepEqual(controller.getViewResidency().dormant.map(entry => entry.tabId), [tab.id]);

    // 切回去的同一刻点「在侧栏提问」：视图还在重挂，引用要落进这个侧聊，不能另开一个
    controller.activateTab(tab.id);
    const handle = await wiring.openSideChat({ reference: { id: 'ref-2', text: 'second selection' } });
    assert.deepEqual(controller.getSnapshot().tabs.filter(item => item.kind === 'chat').map(item => item.id), [tab.id], 'no second side chat');
    assert.equal(handle, controller.getTabHandle(tab.id));
    assert.equal(handle.getDraft(), 'half typed, then more');
    assert.deepEqual(handle.getReferences().map(ref => ref.id), ['ref-1', 'ref-2']);
});

// 休眠场景：休眠/唤醒、切话题、退出都不能丢草稿、引用和模型
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function sleepableSideChat(t, opts = {}) {
    const f = await fixture(t, { composerStorage: 'local' });
    f.drafts.save(f.descriptor, { draft: 'start', references: [{ id: 'ref-1', text: 'first selection' }], model: 'm0' });
    const s = f.mountController({ dormancy: { hiddenMs: 30, ...(opts.dormancy || {}) } });
    s.controller.registerTabType({ kind: 'note', label: 'Note', provider: { mountTab: () => ({ dispose() {} }) } });
    await s.wiring.restoreSessions('agent', 'parent');
    const tab = s.controller.getSnapshot().tabs.find(item => item.kind === 'chat');
    s.controller.activateTab(tab.id); s.controller.setVisible(true);
    await sleep(20);
    const hide = async () => { await s.controller.openTab({ id: 'note:' + Math.random(), kind: 'note', title: 'Note', closable: true, scopeMode: 'global' }); await sleep(120); };
    const wake = async () => { s.controller.activateTab(tab.id); for (let i = 0; i < 50 && !s.controller.getTabHandle(tab.id); i++) await sleep(5); await sleep(20); return s.controller.getTabHandle(tab.id); };
    return { f, s, tab, hide, wake, handle: () => s.controller.getTabHandle(tab.id) };
}

test('a model picked in a side chat survives sleep', async t => {
    const p = await sleepableSideChat(t);
    p.handle().setModel('m-new');
    await p.hide();
    assert.equal(p.handle(), null);
    const h = await p.wake();
    assert.equal(h.getModel(), 'm-new');
});

test('a draft typed inside the save debounce survives sleep and reaches storage', async t => {
    const p = await sleepableSideChat(t);
    const ta = p.f.doc.querySelector('.side-chat-textarea');
    ta.value = 'typed fast'; ta.dispatchEvent(new p.f.dom.window.Event('input', { bubbles: true }));
    await p.hide();
    assert.equal(p.handle(), null);
    assert.equal(p.f.drafts.read(p.f.descriptor).input.draft, 'typed fast');
    const h = await p.wake();
    assert.equal(h.getDraft(), 'typed fast');
});

test('sleep keeps the latest draft, removed references and model even when localStorage writes fail', async t => {
    const p = await sleepableSideChat(t);
    const proto = Object.getPrototypeOf(p.f.dom.window.localStorage);
    const orig = proto.setItem; proto.setItem = function () { throw new Error('QuotaExceeded'); };
    try {
        p.handle().setDraft('new text'); p.handle().removeReference('ref-1'); p.handle().setModel('m-new');
        await p.hide();
        const h = await p.wake();
        assert.equal(h.getDraft(), 'new text');
        assert.deepEqual(h.getReferences(), [], 'removed reference must not come back');
        assert.equal(h.getModel(), 'm-new');
    } finally { proto.setItem = orig; }
});

test('quitting while a side chat is dormant restores its latest draft on relaunch', async t => {
    const p = await sleepableSideChat(t);
    p.handle().setDraft('before quit');
    await p.hide();
    p.f.dom.window.dispatchEvent(new p.f.dom.window.Event('pagehide'));
    await p.s.controller.dispose(); p.s.wiring.dispose();
    const s2 = p.f.mountController();
    await s2.wiring.restoreSessions('agent', 'parent');
    const tab = s2.controller.getSnapshot().tabs.find(item => item.kind === 'chat');
    assert.equal(s2.controller.getTabHandle(tab.id).getDraft(), 'before quit');
    assert.equal(s2.controller.getTabHandle(tab.id).getModel(), 'm0');
});

test('a side chat that sleeps after a topic switch keeps its draft when the topic comes back', async t => {
    const p = await sleepableSideChat(t, { dormancy: { otherTopicMs: 30 } });
    p.handle().setDraft('topic draft');
    p.s.controller.setParent({ ...p.f.descriptor.parent, topicId: 'other' });
    await sleep(150);
    assert.equal(p.handle(), null, 'slept after leaving the topic');
    p.s.controller.setParent(p.f.descriptor.parent);
    for (let i = 0; i < 50 && !p.handle(); i++) await sleep(5);
    await sleep(20);
    assert.equal(p.handle()?.getDraft(), 'topic draft');
});
