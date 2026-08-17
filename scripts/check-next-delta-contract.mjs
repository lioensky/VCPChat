import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const document = new JSDOM(read('main.html')).window.document;

const canonicalIds = [
    'nextUiTopbar', 'nextUiAddTabBtn', 'nextUiCreateItemBtn',
    'nextUiAccountMenuTrigger', 'nextUiNotificationMenuBtn',
    'chatMessages', 'messageInput', 'sendMessageBtn', 'agentList',
    'tabContentTopics', 'tabContentSettings', 'notificationsList',
];
for (const id of canonicalIds) {
    assert.equal(document.querySelectorAll(`#${id}`).length, 1,
        `canonical/upstream shared element #${id} must exist exactly once`);
}

const retiredMainIds = [
    'createNewAgentBtn', 'createNewGroupBtn', 'openForumBtn',
    'themeToggleBtn', 'clearNotificationsBtn', 'doNotDisturbBtn',
    'minimize-to-tray-btn', 'minimize-btn', 'maximize-btn', 'restore-btn',
    'close-btn', 'settings-btn', 'title-bar-seam-fixer',
];
for (const id of retiredMainIds) {
    assert.equal(document.getElementById(id), null, `retired main control #${id} must not return`);
}

const mainRuntimeFiles = [
    'renderer.js',
    'modules/event-listeners.js',
    'modules/uiManager.js',
    'modules/filterManager.js',
    'modules/ui-helpers.js',
    'Groupmodules/grouprenderer.js',
];
for (const file of mainRuntimeFiles) {
    const source = read(file);
    for (const id of retiredMainIds) {
        assert.equal(source.includes(id), false,
            `${file} must not silently wire the retired main control #${id}`);
    }
}

const rendererSource = read('renderer.js');
const globalSettingsSource = read('modules/global-settings-manager.js');
const appearanceStudioSource = read('modules/ui-system/appearance-studio.js');
for (const [file, source] of [
    ['renderer.js', rendererSource],
    ['modules/global-settings-manager.js', globalSettingsSource],
    ['modules/ui-system/appearance-studio.js', appearanceStudioSource],
]) {
    assert.doesNotMatch(source, /(?:globalSettings|newSettings|draft|snapshot)\.uiMode|uiModeManager\.(?:apply|applyAsync)/,
        `${file} must not treat the retired main-window mode as live state`);
}
assert.doesNotMatch(appearanceStudioSource, /appearanceUiMode|enableNextUi|ui-mode-changed/,
    'Appearance Studio must only edit appearance, not a retired presentation switch');

const embeddedSource = read('modules/services/embeddedAppSessionManager.js');
assert.match(embeddedSource, /const uiMode = 'classic'/,
    'unmigrated child applications must keep an explicit upstream presentation policy');
assert.doesNotMatch(embeddedSource, /settings-updated|ui-mode-updated|subscribeSettings/,
    'main settings must not override the presentation policy of live child applications');

const vcpUiSource = read('modules/ui-system/vcp-ui.js');
assert.match(vcpUiSource, /_listen\(wa, 'wa-hide',[\s\S]*?event\.preventDefault\(\)[\s\S]*?finalize\(null\)/,
    'Web Awesome Modal dismissal must honor dismissibility and finalize the shared close contract');
assert.match(vcpUiSource, /_listen\(wa, 'wa-after-hide',[\s\S]*?finalize\(null\)[\s\S]*?controller\.destroy\(\)/,
    'Web Awesome Modal teardown must defensively finalize before destroying resources');

const creationSource = read('modules/ui-system/next-shell/creation-controller.js');
assert.match(creationSource, /modal\.update\(\{ dismissible: false, closeOnBackdrop: false \}\)/,
    'durable Agent/group creation must lock user dismissal at its commit boundary');
assert.match(creationSource, /modal\.update\(\{ dismissible: true, closeOnBackdrop: true \}\)/,
    'failed creation must restore user dismissal controls');

const commandsSource = read('modules/mainChatCommands.js');
assert.doesNotMatch(commandsSource, /\.click\s*\(/,
    'canonical commands must not proxy through presentation DOM clicks');
assert.match(commandsSource, /createAgent[\s\S]*?createGroup/,
    'canonical creation entries must remain shared business commands');

const eventSource = read('modules/event-listeners.js');
for (const id of [
    'enableMiddleClickQuickAction', 'middleClickQuickAction',
    'enableMiddleClickAdvanced', 'middleClickAdvancedDelay',
]) {
    assert.match(eventSource, new RegExp(`getElementById\\('${id}'\\)`),
        `upstream settings behavior for #${id} must remain wired without a retired toolbar button`);
}

const sharedBaseline = JSON.parse(read('scripts/next-delta-shared-baseline.json'));
for (const [file, entry] of Object.entries(sharedBaseline)) {
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.length >= 12, `${file} requires a review rationale`);
    const digest = crypto.createHash('sha256').update(read(file)).digest('hex');
    assert.equal(digest, entry.sha256,
        `${file} changed across the Next/upstream business boundary; review it explicitly and update its rationale/hash`);
}

console.log('Next delta contract passed (canonical ownership, upstream reachability, modal and child policy).');
