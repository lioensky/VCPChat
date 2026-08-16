const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { LifecycleScope } = require('../modules/ui-system/lifecycle-scope.js');
const { SurfaceController } = require('../modules/ui-system/surface-controller.js');

function fixture(runtimeState = 'ready') {
    const dom = new JSDOM('<!doctype html><html data-ui-mode="next"><body><button id="origin">open</button><div id="host"></div></body></html>');
    dom.window.VCPLifecycle = { LifecycleScope };
    dom.window.VCPWebAwesome = { getRuntimeState: () => ({ state: runtimeState }) };
    return dom;
}

test('surface chooses one kernel, owns controls and restores focus', async () => {
    const dom = fixture('ready');
    const origin = dom.window.document.getElementById('origin');
    const host = dom.window.document.getElementById('host');
    origin.focus();
    let destroyed = 0;
    const surface = new SurfaceController({
        window: dom.window,
        document: dom.window.document,
        label: 'next:test-surface',
        getUi: () => ({ create: () => ({ element: dom.window.document.createElement('button'), destroy: () => { destroyed += 1; } }) }),
    });
    await surface.mount(host, context => {
        const control = context.create('Button');
        host.append(control.element);
        dom.window.VCPWebAwesome.getRuntimeState = () => ({ state: 'failed' });
        assert.equal(context.kernel, 'web-awesome');
    });
    assert.equal(surface.kernel, 'web-awesome');
    await surface.dispose();
    await surface.dispose();
    assert.equal(destroyed, 1);
    assert.equal(origin, dom.window.document.activeElement);
});

test('surface falls back atomically when render fails', async () => {
    const dom = fixture('loading');
    const host = dom.window.document.getElementById('host');
    let destroyed = 0;
    const surface = new SurfaceController({ window: dom.window, document: dom.window.document, getUi: () => ({}) });
    await surface.mount(host, context => {
        context.own(() => { destroyed += 1; }, 'partial');
        throw new Error('render failed');
    }, {
        renderFallback: (target, error) => { target.textContent = `fallback:${error.message}`; },
    });
    assert.equal(surface.kernel, 'native');
    assert.equal(surface.fallback, true);
    assert.equal(destroyed, 1);
    assert.equal(host.textContent, 'fallback:render failed');
    await surface.dispose();
});
