import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Agent and group settings save only on the Save button. Every edit has to
// show 未保存更改 before the user switches away, or the switch drops it
// without a trace. These cover the edits that bypass the form's own
// input/change events: the regex modal, MiMo add/remove, and group speaker
// reordering, plus the group form, which had no indicator at all.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const mainHtml = fs.readFileSync(path.join(repoRoot, 'main.html'), 'utf8');
const schema = await import(pathToFileURL(path.join(repoRoot, 'modules/settings/schema/sidebar-surfaces.js')).href);
const surfaceModule = await import(pathToFileURL(path.join(repoRoot, 'modules/ui-system/settings/settings-sidebar-surface.js')).href);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function withDom(run) {
    return async () => {
        const dom = new JSDOM('<!doctype html><html><body><main id="tabContentSettings" class="active" aria-hidden="false"><div id="agentSettingsContainer"></div><p id="selectAgentPromptForSettings">请选择</p></main></body></html>', { url: 'http://localhost' });
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
        globalThis.document = dom.window.document;
        globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
        dom.window.requestAnimationFrame = cb => setTimeout(cb, 0);
        globalThis.MutationObserver = dom.window.MutationObserver;
        globalThis.CustomEvent = dom.window.CustomEvent;
        globalThis.setInterval = (...args) => {
            const id = saved.setInterval(...args);
            id.unref?.();
            intervals.push(id);
            return id;
        };
        try {
            await run(dom, dom.window.document);
        } finally {
            intervals.forEach(clearInterval);
            Object.assign(globalThis, saved);
            dom.window.close();
        }
    };
}

function mountRegexModal(document) {
    const match = mainHtml.match(/<template id="regexRuleModalTemplate">([\s\S]*?)<\/template>/);
    assert.ok(match, 'main.html must carry the regex modal template');
    const holder = document.createElement('div');
    holder.innerHTML = match[1];
    document.body.append(...holder.childNodes);
}

async function mountAgentSettings(dom, document) {
    const host = document.getElementById('agentSettingsContainer');
    const form = schema.renderAgentSettingsSurface(host, document);
    mountRegexModal(document);
    dom.window.eval(fs.readFileSync(path.join(repoRoot, 'modules/settingsManager.js'), 'utf8'));
    const sm = dom.window.settingsManager;
    sm.init({
        electronAPI: { saveAgentConfig: async () => ({ success: true }), getAgentConfig: async () => ({}) },
        uiHelper: {
            showToastNotification() {},
            showSaveFeedback() {},
            openModal() {},
            closeModal() {},
            showConfirmDialog: async () => true
        },
        refs: { currentSelectedItemRef: { get: () => ({ id: 'agent-a', type: 'agent' }), set() {} } },
        mainRendererFunctions: { getCroppedFile: () => null, resetCroppedFile() {} },
        elements: {
            agentSettingsContainer: host,
            groupSettingsContainer: null,
            selectItemPromptForSettings: document.getElementById('selectAgentPromptForSettings'),
            itemSettingsContainerTitle: null,
            selectedItemNameForSettingsSpan: null,
            deleteItemBtn: document.getElementById('deleteAgentBtn'),
            agentSettingsForm: form,
            editingAgentIdInput: document.getElementById('editingAgentId'),
            agentNameInput: document.getElementById('agentNameInput'),
            agentAvatarInput: document.getElementById('agentAvatarInput'),
            agentAvatarPreview: document.getElementById('agentAvatarPreview'),
            agentModelInput: document.getElementById('agentModel'),
            agentTemperatureInput: document.getElementById('agentTemperature'),
            agentContextTokenLimitInput: document.getElementById('agentContextTokenLimit'),
            agentMaxOutputTokensInput: document.getElementById('agentMaxOutputTokens'),
            openModelSelectBtn: document.getElementById('openModelSelectBtn'),
            topicSummaryModelInput: null,
            openTopicSummaryModelSelectBtn: null,
            agentTtsSpeedSlider: document.getElementById('agentTtsSpeed')
        }
    });
    document.dispatchEvent(new dom.window.CustomEvent('modal-ready', { detail: { modalId: 'regexRuleModal' } }));
    document.getElementById('editingAgentId').value = 'agent-a';
    const state = () => document.getElementById('formSaveStateIndicator').dataset.state;
    const save = async () => {
        form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
        await wait(30);
    };
    return { sm, form, state, save };
}

test('adding or editing a regex rule in the modal marks the Agent form unsaved', withDom(async (dom, document) => {
    const { sm, state, save } = await mountAgentSettings(dom, document);
    await save();
    assert.equal(state(), 'done');

    sm.openRegexModal();
    document.getElementById('regexRuleTitle').value = 'strip thinking';
    document.getElementById('regexRuleFind').value = '<think>.*</think>';
    document.getElementById('regexRuleForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(document.querySelectorAll('.strip-regex-row').length, 1);
    assert.equal(state(), 'warning', 'a new regex rule is an unsaved edit');
}));

test('deleting a regex rule marks the Agent form unsaved', withDom(async (dom, document) => {
    const { sm, state, save } = await mountAgentSettings(dom, document);
    sm.openRegexModal();
    document.getElementById('regexRuleTitle').value = 'rule';
    document.getElementById('regexRuleFind').value = 'x';
    document.getElementById('regexRuleForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await save();
    assert.equal(state(), 'done');

    document.querySelector('.btn-delete-regex').click();
    await wait(0);
    assert.equal(document.querySelectorAll('.strip-regex-row').length, 0);
    assert.equal(state(), 'warning', 'a deleted regex rule is an unsaved edit');
}));

test('adding or removing a MiMo director prompt marks the Agent form unsaved', withDom(async (dom, document) => {
    const { sm, state, save } = await mountAgentSettings(dom, document);
    await save();
    assert.equal(state(), 'done');

    sm.setTtsDirectorPrompts(['温柔一点']);
    assert.equal(state(), 'warning', 'adding a prompt is an unsaved edit');

    await save();
    assert.equal(state(), 'done');
    sm.setTtsDirectorPrompts(['温柔一点']);
    assert.equal(state(), 'done', 'writing back the same prompts is not an edit');

    sm.setTtsDirectorPrompts([]);
    assert.equal(state(), 'warning', 'removing a prompt is an unsaved edit');
}));

async function mountGroupSettings(dom, document, { saveResult = { success: true } } = {}) {
    const root = document.getElementById('tabContentSettings');
    dom.window.VCPSettingsSidebar = surfaceModule.createSettingsSidebarSurface({ document, root });
    dom.window.VCPSettingsSchema = schema;
    dom.window.eval(fs.readFileSync(path.join(repoRoot, 'modules/ui-system/settings/group-slots.js'), 'utf8'));
    dom.window.VCPGroupSettingsSlots.ensureSettingsSurface({ document, settingsTab: root });
    dom.window.eval(fs.readFileSync(path.join(repoRoot, 'Groupmodules/grouprenderer.js'), 'utf8'));
    const gr = dom.window.GroupRenderer;
    const agents = [{ id: 'a1', name: 'Ann' }, { id: 'a2', name: 'Bob' }];
    const configs = {
        'group-1': { id: 'group-1', name: 'One', mode: 'sequential', members: ['a1', 'a2'] },
        'group-2': { id: 'group-2', name: 'Two', mode: 'sequential', members: ['a1', 'a2'] }
    };
    let selected = { id: 'group-1', type: 'group' };
    gr.init({
        electronAPI: {
            getAgentGroupConfig: async id => structuredClone(configs[id]),
            getAgents: async () => agents,
            saveAgentGroupConfig: async (id, config) => (saveResult.success
                ? { success: true, agentGroup: { ...config, id } }
                : { success: false, error: 'disk full' })
        },
        globalSettings: {},
        currentSelectedItemRef: { get: () => selected, set: value => { selected = value; } },
        currentTopicIdRef: { get: () => null, set() {} },
        messageRenderer: { setCurrentItemAvatar() {}, setCurrentItemAvatarColor() {} },
        uiHelper: { showToastNotification() {}, showSaveFeedback() {} },
        mainRendererElements: {},
        selectAgentPromptForSettingsElement: document.getElementById('selectAgentPromptForSettings'),
        agentSettingsContainer: null,
        selectedItemNameForSettingsElement: null,
        mainRendererFunctions: { setCroppedFile() {}, getCroppedFile: () => null, loadItems: async () => {} }
    });
    const open = async id => {
        selected = { id, type: 'group' };
        await gr.displayGroupSettingsPage(id);
    };
    const state = () => document.querySelector('#groupSettingsForm .form-save-state-indicator')?.dataset.state;
    return { gr, open, state };
}

test('group settings show unsaved edits, clear on save, and reset on switching group', withDom(async (dom, document) => {
    const { open, state } = await mountGroupSettings(dom, document);
    await open('group-1');
    assert.equal(state(), 'done', 'a freshly loaded group has nothing unsaved');

    const name = document.getElementById('groupNameInput');
    name.value = 'One renamed';
    name.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(state(), 'warning', 'typing in the group form is an unsaved edit');

    document.getElementById('groupSettingsForm')
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(30);
    assert.equal(state(), 'done', 'a successful save clears the indicator');

    name.value = 'again';
    name.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await open('group-2');
    assert.equal(state(), 'done', 'the next group starts clean');
}));

test('reordering the speaker order marks the group form unsaved', withDom(async (dom, document) => {
    const { open, state } = await mountGroupSettings(dom, document);
    await open('group-1');
    assert.equal(state(), 'done');
    const items = document.querySelectorAll('#sequentialSpeakerOrderList .sequential-speaker-order-item');
    assert.equal(items.length, 2);
    items[1].querySelector('button').click();
    assert.equal(state(), 'warning', 'a speaker reorder fires no input event but is still an edit');
}));

test('a failed group save keeps the edit marked unsaved', withDom(async (dom, document) => {
    const { open, state } = await mountGroupSettings(dom, document, { saveResult: { success: false } });
    await open('group-1');
    const name = document.getElementById('groupNameInput');
    name.value = 'lost?';
    name.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    document.getElementById('groupSettingsForm')
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(30);
    assert.equal(state(), 'warning');
}));
