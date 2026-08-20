import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createReadOnlyChatSurface } from '../modules/chat/chatSurface.js';

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
