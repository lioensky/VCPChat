const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'modules/itemListManager.js'), 'utf8');

test('the Agent and group list is one keyboard tab stop with arrow navigation and Enter to select', async () => {
    const dom = new JSDOM('<!doctype html><html><body><ul id="agentList"></ul></body></html>', {
        url: 'https://vcpchat.local/main.html', runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(source);
    const selected = [];
    let current = { id: 'nova', type: 'agent' };
    window.itemListManager.init({
        elements: { itemListUl: window.document.getElementById('agentList') },
        electronAPI: {
            getAgents: async () => [{ id: 'ada', name: 'Ada' }, { id: 'nova', name: 'Nova' }],
            getAgentGroups: async () => [{ id: 'council', name: 'Council' }],
            loadSettings: async () => ({ combinedItemOrder: [], vcpServerUrl: '' }),
            getUnreadTopicCounts: async () => ({ success: true, counts: {} }),
        },
        refs: { currentSelectedItemRef: { get: () => current, set() {} } },
        mainRendererFunctions: { selectItem: (id, type) => selected.push(`${type}:${id}`) },
        uiHelper: { showToastNotification() {} },
    });
    try {
        await window.itemListManager.loadItems();

        const doc = window.document;
        const items = () => [...doc.querySelectorAll('#agentList li[data-item-id]')];
        const key = (target, name) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
        const stops = () => items().filter(li => li.tabIndex === 0).map(li => li.dataset.itemId);

        assert.deepEqual(stops(), ['nova'], 'the selected Agent is the only tab stop');
        const nova = items().find(li => li.dataset.itemId === 'nova');
        nova.focus();
        key(nova, 'Home');
        assert.equal(doc.activeElement, items()[0]);
        key(doc.activeElement, 'ArrowDown');
        assert.equal(doc.activeElement, items()[1]);
        assert.deepEqual(stops(), [items()[1].dataset.itemId], 'the tab stop follows focus');
        key(doc.activeElement, 'End');
        assert.equal(doc.activeElement, items().at(-1));

        const target = doc.activeElement;
        key(target, 'Enter');
        assert.deepEqual(selected, [`${target.dataset.itemType}:${target.dataset.itemId}`]);

        items()[0].style.display = 'none';
        key(items()[1], 'ArrowUp');
        assert.notEqual(doc.activeElement, items()[0], 'items hidden by the search filter are skipped');
    } finally {
        dom.window.close();
    }
});

test('rebuilding the list keeps the active assistant search applied', async () => {
    const dom = new JSDOM('<!doctype html><html><body><input id="agentSearchInput"><ul id="agentList"></ul></body></html>', {
        url: 'https://vcpchat.local/main.html', runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(source);
    // The real filter lives in ui-helpers; this one hides by name the same way.
    window.uiHelperFunctions = {
        filterAgentList(term) {
            const needle = String(term).trim().toLowerCase();
            window.document.querySelectorAll('#agentList li').forEach(li => {
                const name = (li.querySelector('.agent-name')?.textContent || '').toLowerCase();
                li.style.display = !needle || name.includes(needle) ? '' : 'none';
            });
        }
    };
    window.itemListManager.init({
        elements: { itemListUl: window.document.getElementById('agentList') },
        electronAPI: {
            getAgents: async () => [{ id: 'ada', name: 'Ada' }, { id: 'nova', name: 'Nova' }],
            getAgentGroups: async () => [],
            loadSettings: async () => ({ combinedItemOrder: [], vcpServerUrl: '' }),
            getUnreadTopicCounts: async () => ({ success: true, counts: {} }),
        },
        refs: { currentSelectedItemRef: { get: () => null, set() {} } },
        mainRendererFunctions: { selectItem() {} },
        uiHelper: { showToastNotification() {} },
    });
    try {
        await window.itemListManager.loadItems();
        const input = window.document.getElementById('agentSearchInput');
        input.value = 'nov';
        window.uiHelperFunctions.filterAgentList(input.value);
        await window.itemListManager.loadItems();
        const visible = [...window.document.querySelectorAll('#agentList li[data-item-id]')]
            .filter(li => li.style.display !== 'none')
            .map(li => li.dataset.itemId);
        assert.deepEqual(visible, ['nova']);
    } finally {
        dom.window.close();
    }
});

test('a rejected catalog IPC shows an error instead of a permanent spinner', async () => {
    const dom = new JSDOM('<!doctype html><html><body><ul id="agentList"></ul></body></html>', {
        url: 'https://vcpchat.local/main.html', runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(source);
    window.itemListManager.init({
        elements: { itemListUl: window.document.getElementById('agentList') },
        electronAPI: {
            getAgents: async () => { throw new Error('agents dir unreadable'); },
            getAgentGroups: async () => [],
            loadSettings: async () => ({ combinedItemOrder: [], vcpServerUrl: '' }),
            getUnreadTopicCounts: async () => ({ success: true, counts: {} }),
        },
        refs: { currentSelectedItemRef: { get: () => null, set() {} } },
        mainRendererFunctions: { selectItem() {} },
        uiHelper: { showToastNotification() {} },
    });
    try {
        await window.itemListManager.loadItems();
        const list = window.document.getElementById('agentList');
        assert.equal(list.querySelector('.loading-spinner-small'), null);
        assert.match(list.textContent, /agents dir unreadable/);
    } finally {
        dom.window.close();
    }
});

test('reloading the list reuses the avatar URL so the browser cache can serve it', async () => {
    const dom = new JSDOM('<!doctype html><html><body><ul id="agentList"></ul></body></html>', {
        url: 'https://vcpchat.local/main.html', runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(source);
    const avatarUrl = 'file:///data/Agents/ada/avatar.png?v=1700000000000';
    window.itemListManager.init({
        elements: { itemListUl: window.document.getElementById('agentList') },
        electronAPI: {
            getAgents: async () => [{ id: 'ada', name: 'Ada', avatarUrl }],
            getAgentGroups: async () => [],
            loadSettings: async () => ({ combinedItemOrder: [], vcpServerUrl: '' }),
            getUnreadTopicCounts: async () => ({ success: true, counts: {} }),
        },
        refs: { currentSelectedItemRef: { get: () => ({ id: null }), set() {} } },
        mainRendererFunctions: { selectItem() {} },
        uiHelper: { showToastNotification() {} },
    });
    try {
        const src = () => window.document.querySelector('#agentList li[data-item-id="ada"] img.avatar').getAttribute('src');
        await window.itemListManager.loadItems();
        const first = src();
        await new Promise(resolve => setTimeout(resolve, 5));
        await window.itemListManager.loadItems();
        assert.equal(first, avatarUrl, 'the versioned URL from the main process is used as is');
        assert.equal(src(), first, 'a refresh does not force every avatar to download again');
    } finally {
        dom.window.close();
    }
});
