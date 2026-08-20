import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

await import('./test-ask-nova-service.mjs');

const composerSafeFocusSelector = /:focus-visible:not\(#messageInput\):not\(\.chat-message-input\):not\(\.vcp-ui-scope \*\)\s*\{/;
const paperThemeSource = fs.readFileSync('styles/themes/themes纸墨与机芯.css', 'utf8');
const componentStyles = fs.readFileSync('styles/ui-system/components.css', 'utf8');
const sidebarStyles = fs.readFileSync('styles/ui-system/sidebar.css', 'utf8');
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
const mainHtmlSource = fs.readFileSync('main.html', 'utf8');
const mainDomForComposer = new JSDOM(mainHtmlSource);
['quickNewTopicBtn', 'attachFileBtn', 'emoticonTriggerBtn'].forEach(id => {
    const button = mainDomForComposer.window.document.getElementById(id);
    assert.ok(button?.querySelector('svg'), `${id} must use an inline SVG icon in both UI modes`);
    assert.equal(button?.querySelector('.material-symbols-outlined'), null, `${id} must not depend on a mode-specific icon font`);
});
assert.match(
    componentStyles,
    /\.vcp-ui-toast > :is\(button, wa-button\)\s*\{\s*pointer-events:\s*auto/s,
    'the toast close control must remain clickable after Web Awesome upgrades it to wa-button'
);
assert.doesNotMatch(
    sidebarStyles,
    /html[^{]*\.agent-name::after[^}]*display:\s*none/s,
    'Next UI must not hide the assistant emotion text shown on hover'
);
assert.doesNotMatch(
    sidebarStyles,
    /html[^{]*\.agent-emotion-card[^}]*display:\s*none/s,
    'Next UI must not disable the assistant emotion animation card'
);

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
    DOMParser: dom.window.DOMParser,
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
    isLoaded: tag => Boolean(customElements.get(`wa-${String(tag).toLowerCase()}`)),
});

const { VCPUI } = window;
const lifecycleApi = createRequire(import.meta.url)('../modules/ui-system/lifecycle-scope.js');
window.VCPLifecycle = lifecycleApi;
const scope = document.querySelector('.vcp-ui-scope');
assert.ok(VCPUI, 'VCPUI should be exposed on window');

const { createAskNovaController, renderSafeMarkdown } = await import(`${pathToFileURL(`${process.cwd()}/modules/ui-system/ask-nova-modal.js`).href}?ask-nova-contract-test=1`);
const unsafeMarkdownHost = document.createElement('div');
unsafeMarkdownHost.append(renderSafeMarkdown('unsafe', {
    document,
    marked: {
        parse: () => '<p onclick="alert(1)">Safe <strong>text</strong></p><script>alert(1)</script><a href="javascript:alert(1)">bad</a><a href="https://deepwiki.com/lioensky/VCPChat">good</a>'
    }
}));
assert.equal(unsafeMarkdownHost.querySelector('script'), null, 'Ask Nova Markdown must remove scripts');
assert.equal(unsafeMarkdownHost.querySelector('[onclick]'), null, 'Ask Nova Markdown must remove event attributes');
assert.equal(unsafeMarkdownHost.querySelector('a[href^="javascript:"]'), null, 'Ask Nova Markdown must remove dangerous links');
assert.equal(unsafeMarkdownHost.querySelector('a[href^="https:"]')?.getAttribute('rel'), 'noreferrer noopener');

const askNovaCalls = [];
const askNovaApi = {
    askNovaQuery: async payload => {
        askNovaCalls.push(payload);
        return { success: true, answer: '**Answer**', queryId: `${payload.target}-session` };
    },
    cancelAskNovaQuery: async requestId => {
        askNovaCalls.push({ cancel: requestId });
        return { success: true, cancelled: true };
    },
    sendOpenExternalLink: url => askNovaCalls.push({ external: url })
};
const askNovaController = createAskNovaController({ document, api: askNovaApi, VCPUI, marked: { parse: value => `<p>${value}</p>` } });
const askNovaModal = await askNovaController.open('backend');
assert.equal(askNovaModal.getState().targetId, 'backend');
assert.ok(askNovaModal.element.querySelector('.ask-nova-dialog'), 'Ask Nova modal must mount through VCPUI');
const askNovaTabs = [...askNovaModal.element.querySelectorAll('[role="tab"]')];
assert.equal(askNovaTabs.length, 3, 'Ask Nova must expose all target tabs');
assert.equal(askNovaTabs.filter(tab => tab.tabIndex === 0).length, 1, 'Ask Nova tabs must use roving tabindex');
assert.equal(askNovaTabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.tabIndex, 0, 'selected Ask Nova tab must be focusable');
askNovaTabs[1].focus();
askNovaTabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
assert.equal(askNovaModal.getState().targetId, 'fullstack', 'Ask Nova tab arrows must switch target');
askNovaModal.switchTarget('backend');
const askNovaTextarea = askNovaModal.element.querySelector('.ask-nova-composer textarea');
askNovaTextarea.value = 'Explain plugins';
askNovaTextarea.dispatchEvent(new Event('input', { bubbles: true }));
askNovaModal.element.querySelector('.ask-nova-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
assert.equal(askNovaModal.element.querySelector('.ask-nova-composer').getAttribute('aria-busy'), 'true', 'Ask Nova composer must expose its loading terminal state');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(askNovaCalls[0].target, 'backend');
assert.deepEqual(askNovaCalls[0].history, []);
assert.match(askNovaModal.element.querySelector('.ask-nova-message-assistant .ask-nova-message-bubble')?.textContent || '', /Answer/);
assert.equal(askNovaModal.element.querySelector('.ask-nova-composer').getAttribute('aria-busy'), 'false', 'Ask Nova composer must clear its loading state after success');
askNovaModal.switchTarget('frontend');
assert.equal(askNovaModal.getState().targetId, 'frontend');
assert.equal(askNovaModal.getState().sessions.frontend.messages.length, 1, 'Ask Nova tabs must keep independent sessions');
askNovaModal.element.querySelector('.ask-nova-open-external').click();
assert.match(askNovaCalls.at(-1).external, /VCPChat/);
askNovaModal.close();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(askNovaController.activeModal, null, 'Ask Nova close must clean up modal state');
assert.equal(lifecycleApi.diagnostics.find('next:ask-nova-modal:backend').length, 0, 'Ask Nova close must dispose its modal scope');
await askNovaController.destroy();

let pendingAskNovaResolve;
const pendingAskNovaCalls = [];
const pendingAskNovaController = createAskNovaController({
    document,
    VCPUI,
    marked: { parse: value => `<p>${value}</p>` },
    api: {
        askNovaQuery: payload => {
            pendingAskNovaCalls.push(payload);
            return new Promise(resolve => { pendingAskNovaResolve = resolve; });
        },
        cancelAskNovaQuery: async requestId => {
            pendingAskNovaCalls.push({ cancel: requestId });
            return { success: true, cancelled: true };
        },
        sendOpenExternalLink: () => {}
    }
});
const pendingAskNovaModal = await pendingAskNovaController.open('frontend');
const pendingTextarea = pendingAskNovaModal.element.querySelector('.ask-nova-composer textarea');
pendingTextarea.value = 'Long query';
pendingTextarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await new Promise(resolve => setTimeout(resolve, 0));
const pendingRequestId = pendingAskNovaCalls[0].requestId;
document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(pendingAskNovaController.activeModal, null, 'document-level Escape must close an in-flight Ask Nova modal after its textarea is disabled');
assert.equal(pendingAskNovaCalls.at(-1).cancel, pendingRequestId, 'closing Ask Nova must cancel its active request');
pendingAskNovaResolve({ success: false, cancelled: true });
const reopenedAskNovaModal = await pendingAskNovaController.open('backend');
assert.equal(reopenedAskNovaModal.getState().targetId, 'backend', 'Ask Nova must reopen on a different target after cancellation');
assert.equal(document.querySelectorAll('.ask-nova-modal-host').length, 1, 'Ask Nova rapid reopen must leave exactly one modal host');
reopenedAskNovaModal.close();
await new Promise(resolve => setTimeout(resolve, 0));
await pendingAskNovaController.destroy();
assert.equal(
    lifecycleApi.diagnostics.snapshot().filter(item => item.label.startsWith('next:ask-nova')).length,
    0,
    'Ask Nova destroy must retract controller and modal resources'
);

// Concurrent opens may settle in either native IPC order, but the most recent
// user request must select the final target and only one modal may survive.
const previousConcurrentTopTabManager = window.topTabManager;
const concurrentOverlayResolvers = [];
const concurrentOverlayReleases = [];
window.topTabManager = {
    acquireOverlay: () => new Promise(resolve => concurrentOverlayResolvers.push(resolve)),
    releaseOverlay: owner => concurrentOverlayReleases.push(owner)
};
const concurrentAskNovaController = createAskNovaController({
    document,
    VCPUI,
    marked: { parse: value => `<p>${value}</p>` },
    api: askNovaApi
});
const firstConcurrentOpen = concurrentAskNovaController.open('frontend');
const latestConcurrentOpen = concurrentAskNovaController.open('backend');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(concurrentOverlayResolvers.length, 2);
concurrentOverlayResolvers[1]();
const latestConcurrentModal = await latestConcurrentOpen;
concurrentOverlayResolvers[0]();
const firstConcurrentResult = await firstConcurrentOpen;
assert.strictEqual(firstConcurrentResult, latestConcurrentModal);
assert.equal(latestConcurrentModal.getState().targetId, 'backend', 'latest Ask Nova target must win regardless of acquire order');
assert.equal(document.querySelectorAll('.ask-nova-modal-host').length, 1, 'concurrent Ask Nova opens must mount one host');
latestConcurrentModal.close();
await new Promise(resolve => setTimeout(resolve, 0));
await concurrentAskNovaController.destroy();
assert.equal(concurrentOverlayReleases.length, 2, 'both concurrent overlay leases must be returned');
window.topTabManager = previousConcurrentTopTabManager;

// Destroying the controller while the native WebContentsView hide request is
// pending must return the just-acquired overlay lease instead of attaching it
// to an already disposed modal Scope.
const previousTopTabManager = window.topTabManager;
let resolveOverlayAcquire;
const overlayReleases = [];
window.topTabManager = {
    acquireOverlay: () => new Promise(resolve => { resolveOverlayAcquire = resolve; }),
    releaseOverlay: owner => overlayReleases.push(owner)
};
const interruptedAskNovaController = createAskNovaController({
    document,
    VCPUI,
    marked: { parse: value => `<p>${value}</p>` },
    api: askNovaApi
});
const interruptedOpen = interruptedAskNovaController.open('frontend');
await new Promise(resolve => setTimeout(resolve, 0));
await interruptedAskNovaController.destroy();
resolveOverlayAcquire();
assert.equal(await interruptedOpen, null, 'destroyed Ask Nova must not mount after overlay acquisition settles');
assert.equal(overlayReleases.length, 1, 'destroyed Ask Nova must return its late overlay lease exactly once');
window.topTabManager = previousTopTabManager;

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
legacyRange.min = '0';
legacyRange.max = '100';
legacyRange.value = '75';
legacyRange.dispatchEvent(new Event('input', { bubbles: true }));
assert.equal(legacyRange.style.getPropertyValue('--vcp-ui-range-progress'), '75%');
enhancedRange.destroy();
assert.ok(legacyRange.isConnected, 'enhanced elements should remain in the DOM after destroy');
assert.equal(legacyRange.className, '');
assert.equal(legacyRange.style.getPropertyValue('--vcp-ui-range-progress'), '');
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

const retainedNativeSelect = document.createElement('select');
retainedNativeSelect.add(new Option('Retained', 'retained'));
scope.append(retainedNativeSelect);
const retainedNativeController = VCPUI.enhance('Select', retainedNativeSelect, { kernel: 'native' });
assert.equal(retainedNativeController.kernel, 'native', 'legacy surfaces can keep Select on the native lifecycle');
assert.equal(retainedNativeController.element, retainedNativeSelect);
assert.equal(scope.querySelectorAll('wa-select.vcp-ui-select-proxy').length, 0, 'native Select opt-out creates no WA shadow tree');
retainedNativeController.destroy();
retainedNativeSelect.remove();

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
dynamicSelectRoot.replaceChildren();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(VCPUI.getController(dynamicSelect), null, 'observer releases controllers whose native and proxy nodes were removed');
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
document.dispatchEvent(new CustomEvent('vcp-settings-surface-updated', {
    detail: { kind: 'group', root: dynamicGroupForm }
}));
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(document.getElementById('dynamicGroupPrompt').classList.contains('vcp-ui-native-textarea'));

// Global settings modal is enhanced independently of the sidebar presentation
// gate: controls, save bar and injected search use the canonical presentation.
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
window.VCPUISettingsBridge.refresh();
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(document.getElementById('globalUserName').classList.contains('vcp-ui-native-input'), 'global input enhanced');
assert.ok(document.getElementById('globalSelect').classList.contains('vcp-ui-native-select'), 'global select enhanced');
assert.ok(globalModal.querySelector('wa-select.vcp-ui-select-proxy'), 'global select uses the loaded Web Awesome kernel');
const globalFooter = globalModal.querySelector('.global-settings-footer');
assert.ok(globalFooter.classList.contains('vcp-ui-settings-action-bar'), 'global save bar enhanced');
assert.ok(globalModal.querySelector('.vcp-ui-settings-search'), 'settings search injected');
document.getElementById('globalUserName').value = 'Changed';
document.getElementById('globalUserName').dispatchEvent(new Event('input', { bubbles: true }));
assert.equal(globalFooter.dataset.state, 'dirty', 'global save bar tracks dirty state');
document.getElementById('globalSettingsForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
assert.equal(globalFooter.dataset.state, 'saving', 'global save bar tracks saving state');
document.documentElement.dataset.uiMode = 'classic';
window.dispatchEvent(new CustomEvent('ui-mode-changed', { detail: { mode: 'classic', previousMode: 'next' } }));
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(document.getElementById('globalUserName').classList.contains('vcp-ui-native-input'),
    'legacy mode events must not tear down canonical settings controls');
assert.ok(globalModal.classList.contains('vcp-global-settings-next'),
    'legacy mode events must not remove the canonical modal marker');
assert.ok(globalModal.querySelector('.vcp-ui-settings-search'),
    'legacy mode events must not remove the SettingsShell search');
await window.VCPUISettingsBridge.destroy();
modalContainer.remove();

assert.ok(!document.getElementById('bridgeInput').classList.contains('vcp-ui-native-input'));
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
await window.VCPUISettingsBridge.destroy();
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
const notificationSystemCss = fs.readFileSync(new URL('../styles/ui-system/notifications.css', import.meta.url), 'utf8');
const mainHtml = fs.readFileSync(new URL('../main.html', import.meta.url), 'utf8');
const trayManagerSource = fs.readFileSync(new URL('../modules/trayManager.js', import.meta.url), 'utf8');
const mainChatCommandsSource = fs.readFileSync(new URL('../modules/mainChatCommands.js', import.meta.url), 'utf8');
const windowStateServiceSource = fs.readFileSync(new URL('../modules/services/windowStateService.js', import.meta.url), 'utf8');
const nextShellControllerSource = fs.readFileSync(new URL('../modules/ui-system/next-shell/next-shell-controller.js', import.meta.url), 'utf8');
const eventListenersSource = fs.readFileSync(new URL('../modules/event-listeners.js', import.meta.url), 'utf8');
const rendererSource = fs.readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');
assert.match(rendererSource, /switcher\.setAttribute\('aria-hidden', String\(!open\)\)/,
    'chat presentation switcher must expose hidden state to assistive technology');
assert.match(rendererSource, /switcher\.inert = !open/,
    'closed chat presentation switcher must leave the focus tree');
assert.match(rendererSource, /chatPresentationSaveChain/,
    'chat presentation persistence must serialize rapid intent changes');
const topTabManagerSource = fs.readFileSync(new URL('../modules/topTabManager.js', import.meta.url), 'utf8');
const appTabHostSource = fs.readFileSync(new URL('../modules/ui-system/next-shell/app-tab-host.js', import.meta.url), 'utf8');
const accountMenuControllerSource = fs.readFileSync(new URL('../modules/ui-system/next-shell/account-menu-controller.js', import.meta.url), 'utf8');
const agentHandlersSource = fs.readFileSync(new URL('../modules/ipc/agentHandlers.js', import.meta.url), 'utf8');
const settingsHandlersSource = fs.readFileSync(new URL('../modules/ipc/settingsHandlers.js', import.meta.url), 'utf8');
const appearanceStyles = fs.readFileSync(new URL('../styles/appearance.css', import.meta.url), 'utf8');
const messageRendererStyles = fs.readFileSync(new URL('../styles/messageRenderer.css', import.meta.url), 'utf8');
assert.match(mainHtml, /id="nextUiPresentationBtn"[\s\S]*id="nextUiThemeStoreBtn"[\s\S]*id="nextUiThemeBtn"/,
    'Next must expose chat presentation and theme shortcuts in the topbar');
assert.doesNotMatch(mainHtml, /id="nextUi(?:PresentationBtn|ThemeStoreBtn|ThemeBtn)"[^>]*next-ui-relocated-action/,
    'visible Next shortcuts must not carry the hidden relocated-action class');
assert.match(mainHtml, /id="nextUiMinimizeToTrayBtn"[^>]*aria-label="最小化到系统托盘"/,
    'Next must expose a distinct minimize-to-tray control');
assert.match(mainChatCommandsSource, /function minimizeToTray\(\)[\s\S]*minimizeToTray\?\.\(\)/,
    'minimize-to-tray must route through the existing preload API');
assert.doesNotMatch(mainChatCommandsSource, /nextUiMaximizeBtn|onWindowMaximized|syncMaximizeControl/,
    'business commands must not own Next window-control presentation');
assert.match(windowStateServiceSource, /publish\(maximized\)[\s\S]*register\('onWindowMaximized', true\)/,
    'the shared window service must publish real maximize state');
assert.match(nextShellControllerSource, /subscribeWindowState[\s\S]*syncWindowControl/,
    'Next shell must project the shared window state into its control');
assert.match(mainHtml, /id="nextUiDynamicTabs"[^>]*role="tablist"/,
    'the dynamic application strip must expose tablist semantics');
assert.match(appTabHostSource, /setAttribute\('role', 'presentation'\)[\s\S]*className = 'next-ui-tab-label next-ui-tab-label-button'[\s\S]*setAttribute\('role', 'tab'\)[\s\S]*next-ui-tab-close/,
    'dynamic tabs must keep the tab button and close button as siblings');
assert.match(appTabHostSource, /setAttribute\('role', 'tabpanel'\)[\s\S]*aria-labelledby/,
    'dynamic app panels must be labelled by their tab button');
assert.doesNotMatch(topTabManagerSource, /createElement\('div'\)[\s\S]*next-ui-tab-close/,
    'topTabManager must delegate tab presentation to AppTabHost');
const saveSettingsHandler = settingsHandlersSource.match(/ipcMain\.handle\('save-settings',[\s\S]*?\n\s*}\);/)?.[0] || '';
assert.match(saveSettingsHandler, /'flowlockContinueDelay' in settingsToSave/,
    'partial settings patches may validate flowlock delay only when supplied');
assert.doesNotMatch(saveSettingsHandler, /enableDistributedServerLogs\s*=/,
    'partial settings patches must not synthesize unrelated distributed-log settings');
assert.doesNotMatch(appearanceStyles, /data-ui-mode/,
    'canonical appearance must not retain a dead mode gate');
assert.match(appearanceStyles, /html body\s*\{[^}]*font-family:[^}]*font-size:/s,
    'canonical typography must be scoped through the document root');
assert.doesNotMatch(appearanceStyles, /(?:^|\n)\s*body\s*\{[^}]*font-(?:family|size):/s,
    'appearance must not leak an unscoped body typography rule');
assert.match(messageRendererStyles, /\.maid-diary-bubble\s*\{[^}]*background:[^;]+!important;[^}]*border-radius:[^;]+!important;/s,
    'upstream diary component declarations must retain their cascade authority');
assert.match(messageRendererStyles, /\.vcp-tool-result-bubble\s*\{[^}]*background:[^;]+!important;[^}]*border-radius:[^;]+!important;/s,
    'upstream tool result declarations must retain their cascade authority');
assert.doesNotMatch(mainChatCommandsSource, /function createAgentConfig/,
    'renderer commands must not duplicate the canonical Agent defaults');
assert.match(mainChatCommandsSource, /createAgent\?\.\(name, model \? \{ model \} : undefined\)/,
    'Next creation may send only the selected model override');
assert.match(agentHandlersSource, /const defaultConfig = \{[\s\S]*const configToSave = \{ \.\.\.defaultConfig, \.\.\.configOverrides, name: agentName \}/,
    'the main process must merge renderer overrides into canonical Agent defaults');
assert.match(mainChatCommandsSource, /navigationSuccess: false, warning: error\.message/,
    'post-create navigation failures must not be reported as creation failures');
assert.match(nextUiCss, /\.next-ui-chat-presentation-switcher\.is-open\s*\{/,
    'the Next presentation popup must use explicit open state');
assert.doesNotMatch(nextUiCss, /next-ui-presentation-switcher:focus-within[^\{]*next-ui-chat-presentation-switcher/,
    'the Next presentation popup must not use focus-within as its state authority');
assert.match(rendererSource, /usesExplicitState[\s\S]*setOpen\(false\)[\s\S]*trigger\?\.focus\(\)/,
    'the presentation popup must close explicitly and restore trigger focus');
assert.match(accountMenuControllerSource, /topbarThemeButton[\s\S]*setAttribute\('aria-label', label\)/,
    'the Next topbar theme shortcut must synchronize its action label');
assert.doesNotMatch(topTabManagerSource, /nextUiAccountThemeLabel[\s\S]*setAttribute\('aria-label'/,
    'topTabManager must delegate account and theme presentation state');
assert.match(eventListenersSource, /const runMenuAction = async[\s\S]*catch \(error\)[\s\S]*finally \{[\s\S]*closeNotificationMenu/,
    'notification menu actions must close and restore focus even after rejection');
assert.match(mainHtml, /id="nextUiNotificationForum"[\s\S]*id="nextUiNotificationMemo"[\s\S]*id="nextUiNotificationFilterToggle"[\s\S]*id="nextUiNotificationClear"/,
    'the Next notification menu must contain separate Forum and Memo entries plus filter and clear commands');
assert.doesNotMatch(eventListenersSource, /(?:doNotDisturbBtn|clearNotificationsBtn)\.click\(\)/,
    'Next notification actions must not proxy hidden Classic controls');
assert.match(eventListenersSource, /nextUiNotificationMemo\.addEventListener\('click'[\s\S]*openMemo/,
    'the dedicated Memo menu item must open Memo');
assert.match(eventListenersSource, /nextUiNotificationFilterToggle\.addEventListener\('contextmenu'[\s\S]*openNotificationFilterSettings/,
    'filter menu secondary action must open filter settings');
assert.doesNotMatch(nextUiCss,
    /html[^{]*#vchatAppTray[^{]*\{[^}]*display:\s*none/s,
    'Next UI must preserve the upstream app tray instead of hiding it');
assert.match(notificationSystemCss,
    /html \.vcp-ui-scope #vchatAppTray\s*\{[^}]*display:\s*flex/s,
    'Next UI must expose the app tray in the notification sidebar');
assert.match(mainHtml, /id="appTrayPinnedApps"[\s\S]*id="appTrayMoreBtn"[\s\S]*id="appTrayDrawer"/,
    'the app tray must retain pinned apps and the complete app drawer');
assert.match(trayManagerSource, /localStorage\.setItem\('vcp-tray-pinned-apps'/,
    'the app tray must retain the upstream pinned-app persistence contract');
assert.match(trayManagerSource, /modal\.setAttribute\('role', 'dialog'\)[\s\S]*modal\.setAttribute\('aria-modal', 'true'\)[\s\S]*aria-labelledby/,
    'app tray settings must expose dialog semantics');
assert.match(trayManagerSource, /event\.key !== 'Tab'[\s\S]*focusable\(\)[\s\S]*event\.shiftKey/,
    'app tray settings must own a focus trap');
assert.match(trayManagerSource, /overlayAcquired[\s\S]*if \(closed\)[\s\S]*releaseOverlay/,
    'app tray settings must release a late overlay acquisition');

const commandDom = new JSDOM(`<!doctype html><html><body>
    <button id="nextUiMaximizeBtn"><span class="vcp-ui-icon">crop_square</span></button>
    <ul id="notificationsList"></ul>
</body></html>`, {
    url: 'https://vcpchat.local/',
    runScripts: 'outside-only'
});
const creationCalls = [];
const commandWindowCalls = { maximize: 0, unmaximize: 0 };
let emitMaximized;
let emitUnmaximized;
commandDom.window.chatAPI = {
    createAgent: async (...args) => {
        creationCalls.push(args);
        return { success: true, agentId: 'agent-1', agentName: args[0], config: { model: args[1]?.model } };
    },
    maximizeWindow: () => { commandWindowCalls.maximize += 1; },
    unmaximizeWindow: () => { commandWindowCalls.unmaximize += 1; },
    onWindowMaximized: callback => { emitMaximized = callback; },
    onWindowUnmaximized: callback => { emitUnmaximized = callback; },
};
commandDom.window.eval(fs.readFileSync(new URL('../modules/ui-system/state-channel.js', import.meta.url), 'utf8'));
commandDom.window.eval(windowStateServiceSource);
commandDom.window.itemListManager = {
    loadItems: async () => { throw new Error('list refresh failed'); }
};
commandDom.window.uiHelperFunctions = { showToastNotification() {} };
commandDom.window.eval(mainChatCommandsSource);
commandDom.window.MainChatCommands.toggleMaximize();
assert.equal(commandWindowCalls.maximize, 1);
emitMaximized();
assert.equal(commandDom.window.MainChatCommands.getWindowState().maximized, true);
commandDom.window.MainChatCommands.toggleMaximize();
assert.equal(commandWindowCalls.unmaximize, 1);
emitUnmaximized();
assert.equal(commandDom.window.MainChatCommands.getWindowState().maximized, false);
const partialCreation = await commandDom.window.MainChatCommands.createAgent({ name: 'Nova', model: 'model-next' });
assert.equal(JSON.stringify(creationCalls[0]), JSON.stringify(['Nova', { model: 'model-next' }]),
    'renderer creation must pass only the model override to the main process');
assert.equal(partialCreation.success, true, 'a persisted Agent must remain a successful creation result');
assert.equal(partialCreation.navigationSuccess, false, 'post-create UI failure must be reported separately');
assert.match(mainHtml,
    /id="nextUiMainPanel"[^>]*>[\s\S]*<main class="main-content">[\s\S]*id="resizerRight"[\s\S]*id="notificationsSidebar"[\s\S]*<\/section>/s,
    'main chat, notification resizer, and notification sidebar must share one clipping host');
assert.match(nextUiCss,
    /html \.next-ui-main-panel\s*\{[^}]*overflow:\s*hidden;[^}]*isolation:\s*isolate;[^}]*border-radius:\s*var\(--vcp-ui-shell-radius\) 0 0 0;[^}]*var\(--next-wallpaper\);/s,
    'the shared host must own both the panel radius and the theme wallpaper clip');
assert.match(nextUiCss,
    /html \.main-content\s*\{[^}]*background:\s*transparent;/s,
    'the chat layer must not repaint the theme wallpaper outside the shared clip');
assert.doesNotMatch(nextUiCss, /next-ui-panel-elevation|mask-image:\s*radial-gradient|clip-path:\s*polygon/,
    'the panel corner must not be reconstructed by fixed overlays, masks, or polygon approximations');
assert.doesNotMatch(nextUiCss,
    /html :is\(\.main-content, \.chat-header\)[^{]*\{[^}]*(?:border-radius|clip-path):/s,
    'child chat layers must not draw a second copy of the shell corner');
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
let behaviorModalCloseCount = 0;
const behaviorModal = VCPUI.create('Modal', {
    title: 'Modal',
    content: document.createTextNode('Body'),
    onClose: () => { behaviorModalCloseCount += 1; },
});
scope.append(behaviorModal.element);
assert.equal(behaviorModal.element.querySelector('.vcp-ui-modal').getAttribute('role'), 'dialog');
const behaviorDialog = behaviorModal.element.querySelector('.vcp-ui-modal');
const behaviorTitleId = behaviorDialog.getAttribute('aria-labelledby');
assert.ok(behaviorTitleId && behaviorDialog.querySelector(`#${behaviorTitleId}`), 'native modal must expose an accessible title');
behaviorModal.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.ok(!behaviorModal.element.isConnected, 'Escape must close the modal');
behaviorModal.close(null);
assert.equal(behaviorModalCloseCount, 1, 'native modal close finalization must be idempotent');
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

// Feedback resources belong to their surface. Disposing one owner must not
// close another owner's dialog/toast/loading state, including queued dialogs.
const mainFeedbackScope = new lifecycleApi.LifecycleScope('test:main-feedback');
const showcaseFeedbackScope = new lifecycleApi.LifecycleScope('test:showcase-feedback');
const mainFeedback = VCPUI.feedback.owner(mainFeedbackScope);
const showcaseFeedback = VCPUI.feedback.owner(showcaseFeedbackScope);
const mainToast = mainFeedback.toast('Main owner toast', { duration: 0 });
const showcaseToast = showcaseFeedback.toast('Showcase toast', { duration: 0 });
mainFeedback.setLoading(true, 'Main owner loading');
showcaseFeedback.setLoading(true, 'Showcase loading');
const mainDialogPromise = mainFeedback.confirm({ title: 'Main owner dialog', message: 'Keep open' });
const showcaseDialogPromise = showcaseFeedback.confirm({ title: 'Showcase dialog', message: 'Dispose me' });
await new Promise(resolve => setTimeout(resolve, 0));
assert.match(document.querySelector('.vcp-ui-modal h2')?.textContent || '', /Main owner dialog/);
await showcaseFeedbackScope.dispose('showcase-closed');
assert.equal(await showcaseDialogPromise, null, 'disposing an owner settles its queued dialog');
assert.ok(mainToast.element.isConnected, 'another owner toast survives showcase disposal');
assert.ok(!showcaseToast.element.isConnected, 'showcase toast is removed with its owner');
assert.match(document.querySelector('.vcp-ui-modal h2')?.textContent || '', /Main owner dialog/, 'another owner dialog remains open');
assert.equal(document.querySelector('.vcp-ui-loading-label')?.textContent, 'Main owner loading', 'loading falls back to the surviving owner');
await showcaseFeedback.dispose();
await mainFeedbackScope.dispose('main-closed');
assert.equal(await mainDialogPromise, null, 'disposing an owner settles its active dialog');
assert.ok(!mainToast.element.isConnected);
assert.equal(document.querySelector('.vcp-ui-loading-layer')?.hidden, true);
await mainFeedback.dispose();

let lateShowcaseMutation = 0;
const timerFeedbackScope = new lifecycleApi.LifecycleScope('test:showcase-timer');
const timerFeedback = VCPUI.feedback.owner(timerFeedbackScope);
timerFeedback.setLoading(true, 'Timer loading');
timerFeedbackScope.timeout(() => {
    lateShowcaseMutation += 1;
    timerFeedback.setLoading(false);
}, 5, 'showcase-loading-demo');
await timerFeedbackScope.dispose('showcase-closed-before-timer');
await timerFeedbackScope.dispose('duplicate-dispose');
await new Promise(resolve => setTimeout(resolve, 15));
assert.equal(lateShowcaseMutation, 0, 'a disposed showcase timer cannot mutate feedback state');
assert.equal(document.querySelector('.vcp-ui-loading-layer')?.hidden, true);

assert.throws(
    () => VCPUI.feedback.owner({ label: 'failed-owner', own() { throw new Error('controlled owner registration failure'); } }),
    /controlled owner registration failure/,
    'owner setup failure rolls back without publishing a usable handle'
);
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

const waToast = VCPUI.feedback.toast('Web Awesome close', { duration: 0 });
const waToastClose = waToast.element.querySelector('wa-button[aria-label="关闭通知"]');
assert.ok(waToastClose, 'a Web Awesome toast must expose a close button');
waToastClose.click();
assert.ok(!waToast.element.isConnected, 'clicking the Web Awesome toast close button must dismiss the toast');

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
const nestedTabs = document.createElement('wa-tab-group');
waTabs.element.append(nestedTabs);
nestedTabs.dispatchEvent(new CustomEvent('wa-tab-show', { detail: { name: 'nested' }, bubbles: true }));
assert.equal(waTabChanges, 1, 'nested tab lifecycle events must not mutate an ancestor Tabs controller');

let waModalCloseCount = 0;
const waModal = VCPUI.create('Modal', {
    title: 'Modal',
    content: document.createTextNode('Body'),
    onClose: () => { waModalCloseCount += 1; },
});
assert.equal(waModal.element.tagName.toLowerCase(), 'wa-dialog');
waHost.append(waModal.element);
await new Promise(resolve => setTimeout(resolve, 40));
assert.equal(waModal.element.open, true, 'wa-dialog must open once connected');
const nestedWaControl = document.createElement('wa-select');
waModal.element.append(nestedWaControl);
nestedWaControl.dispatchEvent(new CustomEvent('wa-hide', { bubbles: true, cancelable: true }));
nestedWaControl.dispatchEvent(new CustomEvent('wa-after-hide', { bubbles: true }));
assert.equal(waModalCloseCount, 0, 'nested WA lifecycle events must not close their owning Modal');
assert.equal(waModal.element.isConnected, true, 'nested WA teardown must not destroy the Modal Surface');
waModal.close(null);
assert.equal(waModal.element.open, false);
waModal.element.dispatchEvent(new CustomEvent('wa-hide', { bubbles: true, cancelable: true }));
waModal.element.dispatchEvent(new CustomEvent('wa-after-hide', { bubbles: true }));
assert.equal(waModalCloseCount, 1, 'programmatic and Web Awesome hide events must share one close finalizer');

let dismissedWaModalCount = 0;
const dismissedWaModal = VCPUI.create('Modal', {
    title: 'Dismissed modal',
    content: document.createTextNode('Body'),
    onClose: () => { dismissedWaModalCount += 1; },
});
waHost.append(dismissedWaModal.element);
const userHide = new CustomEvent('wa-hide', { bubbles: true, cancelable: true });
dismissedWaModal.element.dispatchEvent(userHide);
dismissedWaModal.element.dispatchEvent(new CustomEvent('wa-after-hide', { bubbles: true }));
assert.equal(userHide.defaultPrevented, false);
assert.equal(dismissedWaModalCount, 1, 'Web Awesome user dismissal must invoke the Modal onClose contract');

let lockedWaModalCount = 0;
const lockedWaModal = VCPUI.create('Modal', {
    title: 'Locked modal',
    content: document.createTextNode('Body'),
    dismissible: false,
    onClose: () => { lockedWaModalCount += 1; },
});
waHost.append(lockedWaModal.element);
const blockedHide = new CustomEvent('wa-hide', { bubbles: true, cancelable: true });
lockedWaModal.element.dispatchEvent(blockedHide);
assert.equal(blockedHide.defaultPrevented, true, 'non-dismissible WA modal must block native dismiss requests');
assert.equal(lockedWaModalCount, 0);
lockedWaModal.close(null);
assert.equal(lockedWaModalCount, 1, 'programmatic completion may close a non-dismissible modal');
const programmaticHide = new CustomEvent('wa-hide', { bubbles: true, cancelable: true });
lockedWaModal.element.dispatchEvent(programmaticHide);
assert.equal(programmaticHide.defaultPrevented, false, 'programmatic close must bypass the user-dismiss lock');
lockedWaModal.element.dispatchEvent(new CustomEvent('wa-after-hide', { bubbles: true }));

const waTipTrigger = VCPUI.create('Button', { label: 'tip' });
const waTooltip = VCPUI.create('Tooltip', { trigger: waTipTrigger, content: '提示', placement: 'top' });
assert.equal(waTooltip.element.tagName.toLowerCase(), 'wa-tooltip');
assert.ok(waTipTrigger.element.id, 'tooltip trigger must get an id');
assert.equal(waTooltip.element.getAttribute('for'), waTipTrigger.element.id);

[waButton, waIconButton, waInput, waTextarea, waSelect, waCheckbox, waSwitch, waCard, waTabs, waModal, dismissedWaModal, lockedWaModal, waTooltip, waTipTrigger].forEach(controller => controller.destroy());
assert.equal(waHost.querySelectorAll('[class^="vcp-ui-"]').length, 0, 'WA-backed controls must be removed on destroy');
waHost.remove();

console.log(`UI system contract tests passed (${expected.length} public component names).`);
