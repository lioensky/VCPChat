import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { createModelPickerPopup, modelCheckStore } from '../modules/renderer/model-picker-popup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceCode = fs.readFileSync(path.resolve(__dirname, '../modules/renderer/composerModelSelect.js'), 'utf8');

const tick = () => new Promise(resolve => setTimeout(resolve, 15));

function setupTestEnv() {
    const dom = new JSDOM(`<!doctype html>
<html>
<head></head>
<body>
    <div class="chat-input-card">
        <div class="chat-input-actions">
            <button id="sendMessageBtn" type="button">Send</button>
        </div>
    </div>
    <div id="settingsPanel">
        <input id="editingAgentId" value="agent_1" />
        <input id="agentModel" value="" />
    </div>
</body>
</html>`, {
        url: 'https://vcp.local/',
        runScripts: 'outside-only'
    });

    const { window } = dom;
    const { document } = window;

    // 挂载通用组件 Portal 与 CheckStore 到 JSDOM window
    window.ModelPickerPopup = {
        createModelPickerPopup,
        modelCheckStore
    };

    globalThis.window = window;
    globalThis.document = document;
    globalThis.localStorage = window.localStorage;
    globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };

    // 执行脚本挂载 window.ComposerModelSelect
    dom.window.eval(sourceCode);
    return { dom, window, document };
}

test('ComposerModelSelect: 默认未配置勾选池时，自适应展示全部模型并提示右键自定义', async () => {
    const { window, document } = setupTestEnv();
    window.localStorage.clear();

    const mockModels = ['gpt-4o', 'gemini-2.5-flash', 'claude-3-5-sonnet'];
    const electronAPI = {
        getCachedModels: async () => mockModels,
        getFavoriteModels: async () => ['gpt-4o'],
        saveAgentConfig: async () => ({ success: true })
    };

    let currentAgent = {
        type: 'agent',
        id: 'agent_1',
        name: '助手',
        config: { model: 'gemini-2.5-flash' }
    };
    const selectedItemRef = {
        get: () => currentAgent,
        set: (item) => { currentAgent = item; }
    };

    const instance = window.ComposerModelSelect.init({
        electronAPI,
        selectedItemRef,
        sendMessageBtn: document.getElementById('sendMessageBtn')
    });

    const trigger = document.querySelector('.vcp-model-select-trigger');
    const label = document.querySelector('.vcp-model-select-label');

    // 按钮显示当前选中的模型
    assert.equal(label.textContent, 'gemini-2.5-flash');

    // 左键点击打开候选菜单
    trigger.click();
    await tick();

    const menu = document.querySelector('.vcp-model-picker-popup[data-mode="select"]');
    assert.ok(menu, 'popup menu should be opened');

    // 规范 v2.0：checkedSet 为空时，自适应展示全部可用模型，绝不呈现冷启动白屏
    const options = document.querySelectorAll('.vcp-model-picker-item');
    assert.equal(options.length, 3, 'all models should be visible when pool is unconfigured');

    const hint = document.querySelector('.vcp-model-picker-hint');
    assert.ok(hint, 'hint should guide user to right-click');
    assert.match(hint.textContent, /右键按钮可自定义常用候选/);

    // 点击某项切换模型
    options[0].click();
    await tick();

    assert.equal(currentAgent.config.model, 'gpt-4o');
    assert.equal(label.textContent, 'gpt-4o');
    assert.equal(document.getElementById('agentModel').value, 'gpt-4o');
    assert.equal(document.querySelector('.vcp-model-picker-popup'), null, 'popup closes after selection');

    instance.dispose();
});

test('ComposerModelSelect: 右键弹出勾选菜单，勾选后持久化，左键仅展示勾选的模型', async () => {
    const { window, document } = setupTestEnv();
    window.localStorage.clear();

    const mockModels = ['gpt-4o', 'gemini-2.5-flash', 'claude-3-5-sonnet'];
    const electronAPI = {
        getCachedModels: async () => mockModels,
        getFavoriteModels: async () => ['gpt-4o'],
        saveAgentConfig: async () => ({ success: true })
    };

    let currentAgent = {
        type: 'agent',
        id: 'agent_1',
        name: '助手',
        config: { model: 'unlisted-model' }
    };
    const selectedItemRef = {
        get: () => currentAgent,
        set: (item) => { currentAgent = item; }
    };

    const instance = window.ComposerModelSelect.init({
        electronAPI,
        selectedItemRef,
        sendMessageBtn: document.getElementById('sendMessageBtn')
    });

    const trigger = document.querySelector('.vcp-model-select-trigger');
    const label = document.querySelector('.vcp-model-select-label');
    assert.equal(label.textContent, 'unlisted-model');

    // 右键点击触发器弹出勾选配置面板
    trigger.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();

    const checkMenu = document.querySelector('.vcp-model-picker-popup[data-mode="check"]');
    assert.ok(checkMenu, 'check menu should open');

    const checkItems = checkMenu.querySelectorAll('.vcp-model-picker-check-item');
    assert.equal(checkItems.length, 3);
    checkItems.forEach(item => {
        assert.equal(item.getAttribute('aria-checked'), 'false');
    });

    // 勾选前两个模型 (gpt-4o, gemini-2.5-flash)
    checkItems[0].click();
    assert.equal(checkItems[0].getAttribute('aria-checked'), 'true');
    checkItems[1].click();
    assert.equal(checkItems[1].getAttribute('aria-checked'), 'true');

    // 验证持久化存储
    const saved = JSON.parse(window.localStorage.getItem('vcp-composer-checked-models'));
    assert.deepEqual(new Set(saved), new Set(['gpt-4o', 'gemini-2.5-flash']));

    // 关闭勾选菜单
    document.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(document.querySelector('.vcp-model-picker-popup'), null);

    // 再次左键点击打开候选列表
    trigger.click();
    await tick();

    const selectMenu = document.querySelector('.vcp-model-picker-popup[data-mode="select"]');
    assert.ok(selectMenu);

    // 只有勾选的两个模型出现在候选中，未勾选的 claude-3-5-sonnet 被过滤
    const optionNames = Array.from(selectMenu.querySelectorAll('.vcp-model-picker-item .name')).map(el => el.textContent);
    assert.deepEqual(new Set(optionNames), new Set(['gpt-4o', 'gemini-2.5-flash']));
    assert.ok(!optionNames.includes('claude-3-5-sonnet'));

    instance.dispose();
});

test('ComposerModelSelect: 全选与清空操作正确更新持久化与候选状态', async () => {
    const { window, document } = setupTestEnv();
    window.localStorage.clear();

    const mockModels = ['model-a', 'model-b', 'model-c'];
    const electronAPI = {
        getCachedModels: async () => mockModels,
        getFavoriteModels: async () => [],
        saveAgentConfig: async () => ({ success: true })
    };

    let currentAgent = {
        type: 'agent',
        id: 'agent_1',
        config: { model: 'model-a' }
    };
    const selectedItemRef = {
        get: () => currentAgent,
        set: (item) => { currentAgent = item; }
    };

    const instance = window.ComposerModelSelect.init({
        electronAPI,
        selectedItemRef,
        sendMessageBtn: document.getElementById('sendMessageBtn')
    });

    const trigger = document.querySelector('.vcp-model-select-trigger');

    // 右键打开勾选菜单并全选
    trigger.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();

    const selectAllBtn = document.querySelectorAll('.vcp-model-picker-action-btn')[0];
    assert.ok(selectAllBtn, 'selectAllBtn should exist');
    selectAllBtn.click();

    let saved = JSON.parse(window.localStorage.getItem('vcp-composer-checked-models'));
    assert.equal(saved.length, 3);

    // 点击清空
    const clearAllBtn = document.querySelectorAll('.vcp-model-picker-action-btn')[1];
    assert.ok(clearAllBtn, 'clearAllBtn should exist');
    clearAllBtn.click();

    saved = JSON.parse(window.localStorage.getItem('vcp-composer-checked-models'));
    assert.equal(saved.length, 0);

    instance.dispose();
});