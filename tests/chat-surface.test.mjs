import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createChatSurface, createReadOnlyChatSurface } from '../modules/chat/chatSurface.js';

test('read-only ChatSurface ignores a late history result after dispose', async () => {
    const dom = new JSDOM('<div id="root" tabindex="-1"></div>');
    let resolveHistory;
    const renderer = { renderHistory: async () => { throw new Error('must not render after dispose'); } };
    const surface = createReadOnlyChatSurface({
        root: dom.window.document.querySelector('#root'),
        renderer,
        repository: { getHistory: () => new Promise(resolve => { resolveHistory = resolve; }) }
    });
    const load = surface.loadHistory('a', 'agent', 't');
    const firstDispose = surface.dispose();
    const secondDispose = surface.dispose();
    resolveHistory([]);
    assert.deepEqual(await load, { stale: true });
    await Promise.all([firstDispose, secondDispose]);
    assert.equal(surface.disposed, true);
});

test('interactive ChatSurface drains its real operation before renderer teardown', async () => {
    const dom = new JSDOM('<div id="root"></div>');
    const sequence = [];
    let settleOperation;
    const operationDone = new Promise(resolve => { settleOperation = resolve; });
    const surface = createChatSurface({
        root: dom.window.document.querySelector('#root'),
        renderer: {},
        repository: { getHistory: async () => [] },
        mode: 'interactive',
        operations: {
            async dispose() {
                sequence.push('operation-cancel');
                settleOperation();
                await operationDone;
                sequence.push('operation-terminal');
            },
        },
        disposeRenderer: async () => {
            sequence.push('renderer-dispose');
            assert.deepEqual(sequence, ['operation-cancel', 'operation-terminal', 'renderer-dispose']);
        },
    });

    await surface.dispose();

    assert.deepEqual(sequence, ['operation-cancel', 'operation-terminal', 'renderer-dispose']);
    dom.window.close();
});
