const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function source(path) { return fs.readFileSync(path, 'utf8'); }

test('appearance and theme expose explicit authoritative subscriptions', async () => {
    const dom = new JSDOM('<!doctype html><html><body class="light-theme"></body></html>', {
        url: 'https://vcpchat.local/main.html', runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(source('modules/ui-system/state-channel.js'));
    window.chatAPI = {};
    window.eval(source('modules/services/windowStateService.js'));
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
        ['appearance', 'main-window', 'theme']
    );
    dom.window.close();
});

test('notification filter queries are safe before settings capability initialization', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://vcpchat.local/main.html', runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(source('modules/ui-system/state-channel.js'));
    window.eval(source('modules/filterManager.js'));

    assert.equal(
        window.filterManager.checkMessageFilter('early VCP log'),
        null,
        'notifications must fail open before settings are ready'
    );
    assert.equal(
        window.filterManager.checkToolAutoApproval({ toolName: 'EarlyTool' }),
        null,
        'tool approval must fail closed before settings are ready'
    );
    assert.equal(window.filterManager.isFilterEnabled(), false);

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

test('assistant catalog rejects stale load completion without a test-only state channel', async () => {
    const dom = new JSDOM('<!doctype html><html><body><ul id="agentList"></ul></body></html>', {
        url: 'https://vcpchat.local/main.html', runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(source('modules/itemListManager.js'));
    const current = { value: null };
    let resolveFirst;
    let request = 0;
    const firstAgents = new Promise(resolve => { resolveFirst = resolve; });
    window.itemListManager.init({
        elements: { itemListUl: window.document.getElementById('agentList') },
        electronAPI: {
            getAgents: async () => ++request === 1 ? firstAgents : [{ id: 'nova', name: 'Nova' }],
            getAgentGroups: async () => [],
            loadSettings: async () => ({ combinedItemOrder: [], vcpServerUrl: '' }),
            getUnreadTopicCounts: async () => ({ success: true, counts: {} }),
        },
        refs: { currentSelectedItemRef: { get: () => current.value, set: value => { current.value = value; } } },
        mainRendererFunctions: { selectItem() {} },
        uiHelper: { showToastNotification() {} },
    });
    const staleLoad = window.itemListManager.loadItems();
    const currentLoad = window.itemListManager.loadItems();
    await currentLoad;
    resolveFirst([{ id: 'stale', name: 'Stale' }]);
    await staleLoad;
    assert.equal(window.document.querySelector('[data-item-id="nova"]')?.dataset.itemId, 'nova');
    assert.equal(window.document.querySelector('[data-item-id="stale"]'), null);
    dom.window.close();
});


test('assistant catalog preserves per-item speaking indicators across concurrent streams and rerenders', async () => {
    const dom = new JSDOM('<!doctype html><html><body><ul id="agentList"></ul></body></html>', {
        url: 'https://vcpchat.local/main.html', runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(source('modules/itemListManager.js'));
    const electronAPI = {
        getAgents: async () => [{ id: 'nova', name: 'Nova' }],
        getAgentGroups: async () => [{ id: 'council', name: 'Council' }],
        loadSettings: async () => ({ combinedItemOrder: [], vcpServerUrl: '' }),
        getUnreadTopicCounts: async () => ({ success: true, counts: {} }),
    };
    window.itemListManager.init({
        elements: { itemListUl: window.document.getElementById('agentList') },
        electronAPI,
        refs: { currentSelectedItemRef: { get: () => null, set() {} } },
        mainRendererFunctions: { selectItem() {} },
        uiHelper: { showToastNotification() {} },
    });
    await window.itemListManager.loadItems();

    const event = (type, messageId, context) => ({ type, messageId, context });
    const groupContext = { groupId: 'council', topicId: 'topic-a', isGroupMessage: true };
    window.itemListManager.consumeStreamActivityEvent(event('agent_thinking', 'group-stream-1', groupContext));
    window.itemListManager.consumeStreamActivityEvent(event('start', 'group-stream-2', groupContext));

    let groupItem = window.document.querySelector('[data-item-id="council"][data-item-type="group"]');
    assert.equal(groupItem.classList.contains('is-stream-speaking'), true);
    assert.equal(groupItem.dataset.activeStreamCount, '2');
    assert.equal(groupItem.querySelectorAll('.stream-speaking-bar').length, 3);
    assert.equal(groupItem.querySelector('.stream-speaking-indicator').hidden, false);

    window.itemListManager.consumeStreamActivityEvent(event('end', 'group-stream-1', groupContext));
    assert.equal(groupItem.classList.contains('is-stream-speaking'), true, 'one completed stream must not hide another');
    assert.equal(groupItem.dataset.activeStreamCount, '1');

    await window.itemListManager.loadItems();
    groupItem = window.document.querySelector('[data-item-id="council"][data-item-type="group"]');
    assert.equal(groupItem.classList.contains('is-stream-speaking'), true, 'rerender must restore active background stream');

    window.itemListManager.consumeStreamActivityEvent(event('error', 'group-stream-2', groupContext));
    assert.equal(groupItem.classList.contains('is-stream-speaking'), false);
    assert.equal(groupItem.dataset.activeStreamCount, '0');
    assert.equal(groupItem.querySelector('.stream-speaking-indicator').hidden, true);

    const agentContext = { agentId: 'nova', topicId: 'topic-b', isGroupMessage: false };
    window.itemListManager.consumeStreamActivityEvent(event('data', 'agent-stream-1', agentContext));
    const agentItem = window.document.querySelector('[data-item-id="nova"][data-item-type="agent"]');
    assert.equal(agentItem.classList.contains('is-stream-speaking'), true);
    window.itemListManager.consumeStreamActivityEvent(event('full_response', 'agent-stream-1', agentContext));
    assert.equal(agentItem.classList.contains('is-stream-speaking'), false);

    dom.window.close();
});


for (const scenario of [
    { name: 'old agents', agents: [{ id: 'old-a', name: 'Old' }], groups: [] },
    { name: 'old empty list', agents: [], groups: [] },
    { name: 'old catalog errors', agents: { error: 'old-agent-error' }, groups: { error: 'old-group-error' } },
    { name: 'old settings rejection', agents: [{ id: 'old-a', name: 'Old' }], groups: [], rejectSettings: true },
]) {
    test('settings wait cannot publish superseded assistant catalogs: ' + scenario.name, async () => {
        const dom = new JSDOM('<!doctype html><ul id="agentList"></ul>', {
            url: 'https://vcpchat.local/main.html', runScripts: 'outside-only'
        });
        const { window } = dom;
        let resolveSettings, rejectSettings, reachedSettings;
        const waiting = new Promise(resolve => { reachedSettings = resolve; });
        const lateSettings = new Promise((resolve, reject) => { resolveSettings = resolve; rejectSettings = reject; });
        let settingsReads = 0, agentReads = 0, groupReads = 0, unreadReads = 0;
        const currentSettings = {
            vcpServerUrl: '', combinedItemOrder: [
                { id: 'current-b', type: 'agent' }, { id: 'current-group', type: 'group' }
            ]
        };
        try {
            window.eval(source('modules/itemListManager.js'));
            window.itemListManager.init({
                elements: { itemListUl: window.document.getElementById('agentList') },
                electronAPI: {
                    getAgents: async () => ++agentReads === 1 ? scenario.agents : [{ id: 'current-b', name: 'Current' }],
                    getAgentGroups: async () => ++groupReads === 1 ? scenario.groups : [{ id: 'current-group', name: 'Current group' }],
                    // init reads persona settings first; pause only the old catalog's ordering read.
                    loadSettings: () => ++settingsReads === 2 ? (reachedSettings(), lateSettings) : Promise.resolve(currentSettings),
                    getUnreadTopicCounts: async () => { unreadReads++; return { success: true, counts: {} }; },
                },
                refs: { currentSelectedItemRef: { get: () => ({ id: 'current-b', type: 'agent' }) } },
                mainRendererFunctions: { selectItem() {} }, uiHelper: { showToastNotification() {} },
            });
            const oldLoad = window.itemListManager.loadItems();
            await waiting;
            await window.itemListManager.loadItems();
            const list = window.document.getElementById('agentList');
            const currentRow = list.querySelector('[data-item-id="current-b"]');
            assert.ok(currentRow?.classList.contains('active'));
            const currentHTML = list.innerHTML;
            const currentIds = ['agent:current-b', 'group:current-group'];
            const cachedIds = () => Array.from(window.itemListManager.getLoadedItems(), item => item.type + ':' + item.id);
            assert.deepEqual(cachedIds(), currentIds, 'the latest settings order must be applied');
            assert.equal(unreadReads, 1);

            if (scenario.rejectSettings) rejectSettings(new Error('old settings failed'));
            else resolveSettings({ vcpServerUrl: '', combinedItemOrder: [] });
            await oldLoad;
            assert.equal(list.innerHTML, currentHTML, 'late success, empty, error or fallback must not replace the current view');
            assert.equal(list.querySelector('[data-item-id="current-b"]'), currentRow, 'keep the active row and its DOM identity');
            assert.deepEqual(cachedIds(), currentIds, 'public cache must still match the current list');
            assert.equal(unreadReads, 1, 'a discarded catalog must not launch another follow-up refresh');
        } finally {
            resolveSettings({});
            dom.window.close();
        }
    });
}

test('current assistant catalog keeps its normal fallback when ordering settings fail', async () => {
    const dom = new JSDOM('<!doctype html><ul id="agentList"></ul>', {
        url: 'https://vcpchat.local/main.html', runScripts: 'outside-only'
    });
    const { window } = dom;
    let settingsReads = 0;
    try {
        window.eval(source('modules/itemListManager.js'));
        window.itemListManager.init({
            elements: { itemListUl: window.document.getElementById('agentList') },
            electronAPI: {
                getAgents: async () => [{ id: 'z', name: 'Zed' }, { id: 'a', name: 'Ada' }],
                getAgentGroups: async () => [{ id: 'group', name: 'Group' }],
                loadSettings: async () => {
                    if (++settingsReads === 2) throw new Error('ordering unavailable');
                    return { vcpServerUrl: '' };
                },
                getUnreadTopicCounts: async () => ({ success: true, counts: {} }),
            },
            refs: { currentSelectedItemRef: { get: () => null } },
            mainRendererFunctions: { selectItem() {} }, uiHelper: { showToastNotification() {} },
        });
        await window.itemListManager.loadItems();
        const expected = ['group:group', 'agent:a', 'agent:z'];
        assert.deepEqual(Array.from(window.itemListManager.getLoadedItems(), item => item.type + ':' + item.id), expected);
        assert.deepEqual(Array.from(window.document.querySelectorAll('li[data-item-id]'), row => row.dataset.itemType + ':' + row.dataset.itemId), expected);
    } finally { dom.window.close(); }
});

const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture() {
    const dom = new JSDOM(`<!doctype html><body class="light-theme">
        <aside class="sidebar"><div id="tabContentAgents"><ul id="agentList"></ul></div>
        <div id="tabContentTopics"></div></aside></body>`, {
        url: 'https://vcpchat.local/main.html', runScripts: 'outside-only'
    });
    const { window } = dom;
    const pending = [];
    const errors = [];
    let deferred = false;
    window.console = { log() {}, warn() {}, debug() {}, error: (...args) => errors.push(args) };
    const api = {
        getAgents: async () => [{ id: 'nova', name: 'Nova' }],
        getAgentGroups: async () => [],
        loadSettings: async () => ({ vcpServerUrl: '' }),
        setTheme() {},
        getUnreadTopicCounts: () => deferred ? new Promise((resolve, reject) => {
            pending.push({ resolve, reject });
        }) : Promise.resolve({ success: true, counts: { nova: 3 } })
    };
    window.eval(fs.readFileSync('modules/itemListManager.js', 'utf8'));
    window.eval(fs.readFileSync('modules/uiManager.js', 'utf8'));
    const listConfig = {
        elements: { itemListUl: window.document.getElementById('agentList') },
        electronAPI: api,
        refs: { currentSelectedItemRef: { get: () => null } },
        mainRendererFunctions: { selectItem() {} }, uiHelper: { showToastNotification() {} }
    };
    const uiConfig = {
        electronAPI: api, itemListManager: window.itemListManager,
        refs: { globalSettingsRef: { get: () => ({ currentThemeMode: 'light' }) } },
        listenerOwner: { capture: () => () => {} },
        elements: {
            leftSidebar: window.document.querySelector('.sidebar'),
            sidebarTabButtons: [],
            sidebarTabContents: [...window.document.querySelectorAll('[id^="tabContent"]')]
        }
    };
    window.itemListManager.init(listConfig);
    await window.itemListManager.loadItems();
    await window.uiManager.init(uiConfig);
    await settle();
    deferred = true;
    return {
        window, pending, errors, listConfig, uiConfig,
        refresh: owner => owner === 'ui' ? window.uiManager.switchToTab('agents') : window.itemListManager.refreshUnreadCounts(),
        badge: () => window.document.querySelector('[data-item-id="nova"] .unread-badge'),
        async close() {
            for (const request of pending) request.resolve({ success: false });
            await settle();
            await window.uiManager.dispose();
            dom.window.close();
        }
    };
}

for (const [olderOwner, newerOwner] of [['list', 'list'], ['ui', 'list'], ['list', 'ui'], ['ui', 'ui']]) {
    for (const oldCounts of [{ nova: 9 }, {}]) {
        test(`${olderOwner} -> ${newerOwner}: late ${oldCounts.nova ? 'count' : 'empty'} cannot overwrite current badge`, async () => {
            const f = await fixture();
            try {
                f.refresh(olderOwner);
                f.refresh(newerOwner);
                assert.equal(f.pending.length, 2);
                f.pending[1].resolve({ success: true, counts: { nova: 1 } });
                await settle();
                const currentBadge = f.badge();
                assert.equal(currentBadge.textContent, '1');
                f.pending[0].resolve({ success: true, counts: oldCounts });
                await settle();
                assert.equal(f.badge(), currentBadge, 'preserve the current badge node');
                assert.equal(f.badge().textContent, '1');
            } finally { await f.close(); }
        });
    }
}

for (const failure of ['unsuccessful', 'rejection']) {
    test(`latest ${failure} keeps displayed badge and still supersedes an older response`, async () => {
        const f = await fixture();
        try {
            f.refresh('ui');
            const latest = f.refresh('list');
            if (failure === 'rejection') f.pending[1].reject(new Error('unread request failed'));
            else f.pending[1].resolve({ success: false });
            await latest;
            await settle();
            assert.equal(f.badge().textContent, '3');
            f.pending[0].resolve({ success: true, counts: { nova: 9 } });
            await settle();
            assert.equal(f.badge().textContent, '3');
            if (failure === 'rejection') {
                assert.equal(f.errors.filter(args => args.some(value => value?.message === 'unread request failed')).length, 1);
            }
        } finally { await f.close(); }
    });
}

test('current zero displays a dot and current empty counts remove it', async () => {
    const f = await fixture();
    try {
        f.refresh('ui');
        f.pending[0].resolve({ success: true, counts: { nova: 0 } });
        await settle();
        assert.equal(f.badge().textContent, '');
        assert.ok(f.badge().classList.contains('unread-badge-dot-only'));
        const latest = f.refresh('list');
        f.pending[1].resolve({ success: true, counts: {} });
        await latest;
        await settle();
        assert.equal(f.badge(), null);
    } finally { await f.close(); }
});

test('catalog rerender with the same agent ID supersedes counts for the previous rows', async () => {
    const f = await fixture();
    try {
        f.refresh('ui');
        const previousRow = f.badge().closest('li');
        await f.window.itemListManager.loadItems();
        f.pending[1].resolve({ success: true, counts: { nova: 1 } });
        await settle();
        assert.notEqual(f.badge().closest('li'), previousRow);
        f.pending[0].resolve({ success: true, counts: { nova: 9 } });
        await settle();
        assert.equal(f.badge().textContent, '1');
    } finally { await f.close(); }
});

test('UI disposal revokes its pending count publication without revoking a later list refresh', async () => {
    const f = await fixture();
    try {
        f.refresh('ui');
        await f.window.uiManager.dispose();
        f.pending[0].resolve({ success: true, counts: { nova: 9 } });
        await settle();
        assert.equal(f.badge().textContent, '3');
        const latest = f.refresh('list');
        f.pending[1].resolve({ success: true, counts: { nova: 1 } });
        await latest;
        await settle();
        assert.equal(f.badge().textContent, '1');
    } finally { await f.close(); }
});

test('UI reinitialization revokes its previous pending request even if the new lifecycle starts no refresh', async () => {
    const f = await fixture();
    try {
        f.refresh('ui');
        await f.window.uiManager.init({ ...f.uiConfig, elements: { ...f.uiConfig.elements, sidebarTabContents: [] } });
        assert.equal(f.pending.length, 1);
        f.pending[0].resolve({ success: true, counts: { nova: 9 } });
        await settle();
        assert.equal(f.badge().textContent, '3');
    } finally { await f.close(); }
});

test('list reinitialization revokes count requests from the previous API', async () => {
    const f = await fixture();
    try {
        f.refresh('list');
        f.window.itemListManager.init(f.listConfig);
        f.pending[0].resolve({ success: true, counts: { nova: 9 } });
        await settle();
        assert.equal(f.badge().textContent, '3');
    } finally { await f.close(); }
});
