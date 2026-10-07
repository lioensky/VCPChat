import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import queueModule from '../modules/services/historyMutationQueue.js';
import { mountSideChatSurface } from '../modules/renderer/sideChatSurfaceOwner.js';

async function waitFor(predicate) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Side delete did not settle');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-side-delete-'));
    const queue = new queueModule.HistoryMutationQueue({ userDataDir: directory });
    const child = { itemId: 'agent', itemType: 'agent', topicId: 'child' };
    const parent = { ...child, topicId: 'parent' };
    const initial = [{ id: 'question', role: 'user', content: 'question' },
        { id: 'answer', role: 'assistant', content: 'saved answer' }];
    const parentHistory = [{ id: 'parent', role: 'user', content: 'parent stays unchanged' }];
    await queue.replace(child, initial);
    await queue.replace(parent, parentHistory);
    const historyPath = queue.getHistoryPath(child.itemId, child.topicId);
    const backup = historyPath + '.backup';
    let blocked = false, gate, saveResult, history = [], sends = 0;
    const toasts = [], removals = [], writes = [], confirms = [];
    let confirmAnswer = true;
    const dom = new JSDOM('<div id="mount"></div>');
    const doc = dom.window.document;
    const repository = {
        getHistory: () => queue.read(child),
        async saveHistory(itemId, itemType, topicId, next) {
            writes.push({ itemId, itemType, topicId, next });
            if (gate) await gate;
            if (saveResult) return saveResult;
            return queue.replace({ itemId, itemType, topicId }, next);
        },
    };
    const handle = await mountSideChatSurface(doc.getElementById('mount'), {
        descriptor: { id: 'side', model: 'model', contextMode: 'references-only',
            parent: { itemId: 'agent', topicId: 'parent' }, child: { itemId: 'agent', topicId: 'child' } },
        chatCapabilities: {
            repository,
            uiHelper: { showConfirmDialog: async message => { confirms.push(message); return confirmAnswer; },
                showToastNotification: (message, type) => toasts.push({ message, type }) },
            manager: { sendMessage() { sends++; throw new Error('Unexpected generation'); } },
            createRenderer({ root: list, conversation }) {
                const renderHistory = async messages => {
                    list.querySelectorAll('.message-item').forEach(item => item.remove());
                    for (const message of messages) {
                        const item = doc.createElement('div');
                        item.className = `message-item ${message.role}`;
                        item.dataset.messageId = message.id;
                        const content = doc.createElement('div');
                        content.className = 'md-content'; content.textContent = message.content;
                        item.append(content); list.append(item);
                    }
                };
                return { renderer: {
                    renderHistory,
                    removeMessageById(id, persist) {
                        // Match the production renderer's synchronous removal and optional background save.
                        history = history.filter(message => message.id !== id);
                        list.querySelector(`[data-message-id="${id}"]`)?.remove();
                        removals.push({ id, persist });
                        if (persist) void repository.saveHistory('agent', 'agent', 'child', history).catch(() => {});
                    },
                }, conversation: {
                    selectedItemRef: { get: () => conversation.selectedItem },
                    topicIdRef: { get: () => conversation.topicId },
                    historyRef: { get: () => history, set: next => { history = next; } },
                    replaceHistory: next => { history = next; },
                }, dispose() {} };
            },
        },
    });
    async function repair() {
        if (!blocked) return;
        await fs.rmdir(historyPath);
        await fs.rename(backup, historyPath);
        blocked = false;
    }
    t.after(async () => {
        await repair(); await handle.dispose(); dom.window.close(); await queue.dispose();
        assert.deepEqual(await queue.read(parent), parentHistory);
        assert.ok(directory.startsWith(os.tmpdir() + path.sep));
        await fs.rm(directory, { recursive: true, force: true });
    });
    await waitFor(() => doc.querySelector('[data-message-id="answer"]') && !doc.querySelector('.side-chat-textarea').disabled);
    function menu(id) {
        doc.querySelector(`[data-message-id="${id}"] .md-content`).dispatchEvent(
            new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    }
    function remove(id) { menu(id); doc.querySelector('[data-side-chat-action="delete"]').click(); }
    return { doc, handle, initial, toasts, writes, removals, menu, remove, repair, confirms,
        answerConfirm: answer => { confirmAnswer = answer; },
        history: () => history, read: () => queue.read(child), sends: () => sends,
        failWithResult(result) { saveResult = result; },
        holdSave(promise) { gate = promise; },
        async blockDiskWrite() {
            await fs.rename(historyPath, backup); await fs.mkdir(historyPath); blocked = true;
        },
    };
}

test('side delete retains the message on a real disk-write failure, shows the error and can retry', async t => {
    const f = await fixture(t);
    await f.blockDiskWrite();
    f.remove('answer');
    await waitFor(() => f.toasts.some(item => item.type === 'error'));
    assert.match(f.toasts.at(-1).message, /删除失败/);
    assert.ok(f.doc.querySelector('[data-message-id="answer"]'));
    assert.deepEqual(f.history(), f.initial);
    assert.equal(f.removals.length, 0);
    await f.repair();
    assert.deepEqual(await f.read(), f.initial);
    await f.handle.retryLoadHistory();
    assert.ok(f.doc.querySelector('[data-message-id="answer"]'));
    f.remove('answer');
    await waitFor(() => !f.doc.querySelector('[data-message-id="answer"]'));
    assert.deepEqual((await f.read()).map(item => item.id), ['question']);
    assert.deepEqual(f.removals, [{ id: 'answer', persist: false }]);
    assert.ok(f.writes.every(write => write.itemId === 'agent' && write.topicId === 'child' && write.itemType === 'agent'));
});

test('side delete treats a rejected save result as failure without removing live or persisted content', async t => {
    const f = await fixture(t);
    f.failWithResult({ success: false, error: 'permission denied' });
    f.remove('answer');
    await waitFor(() => f.toasts.some(item => item.type === 'error'));
    assert.match(f.toasts.at(-1).message, /删除失败.*消息已保留/);
    assert.deepEqual(f.history(), f.initial);
    assert.deepEqual(await f.read(), f.initial);
    assert.ok(f.doc.querySelector('[data-message-id="answer"]'));
    assert.equal(f.removals.length, 0);
});

test('pending side deletion keeps typed drafts, blocks send and close, then persists an empty conversation', async t => {
    const f = await fixture(t);
    let release;
    f.holdSave(new Promise(resolve => { release = resolve; }));
    f.remove('answer');
    const send = f.doc.querySelector('.side-chat-send-btn');
    await waitFor(() => f.writes.length === 1);
    assert.ok(send.disabled);
    assert.deepEqual(f.history(), f.initial);
    assert.deepEqual(await f.read(), f.initial);
    assert.equal(f.removals.length, 0);
    f.handle.setDraft('keep my next question');
    f.doc.querySelector('form').requestSubmit();
    assert.equal(f.sends(), 0);
    assert.equal(f.handle.getDraft(), 'keep my next question');
    assert.deepEqual(await f.handle.requestClose(), { closed: false, reason: 'DELETE_PENDING' });
    f.menu('question');
    assert.equal(f.doc.querySelector('[data-side-chat-action="delete"]'), null);
    assert.equal(f.doc.querySelector('[data-side-chat-action="edit"]'), null);
    release();
    await waitFor(() => !f.doc.querySelector('[data-message-id="answer"]') && !send.disabled);
    f.remove('question');
    await waitFor(() => !f.doc.querySelector('.message-item') && !send.disabled);
    assert.deepEqual(await f.read(), []);
    assert.deepEqual(f.history(), []);
    assert.equal(f.doc.querySelector('.side-chat-empty-state').hidden, false);
    assert.equal(f.handle.getDraft(), 'keep my next question');
    assert.deepEqual(await f.handle.requestClose(), { closed: true });
    assert.deepEqual(f.removals, [{ id: 'answer', persist: false }, { id: 'question', persist: false }]);
    assert.equal(f.writes.length, 2, 'one acknowledged save per deletion, no hidden renderer write');
});

test('closing a side chat that has messages asks first, and keeps it when declined', async t => {
    const f = await fixture(t);
    f.answerConfirm(false);
    assert.deepEqual(await f.handle.requestClose(), { closed: false, reason: 'USER_CANCELED' });
    assert.equal(f.confirms.length, 1);
    assert.deepEqual(await f.read(), f.initial);

    f.answerConfirm(true);
    assert.deepEqual(await f.handle.requestClose(), { closed: true });
    assert.equal(f.confirms.length, 2);
});

test('view trajectory from a side reply asks for the child topic, not the main chat', async t => {
    const f = await fixture(t);
    const executed = [];
    f.doc.defaultView.VCPContributions = { commands: {
        get: id => id === 'sidepane.open-trajectory',
        execute: (id, options) => executed.push([id, options])
    } };
    f.menu('answer');
    f.doc.querySelector('[data-side-chat-action="trajectory"]').click();
    assert.equal(executed.length, 1);
    const [id, options] = executed[0];
    assert.equal(id, 'sidepane.open-trajectory');
    assert.equal(options.requestId, 'answer');
    assert.equal(options.conversation.item.id, 'agent');
    assert.equal(options.conversation.topicId, 'child');
});
