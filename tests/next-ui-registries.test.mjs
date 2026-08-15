import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { LifecycleScope } = require('../modules/ui-system/lifecycle-scope.js');

test('Next app registrations retract with their owner without changing the register return value', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://vcpchat.local/' });
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        CustomEvent: dom.window.CustomEvent,
    });
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

test('frontend plugin loader owns registration, instance, script and style lifetime', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
        url: 'https://vcpchat.local/',
        runScripts: 'outside-only',
    });
    const { window } = dom;
    window.eval(fs.readFileSync('modules/ui-system/lifecycle-scope.js', 'utf8'));
    window.chatAPI = { listEnabledFrontendPlugins: async () => ({ success: true, plugins: [] }) };
    window.eval(fs.readFileSync('VCPDistributedServer/frontend-plugin-loader.js', 'utf8'));
    let destroyed = 0;
    const instance = { destroy() { destroyed += 1; } };
    assert.equal(window.VCPFrontendPlugins.register('owned-plugin', instance), true);
    assert.strictEqual(window.VCPFrontendPlugins.get('owned-plugin'), instance);
    assert.ok(window.VCPFrontendPlugins.getScope('owned-plugin'));
    assert.equal(await window.VCPFrontendPlugins.unregister('owned-plugin'), true);
    assert.equal(window.VCPFrontendPlugins.get('owned-plugin'), undefined);
    assert.equal(destroyed, 1);
    assert.equal(await window.VCPFrontendPlugins.unregister('owned-plugin'), false);
    let orphanResourceDisposed = 0;
    const orphanScope = window.VCPFrontendPlugins.getScope('failed-plugin');
    orphanScope.own(() => { orphanResourceDisposed += 1; }, 'failed-script-resource');
    assert.equal(await window.VCPFrontendPlugins.unregister('failed-plugin'), true, 'failed loads must be retractable before registration');
    assert.equal(orphanResourceDisposed, 1);
    await window.VCPFrontendPlugins.destroy();
    assert.equal(window.VCPFrontendPlugins.register('after-destroy', {}), false, 'destroyed loaders must reject late registrations');
    assert.equal(window.VCPFrontendPlugins.getScope('after-destroy'), null, 'destroyed loaders must not create orphan scopes');
    await window.VCPFrontendPlugins.destroy();
    dom.window.close();
});

test('frontend plugin discovery cannot append resources after loader destruction', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
        url: 'https://vcpchat.local/',
        runScripts: 'outside-only',
    });
    const { window } = dom;
    window.eval(fs.readFileSync('modules/ui-system/lifecycle-scope.js', 'utf8'));
    let resolvePlugins;
    window.chatAPI = {
        listEnabledFrontendPlugins: () => new Promise(resolve => { resolvePlugins = resolve; })
    };
    let loadedEvents = 0;
    window.document.addEventListener('vcp-frontend-plugins-loaded', () => { loadedEvents += 1; });
    window.eval(fs.readFileSync('VCPDistributedServer/frontend-plugin-loader.js', 'utf8'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await new Promise(resolve => setTimeout(resolve, 0));
    await window.VCPFrontendPlugins.destroy();
    resolvePlugins({
        success: true,
        plugins: [{ id: 'late-plugin', style: '/late.css', script: '/late.js' }]
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(window.document.querySelector('[data-vcp-plugin="late-plugin"]'), null);
    assert.equal(loadedEvents, 0, 'destroyed discovery must not emit a misleading loaded event');
    dom.window.close();
});
