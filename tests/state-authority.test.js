const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function source(path) { return fs.readFileSync(path, 'utf8'); }

test('UI mode, appearance and theme expose explicit authoritative subscriptions', async () => {
    const dom = new JSDOM('<!doctype html><html><body class="light-theme"></body></html>', {
        url: 'https://vcpchat.local/main.html', runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(source('modules/ui-system/state-channel.js'));
    window.chatAPI = {};
    window.eval(source('modules/services/windowStateService.js'));
    window.eval(source('modules/uiModeManager.js'));
    const modes = [];
    const unsubscribeMode = window.uiModeManager.subscribe(state => modes.push(state.mode));
    window.uiModeManager.apply('next');
    assert.deepEqual(modes, ['next']);
    unsubscribeMode();

    window.eval(source('modules/ui-system/appearance-engine.js'));
    const appearances = [];
    const unsubscribeAppearance = window.VCPAppearance.subscribe(state => appearances.push(state.revision));
    window.VCPAppearance.commit({ density: 'compact' }, { uiMode: 'next', source: 'test' });
    assert.deepEqual(appearances, [0, 1]);
    unsubscribeAppearance();

    window.eval(source('modules/uiManager.js'));
    const themes = [];
    const unsubscribeTheme = window.uiManager.subscribeTheme(state => themes.push(state.effective));
    window.uiManager.applyTheme('dark');
    assert.deepEqual(themes, ['light', 'dark']);
    unsubscribeTheme();
    assert.deepEqual(
        Array.from(window.VCPStateChannels.diagnostics(), item => String(item.name)).sort(),
        ['appearance', 'main-window', 'theme', 'ui-mode']
    );
    dom.window.close();
});

test('notification filter publishes committed and rolled-back state exactly once', async () => {
    const dom = new JSDOM('<!doctype html><html><body><button id="doNotDisturbBtn"></button></body></html>', {
        url: 'https://vcpchat.local/main.html', runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(source('modules/ui-system/state-channel.js'));
    window.eval(source('modules/filterManager.js'));
    let settings = { filterEnabled: false, filterRules: [], toolAutoApprovalRules: [], toolAutoApprovalEnabled: false };
    let failSave = false;
    window.filterManager.init({
        electronAPI: { saveSettings: async () => failSave ? { success: false, error: 'denied' } : { success: true } },
        uiHelper: { openModal() {}, closeModal() {}, showToastNotification() {} },
        refs: { globalSettingsRef: { get: () => settings, set: value => { settings = value; } } },
    });
    const states = [];
    const events = [];
    const unsubscribe = window.filterManager.subscribe(state => states.push(state.enabled));
    window.addEventListener('notification-filter-changed', event => events.push(event.detail.enabled));
    const committed = await window.filterManager.toggleFilterMode();
    assert.equal(committed.success, true);
    assert.equal(committed.enabled, true);
    failSave = true;
    const rolledBack = await window.filterManager.toggleFilterMode();
    assert.equal(rolledBack.success, false);
    assert.equal(rolledBack.enabled, true);
    assert.equal(rolledBack.error, 'denied');
    assert.deepEqual(states, [false, true]);
    assert.deepEqual(events, [true, true]);
    unsubscribe();
    dom.window.close();
});

test('assistant catalog publishes loading and authoritative completion without DOM scanning', async () => {
    const dom = new JSDOM('<!doctype html><html><body><ul id="agentList"></ul></body></html>', {
        url: 'https://vcpchat.local/main.html', runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(source('modules/ui-system/state-channel.js'));
    window.eval(source('modules/ui-system/settlement.js'));
    window.eval(source('modules/itemListManager.js'));
    const current = { value: null };
    let resolveAgents;
    const agents = new Promise(resolve => { resolveAgents = resolve; });
    window.itemListManager.init({
        elements: { itemListUl: window.document.getElementById('agentList') },
        electronAPI: {
            getAgents: async () => agents,
            getAgentGroups: async () => [],
            loadSettings: async () => ({ combinedItemOrder: [], vcpServerUrl: '' }),
            getUnreadTopicCounts: async () => ({ success: true, counts: {} }),
        },
        refs: { currentSelectedItemRef: { get: () => current.value, set: value => { current.value = value; } } },
        mainRendererFunctions: { selectItem() {} },
        uiHelper: { showToastNotification() {} },
    });
    const statuses = [];
    const unsubscribe = window.itemListManager.subscribe(state => statuses.push([state.status, state.items.length]));
    const loading = window.itemListManager.loadItems();
    const boundary = window.itemListManager.getCatalogSnapshot().revision;
    const settled = window.itemListManager.whenSettled({ afterRevision: boundary });
    resolveAgents([{ id: 'nova', name: 'Nova' }]);
    await loading;
    const settledSnapshot = await settled;
    assert.equal(settledSnapshot.value.status, 'ready');
    assert.deepEqual(statuses, [['idle', 0], ['loading', 0], ['ready', 1]]);
    assert.equal(window.itemListManager.getCatalogState().items[0].id, 'nova');
    unsubscribe();
    dom.window.close();
});
