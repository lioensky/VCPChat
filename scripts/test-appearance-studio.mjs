import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!doctype html><html data-ui-mode="next"><body class="dark-theme">
    <button id="nextUiAccountAppearanceStudioBtn">外观与布局</button>
    <button id="nextUiAccountMenuTrigger">账户</button>
    <div id="nextUiAccountMenu" hidden></div>
    <form id="globalSettingsForm">
        <input type="checkbox" id="showHomeVisualBrand" checked>
        <input type="checkbox" id="showHomeVisualTagline" checked>
        <input type="text" id="homeVisualTagline" value="语义级打穿 AI、UI/UX、APP 与人类想象力的边界">
        <select id="appearanceDensity"><option value="compact">紧凑</option><option value="comfortable">舒适</option><option value="relaxed">宽松</option></select>
        <select id="appearanceRadius"><option value="small">小</option><option value="medium">中</option></select>
        <select id="appearanceTypography"><option value="system">系统</option><option value="humanist">人文</option><option value="serif">衬线</option></select>
        <select id="appearanceFontScale"><option value="small">小</option><option value="normal">标准</option><option value="large">大</option></select>
        <select id="appearanceContentWidth"><option value="full">铺满</option><option value="centered">居中</option></select>
        <input type="range" id="appearanceSidebarRowHeight" min="38" max="64" value="46">
        <output id="appearanceSidebarRowHeightValue">46px</output>
        <input type="range" id="appearanceSidebarAvatarSize" min="20" max="52" value="32">
        <output id="appearanceSidebarAvatarSizeValue">32px</output>
        <select id="appearanceSidebarRadius"><option value="tuned">原设计</option><option value="medium">中</option><option value="round">大</option></select>
        <input type="range" id="appearanceCustomRadius" min="0" max="32" value="10">
        <output id="appearanceCustomRadiusValue">10px</output>
        <select id="appearanceSurface"><option value="solid">实色</option><option value="translucent">主题</option><option value="custom">自定义</option></select>
        <input type="radio" name="chatPresentationMode" value="bubble" checked>
        <input type="radio" name="chatPresentationMode" value="panel">
        <input type="radio" name="chatPresentationMode" value="immersive">
        <input type="radio" id="chatLayoutModeNormal" name="chatLayoutMode" value="normal" checked>
        <input type="radio" id="chatLayoutModeWide" name="chatLayoutMode" value="wide">
        <div id="appearanceSettingsWorkbenchCard">
            <div data-appearance-summary-preview></div>
            <strong data-appearance-summary-title></strong>
            <p data-appearance-summary-description></p>
            <span data-appearance-summary-density></span>
            <span data-appearance-summary-radius></span>
            <span data-appearance-summary-presentation></span>
            <button type="button" id="openAppearanceStudioFromSettings">打开工作台</button>
        </div>
    </form>
    <section id="nextUiEmptyState"><p id="nextUiEmptyTagline">语义级打穿 AI、UI/UX、APP 与人类想象力的边界</p></section>
</body></html>`, {
    url: 'https://vcpchat.local/',
    runScripts: 'outside-only'
});

const { window } = dom;
Object.assign(globalThis, {
    window,
    document: window.document,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    MutationObserver: window.MutationObserver,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    requestAnimationFrame: callback => callback(),
    matchMedia: () => ({ matches: false })
});
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.matchMedia = globalThis.matchMedia;
await import(`${pathToFileURL(`${process.cwd()}/modules/ui-system/vcp-ui.js`).href}?appearance-studio-test=1`);
window.globalSettings = {
    currentThemeMode: 'dark',
    appearanceProfile: {
        density: 'comfortable', radius: 'medium', typography: 'humanist',
        fontScale: 'normal', contentWidth: 'full', surface: 'translucent',
        sidebarRowHeight: 46, sidebarAvatarSize: 32, customRadius: 10
    },
    chatPresentationMode: 'bubble',
    enableWideChatLayout: false,
    showHomeVisualBrand: true,
    showHomeVisualTagline: true,
    homeVisualTagline: '语义级打穿 AI、UI/UX、APP 与人类想象力的边界'
};
window.chatAPI = {
    saved: [],
    themes: [],
    appliedColorThemes: [],
    async saveSettings(patch) {
        this.saved.push(patch);
        return { success: true };
    },
    setTheme(theme) { this.themes.push(theme); },
    setThemeMode() {},
    async getThemes() {
        return [
            {
                fileName: 'themes默认.css', name: '默认', isActive: true,
                variables: {
                    dark: { '--primary-bg': '#111827', '--secondary-bg': '#1f2937', '--button-bg': '#7c3aed' },
                    light: { '--primary-bg': '#f9fafb', '--secondary-bg': '#ffffff', '--button-bg': '#6d28d9' }
                }
            },
            {
                fileName: 'themes森林.css', name: '森林', isActive: false,
                variables: {
                    dark: { '--primary-bg': '#13231a', '--secondary-bg': '#203a2b', '--button-bg': '#59a473' },
                    light: { '--primary-bg': '#eff8f1', '--secondary-bg': '#ffffff', '--button-bg': '#43835a' }
                }
            }
        ];
    },
    applyTheme(fileName) { this.appliedColorThemes.push(fileName); },
    openThemesWindow() {}
};
window.uiManager = {
    applyTheme(theme) {
        window.document.body.classList.toggle('dark-theme', theme === 'dark');
        window.document.body.classList.toggle('light-theme', theme === 'light');
    }
};
window.uiHelperFunctions = { showToastNotification() {}, openModal() {} };
window.normalizeChatPresentationMode = mode => ['bubble', 'panel', 'immersive'].includes(mode) ? mode : 'bubble';
window.applyChatPresentationMode = async mode => {
    const normalized = window.normalizeChatPresentationMode(mode);
    window.globalSettings.chatPresentationMode = normalized;
    window.document.body.classList.toggle('chat-presentation-bubble', normalized === 'bubble');
    window.document.body.classList.toggle('chat-presentation-panel', normalized === 'panel');
    window.document.body.classList.toggle('chat-presentation-immersive', normalized === 'immersive');
    return { success: true, mode: normalized };
};

window.eval(fs.readFileSync('modules/ui-system/lifecycle-scope.js', 'utf8'));
window.eval(fs.readFileSync('modules/ui-system/appearance-engine.js', 'utf8'));
window.eval(fs.readFileSync('modules/ui-system/appearance-studio.js', 'utf8'));
document.dispatchEvent(new CustomEvent('modal-ready', { detail: { modalId: 'globalSettingsModal' } }));

const settingsRowHeight = document.getElementById('appearanceSidebarRowHeight');
const settingsAvatarSize = document.getElementById('appearanceSidebarAvatarSize');
settingsRowHeight.value = '38';
settingsRowHeight.dispatchEvent(new Event('input', { bubbles: true }));
assert.equal(settingsAvatarSize.value, '24', 'default avatar follows the global-settings row-height slider');
assert.equal(settingsAvatarSize.max, '34', 'global-settings avatar is bounded by the current row height');
settingsRowHeight.value = '46';
settingsRowHeight.dispatchEvent(new Event('input', { bubbles: true }));
assert.equal(settingsAvatarSize.value, '32');

const studio = window.VCPAppearanceStudio;
assert.ok(studio);
assert.equal(studio.PRESETS.focus.themeMode, undefined);
assert.equal(studio.PRESETS.reading.themeMode, undefined);
assert.equal(studio.open({ trigger: document.getElementById('nextUiAccountAppearanceStudioBtn') }), true);
assert.equal(studio.isOpen(), true);
await new Promise(resolve => setImmediate(resolve));

const drawer = document.getElementById('vcpAppearanceStudio');
assert.ok(drawer);
assert.equal(drawer.querySelector('.vcp-appearance-studio-header'), null);
assert.ok(drawer.querySelector('.vcp-appearance-theme-section [data-studio-close]'));
assert.ok(
    [...drawer.querySelectorAll('.vcp-appearance-studio-section')].indexOf(drawer.querySelector('.vcp-appearance-studio-section-presets'))
    < [...drawer.querySelectorAll('.vcp-appearance-studio-section')].indexOf(drawer.querySelector('[aria-labelledby="vcpAppearanceLayoutTitle"]')),
    'quick presets should appear near the top, before detailed appearance controls'
);
assert.deepEqual(
    [...drawer.querySelectorAll('.vcp-appearance-studio-content > .vcp-appearance-studio-section[aria-labelledby]')]
        .map(section => section.getAttribute('aria-labelledby')),
    [
        'vcpAppearanceThemeTitle',
        'vcpAppearancePresetsTitle',
        'vcpAppearanceLayoutTitle',
        'vcpAppearanceGeometryTitle',
        'vcpAppearanceReadingTitle',
        'vcpAppearanceMaterialTitle'
    ],
    'appearance settings remain one continuous panel with a predictable reading order'
);
assert.match(drawer.textContent, /阅读区布局/);
assert.match(drawer.textContent, /消息宽度/);
assert.match(drawer.textContent, /主页视觉文字/);
assert.match(drawer.textContent, /侧栏列表尺寸/);
assert.equal(
    drawer.querySelector('[data-studio-action="wallpaper"]'),
    null,
    'Appearance Studio must not add a Next-only entry for an upstream Classic plugin'
);
assert.match(drawer.textContent, /头像大小/);
assert.match(drawer.textContent, /侧栏列表圆角/);
assert.match(drawer.textContent, /直角 · 0px/);
assert.match(drawer.textContent, /圆润 · 14px/);
assert.equal(drawer.querySelectorAll('[data-appearance-key="radius"]').length, 5);
assert.ok(drawer.querySelector('[data-appearance-key="customRadius"]').classList.contains('vcp-ui-range'), 'studio ranges use the shared VCPUI design');
assert.match(drawer.textContent, /控制整个聊天阅读区/);
assert.match(drawer.textContent, /控制单条消息的最大宽度/);
drawer.querySelector('[data-appearance-key="homeVisual"][data-appearance-value="hidden"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.documentElement.dataset.vcpHomeVisual, 'hidden');
const studioTaglineInput = drawer.querySelector('[data-home-tagline-input]');
assert.equal(studioTaglineInput.value, '语义级打穿 AI、UI/UX、APP 与人类想象力的边界');
studioTaglineInput.value = '自定义首页寄语';
studioTaglineInput.dispatchEvent(new Event('input', { bubbles: true }));
drawer.querySelector('[data-appearance-key="homeTagline"][data-appearance-value="hidden"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.getElementById('nextUiEmptyTagline').textContent, '自定义首页寄语');
assert.equal(document.getElementById('nextUiEmptyTagline').hidden, true);
const sidebarRowHeight = drawer.querySelector('[data-appearance-key="sidebarRowHeight"]');
sidebarRowHeight.value = '58';
sidebarRowHeight.dispatchEvent(new Event('input', { bubbles: true }));
await new Promise(resolve => setImmediate(resolve));
assert.match(document.getElementById('vcpAppearanceLayoutVariables').textContent, /--vcp-appearance-sidebar-row-height:58px/);
assert.equal(drawer.querySelector('[data-appearance-output="sidebarRowHeight"]').textContent, '58px');
assert.equal(drawer.querySelector('[data-appearance-output="sidebarAvatarSize"]').textContent, '44px');
const sidebarAvatarSize = drawer.querySelector('[data-appearance-key="sidebarAvatarSize"]');
sidebarAvatarSize.value = '48';
sidebarAvatarSize.dispatchEvent(new Event('input', { bubbles: true }));
await new Promise(resolve => setImmediate(resolve));
assert.match(document.getElementById('vcpAppearanceLayoutVariables').textContent, /--vcp-appearance-sidebar-avatar-size:48px/);
const geometryRadius = drawer.querySelector('.vcp-appearance-geometry-radius [data-appearance-key="sidebarRadius"][data-appearance-value="round"]');
geometryRadius.click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.documentElement.dataset.vcpSidebarRadius, 'round');
const customRadius = drawer.querySelector('[data-appearance-key="customRadius"]');
customRadius.value = '17';
customRadius.dispatchEvent(new Event('input', { bubbles: true }));
drawer.querySelector('[data-appearance-key="radius"][data-appearance-value="custom"]').click();
drawer.querySelector('.vcp-appearance-geometry-radius [data-appearance-key="sidebarRadius"][data-appearance-value="custom"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.documentElement.dataset.vcpRadius, 'custom');
assert.equal(document.documentElement.dataset.vcpSidebarRadius, 'custom');
assert.match(document.getElementById('vcpAppearanceLayoutVariables').textContent, /--vcp-appearance-custom-radius:17px/);
assert.doesNotMatch(drawer.textContent, /内容宽度/);
drawer.querySelector('[data-appearance-key="messageWidth"][data-appearance-value="wide"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.body.classList.contains('chat-wide-layout'), true);
assert.equal(drawer.querySelectorAll('[data-appearance-key="uiMode"]').length, 0);
assert.equal(document.documentElement.dataset.uiMode, 'next');
assert.equal(drawer.querySelectorAll('[data-theme-file-name]').length, 2);
assert.equal(drawer.querySelector('[data-theme-file-name="themes默认.css"]').classList.contains('active'), true);
assert.equal(drawer.querySelectorAll('.vcp-appearance-theme-mode button').length, 3);
assert.equal(drawer.querySelectorAll('.vcp-appearance-theme-preview-system').length, 0);
drawer.querySelector('[data-theme-file-name="themes森林.css"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(drawer.querySelector('[data-theme-file-name="themes森林.css"]').classList.contains('active'), true);
assert.ok(document.getElementById('vcpAppearanceThemePreview'));
const detailMenu = drawer.querySelector('[data-radius-details]');
assert.ok(detailMenu);
const materialMenu = drawer.querySelector('[data-material-details]');
assert.ok(materialMenu);
assert.equal(materialMenu.open, false, 'advanced material parameters are collapsed by default');
assert.equal(materialMenu.querySelectorAll('input[type="range"]').length, 7);
assert.equal(materialMenu.querySelectorAll('[data-material-effect]').length, 0, 'material recipes stay outside the advanced disclosure');
assert.equal(drawer.querySelectorAll('.vcp-appearance-material-overview [data-material-effect]').length, 4);
assert.equal(drawer.querySelectorAll('.vcp-appearance-material-overview [data-appearance-key="surface"]').length, 3);
assert.equal(materialMenu.querySelector('[data-appearance-key="surfaceOpacity"]').style.getPropertyValue('--vcp-ui-range-progress'), '60%');
assert.equal(materialMenu.querySelector('[data-appearance-key="surfaceShadow"]').style.getPropertyValue('--vcp-ui-range-progress'), '18%');
materialMenu.open = true;
const blurControl = materialMenu.querySelector('[data-appearance-key="surfaceBlur"]');
blurControl.value = '32';
blurControl.dispatchEvent(new Event('input', { bubbles: true }));
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.documentElement.dataset.vcpSurface, 'custom');
assert.equal(drawer.querySelector('[data-material-details-status]').textContent, 'Vibrancy · 自定义');
assert.equal(drawer.querySelector('[data-material-output="surfaceBlur"]').textContent, '32px');
assert.equal(blurControl.style.getPropertyValue('--vcp-ui-range-progress'), '80%');
assert.match(document.getElementById('vcpAppearanceMaterialVariables').textContent, /--vcp-material-blur:32px/);
drawer.querySelector('[data-material-effect="acrylic"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.documentElement.dataset.vcpSurfaceEffect, 'acrylic');
assert.equal(drawer.querySelector('[data-material-details-status]').textContent, 'Acrylic · 自定义');
assert.equal(drawer.querySelector('[data-material-output="surfaceSaturation"]').textContent, '125%');
drawer.querySelector('[data-material-effect="liquid"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.documentElement.dataset.vcpSurfaceEffect, 'liquid');
assert.equal(drawer.querySelector('[data-material-details-status]').textContent, 'Liquid Glass · 自定义');
assert.equal(drawer.querySelector('[data-material-output="surfaceSheen"]').textContent, '38%');
materialMenu.querySelector('[data-reset-material]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.documentElement.dataset.vcpSurface, 'translucent');
assert.equal(drawer.querySelector('[data-material-details-status]').textContent, '主题原样');
assert.equal(drawer.querySelector('[data-material-output="surfaceBlur"]').textContent, '24px');
assert.equal(blurControl.style.getPropertyValue('--vcp-ui-range-progress'), '60%');
assert.equal(detailMenu.querySelector('[data-appearance-key="composerRadius"]').value, 'tuned');
detailMenu.open = true;
assert.equal(detailMenu.querySelector('[data-appearance-key="sidebarRadius"]'), null, 'sidebar radius is not duplicated inside detail radius controls');
const shellRadius = detailMenu.querySelector('[data-appearance-key="shellRadius"]');
shellRadius.value = 'round';
shellRadius.dispatchEvent(new Event('change', { bubbles: true }));
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.documentElement.dataset.vcpShellRadius, 'round');
assert.equal(drawer.querySelector('[data-radius-details-status]').textContent, '1 项自定义');
drawer.querySelector('[data-appearance-key="density"][data-appearance-value="compact"]').click();
assert.equal(document.documentElement.dataset.vcpDensity, 'compact');
drawer.querySelector('[data-appearance-key="presentation"][data-appearance-value="panel"]').click();
assert.equal(document.body.classList.contains('chat-presentation-panel'), true);
drawer.querySelector('[data-appearance-key="themeMode"][data-appearance-value="light"]').click();
assert.equal(document.body.classList.contains('light-theme'), true);
drawer.querySelector('[data-appearance-preset="focus"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.body.classList.contains('light-theme'), true, 'presets must preserve the active theme mode');

await studio.close({ rollback: true });
assert.equal(studio.isOpen(), false);
assert.equal(document.documentElement.dataset.vcpDensity, 'comfortable');
assert.equal(document.documentElement.dataset.vcpSidebarRadius, 'tuned');
assert.equal(document.body.classList.contains('dark-theme'), true);
assert.equal(document.body.classList.contains('chat-presentation-bubble'), true);
assert.equal(document.body.classList.contains('chat-wide-layout'), false);
assert.equal(document.documentElement.dataset.vcpHomeVisual, 'shown');
assert.equal(document.documentElement.dataset.vcpHomeTagline, 'shown');
assert.equal(document.getElementById('nextUiEmptyTagline').textContent, '语义级打穿 AI、UI/UX、APP 与人类想象力的边界');
assert.match(document.getElementById('vcpAppearanceLayoutVariables').textContent, /--vcp-appearance-sidebar-row-height:46px/);
assert.match(document.getElementById('vcpAppearanceLayoutVariables').textContent, /--vcp-appearance-sidebar-avatar-size:32px/);
assert.equal(document.getElementById('vcpAppearanceThemePreview'), null);
assert.deepEqual(window.chatAPI.appliedColorThemes, []);

document.getElementById('appearanceDensity').value = 'compact';
document.querySelector('input[name="chatPresentationMode"][value="panel"]').checked = true;
document.getElementById('appearanceDensity').dispatchEvent(new Event('change', { bubbles: true }));
assert.equal(document.querySelector('[data-appearance-summary-density]').textContent, '紧凑');
assert.equal(document.querySelector('[data-appearance-summary-presentation]').textContent, '面板');
document.getElementById('openAppearanceStudioFromSettings').click();
assert.equal(document.documentElement.dataset.vcpDensity, 'compact');
assert.equal(document.body.classList.contains('chat-presentation-panel'), true);
await studio.close({ rollback: true });
assert.equal(document.documentElement.dataset.vcpDensity, 'comfortable');

studio.open();
await new Promise(resolve => setImmediate(resolve));
studio.setThemeMode('dark', { persist: false, source: 'preset-theme-independence-test' });
drawer.querySelector('[data-appearance-preset="reading"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.body.classList.contains('dark-theme'), true, 'reading preset must not force light mode');
drawer.querySelector('[data-appearance-key="messageWidth"][data-appearance-value="wide"]').click();
drawer.querySelector('[data-appearance-key="homeVisual"][data-appearance-value="hidden"]').click();
studioTaglineInput.value = '为想象力打开新的边界';
studioTaglineInput.dispatchEvent(new Event('input', { bubbles: true }));
drawer.querySelector('[data-appearance-key="homeTagline"][data-appearance-value="hidden"]').click();
await new Promise(resolve => setImmediate(resolve));
drawer.querySelector('[data-reset-section="layout"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.documentElement.dataset.uiMode, 'next', 'layout reset must preserve the canonical presentation');
assert.equal(document.documentElement.dataset.vcpContentWidth, 'full');
assert.equal(document.body.classList.contains('chat-wide-layout'), false);
assert.equal(document.documentElement.dataset.vcpHomeVisual, 'shown');
assert.equal(document.documentElement.dataset.vcpDensity, 'relaxed', 'layout reset must not reset component geometry');
drawer.querySelector('[data-reset-section="geometry"]').click();
assert.equal(document.documentElement.dataset.vcpDensity, 'comfortable');
assert.equal(document.documentElement.dataset.vcpRadius, 'medium');
drawer.querySelector('[data-reset-all]').click();
assert.equal(document.documentElement.dataset.vcpTypography, 'humanist');
assert.equal(document.body.classList.contains('chat-presentation-bubble'), true);
drawer.querySelector('[data-appearance-preset="reading"]').click();
await new Promise(resolve => setImmediate(resolve));
drawer.querySelector('[data-appearance-key="messageWidth"][data-appearance-value="wide"]').click();
sidebarRowHeight.value = '54';
sidebarRowHeight.dispatchEvent(new Event('input', { bubbles: true }));
sidebarAvatarSize.value = '40';
sidebarAvatarSize.dispatchEvent(new Event('input', { bubbles: true }));
drawer.querySelector('[data-appearance-key="homeVisual"][data-appearance-value="hidden"]').click();
studioTaglineInput.value = '为想象力打开新的边界';
studioTaglineInput.dispatchEvent(new Event('input', { bubbles: true }));
drawer.querySelector('[data-appearance-key="homeTagline"][data-appearance-value="hidden"]').click();
await new Promise(resolve => setImmediate(resolve));
drawer.querySelector('[data-theme-file-name="themes森林.css"]').click();
drawer.querySelector('[data-studio-save]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(window.chatAPI.saved.length, 1);
assert.equal(Object.hasOwn(window.chatAPI.saved[0], 'uiMode'), false,
    'Appearance Studio must not write the retired main-window presentation field');
assert.equal(window.chatAPI.saved[0].appearanceProfile.typography, 'serif');
assert.equal(window.chatAPI.saved[0].chatPresentationMode, 'immersive');
assert.equal(window.chatAPI.saved[0].enableWideChatLayout, true);
assert.equal(window.chatAPI.saved[0].showHomeVisualBrand, false);
assert.equal(window.chatAPI.saved[0].showHomeVisualTagline, false);
assert.equal(window.chatAPI.saved[0].homeVisualTagline, '为想象力打开新的边界');
assert.equal(window.chatAPI.saved[0].appearanceProfile.sidebarRowHeight, 54);
assert.equal(window.chatAPI.saved[0].appearanceProfile.sidebarAvatarSize, 40);
assert.equal(window.globalSettings.enableWideChatLayout, true);
assert.equal(window.globalSettings.showHomeVisualBrand, false);
assert.equal(window.globalSettings.showHomeVisualTagline, false);
assert.equal(window.globalSettings.homeVisualTagline, '为想象力打开新的边界');
assert.equal(document.getElementById('showHomeVisualBrand').checked, false);
assert.equal(document.getElementById('appearanceSidebarRowHeightValue').value, '54px');
assert.equal(document.getElementById('appearanceSidebarAvatarSizeValue').value, '40px');
assert.equal(document.getElementById('appearanceSidebarRadius').value, 'tuned');
assert.equal(document.getElementById('appearanceCustomRadiusValue').value, '14px');
assert.equal(document.getElementById('chatLayoutModeWide').checked, true);
assert.equal(window.globalSettings.appearanceProfile.radius, 'round');
assert.deepEqual(window.chatAPI.appliedColorThemes, ['themes森林.css']);
assert.equal(studio.isOpen(), false);

studio.open();
await new Promise(resolve => setImmediate(resolve));
drawer.querySelector('[data-appearance-key="density"][data-appearance-value="compact"]').click();
await new Promise(resolve => setImmediate(resolve));
window.globalSettings.appearanceProfile = {
    ...window.globalSettings.appearanceProfile,
    density: 'relaxed',
};
window.VCPAppearance.commit(window.globalSettings.appearanceProfile, {
    uiMode: 'next',
    source: 'concurrent-settings-save',
});
await studio.close({ rollback: true });
assert.equal(document.documentElement.dataset.vcpDensity, 'relaxed', 'a stale studio snapshot must not roll back a newer committed revision');

assert.equal(studio.setThemeMode('dark', { source: 'test-theme-toggle' }), true);
assert.equal(window.globalSettings.currentThemeMode, 'dark');
assert.equal(document.body.classList.contains('dark-theme'), true);
assert.equal(window.chatAPI.themes.at(-1), 'dark');

assert.equal(studio.open({ trigger: document.getElementById('openAppearanceStudioFromSettings') }), true);
assert.equal(studio.isOpen(), true, 'canonical layout must reopen the same appearance drawer');
await studio.close({ rollback: true });
assert.equal(document.documentElement.dataset.uiMode, 'next');
assert.equal(document.documentElement.classList.contains('vcp-appearance-studio-host'), false);

studio.open();
drawer.querySelector('[data-appearance-key="density"][data-appearance-value="compact"]').click();
await new Promise(resolve => setImmediate(resolve));
drawer.querySelector('[data-studio-close]').click();
await Promise.resolve();
const unsavedPrompt = drawer.querySelector('[data-unsaved-confirm]');
assert.equal(unsavedPrompt.hidden, false, 'closing a dirty drawer must show the unsaved-changes prompt');
assert.equal(studio.isOpen(), true, 'the drawer stays open while the user decides');
assert.equal(drawer.querySelector('.vcp-appearance-studio').inert, true, 'background controls are inert while confirming');
drawer.querySelector('[data-unsaved-action="continue"]').click();
assert.equal(unsavedPrompt.hidden, true);
assert.equal(studio.isOpen(), true, 'continue editing dismisses only the prompt');
drawer.querySelector('[data-studio-close]').click();
await Promise.resolve();
drawer.querySelector('[data-unsaved-action="discard"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(studio.isOpen(), false, 'discard closes the drawer');
assert.equal(document.documentElement.dataset.vcpDensity, 'relaxed', 'discard restores the saved snapshot');

studio.open();
drawer.querySelector('[data-appearance-key="density"][data-appearance-value="compact"]').click();
await new Promise(resolve => setImmediate(resolve));
drawer.querySelector('[data-studio-cancel]').click();
await Promise.resolve();
drawer.querySelector('[data-unsaved-action="save"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(studio.isOpen(), false, 'save and close persists changes before closing');
assert.equal(window.globalSettings.appearanceProfile.density, 'compact');
assert.equal(window.chatAPI.saved.length, 2);

const savedBeforeFailedApply = window.chatAPI.saved.length;
const persistedBeforeFailedApply = {
    appearanceProfile: structuredClone(window.globalSettings.appearanceProfile),
    chatPresentationMode: window.globalSettings.chatPresentationMode,
    enableWideChatLayout: window.globalSettings.enableWideChatLayout,
    showHomeVisualBrand: window.globalSettings.showHomeVisualBrand,
    showHomeVisualTagline: window.globalSettings.showHomeVisualTagline,
    homeVisualTagline: window.globalSettings.homeVisualTagline,
    currentThemeMode: window.globalSettings.currentThemeMode
};
const originalApplyPresentation = window.applyChatPresentationMode;
let failCommittedPresentationApply = false;
window.applyChatPresentationMode = async (...args) => {
    if (failCommittedPresentationApply) {
        failCommittedPresentationApply = false;
        throw new Error('simulated committed presentation failure');
    }
    return originalApplyPresentation(...args);
};
studio.open();
drawer.querySelector('[data-appearance-key="density"][data-appearance-value="comfortable"]').click();
await new Promise(resolve => setImmediate(resolve));
failCommittedPresentationApply = true;
drawer.querySelector('[data-studio-save]').click();
await new Promise(resolve => setImmediate(resolve));
await new Promise(resolve => setImmediate(resolve));
assert.equal(window.chatAPI.saved.length, savedBeforeFailedApply + 2,
    'a local apply failure after persistence must issue a compensating settings write');
assert.equal(JSON.stringify(window.chatAPI.saved.at(-1)), JSON.stringify(persistedBeforeFailedApply),
    'the compensating write must restore the complete persisted appearance snapshot');
assert.equal(document.documentElement.dataset.vcpDensity, 'compact',
    'failed local apply must restore the in-memory appearance snapshot');
assert.equal(studio.isOpen(), true, 'failed save keeps the studio open for correction');
await studio.close({ rollback: true });
window.applyChatPresentationMode = originalApplyPresentation;

const originalTopTabManager = window.topTabManager;
let rejectFirstOverlay;
const overlayOwners = [];
const releasedOverlayOwners = [];
window.topTabManager = {
    acquireOverlay: owner => {
        overlayOwners.push(owner);
        if (overlayOwners.length === 1) {
            return new Promise((_, reject) => { rejectFirstOverlay = reject; });
        }
        return Promise.resolve(owner);
    },
    releaseOverlay: owner => { releasedOverlayOwners.push(owner); },
};
studio.open();
await new Promise(resolve => setImmediate(resolve));
await studio.close({ rollback: true });
studio.open();
await new Promise(resolve => setImmediate(resolve));
rejectFirstOverlay(new Error('simulated stale overlay acquisition failure'));
await new Promise(resolve => setImmediate(resolve));
assert.equal(studio.isOpen(), true, 'a stale overlay failure must not invalidate a newer open');
await studio.close({ rollback: true });
await new Promise(resolve => setImmediate(resolve));
assert.equal(overlayOwners.length, 2);
assert.notStrictEqual(overlayOwners[0], overlayOwners[1], 'each Appearance open needs an isolated overlay identity');
assert.deepEqual(releasedOverlayOwners, overlayOwners, 'both old and current overlay leases must be released exactly once');
assert.equal(
    window.VCPLifecycle.diagnostics.find('next:appearance-studio-open').length,
    0,
    'failed overlay acquisition must not retain the per-open Appearance Studio scope'
);
window.topTabManager = originalTopTabManager;

studio.open();
const closeBeforeReopen = studio.close({ rollback: true });
assert.equal(studio.open(), true, 'an open requested during teardown should be queued');
await closeBeforeReopen;
await new Promise(resolve => setImmediate(resolve));
assert.equal(studio.isOpen(), true, 'queued open should mount only after prior teardown completes');
await studio.close({ rollback: true });

const source = fs.readFileSync('main.html', 'utf8');
assert.match(source, /nextUiAccountAppearanceStudioBtn/);
assert.match(source, /nextUiAccountThemeStoreBtn/);
assert.match(source, />主题管理器</);
assert.match(source, /nextUiAccountThemeToggleBtn/);
assert.doesNotMatch(source, /nextUiAccountPresentationBtn/);
assert.doesNotMatch(source, />使用新版 UI</);
assert.doesNotMatch(
    fs.readFileSync('modules/ui-system/appearance-studio.js', 'utf8'),
    /vchatDynamicWallpaperMenuButton|data-studio-action="wallpaper"/,
    'Next Appearance Studio must not depend on a plugin-specific wallpaper adapter'
);
await studio.destroy();
console.log('appearance studio checks passed.');
