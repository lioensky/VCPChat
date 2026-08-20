import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const exists = file => fs.existsSync(new URL(`../${file}`, import.meta.url));
const canonicalTextDigest = source => crypto.createHash('sha256')
    .update(source.replace(/\r\n/g, '\n'))
    .digest('hex');
const document = new JSDOM(read('main.html')).window.document;

assert.equal(canonicalTextDigest('line one\nline two\n'), canonicalTextDigest('line one\r\nline two\r\n'),
    'reviewed text baselines must be independent from the checkout line-ending policy');

for (const retiredFile of [
    'modules/uiModeManager.js',
    'modules/ui-system/settings-settlement.js',
    'modules/ui-system/ui-mode-controller.js',
    'modules/ui-system/vcp-page-rebuild.js',
    'modules/ui-system/vcp-ui-runtime-bootstrap.js',
    'styles/ui-system/runtime.css',
]) {
    assert.equal(exists(retiredFile), false, `${retiredFile} must not return without a production consumer`);
}
assert.equal(document.documentElement.dataset.uiMode, 'next', 'main.html must declare the canonical presentation');
assert.doesNotMatch(read('preloads/shared/catalog.js'), /onUiModeUpdated|ui-mode-updated/,
    'preload must not expose a presentation subscription without a sender and consumer');

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
assert.match(vcpUiSource, /_listen\(wa, 'wa-hide', event => \{[\s\S]*?event\.target !== wa[\s\S]*?_listen\(wa, 'wa-after-hide', event => \{[\s\S]*?event\.target !== wa/,
    'Web Awesome Modal must reject lifecycle events bubbled by nested components');
assert.match(vcpUiSource, /_listen\(wa, 'wa-after-hide',[\s\S]*?finalize\(null\)[\s\S]*?controller\.destroy\(\)/,
    'Web Awesome Modal teardown must defensively finalize before destroying resources');

const creationSource = read('modules/ui-system/next-shell/creation-controller.js');
assert.doesNotMatch(creationSource, /getSnapshot|whenSettled|pendingOperations|listeners|\brevision\b|\boperationId\b/,
    'creation must not expose test-only settlement state');
assert.match(creationSource, /await webAwesome\.loadComponents\(\)[\s\S]*?REQUIRED_WEB_AWESOME_COMPONENTS\.filter\(tag => !webAwesome\.isDefined\(tag\)\)/,
    'creation must await its own Web Awesome dependency before choosing a Surface kernel');
assert.doesNotMatch(creationSource, /SurfaceController \?|buildControls\(\(name, options\) => ui\.create/,
    'creation must not retain a direct no-Surface construction path');
assert.match(creationSource, /kernelPreference:\s*webAwesomeReady \? 'web-awesome' : 'native'/,
    'canonical creation must choose one explicit kernel before mounting');
assert.match(creationSource, /Web Awesome creation kernel unavailable; using native kernel/,
    'canonical creation must retain a native fallback when Web Awesome fails');
assert.match(creationSource, /modal\.update\(\{ dismissible: false, closeOnBackdrop: false \}\)/,
    'durable Agent/group creation must lock user dismissal at its commit boundary');
assert.match(creationSource, /modal\.update\(\{ dismissible: true, closeOnBackdrop: true \}\)/,
    'failed creation must restore user dismissal controls');

const surfaceSource = read('modules/ui-system/surface-controller.js');
assert.match(surfaceSource, /kernel === 'web-awesome'[\s\S]*?mountScope\?\.\(host\)[\s\S]*?this\.own\(releaseKernelScope/,
    'Web Awesome Surfaces must own and release their theme/token scope');

const commandsSource = read('modules/mainChatCommands.js');
assert.doesNotMatch(commandsSource, /\.click\s*\(/,
    'canonical commands must not proxy through presentation DOM clicks');
assert.match(commandsSource, /createAgent[\s\S]*?createGroup/,
    'canonical creation entries must remain shared business commands');

const itemListSource = read('modules/itemListManager.js');
assert.doesNotMatch(itemListSource, /assistant-catalog|getCatalogState|getCatalogSnapshot|whenSettled|catalogChannel/,
    'item list must not publish a test-only catalog store');

const contributionSource = read('modules/ui-system/contribution-registry.js');
assert.doesNotMatch(contributionSource, /new ContributionRegistry\(['"](?:menu|setting)['"]\)|\bmenus\b|\bsettings\b/,
    'contribution registry must not expose kinds without production producers and consumers');
assert.match(contributionSource, /Object\.freeze\(\{ ContributionRegistry, CommandRegistry, commands, apps, diagnostics \}\)/,
    'contribution registry must retain only the production command/app contract');
const accountMenuSource = read('modules/ui-system/next-shell/account-menu-controller.js');
assert.doesNotMatch(accountMenuSource, /getMenuRegistry|renderContributions|data-contribution|account-menu-contributions/,
    'account menu must not retain an empty dynamic contribution surface');
assert.match(read('modules/ui-system/component-showcase.js'), /id: 'ui-component-library'/,
    'the user-visible component library must remain a registered internal application');
assert.match(read('modules/ui-system/next-shell/launchpad-controller.js'), /getInternalApps\(\)\.forEach/,
    'Launchpad must continue exposing registered internal applications to users');

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
    const digest = canonicalTextDigest(read(file));
    assert.equal(digest, entry.sha256,
        `${file} changed across the Next/upstream business boundary; review it explicitly and update its rationale/hash`);
}

console.log('Next delta contract passed (canonical ownership, upstream reachability, modal and child policy).');
