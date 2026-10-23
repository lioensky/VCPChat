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
        <select id="appearanceWallpaperScope"><option value="theme">主题</option><option value="panel">内容区</option><option value="global">全局</option></select>
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
        fontScale: 'normal', contentWidth: 'full', wallpaperScope: 'theme', surface: 'translucent',
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
        const materialized = {};
        for (const operation of patch?.__vcpSettingsOps || []) {
            if (operation.op !== 'set') continue;
            let target = materialized;
            const path = Array.isArray(operation.path) ? operation.path : [];
            path.slice(0, -1).forEach(key => {
                target[key] ||= {};
                target = target[key];
            });
            if (path.length) target[path.at(-1)] = operation.value;
        }
        this.saved.push(Object.keys(materialized).length ? materialized : patch);
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
const normalizePresentation = mode => ['bubble', 'panel', 'immersive', 'messenger'].includes(mode) ? mode : 'bubble';
let applyPresentation = async mode => {
    const normalized = normalizePresentation(mode);
    window.globalSettings.chatPresentationMode = normalized;
    window.document.body.classList.toggle('chat-presentation-bubble', normalized === 'bubble');
    window.document.body.classList.toggle('chat-presentation-panel', normalized === 'panel');
    window.document.body.classList.toggle('chat-presentation-immersive', normalized === 'immersive');
    window.document.body.classList.toggle('chat-presentation-messenger', normalized === 'messenger');
    return { success: true, mode: normalized };
};

// The legacy flow below is the manual preview → apply mode; instant apply has its own block near the end.
window.localStorage.setItem('vcp-appearance-studio-auto-apply', '0');
window.eval(fs.readFileSync('modules/ui-system/lifecycle-scope.js', 'utf8'));
window.eval(fs.readFileSync('modules/ui-system/appearance-engine.js', 'utf8'));
window.eval(fs.readFileSync('modules/renderer/chat-header-style.js', 'utf8'));
window.eval(fs.readFileSync('modules/ui-system/appearance-studio.js', 'utf8'));
window.dispatchEvent(new CustomEvent('vcp-appearance-studio-configure', { detail: {
    settings: {
        get: () => structuredClone(window.globalSettings),
        replace: patch => Object.assign(window.globalSettings, structuredClone(patch || {})),
    },
    appearance: window.VCPAppearance,
    uiManager: window.uiManager,
    presentation: {
        normalize: normalizePresentation,
        apply: (...args) => applyPresentation(...args),
    },
} }));
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
const tick = () => new Promise(resolve => setImmediate(resolve));
const closedModals = [];
window.uiHelperFunctions.closeModal = id => { closedModals.push(id); };

// Stand-in for the side pane: one tab host, mounted while the "tab" is open.
const host = document.createElement('div');
document.body.append(host);
let tabHandle = null;
let openRequests = 0;
const opener = {
    async open() {
        openRequests += 1;
        if (!tabHandle) tabHandle = studio.mount(host, {});
        return tabHandle;
    },
    async close() {
        const handle = tabHandle;
        tabHandle = null;
        await handle?.dispose();
    }
};
const view = () => host.querySelector('.side-appearance-root');
const press = (key, value) => view()
    .querySelector(`[data-appearance-key="${key}"][data-appearance-value="${value}"]`).click();
const inputValue = (control, value) => {
    control.value = String(value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
};
const layoutVariables = () => document.getElementById('vcpAppearanceLayoutVariables').textContent;
const rootData = () => document.documentElement.dataset;

assert.deepEqual(
    Object.keys(studio.PRESETS),
    ['balanced', 'minimal'],
    'two presets only: the default look and the minimal capsule-header chat layout'
);
assert.equal(studio.PRESETS.minimal.name, '极简');
assert.equal(studio.PRESETS.minimal.presentation, 'messenger');
assert.equal(studio.PRESETS.minimal.chatHeader, 'capsule');
assert.equal(studio.PRESETS.balanced.chatHeader, 'classic');
assert.equal(studio.PRESETS.minimal.themeMode, undefined);

// Without an opener (a window with no side pane) the studio refuses instead of failing silently.
assert.equal(studio.open(), false);
assert.equal(studio.isOpen(), false);

const unregisterOpener = studio.registerOpener(opener);
assert.equal(studio.open({ trigger: document.getElementById('nextUiAccountAppearanceStudioBtn') }), true);
await tick();
assert.equal(studio.isOpen(), true);
assert.equal(openRequests, 1);
assert.ok(view(), 'the studio renders inside the side pane tab host');
assert.equal(document.getElementById('vcpAppearanceStudio'), null, 'no full-window overlay is created any more');
assert.equal(document.documentElement.classList.contains('vcp-appearance-studio-host'), false);
assert.equal(host.classList.contains('side-appearance-view'), true);

// Layout: presets first, then six accordion sections; only layout starts expanded.
const sections = [...view().querySelectorAll('details.side-appearance-section')];
assert.deepEqual(sections.map(section => section.dataset.section), ['layout', 'tools', 'shape', 'type', 'home', 'theme']);
assert.deepEqual(sections.map(section => section.open), [true, false, false, false, false, false],
    'theme and palette stay folded until asked for');
assert.ok(
    view().querySelector('.side-appearance-presets').compareDocumentPosition(sections[0])
        & window.Node.DOCUMENT_POSITION_FOLLOWING,
    'presets appear before the detailed sections'
);
assert.equal(view().querySelectorAll('[data-appearance-preset]').length, 2);
assert.equal(view().querySelectorAll('[data-appearance-key="wallpaperScope"]').length, 3);
assert.equal(view().querySelectorAll('[data-appearance-key="radius"]').length, 5);
assert.ok(
    view().querySelector('[data-appearance-key="customRadius"]').classList.contains('vcp-ui-range'),
    'studio ranges use the shared VCPUI design'
);
assert.equal(view().querySelector('[data-row="customRadius"]').hidden, true,
    'the custom radius slider only shows when it matters');
assert.ok(view().querySelector('[data-section-summary="layout"]').textContent.includes('气泡'));

// Controls that never had a visible effect are gone.
for (const key of [
    'sidebarAvatarSize', 'surfaceBlur', 'surfaceOpacity', 'surfaceSaturation', 'surfaceBrightness',
    'surfaceBorder', 'surfaceShadow', 'surfaceSheen', 'surfaceEffect'
]) {
    assert.equal(view().querySelector(`[data-appearance-key="${key}"]`), null, `${key} is no longer exposed`);
}
assert.equal(view().querySelector('[data-material-details]'), null);
assert.doesNotMatch(view().textContent, /头像大小|磨砂|Acrylic|Liquid/);
assert.equal(view().querySelector('[data-unsaved-confirm]'), null);
assert.equal(view().querySelector('[data-studio-action="wallpaper"]'), null,
    'Appearance Studio must not add a Next-only entry for an upstream Classic plugin');
assert.equal(view().querySelector('[data-studio-save]').disabled, true);
assert.equal(view().querySelector('[data-studio-status]').textContent, '已同步');

// Section open state is remembered across tab reopen.
sections[5].open = true;
sections[5].dispatchEvent(new window.Event('toggle'));
sections[0].open = false;
sections[0].dispatchEvent(new window.Event('toggle'));

// Presets.
assert.equal(view().querySelector('[data-current-preset]').textContent, '默认');
view().querySelector('[data-appearance-preset="minimal"]').click();
await tick();
assert.equal(document.body.classList.contains('chat-header-capsule'), true, 'minimal turns the chat header into a capsule');
assert.equal(document.body.classList.contains('chat-presentation-messenger'), true, 'minimal uses the conversation layout');
assert.equal(rootData().vcpRadius, 'medium', 'a preset never changes corner radius');
assert.equal(view().querySelector('[data-current-preset]').textContent, '极简');
assert.equal(view().querySelector('[data-appearance-preset="minimal"]').getAttribute('aria-pressed'), 'true');
assert.equal(view().querySelector('[data-studio-status]').textContent, '预览中 · 未应用');
assert.equal(view().querySelector('[data-studio-save]').disabled, false);
press('chatHeader', 'classic');
await tick();
assert.equal(view().querySelector('[data-current-preset]').textContent, '自定义', 'tweaking a preset field leaves the preset');
view().querySelector('[data-appearance-preset="balanced"]').click();
await tick();
assert.equal(document.body.classList.contains('chat-header-capsule'), false);
assert.equal(view().querySelector('[data-studio-status]').textContent, '已同步',
    'returning to the saved look leaves nothing to apply');
assert.equal(view().querySelector('[data-studio-save]').disabled, true);

// Direct controls.
press('homeVisual', 'hidden');
await tick();
assert.equal(rootData().vcpHomeVisual, 'hidden');
const taglineInput = view().querySelector('[data-home-tagline-input]');
assert.equal(taglineInput.value, '语义级打穿 AI、UI/UX、APP 与人类想象力的边界');
inputValue(taglineInput, '自定义首页寄语');
press('homeTagline', 'hidden');
await tick();
assert.equal(document.getElementById('nextUiEmptyTagline').textContent, '自定义首页寄语');
assert.equal(document.getElementById('nextUiEmptyTagline').hidden, true);
inputValue(view().querySelector('[data-appearance-key="sidebarRowHeight"]'), 58);
await tick();
assert.match(layoutVariables(), /--vcp-appearance-sidebar-row-height:58px/);
assert.match(layoutVariables(), /--vcp-appearance-sidebar-avatar-size:44px/,
    'avatar size follows the row height automatically');
assert.equal(view().querySelector('[data-appearance-output="sidebarRowHeight"]').textContent, '58px');
press('radius', 'custom');
inputValue(view().querySelector('[data-appearance-key="customRadius"]'), 17);
await tick();
assert.equal(rootData().vcpRadius, 'custom');
assert.match(layoutVariables(), /--vcp-appearance-custom-radius:17px/);
press('wallpaperScope', 'global');
await tick();
assert.equal(rootData().vcpWallpaperScopePreference, 'global');
assert.equal(rootData().vcpWallpaperScope, 'global');
press('messageWidth', 'wide');
await tick();
assert.equal(document.body.classList.contains('chat-wide-layout'), true);
press('density', 'compact');
assert.equal(rootData().vcpDensity, 'compact');
press('presentation', 'panel');
await tick();
assert.equal(document.body.classList.contains('chat-presentation-panel'), true);
assert.equal(document.documentElement.dataset.uiMode, 'next');
assert.equal(view().querySelectorAll('[data-appearance-key="uiMode"]').length, 0);

// Per-region radius lives behind a disclosure.
const detailMenu = view().querySelector('[data-radius-details]');
assert.ok(detailMenu);
assert.equal(detailMenu.open, false);
assert.equal(detailMenu.querySelectorAll('select[data-appearance-key]').length, 4);
detailMenu.open = true;
const shellRadius = detailMenu.querySelector('[data-appearance-key="shellRadius"]');
shellRadius.value = 'round';
shellRadius.dispatchEvent(new Event('change', { bubbles: true }));
await tick();
assert.equal(rootData().vcpShellRadius, 'round');
assert.equal(view().querySelector('[data-radius-details-status]').textContent, '1 项独立');

// Theme section.
assert.equal(view().querySelectorAll('[data-theme-file-name]').length, 2);
assert.equal(view().querySelector('[data-theme-file-name="themes默认.css"]').classList.contains('active'), true);
assert.equal(view().querySelectorAll('[data-appearance-key="themeMode"]').length, 3);
view().querySelector('[data-theme-file-name="themes森林.css"]').click();
await tick();
assert.equal(view().querySelector('[data-theme-file-name="themes森林.css"]').classList.contains('active'), true);
assert.ok(document.getElementById('vcpAppearanceThemePreview'));
press('themeMode', 'light');
await tick();
assert.equal(document.body.classList.contains('light-theme'), true);
view().querySelector('[data-appearance-preset="minimal"]').click();
await tick();
assert.equal(document.body.classList.contains('light-theme'), true, 'presets must preserve the active theme mode');
assert.equal(rootData().vcpWallpaperScope, 'global', 'presets must preserve the wallpaper scope');
assert.equal(view().querySelector('[data-theme-file-name="themes森林.css"]').classList.contains('active'), true,
    'presets must preserve the colour theme');

// Closing the tab rolls back anything that was only previewed.
await studio.close();
assert.equal(studio.isOpen(), false);
assert.equal(view(), null);
assert.equal(host.classList.contains('side-appearance-view'), false);
assert.equal(rootData().vcpDensity, 'comfortable');
assert.equal(rootData().vcpRadius, 'medium');
assert.equal(rootData().vcpShellRadius, 'tuned');
assert.equal(rootData().vcpWallpaperScopePreference, 'theme');
assert.equal(rootData().vcpWallpaperScope, 'panel');
assert.equal(document.body.classList.contains('dark-theme'), true);
assert.equal(document.body.classList.contains('chat-presentation-bubble'), true);
assert.equal(document.body.classList.contains('chat-wide-layout'), false);
assert.equal(rootData().vcpHomeVisual, 'shown');
assert.equal(rootData().vcpHomeTagline, 'shown');
assert.equal(document.getElementById('nextUiEmptyTagline').textContent, '语义级打穿 AI、UI/UX、APP 与人类想象力的边界');
assert.match(layoutVariables(), /--vcp-appearance-sidebar-row-height:46px/);
assert.match(layoutVariables(), /--vcp-appearance-sidebar-avatar-size:32px/);
assert.equal(document.getElementById('vcpAppearanceThemePreview'), null);
assert.deepEqual(window.chatAPI.appliedColorThemes, []);
assert.deepEqual(window.chatAPI.saved, [], 'a discarded preview never reaches storage');

// The folded sections stay as the user left them.
studio.open();
await tick();
assert.deepEqual(
    [...view().querySelectorAll('details.side-appearance-section')].map(section => section.open),
    [false, false, false, false, false, true]
);
await studio.close();

// Opening from the global settings card hands the form values to the tab and folds the modal away.
document.getElementById('appearanceDensity').value = 'compact';
document.querySelector('input[name="chatPresentationMode"][value="panel"]').checked = true;
document.getElementById('appearanceDensity').dispatchEvent(new Event('change', { bubbles: true }));
assert.equal(document.querySelector('[data-appearance-summary-density]').textContent, '紧凑');
assert.equal(document.querySelector('[data-appearance-summary-presentation]').textContent, '面板');
document.getElementById('openAppearanceStudioFromSettings').click();
await tick();
assert.deepEqual(closedModals, ['globalSettingsModal']);
assert.equal(studio.isOpen(), true);
assert.equal(rootData().vcpDensity, 'compact');
assert.equal(document.body.classList.contains('chat-presentation-panel'), true);
// Triggering again while the tab is open merges the form values instead of resetting the session.
document.getElementById('appearanceDensity').value = 'relaxed';
document.getElementById('openAppearanceStudioFromSettings').click();
await tick();
assert.equal(openRequests >= 3, true);
assert.equal(rootData().vcpDensity, 'relaxed');
await studio.close();
assert.equal(rootData().vcpDensity, 'comfortable');
document.getElementById('appearanceDensity').value = 'comfortable';
document.querySelector('input[name="chatPresentationMode"][value="bubble"]').checked = true;
document.getElementById('appearanceDensity').dispatchEvent(new Event('change', { bubbles: true }));

// Reset and revert.
studio.open();
await tick();
studio.setThemeMode('dark', { persist: false, source: 'preset-theme-independence-test' });
view().querySelector('[data-appearance-preset="minimal"]').click();
await tick();
assert.equal(document.body.classList.contains('dark-theme'), true, 'preset must not force light mode');
press('messageWidth', 'wide');
view().querySelector('[data-reset-all]').click();
await tick();
assert.equal(rootData().vcpTypography, 'humanist');
assert.equal(rootData().vcpContentWidth, 'full');
assert.equal(document.body.classList.contains('chat-wide-layout'), false);
assert.equal(document.body.classList.contains('chat-presentation-bubble'), true);
press('density', 'compact');
assert.equal(rootData().vcpDensity, 'compact');
view().querySelector('[data-studio-revert]').click();
await tick();
assert.equal(rootData().vcpDensity, 'comfortable', 'revert returns to the saved look');
assert.equal(view().querySelector('[data-studio-save]').disabled, true);

// Saving.
view().querySelector('[data-appearance-preset="minimal"]').click();
press('presentation', 'immersive');
press('typography', 'serif');
press('radius', 'round');
press('messageWidth', 'wide');
press('chatHeader', 'capsule');
assert.equal(document.body.classList.contains('chat-header-capsule'), true, 'header style previews immediately');
press('toolPresentation', 'grouped');
press('toolExpansion', 'none');
assert.equal(window.VCPAppearance.getCurrent().toolPresentation, 'grouped', 'tool mode previews immediately');
press('wallpaperScope', 'global');
inputValue(view().querySelector('[data-appearance-key="sidebarRowHeight"]'), 54);
press('homeVisual', 'hidden');
inputValue(view().querySelector('[data-home-tagline-input]'), '为想象力打开新的边界');
press('homeTagline', 'hidden');
await tick();
view().querySelector('[data-theme-file-name="themes森林.css"]').click();
await tick();
view().querySelector('[data-studio-save]').click();
await tick();
await tick();
assert.equal(window.chatAPI.saved.length, 1);
const saved = window.chatAPI.saved[0];
assert.equal(Object.hasOwn(saved, 'uiMode'), false,
    'Appearance Studio must not write the retired main-window presentation field');
assert.equal(saved.appearanceProfile.typography, 'serif');
assert.equal(saved.chatPresentationMode, 'immersive');
assert.equal(saved.enableWideChatLayout, true);
assert.equal(saved.showHomeVisualBrand, false);
assert.equal(saved.showHomeVisualTagline, false);
assert.equal(saved.homeVisualTagline, '为想象力打开新的边界');
assert.equal(saved.appearanceProfile.sidebarRowHeight, 54);
assert.equal(saved.appearanceProfile.wallpaperScope, 'global');
assert.equal(saved.appearanceProfile.toolPresentation, 'grouped');
assert.equal(saved.appearanceProfile.toolExpansion, 'none');
assert.equal(saved.chatHeaderStyle, 'capsule');
assert.equal(window.globalSettings.chatHeaderStyle, 'capsule');
assert.equal(window.globalSettings.enableWideChatLayout, true);
assert.equal(window.globalSettings.showHomeVisualBrand, false);
assert.equal(window.globalSettings.homeVisualTagline, '为想象力打开新的边界');
assert.equal(window.globalSettings.appearanceProfile.radius, 'round');
assert.equal(document.getElementById('showHomeVisualBrand').checked, false);
assert.equal(document.getElementById('appearanceSidebarRowHeightValue').value, '54px');
assert.equal(document.getElementById('appearanceWallpaperScope').value, 'global');
assert.equal(document.getElementById('chatLayoutModeWide').checked, true);
assert.deepEqual(window.chatAPI.appliedColorThemes, ['themes森林.css']);
assert.equal(studio.isOpen(), true, 'applying keeps the tab open');
assert.equal(view().querySelector('[data-studio-status]').textContent, '已同步');
assert.equal(view().querySelector('[data-studio-save]').disabled, true);
await studio.close();
assert.equal(rootData().vcpTypography, 'serif', 'closing after applying keeps the applied look');

// A stale snapshot must not roll back a newer committed revision.
studio.open();
await tick();
press('density', 'compact');
await tick();
window.globalSettings.appearanceProfile = {
    ...window.globalSettings.appearanceProfile,
    density: 'relaxed',
};
window.VCPAppearance.commit(window.globalSettings.appearanceProfile, {
    uiMode: 'next',
    source: 'concurrent-settings-save',
});
await studio.close();
assert.equal(rootData().vcpDensity, 'relaxed',
    'a stale studio snapshot must not roll back a newer committed revision');

assert.equal(studio.setThemeMode('dark', { source: 'test-theme-toggle' }), true);
assert.equal(window.globalSettings.currentThemeMode, 'dark');
assert.equal(document.body.classList.contains('dark-theme'), true);
assert.equal(window.chatAPI.themes.at(-1), 'dark');

// An external settings change is followed while nothing is being previewed.
studio.open();
await tick();
window.globalSettings.appearanceProfile = { ...window.globalSettings.appearanceProfile, density: 'compact' };
window.dispatchEvent(new CustomEvent('global-settings-updated', {
    detail: { settings: window.globalSettings, source: 'external-test' }
}));
await tick();
assert.equal(
    view().querySelector('[data-appearance-key="density"][data-appearance-value="compact"]').getAttribute('aria-pressed'),
    'true'
);
assert.equal(view().querySelector('[data-studio-save]').disabled, true, 'following an external change leaves nothing dirty');
await studio.close();

// Failed save: persisted settings and the live preview are both restored.
const savedBeforeFailedApply = window.chatAPI.saved.length;
const persistedBeforeFailedApply = {
    appearanceProfile: structuredClone(window.globalSettings.appearanceProfile),
    chatPresentationMode: window.globalSettings.chatPresentationMode,
    enableWideChatLayout: window.globalSettings.enableWideChatLayout,
    chatHeaderStyle: window.globalSettings.chatHeaderStyle,
    showHomeVisualBrand: window.globalSettings.showHomeVisualBrand,
    showHomeVisualTagline: window.globalSettings.showHomeVisualTagline,
    homeVisualTagline: window.globalSettings.homeVisualTagline,
    currentThemeMode: window.globalSettings.currentThemeMode
};
const originalApplyPresentation = applyPresentation;
let failCommittedPresentationApply = false;
applyPresentation = async (...args) => {
    if (failCommittedPresentationApply) {
        failCommittedPresentationApply = false;
        throw new Error('simulated committed presentation failure');
    }
    return originalApplyPresentation(...args);
};
studio.open();
await tick();
press('density', 'comfortable');
await tick();
failCommittedPresentationApply = true;
view().querySelector('[data-studio-save]').click();
await tick();
await tick();
assert.equal(window.chatAPI.saved.length, savedBeforeFailedApply + 2,
    'a local apply failure after persistence must issue a compensating settings write');
assert.deepEqual(window.chatAPI.saved.at(-1), persistedBeforeFailedApply,
    'the compensating write must restore the complete persisted appearance snapshot');
assert.equal(rootData().vcpDensity, 'compact',
    'failed local apply must restore the in-memory appearance snapshot');
assert.equal(studio.isOpen(), true, 'failed save keeps the tab open for correction');
await studio.close();
applyPresentation = originalApplyPresentation;

// Close racing a reopen leaves exactly one live view and no leaked scope.
studio.open();
const closing = studio.close();
studio.open();
await closing;
await tick();
await tick();
assert.equal(host.querySelectorAll('.side-appearance-root').length, 1, 'close-then-open never stacks views');
await studio.close();
assert.equal(
    window.VCPLifecycle.diagnostics.find('next:appearance-studio-view').length,
    0,
    'a closed tab must not retain the per-view Appearance Studio scope'
);

// Instant apply: edits land on their own after a short pause; manual mode keeps the two-step flow.
{
    const AUTO_KEY = 'vcp-appearance-studio-auto-apply';
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    studio.open();
    await tick();
    const autoButton = () => view().querySelector('[data-studio-auto]');
    const statusText = () => view().querySelector('[data-studio-status]').textContent;
    assert.equal(autoButton().getAttribute('aria-pressed'), 'false', 'a stored opt-out keeps manual mode');
    press('density', rootData().vcpDensity === 'compact' ? 'comfortable' : 'compact');
    await tick();
    await wait(600);
    assert.equal(statusText(), '预览中 · 未应用', 'manual mode never saves on its own');
    await studio.close();

    studio.open();
    await tick();
    autoButton().click();
    assert.equal(autoButton().getAttribute('aria-pressed'), 'true');
    assert.equal(window.localStorage.getItem(AUTO_KEY), '1', 'the preference survives a reopen');
    const savedBefore = window.chatAPI.saved.length;
    press('density', 'comfortable');
    press('messageWidth', 'wide');
    await tick();
    assert.equal(statusText(), '即将应用…');
    assert.equal(window.chatAPI.saved.length, savedBefore, 'saving waits for the pause so a burst of edits is one write');
    await wait(700);
    assert.equal(window.chatAPI.saved.length, savedBefore + 1, 'the burst is saved once');
    assert.equal(statusText(), '已同步');
    assert.equal(view().querySelector('[data-studio-save]').disabled, true);

    // Closing with a save still pending flushes it instead of rolling the preview back.
    press('density', 'compact');
    await tick();
    assert.equal(statusText(), '即将应用…');
    await studio.close();
    assert.equal(window.chatAPI.saved.length, savedBefore + 2, 'close flushes the pending save');
    assert.equal(rootData().vcpDensity, 'compact', 'the flushed edit stays applied');

    // 还原 returns to the look the tab opened with, and that is saved too.
    studio.open();
    await tick();
    press('density', 'comfortable');
    await wait(700);
    assert.equal(rootData().vcpDensity, 'comfortable');
    const savedMid = window.chatAPI.saved.length;
    view().querySelector('[data-studio-revert]').click();
    await tick();
    await wait(50);
    assert.equal(rootData().vcpDensity, 'compact', 'revert goes back to the opening look, not the last auto-saved one');
    assert.equal(window.chatAPI.saved.length, savedMid + 1);

    // Switching back to manual cancels a pending save.
    press('density', 'comfortable');
    await tick();
    assert.equal(statusText(), '即将应用…');
    autoButton().click();
    assert.equal(autoButton().getAttribute('aria-pressed'), 'false');
    assert.equal(window.localStorage.getItem(AUTO_KEY), '0');
    await wait(700);
    assert.equal(window.chatAPI.saved.length, savedMid + 1, 'manual mode drops the pending save');
    await studio.close();
    assert.equal(
        window.VCPLifecycle.diagnostics.find('next:appearance-studio-view').length,
        0,
        'instant apply leaves no timer or scope behind'
    );
}

const source = fs.readFileSync('main.html', 'utf8');
assert.match(source, /nextUiAccountAppearanceStudioBtn/);
assert.match(source, /nextUiAccountThemeStoreBtn/);
assert.match(source, />主题管理器</);
assert.match(source, /nextUiAccountThemeToggleBtn/);
assert.match(source, /styles\/ui-system\/side-pane-appearance\.css/);
assert.match(
    fs.readFileSync('modules/ui-system/side-pane/tab-types/appearance.js', 'utf8'),
    /entry:[^]*?id: 'appearance'/
);
assert.match(fs.readFileSync('modules/renderer/sidePaneWiring.js', 'utf8'), /defineAppearanceTabType/);
assert.doesNotMatch(source, /nextUiAccountPresentationBtn/);
assert.doesNotMatch(source, />使用新版 UI</);
assert.doesNotMatch(
    fs.readFileSync('modules/ui-system/appearance-studio.js', 'utf8'),
    /vchatDynamicWallpaperMenuButton|data-studio-action="wallpaper"/,
    'Next Appearance Studio must not depend on a plugin-specific wallpaper adapter'
);
unregisterOpener();
const disposeReceipt = { promise: Promise.resolve() };
window.dispatchEvent(new CustomEvent('vcp-appearance-studio-dispose', { detail: disposeReceipt }));
await disposeReceipt.promise;
console.log('appearance studio checks passed.');
