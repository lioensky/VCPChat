const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');

test('legacy mode events cannot tear down canonical topic management state', async () => {
    const dom = new JSDOM(`<!doctype html><html data-ui-mode="next"><body>
        <section id="tabContentTopics" class="is-managing">
            <div class="topics-header-container" data-next-ui-tools-bound="true"></div>
            <div class="next-ui-topic-manage-panel" aria-hidden="false"></div>
            <button id="nextUiManageTopicsBtn" class="active" aria-pressed="true"></button>
            <span id="nextUiTopicSelectionCount">已选择 2 项</span>
            <button id="nextUiSelectAllTopicsBtn"><span class="vcp-ui-icon"></span></button>
            <button id="nextUiDeleteTopicsBtn"></button>
            <ul id="topicList" class="topic-list">
                <li class="topic-item active selected" data-topic-id="topic-a" aria-selected="true">
                    <span class="next-ui-topic-select-icon">check_box</span>
                    <span class="unlocked-indicator">unlocked</span>
                </li>
                <li class="topic-item selected" data-topic-id="topic-b" aria-selected="true">
                    <span class="next-ui-topic-select-icon">check_box</span>
                </li>
            </ul>
        </section>
    </body></html>`, {
        url: 'https://vcpchat.local/main.html',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(fs.readFileSync(path.join(root, 'modules/topicListManager.js'), 'utf8'));
    window.topicListManager.init({
        elements: { topicListContainer: window.document.getElementById('tabContentTopics') },
        electronAPI: {},
        refs: {
            currentSelectedItemRef: { get: () => ({ id: '', type: '' }) },
            currentTopicIdRef: { get: () => 'topic-a' }
        },
        uiHelper: {},
        mainRendererFunctions: {}
    });

    window.document.documentElement.dataset.uiMode = 'classic';
    window.dispatchEvent(new window.CustomEvent('ui-mode-changed', {
        detail: { mode: 'classic', previousMode: 'next' }
    }));
    await new Promise(resolve => setTimeout(resolve, 0));

    const container = window.document.getElementById('tabContentTopics');
    assert.equal(container.classList.contains('is-managing'), true);
    assert.equal(window.document.querySelectorAll('.next-ui-topic-select-icon').length, 2);
    assert.equal(window.document.querySelectorAll('.unlocked-indicator').length, 1);
    assert.equal(window.document.querySelectorAll('.topic-item.selected').length, 2);
    assert.equal(window.document.getElementById('nextUiManageTopicsBtn').getAttribute('aria-pressed'), 'true');
    dom.window.close();
});
