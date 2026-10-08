import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createDomListenerOwner } from '../modules/renderer/domListenerOwner.js';

const source = fs.readFileSync(new URL('../modules/inputEnhancer.js', import.meta.url), 'utf8');
const deferred = () => Promise.withResolvers();

function fixture(t, { listenerOwner, handleFileDrop = async () => [] } = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="composer"><textarea></textarea></div></body>', {
        runScripts: 'outside-only', url: 'http://localhost/',
    });
    const { window } = dom;
    window.console = { ...console, log() {} };
    window.alert = message => assert.fail(`Unexpected alert: ${message}`);
    window.electronPath = { basename: async value => value.split('\\').pop() };
    window.eval(source);
    const composer = window.document.getElementById('composer');
    const subscriptions = [];
    const attachments = [];
    let previews = 0;
    const refs = {
        messageInput: composer.querySelector('textarea'), dropTargetElement: composer,
        electronAPI: {
            onAddFileToInput: callback => {
                const subscription = { callback, disposals: 0, active: true };
                subscriptions.push(subscription);
                return () => { subscription.disposals += 1; subscription.active = false; };
            },
            handleFileDrop, searchNotes: async () => [],
        },
        attachedFiles: { append: attachment => attachments.push(attachment) },
        updateAttachmentPreview: () => { previews += 1; },
        getCurrentAgentId: () => 'agent', getCurrentTopicId: () => 'topic', listenerOwner,
    };
    t.after(async () => {
        await window.inputEnhancer.dispose();
        listenerOwner?.dispose();
        window.close();
    });
    const initialize = () => window.inputEnhancer.initializeInputEnhancer(refs);
    initialize();
    return { window, composer, subscriptions, attachments, initialize, get previews() { return previews; } };
}

test('renderer owner removes real DOM listeners and preload subscriptions', async t => {
    const owner = createDomListenerOwner();
    const f = fixture(t, { listenerOwner: owner });
    f.composer.dispatchEvent(new f.window.Event('dragenter', { bubbles: true, cancelable: true }));
    assert.equal(f.composer.classList.contains('drag-over'), true);
    f.composer.classList.remove('drag-over');
    owner.dispose();
    f.composer.dispatchEvent(new f.window.Event('dragenter', { bubbles: true, cancelable: true }));
    assert.equal(f.composer.classList.contains('drag-over'), false);
    assert.equal(f.subscriptions[0].disposals, 1);
});

test('every dispose caller waits for pending preload work and late projection is suppressed', async t => {
    const result = deferred(), entered = deferred();
    const f = fixture(t, { handleFileDrop: () => { entered.resolve(); return result.promise; } });
    const pending = f.subscriptions[0].callback('C:\\tmp\\late.txt');
    await entered.promise;
    let firstDone = false, secondDone = false;
    const first = f.window.inputEnhancer.dispose().then(() => { firstDone = true; });
    const second = f.window.inputEnhancer.dispose().then(() => { secondDone = true; });
    try {
        await Promise.resolve();
        assert.equal(firstDone, false);
        assert.equal(secondDone, false, 'a repeated dispose must share the pending teardown barrier');
    } finally {
        result.resolve([{ success: true, attachment: { name: 'late.txt', internalPath: '/tmp/late.txt' } }]);
        await Promise.all([pending, first, second]);
    }
    assert.equal(f.attachments.length, 0);
    assert.equal(f.previews, 0);
    assert.equal(f.subscriptions[0].disposals, 1, 'standalone disposal must release the preload subscription');
});

test('reinitialization retires the old preload subscription and delivers only to the new instance', async t => {
    const owner = createDomListenerOwner();
    const f = fixture(t, {
        listenerOwner: owner,
        handleFileDrop: async () => [{ success: true, attachment: { name: 'current.txt', internalPath: '/tmp/current.txt' } }],
    });
    f.initialize();
    assert.equal(f.subscriptions[0].disposals, 1);
    assert.equal(f.subscriptions.filter(subscription => subscription.active).length, 1);
    await f.subscriptions[0].callback('C:\\tmp\\old.txt');
    await f.subscriptions[1].callback('C:\\tmp\\current.txt');
    assert.equal(f.attachments.length, 1);
    assert.equal(f.previews, 1);
    await f.window.inputEnhancer.dispose();
    owner.dispose();
    assert.deepEqual(f.subscriptions.map(subscription => subscription.disposals), [1, 1]);
});
