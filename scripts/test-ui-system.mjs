import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const composerSafeFocusSelector = /:focus-visible:not\(#messageInput\):not\(\.chat-message-input\)\s*\{/;
const paperThemeSource = fs.readFileSync('styles/themes/themes纸墨与机芯.css', 'utf8');
assert.match(paperThemeSource, composerSafeFocusSelector, 'the paper theme must preserve the composer focus contract');
assert.doesNotMatch(
    paperThemeSource,
    /:focus-visible(?:\s|\{)/,
    'the paper theme must not apply an unscoped focus outline to component-owned inputs'
);
const activeThemeSource = fs.readFileSync('styles/themes.css', 'utf8');
if (activeThemeSource.includes(':focus-visible')) {
    assert.match(activeThemeSource, composerSafeFocusSelector, 'the active theme must preserve the composer focus contract');
}

const dom = new JSDOM('<!doctype html><html data-ui-mode="next"><body><main class="vcp-ui-scope" data-density="comfortable"></main></body></html>', {
    url: 'https://vcpchat.local/'
});

Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    Element: dom.window.Element,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MutationObserver: dom.window.MutationObserver,
    Option: dom.window.Option,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    customElements: dom.window.customElements,
    ResizeObserver: class {
        observe() {}
        disconnect() {}
    }
});

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = callback => setTimeout(callback, 16);
}
if (!dom.window.HTMLElement.prototype.scrollTo) {
    dom.window.HTMLElement.prototype.scrollTo = function scrollTo(options) {
        this.scrollTop = typeof options === 'number' ? options : options?.top || 0;
        this.dispatchEvent(new dom.window.Event('scroll'));
    };
}

await import(`${pathToFileURL(`${process.cwd()}/modules/ui-system/vcp-ui.js`).href}?contract-test=1`);
await import(`${pathToFileURL(`${process.cwd()}/modules/ui-system/webawesome-adapter.js`).href}?wa-adapter-test=1`);
assert.ok(window.VCPWebAwesome, 'WebAwesomeAdapter must be exposed on window');
// This suite exercises VCPUI factories with controlled fake custom elements;
// adapter runtime state and terminal fallback are covered independently by
// test-webawesome-adapter.mjs and the real Electron smoke.
window.VCPWebAwesome = Object.freeze({
    ...window.VCPWebAwesome,
    isDefined: tag => Boolean(customElements.get(`wa-${String(tag).toLowerCase()}`)),
});

const { VCPUI } = window;
const scope = document.querySelector('.vcp-ui-scope');
assert.ok(VCPUI, 'VCPUI should be exposed on window');

const expected = ['button', 'iconbutton', 'input', 'textarea', 'select', 'range', 'checkbox', 'switch', 'field', 'settingssection', 'settingsactionbar', 'badge', 'alert', 'card', 'tabs', 'toolbar', 'list', 'listitem', 'tableframe', 'emptystate', 'divider', 'tooltip', 'skeleton', 'segmentedcontrol', 'pagination', 'scrollarea', 'modal', 'toast', 'confirmdialog', 'inputdialog', 'apppageshell', 'windowcontrols', 'asyncboundary'];
expected.forEach(name => assert.ok(VCPUI.components.includes(name), `missing public component ${name}`));
assert.equal(VCPUI.manifest.length, 32);
assert.equal(VCPUI.getComponentMeta('ListItem').name, 'List');
assert.equal(VCPUI.getComponentMeta('Button').status, 'stable');

const input = VCPUI.create('Input', { placeholder: 'Name' });
const iconButton = VCPUI.create('IconButton', { icon: 'add', label: 'Add' });
const cases = [
    VCPUI.create('Button', { label: 'Save' }),
    iconButton,
    input,
    VCPUI.create('Textarea', { value: 'Text' }),
    VCPUI.create('Select', { options: ['One', 'Two'], value: 'One' }),
    VCPUI.create('Range', { min: 0, max: 2, step: 0.1, value: 1, label: 'Speed' }),
    VCPUI.create('Checkbox', { label: 'Check' }),
    VCPUI.create('Switch', { label: 'Toggle' }),
    VCPUI.create('Field', { label: 'Name', control: input }),
    VCPUI.create('SettingsSection', { title: 'Advanced', summary: 'Collapsed summary', content: document.createTextNode('Settings content'), collapsed: true }),
    VCPUI.create('SettingsActionBar', { saveLabel: 'Save', dangerLabel: 'Delete' }),
    VCPUI.create('Badge', { label: 'Stable' }),
    VCPUI.create('Alert', { message: 'Notice' }),
    VCPUI.create('Card', { title: 'Card' }),
    VCPUI.create('Tabs', { items: [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }] }),
    VCPUI.create('Toolbar', { start: [] }),
    VCPUI.create('List', { items: [{ label: 'Row' }] }),
    VCPUI.create('TableFrame', { columns: [{ key: 'name', label: 'Name' }], rows: [{ name: 'Row' }] }),
    VCPUI.create('EmptyState', { title: 'Empty' }),
    VCPUI.create('Divider', { label: 'Section' }),
    VCPUI.create('Tooltip', { trigger: iconButton, content: 'Add item' }),
    VCPUI.create('Skeleton', { lines: 2 }),
    VCPUI.create('SegmentedControl', { items: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }),
    VCPUI.create('Pagination', { page: 2, total: 60, pageSize: 10 }),
    VCPUI.create('ScrollArea', { content: document.createTextNode('Scrollable') })
];

cases.forEach(controller => {
    assert.ok(controller.element instanceof dom.window.Element);
    assert.equal(typeof controller.update, 'function');
    assert.equal(typeof controller.focus, 'function');
    assert.equal(typeof controller.destroy, 'function');
    scope.append(controller.element);
    controller.update({});
    controller.focus();
});

assert.equal(iconButton.element.getAttribute('aria-label'), 'Add');
assert.equal(input.control.localName, 'input', 'native Input exposes its business control');
assert.equal(input.getValue(), '');
input.setValue('Nova');
assert.equal(input.getValue(), 'Nova');
input.setDisabled(true);
assert.equal(input.control.disabled, true);
input.setDisabled(false);
const legacyRange = document.createElement('input');
legacyRange.type = 'range';
legacyRange.id = 'legacyRange';
scope.append(legacyRange);
const enhancedRange = VCPUI.enhance('Range', legacyRange, { label: 'Legacy speed', size: 'sm' });
assert.equal(enhancedRange.element, legacyRange);
assert.ok(legacyRange.classList.contains('vcp-ui-range'));
assert.equal(VCPUI.getController(legacyRange), enhancedRange);
enhancedRange.destroy();
assert.ok(legacyRange.isConnected, 'enhanced elements should remain in the DOM after destroy');
assert.equal(legacyRange.className, '');
legacyRange.remove();

const legacyInput = document.createElement('input');
legacyInput.type = 'text';
scope.append(legacyInput);
const enhancedInput = VCPUI.enhance('Input', legacyInput, { size: 'sm', invalid: true });
assert.ok(legacyInput.classList.contains('vcp-ui-native-input'));
assert.equal(legacyInput.getAttribute('aria-invalid'), 'true');
assert.equal(enhancedInput.control, legacyInput);
enhancedInput.setValue('Enhanced');
assert.equal(enhancedInput.getValue(), 'Enhanced');
enhancedInput.setDisabled(true);
assert.equal(legacyInput.disabled, true);
enhancedInput.destroy();
assert.ok(legacyInput.isConnected);
assert.equal(legacyInput.getAttribute('aria-invalid'), null);
legacyInput.remove();

class TestWaOption extends dom.window.HTMLElement {
    get value() { return this.getAttribute('value') || ''; }
    set value(next) { this.setAttribute('value', String(next)); }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(next) { this.toggleAttribute('disabled', Boolean(next)); }
}
class TestWaSelect extends dom.window.HTMLElement {
    constructor() {
        super();
        this._value = '';
        this.disabled = false;
        this.required = false;
        this.updateComplete = Promise.resolve();
    }
    get value() { return this._value; }
    set value(next) { this._value = String(next ?? ''); }
    setCustomValidity(message) { this.validationMessage = message; }
}
if (!customElements.get('wa-option')) customElements.define('wa-option', TestWaOption);
if (!customElements.get('wa-select')) customElements.define('wa-select', TestWaSelect);

const waContractSelect = VCPUI.create('Select', { options: ['One', 'Two'], value: 'One' });
scope.append(waContractSelect.element);
assert.equal(waContractSelect.control.localName, 'wa-select', 'WA Select exposes the same business control contract');
waContractSelect.setValue('Two');
assert.equal(waContractSelect.getValue(), 'Two');
waContractSelect.setDisabled(true);
assert.equal(waContractSelect.control.disabled, true);
waContractSelect.update({ size: 'sm' });
assert.equal(waContractSelect.getValue(), 'Two', 'unrelated WA Select updates preserve setValue state');

const legacySelect = document.createElement('select');
legacySelect.id = 'legacySelect';
legacySelect.className = 'legacy-filter-select';
legacySelect.style.cssText = 'width: 12rem; padding: 20px; border: 4px solid red; background: blue;';
legacySelect.setAttribute('aria-label', 'Legacy choice');
legacySelect.add(new Option('One', 'one'));
legacySelect.add(new Option('Two', 'two'));
legacySelect.value = 'one';
scope.append(legacySelect);
let legacySelectChanges = 0;
legacySelect.addEventListener('change', () => { legacySelectChanges += 1; });
const enhancedSelect = VCPUI.enhance('Select', legacySelect, { size: 'sm' });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(enhancedSelect.nativeElement, legacySelect);
assert.equal(enhancedSelect.element.localName, 'wa-select');
assert.ok(enhancedSelect.element.classList.contains('legacy-filter-select'));
assert.equal(enhancedSelect.element.style.width, '12rem');
assert.equal(enhancedSelect.element.style.padding, '', 'legacy visual padding is not copied to the WA host');
assert.equal(enhancedSelect.element.style.border, '', 'legacy visual border is not copied to the WA host');
assert.equal(enhancedSelect.element.style.background, '', 'legacy visual background is not copied to the WA host');
assert.ok(legacySelect.classList.contains('vcp-ui-select-source'));
assert.equal(enhancedSelect.element.querySelectorAll('wa-option').length, 2);
assert.equal(enhancedSelect.element.value, 'one');
legacySelect.value = 'two';
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(enhancedSelect.element.value, 'two', 'native value writes sync to WA');
legacySelect.add(new Option('Three', 'three'));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(enhancedSelect.element.querySelectorAll('wa-option').length, 3, 'native option additions sync to WA');
enhancedSelect.element.value = 'three';
enhancedSelect.element.dispatchEvent(new Event('change', { bubbles: true }));
assert.equal(legacySelect.value, 'three', 'WA value syncs to native source');
assert.equal(legacySelectChanges, 1, 'WA change relays exactly one native change');
assert.equal(VCPUI.getController(legacySelect), enhancedSelect, 'repeat enhancement resolves the proxy controller');
enhancedSelect.destroy();
assert.ok(legacySelect.isConnected, 'destroy restores the native select');
assert.ok(!legacySelect.classList.contains('vcp-ui-select-source'));
legacySelect.remove();

const dynamicSelectRoot = document.createElement('div');
scope.append(dynamicSelectRoot);
const selectObserver = VCPUI.observeControls(dynamicSelectRoot, { kinds: ['Select'] });
const dynamicSelect = document.createElement('select');
dynamicSelect.add(new Option('Dynamic', 'dynamic'));
dynamicSelectRoot.append(dynamicSelect);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(dynamicSelectRoot.querySelectorAll('wa-select.vcp-ui-select-proxy').length, 1, 'dynamic Select receives one proxy');
selectObserver.refresh();
assert.equal(dynamicSelectRoot.querySelectorAll('wa-select.vcp-ui-select-proxy').length, 1, 'refresh does not duplicate Select proxies');
selectObserver.destroy();
assert.equal(dynamicSelectRoot.querySelectorAll('wa-select.vcp-ui-select-proxy').length, 0, 'observer teardown removes owned proxies');
assert.equal(dynamicSelect.hidden, false, 'observer teardown restores native Select visibility');
dynamicSelectRoot.remove();

document.documentElement.dataset.uiMode = 'classic';
const lateUpgradeSelect = document.createElement('select');
lateUpgradeSelect.add(new Option('Late', 'late'));
scope.append(lateUpgradeSelect);
const nativeSelectController = VCPUI.enhance('Select', lateUpgradeSelect);
assert.equal(nativeSelectController.kernel, 'native');
document.documentElement.dataset.uiMode = 'next';
const upgradedSelectController = VCPUI.enhance('Select', lateUpgradeSelect);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(upgradedSelectController.kernel, 'webawesome-proxy', 'native Select upgrades after WA becomes available');
assert.notEqual(upgradedSelectController, nativeSelectController);
upgradedSelectController.destroy();
lateUpgradeSelect.remove();

const legacySection = document.createElement('section');
legacySection.className = 'agent-settings-section collapsed';
legacySection.innerHTML = '<div class="agent-settings-section-header"><button class="agent-settings-toggle-btn"></button></div><div class="agent-settings-section-content"></div>';
scope.append(legacySection);
const enhancedSection = VCPUI.enhance('SettingsSection', legacySection);
assert.equal(legacySection.dataset.state, 'collapsed');
assert.equal(legacySection.querySelector('button').getAttribute('aria-expanded'), 'false');
legacySection.classList.remove('collapsed');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(legacySection.dataset.state, 'expanded');
enhancedSection.destroy();
assert.ok(legacySection.isConnected);
legacySection.remove();

const settingsHost = document.createElement('div');
settingsHost.id = 'tabContentSettings';
settingsHost.innerHTML = `
    <form id="agentSettingsForm">
        <section class="agent-settings-section collapsed">
            <div class="agent-settings-section-header"><button type="button" class="agent-settings-toggle-btn"></button></div>
            <div class="agent-settings-section-content"></div>
        </section>
        <div class="group-settings-field-shell"><label for="bridgeInput">Name</label><input id="bridgeInput" type="text" required><small>Required</small></div>
        <select id="bridgeSelect"><option>One</option></select>
        <label class="switch"><input type="checkbox"><span class="slider"></span></label>
        <div class="form-actions"><button type="submit">Save</button><button type="button" class="danger-button">Delete</button></div>
    </form>`;
scope.append(settingsHost);
await import(`${pathToFileURL(`${process.cwd()}/modules/ui-system/settings-bridge.js`).href}?contract-test=1`);
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(document.getElementById('bridgeInput').classList.contains('vcp-ui-native-input'));
assert.ok(document.getElementById('bridgeSelect').classList.contains('vcp-ui-native-select'));
assert.ok(settingsHost.querySelector('.switch').classList.contains('vcp-ui-native-switch'));
assert.ok(settingsHost.querySelector('.agent-settings-section').classList.contains('vcp-ui-settings-section'));
assert.ok(settingsHost.querySelector('.group-settings-field-shell').classList.contains('vcp-ui-settings-field'));
const bridgedActionBar = settingsHost.querySelector('.form-actions');
assert.ok(bridgedActionBar.classList.contains('vcp-ui-settings-action-bar'));
document.getElementById('bridgeInput').value = 'Changed';
document.getElementById('bridgeInput').dispatchEvent(new Event('input', { bubbles: true }));
assert.equal(bridgedActionBar.dataset.state, 'dirty');
document.getElementById('agentSettingsForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
assert.equal(bridgedActionBar.dataset.state, 'saving');
document.getElementById('agentSettingsForm').dispatchEvent(new CustomEvent('vcp-settings-save-result', { detail: { success: true } }));
assert.equal(bridgedActionBar.dataset.state, 'clean');
bridgedActionBar.querySelector('.danger-button').click();
assert.equal(bridgedActionBar.dataset.state, 'deleting');
document.getElementById('agentSettingsForm').dispatchEvent(new CustomEvent('vcp-settings-delete-result', { detail: { success: false, cancelled: true } }));
assert.equal(bridgedActionBar.dataset.state, 'clean');

const dynamicGroupForm = document.createElement('form');
dynamicGroupForm.id = 'groupSettingsForm';
dynamicGroupForm.innerHTML = '<textarea id="dynamicGroupPrompt"></textarea>';
settingsHost.append(dynamicGroupForm);
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(document.getElementById('dynamicGroupPrompt').classList.contains('vcp-ui-native-textarea'));

// Global settings modal is enhanced independently of the sidebar presentation
// gate: controls, save bar and injected search only in next mode.
const modalContainer = document.createElement('div');
modalContainer.id = 'modal-container';
const globalModal = document.createElement('div');
globalModal.className = 'modal vcp-ui-scope';
globalModal.id = 'globalSettingsModal';
globalModal.innerHTML = `
    <div class="global-settings-modal-content">
        <div class="global-settings-content">
            <form id="globalSettingsForm">
                <input id="globalUserName" type="text">
                <select id="globalSelect"><option>A</option><option>B</option></select>
            </form>
        </div>
        <div class="global-settings-footer"><button type="submit" form="globalSettingsForm">保存全局设置</button></div>
    </div>`;
modalContainer.append(globalModal);
scope.append(modalContainer);
await import(`${pathToFileURL(`${process.cwd()}/modules/ui-system/settings-bridge.js`).href}?global-settings-contract-test=1`);
window.VCPUISettingsBridge.refresh();
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(document.getElementById('globalUserName').classList.contains('vcp-ui-native-input'), 'global input enhanced');
assert.ok(document.getElementById('globalSelect').classList.contains('vcp-ui-native-select'), 'global select enhanced');
const globalFooter = globalModal.querySelector('.global-settings-footer');
assert.ok(globalFooter.classList.contains('vcp-ui-settings-action-bar'), 'global save bar enhanced');
assert.ok(globalModal.querySelector('.vcp-ui-settings-search'), 'settings search injected');
document.getElementById('globalUserName').value = 'Changed';
document.getElementById('globalUserName').dispatchEvent(new Event('input', { bubbles: true }));
assert.equal(globalFooter.dataset.state, 'dirty', 'global save bar tracks dirty state');
document.getElementById('globalSettingsForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
assert.equal(globalFooter.dataset.state, 'saving', 'global save bar tracks saving state');
window.VCPUISettingsBridge.destroy();
modalContainer.remove();

document.documentElement.dataset.uiMode = 'classic';
window.dispatchEvent(new CustomEvent('ui-mode-changed'));
assert.ok(!document.getElementById('bridgeInput').classList.contains('vcp-ui-native-input'));
window.VCPUISettingsBridge.destroy();
settingsHost.remove();
document.documentElement.dataset.uiMode = 'next';

const classicPresentationSettingsHost = document.createElement('div');
classicPresentationSettingsHost.id = 'tabContentSettings';
classicPresentationSettingsHost.dataset.settingsPresentation = 'classic';
classicPresentationSettingsHost.innerHTML = '<form id="agentSettingsForm"><input id="classicPresentationInput" type="text"></form>';
scope.append(classicPresentationSettingsHost);
await import(`${pathToFileURL(`${process.cwd()}/modules/ui-system/settings-bridge.js`).href}?classic-presentation-contract-test=1`);
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(!document.getElementById('classicPresentationInput').classList.contains('vcp-ui-native-input'));
assert.equal(window.VCPUISettingsBridge.enhancedCount, 0);
window.VCPUISettingsBridge.destroy();
classicPresentationSettingsHost.remove();

assert.equal(VCPUI.setDensity(scope, 'compact'), 'compact');
assert.equal(VCPUI.getDensity(scope), 'compact');
assert.equal(scope.dataset.density, 'compact');

// --- Component behavior, native fallback kernel ---
// Button: loading implies disabled + aria-busy; a disabled button swallows clicks.
const behaviorButton = VCPUI.create('Button', { label: 'Save', loading: true });
assert.equal(behaviorButton.element.disabled, true, 'loading button must be disabled');
assert.equal(behaviorButton.element.getAttribute('aria-busy'), 'true');
let behaviorButtonClicks = 0;
behaviorButton.element.addEventListener('click', () => { behaviorButtonClicks += 1; });
behaviorButton.element.click();
assert.equal(behaviorButtonClicks, 0, 'disabled button must not emit click');
behaviorButton.update({ loading: false, disabled: true });
behaviorButton.element.click();
assert.equal(behaviorButtonClicks, 0, 'disabled button must swallow clicks');
behaviorButton.destroy();

// IconButton: aria-label is required and stored.
const behaviorIconButton = VCPUI.create('IconButton', { icon: 'close', label: '关闭' });
assert.equal(behaviorIconButton.element.getAttribute('aria-label'), '关闭');
assert.equal(behaviorIconButton.element.getAttribute('aria-pressed'), null);
behaviorIconButton.destroy();

// WindowControls: a page handler and the utility fallback are mutually
// exclusive. Calling both makes maximize toggle twice and appear inert.
const windowCalls = { pageMinimize: 0, pageMaximize: 0, pageClose: 0, fallbackMinimize: 0, fallbackMaximize: 0, fallbackClose: 0 };
window.utilityAPI = {
    minimizeWindow: () => { windowCalls.fallbackMinimize += 1; },
    maximizeWindow: () => { windowCalls.fallbackMaximize += 1; },
    closeWindow: () => { windowCalls.fallbackClose += 1; },
};
const behaviorWindowControls = VCPUI.create('WindowControls', {
    onMinimize: () => { windowCalls.pageMinimize += 1; },
    onMaximize: () => { windowCalls.pageMaximize += 1; },
    onClose: () => { windowCalls.pageClose += 1; },
});
assert.equal(behaviorWindowControls.element.querySelectorAll('.vcp-ui-window-control-button').length, 3,
    'WindowControls must mark every clickable host as a no-drag control');
const uiComponentsCss = fs.readFileSync(new URL('../styles/ui-system/components.css', import.meta.url), 'utf8');
const nextUiCss = fs.readFileSync(new URL('../styles/ui-next.css', import.meta.url), 'utf8');
assert.match(nextUiCss,
    /html\[data-ui-mode="next"\] \.main-content\s*\{[^}]*overflow:\s*hidden;[^}]*border-radius:\s*var\(--vcp-ui-shell-radius\) 0 0 0;[^}]*clip-path:\s*inset\(0 round var\(--vcp-ui-shell-radius\) 0 0 0\);[^}]*isolation:\s*isolate;/s,
    'the main chat panel must apply one final rounded compositor clip');
assert.match(nextUiCss,
    /html\[data-ui-mode="next"\] \.chat-header\s*\{[^}]*border-radius:\s*var\(--vcp-ui-shell-radius\) 0 0 0;/s,
    'the opaque main chat header surface must not cover the panel corner');
assert.doesNotMatch(nextUiCss,
    /html\[data-ui-mode="next"\] \.main-content\s*\{[^}]*(?:border-width|background-clip):/s,
    'the panel corner fix must not create a visible inset between the panel edge and wallpaper');
assert.match(nextUiCss,
    /\.next-ui-navigation-material\s*\{[\s\S]*clip-path:\s*polygon\([\s\S]*--vcp-ui-shell-curve-1[\s\S]*--vcp-ui-shell-curve-2[\s\S]*--vcp-ui-shell-curve-3[\s\S]*--vcp-ui-shell-curve-4[\s\S]*--vcp-ui-shell-curve-5[\s\S]*\);/s,
    'the navigation material cutout must follow the rounded panel corner instead of leaving a square underlay');
assert.match(nextUiCss,
    /\.next-ui-panel-elevation\s*\{[^}]*border-radius:\s*var\(--vcp-ui-shell-radius\) 0 0 0;[^}]*box-shadow:\s*none;/s,
    'the panel edge must not cast a rectangular shadow across the rounded cutout');
assert.match(nextUiCss,
    /\.next-ui-panel-elevation::before\s*\{[^}]*width:\s*calc\(var\(--vcp-ui-shell-radius\) \+ 1px\);[^}]*height:\s*calc\(var\(--vcp-ui-shell-radius\) \+ 1px\);[^}]*background-color:\s*var\(--next-shell-bg\);[^}]*background-image:\s*var\(--next-material-sheen\);[^}]*backdrop-filter:\s*var\(--next-backdrop-filter\);[^}]*mask-image:\s*radial-gradient\([^;]*var\(--vcp-ui-shell-radius\)[^;]*\);/s,
    'the exposed outer-corner triangle must be painted with the topbar and sidebar shell material');
assert.match(nextUiCss,
    /\.next-ui-panel-elevation::after\s*\{[^}]*width:\s*calc\(var\(--vcp-ui-shell-radius\) \+ 1px\);[^}]*height:\s*calc\(var\(--vcp-ui-shell-radius\) \+ 1px\);[^}]*border-top:\s*1px solid var\(--next-panel-edge\);[^}]*border-left:\s*1px solid var\(--next-panel-edge\);[^}]*border-radius:\s*var\(--vcp-ui-shell-radius\) 0 0 0;/s,
    'the corner patch must redraw the rounded edge above the shell-colored triangle');
assert.match(uiComponentsCss,
    /\.vcp-ui-window-control-button\s*\{[^}]*-webkit-app-region:\s*no-drag/s,
    'WindowControls must keep the no-drag contract in next-UI scoped CSS rather than inline mutation');
behaviorWindowControls.element.querySelector('[aria-label="最小化窗口"]').click();
behaviorWindowControls.element.querySelector('[aria-label="最大化窗口"]').click();
behaviorWindowControls.element.querySelector('[aria-label="关闭窗口"]').click();
assert.deepEqual(windowCalls, { pageMinimize: 1, pageMaximize: 1, pageClose: 1, fallbackMinimize: 0, fallbackMaximize: 0, fallbackClose: 0 });
behaviorWindowControls.destroy();

const fallbackWindowControls = VCPUI.create('WindowControls');
fallbackWindowControls.element.querySelector('[aria-label="最小化窗口"]').click();
fallbackWindowControls.element.querySelector('[aria-label="最大化窗口"]').click();
fallbackWindowControls.element.querySelector('[aria-label="关闭窗口"]').click();
assert.deepEqual(windowCalls, { pageMinimize: 1, pageMaximize: 1, pageClose: 1, fallbackMinimize: 1, fallbackMaximize: 1, fallbackClose: 1 });
fallbackWindowControls.destroy();

// Input: disabled / readonly / required / invalid / value / focus.
const behaviorInput = VCPUI.create('Input', { placeholder: 'Name', required: true, readonly: true, disabled: true, invalid: true });
const behaviorInputControl = behaviorInput.element.querySelector('input');
assert.equal(behaviorInputControl.disabled, true);
assert.equal(behaviorInputControl.readOnly, true);
assert.equal(behaviorInputControl.required, true);
assert.equal(behaviorInputControl.getAttribute('aria-invalid'), 'true');
behaviorInput.focus();
behaviorInput.update({ value: 'x', invalid: false, disabled: false, readonly: false });
assert.equal(behaviorInputControl.value, 'x');
assert.equal(behaviorInputControl.getAttribute('aria-invalid'), 'false');
behaviorInput.destroy();

// Textarea: rows and resize are applied to the native control.
const behaviorTextarea = VCPUI.create('Textarea', { rows: 6, resize: 'none' });
assert.equal(behaviorTextarea.element.querySelector('textarea').rows, 6);
assert.equal(behaviorTextarea.element.dataset.resize, 'none');
behaviorTextarea.destroy();

// Select: options render, value/disabled read back.
const behaviorSelect = VCPUI.create('Select', { options: ['One', 'Two'], value: 'Two', disabled: true });
assert.equal(behaviorSelect.element.querySelectorAll(behaviorSelect.element.localName === 'wa-select' ? 'wa-option' : 'option').length, 2);
assert.equal(behaviorSelect.element.value, 'Two');
assert.equal(behaviorSelect.element.disabled, true);
behaviorSelect.update({ disabled: false, value: 'One' });
assert.equal(behaviorSelect.element.value, 'One');
behaviorSelect.destroy();

// Checkbox: toggling the internal input reflects state and emits change.
const behaviorCheckbox = VCPUI.create('Checkbox', { label: 'Agree' });
const behaviorCheckboxInput = behaviorCheckbox.element.querySelector('input');
let behaviorCheckboxChanges = 0;
behaviorCheckbox.element.addEventListener('change', () => { behaviorCheckboxChanges += 1; });
behaviorCheckboxInput.checked = true;
behaviorCheckboxInput.dispatchEvent(new Event('change', { bubbles: true }));
assert.equal(behaviorCheckbox.element.dataset.state, 'checked');
assert.equal(behaviorCheckboxChanges, 1);
behaviorCheckbox.destroy();

// Switch: click toggles aria-checked and fires change; role is switch.
const behaviorSwitch = VCPUI.create('Switch', { label: 'Toggle' });
let behaviorSwitchChanges = 0;
behaviorSwitch.element.addEventListener('change', () => { behaviorSwitchChanges += 1; });
assert.equal(behaviorSwitch.element.getAttribute('role'), 'switch');
behaviorSwitch.element.click();
assert.equal(behaviorSwitch.element.getAttribute('aria-checked'), 'true');
assert.equal(behaviorSwitchChanges, 1);
behaviorSwitch.update({ checked: false });
assert.equal(behaviorSwitch.element.getAttribute('aria-checked'), 'false');
behaviorSwitch.destroy();

// Tabs: roving tabindex + arrow-key navigation + change event.
const behaviorTabs = VCPUI.create('Tabs', { items: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }, { label: 'C', value: 'c' }] });
const behaviorTabsEl = behaviorTabs.element;
scope.append(behaviorTabsEl);
const behaviorTabButtons = () => [...behaviorTabsEl.querySelectorAll('[role="tab"]')];
assert.equal(behaviorTabButtons()[0].getAttribute('aria-selected'), 'true');
assert.equal(behaviorTabButtons()[0].tabIndex, 0);
assert.equal(behaviorTabButtons()[1].tabIndex, -1);
behaviorTabButtons()[0].focus();
behaviorTabButtons()[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
let behaviorTabsCurrent = behaviorTabButtons();
assert.equal(behaviorTabsCurrent[1].getAttribute('aria-selected'), 'true');
assert.equal(behaviorTabsCurrent[1].tabIndex, 0);
behaviorTabsCurrent[1].focus();
behaviorTabsCurrent[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
behaviorTabsCurrent = behaviorTabButtons();
assert.equal(behaviorTabsCurrent[0].getAttribute('aria-selected'), 'true');
behaviorTabs.destroy();

// Card (interactive): aria-pressed tracks the selected variant.
const behaviorCard = VCPUI.create('Card', { title: 'T', description: 'D', interactive: true, variant: 'selected' });
assert.equal(behaviorCard.element.getAttribute('aria-pressed'), 'true');
behaviorCard.update({ variant: 'default' });
assert.equal(behaviorCard.element.getAttribute('aria-pressed'), 'false');
behaviorCard.destroy();

// Tooltip: aria-describedby wiring and cleanup on destroy.
const behaviorTipTrigger = VCPUI.create('Button', { label: 'Trigger' });
const behaviorTooltip = VCPUI.create('Tooltip', { trigger: behaviorTipTrigger, content: 'Help', placement: 'right' });
const behaviorBubbleId = behaviorTipTrigger.element.getAttribute('aria-describedby');
assert.ok(behaviorBubbleId, 'tooltip trigger must get aria-describedby');
behaviorTooltip.update({ open: true });
assert.equal(behaviorTooltip.element.dataset.state, 'open');
behaviorTooltip.destroy();
assert.equal(behaviorTipTrigger.element.getAttribute('aria-describedby'), null, 'destroy must unlink aria-describedby');
behaviorTipTrigger.destroy();

// Modal: Escape closes the overlay.
const behaviorFocusTarget = document.createElement('button');
scope.append(behaviorFocusTarget);
behaviorFocusTarget.focus();
const behaviorModal = VCPUI.create('Modal', { title: 'Modal', content: document.createTextNode('Body') });
scope.append(behaviorModal.element);
assert.equal(behaviorModal.element.querySelector('.vcp-ui-modal').getAttribute('role'), 'dialog');
behaviorModal.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.ok(!behaviorModal.element.isConnected, 'Escape must close the modal');
behaviorFocusTarget.remove();

const switchControl = cases.find(controller => controller.element.classList.contains('vcp-ui-switch'));
let switchChanges = 0;
switchControl.element.addEventListener('change', () => { switchChanges += 1; });
switchControl.element.click();
assert.equal(switchControl.element.getAttribute('aria-checked'), 'true');
assert.equal(switchChanges, 1);

const segmented = cases.find(controller => controller.element.classList.contains('vcp-ui-segmented'));
segmented.element.querySelector('[data-value="b"]').click();
assert.equal(segmented.element.querySelector('[aria-checked="true"]').dataset.value, 'b');

const toast = VCPUI.feedback.toast('Saved', { variant: 'success', duration: 0 });
assert.ok(document.querySelector('.vcp-ui-toast'));
toast.destroy();

const confirmPromise = VCPUI.feedback.confirm({ message: 'Continue?' });
await new Promise(resolve => setTimeout(resolve, 0));
const confirmButtons = [...document.querySelectorAll('.vcp-ui-modal footer .vcp-ui-button')];
confirmButtons.at(-1).click();
assert.equal(await confirmPromise, true);

VCPUI.feedback.setLoading(true, 'Loading');
VCPUI.feedback.setLoading(true, 'Loading');
assert.equal(VCPUI.feedback.setLoading(false), 1);
assert.equal(VCPUI.feedback.setLoading(false), 0);
VCPUI.feedback.cancelAll();
assert.equal(document.querySelector('.vcp-ui-feedback-host'), null);

cases.reverse().forEach(controller => controller.destroy());
assert.equal(scope.querySelectorAll('[class^="vcp-ui-"]').length, 0);

// --- Lucide semantic alias table validation ---
// Every alias must resolve to a real icon in the vendored lucide UMD, and every
// icon name VCPUI itself renders must resolve.
const lucide = createRequire(import.meta.url)('../node_modules/lucide/dist/umd/lucide.min.js');
const lucideIcons = new Set(Object.keys(lucide.icons || {}));
const lucideAdapterSource = fs.readFileSync(`${process.cwd()}/modules/ui-system/lucide-adapter.js`, 'utf8');
const lucideAliases = {};
for (const match of lucideAdapterSource.matchAll(/"([a-z0-9_]+)": "([a-z0-9-]+)"/g)) lucideAliases[match[1]] = match[2];
const resolveLucide = name => {
    const target = lucideAliases[name] || name.replaceAll('_', '-');
    return target.split('-').filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join('');
};
for (const [semantic, target] of Object.entries(lucideAliases)) {
    assert.ok(lucideIcons.has(resolveLucide(semantic)), `lucide alias ${semantic} -> ${target} does not exist`);
}
const vcpUiSource = fs.readFileSync(`${process.cwd()}/modules/ui-system/vcp-ui.js`, 'utf8');
const usedIconNames = [...new Set([...vcpUiSource.matchAll(/icon\('([a-z0-9_]+)'/g)].map(match => match[1]))];
usedIconNames.forEach(name => {
    assert.ok(lucideIcons.has(resolveLucide(name)), `icon name "${name}" used by VCPUI is not resolvable via lucide-adapter`);
});
console.log(`lucide aliases validated (${Object.keys(lucideAliases).length} aliases, ${usedIconNames.length} names used by VCPUI).`);

// --- Web Awesome-backed kernel (stub custom elements) ---
// Registers fake wa-* elements that satisfy the API surface VCPUI factories
// rely on, then verifies the WA branches and the native-control compat bridges.
function defineWaStubs() {
    const { HTMLElement, customElements } = window;
    const define = (tag, Class) => { if (!customElements.get(tag)) customElements.define(tag, Class); };
    class WaBase extends HTMLElement {
        get updateComplete() { return Promise.resolve(this); }
        connectedCallback() {
            if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
        }
        focus() {}
    }
    class WaButton extends WaBase {
        get disabled() { return this.hasAttribute('disabled'); }
        set disabled(value) { this.toggleAttribute('disabled', Boolean(value)); }
        get loading() { return this.hasAttribute('loading'); }
        set loading(value) { this.toggleAttribute('loading', Boolean(value)); }
    }
    class WaValue extends WaBase {
        get value() { return this.getAttribute('value') ?? ''; }
        set value(next) { if (next == null) this.removeAttribute('value'); else this.setAttribute('value', String(next)); }
        get disabled() { return this.hasAttribute('disabled'); }
        set disabled(value) { this.toggleAttribute('disabled', Boolean(value)); }
        get required() { return this.hasAttribute('required'); }
        set required(value) { this.toggleAttribute('required', Boolean(value)); }
        get readonly() { return this.hasAttribute('readonly'); }
        set readonly(value) { this.toggleAttribute('readonly', Boolean(value)); }
        setCustomValidity() {}
    }
    class WaInput extends WaValue {}
    class WaTextarea extends WaValue {}
    class WaOption extends WaBase {}
    class WaSelect extends WaValue {}
    class WaChecked extends WaBase {
        get checked() { return this.hasAttribute('checked'); }
        set checked(value) { this.toggleAttribute('checked', Boolean(value)); }
        get disabled() { return this.hasAttribute('disabled'); }
        set disabled(value) { this.toggleAttribute('disabled', Boolean(value)); }
        get required() { return this.hasAttribute('required'); }
        set required(value) { this.toggleAttribute('required', Boolean(value)); }
        get value() { return this.getAttribute('value') ?? 'on'; }
        set value(next) { this.setAttribute('value', String(next)); }
        click() {
            if (this.disabled) return;
            this.checked = !this.checked;
            this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        }
    }
    class WaCheckbox extends WaChecked {
        get indeterminate() { return this.hasAttribute('indeterminate'); }
        set indeterminate(value) { this.toggleAttribute('indeterminate', Boolean(value)); }
    }
    class WaSwitch extends WaChecked {}
    class WaCard extends WaBase {}
    class WaTab extends WaBase {}
    class WaTabPanel extends WaBase {}
    class WaTabGroup extends WaBase {
        get active() { return this.getAttribute('active') ?? ''; }
        set active(value) { if (value == null) this.removeAttribute('active'); else this.setAttribute('active', String(value)); }
    }
    class WaDialog extends WaBase {
        get open() { return this.hasAttribute('open'); }
        set open(value) { this.toggleAttribute('open', Boolean(value)); }
    }
    class WaTooltip extends WaBase {}
    define('wa-button', WaButton);
    define('wa-card', WaCard);
    define('wa-input', WaInput);
    define('wa-textarea', WaTextarea);
    define('wa-option', WaOption);
    define('wa-select', WaSelect);
    define('wa-checkbox', WaCheckbox);
    define('wa-switch', WaSwitch);
    define('wa-tab', WaTab);
    define('wa-tab-panel', WaTabPanel);
    define('wa-tab-group', WaTabGroup);
    define('wa-dialog', WaDialog);
    define('wa-tooltip', WaTooltip);
}
defineWaStubs();

const waHost = document.createElement('main');
waHost.className = 'vcp-ui-scope';
document.body.append(waHost);

const waButton = VCPUI.create('Button', { label: '保存', icon: 'save', variant: 'primary', loading: true });
assert.equal(waButton.element.tagName.toLowerCase(), 'wa-button', 'Button must use wa-button in next mode');
assert.equal(waButton.element.loading, true);
assert.equal(waButton.element.disabled, true, 'loading implies disabled on wa-button');
assert.equal(waButton.element.getAttribute('variant'), 'brand');
waButton.update({ loading: false });
assert.equal(waButton.element.disabled, false);

const waIconButton = VCPUI.create('IconButton', { icon: 'close', label: '关闭', active: true });
assert.equal(waIconButton.element.tagName.toLowerCase(), 'wa-button');
assert.equal(waIconButton.element.getAttribute('aria-label'), '关闭');
assert.equal(waIconButton.element.getAttribute('aria-pressed'), 'true');
assert.equal(waIconButton.element.getAttribute('appearance'), 'plain');

const waInput = VCPUI.create('Input', { value: 'hi', placeholder: 'Name', label: 'Name' });
assert.equal(waInput.element.tagName.toLowerCase(), 'wa-input');
assert.equal(waInput.control, waInput.element, 'WA Input exposes the same business control contract');
assert.equal(waInput.getValue(), 'hi');
waInput.setValue('contract-value');
assert.equal(waInput.getValue(), 'contract-value');
waInput.setDisabled(true);
assert.equal(waInput.control.disabled, true);
waInput.setDisabled(false);
waInput.update({ placeholder: 'Updated name' });
assert.equal(waInput.getValue(), 'contract-value', 'unrelated WA Input updates preserve setValue state');
const waInputNative = waInput.element.querySelector('input');
assert.ok(waInputNative instanceof dom.window.HTMLInputElement, 'WA Input must expose a queryable input');
assert.equal(waInputNative.value, 'contract-value');
waInputNative.value = 'updated';
assert.equal(waInput.element.value, 'updated', 'shim value write must forward to the WA control');
let waInputRelays = 0;
waInputNative.addEventListener('input', () => { waInputRelays += 1; });
waInput.element.dispatchEvent(new Event('input', { bubbles: true }));
assert.equal(waInputRelays, 1, 'WA input event must relay to the native shim');

const waTextarea = VCPUI.create('Textarea', { value: 'body', rows: 6 });
assert.equal(waTextarea.element.tagName.toLowerCase(), 'wa-textarea');
assert.equal(waTextarea.element.rows, 6);
const waTextareaNative = waTextarea.element.querySelector('textarea');
assert.ok(waTextareaNative instanceof dom.window.HTMLTextAreaElement);
assert.equal(waTextareaNative.value, 'body');

const waSelect = VCPUI.create('Select', { options: ['A', 'B'], value: 'B' });
assert.equal(waSelect.element.tagName.toLowerCase(), 'wa-select');
assert.equal(waSelect.control, waSelect.element, 'WA Select exposes the same business control contract');
waSelect.setValue('A');
assert.equal(waSelect.getValue(), 'A');
waSelect.setDisabled(true);
assert.equal(waSelect.control.disabled, true);
waSelect.setDisabled(false);
waSelect.update({ size: 'sm' });
assert.equal(waSelect.getValue(), 'A', 'unrelated WA Select updates preserve setValue state');
assert.equal(waSelect.element.querySelectorAll('wa-option').length, 2);
assert.equal(waSelect.element.value, 'A');
assert.equal(waSelect.element.selectedIndex, 0);
assert.equal(waSelect.element.options.length, 2);
assert.equal(waSelect.element.querySelector('select').value, 'A');

const waCheckbox = VCPUI.create('Checkbox', { label: '同意', checked: true });
assert.equal(waCheckbox.element.tagName.toLowerCase(), 'wa-checkbox');
assert.equal(waCheckbox.element.checked, true);
waCheckbox.element.click();
assert.equal(waCheckbox.element.checked, false, 'wa-checkbox click must toggle checked');

const waSwitch = VCPUI.create('Switch', { label: '开关' });
assert.equal(waSwitch.element.tagName.toLowerCase(), 'wa-switch');
let waSwitchChanges = 0;
waSwitch.element.addEventListener('change', () => { waSwitchChanges += 1; });
waSwitch.element.click();
assert.equal(waSwitch.element.checked, true, 'wa-switch click must toggle checked');
assert.equal(waSwitchChanges, 1, 'wa-switch change must reach consumers');

const waCard = VCPUI.create('Card', { title: 'Card', description: 'desc', interactive: true });
assert.equal(waCard.element.tagName.toLowerCase(), 'wa-card');
assert.equal(waCard.element.appearance, 'filled');
waCard.update({ variant: 'outlined' });
assert.equal(waCard.element.appearance, 'outlined', 'wa-card appearance must follow the variant');

const waTabs = VCPUI.create('Tabs', { items: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }], value: 'b' });
assert.equal(waTabs.element.tagName.toLowerCase(), 'wa-tab-group');
assert.equal(waTabs.element.active, 'b', 'wa-tab-group must reflect the active tab');
let waTabChanges = 0;
waTabs.element.addEventListener('change', () => { waTabChanges += 1; });
waTabs.element.dispatchEvent(new CustomEvent('wa-tab-show', { detail: { name: 'a' }, bubbles: true }));
assert.equal(waTabChanges, 1, 'wa-tab-show must be translated to change');

const waModal = VCPUI.create('Modal', { title: 'Modal', content: document.createTextNode('Body') });
assert.equal(waModal.element.tagName.toLowerCase(), 'wa-dialog');
waHost.append(waModal.element);
await new Promise(resolve => setTimeout(resolve, 40));
assert.equal(waModal.element.open, true, 'wa-dialog must open once connected');
waModal.close(null);
assert.equal(waModal.element.open, false);

const waTipTrigger = VCPUI.create('Button', { label: 'tip' });
const waTooltip = VCPUI.create('Tooltip', { trigger: waTipTrigger, content: '提示', placement: 'top' });
assert.equal(waTooltip.element.tagName.toLowerCase(), 'wa-tooltip');
assert.ok(waTipTrigger.element.id, 'tooltip trigger must get an id');
assert.equal(waTooltip.element.getAttribute('for'), waTipTrigger.element.id);

[waButton, waIconButton, waInput, waTextarea, waSelect, waCheckbox, waSwitch, waCard, waTabs, waModal, waTooltip, waTipTrigger].forEach(controller => controller.destroy());
assert.equal(waHost.querySelectorAll('[class^="vcp-ui-"]').length, 0, 'WA-backed controls must be removed on destroy');
waHost.remove();

console.log(`UI system contract tests passed (${expected.length} public component names).`);
