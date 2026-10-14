'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');

test('拖拽放回原位不保存，换位才保存一次排序', async () => {
    const dom = new JSDOM('<ul id="agentList"></ul>', { runScripts: 'outside-only' });
    const w = dom.window;
    let options = null, saves = [];
    w.Sortable = function (_el, opts) { options = opts; this.destroy = () => {}; };
    try {
        w.eval(await fs.readFile(path.join(root, 'modules/itemListManager.js'), 'utf8'));
        const ul = w.document.querySelector('ul');
        w.itemListManager.init({
            elements: { itemListUl: ul },
            electronAPI: {
                getAgents: async () => [],
                getAgentGroups: async () => [
                    { id: 'g1', name: '群一', mode: 'sequential' },
                    { id: 'g2', name: '群二', mode: 'sequential' },
                ],
                loadSettings: async () => ({ combinedItemOrder: [] }),
                getUnreadTopicCounts: async () => ({ success: true, counts: {} }),
                saveCombinedItemOrder: async order => { saves.push(order); return { success: true }; },
            },
            refs: { currentSelectedItemRef: { get: () => null } },
            mainRendererFunctions: { selectItem() {} },
            uiHelper: { showToastNotification() {} },
        });
        await w.itemListManager.loadItems();
        assert.ok(options, 'Sortable 应已初始化');
        await options.onEnd({ from: ul, to: ul, oldIndex: 1, newIndex: 1 });
        assert.equal(saves.length, 0);
        await options.onEnd({ from: ul, to: ul, oldIndex: 0, newIndex: 1 });
        assert.equal(saves.length, 1);
        assert.deepEqual(Array.from(saves[0], item => item.id).sort(), ['g1', 'g2']);
    } finally { w.close(); }
});