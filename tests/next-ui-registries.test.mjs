import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { LifecycleScope } = require('../modules/ui-system/lifecycle-scope.js');

test('Next app registrations retract with their owner without changing the register return value', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://vcpchat.local/', runScripts: 'outside-only' });
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        CustomEvent: dom.window.CustomEvent,
    });
    window.eval(fs.readFileSync('modules/ui-system/contribution-registry.js', 'utf8'));
    const moduleUrl = `${pathToFileURL(`${process.cwd()}/modules/ui-system/next-ui-apps.js`).href}?registry-test=${Date.now()}`;
    const registry = await import(moduleUrl);
    const owner = new LifecycleScope('registry-owner');
    const changes = [];
    window.addEventListener('next-ui-apps-changed', event => changes.push(event.detail.action));
    const definition = { id: 'owned-test-app', title: 'Owned', kind: 'internal', mount() {} };
    const app = registry.register(definition, { owner });
    assert.equal(app.id, definition.id);
    assert.strictEqual(registry.get(app.id), app);
    await owner.dispose();
    assert.equal(registry.get(app.id), null);
    assert.deepEqual(changes, ['registered', 'unregistered']);
    assert.throws(
        () => registry.register({ id: 'late-owned-app', title: 'Late', kind: 'internal', mount() {} }, { owner }),
        /inactive owner/,
    );
    assert.equal(registry.get('late-owned-app'), null, 'failed late registration must not leave a registry entry');
    dom.window.close();
});

test('frontend plugin loader keeps the upstream registration contract unchanged', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
        url: 'https://vcpchat.local/',
        runScripts: 'outside-only',
    });
    const { window } = dom;
    window.chatAPI = { listEnabledFrontendPlugins: async () => ({ success: true, plugins: [] }) };
    window.eval(fs.readFileSync('VCPDistributedServer/frontend-plugin-loader.js', 'utf8'));
    const instance = { destroy() {} };
    assert.equal(window.VCPFrontendPlugins.register('legacy-plugin', instance), true);
    assert.strictEqual(window.VCPFrontendPlugins.get('legacy-plugin'), instance);
    assert.equal(window.VCPFrontendPlugins.register('legacy-plugin', {}), false);
    assert.equal('getScope' in window.VCPFrontendPlugins, false);
    assert.equal('getContributions' in window.VCPFrontendPlugins, false);
    assert.equal('unregister' in window.VCPFrontendPlugins, false);
    dom.window.close();
});
