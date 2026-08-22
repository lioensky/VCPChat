import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMainChatSettingsOwner } from '../modules/renderer/mainChatSettingsOwner.js';
import { createDomListenerOwner } from '../modules/renderer/domListenerOwner.js';
import { createMainChatThemeOwner } from '../modules/renderer/mainChatThemeOwner.js';
import { createMainChatSettingsPresentationOwner } from '../modules/renderer/mainChatSettingsPresentationOwner.js';

test('settings owner publishes replacements and isolates snapshots', () => {
    const published = []; const owner = createMainChatSettingsOwner({ initial: { theme: 'dark' }, publish: value => published.push(value) });
    owner.update('theme', 'light');
    const copy = owner.snapshot();
    assert.equal(owner.get().theme, 'light'); assert.equal(copy.theme, 'light'); assert.equal(Object.isFrozen(copy), true); assert.equal(published.length, 1);
});

test('settings owner read copies cannot mutate nested authority state', () => {
    const owner = createMainChatSettingsOwner({ initial: { profile: { density: 'comfortable' }, rules: [{ enabled: true }] } });
    const borrowed = owner.get();
    borrowed.profile.density = 'compact';
    borrowed.rules[0].enabled = false;
    assert.deepEqual(owner.get(), { profile: { density: 'comfortable' }, rules: [{ enabled: true }] });
    const snapshot = owner.snapshot();
    assert.equal(Object.isFrozen(snapshot.profile), true);
    assert.equal(Object.isFrozen(snapshot.rules[0]), true);
});

test('disposed settings owner rejects further replacement', () => {
    const owner = createMainChatSettingsOwner({ initial: { enabled: true } }); owner.dispose(); owner.replace({ enabled: false }); assert.equal(owner.get().enabled, true);
});

test('DOM listener owner removes registrations and ignores late adds', () => {
    const added = []; const removed = []; const target = { addEventListener: (...args) => added.push(args), removeEventListener: (...args) => removed.push(args) };
    const owner = createDomListenerOwner(); const handler = () => {};
    assert.equal(owner.add(target, 'click', handler), true); owner.dispose(); assert.equal(owner.add(target, 'click', handler), false);
    assert.equal(added.length, 1); assert.equal(removed.length, 1); assert.equal(removed[0][1], handler);
});

test('DOM listener owner captures direct EventTarget registrations during assembly', () => {
    if (typeof EventTarget === 'undefined') return;
    const owner = createDomListenerOwner(); const target = new EventTarget(); const handler = () => {};
    const release = owner.capture(); target.addEventListener('click', handler); release(); owner.dispose();
    assert.doesNotThrow(() => target.dispatchEvent(new Event('click')));
});

test('DOM listener owner disposes observer-like resources', () => {
    let disconnected = 0; const owner = createDomListenerOwner(); owner.own({ disconnect() { disconnected += 1; } }); owner.dispose(); owner.dispose(); assert.equal(disconnected, 1);
});

test('DOM listener owner cancels pending timeout on dispose', async () => {
    let ran = false; const owner = createDomListenerOwner(); owner.timeout(() => { ran = true; }, 5); owner.dispose(); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(ran, false);
});

test('theme owner rolls back failed presentation persistence', async () => {
    const settings = { chatPresentationMode: 'bubble' };
    const classList = { values: new Set(), remove(...values) { values.forEach(value => this.values.delete(value)); }, add(value) { this.values.add(value); } };
    const owner = createMainChatThemeOwner({ settingsOwner: { get: () => settings, update: (key, value) => { settings[key] = value; } }, documentRef: { body: { classList, removeAttribute() {} } }, saveSettings: async () => ({ success: false, error: 'no' }), scheduleFrame: callback => callback(), notify() {} });
    const result = await owner.applyPresentation('panel', { persist: true });
    assert.equal(result.success, false); assert.equal(settings.chatPresentationMode, 'bubble'); assert.equal(classList.values.has('chat-presentation-bubble'), true);
});

test('theme owner rejects work after dispose', () => {
    const classList = { values: new Set(), remove() {}, add(value) { this.values.add(value); } }; const owner = createMainChatThemeOwner({ settingsOwner: { get: () => ({ chatPresentationMode: 'bubble' }), update() {} }, documentRef: { body: { classList, removeAttribute() {} } } }); owner.dispose(); owner.applyInitialTheme('dark'); assert.equal(classList.values.size, 0);
});

test('settings presentation owner reads the live authority and releases quick-switcher listeners', async () => {
    const dom = new JSDOM(`<!doctype html><html><body>
        <button aria-controls="presentation-options"></button>
        <div id="presentation-options" class="chat-presentation-quick-switcher">
            <button class="chat-presentation-quick-option" data-presentation-mode="bubble"></button>
            <button class="chat-presentation-quick-option" data-presentation-mode="panel"></button>
        </div>
    </body></html>`);
    const settingsOwner = createMainChatSettingsOwner({ initial: { chatPresentationMode: 'bubble' } });
    const listenerOwner = createDomListenerOwner();
    const calls = [];
    const owner = createMainChatSettingsPresentationOwner({
        documentRef: dom.window.document,
        settingsOwner,
        listenerOwner,
        chatAPI: {},
    });
    owner.configureThemeOwner({
        normalizePresentation: mode => mode,
        applyPresentation: async mode => { calls.push(mode); return { success: true, mode }; },
        applyInitialTheme() {},
    });

    settingsOwner.update('chatPresentationMode', 'panel');
    owner.setupPresentationQuickSwitcher();
    const panel = dom.window.document.querySelector('[data-presentation-mode="panel"]');
    assert.equal(panel.getAttribute('aria-checked'), 'true');
    panel.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['panel']);

    listenerOwner.dispose();
    panel.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['panel']);
    dom.window.close();
});

test('settings presentation owner waits for pending startup settings and suppresses projection after dispose', async () => {
    let resolveSettings;
    const pendingSettings = new Promise(resolve => { resolveSettings = resolve; });
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const settingsOwner = createMainChatSettingsOwner({ initial: { chatPresentationMode: 'bubble' } });
    const listenerOwner = createDomListenerOwner();
    const releases = [];
    const owner = createMainChatSettingsPresentationOwner({
        documentRef: dom.window.document,
        settingsOwner,
        listenerOwner,
        chatAPI: {},
    });
    owner.configureThemeOwner({
        normalizePresentation: mode => mode || 'bubble',
        applyPresentation: async mode => ({ success: true, mode }),
        applyInitialTheme() {},
    });
    owner.configureStartup({
        loadSettings: () => pendingSettings,
        startupThemeGate: { release: value => releases.push(value) },
    });

    const loading = owner.loadAndApply();
    await new Promise(resolve => setImmediate(resolve));
    let disposed = false;
    const disposing = owner.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposed, false);
    resolveSettings({ chatPresentationMode: 'panel', sidebarWidth: 400 });
    await Promise.all([loading, disposing]);
    assert.equal(settingsOwner.get().chatPresentationMode, 'bubble');
    assert.deepEqual(releases, []);
    await owner.dispose();
    listenerOwner.dispose();
    dom.window.close();
});
