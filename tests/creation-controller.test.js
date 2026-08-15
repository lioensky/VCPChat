const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { CreationController, normalizeModelOptions } = require('../modules/ui-system/next-shell/creation-controller.js');

test('model options normalize supported payloads and remove duplicates', () => {
    assert.deepEqual(normalizeModelOptions({ models: [
        'gpt-a', { id: 'gpt-b', displayName: 'Model B' }, { id: 'gpt-a', name: 'duplicate' }, {},
    ] }), [
        { value: 'gpt-a', label: 'gpt-a' },
        { value: 'gpt-b', label: 'Model B' },
    ]);
    assert.deepEqual(normalizeModelOptions(null), []);
});

test('creation controller refuses unavailable commands and disposes idempotently', async () => {
    const dom = new JSDOM('<!doctype html><html data-ui-mode="next"><body></body></html>');
    let unavailable = 0;
    const controller = new CreationController({
        window: dom.window,
        document: dom.window.document,
        getUi: () => ({}),
        commands: () => ({}),
        showUnavailable: () => { unavailable += 1; },
    });
    controller.mount();
    await controller.open();
    assert.equal(unavailable, 1);
    controller.dispose();
    controller.dispose();
    await controller.open();
    assert.equal(unavailable, 1, 'disposed controller cannot reopen a surface');
});
