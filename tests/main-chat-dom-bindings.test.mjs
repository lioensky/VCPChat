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
