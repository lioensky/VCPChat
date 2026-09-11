import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

async function fixture(t) {
    const dom = new JSDOM('<form><div id="prompt"></div></form>', {
        url: 'http://localhost',
        runScripts: 'outside-only',
    });
    t.after(() => dom.window.close());
    const { window } = dom;
    window.structuredClone = structuredClone;
    const writes = [];
    const api = {
        loadSettings: async () => ({}),
        getGlobalWarehouse: async () => ({ success: true, data: [] }),
        loadPresetPrompts: async () => ({ success: true, presets: [] }),
        updateAgentConfig: async (...args) => { writes.push(args); },
        saveGlobalWarehouse: async (...args) => { writes.push(args); },
    };
    for (const name of ['original-prompt-module', 'modular-prompt-module', 'preset-prompt-module', 'prompt-manager']) {
        window.eval(fs.readFileSync(new URL(`../Promptmodules/${name}.js`, import.meta.url), 'utf8'));
    }
    const manager = new window.PromptManager();
    await manager.init({ containerElement: window.document.getElementById('prompt'), electronAPI: api });
    return { window, api, manager, writes };
}

test('三模式切换保留各自草稿且不触发表单提交或配置写入', async t => {
    const { window, manager, writes } = await fixture(t);
    await manager.updateAgentContext('A', { originalSystemPrompt: 'A original', presetSystemPrompt: 'A preset' });
    let submits = 0;
    window.document.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        submits++;
    });
    manager.originalModule.textarea.value = 'edited original';
    window.document.querySelector('[data-mode="modular"]').click();
    manager.modularModule.addBlock('text');
    manager.modularModule.blocks[0].content = 'edited modular';
    await manager.switchMode('preset');
    await new Promise(resolve => setTimeout(resolve, 0));
    manager.presetModule.textarea.value = 'edited preset';
    await manager.switchMode('original');
    assert.equal(manager.originalModule.textarea.value, 'edited original');
    const draft = manager.collectDraft();
    assert.equal(draft.originalSystemPrompt, 'edited original');
    assert.equal(draft.presetSystemPrompt, 'edited preset');
    assert.equal(draft.advancedSystemPrompt.blocks[0].content, 'edited modular');
    assert.equal(draft.systemPrompt, 'edited original');
    assert.equal(submits, 0);
    assert.deepEqual(writes, []);
});

test('A 的积木不污染无积木配置的 B，空文本不回退到旧提示词', async t => {
    const { manager, writes } = await fixture(t);
    const config = { advancedSystemPrompt: { blocks: [{ id: 'a', type: 'text', content: 'A' }] } };
    await manager.updateAgentContext('A', config);
    manager.modularModule.blocks[0].content = 'draft A';
    assert.equal(config.advancedSystemPrompt.blocks[0].content, 'A');
    await manager.updateAgentContext('B', { originalSystemPrompt: '', systemPrompt: 'must not restore' });
    const draft = manager.collectDraft();
    assert.equal(draft.originalSystemPrompt, '');
    assert.equal(draft.advancedSystemPrompt.blocks.length, 0);
    assert.deepEqual(writes, []);
});

test('预制异步渲染迟到时不能插入已切回的文本视图', async t => {
    const { window, api, manager, writes } = await fixture(t);
    await manager.updateAgentContext('A', { originalSystemPrompt: 'original' });
    let release;
    api.loadPresetPrompts = () => new Promise(resolve => { release = resolve; });
    await manager.switchMode('preset');
    await manager.switchMode('original');
    release({ success: true, presets: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(window.document.querySelectorAll('.preset-prompt-textarea').length, 0);
    assert.equal(manager.originalModule.textarea.value, 'original');
    assert.deepEqual(writes, []);
});

test('积木输入未失焦即切换模式仍保留草稿，空轮换文本不回退', async t => {
    const { window, manager, writes } = await fixture(t);
    await manager.updateAgentContext('A', {
        promptMode: 'modular',
        advancedSystemPrompt: {
            blocks: [{ id: 'block-a', type: 'text', content: 'old', variants: ['old'], selectedVariant: 0 }]
        }
    });
    const editor = window.document.querySelector('.block-content');
    editor.contentEditable = 'true';
    editor.textContent = 'unblurred draft';
    editor.dispatchEvent(new window.Event('input', { bubbles: true }));
    await manager.switchMode('original');
    assert.equal(manager.collectDraft().advancedSystemPrompt.blocks[0].variants[0], 'unblurred draft');
    await manager.switchMode('modular');
    const nextEditor = window.document.querySelector('.block-content');
    nextEditor.contentEditable = 'true';
    nextEditor.textContent = '';
    nextEditor.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(manager.collectDraft().systemPrompt, '');
    assert.deepEqual(writes, []);
});