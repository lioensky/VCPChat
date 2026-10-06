import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import trustedSenderFixture from './helpers/trusted-main-sender.cjs';
import { initialize } from '../modules/ipc/sideChatHandlers.js';
import { saveSideChatMetadata } from '../modules/chat/sideChatSessionService.js';
import { createSideChatPersistence } from '../modules/renderer/side-chat/persistence.js';
import { createSideChatDraftStore } from '../modules/renderer/side-chat/draft-store.js';

async function waitFor(predicate) {
    const deadline = Date.now() + 2000;
    while (!await predicate()) {
        if (Date.now() > deadline) throw new Error('Draft save did not settle');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-side-draft-'));
    const topicDir = path.join(directory, 'agent', 'topics', 'child');
    await fs.mkdir(topicDir, { recursive: true });
    await fs.writeFile(path.join(topicDir, 'sidechat-child.json'), JSON.stringify({ schemaVersion: 1, ephemeral: true }));
    const metadataPath = path.join(topicDir, 'sidechat-metadata.json'), backup = metadataPath + '.backup';
    const historyPath = path.join(topicDir, 'history.json');
    const history = [{ id: 'saved', role: 'user', content: 'saved history is independent' }];
    await fs.writeFile(historyPath, JSON.stringify(history));
    const descriptor = { id: 'side', parent: { itemId: 'agent', topicId: 'parent' },
        child: { itemId: 'agent', topicId: 'child' }, contextMode: 'references-only', draft: 'old draft', references: [] };
    await fs.writeFile(metadataPath, JSON.stringify(descriptor));
    const trusted = trustedSenderFixture.createTrustedMainSender();
    const handlers = new Map();
    initialize({ USER_DATA_DIR: directory, mainWindow: trusted.mainWindow,
        ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) } });
    const dom = new JSDOM('<textarea></textarea><span id="status"></span><button id="badge" hidden></button>', { url: 'https://side-chat.test', storageQuota: 2048 });
    const drafts = createSideChatDraftStore({ getStorage: () => dom.window.localStorage });
    const doc = dom.window.document, textarea = doc.querySelector('textarea'), status = doc.getElementById('status');
    textarea.value = descriptor.draft;
    const store = { currentDescriptor: descriptor, currentModel: 'model', references: [], isHistoryLoaded: true, isDisposed: false };
    const toasts = [];
    let saveOverride, settled = 0;
    const owner = createSideChatPersistence({ store, descriptor, doc, textarea, statusText: status,
        persistenceBadge: doc.getElementById('badge'), repository: {}, getConversation: () => null,
        getSurface: () => { throw new Error('Metadata retry must not reload history'); },
        saveDraft: (metadata, input) => drafts.save(metadata, input),
        updateStatus(text, type) { status.textContent = type === 'error' ? text : ''; },
        updateComposerState() {}, updateEmptyState() {},
        chatCapabilities: {
            uiHelper: { showToastNotification: (message, type) => toasts.push({ message, type }) },
            saveSideChatMetadata: async metadata => {
                try {
                    return saveOverride ? await saveOverride(metadata) : await saveSideChatMetadata({ metadata,
                        electronAPI: { saveSideChatMetadata: value => handlers.get('side-chat:save-metadata')(trusted.event, value) } });
                } finally { settled++; }
            },
        },
    });
    let blocked = false;
    async function repair() {
        if (!blocked) return;
        await fs.rmdir(metadataPath); await fs.rename(backup, metadataPath); blocked = false;
    }
    t.after(async () => {
        await repair(); owner.dispose(); dom.window.close();
        assert.deepEqual(JSON.parse(await fs.readFile(historyPath, 'utf8')), history);
        assert.ok(directory.startsWith(os.tmpdir() + path.sep));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { owner, store, status, textarea, toasts, dom, repair, drafts, descriptor,
        get settled() { return settled; },
        read: async () => JSON.parse(await fs.readFile(metadataPath, 'utf8')),
        setSave(fn) { saveOverride = fn; },
        async block() { await fs.rename(metadataPath, backup); await fs.mkdir(metadataPath); blocked = true; },
        type(text) { textarea.value = text; textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true })); },
    };
}

test('a real side metadata write failure is visible and retry saves the current draft, references and model', async t => {
    const f = await fixture(t);
    await f.block(); const before = f.settled;
    f.type('my unsent work'); await f.owner.flushInputSave();
    await waitFor(() => f.settled > before);
    assert.match(f.status.textContent, /未保存.*重试/);
    assert.equal(f.status.getAttribute('role'), 'button');
    assert.equal(f.status.tabIndex, 0);
    assert.equal(f.textarea.value, 'my unsent work');
    assert.equal(f.toasts.length, 1);
    assert.equal(f.toasts[0].type, 'error');
    assert.doesNotMatch(f.toasts[0].message, /EISDIR|sidechat-metadata\.json/);
    await f.repair(); assert.equal((await f.read()).draft, 'old draft');
    f.type('my newest unsent work');
    f.store.references = [{ id: 'ref', text: 'keep this selection', sourceMessageId: 'saved' }];
    f.store.currentModel = 'new-model';
    f.status.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await waitFor(() => f.status.textContent === '' && f.settled >= 2);
    const persisted = await f.read();
    assert.equal(persisted.composerStorage, 'local');
    assert.equal(persisted.draft, undefined);
    assert.equal(persisted.model, undefined);
    assert.equal(persisted.references, undefined);
    assert.deepEqual(f.drafts.read(f.descriptor).input, { draft: 'my newest unsent work', model: 'new-model', references: f.store.references });
    assert.equal(persisted.child.topicId, 'child');
    await f.owner.flushInputSave();
    assert.equal(f.status.getAttribute('role'), null);
});

test('metadata failure results and thrown errors stay retryable without clearing an independent chat error', async t => {
    const f = await fixture(t);
    f.setSave(() => ({ success: false, error: 'permission denied' }));
    await assert.rejects(f.owner.persistMetadata(), /permission denied/);
    f.setSave(() => { throw new Error('connection lost'); });
    await assert.rejects(f.owner.persistMetadata(), /connection lost/);
    assert.equal(f.toasts.length, 1, 'Repeated failed autosaves must not flood notifications');
    assert.match(f.status.textContent, /重试/);
    f.status.textContent = '发送失败：服务端拒绝';
    f.setSave(() => ({ success: true }));
    await f.owner.persistMetadata();
    assert.equal(f.status.textContent, '发送失败：服务端拒绝');
    assert.equal(f.textarea.value, 'old draft');
});

test('pagehide flush saves an intentionally empty side draft and removes old references', async t => {
    const f = await fixture(t);
    f.store.references = [{ id: 'old', text: 'old selection' }];
    f.type('draft with selection'); await f.owner.flushInputSave();
    assert.equal(f.drafts.read(f.descriptor).input.references.length, 1);
    f.store.references = []; f.type('');
    f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'));
    assert.equal(f.drafts.read(f.descriptor).input.draft, '');
    assert.deepEqual(f.drafts.read(f.descriptor).input.references, []);
    assert.equal(f.status.textContent, '');
    assert.equal(f.toasts.length, 0);
});

test('browser quota failure retains input and the old file draft; retry saves current input without further IPC autosaves', async t => {
    const f = await fixture(t);
    f.type('x'.repeat(4096)); await f.owner.flushInputSave();
    assert.equal(f.textarea.value.length, 4096);
    assert.match(f.status.textContent, /未保存.*重试/);
    assert.equal(f.toasts.length, 1);
    assert.equal(f.settled, 0, 'Do not clear the legacy file when browser storage failed');
    assert.equal((await f.read()).draft, 'old draft');
    f.type('new input that fits');
    f.status.click(); await waitFor(() => f.status.textContent === '' && f.settled > 0);
    assert.equal(f.drafts.read(f.descriptor).input.draft, 'new input that fits');
    const migrationCalls = f.settled;
    f.type('another edit'); await f.owner.flushInputSave();
    assert.equal(f.settled, migrationCalls, 'Typing after migration must never write metadata');
    assert.equal(f.drafts.read(f.descriptor).input.draft, 'another edit');
});

test('browser draft scopes distinguish parents and children and preserve an explicit empty draft over old file content', async t => {
    const f = await fixture(t), a = f.descriptor;
    const b = { ...a, child: { ...a.child, topicId: 'other-child' } };
    const c = { ...a, parent: { ...a.parent, topicId: 'other-parent' } };
    assert.equal(f.drafts.save(a, { draft: 'child A' }).ok, true);
    assert.equal(f.drafts.save(b, { draft: 'child B' }).ok, true);
    assert.equal(f.drafts.read(c).input, null);
    f.drafts.save(a, { draft: '', references: [], model: 'model' });
    assert.equal(f.drafts.read(a).input.draft, '');
    assert.equal(f.drafts.read(b).input.draft, 'child B');
    f.drafts.remove(a);
    assert.equal(f.drafts.read(a).input, null);
    assert.equal(f.drafts.read(b).input.draft, 'child B');
});
