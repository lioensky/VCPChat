'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

test('queue view scopes messages and withdraws by exact scope/id without HTML execution', async t => {
    const { createTopicAdmissionQueueView } = await import('../modules/renderer/topicAdmissionQueueView.js');
    const dom = new JSDOM('<main><textarea></textarea></main>');
    t.after(() => dom.window.close());
    const doc = dom.window.document;
    const a = { itemType: 'agent', itemId: 'a', topicId: 'topic_a' };
    const b = { itemType: 'group', itemId: 'b', topicId: 'topic_b' };
    let scope = a;
    let listener;
    let unsubscribed = false;
    const calls = [];
    const entries = [
        { entryId: 'one', scope: a, state: 'queued', message: { name: 'Kerr', content: '<script>bad()</script>' } },
        { entryId: 'two', scope: b, state: 'queued', message: { name: 'Nova', content: 'group' } },
        { entryId: 'three', scope: a, state: 'advancing', committed: true, message: { name: '用户', content: 'committed' } },
    ];
    const view = createTopicAdmissionQueueView({
        parent: doc.querySelector('main'),
        before: doc.querySelector('textarea'),
        getScope: () => scope,
        api: {
            topicAdmissionList: async () => ({ success: true, entries }),
            topicAdmissionWithdraw: async (...args) => { calls.push(args); return { success: true }; },
            onTopicAdmissionChanged: callback => {
                listener = callback;
                return () => { unsubscribed = true; };
            },
        },
    });
    await view.refresh();
    const root = doc.querySelector('.topic-admission-queue');
    assert.equal(root.previousSibling, null);
    assert.equal(root.querySelectorAll('.topic-admission-row').length, 1);
    assert.equal(root.textContent.includes('committed'), false);
    assert.equal(root.querySelector('script'), null);
    assert.ok(root.textContent.includes('<script>bad()</script>'));
    assert.equal(root.querySelectorAll('button').length, 1);
    root.querySelector('button').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [[a, 'one']]);
    scope = b;
    view.selectionChanged();
    assert.equal(root.querySelectorAll('.topic-admission-row').length, 1);
    assert.ok(root.textContent.includes('Nova'));
    listener([]);
    assert.equal(root.hidden, true);
    view.dispose();
    assert.equal(unsubscribed, true);
    assert.equal(doc.querySelector('.topic-admission-queue'), null);
});
test('withdraw race reports host rejection and does not hide the queued message', async t => {
    const { createTopicAdmissionQueueView } = await import('../modules/renderer/topicAdmissionQueueView.js');
    const dom = new JSDOM('<main></main>');
    t.after(() => dom.window.close());
    const scope = { itemType: 'group', itemId: 'g', topicId: 't' };
    const entries = [
        { entryId: 'pending', scope, state: 'queued', message: { content: 'pending' } },
        { entryId: 'uncertain', scope, state: 'failed', commitStarted: true, message: { content: 'uncertain' } },
    ];
    const warnings = [];
    let finish;
    const view = createTopicAdmissionQueueView({
        parent: dom.window.document.querySelector('main'),
        getScope: () => scope,
        notify: (...args) => warnings.push(args),
        api: {
            topicAdmissionList: async () => ({ success: true, entries }),
            onTopicAdmissionChanged: () => () => {},
            topicAdmissionWithdraw: () => new Promise(resolve => { finish = resolve; }),
        },
    });
    t.after(() => view.dispose());
    await view.refresh();
    const root = dom.window.document.querySelector('.topic-admission-queue');
    assert.equal(root.querySelectorAll('[aria-label="撤回暂挂消息"]').length, 1);
    root.querySelector('[aria-label="撤回暂挂消息"]').click();
    assert.equal(root.querySelector('[aria-label="撤回暂挂消息"]').disabled, true);
    finish({ success: false, code: 'ALREADY_COMMITTED' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(root.querySelectorAll('.topic-admission-row').length, 2);
    assert.deepEqual(warnings, [['ALREADY_COMMITTED', 'warning']]);
    assert.equal(root.querySelector('[aria-label="撤回暂挂消息"]').disabled, false);
});
test('uncertain saved state exposes diagnostics without offering resume or withdrawal', async t => {
    const { createTopicAdmissionQueueView } = await import('../modules/renderer/topicAdmissionQueueView.js');
    const dom = new JSDOM('<main></main>');
    t.after(() => dom.window.close());
    const scope = { itemType: 'group', itemId: 'g', topicId: 't' };
    const view = createTopicAdmissionQueueView({
        parent: dom.window.document.querySelector('main'),
        getScope: () => scope,
        api: {
            topicAdmissionList: async () => ({ success: true, entries: [{
                entryId: 'uncertain', scope, state: 'uncertain', committed: true,
                error: 'save unknown', message: { content: 'hello' },
            }] }),
            onTopicAdmissionChanged: () => () => {},
        },
    });
    t.after(() => view.dispose());
    await view.refresh();
    const root = dom.window.document.querySelector('.topic-admission-queue');
    assert.match(root.textContent, /保存待核实 · 保留占用/);
    assert.equal(root.querySelector('.topic-admission-status').title, 'save unknown');
    assert.equal(root.querySelectorAll('button').length, 0);
});

for (const accepted of [false, true]) {
    test(`terminal verification UI uses exact batch without generation or optimistic removal: ${accepted}`, async t => {
        const { createTopicAdmissionQueueView } = await import('../modules/renderer/topicAdmissionQueueView.js');
        const dom = new JSDOM('<main></main>');
        t.after(() => dom.window.close());
        const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
        let entries = [{
            entryId: 'batch', scope, state: 'uncertain', committed: true,
            message: { content: 'pending verification' },
        }];
        const calls = [];
        const warnings = [];
        let finish;
        const view = createTopicAdmissionQueueView({
            parent: dom.window.document.querySelector('main'),
            getScope: () => scope,
            notify: (...args) => warnings.push(args),
            api: {
                topicAdmissionList: async () => ({ success: true, entries }),
                onTopicAdmissionChanged: () => () => {},
                topicAdmissionResume: async () => assert.fail('verification must not generate'),
                topicAdmissionWithdraw: async () => assert.fail('verification must not withdraw'),
                topicAdmissionReconcile: (...args) => {
                    calls.push(args);
                    return new Promise(resolve => { finish = resolve; });
                },
            },
        });
        t.after(() => view.dispose());
        await view.refresh();
        const root = dom.window.document.querySelector('.topic-admission-queue');
        const button = root.querySelector('button');
        assert.equal(button.textContent, '核对终稿');
        button.click();
        assert.equal(root.querySelector('button').disabled, true);
        assert.equal(root.querySelectorAll('.topic-admission-row').length, 1);
        assert.deepEqual(calls, [[scope, 'batch']]);
        if (accepted) entries = [];
        finish(accepted ? { success: true } : { success: false, code: 'TERMINAL_UNCONFIRMED' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(root.querySelectorAll('.topic-admission-row').length, accepted ? 0 : 1);
        assert.equal(warnings.length, accepted ? 0 : 1);
        if (!accepted) assert.equal(root.querySelector('button').disabled, false);
    });
}
test('idle admission stays hidden, real deferral shows only until committed, diagnostics remain visible', async t => {
    const { createTopicAdmissionQueueView } = await import('../modules/renderer/topicAdmissionQueueView.js');
    const dom = new JSDOM('<main></main>');
    t.after(() => dom.window.close());
    const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
    let listener;
    const entry = { entryId: 'message', scope, state: 'queued', deferred: false, message: { content: 'hello' } };
    const view = createTopicAdmissionQueueView({
        parent: dom.window.document.querySelector('main'), getScope: () => scope,
        api: {
            topicAdmissionList: async () => ({ success: true, entries: [entry] }),
            onTopicAdmissionChanged: callback => { listener = callback; return () => {}; },
        },
    });
    t.after(() => view.dispose());
    await view.refresh();
    const root = dom.window.document.querySelector('.topic-admission-queue');
    assert.equal(root.hidden, true);
    listener([{ ...entry, deferred: true }]);
    assert.equal(root.hidden, false);
    listener([{ ...entry, deferred: true, committed: true }]);
    assert.equal(root.hidden, true);
    listener([{ ...entry, state: 'advancing', committed: true }]);
    assert.equal(root.hidden, true);
    listener([{ ...entry, state: 'failed', error: 'disk full' }]);
    assert.equal(root.hidden, false);
});