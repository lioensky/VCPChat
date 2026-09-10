import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

function fixture(t) {
    const dom = new JSDOM('<form><div id="prompts"></div></form>', {
        runScripts: 'outside-only',
        url: 'https://test.invalid',
    });
    t.after(() => dom.window.close());
    dom.window.structuredClone = structuredClone;
    for (const file of ['original-prompt-module', 'modular-prompt-module', 'preset-prompt-module', 'prompt-manager']) {
        dom.window.eval(fs.readFileSync(new URL(`../Promptmodules/${file}.js`, import.meta.url), 'utf8'));
    }
    const writes = [];
    const api = {
        loadSettings: async () => ({}),
        getGlobalWarehouse: async () => ({ success: true, data: [], currentRevision: 'warehouse-0' }),
        loadPresetPrompts: async () => ({ success: true, presets: [] }),
        saveGlobalWarehouse: async () => ({ success: true, currentRevision: 'warehouse-1' }),
        updateAgentConfig: async (id, patch) => {
            writes.push({ id, patch: structuredClone(patch) });
            return { success: true };
        },
    };
    return { dom, api, writes, container: dom.window.document.getElementById('prompts') };
}

test('detached A → B → A keeps each original prompt and does not write on browsing', async t => {
    const { dom, api, writes, container } = fixture(t);
    const manager = new dom.window.PromptManager();
    await manager.init({ containerElement: container, electronAPI: api });
    await manager.updateAgentContext('A', { originalSystemPrompt: 'prompt A' });
    const oldEditor = manager.originalModule.textarea;
    container.parentElement.remove();
    await manager.saveCurrentModeData();
    await manager.updateAgentContext('B', { originalSystemPrompt: 'prompt B' });
    assert.equal(await manager.getCurrentSystemPrompt(), 'prompt B');
    assert.equal(manager.originalModule.textarea.value, 'prompt B');
    oldEditor.value = 'late A input';
    oldEditor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(await manager.getCurrentSystemPrompt(), 'prompt B');
    await manager.saveCurrentModeData();
    await manager.updateAgentContext('A', { originalSystemPrompt: 'prompt A' });
    assert.equal(await manager.getCurrentSystemPrompt(), 'prompt A');
    assert.deepEqual(writes, []);
});

test('explicit empty original content never inherits compatibility content', async t => {
    const { dom, api } = fixture(t);
    const module = new dom.window.OriginalPromptModule({ electronAPI: api });
    module.updateContext('A', { originalSystemPrompt: '', systemPrompt: 'other content' });
    assert.equal(await module.getPrompt(), '');
    module.updateContext('B', { promptMode: 'preset', systemPrompt: 'preset content' });
    assert.equal(await module.getPrompt(), '');
});

test('original draft survives failed save and retries to the same Agent', async t => {
    const { dom, api, writes, container } = fixture(t);
    const module = new dom.window.OriginalPromptModule({ electronAPI: api });
    module.updateContext('A', { originalSystemPrompt: 'old' });
    module.render(container);
    module.textarea.value = 'edited';
    module.textarea.dispatchEvent(new dom.window.Event('input'));
    const save = api.updateAgentConfig;
    api.updateAgentConfig = async () => ({ success: false, error: 'disk unavailable' });
    await assert.rejects(module.save(), /disk unavailable/);
    assert.equal(await module.getPrompt(), 'edited');
    api.updateAgentConfig = save;
    await module.save();
    assert.deepEqual(writes, [{ id: 'A', patch: { originalSystemPrompt: 'edited' } }]);
});

test('missing modular data resets private blocks and does not mutate source config', async t => {
    const { dom, api } = fixture(t);
    const module = new dom.window.ModularPromptModule({ electronAPI: api });
    const config = { advancedSystemPrompt: { blocks: [{ type: 'text', content: 'A' }] } };
    await module.updateContext('A', config);
    module.blocks[0].content = 'edited';
    assert.equal(config.advancedSystemPrompt.blocks[0].content, 'A');
    await module.updateContext('B', {});
    assert.equal(module.getFormattedPrompt(), '');
    assert.equal(module.blocks.length, 0);
    assert.equal(module.currentWarehouse, 'default');
});

test('rapid mode clicks settle on the last intent with matching durable content', async t => {
    const { dom, api, writes, container } = fixture(t);
    const manager = new dom.window.PromptManager();
    await manager.init({ containerElement: container, electronAPI: api });
    await manager.updateAgentContext('A', {
        originalSystemPrompt: 'original A',
        presetSystemPrompt: '',
        advancedSystemPrompt: { blocks: [{ type: 'text', content: 'modular A' }] },
    });
    await Promise.all([
        manager.switchMode('modular'),
        manager.switchMode('preset'),
        manager.switchMode('original'),
    ]);
    assert.equal(manager.getMode(), 'original');
    assert.equal(await manager.getCurrentSystemPrompt(), 'original A');
    assert.deepEqual(writes.at(-1), {
        id: 'A', patch: { promptMode: 'original', systemPrompt: 'original A' },
    });
    await manager.switchMode('preset');
    assert.equal(manager.getMode(), 'preset');
    assert.equal(await manager.getCurrentSystemPrompt(), '');
    assert.deepEqual(writes.at(-1), {
        id: 'A', patch: { promptMode: 'preset', systemPrompt: '' },
    });
    assert.equal(container.querySelectorAll('.preset-prompt-textarea').length, 1);
    assert.ok([...container.querySelectorAll('.prompt-mode-button')].every(button => button.type === 'button'));
});

test('failed mode commit preserves the displayed mode and original draft', async t => {
    const { dom, api, container } = fixture(t);
    const manager = new dom.window.PromptManager();
    await manager.init({ containerElement: container, electronAPI: api });
    await manager.updateAgentContext('A', { originalSystemPrompt: 'original A' });
    api.updateAgentConfig = async () => ({ success: false, error: 'write failed' });
    await assert.rejects(manager.switchMode('preset'), /write failed/);
    assert.equal(manager.getMode(), 'original');
    assert.equal(await manager.getCurrentSystemPrompt(), 'original A');
    assert.equal(container.querySelector('.original-prompt-textarea').value, 'original A');
});

test('late mode commit for A cannot change B mode or editor', async t => {
    const { dom, api, container } = fixture(t);
    const manager = new dom.window.PromptManager();
    await manager.init({ containerElement: container, electronAPI: api });
    await manager.updateAgentContext('A', { originalSystemPrompt: 'A', presetSystemPrompt: 'preset A' });
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    api.updateAgentConfig = async (id, patch) => {
        assert.equal(id, 'A');
        assert.equal(patch.systemPrompt, 'preset A');
        started();
        await new Promise(resolve => { release = resolve; });
        return { success: true };
    };
    const pending = manager.switchMode('preset');
    await ready;
    await manager.updateAgentContext('B', { originalSystemPrompt: 'B' });
    release();
    await pending;
    assert.equal(manager.getAgentId(), 'B');
    assert.equal(manager.getMode(), 'original');
    assert.equal(await manager.getCurrentSystemPrompt(), 'B');
    assert.equal(container.querySelector('.original-prompt-textarea').value, 'B');
});

test('installed coordinator rejection never falls back to direct prompt IPC', async t => {
    const { dom, api, writes, container } = fixture(t);
    const manager = new dom.window.PromptManager();
    await manager.init({ containerElement: container, electronAPI: api });
    await manager.updateAgentContext('A', { originalSystemPrompt: 'A' });
    dom.window.settingsManager = {
        stageAgentPatch: () => ({
            success: false, stale: true, error: 'session-rejected'
        }),
    };

    manager.originalModule.cachedContent = 'edited';
    await assert.rejects(manager.originalModule.save(), /session-rejected/);
    await assert.rejects(manager.presetModule.save(), /session-rejected/);
    await assert.rejects(manager.presetModule.savePresetPath(), /session-rejected/);
    await assert.rejects(manager.modularModule.save(), /session-rejected/);
    await assert.rejects(manager.switchMode('preset'), /session-rejected/);
    assert.equal(manager.getMode(), 'original');
    assert.deepEqual(writes, []);
});

test('original staging back to the durable value does not leave an older draft pending', async t => {
    const { dom, api, writes } = fixture(t);
    const module = new dom.window.OriginalPromptModule({ electronAPI: api });
    const staged = [];
    dom.window.settingsManager = {
        stageAgentPatch: (patch, agentId) => {
            staged.push({ agentId, patch: structuredClone(patch) });
            return { success: true, staged: true };
        },
    };
    module.updateContext('A', { originalSystemPrompt: 'base' });
    module.cachedContent = 'edited';
    await module.save();
    assert.equal(module.persistedContent, 'base');
    module.cachedContent = 'base';
    await module.save();
    assert.deepEqual(staged, [
        { agentId: 'A', patch: { originalSystemPrompt: 'edited' } },
        { agentId: 'A', patch: { originalSystemPrompt: 'base' } },
    ]);
    assert.deepEqual(writes, []);
});

test('explicitly empty modular variant does not inherit the legacy block content', async t => {
    const { dom, api } = fixture(t);
    const module = new dom.window.ModularPromptModule({ electronAPI: api });
    await module.updateContext('A', {
        advancedSystemPrompt: {
            blocks: [{
                type: 'text', content: 'legacy content',
                variants: [''], selectedVariant: 0,
            }],
        },
    });
    assert.equal(module.getFormattedPrompt(), '');
});

test('failed global warehouse load never authorizes an empty warehouse overwrite', async t => {
    const { dom, api, writes } = fixture(t);
    let globalWrites = 0;
    api.getGlobalWarehouse = async () => ({ success: false, error: 'unreadable' });
    api.saveGlobalWarehouse = async () => {
        globalWrites += 1;
        return { success: true };
    };
    const module = new dom.window.ModularPromptModule({ electronAPI: api });
    await module.updateContext('A', {
        advancedSystemPrompt: { blocks: [{ type: 'text', content: 'private' }] },
    });
    await module.save();
    assert.equal(globalWrites, 0);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].id, 'A');
    assert.equal(writes[0].patch.advancedSystemPrompt.blocks[0].content, 'private');
});

test('late preset load cannot overwrite a newer Agent context', async t => {
    const { dom, api, container } = fixture(t);
    let releasePreset;
    let signalStarted;
    const loadStarted = new Promise(resolve => { signalStarted = resolve; });
    const presetReady = new Promise(resolve => { releasePreset = resolve; });
    api.loadPresetPrompts = async () => ({ success: true, presets: [{ path: 'late.md', name: 'late' }] });
    api.loadPresetContent = async (path) => {
        assert.equal(path, 'late.md');
        signalStarted();
        await presetReady;
        return { success: true, content: 'late preset A' };
    };
    const manager = new dom.window.PromptManager();
    await manager.init({ containerElement: container, electronAPI: api });
    await manager.updateAgentContext('A', {
        promptMode: 'original',
        originalSystemPrompt: 'A',
        presetSystemPrompt: 'old preset A',
        selectedPreset: 'old.md',
    });
    await manager.switchMode('preset');
    manager.presetModule.presetSelect.value = 'late.md';
    const pendingLoad = manager.presetModule.loadSelectedPreset();
    await loadStarted;
    await manager.updateAgentContext('B', {
        promptMode: 'original',
        originalSystemPrompt: 'B',
    });
    releasePreset();
    await pendingLoad;
    assert.equal(manager.getAgentId(), 'B');
    assert.equal(manager.getMode(), 'original');
    assert.equal(await manager.getCurrentSystemPrompt(), 'B');
    assert.equal(manager.presetModule.agentId, 'B');
});

test('rapid Agent and mode changes keep the latest context and editor', async t => {
    const { dom, api, container } = fixture(t);
    const manager = new dom.window.PromptManager();
    await manager.init({ containerElement: container, electronAPI: api });
    await manager.updateAgentContext('A', {
        promptMode: 'original',
        originalSystemPrompt: 'A',
        advancedSystemPrompt: { blocks: [{ type: 'text', content: 'A modular' }] },
    });
    const switching = manager.switchMode('modular');
    const replacing = manager.updateAgentContext('B', {
        promptMode: 'preset',
        presetSystemPrompt: '',
        selectedPreset: '',
    });
    await Promise.allSettled([switching, replacing]);
    assert.equal(manager.getAgentId(), 'B');
    assert.equal(manager.getMode(), 'preset');
    assert.equal(await manager.getCurrentSystemPrompt(), '');
    assert.equal(container.querySelectorAll('.preset-prompt-textarea').length, 1);
    assert.equal(container.querySelector('.preset-prompt-textarea').value, '');
});

test('empty preset selection is durable and does not retain a previous preset draft', async t => {
    const { dom, api, writes, container } = fixture(t);
    const manager = new dom.window.PromptManager();
    await manager.init({ containerElement: container, electronAPI: api });
    await manager.updateAgentContext('A', {
        promptMode: 'preset',
        presetSystemPrompt: 'previous',
        selectedPreset: 'previous.md',
    });
    const select = manager.presetModule.presetSelect;
    select.value = '';
    await manager.presetModule.loadSelectedPreset();
    assert.equal(manager.presetModule.cachedSelectedPreset, '');
    assert.equal(manager.presetModule.cachedContent, '');
    assert.ok(writes.some(write =>
        write.id === 'A' && write.patch.presetSystemPrompt === ''
    ));
    assert.ok(writes.some(write =>
        write.id === 'A' && write.patch.selectedPreset === ''
    ));
});

test('global queue freezes successive drafts and persists a return to the original value', async t => {
    const { dom, api } = fixture(t);
    const module = new dom.window.ModularPromptModule({ electronAPI: api });
    await module.updateContext('A', {});
    let release;
    let signal;
    const started = new Promise(resolve => { signal = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const transactions = [];
    api.saveGlobalWarehouse = async transaction => {
        transactions.push(structuredClone(transaction));
        if (transactions.length === 1) {
            signal();
            await gate;
        }
        return { success: true, currentRevision: `warehouse-${transactions.length}` };
    };
    module.hiddenBlocks.global = [{ content: 'first' }];
    const first = module.save();
    await started;
    module.hiddenBlocks.global = [];
    const second = module.save();
    release();
    await Promise.all([first, second]);
    assert.equal(transactions.length, 2);
    assert.deepEqual(transactions[0].data, [{ content: 'first' }]);
    assert.deepEqual(transactions[1].data, []);
    assert.equal(transactions[0].expectedRevision, 'warehouse-0');
    assert.equal(transactions[1].expectedRevision, 'warehouse-1');
    assert.equal(module.persistedGlobalWarehouse, '[]');
    assert.equal(module.globalWarehouseRevision, 'warehouse-2');
});

test('global conflict preserves draft, blocks blind retry and prevents context replacement', async t => {
    const { dom, api } = fixture(t);
    const module = new dom.window.ModularPromptModule({ electronAPI: api });
    await module.updateContext('A', {});
    let writes = 0;
    api.saveGlobalWarehouse = async () => {
        writes += 1;
        return { success: false, status: 'conflict', error: 'warehouse changed externally' };
    };
    module.hiddenBlocks.global = [{ content: 'unsaved' }];
    await assert.rejects(module.save(), /changed externally/);
    await assert.rejects(module.save(), /changed externally/);
    await assert.rejects(module.updateContext('B', {}), /未保存草稿/);
    assert.equal(writes, 1);
    assert.equal(module.agentId, 'A');
    assert.equal(module.hiddenBlocks.global[0].content, 'unsaved');
    assert.equal(module.globalWarehouseRevision, 'warehouse-0');
});