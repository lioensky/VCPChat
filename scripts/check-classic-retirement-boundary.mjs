import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const document = new JSDOM(read('main.html')).window.document;

for (const id of ['chatMessages', 'messageInput', 'sendMessageBtn', 'attachFileBtn', 'quickNewTopicBtn', 'emoticonTriggerBtn', 'notificationsList', 'globalSettingsModalTemplate', 'agentSettingsForm']) {
    assert.equal(document.querySelectorAll(`#${id}`).length, 1, `shared DOM identity #${id} must exist exactly once`);
}
assert.doesNotMatch(read('modules/renderer/streamManager.js'), /uiMode|data-ui-mode|nextUi/i,
    'shared stream manager must not depend on presentation mode');
assert.doesNotMatch(read('modules/mainChatCommands.js'), /nextUi[A-Z]|querySelectorAll\(['"]\.notification-item/,
    'business commands must not own Next controls or notification DOM');
assert.doesNotMatch(read('modules/event-listeners.js'), /(?:doNotDisturbBtn|clearNotificationsBtn|openForumBtn)\??\.click\(/,
    'Next actions must call shared commands, not hidden Classic controls');
for (const file of ['renderer.js', 'modules/chatManager.js', 'modules/messageRenderer.js', 'modules/renderer/streamManager.js']) {
    const source = read(file).replaceAll('nextUiEmptyState', 'allowedEmptyStateProjection');
    assert.doesNotMatch(source, /nextUi[A-Z]/, `${file} must stay independent of Next presentation IDs`);
}
for (const file of [
    'modules/event-listeners.js',
    'modules/searchManager.js',
    'modules/trayManager.js',
    'modules/topicListManager.js',
    'modules/ui-helpers.js',
    'modules/ui-system/ask-nova-modal.js',
    'modules/ui-system/lucide-adapter.js',
    'modules/ui-system/next-shell/creation-controller.js',
    'modules/ui-system/next-shell/next-shell-controller.js',
    'modules/ui-system/settings-bridge.js',
    'modules/ui-system/vcp-main-ui-runtime.js',
]) {
    assert.doesNotMatch(
        read(file),
        /documentElement\.dataset\.uiMode|addEventListener\(['"]ui-mode-changed|prepareForMode|syncMode\s*\(/,
        `${file} must not retain a main-window Classic/Next runtime branch`,
    );
}
assert.doesNotMatch(read('modules/topTabManager.js'), /prepareForMode|syncMode/,
    'the canonical tab-host facade must not expose retired mode-transition methods');
console.log('Classic retirement boundary gate passed.');
