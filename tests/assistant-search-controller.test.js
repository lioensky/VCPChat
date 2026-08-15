const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { AssistantSearchController } = require('../modules/ui-system/next-shell/assistant-search-controller.js');

test('assistant search owns open, escape, tab-change and teardown state', () => {
    const dom = new JSDOM(`<!doctype html><body>
      <section id="tabContentAgents"><header class="agents-header"></header></section>
      <button id="nextUiAgentSearchTrigger"></button><button id="nextUiAgentSearchClose"></button>
      <input id="agentSearchInput"><button class="sidebar-tab-button" data-tab="groups"></button>
    </body>`, { pretendToBeVisual: true });
    const filters = [];
    const controller = new AssistantSearchController({
        document: dom.window.document,
        filter: value => filters.push(value),
    });
    assert.equal(controller.mount(), true);
    dom.window.document.getElementById('nextUiAgentSearchTrigger').click();
    assert.equal(dom.window.document.querySelector('.agents-header').classList.contains('is-searching'), true);
    const input = dom.window.document.getElementById('agentSearchInput');
    input.value = 'Nova';
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(input.value, '');
    assert.equal(filters.at(-1), '');
    controller.dispose();
    dom.window.document.getElementById('nextUiAgentSearchTrigger').click();
    assert.equal(dom.window.document.querySelector('.agents-header').classList.contains('is-searching'), false);
});
