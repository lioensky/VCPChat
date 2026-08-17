const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { CreationController, normalizeModelOptions } = require('../modules/ui-system/next-shell/creation-controller.js');
const { LifecycleScope, diagnostics } = require('../modules/ui-system/lifecycle-scope.js');
const { SurfaceController } = require('../modules/ui-system/surface-controller.js');
const settlement = require('../modules/ui-system/settlement.js');

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
    dom.window.VCPSettlement = settlement;
    controller.mount();
    const opening = controller.open();
    const operationId = controller.getSnapshot().operationId;
    await opening;
    const settled = await controller.whenSettled({ operationId });
    assert.equal(settled.status, 'failed');
    assert.equal(unavailable, 1);
    controller.dispose();
    controller.dispose();
    await controller.open();
    assert.equal(unavailable, 1, 'disposed controller cannot reopen a surface');
});

test('creation surface failure destroys partial controls and does not continue with a broken modal', async () => {
    const dom = new JSDOM('<!doctype html><html data-ui-mode="next"><body></body></html>');
    dom.window.VCPLifecycle = { LifecycleScope };
    dom.window.VCPUISurface = { SurfaceController };
    dom.window.VCPWebAwesome = { getRuntimeState: () => ({ state: 'ready' }) };
    let creates = 0;
    let destroys = 0;
    let unavailable = 0;
    const ui = {
        create() {
            creates += 1;
            if (creates === 3) throw new Error('injected control failure');
            return {
                element: dom.window.document.createElement('div'),
                destroy() { destroys += 1; },
            };
        },
    };
    const owner = new LifecycleScope('creation-failure-owner');
    const controller = new CreationController({
        window: dom.window,
        document: dom.window.document,
        getUi: () => ui,
        commands: () => ({ createAgent() {}, createGroup() {} }),
        showUnavailable: () => { unavailable += 1; },
    });
    controller.mount(owner);
    await controller.open();
    assert.equal(unavailable, 1);
    assert.equal(destroys, 2, 'every successfully created partial control must be destroyed');
    assert.equal(dom.window.document.querySelector('.next-ui-create-dialog-host'), null);
    assert.equal(diagnostics.find('next:create-item-modal').length, 0);
    await owner.dispose();
});
