import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Agent settings save only on the Save button and every Agent shares one
// form. Switching Agent used to overwrite unsaved edits, including the ones a
// failed save had just tried to persist. The draft now stays with its Agent
// until a save succeeds.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const schema = await import(pathToFileURL(path.join(repoRoot, 'modules/settings/schema/sidebar-surfaces.js')).href);
const surfaceModule = await import(pathToFileURL(path.join(repoRoot, 'modules/ui-system/settings/settings-sidebar-surface.js')).href);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withAgentSettings(run) {
    const dom = new JSDOM('<!doctype html><html><body><main id="tabContentSettings" class="active" aria-hidden="false"><div id="agentSettingsContainer"></div><p id="selectAgentPromptForSettings">请选择</p></main></body></html>', { url: 'http://localhost' });
    const { document } = dom.window;
    const saved = {
        window: globalThis.window,
        document: globalThis.document,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        MutationObserver: globalThis.MutationObserver,
        CustomEvent: globalThis.CustomEvent,
        setInterval: globalThis.setInterval
    };
    const intervals = [];
    globalThis.window = dom.window;
    globalThis.document = document;
    globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
    dom.window.requestAnimationFrame = cb => setTimeout(cb, 0);
    globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.setInterval = (...args) => {
        const id = saved.setInterval(...args);
        id.unref?.();
        intervals.push(id);
        return id;
    };

    try {
        const root = document.getElementById('tabContentSettings');
        const surface = surfaceModule.createSettingsSidebarSurface({ document, root });
        dom.window.VCPSettingsSidebar = surface;
        const host = document.getElementById('agentSettingsContainer');
        const form = schema.renderAgentSettingsSurface(host, document);
        surface.register('agent', host);
        dom.window.eval(fs.readFileSync(path.join(repoRoot, 'modules/settingsManager.js'), 'utf8'));
        const sm = dom.window.settingsManager;

        const disk = {
            'agent-a': { name: 'Alice', customCss: '' },
            'agent-b': { name: 'Bob', customCss: '.bob {}' }
        };
        let saveFails = false;
        let selected = { id: 'agent-a', type: 'agent' };
        const toasts = [];
        sm.init({
            electronAPI: {
                saveAgentConfig: async (id, config) => {
                    if (saveFails) return { success: false, error: 'disk full' };
                    disk[id] = { ...disk[id], ...config };
                    return { success: true };
                },
                getAgentConfig: async id => structuredClone(disk[id]),
                sovitsGetModels: async () => ({ models: [] })
            },
            uiHelper: { showToastNotification: (msg, type) => toasts.push({ msg, type }), showSaveFeedback() {} },
            refs: { currentSelectedItemRef: { get: () => selected, set: value => { selected = value; } } },
            mainRendererFunctions: { getCroppedFile: () => null, resetCroppedFile() {} },
            elements: {
                agentSettingsContainer: host,
                groupSettingsContainer: null,
                selectItemPromptForSettings: document.getElementById('selectAgentPromptForSettings'),
                itemSettingsContainerTitle: null,
                selectedItemNameForSettingsSpan: null,
                deleteItemBtn: document.getElementById('deleteAgentBtn'),
                agentSettingsForm: form,
                editingAgentIdInput: form.querySelector('#editingAgentId'),
                agentNameInput: form.querySelector('#agentNameInput'),
                agentAvatarInput: form.querySelector('#agentAvatarInput'),
                agentAvatarPreview: form.querySelector('#agentAvatarPreview'),
                agentModelInput: form.querySelector('#agentModel'),
                agentTemperatureInput: form.querySelector('#agentTemperature'),
                agentContextTokenLimitInput: form.querySelector('#agentContextTokenLimit'),
                agentMaxOutputTokensInput: form.querySelector('#agentMaxOutputTokens'),
                openModelSelectBtn: form.querySelector('#openModelSelectBtn'),
                topicSummaryModelInput: null,
                openTopicSummaryModelSelectBtn: null,
                agentTtsSpeedSlider: form.querySelector('#agentTtsSpeed')
            }
        });

        const show = async id => {
            selected = { id, type: 'agent', config: structuredClone(disk[id]) };
            await sm.displaySettingsForItem(selected);
            await wait(10);
        };
        const edit = (id, value) => {
            const input = form.querySelector(`#${id}`);
            input.value = value;
            input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        };
        const save = async () => {
            form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
            await wait(30);
        };
        const state = () => document.getElementById('formSaveStateIndicator').dataset.state;
        const value = id => form.querySelector(`#${id}`).value;
        await run({ show, edit, save, state, value, toasts, disk, setSaveFails: v => { saveFails = v; } });
    } finally {
        intervals.forEach(clearInterval);
        Object.assign(globalThis, saved);
        dom.window.close();
    }
}

test('an edit kept after a failed save survives switching to another Agent and back', () => withAgentSettings(async ({ show, edit, save, state, value, toasts, disk, setSaveFails }) => {
    await show('agent-a');
    assert.equal(state(), 'done');
    edit('agentCustomCss', '.alice { color: red; }');
    setSaveFails(true);
    await save();
    assert.equal(state(), 'warning', 'a failed save leaves the edit unsaved');

    await show('agent-b');
    assert.equal(value('agentCustomCss'), '.bob {}', 'Agent B shows its own values');
    assert.equal(state(), 'done', 'Agent B has nothing unsaved');

    toasts.length = 0;
    await show('agent-a');
    assert.equal(value('agentCustomCss'), '.alice { color: red; }', 'the unsaved edit comes back with Agent A');
    assert.equal(state(), 'warning', 'the restored draft is still unsaved');
    assert.ok(toasts.some(t => t.msg.includes('已恢复')), 'the user is told the draft was restored');
    assert.equal(disk['agent-a'].customCss, '', 'nothing was written to disk behind the user');

    setSaveFails(false);
    await save();
    assert.equal(state(), 'done');
    assert.equal(disk['agent-a'].customCss, '.alice { color: red; }');
}));

test('a saved Agent comes back from disk without a stale draft', () => withAgentSettings(async ({ show, edit, save, state, value, toasts }) => {
    await show('agent-a');
    edit('agentCustomCss', '.saved {}');
    await save();
    await show('agent-b');
    toasts.length = 0;
    await show('agent-a');
    assert.equal(value('agentCustomCss'), '.saved {}');
    assert.equal(state(), 'done');
    assert.ok(!toasts.some(t => t.msg.includes('已恢复')));
}));

test('a clean Agent leaves no draft behind', () => withAgentSettings(async ({ show, state, value, toasts }) => {
    await show('agent-b');
    await show('agent-a');
    toasts.length = 0;
    await show('agent-b');
    assert.equal(value('agentCustomCss'), '.bob {}');
    assert.equal(state(), 'done');
    assert.equal(toasts.length, 0);
}));

test('a draft with the name cleared does not take the next Agent\'s name', () => withAgentSettings(async ({ show, edit, save, value, disk }) => {
    await show('agent-a');
    edit('agentCustomCss', '.alice {}');
    edit('agentNameInput', '');
    await show('agent-b');
    await show('agent-a');
    assert.equal(value('agentCustomCss'), '.alice {}', 'the draft came back');
    assert.notEqual(value('agentNameInput'), 'Bob');
    await save();
    assert.notEqual(disk['agent-a'].name, 'Bob', 'saving the restored draft keeps Agent A\'s name');
}));
test('local tool choices survive draft switching, save, reload and return to inheritance', () => withAgentSettings(async ({ show, edit, save, value, disk }) => {
    await show('agent-a');
    assert.equal(value('agentToolPresentation'), 'inherit');
    edit('agentToolPresentation', 'process');
    edit('agentToolExpansion', 'none');
    await show('agent-b');
    assert.equal(value('agentToolPresentation'), 'inherit');
    await show('agent-a');
    assert.equal(value('agentToolPresentation'), 'process');
    assert.equal(value('agentToolExpansion'), 'none');
    await save();
    assert.equal(disk['agent-a'].toolPresentation, 'process');
    assert.equal(disk['agent-a'].toolExpansion, 'none');
    await show('agent-b');
    await show('agent-a');
    assert.equal(value('agentToolPresentation'), 'process');
    edit('agentToolPresentation', 'inherit');
    edit('agentToolExpansion', 'inherit');
    await save();
    assert.equal(disk['agent-a'].toolPresentation, 'inherit');
    assert.equal(disk['agent-a'].toolExpansion, 'inherit');
}));
