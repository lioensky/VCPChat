import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomListenerOwner } from '../modules/renderer/domListenerOwner.js';

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
let inputEnhancer;

test('input enhancer registers DOM and preload resources with the renderer owner', async () => {
    globalThis.window = { electronPath: { basename: async value => value.split('\\').pop() } };
    globalThis.alert = () => {};
    await import('../modules/inputEnhancer.js?owner-test=2');
    inputEnhancer = window.inputEnhancer;
    const owner = createDomListenerOwner();
    const listeners = new Map();
    const target = {
        classList: { add() {}, remove() {}, contains() { return false; } },
        addEventListener(type, handler) { listeners.set(type, handler); },
        removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); },
    };
    let sharedDisposed = 0;
    const api = {
        onAddFileToInput: () => () => { sharedDisposed += 1; },
        handleFileDrop: async () => [],
        searchNotes: async () => [],
    };
    window.inputEnhancer.initializeInputEnhancer({
        messageInput: target,
        dropTargetElement: target,
        electronAPI: api,
        attachedFiles: { get: () => [], set() {}, append() {} },
        updateAttachmentPreview() {},
        getCurrentAgentId: () => 'agent',
        getCurrentTopicId: () => 'topic',
        listenerOwner: owner,
    });
    assert.equal(listeners.size >= 6, true);
    owner.dispose();
    assert.equal(listeners.size, 0);
    assert.equal(sharedDisposed, 1);
});

test('input enhancer waits for pending preload work and suppresses its late attachment projection', async () => {
    window.electronPath = { basename: async value => value.split('\\').pop() };
    globalThis.alert = () => {};
    const result = deferred();
    let consumeSharedFile;
    let appended = 0;
    let previews = 0;
    const target = {
        classList: { add() {}, remove() {}, contains() { return false; } },
        addEventListener() {}, removeEventListener() {},
    };
    inputEnhancer.initializeInputEnhancer({
        messageInput: target,
        dropTargetElement: target,
        electronAPI: {
            onAddFileToInput: callback => { consumeSharedFile = callback; return () => {}; },
            handleFileDrop: () => result.promise,
            searchNotes: async () => [],
        },
        attachedFiles: { get: () => [], set() {}, append() { appended += 1; } },
        updateAttachmentPreview() { previews += 1; },
        getCurrentAgentId: () => 'agent',
        getCurrentTopicId: () => 'topic',
    });

    const pending = consumeSharedFile('C:\\tmp\\late.txt');
    await new Promise(resolve => setImmediate(resolve));
    let disposed = false;
    const disposing = inputEnhancer.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposed, false);
    result.resolve([{ success: true, attachment: { name: 'late.txt', internalPath: '/tmp/late.txt' } }]);
    await Promise.all([pending, disposing]);
    assert.equal(appended, 0);
    assert.equal(previews, 0);
});
