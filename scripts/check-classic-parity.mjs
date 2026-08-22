import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const mainHtml = fs.readFileSync(path.join(root, 'main.html'), 'utf8');
const dom = new JSDOM(mainHtml);
const document = dom.window.document;

assert.equal(document.querySelector('.title-bar'), null, 'retired Classic title bar must not remain hidden in the DOM');
assert.equal(document.getElementById('themeToggleBtn'), null, 'retired Classic theme toggle must not remain hidden');
assert.ok(document.getElementById('toggleNotificationsBtn'), 'shared upstream notification toggle must remain available');
assert.equal(document.getElementById('openForumBtn'), null, 'retired Forum proxy must not remain hidden');
assert.equal(document.getElementById('doNotDisturbBtn'), null, 'retired filter proxy must not remain hidden');
assert.equal(document.getElementById('clearNotificationsBtn'), null, 'retired clear proxy must not remain hidden');
const rendererSource = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
assert.equal(rendererSource.includes('material-symbols-outlined vcp-ui-icon" aria-hidden="true">stop'), false,
    'Classic interrupt button must not inject a Material Symbols text token');

['quickNewTopicBtn', 'attachFileBtn', 'emoticonTriggerBtn', 'sendMessageBtn'].forEach(id => {
    const button = document.getElementById(id);
    assert.ok(button, `${id} must remain in the shared composer DOM`);
    assert.ok(button.querySelector('svg'), `${id} must keep an inline SVG usable without the Next runtime`);
    assert.equal(button.querySelector('.material-symbols-outlined'), null, `${id} must not depend on a mode-specific icon font`);
});

const settingsTemplate = document.getElementById('globalSettingsModalTemplate');
assert.ok(settingsTemplate, 'shared upstream global settings template must remain in main.html');
const classicSettingsTemplates = [
    settingsTemplate,
    document.getElementById('agentSettingsModalTemplate'),
    document.getElementById('groupSettingsModalTemplate'),
].filter(Boolean);
classicSettingsTemplates.forEach(template => {
    const leakedMaterialTokens = [...template.content.querySelectorAll('.vcp-ui-icon')]
        .filter(icon => icon.textContent.trim());
    assert.deepEqual(
        leakedMaterialTokens.map(icon => icon.textContent.trim()),
        [],
        'Classic shared settings templates must not expose Material Symbols text tokens',
    );
});
assert.equal(settingsTemplate.content.querySelectorAll('.appearance-layout-option').length, 0,
    'retired main-layout controls must not remain in settings');
const navItems = [...settingsTemplate.content.querySelectorAll('.settings-nav-item')];
assert.equal(navItems.length, 8, 'Classic global settings must retain all eight upstream categories');
navItems.forEach(item => assert.ok(item.dataset.section, 'Classic settings category must retain its section target'));

for (const file of [
    path.join(root, 'styles', 'ui-next.css'),
    ...fs.readdirSync(path.join(root, 'styles', 'ui-system'))
        .filter(name => name.endsWith('.css'))
        .map(name => path.join(root, 'styles', 'ui-system', name)),
]) {
    const css = postcss.parse(fs.readFileSync(file, 'utf8'), { from: file });
    css.walkRules(rule => {
        if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
        rule.selectors.forEach(selector => {
            const explicitHost = selector.startsWith('html')
                || selector.startsWith(':is(html')
                || selector.includes('html.vcp-appearance-studio-host')
                || selector.includes('html.vcp-global-settings-host');
            const nextOwned = /(?:\.next-ui-|#nextUi)/.test(selector)
                && !/(?:\.chat-|\.sidebar|\.notifications-|#messageInput|#sendMessageBtn|#attachFileBtn|#quickNewTopicBtn|#emoticonTriggerBtn|#globalSettingsModal)/.test(selector);
            if (!explicitHost && !nextOwned) {
                throw new Error(`${path.relative(root, file)} escapes the Next/explicit-host boundary: ${selector}`);
            }
        });
    });
}

const nextComposerCss = fs.readFileSync(
    path.join(root, 'styles', 'ui-system', 'chat-input.css'),
    'utf8'
);
assert.match(
    nextComposerCss,
    /:is\([\s\S]*?#attachFileBtn[\s\S]*?#quickNewTopicBtn[\s\S]*?#emoticonTriggerBtn[\s\S]*?\) svg\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/,
    'Next composer inline SVG controls must retain the same 16px icon geometry as Classic'
);

const nextNotificationsCss = fs.readFileSync(
    path.join(root, 'styles', 'ui-system', 'notifications.css'),
    'utf8'
);
const nextMessagesCss = postcss.parse(
    fs.readFileSync(path.join(root, 'styles', 'ui-system', 'messages.css'), 'utf8')
);
const forbiddenNextMessageClasses = [
    'chat-messages',
    'message-item',
    'chat-avatar',
    'details-and-bubble-wrapper',
    'sender-name',
    'message-timestamp',
    'md-content',
    'vcp-thought-chain-bubble',
];
nextMessagesCss.walkRules(rule => {
    for (const selector of rule.selectors) {
        assert.ok(
            forbiddenNextMessageClasses.every(className => (
                !new RegExp(`\\.${className}(?![\\w-])`).test(selector)
            )),
            `Next must not restyle Classic conversation content: ${selector}`
        );
    }
});
assert.match(
    nextNotificationsCss,
    /notifications-sidebar\s*>\s*\.section-divider\s*\{[\s\S]*?display:\s*block;[\s\S]*?height:\s*1px;/,
    'Next app tray must retain a visible divider above its controls'
);
assert.match(
    nextNotificationsCss,
    /#vchatAppTray\s*:is\(\.capsule-button,\s*\.app-tray-more-btn\)\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/,
    'Next app tray controls must use separate borderless button surfaces'
);
assert.match(
    nextNotificationsCss,
    /#appTrayPinnedApps\s+\.notes-button-label\s*\{[\s\S]*?display:\s*none;/,
    'Next pinned app tray must use icon-only controls instead of truncated text labels'
);
assert.match(
    nextNotificationsCss,
    /#appTrayDrawerGrid\s+\.notes-button-label\s*\{[\s\S]*?display:\s*block;/,
    'Next all-apps drawer must retain visible application labels'
);
assert.match(
    nextNotificationsCss,
    /#appTrayDrawerGrid\s+\.app-tray-drawer-item\s*\{[\s\S]*?min-height:\s*var\(--vcp-ui-control-md\)/,
    'Next all-apps drawer must retain the compact upstream application hit target'
);
assert.match(
    nextNotificationsCss,
    /#appTrayDrawerGrid\s+\.notes-button-label\s*\{[\s\S]*?font-size:\s*var\(--vcp-ui-font-body\)/,
    'Next all-apps drawer labels must retain the upstream readable scale'
);
assert.match(
    nextNotificationsCss,
    /#vchatAppTray\s+\[data-tooltip\]::before[\s\S]*?content:\s*attr\(data-tooltip\)/,
    'Next icon-only app tray must expose a styled text hint'
);
assert.match(
    nextNotificationsCss,
    /\[data-tooltip\]:is\(:hover,\s*:focus-visible\):not\(\.active\)::before/,
    'Next app tray hint must support both pointer and keyboard focus'
);
assert.match(
    nextNotificationsCss,
    /notifications-sidebar:has\(#appTrayDrawer:is\(\.active,\s*\.is-closing\)\)[\s\S]*?overflow:\s*visible/,
    'Next all-apps drawer must stay unclipped throughout its exit transition'
);

console.log('Upstream shared-surface contract passed (controls, settings, icons and CSS isolation).');
