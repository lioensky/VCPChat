import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

const dom = new JSDOM('<!doctype html><html data-ui-mode="next"><body></body></html>', {
    url: 'https://vcp.local/',
    runScripts: 'outside-only'
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.customElements = dom.window.customElements;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Event = dom.window.Event;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.MutationObserver = dom.window.MutationObserver;

const adapter = (await import('../modules/ui-system/webawesome-adapter.js')).default;
const adapterWin = dom.window;

function scopeRoot() {
    const root = adapterWin.document.createElement('div');
    root.className = 'vcp-ui-scope';
    adapterWin.document.body.append(root);
    return root;
}

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        failures += 1;
        console.error(`FAIL - ${name}\n    ${error.message}`);
    }
}

check('exposes the VCP-shaped API', () => {
    for (const key of ['loadComponents', 'create', 'on', 'awaitUpdate', 'applyTokens', 'registerTheme', 'destroy', 'isNextUi', 'getRuntimeState']) {
        assert.equal(typeof adapter[key], 'function', `missing ${key}`);
    }
    assert.equal(typeof adapterWin.VCPWebAwesome, 'object');
});

check('create builds a wa-* element and translates attributes', () => {
    const el = adapter.create('button', { size: 'small', disabled: true, hidden: false, label: '保存' });
    assert.equal(el.tagName.toLowerCase(), 'wa-button');
    assert.equal(el.getAttribute('size'), 'small');
    assert.equal(el.getAttribute('disabled'), '');
    assert.equal(el.hasAttribute('hidden'), false);
    assert.equal(el.getAttribute('label'), '保存');
});

check('create appends children', () => {
    const child = adapterWin.document.createElement('span');
    const el = adapter.create('button', {}, [child]);
    assert.equal(el.firstElementChild, child);
});

check('on attaches and detaches a listener', () => {
    const el = adapterWin.document.createElement('button');
    let count = 0;
    const off = adapter.on(el, 'click', () => { count += 1; });
    el.dispatchEvent(new adapterWin.window.Event('click'));
    off();
    el.dispatchEvent(new adapterWin.window.Event('click'));
    assert.equal(count, 1);
});

check('awaitUpdate resolves without updateComplete', async () => {
    const el = adapterWin.document.createElement('div');
    assert.equal(await adapter.awaitUpdate(el), el);
});

check('applyTokens marks an adapter scope in next mode and unmarks on release', () => {
    const root = scopeRoot();
    const release = adapter.applyTokens(root);
    assert.equal(root.dataset.waScope, 'true');
    assert.equal(root.classList.contains('wa-dark'), true);
    assert.equal(root.classList.contains('wa-light'), false);
    release();
    assert.equal(root.hasAttribute('data-wa-scope'), false);
    assert.equal(root.classList.contains('wa-dark'), false);
});

check('registerTheme is ref-counted', () => {
    const releaseOne = adapter.registerTheme();
    const releaseTwo = adapter.registerTheme();
    let link = adapterWin.document.querySelector('link[data-webawesome-runtime-theme]');
    assert.ok(link, 'theme link created');
    assert.equal(Number(link.dataset.ownerCount), 2);
    releaseOne();
    link = adapterWin.document.querySelector('link[data-webawesome-runtime-theme]');
    assert.ok(link, 'link survives first release');
    assert.equal(Number(link.dataset.ownerCount), 1);
    releaseTwo();
    link = adapterWin.document.querySelector('link[data-webawesome-runtime-theme]');
    assert.equal(link, null, 'link removed at zero owners');
});

check('isNextUi reflects the current ui mode', () => {
    assert.equal(adapter.isNextUi(), true);
    adapterWin.document.documentElement.dataset.uiMode = 'classic';
    assert.equal(adapter.isNextUi(), false);
    adapterWin.document.documentElement.dataset.uiMode = 'next';
});

check('applyTokens is a no-op outside next mode', () => {
    adapterWin.document.documentElement.dataset.uiMode = 'classic';
    const root = scopeRoot();
    const release = adapter.applyTokens(root);
    assert.equal(root.hasAttribute('data-wa-scope'), false);
    release();
    adapterWin.document.documentElement.dataset.uiMode = 'next';
});

check('loadComponents refuses to run outside next mode', async () => {
    adapterWin.document.documentElement.dataset.uiMode = 'classic';
    await assert.rejects(adapter.loadComponents(['button']), /next/);
    adapterWin.document.documentElement.dataset.uiMode = 'next';
});

check('destroy clears theme ref-count nodes', () => {
    adapter.registerTheme();
    adapter.destroy();
    assert.equal(adapterWin.document.querySelector('link[data-webawesome-runtime-theme]'), null);
});

check('exposes isLoaded alongside isDefined', () => {
    for (const api of [adapter, adapterWin.VCPWebAwesome]) {
        assert.equal(typeof api.isLoaded, 'function', 'isLoaded must be exposed');
        assert.equal(typeof api.isDefined, 'function', 'isDefined must be exposed');
    }
    assert.equal(adapter.isLoaded('never-loaded-tag'), false, 'never-loaded tag must report false');
    assert.equal(adapter.isDefined('nonexistent-tag'), false, 'undefined tag must report false');
});

check('translateEvent re-dispatches a wa event as a VCP event', () => {
    const element = adapterWin.document.createElement('wa-select');
    let seen = null;
    const off = adapter.translateEvent(element, 'wa-change', 'change', event => ({ value: event.detail?.value ?? 42 }));
    element.addEventListener('change', event => { seen = event.detail; });
    element.dispatchEvent(new adapterWin.window.CustomEvent('wa-change', { detail: { value: 'B' } }));
    assert.deepEqual(seen, { value: 'B' });
    off();
    element.dispatchEvent(new adapterWin.window.CustomEvent('wa-change', { detail: { value: 'C' } }));
    assert.deepEqual(seen, { value: 'B' }, 'unsubscribed translation must not fire');
});

check('mountScope applies tokens and theme together and releases both', () => {
    adapterWin.document.documentElement.dataset.uiMode = 'next';
    const root = scopeRoot();
    const release = adapter.mountScope(root);
    assert.equal(root.dataset.waScope, 'true');
    assert.ok(adapterWin.document.querySelector('link[data-webawesome-runtime-theme]'), 'theme link created by mountScope');
    release();
    assert.equal(root.hasAttribute('data-wa-scope'), false);
    assert.equal(adapterWin.document.querySelector('link[data-webawesome-runtime-theme]'), null, 'theme released with the scope');
});

check('awaitUpdate resolves through an updateComplete promise', async () => {
    const element = adapterWin.document.createElement('div');
    let release;
    element.updateComplete = new Promise(resolve => { release = () => resolve(element); });
    const pending = adapter.awaitUpdate(element);
    let settled = false;
    pending.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(settled, false, 'must wait for updateComplete');
    release();
    assert.equal(await pending, element);
});

// Deterministic fallback contract: custom-element definitions cannot be
// rolled back, so the adapter state — rather than registry contents — is the
// authority that keeps VCPUI on native DOM after any kernel failure.
async function checkAsync(name, fn) {
    try {
        await fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        failures += 1;
        console.error(`FAIL - ${name}\n    ${error.message}`);
    }
}

await checkAsync('mounted scope follows runtime light and dark theme changes', async () => {
    const root = scopeRoot();
    const release = adapter.applyTokens(root);
    adapterWin.document.body.classList.add('light-theme');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(root.classList.contains('wa-light'), true);
    assert.equal(root.classList.contains('wa-dark'), false);
    adapterWin.document.body.classList.remove('light-theme');
    adapterWin.document.body.classList.add('dark-theme');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(root.classList.contains('wa-dark'), true);
    assert.equal(root.classList.contains('wa-light'), false);
    release();
});

await checkAsync('loadComponents failure is deterministic and observable', async () => {
    adapterWin.document.documentElement.dataset.uiMode = 'next';
    const events = [];
    const onLoaded = event => events.push(['loaded', event.detail?.tags]);
    const onFailed = event => events.push(['failed', event.detail?.tags]);
    adapterWin.addEventListener('vcp-webawesome-loaded', onLoaded);
    adapterWin.addEventListener('vcp-webawesome-failed', onFailed);
    try {
        const first = adapter.loadComponents(['button']);
        const second = adapter.loadComponents(['select']);
        assert.equal(adapter.getRuntimeState().state, 'loading');
        await Promise.all([first, second]);
    } catch {
        // Expected: the vendored browser ESM cannot be imported in Node/jsdom.
    }
    adapterWin.removeEventListener('vcp-webawesome-loaded', onLoaded);
    adapterWin.removeEventListener('vcp-webawesome-failed', onFailed);
    assert.equal(events.length, 1, 'exactly one load outcome event must fire');
    if (events[0][0] === 'failed') {
        assert.deepEqual(events[0][1], adapter.getRuntimeState().components);
        assert.equal(adapter.getRuntimeState().state, 'failed');
        assert.equal(adapter.isLoaded('button'), false, 'failed preload must not mark tags as loaded');
        assert.equal(adapter.isDefined('button'), false, 'failed kernel must force native fallback');
        await assert.rejects(adapter.loadComponents(['button']));
        assert.equal(events.length, 1, 'terminal failure must not dispatch duplicate outcomes');
    }
});

await checkAsync('failed runtime ignores irreversible custom element registrations', async () => {
    adapterWin.document.documentElement.dataset.uiMode = 'next';
    class FakeWaButton extends adapterWin.HTMLElement {}
    if (!adapterWin.customElements.get('wa-button')) {
        adapterWin.customElements.define('wa-button', FakeWaButton);
    }
    assert.equal(adapter.isDefined('button'), false, 'registry contents must not override terminal native fallback');
    const el = adapter.create('button', { disabled: true });
    assert.equal(el.tagName.toLowerCase(), 'wa-button');
    assert.equal(el.getAttribute('disabled'), '');
});

if (failures) {
    console.error(`\n${failures} webawesome-adapter contract check(s) failed.`);
    process.exit(1);
}
console.log('\nwebawesome-adapter contract checks passed.');
