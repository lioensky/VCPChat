const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'modules/topicListManager.js'), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function mountTopicList({ item, electronAPI }) {
    const dom = new JSDOM(`<!doctype html><html><body>
        <section id="tabContentTopics">
            <div class="topics-header"><input type="text" id="topicSearchInput"></div>
            <ul id="topicList" class="topic-list"></ul>
        </section>
    </body></html>`, { url: 'https://vcpchat.local/main.html', runScripts: 'outside-only' });
    const { window } = dom;
    window.requestAnimationFrame = callback => setTimeout(callback, 0);
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.eval(source);
    const configUpdates = [];
    window.topicListManager.init({
        elements: { topicListContainer: window.document.getElementById('tabContentTopics') },
        electronAPI,
        chatRepository: { getHistory: async () => [] },
        refs: {
            currentSelectedItemRef: { get: () => item },
            currentTopicIdRef: { get: () => null }
        },
        uiHelper: {},
        mainRendererFunctions: { updateCurrentItemConfig: config => configUpdates.push(config) },
        topicSelectionReadiness: { isReady: () => true, defer() {} }
    });
    window.topicListManager.setupTopicSearch();
    return { dom, window, list: window.document.getElementById('topicList'), configUpdates };
}

test('a rejected config IPC replaces the loading spinner with an error row', async () => {
    const { dom, window, list } = mountTopicList({
        item: { id: 'agent-a', type: 'agent', name: 'Alice' },
        electronAPI: { getAgentConfig: async () => { throw new Error('config read failed'); } }
    });
    await window.topicListManager.loadTopicList();
    assert.equal(list.querySelector('.loading-spinner-small'), null, 'spinner must not stay up after a rejection');
    assert.match(list.textContent, /config read failed/);
    window.topicListManager.dispose();
    dom.window.close();
});

test('item names and IPC errors render as text, not markup', async () => {
    const hostile = '<img src=x data-injected="name">';
    const { dom, window, list } = mountTopicList({
        item: { id: 'agent-a', type: 'agent', name: hostile },
        electronAPI: { getAgentConfig: async () => ({ error: '<b data-injected="error">boom</b>' }) }
    });
    await window.topicListManager.loadTopicList();
    assert.equal(list.querySelector('[data-injected]'), null, 'no element may be parsed out of a name or error');
    assert.ok(list.textContent.includes(hostile));
    assert.ok(list.textContent.includes('<b data-injected="error">boom</b>'));
    window.topicListManager.dispose();
    dom.window.close();
});

test('typing a search waits for a pause and reloads once', async () => {
    let configCalls = 0;
    let searchCalls = 0;
    const { dom, window, list } = mountTopicList({
        item: { id: 'agent-a', type: 'agent', name: 'Alice' },
        electronAPI: {
            getAgentConfig: async () => {
                configCalls++;
                return { topics: [{ id: 't1', name: 'alpha notes', createdAt: 1 }, { id: 't2', name: 'beta', createdAt: 2 }] };
            },
            searchTopicsByContent: async () => { searchCalls++; return { success: true, matchedTopicIds: [] }; }
        }
    });
    const input = window.document.getElementById('topicSearchInput');
    for (const value of ['a', 'al', 'alp', 'alph', 'alpha']) {
        input.value = value;
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
    }
    assert.equal(configCalls, 0, 'no IPC per keystroke');
    await wait(300);
    assert.equal(configCalls, 1, 'one reload after typing stops');
    assert.equal(searchCalls, 1, 'one content search for the final query');
    assert.deepEqual([...list.querySelectorAll('.topic-item')].map(li => li.dataset.topicId), ['t1']);
    window.topicListManager.dispose();
    dom.window.close();
});

test('Enter searches at once and cancels the pending debounced reload', async () => {
    let configCalls = 0;
    const { dom, window } = mountTopicList({
        item: { id: 'agent-a', type: 'agent', name: 'Alice' },
        electronAPI: {
            getAgentConfig: async () => { configCalls++; return { topics: [] }; },
            searchTopicsByContent: async () => ({ success: true, matchedTopicIds: [] })
        }
    });
    const input = window.document.getElementById('topicSearchInput');
    input.value = 'x';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(0);
    assert.equal(configCalls, 1);
    await wait(300);
    assert.equal(configCalls, 1, 'the earlier keystroke must not reload again');
    window.topicListManager.dispose();
    dom.window.close();
});
