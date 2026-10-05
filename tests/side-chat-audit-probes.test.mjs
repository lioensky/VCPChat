import trustedSenderFixture from './helpers/trusted-main-sender.cjs';
const trusted = trustedSenderFixture.createTrustedMainSender();
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { defineChatTabType } from '../modules/ui-system/side-pane/tab-types/chat.js';
import { mountSideChatSurface, createSideChatSurfaceOwner } from '../modules/renderer/sideChatSurfaceOwner.js';
import { buildModelConfig } from '../modules/chat/singleChatRequestOrchestrator.js';
import * as service from '../modules/chat/sideChatSessionService.js';
import { captureSelectionReference } from '../modules/ui-system/side-pane/selection-reference.js';
import * as ipcModule from '../modules/ipc/sideChatHandlers.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

const createDescriptor = (id = 's1', child = 'child', agent = 'agent') => ({
    id,
    title: '侧聊',
    parent: { itemType: 'agent', itemId: agent, topicId: 'parent', name: 'Fixture Agent' },
    child: { itemType: 'agent', itemId: agent, topicId: child },
    contextMode: 'references-only',
    model: 'test-model'
});

function createMockController(provider = { mountTab: async () => ({ dispose: async () => {}, focus() {} }) }) {
    const dom = new JSDOM('<main class="main-content"></main><aside id="pane"><div id="tabs"></div><div id="content"><section class="side-pane-view" id="sidePaneViewNotifications"></section></div></aside>');
    const doc = dom.window.document;
    const ctrl = createSidePaneController({
        root: doc.getElementById('pane'),
        tabListElement: doc.getElementById('tabs'),
        contentContainer: doc.getElementById('content'),
        tabTypes: [defineChatTabType({ provider: provider })]
    });
    return { dom, doc, ctrl };
}

function createMockCapabilities(send = async () => ({ terminal: { event: { type: 'completed' } } })) {
    let selected;
    return {
        repository: {
            getHistory: async () => [],
            saveHistory: async () => ({ success: true })
        },
        createRenderer({ conversation }) {
            selected = conversation.selectedItem;
            return {
                renderer: { renderHistory: async () => {} },
                conversation: {
                    selectedItemRef: { get: () => selected },
                    topicIdRef: { get: () => conversation.topicId },
                    historyRef: { get: () => [], set() {} },
                    replaceHistory() {}
                },
                dispose: async () => {}
            };
        },
        manager: { sendMessage: send },
        getSelected: () => selected
    };
}

test('R01: Parent change deactivates old tab panel and hides non-visible tabs', async () => {
    const { dom, doc, ctrl } = createMockController();
    await ctrl.openTab({ kind: 'chat', descriptor: createDescriptor() });

    ctrl.setParent({ itemType: 'agent', itemId: 'agent', topicId: 'other-parent' });

    const visibleTabs = doc.querySelectorAll('[role="tab"][data-tab-id="s1"]');
    const panel = doc.querySelector('[role="tabpanel"][data-tab-id="s1"]');
    assert.equal(visibleTabs.length, 0, 'Tab s1 should not be visible under other-parent');
    assert.equal(panel.classList.contains('active'), false, 'Old chat panel should be deactivated');

    await ctrl.dispose();
    dom.window.close();
});

test('R02: Reopening same child activates existing view without duplicate panels or mounts', async () => {
    let mounts = 0;
    const { dom, doc, ctrl } = createMockController({
        mountTab: async () => {
            mounts++;
            return { dispose: async () => {}, focus() {} };
        }
    });

    await ctrl.openTab({ kind: 'chat', descriptor: createDescriptor('s1') });
    await ctrl.openTab({ kind: 'chat', descriptor: createDescriptor('s2') });

    const snapshot = ctrl.getSnapshot();
    const chatTabs = snapshot.tabs.filter(t => t.kind === 'chat');
    const panels = doc.querySelectorAll('[role="tabpanel"][data-tab-id]');

    assert.equal(chatTabs.length, 1, 'Should reuse existing tab for same child');
    assert.equal(mounts, 1, 'Should mount view only once');
    assert.equal(panels.length, 1, 'Should have only one tabpanel');
    assert.equal(snapshot.activeTabId, 's1', 'Should keep s1 as active tab');

    await ctrl.dispose();
    dom.window.close();
});

test('R03: Tab close during async mount disposes handle and removes panel without orphan state', async () => {
    let resolveMount;
    let disposed = 0;
    const { dom, doc, ctrl } = createMockController({
        mountTab: () => new Promise(r => { resolveMount = r; })
    });

    const pending = ctrl.openTab({ kind: 'chat', descriptor: createDescriptor() });
    await ctrl.closeTab('s1');
    resolveMount({ dispose: async () => { disposed++; }, focus() {} });
    await pending;

    assert.equal(ctrl.getSnapshot().tabs.some(t => t.id === 's1'), false, 'State should not contain closed tab');
    assert.equal(ctrl.getTabHandle('s1'), null, 'Handle should not be registered for closed tab');
    assert.equal(doc.querySelector('[data-tab-id="s1"]'), null, 'DOM panel should be removed');
    assert.equal(disposed, 1, 'Disposed handle callback should be called once');

    await ctrl.dispose();
    dom.window.close();
});

test('R04: Agent configuration is resolved and reference length/count quota is enforced', async () => {
    const dom = new JSDOM('<div id="mount"></div>');
    const caps = createMockCapabilities();
    const handle = await mountSideChatSurface(dom.window.document.getElementById('mount'), {
        descriptor: createDescriptor(),
        chatCapabilities: caps
    });
    await tick();

    // Single item exceeding 8000 limit must be rejected
    handle.addReference({ id: 'too-long', text: 'x'.repeat(8001) });
    assert.equal(handle.getReferences().length, 0, 'Single reference exceeding 8000 must be rejected');

    // Add references within single limit and verify total 16000 quota enforcement
    for (let i = 0; i < 9; i++) {
        handle.addReference({ id: 'r' + i, text: 'x'.repeat(7999) + i });
    }

    const selectedKeys = Object.keys(caps.getSelected());
    assert.ok(selectedKeys.includes('config'), 'selectedItem should include config');
    assert.ok(selectedKeys.includes('model'), 'selectedItem should include model');
    assert.ok(selectedKeys.includes('systemPrompt'), 'selectedItem should include systemPrompt');
    assert.ok(selectedKeys.includes('streamOutput'), 'selectedItem should include streamOutput');

    const effectiveConfig = buildModelConfig(caps.getSelected());
    assert.equal(effectiveConfig.model, 'test-model');
    assert.equal(effectiveConfig.stream, true);

    const refs = handle.getReferences();
    assert.equal(refs.length, 2, 'Should accept only references within total 16000 quota');
    assert.equal(refs.reduce((sum, r) => sum + r.text.length, 0), 16000, 'Quota limit enforces character max (2 * 8000)');

    await handle.dispose();
    dom.window.close();
});

test('R05: Transport failure restores draft & refs; persistence failure blocks close with unsaved state', async () => {
    // 1. Transport failure
    {
        const dom = new JSDOM('<div id="mount"></div>');
        const doc = dom.window.document;
        const caps = createMockCapabilities(async () => ({
            terminal: { event: { type: 'failed', outcome: { transport: { error: 'fixture-failure' } } } }
        }));
        const handle = await mountSideChatSurface(doc.getElementById('mount'), {
            descriptor: createDescriptor(),
            chatCapabilities: caps
        });
        await tick();

        handle.addReference({ id: 'ref', text: 'essential quoted context' });
        doc.querySelector('textarea').value = 'question';
        doc.querySelector('form').requestSubmit();
        await tick();
        await tick();

        assert.equal(handle.getReferences().length, 1, 'References should be restored on transport failure');
        assert.equal(doc.querySelector('textarea').value, 'question', 'Draft should be restored on transport failure');
        assert.ok(doc.querySelector('.side-chat-status-text').textContent.includes('发送失败'), 'Status should show failure');
        const closeResult = await handle.requestClose();
        assert.equal(closeResult.closed, true, 'Close permitted after transport failure when restored');

        await handle.dispose();
        dom.window.close();
    }

    // 2. Persistence failure
    {
        const dom = new JSDOM('<div id="mount"></div>');
        const doc = dom.window.document;
        const caps = createMockCapabilities(async () => ({
            terminal: { event: { type: 'failed', outcome: { persistence: { error: 'fixture-failure' } } } }
        }));
        const handle = await mountSideChatSurface(doc.getElementById('mount'), {
            descriptor: createDescriptor(),
            chatCapabilities: caps
        });
        await tick();

        handle.addReference({ id: 'ref', text: 'essential quoted context' });
        doc.querySelector('textarea').value = 'question';
        doc.querySelector('form').requestSubmit();
        await tick();
        await tick();

        assert.equal(doc.querySelector('.side-chat-status-text').textContent, '已生成但保存失败');
        const closeResult = await handle.requestClose();
        assert.equal(closeResult.closed, false, 'Close should be blocked on unsaved changes');
        assert.equal(closeResult.reason, 'UNSAVED_CHANGES');

        await handle.dispose();
        dom.window.close();
    }
});

test('R06: Reference added during active send is preserved across completion', async () => {
    let done;
    const dom = new JSDOM('<div id="mount"></div>');
    const doc = dom.window.document;
    const caps = createMockCapabilities(() => new Promise(resolve => { done = resolve; }));
    const handle = await mountSideChatSurface(doc.getElementById('mount'), {
        descriptor: createDescriptor(),
        chatCapabilities: caps
    });
    await tick();

    handle.addReference({ id: 'r1', text: 'first' });
    doc.querySelector('textarea').value = 'q';
    doc.querySelector('form').requestSubmit();

    // Add reference while request is in flight
    handle.addReference({ id: 'r2', text: 'added while sending' });

    done({ terminal: { event: { type: 'completed' } } });
    await tick();
    await tick();

    const remaining = handle.getReferences();
    assert.equal(remaining.length, 1, 'Should keep reference added during send');
    assert.equal(remaining[0].id, 'r2');
    assert.equal(remaining[0].text, 'added while sending');

    await handle.dispose();
    dom.window.close();
});

test('R07: Stable history filtering excludes isPendingStream, preserves tool_calls & attachments', async () => {
    const content = [{ type: 'text', text: 'initial' }];
    const raw = [
        { id: 'pending', role: 'assistant', content: 'partial', isPendingStream: true },
        { id: 'a', role: 'assistant', content: 'tool call', tool_calls: [{ id: 't' }] },
        { id: 't', role: 'tool', content: 'result', tool_call_id: 't' },
        { id: 'orphan_tool', role: 'tool', content: 'orphan without id' },
        { id: 'multi', role: 'user', content, attachments: [{ name: 'test.png' }] }
    ];

    const frozen = ipcModule.filterStableHistory(raw);
    content[0].text = 'mutated';

    const ids = frozen.map(m => m.id);
    assert.deepEqual(ids, ['a', 't', 'multi'], 'Pending streams and orphan tools should be excluded');
    assert.equal(Boolean(frozen.find(m => m.id === 'a').tool_calls), true, 'tool_calls should be retained');
    assert.equal(frozen.find(m => m.id === 'multi').content[0].text, 'initial', 'multimodal content should be deep-cloned');
    assert.equal(Boolean(frozen.find(m => m.id === 'multi').attachments), true, 'attachments should be retained');
});

test('R08: Service reports snapshot and IPC errors as ok:false', async () => {
    const res = await service.createParentSnapshot({
        electronAPI: {
            createSideChatSnapshot: async () => ({ success: false, error: 'disk failure' })
        },
        agentId: 'a',
        parentTopicId: 'p',
        fallbackHistory: []
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SNAPSHOT_FAILED');
    assert.equal(res.error, 'disk failure');

    const missingIpc = await service.saveSideChatMetadata({
        electronAPI: {},
        metadata: createDescriptor()
    });
    assert.equal(missingIpc.ok, false);
    assert.equal(missingIpc.code, 'UNSUPPORTED');
});

test('R09: Text selection outside authorized message is rejected', async () => {
    const dom = new JSDOM('<p id="outside">unrelated text</p>');
    const doc = dom.window.document;
    const range = doc.createRange();
    range.selectNodeContents(doc.getElementById('outside'));
    dom.window.getSelection().addRange(range);

    const result = captureSelectionReference(dom.window);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'OUTSIDE_MESSAGE');

    dom.window.close();
});

import os from 'node:os';

test('R10: Metadata includes snapshot & boundary; tab close does not delete snapshot file', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-side-chat-ipc-test-'));
    const handlers = new Map();
    ipcModule.initialize({
        USER_DATA_DIR: base, mainWindow: trusted.mainWindow,
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
        historyMutationQueue: { read: async () => [{ id: 'p1', role: 'user', content: 'parent fact' }] }
    });

    const call = (name, ...args) => handlers.get(name)(trusted.event, ...args);
    await fs.mkdir(path.join(base, 'agent/topics/child'), { recursive:true });
    await fs.writeFile(path.join(base, 'agent/topics/child/sidechat-child.json'), JSON.stringify({schemaVersion:1,ephemeral:true}));
    const snap = await call('side-chat:create-snapshot', 'agent', 'parent', 'child');
    const desc = {
        ...createDescriptor(),
        contextMode: 'parent-snapshot',
        snapshotId: snap.snapshotId,
        parentSnapshot: snap.messages
    };

    await call('side-chat:save-metadata', desc);
    const list = await call('side-chat:list-metadata', 'agent', 'parent');

    const snapshotPath = path.join(base, 'agent/topics/child/parent-snapshot.json');
    const existsBefore = Boolean(await fs.stat(snapshotPath).catch(() => null));
    assert.equal(existsBefore, true, 'Snapshot file should exist before deletion');

    assert.equal('parentSnapshot' in list.items[0], true, 'Listing should include parentSnapshot');
    assert.equal(Boolean(list.items[0].snapshotBoundary), true, 'Listing should include snapshotBoundary');

    await fs.rm(base, { recursive: true, force: true });
});

test('R11: Transport completion does not leave cancelled status', async () => {
    let done;
    const dom = new JSDOM('<div id="mount"></div>');
    const doc = dom.window.document;
    const caps = createMockCapabilities(() => new Promise(r => { done = r; }));
    const handle = await mountSideChatSurface(doc.getElementById('mount'), {
        descriptor: createDescriptor(),
        chatCapabilities: caps
    });
    await tick();

    doc.querySelector('textarea').value = 'q';
    doc.querySelector('form').requestSubmit();
    doc.querySelector('.side-chat-stop-btn').click();

    done(undefined);
    await tick();
    await tick();

    const statusText = doc.querySelector('.side-chat-status-text').textContent;
    assert.equal(statusText, '', 'Normal completion leaves no status text, like the main composer');
    assert.equal(doc.querySelector('.side-chat-stop-btn').hidden, true);
    assert.equal(doc.querySelector('.side-chat-send-btn').hidden, false);

    await handle.dispose();
    dom.window.close();
});

test('R12: Send-to-main blocks cross-topic contamination', async () => {
    const dom = new JSDOM('<textarea id="messageInput" data-current-topic="unrelated-topic"></textarea><div id="mount"></div>');
    const doc = dom.window.document;
    doc.getElementById('messageInput').value = 'unrelated draft';

    const handle = await mountSideChatSurface(doc.getElementById('mount'), {
        descriptor: createDescriptor(),
        chatCapabilities: createMockCapabilities()
    });
    await tick();

    const item = doc.createElement('div');
    item.className = 'message-item assistant';
    item.innerHTML = '<div class="md-content">side answer for parent</div>';
    doc.querySelector('.side-chat-messages-container').append(item);
    await tick();

    sendToMainFromMenu(doc);

    assert.equal(doc.getElementById('messageInput').value, 'unrelated draft', 'Should not overwrite draft in unrelated topic');

    await handle.dispose();
    dom.window.close();
});

function sendToMainFromMenu(doc) {
    const content = doc.querySelector('.side-chat-messages-container .message-item.assistant .md-content');
    content.dispatchEvent(new doc.defaultView.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    doc.querySelector('#chatContextMenu [data-side-chat-action="send-to-main"]').click();
}

test('R13: Persistence retry and explicit discard restore ready state', async () => {
    const dom = new JSDOM('<div id="mount"></div>');
    const doc = dom.window.document;
    let saveCount = 0;
    const caps = createMockCapabilities(async () => ({
        terminal: { event: { type: 'failed', outcome: { persistence: { error: 'write-failure' } } } }
    }));
    caps.repository.saveHistory = async () => {
        saveCount++;
        return { success: true };
    };

    const handle = await mountSideChatSurface(doc.getElementById('mount'), {
        descriptor: createDescriptor(),
        chatCapabilities: caps
    });
    await tick();

    doc.querySelector('textarea').value = 'save-me';
    doc.querySelector('form').requestSubmit();
    await tick();
    await tick();

    assert.equal(handle.getUnsavedStatus().hasUnsavedChanges, true);
    assert.equal(doc.querySelector('.side-chat-persistence-badge').hidden, false);

    // Retry persistence
    const retryRes = await handle.retryPersistence();
    assert.equal(retryRes.ok, true);
    assert.equal(handle.getUnsavedStatus().hasUnsavedChanges, false);
    assert.equal(doc.querySelector('.side-chat-persistence-badge').hidden, true);
    assert.equal(saveCount, 1);

    await handle.dispose();
    dom.window.close();
});

test('R14: Draft and uncommitted references preserved across tab close and reopen', async () => {
    const provider = createSideChatSurfaceOwner({
        chatCapabilities: {},
        mountSurface: async (view, { descriptor: desc }) => {
            let draft = '';
            const refs = [];
            return {
                descriptor: desc,
                getDraft: () => draft,
                setDraft: (d) => { draft = d; },
                getReferences: () => [...refs],
                addReference: (r) => { refs.push(r); },
                requestClose: async () => ({ closed: true }),
                dispose: async () => {}
            };
        }
    });
    const { dom, ctrl } = createMockController(provider);
    const desc = createDescriptor('tab-draft', 'topic-draft');

    const handle1 = await ctrl.openTab({ kind: 'chat', descriptor: desc });
    handle1.setDraft('preserved draft message');
    handle1.addReference({ id: 'r1', text: 'quoted draft ref' });

    const activeTabId = ctrl.getSnapshot().activeTabId;
    await ctrl.closeTab(activeTabId);

    // Reopen same child
    const handle2 = await ctrl.openTab({ kind: 'chat', descriptor: desc });
    assert.equal(handle2.getDraft(), 'preserved draft message');
    assert.equal(handle2.getReferences().length, 1);
    assert.equal(handle2.getReferences()[0].text, 'quoted draft ref');

    await ctrl.dispose();
    dom.window.close();
});

test('R15: Send-to-main validates both item ID and topic ID provenance', async () => {
    const dom = new JSDOM('<textarea id="messageInput" data-current-topic="parent"></textarea><div id="mount"></div>');
    const doc = dom.window.document;
    doc.getElementById('messageInput').value = 'existing main draft';

    let currentItemMock = { id: 'other-agent', type: 'agent' };
    const caps = createMockCapabilities();
    caps.getCurrentItem = () => currentItemMock;

    const handle = await mountSideChatSurface(doc.getElementById('mount'), {
        descriptor: createDescriptor('s1', 'c1', 'agent-correct'),
        chatCapabilities: caps
    });
    await tick();

    const item = doc.createElement('div');
    item.className = 'message-item assistant';
    item.innerHTML = '<div class="md-content">side answer</div>';
    doc.querySelector('.side-chat-messages-container').append(item);
    await tick();

    // 1. Same topic name but wrong agent -> blocked
    sendToMainFromMenu(doc);
    assert.equal(doc.getElementById('messageInput').value, 'existing main draft');

    // 2. Correct agent and correct topic -> allowed
    currentItemMock = { id: 'agent-correct', type: 'agent' };
    sendToMainFromMenu(doc);
    assert.equal(doc.getElementById('messageInput').value, 'existing main draft\n\nside answer');

    await handle.dispose();
    dom.window.close();
});
