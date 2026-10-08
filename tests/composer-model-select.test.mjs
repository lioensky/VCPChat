import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceCode = fs.readFileSync(path.resolve(__dirname, '../modules/renderer/composerModelSelect.js'), 'utf8');

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
</body>
</html>`, {
        url: 'https://vcp.local/',
        runScripts: 'outside-only'
    });

    const { window } = dom;
    const { document } = window;

    // 注入全局环境
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

test('ComposerModelSelect: 默认所有模型未勾选，左键菜单不展示未勾选模型', async () => {
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

    // 验证需求：在设置中选定的模型自然就是按钮所显示的模型，哪怕它未被勾选
    assert.equal(label.textContent, 'gemini-2.5-flash');

    // 左键点击触发器打开候选菜单
    trigger.click();
    await new Promise(r => setTimeout(r, 10));

    // 默认所有模型都没有打勾，候选列表里不出现这些模型
    const options = document.querySelectorAll('.vcp-model-select-item');
    assert.equal(options.length, 0);

    const empty = document.querySelector('.vcp-model-select-empty');
    assert.ok(empty);
    assert.match(empty.textContent, /未勾选任何模型/);

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
        config: { model: 'unlisted-model' } // 一个不在候选列表里的模型
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

    // 右键点击触发器弹出勾选菜单
    trigger.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 10));

    const checkMenu = document.querySelector('.vcp-model-select-menu[data-mode="check"]');
    assert.ok(checkMenu);

    // 验证初始状态所有模型 checkbox 均为 false
    const checkItems = checkMenu.querySelectorAll('.vcp-model-check-item');
    assert.equal(checkItems.length, 3);
    checkItems.forEach(item => {
        assert.equal(item.getAttribute('aria-checked'), 'false');
    });

    // 点击勾选第 1 个 (gpt-4o) 和第 2 个 (gemini-2.5-flash)
    checkItems[0].click();
    assert.equal(checkItems[0].getAttribute('aria-checked'), 'true');
    checkItems[1].click();
    assert.equal(checkItems[1].getAttribute('aria-checked'), 'true');

    // 验证持久化到了 localStorage
    const saved = JSON.parse(window.localStorage.getItem('vcp-composer-checked-models'));
    assert.deepEqual(new Set(saved), new Set(['gpt-4o', 'gemini-2.5-flash']));

    // 关闭勾选菜单
    document.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(document.querySelector('.vcp-model-select-menu'), null);

    // 左键点击触发器打开候选菜单
    trigger.click();
    await new Promise(r => setTimeout(r, 10));

    const selectMenu = document.querySelector('.vcp-model-select-menu[data-mode="select"]');
    assert.ok(selectMenu);

    // 只有勾选的两个模型出现在左键候选中，未勾选的 claude-3-5-sonnet 不出现
    const optionNames = Array.from(selectMenu.querySelectorAll('.vcp-model-select-item .name')).map(el => el.textContent);
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
    await new Promise(r => setTimeout(r, 10));

    const selectAllBtn = document.querySelectorAll('.vcp-model-select-action-btn')[0];
    selectAllBtn.click();

    let saved = JSON.parse(window.localStorage.getItem('vcp-composer-checked-models'));
    assert.equal(saved.length, 3);

    // 点击清空
    const clearAllBtn = document.querySelectorAll('.vcp-model-select-action-btn')[1];
    clearAllBtn.click();

    saved = JSON.parse(window.localStorage.getItem('vcp-composer-checked-models'));
    assert.equal(saved.length, 0);

    instance.dispose();
});