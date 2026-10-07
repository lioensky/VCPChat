import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import queueModule from '../modules/services/historyMutationQueue.js';
import { mountSideChatSurface } from '../modules/renderer/sideChatSurfaceOwner.js';

import { waitFor } from './helpers/wait-for.mjs';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-side-retry-'));
    const queue = new queueModule.HistoryMutationQueue({ userDataDir: root });
    const target = { itemId: 'agent', itemType: 'agent', topicId: 'child' };
    const dom = new JSDOM('<div id="mount"></div>');
    const doc = dom.window.document;
    let history = [], renderer, failNextSave = false, writeStarted = false, holdNext = null;
    const repository = {
        getHistory: () => queue.read(target),
        saveHistory: async (_item, _type, _topic, next) => {
            if (holdNext) {
                const held = holdNext;
                holdNext = null;
                writeStarted = true;
                await held;
            }
            if (failNextSave) {
                failNextSave = false;
                throw new Error('controlled disk write failure');
            }
            return queue.replace(target, next);
        },
    };
    const capabilities = {
        repository,
        createRenderer({ root: list, conversation }) {
            const renderHistory = async messages => {
                list.querySelectorAll('.message-item').forEach(item => item.remove());
                for (const message of messages) {
                    const item = doc.createElement('div');
                    item.className = `message-item ${message.role}`;
                    item.dataset.messageId = message.id;
                    const content = doc.createElement('div');
                    content.className = 'md-content';
                    content.textContent = message.content;
                    item.append(content); list.append(item);
                }
            };
            renderer = {
                renderHistory,
                updateMessageContent(id, text) { list.querySelector(`[data-message-id="${id}"] .md-content`).textContent = text; },
                async removeMessageById(id, persist) {
                    history = history.filter(message => message.id !== id);
                    if (persist) await repository.saveHistory('agent', 'agent', 'child', history);
                    list.querySelector(`[data-message-id="${id}"]`)?.remove();
                },
            };
            return { renderer, conversation: {
                selectedItemRef: { get: () => conversation.selectedItem },
                topicIdRef: { get: () => conversation.topicId },
                historyRef: { get: () => history, set: next => { history = next; } },
                replaceHistory: next => { history = next; },
            }, dispose() {} };
        },
        manager: {
            async sendMessage(request) {
                request.onOperation?.({ cancel: async () => false });
                history = [{ id: 'question', role: 'user', content: request.content },
                    { id: 'answer', role: 'assistant', content: 'generated answer' }];
                await renderer.renderHistory(history);
                failNextSave = true;
                try { await repository.saveHistory('agent', 'agent', 'child', history); }
                catch (error) { return { terminal: { event: { type: 'failed', outcome: { persistence: { error: error.message } } } } }; }
                throw new Error('Fixture must reproduce a persistence failure');
            },
        },
    };
    const handle = await mountSideChatSurface(doc.getElementById('mount'), {
        descriptor: { id: 'side', title: 'Side retry', model: 'fixture-model', contextMode: 'references-only',
            parent: { itemId: 'agent', topicId: 'parent' }, child: { itemId: 'agent', topicId: 'child' } },
        chatCapabilities: capabilities,
    });
    t.after(async () => { await handle.dispose(); dom.window.close(); await queue.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    await waitFor(() => !doc.querySelector('.side-chat-send-btn').disabled);
    doc.querySelector('.side-chat-textarea').value = 'question';
    doc.querySelector('form').requestSubmit();
    await waitFor(() => handle.getUnsavedStatus().hasUnsavedChanges && !doc.querySelector('form').hasAttribute('aria-busy'));
    const action = (id, name) => {
        doc.querySelector(`[data-message-id="${id}"] .md-content`).dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        const button = doc.querySelector(`[data-side-chat-action="${name}"]`);
        assert.ok(button, `User must be able to ${name} after generation ends`);
        button.click();
    };
    return { doc, handle, action, read: () => queue.read(target), failSave() { failNextSave = true; },
        get writeStarted() { return writeStarted; },
        // 卡住下一次仓库写入，模拟删除正在落盘
        holdNextWrite() {
            let release;
            holdNext = new Promise(resolve => { release = resolve; });
            t.after(() => release());
            return release;
        },
    };
}

test('side retry preserves an in-place edit made after the answer failed to save', async t => {
    const f = await fixture(t);
    f.action('answer', 'edit');
    f.doc.querySelector('.message-edit-textarea').value = 'my revised answer';
    f.doc.querySelector('[data-side-chat-edit="save"]').click();
    await waitFor(() => !f.doc.querySelector('.message-edit-textarea'));
    assert.equal((await f.read())[1].content, 'my revised answer');
    assert.equal((await f.handle.retryPersistence()).ok, true);
    assert.equal((await f.read())[1].content, 'my revised answer', 'retry overwrote the successfully saved edit');
    assert.equal(f.doc.querySelector('[data-message-id="answer"] .md-content').textContent, 'my revised answer');
});

test('side retry respects deletions including an intentionally empty conversation', async t => {
    for (const deleted of [['answer'], ['answer', 'question']]) {
        const f = await fixture(t);
        for (const id of deleted) {
            f.action(id, 'delete');
            await waitFor(() => !f.doc.querySelector(`[data-message-id="${id}"]`));
        }
        const beforeRetry = await f.read();
        assert.equal((await f.handle.retryPersistence()).ok, true);
        assert.deepEqual(await f.read(), beforeRetry, 'retry resurrected a deleted side message');
        assert.equal(beforeRetry.length, 2 - deleted.length);
    }
});

test('another failed side retry keeps the unsaved badge and close protection', async t => {
    const f = await fixture(t);
    f.failSave();
    assert.equal((await f.handle.retryPersistence()).ok, false);
    assert.equal(f.handle.getUnsavedStatus().hasUnsavedChanges, true);
    assert.equal(f.doc.querySelector('.side-chat-persistence-badge').hidden, false);
    assert.equal((await f.handle.requestClose()).closed, false);
    assert.equal((await f.handle.retryPersistence()).ok, true);
    assert.deepEqual((await f.read()).map(message => message.id), ['question', 'answer']);
    assert.equal(f.handle.getUnsavedStatus().hasUnsavedChanges, false);
    assert.equal(f.doc.querySelector('.side-chat-persistence-badge').hidden, true);
    assert.equal((await f.handle.requestClose()).closed, true);
});

test('retrying the failed-save badge during a pending deletion cannot restore the deleted answer', async t => {
    const f = await fixture(t);
    const release = f.holdNextWrite();
    f.action('answer', 'delete');
    await waitFor(() => f.writeStarted);
    const retry = f.handle.retryPersistence();
    release();
    const result = await retry;
    await waitFor(() => !f.doc.querySelector('[data-message-id="answer"]'));
    assert.deepEqual((await f.read()).map(message => message.id), ['question'], 'The retry queued an old snapshot after deletion');
    assert.equal(result.ok, false, 'A pending deletion must finish before retrying a failed save');
    assert.equal((await f.handle.retryPersistence()).ok, true);
    assert.deepEqual((await f.read()).map(message => message.id), ['question']);
});
