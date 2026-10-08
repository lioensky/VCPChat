import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMainChatDomBindings } from '../modules/renderer/mainChatDomBindings.js';

const requiredMarkup = `
  <ul id="agentList"></ul><div id="chatMessages"></div>
  <textarea id="messageInput"></textarea><button id="sendMessageBtn"></button>
  <aside class="sidebar"></aside><section class="chat-input-card"></section>`;

test('main chat DOM bindings resolve once from the owning document', () => {
    const dom = new JSDOM(requiredMarkup);
    const bindings = createMainChatDomBindings(dom.window.document);
    assert.equal(bindings.chatMessagesDiv.ownerDocument, dom.window.document);
    assert.equal(bindings.messageInput.id, 'messageInput');
    assert.equal(Object.isFrozen(bindings), true);
    dom.window.close();
});

test('main chat DOM bindings fail fast when the canonical contract is incomplete', () => {
    const dom = new JSDOM('<div id="chatMessages"></div>');
    assert.throws(() => createMainChatDomBindings(dom.window.document), /missing required node/);
    assert.throws(() => createMainChatDomBindings(null), /owning document/);
    dom.window.close();
});

test('main chat DOM bindings resolve side pane elements when present', () => {
    const markupWithSidePane = requiredMarkup + `
      <aside class="vcp-side-pane" id="vcpSidePane">
        <div class="side-pane-tabs"></div>
        <div class="side-pane-content-container"></div>
      </aside>
      <button id="toggleSidePaneChatBtn"></button>
      <button id="closeSidePaneBtn"></button>
      <button id="addSidePaneChatBtn"></button>
    `;
    const dom = new JSDOM(markupWithSidePane);
    const bindings = createMainChatDomBindings(dom.window.document);
    assert.equal(bindings.vcpSidePane.id, 'vcpSidePane');
    assert.ok(bindings.sidePaneTabs);
    assert.ok(bindings.sidePaneContentContainer);
    assert.equal(bindings.toggleSidePaneChatBtn.id, 'toggleSidePaneChatBtn');
    assert.equal(bindings.closeSidePaneBtn.id, 'closeSidePaneBtn');
    assert.equal(bindings.addSidePaneChatBtn.id, 'addSidePaneChatBtn');
    dom.window.close();
});
