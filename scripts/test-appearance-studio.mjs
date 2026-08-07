import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!doctype html><html data-ui-mode="next"><body class="dark-theme">
    <button id="nextUiAccountAppearanceStudioBtn">外观与布局</button>
    <button id="nextUiAccountMenuTrigger">账户</button>
    <div id="nextUiAccountMenu" hidden></div>
    <form id="globalSettingsForm">
        <input type="checkbox" id="enableNextUi" checked>
        <select id="appearanceDensity"><option value="compact">紧凑</option><option value="comfortable">舒适</option><option value="relaxed">宽松</option></select>
        <select id="appearanceRadius"><option value="small">小</option><option value="medium">中</option></select>
        <select id="appearanceTypography"><option value="system">系统</option><option value="humanist">人文</option><option value="serif">衬线</option></select>
        <select id="appearanceFontScale"><option value="small">小</option><option value="normal">标准</option><option value="large">大</option></select>
        <select id="appearanceContentWidth"><option value="full">铺满</option><option value="centered">居中</option></select>
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
    requestAnimationFrame: callback => callback(),
    matchMedia: () => ({ matches: false })
});
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.matchMedia = globalThis.matchMedia;
window.globalSettings = {
    uiMode: 'next',
    currentThemeMode: 'dark',
    appearanceProfile: {
        density: 'comfortable', radius: 'medium', typography: 'humanist',
        fontScale: 'normal', contentWidth: 'full', surface: 'translucent'
    },
    chatPresentationMode: 'bubble',
    enableWideChatLayout: false
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
window.uiModeManager = {
    applied: [],
    apply(mode, options = {}) {
        const normalized = mode === 'next' ? 'next' : 'classic';
        const previousMode = document.documentElement.dataset.uiMode;
        document.documentElement.dataset.uiMode = normalized;
        this.applied.push({ mode: normalized, cache: options.cache === true });
        if (previousMode !== normalized) {
            window.dispatchEvent(new CustomEvent('ui-mode-changed', {
                detail: { mode: normalized, previousMode }
            }));
        }
        return normalized;
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

window.eval(fs.readFileSync('modules/ui-system/appearance-engine.js', 'utf8'));
window.eval(fs.readFileSync('modules/ui-system/appearance-studio.js', 'utf8'));
document.dispatchEvent(new CustomEvent('modal-ready', { detail: { modalId: 'globalSettingsModal' } }));

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
    > [...drawer.querySelectorAll('.vcp-appearance-studio-section')].indexOf(drawer.querySelector('[aria-labelledby="vcpAppearanceChatTitle"]')),
    'quick presets should appear after the detailed appearance controls'
);
assert.match(drawer.textContent, /阅读区布局/);
assert.match(drawer.textContent, /消息宽度/);
assert.match(drawer.textContent, /控制整个聊天阅读区/);
assert.match(drawer.textContent, /控制单条消息的最大宽度/);
assert.doesNotMatch(drawer.textContent, /内容宽度/);
drawer.querySelector('[data-appearance-key="messageWidth"][data-appearance-value="wide"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.body.classList.contains('chat-wide-layout'), true);
assert.equal(drawer.querySelectorAll('[data-appearance-key="uiMode"]').length, 2);
drawer.querySelector('[data-appearance-key="uiMode"][data-appearance-value="classic"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.documentElement.dataset.uiMode, 'classic');
assert.equal(studio.isOpen(), true, 'the drawer must remain open while previewing classic layout');
assert.equal(document.documentElement.classList.contains('vcp-appearance-studio-host'), true);
drawer.querySelector('[data-appearance-key="uiMode"][data-appearance-value="next"]').click();
await new Promise(resolve => setImmediate(resolve));
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
assert.equal(materialMenu.querySelectorAll('input[type="range"]').length, 7);
assert.equal(materialMenu.querySelectorAll('[data-material-effect]').length, 4);
materialMenu.open = true;
const blurControl = materialMenu.querySelector('[data-appearance-key="surfaceBlur"]');
blurControl.value = '32';
blurControl.dispatchEvent(new Event('input', { bubbles: true }));
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.documentElement.dataset.vcpSurface, 'custom');
assert.equal(drawer.querySelector('[data-material-details-status]').textContent, 'Vibrancy · 自定义');
assert.equal(drawer.querySelector('[data-material-output="surfaceBlur"]').textContent, '32px');
assert.match(document.getElementById('vcpAppearanceMaterialVariables').textContent, /--vcp-material-blur:32px/);
materialMenu.querySelector('[data-material-effect="acrylic"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.documentElement.dataset.vcpSurfaceEffect, 'acrylic');
assert.equal(drawer.querySelector('[data-material-details-status]').textContent, 'Acrylic · 自定义');
assert.equal(drawer.querySelector('[data-material-output="surfaceSaturation"]').textContent, '125%');
materialMenu.querySelector('[data-material-effect="liquid"]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.documentElement.dataset.vcpSurfaceEffect, 'liquid');
assert.equal(drawer.querySelector('[data-material-details-status]').textContent, 'Liquid Glass · 自定义');
assert.equal(drawer.querySelector('[data-material-output="surfaceSheen"]').textContent, '38%');
materialMenu.querySelector('[data-reset-material]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.documentElement.dataset.vcpSurface, 'translucent');
assert.equal(drawer.querySelector('[data-material-details-status]').textContent, '主题原样');
assert.equal(drawer.querySelector('[data-material-output="surfaceBlur"]').textContent, '24px');
assert.equal(detailMenu.querySelector('[data-appearance-key="composerRadius"]').value, 'tuned');
detailMenu.open = true;
const sidebarRadius = detailMenu.querySelector('[data-appearance-key="sidebarRadius"]');
sidebarRadius.value = 'round';
sidebarRadius.dispatchEvent(new Event('change', { bubbles: true }));
await new Promise(resolve => setImmediate(resolve));
assert.equal(document.documentElement.dataset.vcpSidebarRadius, 'round');
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
drawer.querySelector('[data-reset-section="layout"]').click();
assert.equal(document.documentElement.dataset.vcpDensity, 'comfortable');
assert.equal(document.documentElement.dataset.vcpRadius, 'medium');
drawer.querySelector('[data-reset-all]').click();
assert.equal(document.documentElement.dataset.vcpTypography, 'humanist');
assert.equal(document.body.classList.contains('chat-presentation-bubble'), true);
drawer.querySelector('[data-appearance-preset="reading"]').click();
await new Promise(resolve => setImmediate(resolve));
drawer.querySelector('[data-appearance-key="messageWidth"][data-appearance-value="wide"]').click();
await new Promise(resolve => setImmediate(resolve));
drawer.querySelector('[data-theme-file-name="themes森林.css"]').click();
drawer.querySelector('[data-studio-save]').click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(window.chatAPI.saved.length, 1);
assert.equal(window.chatAPI.saved[0].uiMode, 'next');
assert.equal(window.chatAPI.saved[0].appearanceProfile.typography, 'serif');
assert.equal(window.chatAPI.saved[0].chatPresentationMode, 'immersive');
assert.equal(window.chatAPI.saved[0].enableWideChatLayout, true);
assert.equal(window.globalSettings.enableWideChatLayout, true);
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

window.globalSettings.uiMode = 'classic';
document.getElementById('enableNextUi').checked = false;
window.uiModeManager.apply('classic');
assert.equal(studio.open({ trigger: document.getElementById('openAppearanceStudioFromSettings') }), true);
assert.equal(studio.isOpen(), true, 'classic layout must be able to reopen the same appearance drawer');
assert.equal(drawer.querySelector('[data-appearance-key="uiMode"][data-appearance-value="classic"]').classList.contains('active'), true);
await studio.close({ rollback: true });
assert.equal(document.documentElement.dataset.uiMode, 'classic');
assert.equal(document.documentElement.classList.contains('vcp-appearance-studio-host'), false);

const source = fs.readFileSync('main.html', 'utf8');
assert.match(source, /nextUiAccountAppearanceStudioBtn/);
assert.match(source, /nextUiAccountThemeStoreBtn/);
assert.match(source, />主题管理器</);
assert.match(source, /nextUiAccountThemeToggleBtn/);
assert.doesNotMatch(source, /nextUiAccountPresentationBtn/);
assert.doesNotMatch(source, />使用新版 UI</);
console.log('appearance studio checks passed.');
