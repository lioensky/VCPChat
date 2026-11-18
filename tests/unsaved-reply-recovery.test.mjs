import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createUnsavedReplyRecovery } from '../modules/renderer/unsavedReplyRecovery.js';

test('retry after topic navigation commits only the failed terminal', async () => {
    const dom = new JSDOM('<main></main>');
    const root = dom.window.document.querySelector('main');
    let topic = 'one';
    const calls = [];
    const recovery = createUnsavedReplyRecovery(root, {
        getSelection: () => ({ id: 'agent' }), getTopicId: () => topic,
        historyPersistence: { commit: async p => { calls.push(p); } },
    });
    const redraw = async () => {
        root.replaceChildren(dom.window.document.createTextNode(''));
        await new Promise(resolve => setTimeout(resolve, 0));
    };
    const message = { id: 'm', role: 'assistant', content: '<b>terminal</b>' };
    const context = { agentId: 'agent', topicId: 'one' };
    try {
        recovery.retain({ context, messageId: 'm', history: [{ id: 'other' }, message] }, Error('write failed'));
        topic = 'two';
        await redraw();
        assert.equal(root.textContent, '');
        topic = 'one';
        await redraw();
        assert.match(root.textContent, /<b>terminal/);
        const button = root.querySelector('button');
        button.click();
        button.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].history, [message]);
        assert.deepEqual(calls[0].context, context);
        assert.equal(root.querySelector('button'), null);
        assert.equal(recovery.has(context, 'm'), false);
    } finally { recovery.dispose(); dom.window.close(); }
});