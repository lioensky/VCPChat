const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'modules/topicListManager.js'), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function mountTopics() {
    const dom = new JSDOM(`<!doctype html><html><body>
        <section id="tabContentTopics">
            <div class="topics-header"><input type="text" id="topicSearchInput"></div>
            <ul id="topicList" class="topic-list"></ul>
        </section>
    </body></html>`, { url: 'https://vcpchat.local/main.html', runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    window.requestAnimationFrame = callback => setTimeout(callback, 0);
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.eval(source);
    const selected = [];
    window.topicListManager.init({
        elements: { topicListContainer: window.document.getElementById('tabContentTopics') },
        electronAPI: {
            getAgentConfig: async () => ({
                id: 'agent-a',
                topics: [
                    { id: 't1', name: 'one', createdAt: 1 },
                    { id: 't2', name: 'two', createdAt: 2 },
                    { id: 't3', name: 'three', createdAt: 3 }
                ]
            })
        },
        chatRepository: { getHistory: async () => [] },
        refs: {
            currentSelectedItemRef: { get: () => ({ id: 'agent-a', type: 'agent', name: 'Alice' }) },
            currentTopicIdRef: { get: () => 't2' }
        },
        uiHelper: { showToastNotification() {} },
        mainRendererFunctions: { updateCurrentItemConfig() {}, selectTopic: id => { selected.push(id); } },
        topicSelectionReadiness: { isReady: () => true, defer() {} }
    });
    await window.topicListManager.loadTopicList();
    await wait(20);
    const doc = window.document;
    const item = id => doc.querySelector(`.topic-item[data-topic-id="${id}"]`);
    const key = (target, keyName, init = {}) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init }));
    return { dom, window, doc, item, key, selected };
}

test('the topic list has one tab stop on the open topic and arrows move it', async () => {
    const { dom, window, doc, item, key } = await mountTopics();
    assert.deepEqual(['t1', 't2', 't3'].map(id => item(id).tabIndex), [-1, 0, -1]);

    item('t2').focus();
    key(item('t2'), 'ArrowDown');
    assert.equal(doc.activeElement, item('t3'));
    assert.deepEqual(['t1', 't2', 't3'].map(id => item(id).tabIndex), [-1, -1, 0], 'the tab stop follows focus');
    key(item('t3'), 'Home');
    assert.equal(doc.activeElement, item('t1'));
    key(item('t1'), 'End');
    assert.equal(doc.activeElement, item('t3'));
    key(item('t3'), 'ArrowUp');
    assert.equal(doc.activeElement, item('t2'));
    window.topicListManager.dispose();
    dom.window.close();
});

test('Enter opens the focused topic', async () => {
    const { dom, window, item, key, selected } = await mountTopics();
    item('t1').focus();
    key(item('t1'), 'Enter');
    await wait(0);
    assert.deepEqual(selected, ['t1']);
    window.topicListManager.dispose();
    dom.window.close();
});

test('Shift+F10 opens a keyboard menu that Escape closes back onto the topic', async () => {
    const { dom, window, doc, item, key } = await mountTopics();
    item('t1').focus();
    key(item('t1'), 'F10', { shiftKey: true });
    const menu = doc.getElementById('topicContextMenu');
    assert.ok(menu, 'the menu opens from the keyboard');
    assert.equal(menu.getAttribute('role'), 'menu');
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    assert.ok(items.length > 3);
    assert.equal(doc.activeElement, items[0], 'focus moves into the menu');

    key(items[0], 'ArrowDown');
    assert.equal(doc.activeElement, items[1]);
    key(items[1], 'ArrowUp');
    key(items[0], 'ArrowUp');
    assert.equal(doc.activeElement, items[items.length - 1], 'arrows wrap like a Radix menu');

    key(doc.activeElement, 'Escape');
    assert.equal(doc.getElementById('topicContextMenu'), null);
    assert.equal(doc.activeElement, item('t1'), 'focus returns to the topic');
    window.topicListManager.dispose();
    dom.window.close();
});
