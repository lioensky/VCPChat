import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const dom = new JSDOM(`<!doctype html><html><body>
    <main class="main-content">
        <h3 id="currentChatAgentName"></h3>
        <section id="nextUiEmptyState" aria-hidden="true"></section>
        <div id="chatMessages"></div>
    </main>
    <button id="voiceChatBtn"></button>
</body></html>`, {
    runScripts: 'dangerously',
    url: 'http://localhost/'
});

const { window } = dom;
window.console = console;
window.eval(fs.readFileSync(path.join(root, 'modules', 'chatManager.js'), 'utf8'));

const watcherStop = new Promise(() => {});
const selectedItem = { value: { id: null, type: null } };
const topicId = { value: null };
const history = { value: [] };

window.chatManager.init({
    electronAPI: {
        onCanvasContentUpdate() {},
        onCanvasWindowClosed() {},
        watcherStop: () => watcherStop
    },
    uiHelper: {},
    modules: {
        messageRenderer: null,
        itemListManager: {},
        topicListManager: { loadTopicList() {} },
        groupRenderer: null
    },
    refs: {
        currentSelectedItemRef: {
            get: () => selectedItem.value,
            set: value => { selectedItem.value = value; }
        },
        currentTopicIdRef: {
            get: () => topicId.value,
            set: value => { topicId.value = value; }
        },
        currentChatHistoryRef: {
            get: () => history.value,
            set: value => { history.value = value; }
        },
        attachedFilesRef: { get: () => [], set() {} },
        globalSettingsRef: { get: () => ({}) }
    },
    elements: {
        currentChatNameH3: window.document.getElementById('currentChatAgentName'),
        chatMessagesDiv: window.document.getElementById('chatMessages'),
        currentItemActionBtn: window.document.createElement('button'),
        messageInput: window.document.createElement('textarea'),
        sendMessageBtn: window.document.createElement('button'),
        attachFileBtn: window.document.createElement('button')
    },
    mainRendererFunctions: {}
});

const mainContent = window.document.querySelector('.main-content');
assert.equal(window.chatManager.displayNoItemSelected(), true);
assert.equal(mainContent.dataset.chatEmpty, 'true');
assert.equal(mainContent.dataset.chatEmptyReason, 'no-selection');

// Reproduce the late-render race: an empty state may be active before an
// asynchronous history renderer appends the first real message.
const lateMessage = window.document.createElement('div');
lateMessage.className = 'message-item assistant';
lateMessage.textContent = 'history message';
window.document.getElementById('chatMessages').appendChild(lateMessage);
await new Promise(resolve => window.setTimeout(resolve, 0));
assert.equal(mainContent.classList.contains('next-ui-empty-state-active'), false);
assert.equal(mainContent.dataset.chatEmpty, 'false');
assert.equal(window.document.getElementById('nextUiEmptyState').getAttribute('aria-hidden'), 'true');

assert.equal(window.chatManager.displayNoItemSelected(), true);
void window.chatManager.selectItem('nova', 'agent', 'Nova', null, {});
assert.equal(mainContent.dataset.chatEmpty, 'false', 'selection must hide the empty state immediately');
assert.equal(
    window.chatManager.displayNoItemSelected(),
    false,
    'a late empty-state request must be rejected while item selection is pending'
);
assert.equal(mainContent.classList.contains('next-ui-empty-state-active'), false);
assert.equal(mainContent.hasAttribute('data-chat-empty-reason'), false);
assert.equal(window.document.getElementById('nextUiEmptyState').getAttribute('aria-hidden'), 'true');

const nextUiCss = fs.readFileSync(path.join(root, 'styles', 'ui-next.css'), 'utf8');
const mainHtml = fs.readFileSync(path.join(root, 'main.html'), 'utf8');
assert.match(nextUiCss, /--next-empty-flow-primary:\s*var\(--button-bg\)/);
assert.match(nextUiCss, /--next-empty-flow-secondary:\s*hsl\(from var\(--button-bg\) calc\(h \+ 150\) s l\)/);
assert.doesNotMatch(nextUiCss, /stroke:\s*#(?:00f3ff|ff00ea)/i);
assert.doesNotMatch(mainHtml, /stop-color="#(?:00f3ff|ff00ea)"/i);
assert.match(
    mainHtml,
    /id="nextUiEmptyTagline"[^>]*>语义级打穿 AI、UI\/UX、APP 与人类想象力的边界</,
    'the empty-state tagline must ship with the configured product default'
);
const settingsSource = fs.readFileSync(path.join(root, 'modules', 'utils', 'appSettingsManager.js'), 'utf8');
assert.match(settingsSource, /showHomeVisualTagline:\s*true/);
assert.match(settingsSource, /homeVisualTagline:\s*'语义级打穿 AI、UI\/UX、APP 与人类想象力的边界'/);

console.log('Next UI empty-state race and theme-color contract passed.');
