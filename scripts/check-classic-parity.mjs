import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const mainHtml = fs.readFileSync(path.join(root, 'main.html'), 'utf8');
const dom = new JSDOM(mainHtml);
const document = dom.window.document;

assert.ok(document.querySelector('.title-bar'), 'Classic title bar must remain in the shared DOM');
assert.ok(document.getElementById('themeToggleBtn'), 'Classic theme toggle must remain available');
assert.ok(document.getElementById('toggleNotificationsBtn'), 'Classic notification toggle must remain available');
assert.ok(document.getElementById('openForumBtn'), 'Classic Forum shortcut must remain available');
assert.ok(document.getElementById('doNotDisturbBtn'), 'Classic notification filter shortcut must remain available');
assert.ok(document.getElementById('clearNotificationsBtn'), 'Classic notification clear shortcut must remain available');

['quickNewTopicBtn', 'attachFileBtn', 'emoticonTriggerBtn', 'sendMessageBtn'].forEach(id => {
    const button = document.getElementById(id);
    assert.ok(button, `${id} must remain in the shared composer DOM`);
    assert.ok(button.querySelector('svg'), `${id} must keep an inline SVG usable without the Next runtime`);
    assert.equal(button.querySelector('.material-symbols-outlined'), null, `${id} must not depend on a mode-specific icon font`);
});

const settingsTemplate = document.getElementById('globalSettingsModalTemplate');
assert.ok(settingsTemplate, 'Classic global settings template must remain in main.html');
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
            const explicitHost = selector.startsWith('html[data-ui-mode="next"]')
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

const wallpaperPlugin = fs.readFileSync(
    path.join(root, 'VCPDistributedServer', 'Plugin', 'VChatDynamicWallpaper', 'plugin.js'),
    'utf8'
);

const nextComposerCss = fs.readFileSync(
    path.join(root, 'styles', 'ui-system', 'chat-input.css'),
    'utf8'
);
assert.match(
    nextComposerCss,
    /:is\([\s\S]*?#attachFileBtn[\s\S]*?#quickNewTopicBtn[\s\S]*?#emoticonTriggerBtn[\s\S]*?\) svg\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/,
    'Next composer inline SVG controls must retain the same 16px icon geometry as Classic'
);

assert.match(wallpaperPlugin, /const icons = \{[\s\S]*?movie:\s*'<svg/, 'Classic wallpaper entry must provide an inline SVG icon');
assert.doesNotMatch(
    wallpaperPlugin,
    /id="vchat-dynamic-wallpaper-panel"[\s\S]*?<span class="vcp-ui-icon"[^>]*>movie<\/span>/,
    'Classic wallpaper entry must not depend on the Next icon adapter'
);

console.log('Classic parity static gate passed (shared controls, settings navigation, icon independence, CSS isolation).');
