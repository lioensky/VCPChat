import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { LifecycleScope } = require('../modules/ui-system/lifecycle-scope.js');
const { createUiScope } = await import('../modules/uiux/runtime/scope.ts');
const { mountThemePresenter } = await import('../modules/uiux/providers/theme.ts');

function createThemeReadable() {
    let value = Object.freeze({ ready: true, preference: 'light', effective: 'light' });
    let revision = 0;
    const listeners = new Set();
    const snapshot = () => Object.freeze({
        value,
        revision,
        source: revision ? 'test-command' : 'initial',
    });
    return {
        get: () => value,
        getSnapshot: snapshot,
        subscribe(listener, options = {}) {
            listeners.add(listener);
            if (options.immediate !== false) listener(value, snapshot());
            return () => listeners.delete(listener);
        },
        publish(effective) {
            revision += 1;
            value = Object.freeze({ ready: true, preference: effective, effective });
            const next = snapshot();
            listeners.forEach(listener => listener(value, next));
        },
        get listenerCount() { return listeners.size; },
    };
}

test('typed ThemePresenter projects snapshots and releases through LifecycleScope', async () => {
    const dom = new JSDOM('<!doctype html><body><section id="root"></section></body>', { pretendToBeVisual: true });
    const root = dom.window.document.getElementById('root');
    const theme = createThemeReadable();
    const legacyScope = new LifecycleScope('typed-theme-consumer');
    const scope = createUiScope(legacyScope);
    mountThemePresenter(root, { theme }, { scope, services: { theme } });
    assert.equal(root.dataset.themeEffective, 'light');
    assert.equal(root.dataset.themePreference, 'light');
    assert.equal(root.dataset.themeRevision, '0');
    assert.equal(dom.window.document.documentElement.style.getPropertyValue('--vcp-ui-theme-bg-primary'), 'oklch(0.98 0.008 230)');
    assert.equal(dom.window.document.documentElement.style.getPropertyValue('--dsw-alias-border-inverted'), 'rgba(0, 0, 0, 0)');
    assert.equal(dom.window.document.documentElement.style.getPropertyValue('--dsw-specific-menu'), 'rgb(255, 255, 255)');
    assert.equal(dom.window.document.body.dataset.vcpTheme, 'light');
    assert.equal(dom.window.document.documentElement.style.colorScheme, 'light');
    assert.equal(dom.window.document.querySelector('meta[data-vcp-theme-color]')?.content, '#ffffff');
    theme.publish('dark');
    assert.equal(root.dataset.themeEffective, 'dark');
    assert.equal(dom.window.document.body.dataset.vcpTheme, 'dark');
    assert.equal(dom.window.document.querySelector('meta[data-vcp-theme-color]')?.content, '#232324');
    assert.equal(root.dataset.themeRevision, '1');
    assert.equal(dom.window.document.documentElement.style.getPropertyValue('--vcp-ui-theme-bg-primary'), 'oklch(0.04 0.012 230)');
    assert.equal(dom.window.document.documentElement.style.getPropertyValue('--dsw-alias-border-inverted'), 'rgba(255, 255, 255, 0.06)');
    assert.equal(theme.listenerCount, 1);
    await scope.dispose('test-teardown');
    assert.equal(theme.listenerCount, 0);
    assert.equal(dom.window.document.documentElement.style.getPropertyValue('--vcp-ui-theme-bg-primary'), '');
    assert.equal(dom.window.document.documentElement.style.getPropertyValue('--dsw-alias-border-inverted'), '');
    theme.publish('light');
    assert.equal(root.dataset.themeEffective, 'dark', 'disposed consumer must ignore late theme updates');
    dom.window.close();
});

test('ThemeTokenOwner keeps document tokens while another presenter remains mounted', async () => {
    const dom = new JSDOM('<!doctype html><section id="a"></section><section id="b"></section>', { pretendToBeVisual: true });
    const theme = createThemeReadable();
    const scopeA = createUiScope(new LifecycleScope('theme-a'));
    const scopeB = createUiScope(new LifecycleScope('theme-b'));
    mountThemePresenter(dom.window.document.getElementById('a'), { theme }, { scope: scopeA, services: { theme } });
    mountThemePresenter(dom.window.document.getElementById('b'), { theme }, { scope: scopeB, services: { theme } });
    assert.notEqual(dom.window.document.documentElement.style.getPropertyValue('--vcp-ui-theme-bg-primary'), '');
    await scopeA.dispose('a-close');
    assert.notEqual(dom.window.document.documentElement.style.getPropertyValue('--vcp-ui-theme-bg-primary'), '', 'token remains while presenter B owns document');
    await scopeB.dispose('b-close');
    assert.equal(dom.window.document.documentElement.style.getPropertyValue('--vcp-ui-theme-bg-primary'), '');
    dom.window.close();
});
