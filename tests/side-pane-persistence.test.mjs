import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { defineChatTabType } from '../modules/ui-system/side-pane/tab-types/chat.js';
import {
    PARENT_MEMORY_LIMIT, MAX_PERSISTED_TAB_CHARS, SIDE_PANE_LAYOUT_VERSION,
    parseLayout, rememberBounded, serializeLayout, sanitizeTab
} from '../modules/ui-system/side-pane/side-pane-persistence.js';

const canPersist = kind => kind === 'notes' || kind === 'browser';

test('rememberBounded keeps only the most recently touched keys', () => {
    const map = new Map();
    for (let i = 0; i < PARENT_MEMORY_LIMIT + 5; i++) rememberBounded(map, `p${i}`, i);
    assert.equal(map.size, PARENT_MEMORY_LIMIT);
    assert.equal(map.has('p0'), false);
    rememberBounded(map, 'p5', 'again');
    rememberBounded(map, 'new', 1);
    assert.equal(map.has('p5'), true, 'touching a key refreshes it');
    assert.equal(map.has('p6'), false);
});

test('sanitizeTab drops ephemeral, unknown, unserializable and oversized tabs', () => {
    assert.equal(sanitizeTab({ id: 'c', kind: 'chat', title: 'x' }, canPersist), null);
    assert.equal(sanitizeTab({ id: 'n', kind: 'notes', ephemeral: true }, canPersist), null);
    assert.equal(sanitizeTab({ id: 'n', kind: 'notes', payload: [] }, canPersist), null);
    assert.equal(sanitizeTab({ id: 'n', kind: 'notes', scopeMode: 'topic' }, canPersist), null, 'topic tab needs a parent');
    assert.equal(sanitizeTab({ id: 'b', kind: 'browser', payload: { html: 'x'.repeat(MAX_PERSISTED_TAB_CHARS) } }, canPersist), null);

    const tab = sanitizeTab({
        id: 'b', kind: 'browser', title: 'Docs', closable: true, scopeMode: 'global',
        payload: { url: 'https://example.com' }, handle: { secret: true }, openedAt: 5
    }, canPersist);
    assert.deepEqual(tab, { id: 'b', kind: 'browser', title: 'Docs', closable: true, scopeMode: 'global', openedAt: 5, payload: { url: 'https://example.com' } });
});

test('parseLayout rejects other versions and broken JSON and filters entries', () => {
    assert.equal(parseLayout('{', canPersist), null);
    assert.equal(parseLayout(JSON.stringify({ version: 99, tabs: [] }), canPersist), null);
    assert.equal(parseLayout(null, canPersist), null);

    const layout = parseLayout(JSON.stringify({
        version: SIDE_PANE_LAYOUT_VERSION,
        tabs: [{ id: 'n', kind: 'notes' }, { id: 'n', kind: 'notes' }, { id: 'x', kind: 'gone' }, 'junk'],
        activeByParent: [['a', 'n'], ['b', 3], 'junk'],
        collapsedByParent: [['a', false], ['b', 'no']]
    }), canPersist);
    assert.deepEqual(layout.tabs.map(t => t.id), ['n']);
    assert.deepEqual([...layout.activeByParent], [['a', 'n']]);
    assert.deepEqual([...layout.collapsedByParent], [['a', false]]);
});

test('serializeLayout round-trips through parseLayout', () => {
    const data = serializeLayout({
        tabs: [{ id: 'notifications', kind: 'notifications' }, { id: 'n', kind: 'notes', title: '笔记' }],
        activeByParent: new Map([['k', 'n']]),
        collapsedByParent: new Map([['k', true]])
    }, canPersist);
    const parsed = parseLayout(JSON.stringify(data), canPersist);
    assert.deepEqual(parsed.tabs, [{ id: 'n', kind: 'notes', title: '笔记' }]);
    assert.equal(parsed.collapsedByParent.get('k'), true);
});

function createStorage() {
    const data = new Map();
    return { data, getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)) };
}

function createPane(storage, mounts) {
    const dom = new JSDOM(`
        <div class="main-content"></div>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar"><div class="side-pane-tabs"></div></header>
            <div class="side-pane-content-container"></div>
        </aside>
    `);
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const provider = kind => ({
        mountTab(tab) {
            mounts.push({ kind, id: tab.id, payload: tab.payload });
            return { dispose() {} };
        }
    });
    const controller = createSidePaneController({
        root,
        tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container'),
        persistence: { storage },
        tabTypes: [
            { kind: 'notes', label: '笔记', provider: provider('notes') },
            { kind: 'browser', label: '浏览器', provider: provider('browser') },
            { kind: 'terminal', label: '终端', persist: false, provider: provider('terminal') },
            defineChatTabType({ provider: { mountTab: () => ({ dispose() {} }) } })
        ]
    });
    return { dom, controller };
}

test('controller saves the layout and lazily restores it after a restart', async () => {
    const storage = createStorage();
    const parent = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-1' };

    const first = createPane(storage, []);
    first.controller.restoreLayout();
    first.controller.setParent(parent);
    await first.controller.openTab({ id: 'notes', kind: 'notes', title: '笔记', closable: true, scopeMode: 'global' });
    await first.controller.openTab({ id: 'browser:1', kind: 'browser', title: '浏览器', closable: true, scopeMode: 'global', payload: {} });
    first.controller.updateTab('browser:1', { payload: { url: 'https://example.com/' } });
    await first.controller.openTab({ id: 'terminal', kind: 'terminal', title: '终端', closable: true, scopeMode: 'global' });
    await first.controller.openTab({ kind: 'chat', descriptor: {
        id: 'side-1', parent, child: { itemType: 'agent', itemId: 'agent-1', topicId: 'child-1' }, title: '辅助'
    } });
    first.controller.activateTab('browser:1');
    await first.controller.dispose(); // flushes the pending save
    first.dom.window.close();

    const saved = JSON.parse(storage.data.get('vcp.sidePane.layout.v1'));
    assert.deepEqual(saved.tabs.map(t => t.id), ['notes', 'browser:1'], 'terminal and chat tabs are not persisted');

    const mounts = [];
    const second = createPane(storage, mounts);
    assert.equal(second.controller.restoreLayout(), true);
    assert.deepEqual(second.controller.getSnapshot().tabs.map(t => t.id), ['notifications', 'notes', 'browser:1']);
    assert.equal(second.controller.getSnapshot().visible, true, 'the pane was expanded when the app closed');
    assert.equal(second.controller.getSnapshot().activeTabId, 'browser:1');

    second.controller.setParent(parent);
    assert.equal(second.controller.getSnapshot().activeTabId, 'browser:1', 'global tools survive the conversation switch');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(mounts, [{ kind: 'browser', id: 'browser:1', payload: { url: 'https://example.com/' } }], 'only the shown tab is mounted');

    second.controller.activateTab('notes');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(mounts.map(m => m.id), ['browser:1', 'notes']);

    await second.controller.dispose();
    second.dom.window.close();
});

test('nothing is written before restoreLayout runs, so an early render cannot wipe the saved layout', async () => {
    const storage = createStorage();
    storage.setItem('vcp.sidePane.layout.v1', JSON.stringify({ version: 1, tabs: [{ id: 'notes', kind: 'notes' }] }));
    const pane = createPane(storage, []);
    await pane.controller.openTab({ id: 'browser:1', kind: 'browser', title: '浏览器', closable: true, scopeMode: 'global' });
    await pane.controller.dispose();
    pane.dom.window.close();
    assert.deepEqual(JSON.parse(storage.data.get('vcp.sidePane.layout.v1')).tabs.map(t => t.id), ['notes']);
});

test('restoring after the host picked the conversation mounts nothing from another topic and does not animate', async () => {
    const storage = createStorage();
    const topicA = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-a' };
    const topicB = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-b' };

    const first = createPane(storage, []);
    first.controller.restoreLayout();
    first.controller.setParent(topicA);
    await first.controller.openTab({ id: 'notes:a', kind: 'notes', title: '笔记', closable: true, scopeMode: 'topic', parent: topicA });
    first.controller.setParent(topicB);
    first.controller.setVisible(false);
    first.controller.setParent(topicA);
    await first.controller.dispose();
    first.dom.window.close();

    const mounts = [];
    const second = createPane(storage, mounts);
    // 宿主先同步当前对话（话题 B），再恢复存档
    second.controller.setParent(topicB);
    assert.equal(second.controller.restoreLayout(), true);
    await new Promise(resolve => setTimeout(resolve, 0));
    const root = second.dom.window.document.getElementById('vcpSidePane');
    assert.deepEqual(mounts, [], 'the topic A tab is not mounted while topic B is shown');
    assert.equal(root.classList.contains('is-animating'), false);
    assert.equal(second.controller.getSnapshot().visible, false, 'topic B was left collapsed');

    second.controller.setParent(topicA);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(mounts.map(m => m.id), ['notes:a']);
    await second.controller.dispose();
    second.dom.window.close();
});

test('a layout over the total budget drops the oldest large tabs but keeps the active one', async () => {
    const { MAX_PERSISTED_LAYOUT_CHARS } = await import('../modules/ui-system/side-pane/side-pane-persistence.js');
    const big = i => ({ id: `diff:${i}`, kind: 'notes', title: `d${i}`, payload: { oldCode: 'x'.repeat(60 * 1024), n: i } });
    const tabs = Array.from({ length: 20 }, (_, i) => big(i));
    const data = serializeLayout({ tabs, activeTabId: 'diff:0' }, canPersist);
    assert.ok(JSON.stringify(data).length <= MAX_PERSISTED_LAYOUT_CHARS + 1024);
    assert.equal(data.activeTabId, 'diff:0', 'the active tab survives even though it is the oldest');
    assert.ok(data.tabs.some(tab => tab.id === 'diff:19'), 'the newest tabs are kept');
    assert.equal(data.tabs.some(tab => tab.id === 'diff:1'), false, 'older tabs are dropped first');
});

test('a quota error still saves the tab list and conversation memory without the large tabs', async () => {
    const { createSidePaneLayoutStore } = await import('../modules/ui-system/side-pane/side-pane-persistence.js');
    const data = new Map();
    const storage = {
        getItem: key => data.get(key) ?? null,
        setItem(key, value) {
            if (value.length > 8 * 1024) throw new Error('QuotaExceededError');
            data.set(key, value);
        }
    };
    const layout = serializeLayout({
        tabs: [{ id: 'small', kind: 'notes', title: 's' }, { id: 'large', kind: 'notes', title: 'l', payload: { code: 'x'.repeat(20 * 1024) } }],
        activeTabId: 'large',
        collapsedByParent: new Map([['agent:a', true]])
    }, canPersist);
    const store = createSidePaneLayoutStore({ storage, getLayout: () => layout });
    store.flush();
    const saved = parseLayout(store.load(), canPersist);
    assert.deepEqual(saved.tabs.map(tab => tab.id), ['small']);
    assert.equal(saved.activeTabId, null);
    assert.equal(saved.collapsedByParent.get('agent:a'), true);
    store.dispose();
});
