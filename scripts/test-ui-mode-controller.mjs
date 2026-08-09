import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

const dom = new JSDOM('<!doctype html><html data-ui-mode="classic"><body></body></html>', {
    url: 'https://vcp.local/',
    runScripts: 'outside-only'
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Event = dom.window.Event;
globalThis.URLSearchParams = dom.window.URLSearchParams;

const controller = (await import('../modules/ui-system/ui-mode-controller.js')).default;

let failures = 0;
const tests = [];
function check(name, fn) {
    tests.push({ name, fn });
}

check('normalize clamps unknown modes to classic', () => {
    assert.equal(controller.normalize('next'), 'next');
    assert.equal(controller.normalize('CLASSIC'), 'classic');
    assert.equal(controller.normalize('weird'), 'classic');
});

check('currentMode reflects html[data-ui-mode]', () => {
    dom.window.document.documentElement.dataset.uiMode = 'next';
    assert.equal(controller.getCurrentMode(), 'next');
    dom.window.document.documentElement.dataset.uiMode = 'classic';
    assert.equal(controller.getCurrentMode(), 'classic');
});

check('createSurfaceController runs onEnter/onLeave and is idempotent', () => {
    dom.window.document.documentElement.dataset.uiMode = 'classic';
    let enters = 0;
    let leaves = 0;
    const surface = controller.createSurfaceController({ onEnter: () => { enters += 1; }, onLeave: () => { leaves += 1; } });
    assert.equal(surface.isActive(), false);

    dom.window.document.documentElement.dataset.uiMode = 'next';
    dom.window.dispatchEvent(new dom.window.CustomEvent('ui-mode-changed', { detail: { mode: 'next' } }));
    dom.window.dispatchEvent(new dom.window.CustomEvent('ui-mode-changed', { detail: { mode: 'next' } }));
    assert.equal(enters, 1, 'onEnter runs once for repeated next events');

    dom.window.document.documentElement.dataset.uiMode = 'classic';
    dom.window.dispatchEvent(new dom.window.CustomEvent('ui-mode-changed', { detail: { mode: 'classic' } }));
    dom.window.dispatchEvent(new dom.window.CustomEvent('ui-mode-changed', { detail: { mode: 'classic' } }));
    assert.equal(leaves, 1, 'onLeave runs once for repeated classic events');
    assert.equal(surface.isActive(), false);

    surface.destroy();
    dom.window.document.documentElement.dataset.uiMode = 'next';
    dom.window.dispatchEvent(new dom.window.CustomEvent('ui-mode-changed', { detail: { mode: 'next' } }));
    assert.equal(enters, 1, 'destroy detaches the listener');
});

check('createSurfaceController fires onEnter immediately when already next', () => {
    dom.window.document.documentElement.dataset.uiMode = 'next';
    let enters = 0;
    const surface = controller.createSurfaceController({ onEnter: () => { enters += 1; } });
    assert.equal(enters, 1);
    assert.equal(surface.isActive(), true);
    surface.destroy();
    dom.window.document.documentElement.dataset.uiMode = 'classic';
});

check('bootstrap reads the ?uiMode query param', async () => {
    dom.window.document.documentElement.dataset.uiMode = '';
    dom.window.history.replaceState({}, '', '/?uiMode=next');
    const instance = await controller.bootstrap({ readMode: () => 'next' });
    assert.equal(instance.getMode(), 'next');
    assert.equal(dom.window.document.documentElement.dataset.uiMode, 'next');
    instance.destroy();
    dom.window.history.replaceState({}, '', '/');
});

check('bootstrap applies subscribed mode changes and unsubscribes on destroy', async () => {
    let subscribed = true;
    let notify;
    dom.window.document.documentElement.dataset.uiMode = 'classic';
    const instance = await controller.bootstrap({
        readMode: () => 'classic',
        subscribeMode: cb => {
            notify = mode => { if (subscribed) cb(mode); };
            return () => { subscribed = false; };
        },
    });
    assert.equal(instance.getMode(), 'classic');
    notify('next');
    assert.equal(instance.getMode(), 'next');
    notify('next');
    instance.destroy();
    assert.equal(subscribed, false, 'destroy unsubscribes');
    notify('classic');
    assert.equal(instance.getMode(), 'next', 'no update after unsubscribe');
});

check('runtime mode updates reload the original child document with the new mode', async () => {
    let notify;
    let unsubscribed = false;
    let navigatedTo = null;
    dom.window.history.replaceState({}, '', '/notes.html?vcpEmbedded=1&uiMode=classic');
    dom.window.utilityAPI = {
        onUiModeUpdated(callback) {
            notify = callback;
            return () => { unsubscribed = true; };
        },
    };
    const instance = await controller.bootstrap({
        readMode: () => 'classic',
        navigate: url => { navigatedTo = url; },
    });
    notify('next');
    const target = new URL(navigatedTo);
    assert.equal(target.pathname, '/notes.html');
    assert.equal(target.searchParams.get('vcpEmbedded'), '1');
    assert.equal(target.searchParams.get('uiMode'), 'next');
    assert.equal(instance.getMode(), 'classic', 'current document is not destructively remounted before navigation');
    instance.destroy();
    assert.equal(unsubscribed, true);
    delete dom.window.utilityAPI;
    dom.window.history.replaceState({}, '', '/');
});

check('defaultReadMode reads the query param when present', async () => {
    dom.window.document.documentElement.dataset.uiMode = '';
    dom.window.history.replaceState({}, '', '/?uiMode=next');
    const instance = await controller.bootstrap();
    assert.equal(instance.getMode(), 'next');
    instance.destroy();
    dom.window.history.replaceState({}, '', '/');
});

check('defaultReadMode falls back to Next when no persisted provider exists', async () => {
    dom.window.document.documentElement.dataset.uiMode = '';
    const instance = await controller.bootstrap();
    assert.equal(instance.getMode(), 'next');
    instance.destroy();
});

for (const { name, fn } of tests) {
    try {
        await fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        failures += 1;
        console.error(`FAIL - ${name}\n    ${error.message}`);
    }
}

if (failures) {
    console.error(`\n${failures} ui-mode-controller check(s) failed.`);
    process.exit(1);
}
console.log('\nui-mode-controller checks passed.');
