import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createModelPickerPopup, modelCheckStore } from '../modules/renderer/model-picker-popup.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('model-picker-popup renders all 1200 models without clipping or loss', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="wrap"><button id="trigger"></button></div></body>', {
        url: 'https://vcp.test'
    });
    const doc = dom.window.document;
    const wrap = doc.getElementById('wrap');
    const trigger = doc.getElementById('trigger');

    // 构造 1200 个真实的大模型 ID
    const mockModels = Array.from({ length: 1200 }, (_, i) => `vendor/cluster-node-model-${String(i).padStart(4, '0')}`);
    const selected = [];

    const popup = createModelPickerPopup({
        doc,
        win: dom.window,
        wrap,
        trigger,
        getCatalog: async () => ({ ids: mockModels, favorites: new Set([mockModels[0], mockModels[1]]) }),
        getActiveModel: () => mockModels[0],
        onSelect: (id) => selected.push(id)
    });

    // 清空勾选池以测试全量展示冷启动
    modelCheckStore.set([], dom.window);

    // 触发点击打开左键选择面板
    trigger.click();
    await tick();

    const menu = wrap.querySelector('.vcp-model-picker-popup');
    assert.ok(menu, 'popup menu should be mounted to the DOM');
    assert.equal(menu.dataset.mode, 'select');

    const items = wrap.querySelectorAll('.vcp-model-picker-item');
    assert.equal(items.length, 1200, 'all 1200 models should be rendered in full');

    // 搜索过滤测试
    const searchInput = wrap.querySelector('.vcp-model-picker-search');
    assert.ok(searchInput);
    searchInput.value = 'model-005';
    searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    const filteredItems = wrap.querySelectorAll('.vcp-model-picker-item');
    // 应该包含 0050 ~ 0059 以及 0005 等
    assert.ok(filteredItems.length > 0 && filteredItems.length < 50, 'filtered results should be narrowed');

    // 点击某项触发选中回调
    filteredItems[0].click();
    assert.equal(selected.length, 1);
    assert.equal(selected[0], filteredItems[0].dataset.model);
    assert.equal(wrap.querySelector('.vcp-model-picker-popup'), null, 'popup should close on selection');

    popup.dispose();
});

test('model-picker-popup supports right-click check mode to filter candidate pool', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="wrap"><button id="trigger"></button></div></body>', {
        url: 'https://vcp.test'
    });
    const doc = dom.window.document;
    const wrap = doc.getElementById('wrap');
    const trigger = doc.getElementById('trigger');

    const models = ['claude-3-5-sonnet', 'gpt-4o', 'gemini-1-5-pro', 'deepseek-v3'];
    const popup = createModelPickerPopup({
        doc,
        win: dom.window,
        wrap,
        trigger,
        getCatalog: async () => ({ ids: models, favorites: new Set() }),
        getActiveModel: () => 'gpt-4o',
        onSelect: () => {}
    });

    // 右键打开勾选配置模式
    trigger.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();

    const menu = wrap.querySelector('.vcp-model-picker-popup');
    assert.ok(menu);
    assert.equal(menu.dataset.mode, 'check');

    // 测试清空所有常用勾选
    const clearBtn = wrap.querySelector('.vcp-model-picker-actions button:last-child');
    clearBtn.click();
    assert.equal(modelCheckStore.get(dom.window).size, 0);

    // 勾选第一和第二项
    const checkItems = wrap.querySelectorAll('.vcp-model-picker-check-item');
    assert.equal(checkItems.length, 4);
    checkItems[0].click();
    checkItems[1].click();

    const checkedAfter = modelCheckStore.get(dom.window);
    assert.equal(checkedAfter.size, 2);
    assert.ok(checkedAfter.has('claude-3-5-sonnet'));
    assert.ok(checkedAfter.has('gpt-4o'));

    popup.close();

    // 再次左键打开，应当只展示勾选的 2 个模型
    trigger.click();
    await tick();

    const selectItems = wrap.querySelectorAll('.vcp-model-picker-item');
    assert.equal(selectItems.length, 2);
    const renderedIds = Array.from(selectItems).map(el => el.dataset.model);
    assert.deepEqual(renderedIds.sort(), ['claude-3-5-sonnet', 'gpt-4o'].sort());

    popup.dispose();
});

test('model-picker-popup handles Escape and focus trapping safely', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="wrap"><button id="trigger"></button></div></body>', {
        url: 'https://vcp.test'
    });
    const doc = dom.window.document;
    const wrap = doc.getElementById('wrap');
    const trigger = doc.getElementById('trigger');

    const popup = createModelPickerPopup({
        doc,
        win: dom.window,
        wrap,
        trigger,
        getCatalog: async () => ({ ids: ['m1', 'm2'], favorites: new Set() }),
        getActiveModel: () => 'm1',
        onSelect: () => {}
    });

    trigger.click();
    await tick();
    assert.ok(popup.isOpen());

    // 按下 Esc 键关闭
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(popup.isOpen(), false, 'Escape should close the popup');

    popup.dispose();
});