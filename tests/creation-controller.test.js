const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { CreationController, normalizeModelOptions } = require('../modules/ui-system/next-shell/creation-controller.js');
const { LifecycleScope, diagnostics } = require('../modules/ui-system/lifecycle-scope.js');
const { SurfaceController } = require('../modules/ui-system/surface-controller.js');

function createUi(window) {
    const controls = [];
    const create = (name, options = {}) => {
        const element = window.document.createElement(name === 'Input' ? 'input' : name === 'Select' ? 'select' : name === 'Button' ? 'button' : 'div');
        const control = {
            element,
            control: element,
            options: { ...options },
            update(patch) {
                Object.assign(this.options, patch);
                if ('disabled' in patch) element.disabled = patch.disabled;
                if ('error' in patch) element.dataset.state = patch.error ? 'error' : '';
            },
            getValue: () => element.value,
            focus: () => element.focus(),
            destroy: () => element.remove(),
        };
        if (name === 'Field') {
            element.append(options.control.element);
            control.control = options.control.control;
        }
        if (name === 'Modal') {
            element.append(options.content, ...options.actions.map(action => action.element));
            control.close = value => { options.onClose?.(value); element.remove(); };
            control.focus = () => {};
        }
        controls.push(control);
        return control;
    };
    return { create, controls, feedback: { toast() {} } };
}

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

test('creation submission waits for the command promise and restores controls after failure', async () => {
    const dom = new JSDOM('<!doctype html><html data-ui-mode="next"><body></body></html>', { pretendToBeVisual: true });
    const ui = createUi(dom.window);
    let resolveCreation;
    const creation = new Promise(resolve => { resolveCreation = resolve; });
    const controller = new CreationController({
        window: dom.window,
        document: dom.window.document,
        getUi: () => ui,
        getApi: () => ({ getCachedModels: async () => [] }),
        commands: () => ({ createAgent: () => creation, createGroup: () => creation }),
    });
    controller.mount();
    await controller.open();
    const form = dom.window.document.querySelector('.next-ui-create-dialog-form');
    const input = form.querySelector('input');
    input.value = 'Nova';
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setImmediate(resolve));
    const buttons = ui.controls.filter(control => control.element.tagName === 'BUTTON');
    const modal = ui.controls.find(control => control.options.title === '创建助手或群组');
    assert.equal(buttons[0].element.disabled, true);
    assert.equal(modal.options.dismissible, false);
    resolveCreation({ success: false, error: 'denied' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(form.querySelector('[role="alert"]').textContent, 'denied');
    assert.equal(buttons[0].element.disabled, false);
    assert.equal(modal.options.dismissible, true);
    controller.dispose();
    dom.window.close();
});
